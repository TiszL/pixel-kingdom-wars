package gg.pixelkingdomwars.nativeclient

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** The renderer draws from the same parse that admitted the catalogue, so the bridged tree must be
 * indistinguishable from libGDX's own parse of the same text. */
class JsonValueBridgeTest {
    private val pack = File("src/main/assets/native")
    /** The bundled catalogue is this build's download floor and must be a contract the build admits; a
     * literal here went stale the first time the pack was re-pinned (12 → 13), so read the compatibility file.
     * The newest admitted contract may run ONE step ahead of the bundle while that contract is being
     * introduced (contract 15, the revision-5 realm kit: the exporter and admission landed before the first
     * contract-15 pack could be exported and re-pinned, docs/UPDATE_COMPATIBILITY.md "Renderer contract 15"),
     * never two: the next contract bump owes the bundle re-pin first. */
    private val supportedContracts: List<Int> = Json.parseToJsonElement(File("../native-compatibility.json").readText())
        .jsonObject.getValue("rendererContractVersions").jsonArray.map { it.jsonPrimitive.int }
    private val newestSupportedContract: Int = supportedContracts.max()
    private fun assertBundledContract(bundled: Int?) {
        assertNotNull(bundled); bundled!!
        assertTrue("bundled contract $bundled must be admitted by this build", bundled in supportedContracts)
        assertTrue("bundled contract $bundled may trail the newest admitted contract $newestSupportedContract by at most the one being introduced; re-pin the pack before the next bump",
            newestSupportedContract - bundled <= 1)
    }
    private fun assertSameTree(expected: JsonValue?, actual: JsonValue?, path: String) {
        if (expected == null || actual == null) { assertEquals(path, expected, actual); return }
        assertEquals(path, expected.name, actual.name)
        assertEquals(path, expected.type(), actual.type())
        assertEquals(path, expected.size, actual.size)
        if (expected.isValue) {
            assertEquals(path, expected.asString(), actual.asString())
            if (expected.isNumber) assertEquals(path, expected.asDouble(), actual.asDouble(), 0.0)
        }
        var left = expected.child; var right = actual.child; var index = 0
        while (left != null || right != null) {
            assertSameTree(left, right, "$path/${left?.name ?: index}")
            left = left?.next; right = right?.next; index++
        }
    }
    @Test fun `bridged tree equals a libGDX parse of the published render catalogue and admits it`() {
        val text = pack.resolve("render-catalog.json").readText()
        val bridged = Json.parseToJsonElement(text).toGdx()
        assertSameTree(JsonReader().parse(text), bridged, "")
        RendererCatalogue.validate(bridged)
        assertBundledContract(bridged.getInt("rendererContractVersion"))
    }
    @Test fun `numbers booleans nulls strings and nesting keep their source form`() {
        val text = """{"a":1,"b":-2.5,"c":1e3,"d":true,"e":false,"f":null,"g":"12","h":[1,[2,{"i":"x"}],[]],"j":{},"k":0.1}"""
        val bridged = Json.parseToJsonElement(text).toGdx()
        assertSameTree(JsonReader().parse(text), bridged, "")
        assertEquals("12", bridged.getString("g")); assertTrue(bridged.get("g").isString)
        assertEquals(1000f, bridged.getFloat("c"), 0f); assertEquals("1e3", bridged.get("c").asString())
        assertTrue(bridged.get("f").isNull); assertEquals(0, bridged.get("j").size); assertEquals(2, bridged.get("h").get(1).size)
    }
    @Test fun `bundled manifest header names the same renderer contract as its catalogue`() {
        // Startup trusts this header to set the download floor without parsing the bundled catalogue.
        val manifest = Json.parseToJsonElement(pack.resolve("manifest.json").readText()).jsonObject
        val head = pack.resolve("render-catalog.json").inputStream().use { it.readNBytes(256) }.toString(Charsets.US_ASCII)
        val catalogue = Regex(""""rendererContractVersion"\s*:\s*(\d+)""").find(head)?.groupValues?.get(1)?.toInt()
        assertEquals(catalogue, manifest.getValue("rendererContractVersion").jsonPrimitive.int)
        assertBundledContract(catalogue)
    }
}
