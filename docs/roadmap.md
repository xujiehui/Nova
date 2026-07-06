# Nova Roadmap

## Phase 1: Fork Foundation

- Keep Nova changes isolated as overlay files.
- Clone or track upstream VS Code in `vendor/vscode`.
- Copy `extensions/nova-ai` into the fork as a built-in extension.
- Apply product branding through `product.json` and later icons/update channels.
- Verify the overlay against a real `vendor/vscode` checkout.
- Verify built-in extension activation and custom OpenAI-compatible model routing in VS Code extension-test mode.
- Prompt first-run setup and contribute a getting-started walkthrough for model configuration.

## Phase 2: AI Core

- Expand the current lightweight repository context retrieval into indexed repository-aware chat.
- Add inline edit previews and diff approval before applying model output.
- Expand the current inline completion provider with debouncing, caching, and provider-specific completion endpoints.
- Expand the current workspace rules system with user-level rules and per-language rules.
- Expand provider profiles beyond the current OpenAI-compatible presets into Anthropic-compatible gateways and enterprise policy-managed endpoints.

## Phase 3: Agent Workflows

- Expand the current bounded workspace edit and validation-command agent into richer tool execution for file search, terminal workflows, tests, and git.
- Add plan mode before multi-file changes.
- Add workspace indexing for semantic retrieval.
- Add MCP server configuration and execution.

## Phase 4: Productization

- Replace default branding, app IDs, update endpoints, and telemetry policy.
- Build macOS, Windows, and Linux installers.
- Add first-run model setup.
- Add enterprise policy controls for allowed model providers and audit logging.

## References

- VS Code Extension API: https://code.visualstudio.com/api
- VS Code Webview API: https://code.visualstudio.com/api/extension-guides/webview
- VS Code Contribution Points: https://code.visualstudio.com/api/references/contribution-points
- VS Code contribution/build prerequisites: https://github.com/microsoft/vscode/wiki/How-to-Contribute
- Cursor docs: https://cursor.com/docs
- Cursor rules: https://cursor.com/docs/rules
- Cursor MCP: https://cursor.com/docs/mcp
- Cursor models and pricing: https://cursor.com/docs/models-and-pricing
