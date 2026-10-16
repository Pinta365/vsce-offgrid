import * as vscode from "vscode";
import { createHash } from "crypto";
import { createWriteStream, existsSync } from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import * as path from "path";

/** A model the extension can download, pinned by size and SHA-256. */
export interface KnownModel {
    label: string;
    file: string;
    url: string;
    size: number;
    sha256: string;
}

export const COMPLETION_MODEL: KnownModel = {
    label: "Qwen2.5-Coder 1.5B (Q8_0)",
    file: "qwen2.5-coder-1.5b-q8_0.gguf",
    url: "https://huggingface.co/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF/resolve/main/qwen2.5-coder-1.5b-q8_0.gguf",
    size: 1646573056,
    sha256: "29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832",
};

export const CHAT_MODEL: KnownModel = {
    label: "Qwen3 4B Instruct 2507 (Q4_K_M)",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    size: 2497281120,
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
};

export type Role = "completion" | "chat";

const KNOWN: Record<Role, KnownModel> = { completion: COMPLETION_MODEL, chat: CHAT_MODEL };

export class Models {
    constructor(private readonly storage: vscode.Uri) {}

    private get dir(): string {
        return path.join(this.storage.fsPath, "models");
    }

    /** The configured path, or the default model's path once it is downloaded. */
    resolve(role: Role): string | undefined {
        const configured = vscode.workspace.getConfiguration("offgrid").get<string>(`${role}.model`, "").trim();
        if (configured) {
            return existsSync(configured) ? configured : undefined;
        }
        const file = path.join(this.dir, KNOWN[role].file);
        return existsSync(file) ? file : undefined;
    }

    /** Whether `role` uses a custom path that doesn't exist (so downloading won't help). */
    missingCustom(role: Role): string | undefined {
        const configured = vscode.workspace.getConfiguration("offgrid").get<string>(`${role}.model`, "").trim();
        return configured && !existsSync(configured) ? configured : undefined;
    }

    known(role: Role): KnownModel {
        return KNOWN[role];
    }

    /** Download the default model for `role` with progress; verifies size and SHA-256. */
    async download(role: Role): Promise<string | undefined> {
        const model = KNOWN[role];
        const target = path.join(this.dir, model.file);
        if (existsSync(target)) {
            return target;
        }
        await mkdir(this.dir, { recursive: true });
        const part = `${target}.part`;
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `offgrid: downloading ${model.label}`,
                cancellable: true,
            },
            async (progress, token) => {
                const abort = new AbortController();
                token.onCancellationRequested(() => abort.abort());
                let reported = 0; // percent
                try {
                    await fetchTo(model, part, abort.signal, (done) => {
                        const pct = (done / model.size) * 100;
                        progress.report({ message: `${gib(done)} of ${gib(model.size)}`, increment: pct - reported });
                        reported = pct;
                    });
                    await rename(part, target);
                    return target;
                } catch (e) {
                    await rm(part, { force: true });
                    if (token.isCancellationRequested) {
                        return undefined;
                    }
                    throw e;
                }
            },
        );
    }
}

function gib(bytes: number): string {
    return `${(bytes / 2 ** 30).toFixed(2)} GB`;
}

async function fetchTo(model: KnownModel, file: string, signal: AbortSignal, onProgress: (done: number) => void) {
    const res = await fetch(model.url, { signal, redirect: "follow" });
    if (!res.ok || !res.body) {
        throw new Error(`download failed: HTTP ${res.status} for ${model.url}`);
    }
    const hash = createHash("sha256");
    const out = createWriteStream(file);
    let done = 0;
    let last = 0;
    try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            done += chunk.length;
            if (!out.write(chunk)) {
                await new Promise<void>((r) => out.once("drain", () => r()));
            }
            if (done - last > 16 << 20) {
                last = done;
                onProgress(done);
            }
        }
    } finally {
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    }
    const size = (await stat(file)).size;
    if (size !== model.size) {
        throw new Error(`download incomplete: got ${size} bytes, expected ${model.size}`);
    }
    const digest = hash.digest("hex");
    if (digest !== model.sha256) {
        throw new Error(`checksum mismatch for ${model.file}: got ${digest}`);
    }
}
