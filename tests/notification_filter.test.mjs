// Tests for the pure notification-selection logic injected into the Portal page.
//
// The source file is plain browser script (no imports/exports) because it is
// concatenated into the injected bridge via include_str!. To test it we read it
// and evaluate it in an isolated function scope, which keeps the shipped file
// free of any module machinery that a webview would not understand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "..", "src-tauri", "src", "notification_filter.js"),
  "utf8",
);
const { selectNotifications } = new Function(
  `${src}\nreturn { selectNotifications };`,
)();

const ASSIGNED = "task_assignee_changed";

function notif(id, type = ASSIGNED, extra = {}) {
  return {
    id,
    type,
    isRead: false,
    eventData: { taskTitle: `Task ${id}`, workspaceId: "w1" },
    ...extra,
  };
}

test("first batch primes silently and shows nothing", () => {
  const seen = new Set();
  const out = selectNotifications([notif("a"), notif("b")], seen, {
    primed: false,
  });
  assert.deepEqual(out.show, []);
  assert.equal(out.primed, true);
  assert.deepEqual([...seen].sort(), ["a", "b"]);
});

test("priming prevents the 50-unread popup storm", () => {
  const seen = new Set();
  const backlog = Array.from({ length: 50 }, (_, i) => notif(`n${i}`));
  const out = selectNotifications(backlog, seen, { primed: false });
  assert.equal(out.show.length, 0);
  assert.equal(seen.size, 50);
});

test("a new assignment after priming is shown", () => {
  const seen = new Set(["a"]);
  const out = selectNotifications([notif("a"), notif("b")], seen, {
    primed: true,
  });
  assert.equal(out.show.length, 1);
  assert.equal(out.show[0].id, "b");
});

test("composes title and body, since Portal sends null title/content", () => {
  const seen = new Set();
  const item = notif("x");
  item.title = null;
  item.content = null;
  item.eventData.taskTitle = "Ship the thing";
  const out = selectNotifications([item], seen, { primed: true });
  assert.equal(out.show[0].title, "Assigned to you");
  assert.equal(out.show[0].body, "Ship the thing");
});

test("ignores non-assignment notification types", () => {
  const seen = new Set();
  const items = [
    notif("c1", "task_comment"),
    notif("c2", "task_created"),
    notif("c3", "task_status_changed"),
    notif("c4", "task_overdue"),
  ];
  const out = selectNotifications(items, seen, { primed: true });
  assert.deepEqual(out.show, []);
  // still marked seen, so flipping type later cannot resurface them
  assert.equal(seen.size, 4);
});

test("ignores already-read assignments", () => {
  const seen = new Set();
  const out = selectNotifications([notif("r", ASSIGNED, { isRead: true })], seen, {
    primed: true,
  });
  assert.deepEqual(out.show, []);
});

test("never shows the same id twice", () => {
  const seen = new Set();
  const first = selectNotifications([notif("a")], seen, { primed: true });
  const second = selectNotifications([notif("a")], seen, { primed: true });
  assert.equal(first.show.length, 1);
  assert.equal(second.show.length, 0);
});

test("caps a burst so a backfill cannot spam the OS", () => {
  const seen = new Set();
  const burst = Array.from({ length: 20 }, (_, i) => notif(`b${i}`));
  const out = selectNotifications(burst, seen, { primed: true, maxPerBatch: 3 });
  assert.equal(out.show.length, 3);
  // everything is still recorded as seen, so the remainder never reappears
  assert.equal(seen.size, 20);
});

test("tolerates malformed payloads without throwing", () => {
  const seen = new Set();
  const junk = [
    null,
    undefined,
    {},
    { id: "no-type" },
    { type: ASSIGNED },
    { id: "ok", type: ASSIGNED, isRead: false },
    "string",
    42,
  ];
  const out = selectNotifications(junk, seen, { primed: true });
  assert.equal(out.show.length, 1);
  assert.equal(out.show[0].id, "ok");
});

test("falls back to a generic body when taskTitle is missing", () => {
  const seen = new Set();
  const out = selectNotifications(
    [{ id: "z", type: ASSIGNED, isRead: false, eventData: {} }],
    seen,
    { primed: true },
  );
  assert.equal(out.show[0].body, "A task was assigned to you");
});

test("non-array input is handled", () => {
  const seen = new Set();
  for (const bad of [null, undefined, {}, "nope", 7]) {
    const out = selectNotifications(bad, seen, { primed: true });
    assert.deepEqual(out.show, []);
  }
});

test("payload wrapped in a data property is unwrapped", () => {
  const seen = new Set();
  const out = selectNotifications({ data: [notif("w")] }, seen, { primed: true });
  assert.equal(out.show.length, 1);
  assert.equal(out.show[0].id, "w");
});
