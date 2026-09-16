fn main() {
    // The Portal URL is baked in at compile time via `option_env!`, so Cargo
    // must rebuild when it changes. Without this the constant silently keeps
    // whatever value was set on the first build.
    println!("cargo:rerun-if-env-changed=CAELON_PORTAL_URL");
    tauri_build::build()
}
