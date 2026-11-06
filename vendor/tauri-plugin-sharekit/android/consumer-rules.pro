# Consumer ProGuard / R8 rules for tauri-plugin-sharekit.
#
# Tauri's Android runtime dispatches via reflection:
#   - @TauriPlugin classes are instantiated by name
#   - @Command / @ActivityCallback methods are invoked by name on those instances
#   - @InvokeArg argument classes are deserialized via Jackson reflection
# Nothing in the consumer app statically references these members, so R8
# would strip them under release minification without these keep rules.

-keep @app.tauri.annotation.TauriPlugin class app.tauri.share.** { *; }
-keep @app.tauri.annotation.InvokeArg class app.tauri.share.** { *; }
