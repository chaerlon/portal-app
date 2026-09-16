// Diagnostic, appended to the injected bridge ONLY when CAELON_NOTIFY_SELFTEST
// is set in the environment. Never present in a normal run.
//
// Why it exists: the notification path depends on the remote Portal origin being
// able to reach the IPC bridge (see capabilities/portal-notifications.json).
// If that grant is misconfigured, nothing throws anywhere visible -- the app
// looks healthy and notifications simply never appear. Proving the path end to
// end otherwise requires a signed-in session plus a real task assignment.
//
// This fires one notification and then reports the outcome by navigating to a
// sentinel URL, because the Rust `on_navigation` hook is the one channel whose
// output is observable from outside the webview. The navigation is the point;
// it is how the result escapes the page.
(function () {
  "use strict";

  function report(status, detail) {
    var url =
      window.location.origin +
      "/?caelon_selftest=" +
      encodeURIComponent(status) +
      (detail ? "&detail=" + encodeURIComponent(String(detail).slice(0, 80)) : "");
    window.location.assign(url);
  }

  function run() {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      report("no-ipc", "__TAURI_INTERNALS__ missing on this origin");
      return;
    }

    internals
      .invoke("plugin:notification|is_permission_granted")
      .then(function (granted) {
        if (granted === true) return "granted";
        return internals.invoke("plugin:notification|request_permission");
      })
      .then(function (result) {
        if (!(result === "granted" || result === true)) {
          report("denied", result);
          return;
        }
        return internals
          .invoke("plugin:notification|notify", {
            options: {
              title: "Caelon Portal",
              body: "Notification self-test succeeded.",
            },
          })
          .then(function () {
            report("ok");
          });
      })
      .catch(function (err) {
        report("error", err && err.message ? err.message : err);
      });
  }

  // Only run on a page that is not already a self-test result, so the sentinel
  // navigation cannot loop.
  if (window.location.search.indexOf("caelon_selftest=") === -1) {
    setTimeout(run, 1500);
  }
})();
