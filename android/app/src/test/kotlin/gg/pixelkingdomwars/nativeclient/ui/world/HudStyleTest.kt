package gg.pixelkingdomwars.nativeclient.ui.world

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * D-166/D-167: the native HUD is the approved web HUD, not a look-alike. Every token, realm accent, chip and band the
 * Kotlin HUD uses is compared with the reference exported from the pinned web commit (`tools/world-hud.mjs`), so a
 * palette, bevel, type-scale or chip drift on either side fails here instead of shipping two different HUDs.
 */
class HudStyleTest {
    private val ref = HudReference.json

    private fun JsonObject.strings(): Map<String, String> = mapValues { it.value.jsonPrimitive.content }

    @Test fun `every root token is the pinned HUD_CSS value, in order`() {
        val tokens = ref.getValue("tokens").jsonObject
        assertEquals(tokens.getValue("root").jsonObject.strings().toList(), HudTokens.ROOT.toList())
    }

    @Test fun `the media overrides match the pinned type scale rules`() {
        val media = ref.getValue("tokens").jsonObject.getValue("media").jsonObject
        assertEquals(media.getValue("dppx2").jsonObject.strings(), HudTokens.DPPX2)
        assertEquals(media.getValue("portrait").jsonObject.strings(), HudTokens.PORTRAIT)
        assertEquals(media.getValue("shortLandscape").jsonObject.strings(), HudTokens.SHORT_LANDSCAPE)
    }

    @Test fun `colours and bevel rows are parsed from the tokens, never retyped`() {
        assertEquals(parseCssColor("#e3ae3c"), HudStyle.gold)
        assertEquals(parseCssColor("#554c40"), HudStyle.stone)
        // The stone bevel: two light rows top/left, three dark rows bottom/right, first-listed on top (the CSS order).
        assertEquals(listOf(1 to 1, 2 to 2, -1 to -1, -2 to -2, -3 to -3), HudStyle.bevelStone.map { it.dx to it.dy })
        assertEquals(parseCssColor("#87785f"), HudStyle.bevelStone.first().color)
        assertEquals(5, HudStyle.rim.size)
        assertEquals(parseCssColor("#1a171e"), HudStyle.rim.first().color)
        // rgba alpha rounds like a browser: .92 × 255 = 234.6 → 235.
        assertEquals(235, (HudStyle.wellFill.alpha * 255 + .5f).toInt())
        assertEquals(500, HudStyle.slideMs); assertEquals(300, HudStyle.fadeMs)
        assertEquals(48f, HudStyle.tap); assertEquals(44f, HudStyle.tapMin)
    }

    @Test fun `glows are the pinned hud_js shadows and blur the way CSS blurs`() {
        val root = ref.getValue("tokens").jsonObject.getValue("root").jsonObject
        assertEquals(parseShadow(root.getValue("--hud-gold-glow").jsonPrimitive.content), HudStyle.goldGlow)
        assertEquals(HudShadow(0f, 0f, 18f, -4f, parseCssColor("rgba(227,174,60,.6)")), HudStyle.goldGlow)
        assertEquals(HudShadow(0f, 2f, 0f, 0f, parseCssColor("rgba(0,0,0,.45)")), HudStyle.countDrop)
        assertThrows(IllegalArgumentException::class.java) { parseShadow("inset 1px 1px 0 #87785f") }
        // CSS blurs with a Gaussian of sigma = blur / 2; Skia turns a radius r into sigma = 0.57735 r + 0.5. The gold glow
        // (18 CSS px) on a 2.625 dppx Seeker is 47.25 px, sigma 23.625 px, so Skia must get r = 40.05 px, not 47.25.
        val r = cssBlurToSkiaRadius(47.25f)
        assertEquals(40.05f, r, 0.01f)
        assertEquals(47.25f / 2f, 0.57735f * r + 0.5f, 1e-3f)
        assertEquals("a hard shadow has no blur", 0f, cssBlurToSkiaRadius(0f), 0f)
        assertEquals("a sub-pixel blur is no blur", 0f, cssBlurToSkiaRadius(0.8f), 0f)
    }

    @Test fun `the panel entrance and exit keep the web's timings`() {
        // main.js countUp: e = clamp((now − t0 − 180) / 700, 0, 1), k = 1 − (1 − e)³, the figure is Math.round(n · k).
        assertEquals(0L, HudMotion.countUp(1234, 0f)); assertEquals(0L, HudMotion.countUp(1234, 180f))
        assertEquals("e = .5 → k = .875 → 1079.75 rounds up", 1080L, HudMotion.countUp(1234, 530f))
        assertEquals(1234L, HudMotion.countUp(1234, 880f)); assertEquals(1234L, HudMotion.countUp(1234, 60_000f))
        // index.html pIn: each child starts 110 + 50·i ms in and rises over --hud-t-slide; the CTA (i = 7) ends last.
        assertEquals(110, HudMotion.staggerDelay(0)); assertEquals(460, HudMotion.staggerDelay(HudMotion.CTA_INDEX))
        assertEquals(0f, HudMotion.stagger(7, 460f), 0f); assertEquals(0.5f, HudMotion.stagger(7, 710f), 1e-6f); assertEquals(1f, HudMotion.stagger(7, 960f), 0f)
        assertEquals(960, HudMotion.ENTRANCE_MS)
        // #panel: opacity .3s (reduced motion .2s) next to the .5s transform.
        assertEquals(HudStyle.fadeMs, HudMotion.FADE_MS); assertEquals(200, HudMotion.REDUCED_FADE_MS)
    }

    @Test fun `the type scale follows the web media queries on Seeker densities`() {
        // Every Seeker row is >= 2 dppx: the small steps apply. Portrait and short landscape use the small display size.
        for (d in SeekerRows.DENSITIES) {
            val (pw, ph) = SeekerRows.portrait(d)
            val p = HudType.of(d, landscape = pw > ph, heightDp = ph)
            assertEquals(HudType(16f, 16f, 18f, 20f, 24f, 30f, 24f, 24f, 12f), p)
            val (lw, lh) = SeekerRows.landscape(d)
            val l = HudType.of(d, landscape = lw > lh, heightDp = lh)
            assertTrue("Seeker landscape is short (≤ 520 dp tall)", lh <= 520f)
            assertEquals("short landscape shrinks the big numbers to the ui size", 20f, l.numLg)
            assertEquals(24f, l.display)
        }
        // A 1× tall landscape screen keeps the pixel-exact 20/40 steps and the large display name.
        assertEquals(HudType(20f, 20f, 20f, 20f, 20f, 40f, 32f, 24f, 12f), HudType.of(1f, landscape = true, heightDp = 800f))
    }

    @Test fun `realm accents are the globe's light for all eight realms`() {
        val realms = ref.getValue("realms").jsonObject
        assertEquals(realms.keys, HudRealms.ACCENT.keys)
        for ((id, r) in realms) assertEquals(id, r.jsonObject.getValue("accent").jsonPrimitive.content, HudRealms.ACCENT[id])
        // ui.js keeps its own copy for the five map realms; both must agree with landmarks.js.
        for ((id, v) in ref.getValue("realmAccentUi").jsonObject) assertEquals(id, v.jsonPrimitive.content, HudRealms.ACCENT[id])
    }

    @Test fun `the approved chips are the pinned set but for D-191's Unshielded, and the data-less three stay hidden until a feed carries them`() {
        val chips = ref.getValue("chips").jsonArray.map { it.jsonObject }
        // SHARDKEEP D-191 (owner 2026-09-28, endorsing a player: "instead of Shielded … Unshielded: the purpose of searching
        // is to raid, their target should be the unshielded"): the shield chip is Unshielded, ahead of the pinned web
        // reference, whose ui.js at the pin still declares Shielded. The reference is regenerated, never hand-edited, so
        // this test carries the one divergence: when the pin moves to a web that has D-191 the reference will carry the
        // new chip, this assertion fails, and the exception below is dropped for plain equality.
        // It waits for the web's D-191 commits: SHARDKEEP branch `realm-filter-hide`, `27803dcdf..5fc4c675b`
        // (530f11c0f "feat(worldv2): hide filtered-out kingdoms and add Unshielded chip" + tests/docs; the K-211 host fix
        // follows on that branch). Those commits change the production port `apps/web/src/ui/fantasy/worldv2/realm/ui.mjs`,
        // while tools/world-hud.mjs reads CONCEPT `concepts/globe3d-2026-09-23/src/realm/ui.js`, which that branch does not
        // contain (the pin 02fe82b4 is on `globe-realms` / `globe-realms-veil`): the re-export that lifts this
        // needs a pin whose concept ui.js declares Unshielded, or the generator pointed at the port.
        val shieldAt = chips.indexOfFirst { it.getValue("id").jsonPrimitive.content == "shield" }
        assertTrue("the pinned reference still declares the pre-D-191 Shielded chip; if not, drop the D-191 exception here", shieldAt >= 0)
        assertEquals(listOf("Shielded", "Shield", "Shielded"), listOf("lg", "sm", "aria").map { chips[shieldAt].getValue(it).jsonPrimitive.content })
        assertEquals(HudChip("unshielded", true, "Unshielded", "No shield", "Unshielded", "shield"), HudChips.ALL[shieldAt])
        assertEquals(chips.map { it.getValue("id").jsonPrimitive.content }.mapIndexed { i, id -> if (i == shieldAt) "unshielded" else id }, HudChips.ALL.map { it.id })
        chips.zip(HudChips.ALL).forEachIndexed { i, (r, k) ->
            if (i == shieldAt) return@forEachIndexed
            assertEquals(r.getValue("lg").jsonPrimitive.content, k.long)
            assertEquals(r.getValue("sm").jsonPrimitive.content, k.short)
            assertEquals(r["aria"]?.jsonPrimitive?.contentOrNull, k.aria)
            assertEquals(r.getValue("kind").jsonPrimitive.content == "filter", k.filter)
        }
        assertEquals("the retired Shielded chip is gone (a three-state chip comes back only on the owner's word)", 0, HudChips.ALL.count { it.id == "shield" })
        // D-169: hidden (not disabled, not faked) while no public feed carries clan, attackable or a bulk shield bit.
        assertEquals(listOf("all", "mine", "lvl"), HudChips.shown(emptySet()).map { it.id })
        assertEquals(HudChips.ALL, HudChips.shown(setOf("clan", "attackable", "shield")))
        // D-181: once the realm feed's markers carry `shielded` (server PR #147) the realm map shows Unshielded; before that
        // (a server without the PR) it stays hidden like the others. Clan and attackable still have no feed at all.
        assertEquals(listOf("all", "mine", "unshielded", "lvl"), HudChips.realm(shieldFed = true).map { it.id })
        assertEquals(listOf("all", "mine", "lvl"), HudChips.realm(shieldFed = false).map { it.id })
    }

    @Test fun `the bands and flags the HUD reads are the pinned contracts`() {
        val b = ref.getValue("bands").jsonObject
        assertEquals(b.getValue("uiDots").jsonPrimitive.double, HudBands.UI_DOTS_S, 0.0)
        assertEquals(b.getValue("uiIcons").jsonPrimitive.double, HudBands.UI_ICONS_S, 0.0)
        assertEquals(b.getValue("keepMinCss").jsonPrimitive.double, HudBands.KEEP_MIN_CSS, 0.0)
        assertEquals(b.getValue("mapStart").jsonPrimitive.double, HudBands.MAP_START_D, 0.0)
        assertEquals(b.getValue("trueFull").jsonPrimitive.double, HudBands.TRUE_FULL_D, 0.0)
        assertEquals(b.getValue("selectD").jsonPrimitive.double, HudBands.SELECT_D, 0.0)
        assertEquals(b.getValue("myBaseD").jsonPrimitive.double, HudBands.MY_BASE_D, 0.0)
        assertArrayEquals(b.getValue("impostor").jsonArray.map { it.jsonPrimitive.double }.toDoubleArray(), HudBands.IMPOSTOR_D, 0.0)
        val f = ref.getValue("flag").jsonObject.mapValues { it.value.jsonPrimitive.int }
        assertEquals(mapOf("occupied" to HudFlag.OCCUPIED, "mine" to HudFlag.MINE, "shield" to HudFlag.SHIELD, "attackable" to HudFlag.ATTACKABLE,
            "filteredIn" to HudFlag.FILTERED_IN, "selected" to HudFlag.SELECTED, "clan" to HudFlag.CLAN, "hovered" to HudFlag.HOVERED), f)
    }

    @Test fun `the globe hint and tool set are the pinned page's`() {
        val globe = ref.getValue("globe").jsonObject
        assertEquals("Shaping the realms…", globe.getValue("loading").jsonPrimitive.content)
        val tools = globe.getValue("tools").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }
        assertEquals(listOf("in", "out", "mine", "world", "night"), tools)
        // Native keeps the globe tool set (MY PARCEL is the F1 name of "My base") and adds nothing to it. It drops the
        // page's "world" (fly to the whole-world frame): the owner (2026-09-26) found it does nothing on the world scene.
        assertEquals(listOf("MY PARCEL", "NIGHT"), GlobeHudPlan.TOOLS)
    }
}

/** The pinned web HUD reference (tools/world-hud.mjs output). */
object HudReference {
    val json: JsonObject by lazy {
        Json.parseToJsonElement(requireNotNull(HudReference::class.java.getResource("/world-hud/source-reference.json")) { "Run tools/world-hud.mjs" }.readText()).jsonObject
    }
}
