//! Tauri's build script.
//!
//! It reads `tauri.conf.json`, generates the capability/permission glue Tauri 2
//! needs, and embeds the app metadata — so it must run before anything that
//! touches the config, and it must fail loudly when the config is malformed.
fn main() {
    tauri_build::build();
}
