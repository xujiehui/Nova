import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const vscodeDir = path.resolve(process.env.VSCODE_DIR ?? path.join(rootDir, "vendor/vscode"));

type CopyEntry = {
  from: string;
  to: string;
};

const entries: CopyEntry[] = [
  {
    from: path.join(rootDir, "extensions/nova-ai"),
    to: path.join(vscodeDir, "extensions/nova-ai")
  }
];

function assertVscodeCheckout() {
  const packagePath = path.join(vscodeDir, "package.json");
  const extensionsPath = path.join(vscodeDir, "extensions");

  if (!fs.existsSync(packagePath) || !fs.existsSync(extensionsPath)) {
    throw new Error(`VS Code checkout not found at ${vscodeDir}. Run pnpm bootstrap:vscode first.`);
  }
}

function buildNovaExtension() {
  const pnpm = process.env.PNPM_EXECUTABLE ?? "pnpm";
  const result = spawnSync(pnpm, ["--filter", "nova-ai", "build"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    throw new Error("Failed to build Nova extension before applying overlay.");
  }
}

function copyRecursive(from: string, to: string) {
  const stats = fs.statSync(from);

  if (stats.isDirectory()) {
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });

    for (const child of fs.readdirSync(from)) {
      if (["node_modules", ".turbo", ".acceptance"].includes(child)) {
        continue;
      }

      copyRecursive(path.join(from, child), path.join(to, child));
    }
    return;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function mergeProductOverlay() {
  const productPath = path.join(vscodeDir, "product.json");
  const overlayPath = path.join(rootDir, "overlays/vscode/product.json");
  const product = JSON.parse(fs.readFileSync(productPath, "utf8")) as Record<string, unknown>;
  const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8")) as Record<string, unknown>;
  const nextProduct = mergeObjects(product, overlay);

  fs.writeFileSync(productPath, `${JSON.stringify(nextProduct, null, 2)}\n`);
  console.log(`Merged ${path.relative(rootDir, overlayPath)} -> ${path.relative(rootDir, productPath)}`);
}

function mergeObjects(base: Record<string, unknown>, overlay: Record<string, unknown>) {
  const output = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = output[key];

    if (Array.isArray(baseValue) && Array.isArray(value)) {
      output[key] = mergeArraysByName(baseValue, value);
    } else if (isPlainObject(baseValue) && isPlainObject(value)) {
      output[key] = mergeObjects(baseValue, value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function mergeArraysByName(base: unknown[], overlay: unknown[]) {
  const output = [...base];

  for (const item of overlay) {
    if (!isPlainObject(item) || typeof item.name !== "string") {
      output.push(item);
      continue;
    }

    const index = output.findIndex((existing) => isPlainObject(existing) && existing.name === item.name);

    if (index >= 0 && isPlainObject(output[index])) {
      output[index] = mergeObjects(output[index], item);
    } else {
      output.push(item);
    }
  }

  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

try {
  assertVscodeCheckout();
  buildNovaExtension();

  for (const entry of entries) {
    copyRecursive(entry.from, entry.to);
    console.log(`Applied ${path.relative(rootDir, entry.from)} -> ${path.relative(rootDir, entry.to)}`);
  }

  mergeProductOverlay();
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to apply Nova overlay.";
  console.error(message);
  process.exit(1);
}
