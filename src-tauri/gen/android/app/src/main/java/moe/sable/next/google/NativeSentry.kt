package moe.sable.next

import android.content.Context
import android.util.Log
import io.sentry.Sentry
import io.sentry.android.core.SentryAndroid

object NativeSentry {
  fun apply(context: Context, enabled: Boolean) {
    runCatching {
      if (!enabled) {
        Sentry.close()
        return@runCatching
      }
      if (Sentry.isEnabled() || BuildConfig.SENTRY_DSN.isBlank()) return@runCatching
      SentryAndroid.init(context.applicationContext) { options ->
        options.dsn = BuildConfig.SENTRY_DSN
        options.environment = BuildConfig.SENTRY_ENVIRONMENT.ifBlank { null }
        options.release = BuildConfig.SENTRY_RELEASE.ifBlank { null }
        options.isSendDefaultPii = false
      }
    }.onFailure { error ->
      Log.e("SableSentry", "Sentry setup failed", error)
    }
  }
}
