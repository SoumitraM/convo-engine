# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Documentation context (non-obvious only)

- **`../ConvoEngine_Spec.md`** (workspace root, one level up) is the authoritative spec — not the README. The README is a consumer-facing quickstart; the spec is the implementation contract.
- **Section 8.1 of the spec** documents when NOT to use `ConversationEngine` — batch operations like report generation and field extraction bypass the engine and call the provider adapter directly. This is intentional, not a gap.
- **Section 7.1** documents tool selection via `beforeSend` — the spec explicitly says `convo-engine` has no tool registry and never will. Questions about tool registration belong in the consuming app, not this package.
- **`GatewayProviderAdapter_Spec.md`** (workspace root) is the full implementation spec for `src/adapters/provider/gateway.ts` — it contains the complete reference implementation and test cases. Use it directly.
- **The examples in Section 9** of the spec are AquantX-specific illustrations only — they are not requirements for this package.
- **`cacheBreakpoint`** is a field on `ProviderMessage` that only `ClaudeProviderAdapter` uses. Its presence in the interface is not a mistake — adapters without caching silently ignore it.
- **IBM gateway for live testing:** `LLM_TLS_REJECT_UNAUTHORIZED=false` is required because the gateway has a self-signed cert. Without it, all fetch calls fail with a TLS error — not a code bug.
