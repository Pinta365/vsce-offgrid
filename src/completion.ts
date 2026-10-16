import * as vscode from "vscode";
import { COMPLETION_ID, Endpoint, Server, headers, isConnectionError } from "./server";

/** Lines of the current file around the cursor that go into each request. */
const PREFIX_LINES = 256;
const SUFFIX_LINES = 64;
/** Extra context: code around the cursor in files the user recently left. */
const EXTRA_CHUNKS = 16;
const EXTRA_CHUNK_LINES = 64;
/** Completions remembered for typing along a suggestion without a new request. */
const CACHE_SIZE = 256;

interface Chunk {
    filename: string;
    text: string;
}

/**
 * Inline completion through offgrid-server's `/infill` (llama.cpp's format, as llama.vscode
 * sends it): the code before and after the cursor, plus chunks of recently visited files.
 */
export class CompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    /** One slot per window: a newer request from this window replaces the older one. */
    private readonly slot = process.pid;
    private readonly extra: Chunk[] = [];
    private readonly cache = new Map<string, string>();
    private warmTimer?: NodeJS.Timeout;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly status: (text: string) => void;

    constructor(
        private readonly server: Server,
        private readonly log: vscode.LogOutputChannel,
        status: (text: string) => void,
    ) {
        this.status = status;
        // Remember where the user was in the editor they leave, as context for the next one.
        let last = vscode.window.activeTextEditor;
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (last && last.document !== editor?.document) {
                    this.keepContext(last.document, last.selection.active.line);
                }
                last = editor;
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                const editor = vscode.window.activeTextEditor;
                if (editor?.document === doc) {
                    this.keepContext(doc, editor.selection.active.line);
                }
            }),
        );
    }

    dispose() {
        clearTimeout(this.warmTimer);
        this.disposables.forEach((d) => d.dispose());
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        const cfg = vscode.workspace.getConfiguration("offgrid");
        if (!cfg.get<boolean>("completion.enabled", true)) {
            return undefined;
        }
        const line = document.lineAt(position.line).text;
        const before = line.slice(0, position.character);
        const after = line.slice(position.character);
        // Only complete at the end of a line, or before closing brackets and quotes.
        if (!/^[\s)\]}>'"`;,]*$/.test(after)) {
            return undefined;
        }
        const firstLine = Math.max(0, position.line - PREFIX_LINES);
        const lastLine = Math.min(document.lineCount - 1, position.line + SUFFIX_LINES);
        const prefix = document.getText(new vscode.Range(firstLine, 0, position.line, 0));
        const suffix = after + document.getText(new vscode.Range(position.line, line.length, lastLine + 1, 0));

        const key = `${document.uri}\n${prefix}\u0000${suffix}\u0000`;
        const hit = this.fromCache(key, before);
        if (hit !== undefined) {
            return hit ? [item(hit, position)] : undefined;
        }

        await sleep(cfg.get<number>("completion.debounceMs", 100));
        if (token.isCancellationRequested) {
            return undefined;
        }
        const endpoint = await this.server.ensure();
        if (!endpoint?.completion || token.isCancellationRequested) {
            return undefined;
        }
        const indent = /^[ \t]*/.exec(line)![0].length;
        const body = {
            model: COMPLETION_ID,
            id_slot: this.slot,
            input_prefix: prefix,
            input_suffix: suffix,
            input_extra: this.extra.filter((c) => c.filename !== vscode.workspace.asRelativePath(document.uri)),
            prompt: before,
            n_predict: cfg.get<number>("completion.maxTokens", 128),
            t_max_predict_ms: cfg.get<number>("completion.timeLimitMs", 500),
            n_indent: indent > 0 ? indent : undefined,
            top_k: 40,
            top_p: 0.99,
            samplers: ["top_k", "top_p", "infill"],
        };
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        const started = Date.now();
        try {
            const res = await fetch(`${endpoint.url}/infill`, {
                method: "POST",
                headers: headers(endpoint),
                body: JSON.stringify(body),
                signal: abort.signal,
            });
            if (!res.ok) {
                this.log.warn(`completion failed: HTTP ${res.status} ${await res.text()}`);
                return undefined;
            }
            const out = (await res.json()) as { content: string; stop_type: string; timings?: { cache_n: number } };
            const ms = Date.now() - started;
            if (out.stop_type === "none") {
                return undefined; // replaced by a newer request
            }
            const text = trim(out.content, document, position);
            this.store(key + before, text);
            this.status(`${ms} ms`);
            this.log.debug(`completion in ${ms} ms (${out.timings?.cache_n ?? 0} cached): ${JSON.stringify(text)}`);
            return text ? [item(text, position)] : undefined;
        } catch (e) {
            if (abort.signal.aborted) {
                return undefined;
            }
            if (isConnectionError(e)) {
                this.server.lost();
            }
            this.log.warn(`completion failed: ${e instanceof Error ? e.message : e}`);
            return undefined;
        } finally {
            sub.dispose();
        }
    }

    /** A cached completion for this position, or what remains of one the user typed along. */
    private fromCache(key: string, before: string): string | undefined {
        const exact = this.cache.get(key + before);
        if (exact !== undefined) {
            return exact;
        }
        // The user typed the start of an earlier suggestion: offer the rest.
        for (let n = 1; n <= Math.min(before.length, 64); n++) {
            const earlier = this.cache.get(key + before.slice(0, -n));
            const typed = before.slice(-n);
            if (earlier && earlier.length > typed.length && earlier.startsWith(typed)) {
                return earlier.slice(typed.length);
            }
        }
        return undefined;
    }

    private store(key: string, text: string) {
        this.cache.delete(key);
        this.cache.set(key, text);
        if (this.cache.size > CACHE_SIZE) {
            this.cache.delete(this.cache.keys().next().value!);
        }
    }

    /** Keep the code around `line` of `doc` as extra context, newest last. */
    private keepContext(doc: vscode.TextDocument, line: number) {
        if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") {
            return;
        }
        const from = Math.max(0, line - EXTRA_CHUNK_LINES / 2);
        const to = Math.min(doc.lineCount, from + EXTRA_CHUNK_LINES);
        const text = doc.getText(new vscode.Range(from, 0, to, 0));
        if (!text.trim()) {
            return;
        }
        const filename = vscode.workspace.asRelativePath(doc.uri);
        // One chunk per file: the latest position replaces an earlier one.
        const i = this.extra.findIndex((c) => c.filename === filename);
        if (i >= 0) {
            if (this.extra[i].text === text) {
                return;
            }
            this.extra.splice(i, 1);
        }
        this.extra.push({ filename, text });
        if (this.extra.length > EXTRA_CHUNKS) {
            this.extra.shift();
        }
        this.scheduleWarmup();
    }

    /** Evaluate the new extra context while the user isn't typing, so it is cached. */
    private scheduleWarmup() {
        clearTimeout(this.warmTimer);
        this.warmTimer = setTimeout(async () => {
            const endpoint = this.server.state.kind === "ready" ? this.server.state.endpoint : undefined;
            if (endpoint?.completion) {
                await warm(endpoint, this.slot, this.extra).catch(() => undefined);
            }
        }, 1000);
    }
}

async function warm(endpoint: Endpoint, slot: number, extra: Chunk[]) {
    await fetch(`${endpoint.url}/infill`, {
        method: "POST",
        headers: headers(endpoint),
        body: JSON.stringify({ model: COMPLETION_ID, id_slot: slot, input_prefix: "", input_suffix: "", input_extra: extra, n_predict: 0 }),
    });
}

function item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
}

/** Drop trailing whitespace and lines that repeat the code right after the cursor. */
function trim(content: string, document: vscode.TextDocument, position: vscode.Position): string {
    let lines = content.replace(/\s+$/, "").split("\n");
    const next: string[] = [];
    for (let l = position.line + 1; l < Math.min(document.lineCount, position.line + 1 + lines.length); l++) {
        next.push(document.lineAt(l).text.trim());
    }
    // The model often ends by rewriting the following lines; cut where that begins.
    for (let i = 1; i < lines.length; i++) {
        const rest = lines.slice(i).map((s) => s.trim()).filter(Boolean);
        if (rest.length > 0 && rest.every((s, k) => s === next[k])) {
            lines = lines.slice(0, i);
            break;
        }
    }
    return lines.join("\n").replace(/\s+$/, "");
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
