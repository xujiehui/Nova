# Nova

Nova is a VS Code fork overlay for an AI-native coding editor. The first milestone keeps VS Code's editor and workbench intact, then adds a built-in Nova AI extension with user-configurable model routing.

## Current Milestone

- VS Code fork workflow scripts.
- Built-in `nova-ai` extension scaffold.
- Nova activity bar chat view.
- Streaming chat responses for OpenAI-compatible providers that support SSE.
- Commands for chat, explain, test generation, and AI edit.
- Inline completions powered by the active user model profile.
- Workspace agent command for small multi-file plans with read-only search/read inspection, plan documents, and review before applying.
- Agent Tasks view for reopening recent `.nova/plans/` and `.nova/runs/` records.
- User-configurable OpenAI-compatible model endpoint.
- Multiple model profiles with provider presets, quick switching, editing, and deletion.
- API-key-required and no-key local model profiles for hosted providers, Ollama, LM Studio, and trusted local gateways.
- Custom per-profile request headers for enterprise gateways and OpenAI-compatible routers.
- Custom per-profile request body fields for provider-specific parameters such as `top_p`, `max_tokens`, and router options.
- Model connection testing for the active profile.
- Built-in Models view for managing profiles, auth mode, headers, request body fields, API keys, and connection tests.
- API key storage through VS Code SecretStorage.
- First-run setup prompt and walkthrough for connecting a model provider.
- Workspace rules from `.nova/rules.md`, `.cursorrules`, and `.cursor/rules/*`.
- Built-in Rules view for creating and editing `.nova/rules.md` while showing loaded Nova/Cursor rule sources.
- Lightweight repository-aware context retrieval for chat and edits.

## Commands

```bash
pnpm install
pnpm setup:node
pnpm typecheck
pnpm build:extension
pnpm bootstrap:vscode
pnpm apply:overlay
pnpm verify:overlay
pnpm check:vscode-env
pnpm install:vscode-deps
pnpm build:vscode-fast
pnpm smoke:vscode-start
pnpm acceptance:vscode-model
pnpm website:dev
pnpm start:vscode -- --disable-gpu
```

`pnpm bootstrap:vscode` creates `vendor/vscode` from upstream VS Code. `pnpm apply:overlay` builds the Nova extension and copies Nova files into that checkout.

If `npm` is not available on PATH but can be launched another way, pass it explicitly:

```bash
NPM_EXECUTABLE="pnpm dlx npm" pnpm install:vscode-deps
```

Upstream VS Code currently requires Node.js `v24.17.0` or newer within major version 24. `pnpm check:vscode-env` reports the exact local mismatch before installation.

For a project-local Node runtime, run `pnpm setup:node`, then put its `bin` directory first on PATH:

```bash
PATH="$PWD/.tooling/node-v24.17.0-darwin-arm64/bin:$PATH" pnpm check:vscode-env
```

After dependencies are installed, `pnpm build:vscode-fast` transpiles the fork and built-in extensions. `pnpm start:vscode -- <args>` launches the Nova VS Code fork through the upstream `scripts/code.sh` or `scripts/code.bat`.

`pnpm acceptance:vscode-model` launches the Nova fork in VS Code extension-test mode, activates `nova.nova-ai`, points Nova settings at a local OpenAI-compatible mock server, and verifies that model test/chat/streaming requests use the configured base URL, model ID, and API key.

## Model Settings

Run `Nova: Setup` or `Nova: Configure Model` after applying the overlay, or open the `Models` view in the Nova side bar. Nova also prompts once on first run when the active profile is not ready. The Models view supports OpenAI, OpenRouter, DeepSeek, Qwen DashScope, Ollama, LM Studio, and custom OpenAI-compatible providers.

The underlying VS Code settings remain available for the default profile:

- `nova.modelBaseUrl`
- `nova.modelId`
- `nova.requiresApiKey`
- `nova.requestHeaders`
- `nova.requestBody`
- `nova.temperature`
- `nova.systemPrompt`
- `nova.inlineCompletion.enabled`

Run `Nova: Set Model API Key` to store the provider key securely for the active model profile. Local presets such as Ollama and LM Studio can be configured as no-key profiles; Nova will still call the OpenAI-compatible endpoint but will omit the `Authorization` header.

Use `nova.requestHeaders` or the profile editor's custom headers prompt for trusted gateway metadata such as tenant IDs, project IDs, or router hints. Header values are stored as a JSON object; Nova ignores reserved headers including `Authorization`, `Content-Type`, `Content-Length`, and `Host`.

Use `nova.requestBody` or the profile editor's custom request body field for provider-specific OpenAI-compatible parameters, for example `{"top_p":0.9,"max_tokens":4096}`. Body values are stored as a JSON object; Nova ignores reserved fields including `model`, `messages`, `stream`, and `temperature` so the active profile and request mode stay under Nova's control.

Use `Nova: Create Model Profile` to add another provider/model combination, then `Nova: Switch Model Profile` to route all Nova AI actions through it. `Nova: Edit Active Model Profile` and `Nova: Delete Model Profile` manage saved custom profiles.
Run `Nova: Test Model Connection` before chatting to verify the active profile's base URL, model ID, and API key.

The older command-palette setup flow remains available as `Nova: Configure Model (Quick Pick)` for keyboard-first workflows.

## Website

The promotional website lives in `website/` as a static site. Preview it locally with:

```bash
pnpm website:dev
```

Then open `http://localhost:4173/website/`.

Build the GitHub Pages artifact locally with:

```bash
pnpm website:build
```

The build output is written to `dist/website`. The `GitHub Pages` workflow builds that artifact on pushes to `main` that touch website-related files, uploads it with `actions/upload-pages-artifact`, and deploys it with `actions/deploy-pages`.

## Inline Completion

Nova registers an inline completion provider that uses the active model profile. It sends a bounded prefix/suffix around the cursor and expects the model to return only the insertion text. Toggle it with `nova.inlineCompletion.enabled`.

## Workspace Rules

Nova reads project-specific instructions from:

- `.nova/rules.md`
- `.cursorrules`
- `.cursor/rules/**/*.md`
- `.cursor/rules/**/*.mdc`

These rules are injected into the system context before active editor content.

Open `Nova: Open Rules` or the `Rules` view in the Nova side bar to create and edit `.nova/rules.md`. The view also shows which Nova and Cursor-compatible rule files are currently loaded.

## Repository Context

Nova scans a bounded set of workspace source files and injects the most relevant snippets based on the active prompt. This is intentionally lightweight for the first fork milestone; later phases can replace it with a persistent semantic index.

## Workspace Agent

Run `Nova: Run Agent` or use the `Agent` button in the Nova side bar for small workspace changes. Before asking for the final edit plan, Nova can ask the active model for a few read-only inspections, then safely runs bounded `search` and `read` tools inside the workspace. The final agent plan includes those inspection results, limits writes to normal workspace text files, excludes directories such as `node_modules`, `vendor`, `.git`, `dist`, `out`, `build`, and `.nova`, and opens a Markdown plan under `.nova/plans/` before anything is applied. If approved, Nova still opens a diff preview before each file is written.

Each run writes a Markdown report under `.nova/runs/` with the summary, inspections, applied/skipped files, and validation command output so changes remain reviewable after the notifications disappear.

Open `Nova: Open Agent Tasks` or the `Agent Tasks` view in the Nova side bar to reopen recent plan and run documents.

Agent plans can also propose validation commands. Nova only allows non-interactive validation/status commands such as `pnpm test`, `pnpm typecheck`, `npm run build`, `tsc --noEmit`, `node --version`, and read-only `git status`/`git diff` style commands, and asks before running each command.
