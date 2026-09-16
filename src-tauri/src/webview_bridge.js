// Injected into every page load in the Portal webview.
//
// Purpose: funnel "open in a new window" gestures back into ordinary top-level
// navigations so the Rust `on_navigation` policy is the single place that
// decides in-app vs. system-browser vs. blocked.
//
// This exists specifically so we do NOT need IPC. A `window.open` handled in JS
// would otherwise need to call a Rust command, which would mean granting the
// remote Portal origin access to the IPC bridge. Rewriting to a normal
// navigation keeps that attack surface at zero.
(function () {
  "use strict";

  // `window.open(url, ...)` -> top-level navigation.
  // Returns null, matching a popup-blocked browser. Callers that chain off the
  // return value (e.g. `w.document.write(...)`) would break, but Portal uses
  // window.open only for outbound links.
  window.open = function (url) {
    if (url) {
      window.location.assign(String(url));
    }
    return null;
  };

  // Anchors with target="_blank" (or any non-self target) -> same-window nav.
  // Capture phase so we run before the app's own click handlers.
  document.addEventListener(
    "click",
    function (event) {
      var node = event.target;

      // event.target can be a text node or the document itself; walk up to the
      // nearest Element before using .closest().
      while (node && node.nodeType !== 1) {
        node = node.parentNode;
      }
      if (!node || typeof node.closest !== "function") {
        return;
      }

      var anchor = node.closest("a[target]");
      if (!anchor) {
        return;
      }

      var target = anchor.getAttribute("target");
      if (target === "_self" || target === "" || target === null) {
        return;
      }

      // .href is the resolved absolute URL; skip empty and in-page anchors.
      var href = anchor.href;
      if (!href || href.charAt(0) === "#") {
        return;
      }

      event.preventDefault();
      window.location.assign(href);
    },
    true
  );
})();

// ---------------------------------------------------------------------------
// Desktop notifications for task assignments.
//
// Portal's own notification path is Web Push (/push-sw.js + VAPID), which does
// not exist in WKWebView or WebView2 -- its settings page reports "Off for this
// browser" inside the app for exactly that reason. So instead of pushing, we
// observe: Portal already refetches its notification list whenever the realtime
// socket delivers {"type":"NOTIFICATION_CREATED"}, and we read that response.
//
// Watching fetch responses rather than the socket means we never have to know
// the REST path, and we get the fully-formed records instead of a bare signal.
//
// Unlike the navigation shim above, this DOES require IPC: see
// capabilities/portal-notifications.json, which grants this origin the
// notification permission and nothing else.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  var seen = new Set();
  var primed = false;
  var permission = null; // null = unknown, true/false once resolved

  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("IPC unavailable"));
    }
    return internals.invoke(cmd, args || {});
  }

  // Resolved once and cached. macOS requires an explicit grant; Windows does
  // not, but the plugin answers the same way on both.
  function ensurePermission() {
    if (permission !== null) {
      return Promise.resolve(permission);
    }
    return invoke("plugin:notification|is_permission_granted")
      .then(function (granted) {
        if (granted === true) return "granted";
        return invoke("plugin:notification|request_permission");
      })
      .then(function (result) {
        permission = result === "granted" || result === true;
        return permission;
      })
      .catch(function () {
        permission = false;
        return false;
      });
  }

  function show(entry) {
    return invoke("plugin:notification|notify", {
      options: { title: entry.title, body: entry.body },
    }).catch(function () {
      /* a failed notification must never disturb the page */
    });
  }

  function handlePayload(payload) {
    var result = selectNotifications(payload, seen, { primed: primed });
    primed = result.primed;
    if (result.show.length === 0) {
      return;
    }
    // Don't interrupt someone who is already looking at the app.
    if (typeof document.hasFocus === "function" && document.hasFocus()) {
      return;
    }
    ensurePermission().then(function (granted) {
      if (!granted) return;
      for (var i = 0; i < result.show.length; i++) {
        show(result.show[i]);
      }
    });
  }

  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url;
    } catch (e) {
      /* ignore */
    }
    return "";
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }

  window.fetch = function (input, init) {
    var response = originalFetch.apply(this, arguments);

    try {
      var url = urlOf(input);
      if (url && url.indexOf("notification") !== -1) {
        response = response.then(function (res) {
          try {
            // clone() so the app still gets an unread body.
            res
              .clone()
              .json()
              .then(handlePayload)
              .catch(function () {});
          } catch (e) {
            /* ignore */
          }
          return res;
        });
      }
    } catch (e) {
      /* never let instrumentation break a real request */
    }

    return response;
  };
})();
