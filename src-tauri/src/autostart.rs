//! "Start at login" wiring for the desktop shell.
//!
//! Notifications only arrive while the process is running, so a machine that
//! has just rebooted delivers nothing until the user remembers to launch the
//! app. Registering a login item closes that gap.
//!
//! The login item is *defaulted* on rather than forced on: the first run turns
//! it on and records that it did so, and from then on whatever the user chose
//! in the tray menu stands. Without the marker file, a user who turned it off
//! would find it switched back on at every launch.
//!
//! Everything here runs in Rust and is driven from the tray menu. The remote
//! Portal origin cannot reach any of it: `capabilities/default.json` carries the
//! autostart permissions and has no `remote` field, so the hosted page has no
//! path to these commands.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// Name of the file that records "the first-run default has been applied".
///
/// Its presence is the whole state; the contents are a human-readable note for
/// anyone who stumbles across it.
const MARKER_FILE: &str = "autostart-defaulted";

/// What should happen to the login item during startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupAction {
    /// Turn the login item on, because this is the first run and nobody has
    /// expressed a preference yet.
    EnableAsDefault,
    /// Leave the login item exactly as it is.
    LeaveAsIs,
}

/// Decide whether startup should install the login item.
///
/// `default_applied` is whether a previous run already made this decision, and
/// `currently_enabled` is what the OS reports right now. Both are needed:
/// without the first the default would fight the user's choice on every launch,
/// and without the second a fresh marker-less profile on a machine that already
/// has the login item would perform a pointless re-registration.
pub fn startup_action(default_applied: bool, currently_enabled: bool) -> StartupAction {
    if default_applied || currently_enabled {
        StartupAction::LeaveAsIs
    } else {
        StartupAction::EnableAsDefault
    }
}

/// The state the login item should move to when the menu item is clicked.
///
/// Deliberately a function of the *observed* state rather than of a remembered
/// one: the login item can be removed behind the app's back (Task Manager's
/// Startup tab, System Settings > Login Items), and a toggle computed from a
/// stale local flag would then move it the wrong way.
pub fn toggled(currently_enabled: bool) -> bool {
    !currently_enabled
}

/// Ask the OS whether the login item is currently registered.
///
/// A failed query reports `false`. That biases the tray checkmark toward
/// "off", which is the honest answer when the app cannot confirm the item
/// exists, and it keeps a broken query from showing a tick for something that
/// may not be there.
pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(e) => {
            eprintln!("[autostart] could not read login item state: {e}");
            false
        }
    }
}

/// Register or unregister the login item, reporting failure rather than
/// panicking. Returns whether the change went through.
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> bool {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };

    match result {
        Ok(()) => {
            println!("[autostart] login item enabled={enabled}");
            true
        }
        Err(e) => {
            eprintln!("[autostart] failed to set login item enabled={enabled}: {e}");
            false
        }
    }
}

/// Where the "default already applied" marker lives.
fn marker_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(MARKER_FILE)),
        Err(e) => {
            eprintln!("[autostart] no app config dir, cannot record first-run default: {e}");
            None
        }
    }
}

/// Turn the login item on the first time the app runs, then never again.
///
/// If the marker cannot be written the default is still applied, but the run is
/// treated as not-first next time only if the marker happens to exist -- i.e.
/// the failure mode is "the default is re-applied", not "the app crashes".
pub fn apply_first_run_default<R: Runtime>(app: &AppHandle<R>) {
    let marker = marker_path(app);
    let default_applied = marker.as_ref().is_some_and(|p| p.exists());

    match startup_action(default_applied, is_enabled(app)) {
        StartupAction::EnableAsDefault => {
            println!("[autostart] first run -> enabling login item by default");
            set_enabled(app, true);
        }
        StartupAction::LeaveAsIs => {
            println!("[autostart] login item left as-is (default_applied={default_applied})");
        }
    }

    // Written in both branches: the point of the marker is "this app has had
    // its say", not "this app switched something on".
    if let Some(path) = marker {
        if !path.exists() {
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    eprintln!("[autostart] could not create {}: {e}", parent.display());
                    return;
                }
            }
            if let Err(e) = std::fs::write(
                &path,
                "Caelon Portal has applied its first-run 'Start at login' default.\n\
                 Delete this file to have the default applied again.\n",
            ) {
                eprintln!("[autostart] could not write {}: {e}", path.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_run_enables_the_login_item() {
        assert_eq!(startup_action(false, false), StartupAction::EnableAsDefault);
    }

    #[test]
    fn a_user_who_turned_it_off_is_not_overridden_on_the_next_launch() {
        // The regression this guards: without the marker, every launch would
        // re-apply the default and silently undo the user's choice.
        assert_eq!(startup_action(true, false), StartupAction::LeaveAsIs);
    }

    #[test]
    fn an_already_registered_login_item_is_not_re_registered() {
        assert_eq!(startup_action(false, true), StartupAction::LeaveAsIs);
    }

    #[test]
    fn a_still_enabled_login_item_on_a_later_launch_is_left_alone() {
        assert_eq!(startup_action(true, true), StartupAction::LeaveAsIs);
    }

    #[test]
    fn toggling_an_enabled_login_item_turns_it_off() {
        assert!(!toggled(true));
    }

    #[test]
    fn toggling_a_disabled_login_item_turns_it_on() {
        assert!(toggled(false));
    }
}
