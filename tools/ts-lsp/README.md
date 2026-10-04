# ts-lsp

A Claude Code plugin that gives the agent a TypeScript language server (go-to-definition, find-references, hover, call hierarchy) for this repository. It runs `tsc --lsp --stdio` from this repository's `node_modules/.bin`, for `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files.

## Needs

- `npm install` in the repository root, so `node_modules/.bin/tsc` exists (TypeScript 7 or later, the native compiler, which answers LSP itself).
- The plugin is used in place: it expects to live at `tools/ts-lsp/`, two levels below the repository root.

## Why not `typescript-language-server`

The official `typescript-lsp` plugin runs `typescript-language-server --stdio`, which needs a `tsserver.js`. TypeScript 7's `lib/` has none, so that plugin fails to initialize here ("provides no tsserver.js"). TypeScript 7's compiler speaks LSP directly, so this plugin runs that instead.

## Use

Add the directory to a policy's `pluginDirs` (see "Policy configuration" in the README). Whether it works together with `bare: true` is unconfirmed; see `docs/smoke-test.md`.
