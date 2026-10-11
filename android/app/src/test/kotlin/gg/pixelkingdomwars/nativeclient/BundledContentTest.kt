package gg.pixelkingdomwars.nativeclient

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class BundledContentTest {
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private class Pack(val manifest: ByteArray,val files: Map<String,ByteArray>)
    private fun pack(marker: String): Pack {
        val files = sortedMapOf("atlas/meta.json" to marker.toByteArray(),"catalogue.json" to "{}".toByteArray(),
            "contracts.json" to "{}".toByteArray(),"kotlin/NativeContracts.kt" to "// provenance".toByteArray(),
            "render-catalog.json" to "{}".toByteArray(),"fixtures/base.json" to "fixture".toByteArray())
        val entries = buildJsonArray { files.forEach { (path,bytes) -> add(buildJsonObject {
            put("path",path);put("sha256",hash(bytes));put("size",bytes.size);put("tier",if(path.startsWith("fixtures/")) "optional" else "core")
        }) } }
        val identity = buildJsonObject { put("schemaVersion",1);put("sourceCommit","a".repeat(40));put("simVersion",14);put("files",entries) }
        val manifest = buildJsonObject {
            identity.forEach { (key,value) -> put(key,value) };put("contentVersion",hash(identity.toString().toByteArray()))
            put("cataloguePath","catalogue.json");put("renderCataloguePath","render-catalog.json");put("atlasMetadataPath","atlas/meta.json")
            put("contractPath","contracts.json");put("kotlinModelsPath","kotlin/NativeContracts.kt")
        }.toString().toByteArray()
        return Pack(manifest,files)
    }
    private fun prepare(root: File,pack: Pack,debug: Boolean = false,full: Boolean = false,verifier: String = "",onLoad: ((ContentLoadSample)->Unit)? = null) =
        BundledContent.prepare(root,pack.manifest,debug,onLoad,verifier,full) { pack.files.getValue(it).inputStream() }
    private fun temporary(block: (File)->Unit) {
        val root = Files.createTempDirectory("bundled-content-test").toFile()
        try { block(root) } finally { root.deleteRecursively() }
    }
    @Test fun `a complete marker cannot hide missing or corrupt APK content`() = temporary { root ->
        val pack = pack("canonical")
        val directory = prepare(root,pack)
        File(directory,".complete").writeText("ok")
        File(directory,"atlas/meta.json").writeText("corruption")
        File(directory,"contracts.json").delete()
        assertEquals(directory,prepare(root,pack))
        assertEquals("canonical",File(directory,"atlas/meta.json").readText())
        assertTrue(File(directory,"contracts.json").isFile)
    }
    // Rewritten for the startup trust model: debug fixtures are extracted but never hashed at launch.
    // The offline preview that reads them verifies them, and an explicit full verification repairs them.
    @Test fun `a resumed extraction removes dead staging and extracts debug fixtures without hashing them at launch`() = temporary { root ->
        val abandoned = File(root,"bundled-staging-00000000-0000-0000-0000-000000000000").apply { mkdir() }
        File(abandoned,"partial").writeText("orphan")
        val pack = pack("art")
        val release = prepare(root,pack)
        assertFalse(abandoned.exists()); assertFalse(File(release,"fixtures/base.json").exists())
        val debug = prepare(root,pack,true)
        assertEquals("fixture",File(debug,"fixtures/base.json").readText())
        assertEquals("An already stamped bundle still gains its fixtures for a debug launch",debug,release)
        File(debug,"fixtures/base.json").writeText("fixturf") // same size: the launch stat check passes
        val samples = mutableListOf<ContentLoadSample>()
        assertEquals("fixturf",File(prepare(root,pack,true,onLoad={ samples.add(it);Unit }),"fixtures/base.json").readText())
        assertEquals("Launch trusts the core stamp and hashes nothing",listOf(ContentLoadStage.BUNDLE_TRUST),samples.map { it.stage })
        assertTrue("The preview that reads fixtures hashes them",runCatching { BundledContent.verifyFixtures(debug) }.isFailure)
        assertEquals("fixture",File(prepare(root,pack,true,full=true),"fixtures/base.json").readText())
        BundledContent.verifyFixtures(debug)
        File(debug,"fixtures/base.json").delete()
        assertEquals("A missing fixture is noticed by stat and re-extracted","fixture",File(prepare(root,pack,true),"fixtures/base.json").readText())
    }
    @Test fun `a stamped bundle is trusted by stat check and re-hashed only after an APK build change or a changed file`() = temporary { root ->
        val pack = pack("stamped")
        val samples = mutableListOf<ContentLoadSample>()
        val sink: (ContentLoadSample)->Unit = { samples.add(it);Unit }
        fun stages() = samples.map { it.stage to it.succeeded }.also { samples.clear() }
        val directory = prepare(root,pack,verifier="build-1",onLoad=sink)
        assertEquals("Extraction hashes while copying and needs no separate verification",listOf(ContentLoadStage.BUNDLE_EXTRACT to true),stages())
        assertEquals(directory,prepare(root,pack,verifier="build-1",onLoad=sink))
        assertEquals("The next launch of the same build only stats",listOf(ContentLoadStage.BUNDLE_TRUST to true),stages())
        assertEquals(directory,prepare(root,pack,verifier="build-2",onLoad=sink))
        assertEquals("A new APK build re-hashes once",listOf(ContentLoadStage.BUNDLE_TRUST to false,ContentLoadStage.BUNDLE_VERIFY to true),stages())
        assertEquals(directory,prepare(root,pack,verifier="build-2",onLoad=sink))
        assertEquals(listOf(ContentLoadStage.BUNDLE_TRUST to true),stages())
        assertEquals(directory,prepare(root,pack,verifier="build-2",full=true,onLoad=sink))
        assertEquals("An explicit full verification never consults the stamp",listOf(ContentLoadStage.BUNDLE_VERIFY to true),stages())
        File(directory,"atlas/meta.json").writeText("stampedx")
        assertEquals(directory,prepare(root,pack,verifier="build-2",onLoad=sink))
        assertEquals("A changed file fails the stat check, then the hash, then repairs",
            listOf(ContentLoadStage.BUNDLE_TRUST to false,ContentLoadStage.BUNDLE_VERIFY to false,ContentLoadStage.BUNDLE_EXTRACT to true),stages())
        assertEquals("stamped",File(directory,"atlas/meta.json").readText())
    }
    @Test fun `cleanup retains current previous and every active renderer until disposal`() = temporary { root ->
        val first = prepare(root,pack("first"))
        val scene = requireNotNull(BundledContent.acquire(first))
        prepare(root,pack("second")); prepare(root,pack("third")); val fourthPack = pack("fourth")
        val fourth = prepare(root,fourthPack)
        assertTrue(first.isDirectory)
        assertEquals(3,root.listFiles()!!.count { it.name.matches(Regex("bundled-[a-f0-9]{64}")) })
        scene.close();scene.close()
        prepare(root,fourthPack)
        assertFalse(first.exists());assertTrue(fourth.isDirectory)
        assertEquals(2,root.listFiles()!!.count { it.name.matches(Regex("bundled-[a-f0-9]{64}")) })
    }
    @Test fun `corrupt assets used by an active renderer are preserved until restart or release`() = temporary { root ->
        val pack = pack("first"); val directory = prepare(root,pack)
        val scene = requireNotNull(BundledContent.acquire(directory))
        File(directory,"atlas/meta.json").writeText("broken")
        assertTrue(runCatching { prepare(root,pack) }.isFailure)
        assertTrue(directory.exists())
        scene.close()
        assertEquals("first",File(prepare(root,pack),"atlas/meta.json").readText())
    }
}
