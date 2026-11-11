const COMMANDS: &[&str] = &[
    "play_chime",
    "push_history",
    "clear_push_history",
    "take_push_diagnostics",
    "check_permissions",
    "request_permissions",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
