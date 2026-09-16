// Execute the same concatenated browser scripts used by the Portal webview.
// Browser focus and native IPC are external boundaries; selection, permission
// flow, fetch interception, payload composition, and Response streams stay real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = ["notification_filter.js", "webview_bridge.js"]
  .map((name) => readFileSync(new URL(`../src-tauri/src/${name}`, import.meta.url), "utf8"))
  .join("\n");

function assignment(id, taskTitle = "Ship the release") {
  return {
    id,
    type: "task_assignee_changed",
    isRead: false,
    title: null,
    content: null,
    eventData: { taskTitle, workspaceId: "workspace-1" },
  };
}

function browser({ granted = true, requested = "granted", missingIPC = false, failCommand } = {}) {
  const commands = [];
  const requests = [];
  const responses = [];
  const reads = new Set();
  let focused = false;
  const window = {
    location: { assign() {} },
    fetch(...args) {
      requests.push({ receiver: this, args });
      const response = responses.shift();
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  if (!missingIPC) {
    window.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        // Copy across the VM boundary, as native IPC serializes its arguments.
        commands.push({ command, args: JSON.parse(JSON.stringify(args)) });
        if (command === failCommand) throw new Error("native IPC rejected");
        switch (command) {
          case "plugin:notification|is_permission_granted": return granted;
          case "plugin:notification|request_permission": return requested;
          case "plugin:notification|notify": return undefined;
          default: throw new Error(`Unexpected native command: ${command}`);
        }
      },
    };
  }
  runInNewContext(source, {
    window,
    document: { addEventListener() {}, hasFocus: () => focused },
  }, { filename: "portal-injected-notification-bridge.js" });

  function fetchResponse(response, input = "https://portal.example/api/notification", init) {
    if (response instanceof Response) {
      const clone = response.clone.bind(response);
      response.clone = function () {
        const copy = clone();
        const json = copy.json.bind(copy);
        copy.json = function () {
          const read = json();
          reads.add(read);
          read.then(() => reads.delete(read), () => reads.delete(read));
          return read;
        };
        return copy;
      };
    }
    responses.push(response);
    return window.fetch(input, init);
  }

  async function settle() {
    // A cloned Response body is streamed asynchronously. Await that actual
    // read, then let the bridge's permission/notify promise continuations run.
    await Promise.allSettled([...reads]);
    await new Promise(setImmediate);
  }

  async function receive(payload, input, init) {
    const original = Response.json(payload);
    const returned = await fetchResponse(original, input, init);
    await settle();
    return { original, returned };
  }

  return {
    commands, requests, receive, fetchResponse, settle,
    focus(value) { focused = value; },
    notifications() { return commands.filter(({ command }) => command === "plugin:notification|notify"); },
  };
}

const expectedRelease = {
  command: "plugin:notification|notify",
  args: { options: { title: "Assigned to you", body: "Ship the release" } },
};

test("initial unread backlog stays silent without requesting native permission", async () => {
  const page = browser();
  await page.receive(Array.from({ length: 50 }, (_, i) => assignment(`old-${i}`)));
  assert.deepEqual(page.commands, []);
});

test("new assignment sends the composed Portal payload to native notification IPC", async () => {
  const page = browser();
  await page.receive([assignment("old")]);
  await page.receive({ data: [assignment("old"), assignment("new")] });
  assert.deepEqual(page.commands, [
    { command: "plugin:notification|is_permission_granted", args: {} },
    expectedRelease,
  ]);
});

test("native notification gets a useful fallback when Portal has no task title", async () => {
  const page = browser();
  await page.receive([]);
  await page.receive([assignment("new", null)]);
  assert.deepEqual(page.notifications(), [{
    command: "plugin:notification|notify",
    args: { options: { title: "Assigned to you", body: "A task was assigned to you" } },
  }]);
});

test("repeated notification responses never resend an assignment", async () => {
  const page = browser();
  await page.receive([]);
  await page.receive([assignment("new")]);
  await page.receive([assignment("new"), assignment("new")]);
  assert.deepEqual(page.notifications(), [expectedRelease]);
});

test("focused assignments stay silent and do not reappear after focus is lost", async () => {
  const page = browser();
  await page.receive([]);
  page.focus(true);
  await page.receive([assignment("while-focused")]);
  assert.deepEqual(page.commands, []);
  page.focus(false);
  await page.receive([assignment("while-focused"), assignment("later")]);
  assert.deepEqual(page.notifications(), [expectedRelease]);
});

test("permission grant is requested before notifying and cached for later assignments", async () => {
  const page = browser({ granted: false, requested: "granted" });
  await page.receive([]);
  await page.receive([assignment("first")]);
  await page.receive([assignment("second")]);
  assert.deepEqual(page.commands, [
    { command: "plugin:notification|is_permission_granted", args: {} },
    { command: "plugin:notification|request_permission", args: {} },
    expectedRelease,
    expectedRelease,
  ]);
});

test("denied permission suppresses notifications and repeated permission prompts", async () => {
  const page = browser({ granted: false, requested: "denied" });
  await page.receive([]);
  await page.receive([assignment("first")]);
  await page.receive([assignment("second")]);
  assert.deepEqual(page.commands, [
    { command: "plugin:notification|is_permission_granted", args: {} },
    { command: "plugin:notification|request_permission", args: {} },
  ]);
});

test("an unresolved native permission prompt does not delay the page fetch", { timeout: 2000 }, async () => {
  let grant;
  const requested = new Promise((resolve) => { grant = resolve; });
  const page = browser({ granted: false, requested });
  await page.receive([]);
  const { returned } = await page.receive([assignment("first")]);
  assert.deepEqual(await returned.json(), [assignment("first")]);
  assert.deepEqual(page.notifications(), []);
  grant("granted");
  await page.settle();
  assert.deepEqual(page.notifications(), [expectedRelease]);
});

test("missing IPC leaves the original fetch response readable", async () => {
  const page = browser({ missingIPC: true });
  await page.receive([]);
  const { original, returned } = await page.receive([assignment("first")]);
  assert.equal(returned, original);
  assert.deepEqual(await returned.json(), [assignment("first")]);
  assert.deepEqual(page.commands, []);
});

for (const failCommand of ["plugin:notification|is_permission_granted", "plugin:notification|request_permission", "plugin:notification|notify"]) {
  test(`rejected ${failCommand} does not disturb the page response`, async () => {
    const page = browser({ granted: false, failCommand });
    await page.receive([]);
    const { original, returned } = await page.receive([assignment("first")]);
    assert.equal(returned, original);
    assert.equal(returned.bodyUsed, false);
    assert.deepEqual(await returned.json(), [assignment("first")]);
    assert.equal(page.commands.filter(({ command }) => command === failCommand).length, 1);
    if (failCommand !== "plugin:notification|notify") assert.deepEqual(page.notifications(), []);
  });
}

test("observing a cloned body preserves original response identity, status, headers and content", async () => {
  const page = browser();
  await page.receive([]);
  const original = new Response(JSON.stringify([assignment("first")]), {
    status: 202,
    headers: { "content-type": "application/json", "x-portal-request": "request-123" },
  });
  const returned = await page.fetchResponse(original);
  await page.settle();
  assert.equal(returned, original);
  assert.equal(returned.status, 202);
  assert.equal(returned.headers.get("x-portal-request"), "request-123");
  assert.equal(returned.bodyUsed, false);
  assert.deepEqual(await returned.json(), [assignment("first")]);
  assert.deepEqual(page.notifications(), [expectedRelease]);
});

for (const [label, input] of [
  ["URL string", "https://portal.example/api/notification?limit=10"],
  ["Request", new Request("https://portal.example/api/notification?limit=10")],
]) {
  test(`${label} notification requests are observed while preserving fetch arguments`, async () => {
    const page = browser();
    await page.receive([]);
    const init = { headers: { "x-portal-workspace": "workspace-1" }, cache: "no-store" };
    await page.receive([assignment("first")], input, init);
    assert.equal(page.requests[1].args[0], input);
    assert.equal(page.requests[1].args[1], init);
    assert.deepEqual(page.notifications(), [expectedRelease]);
  });
}

test("unrelated fetch responses cannot prime or trigger assignment notifications", async () => {
  const page = browser();
  const { returned } = await page.receive([assignment("unrelated")], "https://portal.example/api/tasks");
  assert.deepEqual(await returned.json(), [assignment("unrelated")]);
  await page.receive([assignment("old")]);
  assert.deepEqual(page.commands, []);
  await page.receive([assignment("new")]);
  assert.deepEqual(page.notifications(), [expectedRelease]);
});

test("malformed notification JSON does not break fetch or prematurely prime the session", async () => {
  const page = browser();
  const original = new Response("not JSON", { status: 502 });
  const returned = await page.fetchResponse(original);
  await page.settle();
  assert.equal(returned, original);
  assert.equal(await returned.text(), "not JSON");
  await page.receive([assignment("old")]);
  assert.deepEqual(page.commands, []);
  await page.receive([assignment("new")]);
  assert.deepEqual(page.notifications(), [expectedRelease]);
});

test("an unclonable response still reaches the caller without a bridge error", async () => {
  const page = browser();
  const original = Response.json([assignment("old")]);
  await original.json();
  const returned = await page.fetchResponse(original);
  await page.settle();
  assert.equal(returned, original);
  assert.deepEqual(page.commands, []);
});

test("the original network rejection propagates unchanged", async () => {
  const page = browser();
  const failure = new Error("Portal is offline");
  await assert.rejects(page.fetchResponse(failure), (error) => error === failure);
  assert.deepEqual(page.commands, []);
});
