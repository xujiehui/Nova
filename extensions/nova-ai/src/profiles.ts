import * as vscode from "vscode";

export type ModelProfile = {
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  temperature: number;
  requiresApiKey: boolean;
  headersJson: string;
  bodyJson: string;
};

export type ModelProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  requiresApiKey: boolean;
  headersJson: string;
  bodyJson: string;
  detail: string;
};

const PROFILES_KEY = "nova.modelProfiles";
const ACTIVE_PROFILE_KEY = "nova.activeModelProfileId";
const DEFAULT_PROFILE_ID = "default";

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4.1",
    requiresApiKey: true,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "OpenAI API and compatible organization gateways."
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "openai/gpt-4.1",
    requiresApiKey: true,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "Multi-provider routing through OpenRouter's OpenAI-compatible API."
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
    requiresApiKey: true,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "DeepSeek's OpenAI-compatible chat completions endpoint."
  },
  {
    id: "dashscope",
    label: "Qwen DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen-plus",
    requiresApiKey: true,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "Alibaba Cloud DashScope OpenAI-compatible mode."
  },
  {
    id: "ollama",
    label: "Ollama Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "qwen2.5-coder:7b",
    requiresApiKey: false,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "Local Ollama server with OpenAI-compatible API enabled."
  },
  {
    id: "lmstudio",
    label: "LM Studio Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    modelId: "local-model",
    requiresApiKey: false,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "Local LM Studio server using the OpenAI-compatible endpoint."
  },
  {
    id: "custom",
    label: "Custom Provider",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4.1",
    requiresApiKey: true,
    headersJson: "{}",
    bodyJson: "{}",
    detail: "Any OpenAI-compatible /chat/completions endpoint."
  }
];

export function getDefaultProfile(): ModelProfile {
  const config = vscode.workspace.getConfiguration("nova");

  return {
    id: DEFAULT_PROFILE_ID,
    label: "Default",
    baseUrl: config.get<string>("modelBaseUrl", "https://api.openai.com/v1"),
    modelId: config.get<string>("modelId", "gpt-4.1"),
    temperature: config.get<number>("temperature", 0.2),
    requiresApiKey: config.get<boolean>("requiresApiKey", true),
    headersJson: config.get<string>("requestHeaders", "{}"),
    bodyJson: config.get<string>("requestBody", "{}")
  };
}

export function getProfiles(context: vscode.ExtensionContext) {
  const profiles = context.globalState.get<ModelProfile[]>(PROFILES_KEY, []);
  const defaultProfile = getDefaultProfile();
  const deduped = new Map<string, ModelProfile>();

  deduped.set(defaultProfile.id, defaultProfile);

  for (const profile of profiles) {
    if (isValidProfile(profile)) {
      deduped.set(profile.id, profile);
    }
  }

  return [...deduped.values()];
}

export function getActiveProfile(context: vscode.ExtensionContext) {
  const profiles = getProfiles(context);
  const activeId = context.globalState.get<string>(ACTIVE_PROFILE_KEY, "default");

  return profiles.find((profile) => profile.id === activeId) ?? profiles[0] ?? getDefaultProfile();
}

export async function setActiveProfile(context: vscode.ExtensionContext, profileId: string) {
  const exists = getProfiles(context).some((profile) => profile.id === profileId);

  if (!exists) {
    throw new Error(`Nova model profile not found: ${profileId}`);
  }

  await context.globalState.update(ACTIVE_PROFILE_KEY, profileId);
}

export async function saveProfile(context: vscode.ExtensionContext, profile: ModelProfile) {
  const normalized = normalizeProfile(profile);

  if (normalized.id === DEFAULT_PROFILE_ID) {
    await saveDefaultProfile(normalized);
    await setActiveProfile(context, DEFAULT_PROFILE_ID);
    return;
  }

  const profiles = getProfiles(context).filter((item) => item.id !== normalized.id && item.id !== DEFAULT_PROFILE_ID);
  profiles.push(normalized);
  await context.globalState.update(PROFILES_KEY, profiles);
  await setActiveProfile(context, normalized.id);
}

export function buildProfileFromPreset(presetId: string) {
  const preset = MODEL_PROVIDER_PRESETS.find((item) => item.id === presetId);

  if (!preset) {
    throw new Error(`Nova model provider preset not found: ${presetId}`);
  }

  return normalizeProfile({
    id: createProfileId(preset.label),
    label: preset.id === "custom" ? "Custom" : preset.label,
    baseUrl: preset.baseUrl,
    modelId: preset.modelId,
    temperature: 0.2,
    requiresApiKey: preset.requiresApiKey,
    headersJson: preset.headersJson,
    bodyJson: preset.bodyJson
  });
}

export function canDeleteProfile(profileId: string) {
  return profileId !== DEFAULT_PROFILE_ID;
}

export async function deleteProfile(context: vscode.ExtensionContext, profileId: string) {
  if (profileId === DEFAULT_PROFILE_ID) {
    throw new Error("The default Nova model profile cannot be deleted.");
  }

  const wasActive = getActiveProfile(context).id === profileId;
  const profiles = getProfiles(context).filter((profile) => profile.id !== profileId && profile.id !== DEFAULT_PROFILE_ID);
  await context.globalState.update(PROFILES_KEY, profiles);

  if (wasActive) {
    await setActiveProfile(context, DEFAULT_PROFILE_ID);
  }
}

export async function pickProfile(context: vscode.ExtensionContext) {
  const profiles = getProfiles(context);
  const activeProfile = getActiveProfile(context);
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: `${profile.id === activeProfile.id ? "$(check) " : ""}${profile.label}`,
      description: profile.modelId,
      detail: profile.baseUrl,
      profile
    })),
    {
      title: "Nova model profile",
      placeHolder: "Choose the model runtime Nova should use"
    }
  );

  if (!picked) {
    return undefined;
  }

  await setActiveProfile(context, picked.profile.id);
  return picked.profile;
}

export async function createProfile(context: vscode.ExtensionContext) {
  const preset = await pickProviderPreset();

  if (!preset) {
    return undefined;
  }

  const profile = await promptForProfile(buildProfileFromPreset(preset.id));

  if (!profile) {
    return undefined;
  }

  await saveProfile(context, profile);
  return profile;
}

export async function editProfile(context: vscode.ExtensionContext, profileId?: string) {
  const profile = profileId ? getProfiles(context).find((item) => item.id === profileId) : getActiveProfile(context);

  if (!profile) {
    return undefined;
  }

  const updated = await promptForProfile(profile);

  if (!updated) {
    return undefined;
  }

  await saveProfile(context, updated);
  return updated;
}

export async function pickDeletableProfile(context: vscode.ExtensionContext) {
  const profiles = getProfiles(context).filter((profile) => profile.id !== DEFAULT_PROFILE_ID);

  if (profiles.length === 0) {
    vscode.window.showInformationMessage("No custom Nova model profiles to delete.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.label,
      description: profile.modelId,
      detail: profile.baseUrl,
      profile
    })),
    {
      title: "Delete Nova model profile",
      placeHolder: "Choose a custom profile to delete"
    }
  );

  return picked?.profile;
}

export function getProfileDisplayName(profile: ModelProfile) {
  return `${profile.label} (${profile.modelId})`;
}

export function validateProfileHeaders(value: string) {
  return validateHeadersJson(value);
}

export function validateProfileBody(value: string) {
  return validateBodyJson(value);
}

export function normalizeModelProfile(profile: ModelProfile) {
  return normalizeProfile(profile);
}

async function pickProviderPreset() {
  const picked = await vscode.window.showQuickPick(
    MODEL_PROVIDER_PRESETS.map((preset) => ({
      label: preset.label,
      description: preset.requiresApiKey ? `${preset.modelId} · API key` : `${preset.modelId} · no API key`,
      detail: `${preset.detail}\n${preset.baseUrl}`,
      preset
    })),
    {
      title: "Nova model provider",
      placeHolder: "Choose a provider preset or start from Custom Provider"
    }
  );

  return picked?.preset;
}

async function promptForProfile(seed: ModelProfile) {
  const label = await vscode.window.showInputBox({
    title: "Nova model profile name",
    prompt: "Example: Local Qwen, OpenRouter Claude, Company Gateway",
    value: seed.label,
    ignoreFocusOut: true
  });

  if (!label) {
    return undefined;
  }

  const baseUrl = await vscode.window.showInputBox({
    title: "OpenAI-compatible base URL",
    value: seed.baseUrl,
    prompt: "Nova appends /chat/completions when needed.",
    validateInput(value) {
      return value.trim().length > 0 ? undefined : "Enter a base URL.";
    },
    ignoreFocusOut: true
  });

  if (!baseUrl) {
    return undefined;
  }

  const modelId = await vscode.window.showInputBox({
    title: "Model ID",
    value: seed.modelId,
    validateInput(value) {
      return value.trim().length > 0 ? undefined : "Enter a model ID.";
    },
    ignoreFocusOut: true
  });

  if (!modelId) {
    return undefined;
  }

  const temperatureValue = await vscode.window.showInputBox({
    title: "Temperature",
    value: String(seed.temperature),
    validateInput(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? undefined : "Enter a number from 0 to 2.";
    },
    ignoreFocusOut: true
  });

  if (!temperatureValue) {
    return undefined;
  }

  const keyMode = await vscode.window.showQuickPick(
    [
      {
        label: "$(key) API Key Required",
        description: "Hosted providers and secured gateways",
        requiresApiKey: true
      },
      {
        label: "$(device-desktop) No API Key",
        description: "Local Ollama, LM Studio, or trusted local proxies",
        requiresApiKey: false
      }
    ],
    {
      title: "Nova model authentication",
      placeHolder: "Choose whether this profile needs an API key"
    }
  );

  if (!keyMode) {
    return undefined;
  }

  const headersJson = await vscode.window.showInputBox({
    title: "Custom request headers",
    value: seed.headersJson,
    prompt: "Optional JSON object. Example: {\"HTTP-Referer\":\"https://example.com\"}",
    validateInput(value) {
      return validateHeadersJson(value);
    },
    ignoreFocusOut: true
  });

  if (headersJson === undefined) {
    return undefined;
  }

  const bodyJson = await vscode.window.showInputBox({
    title: "Custom request body",
    value: seed.bodyJson,
    prompt: "Optional JSON object. Example: {\"top_p\":0.9,\"max_tokens\":4096}",
    validateInput(value) {
      return validateBodyJson(value);
    },
    ignoreFocusOut: true
  });

  if (bodyJson === undefined) {
    return undefined;
  }

  return normalizeProfile({
    id: seed.id,
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    modelId: modelId.trim(),
    temperature: Number(temperatureValue),
    requiresApiKey: keyMode.requiresApiKey,
    headersJson,
    bodyJson
  });
}

function createProfileId(label: string) {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
}

async function saveDefaultProfile(profile: ModelProfile) {
  const config = vscode.workspace.getConfiguration("nova");
  await config.update("modelBaseUrl", profile.baseUrl, vscode.ConfigurationTarget.Global);
  await config.update("modelId", profile.modelId, vscode.ConfigurationTarget.Global);
  await config.update("temperature", profile.temperature, vscode.ConfigurationTarget.Global);
  await config.update("requiresApiKey", profile.requiresApiKey, vscode.ConfigurationTarget.Global);
  await config.update("requestHeaders", profile.headersJson, vscode.ConfigurationTarget.Global);
  await config.update("requestBody", profile.bodyJson, vscode.ConfigurationTarget.Global);
}

function normalizeProfile(profile: ModelProfile): ModelProfile {
  return {
    ...profile,
    label: profile.label.trim(),
    baseUrl: profile.baseUrl.trim().replace(/\/+$/, ""),
    modelId: profile.modelId.trim(),
    temperature: profile.temperature,
    requiresApiKey: profile.requiresApiKey ?? true,
    headersJson: normalizeHeadersJson(profile.headersJson),
    bodyJson: normalizeBodyJson(profile.bodyJson)
  };
}

function isValidProfile(profile: ModelProfile) {
  return Boolean(profile.id && profile.label && profile.baseUrl && profile.modelId);
}

function validateHeadersJson(value: string) {
  try {
    normalizeHeadersJson(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a JSON object.";
  }
}

function normalizeHeadersJson(value: string | undefined) {
  const trimmed = value?.trim() || "{}";
  const parsed = JSON.parse(trimmed) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }

  const normalized: Record<string, string> = {};

  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Header ${name} must be a string.`);
    }

    normalized[name] = headerValue;
  }

  return JSON.stringify(normalized);
}

function validateBodyJson(value: string) {
  try {
    normalizeBodyJson(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a JSON object.";
  }
}

function normalizeBodyJson(value: string | undefined) {
  const trimmed = value?.trim() || "{}";
  const parsed = JSON.parse(trimmed) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }

  return JSON.stringify(parsed);
}
