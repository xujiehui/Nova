import * as path from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { requestChatCompletion } from "./modelClient";
import { collectRepositoryContext, formatRepositoryContext } from "./workspaceContext";

export type AgentFileChange = {
  path: string;
  content: string;
};

export type AgentCommand = {
  command: string;
  reason: string;
};

export type AgentPlan = {
  summary: string;
  changes: AgentFileChange[];
  commands: AgentCommand[];
  inspections?: AgentInspectionResult[];
};

export type AgentRunResult = {
  summary: string;
  applied: string[];
  skipped: string[];
  commands: AgentCommandResult[];
  reportPath?: string;
};

export type AgentPlanDocument = {
  path: string;
  uri: vscode.Uri;
};

export type AgentCommandResult = AgentCommand & {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type AgentInspectionRequest =
  | {
      tool: "search";
      query: string;
      reason: string;
    }
  | {
      tool: "read";
      path: string;
      reason: string;
    };

export type AgentInspectionResult = AgentInspectionRequest & {
  content: string;
};

const MAX_AGENT_CHANGES = 8;
const MAX_AGENT_FILE_BYTES = 120000;
const MAX_AGENT_COMMANDS = 4;
const MAX_AGENT_INSPECTION_REQUESTS = 5;
const MAX_AGENT_INSPECTION_QUERY_LENGTH = 160;
const MAX_AGENT_READ_BYTES = 30000;
const MAX_AGENT_SEARCH_RESULTS = 8;
const MAX_COMMAND_OUTPUT_BYTES = 60000;
const COMMAND_TIMEOUT_MS = 60000;
const ALLOWED_COMMANDS = new Set(["pnpm", "npm", "yarn", "node", "tsx", "tsc", "git"]);
const BLOCKED_COMMAND_PARTS = [
  "rm",
  "sudo",
  "curl",
  "wget",
  "ssh",
  "scp",
  "chmod",
  "chown",
  "mkfs",
  "dd",
  "kill",
  "pkill",
  ">",
  ">>",
  "|",
  "&&",
  "||",
  ";",
  "`",
  "$(",
  "<"
];
const BLOCKED_SHELL_TOKENS = new Set([">", ">>", "|", "&&", "||", ";", "`", "$(", "<"]);

export async function runWorkspaceAgent(
  instruction: string,
  extensionContext: vscode.ExtensionContext
): Promise<AgentRunResult | undefined> {
  const plan = await requestWorkspaceAgentPlan(instruction, extensionContext);
  const planDocument = await writeAndOpenAgentPlanDocument(plan, instruction);
  const approved = await vscode.window.showInformationMessage(
    `Nova Agent planned ${plan.changes.length} file change(s) and ${plan.commands.length} command(s). Review ${planDocument.path}?`,
    { modal: true },
    "Apply Plan",
    "Cancel"
  );

  if (approved !== "Apply Plan") {
    return undefined;
  }

  const result = await previewAndApplyAgentPlan(plan);
  showAgentCommandSummary(result.commands);
  return result;
}

export async function requestWorkspaceAgentPlan(
  instruction: string,
  extensionContext: vscode.ExtensionContext
): Promise<AgentPlan> {
  const repositoryContext = formatRepositoryContext(await collectRepositoryContext(instruction));
  const workspaceFiles = await collectWorkspaceFileList();
  const inspectionRequests = await requestAgentInspectionRequests(
    instruction,
    workspaceFiles,
    repositoryContext,
    extensionContext
  );
  const inspectionResults = await runAgentInspectionRequests(inspectionRequests);
  const prompt = [
    "You are Nova Agent, a careful coding agent inside a VS Code fork.",
    "Create a small, reviewable workspace edit plan.",
    "Return only JSON. Do not include markdown fences or commentary.",
    "Schema:",
    '{"summary":"short summary","changes":[{"path":"relative/workspace/path","content":"full replacement file content"}],"commands":[{"command":"pnpm test","reason":"why this should be run"}]}',
    "Rules:",
    "- Use paths from the workspace, relative to the workspace root.",
    "- Return full replacement content for each changed file.",
    `- Change at most ${MAX_AGENT_CHANGES} files.`,
    `- Propose at most ${MAX_AGENT_COMMANDS} validation commands.`,
    "- Commands must be non-interactive and start with one of: pnpm, npm, yarn, node, tsx, tsc, git.",
    "- Do not use shell operators, redirects, pipes, sudo, curl, wget, ssh, chmod, chown, rm, kill, or pkill.",
    "- Do not include binary files, absolute paths, parent directory traversal, or files under node_modules, vendor, .git, dist, out, build, or .nova.",
    "- If no file change is needed, return an empty changes array. If no validation command is needed, return an empty commands array.",
    "",
    "Workspace files:",
    workspaceFiles.join("\n"),
    "",
    repositoryContext,
    "",
    formatAgentInspectionResults(inspectionResults),
    "",
    `User request: ${instruction}`
  ].join("\n");
  const response = await requestChatCompletion(prompt, undefined, extensionContext);
  const plan = parseAgentPlan(response);
  plan.inspections = inspectionResults;

  await validateAgentPlan(plan);
  return plan;
}

export async function writeAgentPlanDocument(plan: AgentPlan, instruction: string): Promise<AgentPlanDocument> {
  const planUri = buildAgentPlanUri();
  const planPath = vscode.workspace.asRelativePath(planUri, false);
  const content = buildAgentPlanDocument(plan, instruction);

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(getWorkspaceFolder().uri, ".nova", "plans"));
  await vscode.workspace.fs.writeFile(planUri, Buffer.from(content, "utf8"));

  return {
    path: planPath,
    uri: planUri
  };
}

async function writeAndOpenAgentPlanDocument(plan: AgentPlan, instruction: string) {
  const planDocument = await writeAgentPlanDocument(plan, instruction);
  const document = await vscode.workspace.openTextDocument(planDocument.uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return planDocument;
}

async function requestAgentInspectionRequests(
  instruction: string,
  workspaceFiles: string[],
  repositoryContext: string,
  extensionContext: vscode.ExtensionContext
) {
  if (workspaceFiles.length === 0) {
    return [];
  }

  const prompt = [
    "You are Nova Agent Inspector, a read-only workspace triage planner.",
    "Before Nova Agent edits files, decide whether a few safe read-only inspections would materially improve the plan.",
    "Return only JSON. Do not include markdown fences or commentary.",
    "Schema:",
    '{"requests":[{"tool":"search","query":"symbol or phrase","reason":"why"},{"tool":"read","path":"relative/workspace/path","reason":"why"}]}',
    "Rules:",
    `- Request at most ${MAX_AGENT_INSPECTION_REQUESTS} inspections.`,
    "- Use only these tools: search, read.",
    "- search scans text files for a short query and returns matching file snippets.",
    "- read returns a bounded excerpt from one relative workspace file.",
    "- Paths must come from the workspace file list. Do not use absolute paths or parent traversal.",
    "- If the initial context is enough, return {\"requests\":[]}.",
    "",
    "Workspace files:",
    workspaceFiles.join("\n"),
    "",
    repositoryContext,
    "",
    `User request: ${instruction}`
  ].join("\n");

  try {
    return parseAgentInspectionRequests(await requestChatCompletion(prompt, undefined, extensionContext));
  } catch {
    return [];
  }
}

function parseAgentInspectionRequests(response: string): AgentInspectionRequest[] {
  const parsed = safeJsonParse(stripMarkdownFence(response));

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.requests)) {
    return [];
  }

  return parsed.requests.slice(0, MAX_AGENT_INSPECTION_REQUESTS).flatMap((request: unknown) => {
    if (!request || typeof request !== "object") {
      return [];
    }

    const candidate = request as { tool?: unknown; query?: unknown; path?: unknown; reason?: unknown };
    const reason = typeof candidate.reason === "string" && candidate.reason.trim() ? candidate.reason.trim() : "Inspect workspace context.";

    if (candidate.tool === "search" && typeof candidate.query === "string" && candidate.query.trim()) {
      return [
        {
          tool: "search" as const,
          query: candidate.query.trim().slice(0, MAX_AGENT_INSPECTION_QUERY_LENGTH),
          reason
        }
      ];
    }

    if (candidate.tool === "read" && typeof candidate.path === "string" && candidate.path.trim()) {
      return [
        {
          tool: "read" as const,
          path: normalizeRelativePath(candidate.path),
          reason
        }
      ];
    }

    return [];
  });
}

async function runAgentInspectionRequests(requests: AgentInspectionRequest[]) {
  const results: AgentInspectionResult[] = [];

  for (const request of requests) {
    if (request.tool === "search") {
      results.push({
        ...request,
        content: await runAgentSearchInspection(request.query)
      });
      continue;
    }

    results.push({
      ...request,
      content: await runAgentReadInspection(request.path)
    });
  }

  return results;
}

async function runAgentSearchInspection(query: string) {
  const normalizedQuery = query.toLowerCase().trim();

  if (!normalizedQuery) {
    return "No query provided.";
  }

  const files = await vscode.workspace.findFiles(
    "**/*.{ts,tsx,js,jsx,json,md,py,go,rs,java,cs,css,scss,html,yml,yaml}",
    "**/{node_modules,.git,dist,out,build,vendor,.nova}/**",
    300
  );
  const matches: string[] = [];

  for (const uri of files) {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const content = await readFileIfExists(uri);

    if (!content) {
      continue;
    }

    const lowerContent = content.toLowerCase();
    const pathMatch = relativePath.toLowerCase().includes(normalizedQuery);
    const contentIndex = lowerContent.indexOf(normalizedQuery);

    if (!pathMatch && contentIndex < 0) {
      continue;
    }

    const excerpt =
      contentIndex >= 0
        ? content.slice(Math.max(0, contentIndex - 240), contentIndex + normalizedQuery.length + 760)
        : content.slice(0, 1000);
    matches.push([`File: ${relativePath}`, "```", excerpt, "```"].join("\n"));

    if (matches.length >= MAX_AGENT_SEARCH_RESULTS) {
      break;
    }
  }

  return matches.length ? matches.join("\n\n") : `No matches for query: ${query}`;
}

async function runAgentReadInspection(relativePath: string) {
  validateWorkspaceRelativePath(relativePath);
  const targetUri = resolveWorkspacePath(relativePath);
  const content = await readFileIfExists(targetUri);

  if (content === undefined) {
    return `File not found or unreadable: ${relativePath}`;
  }

  return content.slice(0, MAX_AGENT_READ_BYTES);
}

function formatAgentInspectionResults(results: AgentInspectionResult[]) {
  if (results.length === 0) {
    return "Agent inspection results: none requested.";
  }

  return [
    "Agent inspection results:",
    ...results.map((result, index) => {
      const heading =
        result.tool === "search"
          ? `${index + 1}. search "${result.query}" - ${result.reason}`
          : `${index + 1}. read ${result.path} - ${result.reason}`;

      return [heading, "```", result.content, "```"].join("\n");
    })
  ].join("\n\n");
}

export async function previewAndApplyAgentPlan(plan: AgentPlan): Promise<AgentRunResult> {
  if (plan.changes.length === 0) {
    vscode.window.showInformationMessage(`Nova Agent: ${plan.summary}`);
    const result: AgentRunResult = {
      summary: plan.summary,
      applied: [],
      skipped: [],
      commands: await maybeRunAgentCommands(plan.commands)
    };
    return writeAndOpenAgentRunReport(plan, result);
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const change of plan.changes) {
    const targetUri = resolveWorkspacePath(change.path);
    const previewUri = buildAgentPreviewUri(change.path);
    const existingContent = await readFileIfExists(targetUri);

    await vscode.workspace.fs.writeFile(previewUri, Buffer.from(change.content, "utf8"));
    await vscode.commands.executeCommand("vscode.diff", targetUri, previewUri, `Nova Agent: ${change.path}`);

    const choice = await vscode.window.showInformationMessage(
      `Apply Nova Agent change to ${change.path}?`,
      "Apply",
      "Skip",
      "Cancel"
    );

    if (choice === "Cancel") {
      skipped.push(change.path);
      await deletePreview(previewUri);
      break;
    }

    if (choice !== "Apply") {
      skipped.push(change.path);
      await deletePreview(previewUri);
      continue;
    }

    try {
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(change.content, "utf8"));
      applied.push(change.path);
    } catch (error) {
      if (existingContent !== undefined) {
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(existingContent, "utf8"));
      }

      throw error;
    } finally {
      await deletePreview(previewUri);
    }
  }

  vscode.window.showInformationMessage(`Nova Agent applied ${applied.length} file change(s).`);

  const result: AgentRunResult = {
    summary: plan.summary,
    applied,
    skipped,
    commands: await maybeRunAgentCommands(plan.commands)
  };
  return writeAndOpenAgentRunReport(plan, result);
}

export async function applyAgentPlanWithoutPrompt(plan: AgentPlan): Promise<AgentRunResult> {
  await validateAgentPlan(plan);

  const applied: string[] = [];

  for (const change of plan.changes) {
    const targetUri = resolveWorkspacePath(change.path);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(change.content, "utf8"));
    applied.push(change.path);
  }

  const result: AgentRunResult = {
    summary: plan.summary,
    applied,
    skipped: [],
    commands: await runAgentCommands(plan.commands)
  };
  return writeAgentRunReport(plan, result);
}

export function parseAgentPlan(response: string): AgentPlan {
  const parsed = safeJsonParse(stripMarkdownFence(response));

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Nova Agent returned invalid JSON.");
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const changes: unknown[] | undefined = Array.isArray(parsed.changes) ? parsed.changes : undefined;
  const commands: unknown[] = Array.isArray(parsed.commands) ? parsed.commands : [];

  if (!summary) {
    throw new Error("Nova Agent plan is missing a summary.");
  }

  if (!changes) {
    throw new Error("Nova Agent plan is missing a changes array.");
  }

  return {
    summary,
    changes: changes.map((change, index) => {
      if (!change || typeof change !== "object") {
        throw new Error(`Nova Agent change ${index + 1} is not an object.`);
      }

      const candidate = change as { path?: unknown; content?: unknown };

      if (typeof candidate.path !== "string" || !candidate.path.trim()) {
        throw new Error(`Nova Agent change ${index + 1} is missing a path.`);
      }

      if (typeof candidate.content !== "string") {
        throw new Error(`Nova Agent change ${candidate.path} is missing replacement content.`);
      }

      return {
        path: normalizeRelativePath(candidate.path),
        content: candidate.content
      };
    }),
    commands: commands.map((command, index) => {
      if (!command || typeof command !== "object") {
        throw new Error(`Nova Agent command ${index + 1} is not an object.`);
      }

      const candidate = command as { command?: unknown; reason?: unknown };

      if (typeof candidate.command !== "string" || !candidate.command.trim()) {
        throw new Error(`Nova Agent command ${index + 1} is missing a command.`);
      }

      if (typeof candidate.reason !== "string" || !candidate.reason.trim()) {
        throw new Error(`Nova Agent command ${candidate.command} is missing a reason.`);
      }

      return {
        command: candidate.command.trim(),
        reason: candidate.reason.trim()
      };
    })
  };
}

async function validateAgentPlan(plan: AgentPlan) {
  if (plan.changes.length > MAX_AGENT_CHANGES) {
    throw new Error(`Nova Agent proposed ${plan.changes.length} changes; the limit is ${MAX_AGENT_CHANGES}.`);
  }

  if (plan.commands.length > MAX_AGENT_COMMANDS) {
    throw new Error(`Nova Agent proposed ${plan.commands.length} commands; the limit is ${MAX_AGENT_COMMANDS}.`);
  }

  const seen = new Set<string>();

  for (const change of plan.changes) {
    if (seen.has(change.path)) {
      throw new Error(`Nova Agent proposed duplicate changes for ${change.path}.`);
    }

    seen.add(change.path);
    validateWorkspaceRelativePath(change.path);

    if (Buffer.byteLength(change.content, "utf8") > MAX_AGENT_FILE_BYTES) {
      throw new Error(`Nova Agent proposed a very large replacement for ${change.path}.`);
    }
  }

  for (const command of plan.commands) {
    validateAgentCommand(command.command);
  }
}

async function maybeRunAgentCommands(commands: AgentCommand[]) {
  const results: AgentCommandResult[] = [];

  for (const command of commands) {
    const choice = await vscode.window.showInformationMessage(
      `Run Nova Agent command: ${command.command}\n${command.reason}`,
      { modal: true },
      "Run",
      "Skip"
    );

    if (choice !== "Run") {
      continue;
    }

    const result = await runAgentCommand(command);
    results.push(result);
    vscode.window.showInformationMessage(`Nova Agent command exited ${result.exitCode}: ${command.command}`);
  }

  return results;
}

async function runAgentCommands(commands: AgentCommand[]) {
  const results: AgentCommandResult[] = [];

  for (const command of commands) {
    results.push(await runAgentCommand(command));
  }

  return results;
}

async function runAgentCommand(command: AgentCommand): Promise<AgentCommandResult> {
  validateAgentCommand(command.command);

  const folder = getWorkspaceFolder();
  const [executable, ...args] = command.command.split(/\s+/);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: folder.uri.fsPath,
      shell: false,
      env: process.env
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Nova Agent command timed out: ${command.command}`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => pushLimited(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => pushLimited(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({
        ...command,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function validateAgentCommand(command: string) {
  const parts = command.trim().split(/\s+/);
  const executable = parts[0];

  if (!ALLOWED_COMMANDS.has(executable)) {
    throw new Error(`Nova Agent command is not allowed: ${command}`);
  }

  if (parts.some((part) => BLOCKED_COMMAND_PARTS.includes(part))) {
    throw new Error(`Nova Agent command contains a blocked executable or token: ${command}`);
  }

  if ([...BLOCKED_SHELL_TOKENS].some((token) => command.includes(token))) {
    throw new Error(`Nova Agent command contains a blocked shell token: ${command}`);
  }

  if (!isAllowedValidationCommand(parts)) {
    throw new Error(`Nova Agent command is outside the validation allowlist: ${command}`);
  }
}

function isAllowedValidationCommand(parts: string[]) {
  const [executable, ...args] = parts;

  if (executable === "node") {
    return args.length === 1 && ["--version", "-v"].includes(args[0]);
  }

  if (executable === "tsc") {
    return args.every((arg) => ["--noEmit", "-b", "--pretty", "false"].includes(arg) || !arg.startsWith("-"));
  }

  if (["pnpm", "npm", "yarn"].includes(executable)) {
    return isAllowedPackageManagerCommand(args);
  }

  if (executable === "tsx") {
    return args.length > 0 && args.every((arg) => !arg.startsWith("-") || ["--tsconfig"].includes(arg));
  }

  if (executable === "git") {
    return ["status", "diff", "log", "show"].includes(args[0]);
  }

  return false;
}

function isAllowedPackageManagerCommand(args: string[]) {
  const commandIndex = args.findIndex((arg) => !arg.startsWith("-") && arg !== "run");
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;

  if (!command) {
    return false;
  }

  if (["test", "typecheck", "lint", "build"].includes(command)) {
    return true;
  }

  if (args[0] === "run" && command && /^(test|typecheck|lint|build)(:[a-z0-9._-]+)?$/i.test(command)) {
    return true;
  }

  return false;
}

function pushLimited(chunks: Buffer[], chunk: Buffer) {
  const currentSize = chunks.reduce((size, item) => size + item.byteLength, 0);

  if (currentSize >= MAX_COMMAND_OUTPUT_BYTES) {
    return;
  }

  chunks.push(chunk.subarray(0, MAX_COMMAND_OUTPUT_BYTES - currentSize));
}

function showAgentCommandSummary(results: AgentCommandResult[]) {
  if (results.length === 0) {
    return;
  }

  const failed = results.filter((result) => result.exitCode !== 0);

  if (failed.length > 0) {
    vscode.window.showWarningMessage(`Nova Agent ran ${results.length} command(s); ${failed.length} exited non-zero.`);
    return;
  }

  vscode.window.showInformationMessage(`Nova Agent ran ${results.length} command(s) successfully.`);
}

async function writeAndOpenAgentRunReport(plan: AgentPlan, result: AgentRunResult) {
  const finalResult = await writeAgentRunReport(plan, result);

  if (finalResult.reportPath) {
    const reportUri = resolveWorkspacePathAllowNova(finalResult.reportPath);
    const document = await vscode.workspace.openTextDocument(reportUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  return finalResult;
}

async function writeAgentRunReport(plan: AgentPlan, result: AgentRunResult): Promise<AgentRunResult> {
  const reportUri = buildAgentRunReportUri();
  const reportPath = vscode.workspace.asRelativePath(reportUri, false);
  const content = buildAgentRunReport(plan, {
    ...result,
    reportPath
  });

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(getWorkspaceFolder().uri, ".nova", "runs"));
  await vscode.workspace.fs.writeFile(reportUri, Buffer.from(content, "utf8"));

  return {
    ...result,
    reportPath
  };
}

function buildAgentRunReport(plan: AgentPlan, result: AgentRunResult) {
  const lines = [
    "# Nova Agent Run",
    "",
    `Summary: ${plan.summary}`,
    "",
    "## File Changes",
    "",
    formatList("Applied", result.applied),
    "",
    formatList("Skipped", result.skipped),
    "",
    "## Inspections",
    "",
    formatInspectionReport(plan.inspections ?? []),
    "",
    "## Commands",
    "",
    formatCommandReport(result.commands),
    ""
  ];

  return lines.join("\n");
}

function buildAgentPlanDocument(plan: AgentPlan, instruction: string) {
  const lines = [
    "# Nova Agent Plan",
    "",
    `Request: ${instruction}`,
    "",
    `Summary: ${plan.summary}`,
    "",
    "## Planned File Changes",
    "",
    formatPlanChanges(plan.changes),
    "",
    "## Proposed Commands",
    "",
    formatPlanCommands(plan.commands),
    "",
    "## Inspection Evidence",
    "",
    formatInspectionReport(plan.inspections ?? []),
    "",
    "## Review",
    "",
    "Use the confirmation dialog to apply this plan. Nova will still show a diff for each file before writing it.",
    ""
  ];

  return lines.join("\n");
}

function formatPlanChanges(changes: AgentFileChange[]) {
  if (changes.length === 0) {
    return "No file changes planned.";
  }

  return changes
    .map((change, index) => {
      return [
        `### ${index + 1}. ${change.path}`,
        "",
        `Replacement size: ${Buffer.byteLength(change.content, "utf8")} bytes`,
        "",
        "Preview:",
        "```",
        truncateForReport(change.content),
        "```"
      ].join("\n");
    })
    .join("\n\n");
}

function formatPlanCommands(commands: AgentCommand[]) {
  if (commands.length === 0) {
    return "No validation commands proposed.";
  }

  return commands
    .map((command, index) => {
      return [`${index + 1}. \`${command.command}\``, "", `Reason: ${command.reason}`].join("\n");
    })
    .join("\n\n");
}

function formatList(label: string, values: string[]) {
  if (values.length === 0) {
    return `${label}: none`;
  }

  return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

function formatInspectionReport(inspections: AgentInspectionResult[]) {
  if (inspections.length === 0) {
    return "No read-only inspections were requested.";
  }

  return inspections
    .map((inspection, index) => {
      const title =
        inspection.tool === "search"
          ? `${index + 1}. search "${inspection.query}"`
          : `${index + 1}. read ${inspection.path}`;

      return [
        `### ${title}`,
        "",
        `Reason: ${inspection.reason}`,
        "",
        "```",
        truncateForReport(inspection.content),
        "```"
      ].join("\n");
    })
    .join("\n\n");
}

function formatCommandReport(commands: AgentCommandResult[]) {
  if (commands.length === 0) {
    return "No validation commands were run.";
  }

  return commands
    .map((command, index) => {
      return [
        `### ${index + 1}. ${command.command}`,
        "",
        `Reason: ${command.reason}`,
        "",
        `Exit code: ${command.exitCode ?? "unknown"}`,
        "",
        "Stdout:",
        "```",
        truncateForReport(command.stdout || "(empty)"),
        "```",
        "",
        "Stderr:",
        "```",
        truncateForReport(command.stderr || "(empty)"),
        "```"
      ].join("\n");
    })
    .join("\n\n");
}

function truncateForReport(value: string) {
  const maxLength = 12000;

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... truncated ...`;
}

async function collectWorkspaceFileList() {
  const files = await vscode.workspace.findFiles(
    "**/*.{ts,tsx,js,jsx,json,md,py,go,rs,java,cs,css,scss,html,yml,yaml}",
    "**/{node_modules,.git,dist,out,build,vendor,.nova}/**",
    200
  );

  return files.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
}

function resolveWorkspacePath(relativePath: string) {
  const folder = getWorkspaceFolder();
  const normalized = normalizeRelativePath(relativePath);
  validateWorkspaceRelativePath(normalized);

  return vscode.Uri.joinPath(folder.uri, ...normalized.split("/"));
}

function buildAgentPreviewUri(relativePath: string) {
  const folder = getWorkspaceFolder();
  const safeName = normalizeRelativePath(relativePath).replace(/[^a-zA-Z0-9._-]+/g, "-");

  return vscode.Uri.joinPath(folder.uri, ".nova", "previews", `${Date.now()}-agent-${safeName}`);
}

function buildAgentRunReportUri() {
  const folder = getWorkspaceFolder();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  return vscode.Uri.joinPath(folder.uri, ".nova", "runs", `${timestamp}-agent-run.md`);
}

function buildAgentPlanUri() {
  const folder = getWorkspaceFolder();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  return vscode.Uri.joinPath(folder.uri, ".nova", "plans", `${timestamp}-agent-plan.md`);
}

function resolveWorkspacePathAllowNova(relativePath: string) {
  const folder = getWorkspaceFolder();
  const normalized = normalizeRelativePath(relativePath);

  if (path.isAbsolute(relativePath) || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Nova path must stay inside the workspace: ${relativePath}`);
  }

  return vscode.Uri.joinPath(folder.uri, ...normalized.split("/"));
}

function getWorkspaceFolder() {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    throw new Error("Open a workspace folder before running Nova Agent.");
  }

  return folder;
}

function validateWorkspaceRelativePath(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);

  if (path.isAbsolute(relativePath) || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Nova Agent path must stay inside the workspace: ${relativePath}`);
  }

  if (
    normalized
      .split("/")
      .some((part) => ["node_modules", ".git", "dist", "out", "build", "vendor", ".nova"].includes(part))
  ) {
    throw new Error(`Nova Agent cannot write excluded workspace path: ${relativePath}`);
  }
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

async function readFileIfExists(uri: vscode.Uri) {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return undefined;
  }
}

async function deletePreview(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // Preview cleanup is best-effort.
  }
}

function stripMarkdownFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  return fenced?.[1]?.trim() ?? trimmed;
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
