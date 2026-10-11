package gg.pixelkingdomwars.nativeclient.network

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface SecretStore { fun read(): String?; fun write(value: String); fun clear() }
class SecretStorageException : IOException("Encrypted device storage is unavailable. Retry after unlocking the device. Saved requests have been retained.")

/** Presence only: never read/decrypt bytes or consult/create a Keystore key. */
internal fun encryptedStoreHasData(file: File): Boolean = try {
    Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    true
} catch (_: NoSuchFileException) { false }
catch (_: Exception) { throw SecretStorageException() }

/** Device-bound credentials live outside Android backup; ciphertext never enters logs. */
class EncryptedStore(context: Context, private val name: String) : SecretStore {
    private val file = File(context.noBackupFilesDir, "$name.enc")
    private val alias = "pkw.native.$name"
    @Synchronized fun hasStoredData(): Boolean = encryptedStoreHasData(file)
    private fun key(create: Boolean = true): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) throw SecretStorageException()
        return KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized override fun read(): String? {
        val bytes = try { Files.readAllBytes(file.toPath()) }
        catch (_: NoSuchFileException) { return null }
        catch (_: Exception) { throw SecretStorageException() }
        return try {
            require(bytes.size >= 29)
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
            }
        } catch (_: Exception) { throw SecretStorageException() }
    }
    @Synchronized override fun write(value: String) {
        val temp = File(file.parentFile, "${file.name}.tmp")
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            temp.outputStream().use { it.write(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))); it.flush(); it.fd.sync() }
            check(temp.renameTo(file))
        } catch (_: Exception) { temp.delete(); throw SecretStorageException() }
    }
    @Synchronized override fun clear() {
        try { Files.deleteIfExists(file.toPath()) }
        catch (_: Exception) { throw SecretStorageException() }
    }
}
