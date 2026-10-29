# dsh-workbuddy-token

DSH (DeepSeek Harness) plugin: a capsule near the input box showing your remaining WorkBuddy credits converted to tokens at the "current model × current period" effective rate.

```
┌──────────────────────────────┐
│ glm-5.2 · x0.35 · night      │
│ ≈ 11.7M tokens (est.)        │
└──────────────────────────────┘
  Click the capsule = refresh both endpoints immediately
```

- Read-only: only calls `/v2/billing/meter/get-user-resource` and `/v3/config`; no check-in, claim, or 2api write endpoints
- Connects directly to the WorkBuddy upstream (`www.codebuddy.cn` / `www.workbuddy.ai`, routed by the credential's region/domain) — CPA is not a dependency and is never modified
- Zero hardcoded data: model roster, multipliers and promotions are rebuilt from the upstream on every refresh; validity is judged at compute time
- Request discipline: credits every 5 minutes and config every 2 hours by default, exponential backoff (1→2→4→8 min) on failure
- Credential discovery: CPA directory (`~/.cli-proxy-api/workbuddy-*.json`, glob) → WorkBuddy desktop sign-in file; neither logs nor UI ever print tokens

## Install into a DSH Desktop profile

```bash
pnpm i && pnpm build
node install.mjs                 # desktop profile by default; --profile <name> for others
```

The installer automatically: backs up the profile's `package.json`/`pnpm-lock.yaml` → registers the `file:` dependency and adds the package to `dsh.profile.bundles` → runs `pnpm install` → self-checks (host/client module loading, exports completeness, credential discovery). Idempotent; safe to re-run.

Note: DSH Desktop profiles are managed exclusively by the Electron application, so `dsh plugin add` refuses them; this script follows the same path as DSH's built-in plugin manager (edit the profile's package.json + pnpm). Rollback: restore the generated `.bak-<timestamp>` files and run `pnpm install`.

## Configuration (profile plugin settings)

| Key | Default | Description |
|---|---|---|
| `creditsIntervalSec` | 300 | Credits refresh interval (seconds, min 60) |
| `configIntervalSec` | 7200 | Model/promotion config refresh interval (seconds, min 600) |
| `cpaDir` | `~/.cli-proxy-api` | CPA credential directory |
| `baseTokensPerCredit` | 50000 | Base rate: tokens per credit at x1 multiplier (calibrated 2026-10-29 against real usage: 58.96M tokens ↔ 201.8 credits at weighted x0.169; official value unpublished — re-calibrate as needed) |

## Build and test

```bash
pnpm i && pnpm build   # lib/index.js + lib/client.js
pnpm test              # node test/verify.mjs — asserts conversion/window/parsing logic
```

## Three display states

- Normal: live data; remaining credits stay on the second line (WorkBuddy models add the token estimate); floating-rate models (e.g. `auto`) show a range
- Stale: on upstream failure, shows the last successful cache labeled "X min ago"
- Error: rejected credentials (401/403) prompt re-login; a model that vanished from the roster shows "delisted" while credits stay live; a model that never belonged to the WorkBuddy roster shows credits only, with no guessed rate

## License

[MIT](./LICENSE)
