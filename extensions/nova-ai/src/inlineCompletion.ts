import * as vscode from "vscode";
import { requestChatCompletion } from "./modelClient";

const MAX_PREFIX_CHARS = 5000;
const MAX_SUFFIX_CHARS = 2000;

export function registerInlineCompletionProvider(context: vscode.ExtensionContext) {
  return vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    {
      async provideInlineCompletionItems(document, position, completionContext, token) {
        if (!isInlineCompletionEnabled()) {
          return;
        }

        if (completionContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && !isUsefulPosition(document, position)) {
          return;
        }

        if (token.isCancellationRequested) {
          return;
        }

        const completion = await requestInlineCompletion(document, position, context);

        if (token.isCancellationRequested || !completion) {
          return;
        }

        return {
          items: [
            new vscode.InlineCompletionItem(
              completion,
              new vscode.Range(position, position)
            )
          ]
        };
      }
    }
  );
}

export async function requestInlineCompletion(
  document: vscode.TextDocument,
  position: vscode.Position,
  extensionContext: vscode.ExtensionContext
) {
  const prompt = buildInlineCompletionPrompt(document, position);
  const response = await requestChatCompletion(prompt, undefined, extensionContext);

  return sanitizeInlineCompletion(response);
}

export function buildInlineCompletionPrompt(document: vscode.TextDocument, position: vscode.Position) {
  const offset = document.offsetAt(position);
  const text = document.getText();
  const prefix = text.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset);
  const suffix = text.slice(offset, offset + MAX_SUFFIX_CHARS);
  const relativePath = vscode.workspace.asRelativePath(document.uri, false);

  return [
    "You are Nova Inline, an AI code completion engine inside a VS Code fork.",
    "Return only the code/text that should be inserted at the cursor.",
    "Do not explain. Do not include markdown fences. Do not repeat existing prefix text.",
    "Keep the completion short and directly useful.",
    "",
    `File: ${relativePath}`,
    `Language: ${document.languageId}`,
    "",
    "Prefix before cursor:",
    "```",
    prefix,
    "```",
    "",
    "Suffix after cursor:",
    "```",
    suffix,
    "```"
  ].join("\n");
}

export function sanitizeInlineCompletion(response: string) {
  const withoutFence = response.trim().replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "");
  const lines = withoutFence.split(/\r?\n/);
  const trimmed = lines.join("\n").replace(/\s+$/g, "");

  if (!trimmed || trimmed.length > 4000) {
    return undefined;
  }

  return trimmed;
}

function isInlineCompletionEnabled() {
  return vscode.workspace.getConfiguration("nova.inlineCompletion").get<boolean>("enabled", true);
}

function isUsefulPosition(document: vscode.TextDocument, position: vscode.Position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

  return linePrefix.trim().length > 0 || position.character > 0;
}
