package gg.pixelkingdomwars.nativeclient.content

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.FileTime
import kotlin.test.*
import org.junit.After
import org.junit.Test

class ContentStoreTest {
    private val directory = Files.createTempDirectory("pkw-content-test").toFile()
    private val store = ContentStore(directory)
    @After fun clean() { directory.deleteRecursively() }

    private fun manifest(bytes: String, path: String = "atlas/tile@1x.png", version: String = hash(bytes)) =
        ContentManifest(1, "9f4a98ba", version, listOf(ContentFile(path, hash(bytes), bytes.toByteArray().size.toLong())))
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun install(bytes: String): String { val m = manifest(bytes); store.install(m) { bytes.byteInputStream() }; return m.contentVersion }

    @Test fun `failed download cannot replace the playable generation`() {
        val original = install("original")
        store.activate(original)
        assertFailsWith<IllegalArgumentException> { store.install(manifest("expected")) { "tampered".byteInputStream() } }
        assertEquals(original, store.activeRoot()!!.name)
        assertFalse(directory.listFiles()!!.any { it.name.startsWith("staging-") })
    }

    @Test fun `content activation waits until every battle releases its generation`() {
        val original = install("old")
        store.activate(original)
        val first = store.acquireScene(battle = true)!!
        val second = store.acquireScene(battle = true)!!
        val updated = install("updated")
        assertFalse(store.activate(updated))
        first.close(); first.close()
        assertEquals(original, store.activeRoot()!!.name)
        assertEquals(original, second.directory.name)
        second.close()
        assertEquals(updated, store.activeRoot()!!.name)
        assertEquals("old", File(first.directory, "atlas/tile@1x.png").readText())
    }

    @Test fun `restart recovers previous verified generation if active bytes are corrupt`() {
        val original = install("good")
        store.activate(original)
        val updated = install("new")
        store.activate(updated)
        File(directory, "$updated/atlas/tile@1x.png").writeText("bad")
        assertEquals(original, ContentStore(directory).activeRoot()!!.name)
    }

    @Test fun `malicious manifest paths fail before any download`() {
        var downloads = 0
        for (path in listOf("../escape", "/absolute", "atlas/../escape", "atlas\\escape", "atlas/.verified", "C:/file", "atlas//file")) {
            assertFailsWith<IllegalArgumentException> {
                store.install(manifest("x", path)) { downloads++; "x".byteInputStream() }
            }
        }
        assertEquals(0, downloads)
    }

    @Test fun `published version cannot silently acquire different files`() {
        val original = install("old")
        assertFailsWith<IllegalArgumentException> { store.install(manifest("new", version = original)) { "new".byteInputStream() } }
    }

    private val repairBytes=linkedMapOf("atlas/color.png" to "healthy color", "atlas/mask.png" to "healthy mask")
    private fun repairManifest()=ContentManifest(1,"9f4a98ba",hash("atomic island pair"),repairBytes.map { (path,bytes)->ContentFile(path,hash(bytes),bytes.length.toLong()) })
    private fun installedPair():File {
        val manifest=repairManifest()
        val result=store.install(manifest) { repairBytes.getValue(it.path).byteInputStream() }
        store.activate(manifest.contentVersion)
        return result
    }
    @Test fun `same receipt repair reuses healthy files and atomically restores corrupt bytes`() {
        val target=installedPair();File(target,"atlas/mask.png").writeText("bad")
        assertEquals(setOf("atlas/color.png"),store.reusableFiles(repairManifest()))
        val requested=mutableListOf<String>()
        val result=store.install(repairManifest()) { requested+=it.path;repairBytes.getValue(it.path).byteInputStream() }
        assertEquals(listOf("atlas/mask.png"),requested,"Already verified color never needs another transport read")
        repairBytes.forEach { (path,bytes)->assertEquals(bytes,File(result,path).readText()) }
        assertEquals(target,store.activeRoot())
        assertFalse(directory.listFiles()!!.any { it.name.startsWith("repair-") || it.name.startsWith("staging-") })
    }
    @Test fun `unchanged group keeps original provenance during a later app repair`() {
        val target=installedPair();File(target,"atlas/mask.png").writeText("bad")
        val unchanged=repairManifest().copy(sourceCommit="a".repeat(40))
        val receipt=store.receiptForSameFiles(unchanged)
        assertEquals(repairManifest(),receipt,"An app update does not rewrite original asset provenance")
        store.install(receipt) { repairBytes.getValue(it.path).byteInputStream() }
        val changed=unchanged.copy(files=unchanged.files.dropLast(1))
        assertEquals(changed,store.receiptForSameFiles(changed),"Different pins never inherit another receipt")
        assertFailsWith<IllegalArgumentException> { store.install(changed) { error("Must fail before transport") } }
    }
    @Test fun `failed or cancelled repair preserves healthy bytes and pointers for a later retry`() {
        val target=installedPair();File(target,"atlas/mask.png").writeText("bad")
        val active=File(directory,"active").readText()
        assertFailsWith<java.io.IOException> { store.install(repairManifest()) { throw java.io.IOException("interrupted body") } }
        assertEquals("healthy color",File(target,"atlas/color.png").readText())
        assertEquals("bad",File(target,"atlas/mask.png").readText())
        assertEquals(active,File(directory,"active").readText())
        assertFalse(directory.listFiles()!!.any { it.name.startsWith("repair-") || it.name.startsWith("staging-") })
        store.install(repairManifest()) { repairBytes.getValue(it.path).byteInputStream() }
        assertEquals("healthy mask",File(target,"atlas/mask.png").readText())
    }
    @Test fun `low storage refuses repair before fetching without clearing healthy files`() {
        val target=installedPair();File(target,"atlas/mask.png").writeText("bad")
        val bounded=ContentStore(directory,availableBytes={0L})
        var reads=0
        assertFailsWith<IllegalArgumentException> { bounded.install(repairManifest()) { reads++;error("No room for replacement") } }
        assertEquals(0,reads);assertEquals("healthy color",File(target,"atlas/color.png").readText())
        assertEquals(target.name,File(directory,"active").readText())
    }
    @Test fun `corrupt generation cannot be replaced while a renderer owns its path`() {
        val target=installedPair();val lease=SceneContentLeases.acquire(directory,target)
        File(target,"atlas/mask.png").writeText("bad")
        try {
            assertFailsWith<IllegalStateException> { store.install(repairManifest()) { repairBytes.getValue(it.path).byteInputStream() } }
            assertEquals("bad",File(lease.directory,"atlas/mask.png").readText())
            assertEquals("healthy color",File(lease.directory,"atlas/color.png").readText())
        } finally { lease.close() }
        store.install(repairManifest()) { repairBytes.getValue(it.path).byteInputStream() }
        assertEquals("healthy mask",File(target,"atlas/mask.png").readText())
    }
    @Test fun `restart during repair restores quarantine before rebuilding the same group`() {
        val target=installedPair();File(target,"atlas/mask.png").writeText("bad")
        Files.move(target.toPath(),File(directory,"repair-${target.name}").toPath())
        val requested=mutableListOf<String>()
        val restarted=ContentStore(directory)
        restarted.install(repairManifest()) { requested+=it.path;repairBytes.getValue(it.path).byteInputStream() }
        assertEquals(listOf("atlas/mask.png"),requested)
        assertEquals(target,restarted.activeRoot())
    }

    @Test fun `declared length and total budget reject streaming overrun`() {
        val bounded = ContentStore(File(directory, "small"), maxInstallBytes = 2)
        assertFailsWith<IllegalArgumentException> { bounded.install(manifest("abc")) { "abc".byteInputStream() } }
        assertFailsWith<IllegalArgumentException> { bounded.install(manifest("x")) { "xx".byteInputStream() } }
    }

    @Test fun `symlink generation cannot redirect reads outside the content root`() {
        val original = install("old")
        val directoryToLink = File(directory, original)
        directoryToLink.deleteRecursively()
        val outside = Files.createTempDirectory("pkw-outside").toFile()
        try {
            Files.createSymbolicLink(directoryToLink.toPath(), outside.toPath())
            assertFailsWith<IllegalArgumentException> { store.activate(original) }
        } finally { directoryToLink.delete(); outside.deleteRecursively() }
    }

    @Test fun `restart reclaims killed downloads but never another live installer staging`() {
        val original = install("playable")
        store.activate(original)
        val orphan = File(directory,"staging-00000000-0000-0000-0000-000000000001").apply { mkdir() }
        File(orphan,"partial.png").writeText("unfinished")
        FileChannel.open(File(directory,".install.lock").toPath(),StandardOpenOption.WRITE).use { channel ->
            channel.lock().use {
                assertFailsWith<OverlappingFileLockException> { ContentStore(directory).install(manifest("next")) { "next".byteInputStream() } }
                assertTrue(orphan.exists(),"A second installer cannot reclaim a live writer's files")
            }
        }
        ContentStore(directory).install(manifest("next")) { "next".byteInputStream() }
        assertFalse(orphan.exists(),"A dead process cannot permanently consume the update budget")
        assertEquals(original,store.activeRoot()!!.name)
    }
    @Test fun `semantic fallback selects and leases previous and deferred activation preserves it`() {
        val good=install("good");store.activate(good)
        val bad=install("bad");store.activate(bad)
        val accepts:(File)->Boolean={ File(it,"atlas/tile@1x.png").readText()!="bad" }
        val retained=store.acquireScene(battle=true,accepts=accepts)!!
        assertEquals(good,retained.directory.name)
        val next=install("next");assertFalse(store.activate(next,accepts))
        retained.close();assertEquals(next,store.activeRoot(accepts)!!.name)
        assertEquals(good,File(directory,"previous").readText(),"Bad active cannot replace the semantically valid recovery pointer")
        File(directory,"$next/atlas/tile@1x.png").writeText("broken")
        assertEquals(good,store.activeRoot(accepts)!!.name)
    }

    // --- Verification stamps: launch trusts one earlier full hash instead of re-hashing ---

    private fun stampedStore(verifier: String = "build-1", reports: MutableList<ContentVerification>) =
        ContentStore(directory, verifier = verifier, onVerification = { reports.add(it) })

    @Test fun `a stamped generation is selected by stat check without re-hashing across restarts`() {
        val reports = mutableListOf<ContentVerification>()
        val installer = stampedStore(reports = reports)
        val version = manifest("playable").contentVersion
        installer.install(manifest("playable")) { "playable".byteInputStream() }
        assertTrue(installer.activate(version))
        assertEquals(listOf(true), reports.map { it.hashed }, "Activation is the on-demand full hash")
        reports.clear()
        val restarted = stampedStore(reports = reports)
        assertEquals(version, restarted.activeRoot()!!.name)
        restarted.retain(version).close()
        assertEquals(listOf(false, false), reports.map { it.hashed }, "Launch selection and retention trust the stamp")
        assertTrue(reports.all { it.version == version && it.files == 1 })
    }

    @Test fun `stamp is ignored when the verifier build changes and re-established afterwards`() {
        val reports = mutableListOf<ContentVerification>()
        val version = install("stable")
        store.activate(version)
        val upgraded = stampedStore("build-2", reports)
        assertEquals(version, upgraded.activeRoot()!!.name)
        assertEquals(listOf(true), reports.map { it.hashed }, "A new APK build must re-hash once")
        assertEquals(version, upgraded.activeRoot()!!.name)
        assertEquals(listOf(true, false), reports.map { it.hashed }, "...and then owns its own stamp")
        val downgraded = stampedStore("build-1", mutableListOf())
        assertEquals(version, downgraded.activeRoot()!!.name, "Another build never loses the content, it only hashes again")
    }

    @Test fun `a changed size or modification time invalidates the stamp and corruption falls back`() {
        val pinned = FileTime.fromMillis(1_700_000_000_000L)
        for (sameSize in listOf(false, true)) {
            val root = File(directory, "case-$sameSize").also { it.mkdirs() }
            val installer = ContentStore(root)
            fun put(bytes: String): String { val m = manifest(bytes); installer.install(m) { bytes.byteInputStream() }; return m.contentVersion }
            val good = put("good"); installer.activate(good)
            val updated = put("updated")
            val tile = File(root, "$updated/atlas/tile@1x.png")
            Files.setLastModifiedTime(tile.toPath(), pinned)
            installer.activate(updated) // full hash, stamp records the pinned stat
            tile.writeText(if (sameSize) "updatex" else "updated!")
            Files.setLastModifiedTime(tile.toPath(), if (sameSize) FileTime.fromMillis(pinned.toMillis() + 1_000) else pinned)
            // A trusted stamp would have selected the tampered generation; the hash it forced instead
            // failed closed to the previous generation.
            assertEquals(good, ContentStore(root).activeRoot()!!.name, "sameSize=$sameSize")
        }
    }

    @Test fun `same-size same-mtime tampering passes launch trust but is caught by activation`() {
        // This pins the exact boundary of the trust model: the launch check is a stat, not a hash.
        val version = install("original")
        val tile = File(directory, "$version/atlas/tile@1x.png")
        val pinned = FileTime.fromMillis(1_700_000_000_000L)
        Files.setLastModifiedTime(tile.toPath(), pinned)
        store.activate(version) // full hash of "original"; the stamp records the pinned stat
        tile.writeText("tampered") // "original" and "tampered" are both eight bytes, same inode
        Files.setLastModifiedTime(tile.toPath(), pinned)
        val reports = mutableListOf<ContentVerification>()
        val restarted = ContentStore(directory, onVerification = { reports.add(it) })
        assertEquals(version, restarted.activeRoot()!!.name, "Preserved stat is trusted at launch")
        assertEquals(listOf(false), reports.map { it.hashed })
        assertFailsWith<IllegalArgumentException>("Activation re-hashes every installed byte") { restarted.activate(version) }
    }

    @Test fun `optional tier files are neither downloaded nor verified and the receipt keeps the full manifest`() {
        val core = ContentFile("atlas/tile@1x.png", hash("core"), 4)
        val optional = ContentFile("atlas/extra@1x.png", hash("never"), 5, tier = "optional")
        val full = ContentManifest(1, "9f4a98ba", hash("core+optional"), listOf(core, optional))
        val opened = mutableListOf<String>()
        val installed = store.install(full) { opened += it.path; "core".byteInputStream() }
        assertEquals(listOf("atlas/tile@1x.png"), opened)
        assertFalse(File(installed, "atlas/extra@1x.png").exists())
        assertTrue(store.activate(full.contentVersion))
        assertEquals(installed, ContentStore(directory).activeRoot())
        ContentStore(directory).acquireScene()!!.use { lease ->
            assertEquals(full, lease.manifest, "Process recovery retains optional pins without downloading them")
        }
        store.retain(full.contentVersion).use { lease -> assertEquals(full, lease.manifest) }
        assertEquals(installed, store.install(full) { fail("A re-offer of the same version downloads nothing") }, "The receipt still matches the complete manifest identity")
    }

}
