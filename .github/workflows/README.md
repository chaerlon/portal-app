# Workflows

## `desktop-macos.yml` — Caelon Portal desktop, Apple Silicon

Builds the Tauri desktop client in `caelon-desktop/` for `aarch64-apple-darwin`
and uploads the `.app` and `.dmg` as workflow artifacts.

After artifact upload, it launches the packaged app through the opt-in lifecycle
and notification probes. Runtime results, logs, and available screenshots are
uploaded as `caelon-portal-macos-smoke-evidence`, including on smoke failure.
Startup/lifecycle failures and unverified required notification IPC make the job
fail. Screenshot availability is recorded separately. A passed notification
probe proves IPC request acceptance, not native banner delivery or OS permission.

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
- `pnpm/action-setup` reads the pinned version from `packageManager` in
  `package.json`; do not also specify its `version:` input.

### Portal URL

`CAELON_PORTAL_URL` is a **compile-time** constant, defaulting to
`https://portal.caelonhq.com/auth/sign-in?error=account_not_linked`. This is the
same sign-in workaround as `DEFAULT_PORTAL_URL` in `src-tauri/src/lib.rs`: a bare
sign-in route immediately redirects to OIDC before Portal can render its own
sign-in UI. To build a binary pointing elsewhere (staging, a preview deploy), run
the workflow manually and set the `portal_url` input; that explicit input wins.

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

The architecture check reads `CFBundleExecutable` from each generated app's
`Contents/Info.plist` instead of assuming the `.app` directory name matches the
Cargo binary name.

## `desktop-windows.yml` — Caelon Portal desktop, Windows x64

Builds the Tauri desktop client on `windows-latest` and produces both installers
that `bundle.targets: "all"` already yields: the WiX `.msi` and the NSIS
`-setup.exe`. No configuration change was needed to get an MSI; the workflow
exists to make that MSI *downloadable*.

### Triggers

| Trigger | When | Output |
|---|---|---|
| `workflow_dispatch` | Manual. Optional `portal_url` input overrides the URL compiled into the binary. | Workflow artifacts only (14 days). No release. |
| `push` on tag `desktop-v*` | Release builds, e.g. `desktop-v0.1.0`. | Artifacts **and** a published GitHub Release with both installers plus `SHA256SUMS.txt`. |

Only a tag can produce a public download, so a manual build pointed at a staging
`portal_url` cannot become one by accident. The release step is the only reason
the job requests `contents: write`; GitHub has no step-scoped permissions, so the
grant sits at job scope.

The release is published, not drafted. Flip `draft: true` on the
`softprops/action-gh-release` step to have it land unlisted for review instead —
at the cost of the download URL not existing until someone presses Publish.

### Version guard

A tag build fails immediately unless the tag version matches `version` in
**both** `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. An MSI's
ProductVersion is read from the config rather than the tag, and Windows keys MSI
upgrade logic on ProductVersion — so a mismatched pair publishes an installer
that later refuses to be upgraded over. `desktop-macos.yml` has no equivalent
check because a `.dmg` carries no comparable upgrade semantics.

### Asset naming

Tauri names bundles after the product name verbatim, which puts a space in
`Caelon Portal_0.1.0_x64_en-US.msi`. GitHub replaces every space in a release
asset name with a dot, so the files are copied to a `dist-release/` staging
directory under hyphenated names first. That keeps the public download URL clean.

### Architecture check

The analogue of `lipo -archs` in the macOS workflow: it reads the PE header's
machine field from the built `caelon-desktop.exe` (the NT header offset lives at
`0x3C`; the machine word follows the 4-byte `PE\0\0` signature) and fails unless
it is `0x8664`. The build also pins `--target x86_64-pc-windows-msvc` rather than
trusting the host default, so a future arm64 `windows-latest` image cannot
silently ship arm64 binaries under x64 file names.

### Signing

The POC builds **unsigned**, and SmartScreen will warn on every download.

Enabling signing is *not* the Apple flow — the Tauri CLI reads no certificate
from the environment. `signtool` resolves the certificate from the Windows
certificate store by thumbprint, so it takes two coordinated changes: a
`certificateThumbprint` under `bundle.windows` in `tauri.conf.json`, and a
`.pfx` import step that runs before the build. Both are spelled out in the
commented block on the build step, including why an EV hardware token needs
`signCommand` and a cloud signing service instead.

## `test.yml` â€” cross-platform checks

Runs on Ubuntu, Windows, and `macos-14` for pushes, pull requests, and manual
dispatches. It installs Node 20 and runs `node --test tests/*.test.mjs` directly;
the test suite uses Node built-ins and needs neither `pnpm install` nor a frontend
build. It then runs `cargo test --locked --verbose` from `src-tauri` with the
platform webview dependencies installed on Ubuntu.

The macOS bundle workflow also runs JavaScript and locked ARM64 Rust tests before
building. Remote workflows test the pushed ref. To repeat the checks locally on
Apple Silicon, run `bash scripts/test-macos.sh` and record runtime results in
`docs/desktop-validation.md`.
