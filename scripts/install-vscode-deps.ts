import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const vscodeDir = path.resolve(process.env.VSCODE_DIR ?? path.join(rootDir, "vendor/vscode"));

function run(command: string, args: string[], cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCommandLine(commandLine: string, cwd = process.cwd()) {
  const result = spawnSync(commandLine, {
    cwd,
    stdio: "inherit",
    shell: true
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hasCommand(command: string) {
  const result = command.includes(" ")
    ? spawnSync(`${command} --version`, {
        encoding: "utf8",
        shell: true
      })
    : spawnSync(command, ["--version"], {
        encoding: "utf8",
        shell: process.platform === "win32"
      });

  return result.status === 0;
}

if (!fs.existsSync(path.join(vscodeDir, "package-lock.json"))) {
  console.error(`VS Code checkout with package-lock.json not found at ${vscodeDir}. Run pnpm bootstrap:vscode first.`);
  process.exit(1);
}

const npmExecutable = process.env.NPM_EXECUTABLE ?? "npm";

if (!hasCommand(npmExecutable)) {
  console.error(
    "npm is required to install VS Code dependencies because the upstream checkout uses package-lock.json. Set NPM_EXECUTABLE to a compatible npm command if npm is not on PATH."
  );
  process.exit(1);
}

if (npmExecutable.includes(" ")) {
  runCommandLine(`${npmExecutable} install`, vscodeDir);
} else {
  run(npmExecutable, ["install"], vscodeDir);
}
