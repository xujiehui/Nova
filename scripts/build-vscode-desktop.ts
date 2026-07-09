import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeEnv, vscodeDir } from "./vscode-runtime.js";

type Platform = "darwin" | "linux" | "win32";
type Arch = "x64" | "arm64";

const platform = getPlatform();
const arch = getArch();
const npmExecutable = process.env.NPM_EXECUTABLE ?? "npm";
const env = {
  ...getRuntimeEnv(),
  VSCODE_ARCH: arch,
  npm_config_arch: arch
};

if (platform === "win32") {
  env.PATH = withWindowsSdk(env.PATH);
}

patchVscodePackagingForNova();
run(npmExecutable, ["run", "gulp", "core-ci"]);
run(npmExecutable, ["run", "gulp", `vscode-${platform}-${arch}-min-ci`]);

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: vscodeDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
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

function withWindowsSdk(currentPath: string | undefined) {
  const sdkBin = findWindowsSdkBin();
  return sdkBin ? `${sdkBin}${path.delimiter}${currentPath ?? ""}` : currentPath;
}

function findWindowsSdkBin() {
  const kitsRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";

  if (!fs.existsSync(kitsRoot)) {
    return undefined;
  }

  const versions = fs
    .readdirSync(kitsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const version of versions) {
    const candidate = path.join(kitsRoot, version, "x64");
    if (fs.existsSync(path.join(candidate, "signtool.exe"))) {
      return candidate;
    }
  }

  return undefined;
}

function patchVscodePackagingForNova() {
  const gulpfilePath = path.join(vscodeDir, "build", "gulpfile.vscode.ts");
  let content = fs.readFileSync(gulpfilePath, "utf8");
  const original = content;

  content = content
    .replace(
      "import { compileNonNativeExtensionsBuildTask, compileNativeExtensionsBuildTask, compileAllExtensionsBuildTask, compileExtensionMediaBuildTask, cleanExtensionsBuildTask, compileCopilotExtensionBuildTask } from './gulpfile.extensions.ts';",
      "import { compileNonNativeExtensionsBuildTask, compileNativeExtensionsBuildTask, compileAllExtensionsBuildTask, compileExtensionMediaBuildTask, cleanExtensionsBuildTask } from './gulpfile.extensions.ts';"
    )
    .replace(/,\n\t\t\tprepareCopilotRipgrepShimTask\(platform, arch, destinationFolderName\)/g, "")
    .replace(/\n\t\t\t\tcompileCopilotExtensionBuildTask,/g, "");

  if (content !== original) {
    fs.writeFileSync(gulpfilePath, content);
    console.log("Patched VS Code packaging to exclude the upstream Copilot built-in extension shim for Nova.");
  }
}
