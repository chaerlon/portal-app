# Caelon Portal — Desktop Shell (POC)

A minimal [Tauri v2](https://tauri.app) desktop shell that loads the hosted Portal
at **https://portal.caelonhq.com/auth/sign-in?error=account_not_linked**. The query
string deliberately keeps Portal's sign-in UI from immediately starting the OIDC
redirect; see "How the Portal URL is configured".

This is intentionally a *shell*, not a port. It has no custom commands or local
backend. It provides native lifecycle and notification integrations while loading
Portal's hosted interface.

---

## Quick start

```bash
pnpm install
pnpm dev          # development
pnpm build        # production bundle for the current platform
```

Prerequisites: [Rust](https://rustup.rs) (stable), Node 20+, pnpm 10+, plus the
platform toolchain below.

---

## Development

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `tauri dev`. Because this app has **no frontend build step** —
it loads a remote URL — there is no dev server and no file watching for web
assets. Rust changes trigger a rebuild and relaunch; Portal changes are picked
up simply by reloading the window.

Navigation decisions are logged to stdout, which is the fastest way to see the
policy working:

```
[portal] url=https://portal.caelonhq.com/ trusted_hosts=["auth.caelonhq.com", "portal.caelonhq.com"]
[nav] allow https://portal.caelonhq.com/
[nav] allow https://auth.caelonhq.com/application/o/authorize/?response_type=code&...
[nav] external https://github.com/some/repo
[nav] block file:///etc/passwd
```

A login redirect showing up as `external` rather than `allow` means the identity
provider host is missing from the trusted set — see "Authentication and cookies".

### Platform prerequisites

| Platform | Requirements |
|---|---|
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |
| **Windows** | VS Build Tools 2022 (C++ workload) + Windows SDK; WebView2 ships with Win11 |
| **Linux** | `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` |

---

## Production build — Apple Silicon macOS

On an Apple Silicon Mac:

```bash
pnpm install
rustup target add aarch64-apple-darwin     # no-op on an arm64 host
pnpm tauri build --target aarch64-apple-darwin
```

Outputs:

```
src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Caelon Portal.app
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Caelon Portal_0.1.0_aarch64.dmg
```

`pnpm build:mac-arm` is a shortcut for the same command.

### Building macOS from CI

`.github/workflows/desktop-macos.yml` builds the Apple Silicon bundle on a
`macos-14` runner (arm64, so it is a native build rather than a cross-compile)
and uploads the `.app` archive and `.dmg` as artifacts. It can be triggered
manually via **workflow_dispatch** or by a `desktop-v*` tag. Its bundle check reads
`CFBundleExecutable` from the generated `Info.plist`, then verifies that exact
binary is arm64. `.github/workflows/test.yml` is the normal cross-platform gate:
it runs Node's built-in notification-filter suite and the locked Rust suite on
Ubuntu, Windows, and macOS.

You **cannot** produce a macOS bundle from Windows or Linux — Apple's toolchain
and code-signing tools are macOS-only. Use CI or a Mac.

### Signing and notarization

The build above is **unsigned**: macOS will show "unidentified developer" and
Gatekeeper will quarantine downloaded copies. For distribution:

1. In `src-tauri/tauri.macos.conf.json`, add to `bundle.macOS`:
   ```json
   "entitlements": "Entitlements.plist",
   "signingIdentity": "Developer ID Application: … (TEAMID)"
   ```
   `Entitlements.plist` already exists with the network-client entitlement but is
   deliberately **not** wired in, because referencing entitlements in an unsigned
   build buys nothing and can fail the bundle step.
2. Set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
   `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` in the environment; Tauri picks
   these up automatically and notarizes.

---

### Testing Phase 1 on a Mac

GitHub Actions builds the pushed Phase 1 source and runs both test suites before
packaging. Download its artifacts for manual testing, or clone the repository
on an Apple Silicon Mac and run:

```sh
cd caelon-desktop
bash scripts/test-macos.sh
```

The script checks prerequisites, runs JavaScript and locked ARM64 Rust
tests, builds the `.app` and `.dmg`, and verifies the executable named by
`CFBundleExecutable`. It then prints the `.app` path for the manual lifecycle,
menu-bar, icon, login, permission, and notification checks in
[`docs/desktop-validation.md`](docs/desktop-validation.md). Those runtime checks
remain separate evidence from successful compilation.

The macOS workflow also launches the packaged app using the opt-in tray and
notification diagnostics. `scripts/smoke-macos.py` checks startup, hide/reveal,
clean Quit, and whether the remote Portal page can reach notification IPC. It
uploads JSON results, process logs, and available screenshots as
`caelon-portal-macos-smoke-evidence`. It uses the runner's desktop session without
a person clicking; it is not a display-free replacement for macOS.

The pinned desktop notification plugin reports permission as granted and queues
delivery asynchronously without returning the OS delivery result. A successful
notification probe therefore proves IPC request acceptance only. Banner display,
real assignment delivery, OS notification settings, and sleep/wake behavior
still need the manual checks. Bridge integration tests simulate browser/IPC
boundaries and do not prove native delivery.

---

## How the Portal URL is configured

One place, one source of truth: `src-tauri/src/lib.rs`.

```rust
const DEFAULT_PORTAL_URL: &str =
    "https://portal.caelonhq.com/auth/sign-in?error=account_not_linked";

const PORTAL_URL: &str = match option_env!("CAELON_PORTAL_URL") {
    Some(url) => url,
    None => DEFAULT_PORTAL_URL,
};
```

A second variable, `CAELON_AUTH_HOSTS` (comma-separated, default
`auth.caelonhq.com`), lists the identity-provider hosts that sign-in redirects
through. Override both together when pointing at another deployment:

```bash
CAELON_PORTAL_URL=https://portal.staging.caelonhq.com \
CAELON_AUTH_HOSTS=auth.staging.caelonhq.com \
  pnpm tauri build
```

Two deliberate consequences:

- **The trusted host is derived from this URL**, not configured separately, so
  the allowlist can never drift out of sync with the URL being loaded.
- **It is compile-time, not runtime.** A runtime-configurable URL would mean an
  attacker who can write the config file can point the shell at a site of their
  choosing and inherit the app's identity — including its cookie jar.
  `src-tauri/build.rs` emits `cargo:rerun-if-env-changed=CAELON_PORTAL_URL` so
  the value is never silently cached across builds.

---

## Security model

### The remote origin has zero IPC access

This is the single most important property of the POC.

Under Tauri v2, remotely-loaded content can only reach the IPC bridge if its
origin is explicitly listed in a capability's `remote.urls`.
`src-tauri/capabilities/default.json` has **no `remote` field**, so Portal —
and anything it loads — cannot invoke a single Tauri command. Combined with
`"withGlobalTauri": false`, there is no `window.__TAURI__` to reach for.

Do not add a `remote` entry without a reviewed reason. See
"Adding native APIs later" below for what that would entail.

### Navigation policy

`src-tauri/src/navigation.rs` is a pure function over `url::Url`, kept free of
Tauri types so it is unit-testable without a running app (`cargo test`).

| Request | Decision |
|---|---|
| `https://` on a **trusted host** (Portal or the identity provider) | **Allow** in-app |
| `http://` on a trusted host | **Block** — protocol downgrade would leak session cookies |
| `about:blank`, `about:srcdoc` | **Allow** — webview internals |
| Any other `http(s)` URL | **Open in system browser**, cancel in-app |
| `file:`, `data:`, `javascript:`, `blob:`, custom schemes | **Block** outright |

The trusted set is the Portal host plus `CAELON_AUTH_HOSTS` — see
"Authentication and cookies" for why sign-in needs two hosts.

Host matching is **exact and case-insensitive**. Subdomains are not implicitly
trusted. The tests cover the three classic matching bugs: suffix
(`portal.caelonhq.com.evil.com`), prefix (`notportal.caelonhq.com`), and
userinfo spoofing (`https://portal.caelonhq.com@evil.com/`).

Note that dangerous schemes are **Block**, not "open externally" — handing a
`file:` or `ms-settings:` URL to the OS opener would just relocate the bug.

### External links without IPC

`src-tauri/src/webview_bridge.js` is injected on every page load. It rewrites
`window.open(...)` and `target="_blank"` clicks into ordinary top-level
navigations, which then hit the Rust policy above.

This indirection is the point: handling these in JS would require calling a Rust
command, which would require granting Portal IPC access. Rewriting to a
navigation keeps that surface at zero.

Known trade-off: `window.open` returns `null` (as a popup-blocked browser would).
Callers that chain off the returned handle would break. Portal uses `window.open`
only for outbound links, so this is safe here — but re-check it if Portal starts
opening popups it then writes into.

### The CSP in `tauri.conf.json` does NOT apply to Portal

A common and dangerous misreading. `app.security.csp` is injected by Tauri into
**locally bundled assets only**. Remote pages are governed by the CSP their own
server sends. The CSP in this config therefore protects `dist/index.html` and
nothing else.

Portal's security headers are the server's responsibility. As observed, Portal
currently sends `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
and `Referrer-Policy: strict-origin-when-cross-origin`, but **no CSP header** —
worth adding server-side, independent of this shell.

---

## Authentication and cookies

Portal's API is **same-origin** (`https://portal.caelonhq.com/api`, better-auth
at base path `/api/auth`), so session cookies are **first-party** — no
third-party-cookie restrictions (ITP on WKWebView, Chromium's third-party cookie
phase-out) apply.

### Sign-in spans two hosts — this broke the first build

Portal does **not** authenticate locally. It delegates to **Authentik** at
`https://auth.caelonhq.com` over OIDC:

```
portal.caelonhq.com/
  -> auth.caelonhq.com/application/o/authorize/?response_type=code&scope=openid+email+profile
  -> auth.caelonhq.com/if/flow/default-authentication-flow/     (login UI)
  -> portal.caelonhq.com/api/auth/oauth2/callback/custom        (back with code)
```

This is invisible in Portal's JavaScript bundle: it is a *custom* OIDC provider
configured server-side, so no provider name appears in the client code. It only
showed up by running the app and reading the navigation log.

The first version of the policy trusted the Portal host alone, so the
`authorize` hop was punted to the system browser. The visible symptom is nasty:
the app window sits on Portal looking fine, a browser tab opens, and the session
never returns to the app — **login appears to silently do nothing**.

The policy therefore trusts a **set** of hosts. `CAELON_AUTH_HOSTS` supplies the
identity-provider hosts, defaulting to `auth.caelonhq.com`. Both hosts are still
matched exactly; `auth.caelonhq.com` is trusted, `evil.auth.caelonhq.com` is not.

> If Portal's identity provider ever moves, `CAELON_AUTH_HOSTS` must be updated
> in lockstep or sign-in breaks in exactly this way. The `[nav]` log is the
> fastest way to diagnose it: a login redirect logged as `external` is this bug.

### Cookie persistence

Each platform's webview keeps a persistent cookie store scoped to the app's
bundle identifier (`com.caelonhq.portal`), so login survives a restart.
`incognito` is left off, which is what makes that true.

**No cookie or session defects were encountered** once the auth host was
trusted. Worth knowing for later:

- Changing `identifier` in `tauri.conf.json` changes the data-store location and
  silently logs everyone out.
- `Secure` cookies require HTTPS, which is why the policy blocks plain HTTP to
  the Portal host rather than quietly downgrading.
- There is no "clear session" affordance in this POC. Signing out through
  Portal's own UI is the only path.

---

## Adding native APIs later

Today Portal runs as an ordinary web page with no knowledge that it is inside
Tauri. If it ever needs to call native APIs — notifications, tray, filesystem —
here is what changes, in dependency order:

1. **Grant the origin IPC access.** Add a `remote` block to a capability:
   ```json
   "remote": { "urls": ["https://portal.caelonhq.com"] }
   ```
   This is the security-critical step. It means any XSS in Portal, or any
   third-party script it loads, inherits access to every command you expose.
   Scope capabilities narrowly and expose the smallest possible surface.

2. **Expose specific commands.** Add `#[tauri::command]` handlers in Rust and
   grant only those permissions — never `core:default` wholesale to a remote
   origin.

3. **Give Portal a way to detect the shell.** Portal is also served in a plain
   browser, so every native call needs a guard. Either set a custom user-agent
   on the webview, or inject a flag from `webview_bridge.js`
   (e.g. `window.__CAELON_DESKTOP__ = { version: "0.1.0" }`) and have Portal
   feature-detect it.

4. **Then the Portal repo becomes a dependency of this one.** It is not today —
   that decoupling is why this POC needs no access to Portal's source.

An alternative worth weighing first: keep IPC closed and use **custom URL scheme
navigations** (e.g. `caelon://notify?...`) intercepted by the existing
`on_navigation` hook. Strictly less powerful — one-way, string-only, no return
values — but it adds no IPC surface at all. For a handful of simple actions
that trade is often correct.

---

## Desktop notifications

Implemented for **task assignments**, matching Portal's own "Desktop
notifications -- Task assignments from all your workspaces" setting.

### Why not Portal's existing push path

Portal notifies over **Web Push**: `/push-sw.js` subscribes with
`pushManager.subscribe({ applicationServerKey })` and shows notifications from
the service worker's `push` handler. The Push API does not exist in WKWebView or
WebView2, which is why Portal's settings page reports *"Off for this browser"*
inside the app. Granting permissions does not change this -- there is no push
service behind an embedded webview to subscribe to.

Nothing in the page calls `new Notification(...)` either, so shimming
`window.Notification` would also have done nothing.

### How it actually works

Portal's realtime socket delivers `{"type":"NOTIFICATION_CREATED"}`, on which the
page invalidates its `notifications` query and refetches over REST. The bridge
wraps `window.fetch` and reads that response. Watching the response rather than
the socket means the REST path never has to be hard-coded, and the records
arrive fully formed instead of as a bare signal.

Selection rules live in `src-tauri/src/notification_filter.js`, kept pure and
unit-tested under Node (`pnpm test`):

- only `type === "task_assignee_changed"`, unread
- **the first response of a session primes silently.** Portal accumulates unread
  notifications indefinitely, so without this the first load fires one popup per
  unread item
- dedupe by notification id; ids are recorded even when not shown, so an item
  can never resurface as new
- a single batch is capped, so a backfill cannot flood the desktop
- suppressed entirely while the window has focus

`title` and `content` arrive as `null` -- Portal composes display text on the
client -- so the text is built from `type` plus `eventData.taskTitle`.

### The security trade-off

This is the one place the shell grants the remote origin IPC access, in
`capabilities/portal-notifications.json`: three notification commands, one
origin, nothing else. `default.json` remains remote-free, so the split is
legible in review.

Understand the consequence before widening it: any script running on
portal.caelonhq.com -- including one injected via XSS or a compromised
dependency -- can raise OS notifications with arbitrary text. It cannot reach
filesystem, shell, window, or process APIs.

The URL in that capability is **static** and must be updated by hand if
`CAELON_PORTAL_URL` is repointed at another deployment.

### Verifying it

An opt-in probe proves the remote origin can actually reach the notification
IPC, which otherwise fails silently and indistinguishably from "no notifications
arrived yet":

```bash
CAELON_NOTIFY_SELFTEST=1 pnpm dev
```

It fires one notification and reports by navigating to a sentinel URL, because
`on_navigation` is the only channel observable from outside the webview. Watch
the nav log for `caelon_selftest=ok` (or `no-ipc` / `denied` / `error`). Unset
the variable and the probe is not injected at all.

The probe only proves the delivery path. The live filter was verified separately
on 2026-09-16, against an installed Windows build with a signed-in session: a
task was assigned through Portal's API and the app raised a real on-screen
banner, twice, each within ~0.7s of the server writing the
`task_assignee_changed` row (corroborated by `LastNotificationAddedTime`
advancing under `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.caelonhq.portal`).
Two behaviours worth knowing: assigning a task to **yourself** does notify --
Portal does not suppress self-assignment -- and *un*assigning does not.

### Windows: no toast appears in dev, and that is expected

`caelon_selftest=ok` means the IPC call succeeded -- it does **not** mean a toast
was drawn. On Windows a toast is only delivered from an app with a registered
AppUserModelID, and `tauri-plugin-notification` deliberately declines to set one
when the executable lives in `target\debug` or `target\release`
(`desktop.rs`, "set the notification's System.AppUserModel.ID only when running
the installed app"). Without it, Windows drops the toast silently while the call
still reports success.

So on Windows, notifications only appear from an **installed** build:

```bash
pnpm tauri build          # produces an NSIS/MSI installer
```

Install it, launch from the Start Menu, and toasts work. Registering the AUMID by
hand does not help, because the plugin never sends that id in dev.

If a toast lands in the action center (Win+N) but no banner appears on screen,
that is a per-app Windows setting rather than an app bug. Check
**Settings > System > Notifications > Caelon Portal > Show notification
banners**, or force it:

```powershell
$k = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.caelonhq.portal"
New-ItemProperty -Path $k -Name ShowBanner -Value 1 -PropertyType DWord -Force
```

macOS does not have this problem: the same code path calls
`notify_rust::set_application("com.apple.Terminal")` in dev and the real bundle
identifier in production, so notifications show in both.

---

## System tray

The close button does not quit the app -- it hides the window, and the tray icon
is how you get it back.

| Gesture | Result |
| --- | --- |
| Close (X) | Window hides; the process keeps running |
| Windows left-click the tray icon | Toggle: hide the window, or show + unminimize + focus it |
| Windows right-click the tray icon | Menu: **Show Caelon Portal**, **Quit** |
| macOS menu-bar icon click | Menu: **Show Caelon Portal**, **Quit**; it does not also toggle the window |
| macOS dock icon after hiding | Reuses the existing window and shows + unminimizes + focuses it |
| Quit | The only thing that ends the process |

Hiding rather than closing is the point of the feature, not a side effect of it.
`prevent_close` keeps the webview alive, so the Portal session's WebSocket stays
connected and task-assignment notifications keep arriving while the app is out of
sight. Destroying the window would tear the notification bridge down with it,
which would turn the tray icon into a way to *stop* being notified.

All of this is Rust, in `src-tauri/src/tray.rs`. No capability is involved and
the remote origin gains nothing from it: `default.json` is still `remote`-free
and `portal-notifications.json` still carries exactly its three permissions. The
Portal page cannot observe the tray, let alone drive it.

### The one rule worth knowing

Every platform reports a *minimized* window as visible. A literal show/hide
toggle would therefore hide a minimized window -- so clicking the tray icon to
bring the app back would make it disappear instead. `tray_click_action` treats
minimized as "not shown" for that reason. It is a pure function with unit tests
over all four states, kept separate from the Tauri calls for the same reason the
navigation policy is.

### Verifying it

```bash
CAELON_TRAY_SELFTEST=1 pnpm dev     # hide/reveal cycle, prints a verdict
CAELON_TRAY_SELFTEST=quit pnpm dev  # ...then runs the Quit item's body
```

The probe exists because the tray's real triggers are mouse clicks on an
OS-owned icon: nothing outside the app can observe them, and synthesising them
means clicking at real screen coordinates on a live desktop. It drives the same
helpers the click handlers call and prints `[tray-selftest] result=ok`.

Two lines in the startup log are worth reading:

```
[tray] ready id=TrayIconId("main") rect=Some(Rect { position: ... })
[tray] close requested -> hiding to tray
```

`rect` is the **only** honest proof the icon reached the notification area.
`TrayIconBuilder::build` returning `Ok` does not mean Windows accepted the icon
-- the underlying `tray-icon` crate deliberately ignores a failed
`Shell_NotifyIcon` so it can retry when Explorer announces `TaskbarCreated`. The
rect comes back from the shell's own `Shell_NotifyIconGetRect`, so `Some` means
the icon is really there and `None` means it is not. Whether it sits in the
visible tray or is tucked into the overflow chevron is a per-user Windows
setting that neither the app nor the rect can tell you.

### macOS lifecycle and menu bar

On macOS, `RunEvent::Reopen` finds the existing `main` window and calls the same
`tray::reveal` helper used by Show. It never constructs a second webview, so the
Portal session remains in the original window. The menu bar uses the transparent,
monochrome `src-tauri/icons/tray-template.png` asset with
`icon_as_template(true)`, and clicking it opens the Show/Quit menu without a
second toggle event. PNG decoding is explicitly enabled through Tauri's
`image-png` Cargo feature.

This implementation has not yet been exercised on macOS. Use the manual checklist
in `docs/desktop-validation.md` to record dock reopen, menu, icon appearance,
close-to-hide, and notification observations on an Apple Silicon Mac.

---

## Deliberately not implemented

Background services · filesystem access · auto-update · deep linking ·
offline support · Kaneo/Buzz integration.

The structure anticipates them: the navigation policy is isolated and tested,
the bridge script is a real file rather than an inline string, macOS bundle
settings are already split into their own config, and `Entitlements.plist` and
`Info.plist` exist ready to be wired up.

---

## Project layout

```
caelon-desktop/
├── package.json                    # Tauri CLI + scripts (no frontend build)
├── dist/index.html                 # local fallback; satisfies frontendDist
├── scripts/make-icon.mjs           # zero-dep PLACEHOLDER icon generator
├── .github/workflows/test.yml      # cross-platform cargo test matrix
├── .github/workflows/desktop-macos.yml  # macOS arm64 bundle (tag / dispatch)
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs                    # rerun-if-env-changed for CAELON_PORTAL_URL
    ├── tauri.conf.json             # portable config; app.windows is empty
    ├── tauri.macos.conf.json       # macOS-only bundle settings
    ├── Info.plist                  # auto-merged by Tauri on macOS
    ├── Entitlements.plist          # ready for signing; NOT wired in yet
    ├── capabilities/
    │   ├── default.json            # minimal; no `remote` => no IPC for Portal
    │   └── portal-notifications.json  # the ONLY remote grant: 3 notify perms
    └── src/
        ├── main.rs
        ├── lib.rs                  # window construction + policy wiring
        ├── navigation.rs           # pure, unit-tested navigation policy
        ├── tray.rs                 # tray icon + close-to-tray; pure toggle rule
        ├── notification_filter.js  # pure selection logic, tested under Node
        ├── notify_selftest.js      # opt-in notification probe
        └── webview_bridge.js       # target=_blank / window.open + notify bridge
```

The window is built in Rust rather than declared in `tauri.conf.json` because
`on_navigation` is only available on `WebviewWindowBuilder`. `app.windows` is
intentionally an empty array.

> **Icon is a placeholder.** `scripts/make-icon.mjs` draws a generic "C". Replace
> `scripts/icon-source.png` with real 1024×1024 artwork and run `pnpm icon`.
