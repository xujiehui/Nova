import * as vscode from "vscode";
import { getActiveProfile } from "./profiles";
import { formatWorkspaceRules, readWorkspaceRules } from "./rules";
import { collectRepositoryContext, formatRepositoryContext } from "./workspaceContext";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ModelSettings = {
  baseUrl: string;
  apiKey: string;
  requiresApiKey: boolean;
  modelId: string;
  temperature: number;
  headersJson: string;
  bodyJson: string;
  systemPrompt: string;
};

export type ModelConnectionResult = {
  ok: boolean;
  modelId: string;
  baseUrl: string;
  message: string;
  latencyMs: number;
};

export type ChatCompletionStreamOptions = {
  onDelta: (delta: string) => void | Promise<void>;
};

export type ActiveEditorContext = {
  fileName: string;
  languageId: string;
  content: string;
  selection?: string;
};

const SECRET_API_KEY = "nova.modelApiKey";
const PROFILE_SECRET_PREFIX = "nova.modelProfileApiKey";

export async function storeApiKey(context: vscode.ExtensionContext, apiKey: string) {
  const activeProfile = getActiveProfile(context);
  await storeApiKeyForProfile(context, activeProfile.id, apiKey);
}

export async function storeApiKeyForProfile(context: vscode.ExtensionContext, profileId: string, apiKey: string) {
  await context.secrets.store(getProfileSecretKey(profileId), apiKey);
}

export async function readModelSettings(context?: vscode.ExtensionContext): Promise<ModelSettings> {
  const config = vscode.workspace.getConfiguration("nova");
  const activeProfile = context ? getActiveProfile(context) : undefined;
  const profileApiKey =
    context && activeProfile ? await context.secrets.get(getProfileSecretKey(activeProfile.id)) : undefined;
  const legacySecretApiKey = context ? await context.secrets.get(SECRET_API_KEY) : undefined;

  return {
    baseUrl: (activeProfile?.baseUrl ?? config.get<string>("modelBaseUrl", "https://api.openai.com/v1")).replace(
      /\/+$/,
      ""
    ),
    apiKey: profileApiKey || legacySecretApiKey || config.get<string>("apiKey", ""),
    requiresApiKey: activeProfile?.requiresApiKey ?? config.get<boolean>("requiresApiKey", true),
    modelId: activeProfile?.modelId ?? config.get<string>("modelId", "gpt-4.1"),
    temperature: activeProfile?.temperature ?? config.get<number>("temperature", 0.2),
    headersJson: activeProfile?.headersJson ?? config.get<string>("requestHeaders", "{}"),
    bodyJson: activeProfile?.bodyJson ?? config.get<string>("requestBody", "{}"),
    systemPrompt: config.get<string>(
      "systemPrompt",
      "You are Nova, an expert AI pair programmer inside a VS Code fork."
    )
  };
}

export async function hasApiKey(context: vscode.ExtensionContext) {
  const activeProfile = getActiveProfile(context);
  const profileApiKey = await context.secrets.get(getProfileSecretKey(activeProfile.id));
  const legacySecretApiKey = await context.secrets.get(SECRET_API_KEY);
  const configApiKey = vscode.workspace.getConfiguration("nova").get<string>("apiKey", "");

  return Boolean(profileApiKey || legacySecretApiKey || configApiKey);
}

export async function isModelProfileReady(context: vscode.ExtensionContext) {
  const settings = await readModelSettings(context);
  return !settings.requiresApiKey || Boolean(settings.apiKey);
}

function getProfileSecretKey(profileId: string) {
  return `${PROFILE_SECRET_PREFIX}.${profileId}`;
}

export function getActiveEditorContext(): ActiveEditorContext | undefined {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return undefined;
  }

  const selection = editor.document.getText(editor.selection);

  return {
    fileName: vscode.workspace.asRelativePath(editor.document.uri, false),
    languageId: editor.document.languageId,
    content: editor.document.getText(),
    selection: selection.trim().length > 0 ? selection : undefined
  };
}

export async function buildMessages(
  prompt: string,
  context: ActiveEditorContext | undefined,
  settings: ModelSettings
) {
  const workspaceRules = formatWorkspaceRules(await readWorkspaceRules());
  const repositoryContext = formatRepositoryContext(await collectRepositoryContext(prompt, context?.fileName));
  const systemContent = [settings.systemPrompt, workspaceRules].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemContent
    }
  ];

  if (context) {
    const contextParts = [
      `Active file: ${context.fileName}`,
      `Language: ${context.languageId}`,
      context.selection ? "Selected code:" : "File content:",
      "```",
      (context.selection ?? context.content).slice(0, 30000),
      "```"
    ];

    messages.push({
      role: "user",
      content: contextParts.join("\n")
    });
  }

  if (repositoryContext) {
    messages.push({
      role: "user",
      content: repositoryContext
    });
  }

  messages.push({
    role: "user",
    content: prompt
  });

  return messages;
}

function buildChatUrl(baseUrl: string) {
  if (baseUrl.endsWith("/chat/completions")) {
    return baseUrl;
  }

  return `${baseUrl}/chat/completions`;
}

export async function requestChatCompletion(
  prompt: string,
  editorContext?: ActiveEditorContext,
  extensionContext?: vscode.ExtensionContext
) {
  const settings = await readModelSettings(extensionContext);

  if (settings.requiresApiKey && !settings.apiKey) {
    throw new Error("Nova API key is not configured. Set nova.apiKey before sending a request.");
  }

  const response = await fetch(buildChatUrl(settings.baseUrl), {
    method: "POST",
    headers: buildModelHeaders(settings),
    body: JSON.stringify(await buildChatCompletionPayload(prompt, editorContext, settings))
  });

  const rawBody = await response.text();
  const parsed = safeJsonParse(rawBody);

  if (!response.ok) {
    throw new Error(`Nova model request failed (${response.status}): ${formatErrorBody(parsed)}`);
  }

  const content = extractChatCompletionContent(parsed);

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Nova model returned an empty response.");
  }

  return content;
}

export async function requestChatCompletionStream(
  prompt: string,
  editorContext: ActiveEditorContext | undefined,
  extensionContext: vscode.ExtensionContext,
  options: ChatCompletionStreamOptions
) {
  const settings = await readModelSettings(extensionContext);

  if (settings.requiresApiKey && !settings.apiKey) {
    throw new Error("Nova API key is not configured. Set nova.apiKey before sending a request.");
  }

  const response = await fetch(buildChatUrl(settings.baseUrl), {
    method: "POST",
    headers: buildModelHeaders(settings),
    body: JSON.stringify(await buildChatCompletionPayload(prompt, editorContext, settings, { stream: true }))
  });
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const rawBody = await response.text();
    const parsed = safeJsonParse(rawBody);
    throw new Error(`Nova model request failed (${response.status}): ${formatErrorBody(parsed)}`);
  }

  if (!response.body || !contentType.includes("text/event-stream")) {
    const rawBody = await response.text();
    const parsed = safeJsonParse(rawBody);
    const content = extractChatCompletionContent(parsed);

    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Nova model returned an empty response.");
    }

    await options.onDelta(content);
    return content;
  }

  const content = await readStreamingChatCompletion(response.body, options.onDelta);

  if (content.trim().length === 0) {
    throw new Error("Nova model returned an empty response.");
  }

  return content;
}

export async function testModelConnection(extensionContext: vscode.ExtensionContext): Promise<ModelConnectionResult> {
  const settings = await readModelSettings(extensionContext);
  const startedAt = Date.now();

  if (settings.requiresApiKey && !settings.apiKey) {
    return {
      ok: false,
      modelId: settings.modelId,
      baseUrl: settings.baseUrl,
      message: "API key is not configured for the active Nova model profile.",
      latencyMs: 0
    };
  }

  try {
    const response = await fetch(buildChatUrl(settings.baseUrl), {
      method: "POST",
      headers: buildModelHeaders(settings),
      body: JSON.stringify(
        await buildChatCompletionPayload("Reply with OK.", undefined, {
          ...settings,
          systemPrompt: "You are a connection test endpoint. Reply with OK."
        }, {
          temperature: 0,
          max_tokens: 16
        })
      )
    });
    const latencyMs = Date.now() - startedAt;
    const rawBody = await response.text();
    const parsed = safeJsonParse(rawBody);

    if (!response.ok) {
      return {
        ok: false,
        modelId: settings.modelId,
        baseUrl: settings.baseUrl,
        message: `Request failed (${response.status}): ${formatErrorBody(parsed)}`,
        latencyMs
      };
    }

    return {
      ok: true,
      modelId: settings.modelId,
      baseUrl: settings.baseUrl,
      message: "Model connection succeeded.",
      latencyMs
    };
  } catch (error) {
    return {
      ok: false,
      modelId: settings.modelId,
      baseUrl: settings.baseUrl,
      message: error instanceof Error ? error.message : "Unknown model connection error.",
      latencyMs: Date.now() - startedAt
    };
  }
}

async function buildChatCompletionPayload(
  prompt: string,
  editorContext: ActiveEditorContext | undefined,
  settings: ModelSettings,
  overrides: Record<string, unknown> = {}
) {
  return {
    ...parseRequestBody(settings.bodyJson),
    model: settings.modelId,
    temperature: settings.temperature,
    messages: await buildMessages(prompt, editorContext, settings),
    ...overrides
  };
}

function buildModelHeaders(settings: ModelSettings) {
  const headers: Record<string, string> = {
    ...parseRequestHeaders(settings.headersJson),
    "Content-Type": "application/json"
  };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  return headers;
}

function parseRequestHeaders(headersJson: string) {
  const reservedHeaders = new Set(["authorization", "content-type", "content-length", "host"]);
  const parsed = safeJsonParse(headersJson || "{}");
  const headers: Record<string, string> = {};

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return headers;
  }

  for (const [name, value] of Object.entries(parsed)) {
    const normalizedName = name.trim();

    if (!normalizedName || reservedHeaders.has(normalizedName.toLowerCase())) {
      continue;
    }

    if (typeof value === "string") {
      headers[normalizedName] = value;
    }
  }

  return headers;
}

function parseRequestBody(bodyJson: string) {
  const reservedFields = new Set(["model", "messages", "stream", "temperature"]);
  const parsed = safeJsonParse(bodyJson || "{}");
  const body: Record<string, unknown> = {};

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }

  for (const [name, value] of Object.entries(parsed)) {
    if (!reservedFields.has(name)) {
      body[name] = value;
    }
  }

  return body;
}

async function readStreamingChatCompletion(
  body: ReadableStream<Uint8Array>,
  onDelta: ChatCompletionStreamOptions["onDelta"]
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;

  while (!done) {
    const read = await reader.read();

    if (read.done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(read.value, { stream: true });

    const result = await drainSseEvents(buffer, onDelta);
    buffer = result.rest;
    content += result.content;
    done = result.done;
  }

  if (!done && buffer.trim()) {
    const result = await drainSseEvents(`${buffer}\n\n`, onDelta);
    content += result.content;
  }

  return content;
}

async function drainSseEvents(
  buffer: string,
  onDelta: ChatCompletionStreamOptions["onDelta"]
): Promise<{ rest: string; content: string; done: boolean }> {
  const normalized = buffer.replace(/\r\n/g, "\n");
  let rest = normalized;
  let content = "";
  let done = false;

  while (!done) {
    const separatorIndex = rest.indexOf("\n\n");

    if (separatorIndex < 0) {
      break;
    }

    const event = rest.slice(0, separatorIndex);
    rest = rest.slice(separatorIndex + 2);
    const data = parseSseData(event);

    if (!data) {
      continue;
    }

    if (data === "[DONE]") {
      done = true;
      break;
    }

    const parsed = safeJsonParse(data);
    const delta = extractStreamingDelta(parsed);

    if (delta) {
      content += delta;
      await onDelta(delta);
    }
  }

  return { rest, content, done };
}

function parseSseData(event: string) {
  const lines = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  return lines.join("\n").trim();
}

function extractStreamingDelta(value: any) {
  const choices = Array.isArray(value?.choices) ? value.choices : [];

  return choices
    .map((choice: any) => {
      const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
      return typeof content === "string" ? content : "";
    })
    .join("");
}

function extractChatCompletionContent(value: any) {
  const content = value?.choices?.[0]?.message?.content ?? value?.choices?.[0]?.text;

  if (typeof content === "string") {
    return content;
  }

  return undefined;
}

export async function requestCodeEdit(
  prompt: string,
  editorContext: ActiveEditorContext,
  extensionContext: vscode.ExtensionContext
) {
  const editPrompt = [
    "Rewrite the provided code according to the user's request.",
    "Return only the replacement code. Do not include markdown fences unless the code itself requires them.",
    `Request: ${prompt}`
  ].join("\n");
  const response = await requestChatCompletion(editPrompt, editorContext, extensionContext);

  return extractCode(response);
}

export function extractCode(response: string) {
  const fencedBlock = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return (fencedBlock?.[1] ?? response).trim();
}

function safeJsonParse(rawBody: string): any {
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function formatErrorBody(body: any) {
  if (typeof body === "string") {
    return body;
  }

  if (body?.error?.message) {
    return body.error.message;
  }

  return JSON.stringify(body);
}
