package gg.pixelkingdomwars.nativeclient.scene

import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.GroundPresentation
import gg.pixelkingdomwars.nativeclient.renderer.LayeredGroundSource
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import gg.pixelkingdomwars.nativeclient.renderer.RenderServiceIdentity
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** G1 / review 05689289: the new fixture's exact, audited GET /api/base bytes.
 * Missing capture is a failure, never a skipped test or a synthetic replacement.
 * This exercises mapper and renderer admission, not a GL frame or device acceptance. */
class ActualFixtureRendererSmokeTest {
    private val pack = File("src/main/assets/native")
    // The capture's own reviewed renderer-17 Build1R metadata: tracked and hash-pinned, the same files ServiceSceneMapperTest
    // reads (743f1132). The bundle was deliberately replaced tonight by the r12 export (contentVersion abbc0ae2..., renderer
    // 15), which can never equal this capture's pack, so the pins below bind the capture to these files; the ground bytes
    // still come from the bundle and are hash-checked against this metadata's layeredGroundV4 section.
    private val metadata = File("src/test/resources/iw3")
    private val resources = File("src/test/resources/build1r")
    private val hashPattern = Regex("[a-f0-9]{64}")
    private val packPins = mapOf(
        "manifest.json" to "7ce8c43ec191e9b6ba7be4d3b399c46acc3913c3ef1f06ef16209472483c981c",
        "catalogue.json" to "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2",
        "render-catalog.json" to "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133",
    )
    private data class Seed(val type: String, val x: Int, val y: Int)
    // fleet-journey-browser.ts facility(...) calls. The fixture also has a keep
    // and an existing vehicle berth, so neither total count nor berth uniqueness is assumed.
    private val seeds = listOf(Seed("workshop", 9, 10), Seed("market", 19, 10),
        Seed("lodge", 9, 18), Seed("berth", 17, 18))

    private fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
    private fun read(root: File, path: String, maximum: Int): ByteArray {
        require(path.split('/').all { it.isNotEmpty() && it != "." && it != ".." && !it.contains('\\') && !it.contains(':') })
        val base = root.canonicalFile
        val file = base.resolve(path).canonicalFile
        require(file.toPath().startsWith(base.toPath()) && file.isFile && file.length() in 1..maximum.toLong()) {
            "G1 required local input is missing or exceeds its bound"
        }
        return file.readBytes().also { require(it.size in 1..maximum) { "G1 input changed size while reading" } }
    }
    private fun parse(bytes: ByteArray): JsonObject = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
    private fun text(value: JsonObject, key: String): String {
        val field = requireNotNull(value[key] as? JsonPrimitive) { "G1 evidence field is missing" }
        require(field.isString) { "G1 evidence string has the wrong type" }
        return field.content
    }
    private fun number(value: JsonObject, key: String): Int {
        val field = requireNotNull(value[key] as? JsonPrimitive) { "G1 numeric field is missing" }
        require(!field.isString) { "G1 number has the wrong type" }
        return requireNotNull(field.intOrNull) { "G1 integer is invalid" }
    }
    private fun bool(value: JsonObject, key: String): Boolean {
        val field = requireNotNull(value[key] as? JsonPrimitive) { "G1 audit field is missing" }
        require(!field.isString) { "G1 audit boolean has the wrong type" }
        return requireNotNull(field.booleanOrNull) { "G1 audit boolean is invalid" }
    }

    @Test fun `actual Build1R fixture maps seeded services and resolves its bundled ground`() {
        val bodyBytes = read(resources, "base.json", 4 * 1024 * 1024)
        val evidence = parse(read(resources, "base-evidence.json", 64 * 1024))
        assertEquals("build1r-actual-base/v1", text(evidence, "schema"))
        Instant.parse(text(evidence, "capturedAtUtc"))
        require(text(evidence, "runId").matches(Regex("[A-Za-z0-9_-]{1,160}"))) { "G1 run identity is invalid" }
        require(text(evidence, "fixtureSourceCommit").matches(Regex("[a-f0-9]{40}"))) { "G1 fixture source is not pinned" }
        for (key in listOf("qaManifestSha256", "readySha256", "bodySha256", "packManifestSha256", "catalogueSha256", "renderCatalogueSha256"))
            require(text(evidence, key).matches(hashPattern)) { "G1 evidence hash is invalid" }
        assertEquals("G1 body differs from the captured response", text(evidence, "bodySha256"), sha(bodyBytes))
        val audit = evidence.getValue("secretAudit").jsonObject
        assertTrue("G1 requires a completed secret audit", bool(audit, "passed"))
        assertFalse("A redacted body is not the actual fixture response", bool(audit, "redacted"))
        val request = evidence.getValue("request").jsonObject
        assertEquals("GET", text(request, "method")); assertEquals("/api/base", text(request, "path"))
        assertEquals(200, number(request, "status")); assertEquals(17, number(request, "rendererContractVersion"))
        assertEquals(18, number(request, "simVersion"))
        val body = parse(bodyBytes)
        assertEquals("G1 capture belongs to a different base", text(request, "baseId"), text(body, "baseId"))

        val manifestBytes = read(metadata, "manifest.json", 1024 * 1024)
        val catalogueBytes = read(metadata, "catalogue.json", 2 * 1024 * 1024)
        val renderBytes = read(metadata, "render-catalog.json", 16 * 1024 * 1024)
        for ((file, bytes, evidenceKey) in listOf(
            Triple("manifest.json", manifestBytes, "packManifestSha256"),
            Triple("catalogue.json", catalogueBytes, "catalogueSha256"),
            Triple("render-catalog.json", renderBytes, "renderCatalogueSha256"),
        )) {
            assertEquals("G1 requires the exact reviewed Build1R pack metadata", packPins.getValue(file), sha(bytes))
            assertEquals("G1 capture and bundled pack disagree", packPins.getValue(file), text(evidence, evidenceKey))
        }
        val manifest = parse(manifestBytes)
        assertEquals(17, number(manifest, "rendererContractVersion")); assertEquals(18, number(manifest, "simVersion"))
        val catalogue = parse(catalogueBytes); val render = parse(renderBytes)
        assertEquals(17, number(render, "rendererContractVersion")); assertEquals(18, number(catalogue, "simVersion"))
        val rendererRoot = JsonReader().parse(renderBytes.toString(Charsets.UTF_8))
        RendererCatalogue.validate(rendererRoot)
        assertNotNull("The bundled renderer must admit the real service graph", RendererCatalogue.serviceArt(rendererRoot))
        val scene = SceneMapper(catalogue, render).baseScene(body)
        assertTrue("G1 must produce a non-empty scene", scene.buildings.isNotEmpty())
        assertEquals(true, scene.services.phaseEArtEnabled)
        val wireBuildings = body.getValue("buildings").jsonArray.map { it.jsonObject }
        val entries = render.getValue("entries").jsonArray.map { it.jsonObject }
        for (seed in seeds) {
            val wire = wireBuildings.single { text(it, "type") == seed.type && number(it, "tx") == seed.x && number(it, "ty") == seed.y }
            assertEquals("Seeded service must be level 1", 1, number(wire, "level"))
            val placed = scene.buildings.single { it.id == text(wire, "id") }
            val entry = entries.single { text(it, "type") == seed.type && number(it, "level") == 1 }
            val identity = PhaseEServiceArt.entry(JsonReader().parse(entry.toString()))
            assertEquals(RenderServiceIdentity(seed.type, if (seed.type == "berth") null else 1), identity)
            assertEquals("G1 must preserve authentic service art identity", identity, placed.service)
            assertEquals(seed.type, placed.type); assertEquals(1, placed.level)
            assertEquals(seed.x.toFloat(), placed.tileX, 0f); assertEquals(seed.y.toFloat(), placed.tileY, 0f)
            assertEquals(2f, placed.footprintWidth, 0f); assertEquals(2f, placed.footprintHeight, 0f)
            assertFalse("Seeded completed service must not remain construction art", placed.underConstruction)
        }

        val visual = requireNotNull(scene.visual) { "G1 actual visual context is absent" }
        assertEquals("Native layered terrain requires art version 2", 2, visual.artVersion)
        assertEquals("Build1R private fixture must present ground revision 4", 4, visual.groundRevision)
        val ground = GroundPresentation(requireNotNull(rendererRoot.get("ground")))
        val section = requireNotNull(rendererRoot.get("layeredGroundV4")) { "G1 ground revision has no bundled section" }
        // NativeGameRenderer's real revision-4 reader verifies the selected realm's
        // manifest bytes/hash and parses LayeredRealmGround; key presence is insufficient.
        val source = LayeredGroundSource.read(section, visual.realmId, ground.realms.toSet(), false) { path, maximum -> read(pack, path, maximum) }
        assertEquals(visual.realmId, source.rules.realmId)
        assertEquals("accepted", source.rules.status)
        assertEquals("Native layered ground requires a composed painting", "world", source.rules.sampling)
        assertEquals(visual.groundRevision, source.rules.groundRevision)
        assertTrue("G1 resolved ground must carry artwork", source.rules.assets.isNotEmpty())
        for (asset in source.rules.assets.values) {
            require(asset.size in 1..Int.MAX_VALUE.toLong()) { "G1 ground asset exceeds the bounded reader" }
            val bytes = read(pack, asset.path, asset.size.toInt())
            assertEquals("G1 ground asset size differs", asset.size, bytes.size.toLong())
            assertEquals("G1 ground asset hash differs", asset.sha256, sha(bytes))
        }
    }
}
