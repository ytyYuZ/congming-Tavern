//! Binary entry point.
//!
//! Everything real lives in the library crate (`lib.rs`) because Tauri's mobile
//! targets link it and because a lib is the only thing `tests/` can reach.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    smarttavern_desktop_lib::run();
}
