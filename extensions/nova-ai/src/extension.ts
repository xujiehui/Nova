import * as vscode from "vscode";
import { applyAgentPlanWithoutPrompt, requestWorkspaceAgentPlan, runWorkspaceAgent, writeAgentPlanDocument } from "./agent";
import { listAgentTasks, NovaAgentTasksViewProvider } from "./agentTasksView";
import { NovaChatViewProvider } from "./chatViewProvider";
import { previewAndApplyEdit } from "./editPreview";
import { requestInlineCompletion, registerInlineCompletionProvider } from "./inlineCompletion";
import { NovaModelConfigViewProvider } from "./modelConfigView";
import {
  getActiveEditorContext,
  requestChatCompletion,
  requestChatCompletionStream,
  requestCodeEdit,
  storeApiKey,
  storeApiKeyForProfile,
  testModelConnection
} from "./modelClient";
import {
  createProfile,
  deleteProfile,
  editProfile,
  getActiveProfile,
  getProfileDisplayName,
  pickDeletableProfile,
  pickProfile,
  saveProfile
} from "./profiles";
import { readEditableWorkspaceRules, readWorkspaceRules, saveEditableWorkspaceRules } from "./rules";
import { NovaRulesViewProvider } from "./rulesView";
import { getSetupStatus, markSetupCompleted, maybePromptFirstRunSetup, runSetup } from "./setup";

type AcceptanceResult = {
  extensionId: string;
  activeProfile: {
    id: string;
    label: string;
    baseUrl: string;
    modelId: string;
    requiresApiKey: boolean;
    headersJson: string;
    bodyJson: string;
  };
  connection: Awaited<ReturnType<typeof testModelConnection>>;
  completion: {
    ok: boolean;
    content: string;
  };
};

export function activate(context: vscode.ExtensionContext) {
  const provider = new NovaChatViewProvider(context.extensionUri, context);
  const agentTasksProvider = new NovaAgentTasksViewProvider();
  const modelConfigProvider = new NovaModelConfigViewProvider(context);
  const rulesProvider = new NovaRulesViewProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NovaChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(registerInlineCompletionProvider(context));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NovaModelConfigViewProvider.viewType, modelConfigProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NovaRulesViewProvider.viewType, rulesProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NovaAgentTasksViewProvider.viewType, agentTasksProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  void maybePromptFirstRunSetup(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.openChat", async () => {
      await vscode.commands.executeCommand(`${NovaChatViewProvider.viewType}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.setup", async () => {
      await runSetup(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.explainFile", async () => {
      await vscode.commands.executeCommand(`${NovaChatViewProvider.viewType}.focus`);
      await provider.ask("Explain the active file. Focus on architecture, data flow, and likely risks.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.generateTests", async () => {
      await vscode.commands.executeCommand(`${NovaChatViewProvider.viewType}.focus`);
      await provider.ask("Generate high-value tests for the active file. Include runnable examples.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.runAgent", async () => {
      const instruction = await vscode.window.showInputBox({
        title: "Nova Agent",
        prompt: "Describe the workspace change Nova should plan and apply after review.",
        ignoreFocusOut: true
      });

      if (!instruction) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Nova Agent is planning...",
          cancellable: false
        },
        async () => {
          await runWorkspaceAgent(instruction, context);
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.setApiKey", async () => {
      await promptAndStoreApiKey(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.configureModel", async () => {
      await modelConfigProvider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.configureModelQuickPick", async () => {
      await configureModel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.openRules", async () => {
      await rulesProvider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.openAgentTasks", async () => {
      await agentTasksProvider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.pickModelProfile", async () => {
      const profile = await pickProfile(context);

      if (profile) {
        vscode.window.showInformationMessage(`Nova model profile: ${profile.label}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.createModelProfile", async () => {
      const profile = await createProfile(context);

      if (profile) {
        vscode.window.showInformationMessage(`Nova model profile created: ${profile.label}`);
        if (profile.requiresApiKey) {
          await promptAndStoreApiKey(context);
        } else {
          await markSetupCompleted(context);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.editModelProfile", async () => {
      const profile = await editProfile(context);

      if (profile) {
        vscode.window.showInformationMessage(`Nova model profile updated: ${profile.label}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.deleteModelProfile", async () => {
      const profile = await pickDeletableProfile(context);

      if (!profile) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete Nova model profile "${profile.label}"?`,
        { modal: true },
        "Delete"
      );

      if (confirmed !== "Delete") {
        return;
      }

      await deleteProfile(context, profile.id);
      vscode.window.showInformationMessage(`Nova model profile deleted: ${profile.label}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.testModelConnection", async () => {
      await runModelConnectionTest(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.acceptance", async (): Promise<AcceptanceResult> => {
      const activeProfile = getActiveProfile(context);
      const connection = await testModelConnection(context);

      if (!connection.ok) {
        throw new Error(`Nova acceptance connection failed: ${connection.message}`);
      }

      const content = await requestChatCompletion(
        "Return exactly: NOVA_CUSTOM_MODEL_OK",
        undefined,
        context
      );
      const ok = content.includes("NOVA_CUSTOM_MODEL_OK");

      if (!ok) {
        throw new Error(`Nova acceptance completion mismatch: ${content}`);
      }

      return {
        extensionId: context.extension.id,
        activeProfile: {
          id: activeProfile.id,
          label: activeProfile.label,
          baseUrl: activeProfile.baseUrl,
          modelId: activeProfile.modelId,
          requiresApiKey: activeProfile.requiresApiKey,
          headersJson: activeProfile.headersJson,
          bodyJson: activeProfile.bodyJson
        },
        connection,
        completion: {
          ok,
          content
        }
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nova.internal.configureProfile",
      async (input: {
        id: string;
        label: string;
        baseUrl: string;
        modelId: string;
        temperature?: number;
        requiresApiKey?: boolean;
        headersJson?: string;
        bodyJson?: string;
        apiKey?: string;
      }) => {
        await saveProfile(context, {
          id: input.id,
          label: input.label,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          temperature: input.temperature ?? 0.2,
          requiresApiKey: input.requiresApiKey ?? true,
          headersJson: input.headersJson ?? "{}",
          bodyJson: input.bodyJson ?? "{}"
        });

        if (input.apiKey) {
          await storeApiKeyForProfile(context, input.id, input.apiKey);
          await markSetupCompleted(context);
        } else if (input.requiresApiKey === false) {
          await markSetupCompleted(context);
        }

        return getActiveProfile(context);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.agentAcceptance", async (instruction: string) => {
      const plan = await requestWorkspaceAgentPlan(instruction, context);
      const planDocument = await writeAgentPlanDocument(plan, instruction);
      const result = await applyAgentPlanWithoutPrompt(plan);

      return {
        plan,
        planDocument,
        result
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.streamAcceptance", async () => {
      const chunks: string[] = [];
      const content = await requestChatCompletionStream(
        "Return exactly: NOVA_STREAMING_MODEL_OK",
        undefined,
        context,
        {
          onDelta: (delta) => {
            chunks.push(delta);
          }
        }
      );

      return {
        ok: content.includes("NOVA_STREAMING_MODEL_OK"),
        content,
        chunks
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.inlineAcceptance", async () => {
      const document = await vscode.workspace.openTextDocument({
        language: "typescript",
        content: "function novaInlineAcceptance() {\n  return "
      });
      const position = document.positionAt(document.getText().length);
      const completion = await requestInlineCompletion(document, position, context);

      return {
        completion
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.setupStatus", async () => {
      return getSetupStatus(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nova.internal.modelConfigAcceptance",
      async (input: {
        id: string;
        label: string;
        baseUrl: string;
        modelId: string;
        temperature?: number;
        requiresApiKey?: boolean;
        headersJson?: string;
        bodyJson?: string;
        apiKey?: string;
      }) => {
        await saveProfile(context, {
          id: input.id,
          label: input.label,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          temperature: input.temperature ?? 0.2,
          requiresApiKey: input.requiresApiKey ?? true,
          headersJson: input.headersJson ?? "{}",
          bodyJson: input.bodyJson ?? "{}"
        });

        if (input.apiKey) {
          await storeApiKeyForProfile(context, input.id, input.apiKey);
        }

        const connection = await testModelConnection(context);
        const profile = getActiveProfile(context);

        return {
          profile,
          connection,
          setup: await getSetupStatus(context)
        };
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.rulesAcceptance", async (content: string) => {
      const editable = await saveEditableWorkspaceRules(content);
      const discovered = await readWorkspaceRules();

      return {
        editable,
        discovered
      };
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.internal.agentTasksAcceptance", async () => {
      return listAgentTasks();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.editSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const activeContext = getActiveEditorContext();

      if (!editor || !activeContext) {
        vscode.window.showWarningMessage("Open a file before running Nova Edit.");
        return;
      }

      const instruction = await vscode.window.showInputBox({
        title: "Nova edit",
        prompt: "Describe the change Nova should make to the selected code or active file.",
        ignoreFocusOut: true
      });

      if (!instruction) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Nova is editing...",
          cancellable: false
        },
        async () => {
          const replacement = await requestCodeEdit(instruction, activeContext, context);
          const applied = await previewAndApplyEdit({
            editor,
            replacement,
            title: instruction
          });

          if (applied) {
            vscode.window.showInformationMessage("Nova edit applied.");
          }
        }
      );
    })
  );
}

export function deactivate() {}

async function configureModel(context: vscode.ExtensionContext) {
  while (true) {
    const activeProfile = getActiveProfile(context);
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(add) Create Profile",
          description: "Add an OpenAI-compatible provider",
          action: "create"
        },
        {
          label: "$(server-process) Switch Profile",
          description: getProfileDisplayName(activeProfile),
          action: "switch"
        },
        {
          label: "$(edit) Edit Active Profile",
          description: getProfileDisplayName(activeProfile),
          action: "edit"
        },
        {
          label: "$(key) Set API Key",
          description: activeProfile.requiresApiKey
            ? `Store key for ${activeProfile.label}`
            : `Optional for ${activeProfile.label}`,
          action: "key"
        },
        {
          label: "$(plug) Test Active Profile",
          description: `${activeProfile.modelId} · ${activeProfile.baseUrl}`,
          action: "test"
        },
        {
          label: "$(trash) Delete Custom Profile",
          description: "Remove a saved provider profile",
          action: "delete"
        }
      ],
      {
        title: "Configure Nova Model",
        placeHolder: `${activeProfile.label} · ${activeProfile.modelId}`
      }
    );

    if (!picked) {
      return;
    }

    if (picked.action === "create") {
      const profile = await createProfile(context);

      if (profile) {
        vscode.window.showInformationMessage(`Nova model profile created: ${profile.label}`);
        if (profile.requiresApiKey) {
          await promptAndStoreApiKey(context);
        } else {
          await markSetupCompleted(context);
        }
      }
      continue;
    }

    if (picked.action === "switch") {
      const profile = await pickProfile(context);

      if (profile) {
        vscode.window.showInformationMessage(`Nova model profile: ${profile.label}`);
      }
      continue;
    }

    if (picked.action === "edit") {
      const profile = await editProfile(context);

      if (profile) {
        vscode.window.showInformationMessage(`Nova model profile updated: ${profile.label}`);
      }
      continue;
    }

    if (picked.action === "key") {
      await promptAndStoreApiKey(context);
      continue;
    }

    if (picked.action === "test") {
      await runModelConnectionTest(context);
      continue;
    }

    if (picked.action === "delete") {
      await vscode.commands.executeCommand("nova.deleteModelProfile");
    }
  }
}

async function promptAndStoreApiKey(context: vscode.ExtensionContext) {
  const activeProfile = getActiveProfile(context);
  const apiKey = await vscode.window.showInputBox({
    title: "Nova model API key",
    prompt: `Store an API key for ${activeProfile.label}.`,
    password: true,
    ignoreFocusOut: true
  });

  if (!apiKey) {
    return false;
  }

  await storeApiKey(context, apiKey);
  await markSetupCompleted(context);
  vscode.window.showInformationMessage(`Nova API key saved for ${activeProfile.label}.`);
  return true;
}

async function runModelConnectionTest(context: vscode.ExtensionContext) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Testing Nova model connection...",
      cancellable: false
    },
    async () => {
      const result = await testModelConnection(context);
      const detail = `${result.modelId} · ${result.baseUrl} · ${result.latencyMs}ms`;

      if (result.ok) {
        vscode.window.showInformationMessage(`${result.message} ${detail}`);
      } else {
        vscode.window.showErrorMessage(`${result.message} ${detail}`);
      }

      return result;
    }
  );
}
