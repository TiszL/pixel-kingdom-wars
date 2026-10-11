package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** 339e7ac0: a last admitted display value is not an admitted balance or a start permission. */
class LiveBuildHeldPriceTest {
    private fun pack() = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/iw3/catalogue.json"))
        .bufferedReader().use { it.readText() }).jsonObject
    private fun initial(): LiveBuildingCostSnapshot {
        val account = AccountSession(gg.pixelkingdomwars.nativeclient.WALLET, "https://example.invalid", gg.pixelkingdomwars.nativeclient.testToken())
        val raw = buildJsonObject { put("baseId", "b1"); putJsonArray("buildings") {} }
        val base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = 5, builders = 2), null, null, null,
            emptyList(), emptyList(), emptyList(), 1, raw)
        return LiveBuildingCostSnapshot(account, KingdomUiState(
            home = BaseState(base = base, balances = Balances(shards = "1", keep = "0")), catalogue = pack(),
            local = KingdomLocal(buildMenu = true), wallet = account.wallet, selectedBaseId = "b1", baseGeneration = 1), 1, 1)
    }
    private class Owner(var snapshot: LiveBuildingCostSnapshot) {
        val holder = gg.pixelkingdomwars.nativeclient.testHolder().also { it.replace(snapshot.account) }
        val memory = LiveBuildPriceMemory()
        fun costs(rendered: KingdomUiState? = null) = LiveBuildingCosts(holder, snapshot.account,
            { snapshot.state }, { snapshot.balanceRevision }, { snapshot.contentGeneration }, memory, rendered)
        fun card(costs: LiveBuildingCosts, type: String = "mine") = liveBuildTrayUi(
            readTrayFacts(snapshot.state, false), LiveTrayTabs.BUILDINGS, costs).sections.flatMap { it.cards }.single { it.type == type }
    }
    private fun assertHeld(owner: Owner, old: LiveBuildingCosts) {
        val p = old.build("mine")!!
        assertFalse(p.current); assertTrue(p.held); assertNull(p.balanceShards)
        assertEquals(PriceStatus.UNAVAILABLE, p.price.status); assertNull(p.price.amount)
        val ui = owner.card(old)
        assertTrue(ui.priceHeld); assertEquals(BuildCardState.CHECKING, ui.state)
        assertEquals(PriceStatus.CHECKING, ui.price!!.status)
        val chip = cardPrice(ui)!!
        assertEquals(PriceStatus.OK, chip.status) // Kit's neutral cream paint, no stale affordability.
        assertEquals(exactAmount(owner.snapshot.state.price("mine")!!.amount), priceText(chip))
        assertTrue(priceDescription(chip).contains("Last confirmed price"))
        assertFalse(priceDescription(chip).contains("not enough"))
        assertNull(liveTrayNeedMore(readTrayFacts(owner.snapshot.state, false), "mine", MineFact(null, null), old))
        val fresh = owner.costs()
        assertTrue(fresh.build("mine")!!.held)
        assertEquals(ui.price!!.amount, owner.card(fresh).price!!.amount)
    }
    @Test fun `loading alone holds admitted digits across compositions without a balance`() {
        val o = Owner(initial()); val old = o.costs(); assertTrue(old.build("mine")!!.current)
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(home = o.snapshot.state.home.copy(loading = true)))
        assertHeld(o, old)
    }
    @Test fun `error alone holds admitted digits through the failed poll interval`() {
        val o = Owner(initial()); val old = o.costs(); old.build("mine")
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(home = o.snapshot.state.home.copy(error = "read failed")))
        assertHeld(o, old)
    }
    @Test fun `revision alone holds a retained read but a fresh admitted read ends the hold`() {
        val o = Owner(initial()); val old = o.costs(); old.build("mine")
        o.snapshot = o.snapshot.copy(balanceRevision = o.snapshot.balanceRevision + 1)
        val p = old.build("mine")!!
        assertTrue(p.held); assertFalse(p.current); assertNull(p.balanceShards)
        assertTrue(o.card(old).priceHeld)
        val fresh = o.costs(); val current = fresh.build("mine")!!
        assertTrue(current.current); assertFalse(current.held)
        assertFalse(o.card(fresh).priceHeld); assertEquals(PriceStatus.SHORT, current.price.status)
    }
    @Test fun `rendered versus live Home mismatch holds digits but neither review nor placement`() {
        val o = Owner(initial()); o.costs().build("mine"); val rendered = o.snapshot.state
        o.snapshot = o.snapshot.copy(state = rendered.copy(home = rendered.home.copy(balances = Balances(shards = "2", keep = "0"))))
        val costs = o.costs(rendered)
        assertFalse(costs.matchesRendered(rendered)); assertFalse(costs.reviewCurrent())
        assertTrue(costs.build("mine")!!.held); assertTrue(o.card(costs).priceHeld)
        val draft = rendered.copy(local = rendered.local.copy(placement = PlacementDraft("mine", 1 to 1)))
        val facts = readPlacementFacts(draft, false, 0, false)!!
        assertFalse(costs.placement(facts)!!.current)
        assertEquals(PriceStatus.UNAVAILABLE, costs.placement(facts)!!.price.status)
    }
    @Test fun `held and newly refreshing cards refuse placement with an updating explanation`() {
        val o = Owner(initial()); val costs = o.costs(); val ready = o.card(costs)
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(home = o.snapshot.state.home.copy(loading = true)))
        var picked = 0; var more = 0; var navigated = 0; val reasons = mutableListOf<String>()
        for (card in listOf(ready.copy(state = BuildCardState.AVAILABLE), o.card(costs)))
            dispatchLiveBuildCard(card, costs, false, { picked++ }, { more++ }, { navigated++ }, reasons::add)
        assertEquals(0, picked); assertEquals(0, more); assertEquals(0, navigated)
        assertEquals(listOf(UPDATING_BUILD_PRICES, UPDATING_BUILD_PRICES), reasons)
    }
    @Test fun `locked and max taps explain a busy or non-current navigation window`() {
        for (busy in listOf(true, false)) {
            val o = Owner(initial()); val costs = o.costs(); val ready = o.card(costs)
            if (!busy) o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(home = o.snapshot.state.home.copy(error = "read failed")))
            var navigated = 0; val reasons = mutableListOf<String>()
            for (state in listOf(BuildCardState.LOCKED, BuildCardState.MAX))
                dispatchLiveBuildCard(ready.copy(state = state), costs, busy, { fail("placement") }, { fail("shortfall") }, { navigated++ }, reasons::add)
            assertEquals(0, navigated); assertEquals(listOf(UPDATING_BUILD_PRICES, UPDATING_BUILD_PRICES), reasons)
        }
    }
    @Test fun `base switch and switch back cannot resurrect a held price`() {
        val o = Owner(initial()); val original = o.snapshot; o.costs().build("mine")
        o.snapshot = original.copy(state = original.state.copy(selectedBaseId = "b2", baseGeneration = 2,
            home = original.state.home.copy(base = original.state.base!!.copy(baseId = "b2"), loading = true)))
        assertFalse(o.costs().build("mine")!!.held)
        o.snapshot = original.copy(state = original.state.copy(baseGeneration = 3, home = original.state.home.copy(loading = true)))
        assertFalse(o.costs().build("mine")!!.held)
    }
    @Test fun `sign-out or a new account drops the held price`() {
        val o = Owner(initial()); val old = o.costs(); old.build("mine"); o.holder.replace(null)
        assertFalse(old.build("mine")!!.held)
        val other = initial(); o.snapshot = other.copy(state = other.state.copy(home = other.state.home.copy(loading = true)))
        o.holder.replace(other.account)
        assertFalse(o.costs().build("mine")!!.held)
    }
    @Test fun `catalogue identity or generation change drops the held price`() {
        for (generationOnly in listOf(true, false)) {
            val o = Owner(initial()); o.costs().build("mine")
            o.snapshot = o.snapshot.copy(contentGeneration = if (generationOnly) 2 else 1,
                state = o.snapshot.state.copy(catalogue = if (generationOnly) o.snapshot.state.catalogue else pack(),
                    home = o.snapshot.state.home.copy(loading = true)))
            assertFalse(o.costs().build("mine")!!.held)
        }
    }
    @Test fun `a never admitted type or a never admitted price cannot be held`() {
        val o = Owner(initial()); val costs = o.costs(); costs.build("mine")
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(home = o.snapshot.state.home.copy(loading = true)))
        val fresh = o.costs()
        assertFalse(fresh.build("vault")!!.held); assertFalse(o.card(fresh, "vault").priceHeld)
        assertEquals("No price yet", buildCardReasonLabel(o.card(fresh, "vault")))
        val never = Owner(initial().let { it.copy(state = it.state.copy(home = it.state.home.copy(loading = true))) })
        assertFalse(never.costs().build("mine")!!.held)
    }
    @Test fun `read-only orders and changed price context never borrow held admission`() {
        val seed = initial()
        val variants = listOf(
            seed.state.copy(ordersAllowed = false), seed.state.copy(deedActionsAllowed = false),
            seed.state.copy(local = seed.state.local.copy(buildMenu = false)),
            seed.state.copy(local = seed.state.local.copy(placement = PlacementDraft("vault", 2 to 2))))
        for (state in variants) {
            val o = Owner(seed); val old = o.costs(); old.build("mine")
            o.snapshot = seed.copy(state = state.copy(home = state.home.copy(loading = true)))
            assertFalse(old.build("mine")!!.held)
        }
    }
    @Test fun `every short-label producer uses the shared full reason and recovery retires held admission`() {
        val o = Owner(initial()); val costs = o.costs(); costs.build("mine")
        val unavailable = o.card(costs, "workshop")
        assertEquals(BUILDING_UNAVAILABLE, unavailable.reason)
        assertEquals("Unavailable", buildCardReasonLabel(unavailable))
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(home = o.snapshot.state.home.copy(loading = true)))
        val never = Owner(o.snapshot)
        val missing = never.card(never.costs(), "vault")
        assertEquals(PRICE_UNAVAILABLE, missing.reason); assertEquals("No price yet", buildCardReasonLabel(missing))
        val saved = gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent(
            gg.pixelkingdomwars.nativeclient.ops.PendingIntent(gg.pixelkingdomwars.nativeclient.ops.IntentKind.CONSTRUCTION,
                gg.pixelkingdomwars.nativeclient.WALLET, "b1", "original-key", "/base/buildings",
                gg.pixelkingdomwars.nativeclient.json("""{"idempotencyKey":"original-key","type":"mine","tx":4,"ty":7}"""),
                "Build Mine", attempted = true))
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(interrupted = listOf(saved)))
        val blocked = o.costs()
        assertFalse(blocked.build("mine")!!.held)
        val recovery = o.card(blocked)
        assertEquals(SAVED_BUILD_PAYMENT, recovery.reason)
        assertEquals("Check payment", buildCardReasonLabel(recovery))
        assertFalse(recovery.priceHeld); assertEquals(BuildCardState.UNAVAILABLE, recovery.state)
    }
    @Test fun `new cost object uses the same session memory while mismatch remains a strict gate`() {
        val vm = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomViewModel.kt").readText()
        assertTrue(vm.contains("private val buildPriceMemory ="))
        assertTrue(vm.contains("heldPrices = buildPriceMemory, rendered = rendered"))
        val reader = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/live/LiveBuildingFactsReader.kt").readText()
        assertTrue(reader.contains("if (rendered != null && !matchesRendered(rendered)) return false"))
    }
    @Test fun `a remembered build price is scoped to its type and level only`() {
        val o = Owner(initial()); o.costs().build("mine")
        assertNotNull(o.memory.price(o.snapshot, "mine", 1))
        assertNull(o.memory.price(o.snapshot, "mine", 2))
        assertNull(o.memory.price(o.snapshot, "vault", 1))
    }
    @Test fun `a rendered mismatch never becomes a new first admission`() {
        val o = Owner(initial()); val rendered = o.snapshot.state
        o.snapshot = o.snapshot.copy(state = rendered.copy(home = rendered.home.copy(balances = Balances(shards = "2", keep = "0"))))
        val costs = o.costs(rendered)
        assertFalse(costs.reviewCurrent()); assertFalse(costs.build("mine")!!.held)
        assertEquals(PriceStatus.UNAVAILABLE, costs.build("mine")!!.price.status)
        assertFalse(o.card(costs).priceHeld)
    }
    @Test fun `next admitted zero price retires the old display rather than inventing free`() {
        val o = Owner(initial()); o.costs().build("vault")
        val original = o.snapshot.state.catalogue!!
        val constants = original["constants"]!!.jsonObject
        val table = constants["BUILD_COSTS"]!!.jsonObject
        val zero = JsonObject(table["vault"]!!.jsonObject + ("costShards" to JsonPrimitive(0)))
        val next = JsonObject(original + ("constants" to JsonObject(constants + ("BUILD_COSTS" to JsonObject(table + ("vault" to zero))))))
        o.snapshot = o.snapshot.copy(state = o.snapshot.state.copy(catalogue = next))
        val price = o.costs().build("vault")!!
        assertTrue(price.current); assertFalse(price.held); assertNull(price.price.amount)
        assertEquals(PriceStatus.UNAVAILABLE, price.price.status)
    }
}
