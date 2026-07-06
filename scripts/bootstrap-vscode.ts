import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoUrl = process.env.VSCODE_REPO ?? "https://github.com/microsoft/vscode.git";
const targetDir = path.resolve(process.env.VSCODE_DIR ?? "vendor/vscode");

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

try {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    run("git", ["clone", "--depth=1", repoUrl, targetDir]);
  } else {
    run("git", ["fetch", "--depth=1", "origin"], targetDir);
    run("git", ["pull", "--ff-only"], targetDir);
  }

  console.log(`VS Code source is ready at ${targetDir}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to bootstrap VS Code.";
  console.error(message);
  process.exit(1);
}
