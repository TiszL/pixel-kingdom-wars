package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.content.VerificationStamp
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.serialization.json.*
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

/** APK extraction runs on IO. One process-wide lock also covers restored fragment leases.
 *
 * Core-tier files are extracted, hashed while copying, and stamped ([VerificationStamp]) for the
 * extracting APK build. A later launch trusts that stamp after a stat check and re-hashes only
 * when the stamp is missing, the manifest bytes or build differ, or a file's stat changed; [full]
 * forces the hash. Debug fixtures are extracted alongside but are neither stamped nor hashed at
 * launch: the offline preview that reads them calls [verifyFixtures] first. */
internal object BundledContent {
    private val generation = Regex("bundled-[a-f0-9]{64}")
    private val staging = Regex("bundled-staging-[a-f0-9-]{36}")
    private val leases = mutableMapOf<String, Int>()
    private val current = mutableMapOf<String, String>()
    private val previous = mutableMapOf<String, String>()

    @Synchronized fun prepare(root: File, manifestBytes: ByteArray, debug: Boolean,
        onLoad:((ContentLoadSample)->Unit)?=null, verifier: String = "", full: Boolean = false, open: (String) -> InputStream): File {
        check(root.mkdirs() || root.isDirectory)
        val manifest = parseManifest(manifestBytes)
        val core = manifest.files.filter { it.tier == "core" }
        val fixtures = if (debug) fixtures(manifest) else emptyList()
        val files = core + fixtures
        val identity = hash(manifestBytes)
        val destination = File(root, "bundled-$identity")
        require(!Files.isSymbolicLink(destination.toPath()))
        // Only this synchronized method creates staging directories. Anything left is from a dead process.
        root.listFiles().orEmpty().filter { it.name.matches(staging) }.forEach(::remove)
        val valid = destination.isDirectory && runCatching {
            check(File(destination,"manifest.json").readBytes().contentEquals(manifestBytes))
            val trusted = !full && runCatching { contentLoadWork(ContentLoadStage.BUNDLE_TRUST,onLoad,core.size,core.sumOf { it.size }) {
                check(VerificationStamp.trusted(destination, verifier, identity, core.map { VerificationStamp.Entry(it.path, it.size) }, ::child))
            } }.isSuccess
            if (!trusted) {
                val hashed = if (full) files else core
                contentLoadWork(ContentLoadStage.BUNDLE_VERIFY,onLoad,hashed.size,hashed.sumOf { it.size }) { verify(destination,hashed) }
                stamp(destination, verifier, identity, core)
            }
            // A debug launch only needs its fixtures present; verifyFixtures hashes them on demand.
            for (entry in fixtures) { val file = child(destination, entry.path); check(file.isFile && file.length() == entry.size) }
        }.isSuccess
        if (!valid) {
            check((leases[destination.absolutePath] ?: 0) == 0) { "Bundled artwork is damaged while a scene is using it; restart to repair it" }
            val temporary = File(root,"bundled-staging-${UUID.randomUUID()}")
            check(temporary.mkdir())
            try { contentLoadWork(ContentLoadStage.BUNDLE_EXTRACT,onLoad,files.size,files.sumOf { it.size }) {
                check(root.usableSpace >= files.sumOf { it.size }) { "Not enough space for bundled artwork" }
                for (entry in files) {
                    val target = child(temporary,entry.path)
                    val parent = requireNotNull(target.parentFile)
                    check(parent.mkdirs() || parent.isDirectory)
                    open(entry.path).use { input -> FileOutputStream(target).use { output ->
                        val digest = MessageDigest.getInstance("SHA-256")
                        val buffer = ByteArray(64 * 1024)
                        var size = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            size += count
                            require(size <= entry.size) { "Bundled artwork exceeds its manifest: ${entry.path}" }
                            digest.update(buffer,0,count); output.write(buffer,0,count)
                        }
                        require(size == entry.size && digest.digest().hex() == entry.sha256) { "Bundled artwork failed verification: ${entry.path}" }
                        output.fd.sync()
                    } }
                }
                FileOutputStream(File(temporary,"manifest.json")).use { it.write(manifestBytes); it.fd.sync() }
                if(destination.exists()) remove(destination)
                Files.move(temporary.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE)
                // Every core byte was hashed while copying; the stamp lets the next launch stat instead.
                stamp(destination, verifier, identity, core)
            } } finally { if(temporary.exists()) remove(temporary) }
        }
        val oldCurrent = current.put(root.absolutePath,destination.name)
        val others = root.listFiles().orEmpty().filter { it.name.matches(generation) && it != destination }
        val fallback = others.firstOrNull { it.name == oldCurrent }
            ?: others.firstOrNull { it.name == previous[root.absolutePath] }
            ?: others.maxByOrNull { it.lastModified() }
        if(fallback != null) previous[root.absolutePath] = fallback.name
        for (other in others) if(other != fallback && (leases[other.absolutePath] ?: 0) == 0) remove(other)
        return destination
    }

    /** Debug fixtures are hashed only when the offline preview is about to read them. */
    @Synchronized fun verifyFixtures(directory: File) {
        require(directory.name.matches(generation) && File(directory,"manifest.json").isFile) { "Bundled artwork is unavailable" }
        val fixtures = fixtures(parseManifest(File(directory,"manifest.json").readBytes()))
        require(fixtures.isNotEmpty()) { "This bundle carries no debug fixtures" }
        verify(directory, fixtures)
    }

    /** Claim before renderer creation; release only after its GL disposal callback. */
    @Synchronized fun acquire(directory: File): Closeable? {
        if(!directory.name.matches(generation)) return null
        require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath()) && File(directory,"manifest.json").isFile) { "Bundled artwork is unavailable" }
        val path = directory.absolutePath
        leases[path] = (leases[path] ?: 0) + 1
        var closed = false
        return Closeable { synchronized(this) {
            if(!closed) {
                closed = true
                val count = requireNotNull(leases[path]) - 1
                if(count == 0) leases.remove(path) else leases[path] = count
            }
        } }
    }

    private fun parseManifest(manifestBytes: ByteArray): NativeContentManifest {
        val raw = Json.parseToJsonElement(manifestBytes.toString(Charsets.UTF_8)).jsonObject
        return nativeContentManifest(raw, requireNotNull(raw["simVersion"]).jsonPrimitive.int)
    }
    private fun fixtures(manifest: NativeContentManifest) = manifest.files.filter { it.tier == "optional" && it.path.startsWith("fixtures/") }
    private fun stamp(directory: File, verifier: String, identity: String, core: List<NativeContentFile>) =
        VerificationStamp.record(directory, verifier, identity, core.map { VerificationStamp.Entry(it.path, it.size) }, ::child)
    private fun verify(directory: File, files: List<NativeContentFile>) {
        for(entry in files) {
            val file = child(directory,entry.path)
            require(file.isFile && file.length() == entry.size)
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while(true) { val count = input.read(buffer); if(count < 0) break; digest.update(buffer,0,count) }
            }
            require(digest.digest().hex() == entry.sha256) { "Corrupt bundled artwork: ${entry.path}" }
        }
    }
    private fun child(root: File,path: String): File {
        val file = File(root,path)
        require(file.canonicalPath.startsWith(root.canonicalPath + File.separator))
        var part = file
        while(part != root) { require(!Files.isSymbolicLink(part.toPath())); part = requireNotNull(part.parentFile) }
        return file
    }
    private fun remove(file: File) {
        require(!Files.isSymbolicLink(file.toPath()))
        check(file.deleteRecursively()) { "Could not reclaim old bundled artwork" }
    }
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).hex()
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
