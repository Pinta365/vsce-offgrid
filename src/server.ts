import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { access, chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import * as net from "net";
import * as path from "path";
import { Models } from "./models";

/** The offgrid release whose server the extension's flags need (package.json `offgridServer`). */
const OFFGRID_VERSION: string = require("../package.json").offgridServer;

/** globalState key: memory of the largest dedicated GPU, in GiB, as the server reported it. */
export const GPU_MEMORY_KEY = "gpuMemoryGiB";

/** Model ids the server reports; fixed so requests don't depend on file names. */
export const COMPLETION_ID = "offgrid-completion";
export const CHAT_ID = "offgrid-chat";

export interface Endpoint {
    url: string;
    key: string;
    completion: boolean;
    chat: boolean;
    contextSize: number;
}

export type State =
    | { kind: "stopped" }
    | { kind: "setup"; message: string }
    | { kind: "starting" }
    | { kind: "ready"; endpoint: Endpoint; device: string }
    | { kind: "error"; message: string };

/** What the server was started with; another window reuses a server only if this matches. */
interface Launch {
    binary: string;
    args: string[];
}

interface Shared {
    pid: number;
    port: number;
    key: string;
    launch: Launch;
    endpoint: Omit<Endpoint, "url" | "key">;
    device: string;
}

/**
 * Runs offgrid-server with the configured models, or attaches to the one another VS Code
 * window started with the same settings (each window has its own extension host, and the
 * models should load only once).
 */
export class Server implements vscode.Disposable {
    private child?: ChildProcess;
    private starting?: Promise<Endpoint | undefined>;
    private _state: State = { kind: "stopped" };
    private readonly changed = new vscode.EventEmitter<State>();
    readonly onDidChangeState = this.changed.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly models: Models,
        private readonly log: vscode.LogOutputChannel,
    ) {}

    get state(): State {
        return this._state;
    }

    private set(state: State) {
        this._state = state;
        this.changed.fire(state);
    }

    private get sharedFile(): string {
        return path.join(this.context.globalStorageUri.fsPath, "server.json");
    }

    /**
     * The running server, starting it if needed. `undefined` when models are missing or it
     * failed; after a failure it stays down until `restart` (or a settings change), so
     * keystrokes don't keep launching a broken server.
     */
    async ensure(): Promise<Endpoint | undefined> {
        if (this._state.kind === "ready") {
            return this._state.endpoint;
        }
        if (this._state.kind === "error") {
            return undefined;
        }
        this.starting ??= this.start().finally(() => (this.starting = undefined));
        return this.starting;
    }

    /** A request failed to connect: the server (maybe another window's) is gone. */
    lost() {
        if (this._state.kind === "ready") {
            this.log.warn("server unreachable; starting again on the next request");
            this.child = undefined;
            this.set({ kind: "stopped" });
        }
    }

    /** Stop this window's server and forget the shared one (for a reset). */
    async stop() {
        await this.starting?.catch(() => undefined);
        this.stopOwn();
        await rm(this.sharedFile, { force: true });
        this.set({ kind: "stopped" });
    }

    /**
     * Memory of the largest dedicated GPU in GiB (0: none), from the server's device list. Started
     * without a model, the server lists the devices and exits, so this is quick.
     */
    async probeGpu(): Promise<number | undefined> {
        const binary = this.binary();
        if (!binary) {
            return undefined;
        }
        await ensureExecutable(binary);
        return new Promise((resolve) => {
            const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            let gib = 0;
            let seen = false;
            const onLine = (line: string) => {
                const d = parseDevice(line);
                seen ||= /\bdevice \S+ \(\w+\): /.test(line); // CPU-only machines list just the CPU
                if (d?.dedicated && d.gib) {
                    gib = Math.max(gib, d.gib);
                }
            };
            lines(child.stdout!, onLine);
            lines(child.stderr!, onLine);
            const timer = setTimeout(() => child.kill(), 15_000);
            child.once("error", () => resolve(undefined));
            child.once("exit", () => {
                clearTimeout(timer);
                if (!seen) {
                    return resolve(undefined);
                }
                void this.context.globalState.update(GPU_MEMORY_KEY, gib);
                this.log.info(`largest dedicated GPU: ${gib ? `${gib} GiB` : "none"}`);
                resolve(gib);
            });
        });
    }

    async restart(): Promise<Endpoint | undefined> {
        await this.starting?.catch(() => undefined);
        this.stopOwn();
        this.set({ kind: "stopped" });
        return this.ensure();
    }

    dispose() {
        this.stopOwn();
        this.changed.dispose();
    }

    private stopOwn() {
        if (this.child && this.child.exitCode === null) {
            this.log.info(`stopping server (pid ${this.child.pid})`);
            this.child.kill();
        }
        this.child = undefined;
    }

    private async start(): Promise<Endpoint | undefined> {
        const plan = this.plan();
        if ("setup" in plan) {
            this.set({ kind: "setup", message: plan.setup });
            return undefined;
        }
        const attached = await this.attach(plan.launch);
        if (attached) {
            return attached;
        }
        this.set({ kind: "starting" });
        try {
            return await this.spawn(plan.launch, plan.endpoint);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.log.error(message);
            this.set({ kind: "error", message });
            return undefined;
        }
    }

    /** Arguments from the settings, or what's missing. */
    private plan(): { launch: Launch; endpoint: Omit<Endpoint, "url" | "key"> } | { setup: string } {
        const cfg = vscode.workspace.getConfiguration("offgrid");
        const binary = this.binary();
        if (!binary) {
            return { setup: "offgrid-server not found: set offgrid.serverPath" };
        }
        // The code model stays loaded while completion is paused (offgrid.completion.enabled).
        const chatOn = cfg.get<boolean>("chat.enabled", true);
        const completion = this.models.resolve("completion");
        const chat = chatOn ? this.models.resolve("chat") : undefined;
        if (!completion && !chat) {
            return { setup: "no model downloaded yet: run “offgrid: Set Up Models”" };
        }
        const contextSize = cfg.get<number>("chat.contextSize", 32768);
        const completionContext = cfg.get<number>("completion.contextSize", 8192);
        // --exit-on-stdin-close: the server exits with this extension host, even if it crashes.
        const args = ["--host", "127.0.0.1", "--cache-reuse", "256", "--exit-on-stdin-close"];
        args.push("--cache-type", cfg.get<string>("cacheType", "q8_0"));
        if (completion) {
            args.push("--fim-model", completion, "--fim-alias", COMPLETION_ID);
        }
        if (chat) {
            args.push("--model", chat, "--alias", CHAT_ID);
        }
        if (contextSize > 0) {
            args.push("--ctx", String(contextSize));
        }
        if (completion && completionContext > 0) {
            args.push("--fim-ctx", String(completionContext));
        }
        if (!cfg.get<boolean>("gpu", true)) {
            args.push("--gpu-layers", "none");
        }
        const expertLayers = cfg.get<number>("chat.expertLayersOnCpu", 0);
        if (chat && expertLayers > 0) {
            // Expert weights are copied to the GPU once per prompt batch: larger batches are
            // much faster (~2.4x for Qwen3-Coder-30B-A3B at 2048).
            args.push("--n-cpu-moe", String(expertLayers), "--batch", "2048");
        }
        return {
            launch: { binary, args },
            endpoint: { completion: !!completion, chat: !!chat, contextSize: contextSize || 8192 },
        };
    }

    /** `offgrid.serverPath`, else the server bundled in this platform's package. */
    private binary(): string | undefined {
        const configured = vscode.workspace.getConfiguration("offgrid").get<string>("serverPath", "").trim();
        if (configured) {
            return existsSync(configured) ? configured : undefined;
        }
        const exe = process.platform === "win32" ? "offgrid-server.exe" : "offgrid-server";
        const bundled = path.join(this.context.extensionPath, "server", "bin", exe);
        return existsSync(bundled) ? bundled : undefined;
    }

    private async attach(launch: Launch): Promise<Endpoint | undefined> {
        let shared: Shared;
        try {
            shared = JSON.parse(await readFile(this.sharedFile, "utf8"));
        } catch {
            return undefined;
        }
        if (JSON.stringify(shared.launch) !== JSON.stringify(launch) || !alive(shared.pid)) {
            return undefined;
        }
        const endpoint: Endpoint = { url: `http://127.0.0.1:${shared.port}`, key: shared.key, ...shared.endpoint };
        if (!(await healthy(endpoint))) {
            return undefined;
        }
        this.log.info(`using the server another window started (pid ${shared.pid}, port ${shared.port})`);
        this.set({ kind: "ready", endpoint, device: shared.device });
        return endpoint;
    }

    private async spawn(launch: Launch, info: Omit<Endpoint, "url" | "key">): Promise<Endpoint> {
        await ensureExecutable(launch.binary);
        const port = await freePort();
        const key = randomBytes(24).toString("hex");
        const args = [...launch.args, "--port", String(port)];
        this.log.info(`starting ${launch.binary} ${args.join(" ")}`);
        const child = spawn(launch.binary, args, {
            env: { ...process.env, OFFGRID_API_KEY: key },
            stdio: ["pipe", "pipe", "pipe"], // stdin stays open until this process ends
            windowsHide: true,
        });
        this.child = child;
        let device = "CPU";
        let gpuGiB = 0;
        const recent: string[] = [];
        const onLine = (line: string) => {
            if (!line.trim()) {
                return;
            }
            this.log.info(`[server] ${line}`);
            recent.push(line);
            if (recent.length > 20) {
                recent.shift();
            }
            // The first GPU listed is what runs the models; the largest dedicated one tells setup what fits.
            const d = parseDevice(line);
            if (d && device === "CPU" && vscode.workspace.getConfiguration("offgrid").get<boolean>("gpu", true)) {
                device = d.description;
            }
            if (d?.dedicated && d.gib) {
                gpuGiB = Math.max(gpuGiB, d.gib);
                void this.context.globalState.update(GPU_MEMORY_KEY, gpuGiB);
            }
        };
        lines(child.stdout!, onLine);
        lines(child.stderr!, onLine);
        const exited = new Promise<never>((_, reject) => {
            child.once("error", (e) => reject(new Error(`could not start offgrid-server: ${e.message}`)));
            child.once("exit", (code, signal) => {
                if (this.child === child) {
                    this.child = undefined;
                    if (this._state.kind === "ready") {
                        this.log.warn(`server exited (${signal ?? code})`);
                        this.set({ kind: "stopped" });
                    }
                }
                const tooOld = recent.some((l) => l.includes("unexpected argument"));
                const why = tooOld
                    ? `${launch.binary} is too old for this extension (it needs offgrid ${OFFGRID_VERSION} or newer)`
                    : `offgrid-server exited (${signal ?? code}): ${recent.slice(-3).join(" ")}`;
                reject(new Error(why));
            });
        });
        exited.catch(() => undefined); // only observed while waiting below

        const endpoint: Endpoint = { url: `http://127.0.0.1:${port}`, key, ...info };
        const deadline = Date.now() + 5 * 60_000; // loading from a slow disk can take a while
        while (!(await healthy(endpoint))) {
            if (Date.now() > deadline) {
                this.stopOwn();
                throw new Error("offgrid-server did not become ready within 5 minutes");
            }
            await Promise.race([sleep(250), exited]);
        }
        this.log.info(`server ready on port ${port} (${device})`);
        this.set({ kind: "ready", endpoint, device });
        const shared: Shared = { pid: child.pid!, port, key, launch, endpoint: info, device };
        await mkdir(path.dirname(this.sharedFile), { recursive: true });
        await writeFile(this.sharedFile, JSON.stringify(shared), { mode: 0o600 });
        return endpoint;
    }
}

/**
 * A device line of the server's startup log, e.g.
 * "device Vulkan0 (Gpu): AMD Radeon RX 9070 XT (RADV GFX1201) (15.9 GiB)".
 */
function parseDevice(line: string): { description: string; dedicated: boolean; gib?: number } | undefined {
    const m = /device (\S+) \((Gpu|Igpu)\): (.*?)(?: \(([\d.]+) GiB\))?$/.exec(line);
    return m ? { description: m[3], dedicated: m[2] === "Gpu", gib: m[4] ? Number(m[4]) : undefined } : undefined;
}

/** Headers for a request to `endpoint`. */
export function headers(endpoint: Endpoint): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${endpoint.key}` };
}

/** Whether `e` means the server isn't there (as opposed to an HTTP or abort error). */
export function isConnectionError(e: unknown): boolean {
    const cause = (e as { cause?: { code?: string } })?.cause;
    return ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(cause?.code ?? "");
}

async function healthy(endpoint: Endpoint): Promise<boolean> {
    try {
        const res = await fetch(`${endpoint.url}/v1/models`, {
            headers: headers(endpoint),
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

/** VSIX extraction may drop the executable bit. */
async function ensureExecutable(file: string) {
    if (process.platform === "win32") {
        return;
    }
    try {
        await access(file, constants.X_OK);
    } catch {
        await chmod(file, 0o755);
    }
}

function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            onLine(buf.slice(0, i).replace(/\r$/, ""));
            buf = buf.slice(i + 1);
        }
    });
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
