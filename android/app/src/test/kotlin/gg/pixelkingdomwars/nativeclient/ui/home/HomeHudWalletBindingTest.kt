package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BalanceFeatures
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.DailyCache
import gg.pixelkingdomwars.nativeclient.model.GemsFeature
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** A9 display binding: wallet tokens never borrow the game's KEEP balance or an unproven cached read.
 * Authored before implementation; execution belongs to Cedar3's composite queue. */
class HomeHudWalletBindingTest {
    private fun home(gems: String? = "1250", gemsSupported: Boolean = true) = BaseState(
        balances = Balances(shards = "40943", keep = "999999", gems = gems,
            features = BalanceFeatures(if (gemsSupported) GemsFeature(1, 1) else null)),
        quests = QuestBoard(quests = listOf(Quest(id = "ready", completed = true))),
        mine = MineStatus(cache = DailyCache(claimable = true)),
    )
    private fun funds(keep: String? = "312.5", skr: String? = "240") =
        WalletFunds(sol = "876.543", tokens = mapOf("KEEP" to keep, "SKR" to skr), asOf = 1L)
    private fun hud(home: BaseState = home(), wallet: WalletFunds? = null, linked: Boolean = false): HomeHudUi =
        homeHudState(home, MailStatus(7, 2, 1), unreadRaids = 1, chatEnabled = true, chatUnread = 3,
            chatMentions = 1, selectionOpen = false, wallet = wallet, walletLinked = linked)

    @Test fun `supported Gems and linked wallet KEEP are separate simultaneous Home rows`() {
        val ui = hud(wallet = funds(), linked = true)
        assertEquals(listOf(HudIds.SHARDS, HudIds.GEMS, HudIds.KEEP, HUD_SKR), ui.resources.map { it.id })
        assertEquals(listOf("40,943", "1,250", "312.5", "240"), ui.resources.map { it.value })
        assertEquals(listOf(ResourceAccent.SHARDS, ResourceAccent.GEMS, ResourceAccent.KEEP, ResourceAccent.SKR),
            ui.resources.map { it.accent })
        assertTrue(ui.resources.all { !it.plus && it.gain == null })
        assertEquals(listOf(HUD_SKR), ui.resources.filter { it.drawerHandle }.map { it.id })
    }

    @Test fun `linked wallet without a current read keeps KEEP and SKR visibly unknown`() {
        val ui = hud(linked = true)
        assertEquals("…", ui.resources.single { it.id == HudIds.KEEP }.value)
        assertEquals("…", ui.resources.single { it.id == HUD_SKR }.value)
        assertFalse(ui.resources.any { it.value == "999999" || it.value == "999.9K" })
        val rows = homeResourceDrawer(home(), "keep", wallet = null, walletLinked = true).groups.single().rows
        assertEquals("…", rows.single { it.id == "keep" }.value)
        assertEquals("…", rows.single { it.id == "skr" }.value)
    }

    @Test fun `unlinked wallet hides KEEP and cannot expose retained wallet SKR`() {
        val ui = hud(wallet = funds(), linked = false)
        assertEquals(listOf(HudIds.SHARDS, HudIds.GEMS, HUD_SKR), ui.resources.map { it.id })
        assertEquals("…", ui.resources.last().value)
        assertTrue(ui.resources.last().drawerHandle)
        val rows = homeResourceDrawer(home(), "skr", wallet = funds(), walletLinked = false).groups.single().rows
        assertEquals(listOf("shards", "gems", "skr"), rows.map { it.id })
        assertEquals("…", rows.last().value)
    }

    @Test fun `missing wallet tokens stay unknown while explicit zero remains zero`() {
        for (wallet in listOf<WalletFunds?>(null, WalletFunds(null, emptyMap(), 1L), funds(null, null))) {
            val ui = hud(wallet = wallet, linked = true)
            assertEquals("…", ui.resources.single { it.id == HudIds.KEEP }.value)
            assertEquals("…", ui.resources.single { it.id == HUD_SKR }.value)
        }
        val zero = hud(wallet = funds("0", "0.000"), linked = true)
        assertEquals("0", zero.resources.single { it.id == HudIds.KEEP }.value)
        assertEquals("0", zero.resources.single { it.id == HUD_SKR }.value)
        val partial = hud(wallet = funds("0", null), linked = true)
        assertEquals("0", partial.resources.single { it.id == HudIds.KEEP }.value)
        assertEquals("…", partial.resources.single { it.id == HUD_SKR }.value)
    }

    @Test fun `wallet amounts retain exact large fractions and never round a tiny holding to zero`() {
        val wallet = funds("9007199254740993.123456", "0.000001")
        val ui = hud(wallet = wallet, linked = true)
        val keep = ui.resources.single { it.id == HudIds.KEEP }
        val skr = ui.resources.single { it.id == HUD_SKR }
        assertTrue(keep.exactDescription.contains("9,007,199,254,740,993.123456"))
        assertEquals("<0.01", skr.value)
        assertTrue(skr.exactDescription.contains("0.000001"))
        val rows = homeResourceDrawer(home(), "skr", wallet = wallet, walletLinked = true).groups.single().rows
        assertEquals("9,007,199,254,740,993.123456", rows.single { it.id == "keep" }.value)
        assertEquals("0.000001", rows.single { it.id == "skr" }.value)
    }

    @Test fun `unsupported Gems never relabel game KEEP as the wallet token`() {
        val oldServer = home(gemsSupported = false)
        val ui = hud(oldServer, funds("12.3456", "8"), linked = true)
        assertEquals(listOf(HudIds.SHARDS, HudIds.KEEP, HUD_SKR), ui.resources.map { it.id })
        assertEquals("12.34", ui.resources.single { it.id == HudIds.KEEP }.value)
        assertTrue(ui.resources.single { it.id == HudIds.KEEP }.exactDescription.contains("12.3456"))
        val rows = homeResourceDrawer(oldServer, "keep", funds("12.3456", "8"), true).groups.single().rows
        assertEquals(listOf("shards", "keep", "skr"), rows.map { it.id })
        assertEquals("12.3456", rows.single { it.id == "keep" }.value)
        assertFalse(rows.single { it.id == "keep" }.purpose.contains("game's token"))
    }

    @Test fun `drawer matches wallet sources preserves focus and leaves SOL outside Home`() {
        val ui = hud(wallet = funds(), linked = true)
        val drawer = homeResourceDrawer(home(), "keep", funds(), true)
        val group = drawer.groups.single()
        assertEquals("keep", drawer.focusRowId)
        assertEquals(ResourceGroupLayout.WIDE_ROWS, group.layout)
        assertEquals(listOf("shards", "gems", "keep", "skr"), group.rows.map { it.id })
        assertEquals(listOf("40,943", "1,250", "312.5", "240"), group.rows.map { it.value })
        assertEquals("mine.collect", group.rows.single { it.id == "shards" }.earnedAtFeature?.value)
        assertEquals("goldforge.gems", group.rows.single { it.id == "gems" }.earnedAtFeature?.value)
        assertEquals("goldforge.open", group.rows.single { it.id == "keep" }.earnedAtFeature?.value)
        assertNull(group.rows.single { it.id == "skr" }.earnedAtFeature)
        assertTrue(ui.resources.none { it.id.value == "hud.sol" || it.value == "876.54" })
        assertTrue(group.rows.none { it.id == "sol" || it.value == "876.543" })
        assertEquals("skr", hudDrawerRow(HUD_SKR))
        assertNull(hudDrawerRow(HudIds.RESOURCES))
    }

    @Test fun `only a current completed wallet read exposes the original funds object`() {
        val wallet = funds()
        assertSame(wallet, currentHomeWallet(wallet, sessionCurrent = true, loading = false, readErrors = emptyMap()))
        assertNull(currentHomeWallet(null, sessionCurrent = true, loading = false, readErrors = emptyMap()))
        assertNull(currentHomeWallet(wallet, sessionCurrent = false, loading = false, readErrors = emptyMap()))
        assertNull(currentHomeWallet(wallet, sessionCurrent = true, loading = true, readErrors = emptyMap()))
    }

    @Test fun `a failed wallet read never exposes retained funds even with a recent timestamp`() {
        val retained = funds().copy(asOf = Long.MAX_VALUE)
        for (failure in listOf("Offline", "Unavailable on this server.", "")) {
            val projected = currentHomeWallet(retained, sessionCurrent = true, loading = false,
                readErrors = mapOf("/wallet/balances" to failure))
            assertNull(projected)
            val ui = hud(wallet = projected, linked = true)
            assertEquals("…", ui.resources.single { it.id == HudIds.KEEP }.value)
            assertEquals("…", ui.resources.single { it.id == HUD_SKR }.value)
        }
    }

    @Test fun `unrelated read errors cannot erase an otherwise current wallet observation`() {
        val wallet = funds()
        assertSame(wallet, currentHomeWallet(wallet, sessionCurrent = true, loading = false,
            readErrors = mapOf("/balances" to "Old game balance", "/forge" to "Forge unavailable")))
    }

    @Test fun `wallet input changes only resource rows and preserves existing deck tools and edges`() {
        val state = home()
        val tools = homeDeckTools(baseLoaded = true, deedActionsAllowed = true, busy = false)
        fun mapped(wallet: WalletFunds?, linked: Boolean) = homeHudState(state, MailStatus(7, 2, 1),
            unreadRaids = 1, chatEnabled = true, chatUnread = 3, chatMentions = 1, selectionOpen = true,
            tools = tools, toolsOpen = true, wallet = wallet, walletLinked = linked)
        val unknown = mapped(null, false)
        val loaded = mapped(funds(), true)
        assertEquals(unknown, loaded.copy(resources = unknown.resources))
        assertFalse(loaded.deckVisible)
        assertTrue(loaded.toolsOpen)
        assertEquals(tools, loaded.tools)
        assertEquals(listOf(HudIds.ATTACK, HudIds.ARMY, HudIds.MAP, HudIds.BUILD), loaded.deck.map { it.id })
        assertEquals(listOf(HudIds.QUESTS, HudIds.DAILY_CACHE), loaded.rightEdge.map { it.id })
        assertEquals(listOf(HudIds.MAIL, HudIds.CHAT), loaded.leftEdge.map { it.id })
        val build = homeHudForBuild(loaded, true)
        assertEquals(listOf(HudIds.SHARDS), build.resources.map { it.id })
        assertFalse(build.deckVisible)
        assertFalse(build.toolsOpen)
    }
}
