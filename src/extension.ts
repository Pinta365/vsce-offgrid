import * as vscode from "vscode";
import { ChatProvider } from "./chat";
import { CompletionProvider } from "./completion";
import * as os from "os";
import * as path from "path";
import { CHAT_MODEL, CHAT_MODELS, COMPLETION_MODEL, KnownModel, Models, Role } from "./models";
import { GPU_MEMORY_KEY, Server, State } from "./server";

/** Settings that change what the server loads. */
const LAUNCH_SETTINGS = [
    "offgrid.completion.model",
    "offgrid.chat.enabled",
    "offgrid.chat.model",
    "offgrid.chat.contextSize",
    "offgrid.completion.contextSize",
    "offgrid.cacheType",
    "offgrid.chat.expertLayersOnCpu",
    "offgrid.gpu",
    "offgrid.serverPath",
];

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel("offgrid", { log: true });
    const models = new Models(context.globalStorageUri);
    const server = new Server(context, models, log);

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.command = "offgrid.menu";
    let lastTiming = "";
    const render = (state: State = server.state) => {
        const completion = vscode.workspace.getConfiguration("offgrid").get<boolean>("completion.enabled", true);
        const [icon, tip] = describe(state);
        item.text = `${completion ? icon : "$(circle-slash)"} offgrid${state.kind === "ready" && lastTiming ? ` ${lastTiming}` : ""}`;
        item.tooltip = `${tip}${completion ? "" : "\nCode completion is off."}\nClick for options.`;
        item.show();
    };
    render();

    const completion = new CompletionProvider(server, log, (timing) => {
        lastTiming = timing;
        render();
    });
    const chat = new ChatProvider(server, models, log);
    let restartTimer: NodeJS.Timeout | undefined;

    context.subscriptions.push(
        log,
        server,
        item,
        completion,
        server.onDidChangeState((s) => {
            render(s);
            if (s.kind === "error") {
                void showError(s.message);
            }
        }),
        // Editors only: the chat input box is a document too.
        vscode.languages.registerInlineCompletionItemProvider(
            [{ scheme: "file" }, { scheme: "untitled" }, { scheme: "vscode-notebook-cell" }],
            completion,
        ),
        vscode.lm.registerLanguageModelChatProvider("offgrid", chat),
        vscode.commands.registerCommand("offgrid.setup", () => setup(context, models, server, chat)),
        vscode.commands.registerCommand("offgrid.restart", () => server.restart()),
        vscode.commands.registerCommand("offgrid.showLog", () => log.show()),
        vscode.commands.registerCommand("offgrid.toggleCompletions", async () => {
            const cfg = vscode.workspace.getConfiguration("offgrid");
            await cfg.update("completion.enabled", !cfg.get<boolean>("completion.enabled", true), vscode.ConfigurationTarget.Global);
        }),
        vscode.commands.registerCommand("offgrid.menu", () => menu(server)),
        vscode.commands.registerCommand("offgrid.settings", () =>
            vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
        ),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("offgrid.completion.enabled")) {
                render();
            }
            if (LAUNCH_SETTINGS.some((s) => e.affectsConfiguration(s))) {
                // Setup changes several settings at once: restart (and load the models) once.
                clearTimeout(restartTimer);
                restartTimer = setTimeout(() => {
                    chat.refresh();
                    void server.restart();
                }, 300);
            }
        }),
    );

    void firstRun(context, models, server, chat);
}

export function deactivate() {}

function describe(state: State): [string, string] {
    switch (state.kind) {
        case "stopped":
            return ["$(circle-outline)", "offgrid: not running"];
        case "setup":
            return ["$(cloud-download)", `offgrid: ${state.message}`];
        case "starting":
            return ["$(sync~spin)", "offgrid: loading models…"];
        case "ready": {
            const what = [state.endpoint.completion && "code completion", state.endpoint.chat && "chat"].filter(Boolean).join(" and ");
            return ["$(sparkle)", `offgrid: ${what} on ${state.device}`];
        }
        case "error":
            return ["$(error)", `offgrid: ${state.message}`];
    }
}

async function showError(message: string) {
    const pick = await vscode.window.showErrorMessage(`offgrid: ${message}`, "Show Log", "Open Settings");
    if (pick === "Show Log") {
        await vscode.commands.executeCommand("offgrid.showLog");
    } else if (pick === "Open Settings") {
        await vscode.commands.executeCommand("offgrid.settings");
    }
}

async function firstRun(context: vscode.ExtensionContext, models: Models, server: Server, chat: ChatProvider) {
    if (models.resolve("completion") || models.resolve("chat")) {
        await server.ensure();
        return;
    }
    if (context.globalState.get<boolean>("setupDismissed")) {
        await server.ensure(); // shows "set up" in the status bar
        return;
    }
    const pick = await vscode.window.showInformationMessage(
        "offgrid runs code completion and chat on this machine. It needs to download its models first (about 4 GB, once).",
        "Set Up",
        "Not Now",
    );
    if (pick === "Set Up") {
        await setup(context, models, server, chat);
    } else {
        await context.globalState.update("setupDismissed", true);
        await server.ensure();
    }
}

async function setup(context: vscode.ExtensionContext, models: Models, server: Server, chat: ChatProvider) {
    type Pick = vscode.QuickPickItem & { action?: () => Promise<unknown> };
    const cfg = () => vscode.workspace.getConfiguration("offgrid");
    const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
    const section = (label: string): Pick => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const fail = (e: unknown) => void vscode.window.showErrorMessage(`offgrid: ${e instanceof Error ? e.message : e}`);

    /** Download, then restart (a new default model doesn't change any setting). */
    const download = async (which: (Role | KnownModel)[]) => {
        try {
            for (const w of which) {
                if (!(await models.download(w))) {
                    return false; // cancelled
                }
            }
        } catch (e) {
            fail(e);
            return false;
        }
        chat.refresh();
        await server.restart();
        return true;
    };
    /** Make `model` the chat model (the settings listener restarts the server). */
    const useChat = async (model: KnownModel) => {
        const isDefault = model === CHAT_MODEL;
        const gpu = context.globalState.get<number>(GPU_MEMORY_KEY);
        // A GPU big enough for the whole model doesn't need experts on the CPU.
        const experts = model.large && !(gpu && gpu >= model.large.gpuGiB * 1.5) ? model.large.expertLayersOnCpu : undefined;
        await cfg().update("chat.model", isDefault ? undefined : models.pathOf(model), vscode.ConfigurationTarget.Global);
        await cfg().update("chat.expertLayersOnCpu", experts, vscode.ConfigurationTarget.Global);
    };
    const pickFile = async (role: Role, what: string) => {
        const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "GGUF models": ["gguf"] }, title: `Model for ${what}` });
        if (file?.[0]) {
            await cfg().update(`${role}.model`, file[0].fsPath, vscode.ConfigurationTarget.Global);
        }
    };

    const picks: Pick[] = [];
    const completionModel = models.resolve("completion");
    if (!completionModel && !models.resolve("chat") && !models.missingCustom("completion") && !models.missingCustom("chat")) {
        picks.push({
            label: "$(cloud-download) Download the standard models",
            description: gb(COMPLETION_MODEL.size + CHAT_MODEL.size),
            detail: `${COMPLETION_MODEL.label} for code completion, ${CHAT_MODEL.label} for chat. Runs on most machines.`,
            action: () => download(["completion", "chat"]),
        });
    }

    picks.push(section("Code completion"));
    picks.push(
        completionModel
            ? { label: `$(check) ${models.byPath(completionModel)?.short ?? completionModel}`, description: "in use" }
            : { label: `$(cloud-download) Download ${COMPLETION_MODEL.label}`, description: gb(COMPLETION_MODEL.size), action: () => download(["completion"]) },
        { label: "$(folder-opened) Use a GGUF file for code completion…", action: () => pickFile("completion", "code completion") },
    );

    const current = models.chatFile();
    /** A downloaded chat model: in use, or one click to switch to it. */
    const chatItem = (model: KnownModel): Pick =>
        current === models.pathOf(model)
            ? { label: `$(check) ${model.short}`, description: "in use for chat" }
            : { label: `$(arrow-right) Use ${model.short} for chat`, description: "downloaded", action: () => useChat(model) };
    picks.push(section("Chat"));
    if (!CHAT_MODELS.some((m) => models.pathOf(m) === current)) {
        picks.push({ label: `$(check) ${path.basename(current)}`, description: "in use for chat (your file)", detail: current });
    }
    picks.push(
        models.downloaded(CHAT_MODEL)
            ? chatItem(CHAT_MODEL)
            : {
                  label: `$(cloud-download) Download ${CHAT_MODEL.label}`,
                  description: gb(CHAT_MODEL.size),
                  detail: "Runs on most machines, including CPU-only ones (slowly).",
                  action: async () => (await download([CHAT_MODEL])) && useChat(CHAT_MODEL),
              },
        { label: "$(folder-opened) Use a GGUF file for chat…", action: () => pickFile("chat", "chat") },
    );

    // Large models: never a default; say what they need and whether this machine has it.
    const gpu = context.globalState.get<number>(GPU_MEMORY_KEY);
    const ram = os.totalmem() / 2 ** 30;
    for (const model of CHAT_MODELS.filter((m) => m.large)) {
        const need = model.large!;
        picks.push(section(`Large models: need a ${need.gpuGiB} GB GPU and ${need.ramGiB} GB RAM`));
        if (models.downloaded(model)) {
            picks.push(chatItem(model));
            continue;
        }
        // Cards sold as 16 GB report a little less.
        const gpuOk = gpu === undefined || gpu >= need.gpuGiB * 0.95;
        const ramOk = ram >= need.ramGiB * 0.95;
        const machine = `This machine: ${gpu ? `${Math.round(gpu)} GB GPU` : "GPU memory not known yet"}, ${Math.round(ram)} GB RAM.`;
        picks.push({
            label: `${gpuOk && ramOk ? "$(cloud-download)" : "$(warning)"} Download ${model.label}`,
            description: gb(model.size) + (gpuOk && ramOk ? "" : " — too large for this machine"),
            detail: `${need.why}. Runs part of the model on the CPU. ${machine}`,
            action: async () => {
                const warn = gpuOk && ramOk ? "" : `\n\n${machine} It would run very slowly or not load at all.`;
                const ok = await vscode.window.showWarningMessage(
                    `${model.short} is a ${gb(model.size)} download and needs a GPU with at least ${need.gpuGiB} GB of memory and ${need.ramGiB} GB of RAM.`,
                    {
                        modal: true,
                        detail: `While it is loaded it uses almost all of the GPU's memory, so close other GPU-heavy programs. You can switch back to ${CHAT_MODEL.short} in this list at any time.${warn}`,
                    },
                    "Download",
                );
                if (ok === "Download" && (await download([model]))) {
                    await useChat(model);
                }
            },
        });
    }

    picks.push(section("Server"));
    picks.push({
        label: "$(file-binary) Use an offgrid-server binary…",
        description: cfg().get<string>("serverPath", "") || "bundled",
        action: async () => {
            const file = await vscode.window.showOpenDialog({ canSelectMany: false, title: "offgrid-server binary" });
            if (file?.[0]) {
                await cfg().update("serverPath", file[0].fsPath, vscode.ConfigurationTarget.Global);
            }
        },
    });
    const pick = await vscode.window.showQuickPick(picks, { title: "offgrid: models and server" });
    await pick?.action?.();
}

async function menu(server: Server) {
    const completion = vscode.workspace.getConfiguration("offgrid").get<boolean>("completion.enabled", true);
    const items: (vscode.QuickPickItem & { command: string })[] = [
        { label: completion ? "$(circle-slash) Turn off code completion" : "$(sparkle) Turn on code completion", command: "offgrid.toggleCompletions" },
        { label: "$(cloud-download) Set up models…", command: "offgrid.setup" },
        { label: "$(gear) Settings…", command: "offgrid.settings" },
        { label: "$(debug-restart) Restart server", command: "offgrid.restart" },
        { label: "$(output) Show log", command: "offgrid.showLog" },
    ];
    const [, tip] = describe(server.state);
    const pick = await vscode.window.showQuickPick(items, { title: tip });
    if (pick) {
        await vscode.commands.executeCommand(pick.command);
    }
}
