package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.ui.world.RealmCta.Kind.CHOOSE_LAND
import gg.pixelkingdomwars.nativeclient.ui.world.RealmCta.Kind.ENTER_MAP
import gg.pixelkingdomwars.nativeclient.ui.world.RealmCta.Kind.MY_BASE
import gg.pixelkingdomwars.nativeclient.ui.world.RealmCta.Kind.NO_MAP
import gg.pixelkingdomwars.nativeclient.ui.world.RealmCta.Kind.NO_OPEN_LAND
import gg.pixelkingdomwars.nativeclient.ui.world.RealmCta.Kind.PREPARING
import gg.pixelkingdomwars.nativeclient.data.WorldEntry
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The globe realm panel's CTAs ([realmCtaRows], drawn by `RealmPanelBody`). Owner, Seeker code 31b (2026-09-26): "now
 * somehow it does not show up enter map on globe when selecting realms". In choose mode the Crownlands panel offered
 * only CHOOSE LAND HERE to a player with bases in Sunscar, Elderwood and Crownlands: choose mode had replaced the whole
 * foot. The rule: selecting a realm always offers Enter map (and My base where you own land); choose mode may only lead
 * with "Choose land here", as the web's realm panel lists all three (GLOBE-PRODUCTION-PLAN §1).
 */
class RealmPanelCtaTest {
    private val bools = listOf(false, true)
    private fun kinds(rows: List<List<RealmCta>>) = rows.map { row -> row.map { it.kind } }
    private fun gold(rows: List<List<RealmCta>>) = rows.flatten().filter { it.gold }.map { it.kind }

    @Test fun `the owner's Crownlands in choose mode leads with Choose land here and keeps My base and Enter map`() {
        val rows = realmCtaRows("crownlands", open = 12_957, mine = true, hasMap = true, ready = 1f, mineCta = false, choose = true)
        assertEquals(listOf(listOf(CHOOSE_LAND), listOf(MY_BASE, ENTER_MAP)), kinds(rows))
        assertEquals("choose mode's lead is the panel's one gold action; the browse row steps down to stone", listOf(CHOOSE_LAND), gold(rows))
    }

    @Test fun `every realm with a ready map offers Enter map, and My base where you own land, in every mode`() {
        for (choose in bools) for (mine in bools) for (mineCta in bools) for (open in listOf(null, 0, 5)) for (realm in listOf("crownlands", "seeker-reach")) {
            val case = "$realm choose=$choose mine=$mine mineCta=$mineCta open=$open"
            val flat = realmCtaRows(realm, open, mine, hasMap = true, ready = null, mineCta = mineCta, choose = choose).flatten()
            assertTrue("$case: Enter map", flat.any { it.kind == ENTER_MAP })
            assertEquals("$case: My base exactly where you own land", mine, flat.any { it.kind == MY_BASE })
            assertEquals("$case: exactly one gold action", 1, flat.count { it.gold })
        }
    }

    @Test fun `choose mode's lead says why when it cannot choose, and Enter map takes the gold back`() {
        // A full realm and the reserved Solana Reach have nothing to choose: the player can still browse the map.
        for (rows in listOf(realmCtaRows("crownlands", 0, false, true, null, false, true), realmCtaRows("seeker-reach", null, false, true, null, false, true))) {
            assertEquals(listOf(listOf(NO_OPEN_LAND), listOf(ENTER_MAP)), kinds(rows)); assertEquals(listOf(ENTER_MAP), gold(rows))
        }
        // An unknown count (still loading) is not "no land": the card's metered read decides for each deed.
        assertEquals(CHOOSE_LAND, realmCtaRows("crownlands", null, false, true, null, false, true)[0][0].kind)
        // A realm without a map: choose mode still offers its suggested open deed (the parcel panel), the browse row says why.
        assertEquals(listOf(listOf(CHOOSE_LAND), listOf(NO_MAP)), kinds(realmCtaRows("thornwake", 4, true, false, null, false, true)))
    }

    @Test fun `a preparing map shows its readiness in place of the buttons that dive, in both rows`() {
        val choosing = realmCtaRows("crownlands", 5, true, true, 0.5f, false, true)
        assertEquals(listOf(listOf(PREPARING), listOf(MY_BASE, PREPARING)), kinds(choosing))
        assertEquals(listOf(50, 0, 50), choosing.flatten().map { it.percent })
        assertEquals(listOf(true, false, false), choosing.flatten().map { it.gold })
        assertEquals(listOf(listOf(ENTER_MAP)), kinds(realmCtaRows("crownlands", 5, false, true, 1f, false, true).drop(1)))
    }

    @Test fun `outside choose mode the foot is main js realmPanel's, one row`() {
        assertEquals(listOf(listOf(MY_BASE, ENTER_MAP)), kinds(realmCtaRows("sunscar", 3, true, true, null, false, false)))
        assertEquals("Enter map is gold", listOf(ENTER_MAP), gold(realmCtaRows("sunscar", 3, true, true, null, false, false)))
        assertEquals("opened by MY PARCEL, My base is gold", listOf(MY_BASE), gold(realmCtaRows("sunscar", 3, true, true, null, true, false)))
        assertEquals(listOf(listOf(ENTER_MAP)), kinds(realmCtaRows("frostveil", 3, false, true, null, false, false)))
        assertEquals(listOf(listOf(NO_MAP)), kinds(realmCtaRows("thornwake", 3, true, false, null, false, false)))
    }

    @Test fun `the panel's Enter map and My base end choose mode, and Choose land here keeps it`() {
        // Owner (code 31b): an intent must not stick beyond the flow that set it. A landowner who reached the globe in choose
        // mode and taps Enter map browses the realm: no suggested open deed with "Next open deed", and back on the globe
        // the realm panels are the plain ones again. "Choose land here" is the choose flow and carries on as before.
        val choosing = WorldHudFlow.selectRealm(WorldHudFlow.entry(WorldHudUi(), WorldEntry.ChooseLand, 3, 3, null, null, false).ui, "crownlands").ui
        val suggested = RealmCard(740, 20, 1)
        val browse = WorldHudFlow.browseMap(choosing, "crownlands", mine = false)
        assertEquals(listOf(WorldIntent.Dive("crownlands")), browse.intents)
        assertEquals(WorldHudIntent.NONE, browse.ui.intent)
        val landed = WorldHudFlow.dived(browse.ui, "crownlands", myBase = null, openDeed = suggested)
        assertNull("a plain Enter map selects nothing", landed.ui.card)
        val back = WorldHudFlow.left(WorldHudFlow.leave(landed.ui).ui, "crownlands").ui
        assertEquals(WorldHudIntent.NONE, back.intent); assertEquals("fallback", WorldHudFlow.hint(back, "fallback"))
        val home = WorldHudFlow.browseMap(choosing, "crownlands", mine = true).ui
        assertTrue(home.pendingMine); assertEquals("My base ends it too", WorldHudIntent.NONE, home.intent)

        val choose = WorldHudFlow.enterMap(choosing, "crownlands")
        assertEquals(WorldHudIntent.CHOOSE_LAND, choose.ui.intent)
        assertEquals("Choose land here still lands on a suggested open deed", suggested, WorldHudFlow.dived(choose.ui, "crownlands", null, suggested).ui.card)
        assertEquals("a tap that cannot dive (one in flight) changes nothing, the intent included", HudStep(choose.ui), WorldHudFlow.browseMap(choose.ui, "crownlands", mine = false))
        assertEquals("outside choose mode it is Enter map as it was", WorldHudFlow.enterMap(WorldHudUi(), "sunscar", mine = true), WorldHudFlow.browseMap(WorldHudUi(), "sunscar", mine = true))
        // the realm panel's Enter map and My base are wired to it; "Choose land here" keeps its own action
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        assertTrue("enterMap = { realm, mineCta -> apply(WorldHudFlow.browseMap(ui, realm, mine = mineCta)) }" in screen)
        assertTrue("if (realm in mapped) apply(WorldHudFlow.enterMap(ui, realm))" in screen)
    }
}
