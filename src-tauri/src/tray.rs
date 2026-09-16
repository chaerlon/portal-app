//! System tray icon (menu bar on macOS) and close-to-tray behaviour.
//!
//! The close button hides the window instead of destroying it, so the Portal
//! page keeps running: its WebSocket stays connected and task-assignment
//! notifications keep arriving while the app is out of sight. That makes
//! quitting an explicit act -- the tray menu's Quit item is the only path that
//! ends the process.
//!
//! Everything here runs in Rust. The tray grants the remote origin nothing: no
//! capability is involved, and the page has no way to observe or drive it.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, WebviewWindow, WindowEvent,
};

use crate::{WINDOW_LABEL, WINDOW_TITLE};

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "tray.show";
const MENU_QUIT: &str = "tray.quit";

/// What a left-click on the tray icon should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// Bring the window back: show, unminimize, focus.
    Reveal,
    /// Put the window away again.
    Hide,
}

/// How the menu-bar/tray icon should react to a primary click.
///
/// macOS convention is for the menu-bar item to open its menu. Windows keeps
/// the existing show/hide toggle so its notification-area behaviour is
/// unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayIconClickBehavior {
    OpenMenu,
    ToggleWindow,
}

/// Select the primary-click behaviour for a platform.
pub fn tray_icon_click_behavior(is_macos: bool) -> TrayIconClickBehavior {
    if is_macos {
        TrayIconClickBehavior::OpenMenu
    } else {
        TrayIconClickBehavior::ToggleWindow
    }
}

/// Decide what a left-click means for a window in the given state.
///
/// A minimized window counts as *not* shown, even though the platform still
/// reports it visible. Treating it as shown would make the click hide it,
/// leaving nothing on screen right after the user asked to see the app -- which
/// reads as a broken tray icon rather than as a toggle.
pub fn tray_click_action(visible: bool, minimized: bool) -> TrayAction {
    if visible && !minimized {
        TrayAction::Hide
    } else {
        TrayAction::Reveal
    }
}

/// Show, unminimize and focus the window.
///
/// The three steps are independent: a window manager can refuse one without the
/// others being wrong, and giving up halfway would strand the window in a state
/// the user cannot see. So each is attempted and reported separately. Order
/// matters -- `show` first, because unminimizing something still hidden does
/// nothing observable.
pub fn reveal<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(e) = window.show() {
        eprintln!("[tray] show failed: {e}");
    }
    if let Err(e) = window.unminimize() {
        eprintln!("[tray] unminimize failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        eprintln!("[tray] focus failed: {e}");
    }
}

/// Hide the window back to the tray.
pub fn hide<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(e) = window.hide() {
        eprintln!("[tray] hide failed: {e}");
    }
}

/// Apply the left-click toggle to a live window.
pub fn toggle<R: Runtime>(window: &WebviewWindow<R>) {
    // A query that fails is treated as "not in that state": the fallbacks bias
    // toward revealing, since showing a window the user did not ask for is a
    // far smaller annoyance than a tray icon that appears to do nothing.
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);

    match tray_click_action(visible, minimized) {
        TrayAction::Reveal => {
            println!("[tray] click -> reveal (visible={visible} minimized={minimized})");
            reveal(window);
        }
        TrayAction::Hide => {
            println!("[tray] click -> hide");
            hide(window);
        }
    }
}

/// Turn the window's close button into "hide to tray".
///
/// `prevent_close` keeps the window alive rather than merely re-showing it
/// later: destroying it would tear down the webview, dropping the Portal
/// session's WebSocket and the notification bridge with it.
pub fn hide_on_close<R: Runtime>(window: &WebviewWindow<R>) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            println!("[tray] close requested -> hiding to tray");
            hide(&handle);
        }
    });
}

/// Build the tray icon and its menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Show Caelon Portal", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let click_behavior = tray_icon_click_behavior(cfg!(target_os = "macos"));
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(WINDOW_TITLE)
        .menu(&menu)
        // macOS convention is for the menu-bar icon to open its menu. Windows
        // preserves the existing left-click show/hide toggle.
        .show_menu_on_left_click(matches!(click_behavior, TrayIconClickBehavior::OpenMenu))
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => {
                if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                    println!("[tray] menu -> show");
                    reveal(&window);
                }
            }
            MENU_QUIT => {
                println!("[tray] menu -> quit");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if matches!(click_behavior, TrayIconClickBehavior::ToggleWindow) {
                // A click reports both press and release; reacting to one of
                // them keeps a single Windows click from toggling twice.
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Some(window) = tray.app_handle().get_webview_window(WINDOW_LABEL) {
                        toggle(&window);
                    }
                }
            }
        });

    #[cfg(target_os = "macos")]
    {
        // `Image::from_bytes` requires Tauri's `image-png` feature, which is
        // explicitly enabled in Cargo.toml. Keeping the artwork in the binary
        // makes a missing file a build failure and a malformed image a visible
        // startup failure instead of silently falling back to the colour app
        // icon, which is unreadable as a menu-bar template.
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))
            .map_err(|e| {
                eprintln!("[tray] failed to load macOS template icon: {e}");
                e
            })?;
        builder = builder.icon(icon).icon_as_template(true);
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Other platforms continue to use the bundled application icon.
        match app.default_window_icon() {
            Some(icon) => builder = builder.icon(icon.clone()),
            None => eprintln!("[tray] no default window icon; the tray entry will be blank"),
        }
    }

    let tray = builder.build(app)?;

    // `build` succeeding does not mean the shell took the icon: on Windows the
    // underlying crate deliberately swallows a failed registration so it can
    // retry when Explorer announces TaskbarCreated. The rect is the shell's own
    // answer -- `Some` means the icon really is in the notification area, `None`
    // means it is not there (yet), which is worth seeing rather than guessing.
    println!(
        "[tray] ready id={:?} rect={:?}",
        tray.id(),
        tray.rect().ok().flatten()
    );

    Ok(())
}

/// Opt-in diagnostic: drives hide/reveal directly and reports what the window
/// says about itself at each step.
///
/// Why it exists: the tray's real triggers are mouse clicks on an OS-owned icon
/// that nothing outside the app can observe, and that cannot be synthesised on
/// a live desktop without clicking at real screen coordinates. This exercises
/// the same helpers those click handlers call, so a broken show/hide path is
/// caught without a human at the keyboard. Unset in every normal run.
///
/// Setting the variable to `quit` additionally runs the Quit menu item's body
/// (`AppHandle::exit`) once the cycle is done, so that path can be observed
/// from outside as the process going away.
pub fn spawn_selftest<R: Runtime>(window: &WebviewWindow<R>, and_quit: bool) {
    let window = window.clone();
    let app = window.app_handle().clone();

    std::thread::spawn(move || {
        use std::thread::sleep;
        use std::time::Duration;

        let state = |label: &str| -> (bool, bool) {
            let visible = window.is_visible().unwrap_or(false);
            let minimized = window.is_minimized().unwrap_or(false);
            println!("[tray-selftest] {label} visible={visible} minimized={minimized}");
            (visible, minimized)
        };

        // Let the window finish coming up before measuring anything.
        sleep(Duration::from_secs(3));
        let (start_visible, _) = state("initial");

        hide(&window);
        sleep(Duration::from_millis(800));
        let (after_hide, _) = state("after hide");

        reveal(&window);
        sleep(Duration::from_millis(800));
        let (after_reveal, _) = state("after reveal");

        let ok = start_visible && !after_hide && after_reveal;
        println!(
            "[tray-selftest] result={} (start={start_visible} hidden={} shown={after_reveal})",
            if ok { "ok" } else { "fail" },
            !after_hide
        );

        if and_quit {
            println!("[tray-selftest] exercising quit");
            app.exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_macos_menu_bar_click_opens_the_menu_without_toggling_the_window() {
        assert_eq!(
            tray_icon_click_behavior(true),
            TrayIconClickBehavior::OpenMenu
        );
    }

    #[test]
    fn a_windows_notification_area_click_keeps_the_window_toggle() {
        assert_eq!(
            tray_icon_click_behavior(false),
            TrayIconClickBehavior::ToggleWindow
        );
    }

    #[test]
    fn a_shown_window_is_hidden() {
        assert_eq!(tray_click_action(true, false), TrayAction::Hide);
    }

    #[test]
    fn a_hidden_window_is_revealed() {
        assert_eq!(tray_click_action(false, false), TrayAction::Reveal);
    }

    #[test]
    fn a_minimized_window_is_revealed_rather_than_hidden() {
        // The regression this guards: platforms report a minimized window as
        // visible, so a naive toggle would hide it and leave the user with
        // nothing after they clicked to see the app.
        assert_eq!(tray_click_action(true, true), TrayAction::Reveal);
    }

    #[test]
    fn a_hidden_and_minimized_window_is_revealed() {
        assert_eq!(tray_click_action(false, true), TrayAction::Reveal);
    }
}
