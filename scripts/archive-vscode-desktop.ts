import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rootDir, vscodeDir } from "./vscode-runtime.js";

type Platform = "darwin" | "linux" | "win32";
type Arch = "x64" | "arm64";

const platform = getPlatform();
const arch = getArch();
const artifactDir = path.resolve(process.env.ARTIFACT_DIR ?? path.join(rootDir, "artifacts", "desktop"));
const buildRoot = path.dirname(vscodeDir);
const buildDirName = `VSCode-${platform}-${arch}`;
const buildDir = path.join(buildRoot, buildDirName);
const artifactBaseName = `Nova-${platform}-${arch}`;
const artifactPath = path.join(artifactDir, platform === "linux" ? `${artifactBaseName}.tar.gz` : `${artifactBaseName}.zip`);

assertDirectory(buildDir, `Desktop build output not found: ${buildDir}`);
assertNovaExtensionBundled();

fs.rmSync(artifactPath, { force: true });
fs.mkdirSync(artifactDir, { recursive: true });

if (platform === "linux") {
  run("tar", ["-czf", artifactPath, buildDirName], buildRoot);
} else if (platform === "win32") {
  run("tar", ["-a", "-cf", artifactPath, buildDirName], buildRoot);
} else {
  run("zip", ["-r", "-X", "-y", artifactPath, buildDirName], buildRoot);
}

console.log(`Created ${artifactPath}`);

function assertNovaExtensionBundled() {
  const extensionPath =
    platform === "darwin"
      ? path.join(buildDir, "Nova.app", "Contents", "Resources", "app", "extensions", "nova-ai", "package.json")
      : findFile(buildDir, path.join("resources", "app", "extensions", "nova-ai", "package.json"));

  if (!extensionPath || !fs.existsSync(extensionPath)) {
    throw new Error(`Nova AI extension was not found in ${buildDir}`);
  }
}

function findFile(directory: string, suffix: string): string | undefined {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const result = findFile(fullPath, suffix);
      if (result) {
        return result;
      }
    } else if (fullPath.endsWith(suffix)) {
      return fullPath;
    }
  }

  return undefined;
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function assertDirectory(directory: string, message: string) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(message);
  }
}

function getPlatform(): Platform {
  const value = process.env.VSCODE_PLATFORM ?? process.platform;

  if (value === "darwin" || value === "linux" || value === "win32") {
    return value;
  }

  throw new Error(`Unsupported VS Code desktop platform: ${value}`);
}

function getArch(): Arch {
  const value = process.env.VSCODE_ARCH ?? process.arch;

  if (value === "x64" || value === "arm64") {
    return value;
  }

  throw new Error(`Unsupported VS Code desktop architecture: ${value}`);
}
