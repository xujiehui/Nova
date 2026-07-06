import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const vscodeDir = path.resolve(process.env.VSCODE_DIR ?? path.join(rootDir, "vendor/vscode"));

const checks = [
  {
    label: "VS Code checkout",
    path: path.join(vscodeDir, "package.json")
  },
  {
    label: "Nova extension manifest",
    path: path.join(vscodeDir, "extensions/nova-ai/package.json")
  },
  {
    label: "Nova extension entrypoint",
    path: path.join(vscodeDir, "extensions/nova-ai/src/extension.ts")
  },
  {
    label: "Nova compiled extension",
    path: path.join(vscodeDir, "extensions/nova-ai/dist/extension.js")
  },
  {
    label: "Nova product overlay",
    path: path.join(vscodeDir, "product.json")
  }
];

let failed = false;

for (const check of checks) {
  if (fs.existsSync(check.path)) {
    console.log(`OK ${check.label}: ${path.relative(rootDir, check.path)}`);
  } else {
    failed = true;
    console.error(`MISSING ${check.label}: ${path.relative(rootDir, check.path)}`);
  }
}

const productPath = path.join(vscodeDir, "product.json");
const novaManifestPath = path.join(vscodeDir, "extensions/nova-ai/package.json");

if (fs.existsSync(productPath)) {
  const product = JSON.parse(fs.readFileSync(productPath, "utf8")) as {
    nameShort?: string;
    applicationName?: string;
    serverGreeting?: string[];
    darwinBundleIdentifier?: string;
    win32NameVersion?: string;
    builtInExtensions?: Array<{ name?: string }>;
  };

  if (product.nameShort === "Nova" && product.applicationName === "nova") {
    console.log("OK product branding: Nova");
  } else {
    failed = true;
    console.error("MISSING product branding: expected nameShort=Nova and applicationName=nova");
  }

  if (product.builtInExtensions?.some((extension) => extension.name === "nova-ai")) {
    failed = true;
    console.error("INVALID product metadata: nova-ai should be local under extensions/, not a downloadable builtInExtension");
  } else {
    console.log("OK product metadata: nova-ai is not a downloadable builtInExtension");
  }

  if (product.serverGreeting && product.darwinBundleIdentifier && product.win32NameVersion) {
    console.log("OK product metadata preserved: upstream platform fields");
  } else {
    failed = true;
    console.error("MISSING preserved product metadata: upstream platform fields look overwritten");
  }
}

if (fs.existsSync(novaManifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(novaManifestPath, "utf8")) as {
    name?: string;
    publisher?: string;
    main?: string;
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command?: string }>;
      viewsContainers?: { activitybar?: Array<{ id?: string }> };
      views?: Record<string, Array<{ id?: string }>>;
      walkthroughs?: Array<{ id?: string; steps?: Array<{ media?: { markdown?: string } }> }>;
      configuration?: { properties?: Record<string, unknown> };
    };
  };
  const manifestDir = path.dirname(novaManifestPath);
  const mainPath = manifest.main ? path.join(manifestDir, manifest.main) : "";

  expect("Nova extension identifier is nova.nova-ai", manifest.publisher === "nova" && manifest.name === "nova-ai");
  expect("Nova manifest main points to compiled file", Boolean(manifest.main && fs.existsSync(mainPath)));
  expect("Nova activation event registered", Boolean(manifest.activationEvents?.includes("onView:nova.chatView")));
  expect("Nova startup activation registered", Boolean(manifest.activationEvents?.includes("onStartupFinished")));
  expect(
    "Nova commands registered",
    [
      "nova.openChat",
      "nova.setup",
      "nova.runAgent",
      "nova.openAgentTasks",
      "nova.editSelection",
      "nova.configureModel",
      "nova.configureModelQuickPick",
      "nova.openRules",
      "nova.createModelProfile",
      "nova.editModelProfile",
      "nova.deleteModelProfile",
      "nova.testModelConnection"
    ].every((command) => manifest.contributes?.commands?.some((item) => item.command === command))
  );
  expect(
    "Nova activity bar container registered",
    Boolean(manifest.contributes?.viewsContainers?.activitybar?.some((item) => item.id === "nova"))
  );
  expect("Nova chat view registered", Boolean(manifest.contributes?.views?.nova?.some((item) => item.id === "nova.chatView")));
  expect("Nova agent tasks view registered", Boolean(manifest.contributes?.views?.nova?.some((item) => item.id === "nova.agentTasksView")));
  expect("Nova model config view registered", Boolean(manifest.contributes?.views?.nova?.some((item) => item.id === "nova.modelConfigView")));
  expect("Nova rules view registered", Boolean(manifest.contributes?.views?.nova?.some((item) => item.id === "nova.rulesView")));
  expect("Nova setup walkthrough registered", Boolean(manifest.contributes?.walkthroughs?.some((item) => item.id === "nova.setup")));
  expect(
    "Nova setup walkthrough media registered",
    Boolean(
      manifest.contributes?.walkthroughs
        ?.find((item) => item.id === "nova.setup")
        ?.steps?.every((step) => step.media?.markdown && fs.existsSync(path.join(manifestDir, step.media.markdown)))
    )
  );
  expect(
    "Nova model settings registered",
    [
      "nova.modelBaseUrl",
      "nova.modelId",
      "nova.requiresApiKey",
      "nova.requestHeaders",
      "nova.requestBody",
      "nova.temperature",
      "nova.inlineCompletion.enabled"
    ].every((setting) => Boolean(manifest.contributes?.configuration?.properties?.[setting]))
  );
}

if (failed) {
  process.exit(1);
}

function expect(label: string, ok: boolean) {
  if (ok) {
    console.log(`OK ${label}`);
  } else {
    failed = true;
    console.error(`MISSING ${label}`);
  }
}
