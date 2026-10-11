package gg.pixelkingdomwars.nativeclient.network

import java.security.MessageDigest
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class NativeContentManifestTest {
    private fun manifest(sim: Int = 14): JsonObject {
        val files = buildJsonArray {
            listOf("atlas/meta.json","catalogue.json","contracts.json","kotlin/NativeContracts.kt","render-catalog.json").forEach { path ->
                add(buildJsonObject { put("path",path);put("sha256","b".repeat(64));put("size",1);put("tier","core") })
            }
        }
        val identity = buildJsonObject { put("schemaVersion",1);put("sourceCommit","a".repeat(40));put("simVersion",sim);put("files",files) }
        return buildJsonObject {
            identity.forEach { (k,v) -> put(k,v) }
            put("contentVersion",MessageDigest.getInstance("SHA-256").digest(identity.toString().toByteArray()).joinToString("") { "%02x".format(it) })
            put("cataloguePath","catalogue.json");put("renderCataloguePath","render-catalog.json")
            put("atlasMetadataPath","atlas/meta.json");put("contractPath","contracts.json");put("kotlinModelsPath","kotlin/NativeContracts.kt")
        }
    }
    @Test fun `compatible data update needs no new APK`() {
        assertEquals(5,nativeContentManifest(manifest(),14).files.size)
    }
    @Test fun `unreviewed simulation update cannot silently replace the current client content`() {
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(manifest(),15) }
    }
    @Test fun `reviewed SIM15 content still requires an exact live version match`() {
        // Archived event support must not silently broaden live content admission.
        assertEquals(15,nativeContentManifest(manifest(15),15).simVersion)
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(manifest(15),14) }
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(manifest(16),15) }
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(manifest(14),15) }
    }
    @Test fun `changed content descriptors and redirected metadata are rejected`() {
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(JsonObject(manifest()+ ("contentVersion" to JsonPrimitive("c".repeat(64)))),14) }
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(JsonObject(manifest()+ ("cataloguePath" to JsonPrimitive("another.json"))),14) }
    }
    @Test fun `private SIM18 admission does not broaden live SIM17 or future protocol compatibility`() {
        assertEquals(18,nativeContentManifest(manifest(18),18).simVersion)
        assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(manifest(18),17) }
        for(other in listOf(17,19)) assertThrows(IllegalArgumentException::class.java) { nativeContentManifest(manifest(other),18) }
    }
    @Test fun `content cannot cross origins or use credentials redirects and cleartext`() {
        val origin = "https://game.example".toHttpUrl()
        assertEquals(origin.resolve("/native-content/manifest.json"),sameOriginContentUrl(origin,origin.resolve("/native-content/manifest.json")!!))
        listOf("http://game.example/pack","https://other.example/pack","https://game.example:8443/pack","https://user:secret@game.example/pack","https://game.example/pack?redirect=1").forEach { bad ->
            assertThrows(IllegalArgumentException::class.java) { sameOriginContentUrl(origin,bad.toHttpUrl()) }
        }
    }
}
