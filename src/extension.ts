import * as vscode from "vscode";
import { ChatProvider } from "./chat";
import { CompletionProvider } from "./completion";
import * as os from "os";
import * as path from "path";
import { CHAT_MODEL, CHAT_MODELS, COMPLETION_MODEL, KnownModel, Models, Role, SETUPS, Setup } from "./models";
import { GPU_MEMORY_KEY, Server, State } from "./server";

/** globalState key: the user chose "Not Now" in the first-run prompt. */
const SETUP_DISMISSED_KEY = "setupDismissed";

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
        vscode.commands.registerCommand("offgrid.reset", () => reset(context, models, server, chat)),
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
    if (context.globalState.get<boolean>(SETUP_DISMISSED_KEY)) {
        await server.ensure(); // shows "set up" in the status bar
        return;
    }
    const pick = await vscode.window.showInformationMessage(
        "offgrid runs code completion and chat on this machine. Pick a setup that fits it to download the models (once).",
        "Set Up",
        "Not Now",
    );
    if (pick === "Set Up") {
        await setup(context, models, server, chat);
    } else {
        await context.globalState.update(SETUP_DISMISSED_KEY, true);
        await server.ensure();
    }
}

async function setup(context: vscode.ExtensionContext, models: Models, server: Server, chat: ChatProvider) {
    type Pick = vscode.QuickPickItem & { action?: () => Promise<unknown> };
    const cfg = () => vscode.workspace.getConfiguration("offgrid");
    const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
    const section = (label: string): Pick => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const fail = (e: unknown) => void vscode.window.showErrorMessage(`offgrid: ${e instanceof Error ? e.message : e}`);

    /** Download, then restart unless the caller changes settings (which restarts it). */
    const download = async (which: (Role | KnownModel)[], restart = true) => {
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
        if (restart) {
            await server.restart();
        }
        return true;
    };
    /**
     * Make `model` the chat model. Changed settings restart the server (once, debounced); if
     * nothing changed, restart here so newly downloaded models load.
     */
    const useChat = async (model: KnownModel) => {
        const gpu = context.globalState.get<number>(GPU_MEMORY_KEY);
        // A GPU big enough for the whole model doesn't need experts on the CPU.
        const experts = model.large && !(gpu && gpu >= model.large.gpuGiB * 1.5) ? model.large.expertLayersOnCpu : undefined;
        const wanted: [string, unknown][] = [
            ["chat.model", model === CHAT_MODEL ? undefined : models.pathOf(model)],
            ["chat.expertLayersOnCpu", experts],
            ["chat.contextSize", model.contextSize],
        ];
        const changes = wanted.filter(([key, value]) => cfg().inspect(key)?.globalValue !== value);
        for (const [key, value] of changes) {
            await cfg().update(key, value, vscode.ConfigurationTarget.Global);
        }
        if (changes.length === 0) {
            chat.refresh();
            await server.restart();
        }
    };
    const pickFile = async (role: Role, what: string) => {
        const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "GGUF models": ["gguf"] }, title: `Model for ${what}` });
        if (file?.[0]) {
            await cfg().update(`${role}.model`, file[0].fsPath, vscode.ConfigurationTarget.Global);
        }
    };

    // What this machine has: the GPU from the server's device list (probed once), RAM from the OS.
    let gpu = context.globalState.get<number>(GPU_MEMORY_KEY);
    if (gpu === undefined) {
        gpu = await server.probeGpu();
    }
    const ram = os.totalmem() / 2 ** 30;
    const machine = `${gpu === undefined ? "GPU memory unknown" : gpu ? `${Math.round(gpu)} GB GPU` : "no dedicated GPU"}, ${Math.round(ram)} GB RAM`;
    // Cards sold as 8 or 16 GB report a little less.
    const fits = (s: Setup) => (gpu === undefined || s.gpuGiB === 0 || gpu >= s.gpuGiB * 0.95) && ram >= s.ramGiB * 0.95;
    // The biggest setup that fits, except Large: heavy enough that it's always a deliberate choice.
    const recommended = gpu === undefined ? undefined : [...SETUPS].reverse().find((s) => s.name !== "Large" && fits(s));

    const fitText = (s: Setup) =>
        gpu === undefined && s.gpuGiB > 0
            ? `$(question) Needs a ${s.gpuGiB} GB GPU (${machine})`
            : fits(s)
              ? `$(check) Fits this machine (${machine})`
              : `$(warning) Too large for this machine (${machine})`;
    /** For a large or too-large choice: say what it needs, and let the user back out. */
    const confirm = async (s: Setup, what: string, size: number) => {
        if (!s.chat.large && fits(s)) {
            return true;
        }
        const need = `${s.gpuGiB ? `a GPU with at least ${s.gpuGiB} GB of memory and ` : ""}${s.ramGiB} GB of RAM`;
        const go = await vscode.window.showWarningMessage(
            `${what} needs ${need}${size ? ` and downloads ${gb(size)}` : ""}.`,
            {
                modal: true,
                detail:
                    (s.chat.large ? "While it is loaded it uses almost all of the GPU's memory, so close other GPU-heavy programs. " : "") +
                    (fits(s) ? "" : `This machine has ${machine}: it would run very slowly or not load at all. `) +
                    "You can switch in this list at any time.",
            },
            size ? "Download" : "Use It",
        );
        return go !== undefined;
    };

    const current = models.chatFile();
    const completionModel = models.resolve("completion");
    const chatName = models.byPath(current)?.short ?? path.basename(current);
    const completionName = completionModel ? (models.byPath(completionModel)?.short ?? path.basename(completionModel)) : "none";

    const picks: Pick[] = [section("Setups: a chat model and the code model, downloaded together")];
    for (const setup of SETUPS) {
        const chatModel = setup.chat;
        const inUse = current === models.pathOf(chatModel) && models.downloaded(chatModel) && !!completionModel;
        const missing = [COMPLETION_MODEL, chatModel].filter((m) => !models.downloaded(m) && (m !== COMPLETION_MODEL || !completionModel));
        const size = missing.reduce((n, m) => n + m.size, 0);
        picks.push({
            label: `${inUse ? "$(check)" : !fits(setup) ? "$(warning)" : missing.length ? "$(cloud-download)" : "$(arrow-right)"} ${setup.name}`,
            description: [
                `${chatModel.short} + ${COMPLETION_MODEL.short}`,
                inUse ? "in use" : missing.length ? gb(size) : "downloaded",
                setup === recommended && !inUse ? "recommended" : "",
            ]
                .filter(Boolean)
                .join(" · "),
            // The fit first: VS Code cuts long details off.
            detail: `${fitText(setup)}. ${setup.detail}.`,
            action: inUse
                ? undefined
                : async () => {
                      if ((await confirm(setup, setup.name, size)) && (missing.length === 0 || (await download(missing, false)))) {
                          await useChat(chatModel);
                      }
                  },
        });
    }
    picks.push(section("Or"));
    picks.push({
        label: "$(list-unordered) Choose models one by one…",
        description: `chat: ${chatName} · code completion: ${completionName}`,
        detail: "Download or switch the chat and code completion models separately, or use your own GGUF files.",
        action: () => chooseModels(),
    });
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
    const pick = await vscode.window.showQuickPick(picks, { title: "offgrid: set up" });
    await pick?.action?.();

    /** The second level: each model on its own. */
    async function chooseModels() {
        const items: Pick[] = [section("Code completion")];
        items.push(
            completionModel
                ? { label: `$(check) ${completionName}`, description: "in use for code completion", detail: models.byPath(completionModel) ? undefined : completionModel }
                : {
                      label: `$(cloud-download) Download ${COMPLETION_MODEL.short}`,
                      description: `${gb(COMPLETION_MODEL.size)} · ${COMPLETION_MODEL.quant}`,
                      detail: "Runs on any machine.",
                      action: () => download(["completion"]),
                  },
            { label: "$(folder-opened) Use a GGUF file for code completion…", action: () => pickFile("completion", "code completion") },
        );

        items.push(section("Chat"));
        if (!CHAT_MODELS.some((m) => models.pathOf(m) === current)) {
            items.push({ label: `$(check) ${path.basename(current)}`, description: "in use for chat (your file)", detail: current });
        }
        for (const model of CHAT_MODELS) {
            const setup = SETUPS.find((s) => s.chat === model)!;
            if (current === models.pathOf(model) && models.downloaded(model)) {
                items.push({ label: `$(check) ${model.short}`, description: "in use for chat" });
            } else if (models.downloaded(model)) {
                items.push({
                    label: `$(arrow-right) Use ${model.short} for chat`,
                    description: "downloaded",
                    detail: `${fitText(setup)}.`,
                    action: async () => (await confirm(setup, model.short, 0)) && useChat(model),
                });
            } else {
                items.push({
                    label: `${fits(setup) ? "$(cloud-download)" : "$(warning)"} Download ${model.short} for chat`,
                    description: `${gb(model.size)} · ${model.quant}`,
                    detail: `${fitText(setup)}.`,
                    action: async () => {
                        if ((await confirm(setup, model.short, model.size)) && (await download([model], false))) {
                            await useChat(model);
                        }
                    },
                });
            }
        }
        items.push({ label: "$(folder-opened) Use a GGUF file for chat…", action: () => pickFile("chat", "chat") });
        const choice = await vscode.window.showQuickPick(items, { title: "offgrid: choose models one by one" });
        await choice?.action?.();
    }
}

/** Back to a fresh install: settings, remembered state, and optionally the downloaded models. */
async function reset(context: vscode.ExtensionContext, models: Models, server: Server, chat: ChatProvider) {
    const bytes = await models.downloadedBytes();
    const choices = bytes > 0 ? ["Reset Settings", "Reset and Delete Models"] : ["Reset Settings"];
    const pick = await vscode.window.showWarningMessage(
        "Reset offgrid to a fresh install?",
        {
            modal: true,
            detail:
                "This removes all offgrid settings (user and workspace) and what the extension remembers, and stops its server." +
                (bytes > 0 ? ` Downloaded models (${(bytes / 2 ** 30).toFixed(1)} GB) are kept unless you also delete them.` : ""),
        },
        ...choices,
    );
    if (!pick) {
        return;
    }
    await server.stop();
    const cfg = vscode.workspace.getConfiguration("offgrid");
    const keys = Object.keys(context.extension.packageJSON.contributes.configuration.properties as object).map((k) =>
        k.replace(/^offgrid\./, ""),
    );
    for (const key of keys) {
        const set = cfg.inspect(key);
        if (set?.globalValue !== undefined) {
            await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
        }
        if (set?.workspaceValue !== undefined) {
            await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        }
    }
    for (const key of context.globalState.keys()) {
        await context.globalState.update(key, undefined);
    }
    if (pick === "Reset and Delete Models") {
        await models.deleteDownloads();
    }
    chat.refresh();
    void vscode.window.showInformationMessage("offgrid was reset.");
    await firstRun(context, models, server, chat);
}

async function menu(server: Server) {
    const completion = vscode.workspace.getConfiguration("offgrid").get<boolean>("completion.enabled", true);
    const items: (vscode.QuickPickItem & { command: string })[] = [
        { label: completion ? "$(circle-slash) Turn off code completion" : "$(sparkle) Turn on code completion", command: "offgrid.toggleCompletions" },
        { label: "$(cloud-download) Set up models…", command: "offgrid.setup" },
        { label: "$(gear) Settings…", command: "offgrid.settings" },
        { label: "$(debug-restart) Restart server", command: "offgrid.restart" },
        { label: "$(output) Show log", command: "offgrid.showLog" },
        { label: "$(discard) Reset…", command: "offgrid.reset" },
    ];
    const [, tip] = describe(server.state);
    const pick = await vscode.window.showQuickPick(items, { title: tip });
    if (pick) {
        await vscode.commands.executeCommand(pick.command);
    }
}
