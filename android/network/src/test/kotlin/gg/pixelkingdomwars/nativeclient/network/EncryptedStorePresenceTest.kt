package gg.pixelkingdomwars.nativeclient.network

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** JVM metadata checks only; no AndroidKeyStore/decryption/device claim. */
class EncryptedStorePresenceTest {
    @get:Rule val folder = TemporaryFolder()
    @Test fun `only a missing encrypted entry is absent`() {
        val file = File(folder.root, "missing.enc"); assertFalse(encryptedStoreHasData(file))
        file.writeBytes(byteArrayOf(0)); assertTrue(encryptedStoreHasData(file)); assertArrayEquals(byteArrayOf(0), file.readBytes())
    }
    @Test fun `corrupt directories and dangling links stay discoverable without interpreting bytes`() {
        assertTrue(encryptedStoreHasData(folder.newFolder("corrupt.enc")))
        val link = folder.root.toPath().resolve("dangling.enc"); Files.createSymbolicLink(link, folder.root.toPath().resolve("absent"))
        assertTrue(encryptedStoreHasData(link.toFile()))
    }
    @Test fun `metadata failure remains unavailable rather than silently absent`() {
        val parent = folder.newFile("not-a-directory")
        assertTrue(runCatching { encryptedStoreHasData(File(parent, "saved.enc")) }.exceptionOrNull() is SecretStorageException)
    }
}
