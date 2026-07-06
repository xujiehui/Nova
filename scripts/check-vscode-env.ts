import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const vscodeDir = path.resolve(process.env.VSCODE_DIR ?? path.join(rootDir, "vendor/vscode"));

type Check = {
  label: string;
  ok: boolean;
  detail: string;
};

const checks: Check[] = [
  checkPath("VS Code checkout", path.join(vscodeDir, "package.json")),
  checkPath("VS Code package lock", path.join(vscodeDir, "package-lock.json")),
  checkNodeVersion(process.env.NODE_EXECUTABLE),
  checkCommand("npm", ["--version"], process.env.NPM_EXECUTABLE),
  checkCommand("python3", ["--version"])
];

let failed = false;

for (const check of checks) {
  if (check.ok) {
    console.log(`OK ${check.label}: ${check.detail}`);
  } else {
    failed = true;
    console.error(`MISSING ${check.label}: ${check.detail}`);
  }
}

if (failed) {
  console.error("\nInstall the missing tools, then run pnpm install:vscode-deps.");
  process.exit(1);
}

function checkPath(label: string, filePath: string): Check {
  return {
    label,
    ok: fs.existsSync(filePath),
    detail: path.relative(rootDir, filePath)
  };
}

function checkCommand(command: string, args: string[], override?: string): Check {
  const executable = override ?? command;
  const result = override
    ? spawnCommandLine([executable, ...args].join(" "))
    : spawnSync(executable, args, {
        encoding: "utf8",
        shell: process.platform === "win32"
      });

  return {
    label: override ? `${command} (${override})` : command,
    ok: result.status === 0,
    detail: result.status === 0 ? (result.stdout || result.stderr).trim() : "not found on PATH"
  };
}

function spawnCommandLine(commandLine: string) {
  return spawnSync(commandLine, {
    encoding: "utf8",
    shell: true
  });
}

function checkNodeVersion(override?: string): Check {
  const executable = override ?? "node";
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    return {
      label: override ? `node (${override})` : "node",
      ok: false,
      detail: "not found on PATH"
    };
  }

  const version = (result.stdout || result.stderr).trim().replace(/^v/, "");
  const [major, minor] = version.split(".").map((part) => Number(part));
  const ok = major === 24 && minor >= 17;

  return {
    label: override ? `node (${override})` : "node",
    ok,
    detail: ok ? `v${version}` : `v${version}; VS Code requires Node.js v24.17.0 or newer with major version 24`
  };
}
