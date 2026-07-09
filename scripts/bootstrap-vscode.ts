import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoUrl = process.env.VSCODE_REPO ?? "https://github.com/microsoft/vscode.git";
const ref = process.env.VSCODE_REF ?? "ef9a35223cbba22ca5ee53164d39101a1aa4424e";
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
    run("git", ["clone", "--no-checkout", "--depth=1", repoUrl, targetDir]);
    run("git", ["fetch", "--depth=1", "origin", ref], targetDir);
  } else {
    run("git", ["fetch", "--depth=1", "origin", ref], targetDir);
  }

  run("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir);
  console.log(`VS Code source is ready at ${targetDir} (${ref})`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to bootstrap VS Code.";
  console.error(message);
  process.exit(1);
}
