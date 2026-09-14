# @soumitrm/convo-engine

Standalone TypeScript module for managing multi-turn LLM conversations.

## Install

```bash
npm install @soumitrm/convo-engine
```

Provider adapters live behind subpath exports so you only pull in the peer dependency you need:

```ts
import { ConversationEngine } from '@soumitrm/convo-engine';
import { ClaudeProviderAdapter } from '@soumitrm/convo-engine/adapters/claude';
import { InMemoryStorageAdapter } from '@soumitrm/convo-engine/adapters/storage/memory';
```

`@anthropic-ai/sdk` and `openai` are optional peer dependencies — install whichever provider SDK you use.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Changes to `main` must go through a pull request (enforced by a local pre-push hook — see `.husky/pre-push`). CI (`.github/workflows/ci.yml`) runs typecheck/test/build on every PR.

## Releasing

1. Bump `version` in `package.json` (e.g. `npm version patch`).
2. Push the resulting tag: `git push origin main --tags` (from a merged PR, not a direct push to `main`).
3. `.github/workflows/publish.yml` publishes to npm automatically when a tag matching `v*.*.*` is pushed, provided the `NPM_TOKEN` repo secret is set.

To publish manually instead:

```bash
npm login
npm run build
npm publish
```
