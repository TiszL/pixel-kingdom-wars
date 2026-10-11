package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import org.junit.Test
import kotlin.test.*

/** Renderer16 bound-cosmetics extension against the ACTUAL exported candidate
 *  (test-fixtures/candidate-6f7a9e81-sim18-r16-cosmetics, the tracked exact copy): closed parse, union with
 *  the renderer15 service graph, Awning selection by exact binding equality and
 *  completed tier, and every refusal that keeps ordinary Market art. Metadata
 *  only: no files are opened and nothing claims installed pixels. */
class PhaseECosmeticArtTest {
    private fun root(): JsonValue = JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())
    private fun cosmeticFixture(): JsonValue = root().get("boundCosmetics")
    private fun art(): PhaseEServiceArt = requireNotNull(RendererCatalogue.serviceArt(root()))
    private fun reject(mutate: (JsonValue) -> Unit) { val raw = cosmeticFixture(); mutate(raw); assertFails { PhaseECosmeticArt.parse(raw) } }
    private fun market(level: Int, tier: Int, id: String = "market-id") = RenderBuilding(id, "service:market:$level", 4f, 4f, 2f, 2f,
        type = "market", level = level, service = RenderServiceIdentity("market", tier))
    private fun binding(art: PhaseEServiceArt, tier: Int) = requireNotNull(art.cosmetics).bindings.getValue("artisan_market_awning_t$tier")
    private fun awning(art: PhaseEServiceArt, tier: Int, id: String = "market-id", outputTier: Int = tier,
        sha: String? = null, manifest: String? = null, index: String? = null): RenderMarketAwning {
        val b = binding(art, tier)
        return RenderMarketAwning(id, "artisan_market_awning_t$outputTier", sha ?: b.sha256, manifest ?: b.sourceManifestSha256, index ?: b.sourceIndexSha256)
    }
    private fun facts(vararg awnings: RenderMarketAwning?) = RenderServiceFacts(true, emptyList(), emptyList(), awnings.toList().takeIf { it.isNotEmpty() }?.filterNotNull())

    @Test fun `exported candidate is renderer16 with the closed Awning extension attached to the untouched service graph`() {
        val candidate = CosmeticsCandidateFixture.root.resolve("render-catalog.json.gz")
        assertTrue(candidate.isFile, "tracked candidate fixture exists: ${candidate.path}")
        val r = root(); assertEquals(16, r.getInt("rendererContractVersion"))
        val graph = art(); val cosmetics = assertNotNull(graph.cosmetics)
        // Renderer15 closure untouched underneath, plus the extension.
        // 30 table clips describe the group; the four `ready` entries alias their idle cell and
        // become compositions, so 26 clips own cells (132 cells in one group).
        assertEquals(49 + 4, graph.appearances.size); assertEquals(138 + 26, graph.clips.size); assertEquals(46 + 1, graph.groups.size)
        assertEquals(4, cosmetics.appearances.size); assertEquals(26, cosmetics.clips.size); assertEquals(4, cosmetics.bindings.size)
        assertEquals(132, cosmetics.clips.values.sumOf { it.frames.size })
        assertFalse("pe_cos_market_t1_ready" in cosmetics.clips)
        assertEquals(listOf("artisan_market_awning_t1", "artisan_market_awning_t2", "artisan_market_awning_t3", "artisan_market_awning_t4"), cosmetics.bindings.keys.toList())
        assertFalse("aurora_wake" in cosmetics.bindings, "the wake is described for closure only, never exposed as a binding")
        assertFalse(cosmetics.appearances.keys.any { it.contains("wake") })
        val t1 = cosmetics.appearances.getValue("awning-t1")
        assertEquals("market", t1.facility); assertEquals(1, t1.tier)
        assertEquals(setOf("idle", "damaged", "destroyed", "working", "construction", "collapse", "ready"), t1.states.keys)
        assertEquals(ServiceArtState.Still("pe_cos_market_t1_idle_f1"), t1.states["idle"])
        assertEquals(ServiceArtState.Still("pe_cos_market_t1_destroyed_f1"), t1.states["destroyed"])
        assertEquals(ServiceArtState.Composition(listOf(ServiceStateRef("awning-t1", "idle")), ServicePoint(24f, 0f), "pe_cos_ready_fx"), t1.states["ready"])
        // Same seat as the ordinary Market: full-cell bottom, drawScale 1, deed 0.5, contact preserved unapplied.
        val market = graph.appearances.getValue("market-t1").geometry
        assertEquals(market.cell, t1.geometry.cell); assertEquals(market.drawScale, t1.geometry.drawScale); assertEquals(market.deedScale, t1.geometry.deedScale)
        assertEquals(market.horizontalPivot, t1.geometry.horizontalPivot); assertEquals(market.cellBottom, t1.geometry.cellBottom)
        assertEquals(ServicePoint(56f, 104f), t1.geometry.sourcePivot); assertEquals(104f, t1.geometry.contactLine)
        assertEquals("pe_cosmetics", graph.groupFor("pe_cos_market_t4_collapse_f9").id)
        assertEquals("pe_cosmetics", graph.groupFor("pe_cos_ready_fx_f8").id)
        val working = graph.clips.getValue("pe_cos_market_t2_working"); assertEquals(8, working.frames.size); assertTrue(working.loop); assertEquals(8f, working.fps)
        assertEquals(ServiceReducedMotion.Frame(0), working.reducedMotion)
        assertEquals(1, graph.clips.getValue("pe_cos_market_t3_idle").frames.size)
        assertEquals(cosmetics.group, graph.groups.getValue("pe_cosmetics"))
        assertEquals(2, cosmetics.group.files.size)
        assertTrue(cosmetics.sourceManifestSha256.matches(Regex("[0-9a-f]{64}")) && cosmetics.sourceCommit?.length == 40)
        // The admitted constants slice: the shared queue limit, never a native literal.
        assertEquals(CosmeticRules(1, "PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase"), cosmetics.rules)
    }

    @Test fun `constants slice is optional but closed so a missing or foreign queue rule is refused and absence leaves rules null`() {
        val withoutConstants = cosmeticFixture(); withoutConstants.remove("constants")
        assertNull(PhaseECosmeticArt.parse(withoutConstants).rules)
        reject { it.get("constants").get("queue").get("maxConcurrentPerBase").set(0L, null) }
        reject { it.get("constants").get("queue").get("source").set("PHASE_E_BOUND_COSMETICS.maxConcurrentPerBase") }
        reject { it.get("constants").remove("queue") }
        reject { it.get("constants").get("PHASE_E_BOUND_COSMETICS").get("v1").get("recipes").get("craft_artisan_market_awning_t2_v1").get("facility").set("lodge") }
        reject { it.get("constants").get("PHASE_E_BOUND_COSMETICS").get("v1").get("recipes").remove("craft_artisan_market_awning_t4_v1") }
    }

    @Test fun `omitted duplicated foreign or rewritten inventories bindings and pins are refused whole`() {
        reject { it.get("metadata").get("peCosmetics").get("clips").remove("pe_cos_market_t1_collapse") }
        reject { it.get("metadata").get("peCosmetics").get("clips").addChild("pe_market_t1_idle", JsonValue(JsonValue.ValueType.`object`)) }
        reject { it.get("metadata").get("peCosmetics").get("clips").get("pe_cos_market_t1_working").get("frames").get(0).get("key").set("pe_cos_market_t1_working_f0") }
        reject { it.get("metadata").get("peCosmetics").get("clips").get("pe_cos_market_t1_ready").get("alias").set("pe_cos_market_t1_damaged") }
        reject { it.get("metadata").get("peCosmetics").get("clips").get("pe_cos_market_t1_ready").get("overlay").get("clip").set("pe_fx_craft-success") }
        reject { it.get("metadata").get("peCosmetics").get("clips").get("pe_cos_market_t1_idle").get("anchorPx").get(1).set(104L, null) }
        reject { it.get("metadata").get("peCosmetics").get("clips").get("pe_cos_market_t2_working").get("reducedMotionFrame").set(8L, null) }
        reject { it.get("metadata").get("peCosmetics").get("clips").get("pe_cos_market_t1_idle").get("frames").get(0).get("rgbaSha256").set("B".repeat(64)) }
        reject { it.get("metadata").get("peCosmetics").get("bindings").remove("artisan_market_awning_t4") }
        reject { it.get("metadata").get("peCosmetics").get("bindings").get("artisan_market_awning_t2").get("value").get("sourceManifestSha256").set("f".repeat(64)) }
        reject { it.get("metadata").get("peCosmetics").get("bindings").get("artisan_market_awning_t3").get("sha256").set("nope") }
        reject { it.get("metadata").get("peCosmetics").get("bindings").get("artisan_market_awning_t1").get("value").get("outputId").set("artisan_market_awning_t2") }
        reject { it.get("groups").get(0).get("id").set("pe_market_t1") }
        reject { it.get("groups").get(0).get("files").get(1).get("sha256").set("A".repeat(64)) }
        reject { it.get("groups").get(0).get("decodedBytes").set(4096L * 4096 * 4 + 4, null) }
        reject { it.get("awnings").addChild(JsonValue("aurora_wake")) }
        reject { it.get("version").set(2L, null) }
    }

    @Test fun `a renderer15 pack cannot carry the extension and a renderer16 pack cannot omit it`() {
        val r = root()
        r.get("rendererContractVersion").set(15L, null)
        assertFails { RendererCatalogue.serviceArt(r) }
        r.remove("boundCosmetics")
        assertNotNull(RendererCatalogue.serviceArt(r)).let { assertNull(it.cosmetics) }
        r.get("rendererContractVersion").set(16L, null)
        assertFails { RendererCatalogue.serviceArt(r) }
        r.get("rendererContractVersion").set(17L, null)
        assertFails { RendererCatalogue.serviceArt(r) }
        // Whole-catalogue admission of the candidate: no textures, no files.
        RendererCatalogue.validate(root())
    }

    @Test fun `an admitted Awning draws its own states at the Market seat and everything else stays ordinary`() {
        val graph = art()
        val plan = selectServicePlan(graph, market(1, 1), "crownlands", facts(awning(graph, 1)), true, false, null, null).plan
        assertNotNull(plan); assertEquals("awning-t1:idle:false", plan.signature)
        assertEquals(listOf("pe_cos_market_t1_idle_f1"), plan.layers.single().frames); assertEquals(setOf("pe_cosmetics"), plan.groups)
        assertEquals(ServicePoint(.5f, 1f), plan.layers.single().origin); assertEquals(1f, plan.layers.single().scale)
        // Combat states of the Awning family.
        val damaged = selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1)), true, false, null, ServiceCombatState.DAMAGED).plan
        assertEquals(listOf("pe_cos_market_t1_damaged_f1"), damaged?.layers?.single()?.frames)
        val collapse = selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1)), true, false, null, ServiceCombatState.COLLAPSE).plan
        assertNotNull(collapse); assertEquals(9, collapse.layers.single().frames.size)
        assertEquals(listOf("pe_cos_market_t1_destroyed_f1"), collapse.terminal?.layers?.single()?.frames, "collapse rests on the pack's own rubble cell")
        val destroyed = selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1)), true, false, null, ServiceCombatState.DESTROYED).plan
        assertEquals(listOf("pe_cos_market_t1_destroyed_f1"), destroyed?.layers?.single()?.frames)
        // Reduced motion rests on the authored frame 0 of every state.
        val reduced = selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1)), true, true, null, ServiceCombatState.COLLAPSE).plan
        assertEquals(listOf("pe_cos_market_t1_destroyed_f1"), reduced?.layers?.single()?.frames)
        // Current upgrade keeps the COMPLETED tier's Awning idle, never the next tier.
        val upgrading = selectServicePlan(graph, market(5, 1), null, facts(awning(graph, 1)), true, false, "upgrade", null).plan
        assertEquals("awning-t1:idle:false", upgrading?.signature)
        // Tier 4 through the tier-4 binding.
        assertEquals("awning-t4:idle:false", selectServicePlan(graph, market(20, 4), null, facts(awning(graph, 4)), true, false).plan?.signature)
        val ordinary = "market-t1:idle:false"
        // Legacy absence, empty and unrelated projections.
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, RenderServiceFacts(true), true, false).plan?.signature)
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(), true, false).plan?.signature)
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1, id = "another-market")), true, false).plan?.signature)
        // Unowned next tier, wrong tier binding, and every hash disagreement.
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 2, outputTier = 2)), true, false).plan?.signature)
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1, sha = "f".repeat(64))), true, false).plan?.signature)
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1, manifest = "0".repeat(64))), true, false).plan?.signature)
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1, index = "1".repeat(64))), true, false).plan?.signature)
        assertEquals(ordinary, selectServicePlan(graph, market(1, 1), null, facts(RenderMarketAwning("market-id", "aurora_wake", binding(graph, 1).sha256, binding(graph, 1).sourceManifestSha256, binding(graph, 1).sourceIndexSha256)), true, false).plan?.signature)
        // A renderer15 graph (no extension) ignores the projection entirely.
        val r = root(); r.get("rendererContractVersion").set(15L, null); r.remove("boundCosmetics")
        val legacy = requireNotNull(RendererCatalogue.serviceArt(r))
        assertEquals(ordinary, selectServicePlan(legacy, market(1, 1), null, facts(awning(graph, 1)), true, false).plan?.signature)
        // Disabled art or construction still yield nothing, Awning or not.
        assertNull(selectServicePlan(graph, market(1, 1), null, facts(awning(graph, 1)), false, false).plan)
        assertNull(selectServicePlan(graph, market(1, 1).copy(underConstruction = true), null, facts(awning(graph, 1)), true, false).plan)
    }

    @Test fun `admission exposes exactly the packed binding for the four Awnings and nothing for the wake`() {
        val cosmetics = requireNotNull(art().cosmetics)
        for (tier in 1..4) {
            val b = cosmetics.bindings.getValue("artisan_market_awning_t$tier")
            assertEquals("artisan-market-t$tier", b.sourceId)
            assertNotNull(cosmetics.admitted(b.outputId, b.sha256, b.sourceManifestSha256, b.sourceIndexSha256, tier))
            assertNull(cosmetics.admitted(b.outputId, b.sha256, b.sourceManifestSha256, b.sourceIndexSha256, tier % 4 + 1))
            assertNull(cosmetics.admitted(b.outputId, b.sha256.reversed(), b.sourceManifestSha256, b.sourceIndexSha256, tier))
        }
        assertNull(cosmetics.admitted("aurora_wake", "0".repeat(64), cosmetics.sourceManifestSha256, cosmetics.sourceIndexSha256, 1))
        assertFails { PhaseECosmeticArt.appearanceId("aurora_wake") }
    }

    @Test fun `the wake binding is exposed separately for its source preview and never widens the Awning rules`() {
        val cosmetics = requireNotNull(art().cosmetics)
        val wake = cosmetics.wakeBinding
        assertEquals("aurora_wake", wake.outputId); assertEquals("auroraWake", wake.sourceId)
        assertEquals(cosmetics.sourceManifestSha256, wake.sourceManifestSha256); assertEquals(cosmetics.sourceIndexSha256, wake.sourceIndexSha256)
        assertTrue(wake.sha256.matches(Regex("[0-9a-f]{64}")))
        // The Awning map stays exactly four; the wake's real hashes admit no appearance and no Awning id.
        assertEquals(PhaseECosmeticArt.awningOutputs.toSet(), cosmetics.bindings.keys)
        assertNull(cosmetics.admitted(wake.outputId, wake.sha256, wake.sourceManifestSha256, wake.sourceIndexSha256, null))
        assertFails { PhaseECosmeticArt.appearanceId(wake.outputId) }
        // The packed wake clip is the authored 64px centre-anchored 8-frame loop; frame 1 is its source index 0.
        val clip = cosmetics.clips.getValue(PhaseECosmeticArt.WAKE_CLIP)
        assertEquals(8, clip.frames.size); assertTrue(clip.loop); assertEquals(8f, clip.fps)
        assertEquals(ServicePoint(64f, 64f), clip.cell); assertEquals(ServicePoint(32f, 32f), clip.anchorPx); assertEquals("centre", clip.anchorKind)
        assertEquals(0, clip.frames.single { it.key == "pe_cos_wake_f1" }.sourceIndex)
        assertNull(cosmetics.appearances.values.firstOrNull { it.id.contains("wake") }, "no wake appearance exists")
    }
}
