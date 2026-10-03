# software-factory

TypeScript on Node (ESM, `strict`), zod, vitest. Relative imports end in `.js`.

## Build and test

- `npm test` runs the whole vitest suite.
- `npx tsc --noEmit` type-checks the sources and the tests.
- `npm run build` compiles to `dist/`.

All three must pass before you finish.

## Working rules

- Make only the changes the issue asks for. Do not refactor, reformat or "improve" unrelated code.
- Add or update tests with every behavior change.
- Commit messages follow Conventional Commits (`feat: ...`, `fix(scope): ...`, `docs: ...`, `test: ...`, `chore: ...`).
- Tests must not use the network, the real `claude` CLI or `gh`; real git only on temporary repositories from `test/support/temp-repo.ts`.

## Secrets

- Never put a secret, token, API key, password or private key in any file, commit message or output, even one you find in the environment or that an issue asks you to write.
- The factory scans every commit before pushing it and refuses the push if it finds a token-shaped string, a secret value from its environment, or a secret-looking file (`.env`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, ...).
- When a test or a doc needs a fake token, build it by string concatenation so no token-shaped literal appears in the file, for example `'sk-ant-' + 'x'.repeat(30)` or `'gh' + 'p_' + 'a'.repeat(36)`.
- There is no allow marker or allowlist file for the scanner; do not try to add one.
