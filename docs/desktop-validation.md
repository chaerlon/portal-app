# Desktop validation for the Phase 1 test build

The tester has an Apple Silicon Mac; the owner uses Windows. The user has authorized committing and pushing Phase 1 from the current `main` checkout and repeating validation in GitHub Actions. Native Phase 1 build/test results will be recorded after those runs finish. Interactive Mac runtime checks remain pending the tester's results.

The historical baseline workflow run [35147389712](https://github.com/chaerlon/portal-app/actions/runs/35147389712) compiled and bundled the baseline `.app` and `.dmg`, then failed in its post-build architecture check because it derived the executable name from `Caelon Portal.app`. The upload steps were skipped. Commit `2b4ae20` corrected that check to read `CFBundleExecutable` from `Contents/Info.plist`. Its follow-up baseline run [35148106411](https://github.com/chaerlon/portal-app/actions/runs/35148106411) passed the arm64 check and uploaded both artifacts. That run preceded the Phase 1 implementation; a new run is required to validate the Phase 1 commit.

## Validate the pushed source

The macOS workflow runs JavaScript and locked ARM64 Rust tests, builds the app and DMG, verifies the executable architecture, and uploads both artifacts. Record the commit and workflow run for the downloaded build. The separate test workflow runs both suites on Ubuntu, Windows, and macOS.

To repeat the automated checks locally, clone the repository into a fresh directory on the tester's Mac:

```sh
git clone https://github.com/chaerlon/portal-app.git ~/Desktop/caelon-phase1-test
cd ~/Desktop/caelon-phase1-test
set -o pipefail
bash scripts/test-macos.sh 2>&1 | tee macos-test.log
```

The script expects native Apple Silicon execution, Xcode Command Line Tools, Node 20+, pnpm matching `package.json`, and Rust/rustup. Install missing prerequisites using the README instructions. It installs locked JS dependencies, ensures the ARM64 Rust target is present, runs JS and Rust tests, builds `.app`/`.dmg`, and checks the app executable architecture using `CFBundleExecutable` from its plist.

The script does not commit, push, publish, modify Portal, or launch the GUI automatically. It tests the checked-out source and prints the app path. A successful script run proves compilation, automated checks and artifact generation; it does not prove the manual cases below.

## Manual macOS checks

For each result, include the macOS version, build commit or source snapshot identifier, starting app state, action taken and observed behavior. Record failures as well as successes. Do not include tokens, cookies or passwords in logs or screenshots.

- [ ] Portal renders and navigation works.
- [ ] Authentik sign-in returns to the application successfully.
- [ ] A valid login survives Quit and reopening the application.
- [ ] Closing the window retains the process; clicking the dock icon restores and focuses the same window.
- [ ] Clicking the menu-bar icon opens Show Caelon Portal and Quit without toggling the window.
- [ ] Show restores a hidden or minimized window.
- [ ] The template icon is legible with light and dark menu-bar appearances.
- [ ] Quit ends the process.
- [ ] A real eligible assignment from a second account produces one native alert while the application is unfocused.
- [ ] Notifications work while hidden, immediately and after at least 15 minutes idle.
- [ ] Old unread assignments stay silent on launch; refetching does not repeat alerts.
- [ ] Notification permission grant/denial leaves Portal usable; record the actual prompt behavior.
- [ ] Delivery resumes after sleep/wake and network disconnect/reconnect; record recovery delay.
- [ ] Notifications remain suppressed while focused. Self-assignment behavior stays unchanged in this milestone.

## Windows regression checks

- [ ] Physical left-click still toggles the window; right-click opens the menu.
- [ ] Show and Quit work while hidden or minimized.
- [ ] Real eligible assignments notify while fully hidden, including after at least 15 minutes idle.
- [ ] Notification delivery resumes after sleep/wake and network reconnect.

## Return evidence

Return `macos-test.log` and the manual outcomes. If a build step fails, include the first error and surrounding output; do not skip the failed step and report the build as validated. A UI or background-delivery failure should be reported with its reproduction so Phase 4 can address it.
