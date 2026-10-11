package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import org.junit.Test
import kotlin.test.*

class RendererCatalogueTest {
    private fun acceptedKitRoot(): JsonValue {
        val root=JsonReader().parse(publishedText())
        root.remove("layeredGroundV5");root.remove("layeredGroundV5Preview")
        val current=root.get("ground").get("currentVisual")
        current.remove("groundRevision");current.addChild("groundRevision",JsonValue(5L))
        current.get("artVersion").set(2L,null)
        val descriptors=JsonValue(JsonValue.ValueType.array)
        for ((index,realm) in root.get("ground").get("realms").withIndex()) {
            val hash=index.toString(16).padStart(64,'0')
            descriptors.addChild(JsonReader().parse("""{"realmId":"${realm.asString()}","sha256":"$hash","manifestPath":"atlas/fantasy/layered-ground/$hash/manifest.json","size":1}"""))
        }
        root.addChild("layeredGroundV5",JsonReader().parse("""{"version":1,"status":"accepted"}""").also { it.addChild("manifests",descriptors) })
        return root
    }

    @Test fun `production kit admission requires accepted coverage without changing historical metadata parsing`() {
        val accepted=acceptedKitRoot()
        RendererCatalogue.validate(accepted)
        RendererCatalogue.requireAcceptedRealmKits(accepted)
        val historical=acceptedKitRoot().also { it.remove("layeredGroundV5") }
        RendererCatalogue.validate(historical)
        assertFailsWith<IllegalArgumentException> { RendererCatalogue.requireAcceptedRealmKits(historical) }
    }

    @Test fun `production refuses absent preview incomplete duplicate and unknown kit realms`() {
        fun rejected(mutate:(JsonValue)->Unit) {
            val root=acceptedKitRoot();mutate(root)
            assertFails { RendererCatalogue.requireAcceptedRealmKits(root) }
        }
        rejected { it.remove("layeredGroundV5") }
        rejected { root -> val section=root.remove("layeredGroundV5");root.addChild("layeredGroundV5Preview",section) }
        rejected { it.get("layeredGroundV5").get("status").set("preview-only") }
        rejected { it.get("layeredGroundV5").get("manifests").remove(0) }
        rejected { it.get("layeredGroundV5").get("manifests").get(0).get("realmId").set("unknown") }
        rejected { r -> val rows=r.get("layeredGroundV5").get("manifests");rows.get(0).get("realmId").set(rows.get(1).getString("realmId")) }
        rejected { root -> val rows=root.get("layeredGroundV5").get("manifests");while(rows.size>0) rows.remove(0) }
    }

    @Test fun `production kit admission retains descriptor integrity and current visual requirements`() {
        fun rejected(mutate:(JsonValue)->Unit) {
            val root=acceptedKitRoot();mutate(root)
            assertFails { RendererCatalogue.requireAcceptedRealmKits(root) }
        }
        rejected { it.get("layeredGroundV5").get("version").set(2L,null) }
        rejected { it.get("layeredGroundV5").get("manifests").get(0).get("sha256").set("bad") }
        rejected { it.get("layeredGroundV5").get("manifests").get(0).get("manifestPath").set("atlas/unrelated.json") }
        rejected { it.get("layeredGroundV5").get("manifests").get(0).remove("size") }
        rejected { it.get("ground").remove("currentVisual") }
        rejected { it.get("ground").get("currentVisual").get("realmId").set("unknown") }
        rejected { it.get("ground").get("currentVisual").get("groundRevision").set(4L,null) }
        rejected { it.get("ground").get("currentVisual").remove("groundRevision") }
        rejected { it.get("ground").get("currentVisual").get("artVersion").set(1L,null) }
    }

    private fun publishedText(): String {
        val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
        return root.resolve("render-catalog.json").readText()
    }
    @Test fun `the APK bundled catalogue passes production kit admission so cold start can complete`() {
        // The APK's own bundle must pass production admission or the app cannot start.
        RendererCatalogue.requireAcceptedRealmKits(JsonReader().parse(publishedText()))
    }
    @Test fun `pinned catalogue admits without graphics or texture construction`() {
        RendererCatalogue.validate(publishedText())
    }
    @Test fun `metadata admission shares combat base wall and static parser failures before a scene is created`() {
        val source=publishedText()
        fun rejected(mutate:(JsonValue)->Unit) {
            val root=JsonReader().parse(source);mutate(root)
            assertFails { RendererCatalogue.validate(root.toJson(JsonWriter.OutputType.json)) }
        }
        rejected { root ->
            val combat=root.get("combatProfiles").first { it.get("howl")!=null }
            combat.get("howl").remove("aim")
        }
        rejected { it.remove("basePresentation") }
        rejected { it.get("walls").remove(0) }
        rejected { it.get("entries").get(0).remove("atlasPath") }
    }
    /** Contract 15 (docs/REALM-KIT-PLAN.md E-8) is additive: a contract-15 pack without the realm kit section is valid
     * (an empty accepted registry exports no section), a present `layeredGroundV5` section must carry hash-addressed
     * descriptors like every layered section, and a contract-14 pack still admits without it. Since P4 the pinned
     * pack (772f5675) is contract 15 and carries its own accepted section for all eight realms, so every case first
     * strips the pinned sections and then installs exactly one: `JsonValue.get` returns the FIRST child of a name, so
     * a malformed section appended after the pinned valid one would never be read and its refusal would prove nothing. */
    @Test fun `contract fifteen admits the pinned pack with or without a realm kit section and refuses malformed descriptors`() {
        val source=publishedText()
        val section=checkNotNull(javaClass.getResourceAsStream("/realm-kit/layeredGroundV5.json")).bufferedReader().readText()
        fun root(mutate:(JsonValue)->Unit={}):JsonValue { val r=JsonReader().parse(source);r.get("rendererContractVersion").set(15L,null);r.remove("layeredGroundV5");r.remove("layeredGroundV5Preview");mutate(r);return r }
        fun admit(mutate:(JsonValue)->Unit={})=RendererCatalogue.validate(root(mutate).toJson(JsonWriter.OutputType.json))
        fun rejected(mutate:(JsonValue)->Unit) { assertFails { admit(mutate) } }
        admit()
        admit { it.addChild("layeredGroundV5",JsonReader().parse(section)) }
        admit { it.addChild("layeredGroundV5Preview",JsonReader().parse(section)) }
        admit { r->r.get("ground").get("currentVisual").get("groundRevision").set(5L,null) } // the r5 painting lives in its own section
        rejected { it.addChild("layeredGroundV5",JsonReader().parse(section).also { s->s.get("version").set(2L,null) }) }
        rejected { it.addChild("layeredGroundV5",JsonReader().parse(section).also { s->s.get("status").set("draft") }) }
        rejected { it.addChild("layeredGroundV5",JsonReader().parse(section).also { s->s.get("manifests").get(0).get("sha256").set("nope") }) }
        rejected { it.addChild("layeredGroundV5",JsonReader().parse(section).also { s->s.get("manifests").get(0).get("manifestPath").set("atlas/fantasy/layered-ground/x/manifest.json") }) }
        rejected { it.addChild("layeredGroundV5",JsonReader().parse(section).also { s->s.get("manifests").get(0).remove("size") }) }
        rejected { it.addChild("layeredGroundV5",JsonReader().parse(section).also { s->s.get("manifests").addChild(JsonReader().parse(s.get("manifests").get(0).toJson(JsonWriter.OutputType.json))) }) }
        rejected { r->r.get("ground").get("currentVisual").get("groundRevision").set(6L,null) }
        // The pinned pack admits as published, with whatever section it carries (since P4, its own accepted kits).
        RendererCatalogue.validate(source)
        // Older packs keep working: contract 14 still admits and never needs the section. The pinned pack is a
        // renderer-15 pack (SIM18 / ae8104ad) carrying `phaseE` metadata and service entries, so merely relabelling it
        // 14 is NOT a historical pack and the unchanged admission guard must refuse it; the historical-14 view is
        // derived explicitly (PhaseEServiceArtTest pattern): validate and remove ONLY the Phase E-tagged entries and the
        // top-level `phaseE`, keep every legacy section, then lower the contract.
        assertFails { RendererCatalogue.validate(root { it.get("rendererContractVersion").set(14L,null) }.toJson(JsonWriter.OutputType.json)) }
        val historical=root()
        val entries=historical.get("entries")
        for(index in entries.size-1 downTo 0) if(entries.get(index).has("phaseE")) { PhaseEServiceArt.entry(entries.get(index));entries.remove(index) }
        historical.remove("phaseE");historical.get("rendererContractVersion").set(14L,null)
        RendererCatalogue.validate(historical.toJson(JsonWriter.OutputType.json))
        assertNull(RendererCatalogue.serviceArt(historical))
    }
}
