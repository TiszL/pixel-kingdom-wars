package gg.pixelkingdomwars.nativeclient.scene.world

import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.renderer.GlobeAssetLease
import gg.pixelkingdomwars.nativeclient.renderer.GlobeAssetSource
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeContent
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapStats
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorGame
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.ui.world.GlobePanel
import gg.pixelkingdomwars.nativeclient.ui.world.PhaseEIslands
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudFlow
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudUi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Locale

/**
 * The N1/N2 integration (lead, D-171; N5): the World tab runs the GL30 globe + realm maps in a build that carries the
 * world bundle (every build type since N5), and every way into it hands the tab back to the legacy globe on failure. The wiring lives in shared
 * files (PkwApp, MainActivity) that the lanes' own tests cannot see, so it is pinned here; the pure adapters are tested
 * directly.
 */
class WorldEngineIntegrationTest {
    @get:Rule val tmp = TemporaryFolder()
    private val pkwApp = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
    private val mainActivity = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/MainActivity.kt").readText()
    private val surface = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSurface.kt").readText()

    @Test fun `the World tab passes the admitted engine and nothing else`() {
        val world = pkwApp.substring(pkwApp.indexOf("HomeTab.WORLD -> {"))
        val call = world.substring(0, world.indexOf("HomeTab.MORE"))
        assertTrue("PkwApp hands WorldScreen the admission's engine (null = the legacy globe)", "worldEngine = gg.pixelkingdomwars.nativeclient.scene.world.rememberWorldEngine(worldModel)" in call)
        assertEquals("exactly one WorldScreen call site", 1, Regex("""WorldScreen\(""").findAll(pkwApp).count())
        val remember = surface.substring(surface.indexOf("fun rememberWorldEngine"))
        assertTrue("the engine exists only when the admission has no refusal", Regex("""if \(refusal != null\) \{[^}]*null \}""").containsMatchIn(remember))
    }

    @Test fun `every build type carries the world bundle from main assets, generated and never committed`() {
        // D-175/D-NEXT (N5) replaces D-171's rule "only the debug source set carries the bundle, release keeps the legacy
        // globe": the new world ships in every APK, release included, with no download. The bundle is generated into
        // main assets (which every build type packages) from the pinned pack, and stays out of git like the client pack.
        assertEquals("world/content.json", WorldEngineAdmission.WORLD_CONTENT)
        val tool = File("../tools/world-debug-content.mjs").readText()
        assertTrue("the generator fills main assets, which every build type packages", "export const OUT_DIR = 'app/src/main/assets/world';" in tool)
        assertTrue("the generated bundle is ignored, never committed", File("../.gitignore").readLines().any { it.trim() == "app/src/main/assets/world/" })
        assertFalse("no release-only copy may shadow the bundle", File("src/release/assets/world").exists())
        // without the generated bundle (a checkout that never ran the tool) the build still runs, on the legacy globe
        assertEquals("this build carries no world content", WorldEngineAdmission.refusal(false, WorldEngineAdmission.GLES_3_0, false, true, null))
        assertNull(WorldEngineAdmission.refusal(false, WorldEngineAdmission.GLES_3_0, true, true, null))
        // the engine's own test drivers stay out of release: they are declared and built in the debug source set only
        assertFalse(File("src/main/AndroidManifest.xml").readText().let { "WorldEngineSmokeActivity" in it || "DeviceProbeActivity" in it })
        assertTrue(File("src/debug/AndroidManifest.xml").readText().let { "WorldEngineSmokeActivity" in it && "DeviceProbeActivity" in it })
    }

    @Test fun `only a debug build can ask for the legacy world`() {
        val line = mainActivity.lines().singleOrNull { "WorldEngineFlags.legacyWorld" in it }
        assertTrue("MainActivity sets the flag in exactly one place", line != null)
        assertTrue("debug only: $line", line!!.trimStart().startsWith("if (BuildConfig.DEBUG)"))
        assertTrue("from the launch extra worldLegacy, default off", """getBooleanExtra("worldLegacy", false)""" in line)
    }

    @Test fun `the new surface never shares the legacy globe's fragment tag`() {
        // NU's fallback swaps to the legacy WorldSurface (tag fantasy-globe-<dir>) in the same composition.
        assertTrue(""""world-engine-${'$'}{art.name}"""" in surface)
        assertTrue("no string literal names the legacy tag", "\"fantasy-globe-" !in surface)
    }

    @Test fun `the host runs the globe's L2 cut and feeds its loading meter`() {
        // NG's fix pass only takes effect through these host lines: without the offscreen pass L2 renders the sphere at
        // full scale (the ladder cuts nothing on a slow GPU); without the meter the HUD's loading bar sits at 0.
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val globeMode = host.substring(host.indexOf("MODE_GLOBE, MODE_DIVE_WAIT -> {"), host.indexOf("MODE_FADE_IN, MODE_FADE_OUT -> {"))
        val offscreen = globeMode.indexOf("if (mode != MODE_FADE_IN) g.drawOffscreen()")
        assertTrue("the half-scale pass runs in the globe modes, never on a fade's first frame", offscreen >= 0)
        assertTrue("an offscreen pass comes before the screen pass", offscreen < globeMode.indexOf("c.beginScreen("))
        val fades = host.substring(host.indexOf("MODE_FADE_IN, MODE_FADE_OUT -> {"), host.indexOf("MODE_REALM -> {"))
        assertTrue("fades draw the globe at full scale", "drawOffscreen" !in fades)
        val loading = globeMode.substring(0, globeMode.indexOf("return // NG's rule"))
        assertTrue("the meter is published only while the globe is not ready", "publishLoading(g.loadProgress)" in loading)
        assertTrue("the surface hands the meter to the HUD", "override fun loading(value: Float) = post { it.loading = value }" in surface)
    }

    @Test fun `overview reads stay inside the verified directory`() {
        val overview = tmp.newFolder("overview")
        File(overview, "atlas/fantasy/globe").mkdirs()
        File(overview, GlobeContent.MASK_SURFACE).writeBytes(byteArrayOf(1, 2, 3))
        File(tmp.root, "secret.txt").writeText("outside")
        val files = WorldPackFiles(overview, null)
        assertArrayEquals(byteArrayOf(1, 2, 3), files.read(GlobeContent.MASK_SURFACE))
        assertNull("a missing file is null (the globe reports it)", files.read(GlobeContent.MASK_REALM))
        assertNull("no path may climb out of the leased generation", files.read("../secret.txt"))
        assertNull("the verified files carry their own pins; no outer hash is invented", files.expectedSha256(GlobeContent.MASK_SURFACE))
    }

    @Test fun `chain art comes from its own group and every lease is released`() {
        val group = tmp.newFolder("chain-aurora")
        File(group, GlobeContent.CHAIN_DIR).mkdirs()
        File(group, "${GlobeContent.CHAIN_DIR}aurora-detail.png").writeBytes(byteArrayOf(7))
        File(group, "${GlobeContent.CHAIN_DIR}aurora-detail-mask.png").writeBytes(byteArrayOf(8))
        val source = FakeSource(mapOf("chain-aurora" to group))
        val files = WorldPackFiles(tmp.newFolder("overview"), source)
        assertArrayEquals(byteArrayOf(7), files.read("${GlobeContent.CHAIN_DIR}aurora-detail.png"))
        assertArrayEquals(byteArrayOf(8), files.read("${GlobeContent.CHAIN_DIR}aurora-detail-mask.png"))
        assertEquals(listOf("chain-aurora", "chain-aurora"), source.acquired)
        assertEquals("a lease is held only while its bytes are read", source.acquired.size, source.released)
        assertNull("a chain id is a group id, never a path", files.read("${GlobeContent.CHAIN_DIR}../x-detail.png"))
        assertNull("only chain detail art is routed to a group", files.read("${GlobeContent.CHAIN_DIR}cloud-banks.png"))
    }

    @Test fun `a failing or slow chain group leaves the globe without islands instead of failing it`() {
        val failing = WorldPackFiles(tmp.newFolder("o1"), FakeSource(emptyMap()))
        assertNull("an unknown or failing group is unavailable art, not an exception", failing.read("${GlobeContent.CHAIN_DIR}glasswake-detail.png"))
        val source = FakeSource(mapOf("chain-mintwake" to tmp.newFolder("chain-mintwake")))
        val spent = WorldPackFiles(tmp.newFolder("o2"), source, chainBudgetMs = 0)
        spent.read("${GlobeContent.CHAIN_DIR}mintwake-detail.png") // starts the zero budget
        Thread.sleep(2)
        assertNull(spent.read("${GlobeContent.CHAIN_DIR}mintwake-detail-mask.png"))
        assertTrue("past the budget no further group download starts", source.acquired.size <= 1)
        assertNull("no source (release, or no world session): no island art", WorldPackFiles(tmp.newFolder("o3"), null).read("${GlobeContent.CHAIN_DIR}aurora-detail.png"))
    }

    @Test fun `the realm map reads its numbers from the admitted catalogue subset`() {
        val text = File("src/main/assets/native/catalogue.json").readText()
        val subset = requireNotNull(realmCatalogueNumbers(Json.parseToJsonElement(text).jsonObject)) { "the pinned catalogue carries the realm-map constants" }
        val full = RealmEngineWiring.fromCatalogue(text)
        assertEquals("the subset parses to the same deed art scale as the whole catalogue", full.deedArt, subset.deedArt, 0.0)
        assertEquals(full.plots.tiles, subset.plots.tiles)
        assertEquals(full.plots.plotCentre, subset.plots.plotCentre)
        // N3: BASES reads its game numbers (keep footprints, wall caps, mines, source scales) from the SAME admitted subset.
        // A section missing from it would make the host drop every detail lane, and the owner would see no kingdoms.
        val a = DecorGame.fromCatalogue(requireNotNull(subset.constants) { "the subset hands the lanes its constants" })
        val b = DecorGame.fromCatalogue(requireNotNull(full.constants))
        assertEquals(b.art, a.art); assertEquals(b.tilesPerDeed, a.tilesPerDeed); assertEquals(b.outerWallInset, a.outerWallInset)
        assertArrayEquals(b.claimTilesByKeep, a.claimTilesByKeep); assertArrayEquals(b.wallRingsByKeep, a.wallRingsByKeep)
        assertArrayEquals(b.maxMinesByKeep, a.maxMinesByKeep); assertArrayEquals(b.keepFootprint, a.keepFootprint)
        assertEquals(b.buildCaps.keys, a.buildCaps.keys); for (k in b.buildCaps.keys) assertArrayEquals(k, b.buildCaps[k], a.buildCaps[k])
        assertEquals(b.buildingSourceScale, a.buildingSourceScale); assertEquals(b.sourceScale, a.sourceScale); assertEquals(b.offsetGamePxX, a.offsetGamePxX)
        assertNull("no catalogue, no realm maps (the globe still runs)", realmCatalogueNumbers(null))
    }

    @Test fun `the host registers the N3 lanes with the hooks that put them on screen`() {
        // Owner 2026-09-25: "needs some finishing to see bases". The lanes are pure renderer code; only these host lines put
        // them on screen. Without the registration the map stays the FAR overview (no ground detail, trees or kingdoms);
        // without chartUnder MAP pops in at the fade's end; without the wake/knobs a lane that finished loading waits for a
        // touch and LIFE ignores the ladder; without onGate the scale pill never says "detail N%".
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        assertTrue("map.js order: ground, life, bases", "listOf(ground, life, bases)" in host)
        assertTrue("the engine gets the lanes", "lanes = detail?.list ?: emptyList()" in host)
        assertTrue("LIFE reads GROUND's classes", "LifeBandsIn.fromGenerated(), pack, uploads, ground," in host)
        assertTrue("BASES reads GROUND's classes", "uploads, ground, BasesRules.MsClock" in host)
        assertTrue("LIFE gets the GLES30 integer uniforms (else it draws nothing)", "intUniforms = Gles30LaneUniforms" in host)
        assertTrue("GROUND's chart under MAP is the core's rm-chart", "chartUnder = GroundChartUnder { _, alpha, fieldsA -> engine.drawChartUnder(fieldsA, alpha) }" in host)
        assertTrue("lanes wake the pacer", "engine.wakeListener = Runnable { graphics()?.pacer?.markDirty() }" in host)
        assertTrue("the ladder's knobs reach the lanes", "engine.ladderKnobs = ladder.knobs" in host)
        assertTrue("LIFE's cap at L0 is its phone cap, halved from L1 by the ladder", "LadderInputs(GpuSafe.GROUND_PX[0], lifeTables.constants.submittedPhone)" in host)
        assertTrue("a pair backing off asks for its own frame", "r.wakeInMs(now)" in host)
        // The hang guard releases after ~5 s of steady GPU time (6104d5a). A still realm renders nothing, so without the
        // guard's probe in the wake the owner looks at 1/3-scale ground until the next gesture.
        val schedule = host.substring(host.indexOf("private fun schedule"), host.indexOf("private fun status"))
        assertTrue("a tripped hang guard asks for its probe frames in the realm", "hang.wakeInMs()" in schedule &&
            "minOf(realmWake, probe)" in schedule)
        val realmMode = host.substring(host.indexOf("MODE_REALM -> {"), host.indexOf("// ---------------------------------------------------------------- dive and leave"))
        assertTrue("the lanes' idle animations are declared in the realm frame", "TAG_LIFE" in realmMode && "TAG_BASES" in realmMode && "TAG_SHIELD" in realmMode)
        // stage B: Solana Reach's gem sea is a 16-frame 110 ms loop and MAP drifts its gems; without GROUND's own tag the
        // water stands still whenever nothing else animates (ground.js `animating('ground', …)`)
        assertTrue("GROUND's water declares its idle period", "idle.animating(IdleScheduler.TAG_GROUND, l.ground.idlePeriodMs())" in realmMode)
        assertTrue("and a leave stops it with the other realm tags", "IdleScheduler.TAG_GROUND)" in host.substring(host.indexOf("private val REALM_TAGS")))
        val leave = host.substring(host.indexOf("private fun startLeave"), host.indexOf("private fun logBand"))
        assertTrue("a leave stops the realm's idle animations (the globe must not idle at the keeps' cadence)", "for (tag in REALM_TAGS) idle.animating(tag, 0)" in leave)
        assertTrue("the band cue reaches NU's scale pill", "override fun bandGate(held: Boolean, band: Int, progress: Double) = post { it.bandGate = BandGateCue(held, band, progress) }" in surface)
        assertTrue("NU learns which realms carry detail (F7's MAP fallback)", "override fun detailRealms(ids: Set<String>) = post { it.detailRealms = ids }" in surface)
    }

    @Test fun `a globe tap on a Phase E island opens its panel through the host`() {
        // D-172 (islands handoff, owed item 1): the globe reports an island tap by selected(null, id) alone, never picked.
        // Without this host line the island is outlined and framed but no panel opens (only the rail chips worked).
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val events = host.substring(host.indexOf("private val globeEvents = object : GlobeEvents {"), host.indexOf("private fun target(pick: GlobePickV2)"))
        assertTrue("the host forwards the globe's selection to the HUD",
            "override fun selected(realmId: String?, islandId: String?) = callbacks.event(WorldHudEvent.GlobeSelected(realmId, islandId))" in events)
        assertTrue("picks still go to GlobePick unchanged", "override fun picked(pick: GlobePickV2) = callbacks.event(WorldHudEvent.GlobePick(target(pick)))" in events)
        // what the forwarded events do on the HUD: each island's tap opens its panel; a realm tap's selection event changes
        // nothing, so the realm panel still opens once, from its GlobePick (no double handling)
        for (island in PhaseEIslands.ALL) {
            val step = WorldHudFlow.globeSelected(WorldHudUi(), null, island.id)
            assertEquals(island.id, GlobePanel.ISLAND, step.ui.panel); assertEquals(island.id, step.ui.islandId)
        }
        val globe = WorldHudUi()
        assertEquals("a realm's selection event is answered by its GlobePick only", globe, WorldHudFlow.globeSelected(globe, "crownlands", null).ui)
        assertEquals(GlobePanel.REALM, WorldHudFlow.globePick(globe, WorldTarget.Realm("crownlands")).ui.panel)
    }

    @Test fun `a dive fails only once its core readiness stops moving for 8 s`() {
        // D-NEXT (amends D-173, "overview first, live"): a dive waits for the core's FAR set alone (0.7–0.8 s on the
        // Seeker before D-173), never for the lanes' MAP set, so there is no landing valve to outwait: D-173's valve plus
        // 4 s (12 s) only kept a stuck dive on screen longer. The bound still counts from the last progress, never from the
        // dive's start (a 10 s wall from the start once failed slow dives that were still moving: a cold first dive after
        // an install links its programs).
        assertEquals("8 s without core progress answers the dive", 8_000.0, WorldEngineHost.DIVE_STALL_MS, 0.0)
        assertTrue("the emulator keeps its longer SwiftShader bound", WorldEngineHost.EMULATOR_DIVE_STALL_MS >= WorldEngineHost.DIVE_STALL_MS)
        val stall = DiveStall(WorldEngineHost.DIVE_STALL_MS)
        stall.start(0.0)
        var t = 0.0; var v = 0.0
        while (t < 30_000.0) { v += 0.01; assertFalse("still progressing at $t ms", stall.stalled(t, v)); t += 5_000.0 } // a slow, steady core: 30 s
        val last = t - 5_000.0
        assertFalse(stall.stalled(last + WorldEngineHost.DIVE_STALL_MS, v))
        assertTrue("no progress for 8 s: the host answers the dive", stall.stalled(last + WorldEngineHost.DIVE_STALL_MS + 1.0, v))
        stall.start(100_000.0) // a new dive, stuck from its start (a load that never lands): it gets the whole bound, then fails
        assertFalse(stall.stalled(100_000.0, 0.0))
        assertFalse(stall.stalled(100_000.0 + WorldEngineHost.DIVE_STALL_MS, 0.0))
        assertTrue(stall.stalled(100_000.0 + WorldEngineHost.DIVE_STALL_MS + 1.0, 0.0))
        // the host wiring: the bound reads the engine's readiness while it waits, and publishes it, so the HUD's watchdog
        // (a backstop for an engine that stopped answering) re-arms instead of cutting a dive that still moves
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val wait = host.substring(host.indexOf("private fun diveStep"), host.indexOf("private fun failDive"))
        assertTrue("val v = r.readiness()" in wait && "publishReadiness(id, v, diving = true)" in wait && "if (diveStall.stalled(now, v)) failDive(" in wait)
        assertTrue("no wall clock from the dive's start is left", "diveT0" !in host)
        val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        val hudMs = Regex("""private const val DIVE_TIMEOUT_MS = ([0-9_]+)L""").find(hud)!!.groupValues[1].replace("_", "").toDouble()
        assertTrue("the HUD's watchdog outlasts the host's bound ($hudMs ms)", hudMs >= WorldEngineHost.DIVE_STALL_MS + 4_000.0)
        assertTrue("the HUD's watchdog re-arms on dive readiness", "LaunchedEffect(ui.mode, bridge.diveReadiness.takeIf { ui.mode == WorldHudMode.DIVING })" in hud)
    }

    @Test fun `the HUD never cuts a dive whose last items share one 5 percent step before the valve lands it`() {
        // D-173 fix pass: the HUD's watchdog re-arms only when the posted dive readiness changes. Posted in 5 % steps,
        // everything from 0.95 to the engine's 0.99 cap went out once, and those are the lanes' last MAP items, exactly
        // what the landing valve waits for: the HUD cut the dive at 16 s and the owner read "could not load" for a map
        // seconds from landing. While a dive waits the host posts every change its own stall bound sees, so neither the
        // host nor the HUD answers a dive whose items still arrive, and the HUD stays a backstop behind the host.
        val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        val hudMs = Regex("""private const val DIVE_TIMEOUT_MS = ([0-9_]+)L""").find(hud)!!.groupValues[1].replace("_", "").toDouble()
        val items = 60 // ~20 core + lanes + MAP-set lane pairs + the landing view (RealmMapEngine.readiness, capped at 0.99)
        // (a) item 57 crosses 0.95 at 0 s, 58 and 59 come at 6 s and 12 s, then the landing view is stuck: the valve lands
        // at 20 s; (b) steady lanes, one item every 6 s (retry backoff), each 5 % step three items and 18 s long
        val cases = mapOf("tail" to listOf(57 to 0.0, 58 to 6_000.0, 59 to 12_000.0), "steady" to (0 until items).map { it to it * 6_000.0 })
        /** The first time the HUD's watchdog (armed at each post that changes the value) or the host's bound fires, or null. */
        fun firstCut(arrivals: List<Pair<Int, Double>>, diving: Boolean): String? {
            val landAt = arrivals.last().second + GpuSafe.REHEARSE_STALL_MS // the valve: stallMs after the last item
            val stall = DiveStall(WorldEngineHost.DIVE_STALL_MS); stall.start(0.0)
            var posted: Float? = null; var armedAt = 0.0; var next = 0; var done = 0
            var t = 0.0
            while (t < landAt) {
                while (next < arrivals.size && arrivals[next].second <= t) done = arrivals[next++].first
                val v = minOf(0.99, done.toDouble() / items)
                val p = WorldEngineHost.postedReadiness(v, diving)
                if (p != posted) { posted = p; armedAt = t }
                if (stall.stalled(t, v)) return "host at $t ms"
                if (t - armedAt >= hudMs) return "HUD at $t ms"
                t += 100.0
            }
            return null
        }
        for ((name, arrivals) in cases) {
            assertNull("$name: the valve lands the dive first", firstCut(arrivals, diving = true))
            // what the 5 % meter alone did: the HUD cut both dives before the valve (the scenario still reaches the defect)
            assertEquals("$name: the conflated meter's cut", "HUD", firstCut(arrivals, diving = false)?.substringBefore(" at"))
        }
        // the panel's meter keeps its 5 % steps on the globe (one post per step, never per frame)
        assertEquals(0.95f, WorldEngineHost.postedReadiness(0.983, diving = false))
        // a dive stuck from its start still ends: the host answers at its bound, before the HUD's backstop
        assertEquals("host", firstCut(listOf(0 to 0.0, 0 to 40_000.0), diving = true)?.substringBefore(" at"))
    }

    @Test fun `a waiting dive logs what holds it once a second through the gate, in every locale`() {
        // code 29: the smoke's dive sat at 70 % for 120 s and the log said nothing about which lane or item held it. The
        // owner's Seeker log and the smoke read this line: the meter the host bounds and the raw ratio under it, the D-173
        // items, the held lanes, each lane's MAP set and load, and the landing valve's count (it opens at stallMs)
        fun lane(n: String, map: Boolean, settled: Boolean) = object : RealmLane {
            override val name = n
            override fun programs(): List<Gl3Program> = emptyList()
            override fun bandSet() = 0
            override fun settled() = settled
            override fun readyFor(set: Int) = map
            override fun update(view: RealmView) {}
            override fun rehearse(program: Gl3Program, target: Int, view: RealmView) = false
            override fun dispose() {}
        }
        val st = RealmMapStats().apply { readinessRaw = 0.4124; readinessPeak = 0.73077; landDone = 12; landTotal = 39; lanesHeld = 6; landStallMs = 3400.6 }
        val lanes = listOf(lane("ground", map = true, settled = true), lane("life", map = false, settled = false), lane("bases", map = false, settled = true))
        val want = "[world-engine] dive wait crownlands readiness 0.412 peak 0.731 land 12/39 held 0x6 lanes ground 1/1 life 0/0 bases 0/1 valve 3400"
        assertEquals(want, DiveWaitLog.line("crownlands", st, lanes))
        val was = Locale.getDefault()
        try { Locale.setDefault(Locale.GERMANY); assertEquals("a comma locale on the phone prints the same line", want, DiveWaitLog.line("crownlands", st, lanes)) }
        finally { Locale.setDefault(was) }
        assertEquals("[world-engine] dive wait x readiness 0.000 peak 0.000 land 0/0 held 0x0 lanes off valve 0", DiveWaitLog.line("x", RealmMapStats(), null))
        // at most one line a second, the first waiting frame of every dive included
        val log = DiveWaitLog(); log.start()
        assertTrue(log.due(0.0)); assertFalse(log.due(999.0)); assertTrue(log.due(1_000.0)); assertFalse(log.due(1_500.0))
        log.start(); assertTrue("a new dive logs its first waiting frame", log.due(1_600.0))
        // the host: only while the dive waits, through its WorldLog-gated logger, never formatted in release
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val wait = host.substring(host.indexOf("private fun diveStep"), host.indexOf("private fun failDive"))
        assertTrue("if (WorldLog.enabled && diveWaitLog.due(now)) log(DiveWaitLog.line(id, r.stats, lanes?.list))" in wait)
        val begin = host.substring(host.indexOf("private fun beginDive"), host.indexOf("private fun diveStep"))
        assertTrue("each dive starts its own rate", "diveWaitLog.start()" in begin)
    }

    @Test fun `every realm band line carries the rest floor and the landing valve`() {
        // D-173's Seeker check reads these lines: once landed, band >= 2 (MAP) with floor 48; LANDVALVE says the stall valve
        // released the landing before the lanes' MAP set was in. A floor change is logged even without a band change.
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val band = host.substring(host.indexOf("private fun logBand"), host.indexOf("private fun cancelTouches"))
        assertTrue("the rest floor", """floor ${'$'}{st.floorD.toInt()}""" in band)
        assertTrue("the landing valve marker", """${'$'}{if (st.landValveOpened) " LANDVALVE" else ""}""" in band)
        assertTrue("a floor change alone logs a line", "st.floorD == loggedFloor" in band && "loggedFloor = st.floorD" in band)
        val entered = host.substring(host.indexOf("private fun enteredRealm"), host.indexOf("private fun startLeave"))
        assertTrue("each realm entry logs its first band line afresh", "loggedFloor = -1.0" in entered)
    }

    private class FakeSource(private val groups: Map<String, File>) : GlobeAssetSource {
        val acquired = mutableListOf<String>()
        var released = 0
        override fun acquire(group: String, checkpoint: () -> Unit): GlobeAssetLease {
            acquired += group
            val dir = groups[group] ?: throw IllegalArgumentException("Unknown world detail group")
            return GlobeAssetLease(FileHandle(dir)) { released++ }
        }
        override fun cancelPending() {}
    }
}
