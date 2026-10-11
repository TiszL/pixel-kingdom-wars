package gg.pixelkingdomwars.nativeclient.scene

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06 ("no loading screens over gameplay"; "black screen is low quality indication … professional solution"):
 * a Home that re-enters composition gets a new GL renderer, and the live HUD sat over an opaque black shell meanwhile. The
 * last Home frame — now the POSTCARD of scene-transitions spec §4 step 5 — is the cover instead. A wrong picture is worse
 * than none, so it is shown only for the same account, content, base and surface size, and never over a battle.
 *
 * Rewritten 2026-10-06 (spec V1): the one-slot "last frame" of the morning became postcards (account-keyed, 72 h, disk),
 * and the per-surface HomeOpeningVeil became KingdomScreen's single ScenePresentationLayer; each rule below is the same
 * rule on the new owner, plus the account and expiry it now also needs.
 */
class HomeFrameVeilTest {
    private val now = 1_000_000_000L
    private val key = PostcardKey("acct-a", "native-kingdom-bundled-abc", "base-1", 1200, 2670)
    private fun admitted(account: String? = "acct-a", tag: String? = "native-kingdom-bundled-abc", base: String? = "base-1",
        w: Int = 1200, h: Int = 2670, savedAt: Long = now - 1_000) = postcardAdmitted(key, savedAt, account, tag, base, w, h, now)

    @Test fun `the last frame veils only the same base on the same content at the same surface size`() {
        assertTrue(admitted())
        assertFalse("nothing copied yet", postcardAdmitted(null, now, "acct-a", "native-kingdom-bundled-abc", "base-1", 1200, 2670, now))
        assertFalse("another content generation draws other art", admitted(tag = "native-kingdom-bundled-def"))
        assertFalse("another base is another kingdom", admitted(base = "base-2"))
        assertFalse("no base yet", admitted(base = null))
        assertFalse("rotated: every building would sit in the wrong place", admitted(w = 2670, h = 1200))
        assertFalse("resized", admitted(h = 2400))
        assertFalse("not laid out", admitted(w = 0, h = 0))
    }

    @Test fun `a postcard never crosses accounts and expires after 72 hours`() {
        assertFalse("another signed-in account", admitted(account = "acct-b"))
        assertFalse("signed out", admitted(account = null))
        assertTrue("72 h is still the last look", admitted(savedAt = now - POSTCARD_MAX_AGE_MS))
        assertFalse("older than 72 h is a different kingdom by now", admitted(savedAt = now - POSTCARD_MAX_AGE_MS - 1))
        assertFalse("a clock that went backwards proves nothing", admitted(savedAt = now + 60_000))
    }

    @Test fun `the newest copy wins and a failed copy keeps the previous frame`() {
        val slot = PostcardSlot<String>()
        val first = slot.begin(); val second = slot.begin()
        assertFalse("a copy that finishes after a newer request began is dropped", slot.complete(first, Postcard(key, "older", null, now)))
        assertNull(slot.shown)
        assertTrue(slot.complete(second, Postcard(key, "newer", null, now)))
        assertEquals("newer", slot.shown!!.image)
        slot.begin() // this copy fails: PixelCopy never completes it
        assertEquals("the last good frame still covers the next opening", "newer", slot.shown!!.image)
    }

    private fun main(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `both Home opening stages are covered by the one presentation layer, never the dark shell`() {
        val host = main("scene/SceneHost.kt")
        assertTrue("SceneSurface draws no veil of its own when its parent covers it",
            host.contains("if (!sceneReady && !coveredByParent) LoadingOverlay("))
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue("Home covers its own surface", kingdom.contains("coveredByParent = true"))
        // Rewritten 2026-10-06: the strip redesign (owner 12:10 UTC, "improve visually too") gave the cover the realm's accent,
        // so the call gained a trailing realmId argument; the rule — one layer for every stage and failure, its line under the
        // parent's top chrome — is pinned unchanged, and the accent is pinned to the scene's own realm.
        assertTrue("the mapping stage, the GL stage and every failure share the layer",
            kingdom.contains("ScenePresentationLayer(live, shownPostcard, coverFailed, coverRetry, lineTop = parentPadding.calculateTopPadding(),"))
        assertTrue("the cover's strip takes the scene's own realm accent", kingdom.contains("realmId = preparedScene?.scene?.visual?.realmId)"))
        assertFalse("no LoadingOverlay anywhere on Home", kingdom.contains("LoadingOverlay("))
        assertFalse("no centred notice plate over the scene area", kingdom.contains("KingdomOpenNotice("))
    }

    @Test fun `the frame is copied while the surface is still attached, before the fragment is removed`() {
        val host = main("scene/SceneHost.kt")
        val remove = host.substring(host.indexOf("val removeFragment: () -> Unit"), host.indexOf("// A parent node detaches before its children."))
        val copy = remove.indexOf("ScenePostcards.capture(fragment, fragmentTag, proactive = false)")
        assertTrue(copy >= 0)
        assertTrue("removing the fragment destroys the GL surface the copy reads", copy < remove.indexOf("beginTransaction().remove(fragment)"))
    }

    @Test fun `the copy and the cover are measured`() {
        val postcards = main("scene/ScenePostcards.kt")
        assertTrue(postcards.contains("SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, \"\$why skipped\")"))
        assertTrue(postcards.contains("SceneLoadLog.mark(LoadEvent.FRAME_CAPTURE, \"\$why failed code=\$result\")"))
        val layer = main("ui/kingdom/ScenePresentation.kt")
        assertTrue(layer.contains("SceneLoadLog.mark(LoadEvent.VEIL_SHOWN, \"kind="))
        assertTrue(layer.contains("SceneLoadLog.mark(LoadEvent.SUMMARY,"))
    }
}
