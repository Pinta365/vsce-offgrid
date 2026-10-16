import * as vscode from "vscode";
import { ChatProvider } from "./chat";
import { CompletionProvider } from "./completion";
import { Models, Role } from "./models";
import { Server, State } from "./server";

/** Settings that change what the server loads. */
const LAUNCH_SETTINGS = [
    "offgrid.completion.model",
    "offgrid.chat.enabled",
    "offgrid.chat.model",
    "offgrid.chat.contextSize",
    "offgrid.completion.contextSize",
    "offgrid.cacheType",
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
        vscode.commands.registerCommand("offgrid.setup", () => setup(models, server, chat)),
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
                chat.refresh();
                void server.restart();
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
        await setup(models, server, chat);
    } else {
        await context.globalState.update("setupDismissed", true);
        await server.ensure();
    }
}

async function setup(models: Models, server: Server, chat: ChatProvider) {
    type Pick = vscode.QuickPickItem & { action: () => Promise<unknown> };
    const picks: Pick[] = [];
    const download = async (roles: Role[]) => {
        try {
            for (const role of roles) {
                if (!(await models.download(role))) {
                    return; // cancelled
                }
            }
        } catch (e) {
            void vscode.window.showErrorMessage(`offgrid: ${e instanceof Error ? e.message : e}`);
            return;
        }
        chat.refresh();
        await server.restart();
    };
    const missing = (["completion", "chat"] as Role[]).filter((r) => !models.resolve(r) && !models.missingCustom(r));
    if (missing.length === 2) {
        picks.push({
            label: "$(cloud-download) Download both models",
            description: `${((models.known("completion").size + models.known("chat").size) / 2 ** 30).toFixed(1)} GB`,
            detail: `${models.known("completion").label} for code completion, ${models.known("chat").label} for chat`,
            action: () => download(missing),
        });
    }
    for (const role of ["completion", "chat"] as Role[]) {
        const what = role === "completion" ? "code completion" : "chat";
        const known = models.known(role);
        const have = models.resolve(role);
        picks.push(
            have
                ? { label: `$(check) ${what}: ${have}`, action: async () => undefined }
                : {
                      label: `$(cloud-download) Download ${known.label} for ${what}`,
                      description: `${(known.size / 2 ** 30).toFixed(1)} GB`,
                      action: () => download([role]),
                  },
            {
                label: `$(folder-opened) Use a GGUF file for ${what}…`,
                action: async () => {
                    const file = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        filters: { "GGUF models": ["gguf"] },
                        title: `Model for ${what}`,
                    });
                    if (file?.[0]) {
                        // The settings listener restarts the server.
                        await vscode.workspace
                            .getConfiguration("offgrid")
                            .update(`${role}.model`, file[0].fsPath, vscode.ConfigurationTarget.Global);
                    }
                },
            },
        );
    }
    picks.push({
        label: "$(file-binary) Use an offgrid-server binary…",
        description: vscode.workspace.getConfiguration("offgrid").get<string>("serverPath", "") || "bundled",
        action: async () => {
            const file = await vscode.window.showOpenDialog({ canSelectMany: false, title: "offgrid-server binary" });
            if (file?.[0]) {
                await vscode.workspace
                    .getConfiguration("offgrid")
                    .update("serverPath", file[0].fsPath, vscode.ConfigurationTarget.Global);
            }
        },
    });
    const pick = await vscode.window.showQuickPick(picks, { title: "offgrid: models and server" });
    await pick?.action();
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
