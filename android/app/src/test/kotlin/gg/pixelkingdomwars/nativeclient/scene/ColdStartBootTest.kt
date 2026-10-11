package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.diagnostics.bootDetail
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Field measurement 2026-10-06 (Seeker, candidate 05a72df2, cold start): SERVICE_READY 7.5 s after resume, Home live at
 * 9.6 s, and no line said where the time went. Home could not map its scene before `/base`, `/balances` and `/tutorial` had
 * answered one after another after sign-in. These pin the two answers: every boot stage leaves one account-free PKWLoad
 * line, and Home maps the last `/base` answer this device kept — for the same account and base only, geometry only, no taps
 * — then the server's answer replaces it in place.
 */
class ColdStartBootTest {
    private val now = 1_800_000_000_000L
    private fun payload(baseId: String = "base-1") = buildJsonObject { put("baseId", baseId); putJsonArray("buildings") {} }
    private fun cached(account: String = "acct-a", baseId: String = "base-1", savedAt: Long = now - 1) =
        CachedBasePayload(account, baseId, savedAt, payload(baseId))
    private fun main(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `a kept base stands only for the same account and base, and only for a while`() {
        assertNull("the field case: same account, same selected base, minutes old", cachedBaseMiss(cached(), "acct-a", "base-1", now))
        // Another account's base drawn on this account's Home would show someone else's kingdom.
        assertEquals("account", cachedBaseMiss(cached(), "acct-b", "base-1", now))
        assertEquals("account", cachedBaseMiss(cached(), null, "base-1", now))
        // A player who switched bases must not see the other base first.
        assertEquals("base", cachedBaseMiss(cached(), "acct-a", "base-2", now))
        assertEquals("base", cachedBaseMiss(cached(), "acct-a", null, now))
        assertEquals("a header that names one base over a payload of another is refused", "base",
            cachedBaseMiss(CachedBasePayload("acct-a", "base-1", now - 1, payload("base-2")), "acct-a", "base-1", now))
        assertEquals("age", cachedBaseMiss(cached(savedAt = now - BASE_CACHE_MAX_AGE_MS - 1), "acct-a", "base-1", now))
        assertEquals("a clock that went backwards is not trusted either", "age", cachedBaseMiss(cached(savedAt = now + 60_000), "acct-a", "base-1", now))
        assertEquals("none", cachedBaseMiss(null, "acct-a", "base-1", now))
    }

    @Test fun `the disk copy reads back only for the account folder it was written for`() {
        val entry = cached()
        val text = encodeCachedBase(entry)
        val back = requireNotNull(decodeCachedBase(text, "acct-a"))
        assertEquals(entry.baseId, back.baseId); assertEquals(entry.savedAtMs, back.savedAtMs); assertEquals(entry.raw, back.raw)
        assertNull("a file moved into another account's folder is ignored", decodeCachedBase(text, "acct-b"))
        assertNull("a torn write is ignored", decodeCachedBase(text.dropLast(8), "acct-a"))
        assertNull("a payload that is not the base it claims is ignored",
            decodeCachedBase(text.replace("\"raw\":{\"baseId\":\"base-1\"", "\"raw\":{\"baseId\":\"base-9\""), "acct-a"))
        assertEquals("beside the server's own answer the file holds only the hashed account key, the base and the time — never a wallet",
            setOf("v", "account", "baseId", "savedAtMs", "raw"), Json.parseToJsonElement(text).jsonObject.keys)
    }

    @Test fun `disk writes are throttled but the newest answer of each interval is the one written`() {
        assertEquals("the first answer of a launch is written at once", 0L, baseStoreDelayMs(null, 5_000))
        assertEquals("within the interval, the write waits for its end", BASE_CACHE_STORE_EVERY_MS - 10_000, baseStoreDelayMs(5_000, 15_000))
        assertEquals("after the interval, at once", 0L, baseStoreDelayMs(5_000, 5_000 + BASE_CACHE_STORE_EVERY_MS + 1))
        assertEquals("never longer than one interval, whatever the clock says", BASE_CACHE_STORE_EVERY_MS, baseStoreDelayMs(50_000, 0))
        val cache = main("scene/LastBasePayload.kt")
        assertTrue("one scheduled write takes the newest pending answer", cache.contains("pending.also { pending = null }"))
        assertTrue("an unchanged answer costs one identity compare per recomposition", cache.contains("if (raw === offered) return"))
    }

    @Test fun `a kept base draws its geometry only, never its service facts`() {
        val body = RenderBuilding("keep-1", "keep-frame", 1f, 2f, 2f, 2f, type = "workshop")
        val scene = BaseScene(listOf(body), 30, 30, 64f, baseId = "base-1",
            services = RenderServiceFacts(true, emptyList(), listOf(RenderServiceActivity(body.id, RenderServiceState.WORKING))))
        val prepared = PreparedBaseSceneResult(scene, rawSource = payload())
        val drawn = prepared.withoutServices()
        assertEquals("geometry kept", scene.copy(services = RenderServiceFacts()), drawn.scene)
        assertEquals(RenderServiceFacts(), drawn.scene!!.services)
        assertEquals("a changed answer strips the same way (one rule, N-C5)", drawn,
            prepared.forSource(buildJsonObject { put("baseId", "base-1") }))

        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue("only while the server has not answered", kingdom.contains("val heldBase = if (base == null && !editing)"))
        assertTrue("for this account and the selected base", kingdom.contains("cachedBaseMiss(heldBase, sceneAccount,\n        state.selectedBaseId,"))
        assertTrue("the server's answer always wins", kingdom.contains("val raw = if (editing) editor.draftBase else base?.raw ?: cachedRaw"))
        assertTrue("a kept base is stripped of service facts", kingdom.contains("if (fromCache) remember(prepared) { prepared.withoutServices() } else prepared"))
        assertTrue("one prepared scene, so the server's answer replaces the kept one in place",
            Regex("rememberPreparedBaseScene\\(").findAll(kingdom).count() == 1)
    }

    @Test fun `nothing a player does acts on a kept base`() {
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue("a building tap waits for the server's base", kingdom.contains("&& model.state.value.base != null) {"))
        assertTrue("a ground tap waits for the server's base", kingdom.contains("if (!sceneLive || model.state.value.base == null) return@SceneSurface"))
        // Rewritten at the night/android merge (913967ff): the move lane made land ownership no input to a move
        // (homeCarryMode, owner field result 2026-10-06). The rule here is unchanged: `base` is the server's base only — the
        // kept payload feeds `raw` alone — so a kept base carries nothing (and KingdomUiState.carryMode is null without it).
        assertTrue("`base` is the server's answer, never the kept payload", kingdom.contains("    val base = state.base\n"))
        assertTrue("the kept payload reaches the scene only", kingdom.contains("val raw = if (editing) editor.draftBase else base?.raw ?: cachedRaw"))
        assertTrue("no carry without the server's base",
            Regex("""carry = if \(base == null\) null else homeCarryMode\(state, editing\)""").containsMatchIn(kingdom))
        // Owner 2026-10-06: a failed refresh keeps the base drawn and says so once (no card over it) — a kept base too.
        assertTrue(kingdom.contains("val cachedReadFailed = fromCache && state.home.error != null && !state.home.loading"))
        assertTrue(kingdom.contains("KingdomRefreshFailedToast((preparedScene.failed && preparedScene.scene != null) || cachedReadFailed)"))
        assertTrue("and the read is tried once more", kingdom.contains("cachedRetried = true; kotlinx.coroutines.delay(gg.pixelkingdomwars.nativeclient.scene.HOME_UPDATE_RETRY_MS); model.refresh()"))
    }

    @Test fun `the kept base is written from server answers, parsed off Main and forgotten at sign-out`() {
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue("only a server answer is kept", kingdom.contains("val served = base?.raw; if (sceneAccount != null && served != null) gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.offer(sceneAccount, served)"))
        val activity = main("MainActivity.kt")
        assertTrue(activity.contains("gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.install(noBackupFilesDir)"))
        assertTrue("parsed on IO, never Main", activity.contains("lifecycleScope.launch(Dispatchers.IO) { gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.prewarm() }"))
        val postcards = main("scene/ScenePostcards.kt")
        assertTrue("sign-out drops the kept base with the postcard", postcards.contains("slot.forget(account); world.forget(null)\n        LastBasePayload.forget(account)"))
        val cache = main("scene/LastBasePayload.kt")
        assertTrue("a newer answer already held is never replaced by the older disk copy",
            cache.contains("if ((held.value?.savedAtMs ?: Long.MIN_VALUE) < cached.savedAtMs) held.value = cached"))
    }

    @Test fun `every boot stage leaves one account-free line where it ends`() {
        assertEquals("t=1200 ms=340", bootDetail(1200, 340))
        assertEquals("t=90", bootDetail(90, null))
        assertEquals("t=2100 cache=hit", bootDetail(2100, null, "cache=hit"))
        // Each mark sits between the call it times and the next step, so the lines attribute the serial chain call by call.
        fun ordered(source: String, vararg steps: String) {
            var at = -1
            for (step in steps) { val next = source.indexOf(step, at + 1); assertTrue("$step follows the step before it", next > at); at = next }
        }
        val account = main("data/AccountRepository.kt")
        ordered(account, "client(token).get(\"/auth/login/status\")", "LoadEvent.BOOT_SESSION", "if (status.loginRequired)")
        ordered(account, "Identity.from(api.get(\"/me\", session = token))", "LoadEvent.BOOT_IDENTITY", "client.get(\"/bases\")",
            "LoadEvent.BOOT_DIRECTORY", "client.get(\"/playtest/access\")", "phase = AccountPhase.SIGNED_IN", "LoadEvent.BOOT_SIGNED_IN", "onSession(session)")
        val base = main("data/BaseRepository.kt")
        // Rewritten 2026-10-06 (dfa3ad2a + the Home-first round): /base and /balances go through homeGet (one immediate repeat
        // of a transient 5xx); the marks still sit between each call and the next step, and the ask is marked first.
        ordered(base, "LoadEvent.BOOT_BASE_ASK", "homeGet(api, \"/base\", baseQuery)", "LoadEvent.BOOT_BASE_READ",
            "homeGet(api, \"/balances\", query)", "LoadEvent.BOOT_BALANCES", "api.get(\"/tutorial\", query)", "LoadEvent.BOOT_TUTORIAL",
            "return HomeSnapshot(")
        assertTrue(main("data/ContentRepository.kt").contains("diagnostics.LoadEvent.BOOT_CONTENT, started)"))
        assertTrue(main("update/BootUpdateGate.kt").contains("diagnostics.LoadEvent.BOOT_CAPABILITIES,\n                started, if (read != null) \"answered\" else \"unanswered\")"))
        assertTrue(main("ui/kingdom/KingdomScreen.kt").contains("LoadEvent.BOOT_HOME, note = \"cache=\${cachedMiss ?: \"hit\"}\")"))
        assertTrue(main("scene/LastBasePayload.kt").contains("BootTimeline.stage(LoadEvent.BOOT_CACHED_BASE, started)"))
        assertTrue("each launch measures its own boot", main("ui/boot/BootScreen.kt").contains("init { gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.beginLaunch() }"))
        // Like every PKWLoad line, the stage lines reach logcat on debug and candidate builds: no identity at any call site.
        val sources = File("src/main/kotlin").walkTopDown().filter { it.name.endsWith(".kt") }.map { it.readText() }.joinToString("\n")
        val calls = Regex("""BootTimeline\.stage\([^\n]*""").findAll(sources).map { it.value }.toList()
        assertTrue(calls.size >= 11)
        for (line in calls) for (private in listOf("baseId", "wallet", "session", "raw.", "base?.", "token"))
            assertFalse("BOOT lines are account-free: $line", line.contains(private))
    }

    @Test fun `a boot mark without an Android clock is a no-op, so repository tests on the JVM never see it`() {
        SceneLoadLog.reset()
        BootTimeline.beginLaunch()
        BootTimeline.stage(LoadEvent.BOOT_SESSION, BootTimeline.clock())
        assertNull(BootTimeline.clock())
        assertEquals(0, SceneLoadLog.count(LoadEvent.BOOT_SESSION))
        SceneLoadLog.reset()
    }
}
