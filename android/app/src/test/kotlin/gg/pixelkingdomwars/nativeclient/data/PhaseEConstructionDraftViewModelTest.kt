package gg.pixelkingdomwars.nativeclient.data

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.network.RaidInterlockState
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

/** review adeec950: local intent survives only an explicitly current lease reload. These use
 * the real binder/provider/VM, exact IW3 metadata and held FAKE leases; no residency/pixel claim. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhaseEConstructionDraftViewModelTest {
    @Before fun main() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    @Test fun `UI follows runtime art and preparation instead of the null constructor defaults`() = runTest {
        // The harness supplies constructionRuntimeFactory and leaves both constructor flows null.
        val h = ConstructionDraftHarness(this)
        try {
            h.ready()
            assertNotNull(h.provider.constructionArt.value)
            assertSame(h.provider.constructionArt.value, h.model.state.value.constructionArt)
            assertSame(h.provider.preparation.value, h.model.state.value.constructionPreparation)
            assertTrue(h.model.state.value.constructionAvailable("workshop"))

            val gate = h.beginRefresh()
            assertNull(h.model.state.value.constructionArt)
            assertSame(h.provider.preparation.value, h.model.state.value.constructionPreparation)
            assertEquals(PhaseEConstructionPreparation.PREPARING, h.model.state.value.constructionPreparation?.phase)
            assertFalse(h.model.state.value.constructionAvailable("workshop"))

            h.finish(gate)
            assertNotNull(h.model.state.value.constructionArt)
            assertSame(h.provider.constructionArt.value, h.model.state.value.constructionArt)
            assertSame(h.provider.preparation.value, h.model.state.value.constructionPreparation)
            assertEquals(PhaseEConstructionPreparation.READY, h.model.state.value.constructionPreparation?.phase)

            h.sink.permission(h.token, false); h.main()
            assertNull(h.model.state.value.constructionArt)
            assertNull(h.model.state.value.constructionPreparation)
            assertFalse(h.model.state.value.constructionAvailable("workshop"))
            h.assertNoMutation()
        } finally { h.close() }
    }

    @Test fun `same base refresh retains exact draft and tile while full confirm remains closed`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.startDraft(); val draft = requireNotNull(h.model.state.value.placement); val context = h.context()
            val gate = h.beginRefresh()
            assertSame(context, h.context()); assertSame(draft, h.model.state.value.placement)
            assertEquals(15 to 17, h.model.state.value.placement?.tile)
            assertFalse(h.model.state.value.constructionAvailable("workshop"))
            h.model.confirmPlacement(); h.main()
            h.assertNoMutation()
            h.finish(gate); h.assertNoMutation()
        } finally { h.close() }
    }

    @Test fun `ready replacement preserves tile and only explicit confirmation dispatches once`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.startDraft(); val draft = requireNotNull(h.model.state.value.placement)
            val gate = h.beginRefresh(); h.finish(gate)
            assertSame(draft, h.model.state.value.placement); h.assertNoMutation()
            assertTrue(h.model.state.value.constructionAvailable("workshop"))
            h.model.confirmPlacement(); h.main(); h.model.confirmPlacement(); h.main()
            assertEquals(listOf("place:workshop:15:17"), h.base.calls.filter { it.startsWith("place:") })
        } finally { h.close() }
    }

    @Test fun `multiple raw refreshes before collection cannot misclassify stale status as retirement`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.startDraft(); val draft = requireNotNull(h.model.state.value.placement); val context = h.context()
            val gate = h.holdNext()
            h.refresh(); h.refresh(); h.main(); h.worker.enter(gate); h.main()
            assertSame(draft, h.model.state.value.placement); assertSame(context, h.context())
            assertEquals(PhaseEConstructionPreparation.PREPARING, h.provider.preparation.value?.phase)
            assertFalse(h.model.state.value.constructionAvailable("workshop"))
            h.finish(gate); assertSame(draft, h.model.state.value.placement)
        } finally { h.close() }
    }

    @Test fun `permission loss while art already null clears permanently and quick reopening cannot resurrect`() = runTest {
        for (clearSource in listOf(false, true)) {
            val h = ConstructionDraftHarness(this)
            try {
                h.startDraft(); val context = h.context(); val gate = h.beginRefresh()
                if (clearSource) h.sink.clear(h.token) else h.sink.permission(h.token, false)
                assertFalse("Live draft guard retires before collection", context.isCurrent())
                assertNull(h.provider.preparation.value)
                // Deliberately reopen before the UI sees null: identity retirement must survive conflation.
                if (clearSource) h.admit() else h.sink.permission(h.token, true)
                h.main(); h.worker.drain(); h.main()
                assertNull(h.model.state.value.placement)
                h.finish(gate); assertNull(h.model.state.value.placement)
                assertNotSame(context, h.context()); h.assertNoMutation()
            } finally { h.close() }
        }
    }

    @Test fun `each actual owner content or gate retirement clears a preparing draft for good`() = runTest {
        val changes: List<Pair<String, (ConstructionDraftHarness) -> Unit>> = listOf(
            "account instance" to { h -> h.account.value = h.account.value.copy(session = AccountSession(WALLET, h.session.origin, testToken())) },
            "wallet identity" to { h -> h.account.value = h.account.value.copy(identity = Identity("synthetic-other-wallet")) },
            "holder" to { h -> h.holderCurrent = false; h.refresh() },
            "base identity" to { h -> h.account.value = h.account.value.copy(selectedBaseId = "other", baseSelectionGeneration = 2); h.refresh(ConstructionDraftFixtures.raw(id = "other")) },
            "base ABA generation" to { h -> h.account.value = h.account.value.copy(baseSelectionGeneration = 3) },
            "owner cancellation" to { h -> h.owner.cancel() },
            "source replacement" to { h -> h.sink.setSource(h.token, h.session, h.content.state.value, h.newSource()) },
            "assets path" to { h -> h.content.set { it.copy(assets = File("synthetic-replacement")) } },
            "catalogue reference" to { h -> h.content.set { it.copy(checking = true, catalogue = JsonObject(requireNotNull(it.catalogue).toMap())) } },
            "render reference" to { h -> h.content.set { it.copy(checking = true, renderCatalogue = JsonObject(requireNotNull(it.renderCatalogue).toMap())) } },
            "manifest reference" to { h -> h.content.set { it.copy(checking = true, manifest = requireNotNull(it.manifest).copy()) } },
            "mandatory update" to { h -> h.content.set { it.copy(updateMandatoryBlocked = true) } },
            "minimum native build" to { h -> h.content.set { it.copy(minimumNativeBuild = 2) } },
            "unknown raid interlock" to { h -> h.interlock.value = RaidInterlockState(known = false) },
        )
        for ((label, change) in changes) {
            val h = ConstructionDraftHarness(this)
            try {
                h.startDraft(); val context = h.context(); val gate = h.beginRefresh()
                change(h)
                assertFalse("$label must invalidate the captured context before UI collection", context.isCurrent())
                h.main(); assertNull("$label must clear the draft", h.model.state.value.placement)
                h.finish(gate)
                assertNull("$label cannot return a saved draft from old work", h.model.state.value.placement)
                h.assertNoMutation()
            } finally { h.close() }
        }
    }

    @Test fun `feature removal future version and malformed enablement clear despite unchanged content source`() = runTest {
        val malformed = JsonObject(ConstructionDraftFixtures.raw() + ("features" to json("""{"phaseEBuildings":{"version":1,"enabledTypes":"workshop"}}""")))
        val cases = listOf(ConstructionDraftFixtures.raw(enabled = false), ConstructionDraftFixtures.raw(featureVersion = 2), malformed)
        for (raw in cases) {
            val h = ConstructionDraftHarness(this)
            try {
                h.startDraft(); val gate = h.beginRefresh()
                h.refresh(raw); h.main(); assertNull(h.model.state.value.placement)
                h.refresh(); h.main(); h.worker.drain(); h.main(); h.finish(gate)
                assertNull("Restored feature never reconstructs local intent", h.model.state.value.placement)
                h.assertNoMutation()
            } finally { h.close() }
        }
    }

    @Test fun `missing duplicate or malformed required current metadata clears rather than retaining by type name`() = runTest {
        val original = ConstructionDraftFixtures.render
        val entries = original.getValue("entries").jsonArray
        val row = entries.single { it.jsonObject["type"] == JsonPrimitive("workshop") && it.jsonObject["level"] == JsonPrimitive(1) }
        val renderVariants = listOf(
            JsonObject(original + ("entries" to JsonArray(entries.filterNot { it === row }))),
            JsonObject(original + ("entries" to JsonArray(entries + row))),
            JsonObject(original + ("entries" to JsonArray(entries.map { if (it !== row) it else JsonObject(row.jsonObject + ("phaseE" to JsonNull)) }))),
        )
        for (render in renderVariants) {
            val h = ConstructionDraftHarness(this)
            try {
                h.startDraft(); val gate = h.beginRefresh()
                h.content.set { it.copy(renderCatalogue = render) }; h.main()
                assertNull(h.model.state.value.placement)
                h.content.set { h.originalContent }; h.main(); h.worker.drain(); h.main(); h.finish(gate)
                assertNull(h.model.state.value.placement); h.assertNoMutation()
            } finally { h.close() }
        }
    }

    @Test fun `terminal refusal clears draft and explicit later successful preparation never recreates it`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.startDraft(); val context = h.context(); val gate = h.beginRefresh(fail = true)
            h.finish(gate)
            assertEquals(PhaseEConstructionPreparation.REFUSED, h.provider.preparation.value?.phase)
            assertFalse(context.isCurrent()); assertNull(h.model.state.value.placement)
            h.refresh(); h.ready()
            assertNull(h.model.state.value.placement); h.assertNoMutation()
        } finally { h.close() }
    }

    @Test fun `upgrade and new placement remain closed during preparation despite a retained draft`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.startDraft(); val draft = requireNotNull(h.model.state.value.placement); val gate = h.beginRefresh()
            h.model.upgrade("facility"); h.main()
            assertSame(draft, h.model.state.value.placement); h.assertNoMutation()
            h.model.startPlacement("workshop"); h.main()
            assertSame(draft, h.model.state.value.placement); h.assertNoMutation()
            h.finish(gate)
        } finally { h.close() }
    }

    @Test fun `initial preparation cannot create a new draft`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            val gate = h.holdNext(); h.main(); h.worker.enter(gate)
            assertEquals(PhaseEConstructionPreparation.PREPARING, h.provider.preparation.value?.phase)
            h.model.startPlacement("workshop"); h.main()
            assertNull(h.model.state.value.placement); h.assertNoMutation()
            h.finish(gate); assertNull(h.model.state.value.placement)
        } finally { h.close() }
    }

    @Test fun `external art injection without preparation context retains strict retirement behavior`() = runTest {
        val h = ConstructionDraftHarness(this)
        var direct: KingdomViewModel? = null
        try {
            h.ready()
            val vm = KingdomViewModel(h.base, h.content, ReceiptObserver(PendingIntentStore(MemoryStore())),
                InterruptedActions({}, {}, {}), versionCode = 1, wallet = WALLET,
                constructionArt = h.provider.constructionArt)
            direct = vm; h.main()
            vm.startPlacement("workshop"); h.main(); vm.pickTile(15f, 17f); h.main()
            assertNotNull(vm.state.value.placement)
            val gate = h.beginRefresh(); assertNull(vm.state.value.placement)
            h.finish(gate); assertNull(vm.state.value.placement); h.assertNoMutation()
        } finally { direct?.viewModelScope?.cancel(); h.close() }
    }

    @Test fun `ordinary placement and original construction receipt observation keep existing behavior`() = runTest {
        val h = ConstructionDraftHarness(this)
        var recovery: KingdomViewModel? = null
        try {
            h.ready(); h.model.startPlacement("mine"); h.main(); h.model.pickTile(15f, 17f); h.main()
            val ordinary = requireNotNull(h.model.state.value.placement)
            val gate = h.beginRefresh(); assertSame(ordinary, h.model.state.value.placement); h.finish(gate)
            val store = PendingIntentStore(MemoryStore())
            store.create(PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "original-draft-test-key", "/base/buildings",
                json("""{"idempotencyKey":"original-draft-test-key","type":"workshop","tx":15,"ty":17}"""),
                "Build Workshop", attempted = true))
            val observer = ReceiptObserver(store); observer.refresh(WALLET)
            val checked = mutableListOf<String>()
            val vm = KingdomViewModel(h.base, h.content, observer, InterruptedActions({ checked += it }, {}, {}),
                versionCode = 1, wallet = WALLET, recoveryOnly = true)
            recovery = vm; h.main()
            vm.interrupted.check(IntentKind.CONSTRUCTION)
            assertEquals(listOf(IntentKind.CONSTRUCTION), checked)
            assertEquals("original-draft-test-key", vm.state.value.interrupted.single().intent.idempotencyKey)
            h.assertNoMutation()
        } finally { recovery?.viewModelScope?.cancel(); h.close() }
    }
}
