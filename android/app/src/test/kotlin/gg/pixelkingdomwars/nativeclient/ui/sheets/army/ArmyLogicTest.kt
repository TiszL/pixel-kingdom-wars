package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure rules of the army cluster (design/final/army/SPEC.md). Why they matter: these sheets spend the player's
 * Shards and Gems and report raid loot. A draft must never overflow the camp, a tap must never spend when the price is
 * short or unknown, "FREE" or "0" must never appear without the server saying so, loot must not count up or tone as a
 * gain before the server settles it, and unknown values must read "…" rather than a number the player could act on.
 */
class ArmyLogicTest {
    private fun housing(ready: Int, training: Int, draft: Int, capacity: Int, full: Boolean = false, known: Boolean = true) =
        HousingUi(ready, training, draft, capacity, queueCap = 20, full = full, known = known)
    private fun cmd(state: CommandState, price: PriceUi? = null) =
        CommandUi(FeatureId("barracks.train"), "", "TRAIN", price, true, state, if (state == CommandState.DISABLED) "Tap troops to add them" else null, null)

    // --- Durations (D-070: one style, days above 24 h; unknown is "…", never "0s") ---

    @Test fun `durations follow one style and an unknown time reads as an ellipsis`() {
        assertEquals("…", armyDuration(null))
        assertEquals("…", armyDuration(-1))
        assertEquals("42s", armyDuration(42))
        assertEquals("8m 30s", armyDuration(510))
        assertEquals("10h 41m", armyDuration(38_460))
        assertEquals("days above 24 hours", "2d 3h", armyDuration(2 * 86_400 + 3 * 3_600 + 59))
        assertEquals("a zero second unit is dropped (raid.png '+1 in 38m')", "38m", armyDuration(2_280))
        assertEquals("heroes.png 'takes 6h'", "6h", armyDuration(6 * 3_600))
    }

    // --- Housing: the draft can never overflow the camp ---

    @Test fun `the housing meter never overflows even when the server sends more than capacity`() {
        val f = housingFractions(housing(40, 8, 9, 50))
        assertTrue("segments sum to at most the whole meter", f.ready + f.training + f.draft <= 1f + 1e-6f)
        assertEquals(0.8f, f.ready, 1e-6f)
        assertEquals(0.16f, f.training, 1e-6f)
        assertEquals("the draft is clipped to the room actually left", 0.04f, f.draft, 1e-6f)
    }

    @Test fun `unknown or zero capacity draws an empty track instead of a misleading fill`() {
        assertEquals(HousingFractions(0f, 0f, 0f), housingFractions(housing(10, 0, 0, 0)))
        assertEquals(HousingFractions(0f, 0f, 0f), housingFractions(housing(10, 5, 0, 50, known = false)))
    }

    @Test fun `the ARMY tab meter ignores the TRAIN draft`() {
        assertEquals(0f, housingFractions(housing(20, 5, 9, 50), showDraft = false).draft, 0f)
    }

    @Test fun `the housing header shows the draft in its own part and unknown as ellipses`() {
        assertEquals(HousingCount("32", "+9", "50"), housingCount(housing(24, 8, 9, 50)))
        assertEquals("no draft part when nothing is chosen", HousingCount("32", null, "50"), housingCount(housing(24, 8, 0, 50)))
        assertEquals(HousingCount("…", null, "…"), housingCount(housing(24, 8, 9, 50, known = false)))
    }

    @Test fun `the legend names ready training and chosen and says full in its own part`() {
        val l = housingLegend(housing(24, 8, 9, 50, full = true))
        assertEquals("24 ready", l.ready); assertEquals("8 training", l.training); assertEquals("9 chosen", l.draft); assertEquals("· full", l.fullNote)
        val army = housingLegend(housing(38, 4, 0, 50), trainingDoneInSec = 130, showDraft = false)
        assertEquals("the ARMY tab says when training is done", "4 training · in 2m 10s", army.training)
        assertNull(army.draft)
    }

    @Test fun `a troop fits the draft only while the camp has room for its housing points`() {
        val h = housing(24, 8, 9, 50) // 9 points left
        assertEquals(9, roomLeft(h))
        assertTrue(canAddTroop(h, 9))
        assertFalse("one point over capacity is refused", canAddTroop(h, 10))
        assertFalse("a full camp refuses everything", canAddTroop(h.copy(full = true), 1))
        assertFalse("unknown housing never claims there is room", canAddTroop(h.copy(known = false), 1))
        assertFalse("a troop with no housing value is never added", canAddTroop(h, 0))
    }

    @Test fun `loading a saved army trims it to the room left and counts what did not fit`() {
        val t = trimDraft(10, listOf(DraftLine("giant", 5, 1), DraftLine("bowman", 1, 8), DraftLine("mage", 3, 2)))
        assertEquals(listOf(DraftLine("giant", 5, 1), DraftLine("bowman", 1, 5)), t.kept)
        assertEquals("3 bowmen and 2 mages did not fit", 5, t.droppedTroops)
        assertEquals("no room keeps nothing and spends nothing", DraftTrim(emptyList(), 3), trimDraft(0, listOf(DraftLine("mage", 3, 3))))
    }

    // --- Tap routing: never auto-spend; CHECKING navigates, UNAVAILABLE explains, SHORT opens need-more ---

    @Test fun `a short price opens need-more and never runs the action`() {
        assertEquals(TapRoute.NEED_MORE, commandTap(cmd(CommandState.ENABLED, PriceUi(Currency.GEMS, "14", PriceStatus.SHORT))))
        assertEquals(TapRoute.NEED_MORE, commandTap(cmd(CommandState.SHORT)))
    }

    @Test fun `a checking price is enabled navigation and an unavailable price is disabled with its reason`() {
        assertEquals(TapRoute.RUN, commandTap(cmd(CommandState.ENABLED, PriceUi(Currency.GEMS, null, PriceStatus.CHECKING))))
        val unavailable = cmd(CommandState.ENABLED, PriceUi(Currency.GEMS, null, PriceStatus.UNAVAILABLE))
        assertEquals(CommandState.DISABLED, effectiveState(unavailable))
        assertEquals(TapRoute.EXPLAIN, commandTap(unavailable))
    }

    @Test fun `disabled and locked explain, busy ignores so nothing is sent twice`() {
        assertEquals(TapRoute.EXPLAIN, commandTap(cmd(CommandState.DISABLED)))
        assertEquals(TapRoute.EXPLAIN, commandTap(cmd(CommandState.LOCKED)))
        assertEquals(TapRoute.IGNORE, commandTap(cmd(CommandState.BUSY, PriceUi(Currency.SHARDS, "580", PriceStatus.OK))))
    }

    @Test fun `troop cards add, explain or open need-more by state and freeze while TRAIN is sending`() {
        assertEquals(TroopTap.ADD, troopTap(TroopCardState.DEFAULT, sending = false))
        assertEquals(TroopTap.ADD, troopTap(TroopCardState.CHOSEN, sending = false))
        assertEquals(TroopTap.NEED_MORE, troopTap(TroopCardState.SHORT, sending = false))
        assertEquals(TroopTap.LOCKED, troopTap(TroopCardState.LOCKED, sending = false))
        assertEquals(TroopTap.NO_ROOM, troopTap(TroopCardState.NO_ROOM, sending = false))
        TroopCardState.entries.forEach { assertEquals("$it while sending", TroopTap.IGNORE, troopTap(it, sending = true)) }
    }

    @Test fun `FINISH reads FREE only with a server zero and the server's free-first-finish flag`() {
        val zero = PriceUi(Currency.GEMS, "0", PriceStatus.SERVER_ZERO)
        assertEquals("FREE", finishPrice(zero, freeFinish = true).amount)
        assertEquals("a server zero without the flag stays as given", "0", finishPrice(zero, freeFinish = false).amount)
        val checking = PriceUi(Currency.GEMS, null, PriceStatus.CHECKING)
        assertEquals("an unknown price is never turned into FREE", checking, finishPrice(checking, freeFinish = true))
    }

    // --- Tabs ---

    @Test fun `the TRAIN tab badge counts queued groups only while ARMY is showing`() {
        assertNull(trainTabBadge(2, trainActive = true))
        assertNull(trainTabBadge(0, trainActive = false))
        val b = trainTabBadge(2, trainActive = false)!!
        assertEquals("2", b.text); assertEquals(BadgeTone.COUNT, b.tone)
        assertEquals("99+", trainTabBadge(140, trainActive = false)!!.text)
        assertEquals(listOf("TRAIN", "ARMY"), armyTabs(ARMY_TAB_ARMY, 2, "p").map { it.id })
        assertEquals("2", armyTabs(ARMY_TAB_ARMY, 2, "p").first().badge?.text)
    }

    @Test fun `the GEAR tab carries NEW only while a new item waits and REVENGE counts answerable raids`() {
        assertNull(heroTabs("p", "s", gearNew = false).last().badge)
        assertEquals("NEW", heroTabs("p", "s", gearNew = true).last().badge?.text)
        assertNull(raidTabs(0).last().badge)
        assertEquals("1", raidTabs(1).last().badge?.text)
    }

    // --- Research ---

    private fun rcard(troop: String, state: ResearchCardState) = ResearchCardUi(troop, troop, "p", "L1", null, state)

    @Test fun `research selects the first affordable card by default and never a capped or short one`() {
        assertEquals("mage", defaultResearchSelection(listOf(rcard("tur", ResearchCardState.SHORT), rcard("plund", ResearchCardState.LAB_CAP),
            rcard("mage", ResearchCardState.DEFAULT), rcard("giant", ResearchCardState.DEFAULT))))
        assertNull(defaultResearchSelection(listOf(rcard("tur", ResearchCardState.SHORT), rcard("x", ResearchCardState.MAX))))
    }

    @Test fun `a research tap selects and never starts, and every card explains while the Lab works`() {
        assertEquals(ResearchTap.SELECT, researchTap(ResearchCardState.DEFAULT, labBusy = false))
        assertEquals(ResearchTap.NEED_MORE, researchTap(ResearchCardState.SHORT, labBusy = false))
        assertEquals(ResearchTap.LAB_CAP, researchTap(ResearchCardState.LAB_CAP, labBusy = false))
        assertEquals(ResearchTap.LOCKED, researchTap(ResearchCardState.LOCKED, labBusy = false))
        assertEquals(ResearchTap.NONE, researchTap(ResearchCardState.MAX, labBusy = false))
        assertEquals(ResearchTap.BUSY, researchTap(ResearchCardState.DEFAULT, labBusy = true))
        assertEquals(ResearchTap.BUSY, researchTap(ResearchCardState.IN_LAB, labBusy = false))
    }

    // --- Heroes ---

    private fun skill(level: Int, open: Boolean, name: String = "S$level") = SkillUi("s$level", "i", name, level, open, false)

    @Test fun `the skill summary counts open skills and names the next unlock level`() {
        assertEquals("2 of 5 · new at Lv 11", skillSummary(listOf(skill(1, true), skill(5, true), skill(16, false), skill(11, false), skill(20, false))))
        assertEquals("2 of 2", skillSummary(listOf(skill(1, true), skill(5, true))))
        assertEquals("…", skillSummary(emptyList()))
    }

    @Test fun `the next skill row counts levels to go and hides at the cap or once open`() {
        assertEquals("Degen Awakening · 2 levels to go", nextSkillLine(skill(11, false, "Degen Awakening"), 9, 30))
        assertEquals("X · 1 level to go", nextSkillLine(skill(10, false, "X"), 9, 30))
        assertNull(nextSkillLine(skill(11, false), 30, 30))
        assertNull(nextSkillLine(skill(11, true), 9, 30))
        assertEquals("LV 10", nextLevelLabel(9, 30)); assertEquals("MAX", nextLevelLabel(30, 30))
    }

    @Test fun `health reads full, back in a time, or unknown - never a made-up value`() {
        assertEquals("full", healthLabel(1f, null))
        assertEquals("back in 1h 20m", healthLabel(0.4f, 4_800))
        assertEquals("…", healthLabel(null, null))
    }

    @Test fun `the awaken meter fills by worn slots and ticks at the threshold`() {
        val m = awakenMeter(7, 10, 9)
        assertEquals(0.7f, m.fill, 1e-6f); assertEquals(0.9f, m.tick!!, 1e-6f)
        assertNull("a threshold beyond the slots draws no tick", awakenMeter(7, 10, 12).tick)
        assertEquals("7 of 10 worn", gearSummary(7, 10))
    }

    @Test fun `the paper doll keeps GEAR_SLOTS order - four left, four right, weapon and offhand below`() {
        val slots = listOf("helm", "amulet", "chest", "cloak", "gloves", "ring", "boots", "banner", "weapon", "offhand")
        val d = paperDoll(slots)
        assertEquals(listOf("helm", "amulet", "chest", "cloak"), d.left)
        assertEquals(listOf("gloves", "ring", "boots", "banner"), d.right)
        assertEquals(listOf("weapon", "offhand"), d.bottom)
    }

    // --- Raid chooser ---

    @Test fun `energy pips show full and spent points and unknown energy draws no pips`() {
        assertEquals(listOf(true, true, true, true, false), energyPips(4, 5))
        assertNull(energyPips(null, 5))
        assertEquals("pips are capped so the chip never grows over the header", 10, energyPips(3, 40)!!.size)
        assertEquals("+1 in 38m", energyLine(4, 5, 2_280))
        assertEquals("full", energyLine(5, 5, null))
        assertEquals("…", energyLine(null, 5, 60))
        assertEquals("42/50", readyOfCapacity(42, 50)); assertEquals("…/…", readyOfCapacity(null, null))
    }

    @Test fun `the stage road never selects past the frontier`() {
        assertTrue(canSelectStage(StageNodeUi(35, StageNodeState.CLEARED, 3, false)))
        assertTrue(canSelectStage(StageNodeUi(36, StageNodeState.NEXT, 0, true)))
        assertFalse(canSelectStage(StageNodeUi(37, StageNodeState.LOCKED, 0, false)))
    }

    @Test fun `recent raid labels are toned by their leading sign only`() {
        assertEquals(DeltaTone.GAIN, leadingTone("+8,200 Shards"))
        assertEquals(DeltaTone.LOSS, leadingTone("-9 trophies"))
        assertEquals(DeltaTone.UNKNOWN, leadingTone("defeat"))
        assertEquals("redacted loot is never shown as a gain", DeltaTone.UNKNOWN, leadingTone("LOOT REDACTED"))
    }

    // --- Battle result: receipt-gated, honest deltas ---

    @Test fun `loot deltas tone as gain, loss or zero and unknown stays neutral`() {
        assertEquals(DeltaTone.GAIN, deltaTone("+12,400"))
        assertEquals(DeltaTone.LOSS, deltaTone("-9"))
        assertEquals(DeltaTone.ZERO, deltaTone("0"))
        assertEquals(DeltaTone.UNKNOWN, deltaTone("…"))
    }

    @Test fun `loot counts up from zero keeping its sign and grouping, and non-numbers never count`() {
        assertEquals("+0", countUpSigned("+12,400", 0f))
        assertEquals("+6,200", countUpSigned("+12,400", 0.5f))
        assertEquals("+12,400", countUpSigned("+12,400", 1f))
        assertEquals("-4", countUpSigned("-9", 0.5f))
        assertEquals("…", countUpSigned("…", 0.5f))
        assertEquals("LOOT REDACTED", countUpSigned("LOOT REDACTED", 0.2f))
    }

    @Test fun `the loot hint never claims a payout before the server settles`() {
        assertEquals("Counting…", lootHint(SettlementUi.Pending))
        assertEquals("still being settled", lootHint(SettlementUi.Failed("timeout")))
        assertEquals("sent to your storage", lootHint(SettlementUi.Settled(listOf(LootRowUi("shards", "Shards", "", "+12,400")))))
        assertEquals("nothing taken this time", lootHint(SettlementUi.Settled(listOf(LootRowUi("shards", "Shards", "", "0"), LootRowUi("trophy", "Trophies", "", "-9")))))
        assertNull(lootHint(SettlementUi.Redacted))
    }

    // --- Sheet-mode resource rows: only the currencies the sheet spends ---

    @Test fun `each sheet shows only the currencies it spends and SKR never rides along`() {
        fun row(accent: ResourceAccent, handle: Boolean = false) =
            ResourceChipUi(FeatureId("hud.${accent.name.lowercase()}"), "i", "1", null, false, null, accent = accent, drawerHandle = handle)
        val all = listOf(row(ResourceAccent.SHARDS), row(ResourceAccent.GEMS), row(ResourceAccent.KEEP), row(ResourceAccent.SKR, handle = true))
        assertEquals(listOf(ResourceAccent.SHARDS, ResourceAccent.GEMS), sheetResourceRows(all, ArmySheetKind.TRAIN).map { it.accent })
        assertEquals(listOf(ResourceAccent.SHARDS, ResourceAccent.GEMS), sheetResourceRows(all, ArmySheetKind.RESEARCH).map { it.accent })
        assertEquals(listOf(ResourceAccent.SHARDS), sheetResourceRows(all, ArmySheetKind.RAID).map { it.accent })
        assertEquals(listOf(ResourceAccent.GEMS), sheetResourceRows(all, ArmySheetKind.HEROES).map { it.accent })
        assertTrue("no row keeps the drawer caret on a sheet", sheetResourceRows(all, ArmySheetKind.TRAIN).none { it.drawerHandle })
        assertEquals("a missing currency is skipped, not invented", emptyList<ResourceChipUi>(), sheetResourceRows(listOf(row(ResourceAccent.SKR)), ArmySheetKind.ARMY))
    }

    // --- Living header ---

    @Test fun `header sprites draw at whole art scales and walkers wrap at the edge`() {
        assertEquals("56 px troop at x2 on the DPR-2 mock is 56 dp", 56f, artDp(56, 2), 0f)
        assertEquals("ui_portrait_barracks_t3", frameName("ui_portrait_barracks_t3", 5, 1))
        assertEquals("hero_theo_idle_f2", frameName("hero_theo_idle", 7, 6))
        assertEquals(1, headerFrame(125, 8, 4))
        assertEquals(0, headerFrame(500, 8, 4))
        assertEquals(-12f, walkerVelocityDp(Dir8.W), 0f); assertEquals(12f, walkerVelocityDp(Dir8.E), 0f); assertEquals(0f, walkerVelocityDp(Dir8.S), 0f)
        assertEquals("standing walkers stay put", 100f, walkerX(100f, 0f, 9_000, 398f, 56f), 0f)
        assertEquals(88f, walkerX(100f, -12f, 1_000, 398f, 56f), 1e-3f)
        val wrapped = walkerX(0f, -12f, 10_000, 398f, 56f)
        assertTrue("a walker leaving the left edge re-enters from the right: $wrapped", wrapped > 300f && wrapped <= 398f)
    }
}
