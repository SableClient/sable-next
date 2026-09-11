const COMMANDS: &[&str] = &[
    "get_safe_area_insets",
    "get_keyboard_info",
    "enable",
    "disable",
    "show_keyboard",
    "hide_keyboard"
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
