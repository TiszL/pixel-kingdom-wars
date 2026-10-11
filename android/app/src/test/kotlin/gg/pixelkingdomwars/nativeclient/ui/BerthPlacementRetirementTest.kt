package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Synthetic capacity and art-control boundaries, not catalogue numbers or residency proof. */
@OptIn(ExperimentalCoroutinesApi::class)
class BerthPlacementRetirementTest {
    @Before fun main() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    private class Fixture(private val scheduler: TestCoroutineScheduler) : AutoCloseable {
        private val types = listOf("berth", "workshop")
        private val catalogue = buildJsonObject { putJsonObject("constants") {
            putJsonObject("PHASE_E_BUILDINGS") { put("types", JsonArray(types.map(::JsonPrimitive))) }
            putJsonObject("BUILD_COSTS") { types.forEach { put(it, json("""{"costShards":13,"buildSec":17,"requiresKeepLevel":3}""")) } }
            putJsonObject("STRUCTURES") { types.forEach { put(it, json("""{"hp":19,"maxLevel":2,"footprint":[2,1]}""")) } }
            putJsonObject("BUILD_COUNT_CAP_BY_KEEP") { types.forEach { put(it, JsonArray(listOf(0, 0, 1).map(::JsonPrimitive))) } }
        } }
        private val render = buildJsonObject { putJsonArray("entries") { types.forEach { type ->
            addJsonObject {
                put("type", type); put("level", 1); put("footprintWidth", 2); put("footprintHeight", 1)
                putJsonObject("phaseE") { put("facility", type); put("tier", 1) }
            }
        } } }
        fun base(count: Int = 0, cap: Int = 1) = BaseSnapshot.from(json("""{"baseId":"$BASE_ID",
            "player":{"wallet":"$WALLET","keepLevel":3,"builders":1,"expansions":0},
            "claim":{"min":8,"max":22},"freeBuilders":1,"jobs":[],"obstacles":[],
            "buildings":${JsonArray(List(count) { index -> json("""{"id":"berth-$index","type":"berth","level":1,"tx":10,"ty":12,"underConstruction":true}""") })},
            "constructionCapacity":{"version":1,"berth":{"max":$cap}},
            "features":{"phaseEBuildings":{"version":1,"enabledTypes":["berth","workshop"]}}}"""))
        val repo = FakeBaseRepository().also { it._state.value = BaseState(base = base()) }
        val art = MutableStateFlow<PhaseEConstructionArt?>(PhaseEConstructionArt { true })
        val context = PhaseEConstructionDraftContext {}
        val preparation = MutableStateFlow<PhaseEConstructionPreparationState?>(
            PhaseEConstructionPreparationState(context, repo.state.value.base!!.raw, PhaseEConstructionPreparation.READY))
        val model = KingdomViewModel(repo, FakeContentRepository(catalogue, render),
            ReceiptObserver(PendingIntentStore(MemoryStore())), InterruptedActions({}, {}, {}),
            versionCode = 1, wallet = WALLET, recoveryOnly = true,
            constructionArt = art, constructionPreparation = preparation)
        fun drain() = scheduler.runCurrent()
        fun start(type: String = "berth") {
            drain(); model.startPlacement(type); drain(); model.pickTile(15f, 17f); drain()
            assertEquals(15 to 17, model.state.value.placement?.tile)
        }
        fun noMutation() = assertTrue(repo.calls.none { it.startsWith("place:") || it.startsWith("upgrade:") })
        override fun close() { model.viewModelScope.cancel(); drain() }
    }

    @Test fun `full zero or unavailable capacity retires without a tap and recovery requires fresh selection`() = runTest {
        for (refusal in listOf("full", "zero", "missing base")) {
            val f = Fixture(testScheduler)
            try {
                f.start()
                f.repo._state.value = when (refusal) {
                    "full" -> BaseState(base = f.base(count = 1))
                    "zero" -> BaseState(base = f.base(cap = 0))
                    else -> BaseState()
                }
                f.drain(); assertNull(refusal, f.model.state.value.placement)
                f.repo._state.value = BaseState(base = f.base()); f.drain()
                assertNull("Recovery cannot reconstruct intent: $refusal", f.model.state.value.placement)
                f.model.confirmPlacement(); f.drain(); f.noMutation()
                f.start(); f.model.confirmPlacement(); f.drain()
                assertEquals(listOf("place:berth:15:17"), f.repo.calls.filter { it.startsWith("place:") })
            } finally { f.close() }
        }
    }

    @Test fun `capacity refused confirm retires even when recovery overtakes combined UI`() = runTest {
        val f = Fixture(testScheduler)
        try {
            f.start(); val old = f.model.state.value.placement
            f.repo._state.value = BaseState(base = f.base(count = 1))
            assertSame(old, f.model.state.value.placement)
            f.model.confirmPlacement()
            f.repo._state.value = BaseState(base = f.base()); f.drain()
            assertNull(f.model.state.value.placement); assertTrue(f.model.notice.value!!.error)
            f.model.confirmPlacement(); f.drain(); f.noMutation()
        } finally { f.close() }
    }

    @Test fun `capacity refused start retires matching intent even when recovery overtakes combined UI`() = runTest {
        val f = Fixture(testScheduler)
        try {
            f.start(); val old = f.model.state.value.placement
            f.repo._state.value = BaseState(base = f.base(count = 1))
            assertSame(old, f.model.state.value.placement)
            f.model.startPlacement("berth")
            f.repo._state.value = BaseState(base = f.base()); f.drain()
            assertNull(f.model.state.value.placement); assertTrue(f.model.notice.value!!.error)
            f.model.confirmPlacement(); f.drain(); f.noMutation()
        } finally { f.close() }
    }

    @Test fun `a refused Berth start does not retire another selected building type`() = runTest {
        val f = Fixture(testScheduler)
        try {
            f.start("workshop"); val old = f.model.state.value.placement
            f.repo._state.value = BaseState(base = f.base(count = 1))
            f.model.startPlacement("berth"); f.drain()
            assertSame(old, f.model.state.value.placement); assertTrue(f.model.notice.value!!.error)
            f.noMutation()
        } finally { f.close() }
    }

    @Test fun `same context preparing retains a Berth only while capacity remains available`() = runTest {
        val f = Fixture(testScheduler)
        try {
            f.start(); val old = f.model.state.value.placement
            f.preparation.value = PhaseEConstructionPreparationState(f.context, f.repo.state.value.base!!.raw,
                PhaseEConstructionPreparation.PREPARING)
            f.art.value = null; f.drain()
            f.model.confirmPlacement(); f.drain()
            assertSame(old, f.model.state.value.placement); f.noMutation()
            f.repo._state.value = BaseState(base = f.base(count = 1)); f.drain()
            assertNull(f.model.state.value.placement)
            f.repo._state.value = BaseState(base = f.base())
            f.preparation.value = PhaseEConstructionPreparationState(f.context, f.repo.state.value.base!!.raw,
                PhaseEConstructionPreparation.READY)
            f.art.value = PhaseEConstructionArt { true }; f.drain()
            assertNull("Same context and restored art cannot revive a retired tile", f.model.state.value.placement)
            f.model.confirmPlacement(); f.drain(); f.noMutation()
        } finally { f.close() }
    }
}
