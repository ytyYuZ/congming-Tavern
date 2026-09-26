# apps/desktop/src-tauri

Placeholder for the Tauri 2 Rust shell (M0-T8).

`docs/02-技术架构.md` §3 defines `apps/desktop` as a thin Tauri 2 shell that
reuses the `apps/web` build output and adds native capability. That decision
(Tauri vs Electron, ADR-002) is not formally closed yet, so M0-T0 reserves the
directory only and does **not** add a Cargo workspace or any Rust code — CI has
no Rust toolchain step.

The repository root `.gitignore` already ignores `target/` and
`apps/desktop/src-tauri/target/`, so a later `cargo build` cannot pollute the
tree.
