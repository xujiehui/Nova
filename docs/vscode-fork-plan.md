# VS Code Fork Plan

## 1. Bootstrap Upstream

Run:

```bash
pnpm bootstrap:vscode
```

By default this clones `https://github.com/microsoft/vscode.git` into `vendor/vscode`. Override with:

```bash
VSCODE_REPO=https://github.com/your-org/vscode.git VSCODE_DIR=vendor/vscode pnpm bootstrap:vscode
```

## 2. Apply Nova Overlay

Run:

```bash
pnpm apply:overlay
```

This builds `extensions/nova-ai` and copies:

- `extensions/nova-ai` to `vendor/vscode/extensions/nova-ai`
- `overlays/vscode/product.json` to `vendor/vscode/product.json`

The script intentionally keeps the overlay small so upstream rebases stay manageable.
Nova AI is copied as a local extension under `extensions/nova-ai`; it is not added to `product.json` as a downloadable built-in extension.

Verify the overlay:

```bash
pnpm verify:overlay
```

## 3. Build The Built-In Extension

Run:

```bash
pnpm build:extension
```

The extension compiles to `extensions/nova-ai/dist/extension.js`. After `pnpm apply:overlay`, the same source lives inside the VS Code checkout and can be built through the normal VS Code build.

## 4. Run VS Code From Source

Check the local build environment:

```bash
pnpm check:vscode-env
```

The check validates the local VS Code checkout, `package-lock.json`, npm availability, Python, and the upstream Node.js requirement. At the time this project was tested, upstream VS Code required Node.js `v24.17.0` or newer within major version 24.

When using a project-local Node runtime, put it first on PATH before running the check or install:

```bash
pnpm setup:node
PATH="$PWD/.tooling/node-v24.17.0-darwin-arm64/bin:$PATH" pnpm check:vscode-env
```

Install upstream VS Code dependencies:

```bash
pnpm install:vscode-deps
```

If `npm` is not on PATH, provide a compatible command:

```bash
NPM_EXECUTABLE="pnpm dlx npm" pnpm install:vscode-deps
```

Inside `vendor/vscode`, follow the upstream development workflow:

```bash
npm run watch
./scripts/code.sh
```

On Windows use `scripts\\code.bat`. On Linux use `./scripts/code.sh`.

From the Nova overlay repository, use:

```bash
pnpm build:vscode-fast
pnpm smoke:vscode-start
pnpm start:vscode -- --disable-gpu
```

## 5. Nova AI Settings

The built-in extension contributes these settings:

- `nova.modelBaseUrl`
- `nova.modelId`
- `nova.apiKey`
- `nova.temperature`
- `nova.systemPrompt`

Any OpenAI-compatible provider can be used by changing those settings.

Use `Nova: Set Model API Key` to store the provider key for the active profile in VS Code SecretStorage. The `nova.apiKey` setting remains as a development fallback, but the command is the preferred path for real use.

Run `Nova: Create Model Profile` for each provider/model combination you want to keep, then use `Nova: Switch Model Profile` from the command palette or the Nova Chat view.

Run `Nova: Test Model Connection` after setting an API key. It validates the active profile's base URL, model ID, and API key through the same OpenAI-compatible chat completions endpoint used by Nova Chat.

## 6. Workspace Rules

Nova injects project rules into every model request. The supported files are:

- `.nova/rules.md`
- `.cursorrules`
- `.cursor/rules/**/*.md`
- `.cursor/rules/**/*.mdc`
