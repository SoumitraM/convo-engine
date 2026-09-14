# @smsoumitra/convo-engine

Standalone TypeScript module for managing multi-turn LLM conversations.

## Install

```bash
npm install @smsoumitra/convo-engine
```

Provider adapters live behind subpath exports so you only pull in the peer dependency you need:

```ts
import { ConversationEngine } from '@smsoumitra/convo-engine';
import { ClaudeProviderAdapter } from '@smsoumitra/convo-engine/adapters/claude';
import { InMemoryStorageAdapter } from '@smsoumitra/convo-engine/adapters/storage/memory';
```

`@anthropic-ai/sdk` and `openai` are optional peer dependencies — install whichever provider SDK you use.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Changes to `main` go through a pull request — GitHub branch protection requires 1 approval and a passing `test` status check, and a local pre-push hook (`.husky/pre-push`) blocks direct pushes to `main` as a first line of defense. CI (`.github/workflows/ci.yml`) runs typecheck/test/build on every PR.

## Releasing

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — no long-lived npm token stored in the repo.

**First release only** (a brand-new package can't use OIDC until it exists on the registry):

```bash
npm login
npm run build
npm publish
```

Then on [npmjs.com → package settings → Trusted Publisher](https://docs.npmjs.com/trusted-publishers/), add a GitHub Actions publisher pointing at this repo and the `publish.yml` workflow.

**Every release after that:**

1. Bump `version` in `package.json` (e.g. `npm version patch`) via a PR.
2. Once merged, tag the release from `main`: `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/publish.yml` builds and publishes automatically via OIDC when a tag matching `v*.*.*` is pushed.
