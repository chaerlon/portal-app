# Workflows

## `desktop-macos.yml` — Caelon Portal desktop, Apple Silicon

Builds the Tauri desktop client in `caelon-desktop/` for `aarch64-apple-darwin`
and uploads the `.app` and `.dmg` as workflow artifacts.

### Triggers

| Trigger | When |
|---|---|
| `workflow_dispatch` | Manual. Optional `portal_url` input overrides the URL compiled into the binary. |
| `push` on tag `desktop-v*` | Release builds, e.g. `desktop-v0.1.0`. |

It deliberately does **not** run on pushes to `main` — a full Rust release build
plus DMG packaging is too slow to sit in the normal push path.

### Prerequisites

- `caelon-desktop/pnpm-lock.yaml` must be committed. The install step uses
  `--frozen-lockfile`, so a missing lockfile fails with `ERR_PNPM_NO_LOCKFILE`.
- If `packageManager` is ever added to `caelon-desktop/package.json`, remove the
  `version:` input from the `pnpm/action-setup` step — declaring both is an error.

### Portal URL

`CAELON_PORTAL_URL` is a **compile-time** constant, defaulting to
`https://portal.caelonhq.com`. To build a binary pointing elsewhere (staging,
a preview deploy), run the workflow manually and set the `portal_url` input.

Because it is compile-time, `src-tauri/build.rs` declares
`cargo:rerun-if-env-changed=CAELON_PORTAL_URL` so a changed value correctly
invalidates the cached build rather than silently reusing the old URL.

### Signing

The POC builds **unsigned**. The six Apple secrets are documented in a commented
block on the build step; uncomment them and add the repository secrets to turn
signing on — no other part of the workflow changes.

They are commented rather than passed through as empty strings on purpose: an
empty-but-present `APPLE_CERTIFICATE` makes the Tauri CLI attempt a keychain
import and fail, instead of cleanly skipping signing.

Unsigned bundles trip Gatekeeper on any machine that downloads them. The
workflow's final step prints the `xattr -dr com.apple.quarantine` workaround.
