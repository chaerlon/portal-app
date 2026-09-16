// Pure selection logic for desktop notifications. No browser or Tauri APIs are
// touched here on purpose: this file is unit-tested under Node (see
// tests/notification_filter.test.mjs) and concatenated into the injected bridge
// at build time. Keep it dependency-free and side-effect-free.

// Portal's notification `type` vocabulary, observed from GET /api/notification:
//   task_assignee_changed | task_created | task_comment
//   task_status_changed   | task_overdue
//
// Only assignments are surfaced, matching Portal's own "Desktop notifications
// -- Task assignments from all your workspaces" setting.
var CAELON_ASSIGNED_TYPE = "task_assignee_changed";

// A backfill or a reconnect can return a large page at once. Showing every one
// would bury the desktop, so a single batch is capped and the remainder is still
// recorded as seen (it is visible in-app anyway).
var CAELON_MAX_PER_BATCH = 5;

/**
 * Decide which notifications deserve an OS popup.
 *
 * Mutates `seen` (a Set of notification ids) so the caller keeps one long-lived
 * dedupe set across fetches.
 *
 * @param {unknown} payload   Response body: an array, or `{ data: [...] }`.
 * @param {Set<string>} seen  Ids already accounted for.
 * @param {{primed?: boolean, maxPerBatch?: number}} opts
 *   `primed` is false only for the very first response of a session; that batch
 *   records ids without showing anything. Portal accumulates unread items
 *   indefinitely, so without this the first load would fire one popup per unread
 *   notification.
 * @returns {{show: Array<{id: string, title: string, body: string}>, primed: boolean}}
 */
function selectNotifications(payload, seen, opts) {
  var options = opts || {};
  var primed = options.primed === true;
  var cap =
    typeof options.maxPerBatch === "number"
      ? options.maxPerBatch
      : CAELON_MAX_PER_BATCH;

  var items = payload;
  if (items && !Array.isArray(items) && Array.isArray(items.data)) {
    items = items.data;
  }
  if (!Array.isArray(items)) {
    return { show: [], primed: primed };
  }

  var show = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || typeof item !== "object") continue;

    var id = item.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;

    // Record before any filtering, so an item we chose not to show can never
    // resurface later as "new".
    seen.add(id);

    if (!primed) continue;
    if (item.type !== CAELON_ASSIGNED_TYPE) continue;
    if (item.isRead === true) continue;
    if (show.length >= cap) continue;

    var eventData =
      item.eventData && typeof item.eventData === "object" ? item.eventData : {};
    var taskTitle =
      typeof eventData.taskTitle === "string" && eventData.taskTitle.length > 0
        ? eventData.taskTitle
        : null;

    // Portal sends `title` and `content` as null and composes display text on
    // the client, so the text is built here rather than read off the record.
    show.push({
      id: id,
      title: "Assigned to you",
      body: taskTitle || "A task was assigned to you",
    });
  }

  return { show: show, primed: true };
}
