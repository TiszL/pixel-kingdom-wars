package gg.pixelkingdomwars.nativeclient.update

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** M45 §5: nothing reaches the installer unless its bytes, package, single signer and version all match. Every
 * refusal deletes the file, so a bad download can neither be installed later nor keep occupying storage. */
class UpdateVerifierTest {
    private val bytes = "signed apk bytes".toByteArray()
    private fun apk(): File = Files.createTempFile("update", ".apk").toFile().apply { writeBytes(bytes); deleteOnExit() }
    private fun archive(packageName: String = PACKAGE, code: Long = 26, signers: List<String> = listOf(SIGNER)) = ArchiveInfo(packageName, code, signers)
    private fun refused(file: File, info: ArchiveInfo?, offer: gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer = offer(bytes), running: RunningIdentity = running()): UpdateFailureKind {
        var inspected = 0
        val kind = runBlocking { try { UpdateVerifier { inspected++; info }.verify(file, offer, running); null } catch (error: UpdateFailure) { error.kind } }
        assertFalse("A refused file is deleted", file.exists())
        return requireNotNull(kind).also { if (it == UpdateFailureKind.HASH) assertEquals("Bytes are checked before parsing", 0, inspected) }
    }

    @Test fun `a matching file is verified and kept for the installer`() = runBlocking {
        val file = apk()
        assertEquals(VerifiedApk(file, sha(bytes)), UpdateVerifier { archive() }.verify(file, offer(bytes), running()))
        assertTrue(file.exists())
        // apksigner-style signer text is the same key.
        assertEquals(sha(bytes), UpdateVerifier { archive(signers = listOf(SIGNER.uppercase().chunked(2).joinToString(":"))) }.verify(file, offer(bytes), running()).sha256)
    }
    @Test fun `bytes that differ from the published hash are refused first`() {
        // The hash binds the file to the operator's signed release; nothing else is trusted before it matches.
        assertEquals(UpdateFailureKind.HASH, refused(apk(), archive(packageName = "other"), offer(bytes, sha256 = "0".repeat(64))))
    }
    @Test fun `another package or an unreadable archive is refused`() {
        assertEquals(UpdateFailureKind.PACKAGE, refused(apk(), archive(packageName = "gg.pixelkingdomwars.twa.debug")))
        assertEquals(UpdateFailureKind.PACKAGE, refused(apk(), null))
    }
    @Test fun `a foreign or additional signer is refused`() {
        // Exactly one signer, the installed one: a second signer could be the key that actually matters to the platform.
        assertEquals(UpdateFailureKind.SIGNER, refused(apk(), archive(signers = listOf("a1".repeat(32)))))
        assertEquals(UpdateFailureKind.SIGNER, refused(apk(), archive(signers = listOf(SIGNER, "a1".repeat(32)))))
        assertEquals(UpdateFailureKind.SIGNER, refused(apk(), archive(signers = emptyList())))
    }
    @Test fun `the archive must be exactly the offered, newer version`() {
        // A stale or rolled-back file behind a newer channel row must not install.
        assertEquals(UpdateFailureKind.VERSION, refused(apk(), archive(code = 27)))
        assertEquals(UpdateFailureKind.VERSION, refused(apk(), archive(code = 25), offer(bytes, code = 25), running(25)))
    }
}
