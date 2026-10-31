package moe.sable.push

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.annotation.Keep
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Keep
object Secrets {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "sable-secrets"
    private const val PREFERENCES = "sable-secrets"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_SIZE = 12
    private const val TAG_BITS = 128

    @JvmStatic private external fun nativeInstall(context: Context)

    /** Loads the native library itself, so it can run before any activity does. */
    fun install(context: Context) {
        System.loadLibrary("app_lib")
        nativeInstall(context.applicationContext)
    }

    @JvmStatic
    @Synchronized
    fun get(context: Context, name: String): ByteArray? {
        val preferences = preferences(context)
        val sealed = preferences.getString(name, null) ?: return null
        // Restored from a backup onto another device, whose Keystore never held the key.
        val key = existingKey() ?: run {
            preferences.edit().clear().commit()
            return null
        }
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, bytes, 0, IV_SIZE))
        return cipher.doFinal(bytes, IV_SIZE, bytes.size - IV_SIZE)
    }

    @JvmStatic
    @Synchronized
    fun set(context: Context, name: String, secret: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: createKey())
        val sealed = cipher.iv + cipher.doFinal(secret)
        check(preferences(context).edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
            "could not save a secret"
        }
    }

    @JvmStatic
    @Synchronized
    fun delete(context: Context, name: String) {
        check(preferences(context).edit().remove(name).commit()) { "could not delete a secret" }
    }

    private fun preferences(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun existingKey(): SecretKey? =
        (KeyStore.getInstance(KEYSTORE).apply { load(null) }.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

    private fun createKey(): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
}
