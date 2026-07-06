import * as vscode from "vscode";

type AgentTaskMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "open"; path: string };

export type AgentTaskItem = {
  path: string;
  kind: "plan" | "run";
  title: string;
  modifiedAt: number;
  excerpt: string;
};

const MAX_TASKS = 30;

export class NovaAgentTasksViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nova.agentTasksView";
  private view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message: AgentTaskMessage) => {
      void this.handleMessage(message);
    });
  }

  async reveal() {
    await vscode.commands.executeCommand(`${NovaAgentTasksViewProvider.viewType}.focus`);
    await this.postState();
  }

  private async handleMessage(message: AgentTaskMessage) {
    try {
      if (message.type === "ready" || message.type === "refresh") {
        await this.postState();
        return;
      }

      if (message.type === "open") {
        await openAgentTask(message.path);
        await this.postState("Task opened.");
      }
    } catch (error) {
      this.post({ type: "error", content: error instanceof Error ? error.message : "Nova Agent task action failed." });
    }
  }

  private async postState(message?: string) {
    this.post({
      type: "state",
      tasks: await listAgentTasks(),
      message
    });
  }

  private post(message: unknown) {
    void this.view?.webview.postMessage(message);
  }

  private getHtml() {
    const nonce = getNonce();

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nova Agent Tasks</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-sideBarSectionHeader-border);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --secondary: var(--vscode-button-secondaryBackground);
      --focus: var(--vscode-focusBorder);
      --error: var(--vscode-errorForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    main {
      display: grid;
      gap: 12px;
      padding: 12px;
    }
    h1 {
      margin: 0;
      font-size: 13px;
    }
    .status {
      display: grid;
      gap: 4px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    button {
      min-height: 30px;
      border: 0;
      border-radius: 3px;
      color: var(--button-fg);
      background: var(--button);
      cursor: pointer;
      font: inherit;
    }
    button.secondary {
      color: var(--fg);
      background: var(--secondary);
    }
    button:focus {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }
    .tasks {
      display: grid;
      gap: 8px;
    }
    .task {
      display: grid;
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--fg);
      text-align: left;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .excerpt {
      color: var(--muted);
      white-space: pre-wrap;
      line-height: 1.35;
      max-height: 74px;
      overflow: hidden;
    }
    .error {
      color: var(--error);
    }
  </style>
</head>
<body>
  <main>
    <section class="status">
      <h1>Agent Tasks</h1>
      <span id="message"></span>
      <button id="refresh" class="secondary" type="button">Refresh</button>
    </section>
    <section id="tasks" class="tasks"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tasks = document.getElementById("tasks");
    const message = document.getElementById("message");

    function render(state) {
      message.textContent = state.message || "";
      message.className = "";
      tasks.textContent = "";

      if (!state.tasks.length) {
        const empty = document.createElement("div");
        empty.className = "task";
        empty.textContent = "No Agent plans or run reports yet.";
        tasks.appendChild(empty);
        return;
      }

      for (const task of state.tasks) {
        const button = document.createElement("button");
        button.className = "task";
        button.type = "button";
        button.addEventListener("click", () => vscode.postMessage({ type: "open", path: task.path }));

        const title = document.createElement("strong");
        title.textContent = task.title;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = task.kind + " · " + task.path;
        const excerpt = document.createElement("span");
        excerpt.className = "excerpt";
        excerpt.textContent = task.excerpt;

        button.appendChild(title);
        button.appendChild(meta);
        button.appendChild(excerpt);
        tasks.appendChild(button);
      }
    }

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data.type === "state") {
        render(data);
      }
      if (data.type === "error") {
        message.textContent = data.content;
        message.className = "error";
      }
    });

    document.getElementById("refresh").addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

export async function listAgentTasks(): Promise<AgentTaskItem[]> {
  const folder = getWorkspaceFolder();
  const [plans, runs] = await Promise.all([
    findAgentTaskFiles(folder, ".nova/plans/*.md", "plan"),
    findAgentTaskFiles(folder, ".nova/runs/*.md", "run")
  ]);

  return [...plans, ...runs].sort((first, second) => second.modifiedAt - first.modifiedAt).slice(0, MAX_TASKS);
}

export async function openAgentTask(relativePath: string) {
  const uri = resolveAgentTaskPath(relativePath);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function findAgentTaskFiles(
  folder: vscode.WorkspaceFolder,
  pattern: string,
  kind: AgentTaskItem["kind"]
): Promise<AgentTaskItem[]> {
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, MAX_TASKS);
  const tasks: AgentTaskItem[] = [];

  for (const uri of files) {
    const content = await readFile(uri);
    const stat = await vscode.workspace.fs.stat(uri);
    const relativePath = vscode.workspace.asRelativePath(uri, false);

    tasks.push({
      path: relativePath,
      kind,
      title: extractTitle(content, kind),
      modifiedAt: stat.mtime,
      excerpt: extractExcerpt(content)
    });
  }

  return tasks;
}

function extractTitle(content: string, kind: AgentTaskItem["kind"]) {
  const summary = content.match(/^Summary:\s*(.+)$/m)?.[1]?.trim();

  if (summary) {
    return summary;
  }

  return kind === "plan" ? "Nova Agent Plan" : "Nova Agent Run";
}

function extractExcerpt(content: string) {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .slice(0, 4)
    .join("\n")
    .slice(0, 360);
}

async function readFile(uri: vscode.Uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

function resolveAgentTaskPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (
    !(
      normalized.startsWith(".nova/plans/") ||
      normalized.startsWith(".nova/runs/")
    ) ||
    normalized.includes("../")
  ) {
    throw new Error(`Nova Agent task path is not allowed: ${relativePath}`);
  }

  return vscode.Uri.joinPath(getWorkspaceFolder().uri, ...normalized.split("/"));
}

function getWorkspaceFolder() {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    throw new Error("Open a workspace folder before viewing Nova Agent tasks.");
  }

  return folder;
}

function getNonce() {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";

  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}
