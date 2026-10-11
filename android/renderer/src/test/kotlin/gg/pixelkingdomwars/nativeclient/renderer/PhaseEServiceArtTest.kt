package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.File
import org.junit.Test
import kotlin.test.*

class PhaseEServiceArtTest {
    private fun art() = PhaseEServiceArt.parse(serviceFixture())
    private fun reject(mutate: (JsonValue) -> Unit) { val raw = serviceFixture(); mutate(raw); assertFails { PhaseEServiceArt.parse(raw) } }
    private fun building(type: String = "workshop", tier: Int? = 1) = RenderBuilding("service-id", "service:$type:1", 2f, 3f, 2f, 2f,
        type = type, level = 1, service = RenderServiceIdentity(type,tier))
    private fun entry(type: String = "workshop", tier: Int? = 1) = serviceJson(mapOf("type" to type, "level" to 1, "footprintWidth" to 2,
        "footprintHeight" to 2, "phaseE" to mapOf("facility" to type, "tier" to tier)))
    private fun facts(state: RenderServiceState = RenderServiceState.WORKING, presence: RenderStarterPresence? = null) = RenderServiceFacts(true,
        listOf(RenderBerthPresentation("service-id", presence?.let { RenderStarterInstallation("starter",it) })),
        listOf(RenderServiceActivity("service-id",state)))

    @Test fun `closed candidate graph preserves original source frames playback provenance and geometry without files`() {
        val graph = art()
        assertEquals(49,graph.appearances.size); assertEquals(138,graph.clips.size); assertEquals(46,graph.groups.size)
        assertEquals(369,graph.appearances.values.sumOf { it.states.size })
        val working = graph.clips.getValue("pe_workshop_t1_working")
        assertEquals(9,working.frames.size); assertEquals((0..7).toList(),working.playbackIndices)
        assertEquals("rgba-cell",working.frames.first().hashDomain)
        assertEquals(ServicePoint(56f,104f),graph.appearances.getValue("workshop-t1").geometry.sourcePivot)
        assertEquals(ServicePoint(56f,93f),graph.appearances.getValue("starter-berth").geometry.groundContact)
        assertNull(graph.appearances.getValue("survey-balloon-berth").geometry.tidalGate)
        assertEquals("pe_fleet_berths",graph.groupFor("pe_berth_starter_intact_f1").id)
    }
    @Test fun `omitted duplicated foreign and oversized inventories are refused before resolution`() {
        reject { it.get("metadata").get("peClips").remove("pe_workshop_t1_working") }
        reject { it.get("metadata").get("peAppearances").addChild("foreign",serviceJson(emptyMap<String,Any>())) }
        reject { it.get("groups").remove(0) }
        reject { it.get("groups").get(1).get("id").set(it.get("groups").get(0).getString("id")) }
        reject { it.get("metadata").get("peClips").get("pe_workshop_t1_working").get("frames").addChild(serviceJson(emptyMap<String,Any>())) }
    }
    @Test fun `authored playback loop endpoints geometry and explicit reduced motion cannot be rewritten`() {
        reject { it.get("metadata").get("peClips").get("pe_workshop_t1_working").get("playbackIndices").get(0).set(1L, null) }
        reject { it.get("metadata").get("peClips").get("pe_workshop_t1_working").get("frames").get(8).get("sha256").set("b".repeat(64)) }
        reject { it.get("metadata").get("peClips").get("pe_workshop_t1_collapse").get("loop").set(true) }
        reject { it.get("metadata").get("peClips").get("pe_workshop_t1_working").addChild("reducedMotion",serviceJson(mapOf("frame" to 0))) }
        reject { it.get("metadata").get("peAppearances").get("workshop-t1").get("geometry").get("cellBottom").set(104L, null) }
        reject { it.get("metadata").get("peAppearances").get("workshop-t1").get("geometry").get("drawScale").set(1.000000001, null) }
    }
    @Test fun `alias cycles redirected rubble wrong berth layering and made-up effect images are refused`() {
        reject { it.get("metadata").get("peAppearances").get("lodge-t1").get("states").get("destroyed").get("target").get("appearance").set("lodge-t1") }
        reject { it.get("metadata").get("peAppearances").get("starter-berth").get("states").get("away").get("parts").get(0).get("state").set("damaged") }
        reject { it.get("metadata").get("peEffects").get("craft-success").get("anchor").get(0).set(1L, null) }
        reject { it.get("metadata").get("peClips").get("pe_fx_craft-success").get("reducedMotion").get("image").get("path").set("atlas/fake.png") }
    }
    @Test fun `optional groups have exact paired pins native scale and bounded decoded residency`() {
        reject { it.get("groups").get(0).get("atlasPath").set("../other.json") }
        reject { it.get("groups").get(0).get("imagePath").set("atlas/pe_berth@2x.png") }
        reject { it.get("groups").get(0).get("files").get(0).get("path").set("atlas/other.json") }
        reject { it.get("groups").get(0).get("files").get(0).get("sha256").set("A".repeat(64)) }
        reject { it.get("groups").get(0).get("decodedBytes").set(4096L*4096*4+4, null) }
        reject { it.get("groups").get(0).get("files").get(1).get("size").set(0L, null) }
    }
    @Test fun `owned decoded graph is independent of input mutations and its collections cannot be rewritten`() {
        val raw = serviceFixture(); val graph = PhaseEServiceArt.parse(raw)
        raw.get("metadata").get("peClips").get("pe_workshop_t1_working").get("playbackIndices").get(0).set(7L, null)
        assertEquals(0,graph.clips.getValue("pe_workshop_t1_working").playbackIndices.first())
        assertFails { (graph.groups as MutableMap).clear() }
        assertFails { (graph.appearances.getValue("lodge-t1").states as MutableMap).clear() }
        assertFails { (graph.clips.getValue("pe_workshop_t1_working").frames as MutableList).clear() }
    }
    @Test fun `service entries do not claim static artwork and reject mismatches scalar coercion or fictitious defaults`() {
        assertEquals(RenderServiceIdentity("workshop",1),PhaseEServiceArt.entry(entry()))
        assertEquals(RenderServiceIdentity("berth",null),PhaseEServiceArt.entry(entry("berth",null)))
        for (change in listOf<(JsonValue)->Unit>({it.addChild("frameKey",JsonValue("fake"))}, {it.get("phaseE").get("facility").set("market")},
            {it.get("level").set("1")}, {it.get("phaseE").get("tier").set(5L, null)}, {it.get("footprintWidth").set(1L, null)})) {
            val row = entry(); change(row); assertFails { PhaseEServiceArt.entry(row) }
        }
        assertFails { PhaseEServiceArt.entry(entry("berth",1)) }
    }
    @Test fun `contract14 stays unchanged and renderer15 admits metadata without pretending optional pixels are installed`() {
        val root = JsonReader().parse(File("../app/src/main/assets/native/render-catalog.json").readText())
        RendererCatalogue.validate(root)
        assertNotNull(RendererCatalogue.serviceArt(root),"The promoted bundle carries actual renderer15 metadata")
        val old = RendererCatalogue.staticArt(root)
        // Owned historical view: preserve all legacy contracts and remove only the validated additions.
        val entries=root.get("entries")
        for(index in entries.size-1 downTo 0) if(entries.get(index).has("phaseE")) {
            PhaseEServiceArt.entry(entries.get(index));entries.remove(index)
        }
        root.remove("phaseE");root.get("rendererContractVersion").set(14L,null)
        RendererCatalogue.validate(root)
        assertEquals(old,RendererCatalogue.staticArt(root))
        assertNull(RendererCatalogue.serviceArt(root))
        root.get("rendererContractVersion").set(15L, null)
        assertFails { RendererCatalogue.serviceArt(root) }
        root.addChild("phaseE",serviceFixture()); root.get("entries").addChild(entry())
        RendererCatalogue.validate(root)
        assertEquals(old,RendererCatalogue.staticArt(root))
        assertNotNull(RendererCatalogue.serviceArt(root)) // No optional files were created/opened by this test.
        root.get("entries").addChild(entry())
        assertFails { RendererCatalogue.validate(root) }
    }
    @Test fun `permission construction and unavailable metadata select only logical outlines`() {
        val graph = art(); val b = building()
        assertNull(selectServicePlan(graph,b,null,facts(),false,false).plan)
        assertNull(selectServicePlan(null,b,null,facts(),true,false).plan)
        assertEquals("Under construction",selectServicePlan(graph,b.copy(underConstruction=true),null,facts(),true,false).status)
        assertNull(selectServicePlan(graph,b,null,facts(),true,false,job="build").plan)
    }
    @Test fun `server activity determines working ready or idle while upgrades retain current tier neutral art`() {
        val graph=art(); val b=building()
        val working=selectServicePlan(graph,b,null,facts(),true,false).plan!!
        assertEquals((1..8).map { "pe_workshop_t1_working_f$it" },working.layers.single().frames)
        assertEquals(setOf("pe_workshop_t1"),working.groups)
        assertEquals("pe_workshop_t1_ready_f1",selectServicePlan(graph,b,null,facts(RenderServiceState.READY),true,false).plan!!.layers.single().frames.single())
        assertEquals("pe_workshop_t1_idle_f1",selectServicePlan(graph,b,null,RenderServiceFacts(),true,false).plan!!.layers.single().frames.single())
        val upgrading=selectServicePlan(graph,b,null,facts(),true,false,job="upgrade")
        assertEquals("Upgrading",upgrading.status); assertEquals("pe_workshop_t1_idle_f1",upgrading.plan!!.layers.single().frames.single())
    }
    @Test fun `Harvester requires actual realm while berth requires positive matching away starter installation`() {
        val graph=art()
        assertNull(selectServicePlan(graph,building("harvester"),null,facts(),true,false).plan)
        assertNull(selectServicePlan(graph,building("harvester"),"unknown",facts(),true,false).plan)
        assertEquals(setOf("pe_harv_frostveil_t1"),selectServicePlan(graph,building("harvester"),"frostveil",facts(),true,false).plan!!.groups)
        val berth=building("berth",null)
        for (f in listOf(RenderServiceFacts(),facts(),facts(presence=RenderStarterPresence.OCCUPIED),
            facts(presence=RenderStarterPresence.AWAY).copy(berths=listOf(RenderBerthPresentation("other",RenderStarterInstallation("starter",RenderStarterPresence.AWAY))))))
            assertNull(selectServicePlan(graph,berth,null,f,true,false).plan)
        val away=selectServicePlan(graph,berth,null,facts(presence=RenderStarterPresence.AWAY),true,false).plan!!
        assertEquals(2,away.layers.size); assertEquals("pe_berth_starter_intact_f1",away.layers.first().frames.single())
        assertEquals(8,away.layers.last().frames.size)
    }
    @Test fun `APK004 seeded completed Berth without a vehicle draws starter art instead of an empty plot`() {
        val berth = building("berth", null)
        val graph = art()
        for (f in listOf(RenderServiceFacts(true), RenderServiceFacts(true, berths = emptyList()), facts(),
            RenderServiceFacts(true, berths = listOf(RenderBerthPresentation("other", RenderStarterInstallation("starter", RenderStarterPresence.AWAY)))))) {
            assertEquals("starter-berth", completedBerthAppearance(berth, f))
            val plan = assertNotNull(selectServicePlan(graph, berth, null, f, true, false, staticBerth = true).plan)
            assertEquals("starter-berth:intact:false", plan.signature)
            assertEquals(listOf("pe_berth_starter_intact_f1"), plan.layers.single().frames)
            assertEquals(setOf("pe_fleet_berths"), plan.groups)
            assertNull(f.currentFleetIdentity)
        }
    }
    @Test fun `static Berth selects the exact installed family and only explicit away facts add ambient art`() {
        val berth = building("berth", null)
        val graph = art()
        for (presence in RenderStarterPresence.entries) {
            val f = facts(presence = presence)
            assertEquals("starter-berth", completedBerthAppearance(berth, f))
            val plan = assertNotNull(selectServicePlan(graph, berth, null, f, true, false, staticBerth = true).plan)
            assertEquals(if (presence == RenderStarterPresence.AWAY) 2 else 1, plan.layers.size)
        }
        for (family in listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")) {
            for (tier in 1..4) for (presence in RenderAdvancedPresence.entries) {
                val f = RenderServiceFacts(true, currentAdvancedBerths = listOf(RenderAdvancedBerth(berth.id,
                    RenderAdvancedInstallation(family, tier, presence))))
                val appearance = "${family.replace('_', '-')}-berth"
                assertEquals(appearance, completedBerthAppearance(berth, f))
                for (reduced in listOf(false, true)) {
                    val plan = assertNotNull(selectServicePlan(graph, berth, null, f, true, reduced, staticBerth = true).plan)
                    val away = presence == RenderAdvancedPresence.AWAY
                    assertEquals("$appearance:${if (away) "away" else "intact"}:$reduced", plan.signature)
                    assertEquals(listOf("pe_berth_${family.replace('_', '-')}_intact_f1"), plan.layers.first().frames)
                    assertEquals(setOf("pe_fleet_berths"), plan.groups)
                    assertEquals(if (away) 2 else 1, plan.layers.size)
                    if (away) assertEquals(if (reduced) 1 else 8, plan.layers.last().frames.size)
                }
            }
        }
    }
    @Test fun `static Berth refuses duplicate contradictory and unsupported installation facts`() {
        val berth = building("berth", null)
        val starter = RenderBerthPresentation(berth.id, RenderStarterInstallation("starter", RenderStarterPresence.OCCUPIED))
        val advanced = RenderAdvancedBerth(berth.id, RenderAdvancedInstallation("survey_balloon", 1, RenderAdvancedPresence.OCCUPIED))
        val bad = listOf(
            RenderServiceFacts(true, berths = listOf(starter, starter)),
            RenderServiceFacts(true, berths = List(2) { starter.copy(installation = null) }),
            RenderServiceFacts(true, currentAdvancedBerths = listOf(advanced, advanced)),
            RenderServiceFacts(true, currentAdvancedBerths = List(2) { advanced.copy(installation = null) }),
            RenderServiceFacts(true, berths = listOf(starter), currentAdvancedBerths = listOf(advanced)),
            RenderServiceFacts(true, berths = listOf(starter.copy(installation = starter.installation!!.copy(family = "unknown")))),
            RenderServiceFacts(true, currentAdvancedBerths = listOf(advanced.copy(installation = advanced.installation!!.copy(family = "zeppelin")))),
            RenderServiceFacts(true, currentAdvancedBerths = listOf(advanced.copy(installation = advanced.installation!!.copy(tier = 0)))),
            RenderServiceFacts(true, currentAdvancedBerths = listOf(advanced.copy(installation = advanced.installation!!.copy(tier = 5)))))
        val graph = art()
        for (f in bad) {
            assertNull(completedBerthAppearance(berth, f))
            assertNull(selectServicePlan(graph, berth, null, f, true, false, staticBerth = true).plan)
        }
        // An unknown or explicitly uninstalled sibling never erases a positive installation.
        assertEquals("survey-balloon-berth", completedBerthAppearance(berth,
            RenderServiceFacts(true, berths = listOf(starter.copy(installation = null)), currentAdvancedBerths = listOf(advanced))))
    }
    @Test fun `shared Berth appearance requires the completed positive level and admitted marker`() {
        val berth = building("berth", null)
        for (b in listOf(berth.copy(underConstruction = true), berth.copy(level = null), berth.copy(level = 0),
            berth.copy(level = -1), berth.copy(type = "workshop"), berth.copy(service = null),
            berth.copy(service = RenderServiceIdentity("workshop", 1)), berth.copy(service = RenderServiceIdentity("berth", 1)))) {
            assertNull(completedBerthAppearance(b, RenderServiceFacts(true)))
        }
    }
    @Test fun `static Berth opt in preserves permission construction and frozen battle boundaries`() {
        val berth = building("berth", null)
        val graph = art()
        val f = facts(presence = RenderStarterPresence.OCCUPIED)
        assertNull(selectServicePlan(graph, berth, null, f, false, false, staticBerth = true).plan)
        assertNull(selectServicePlan(null, berth, null, f, true, false, staticBerth = true).plan)
        assertNull(selectServicePlan(graph, berth, null, f, true, false, job = "build", staticBerth = true).plan)
        assertNull(selectServicePlan(graph, berth.copy(underConstruction = true), null, f, true, false, staticBerth = true).plan)
        assertNull(selectServicePlan(graph, berth, null, f, true, false).plan, "legacy private selection stays opt out")
        for (combat in ServiceCombatState.entries) {
            assertNull(selectServicePlan(graph, berth, null, f, true, false, combat = combat, staticBerth = true).plan)
            val away = facts(presence = RenderStarterPresence.AWAY)
            assertEquals(selectServicePlan(graph, berth, null, away, true, false, combat = combat),
                selectServicePlan(graph, berth, null, away, true, false, combat = combat, staticBerth = true))
        }
    }
    @Test fun `Workshop READY keeps its authored still in both motion modes without Lodge craft-success`() {
        val graph = art(); val b = building()
        for (reducedMotion in listOf(false, true)) {
            val ready = selectServicePlan(graph,b,null,facts(RenderServiceState.READY),true,reducedMotion)
            assertEquals("Ready",ready.status)
            val plan = assertNotNull(ready.plan)
            assertEquals("workshop-t1:ready:$reducedMotion",plan.signature)
            assertEquals(listOf("pe_workshop_t1_ready_f1"),plan.layers.single().frames)
            assertEquals(setOf("pe_workshop_t1"),plan.groups)
            assertFalse(plan.layers.single().loop)
            assertNotEquals(selectServicePlan(graph,b,null,facts(RenderServiceState.IDLE),true,reducedMotion)
                .plan!!.layers.single().frames,plan.layers.single().frames)
        }
        val lodgeReady = resolveServicePlan(graph,graph.appearances.getValue("lodge-t1"),"ready",false)!!
        assertEquals(setOf("pe_lodge_t1","pe_fx"),lodgeReady.groups)
        assertEquals(2,lodgeReady.layers.size)
    }
    @Test fun `reduced motion keeps status with neutral still and only uses an authored berth reduced frame`() {
        val graph=art()
        val reduced=selectServicePlan(graph,building(),null,facts(),true,true)
        assertEquals("Working",reduced.status); assertEquals(listOf("pe_workshop_t1_idle_f1"),reduced.plan!!.layers.single().frames)
        val berth=selectServicePlan(graph,building("berth",null),null,facts(presence=RenderStarterPresence.AWAY),true,true).plan!!
        assertEquals(listOf("pe_berth_starter_ambient_f1"),berth.layers.last().frames); assertFalse(berth.layers.last().loop)
        val lodge=graph.appearances.getValue("lodge-t1")
        assertNull(resolveServicePlan(graph,lodge,"ready",true))
        assertIs<ServiceReducedMotion.SourceImage>(graph.clips.getValue("pe_fx_craft-success").reducedMotion)
    }
    @Test fun `frozen combat ignores current activity and resolves authored collapse then cross-group rubble`() {
        val graph=art(); val b=building("lodge")
        val collapse=selectServicePlan(graph,b,null,facts(),true,false,combat=ServiceCombatState.COLLAPSE)
        assertEquals("",collapse.status); assertEquals(9,collapse.plan!!.layers.single().frames.size)
        assertFalse(collapse.plan.layers.single().loop)
        assertEquals(setOf("pe_lodge_t1","pe_workshop_t1"),collapse.plan.groups)
        assertEquals("pe_workshop_t1_rubble_f1",collapse.plan.terminal!!.layers.single().frames.single())
        assertEquals("pe_lodge_t1_damaged_f1",selectServicePlan(graph,b,null,facts(),true,true,combat=ServiceCombatState.DAMAGED).plan!!.layers.single().frames.single())
    }
    @Test fun `composition keeps authored FX attachment and south-cell anchor without adding unsupported files`() {
        val graph=art(); val plan=resolveServicePlan(graph,graph.appearances.getValue("lodge-t2"),"ready",false)!!
        assertEquals(setOf("pe_lodge_t2","pe_fx"),plan.groups)
        assertEquals(ServicePoint(.5f,1f),plan.layers.first().origin)
        assertEquals(ServicePoint(24f,0f),plan.layers.last().offset)
        assertEquals(ServicePoint(.5f,.5f),plan.layers.last().origin)
        assertEquals(ServicePoint(64f,64f),plan.layers.last().cell)
        assertTrue(plan.layers.flatMap { it.frames }.none { it.endsWith(".png") })
    }
}
