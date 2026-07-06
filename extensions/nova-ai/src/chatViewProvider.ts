import * as vscode from "vscode";
import {
  getActiveEditorContext,
  hasApiKey,
  isModelProfileReady,
  requestChatCompletionStream,
  testModelConnection
} from "./modelClient";
import { getActiveProfile } from "./profiles";

type WebviewMessage =
  | { type: "ready" }
  | { type: "ask"; prompt: string }
  | { type: "explain" }
  | { type: "tests" }
  | { type: "agent" }
  | { type: "pickProfile" }
  | { type: "testModel" }
  | { type: "configureModel" };

export class NovaChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nova.chatView";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionContext: vscode.ExtensionContext
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }

  async ask(prompt: string) {
    await this.sendPrompt(prompt);
  }

  private async handleMessage(message: WebviewMessage) {
    if (message.type === "ready") {
      this.postState();
      return;
    }

    if (message.type === "configureModel") {
      await vscode.commands.executeCommand("nova.configureModel");
      this.postState();
      return;
    }

    if (message.type === "pickProfile") {
      await vscode.commands.executeCommand("nova.pickModelProfile");
      this.postState();
      return;
    }

    if (message.type === "testModel") {
      await this.testModel();
      return;
    }

    if (message.type === "explain") {
      await this.sendPrompt("Explain the active file. Focus on architecture, data flow, and likely risks.");
      return;
    }

    if (message.type === "tests") {
      await this.sendPrompt("Generate high-value tests for the active file. Include runnable examples.");
      return;
    }

    if (message.type === "agent") {
      await vscode.commands.executeCommand("nova.runAgent");
      this.postState();
      return;
    }

    if (message.type === "ask") {
      await this.sendPrompt(message.prompt);
    }
  }

  private async sendPrompt(prompt: string) {
    if (!prompt.trim()) {
      return;
    }

    this.post({ type: "user", content: prompt });
    this.post({ type: "loading", value: true });

    try {
      const context = getActiveEditorContext();
      let hasStartedAssistantMessage = false;
      await requestChatCompletionStream(prompt, context, this.extensionContext, {
        onDelta: (delta) => {
          if (!hasStartedAssistantMessage) {
            hasStartedAssistantMessage = true;
            this.post({ type: "assistantStart" });
          }

          this.post({ type: "assistantDelta", content: delta });
        }
      });
      this.post({ type: "assistantDone" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nova request failed.";
      this.post({ type: "error", content: message });
    } finally {
      this.post({ type: "loading", value: false });
      this.postState();
    }
  }

  private async testModel() {
    this.post({ type: "loading", value: true });

    try {
      const result = await testModelConnection(this.extensionContext);
      this.post({
        type: result.ok ? "assistant" : "error",
        content: `${result.message}\n${result.modelId} · ${result.baseUrl} · ${result.latencyMs}ms`
      });
    } finally {
      this.post({ type: "loading", value: false });
      this.postState();
    }
  }

  private postState() {
    const context = getActiveEditorContext();
    const activeProfile = getActiveProfile(this.extensionContext);
    void Promise.all([hasApiKey(this.extensionContext), isModelProfileReady(this.extensionContext)]).then(([profileHasApiKey, ready]) => {
      this.post({
        type: "state",
        fileName: context?.fileName ?? "No active file",
        modelId: activeProfile.modelId,
        profileLabel: activeProfile.label,
        hasApiKey: profileHasApiKey,
        requiresApiKey: activeProfile.requiresApiKey,
        ready
      });
    });
  }

  private post(message: unknown) {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview) {
    const nonce = getNonce();

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nova Chat</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-sideBarSectionHeader-border);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --input: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --focus: var(--vscode-focusBorder);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: var(--fg);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      height: 100vh;
      min-height: 0;
    }
    header {
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 700;
    }
    .state {
      display: grid;
      gap: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
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
      background: var(--vscode-button-secondaryBackground);
    }
    button:focus,
    textarea:focus {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }
    #messages {
      min-height: 0;
      overflow: auto;
      padding: 12px;
    }
    .message {
      padding: 10px;
      margin-bottom: 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .message.user {
      border-color: var(--focus);
    }
    .message.error {
      color: var(--vscode-errorForeground);
    }
    form {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--line);
    }
    textarea {
      width: 100%;
      min-height: 86px;
      resize: vertical;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      color: var(--input-fg);
      background: var(--input);
      font: inherit;
    }
    .loading {
      display: none;
      color: var(--muted);
      font-size: 12px;
    }
    .loading.visible {
      display: block;
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>Nova Agent</h1>
      <div class="state">
        <span id="file">No active file</span>
        <span id="model">Model not loaded</span>
        <button id="profile" class="secondary" type="button">Switch Profile</button>
        <button id="testModel" class="secondary" type="button">Test Model</button>
        <button id="settings" class="secondary" type="button">Configure Model</button>
      </div>
    </header>
    <section class="actions">
      <button id="explain" type="button">Explain</button>
      <button id="tests" type="button">Tests</button>
      <button id="agent" type="button">Agent</button>
    </section>
    <section id="messages" aria-live="polite"></section>
    <form id="composer">
      <div id="loading" class="loading">Nova is thinking...</div>
      <textarea id="prompt" placeholder="Ask Nova about the active file"></textarea>
      <button type="submit">Send</button>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const prompt = document.getElementById("prompt");
    const loading = document.getElementById("loading");
    const file = document.getElementById("file");
    const model = document.getElementById("model");
    let streamingAssistantMessage = undefined;

    function appendMessage(kind, content) {
      const node = document.createElement("article");
      node.className = "message " + kind;
      node.textContent = content;
      messages.appendChild(node);
      messages.scrollTop = messages.scrollHeight;
      return node;
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "user" || message.type === "assistant" || message.type === "error") {
        appendMessage(message.type, message.content);
      }
      if (message.type === "assistantStart") {
        streamingAssistantMessage = appendMessage("assistant", "");
      }
      if (message.type === "assistantDelta") {
        if (!streamingAssistantMessage) {
          streamingAssistantMessage = appendMessage("assistant", "");
        }
        streamingAssistantMessage.textContent += message.content;
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === "assistantDone") {
        streamingAssistantMessage = undefined;
      }
      if (message.type === "loading") {
        loading.classList.toggle("visible", Boolean(message.value));
      }
      if (message.type === "state") {
        file.textContent = message.fileName;
        const profile = message.profileLabel ? message.profileLabel + " · " : "";
        if (message.ready) {
          model.textContent = message.requiresApiKey
            ? profile + message.modelId
            : profile + message.modelId + " · no API key";
        } else {
          model.textContent = profile + message.modelId + " · API key missing";
        }
      }
    });

    document.getElementById("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const value = prompt.value.trim();
      if (!value) {
        return;
      }
      vscode.postMessage({ type: "ask", prompt: value });
      prompt.value = "";
    });

    document.getElementById("explain").addEventListener("click", () => vscode.postMessage({ type: "explain" }));
    document.getElementById("tests").addEventListener("click", () => vscode.postMessage({ type: "tests" }));
    document.getElementById("agent").addEventListener("click", () => vscode.postMessage({ type: "agent" }));
    document.getElementById("profile").addEventListener("click", () => vscode.postMessage({ type: "pickProfile" }));
    document.getElementById("testModel").addEventListener("click", () => vscode.postMessage({ type: "testModel" }));
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "configureModel" }));
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
