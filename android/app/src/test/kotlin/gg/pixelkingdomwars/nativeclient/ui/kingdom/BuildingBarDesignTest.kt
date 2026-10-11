package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Mining
import gg.pixelkingdomwars.nativeclient.network.BaseOrderPrice
import gg.pixelkingdomwars.nativeclient.network.TrapRepair
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * The designed selected-building bar and plate (design final/buildings/SPEC.md §1.3-1.6, commands-1..5.png, states.png):
 * which commands each building shows and in what order, where every price and badge comes from, and where each tap
 * goes. A player taps these with real money on the line, so a wrong price, a guessed currency or a tap that spends
 * from a SHORT pill is a defect, not a styling issue.
 */
class BuildingBarDesignTest {
    private val baseId = "11111111-1111-4111-8111-111111111111"
    private val now = java.time.Instant.parse("2026-10-06T00:00:00.000Z").toEpochMilli()
    /** Synthetic catalogue values, not tuning: the next ring needs Keep 3 then Keep 6, priced 0.25 then 0.5 SOL. */
    private val catalogue = json("""{"constants":{"CAPS":{"expansionsMax":2,"claimTilesByExpansion":[14,16,20],
        "expansionReqKeepLevel":[3,6],"expansionPriceSolByIndex":["0.25","0.5"]}}}""")
    private val upgradeJob = BaseJob("job-1", "upgrade", buildingId = "barracks-1", startedAt = "2026-10-05T23:00:00.000Z",
        finishesAt = "2026-10-06T01:12:00.000Z", finishCostKeep = "38")

    private fun building(type: String, level: Int = 3, underConstruction: Boolean = false) =
        Building("$type-1", type, level, 0, 0, underConstruction)
    private fun state(b: Building, shards: String? = "1000", keep: Int = 5, expansions: Int = 0, extra: String = "",
        accrued: String? = null, catalogue: JsonObject? = this.catalogue, orders: Boolean = true) = KingdomUiState(
        home = BaseState(base = BaseSnapshot.from(json("""{"baseId":"$baseId","player":{"keepLevel":$keep,"expansions":$expansions},
            "buildings":[{"id":"${b.id}","type":"${b.type}","level":${b.level},"tx":0,"ty":0,"underConstruction":${b.underConstruction}}]$extra}""")),
            balances = shards?.let { Balances(it, "0") }, mine = accrued?.let { MineStatus(mining = Mining(accrued = it)) }),
        catalogue = catalogue, local = KingdomLocal(selectedBuildingId = b.id), ordersAllowed = orders)
    private fun gates(level: Int = 3, max: Int = 10, upgrade: Boolean = true, cost: String? = "500", job: BaseJob? = null,
        repair: TrapRepair? = null, enabled: Boolean = true) = BuildingGates(job, level, max, repair,
        cost?.let { BaseOrderPrice("SHARDS", it, "3600") }, null, null, cost, enabled, upgrade, null)
    private fun routes(log: MutableList<String>) = BuildingCommandRoutes(
        info = { log += "info" }, review = { log += "review" }, finish = { log += "finish" }, collect = { log += "collect" },
        train = { log += "train" }, research = { log += "research" }, army = { log += "army" }, forge = { log += "forge" },
        heroes = { log += "heroes" }, toggleRow = { log += "row" }, quoteRow = { log += "quoteRow" },
        explain = { log += "explain:$it" }, stores = { log += "stores" }, expand = { log += "expand" }, gear = { log += "gear" },
        heroUpgrade = { log += "heroUpgrade" }, rearm = { log += "rearm" }, rearmShort = { log += "rearmShort" }, clan = { log += "clan" })
    private fun tap(id: FeatureId, bar: CommandBarUi, selection: BuildingSelection? = null): List<String> =
        mutableListOf<String>().also { routeBuildingCommand(id, bar, routes(it), null, selection) }
    private fun CommandBarUi.of(id: FeatureId) = commands.single { it.id == id }

    @Test fun `Keep shows INFO STORES EXPAND and a green UPGRADE primary with EXPAND priced from the catalogue ring`() {
        // commands-1: the Keep's own doors sit before its green primary, and EXPAND's SOL is the same offer the Seal pays.
        val keep = building("keep", 5)
        val bar = buildingCommandBar(state(keep), keep, gates(level = 5), false, now)
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.STORES, BuildingCommandIds.EXPAND, BuildingCommandIds.UPGRADE),
            bar.commands.map { it.id })
        assertTrue(bar.of(BuildingCommandIds.UPGRADE).primary)
        assertEquals(Verb.GREEN, bar.of(BuildingCommandIds.UPGRADE).verb)
        assertEquals(PriceUi(Currency.SOL, "0.25", PriceStatus.OK), bar.of(BuildingCommandIds.EXPAND).price)
        assertEquals(CommandState.ENABLED, bar.of(BuildingCommandIds.EXPAND).state)
        assertEquals(listOf("stores"), tap(BuildingCommandIds.STORES, bar))
        assertEquals(listOf("expand"), tap(BuildingCommandIds.EXPAND, bar))
    }

    @Test fun `Keep EXPAND follows the next ring and disappears once every ring is bought`() {
        // A price for a ring the Keep cannot buy yet would be a false offer; a bought-out claim has nothing to sell.
        val keep = building("keep", 5)
        val locked = buildingCommandBar(state(keep, expansions = 1), keep, gates(level = 5), false, now).of(BuildingCommandIds.EXPAND)
        assertEquals(PriceStatus.UNAVAILABLE, locked.price?.status)
        assertEquals(CommandState.DISABLED, commandDrawState(locked))
        assertEquals("Needs Keep Lv 6", locked.reason)
        val all = buildingCommandBar(state(keep, expansions = 2), keep, gates(level = 5), false, now)
        assertTrue(all.commands.none { it.id == BuildingCommandIds.EXPAND })
        val readOnly = buildingCommandBar(state(keep, orders = false), keep, gates(level = 5, enabled = false), false, now)
        assertEquals(CommandState.DISABLED, readOnly.of(BuildingCommandIds.EXPAND).state)
        assertEquals("Orders are paused here", readOnly.of(BuildingCommandIds.EXPAND).reason)
        assertEquals(CommandState.ENABLED, readOnly.of(BuildingCommandIds.INFO).state)
    }

    @Test fun `a maxed Keep gives STORES the primary and its plate reads MAX`() {
        // commands-1 note: when maxed, STORES takes the slot; tap 2 on the Keep must still open something.
        val keep = building("keep", 10)
        val maxed = gates(level = 10, max = 10, upgrade = false, cost = null)
        val bar = buildingCommandBar(state(keep), keep, maxed, false, now)
        assertTrue(bar.commands.none { it.id == BuildingCommandIds.UPGRADE })
        assertEquals(listOf(BuildingCommandIds.STORES), bar.commands.filter { it.primary }.map { it.id })
        assertEquals("MAX", buildingNamePlate(keep, maxed, now, state(keep)).level)
    }

    @Test fun `UPGRADE goes SHORT only against a known lower Shards balance`() {
        // SPEC 1.5 SHORT: a red pill must be a fact. An unknown balance never accuses the player of being short.
        val tower = building("archertower", 5)
        fun upgradeOf(shards: String?) = buildingCommandBar(state(tower, shards = shards), tower, gates(level = 5, cost = "500"), false, now)
            .of(BuildingCommandIds.UPGRADE)
        assertEquals(PriceStatus.SHORT, upgradeOf("100").price?.status)
        assertEquals(CommandState.SHORT, commandDrawState(upgradeOf("100")))
        assertEquals(PriceStatus.OK, upgradeOf("500").price?.status)
        assertEquals(PriceStatus.OK, upgradeOf(null).price?.status)
        assertEquals(CommandState.ENABLED, commandDrawState(upgradeOf(null)))
        assertEquals("500", upgradeOf("100").price?.amount)
    }

    @Test fun `a SHORT UPGRADE tap opens the review and never anything that spends`() {
        // The only upgrade path from the bar is the review sheet, which shows the shortfall; nothing is ordered here.
        val tower = building("archertower", 5)
        val bar = buildingCommandBar(state(tower, shards = "100"), tower, gates(level = 5), false, now)
        assertEquals(listOf("review"), tap(BuildingCommandIds.UPGRADE, bar))
    }

    @Test fun `REARM runs in place while a SHORT REARM opens Need-more`() {
        // commands-3: REARM is a server call with no sheet; short of Shards it must never fire that call.
        val trap = building("spiketrap", 3)
        val spent = gates(upgrade = false, repair = TrapRepair(600, 60))
        val bar = buildingCommandBar(state(trap), trap, spent, false, now)
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.REARM), bar.commands.map { it.id })
        assertEquals(PriceUi(Currency.SHARDS, "600", PriceStatus.OK), bar.of(BuildingCommandIds.REARM).price)
        assertEquals(listOf("rearm"), tap(BuildingCommandIds.REARM, bar))
        val short = buildingCommandBar(state(trap, shards = "100"), trap, spent, false, now)
        assertEquals(listOf("rearmShort"), tap(BuildingCommandIds.REARM, short))
        assertEquals("Spent · rearm it", buildingNamePlate(trap, spent, now, state(trap)).stateLine)
    }

    @Test fun `REARM and COLLECT show busy dots only for the order this bar sent`() {
        // SPEC 1.5 "Command in flight": the dots belong to the sent order; another order in flight is a plain refusal.
        val trap = building("spiketrap", 3)
        val spent = gates(upgrade = false, repair = TrapRepair(600, 60), enabled = false)
        assertEquals(CommandState.BUSY, buildingCommandBar(state(trap), trap, spent, true, now, sent = BuildingCommandIds.REARM)
            .of(BuildingCommandIds.REARM).state)
        assertEquals(CommandState.DISABLED, buildingCommandBar(state(trap), trap, spent, true, now).of(BuildingCommandIds.REARM).state)
        val mine = building("mine", 3)
        val busyCollect = buildingCommandBar(state(mine, accrued = "8400"), mine, gates(enabled = false), true, now,
            sent = BuildingCommandIds.COLLECT).of(BuildingCommandIds.COLLECT)
        assertEquals(CommandState.BUSY, busyCollect.state)
        assertTrue(tap(BuildingCommandIds.COLLECT, CommandBarUi(mine.id, listOf(busyCollect))).isEmpty())
        assertEquals(CommandState.DISABLED, buildingCommandBar(state(mine, accrued = "8400"), mine, gates(enabled = false), true, now)
            .of(BuildingCommandIds.COLLECT).state)
    }

    @Test fun `Hero Altar shows GEAR with NEW only when the bag holds unseen gear`() {
        // commands-2: a NEW badge that is always on teaches the player to ignore badges.
        val altar = building("heroaltar", 5)
        val withNew = buildingCommandBar(state(altar), altar, gates(level = 5), false, now, extras = BuildingBarExtras(gearNew = true))
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.GEAR, BuildingCommandIds.UPGRADE, BuildingCommandIds.HERO_VEX),
            withNew.commands.map { it.id })
        assertEquals(BadgeUi("NEW", BadgeTone.REWARD, "New gear in the bag"), withNew.of(BuildingCommandIds.GEAR).badge)
        assertEquals("hero_vex_portrait", withNew.of(BuildingCommandIds.HERO_VEX).icon)
        assertNull(buildingCommandBar(state(altar), altar, gates(level = 5), false, now).of(BuildingCommandIds.GEAR).badge)
        assertEquals(listOf("gear"), tap(BuildingCommandIds.GEAR, withNew))
    }

    @Test fun `the hero buildings UPGRADE opens the hero upgrade not the building review`() {
        // The altar's level is the hero's; the old BuildingSheet review is not where that upgrade is paid.
        val altar = building("heroaltar", 5)
        val bar = buildingCommandBar(state(altar), altar, gates(level = 5), false, now)
        assertEquals(listOf("heroUpgrade"), tap(BuildingCommandIds.UPGRADE, bar))
        assertEquals(listOf("heroUpgrade"), tap(BuildingCommandIds.UPGRADE, bar, BuildingSelection(baseId, altar.id, altar.type)))
        val short = buildingCommandBar(state(altar, shards = "1"), altar, gates(level = 5), false, now)
        assertEquals(listOf("heroUpgrade"), tap(BuildingCommandIds.UPGRADE, short))
        assertEquals(listOf("heroes"), tap(BuildingCommandIds.HERO_VEX, bar))
    }

    @Test fun `Clan Hall gets a gold CLAN primary with UPGRADE as a green secondary`() {
        // SPEC 1.4: the building's own job is the gold primary; UPGRADE is always green.
        val hall = building("clanhall", 2)
        val bar = buildingCommandBar(state(hall), hall, gates(level = 2), false, now)
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.UPGRADE, BuildingCommandIds.CLAN), bar.commands.map { it.id })
        assertTrue(bar.of(BuildingCommandIds.CLAN).primary)
        assertFalse(bar.of(BuildingCommandIds.UPGRADE).primary)
        assertEquals(Verb.GREEN, bar.of(BuildingCommandIds.UPGRADE).verb)
        assertEquals(listOf("clan"), tap(BuildingCommandIds.CLAN, bar))
    }

    @Test fun `Barracks carries the training count badge and the training plate line from armyStatus`() {
        // commands-1: the red count is the server's queue, and an idle Barracks shows no badge at all (never 0).
        val barracks = building("barracks", 7)
        val training = state(barracks, extra = ""","armyStatus":{"trainingTroopCount":4,"nextReadyAt":"2026-10-06T00:00:42.000Z"}""")
        val bar = buildingCommandBar(training, barracks, gates(level = 7), false, now)
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.UPGRADE, BuildingCommandIds.TRAIN), bar.commands.map { it.id })
        assertEquals(BadgeUi("4", BadgeTone.COUNT, "4 troops training"), bar.of(BuildingCommandIds.TRAIN).badge)
        assertEquals("Training 4 · 42s", buildingNamePlate(barracks, gates(level = 7), now, training).stateLine)
        val idle = state(barracks, extra = ""","armyStatus":{"trainingTroopCount":0}""")
        assertNull(buildingCommandBar(idle, barracks, gates(level = 7), false, now).of(BuildingCommandIds.TRAIN).badge)
        assertNull(buildingNamePlate(barracks, gates(level = 7), now, idle).stateLine)
    }

    @Test fun `Army Camp plate and ARMY meter show the server camp fill`() {
        // commands-1: "Army 96/120 · 24 free" + the green bar, and the same fill on the ARMY primary.
        val camp = building("camp", 6)
        val s = state(camp, extra = ""","armyStatus":{"readyPts":96,"campCapacityPts":120}""")
        val plate = buildingNamePlate(camp, gates(level = 6), now, s)
        assertEquals("Army 96/120 · 24 free", plate.stateLine)
        assertEquals(0.8f, plate.progress!!, 0.0001f)
        assertEquals(Verb.GREEN, plate.progressVerb)
        assertEquals(0.8f, buildingCommandBar(s, camp, gates(level = 6), false, now).of(BuildingCommandIds.ARMY).meter!!, 0.0001f)
    }

    @Test fun `Mine COLLECT carries the value and ready badge only while Shards are waiting`() {
        // commands-2: "+8,400" and the green "!" are the deed's mining pool; an empty pool must not invite a collect.
        val mine = building("mine", 3)
        val ready = buildingCommandBar(state(mine, accrued = "8400"), mine, gates(), false, now).of(BuildingCommandIds.COLLECT)
        assertEquals("+8,400", ready.value)
        assertEquals(BadgeTone.READY, ready.badge?.tone)
        assertEquals("!", ready.badge?.text)
        assertEquals("Ready · 8,400 Shards", buildingNamePlate(mine, gates(), now, state(mine, accrued = "8400")).stateLine)
        val empty = buildingCommandBar(state(mine, accrued = "0"), mine, gates(), false, now).of(BuildingCommandIds.COLLECT)
        assertNull(empty.value)
        assertNull(empty.badge)
        assertNull(buildingNamePlate(mine, gates(), now, state(mine, accrued = "0")).stateLine)
        assertEquals(listOf("collect"), tap(BuildingCommandIds.COLLECT, CommandBarUi(mine.id, listOf(ready))))
    }

    @Test fun `a building under construction shows a gold NEW tag a striped meter and only INFO and FINISH`() {
        // states.png "Under construction": nothing but FINISH can act on an unfinished building.
        val barracks = building("barracks", 1, underConstruction = true)
        val build = BaseJob("job-2", "build", buildingId = barracks.id, startedAt = "2026-10-05T23:00:00.000Z",
            finishesAt = "2026-10-06T01:12:00.000Z")
        val g = gates(level = 1, upgrade = false, job = build)
        val plate = buildingNamePlate(barracks, g, now, state(barracks))
        assertEquals("NEW", plate.level)
        assertEquals(Verb.GOLD, plate.levelVerb)
        assertEquals("Building · 1h 12m", plate.stateLine)
        assertTrue(plate.progressStriped)
        assertNotNull(plate.progress)
        val bar = buildingCommandBar(state(barracks), barracks, g, false, now)
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.FINISH), bar.commands.map { it.id })
        assertEquals("1h 12m", bar.of(BuildingCommandIds.FINISH).value)
    }

    @Test fun `an upgrading building reads LV a over b and keeps its own action visible but off with the reason`() {
        // states.png "Upgrading": the type action greys out and a tap says why; the bar explains, the router stays quiet.
        val barracks = building("barracks", 3)
        val g = gates(level = 3, upgrade = false, job = upgradeJob)
        val plate = buildingNamePlate(barracks, g, now, state(barracks))
        assertEquals("LV 3>4", plate.level)
        assertNull(plate.levelVerb)
        assertEquals("Upgrading · 1h 12m", plate.stateLine)
        assertFalse(plate.progressStriped)
        val bar = buildingCommandBar(state(barracks), barracks, g, false, now)
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.TRAIN, BuildingCommandIds.FINISH), bar.commands.map { it.id })
        val train = bar.of(BuildingCommandIds.TRAIN)
        assertEquals(CommandState.DISABLED, train.state)
        assertEquals("Barracks is upgrading", train.reason)
        assertTrue(bar.of(BuildingCommandIds.FINISH).primary)
        assertTrue(tap(BuildingCommandIds.TRAIN, bar).isEmpty())
    }

    @Test fun `FINISH shows no currency until the server review terms name one`() {
        // Gems or KEEP is the server's choice at review time; guessing it on the bar would misstate a paid action.
        val barracks = building("barracks", 3)
        val finish = buildingCommandBar(state(barracks), barracks, gates(upgrade = false, job = upgradeJob), false, now)
            .of(BuildingCommandIds.FINISH)
        assertNull(finish.price)
        assertEquals("timer", finish.icon)
        assertEquals("Price shown in review", finish.sub)
        assertEquals("1h 12m", finish.value)
        assertEquals(CommandState.ENABLED, finish.state)
    }

    @Test fun `a LOCKED tap explains its requirement and a DISABLED tap is left to the bar`() {
        // A door never does nothing: LOCKED shows the requirement; DISABLED already shook and showed its reason pill.
        val bar = CommandBarUi("keep-1", listOf(
            CommandUi(BuildingCommandIds.STORES, "bag", "STORES", null, false, CommandState.LOCKED, "Opens with the Keep", null),
            CommandUi(BuildingCommandIds.EXPAND, "itm_deed_earth", "EXPAND", null, false, CommandState.DISABLED, "Orders are paused here", null)))
        assertEquals(listOf("explain:Opens with the Keep"), tap(BuildingCommandIds.STORES, bar))
        assertTrue(tap(BuildingCommandIds.EXPAND, bar).isEmpty())
    }

    @Test fun `unwired new doors explain themselves instead of doing nothing`() {
        // The old KingdomScreen call passes only the first eleven callbacks; its STORES / EXPAND / CLAN must still answer.
        val said = mutableListOf<String>()
        val old = BuildingCommandRoutes({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, explain = { said += it })
        val bar = CommandBarUi("x", listOf(
            CommandUi(BuildingCommandIds.STORES, "bag", "STORES", null, false, CommandState.ENABLED, null, null),
            CommandUi(BuildingCommandIds.EXPAND, "itm_deed_earth", "EXPAND", null, false, CommandState.ENABLED, null, null),
            CommandUi(BuildingCommandIds.CLAN, "itm_banner", "CLAN", null, true, CommandState.ENABLED, null, null)))
        for (id in listOf(BuildingCommandIds.STORES, BuildingCommandIds.EXPAND, BuildingCommandIds.CLAN)) routeBuildingCommand(id, bar, old)
        assertEquals(3, said.size)
        assertTrue(said.all { it.isNotBlank() })
    }

    @Test fun `a Workshop door goes last as the primary with UPGRADE green before it and carries the owner badge`() {
        // commands-4: INFO · UPGRADE · CRAFT, CRAFT gold with the jobs-running count from the Workshop's own read.
        val workshop = building("workshop", 2)
        val badge = BadgeUi("2", BadgeTone.COUNT, "2 refining jobs running")
        val host = object : PhaseEBuildingCommands {
            val seen = mutableListOf<BuildingCommandPresentation>()
            override fun buildingCommandBar(building: Building, presentation: BuildingCommandPresentation): CommandBarUi? {
                seen += presentation
                return CommandBarUi(building.id, listOf(CommandUi(FeatureId("workshop.craft"), "ui:workshop-menu", "CRAFT", null, true,
                    CommandState.ENABLED, null, presentation.entries[FeatureId("workshop.craft")]?.badge)))
            }
            override fun openBuildingDoor(id: FeatureId, selection: BuildingSelection) {}
        }
        val bar = buildingCommandBar(state(workshop), workshop, gates(level = 2), false, now, host,
            BuildingBarExtras(workshop = BarDoorFact(stateLine = "Refining · 42s", badge = badge)))
        assertEquals(listOf(BuildingCommandIds.INFO, BuildingCommandIds.UPGRADE, FeatureId("workshop.craft")), bar.commands.map { it.id })
        assertEquals(listOf(FeatureId("workshop.craft")), bar.commands.filter { it.primary }.map { it.id })
        assertEquals(badge, host.seen.single().entries.getValue(FeatureId("workshop.craft")).badge)
        assertEquals(badge, bar.commands.last().badge)
        assertEquals("Refining · 42s", buildingNamePlate(workshop, gates(level = 2), now, state(workshop),
            BuildingBarExtras(workshop = BarDoorFact(stateLine = "Refining · 42s"))).stateLine)
        // Without the registry door the bar is still whole: UPGRADE keeps the primary it had before C3 was mounted.
        val alone = buildingCommandBar(state(workshop), workshop, gates(level = 2), false, now)
        assertEquals(listOf(BuildingCommandIds.UPGRADE), alone.commands.filter { it.primary }.map { it.id })
    }
}
