package moe.sable.push

import android.app.Activity
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

@TauriPlugin
class SablePushPlugin(activity: Activity) : Plugin(activity)
