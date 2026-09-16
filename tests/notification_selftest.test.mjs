// The diagnostic is injected on every top-level page; only the configured
// Portal origin is permitted to run its native notification probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src-tauri/src/notify_selftest.js", import.meta.url), "utf8");

function page({ origin = "https://portal.caelonhq.com", portalOrigin = "https://portal.caelonhq.com", search = "?error=account_not_linked", failCommand, missingIPC = false, granted = true, permission = "granted" } = {}) {
  const commands = [];
  const navigations = [];
  const timers = [];
  const window = {
    location: { origin, search, assign(url) { navigations.push(url); } },
  };
  if (!missingIPC) {
    window.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        commands.push({ command, args: args ? JSON.parse(JSON.stringify(args)) : undefined });
        if (command === failCommand) throw new Error("native IPC rejected");
        switch (command) {
          case "plugin:notification|is_permission_granted": return granted;
          case "plugin:notification|request_permission": return permission;
          case "plugin:notification|notify": return undefined;
          default: throw new Error(`Unexpected native command: ${command}`);
        }
      },
    };
  }
  // Match the Rust injection's lexical origin argument without adding a
  // writable origin property or granting Authentik native notification IPC.
  runInNewContext(`(function (portalOrigin) {\n${source}\n})(${JSON.stringify(portalOrigin)});`, {
    window,
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  });
  async function runTimers() {
    for (const { callback } of timers.splice(0)) callback();
    await new Promise(setImmediate);
  }
  return { commands, navigations, timers, runTimers };
}

test("configured Portal probe reports accepted notification IPC at the same-origin sentinel", async () => {
  const portal = page();
  assert.equal(portal.timers.length, 1);
  await portal.runTimers();
  assert.deepEqual(portal.commands, [
    { command: "plugin:notification|is_permission_granted", args: undefined },
    { command: "plugin:notification|notify", args: { options: { title: "Caelon Portal", body: "Notification self-test succeeded." } } },
  ]);
  assert.deepEqual(portal.navigations, ["https://portal.caelonhq.com/?caelon_selftest=ok"]);
});

test("OIDC auth pages never schedule the probe, invoke IPC, or report a conflicting sentinel", async () => {
  const auth = page({ origin: "https://auth.caelonhq.com" });
  assert.equal(auth.timers.length, 0);
  await auth.runTimers();
  assert.deepEqual(auth.commands, []);
  assert.deepEqual(auth.navigations, []);
});

test("origin restriction follows the configured Portal origin including scheme and port", async () => {
  for (const origin of ["https://portal.caelonhq.com", "http://portal.staging.example:8443", "https://portal.staging.example"]) {
    const other = page({ origin, portalOrigin: "https://portal.staging.example:8443" });
    await other.runTimers();
    assert.deepEqual(other.commands, []);
    assert.deepEqual(other.navigations, []);
  }
  const configured = page({ origin: "https://portal.staging.example:8443", portalOrigin: "https://portal.staging.example:8443" });
  await configured.runTimers();
  assert.deepEqual(configured.navigations, ["https://portal.staging.example:8443/?caelon_selftest=ok"]);
});

test("a Portal IPC failure remains an observable error rather than being hidden by origin restriction", async () => {
  const portal = page({ failCommand: "plugin:notification|notify" });
  await portal.runTimers();
  assert.deepEqual(portal.navigations, ["https://portal.caelonhq.com/?caelon_selftest=error&detail=native%20IPC%20rejected"]);
});

test("missing Portal IPC and denied permissions retain explicit diagnostic outcomes", async () => {
  const missing = page({ missingIPC: true });
  await missing.runTimers();
  assert.deepEqual(missing.navigations, ["https://portal.caelonhq.com/?caelon_selftest=no-ipc&detail=__TAURI_INTERNALS__%20missing%20on%20this%20origin"]);
  const denied = page({ granted: false, permission: "denied" });
  await denied.runTimers();
  assert.deepEqual(denied.commands.map(({ command }) => command), ["plugin:notification|is_permission_granted", "plugin:notification|request_permission"]);
  assert.deepEqual(denied.navigations, ["https://portal.caelonhq.com/?caelon_selftest=denied&detail=denied"]);
});

test("Portal result pages do not repeat the native diagnostic request", async () => {
  const result = page({ search: "?caelon_selftest=ok" });
  await result.runTimers();
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.navigations, []);
});
