import * as vscode from "vscode";

export async function previewAndApplyEdit(params: {
  editor: vscode.TextEditor;
  replacement: string;
  title: string;
}) {
  const { editor, replacement, title } = params;
  const document = editor.document;
  const targetRange = editor.selection.isEmpty
    ? new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))
    : editor.selection;
  const original = document.getText(targetRange);
  const previewUri = buildPreviewUri(document, title);
  const encodedReplacement = Buffer.from(replacement, "utf8");

  await vscode.workspace.fs.writeFile(previewUri, encodedReplacement);
  await vscode.commands.executeCommand("vscode.diff", document.uri, previewUri, `Nova Preview: ${title}`);

  const choice = await vscode.window.showInformationMessage("Apply Nova edit to the active editor?", "Apply", "Discard");

  if (choice !== "Apply") {
    await deletePreview(previewUri);
    return false;
  }

  const applied = await editor.edit((editBuilder) => {
    editBuilder.replace(targetRange, replacement);
  });

  await deletePreview(previewUri);

  if (!applied) {
    await vscode.workspace.openTextDocument({
      content: original,
      language: document.languageId
    });
    throw new Error("VS Code rejected the edit. The original content was opened in a scratch document.");
  }

  return true;
}

function buildPreviewUri(document: vscode.TextDocument, title: string) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const baseUri = workspaceFolder?.uri ?? vscode.Uri.file(process.cwd());
  const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "edit";
  const fileName = document.uri.path.split("/").pop() ?? "file";

  return vscode.Uri.joinPath(baseUri, ".nova", "previews", `${Date.now()}-${safeTitle}-${fileName}`);
}

async function deletePreview(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // Preview cleanup is best-effort; stale previews are ignored by git.
  }
}
