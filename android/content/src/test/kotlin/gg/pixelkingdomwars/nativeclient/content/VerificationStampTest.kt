package gg.pixelkingdomwars.nativeclient.content

import java.io.File
import java.nio.file.Files
import kotlin.test.*
import org.junit.After
import org.junit.Test

class VerificationStampTest {
    private val directory = Files.createTempDirectory("pkw-stamp-test").toFile()
    @After fun clean() { directory.deleteRecursively() }
    private val resolve: (File, String) -> File = { root, path -> File(root, path) }
    private fun entries(vararg files: Pair<String, String>) = files.map { (path, bytes) ->
        File(directory, path).also { it.parentFile.mkdirs(); it.writeText(bytes) }
        VerificationStamp.Entry(path, bytes.toByteArray().size.toLong())
    }

    @Test fun `a stamp is trusted only for the same verifier identity and exact file set`() {
        val files = entries("atlas/a.png" to "aaaa", "catalogue.json" to "{}")
        VerificationStamp.record(directory, "build-1", "manifest-1", files, resolve)
        assertTrue(VerificationStamp.trusted(directory, "build-1", "manifest-1", files, resolve))
        assertFalse(VerificationStamp.trusted(directory, "build-2", "manifest-1", files, resolve), "Another APK build re-hashes")
        assertFalse(VerificationStamp.trusted(directory, "build-1", "manifest-2", files, resolve), "Another manifest digest re-hashes")
        assertFalse(VerificationStamp.trusted(directory, "build-1", "manifest-1", files.take(1), resolve), "A narrower expectation is not the stamped set")
        val wider = files + entries("atlas/b.png" to "bb")
        assertFalse(VerificationStamp.trusted(directory, "build-1", "manifest-1", wider, resolve), "An unstamped file is never trusted")
        assertFalse(VerificationStamp.trusted(directory, "build-1", "manifest-1", files.map { it.copy(size = it.size + 1) }, resolve), "A different declared size re-hashes")
    }

    @Test fun `a missing stamp missing file or symlinked file is never trusted`() {
        val files = entries("atlas/a.png" to "aaaa")
        assertFalse(VerificationStamp.trusted(directory, "b", "m", files, resolve))
        VerificationStamp.record(directory, "b", "m", files, resolve)
        assertTrue(VerificationStamp.trusted(directory, "b", "m", files, resolve))
        val original = File(directory, "atlas/a.png")
        val moved = File(directory, "atlas/moved.png"); assertTrue(original.renameTo(moved))
        assertFalse(VerificationStamp.trusted(directory, "b", "m", files, resolve), "The file is gone")
        Files.createSymbolicLink(original.toPath(), moved.toPath())
        assertFalse(VerificationStamp.trusted(directory, "b", "m", files, resolve), "A symlink is not the verified regular file")
        assertFailsWith<IllegalArgumentException> { VerificationStamp.record(directory, "b", "m", files, resolve) }
    }
}
