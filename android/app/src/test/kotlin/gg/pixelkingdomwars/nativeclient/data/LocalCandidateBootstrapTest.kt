package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.content.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LocalCandidateBootstrapTest {
    @get:Rule val temp = TemporaryFolder()
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private data class Fixture(val root: File, val directory: File, val bytes: ByteArray, val manifest: NativeContentManifest)
    private fun fixture(): Fixture {
        val root = temp.newFolder().canonicalFile
        val payloads = listOf("catalogue.json", "render-catalog.json", "atlas/meta.json", "contracts.json", "kotlin/NativeContracts.kt", "optional/frame.png")
            .associateWith { it.toByteArray() }
        val files = buildJsonArray { payloads.toSortedMap().forEach { (path, bytes) -> add(buildJsonObject {
            put("path", path); put("sha256", hash(bytes)); put("size", bytes.size); put("tier", if(path.startsWith("optional/")) "optional" else "core")
        }) } }
        val identity = buildJsonObject { put("schemaVersion",1); put("sourceCommit","a".repeat(40)); put("simVersion",18); put("files",files) }
        val raw = JsonObject(identity + buildJsonObject {
            put("contentVersion",hash(identity.toString().toByteArray())); put("rendererContractVersion",15)
            put("cataloguePath","catalogue.json"); put("renderCataloguePath","render-catalog.json"); put("atlasMetadataPath","atlas/meta.json")
            put("contractPath","contracts.json"); put("kotlinModelsPath","kotlin/NativeContracts.kt")
        })
        val manifest = nativeContentManifest(raw,18)
        val storeRoot = File(root,storageNamespace("https://127.0.0.1:18443","content-updates"))
        val store = ContentStore(storeRoot, verifier="prior-stamp")
        val directory = store.install(ContentManifest(1,manifest.sourceCommit,manifest.contentVersion,
            manifest.files.map { ContentFile(it.path,it.sha256,it.size,it.tier) })) { payloads.getValue(it.path).inputStream() }
        return Fixture(root,directory,raw.toString().toByteArray(),manifest)
    }
    private fun rejects(block:()->Unit) { try { block(); fail("Expected refusal") } catch(expected: IllegalArgumentException) {} catch(expected: IllegalStateException) {} }

    @Test fun `only exact debug emulator account environment is admitted`() {
        fun check(debug:Boolean=true, id:String="gg.pixelkingdomwars.twa.debug", hardware:String="ranchu", mode:LaunchMode=LaunchMode.ACCOUNT,
                  build:String="https://127.0.0.1:18443", origin:String=build) = requireLocalCandidateEnvironment(debug,id,hardware,mode,build,origin)
        check()
        rejects { check(debug=false) }; rejects { check(id="gg.pixelkingdomwars.twa") }; rejects { check(hardware="seeker") }
        rejects { check(mode=LaunchMode.OFFLINE_BASE) }; rejects { check(build="https://localhost:18443") }
        rejects { check(origin="https://127.0.0.1:18444") }
    }
    @Test fun `candidate claim refuses duplicate late startup and failed fallback`() {
        val candidate=LocalCandidateStartup(); candidate.candidateStartup()
        rejects { candidate.candidateStartup() }; rejects { candidate.normalStartup() }
        val normal=LocalCandidateStartup(); normal.normalStartup(); normal.normalStartup(); rejects { normal.candidateStartup() }
    }
    @Test fun `retains exact full manifest while optional files remain uninstalled`() {
        val f=fixture(); retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)).use {
            assertEquals(f.manifest,it.manifest); assertFalse(File(f.directory,"optional/frame.png").exists())
        }
        assertFalse(File(f.directory.parentFile,"active").exists())
    }
    @Test fun `wrong host pin or mutated bytes cannot select existing generation`() {
        val f=fixture(); rejects { retainLocalCandidate(f.root,f.directory,f.bytes,"0".repeat(64)) }
        rejects { retainLocalCandidate(f.root,f.directory,f.bytes + 0,hash(f.bytes)) }
    }
    @Test fun `different root and symlink generation refuse before admission`() {
        val f=fixture(); rejects { retainLocalCandidate(temp.newFolder().canonicalFile,f.directory,f.bytes,hash(f.bytes)) }
        val link=File(f.directory.parentFile,"linked"); java.nio.file.Files.createSymbolicLink(link.toPath(),f.directory.toPath())
        rejects { retainLocalCandidate(f.root,link,f.bytes,hash(f.bytes)) }
    }
    @Test fun `trusted Android context ancestor alias retains exact child generation`() {
        val f=fixture(); val alias=File(temp.newFolder().canonicalFile,"context-parent")
        java.nio.file.Files.createSymbolicLink(alias.toPath(),f.root.toPath())
        val directory=File(File(alias,f.directory.parentFile.name),f.directory.name)
        assertNotEquals(alias.absoluteFile,alias.canonicalFile)
        retainLocalCandidate(alias,directory,f.bytes,hash(f.bytes)).use { assertEquals(f.manifest,it.manifest) }
        // A different lexical parent cannot substitute for the trusted Context spelling.
        rejects { retainLocalCandidate(alias,f.directory,f.bytes,hash(f.bytes)) }
    }
    @Test fun `owned root symlink remains refused despite matching trusted parent`() {
        val f=fixture(); val root=f.directory.parentFile; val moved=File(f.root,"other-root")
        check(root.renameTo(moved)); java.nio.file.Files.createSymbolicLink(root.toPath(),moved.toPath())
        rejects { retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)) }
    }
    @Test fun `same named generation symlink cannot borrow an admitted directory`() {
        val f=fixture(); val moved=File(f.directory.parentFile,"other-generation")
        check(f.directory.renameTo(moved)); java.nio.file.Files.createSymbolicLink(f.directory.toPath(),moved.toPath())
        rejects { retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)) }
    }
    @Test fun `fresh verifier catches same length tamper despite a retained old stamp`() {
        val f=fixture(); val file=File(f.directory,"catalogue.json"); val time=file.lastModified()
        file.writeBytes(ByteArray(file.length().toInt()) { 42 }); check(file.setLastModified(time))
        rejects { retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)) }
    }
    @Test fun `different retained provenance is rejected even with same file bytes`() {
        val f=fixture(); val receipt=File(f.directory,".verified")
        val bytes=receipt.readBytes(); val old="a".repeat(40).toByteArray(); val at=bytes.indices.first { i -> i+old.size<=bytes.size && bytes.copyOfRange(i,i+old.size).contentEquals(old) }
        "b".repeat(40).toByteArray().copyInto(bytes,at); receipt.writeBytes(bytes)
        rejects { retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)) }
    }
    @Test fun `cancellation after rehash does not prevent a later verified retain`() {
        val f=fixture(); var calls=0
        try { retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)) { if(++calls==2) throw CancellationException() }; fail() }
        catch(expected: CancellationException) {}
        retainLocalCandidate(f.root,f.directory,f.bytes,hash(f.bytes)).use { assertEquals(f.manifest,it.manifest) }
    }
    @Test fun `headers bind source sim and renderer before publication`() {
        val f=fixture()
        val catalogue=buildJsonObject { put("schemaVersion",1); put("sourceCommit",f.manifest.sourceCommit); put("simVersion",18) }
        val render=buildJsonObject { put("schemaVersion",1); put("rendererContractVersion",15) }
        validateLocalCandidateHeaders(catalogue,render,f.manifest)
        rejects { validateLocalCandidateHeaders(JsonObject(catalogue + ("simVersion" to JsonPrimitive(17))),render,f.manifest) }
        rejects { validateLocalCandidateHeaders(JsonObject(catalogue + ("sourceCommit" to JsonPrimitive("b".repeat(40)))),render,f.manifest) }
        rejects { validateLocalCandidateHeaders(catalogue,JsonObject(render + ("rendererContractVersion" to JsonPrimitive(14))),f.manifest) }
    }
}
