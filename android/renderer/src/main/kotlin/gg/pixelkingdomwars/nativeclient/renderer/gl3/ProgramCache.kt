package gg.pixelkingdomwars.nativeclient.renderer.gl3

import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** What a program binary is valid for: a binary from another driver, GPU or app build is never loaded. */
data class DriverIdentity(val renderer: String, val version: String, val appVersionCode: Long) {
    /** The cache namespace: one directory per identity, so a driver update or a new APK starts cold and purges the old. */
    val namespace: String get() = ProgramCache.sha256Hex("$renderer\n$version\n$appVersionCode").substring(0, 16)
}

/** One cached binary, already checked against its checksum and the driver's current binary formats. */
class ProgramBinary(val format: Int, val bytes: ByteArray)

/**
 * Program-binary cache (GLOBE-NATIVE-PLAN §5.3 step 2), used only on the worker context (disk I/O never runs on the GL
 * thread). Stored under `noBackupFilesDir` by the caller: `root/<identity namespace>/<key>.pb`.
 *
 * Invalidation rules, each one a way a stale binary would otherwise reach `glProgramBinary`:
 * 1. **Source**: the key is the sha256 of both stages (the pinned stage hashes), so any shader change is a miss.
 * 2. **Driver or app build**: the namespace hashes `GL_RENDERER`, `GL_VERSION` and the versionCode; opening the cache
 *    deletes every other namespace (a driver update would otherwise leave dead binaries forever).
 * 3. **Format**: a binary whose format the driver no longer lists in `GL_PROGRAM_BINARY_FORMATS` is deleted, not tried.
 * 4. **Integrity**: a truncated or corrupted file (header or payload sha256 mismatch) is deleted, not tried. Writes are
 *    atomic (temporary file, then rename), so a crash mid-write leaves only a temp file, which opening removes.
 * 5. **Link**: a binary the driver rejects (`LINK_STATUS` false) is deleted by [invalidate] and the program is rebuilt
 *    from source by [ProgramBuilder].
 * 6. **Size**: past [maxBytes] the least recently used binaries are deleted.
 */
class ProgramCache(root: File, driver: DriverIdentity, private val maxBytes: Long) {
    private val dir = File(root, driver.namespace)

    init {
        require(maxBytes > 0) { "maxBytes must be positive" }
        root.listFiles()?.forEach { if (it.isDirectory && it.name != dir.name) it.deleteRecursively() }
        dir.mkdirs()
        dir.listFiles()?.forEach { if (it.name.endsWith(TEMP)) it.delete() }
    }

    fun key(vsSha256: String, fsSha256: String): String = sha256Hex("$vsSha256\n$fsSha256")

    /** The binary for [key] if present, intact and in one of the driver's [formats] (the first [formatCount]). */
    fun load(key: String, formats: IntArray, formatCount: Int): ProgramBinary? {
        val file = file(key)
        if (!file.isFile) return null
        val binary = try { decode(file.readBytes()) } catch (_: IOException) { null }
        if (binary == null || !listed(binary.format, formats, formatCount)) { file.delete(); return null }
        file.setLastModified(System.currentTimeMillis())
        return binary
    }

    fun store(key: String, format: Int, bytes: ByteArray) {
        val file = file(key)
        val temp = File(dir, "${file.name}.${System.nanoTime()}$TEMP")
        try {
            temp.writeBytes(encode(format, bytes))
            try { Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING) }
            catch (_: AtomicMoveNotSupportedException) { Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING) }
        } catch (_: IOException) { temp.delete(); return }
        trim()
    }

    /** The driver rejected this binary: never try it again. */
    fun invalidate(key: String) { file(key).delete() }

    fun totalBytes(): Long = dir.listFiles()?.filter { it.name.endsWith(SUFFIX) }?.sumOf { it.length() } ?: 0L

    private fun file(key: String): File {
        require(key.length == 64 && key.all { it in '0'..'9' || it in 'a'..'f' }) { "Program cache key must be a sha256 hex" }
        return File(dir, key + SUFFIX)
    }

    private fun trim() {
        val files = dir.listFiles()?.filter { it.name.endsWith(SUFFIX) } ?: return
        var total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        for (file in files.sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            total -= file.length(); file.delete()
        }
    }

    companion object {
        private const val SUFFIX = ".pb"
        private const val TEMP = ".tmp"
        private const val MAGIC = 0x504b5750 // "PKWP"
        private const val VERSION = 1

        fun sha256Hex(text: String): String = hex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))

        private fun hex(bytes: ByteArray): String {
            val out = StringBuilder(bytes.size * 2)
            for (b in bytes) { val v = b.toInt() and 0xff; out.append(HEX[v ushr 4]).append(HEX[v and 15]) }
            return out.toString()
        }
        private val HEX = "0123456789abcdef".toCharArray()

        private fun listed(format: Int, formats: IntArray, count: Int): Boolean {
            for (i in 0 until minOf(count, formats.size)) if (formats[i] == format) return true
            return false
        }

        /** magic, version, format, length, sha256(payload), payload. */
        internal fun encode(format: Int, payload: ByteArray): ByteArray {
            val digest = MessageDigest.getInstance("SHA-256").digest(payload)
            return ByteBuffer.allocate(16 + digest.size + payload.size)
                .putInt(MAGIC).putInt(VERSION).putInt(format).putInt(payload.size).put(digest).put(payload).array()
        }

        internal fun decode(bytes: ByteArray): ProgramBinary? {
            if (bytes.size < 48) return null
            val input = DataInputStream(bytes.inputStream())
            if (input.readInt() != MAGIC || input.readInt() != VERSION) return null
            val format = input.readInt(); val length = input.readInt()
            if (length < 0 || bytes.size != 48 + length) return null
            val digest = ByteArray(32).also { input.readFully(it) }
            val payload = ByteArray(length).also { input.readFully(it) }
            return if (MessageDigest.isEqual(digest, MessageDigest.getInstance("SHA-256").digest(payload))) ProgramBinary(format, payload) else null
        }
    }
}
