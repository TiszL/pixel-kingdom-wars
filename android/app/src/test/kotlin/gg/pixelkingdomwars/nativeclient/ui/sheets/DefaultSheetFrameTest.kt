package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import org.junit.Assert.*
import org.junit.Test

/**
 * Contract for the deliberately partial fixed-frame producer, from design review's seven-screen SPEC delivery b240a5b2.
 * A frame is presentation metadata only: no body, data readiness, gate passage or authority to run an action.
 * Tests are authored before implementation. Runtime/compile execution belongs to the content pipeline's guarded queue.
 */
class DefaultSheetFrameTest {
    @Test fun `Mail uses the compact full card and no frame tabs`() {
        assertEquals(
            SheetFrameUi("MAIL", null, SheetSize.FULL, emptyList(), null),
            defaultSheetFrame(SheetEntry(Destination.Mail)),
        )
    }

    @Test fun `History title is fixed while its filter belongs to the body`() {
        listOf("all", "goldforge", "workshop", "islands").forEach { home ->
            assertEquals(
                "History filter $home must not become a title or tab",
                SheetFrameUi("HISTORY", null, SheetSize.FULL, emptyList(), null),
                defaultSheetFrame(SheetEntry(Destination.WalletHistory(home))),
            )
        }
    }

    @Test fun `Settings default frame uses the three specified tabs and real icon aliases`() {
        assertEquals(
            SheetFrameUi("SETTINGS", null, SheetSize.FULL, settingsTabs(), "GAME"),
            defaultSheetFrame(SheetEntry(Destination.Settings())),
        )
    }

    @Test fun `Settings takes each supported initial tab from its destination`() {
        listOf("GAME", "ACCOUNT", "HELP").forEach { tab ->
            val frame = requireNotNull(defaultSheetFrame(SheetEntry(Destination.Settings(tab))))
            assertEquals(tab, frame.selectedTab)
            assertEquals(settingsTabs(), frame.tabs)
        }
    }

    @Test fun `saved current Settings tab takes precedence over valid destination tab`() {
        listOf("GAME", "ACCOUNT", "HELP").forEach { tab ->
            val entry = SheetEntry(Destination.Settings("GAME"), selectedTab = tab)
            assertEquals(tab, requireNotNull(defaultSheetFrame(entry)).selectedTab)
        }
    }

    @Test fun `unknown saved Settings tab does not silently reopen a different tab`() {
        val entry = SheetEntry(Destination.Settings("GAME"), selectedTab = "UNKNOWN")
        assertNull(defaultSheetFrame(entry))
    }

    @Test fun `unsupported destination Settings tab remains unsupported despite valid saved tab`() {
        assertNull(defaultSheetFrame(SheetEntry(Destination.Settings("UNKNOWN"))))
        assertNull(defaultSheetFrame(SheetEntry(Destination.Settings("UNKNOWN"), selectedTab = "GAME")))
    }

    @Test fun `Settings subsection is not discarded by a producer that cannot render it`() {
        listOf("security", "about", "fit", "unrecognized").forEach { section ->
            assertNull(
                "Section $section needs its actual owner binding",
                defaultSheetFrame(SheetEntry(Destination.Settings("HELP", section))),
            )
            assertNull(defaultSheetFrame(SheetEntry(Destination.Settings("HELP", section), selectedTab = "ACCOUNT")))
        }
    }

    @Test fun `Mail body filters are not fabricated as frame tabs from saved entry state`() {
        val frame = requireNotNull(defaultSheetFrame(SheetEntry(Destination.Mail, selectedTab = "REWARDS")))
        assertTrue(frame.tabs.isEmpty())
        assertNull(frame.selectedTab)
    }

    @Test fun `History body filters are not fabricated as frame tabs from saved entry state`() {
        val entry = SheetEntry(Destination.WalletHistory("workshop"), selectedTab = "WORKSHOP")
        val frame = requireNotNull(defaultSheetFrame(entry))
        assertTrue(frame.tabs.isEmpty())
        assertNull(frame.selectedTab)
    }

    @Test fun `fixed frames do not invent live status level art or history availability`() {
        listOf(Destination.Mail, Destination.WalletHistory(), Destination.Settings()).forEach { destination ->
            val frame = requireNotNull(defaultSheetFrame(SheetEntry(destination)))
            assertNull(frame.portrait)
            assertNull(frame.titleTag)
            assertNull(frame.live)
            assertFalse(frame.history)
            frame.tabs.forEach { tab ->
                assertNull(tab.badge)
                assertFalse(tab.locked)
            }
        }
    }

    @Test fun `restored and scroll hints do not manufacture frame state`() {
        listOf(Destination.Mail, Destination.WalletHistory("islands"), Destination.Settings("ACCOUNT")).forEach { destination ->
            val plain = SheetEntry(destination)
            val restored = plain.copy(scrollIndex = 7, scrollOffset = 23, restored = true)
            assertEquals(defaultSheetFrame(plain), defaultSheetFrame(restored))
            assertEquals(7, restored.scrollIndex)
            assertEquals(23, restored.scrollOffset)
            assertTrue(restored.restored)
        }
    }

    @Test fun `drawers scenes and transient commands are never coerced into full cards`() {
        val destinations = listOf(
            Destination.Chat(),
            Destination.World(),
            Destination.IslandScene("seeker"),
            Destination.FocusBuilding("keep", Destination.Settings()),
            Destination.StoragePopover,
            Destination.Resources("skr"),
            Destination.LayoutEditor,
            Destination.LandGate(),
            Destination.DivineTrials,
        )
        destinations.forEach { assertNull("Special surface $it is not a fixed sheet", defaultSheetFrame(SheetEntry(it))) }
    }

    @Test fun `identity and data dependent headers await their owner inputs`() {
        val destinations = listOf(
            Destination.BuildingInfo("building-id"),
            Destination.Upgrade("building-id"),
            Destination.Heroes("vex"),
            Destination.Profile(),
            Destination.Clan(),
            Destination.Leagues(),
        )
        destinations.forEach { assertNull("Dynamic frame $it needs actual data", defaultSheetFrame(SheetEntry(it))) }
    }

    @Test fun `remaining canonical routes await complete frame bindings`() {
        val destinations = listOf(
            Destination.Army(),
            Destination.Research,
            Destination.KeepStores(),
            Destination.BuildShop(),
            Destination.Workshop(),
            Destination.Lodge(),
            Destination.Berth(),
            Destination.Market(),
            Destination.Harvester(),
            Destination.GoldForge(),
            Destination.RaidChooser(),
            Destination.BattleLog(),
            Destination.Quests(),
            Destination.DailyCache,
            Destination.Event(),
            Destination.Feedback,
            Destination.Builders,
            Destination.IslandRewards("seeker"),
            Destination.RealmPermit(1),
            Destination.DivineFragments,
            Destination.Faucet,
            Destination.Expand,
            Destination.IslandSpot("seeker", 1),
            Destination.VehicleCraft,
            Destination.SkrFaucet,
            Destination.SolanaReachUnlock(1),
        )
        destinations.forEach { assertNull("Unbound frame $it must not become a placeholder", defaultSheetFrame(SheetEntry(it))) }
    }

    @Test fun `Settings tab identity is exact and never case folded or trimmed`() {
        listOf("game", " Game", "GAME ", "account", "help").forEach { tab ->
            assertNull(defaultSheetFrame(SheetEntry(Destination.Settings(tab))))
            assertNull(defaultSheetFrame(SheetEntry(Destination.Settings(), selectedTab = tab)))
        }
        // Destination itself rejects blank addresses; the saved presentation hint can still be blank in memory.
        listOf("", " ").forEach { tab ->
            assertNull(defaultSheetFrame(SheetEntry(Destination.Settings(), selectedTab = tab)))
        }
    }

    private fun settingsTabs() = listOf(
        TabUi("GAME", "star", "GAME", badge = null, locked = false),
        TabUi("ACCOUNT", "shield", "ACCOUNT", badge = null, locked = false),
        TabUi("HELP", "info", "HELP", badge = null, locked = false),
    )
}
