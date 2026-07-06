import * as vscode from "vscode";
import { hasApiKey, isModelProfileReady } from "./modelClient";
import { getActiveProfile } from "./profiles";

const SETUP_PROMPTED_KEY = "nova.setupPrompted";
const SETUP_COMPLETED_KEY = "nova.setupCompleted";

export type SetupStatus = {
  prompted: boolean;
  completed: boolean;
  hasApiKey: boolean;
  ready: boolean;
  activeProfile: {
    label: string;
    modelId: string;
    baseUrl: string;
    requiresApiKey: boolean;
  };
};

export async function maybePromptFirstRunSetup(context: vscode.ExtensionContext) {
  const prompted = context.globalState.get<boolean>(SETUP_PROMPTED_KEY, false);

  if (prompted || (await isModelProfileReady(context))) {
    if (await isModelProfileReady(context)) {
      await markSetupCompleted(context);
    }
    return;
  }

  await context.globalState.update(SETUP_PROMPTED_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    "Connect a model provider to start using Nova chat, agent, inline completion, and edits.",
    "Setup Model",
    "Later"
  );

  if (choice === "Setup Model") {
    await runSetup(context);
  }
}

export async function runSetup(context: vscode.ExtensionContext) {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(settings-gear) Configure Model",
        description: "Create or edit a model profile and store an API key",
        action: "configure"
      },
      {
        label: "$(plug) Test Current Model",
        description: "Verify the active profile before using Nova",
        action: "test"
      },
      {
        label: "$(comment-discussion) Open Nova Chat",
        description: "Open the side bar after setup",
        action: "chat"
      }
    ],
    {
      title: "Nova Setup",
      placeHolder: "Connect your model provider"
    }
  );

  if (!choice) {
    return getSetupStatus(context);
  }

  if (choice.action === "configure") {
    await vscode.commands.executeCommand("nova.configureModel");
  }

  if (choice.action === "test") {
    await vscode.commands.executeCommand("nova.testModelConnection");
  }

  if (choice.action === "chat") {
    await vscode.commands.executeCommand("nova.openChat");
  }

  if (await isModelProfileReady(context)) {
    await markSetupCompleted(context);
  }

  return getSetupStatus(context);
}

export async function markSetupCompleted(context: vscode.ExtensionContext) {
  await context.globalState.update(SETUP_COMPLETED_KEY, true);
}

export async function getSetupStatus(context: vscode.ExtensionContext): Promise<SetupStatus> {
  const activeProfile = getActiveProfile(context);
  const hasConfiguredKey = await hasApiKey(context);
  const ready = await isModelProfileReady(context);

  return {
    prompted: context.globalState.get<boolean>(SETUP_PROMPTED_KEY, false),
    completed: context.globalState.get<boolean>(SETUP_COMPLETED_KEY, false),
    hasApiKey: hasConfiguredKey,
    ready,
    activeProfile: {
      label: activeProfile.label,
      modelId: activeProfile.modelId,
      baseUrl: activeProfile.baseUrl,
      requiresApiKey: activeProfile.requiresApiKey
    }
  };
}
