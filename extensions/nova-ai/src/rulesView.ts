import * as vscode from "vscode";
import {
  openEditableWorkspaceRules,
  readEditableWorkspaceRules,
  readWorkspaceRules,
  saveEditableWorkspaceRules
} from "./rules";

type RulesMessage =
  | { type: "ready" }
  | { type: "save"; content: string }
  | { type: "open" }
  | { type: "refresh" };

export class NovaRulesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nova.rulesView";
  private view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message: RulesMessage) => {
      void this.handleMessage(message);
    });
  }

  async reveal() {
    await vscode.commands.executeCommand(`${NovaRulesViewProvider.viewType}.focus`);
    await this.postState();
  }

  private async handleMessage(message: RulesMessage) {
    try {
      if (message.type === "ready" || message.type === "refresh") {
        await this.postState();
        return;
      }

      if (message.type === "save") {
        await saveEditableWorkspaceRules(message.content);
        await this.postState("Rules saved.");
        return;
      }

      if (message.type === "open") {
        await openEditableWorkspaceRules();
        await this.postState("Rules opened.");
      }
    } catch (error) {
      this.post({ type: "error", content: error instanceof Error ? error.message : "Nova rules action failed." });
    }
  }

  private async postState(message?: string) {
    this.post({
      type: "state",
      editable: await readEditableWorkspaceRules(),
      discovered: await readWorkspaceRules(),
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
  <title>Nova Rules</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-sideBarSectionHeader-border);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --secondary: var(--vscode-button-secondaryBackground);
      --input: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
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
    h1, h2 {
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
    textarea {
      width: 100%;
      min-height: 240px;
      resize: vertical;
      color: var(--input-fg);
      background: var(--input);
      border: 1px solid var(--vscode-input-border);
      padding: 8px;
      font: inherit;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.45;
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
    button:focus,
    textarea:focus {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }
    .sources {
      display: grid;
      gap: 8px;
    }
    .source {
      border: 1px solid var(--line);
      padding: 8px;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .source strong {
      display: block;
      margin-bottom: 6px;
      color: var(--fg);
    }
    .error {
      color: var(--error);
    }
  </style>
</head>
<body>
  <main>
    <section class="status">
      <h1>Workspace Rules</h1>
      <span id="path">.nova/rules.md</span>
      <span id="message"></span>
    </section>

    <section>
      <textarea id="content" spellcheck="false" placeholder="# Nova workspace rules"></textarea>
    </section>

    <section class="actions">
      <button id="save" type="button">Save</button>
      <button id="open" class="secondary" type="button">Open</button>
      <button id="refresh" class="secondary" type="button">Refresh</button>
    </section>

    <section class="sources">
      <h2>Loaded Rule Sources</h2>
      <div id="sources"></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const message = document.getElementById("message");
    const path = document.getElementById("path");
    const sources = document.getElementById("sources");

    function render(state) {
      path.textContent = state.editable.path + (state.editable.exists ? "" : " · new");
      content.value = state.editable.content || "# Nova workspace rules\\n\\n";
      message.textContent = state.message || "";
      message.className = "";
      sources.textContent = "";

      if (!state.discovered.length) {
        const empty = document.createElement("div");
        empty.className = "source";
        empty.textContent = "No workspace rules loaded yet.";
        sources.appendChild(empty);
        return;
      }

      for (const rule of state.discovered) {
        const node = document.createElement("article");
        node.className = "source";
        const title = document.createElement("strong");
        title.textContent = rule.source;
        const body = document.createElement("span");
        body.textContent = rule.content;
        node.appendChild(title);
        node.appendChild(body);
        sources.appendChild(node);
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

    document.getElementById("save").addEventListener("click", () => {
      vscode.postMessage({ type: "save", content: content.value });
    });
    document.getElementById("open").addEventListener("click", () => {
      vscode.postMessage({ type: "open" });
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

function getNonce() {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";

  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}
