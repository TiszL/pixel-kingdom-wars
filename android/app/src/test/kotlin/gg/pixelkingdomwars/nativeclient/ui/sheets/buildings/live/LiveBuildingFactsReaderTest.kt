package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.PlacementDraft
import gg.pixelkingdomwars.nativeclient.ui.kingdom.buildingGates
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reader (KingdomUiState -> facts). Why it matters: the live sheets must show the SAME gate and the SAME price the
 * current BuildingSheet / BuildMenu / placement dialog show for the same state, because those are what the player has
 * been trusting; the reader must be a pass-through of `buildingGates` and the catalogue lookups, never a second rule.
 * (Runs in the Gradle unit-test task: it needs the network module's catalogue helpers.)
 */
class LiveBuildingFactsReaderTest {
    private val catalogue: JsonObject = buildJsonObject {
        putJsonObject("constants") {
            putJsonObject("UPGRADE_COSTS") { putJsonArray("cannon") { add("521"); add("900") } }
            putJsonObject("UPGRADE_TIMES_SEC") { putJsonArray("cannon") { add(5400); add(7200) } }
            putJsonObject("DEFENSES") { putJsonObject("cannon") { put("hp", 360) } }
            putJsonObject("DEFENSE_LEVELING") { put("maxLevel", 10); put("statMultPerLevel", 1.1) }
            putJsonObject("BUILD_COSTS") { putJsonObject("cannon") { put("costShards", "1500"); put("buildSec", "7200"); put("requiresKeepLevel", "1") } }
        }
        putJsonObject("display") { putJsonObject("upgradeSolLamports") { putJsonObject("cannon") {} } }
    }
    private val cannon = Building("c1", "cannon", 1, 0, 0)

    private fun state(shards: String? = "341", jobs: List<BaseJob> = emptyList(), free: Int = 1, local: KingdomLocal = KingdomLocal(),
        ordersAllowed: Boolean = true) = KingdomUiState(
        home = BaseState(
            base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = 3, builders = 2), null, null, null, listOf(cannon), emptyList(), jobs, free,
                buildJsonObject { putJsonArray("buildings") { addJsonObject { put("id", "c1"); put("type", "cannon"); put("level", 1) } } }),
            balances = shards?.let { Balances(shards = it, keep = "0") },
        ),
        catalogue = catalogue, local = local, ordersAllowed = ordersAllowed,
    )

    @Test fun `building facts pass the current sheet's gate and price through unchanged`() {
        val s = state()
        val gates = buildingGates(s, cannon, busy = false)!!
        val f = readBuildingFacts(s, cannon, busy = false, now = 0L)!!
        assertEquals(gates.canShowUpgrade, f.canShowUpgrade)
        assertEquals(gates.enabled, f.enabled)
        assertEquals("521", f.upgradeCostRaw)
        assertEquals("521", f.upgradeCost)
        assertEquals("1h 30m", f.upgradeTime)
        assertTrue(f.upgradePriced)
        assertFalse(f.paidStep)
        assertEquals(10, f.maxLevel)
        assertEquals(BuildingCategory.DEFENCE, f.category)
        assertEquals("341", f.shardsBalance)
        assertEquals(1, f.freeBuilders); assertEquals(2, f.totalBuilders)
        val ui = liveUpgradeUi(f)!!
        assertEquals(UpgradeState.SHORT, ui.state)
        assertEquals("180", ui.shortfall)
    }

    @Test fun `a paused base reads as read-only with the bar's words, no balance reads as unknown`() {
        val f = readBuildingFacts(state(shards = null, ordersAllowed = false), cannon, busy = false, now = 0L)!!
        assertTrue(f.readOnly); assertFalse(f.enabled)
        assertEquals("Orders are paused here", f.blockedReason)
        assertNull(f.shardsBalance)
    }

    @Test fun `a running job carries its remaining time and the server's refund, never a finish amount`() {
        val job = BaseJob("j1", "upgrade", buildingId = "c1", startedAt = "2026-10-03T00:00:00Z", finishesAt = "2026-10-03T01:12:00Z",
            finishCostKeep = "38", canCancel = true, refundShards = "260")
        val f = readBuildingFacts(state(jobs = listOf(job)), cannon, busy = false, now = java.time.Instant.parse("2026-10-03T00:00:00Z").toEpochMilli())!!
        assertEquals("1h 12m", f.job?.remaining)
        assertEquals("260", f.job?.cancelRefund)
        assertFalse(f.job!!.freeFinish)
        assertTrue(f.job!!.canReview)
        assertEquals("1h 12m", f.nextBuilderFreeIn)
    }

    @Test fun `tray and placement facts read the same catalogue price the current tray and dialog print`() {
        val tray = readTrayFacts(state(), busy = false)!!
        val card = tray.cards.single { it.type == "cannon" }
        assertEquals("1,500", card.amount); assertEquals("SHARDS", card.currency); assertEquals("2h", card.time)
        assertEquals(1, card.requiredKeep)
        val placement = readPlacementFacts(state(local = KingdomLocal(placement = PlacementDraft("cannon", 2 to 3))), busy = false, now = 0L, heroOffer = false)
        assertNotNull(placement)
        assertEquals("1,500", placement!!.amount)
        assertEquals(2 to 3, placement.tile)
        assertTrue(placement.available)
    }

    private fun costSnapshot(shards: String? = "341") = LiveBuildingCostSnapshot(
        account = gg.pixelkingdomwars.nativeclient.session.AccountSession(
            gg.pixelkingdomwars.nativeclient.WALLET, "https://example.invalid", gg.pixelkingdomwars.nativeclient.testToken()),
        state = state(shards = shards).copy(wallet = gg.pixelkingdomwars.nativeclient.WALLET,
            selectedBaseId = "b1", baseGeneration = 1,
            local = KingdomLocal(selectedBuildingId = "c1", buildMenu = true)),
        contentGeneration = 1, balanceRevision = 1,
    )

    /** A real holder plus mutable owner observations; no captured-UI read lambda. */
    private class CostOwner(initial: LiveBuildingCostSnapshot) {
        val holder = gg.pixelkingdomwars.nativeclient.testHolder().also { it.replace(initial.account) }
        private class Read(val snapshot: LiveBuildingCostSnapshot?)
        private val live = kotlinx.coroutines.flow.MutableStateFlow(Read(initial))
        var failure: RuntimeException? = null
        var reads = 0
        var snapshot: LiveBuildingCostSnapshot?
            get() = live.value.snapshot
            set(value) {
                if (value != null && value.account !== initialAccount) holder.replace(value.account)
                live.value = Read(value)
            }
        private val initialAccount = initial.account
        val costs = LiveBuildingCosts(holder, initial.account,
            readState = { reads++; failure?.let { throw it }; requireNotNull(live.value.snapshot).state },
            readBalanceRevision = { failure?.let { throw it }; requireNotNull(live.value.snapshot).balanceRevision },
            readContentGeneration = { requireNotNull(live.value.snapshot).contentGeneration })
    }

    @Test fun `ordinary catalogue prices are held during refresh while spend admission stays closed`() {
        val pack = kotlinx.serialization.json.Json.parseToJsonElement(requireNotNull(
            javaClass.getResourceAsStream("/iw3/catalogue.json")).bufferedReader().use { it.readText() }) as JsonObject
        val seed = costSnapshot()
        val original = seed.copy(state = seed.state.copy(catalogue = pack))
        val owner = CostOwner(original)
        for (type in listOf("mine", "vault", "barracks", "camp", "spiketrap", "powdermine")) {
            val price = original.state.price(type)!!
            val cost = owner.costs.build(type)!!
            assertEquals("SHARDS", price.currency)
            assertEquals(price.amount, cost.amountRaw)
            assertTrue(cost.current)
            assertNotNull(cost.price.amount)
        }
        val refreshing = original.copy(balanceRevision = original.balanceRevision + 1,
            state = original.state.copy(home = original.state.home.copy(loading = true)))
        owner.snapshot = refreshing
        for (type in listOf("mine", "vault", "barracks", "camp", "spiketrap", "powdermine")) {
            val cost = owner.costs.build(type)!!
            assertFalse(cost.current)
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, cost.price.status)
            assertNull(cost.price.amount)
            assertTrue("339e7ac0 changes the display rule, never currentness", cost.held)
            assertEquals(original.state.price(type)!!.amount, cost.amountRaw)
        }
        val held = liveBuildTrayUi(readTrayFacts(original.state, false), LiveTrayTabs.BUILDINGS, owner.costs)
            .sections.flatMap { it.cards }.single { it.type == "mine" }
        assertTrue(held.priceHeld)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.CHECKING, held.state)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount(original.state.price("mine")!!.amount),
            gg.pixelkingdomwars.nativeclient.ui.kit.priceText(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardPrice(held)!!))
        val settled = refreshing.copy(state = refreshing.state.copy(home = refreshing.state.home.copy(loading = false)))
        val fresh = CostOwner(settled)
        for (type in listOf("mine", "vault", "barracks", "camp", "spiketrap", "powdermine")) {
            assertTrue(fresh.costs.build(type)!!.current)
            assertNotNull(fresh.costs.build(type)!!.price.amount)
        }
    }

    @Test fun `admitted cost hosts use canonical Shards prices and only the base Shards balance`() {
        val snapshot = costSnapshot("341")
        val owner = CostOwner(snapshot); val costs = owner.costs
        val f = readBuildingFacts(snapshot.state, cannon, false, 0L)!!
        val info = liveBuildingInfoUi(f, costs)
        val upgrade = liveUpgradeUi(f, costs)!!
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.SHORT, info.price?.status)
        assertEquals("521", info.price?.amount); assertEquals("180", upgrade.shortfall)
        assertEquals(info.price, upgrade.price)
        val tray = readTrayFacts(snapshot.state, false)!!
        val card = liveBuildTrayUi(tray, LiveTrayTabs.DEFENCES, costs).sections.flatMap { it.cards }.single()
        assertEquals("1,500", card.price?.amount)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.SHORT, card.state)
        // KEEP is zero in this Home; it cannot replace the base's 341 Shards.
        assertEquals("341", costs.upgrade(f)!!.balanceShards)
        assertTrue(costs.reviewCurrent())
    }

    @Test fun `unknown or malformed base Shards remains checking and cannot submit an upgrade`() {
        for (balance in listOf(null, "", "garbled", "1.5", " 900 ", "-1")) {
            val snapshot = costSnapshot(balance); val owner = CostOwner(snapshot); val costs = owner.costs
            val f = readBuildingFacts(snapshot.state, cannon, false, 0L)!!
            val ui = liveUpgradeUi(f, costs)!!
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING, ui.price.status)
            assertNull(ui.shortfall)
            assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook(ui.state, ui.price, ui.reason).sends)
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING, liveBuildingInfoUi(f, costs).price?.status)
        }
    }

    @Test fun `cost admission rejects owner selection catalogue and generation changes before stale UI mapping`() {
        val original = costSnapshot("900")
        val f = readBuildingFacts(original.state, cannon, false, 0L)!!
        val variants = listOf(
            costSnapshot("900"), // another account session, even with the same wallet
            original.copy(state = original.state.copy(wallet = "other")),
            original.copy(state = original.state.copy(selectedBaseId = "other")),
            original.copy(state = original.state.copy(baseGeneration = 2)),
            original.copy(state = original.state.copy(local = original.state.local.copy(selectedBuildingId = "other"))),
            original.copy(state = original.state.copy(catalogue = JsonObject(catalogue.toMap()))),
            original.copy(contentGeneration = 2),
            original.copy(state = original.state.copy(home = original.state.home.copy(loading = true))),
            original.copy(state = original.state.copy(home = original.state.home.copy(error = "refresh failed"))),
            original.copy(state = original.state.copy(ordersAllowed = false)),
            original.copy(state = original.state.copy(deedActionsAllowed = false)),
        )
        for (current in variants) {
            val owner = CostOwner(original); val costs = owner.costs
            assertTrue(costs.reviewCurrent())
            owner.snapshot = current
            assertFalse(costs.reviewCurrent())
            val ui = liveUpgradeUi(f, costs)!!
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, ui.price.status)
            assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook(ui.state, ui.price, ui.reason).sends)
        }
        assertFalse(CostOwner(original).also { it.snapshot = null }.costs.reviewCurrent())
        assertFalse(CostOwner(original).also { it.failure = IllegalStateException("retired") }.costs.reviewCurrent())
    }

    @Test fun `balance refresh invalidates review even with equal amounts and ABA restores`() {
        val original = costSnapshot("900"); val owner = CostOwner(original)
        val costs = owner.costs
        val f = readBuildingFacts(original.state, cannon, false, 0L)!!
        assertTrue(costs.reviewCurrent())
        owner.snapshot = original.copy(state = original.state.copy(home = original.state.home.copy(
            balances = original.state.home.balances!!.copy())))
        assertFalse(costs.reviewCurrent())
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, costs.upgrade(f)!!.price.status)
        owner.snapshot = original.copy(balanceRevision = 2) // the owner revision survives equal-object ABA
        assertFalse(costs.reviewCurrent())
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook(
            liveUpgradeUi(f, costs)!!.state, liveUpgradeUi(f, costs)!!.price, null).sends)
    }

    @Test fun `hero item and SOL reviews are routed before money projection and retain recovery`() {
        val snapshot = costSnapshot(); val owner = CostOwner(snapshot); val costs = owner.costs
        val original = readBuildingFacts(snapshot.state, cannon, false, 0L)!!
        for (f in listOf(original.copy(type = "heroaltar"), original.copy(type = "siegestool"),
            original.copy(paidStep = true, paidOfferReady = true))) {
            assertNull(costs.upgrade(f))
            assertNull(liveUpgradeUi(f, costs))
            assertNull(liveBuildingInfoUi(f, costs).price)
            assertEquals(liveBuildingInfoUi(f).primary, liveBuildingInfoUi(f, costs).primary)
        }
        val running = original.copy(job = JobFact("saved-job", "upgrade", "soon", false, true, "260"))
        assertEquals(liveBuildingInfoUi(running), liveBuildingInfoUi(running, costs))
        assertNull(liveUpgradeUi(running, costs))
    }

    @Test fun `foreign or stale building facts cannot borrow an admitted cost`() {
        val snapshot = costSnapshot(); val owner = CostOwner(snapshot); val costs = owner.costs
        val f = readBuildingFacts(snapshot.state, cannon, false, 0L)!!
        for (wrong in listOf(f.copy(buildingId = "other"), f.copy(level = 2), f.copy(type = "vault"))) {
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, costs.upgrade(wrong)!!.price.status)
        }
        // Amount strings in a presentation object are not price or balance authority.
        val forged = f.copy(upgradeCost = "0", upgradeCostRaw = "0", shardsBalance = "999999")
        assertEquals("521", liveUpgradeUi(forged, costs)!!.price.amount)
        assertEquals("180", liveUpgradeUi(forged, costs)!!.shortfall)
    }

    @Test fun `stale tray uses unavailable prices while preserving Keep and capacity precedence`() {
        val snapshot = costSnapshot(); val owner = CostOwner(snapshot); val costs = owner.costs
        owner.snapshot = snapshot.copy(balanceRevision = 2)
        val tray = readTrayFacts(snapshot.state, false)!!
        val ui = liveBuildTrayUi(tray, LiveTrayTabs.DEFENCES, costs)
        val card = ui.sections.flatMap { it.cards }.single()
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.UNAVAILABLE, card.state)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, card.price?.status)
        val capped = tray.copy(cards = tray.cards.map { it.copy(atCap = true) })
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.MAX,
            liveBuildTrayUi(capped, LiveTrayTabs.DEFENCES, costs).sections.flatMap { it.cards }.single().state)
    }

    @Test fun `guarded need-more uses canonical shortfall and disappears after balance refresh`() {
        val snapshot = costSnapshot(); val owner = CostOwner(snapshot)
        val costs = owner.costs
        val f = readBuildingFacts(snapshot.state, cannon, false, 0L)!!
        assertEquals("180", liveUpgradeNeedMore(f, costs)?.blocks?.single()?.more)
        val tray = readTrayFacts(snapshot.state, false)!!
        assertEquals("1,159", liveTrayNeedMore(tray, "cannon", MineFact(null, null), costs)?.blocks?.single()?.more)
        owner.snapshot = snapshot.copy(balanceRevision = 2)
        assertNull(liveUpgradeNeedMore(f, costs))
        assertNull(liveTrayNeedMore(tray, "cannon", MineFact(null, null), costs))
    }

    @Test fun `INFO facts envelope cannot replace an owner read with the captured UI state`() {
        val captured = costSnapshot("900"); val owner = CostOwner(captured)
        val f = readBuildingFacts(captured.state, cannon, false, 0L)!!
        val envelope = LiveBuildingSheetFacts(f, owner.costs)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.OK, liveBuildingInfoUi(envelope).price?.status)
        owner.snapshot = captured.copy(state = captured.state.copy(baseGeneration = 2))
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, liveBuildingInfoUi(envelope).price?.status)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.CommandState.DISABLED, liveBuildingInfoUi(envelope).primary.state)
        assertEquals("900", captured.state.home.balances?.shards) // deliberately unchanged captured UI
    }

    @Test fun `UPGRADE facts envelope refuses equal-value refresh ABA while the old UI remains payable`() {
        val captured = costSnapshot("900"); val owner = CostOwner(captured)
        val f = readBuildingFacts(captured.state, cannon, false, 0L)!!
        val envelope = LiveBuildingSheetFacts(f, owner.costs)
        assertTrue(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook(
            liveUpgradeUi(envelope)!!.state, liveUpgradeUi(envelope)!!.price, null).sends)
        owner.snapshot = captured.copy(balanceRevision = 2)
        val stale = liveUpgradeUi(envelope)!!
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, stale.price.status)
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook(stale.state, stale.price, stale.reason).sends)
        assertEquals("900", f.shardsBalance)
    }

    @Test fun `BUILD facts envelope refuses account replacement before the captured tray catches up`() {
        val captured = costSnapshot("9000"); val owner = CostOwner(captured)
        val tray = readTrayFacts(captured.state, false)!!
        val envelope = LiveBuildTrayFacts(tray, owner.costs)
        fun card() = liveBuildTrayUi(envelope, LiveTrayTabs.DEFENCES).sections.flatMap { it.cards }.single()
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.AVAILABLE, card().state)
        owner.snapshot = null
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.UNAVAILABLE, card().state)
        owner.snapshot = costSnapshot("9000") // same wallet, different account owner
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.UNAVAILABLE, card().state)
    }

    @Test fun `facts envelopes retain H1 special review routing before any guarded price read`() {
        val captured = costSnapshot(); val f = readBuildingFacts(captured.state, cannon, false, 0L)!!
        val owner = CostOwner(captured); val costs = owner.costs
        owner.reads = 0 // Constructor captures a real owner observation; routing must make no further read.
        for (special in listOf(f.copy(type = "heroaltar"), f.copy(type = "siegestool"), f.copy(paidStep = true, paidOfferReady = true))) {
            val envelope = LiveBuildingSheetFacts(special, costs)
            assertNull(liveUpgradeUi(envelope))
            val info = liveBuildingInfoUi(envelope)
            assertNull(info.price); assertEquals(liveBuildingInfoUi(special).primary, info.primary)
        }
        assertEquals("H1 must route before the projection's currentness read", 0, owner.reads)
    }

    @Test fun `facts envelopes cannot source H2 funds from forged presentation or KEEP amounts`() {
        val captured = costSnapshot("341")
        val owner = CostOwner(captured); val costs = owner.costs
        val f = readBuildingFacts(captured.state, cannon, false, 0L)!!.copy(shardsBalance = "999999", upgradeCost = "0", upgradeCostRaw = "0")
        val envelope = LiveBuildingSheetFacts(f, costs)
        assertEquals("521", liveBuildingInfoUi(envelope).price?.amount)
        assertEquals("180", liveUpgradeUi(envelope)?.shortfall)
        assertEquals("180", liveUpgradeNeedMore(envelope)?.blocks?.single()?.more)
        val tray = readTrayFacts(captured.state, false)!!.copy(shardsBalance = "999999")
        val build = LiveBuildTrayFacts(tray, costs)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.SHORT,
            liveBuildTrayUi(build, LiveTrayTabs.DEFENCES).sections.flatMap { it.cards }.single().price?.status)
        assertEquals("1,159", liveTrayNeedMore(build, "cannon", MineFact(null, null))?.blocks?.single()?.more)
    }

    @Test fun `facts envelopes retire open need-more after a balance refresh without changing recovery`() {
        val captured = costSnapshot(); val owner = CostOwner(captured)
        val f = readBuildingFacts(captured.state, cannon, false, 0L)!!
        val costs = owner.costs
        val selected = LiveBuildingSheetFacts(f, costs)
        val tray = LiveBuildTrayFacts(readTrayFacts(captured.state, false)!!, costs)
        assertNotNull(liveUpgradeNeedMore(selected))
        assertNotNull(liveTrayNeedMore(tray, "cannon", MineFact(null, null)))
        owner.snapshot = captured.copy(balanceRevision = 2)
        assertNull(liveUpgradeNeedMore(selected))
        assertNull(liveTrayNeedMore(tray, "cannon", MineFact(null, null)))
        val job = f.copy(job = JobFact("original-job", "upgrade", "soon", false, true, "260"))
        assertEquals(liveBuildingInfoUi(job), liveBuildingInfoUi(LiveBuildingSheetFacts(job, costs)))
    }

    @Test fun `superseded holder and cancellation both refuse even when the UI and revision are unchanged`() {
        val snapshot = costSnapshot("900"); val owner = CostOwner(snapshot)
        assertTrue(owner.costs.reviewCurrent())
        owner.failure = kotlinx.coroutines.CancellationException("session superseded")
        assertFalse(owner.costs.reviewCurrent())
        owner.failure = null
        gg.pixelkingdomwars.nativeclient.signedIn(owner.holder)
        assertFalse(owner.costs.reviewCurrent())
    }

    @Test fun `canonical SOL upgrade and KEEP second mine retain their original review routes`() {
        val snapshot = costSnapshot()
        val paid = snapshot.copy(state = snapshot.state.copy(catalogue = gg.pixelkingdomwars.nativeclient.json(
            catalogue.toString().replace("\"cannon\":{}", "\"cannon\":{\"2\":7}"))))
        val owner = CostOwner(paid)
        val f = readBuildingFacts(paid.state, cannon, false, 0L)!!
        assertTrue(f.paidStep)
        assertNull(owner.costs.upgrade(f.copy(paidStep = false))) // canonical row, not the presentation flag
        assertNull(liveUpgradeUi(f, owner.costs))
        val mineCatalogue = gg.pixelkingdomwars.nativeclient.json("""{"constants":{"BUILD_COSTS":{"mine":{"costShards":11,"buildSec":17,"requiresKeepLevel":1}},"MINING":{"MINE_BUILD_KEEP":[11,23]}}}""")
        val existingMine = gg.pixelkingdomwars.nativeclient.json("""{"id":"mine-one","type":"mine","level":1}""")
        val raw = JsonObject(snapshot.state.base!!.raw + ("buildings" to kotlinx.serialization.json.JsonArray(listOf(existingMine))))
        val base = snapshot.state.base!!.copy(raw = raw)
        val secondMine = snapshot.copy(state = snapshot.state.copy(catalogue = mineCatalogue, home = snapshot.state.home.copy(base = base)))
        assertEquals("KEEP", secondMine.state.price("mine")?.currency)
        assertNull(CostOwner(secondMine).costs.build("mine"))
    }

    @Test fun `zero catalogue cost is unavailable and LOCKED wins over unavailable or short`() {
        val snapshot = costSnapshot("900")
        val zero = snapshot.copy(state = snapshot.state.copy(catalogue = gg.pixelkingdomwars.nativeclient.json(
            catalogue.toString().replace("\"521\"", "\"0\""))))
        val f = readBuildingFacts(zero.state, cannon, false, 0L)!!
        val cost = CostOwner(zero).costs.upgrade(f)!!
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, cost.price.status)
        assertNull(cost.price.amount)
        val owner = CostOwner(snapshot); owner.snapshot = snapshot.copy(balanceRevision = 2)
        val tray = readTrayFacts(snapshot.state, false)!!.let { it.copy(cards = it.cards.map { card -> card.copy(requiredKeep = 9, atCap = true) }) }
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.LOCKED,
            liveBuildTrayUi(tray, LiveTrayTabs.DEFENCES, owner.costs).sections.flatMap { it.cards }.single().state)
    }

    @Test fun `loading at refresh start refuses a revision that advances only at completion`() {
        val snapshot = costSnapshot("900"); val owner = CostOwner(snapshot)
        assertTrue(owner.costs.reviewCurrent())
        owner.snapshot = snapshot.copy(state = snapshot.state.copy(home = snapshot.state.home.copy(loading = true)))
        assertEquals(snapshot.balanceRevision, owner.snapshot!!.balanceRevision)
        assertFalse(owner.costs.reviewCurrent())
        owner.snapshot = snapshot.copy(balanceRevision = 2)
        assertFalse(owner.costs.reviewCurrent())
    }

    @Test fun `guarded placement shares canonical funds and refuses a stale draft observation`() {
        for (balance in listOf("1.5", " 9000 ", "garbled", null, "341")) {
            val initial = costSnapshot(balance)
            val snapshot = initial.copy(state = initial.state.copy(local = initial.state.local.copy(
                buildMenu = false, placement = PlacementDraft("cannon", 4 to 7))))
            val owner = CostOwner(snapshot)
            val f = readPlacementFacts(snapshot.state, false, 0L, false)!!
            val ui = livePlacementUi(f, owner.costs)!!
            val expected = if (balance == "341") gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.SHORT
                else gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING
            assertEquals(expected, ui.price.status)
            assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.placeLook(ui.state, ui.price, ui.reason).tap ==
                gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlaceTap.PLACE)
            if (balance != "341") assertNull(livePlacementNeedMore(f, MineFact(null, null), owner.costs))
            owner.snapshot = snapshot.copy(balanceRevision = 2)
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, livePlacementUi(f, owner.costs)!!.price.status)
            assertNull(livePlacementNeedMore(f, MineFact(null, null), owner.costs))
        }
    }
    @Test fun `an observation already loading errored paused or blocked is never admitted`() {
        val initial = costSnapshot("900")
        val saved = gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent(
            gg.pixelkingdomwars.nativeclient.ops.PendingIntent(gg.pixelkingdomwars.nativeclient.ops.IntentKind.CONSTRUCTION,
                gg.pixelkingdomwars.nativeclient.WALLET, "b1", "original-key", "/base/buildings",
                gg.pixelkingdomwars.nativeclient.json("""{"idempotencyKey":"original-key","type":"cannon","tx":4,"ty":7}"""),
                "Build Cannon", attempted = true))
        val invalid = listOf(
            initial.state.copy(home = initial.state.home.copy(loading = true)),
            initial.state.copy(home = initial.state.home.copy(error = "failed")),
            initial.state.copy(ordersAllowed = false), initial.state.copy(deedActionsAllowed = false),
            initial.state.copy(interrupted = listOf(saved)),
        )
        for (state in invalid) {
            val observed = initial.copy(state = state)
            val owner = CostOwner(observed)
            assertTrue("The identity comparison alone must admit the unchanged observed state", owner.costs.matchesRendered(state))
            assertFalse(owner.costs.reviewCurrent())
            val f = readBuildingFacts(state, cannon, false, 0L)!!
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE, owner.costs.upgrade(f)!!.price.status)
            assertNull(liveUpgradeNeedMore(f, owner.costs))
        }
    }

    @Test fun `malformed tray funds stay checking and the header never prints raw or forged funds`() {
        for (balance in listOf(null, "", "garbled", "1.5", " 9000 ", "-1", "9000")) {
            val snapshot = costSnapshot(balance); val owner = CostOwner(snapshot)
            val facts = readTrayFacts(snapshot.state, false)!!.copy(shardsBalance = "999999")
            val ui = liveBuildTrayUi(facts, LiveTrayTabs.DEFENCES, owner.costs)
            val card = ui.sections.flatMap { it.cards }.single()
            if (balance == "9000") {
                assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.OK, card.price?.status)
                assertEquals("Shards 9,000", ui.spend.exactDescription)
            } else {
                assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.CHECKING, card.price?.status)
                assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.CHECKING, card.state)
                assertEquals("", ui.spend.exactDescription)
                assertEquals(gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount(null), ui.spend.value)
                assertNull(liveTrayNeedMore(facts, "cannon", MineFact(null, null), owner.costs))
            }
        }
    }

    @Test fun `the actual SessionSupersededException closes the cost observation`() {
        val owner = CostOwner(costSnapshot("900"))
        assertTrue(owner.costs.reviewCurrent())
        owner.failure = gg.pixelkingdomwars.nativeclient.network.SessionSupersededException()
        assertFalse(owner.costs.reviewCurrent())
        assertFalse(owner.costs.reviewCurrent())
    }

    private val phaseETrayTypes = listOf("workshop", "lodge", "market", "harvester", "berth")

    private fun portraitFixture(name: String, expectedHash: String): JsonObject {
        val bytes = requireNotNull(javaClass.getResourceAsStream("/iw3/$name")).use { it.readBytes() }
        assertEquals(expectedHash, java.security.MessageDigest.getInstance("SHA-256")
            .digest(bytes).joinToString("") { "%02x".format(it) })
        return kotlinx.serialization.json.Json.parseToJsonElement(bytes.decodeToString()) as JsonObject
    }

    private fun phaseEPortraitState(realm: String = "frostveil", enabled: List<String> = phaseETrayTypes): KingdomUiState {
        val catalogue = portraitFixture("catalogue.json", "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2")
        val render = portraitFixture("render-catalog.json", "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133")
        val raw = buildJsonObject {
            put("baseId", "b1")
            putJsonArray("buildings") {}
            putJsonObject("features") { putJsonObject("phaseEBuildings") {
                put("version", 1); putJsonArray("enabledTypes") { enabled.forEach { add(it) } }
            } }
            putJsonObject("visualContext") { put("version", 1); put("realmId", realm); put("artVersion", 2) }
        }
        // Real admitted metadata with explicit fake residency: these are mapper tests, not pixel/residency proof.
        val art = gg.pixelkingdomwars.nativeclient.data.preparePhaseEConstructionArt(catalogue, render,
            object : gg.pixelkingdomwars.nativeclient.data.PhaseEConstructionResidency {
                override fun isCurrent() = true
                override fun contains(group: gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup) = true
            })
        val original = state()
        return original.copy(catalogue = catalogue, renderCatalogue = render, constructionArt = art,
            home = original.home.copy(base = original.base!!.copy(raw = raw, buildings = emptyList())))
    }

    private fun placementPortrait(state: KingdomUiState, type: String): PlacementFacts = requireNotNull(
        readPlacementFacts(state.copy(local = KingdomLocal(placement = PlacementDraft(type, 2 to 3))),
            busy = false, now = 0L, heroOffer = false))

    @Test fun `all five admitted Phase E tray cards carry their authored portrait into the new interface`() {
        val state = phaseEPortraitState()
        assertEquals(phaseETrayTypes, state.phaseEBuildingChoices)
        val facts = requireNotNull(readTrayFacts(state, busy = false))
        val cards = liveBuildTrayUi(facts, LiveTrayTabs.BUILDINGS).sections.flatMap { it.cards }
            .filter { it.type in phaseETrayTypes }
        assertEquals(listOf("workshop", "lodge", "berth", "harvester", "market"), cards.map { it.type })
        assertEquals(listOf("ui:workshop-t1-idle", "ui:lodge-t1-idle", "ui:berth-starter-intact",
            "ui:harv-frostveil-t1-idle", "ui:market-t1-idle"), cards.map { it.art })
        cards.forEach { assertNotNull(it.type, gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildingArtDrawable(it.art)) }
    }

    @Test fun `new Phase E placement uses the same admitted portrait as its tray card`() {
        val state = phaseEPortraitState()
        val cards = requireNotNull(readTrayFacts(state, false)).cards.associateBy { it.type }
        phaseETrayTypes.forEach { type ->
            val placement = placementPortrait(state, type)
            assertTrue(type, placement.available)
            assertTrue(type, placement.art.isNotBlank())
            assertEquals(type, cards.getValue(type).art, placement.art)
        }
    }

    @Test fun `Harvester portrait follows each admitted realm without a default realm`() {
        listOf("cinderfall", "crownlands", "elderwood", "frostveil", "seeker-reach", "stormcairn", "sunscar", "thornwake")
            .forEach { realm ->
                val state = phaseEPortraitState(realm)
                assertTrue(realm, "harvester" in state.phaseEBuildingChoices)
                val card = requireNotNull(readTrayFacts(state, false)).cards.single { it.type == "harvester" }
                assertEquals("ui:harv-$realm-t1-idle", card.art)
                assertNotNull(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildingArtDrawable(card.art))
                assertEquals(card.art, placementPortrait(state, "harvester").art)
            }
    }

    @Test fun `missing malformed and unknown realm never invent a Harvester portrait`() {
        val original = phaseEPortraitState()
        val contexts = listOf<kotlinx.serialization.json.JsonElement?>(null,
            kotlinx.serialization.json.JsonNull,
            buildJsonObject { put("version", 1); put("realmId", "unknown-realm"); put("artVersion", 2) },
            buildJsonObject { put("version", "1"); put("realmId", "frostveil"); put("artVersion", 2) })
        contexts.forEach { context ->
            val raw = original.base!!.raw.toMutableMap().apply {
                if (context == null) remove("visualContext") else put("visualContext", context)
            }
            val state = original.copy(home = original.home.copy(base = original.base!!.copy(raw = JsonObject(raw))))
            assertFalse("harvester" in state.phaseEBuildingChoices)
            val card = requireNotNull(readTrayFacts(state, false)).cards.single { it.type == "harvester" }
            assertEquals("", card.art)
            assertNotNull(card.unavailableReason)
            val placement = placementPortrait(state, "harvester")
            assertFalse(placement.available); assertEquals("", placement.art)
        }
    }

    @Test fun `a disabled Phase E offer remains discoverable without a legacy placement portrait fallback`() {
        phaseETrayTypes.forEach { type ->
            val state = phaseEPortraitState(enabled = phaseETrayTypes - type)
            val card = requireNotNull(readTrayFacts(state, false)).cards.single { it.type == type }
            assertNotNull(type, card.unavailableReason)
            assertTrue(type, card.art.isNotBlank())
            val placement = placementPortrait(state, type)
            assertFalse(type, placement.available); assertEquals(type, "", placement.art)
        }
    }

    @Test fun `revoking the art capability clears portraits even on the same retained UI state`() {
        val original = phaseEPortraitState()
        var current = true
        val state = original.copy(constructionArt = gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt { request ->
            current && original.constructionArt!!.isAvailable(request)
        })
        assertEquals(phaseETrayTypes, state.phaseEBuildingChoices)
        assertTrue(placementPortrait(state, "workshop").art.isNotBlank())
        current = false
        assertTrue(state.phaseEBuildingChoices.isEmpty())
        val cards = requireNotNull(readTrayFacts(state, false)).cards.filter { it.type in phaseETrayTypes }
        assertEquals(phaseETrayTypes.toSet(), cards.map { it.type }.toSet())
        assertTrue(cards.all { it.unavailableReason != null })
        phaseETrayTypes.forEach { type ->
            val placement = placementPortrait(state, type)
            assertFalse(type, placement.available); assertEquals(type, "", placement.art)
        }
    }

    // Rewritten 2026-10-06 (fix-builder-bug): this case pinned that placement deliberately kept the catalogue portrait
    // while the tray moved to the identity sprites (a tray-only packet). That portrait is the old icon in a dark grey-rimmed
    // plate, so the placement ghost floated as a framed icon over the footprint (owner screenshot 3, "old building ICON is
    // used, for example barracks"). The ghost is now the tray card's own transparent art (buildings/SPEC.md §4.1); cannon,
    // which has no transparent art yet, keeps its mapping on both.
    @Test fun `ordinary placement ghost uses its tray identity while cannon keeps its mapping`() {
        val state = state()
        val expected = gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait(catalogue, "cannon", 1)
        assertEquals(expected, requireNotNull(readTrayFacts(state, false)).cards.single { it.type == "cannon" }.art)
        assertEquals(expected, placementPortrait(state, "cannon").art)
        val pack = kotlinx.serialization.json.Json.parseToJsonElement(requireNotNull(
            javaClass.getResourceAsStream("/iw3/catalogue.json")).bufferedReader().use { it.readText() }) as JsonObject
        val ordinary = state.copy(catalogue = pack)
        for (type in listOf("mine", "vault", "barracks", "forge", "camp", "clanhall")) {
            val card = readTrayFacts(ordinary, false).cards.single { it.type == type }.art
            assertEquals("ui:$type-t1-identity", card)
            assertEquals(type, card, placementPortrait(ordinary, type).art)
            assertNotEquals(type, gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait(pack, type, 1),
                placementPortrait(ordinary, type).art)
        }
    }

    private fun berthTrayState(buildings: List<Building> = emptyList(), keepLevel: Int = 5, shards: String = "9000"): KingdomUiState {
        val original = phaseEPortraitState()
        val raw = JsonObject(original.base!!.raw + ("buildings" to kotlinx.serialization.json.JsonArray(buildings.map { b ->
            buildJsonObject { put("id", b.id); put("type", b.type); put("level", b.level); put("underConstruction", b.underConstruction) }
        })))
        return original.copy(home = original.home.copy(balances = Balances(shards = shards, keep = "0"),
            base = original.base!!.copy(raw = raw, buildings = buildings, player = original.base!!.player.copy(keepLevel = keepLevel))))
    }

    private fun berthCard(state: KingdomUiState) = liveBuildTrayUi(requireNotNull(readTrayFacts(state, false)), LiveTrayTabs.BUILDINGS)
        .sections.flatMap { it.cards }.single { it.type == "berth" }

    @Test fun `a Berth admitted by the server remains placeable without a Lodge`() {
        // b37cc131 rewrites held case 1: construction has no Lodge prerequisite; the design cannot add one.
        val state = berthTrayState()
        assertTrue("berth" in state.phaseEBuildingChoices)
        val card = berthCard(state)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.AVAILABLE, card.state)
        assertNull(card.requires); assertNull(card.reason)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.CardTap.PLACE,
            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardTap(card.state))
        assertNotNull(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardPrice(card))
        assertTrue(placementPortrait(state, "berth").available)
    }

    @Test fun `an unfinished Lodge does not block server admitted Berth construction`() {
        // b37cc131 rewrites held case 2: Lodge completion is not a construction gate on the server.
        val state = berthTrayState(listOf(Building("l1", "lodge", 1, 0, 0, underConstruction = true)))
        val card = berthCard(state)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.AVAILABLE, card.state)
        assertNull(card.requires); assertNull(card.reason)
        assertTrue(placementPortrait(state, "berth").available)
    }

    @Test fun `Lodge presence never replaces authoritative Berth Keep cap or price gates`() {
        // b37cc131 rewrites held case 3: preserve the real gates, independently of a finished Lodge.
        val lodge = Building("l1", "lodge", 1, 0, 0)
        for (lodges in listOf(emptyList(), listOf(lodge))) {
            val short = berthCard(berthTrayState(lodges, shards = "341"))
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.SHORT, short.state)
            assertNull(short.requires)
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.LOCKED,
                berthCard(berthTrayState(lodges, keepLevel = 3)).state)
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.MAX,
                berthCard(berthTrayState(lodges + Building("b2", "berth", 1, 0, 0))).state)
        }
    }

    @Test fun `zero advertised Berth capacity remains the server cap and never invents a Lodge reason`() {
        // b37cc131 rewrites held case 4: zero is an explicit server cap, not evidence of a missing Lodge.
        val original = berthTrayState()
        val raw = JsonObject(original.base!!.raw + ("constructionCapacity" to buildJsonObject {
            put("version", 1); putJsonObject("berth") { put("max", 0) }
        }))
        val card = berthCard(original.copy(home = original.home.copy(base = original.base!!.copy(raw = raw))))
        assertEquals("0/0", card.count)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.MAX, card.state)
        assertEquals("All built", card.reason); assertNull(card.requires)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.CardTap.EXPLAIN_MAX,
            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardTap(card.state))
    }

    @Test fun `guarded Berth cost stays available without a Lodge and saved payment keeps its recovery reason`() {
        // b37cc131 rewrites held case 5: no client prerequisite; the existing payment recovery gate still wins.
        val base = costSnapshot("9000")
        val state = berthTrayState().copy(wallet = base.state.wallet, selectedBaseId = "b1", baseGeneration = 1,
            local = KingdomLocal(buildMenu = true))
        val owner = CostOwner(base.copy(state = state))
        assertTrue(owner.costs.reviewCurrent())
        assertNotNull(owner.costs.build("berth"))
        val facts = requireNotNull(readTrayFacts(state, false))
        val card = liveBuildTrayUi(facts, LiveTrayTabs.BUILDINGS, owner.costs).sections.flatMap { it.cards }.single { it.type == "berth" }
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.AVAILABLE, card.state)
        assertNull(card.requires); assertNull(card.reason)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.OK, card.price?.status)
        val savedIntent = gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent(
            gg.pixelkingdomwars.nativeclient.ops.PendingIntent(gg.pixelkingdomwars.nativeclient.ops.IntentKind.CONSTRUCTION,
                gg.pixelkingdomwars.nativeclient.WALLET, "b1", "original-berth-key", "/base/buildings",
                gg.pixelkingdomwars.nativeclient.json("""{"idempotencyKey":"original-berth-key","type":"berth","tx":4,"ty":7}"""),
                "Build Berth", attempted = true))
        val blocked = state.copy(interrupted = listOf(savedIntent))
        val blockedOwner = CostOwner(base.copy(state = blocked))
        assertTrue(blockedOwner.costs.savedPaymentBlocked())
        val saved = liveBuildTrayUi(requireNotNull(readTrayFacts(blocked, false)), LiveTrayTabs.BUILDINGS, blockedOwner.costs)
            .sections.flatMap { it.cards }.single { it.type == "berth" }
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState.UNAVAILABLE, saved.state)
        assertEquals("Check the saved payment first", saved.reason)
    }

}
