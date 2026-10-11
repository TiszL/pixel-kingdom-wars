package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.hud.DeckStack
import gg.pixelkingdomwars.nativeclient.ui.hud.EdgeTabMark
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.hud.deckIconDp
import gg.pixelkingdomwars.nativeclient.ui.hud.deckStack
import gg.pixelkingdomwars.nativeclient.ui.hud.edgeTabMark
import gg.pixelkingdomwars.nativeclient.ui.hud.hudIconDp
import gg.pixelkingdomwars.nativeclient.ui.hud.stackHeight
import gg.pixelkingdomwars.nativeclient.ui.hud.tabTop
import gg.pixelkingdomwars.nativeclient.ui.kit.chunkyContentPadding
import gg.pixelkingdomwars.nativeclient.ui.model.ChipTone
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Home HUD fidelity against design/final `home.png`, `hub/toasts.png` and `account/onboard-first-home.png` (owner,
 * 2026-10-06: "chat and email buttons still does not look as originally intended", the "NO LAND YET" line over the dock,
 * the resource pills over the Leagues header). WHY these matter: the Home HUD is the screen every session starts on, and
 * each rule here is a place the build drifted from the designed screen the owner signed off. Composables do not run on the
 * JVM, so the drawing rules live in pure functions tested here and the mount lines are pinned in source, as
 * HomeLayerHooksTest does.
 */
class HomeDockFidelityTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
    private val scaffold = File("$root/ui/home/HomeScaffold.kt").readText()
    private val loaded = BaseState(base = BaseSnapshot(baseId = "base-a", visualContext = null,
        player = PlayerSummary(keepLevel = 3, trophies = "12", league = "silver"), energy = null, armyStatus = null, claim = null,
        buildings = emptyList(), obstacles = emptyList(), jobs = emptyList(), freeBuilders = 1, raw = JsonObject(emptyMap())))
    private fun hud() = homeHudState(loaded, null, 0, true, 0, 0, false)

    @Test fun `the mail and chat tabs draw the designed envelope and speech marks`() {
        // The tabs were white 12-cell glyphs on a chunky button. The binding's icons must map to the drawn marks, or the
        // tab silently falls back to the old glyph.
        val tabs = hud().leftEdge
        assertEquals(listOf(HudIds.MAIL, HudIds.CHAT), tabs.map { it.id })
        assertEquals(listOf(EdgeTabMark.MAIL, EdgeTabMark.CHAT), tabs.map { edgeTabMark(it.icon) })
        assertEquals("the glyph alias names the same mark", EdgeTabMark.MAIL, edgeTabMark("shape:mail"))
        assertEquals(EdgeTabMark.CHAT, edgeTabMark("shape:chat"))
        assertNull("any other icon keeps PkwIcon, never a blank tab", edgeTabMark("quest"))
    }

    @Test fun `the tabs and their badges sit where home png puts them`() {
        // home.html: MAIL 44 x 48 at (0, 712) with its count badge's left edge at (30, 702); CHAT 4 dp below at 764.
        assertEquals(44, HudGeometry.TAB_W)
        assertEquals(48, HudGeometry.TAB_H)
        assertEquals(30, HudGeometry.TAB_BADGE_X)
        assertEquals(-10, HudGeometry.TAB_BADGE_Y)
        assertEquals(712, tabTop(0, 2))
        assertEquals(764, tabTop(1, 2))
    }

    @Test fun `BUILD wears the authored hammer at 32`() {
        val build = hud().deck.single { it.id == HudIds.BUILD }
        assertEquals("pkw_web_item_hammer, not the drawn white glyph", "itm_hammer", build.icon)
        assertEquals(32, hudIconDp(build.icon, large = true))
    }

    @Test fun `the status chip wears the crest of the league the server names and never claims another`() {
        assertEquals("league-silver", hud().trophies?.icon)
        for (tier in listOf("bronze", "silver", "gold", "sol")) assertEquals("league-$tier", homeLeagueCrest(tier))
        assertEquals("league-gold", homeLeagueCrest(" Gold "))
        for (unknown in listOf(null, "", "diamond")) assertEquals("an unknown league keeps the cup", "trophy", homeLeagueCrest(unknown))
    }

    @Test fun `a free camp label stands alone in muted text so it fits the chip whole`() {
        // onboard-first-home.png: "free camp" with no shield icon, muted. With the 24 dp shield beside it the segment ran
        // past the 238 dp chip and read "free c…" on the owner's phone.
        val camp = homeFreeCampHud(hud(), false).shield
        assertEquals("free camp", camp.value)
        assertTrue("no shield icon", camp.icon.isBlank())
        assertEquals(ChipTone.QUIET, camp.tone)
        assertEquals("a landed kingdom keeps its shield icon", "shield", homeFreeCampHud(hud(), true).shield.icon)
    }

    @Test fun `the herald is one line under the stack and clear of QUESTS`() {
        val g = HudGeometry
        assertEquals("hub SPEC 3.1, y 128", 128, g.HERALD_TOP)
        assertTrue("under the full four-row resource stack", g.HERALD_TOP >= g.STACK_TOP + stackHeight(4))
        assertEquals("hub SPEC 3.1, 336 wide on the 412 dp phone", 336, g.HERALD_W_MAX)
        assertTrue("ends before the QUESTS edge button", g.GUTTER + g.HERALD_W_MAX < g.SCREEN_W - g.EDGE_RIGHT - g.EDGE)
        // VT323 advances 8 dp a glyph at 20 sp; icon 30, gap 8 and 13 dp padding each side: the land line is one line.
        assertTrue(LAND_HERALD_TEXT.length * 8 + 30 + 8 + 2 * 13 <= g.HERALD_W_MAX)
    }

    @Test fun `a landless kingdom's notices start under its herald and a landed one keeps its fit`() {
        // The land herald never leaves a landless Home, so notices start under it; a landed kingdom's heralds last 4 s and
        // must not move the camera fit each time one appears.
        assertEquals(HudGeometry.HERALD_TOP + HudGeometry.HERALD_H, homeHeaderSpacerDp(true))
        assertEquals(HudGeometry.STACK_TOP + stackHeight(4), homeHeaderSpacerDp(false))
        assertTrue(scaffold.contains("if (world) Spacer(Modifier.height(homeHeaderSpacerDp(landHeraldBand).dp))"))
        assertTrue(scaffold.contains("val landHeraldBand = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.landOwnedLive(account).takeIf { account.phase == AccountPhase.SIGNED_IN } == false"))
    }

    @Test fun `a full card hides the lifted stack so it never covers the card header and close`() {
        // Rewrites nothing in HomeLayerHooksTest: at most one stack is still painted; under a Full card it is none, because
        // the card paints its own RewardReadouts (hub SPEC decision 4).
        assertFalse(homeLiftedStackPainted(lifted = true, fullCardOver = true))
        assertTrue(homeLiftedStackPainted(lifted = true, fullCardOver = false))
        assertFalse(homeLiftedStackPainted(lifted = false, fullCardOver = false))
        assertTrue(scaffold.contains("liftedHud?.takeIf { homeLiftedStackPainted(lifted = true, fullCardOver = hooks.homeCovered) }"))
    }

    @Test fun `the old NO LAND YET plate is gone and the land herald stays the land door`() {
        assertFalse("the dark plate over the tabs and dock", scaffold.contains("Copy.NO_LAND_PROMPT"))
        assertTrue("a door must never do nothing", scaffold.contains("LAND_HERALD_TARGET.value -> onOpenLand()"))
        assertNotNull(homeLandHeraldUi(false, null))
    }

    @Test fun `an open fleet form hides the deck and tabs instead of painting over them`() {
        // Owner screenshot 1: the VEHICLES & EXPEDITIONS form is drawn under the HUD, so ATTACK, ARMY, MAP, BUILD and the
        // MAIL / CHAT tabs sat on top of it. An open form now counts as a selection: the deck slides away.
        val app = File("$root/ui/nav/PkwApp.kt").readText()
        assertTrue(app.contains("} && fleet?.destination() == null, // an open fleet form"))
    }

    // ---- K-night-A10 (owner, 2026-10-06 16:12, "fit it into the button"): the ARMY dock button's portrait was drawn above
    // the button. Its content column was unbounded, so a 28 dp portrait lifted 4 dp, the 6 dp meter and the caption's real
    // 20 dp em box (50 dp) spilled 7 dp past the 43 dp face, evenly: the opaque portrait stood 4.5 dp above the button and
    // the caption sank into the lip. The face now bounds its content and the icon gives way, never the caption. Units
    // below are dp at density 1 (deckStack is unit-free; the device runs it in px). ----

    private val hudSource = File("$root/ui/hud/HomeHud.kt").readText()
    private val pad = chunkyContentPadding()
    private val rimAndLip = (pad.calculateTopPadding() + pad.calculateBottomPadding()).value.toInt()
    /** A 52 dp deck face between its 3 dp rim and its 6 dp lip: where its icon, meter and caption may be drawn. */
    private val smallRoom = HudGeometry.DECK_SMALL - rimAndLip
    private val primaryRoom = HudGeometry.DECK_PRIMARY - rimAndLip
    /** The fill meter: a 1 dp gap and the 5 dp bar. */
    private val meter = 6
    /** The small-face caption's line box, read from the style itself so any change to it is judged here. */
    private val smallCaption: Int get() = Regex("""SMALL_DECK_CAPTION: TextStyle = PkwTokens\.Type\.caption\.copy\(lineHeight = (\d+)\.sp,\s*""" +
        """lineHeightStyle = LineHeightStyle\(LineHeightStyle\.Alignment\.Center, LineHeightStyle\.Trim\.None\)\)""")
        .find(hudSource)?.groupValues?.get(1)?.toInt()
        ?: throw AssertionError("SMALL_DECK_CAPTION no longer sets its line box with Trim.None, so a one-line caption ignores it")
    private val army = DeckButtonUi(HudIds.ARMY, "ui_portrait_highlander_t2", "ARMY", false, null, 14 to 20, verb = Verb.CHARCOAL)

    /** Every part lies on the face: nothing above the button's top, nothing in its lip, the parts in order and touching. */
    private fun assertOnFace(s: DeckStack, room: Int, meter: Int, caption: Int) {
        assertTrue("icon top ${s.iconTop} is on the face, not above the button", s.iconTop >= 0)
        assertEquals("the meter sits right under the icon", s.iconTop + s.icon, s.meterTop)
        assertEquals("the caption sits right under the meter", s.meterTop + meter, s.captionTop)
        assertTrue("caption bottom ${s.captionTop + caption} stays above the lip at $room", s.captionTop + caption <= room)
    }

    @Test fun `the ARMY portrait, its meter and its caption stay inside the button`() {
        assertEquals("52 dp face less the 3 dp rim and the 6 dp lip", 43, smallRoom)
        val wanted = deckIconDp(army.icon, large = false, meter = true)
        assertEquals("a portrait over a meter asks for the small-face size", 24, wanted)
        val s = deckStack(smallRoom, wanted, 4, meter, smallCaption)
        assertOnFace(s, smallRoom, meter, smallCaption)
        assertEquals("the face is full, so the 4 dp lift is dropped and the stack starts at the top band", 0, s.iconTop)
        // The 56 px portrait draws 1:1 on the Seeker (2.625 px/dp) at 21.3 dp: the caption box must leave it that much.
        assertTrue("portrait ${s.icon} dp keeps the Seeker's whole-pixel size", s.icon >= 56 / 2.625)
    }

    @Test fun `the caption is never squeezed, the icon gives way, even with the caption's full em box or a larger font`() {
        // 20 dp: VT323's em box at 20 sp, what a one-line caption measures when its line box is not applied; 19 dp: the
        // 14 sp box at font scale 1.3. Either way the caption keeps its height and the portrait shrinks to fit.
        for (caption in listOf(20, 19)) {
            val s = deckStack(smallRoom, 24, 4, meter, caption)
            assertOnFace(s, smallRoom, meter, caption)
            assertEquals(smallRoom - meter - caption, s.icon)
        }
    }

    @Test fun `a portrait keeps its lift into the top band only while the face holds it`() {
        // Lifted, a stack sits half the lift higher in the face (home.html ARMY `margin-top:-4px` in a centred column).
        val lifted = deckStack(43, 24, 4, 0, 14)
        assertEquals("38 + 4 fit in 43: lifted from 2 (centred) to 0", 0, lifted.iconTop)
        assertOnFace(lifted, 43, 0, 14)
        val dropped = deckStack(43, 20, 4, meter, 14)
        assertEquals("40 + 4 do not fit: centred at 1, where the lift would have drawn it 1 dp above the button", 1, dropped.iconTop)
        assertOnFace(dropped, 43, meter, 14)
    }

    @Test fun `ARMY without a camp keeps its full 28 dp portrait`() {
        // No camp capacity yet means no meter (HomeHudBinding passes pips only for a positive capacity).
        val wanted = deckIconDp(army.icon, large = false, meter = false)
        assertEquals(28, wanted)
        val s = deckStack(smallRoom, wanted, 4, 0, smallCaption)
        assertEquals(28, s.icon)
        assertOnFace(s, smallRoom, 0, smallCaption)
    }

    @Test fun `the corner faces and MAP keep their designed icons`() {
        // ATTACK 80 x 72 with energy pips, BUILD 72 x 72: the 63 dp room holds the 36 / 32 dp icons over the 20 dp caption.
        assertEquals(36, deckIconDp("attack", large = true, meter = true))
        val attack = deckStack(primaryRoom, 36, 0, meter, 20)
        assertEquals(36, attack.icon)
        assertOnFace(attack, primaryRoom, meter, 20)
        assertEquals(32, deckStack(primaryRoom, deckIconDp("itm_hammer", large = true, meter = false), 0, 0, 20).icon)
        assertEquals("MAP's 24 dp map is not a portrait", 24, deckIconDp("map", large = false, meter = true))
        assertEquals(24, deckStack(smallRoom, 24, 0, 0, smallCaption).icon)
    }

    @Test fun `only a caption and meter taller than the face itself overflow it, evenly`() {
        // An extreme font scale: the icon is already gone; the overflow splits above and below rather than all into the lip.
        val s = deckStack(smallRoom, 24, 4, meter, 41)
        assertEquals(0, s.icon)
        assertEquals(-2, s.iconTop)
        assertEquals(2, s.captionTop + 41 - smallRoom)
    }

    @Test fun `the small caption's line box holds VT323's outlined capitals`() {
        // VT323 capitals stand 560 / 1000 em on the baseline (11.2 dp at 20 sp), 13.2 dp with the 1 dp outline.
        assertTrue("$smallCaption sp holds the outlined capitals", smallCaption >= 0.56 * 20 + 2 * 1)
    }

    @Test fun `the deck face is bounded and stacked by deckStack, with no unbounded lift`() {
        assertTrue("DeckButton draws its content through DeckFace", hudSource.contains("DeckFace(ui)"))
        assertTrue("the room is the face's bounded content box",
            hudSource.contains("val room = if (constraints.hasBoundedHeight) constraints.maxHeight else"))
        assertTrue(hudSource.contains("val stack = deckStack(room, wanted, liftDp.dp.roundToPx(), meterH, caption.height)"))
        assertTrue("the icon is measured at the square deckStack fits",
            hudSource.contains("part(DeckPart.ICON)!!.measure(Constraints.fixed(side, side))"))
        assertFalse("the negative-margin lift that drew the portrait above the button", hudSource.contains("Modifier.liftUp("))
    }
}
