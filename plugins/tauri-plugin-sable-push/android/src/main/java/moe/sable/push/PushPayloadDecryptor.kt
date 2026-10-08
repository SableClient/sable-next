package moe.sable.push

import android.content.Context
import android.util.Log

internal sealed interface PushDecryptResult {
    data class Success(val clearEventJson: String) : PushDecryptResult
    object Discard : PushDecryptResult
    data class NeedsKey(val quietly: Boolean) : PushDecryptResult
    data class Failure(val outcome: PushOutcome) : PushDecryptResult
}

internal object PushPayloadDecryptor {
    private const val TAG = "PushPayloadDecryptor"

    private const val HOST_LIBRARY = "app_lib"
    private const val DISCARD = "discard"
    private const val NEEDS_KEY = "needs-key"
    private const val NEEDS_KEY_QUIETLY = "needs-key-quietly"

    private var loaded: Boolean? = null

    private external fun nativeMaintainPush(storeDir: String, operation: String): String?

    fun maintain(context: Context, operation: String): Boolean =
        available() && runCatching { nativeMaintainPush(context.filesDir.absolutePath, operation) == "ok" }.getOrDefault(false)

    private external fun nativeDecryptPush(
        storeDir: String,
        userId: String,
        deviceId: String,
        roomId: String,
        eventJson: String,
    ): String?

    private external fun nativeDecryptPushLocally(
        storeDir: String,
        userId: String,
        deviceId: String,
        roomId: String,
        eventJson: String,
    ): String?

    private external fun nativeFetchPush(
        storeDir: String,
        userId: String,
        deviceId: String,
        roomId: String,
        eventId: String,
    ): String?

    fun fetch(
        context: Context,
        userId: String,
        deviceId: String,
        roomId: String,
        eventId: String,
    ): PushDecryptResult = run(context) { storeDir ->
        nativeFetchPush(storeDir, userId, deviceId, roomId, eventId)
    }

    private fun available(): Boolean {
        loaded?.let { return it }

        val result = try {
            System.loadLibrary(HOST_LIBRARY)
            true
        } catch (error: UnsatisfiedLinkError) {
            Log.i(TAG, "No native decryptor in this build: ${error.message}")
            false
        }
        loaded = result
        return result
    }

    fun decrypt(
        context: Context,
        userId: String,
        deviceId: String,
        roomId: String,
        eventJson: String,
    ): PushDecryptResult = run(context) { storeDir ->
        nativeDecryptPush(storeDir, userId, deviceId, roomId, eventJson)
    }

    fun decryptLocally(
        context: Context,
        userId: String,
        deviceId: String,
        roomId: String,
        eventJson: String,
    ): PushDecryptResult = run(context) { storeDir ->
        nativeDecryptPushLocally(storeDir, userId, deviceId, roomId, eventJson)
    }

    private fun run(context: Context, native: (String) -> String?): PushDecryptResult {
        if (!available()) return PushDecryptResult.Failure(PushOutcome.NO_NATIVE_LIB)

        val clear = try {
            native(context.dataDir.absolutePath)
        } catch (error: Throwable) {
            Log.i(TAG, "Push payload not decryptable: ${error.message}")
            null
        }

        return when (clear) {
            null, "" -> PushDecryptResult.Failure(PushOutcome.DECRYPT_FAILED)
            DISCARD -> PushDecryptResult.Discard
            NEEDS_KEY -> PushDecryptResult.NeedsKey(quietly = false)
            NEEDS_KEY_QUIETLY -> PushDecryptResult.NeedsKey(quietly = true)
            else -> PushDecryptResult.Success(clear)
        }
    }
}
