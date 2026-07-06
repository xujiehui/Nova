import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getRuntimeEnv, vscodeDir } from "./vscode-runtime.js";

type MockRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  tenant?: string;
  body?: unknown;
};

const timeoutMs = Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 45000);
const script = process.platform === "win32" ? path.join("scripts", "code.bat") : path.join("scripts", "code.sh");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-vscode-acceptance-user-"));
const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-vscode-acceptance-ext-"));
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-vscode-acceptance-workspace-"));
const resultsPath = path.join(os.tmpdir(), `nova-vscode-acceptance-${process.pid}.json`);
const extensionDir = path.join(vscodeDir, "extensions/nova-ai");
const runnerDir = path.join(extensionDir, ".acceptance");
const runnerPath = path.join(runnerDir, "runner.cjs");
const logPath = path.join(os.tmpdir(), `nova-vscode-acceptance-${process.pid}.log`);
const requests: MockRequest[] = [];

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }

  const rawBody = await readRequestBody(request);
  const parsedBody = safeJsonParse(rawBody);
  requests.push({
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    tenant: readHeader(request.headers["x-nova-tenant"]),
    body: parsedBody
  });
  const responseContent = getMockCompletionContent(parsedBody);

  if (isStreamingRequest(parsedBody)) {
    writeStreamingCompletion(response, responseContent);
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      id: "nova-acceptance",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: responseContent
          },
          finish_reason: "stop"
        }
      ]
    })
  );
});

try {
  await listen(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Mock model server did not bind to a TCP port.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  fs.writeFileSync(path.join(workspaceDir, "sample.ts"), "export const nova = 'acceptance';\n");
  writeRunner(baseUrl);

  const args = [
    "--disable-gpu",
    "--skip-welcome",
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
    "--extensionDevelopmentPath",
    extensionDir,
    "--extensionTestsPath",
    runnerPath,
    "--new-window",
    workspaceDir
  ];
  const log = fs.createWriteStream(logPath, { flags: "w" });
  const child = spawn(path.join(vscodeDir, script), args, {
    cwd: vscodeDir,
    env: {
      ...getRuntimeEnv(),
      NOVA_ACCEPTANCE_RESULTS_PATH: resultsPath,
      NOVA_ACCEPTANCE_MODEL_BASE_URL: baseUrl,
      NOVA_ACCEPTANCE_MODEL_ID: "nova-acceptance-model",
      NOVA_ACCEPTANCE_API_KEY: "nova-acceptance-key",
      VSCODE_SKIP_PRELAUNCH: process.env.VSCODE_SKIP_PRELAUNCH ?? ""
    },
    detached: process.platform !== "win32",
    shell: process.platform === "win32"
  });

  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const exitCode = await waitForChild(child, timeoutMs);
  child.stdout.destroy();
  child.stderr.destroy();
  log.end();

  if (exitCode === null) {
    throw new Error(`Nova model acceptance timed out after ${timeoutMs}ms. Log: ${logPath}`);
  }

  if (exitCode !== 0) {
    throw new Error(`Nova model acceptance exited with code ${exitCode}. Log: ${logPath}`);
  }

  const result = readResult();
  const requestUrls = requests.map((request) => request.url);
  const keyedRequests = requests.filter((request) => getBodyModel(request.body) === "nova-acceptance-model");
  const keyedContentRequests = keyedRequests.filter((request) => !isConnectionTestRequest(request.body));
  const noKeyRequests = requests.filter((request) => getBodyModel(request.body) === "nova-local-no-key-model");
  const webviewConfigRequests = requests.filter((request) => getBodyModel(request.body) === "nova-webview-config-model");

  assert(result.extensionId === "nova.nova-ai", `Expected extension id nova.nova-ai, got ${result.extensionId}`);
  assert(
    result.activeProfile?.id === "acceptance-profile",
    `Expected active profile acceptance-profile, got ${JSON.stringify(result.activeProfile)}`
  );
  assert(
    result.activeProfile?.baseUrl === baseUrl,
    `Expected active profile base URL ${baseUrl}, got ${result.activeProfile?.baseUrl}`
  );
  assert(
    result.activeProfile?.bodyJson?.includes("top_p"),
    `Expected active profile body JSON to include top_p, got ${JSON.stringify(result.activeProfile)}`
  );
  assert(result.connection?.ok === true, `Connection failed: ${JSON.stringify(result.connection)}`);
  assert(result.completion?.ok === true, `Completion failed: ${JSON.stringify(result.completion)}`);
  assert(result.stream?.ok === true, `Streaming completion failed: ${JSON.stringify(result.stream)}`);
  assert(
    (result.stream?.chunks?.length ?? 0) >= 2,
    `Streaming completion did not emit multiple chunks: ${JSON.stringify(result.stream)}`
  );
  assert(result.setup?.completed === true, `Setup was not marked completed: ${JSON.stringify(result.setup)}`);
  assert(result.setup?.hasApiKey === true, `Setup did not detect an API key: ${JSON.stringify(result.setup)}`);
  assert(result.setup?.ready === true, `Setup did not mark keyed profile ready: ${JSON.stringify(result.setup)}`);
  assert(
    result.rules?.editable?.content?.includes("NOVA_RULES_ACCEPTANCE"),
    `Rules view did not save editable rules: ${JSON.stringify(result.rules)}`
  );
  assert(
    result.rules?.discovered?.some((rule) => rule.content.includes("NOVA_RULES_ACCEPTANCE")),
    `Rules reader did not discover saved Nova rules: ${JSON.stringify(result.rules)}`
  );
  assert(result.localNoKey?.connection?.ok === true, `No-key local connection failed: ${JSON.stringify(result.localNoKey)}`);
  assert(result.localNoKey?.completion?.ok === true, `No-key local completion failed: ${JSON.stringify(result.localNoKey)}`);
  assert(result.localNoKey?.setup?.ready === true, `No-key local setup was not ready: ${JSON.stringify(result.localNoKey)}`);
  assert(result.modelConfig?.connection?.ok === true, `Model config view save/test failed: ${JSON.stringify(result.modelConfig)}`);
  assert(
    result.modelConfig?.profile?.id === "webview-config-profile",
    `Model config acceptance did not save the expected profile: ${JSON.stringify(result.modelConfig)}`
  );
  assert(
    result.localNoKey?.setup?.activeProfile?.requiresApiKey === false,
    `No-key local setup did not expose requiresApiKey=false: ${JSON.stringify(result.localNoKey)}`
  );
  assert(result.agent?.result?.applied?.includes("agent-output.md"), `Agent did not apply output file: ${JSON.stringify(result.agent)}`);
  assert(
    result.agent?.plan?.summary?.includes("inspected"),
    `Agent final plan did not use inspection context: ${JSON.stringify(result.agent)}`
  );
  assert(
    result.agent?.result?.commands?.some((command) => command.command === "node --version" && command.exitCode === 0),
    `Agent did not run expected command: ${JSON.stringify(result.agent)}`
  );
  assert(
    typeof result.agent?.planDocument?.path === "string" && result.agent.planDocument.path.startsWith(".nova/plans/"),
    `Agent did not write a plan document: ${JSON.stringify(result.agent)}`
  );
  assert(
    result.agentTasks?.some((task) => task.kind === "plan" && task.path === result.agent?.planDocument?.path),
    `Agent tasks did not include the plan document: ${JSON.stringify(result.agentTasks)}`
  );
  const planPath = path.join(workspaceDir, result.agent.planDocument.path);
  const planContent = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : "";
  assert(planContent.includes("# Nova Agent Plan"), `Agent plan document is missing title: ${planContent}`);
  assert(planContent.includes("## Planned File Changes"), `Agent plan document is missing planned changes: ${planContent}`);
  assert(planContent.includes("agent-output.md"), `Agent plan document is missing output file: ${planContent}`);
  assert(planContent.includes("## Inspection Evidence"), `Agent plan document is missing inspection evidence: ${planContent}`);
  assert(
    typeof result.agent?.result?.reportPath === "string" && result.agent.result.reportPath.startsWith(".nova/runs/"),
    `Agent did not write a run report: ${JSON.stringify(result.agent)}`
  );
  assert(
    result.agentTasks?.some((task) => task.kind === "run" && task.path === result.agent?.result?.reportPath),
    `Agent tasks did not include the run report: ${JSON.stringify(result.agentTasks)}`
  );
  const reportPath = path.join(workspaceDir, result.agent.result.reportPath);
  const reportContent = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
  assert(reportContent.includes("# Nova Agent Run"), `Agent report is missing title: ${reportContent}`);
  assert(reportContent.includes("## Inspections"), `Agent report is missing inspections: ${reportContent}`);
  assert(reportContent.includes('search "acceptance"'), `Agent report is missing search inspection: ${reportContent}`);
  assert(reportContent.includes("node --version"), `Agent report is missing command output section: ${reportContent}`);
  assert(
    result.inline?.completion?.includes("42"),
    `Inline completion did not return expected content: ${JSON.stringify(result.inline)}`
  );
  assert(
    fs.readFileSync(path.join(workspaceDir, "agent-output.md"), "utf8").includes("Nova agent acceptance"),
    "Agent output file did not contain expected content"
  );
  assert(requests.length >= 5, `Expected at least 5 model requests, saw ${requests.length}`);
  assert(
    requests.some((request) => getPromptText(request.body).includes("Nova Agent Inspector")),
    "Mock server did not receive the agent inspection planning request"
  );
  assert(
    requests.some((request) => getPromptText(request.body).includes("Agent inspection results")),
    "Mock server did not receive the final agent request with inspection results"
  );
  assert(
    requests.some((request) => getPromptText(request.body).includes("NOVA_RULES_ACCEPTANCE")),
    "Mock server did not receive workspace rules in a model request"
  );
  assert(
    keyedRequests.every((request) => request.authorization === "Bearer nova-acceptance-key"),
    "Mock server did not receive the configured API key on every keyed request"
  );
  assert(
    keyedRequests.every((request) => request.tenant === "acceptance-tenant"),
    "Mock server did not receive the configured custom tenant header on every keyed request"
  );
  assert(
    keyedRequests.every((request) => getBodyField(request.body, "top_p") === 0.77),
    "Mock server did not receive the configured top_p body field on every keyed request"
  );
  assert(
    keyedContentRequests.every((request) => getBodyField(request.body, "max_tokens") === 1234),
    "Mock server did not receive the configured max_tokens body field on every keyed content request"
  );
  assert(
    keyedRequests.some((request) => isConnectionTestRequest(request.body) && getBodyField(request.body, "max_tokens") === 16),
    "Connection test request did not preserve Nova's short max_tokens override"
  );
  assert(
    keyedRequests.every((request) => getBodyField(request.body, "temperature") === 0),
    "Custom request body overrode the keyed profile temperature"
  );
  assert(
    keyedRequests.every((request) => getBodyMessages(request.body).length > 0),
    "Custom request body overrode keyed profile messages"
  );
  assert(
    keyedRequests.some((request) => isStreamingRequest(request.body)),
    "Custom request body overrode the streaming request flag"
  );
  assert(
    webviewConfigRequests.some((request) => request.tenant === "webview-config"),
    "Mock server did not receive model config webview custom header"
  );
  assert(
    webviewConfigRequests.some((request) => getBodyField(request.body, "frequency_penalty") === 0.25),
    "Mock server did not receive model config webview custom body field"
  );
  assert(
    result.modelConfig?.profile?.bodyJson?.includes("frequency_penalty"),
    `Model config acceptance did not save custom body JSON: ${JSON.stringify(result.modelConfig)}`
  );
  assert(
    noKeyRequests.length >= 2,
    `Expected at least 2 no-key local model requests, saw ${noKeyRequests.length}`
  );
  assert(
    noKeyRequests.every((request) => request.authorization === undefined),
    "Mock server received an Authorization header for no-key local profile"
  );
  assert(
    keyedRequests.length >= 5,
    `Expected at least 5 keyed model requests, saw ${keyedRequests.length}`
  );

  console.log("Nova model acceptance passed.");
  console.log(`Extension: ${result.extensionId}`);
  console.log(`Model endpoint: ${baseUrl}/chat/completions`);
  console.log(`Requests: ${requestUrls.join(", ")}`);
  console.log(`Log: ${logPath}`);
} catch (error) {
  const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").slice(-120).join("\n") : "";
  const message = error instanceof Error ? error.message : "Nova model acceptance failed.";

  if (output) {
    console.error(output);
  }

  console.error(message);
  process.exitCode = 1;
} finally {
  cleanupElectronChildren();
  await closeServer(server);
  fs.rmSync(runnerDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(extensionsDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(resultsPath, { force: true });
}

function writeRunner(baseUrl: string) {
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.writeFileSync(
    runnerPath,
    `const fs = require("node:fs");
const vscode = require("vscode");

exports.run = async function run() {
  const extension = vscode.extensions.getExtension("nova.nova-ai");
  if (!extension) {
    throw new Error("Nova extension nova.nova-ai was not discovered.");
  }

  await extension.activate();
  const rules = await vscode.commands.executeCommand(
    "nova.internal.rulesAcceptance",
    "# Nova acceptance rules\\n\\nAlways include NOVA_RULES_ACCEPTANCE when rules are loaded.\\n"
  );
  await vscode.commands.executeCommand("nova.internal.configureProfile", {
    id: "acceptance-profile",
    label: "Acceptance Provider",
    baseUrl: process.env.NOVA_ACCEPTANCE_MODEL_BASE_URL || ${JSON.stringify(baseUrl)},
    modelId: process.env.NOVA_ACCEPTANCE_MODEL_ID || "nova-acceptance-model",
    temperature: 0,
    headersJson: JSON.stringify({
      "X-Nova-Tenant": "acceptance-tenant",
      Authorization: "Bearer should-not-override-secret"
    }),
    bodyJson: JSON.stringify({
      top_p: 0.77,
      max_tokens: 1234,
      model: "should-not-override",
      messages: [],
      stream: false,
      temperature: 1.9
    }),
    apiKey: process.env.NOVA_ACCEPTANCE_API_KEY || "nova-acceptance-key"
  });
  const model = await vscode.commands.executeCommand("nova.internal.acceptance");
  const agent = await vscode.commands.executeCommand("nova.internal.agentAcceptance", "Create agent-output.md for acceptance.");
  const agentTasks = await vscode.commands.executeCommand("nova.internal.agentTasksAcceptance");
  const stream = await vscode.commands.executeCommand("nova.internal.streamAcceptance");
  const inline = await vscode.commands.executeCommand("nova.internal.inlineAcceptance");
  const setup = await vscode.commands.executeCommand("nova.internal.setupStatus");
  await vscode.commands.executeCommand("nova.internal.configureProfile", {
    id: "local-no-key-profile",
    label: "Local No Key",
    baseUrl: process.env.NOVA_ACCEPTANCE_MODEL_BASE_URL || ${JSON.stringify(baseUrl)},
    modelId: "nova-local-no-key-model",
    temperature: 0,
    requiresApiKey: false
  });
  const localNoKeyModel = await vscode.commands.executeCommand("nova.internal.acceptance");
  const localNoKeySetup = await vscode.commands.executeCommand("nova.internal.setupStatus");
  const modelConfig = await vscode.commands.executeCommand("nova.internal.modelConfigAcceptance", {
    id: "webview-config-profile",
    label: "Webview Config",
    baseUrl: process.env.NOVA_ACCEPTANCE_MODEL_BASE_URL || ${JSON.stringify(baseUrl)},
    modelId: "nova-webview-config-model",
    temperature: 0,
    requiresApiKey: false,
    headersJson: JSON.stringify({
      "X-Nova-Tenant": "webview-config"
    }),
    bodyJson: JSON.stringify({
      frequency_penalty: 0.25
    })
  });
  const result = {
    ...model,
    rules,
    agent,
    agentTasks,
    stream,
    inline,
    setup,
    localNoKey: {
      connection: localNoKeyModel.connection,
      completion: localNoKeyModel.completion,
      setup: localNoKeySetup
    },
    modelConfig
  };
  fs.writeFileSync(process.env.NOVA_ACCEPTANCE_RESULTS_PATH, JSON.stringify(result, null, 2));
};
`
  );
}

function listen(target: http.Server) {
  return new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolve();
    });
  });
}

function closeServer(target: http.Server) {
  return new Promise<void>((resolve) => {
    target.close(() => resolve());
  });
}

function waitForChild(child: ReturnType<typeof spawn>, timeout: number) {
  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      stopChild(child);
      resolve(null);
    }, timeout);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function stopChild(child: ReturnType<typeof spawn>) {
  if (child.pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill();
    } else {
      process.kill(-child.pid);
    }
  } catch {
    child.kill();
  }
}

function cleanupElectronChildren() {
  if (process.platform === "win32") {
    return;
  }

  spawnSync("pkill", ["-f", userDataDir], { stdio: "ignore" });
}

function readResult() {
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Nova model acceptance did not write result file. Log: ${logPath}`);
  }

  return JSON.parse(fs.readFileSync(resultsPath, "utf8")) as {
    extensionId?: string;
    activeProfile?: { id?: string; baseUrl?: string; bodyJson?: string };
    connection?: { ok?: boolean };
    completion?: { ok?: boolean; content?: string };
    setup?: { completed?: boolean; hasApiKey?: boolean; ready?: boolean };
    agent?: {
      plan?: { summary?: string };
      planDocument?: { path?: string };
      result?: {
        applied?: string[];
        commands?: Array<{ command?: string; exitCode?: number | null }>;
        reportPath?: string;
      };
    };
    agentTasks?: Array<{ path?: string; kind?: "plan" | "run"; title?: string }>;
    stream?: { ok?: boolean; content?: string; chunks?: string[] };
    inline?: { completion?: string };
    rules?: {
      editable?: { content?: string };
      discovered?: Array<{ source?: string; content: string }>;
    };
    localNoKey?: {
      connection?: { ok?: boolean };
      completion?: { ok?: boolean; content?: string };
      setup?: {
        ready?: boolean;
        activeProfile?: {
          requiresApiKey?: boolean;
        };
      };
    };
    modelConfig?: {
      profile?: { id?: string; bodyJson?: string };
      connection?: { ok?: boolean };
    };
  };
}

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function readHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(",") : value;
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getBodyModel(body: unknown) {
  if (!body || typeof body !== "object" || !("model" in body)) {
    return undefined;
  }

  return (body as { model?: unknown }).model;
}

function getBodyField(body: unknown, field: string) {
  if (!body || typeof body !== "object" || !(field in body)) {
    return undefined;
  }

  return (body as Record<string, unknown>)[field];
}

function isStreamingRequest(body: unknown) {
  return Boolean(body && typeof body === "object" && (body as { stream?: unknown }).stream === true);
}

function isConnectionTestRequest(body: unknown) {
  return getPromptText(body).includes("Reply with OK.");
}

function writeStreamingCompletion(response: http.ServerResponse, content: string) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const midpoint = Math.max(1, Math.floor(content.length / 2));
  const chunks = [content.slice(0, midpoint), content.slice(midpoint)].filter(Boolean);

  for (const chunk of chunks) {
    response.write(
      `data: ${JSON.stringify({
        id: "nova-acceptance-stream",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              content: chunk
            },
            finish_reason: null
          }
        ]
      })}\n\n`
    );
  }

  response.end("data: [DONE]\n\n");
}

function getMockCompletionContent(body: unknown) {
  const prompt = getPromptText(body);

  if (prompt.includes("Nova Agent Inspector")) {
    return JSON.stringify({
      requests: [
        {
          tool: "search",
          query: "acceptance",
          reason: "Find the existing acceptance fixture before editing."
        },
        {
          tool: "read",
          path: "sample.ts",
          reason: "Inspect the active sample source file."
        }
      ]
    });
  }

  if (prompt.includes("You are Nova Agent")) {
    return JSON.stringify({
      summary: prompt.includes("Agent inspection results")
        ? "Create inspected acceptance agent output"
        : "Create acceptance agent output",
      changes: [
        {
          path: "agent-output.md",
          content: "# Nova agent acceptance\n\nThe workspace agent wrote this file.\n"
        }
      ],
      commands: [
        {
          command: "node --version",
          reason: "Verify the agent can run a safe local validation command."
        }
      ]
    });
  }

  if (prompt.includes("You are Nova Inline")) {
    return "42;\n}";
  }

  if (prompt.includes("NOVA_STREAMING_MODEL_OK")) {
    return "NOVA_STREAMING_MODEL_OK";
  }

  return "NOVA_CUSTOM_MODEL_OK";
}

function getPromptText(body: unknown) {
  return getBodyMessages(body)
    .map((message) => message.content)
    .join("\n");
}

function getBodyMessages(body: unknown): Array<{ content: string }> {
  if (!body || typeof body !== "object" || !("messages" in body)) {
    return [];
  }

  const messages = (body as { messages?: unknown }).messages;

  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || !("content" in message)) {
        return undefined;
      }

      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? { content } : undefined;
    })
    .filter((message): message is { content: string } => Boolean(message));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
