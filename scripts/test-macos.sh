#!/usr/bin/env bash
# Run with: bash scripts/test-macos.sh
# Builds the working source; does not commit, push, or create a release.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Run this script natively on an Apple Silicon Mac (not under Rosetta)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
for command_name in node pnpm cargo rustup xcode-select lipo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing prerequisite: $command_name. See README.md for Mac setup." >&2
    exit 1
  fi
done
xcode-select -p >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node 20 or newer is required"); process.exit(1); }'

echo "Testing this source snapshot on $(sw_vers -productVersion) / $(uname -m)"
if [[ -f MACOS-SOURCE-SNAPSHOT.txt ]]; then
  cat MACOS-SOURCE-SNAPSHOT.txt
fi
echo "Node: $(node --version); pnpm: $(pnpm --version); Rust: $(rustc --version)"
if [[ -n "${CAELON_PORTAL_URL:-}" ]]; then
  echo "Using an explicit CAELON_PORTAL_URL override. Leave it unset to test the normal launch URL."
fi

pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin
node --test tests/*.test.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin

bundle_dir="src-tauri/target/aarch64-apple-darwin/release/bundle"
app_path="$(find "$bundle_dir/macos" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$app_path" ]]; then
  echo "Build returned without producing an .app bundle." >&2
  exit 1
fi
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")"
binary_path="$app_path/Contents/MacOS/$executable_name"
binary_arch="$(lipo -archs "$binary_path")"
if [[ "$binary_arch" != "arm64" ]]; then
  echo "Expected an ARM64 executable; found: $binary_arch" >&2
  exit 1
fi
dmg_path="$(find "$bundle_dir/dmg" -maxdepth 1 -name '*.dmg' -print -quit)"
if [[ -z "$dmg_path" ]]; then
  echo "Build returned without producing a .dmg." >&2
  exit 1
fi

echo "Automated tests and ARM64 bundle verification passed."
echo "App: $app_path"
echo "DMG: $dmg_path"
printf 'Launch for manual testing: open %q\n' "$app_path"
echo "Login, dock/menu behavior, icon appearance, permissions, and hidden notifications still require manual checks."
echo "Follow docs/desktop-validation.md and return the terminal log plus observed results."
