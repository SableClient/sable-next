const COMMANDS: &[&str] = &[
    "push_history",
    "clear_push_history",
    "take_push_diagnostics",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
