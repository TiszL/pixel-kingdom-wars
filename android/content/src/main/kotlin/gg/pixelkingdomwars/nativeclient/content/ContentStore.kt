package gg.pixelkingdomwars.nativeclient.content

import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.LinkOption
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.UUID

data class ContentFile(val path: String, val sha256: String, val size: Long, val tier: String = "core")
data class ContentManifest(val schemaVersion: Int, val sourceCommit: String, val contentVersion: String,
                           val files: List<ContentFile>)

/** Call installation on an IO dispatcher. Versions are immutable; activation is a tiny atomic
 * pointer replacement. SHA-256 authenticates bytes against a manifest obtained from the trusted
 * HTTPS release endpoint; it is not a substitute for authenticating that endpoint.
 *
 * Only core-tier files are installed and verified: the renderer catalogue's scene sections never
 * reference optional-tier files (the exporter promotes every referenced atlas and realm painting
 * to core; only the fantasy globe section may still name optional files until the globe renders),
 * and there is no per-file lease that could request one. Every installed file is hashed while it streams in and
 * again at activation. Launch-time selection, retention and the previous-pointer check trust a
 * [VerificationStamp] written after a full hash for the same [verifier] build and receipt; a
 * missing or mismatching stamp falls back to the full hash. */
class ContentStore(private val root: File, private val maxInstallBytes: Long = 512L * 1024 * 1024,
                   private val verifier: String = "", private val onVerification: ((ContentVerification) -> Unit)? = null,
                   private val availableBytes: (File) -> Long = { it.usableSpace }) {
    private var battleLeases = 0
    private data class PendingActivation(val version: String,val accepts: (File)->Boolean)
    private var pendingActivation: PendingActivation? = null
    private val leasedVersions = mutableMapOf<String, Int>()

    /** Optional groups identify unchanged file pins independently of the app source commit.
     * Reuse their original provenance without rewriting the immutable receipt. No byte is trusted
     * by this metadata read: retain/install still verify against these exact caller-supplied pins. */
    @Synchronized fun receiptForSameFiles(manifest: ContentManifest): ContentManifest {
        validate(manifest)
        val target=versionRoot(manifest.contentVersion)
        val prior=target.takeIf { it.exists() } ?: File(root,"repair-${manifest.contentVersion}")
        if(!prior.exists())return manifest
        require(!Files.isSymbolicLink(prior.toPath()) && Files.isRegularFile(File(prior,".verified").toPath(),LinkOption.NOFOLLOW_LINKS))
        val receipt=readReceipt(prior)
        validate(receipt)
        return if(receipt.schemaVersion==manifest.schemaVersion && receipt.contentVersion==manifest.contentVersion && receipt.files==manifest.files)receipt else manifest
    }

    /** Only an identical trusted receipt is eligible for repair reuse. This is an IO planning
     * hint; installation hashes each reused byte again before it can become renderable. */
    @Synchronized fun reusableFiles(manifest: ContentManifest): Set<String> {
        validate(manifest)
        val destination=versionRoot(manifest.contentVersion)
        val directory=destination.takeIf { it.exists() } ?: File(root,"repair-${manifest.contentVersion}")
        require(!Files.isSymbolicLink(directory.toPath()))
        if(!directory.exists() || runCatching { readReceipt(directory)==manifest }.getOrDefault(false).not())return emptySet()
        return installed(manifest).filter { validFile(directory,it) }.map { it.path }.toSet()
    }

    private fun validFile(directory: File, entry: ContentFile): Boolean = runCatching {
        val file=child(directory,entry.path)
        file.isFile && file.length()==entry.size && file.inputStream().use { input ->
            val hash=MessageDigest.getInstance("SHA-256");val buffer=ByteArray(64*1024)
            while(true) { val count=input.read(buffer);if(count<0)break;hash.update(buffer,0,count) }
            hash.digest().hex()==entry.sha256
        }
    }.getOrDefault(false)

    init { require(maxInstallBytes > 0); root.mkdirs() }

    @Synchronized fun install(manifest: ContentManifest, open: (ContentFile) -> InputStream): File {
        // The OS releases this lock on process death. A new installer may then
        // reclaim abandoned staging without deleting another live download.
        FileChannel.open(File(root,".install.lock").toPath(), StandardOpenOption.CREATE,
            StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val lock = checkNotNull(channel.tryLock()) { "Another content installation is active" }
            lock.use { return installOwned(manifest,open) }
        }
    }

    private fun installOwned(manifest: ContentManifest, open: (ContentFile) -> InputStream): File {
        validate(manifest)
        root.listFiles().orEmpty().filter { it.name.matches(Regex("staging-[a-f0-9-]{36}")) }.forEach {
            require(!Files.isSymbolicLink(it.toPath())) { "Content staging symlink rejected" }
            check(it.deleteRecursively()) { "Could not reclaim interrupted content" }
        }
        val destination = versionRoot(manifest.contentVersion)
        val quarantine=File(root,"repair-${manifest.contentVersion}")
        // A process can exit between the two atomic renames. Preserve and restore the old bytes
        // before retrying; their identical receipt still decides what may be reused.
        if(!destination.exists() && quarantine.exists()) {
            require(!Files.isSymbolicLink(quarantine.toPath()) && readReceipt(quarantine)==manifest)
            Files.move(quarantine.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE)
        }
        var repairing=false
        if (destination.exists()) {
            require(readReceipt(destination) == manifest) { "Content version cannot be overwritten" }
            try {
                verify(destination, manifest, full = false)
                if(quarantine.exists()) {
                    require(!Files.isSymbolicLink(quarantine.toPath()) && readReceipt(quarantine)==manifest)
                    check(quarantine.deleteRecursively())
                }
                return destination
            }
            catch(error:IllegalArgumentException) {
                // At least one file must independently fail its trusted pin. A transient IO or
                // metadata error alone is not permission to replace a previously installed tree.
                require(installed(manifest).any { !validFile(destination,it) }) { "Content verification could not be completed" }
                check((leasedVersions[destination.name] ?: 0)==0) { "Corrupt content is still in use" }
                repairing=true
            }
        }
        val staging = File(root, "staging-${UUID.randomUUID()}").also { check(it.mkdir()) }
        try {
            pruneUnused(setOf(destination.name))
            val entries = installed(manifest)
            require(availableBytes(root) >= entries.sumOf { it.size }) { "Not enough space for game content" }
            for (entry in entries) {
                val output = child(staging, entry.path)
                check(output.parentFile.mkdirs() || output.parentFile.isDirectory)
                val hash = MessageDigest.getInstance("SHA-256")
                var count = 0L
                (if(repairing && validFile(destination,entry))child(destination,entry.path).inputStream() else open(entry)).use { input ->
                    FileOutputStream(output).use { target ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            if (n == 0) continue
                            count += n
                            require(count <= entry.size) { "Content exceeds declared length: ${entry.path}" }
                            hash.update(buffer, 0, n)
                            target.write(buffer, 0, n)
                        }
                        target.fd.sync()
                    }
                }
                require(count == entry.size && hash.digest().hex() == entry.sha256) { "Invalid content: ${entry.path}" }
            }
            writeReceipt(staging, manifest)
            if(repairing) {
                var replaced=false
                SceneContentLeases.pruneIfUnleased(root,destination) {
                    check(!quarantine.exists()) { "Previous repair has not been recovered" }
                    Files.move(destination.toPath(),quarantine.toPath(),StandardCopyOption.ATOMIC_MOVE)
                    try { Files.move(staging.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE);replaced=true }
                    catch(error:Exception) { Files.move(quarantine.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE);throw error }
                }
                check(replaced) { "Corrupt content is still in use" }
                check(quarantine.deleteRecursively()) { "Could not reclaim repaired content" }
            } else Files.move(staging.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE)
            // Every byte above was hashed as it streamed in; stamp so the next launch only stats.
            stamp(destination, entries)
            return destination
        } finally { if (staging.exists()) staging.deleteRecursively() }
    }

    /** A battle retains its exact asset generation until close, including through reconnects. */
    @Synchronized fun acquireScene(battle: Boolean = false, accepts: (File)->Boolean = { true }): ContentLease? {
        val active = activeRoot(accepts) ?: return null
        val manifest = readReceipt(active)
        leasedVersions[active.name] = (leasedVersions[active.name] ?: 0) + 1
        if (battle) battleLeases++
        return ContentLease(active, manifest) { releaseScene(active.name,battle) }
    }

    /** A downloaded candidate stays usable if a later download fails before activation. */
    @Synchronized fun retain(version: String): ContentLease {
        val directory = versionRoot(version)
        val manifest = readReceipt(directory)
        verify(directory,manifest, full = false)
        leasedVersions[version] = (leasedVersions[version] ?: 0) + 1
        return ContentLease(directory, manifest) { releaseScene(version,false) }
    }

    /** Returns false when activation is deferred until the current battle releases its lease.
     * Activation always re-hashes every installed byte: it is the on-demand full verification. */
    @Synchronized fun activate(version: String, accepts: (File)->Boolean = { true }): Boolean {
        val directory = versionRoot(version)
        verify(directory, readReceipt(directory), full = true)
        require(accepts(directory)) { "Content metadata is incompatible" }
        if (battleLeases > 0) { pendingActivation = PendingActivation(version,accepts); return false }
        writePointer("active", version,accepts)
        // No versions are deleted: the previous pointer is a recovery path even after process death.
        return true
    }

    @Synchronized fun activeRoot(accepts: (File)->Boolean = { true }): File? {
        for (pointer in listOf("active", "previous")) {
            val file = File(root, pointer)
            if (!file.isFile) continue
            val candidate = runCatching {
                val directory = versionRoot(file.readText())
                verify(directory, readReceipt(directory), full = false)
                directory.takeIf(accepts)
            }.getOrNull()
            if (candidate != null) return candidate
        }
        return null
    }

    @Synchronized private fun releaseBattle() {
        check(battleLeases > 0)
        battleLeases--
        if (battleLeases == 0) pendingActivation?.let { pending ->
            pendingActivation = null
            activate(pending.version,pending.accepts)
        }
    }

    @Synchronized private fun releaseScene(version: String, battle: Boolean) {
        val count = requireNotNull(leasedVersions[version]) - 1
        if(count == 0) leasedVersions.remove(version) else leasedVersions[version] = count
        if(battle) releaseBattle()
    }

    /** Keep installed active/fallback/leased generations; only abandoned verified generations are reclaimed. */
    private fun pruneUnused(additionallyRetained: Set<String> = emptySet()) {
        val retained = (leasedVersions.keys+additionallyRetained).toMutableSet()
        listOf("active","previous").forEach { pointer ->
            File(root,pointer).takeIf { it.isFile }?.readText()?.let(retained::add)
        }
        pendingActivation?.version?.let(retained::add)
        root.listFiles().orEmpty().filter { it.name.matches(Regex("[a-f0-9]{64}")) && it.name !in retained }.forEach {
            SceneContentLeases.pruneIfUnleased(root,it) {
                check(it.deleteRecursively()) { "Could not reclaim unused content" }
            }
        }
    }

    private fun writePointer(name: String, version: String, accepts: (File)->Boolean = { true }) {
        val current = File(root, name)
        if (name == "active" && current.isFile) {
            val previous = current.readText()
            // Never replace the last-known-good pointer with a corrupt active generation.
            val valid = runCatching { val dir = versionRoot(previous); verify(dir, readReceipt(dir), full = false); accepts(dir) }.getOrDefault(false)
            if (valid) writePointer("previous", previous)
        }
        val temporary = File(root, "$name-${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { it.write(version.toByteArray(Charsets.US_ASCII)); it.fd.sync() }
            Files.move(temporary.toPath(), current.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }

    private fun validate(manifest: ContentManifest) {
        require(manifest.schemaVersion == 1) { "Unsupported content schema" }
        require(manifest.sourceCommit.matches(Regex("[a-f0-9]{7,40}")))
        require(manifest.contentVersion.matches(Regex("[a-f0-9]{64}")))
        require(manifest.files.isNotEmpty() && manifest.files.size <= 100_000)
        require(manifest.files.map { it.path }.distinct().size == manifest.files.size)
        var total = 0L
        for (entry in manifest.files) {
            validatePath(entry.path)
            require(entry.sha256.matches(Regex("[a-f0-9]{64}")))
            require(entry.size >= 0 && entry.size <= maxInstallBytes - total)
            require(entry.tier == "core" || entry.tier == "optional")
            total += entry.size
        }
    }

    /** The installed subset of a manifest: core tier only (see the class contract). */
    private fun installed(manifest: ContentManifest) = manifest.files.filter { it.tier == "core" }

    /** [full] re-hashes every installed byte. Otherwise a stamp from this verifier for this exact
     * receipt is trusted after a stat check, and only a stamp miss re-hashes. Both outcomes are
     * reported through [onVerification]; a successful full hash refreshes the stamp. */
    private fun verify(directory: File, manifest: ContentManifest, full: Boolean) {
        validate(manifest)
        require(directory.name == manifest.contentVersion)
        val entries = installed(manifest)
        val started = System.nanoTime()
        if (!full && VerificationStamp.trusted(directory, verifier, receiptIdentity(directory), entries.map { VerificationStamp.Entry(it.path, it.size) }, ::child)) {
            onVerification?.invoke(ContentVerification(manifest.contentVersion, false, entries.size, System.nanoTime() - started))
            return
        }
        for (entry in entries) {
            val file = child(directory, entry.path)
            require(file.isFile && file.length() == entry.size) { "Missing content: ${entry.path}" }
            val hash = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) { val n = input.read(buffer); if (n < 0) break; hash.update(buffer, 0, n) }
            }
            require(hash.digest().hex() == entry.sha256) { "Corrupt content: ${entry.path}" }
        }
        stamp(directory, entries)
        onVerification?.invoke(ContentVerification(manifest.contentVersion, true, entries.size, System.nanoTime() - started))
    }

    private fun stamp(directory: File, entries: List<ContentFile>) =
        VerificationStamp.record(directory, verifier, receiptIdentity(directory), entries.map { VerificationStamp.Entry(it.path, it.size) }, ::child)

    /** The stamp binds to the exact receipt bytes, so a differing manifest never inherits trust. */
    private fun receiptIdentity(directory: File) = MessageDigest.getInstance("SHA-256").digest(File(directory, ".verified").readBytes()).hex()

    private fun versionRoot(version: String): File {
        require(version.matches(Regex("[a-f0-9]{64}")))
        return child(root, version)
    }

    private fun child(directory: File, path: String): File {
        validatePath(path)
        val target = File(directory, path)
        require(target.canonicalPath.startsWith(directory.canonicalPath + File.separator)) { "Content path escapes root" }
        // Refuse symlinks even when they happen to resolve inside the generation.
        var part = target
        while (part != directory) {
            require(!Files.isSymbolicLink(part.toPath())) { "Content symlink rejected" }
            part = part.parentFile
        }
        return target
    }

    private fun validatePath(path: String) {
        require(path.isNotEmpty() && !path.startsWith('/') && !path.contains('\\') && !path.contains(':'))
        require(path.split('/').all { it.matches(Regex("[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*")) && it != "." && it != ".." })
    }

    private fun writeReceipt(directory: File, manifest: ContentManifest) {
        FileOutputStream(File(directory, ".verified")).use { stream ->
            val data = DataOutputStream(stream)
            data.writeInt(manifest.schemaVersion); data.writeUTF(manifest.sourceCommit); data.writeUTF(manifest.contentVersion)
            data.writeInt(manifest.files.size)
            manifest.files.forEach { data.writeUTF(it.path); data.writeUTF(it.sha256); data.writeLong(it.size); data.writeUTF(it.tier) }
            data.flush(); stream.fd.sync()
        }
    }

    private fun readReceipt(directory: File): ContentManifest = DataInputStream(File(directory, ".verified").inputStream()).use { data ->
        val schema = data.readInt(); val commit = data.readUTF(); val version = data.readUTF()
        val size = data.readInt(); require(size in 1..100_000)
        ContentManifest(schema, commit, version, List(size) { ContentFile(data.readUTF(), data.readUTF(), data.readLong(), data.readUTF()) })
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}

class ContentLease internal constructor(val directory: File,
    /** Exact receipt selected with this store generation, including optional pins. Plain scene leases have none. */
    val manifest: ContentManifest? = null, private val release: () -> Unit) : Closeable {
    private var closed = false
    @Synchronized override fun close() { if (!closed) { closed = true; release() } }
}
