import * as vscode from "vscode";
import { hasApiKey, isModelProfileReady, storeApiKey, testModelConnection } from "./modelClient";
import {
  buildProfileFromPreset,
  canDeleteProfile,
  deleteProfile,
  getActiveProfile,
  getProfiles,
  MODEL_PROVIDER_PRESETS,
  ModelProfile,
  normalizeModelProfile,
  saveProfile,
  setActiveProfile,
  validateProfileBody,
  validateProfileHeaders
} from "./profiles";
import { markSetupCompleted } from "./setup";

type ModelConfigMessage =
  | { type: "ready" }
  | { type: "selectProfile"; profileId: string }
  | { type: "createProfile"; presetId: string }
  | { type: "saveProfile"; profile: ModelProfile }
  | { type: "deleteProfile"; profileId: string }
  | { type: "setApiKey"; apiKey: string }
  | { type: "testModel" };

export class NovaModelConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nova.modelConfigView";
  private view?: vscode.WebviewView;

  constructor(private readonly extensionContext: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message: ModelConfigMessage) => {
      void this.handleMessage(message);
    });
  }

  async reveal() {
    await vscode.commands.executeCommand(`${NovaModelConfigViewProvider.viewType}.focus`);
    await this.postState();
  }

  private async handleMessage(message: ModelConfigMessage) {
    try {
      if (message.type === "ready") {
        await this.postState();
        return;
      }

      if (message.type === "selectProfile") {
        await setActiveProfile(this.extensionContext, message.profileId);
        await this.postState("Profile selected.");
        return;
      }

      if (message.type === "createProfile") {
        const profile = buildProfileFromPreset(message.presetId);
        await saveProfile(this.extensionContext, profile);
        if (!profile.requiresApiKey) {
          await markSetupCompleted(this.extensionContext);
        }
        await this.postState("Profile created.");
        return;
      }

      if (message.type === "saveProfile") {
        const validation = validateProfileInput(message.profile);
        if (validation) {
          this.post({ type: "error", content: validation });
          return;
        }

        const profile = normalizeModelProfile(message.profile);
        await saveProfile(this.extensionContext, profile);
        if (!profile.requiresApiKey || (await hasApiKey(this.extensionContext))) {
          await markSetupCompleted(this.extensionContext);
        }
        await this.postState("Profile saved.");
        return;
      }

      if (message.type === "deleteProfile") {
        if (!canDeleteProfile(message.profileId)) {
          this.post({ type: "error", content: "The default Nova profile cannot be deleted." });
          return;
        }

        await deleteProfile(this.extensionContext, message.profileId);
        await this.postState("Profile deleted.");
        return;
      }

      if (message.type === "setApiKey") {
        if (!message.apiKey.trim()) {
          this.post({ type: "error", content: "Enter an API key before saving." });
          return;
        }

        await storeApiKey(this.extensionContext, message.apiKey.trim());
        await markSetupCompleted(this.extensionContext);
        await this.postState("API key saved.");
        return;
      }

      if (message.type === "testModel") {
        const result = await testModelConnection(this.extensionContext);
        await this.postState(`${result.message} ${result.modelId} · ${result.baseUrl} · ${result.latencyMs}ms`);
      }
    } catch (error) {
      this.post({ type: "error", content: error instanceof Error ? error.message : "Nova model configuration failed." });
    }
  }

  private async postState(message?: string) {
    const activeProfile = getActiveProfile(this.extensionContext);
    this.post({
      type: "state",
      activeProfileId: activeProfile.id,
      profiles: getProfiles(this.extensionContext),
      presets: MODEL_PROVIDER_PRESETS,
      hasApiKey: await hasApiKey(this.extensionContext),
      ready: await isModelProfileReady(this.extensionContext),
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
  <title>Nova Model Configuration</title>
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
    label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    input, select, textarea {
      width: 100%;
      color: var(--input-fg);
      background: var(--input);
      border: 1px solid var(--vscode-input-border);
      padding: 7px;
      font: inherit;
    }
    textarea {
      min-height: 84px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
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
    button.danger {
      color: var(--vscode-button-foreground);
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    button:focus,
    input:focus,
    select:focus,
    textarea:focus {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }
    .grid {
      display: grid;
      gap: 8px;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .full {
      grid-column: 1 / -1;
    }
    .error {
      color: var(--error);
    }
  </style>
</head>
<body>
  <main>
    <section class="status">
      <h1>Model Runtime</h1>
      <span id="status">Loading...</span>
      <span id="message"></span>
    </section>

    <section class="grid">
      <h2>Profiles</h2>
      <label>
        Active profile
        <select id="profiles"></select>
      </label>
      <div class="row">
        <select id="presets"></select>
        <button id="create" type="button">Create</button>
      </div>
    </section>

    <section class="grid">
      <h2>Edit Profile</h2>
      <label>
        Name
        <input id="label" type="text">
      </label>
      <label>
        Base URL
        <input id="baseUrl" type="text">
      </label>
      <label>
        Model ID
        <input id="modelId" type="text">
      </label>
      <div class="row">
        <label>
          Temperature
          <input id="temperature" type="number" min="0" max="2" step="0.1">
        </label>
        <label>
          Auth
          <select id="requiresApiKey">
            <option value="true">API key</option>
            <option value="false">No key</option>
          </select>
        </label>
      </div>
      <label>
        Headers JSON
        <textarea id="headersJson" spellcheck="false"></textarea>
      </label>
      <label>
        Body JSON
        <textarea id="bodyJson" spellcheck="false"></textarea>
      </label>
      <div class="actions">
        <button id="save" type="button">Save Profile</button>
        <button id="delete" class="danger" type="button">Delete</button>
      </div>
    </section>

    <section class="grid">
      <h2>API Key</h2>
      <label>
        Key
        <input id="apiKey" type="password" placeholder="Stored in VS Code SecretStorage">
      </label>
      <div class="actions">
        <button id="saveKey" type="button">Save Key</button>
        <button id="test" class="secondary" type="button">Test</button>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { profiles: [], presets: [], activeProfileId: "default" };
    const elements = {
      status: document.getElementById("status"),
      message: document.getElementById("message"),
      profiles: document.getElementById("profiles"),
      presets: document.getElementById("presets"),
      label: document.getElementById("label"),
      baseUrl: document.getElementById("baseUrl"),
      modelId: document.getElementById("modelId"),
      temperature: document.getElementById("temperature"),
      requiresApiKey: document.getElementById("requiresApiKey"),
      headersJson: document.getElementById("headersJson"),
      bodyJson: document.getElementById("bodyJson"),
      apiKey: document.getElementById("apiKey"),
      deleteButton: document.getElementById("delete")
    };

    function activeProfile() {
      return state.profiles.find((profile) => profile.id === state.activeProfileId) || state.profiles[0];
    }

    function render(next) {
      state.profiles = next.profiles || [];
      state.presets = next.presets || [];
      state.activeProfileId = next.activeProfileId || "default";
      const profile = activeProfile();

      elements.status.textContent = profile
        ? (next.ready ? "Ready" : "API key missing") + " · " + profile.label + " · " + profile.modelId
        : "No profile loaded";
      elements.message.textContent = next.message || "";
      elements.message.className = "";

      fillSelect(elements.profiles, state.profiles, (item) => item.label + " · " + item.modelId, "id");
      elements.profiles.value = state.activeProfileId;
      fillSelect(elements.presets, state.presets, (item) => item.label, "id");

      if (!profile) {
        return;
      }

      elements.label.value = profile.label;
      elements.baseUrl.value = profile.baseUrl;
      elements.modelId.value = profile.modelId;
      elements.temperature.value = String(profile.temperature);
      elements.requiresApiKey.value = String(Boolean(profile.requiresApiKey));
      elements.headersJson.value = profile.headersJson || "{}";
      elements.bodyJson.value = profile.bodyJson || "{}";
      elements.deleteButton.disabled = profile.id === "default";
    }

    function fillSelect(select, values, labelFor, valueKey) {
      select.textContent = "";
      for (const item of values) {
        const option = document.createElement("option");
        option.value = item[valueKey];
        option.textContent = labelFor(item);
        select.appendChild(option);
      }
    }

    function collectProfile() {
      const profile = activeProfile();
      return {
        id: profile.id,
        label: elements.label.value.trim(),
        baseUrl: elements.baseUrl.value.trim(),
        modelId: elements.modelId.value.trim(),
        temperature: Number(elements.temperature.value),
        requiresApiKey: elements.requiresApiKey.value === "true",
        headersJson: elements.headersJson.value.trim() || "{}",
        bodyJson: elements.bodyJson.value.trim() || "{}"
      };
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        render(message);
      }
      if (message.type === "error") {
        elements.message.textContent = message.content;
        elements.message.className = "error";
      }
    });

    elements.profiles.addEventListener("change", () => {
      vscode.postMessage({ type: "selectProfile", profileId: elements.profiles.value });
    });
    document.getElementById("create").addEventListener("click", () => {
      vscode.postMessage({ type: "createProfile", presetId: elements.presets.value });
    });
    document.getElementById("save").addEventListener("click", () => {
      vscode.postMessage({ type: "saveProfile", profile: collectProfile() });
    });
    elements.deleteButton.addEventListener("click", () => {
      const profile = activeProfile();
      if (profile && profile.id !== "default") {
        vscode.postMessage({ type: "deleteProfile", profileId: profile.id });
      }
    });
    document.getElementById("saveKey").addEventListener("click", () => {
      vscode.postMessage({ type: "setApiKey", apiKey: elements.apiKey.value });
      elements.apiKey.value = "";
    });
    document.getElementById("test").addEventListener("click", () => {
      vscode.postMessage({ type: "testModel" });
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function validateProfileInput(profile: ModelProfile) {
  if (!profile.label.trim()) {
    return "Enter a profile name.";
  }

  if (!profile.baseUrl.trim()) {
    return "Enter a base URL.";
  }

  if (!profile.modelId.trim()) {
    return "Enter a model ID.";
  }

  if (!Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2) {
    return "Temperature must be a number from 0 to 2.";
  }

  return validateProfileHeaders(profile.headersJson) ?? validateProfileBody(profile.bodyJson);
}

function getNonce() {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";

  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}
