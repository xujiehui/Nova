import * as vscode from "vscode";

const RULE_FILES = [".nova/rules.md", ".cursorrules"];
const CURSOR_RULE_GLOB = ".cursor/rules/**/*.{md,mdc}";
const MAX_RULE_BYTES = 24000;
const NOVA_RULES_PATH = ".nova/rules.md";

export type WorkspaceRules = {
  source: string;
  content: string;
};

export type EditableWorkspaceRules = {
  path: string;
  content: string;
  exists: boolean;
};

export async function readWorkspaceRules(): Promise<WorkspaceRules[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders?.length) {
    return [];
  }

  const rules: WorkspaceRules[] = [];

  for (const folder of workspaceFolders) {
    for (const relativePath of RULE_FILES) {
      const uri = vscode.Uri.joinPath(folder.uri, relativePath);
      const content = await readRuleFile(uri);

      if (content) {
        rules.push({
          source: `${folder.name}/${relativePath}`,
          content
        });
      }
    }

    const cursorRules = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, CURSOR_RULE_GLOB),
      "**/{node_modules,.git,dist,out}/**",
      20
    );

    for (const uri of cursorRules) {
      const content = await readRuleFile(uri);

      if (content) {
        rules.push({
          source: vscode.workspace.asRelativePath(uri, false),
          content
        });
      }
    }
  }

  return rules;
}

export function formatWorkspaceRules(rules: WorkspaceRules[]) {
  if (!rules.length) {
    return "";
  }

  return [
    "Workspace rules:",
    ...rules.map((rule) => [`Source: ${rule.source}`, rule.content].join("\n"))
  ].join("\n\n");
}

export async function readEditableWorkspaceRules(): Promise<EditableWorkspaceRules> {
  const uri = getNovaRulesUri();
  const content = await readRuleFile(uri);

  return {
    path: NOVA_RULES_PATH,
    content,
    exists: content.length > 0
  };
}

export async function saveEditableWorkspaceRules(content: string) {
  const uri = getNovaRulesUri();
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    throw new Error("Open a workspace folder before editing Nova rules.");
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".nova"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content.trimEnd() + "\n", "utf8"));

  return readEditableWorkspaceRules();
}

export async function openEditableWorkspaceRules() {
  const rules = await readEditableWorkspaceRules();

  if (!rules.exists) {
    await saveEditableWorkspaceRules("# Nova workspace rules\n\n");
  }

  const document = await vscode.workspace.openTextDocument(getNovaRulesUri());
  await vscode.window.showTextDocument(document, { preview: false });
}

function getNovaRulesUri() {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    throw new Error("Open a workspace folder before editing Nova rules.");
  }

  return vscode.Uri.joinPath(folder.uri, NOVA_RULES_PATH);
}

async function readRuleFile(uri: vscode.Uri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString("utf8").trim();

    if (!content) {
      return "";
    }

    return content.slice(0, MAX_RULE_BYTES);
  } catch {
    return "";
  }
}
