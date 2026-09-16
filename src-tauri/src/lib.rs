//! Caelon Portal desktop shell.
//!
//! A deliberately thin Tauri wrapper around the hosted Portal web app. It owns
//! exactly one window plus a tray icon, points the window at the Portal origin,
//! and enforces a navigation policy. It exposes no custom commands of its own.

mod navigation;
mod tray;

use navigation::{Decision, Policy};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// The start URL for the main window.
///
/// This is a full URL, not just an origin: the path is where the window lands
/// on launch, and the host is derived from it for the navigation allowlist (see
/// `run`), so the two can never drift apart.
///
/// Points at the sign-in route rather than `/` so the app opens directly on
/// sign-in.
///
/// The `?error=` query string is load-bearing, not a copy/paste artifact: a bare
/// `/auth/sign-in` immediately auto-starts the OIDC flow and bounces the window
/// to Authentik, so Portal's own sign-in UI never renders. The error parameter
/// makes that page render and stay put. If Portal's sign-in route ever stops
/// auto-redirecting, this can go back to a bare path.
///
/// Baked in at compile time. Override for a staging/self-hosted deployment:
///   CAELON_PORTAL_URL=https://portal.staging.example.com/auth/sign-in pnpm tauri build
/// `build.rs` declares a `rerun-if-env-changed` on this so the value is not
/// silently cached across builds.
const DEFAULT_PORTAL_URL: &str =
    "https://portal.caelonhq.com/auth/sign-in?error=account_not_linked";

/// Extra hosts that may be navigated to in-app, comma-separated.
///
/// Portal delegates sign-in to Authentik on a separate host, so the OIDC
/// `/application/o/authorize/` hop must be allowed in-app. If it is not, the
/// redirect is punted to the system browser and the session never returns to
/// the app -- login appears to do nothing. Override alongside the Portal URL
/// when pointing at a different deployment:
///   CAELON_AUTH_HOSTS=auth.staging.example.com
const DEFAULT_AUTH_HOSTS: &str = "auth.caelonhq.com";

const PORTAL_URL: &str = match option_env!("CAELON_PORTAL_URL") {
    Some(url) => url,
    None => DEFAULT_PORTAL_URL,
};

const AUTH_HOSTS: &str = match option_env!("CAELON_AUTH_HOSTS") {
    Some(hosts) => hosts,
    None => DEFAULT_AUTH_HOSTS,
};

/// Opt-in diagnostic appended to the bridge; see the file for why it exists.
const NOTIFY_SELFTEST: &str = include_str!("notify_selftest.js");

/// Injected on every page load.
///
/// The pure selection logic is kept in its own file so it can be unit-tested
/// under Node (`tests/notification_filter.test.mjs`); it is prepended here so
/// the page receives one script with no module loading involved.
const WEBVIEW_BRIDGE: &str = concat!(
    include_str!("notification_filter.js"),
    "
",
    include_str!("webview_bridge.js")
);

pub(crate) const WINDOW_LABEL: &str = "main";
pub(crate) const WINDOW_TITLE: &str = "Caelon Portal";

pub fn run() {
    let portal_url = tauri::Url::parse(PORTAL_URL)
        .unwrap_or_else(|e| panic!("CAELON_PORTAL_URL is not a valid URL ({PORTAL_URL:?}): {e}"));

    // The Portal host is derived from the URL rather than configured
    // separately, so the allowlist can never drift out of sync with the page
    // actually being loaded.
    let portal_host = portal_url
        .host_str()
        .unwrap_or_else(|| panic!("CAELON_PORTAL_URL has no host: {PORTAL_URL:?}"))
        .to_owned();

    let mut hosts = vec![portal_host];
    hosts.extend(AUTH_HOSTS.split(',').map(|h| h.trim().to_owned()));

    let policy = Policy::new(hosts);

    println!(
        "[portal] url={portal_url} trusted_hosts={:?}",
        policy.allowed_hosts()
    );

    // CAELON_NOTIFY_SELFTEST is a diagnostic escape hatch, not a feature: it
    // appends a probe that proves the remote origin can actually reach the
    // notification IPC. Unset in every normal run.
    let mut bridge = WEBVIEW_BRIDGE.to_string();
    if std::env::var_os("CAELON_NOTIFY_SELFTEST").is_some() {
        bridge.push_str(NOTIFY_SELFTEST);
        println!("[notify] self-test probe enabled");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let policy = policy.clone();

            let window = WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                WebviewUrl::External(portal_url.clone()),
            )
            .title(WINDOW_TITLE)
            .inner_size(1280.0, 832.0)
            .min_inner_size(900.0, 600.0)
            .resizable(true)
            .initialization_script(&bridge)
            .on_navigation(move |url| match policy.decide(url) {
                Decision::Allow => {
                    println!("[nav] allow {url}");
                    true
                }
                Decision::OpenExternally => {
                    println!("[nav] external {url}");
                    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
                        eprintln!("[nav] failed to open {url} in system browser: {e}");
                    }
                    false
                }
                Decision::Block => {
                    println!("[nav] block {url}");
                    false
                }
            })
            .build()?;

            // Close hides rather than quits, so the page keeps running and
            // notifications keep arriving; the tray is then the only way back
            // to the window, and the only way out of the app.
            tray::hide_on_close(&window);
            tray::build(app.handle())?;

            if let Some(mode) = std::env::var_os("CAELON_TRAY_SELFTEST") {
                let and_quit = mode == *"quit";
                println!("[tray] self-test probe enabled (quit={and_quit})");
                tray::spawn_selftest(&window, and_quit);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Caelon Portal");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            match app.get_webview_window(WINDOW_LABEL) {
                Some(window) => {
                    println!(
                        "[lifecycle] macOS reopen -> reveal (has_visible_windows={has_visible_windows})"
                    );
                    // Reusing the existing window preserves the Portal session
                    // and avoids creating a second webview or login flow.
                    tray::reveal(&window);
                }
                None => eprintln!(
                    "[lifecycle] macOS reopen ignored: existing {WINDOW_LABEL:?} window was not found"
                ),
            }
        }

        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
