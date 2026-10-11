package gg.pixelkingdomwars.nativeclient.content

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.TimeUnit

/** The record of one successful full SHA-256 verification of a generation.
 *
 * Trust model: bytes are hashed when they are installed and whenever a generation is activated.
 * Between those points a launch only re-establishes that nothing observable changed: the stamp
 * must name the same verifier build and manifest identity, list exactly the expected files, and
 * every file must still have the recorded size, modification time and filesystem identity.
 * Any mismatch, missing stamp or read failure returns to a full hash. A modification that
 * preserves size, mtime and inode inside the app's private storage is not detected by this
 * check; it remains caught by the full hash at activation or by an explicit verification. */
object VerificationStamp {
    const val FILE_NAME = ".verified-stamp"
    private const val FORMAT = 1
    data class Entry(val path: String, val size: Long)

    /** Records the current stat of every listed file. Call only after all of them hashed correctly. */
    fun record(directory: File, verifier: String, identity: String, files: List<Entry>, resolve: (File, String) -> File) {
        val temporary = File(directory, "$FILE_NAME-${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { stream ->
                val data = DataOutputStream(stream)
                data.writeInt(FORMAT); data.writeUTF(verifier); data.writeUTF(identity); data.writeInt(files.size)
                for (entry in files) {
                    val attributes = attributes(resolve(directory, entry.path))
                    require(attributes.isRegularFile && attributes.size() == entry.size) { "Stamped content changed while recording: ${entry.path}" }
                    data.writeUTF(entry.path); data.writeLong(entry.size)
                    data.writeLong(attributes.lastModifiedTime().to(TimeUnit.NANOSECONDS)); data.writeUTF(fileKey(attributes))
                }
                data.flush(); stream.fd.sync()
            }
            Files.move(temporary.toPath(), File(directory, FILE_NAME).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }

    /** True only when a stamp from the same verifier and identity covers exactly [files] and each
     * file still matches its recorded stat. Never throws: every failure means "hash again". */
    fun trusted(directory: File, verifier: String, identity: String, files: List<Entry>, resolve: (File, String) -> File): Boolean = runCatching {
        val stamp = File(directory, FILE_NAME)
        if (!Files.isRegularFile(stamp.toPath(), LinkOption.NOFOLLOW_LINKS)) return false
        val expected = files.associate { it.path to it.size }
        if (expected.size != files.size) return false
        DataInputStream(stamp.inputStream().buffered()).use { data ->
            if (data.readInt() != FORMAT || data.readUTF() != verifier || data.readUTF() != identity) return false
            val count = data.readInt()
            if (count != expected.size) return false
            val seen = HashSet<String>(count)
            repeat(count) {
                val path = data.readUTF(); val size = data.readLong(); val modified = data.readLong(); val key = data.readUTF()
                if (expected[path] != size || !seen.add(path)) return false
                val attributes = attributes(resolve(directory, path))
                if (!attributes.isRegularFile || attributes.size() != size ||
                    attributes.lastModifiedTime().to(TimeUnit.NANOSECONDS) != modified || fileKey(attributes) != key) return false
            }
            seen.size == expected.size
        }
    }.getOrDefault(false)

    private fun attributes(file: File): BasicFileAttributes =
        Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    private fun fileKey(attributes: BasicFileAttributes) = attributes.fileKey()?.toString().orEmpty()
}

/** Outcome of one generation verification. [hashed] is false when a stamp was trusted instead. */
data class ContentVerification(val version: String, val hashed: Boolean, val files: Int, val elapsedNanos: Long)
