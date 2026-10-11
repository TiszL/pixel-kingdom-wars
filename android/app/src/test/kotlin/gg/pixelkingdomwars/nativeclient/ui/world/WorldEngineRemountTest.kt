package gg.pixelkingdomwars.nativeclient.ui.world

import android.content.res.AssetManager
import gg.pixelkingdomwars.nativeclient.data.WorldEntry
import gg.pixelkingdomwars.nativeclient.renderer.globe2.DiveCoverClock
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeCameraV2
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeFiles
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBandRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmCamera
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.scene.world.AssetWorldFiles
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineHost
import gg.pixelkingdomwars.nativeclient.scene.world.WorldHostCallbacks
import gg.pixelkingdomwars.nativeclient.scene.world.WorldHostInputs
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.Closeable
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The owner on the Seeker, code 31: "when phone gets on lock screen automatically because of no interaction and you
 * unlock it, it automatically zooms out to globe with minimap preserved transparent as now, and for seconds screen loses
 * HUD visibility when you press back, which feels like a bug". The log (14:26:43 onStop, "release without GL", 14:27:05
 * onStart, "globe ready in 316 ms", no "leave sunscar") and the screenshots: a stopped app cancels `model.foreground`,
 * whose finally publishes art = null; `key(art)` drops the engine and its host is released without a word to the HUD; the
 * next visit's art mounts a new engine on the globe; and the HUD stayed on the Sunscar map: title card, chips, an empty
 * minimap frame over the globe. Its Back then sent a Leave the new globe ignored, and the HUD sat LEAVING (no HUD at all)
 * until the 4 s leave watchdog.
 *
 * The owner's choice after unlock: "Same map, same spot": the same realm at the same zoom and position, with the realm
 * controls intact, after about half a second under the dive's clouds. Where that cannot happen, the new engine's clean
 * globe. And Back never waits under no HUD for an engine that has nothing to leave.
 */
class WorldEngineRemountTest {
    private val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
    private val worldScreen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldScreen.kt").readText()
    private val model = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldViewModel.kt").readText()
    private val hostSource = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
    private fun hostBetween(from: String, to: String) = hostSource.substring(hostSource.indexOf(from), hostSource.indexOf(to, hostSource.indexOf(from)))

    private val card = RealmCard(71_000, 440, 98)
    /** Where the owner's Sunscar map rested when the phone locked: deed (42.5, 17.25) at the centre, 96 device px a deed. */
    private val camera = RealmResume("sunscar", 42.5, 17.25, 96.0)

    /** The owner's Sunscar session on the real flow: into the map, the MINE chip, a deed card, the minimap pinned. */
    private fun onSunscar(start: WorldHudUi = WorldHudUi()): WorldHudUi {
        val dive = WorldHudFlow.enterMap(WorldHudFlow.selectRealm(start, "sunscar").ui, "sunscar").ui
        val landed = WorldHudFlow.dived(dive, "sunscar", myBase = null).ui
        return WorldHudFlow.selectDeed(WorldHudFlow.setFilter(landed, RealmFilter("mine")).ui, card, fly = false).ui.copy(miniPin = true)
    }

    // ---------------------------------------------------------------- 1. "Same map, same spot"

    @Test fun `the realm map the app stopped on comes back at the same camera with its controls intact`() {
        val browsing = onSunscar()
        assertEquals(WorldHudMode.REALM, browsing.mode)

        // the new engine mounts: the HUD dives back, as any dive, never the realm chrome over the new globe
        val resuming = WorldHudFlow.engineMounted(browsing, camera)
        assertEquals(WorldHudMode.DIVING, resuming.mode)
        assertEquals("the resume carries the old engine's camera, and the card's deed and the chip for the new engine to land with",
            camera.copy(card = card, filter = WorldHudFlow.engineFilter(RealmFilter("mine"))), resuming.resume)
        assertTrue("a dive composes the globe's dive HUD", "WorldHudMode.GLOBE, WorldHudMode.DIVING -> GlobeLayer(" in screen)
        assertTrue("and the realm chrome, minimap frame included, only on a map the engine shows", "WorldHudMode.REALM -> RealmLayer(" in screen)
        assertEquals("Back during the resume leaves it, as during any dive", listOf(BackPriority.REALM_MAP), WorldHudFlow.backLayers(resuming))

        // the resume's own Diving (beginDive) changes nothing; its Dived brings the controls back as the player left them
        assertEquals(resuming, WorldHudFlow.diving(resuming, "sunscar").ui)
        val landed = WorldHudFlow.dived(resuming, "sunscar", myBase = RealmCard(1, 1, 1), openDeed = RealmCard(2, 2, 2))
        assertEquals(WorldHudMode.REALM, landed.ui.mode)
        assertEquals("the same realm, its chip, its card, its pinned minimap", browsing.copy(realmSearch = false), landed.ui)
        assertNull(landed.ui.resume)
        // The new engine landed with the chip and the card already (landResume, below). Nothing goes to it at Dived: the
        // engine's select always flies, to d 700 from the owner's d 96 or back onto the deed from a panned camera
        // (RealmResumeLandingTest), so a Select here was the automatic zoom-in right after unlock, not "Same map, same spot".
        assertEquals("the landed map is left where it is", emptyList<WorldIntent>(), landed.intents)
        assertTrue("the screen skips choose mode's suggested deed on a resume", "u.pendingMine || u.resume != null) null else {" in screen)
    }

    @Test fun `the new engine takes the chip and the card before the old camera, so nothing flies after the landing`() {
        val resume = WorldHudFlow.engineMounted(onSunscar(), camera).resume!!
        assertEquals("the card as catalog columns and rows, what selectCatalogDeed takes", card, resume.card)
        assertEquals(WorldFilterKind.MINE, resume.filter?.kind)
        // a lock on a map with no card and no chip lands with none: the new engine's own (all shown, nothing selected)
        val bare = WorldHudFlow.dived(WorldHudFlow.enterMap(WorldHudFlow.selectRealm(WorldHudUi(), "sunscar").ui, "sunscar").ui, "sunscar", myBase = null).ui
        val plain = WorldHudFlow.engineMounted(bare, camera).resume!!
        assertNull(plain.card); assertEquals(WorldFilterKind.ALL, plain.filter?.kind)

        // the host, on the real engine: the entry (which clears any selection), then the chip, the deed and the camera, in
        // that order: the placement's `set` ends the select's flight before any frame draws
        val land = hostBetween("internal fun landResume", "/** The dive readiness")
        val filter = land.indexOf("at.filter?.let(r::setFilter)")
        val select = land.indexOf("at.card?.let { r.selectCatalogDeed(it.x, it.y, fly = false) }")
        val place = land.indexOf("placeResume(r.cam, at, dpr)")
        assertTrue("the chip, then the deed, then the camera: $filter, $select, $place", filter in 0 until select && select < place)
        val step = hostBetween("private fun diveStep", "private fun failDive")
        val landing = step.indexOf("resumeAt?.let { landResume(r, it, dpr)")
        assertTrue("after the entry opens the map", landing > step.indexOf("if (!r.enter(diveLon, diveLat, diveS))"))
        assertTrue("before the dive's snapshot fade draws it", landing in 0 until step.indexOf("r.renderSnapshot("))
    }

    @Test fun `the new engine lands on the old camera, under clouds that are up from its first frame`() {
        // placement on a real realm camera at the engine's dpr 2 (the Seeker's): d is device px, the camera's own s is CSS px
        val cam = RealmCamera(RealmBandRules(RealmEngineWiring.config().bands, 64.0)) { 0.0 }
        cam.setViewport(600.0, 1305.0, 2.0); cam.setGrid(180, 130); cam.limitD(Double.POSITIVE_INFINITY)
        WorldEngineHost.placeResume(cam, camera, 2.0)
        assertEquals(42.5, cam.x, 0.0); assertEquals(17.25, cam.y, 0.0)
        assertEquals("the same zoom", 96.0, cam.d, 1e-9)
        assertFalse("placed, not flown", cam.moving)

        val resume = hostBetween("private fun resumeRealm", "private fun drawCover")
        assertTrue("a normal dive, straight in: no globe flight", resume.indexOf("beginDive(target.realmId") in 0 until resume.indexOf("resumeAt = target"))
        assertTrue("its clouds are up at once", "cover.start(frameNow - cover.showAfterMs - cover.rampMs)" in resume)
        val clouds = DiveCoverClock()
        clouds.start(1_000.0 - clouds.showAfterMs - clouds.rampMs)
        assertEquals("the new globe (not the place the player left) is never shown", 1.0, clouds.alpha(1_000.0), 0.0)
        assertTrue("a pinch dive is never a resume", "diveWaitLog.start(); resumeAt = null" in hostBetween("private fun beginDive", "private fun diveStep"))
    }

    // ---------------------------------------------------------------- 2. the fallback: the clean globe

    @Test fun `a resume that cannot happen ends on the new engine's clean globe`() {
        val resuming = WorldHudFlow.engineMounted(onSunscar(WorldHudUi(night = true)), camera)
        // the engine refused it, its dive stalled, the watchdog fired: the new engine never selected the realm
        val failed = WorldHudFlow.diveFailed(resuming, "sunscar").ui
        assertEquals(WorldHudMode.GLOBE, failed.mode); assertEquals(GlobePanel.NONE, failed.panel)
        assertNull(failed.realmId); assertNull(failed.card); assertNull(failed.resume)
        assertTrue("the player's toggles carry", failed.night)
        // a normal dive's failure still puts the realm's panel back so Enter map can retry
        val normal = WorldHudFlow.enterMap(WorldHudFlow.selectRealm(WorldHudUi(), "sunscar").ui, "sunscar").ui
        assertEquals(GlobePanel.REALM, WorldHudFlow.diveFailed(normal, "sunscar").ui.panel)
        // Back during the resume: the engine cancels the dive and answers DiveFailed, heard while LEAVING
        val back = WorldHudFlow.leave(resuming)
        assertEquals(listOf(WorldIntent.Leave), back.intents)
        assertEquals(failed, WorldHudFlow.diveFailed(back.ui, "sunscar").ui)
        assertTrue("heard only while a dive or its Back is on screen: after the watchdog the HUD is on the globe already",
            "is WorldHudEvent.DiveFailed -> if (u.mode == WorldHudMode.DIVING || u.mode == WorldHudMode.LEAVING) {" in screen)
        // a realm the new build has no map for, or no engine controls: refused before any dive
        assertTrue("if (controls == null || target.realmId !in bridge.mapRealms) applyNow(WorldHudFlow.diveFailed(uiNow, target.realmId))" in screen)
    }

    @Test fun `a host that cannot start the resume refuses it at once, and its globe stays clean`() {
        assertEquals("the globe is not ready", WorldEngineHost.resumeRefusal(false, true, WorldEngineHost.MODE_GLOBE, true))
        assertEquals("no realm maps", WorldEngineHost.resumeRefusal(true, false, WorldEngineHost.MODE_GLOBE, true))
        assertEquals("the world is not on the globe (dive-wait)", WorldEngineHost.resumeRefusal(true, true, WorldEngineHost.MODE_DIVE_WAIT, true))
        assertEquals("the realm has no map", WorldEngineHost.resumeRefusal(true, true, WorldEngineHost.MODE_GLOBE, false))
        assertNull(WorldEngineHost.resumeRefusal(true, true, WorldEngineHost.MODE_GLOBE, true))

        // the real host, off GL: the refusal is an event now, never the HUD's 12 s watchdog
        val events = CopyOnWriteArrayList<WorldHudEvent>()
        val h = host(events)
        method("resumeRealm", RealmResume::class.java).invoke(h, camera)
        assertEquals(listOf<WorldHudEvent>(WorldHudEvent.DiveFailed("sunscar", "resume refused: the globe is not ready")), events.toList())
        assertEquals("no dive started", WorldEngineHost.MODE_GLOBE, field("mode").getInt(h))

        val fail = hostBetween("private fun failDive", "private fun resumeRealm")
        assertTrue("a failed resume selects nothing on the globe", "if (resumeAt == null) g.diveResult(false, id, now)" in fail)
    }

    @Test fun `anything but a realm map on screen starts over on the new globe with the player's own choices`() {
        val choosing = WorldHudFlow.entry(WorldHudUi(night = true, motion = false), WorldEntry.ChooseLand, 0, 0, null, null, false).ui
        val clean = WorldHudUi(intent = WorldHudIntent.CHOOSE_LAND, night = true, motion = false)
        // a dive or a leave in flight when the app stopped ends with its engine, not at a watchdog
        val diving = WorldHudFlow.enterMap(WorldHudFlow.selectRealm(choosing, "sunscar").ui, "sunscar").ui
        assertEquals(clean, WorldHudFlow.engineMounted(diving, camera))
        assertEquals(clean, WorldHudFlow.engineMounted(WorldHudFlow.leave(onSunscar(choosing)).ui, camera))
        // a cross-realm jump waiting for its leave does not dive on its own
        assertEquals(clean, WorldHudFlow.engineMounted(WorldHudFlow.jump(onSunscar(choosing), "frostveil", RealmCard(12_000, 480, 16)).ui, camera))
        // a map with no camera of its own (it never drew a frame), or another realm's camera
        assertEquals(clean, WorldHudFlow.engineMounted(onSunscar(choosing), null))
        assertEquals(clean, WorldHudFlow.engineMounted(onSunscar(choosing), camera.copy(realmId = "frostveil")))
        // the globe: a panel or a selection does not carry, the new engine has none
        assertEquals(clean, WorldHudFlow.engineMounted(WorldHudFlow.selectRealm(choosing, "sunscar").ui, camera))
        assertEquals("Choose a realm for your land", WorldHudFlow.hint(clean, "fallback"))
        assertTrue("the screen offers the toggles to every new engine", "LaunchedEffect(ui.night, bridge) { bridge.offer(WorldIntent.SetNight(ui.night)) }" in screen)
        assertFalse("no Back layer leaves a map the new engine never entered", BackPriority.REALM_MAP in WorldHudFlow.backLayers(clean))
    }

    @Test fun `a stop during the resume resumes again, but not after the player pressed Back`() {
        val resuming = WorldHudFlow.engineMounted(onSunscar(), camera)
        assertEquals("locked again mid-resume: the same camera, whatever the last frame", resuming, WorldHudFlow.engineMounted(resuming, null))
        val leaving = WorldHudFlow.leave(resuming).ui
        assertEquals(WorldHudUi(), WorldHudFlow.engineMounted(leaving, camera))
    }

    @Test fun `the screen follows every new engine, keeps the realm camera and sends the resume once the engine is up`() {
        // the path: a stopped app ends the visit, its end drops the art, a new art is a new bridge and a new engine
        assertTrue("lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(selectedBaseId) }" in worldScreen)
        val foreground = model.substring(model.indexOf("suspend fun foreground"), model.indexOf("private suspend fun loadArt"))
        assertTrue("_state.update { it.copy(art=null," in foreground.substring(foreground.indexOf("finally")))
        assertTrue("val bridge = remember(art) { WorldHudBridge() }" in screen)
        assertTrue("if (art != null) key(art) { engine.Content(art, bridge, Modifier.fillMaxSize()) }" in screen)
        assertTrue("while the HUD state outlives it", "var ui by remember(selectedBaseId) { mutableStateOf(WorldHudUi()) }" in screen)
        // a released host tells the HUD nothing: the HUD must follow the mount itself
        val events = CopyOnWriteArrayList<WorldHudEvent>()
        val old = host(events)
        field("mode").setInt(old, WorldEngineHost.MODE_REALM); field("shownRealm").set(old, "sunscar")
        old.releaseWithoutGl()
        assertTrue("a released host is silent: ${events.toList()}", events.isEmpty())
        assertEquals("and a new one starts on the globe", WorldEngineHost.MODE_GLOBE, field("mode").getInt(host(events)))

        // D-191 follow-up: with the chips the map can show at the mount, so the resume lands with the filter the toolbar
        // shows (WorldHudFlowTest: a stopped app's next visit starts before any read carries the shield bit)
        assertTrue("every engine after the first re-plans the HUD",
            "LaunchedEffect(bridge) { if (art != null && engines[0]++ > 0) ui = WorldHudFlow.engineMounted(uiNow, lastRealm[0], chipsNow) }" in screen)
        val keep = screen.substring(screen.indexOf("val lastRealm = remember"), screen.indexOf("val engines = remember"))
        assertTrue("the camera comes from the realm engine's frames", "bridge.latestFrame()?.takeIf { it.engine == WorldEngine.REALM }" in keep)
        assertTrue("lastRealm[0] = RealmResume(realm, f.cameraX, f.cameraY, f.cameraScale)" in keep)
        val send = screen.substring(screen.indexOf("LaunchedEffect(bridge, hudReady, ui.resume)"))
        assertTrue("only once the new engine is up, and only while still diving back (not after a Back)",
            "if (!hudReady || uiNow.mode != WorldHudMode.DIVING) return@LaunchedEffect" in send)
        assertTrue("else controls.resume(target)" in send)
        assertTrue("the host answers it on the GL thread", "override fun resume(target: RealmResume) = post { _ -> resumeRealm(target) }" in hostSource)
    }

    // ---------------------------------------------------------------- 3. Back never leaves a HUD-less screen

    @Test fun `a Leave the globe cannot perform is answered at once and the HUD is back on the globe`() {
        val events = CopyOnWriteArrayList<WorldHudEvent>()
        val h = host(events)
        field("globe").set(h, blank(GlobeV2Renderer::class.java))
        val apply = method("applyIntent", WorldIntent::class.java)
        apply.invoke(h, WorldIntent.Leave)
        assertEquals("on the globe: nothing to leave, said at once", listOf<WorldHudEvent>(WorldHudEvent.NothingToLeave), events.toList())
        events.clear(); field("mode").setInt(h, WorldEngineHost.MODE_FADE_OUT)
        apply.invoke(h, WorldIntent.Leave)
        assertTrue("a leave already fading says nothing: its Left follows", events.isEmpty())

        // the HUD's Back from the stale map: LEAVING composes no HUD at all, so the answer ends it at once
        val leaving = WorldHudFlow.leave(onSunscar())
        assertEquals(listOf(WorldIntent.Leave), leaving.intents)
        assertTrue("WorldHudMode.LEAVING -> Unit" in screen)
        val back = WorldHudFlow.nothingToLeave(leaving.ui)
        assertEquals(WorldHudMode.GLOBE, back.ui.mode)
        assertEquals("as a real leave: the realm's panel, selected again", GlobePanel.REALM, back.ui.panel); assertEquals("sunscar", back.ui.realmId)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("sunscar"))), back.intents)
        assertTrue("never the 4 s watchdog", WorldHudFlow.backLayers(back.ui).none { it == BackPriority.REALM_MAP })
        val onGlobe = WorldHudUi(realmId = "sunscar", panel = GlobePanel.REALM)
        assertEquals("a late answer on the globe changes nothing", onGlobe, WorldHudFlow.nothingToLeave(onGlobe).ui)
        assertTrue("the screen applies it while leaving",
            "is WorldHudEvent.NothingToLeave -> if (u.mode == WorldHudMode.LEAVING) { model.realmWindow(null); model.select(null); applyNow(WorldHudFlow.nothingToLeave(u)) }" in screen)
    }

    @Test fun `Back during Enter map's approach flight withdraws the globe's dive before the HUD is back on the globe`() {
        // The integration review's trace: the host was still on the globe (its dive only starts when the 700 ms flight
        // ends), so Back got NothingToLeave and the HUD showed the globe and the realm panel; then the flight's end fired
        // the globe's pending dive and pulled the player into the map. "Back never leaves a HUD-less screen", and a Back
        // that looked like it worked must have worked.
        val events = CopyOnWriteArrayList<WorldHudEvent>()
        val h = host(events)
        val g = blank(GlobeV2Renderer::class.java)
        globeField("camera").set(g, GlobeCameraV2(1.0)); globeField("realmIds").set(g, listOf("crownlands", "sunscar"))
        field("globe").set(h, g)
        val entering = WorldHudFlow.enterMap(WorldHudFlow.selectRealm(WorldHudUi(), "sunscar").ui, "sunscar")
        assertEquals(listOf(WorldIntent.Dive("sunscar")), entering.intents)
        // the globe took it as its approach flight (GlobeV2Renderer.diveInto: diving, and the dive pending on sunscar)
        globeField("diving").setBoolean(g, true); globeField("pendingDive").setInt(g, 1)

        val back = WorldHudFlow.leave(entering.ui)
        assertEquals(listOf(WorldIntent.Leave), back.intents)
        method("applyIntent", WorldIntent::class.java).invoke(h, WorldIntent.Leave)
        assertEquals("the flight's end has no dive left to fire", -1, globeField("pendingDive").getInt(g))
        assertFalse("and Enter map can dive again", globeField("diving").getBoolean(g))
        assertEquals("answered at once: the HUD never waits under no HUD", listOf<WorldHudEvent>(WorldHudEvent.NothingToLeave), events.toList())
        val onGlobe = WorldHudFlow.nothingToLeave(back.ui)
        assertEquals(WorldHudMode.GLOBE, onGlobe.ui.mode); assertEquals(GlobePanel.REALM, onGlobe.ui.panel); assertEquals("sunscar", onGlobe.ui.realmId)
        assertNull("a Back is no failure", onGlobe.ui.noMap)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("sunscar"))), onGlobe.intents)
    }

    // ---------------------------------------------------------------- 4. the landing under clouds (integration review)

    @Test fun `a resume lands under its clouds until its own ground drew the saved spot, never through the snapshot fade`() {
        // Owner 2026-09-26: no grey hard-edged squares, smoothness first. A resume's old camera sits at MAP or TRUE, where
        // the core's chart (other realms' deeds veiled per deed) stood in until GROUND was in, the clouds parted over it and
        // MAP popped in. The rule itself runs on the real engine in RealmResumeLandingTest; this is the host's wiring.
        val step = hostBetween("private fun diveStep", "private fun failDive")
        val hold = step.indexOf("if (resuming) { mode = MODE_REALM; landingSince = now; landingGround = lanes?.ground?.takeIf { hasDetail(id) }?.stats; diveStall.start(now); return }")
        assertTrue("a resume lands on the realm's live frames, its stall bound counting from the landing", hold > step.indexOf("resumeAt?.let { landResume(r, it, dpr)"))
        assertTrue("before the snapshot fade (unseen under full clouds, and no lane adopts a load in a fade)", hold in 0 until step.indexOf("r.renderSnapshot("))
        val realmFrame = hostBetween("MODE_REALM -> {", "logBand(rr)")
        val landing = realmFrame.indexOf("if (landingHeld) landingStep(g, rr, now)")
        assertTrue("each live frame asks whether the ground drew it", landing > realmFrame.indexOf("rr.frame(now, idle.clockMs, idle.frozen)"))
        assertTrue("and the clouds part only after that", "if (!rr.waiting && !landingHeld) cover.live(now)" in realmFrame)
        val landed = hostBetween("private fun landingStep", "private fun cancelLanding")
        assertTrue("the renderer's rule for the realm's GROUND lane", "RealmResumeLanding.landed(r.stats.band, r.stats.groundPass, ground)" in landed)
        assertTrue("held while the lanes still make progress, each step re-arming the HUD's dive watchdog",
            "if (!landed && !diveStall.stalled(now, progress)) { publishReadiness(id, landingMeter(progress), diving = true); return }" in landed)
        assertTrue("then the HUD hears Dived and the realm controls come back with the parting clouds",
            landed.indexOf("g.diveResult(true, id, now); enteredRealm(r, id)") > landed.indexOf("landingSince = Double.NaN"))
        for (touch in listOf("touchDown", "touchMove", "touchUp"))
            assertTrue("no touch moves the saved spot unseen ($touch)", Regex("""MODE_REALM -> if \(!landingHeld\) \{[^\n]*realm\?\.$touch\(""").containsMatchIn(hostSource))
        // the watchdog's re-arm: every progress step is a new post, below the 1 a ready core posts
        val meters = listOf(0.0, 1.0, 2.0, 5.0, 300.0).map { WorldEngineHost.landingMeter(it) }
        assertTrue("$meters", meters.zipWithNext().all { (a, b) -> b > a } && meters.all { it in 0.0..0.999 })
        assertTrue("the host's stall bound is the dive's", WorldEngineHost.DIVE_STALL_MS < 12_000.0)
    }

    @Test fun `Back during the resume's landing cancels it onto the new engine's clean globe, with no error`() {
        val events = CopyOnWriteArrayList<WorldHudEvent>()
        val h = host(events)
        field("globe").set(h, blank(GlobeV2Renderer::class.java))
        field("mode").setInt(h, WorldEngineHost.MODE_REALM); field("shownRealm").set(h, "sunscar"); field("landingSince").setDouble(h, 1_000.0)
        val resuming = WorldHudFlow.engineMounted(onSunscar(), camera)
        val back = WorldHudFlow.leave(resuming)
        method("applyIntent", WorldIntent::class.java).invoke(h, WorldIntent.Leave)
        assertEquals("cancelled as in the dive's wait, never a leave whose fade shows the chart the clouds hid",
            listOf<WorldHudEvent>(WorldHudEvent.DiveFailed("sunscar", "cancelled")), events.toList())
        assertEquals("the clouds part onto the globe", WorldEngineHost.MODE_GLOBE, field("mode").getInt(h))
        assertTrue("the landing is over", field("landingSince").getDouble(h).isNaN())
        assertFalse("no fade-out leave", field("leaveRequested").getBoolean(h))
        val globe = WorldHudFlow.diveFailed(back.ui, "sunscar").ui
        assertEquals(WorldHudUi(), globe); assertNull("the player's Back: no notice", globe.noMap)
        // a map already on screen still leaves through its fade
        events.clear(); field("mode").setInt(h, WorldEngineHost.MODE_REALM); field("shownRealm").set(h, "sunscar")
        method("applyIntent", WorldIntent::class.java).invoke(h, WorldIntent.Leave)
        assertTrue(field("leaveRequested").getBoolean(h)); assertTrue(events.isEmpty())
    }

    // ---------------------------------------------------------------- a host off GL (WorldHostRecreationTest's recipe)

    private fun host(events: MutableList<WorldHudEvent>): WorldEngineHost {
        val assets = blank(AssetManager::class.java)
        val inputs = WorldHostInputs(assets, AssetWorldFiles(assets), NoFiles, null, null, 2.0, Closeable {}, null)
        return WorldEngineHost(inputs, { null }, Recording(events), File("build/tmp/world-programs"), 1L) {}
    }

    private object NoFiles : GlobeFiles { override fun read(path: String): ByteArray? = null }

    private class Recording(private val events: MutableList<WorldHudEvent>) : WorldHostCallbacks {
        override fun ready() {}
        override fun failed(reason: String) {}
        override fun framePublished() {}
        override fun event(event: WorldHudEvent) { events += event }
        override fun mapRealms(ids: Set<String>) {}
        override fun readiness(realmId: String, value: Float) {}
        override fun realmGrid(info: RealmGridInfo?) {}
        override fun loading(value: Float) {}
        override fun status(line: String) {}
        override fun bandGate(held: Boolean, band: Int, progress: Double) {}
        override fun detailRealms(ids: Set<String>) {}
    }

    private companion object {
        fun field(name: String) = WorldEngineHost::class.java.getDeclaredField(name).apply { isAccessible = true }
        fun method(name: String, vararg types: Class<*>) = WorldEngineHost::class.java.getDeclaredMethod(name, *types).apply { isAccessible = true }
        fun globeField(name: String) = GlobeV2Renderer::class.java.getDeclaredField(name).apply { isAccessible = true }

        /** A class the JVM test cannot construct (android.jar, or GL-bound), with every field null. */
        fun <T> blank(type: Class<T>): T {
            val unsafeType = Class.forName("sun.misc.Unsafe")
            val unsafe = unsafeType.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
            return type.cast(unsafeType.getMethod("allocateInstance", Class::class.java).invoke(unsafe, type))
        }
    }
}
