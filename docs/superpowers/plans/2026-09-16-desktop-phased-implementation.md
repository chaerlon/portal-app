# Caelon Desktop Phased Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` when implementation is requested. Work through the current milestone task by task and track completion with the checkboxes below. Later architecture and distribution phases require their own detailed designs before execution.

**Goal:** Produce an unsigned macOS ARM64 build for the owner and one tester, validate it on Apple Silicon, then use the results to guide notification reliability and production distribution.

**Architecture:** Kaneo / Portal remains a hosted application and the backend remains authoritative. Tauri owns the desktop lifecycle and native integrations. Keep the existing fetch-observing notification bridge during the initial Mac milestone; a stable notification interface is a separate follow-up phase.

**Tech stack:** Tauri v2, Rust, injected JavaScript, Node test runner, Windows WebView2, macOS WKWebView, GitHub Actions, `aarch64-apple-darwin`.

**Spec:** `../../../write_up_schema.txt`, with the approved discussion decisions below taking precedence over the original brief.

## Decisions already settled

- Audience: the owner and one tester.
- An Apple Silicon Mac is available for manual validation.
- The first Mac build is unsigned; Apple signing and auto-updates are deferred.
- Closing the window keeps the application running.
- Clicking the dock icon restores and focuses the existing window.
- Clicking the macOS menu-bar icon opens a menu with **Show Caelon Portal** and **Quit**.
- Quit explicitly ends the process.
- macOS uses a monochrome template menu-bar icon.
- Self-assignment filtering is not a priority. Preserve current behavior for this milestone; backend actor metadata is not a blocker.
- Retain the current notification bridge until Mac validation provides evidence about its limitations.

## Global constraints

- Do not duplicate Portal business logic in Rust.
- Keep native permissions narrow. Tray and lifecycle changes run Rust-side and do not require new Portal IPC grants.
- Normal hosted frontend changes arrive through Portal on load/reload; bundled native and bridge changes need a desktop release.
- Preserve Windows tray behavior while introducing platform-specific Mac behavior.
- Treat unit tests, successful builds and manual runtime tests as distinct evidence.
- Do not mark hidden-window notification delivery, sleep recovery or Mac authentication as verified without recorded runtime results.
- Do not include deep links, filesystem integration or other optional native features in the first tester build.

## Phase order

Working Windows POC -> Phase 1: macOS readiness -> Phase 2: ARM64 build -> Phase 3: Apple Silicon validation -> Phase 4: evidence-driven fixes -> Phase 5: stable notifications -> Phase 6: signing and notarization -> Phase 7: updates and production release.

Windows background checks run alongside Phases 1-3 and must be completed before claiming reliable cross-platform background delivery.

## Baseline: working Windows POC

Hosted Portal, authentication/navigation, real assignment notifications and close-to-tray lifecycle are reported as working. The previous review reran 22 Rust tests and 12 JavaScript tests successfully. These are baseline results, not proof that future changes pass.

The repository is already pushed. The user authorized workflow-only commit `2b4ae20` after the original `81f5bee` baseline's bundle check failed; corrected baseline run `35148106411` passed the arm64 check and uploaded both artifacts. The remaining Phase 1 source changes are uncommitted, and their native macOS build and runtime results remain unverified.

## Phase 1: macOS readiness and build consistency

**Purpose:** Make the application recoverable and understandable on a Mac before giving it to the tester.

**Files:**

- Modify `src-tauri/src/lib.rs`: app run loop and macOS reopen handling.
- Modify `src-tauri/src/tray.rs`: platform-specific menu behavior and template icon selection.
- Create `src-tauri/icons/tray-template.png`: monochrome artwork with transparency.
- Modify `.github/workflows/desktop-macos.yml`: consistent default launch URL.
- Modify `.github/workflows/test.yml`: JavaScript test coverage in CI.
- Update `README.md` and `.github/workflows/README.md`: actual behavior, workflow names and build instructions.

**Work:**

- [x] Handle macOS `RunEvent::Reopen` by finding the existing `main` window and reusing `tray::reveal`; do not create a duplicate window or new Portal session. Native macOS compilation/runtime verification remains pending.
- [x] Keep close-to-hide behavior and reuse existing Show and Quit actions.
- [x] On macOS, show the menu on icon click and avoid simultaneously toggling the window. Retain the Windows left-click toggle. The Windows policy is unit-tested; macOS UI verification remains pending.
- [x] Load the template icon on macOS and enable template rendering. Tauri's pinned `image-png` requirement is explicitly enabled and the transparent PNG is embedded. Native macOS appearance verification remains pending.
- [x] Make local builds and CI use the same default launch URL. Preserve the current sign-in workaround until authentication testing supports removing it. A user-supplied CI URL remains an explicit override.
- [x] Add Node setup and `node --test tests/*.test.mjs` to CI. These tests use Node built-ins and do not need a frontend build.
- [x] Run Windows Rust and JavaScript checks and record their results in `tmp/phase1-implementation-report.md`. Manually verify Mac-only behaviors after Phase 2 produces an artifact.

**Error behavior:** A reopen should not panic if the window cannot be found; report the failure. Continue attempting show, unminimize and focus through the existing helper, which reports failures separately. Missing template artwork must be visible in diagnostics and fail the phase's visual acceptance check.

**Complete when:** The intended lifecycle and menu behavior are implemented, tests pass, CI runs both suites, and the build path is ready for Mac verification. Runtime and icon acceptance remain pending until Phase 3.

**Decisions needed from the owner:** None for this phase. Use the agreed menu behavior and minimal template artwork for the test build.

**Implementation status (uncommitted):** Windows `node --test tests/*.test.mjs`, `cargo test --locked`, and `pnpm tauri build --no-bundle` have passed. Native macOS compilation, artifact verification, menu/dock/icon runtime behavior, authentication, permissions, and background notification delivery remain pending the local Apple Silicon tester checklist. Do not mark Phase 1 complete from Windows checks alone.

## Phase 2: generate the unsigned macOS ARM64 build

**Purpose:** Produce a traceable artifact that the owner and tester can install.

**Files:** `.github/workflows/desktop-macos.yml`, `src-tauri/tauri.macos.conf.json`, `README.md`.

**Work:**

- [ ] Publish the reviewed implementation changes to the testing branch when implementation and publication are authorized.
- [ ] Run the existing manual macOS workflow for the selected commit. Do not create a production release tag for the first test build.
- [ ] Confirm the build uses `aarch64-apple-darwin` and the workflow's executable architecture check passes.
- [ ] Download the `.dmg` and archived `.app`; preserve executable permissions and symlinks when extracting the app archive.
- [ ] Record the commit, workflow run, artifact names and install instructions in `docs/desktop-validation.md`.
- [ ] Install and launch the artifact on the available Apple Silicon Mac. Document any OS installation prompt or restriction encountered with the unsigned build.

**Complete when:** The expected ARM64 artifacts exist and the owner can launch the selected build on Apple Silicon. Build success alone does not complete Phase 3.

**Decisions needed from the owner:** None about signing for this milestone. Any GitHub publication or workflow action is handled separately when execution is requested.

## Phase 3: Apple Silicon validation and Windows background checks

**Purpose:** Establish actual desktop behavior, including the paths unit tests cannot prove.

**Files:** Create `docs/desktop-validation.md` for the test record. Use `src-tauri/src/notify_selftest.js` and the existing tray diagnostics only as supporting probes.

**Mac checklist:**

- [ ] Portal renders and ordinary navigation works in WKWebView.
- [ ] Authentik login returns successfully to Portal inside the app.
- [ ] A valid login session survives quitting and restarting the app.
- [ ] Closing hides the window; Show restores it; clicking the dock icon restores and focuses it without opening another window.
- [ ] The menu-bar icon is legible in light and dark appearances and opens the agreed menu.
- [ ] Quit ends the process.
- [ ] An eligible assignment produces one native alert while the app is unfocused.
- [ ] An eligible assignment produces one alert while the window is hidden, including after at least 15 minutes of idle time.
- [ ] Existing unread records remain silent on launch, and repeated refetches do not duplicate alerts.
- [ ] A new assignment is delivered after sleep/wake and after disconnecting/reconnecting the network; record recovery delay separately from normal delivery latency.
- [ ] The OS notification permission flow works. Test both granting and denying permission; denial must leave Portal usable.
- [ ] Suppression while focused continues to match the existing behavior. Self-assignment and unassign behavior remain unchanged in this milestone.

**Windows checks alongside Mac work:**

- [ ] Physical left-click, right-click menu, Show and Quit work, including minimized and hidden states.
- [ ] Real assignments notify while fully hidden to the tray, including after at least 15 minutes idle.
- [ ] New assignment delivery resumes after sleep/wake and a network reconnect.

**Evidence record:** For each case, record platform/OS version, build commit, initial state, action, expected result, observed result and pass/fail. Use real assignment events from a second account for delivery tests. Keep secrets, cookies and tokens out of screenshots and logs.

**Complete when:** Every checklist item has a recorded result. Any failed item has an identified reproduction and belongs to Phase 4; a completed checklist with failures is not a validated release.

**Owner/tester participation:** Run the Mac cases and provide observations or diagnostics. No additional feature choices are required to start this checklist.

## Phase 4: fix issues demonstrated by testing

**Purpose:** Resolve the failures from Phase 3 without expanding the product scope.

**Files:** Change only the files implicated by a recorded reproduction: lifecycle in `lib.rs`/`tray.rs`, bridge behavior in `webview_bridge.js`, filtering in `notification_filter.js`, auth/navigation in `navigation.rs`, and related tests/configuration.

- [ ] Reproduce each failure and identify whether it belongs to OS lifecycle, webview/authentication, permission handling or Portal realtime delivery.
- [ ] Add a regression test when the failure can be meaningfully reproduced in an automated test.
- [ ] Implement the smallest supported fix and rerun the affected checks.
- [ ] Retest the original manual reproduction on the affected platform and check the corresponding Windows/Mac path for regressions.
- [ ] Update `docs/desktop-validation.md` with the result and fixed commit.

**Complete when:** Login, reopen/quit, icon/menu behavior and required assignment notification cases pass on the test build. If hidden/background notification delivery cannot be made reliable with the current bridge, bring the relevant part of Phase 5 forward and agree on that architecture before implementation.

**Decision if a blocker appears:** Whether to introduce the stable notification interface immediately or retain a documented POC limitation. Do not silently present the limitation as resolved.

## Phase 5: stable direct/realtime notification interface

**Status:** Follow-up architecture phase, after Mac evidence or earlier if Phase 4 requires it.

**Purpose:** Remove the dependency on Portal's internal fetch/refetch implementation.

**Scope:** Inspect the existing backend realtime interface and authentication model. Design a stable event contract shared by Portal and Desktop, with IDs, recipient targeting, task reference and display data. Specify initial baselining, reconnect/resume behavior, deduplication, bursts, session changes, focused suppression and permission recovery.

**Completion criteria:** Desktop notifications use the explicit interface, handle the agreed reconnect/session cases, and are verified on Windows and Mac. The fetch observer is retired only after equivalent behavior is demonstrated.

**Decisions needed before detailed implementation:** Whether Portal/backend changes are in scope; how much delivery reliability is required; whether a connection inside the webview is sufficient or native connection ownership is necessary; notification-click behavior and any new notification types.

Self-assignment suppression remains a low-priority follow-up. Reliable actor metadata must be established before implementing that filter.

## Phase 6: Apple signing and notarization

**Status:** Distribution phase, after the test build's behavior is validated.

**Purpose:** Produce a signed/notarized Mac build suitable for the intended wider audience.

**Scope:** Configure the chosen Apple Developer identity, required entitlements and protected CI credentials. Enable signing/notarization in the Mac workflow and verify a downloaded artifact installs and launches through the normal OS flow.

**Completion criteria:** A signed/notarized artifact is validated on a separate Mac installation and the build/signing procedure is documented.

**Decisions needed:** Developer account/team ownership and whether the next audience is an internal team or customers. Assess Windows signing separately for the same distribution audience.

## Phase 7: auto-updates and production release process

**Status:** Production operations phase, after distribution requirements are agreed.

**Purpose:** Make native desktop releases reproducible and maintainable.

**Scope:** Design native updater delivery, artifact signing, versioning, release channels, rollout and recovery. Test updating an installed client without losing its session and define failure/recovery behavior. Hosted Portal deployments continue independently; bundled shell and bridge changes use this release process.

**Completion criteria:** A tested update from an older build to a newer build works on each supported platform, with documented publishing and recovery steps.

**Decisions needed:** Supported platforms/OS versions, update hosting, release ownership, update timing and whether separate testing/production channels are needed.

## Deferred product work

- Self-assignment filtering.
- Deep links and opening the associated task from a notification, subject to a later interaction design.
- Filesystem integration and other native features only when a concrete requirement exists.
- Offline support and independently running background services require separate product and architecture decisions.

## Verification during implementation

From the repository root:

```powershell
node --test tests/*.test.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Mac artifact generation runs on macOS through the existing workflow:

```sh
pnpm tauri build --target aarch64-apple-darwin
```

Passing these commands establishes automated/build evidence only. Phase 3's manual checks are required for Mac and background-delivery claims.

## Current next action

Phase 1 implementation and source review are finished. The user has authorized committing and pushing the changes on the current `main` branch. Run both test suites and the ARM64 packaging workflow for that commit, then record the results. The owner's friend will perform interactive Mac validation; the owner uses Windows. Phases 1-4 make up the first tester milestone. Phases 5-7 are separately scoped follow-up work.
