import * as vscode from "vscode";
import { CHAT_ID, Server, headers, isConnectionError } from "./server";
import { Models } from "./models";

/** Room left for the answer within the context. */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Offers the local chat model in VS Code's chat (model picker, Ask and Agent modes) through
 * offgrid-server's OpenAI-compatible `/v1/chat/completions`.
 */
export class ChatProvider implements vscode.LanguageModelChatProvider {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this.changed.event;

    constructor(
        private readonly server: Server,
        private readonly models: Models,
        private readonly log: vscode.LogOutputChannel,
    ) {
        server.onDidChangeState(() => this.changed.fire());
    }

    /** Settings or downloads changed which models exist. */
    refresh() {
        this.changed.fire();
    }

    provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
        const cfg = vscode.workspace.getConfiguration("offgrid");
        if (!cfg.get<boolean>("chat.enabled", true) || !this.models.resolve("chat")) {
            return [];
        }
        const context = cfg.get<number>("contextSize", 16384) || 8192;
        const output = Math.min(MAX_OUTPUT_TOKENS, Math.floor(context / 4));
        const custom = cfg.get<string>("chat.model", "").trim();
        return [
            {
                id: CHAT_ID,
                name: custom ? `offgrid: ${baseName(custom)}` : "offgrid: Qwen3 4B",
                family: "offgrid",
                version: "1",
                detail: "local",
                tooltip: `Runs on this machine (${custom || this.models.known("chat").label})`,
                maxInputTokens: context - output,
                maxOutputTokens: output,
                capabilities: { toolCalling: true, imageInput: false },
            },
        ];
    }

    async provideLanguageModelChatResponse(
        _model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const endpoint = await this.server.ensure();
        if (!endpoint?.chat) {
            throw new Error("the offgrid chat model isn't running; see “offgrid: Show Log”");
        }
        const tools = (options.tools ?? []).map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } },
        }));
        const body: Record<string, unknown> = {
            model: CHAT_ID,
            messages: toOpenAi(messages),
            stream: true,
            max_tokens: MAX_OUTPUT_TOKENS,
        };
        if (tools.length > 0) {
            body.tools = tools;
            body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
        }
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        try {
            const res = await fetch(`${endpoint.url}/v1/chat/completions`, {
                method: "POST",
                headers: headers(endpoint),
                body: JSON.stringify(body),
                signal: abort.signal,
            });
            if (!res.ok || !res.body) {
                throw new Error(`offgrid: HTTP ${res.status} ${await res.text()}`);
            }
            for await (const event of sse(res.body)) {
                if (event.error) {
                    throw new Error(`offgrid: ${event.error.message}`);
                }
                const delta = event.choices?.[0]?.delta;
                if (delta?.content) {
                    progress.report(new vscode.LanguageModelTextPart(delta.content));
                }
                for (const call of delta?.tool_calls ?? []) {
                    // offgrid sends each call complete in one delta.
                    let input: object = {};
                    try {
                        input = JSON.parse(call.function?.arguments || "{}");
                    } catch {
                        this.log.warn(`tool call with invalid JSON arguments: ${call.function?.arguments}`);
                    }
                    progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, input));
                }
            }
        } catch (e) {
            if (abort.signal.aborted) {
                return;
            }
            if (isConnectionError(e)) {
                this.server.lost();
            }
            throw e;
        } finally {
            sub.dispose();
        }
    }

    /** A rough count (there is no tokenize endpoint yet): about 4 characters per token. */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
    ): Promise<number> {
        const s = typeof text === "string" ? text : JSON.stringify(toOpenAi([text]));
        return Math.ceil(s.length / 4);
    }
}

interface OpenAiMessage {
    role: "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
}

/** VS Code chat messages as OpenAI messages: tool results become `tool` messages. */
function toOpenAi(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
    const out: OpenAiMessage[] = [];
    for (const m of messages) {
        const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
        let text = "";
        const calls: NonNullable<OpenAiMessage["tool_calls"]> = [];
        for (const part of m.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                calls.push({
                    id: part.callId,
                    type: "function",
                    function: { name: part.name, arguments: JSON.stringify(part.input) },
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                out.push({ role: "tool", tool_call_id: part.callId, content: resultText(part.content) });
            }
        }
        if (calls.length > 0) {
            out.push({ role: "assistant", content: text || null, tool_calls: calls });
        } else if (text) {
            out.push({ role, content: text });
        }
    }
    return out;
}

/** The text of a tool result (other part kinds, e.g. prompt-tsx, are left out). */
function resultText(content: readonly unknown[]): string {
    return content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "")).join("");
}

interface ChunkEvent {
    error?: { message: string };
    choices?: {
        delta?: {
            content?: string;
            tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
        };
    }[];
}

/** JSON events of an SSE response, until `[DONE]`. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<ChunkEvent> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
            const event = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of event.split("\n")) {
                if (!line.startsWith("data:")) {
                    continue;
                }
                const data = line.slice(5).trim();
                if (data === "[DONE]") {
                    return;
                }
                yield JSON.parse(data) as ChunkEvent;
            }
        }
    }
}

function baseName(file: string): string {
    return file.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "");
}
