import * as vscode from "vscode";
import { createHash } from "crypto";
import { createWriteStream, existsSync } from "fs";
import { mkdir, readdir, rename, rm, stat } from "fs/promises";
import * as path from "path";

/** A model the extension can download, pinned by size and SHA-256. */
export interface KnownModel {
    label: string;
    /** Name in the chat model picker and setup list. */
    short: string;
    quant: string;
    file: string;
    url: string;
    size: number;
    sha256: string;
    /** Chat context to use with this model (default: offgrid.chat.contextSize's default). */
    contextSize?: number;
    /** Sent with every chat request, e.g. to turn a hybrid model's thinking off. */
    chatTemplateKwargs?: Record<string, unknown>;
    /** What it needs, for models outside a setup (setups state their own). */
    needs?: { gpuGiB: number; ramGiB: number };
    /** Set for models that only run well on big machines. */
    large?: {
        gpuGiB: number;
        ramGiB: number;
        /** `offgrid.chat.expertLayersOnCpu` that fits a GPU of `gpuGiB`. */
        expertLayersOnCpu: number;
        /** Why one would want it, for the setup list. */
        why: string;
    };
}

export const COMPLETION_MODEL: KnownModel = {
    label: "Qwen2.5-Coder 1.5B (Q8_0)",
    short: "Qwen2.5-Coder 1.5B",
    quant: "Q8_0",
    file: "qwen2.5-coder-1.5b-q8_0.gguf",
    url: "https://huggingface.co/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF/resolve/main/qwen2.5-coder-1.5b-q8_0.gguf",
    size: 1646573056,
    sha256: "29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832",
};

/** For machines without a dedicated GPU: several times faster than the 1.5B on a CPU. */
export const TINY_COMPLETION_MODEL: KnownModel = {
    label: "Qwen2.5-Coder 0.5B (Q8_0)",
    short: "Qwen2.5-Coder 0.5B",
    quant: "Q8_0",
    file: "qwen2.5-coder-0.5b-q8_0.gguf",
    url: "https://huggingface.co/ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF/resolve/main/qwen2.5-coder-0.5b-q8_0.gguf",
    size: 531068128,
    sha256: "d0f8cd6c49bab52a0abdbe47948518b1f4d9b1a8a2a6825099cea31cea10ac56",
};

export const COMPLETION_MODELS = [TINY_COMPLETION_MODEL, COMPLETION_MODEL];

// Chat models. Qwen3.5 and Qwen3.6 are hybrid models (offgrid keeps context checkpoints for them)
// with thinking on by default, which the chat view doesn't show: it's turned off.
const NO_THINKING = { enable_thinking: false };

/** Standard: 4/5 on an agent benchmark, 5.9 GB with a 32k context and the code model. */
export const CHAT_MODEL: KnownModel = {
    label: "Qwen3.5 4B (Q4_K_M)",
    short: "Qwen3.5 4B",
    quant: "Q4_K_M",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    size: 2740937888,
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    chatTemplateKwargs: NO_THINKING,
};

/** Tiny: simple questions; uses its tools but poorly. 8k context for CPU-only machines. */
export const TINY_CHAT_MODEL: KnownModel = {
    label: "Qwen3.5 0.8B (Q8_0)",
    short: "Qwen3.5 0.8B",
    quant: "Q8_0",
    file: "Qwen3.5-0.8B-Q8_0.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf",
    size: 811843840,
    sha256: "0ad885ffd4bb022fc4f0d33a3308fa108ef8613159d3b3a67e23abca056b7a6c",
    contextSize: 8192,
    chatTemplateKwargs: NO_THINKING,
};

/** Small: 4/5 on the agent benchmark (Qwen3 1.7B: 0/5) in 3.9 GB. */
export const SMALL_CHAT_MODEL: KnownModel = {
    label: "Qwen3.5 2B (Q4_K_M)",
    short: "Qwen3.5 2B",
    quant: "Q4_K_M",
    file: "Qwen3.5-2B-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
    size: 1280835840,
    sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    chatTemplateKwargs: NO_THINKING,
};

/** Large: 5/5 on the agent benchmark; 22 GB, experts partly on the CPU on a 16 GB GPU. */
export const LARGE_CHAT_MODEL: KnownModel = {
    label: "Qwen3.6 35B-A3B (UD-Q4_K_M)",
    short: "Qwen3.6 35B",
    quant: "UD-Q4_K_M",
    file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    size: 22134528992,
    sha256: "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61",
    chatTemplateKwargs: NO_THINKING,
    large: {
        gpuGiB: 16,
        ramGiB: 32,
        expertLayersOnCpu: 28,
        why: "The best in Agent mode; about 37 tokens/s on a 16 GB GPU",
    },
};

/** An alternative to Standard: as good on the agent benchmark (4/5, no bad calls), faster, and new
 * chats reuse the cache without checkpoints; 0.8 GB more GPU memory. Not hybrid, no thinking flag. */
export const GEMMA_CHAT_MODEL: KnownModel = {
    label: "Gemma 4 E4B (Q4_K_M)",
    short: "Gemma 4 E4B",
    quant: "Q4_K_M",
    file: "gemma-4-E4B-it-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
    size: 4977171584,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
    needs: { gpuGiB: 8, ramGiB: 16 },
};

export const CHAT_MODELS = [TINY_CHAT_MODEL, SMALL_CHAT_MODEL, CHAT_MODEL, GEMMA_CHAT_MODEL, LARGE_CHAT_MODEL];

/**
 * Chat models of earlier versions: still recognized (thinking off, expert offload) and listed
 * when downloaded, so switching back needs no download.
 */
export const OLDER_CHAT_MODELS: KnownModel[] = [
    {
        label: "Qwen3 0.6B (Q8_0)",
        short: "Qwen3 0.6B",
        quant: "Q8_0",
        file: "Qwen3-0.6B-Q8_0.gguf",
        url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf",
        size: 639446688,
        sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031",
        contextSize: 8192,
        chatTemplateKwargs: NO_THINKING,
    },
    {
        label: "Qwen3 1.7B (Q4_K_M)",
        short: "Qwen3 1.7B",
        quant: "Q4_K_M",
        file: "Qwen3-1.7B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
        size: 1107409472,
        sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
        chatTemplateKwargs: NO_THINKING,
    },
    {
        label: "Qwen3 4B Instruct 2507 (Q4_K_M)",
        short: "Qwen3 4B",
        quant: "Q4_K_M",
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        size: 2497281120,
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    },
    {
        label: "Qwen3-Coder 30B-A3B Instruct (Q4_K_M)",
        short: "Qwen3-Coder 30B",
        quant: "Q4_K_M",
        file: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
        size: 18556689568,
        sha256: "fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad",
        large: { gpuGiB: 16, ramGiB: 32, expertLayersOnCpu: 24, why: "About 35 tokens/s on a 16 GB GPU" },
    },
];

/** The default chat model before 0.0.6 (Qwen3 4B): kept in use while nothing else is chosen. */
const PREVIOUS_DEFAULT_CHAT = OLDER_CHAT_MODELS[2];

/** A chat model and the code model, sized for a class of machine. */
export interface Setup {
    name: string;
    chat: KnownModel;
    completion: KnownModel;
    /** Who it's for and what works, for the setup list. */
    detail: string;
    /** GPU memory it needs, in GiB (0: also runs on the CPU). */
    gpuGiB: number;
    ramGiB: number;
}

export const SETUPS: Setup[] = [
    {
        name: "Tiny",
        chat: TINY_CHAT_MODEL,
        completion: TINY_COMPLETION_MODEL,
        detail: "For machines without a dedicated GPU, or under 6 GB: fast code completion; chat for simple questions",
        gpuGiB: 0,
        ramGiB: 4,
    },
    {
        name: "Small",
        chat: SMALL_CHAT_MODEL,
        completion: COMPLETION_MODEL,
        detail: "For 6 GB GPUs: code completion, chat and light Agent use",
        gpuGiB: 6,
        ramGiB: 8,
    },
    {
        name: "Standard",
        chat: CHAT_MODEL,
        completion: COMPLETION_MODEL,
        detail: "For 8 GB GPUs and up: code completion, chat and Agent mode, better answers than Small",
        gpuGiB: 8,
        ramGiB: 16,
    },
    {
        name: "Large",
        chat: LARGE_CHAT_MODEL,
        completion: COMPLETION_MODEL,
        detail: "For 16 GB GPUs with 32 GB RAM: the best in Agent mode; runs part of the model on the CPU",
        gpuGiB: 16,
        ramGiB: 32,
    },
];

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
        const file = this.defaultFile(role);
        return existsSync(file) ? file : undefined;
    }

    /** The default model's file; for chat, the previous default while only that one is downloaded. */
    private defaultFile(role: Role): string {
        const file = path.join(this.dir, KNOWN[role].file);
        if (role === "chat" && !existsSync(file) && this.downloaded(PREVIOUS_DEFAULT_CHAT)) {
            return this.pathOf(PREVIOUS_DEFAULT_CHAT);
        }
        return file;
    }

    /** Whether `role` uses a custom path that doesn't exist (so downloading won't help). */
    missingCustom(role: Role): string | undefined {
        const configured = vscode.workspace.getConfiguration("offgrid").get<string>(`${role}.model`, "").trim();
        return configured && !existsSync(configured) ? configured : undefined;
    }

    known(role: Role): KnownModel {
        return KNOWN[role];
    }

    /** Bytes of downloaded models (and unfinished downloads). */
    async downloadedBytes(): Promise<number> {
        try {
            const files = await readdir(this.dir);
            const sizes = await Promise.all(files.map((f) => stat(path.join(this.dir, f)).then((s) => s.size)));
            return sizes.reduce((a, b) => a + b, 0);
        } catch {
            return 0;
        }
    }

    async deleteDownloads() {
        await rm(this.dir, { recursive: true, force: true });
    }

    /** Where `model` is (or would be) downloaded. */
    pathOf(model: KnownModel): string {
        return path.join(this.dir, model.file);
    }

    downloaded(model: KnownModel): boolean {
        return existsSync(this.pathOf(model));
    }

    /** The known model at `file`, if it is one (by file name), for naming it. */
    byPath(file: string): KnownModel | undefined {
        const name = path.basename(file);
        return [...COMPLETION_MODELS, ...CHAT_MODELS, ...OLDER_CHAT_MODELS].find((m) => m.file === name);
    }

    /** The chat model in use: the configured file, or the default one. */
    chatFile(): string {
        const configured = vscode.workspace.getConfiguration("offgrid").get<string>("chat.model", "").trim();
        return configured || this.defaultFile("chat");
    }

    /** Download `model` (or the default for a role) with progress; verifies size and SHA-256. */
    async download(which: Role | KnownModel): Promise<string | undefined> {
        const model = typeof which === "string" ? KNOWN[which] : which;
        const target = this.pathOf(model);
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
