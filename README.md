# KAI Tools — Foundation plugin

Version 0.3.0 requires KAI Foundation 0.7.0 (plugin API 3).

This package owns MCP connections and process lifetime, email and calendar integrations, the tool registry, the local tool workspace, Developer Tools, saved agent teams, pipelines, playground, benchmarks, and their complete interfaces. Node runtime provisioning and the exact npm dependencies used by email are included in this repository's build inputs. Core does not contain these feature engines.

The plugin stores its own settings, account credentials, team definitions, benchmark results, runtime downloads and scratch files in its Foundation data directory. Accounts are encrypted using the documented OS secret-storage service. No old profile or account data is imported or deleted.

Local model calls use the Core inference API. Paid team and agent execution runs inside Tools; each model call uses the approved Core `run-chat` credit budget. Core continues to own wallet/payment authorization and the credit ledger. Tools does not receive wallet private keys.

MCP reconnects only servers the user has opted to reconnect. Services stay alive while KAI is open or in the tray. Disable/update/quit stops owned MCP processes and active runs. Local-Only hides egress tools and blocks remote account/MCP operations. Marking a native program offline-safe is the user's assertion; it is not a firewall.

**Trust:** this is a native plugin with full computer and application access. Its interface is sandboxed, while its Node service and launched commands are not. Node permission flags, restricted paths, timeouts and network module guards are defense in depth, not an adversarial sandbox. Sensitive tool calls and local scripts retain native user review.

## Public integration

The declared service `kai.tools` exports:

| Method | Input / result |
| --- | --- |
| `list` | Returns `{tools}` with available descriptors. |
| `call` | `{name,args,confirmed}`; the provider enforces privacy and reviews sensitive actions. |
| `request` / `poll` / `cancel` | Plugin-owned UI operations and bounded streams; requests carry `{path,method,body,requestId}`, polling carries `{streamId}`. |
| `payment` | `{action,input}`; handles local advanced-run execution and delegates only financial primitives to Core. |
| `paymentEvents` | `{runId,after}`; returns actual trace events `{sequence,trace}` and `running`. |

Consumed services are declared by the caller. Remote jobs are not authorized to use these local private services. No caller receives Tools' credentials or another plugin's storage.

## Building and verification

Run `npm ci --ignore-scripts`, `npm run build`, and `npm test` in the author/CI checkout. `scripts/build-service.js` copies the lock-resolved pure JavaScript runtime dependencies into the signed package, trims development files, includes licenses, and verifies imports. It accepts an optional dependency-source checkout for an offline build. No npm install or postinstall runs on the user's computer.

The checked-in `plugin/service/node_modules` tree and `dependencies.json` are intentional package contents. The signature covers every shipped dependency. Package the `plugin` directory with the Foundation packer and verify with `node scripts/verify-package.js`. Keep signing keys outside this repository.

Tests exercise real plugin-owned local pipelines, MCP/catalog and account routes, scoped workspace files, local-only filtering, and a paid team against a simulated Core budget ledger. They do not send email, create real calendar events, connect real accounts, or spend real credits. Live-service and native-platform verification remains separate.

## Foundation package publication

Requires KAI Core **0.7.0 or later**, manifest schema 2/API 3 and native API v1. Source lives in `plugin/`, including its service and all runtime dependencies. Runtime installation never runs npm or dependency hooks.

Before signing, install any author dependencies with `npm ci --ignore-scripts` when this repository has a lockfile, run `npm run build --if-present`, then `node scripts/verify-package.js --source` and `npm test`. The source-only check uses a temporary in-memory test signature; it does not claim a publisher release was signed.

Pack the complete plugin using Core's `scripts/core/pack-plugin.js`, keeping the publisher private key outside every repository. Place the new immutable signed asset at `dist/<repository-name>-<manifest-version>.kaiplugin`, then run `node scripts/verify-package.js`. The release verifier checks the actual publisher signature and exact source/assets/dependency contents against the same package rules as Core. Its standalone format snapshot and SHA-256 provenance are under `scripts/package-format-v3*`; it never imports or executes submitted plugin code.

CI tests source on `foundation-v1`, pull requests and `main` on Windows, macOS and Linux. It checks any signed asset present for the current version. Publication runs only from `main`, only when that exact signed asset exists, and only after every check passes. Existing release assets must match byte-for-byte and are never overwritten. Branch builds cannot publish releases. Native device/integration checks remain necessary before a release; unit tests do not replace them.
