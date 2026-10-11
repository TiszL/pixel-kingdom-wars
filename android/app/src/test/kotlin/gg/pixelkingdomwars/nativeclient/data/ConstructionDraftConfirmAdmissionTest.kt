package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** An input race during a routine reload cannot consume an intent without full art admission. */
@OptIn(ExperimentalCoroutinesApi::class)
class ConstructionDraftConfirmAdmissionTest {
    @Before fun main() { Dispatchers.setMain(StandardTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    @Test fun `confirm while preparing preserves the draft for a later explicit admitted confirm`() = runTest {
        val h = ConstructionDraftHarness(this)
        try {
            h.startDraft(); val draft = requireNotNull(h.model.state.value.placement)
            val gate = h.beginRefresh()
            h.model.confirmPlacement(); h.main()
            assertSame(draft, h.model.state.value.placement); h.assertNoMutation()
            h.finish(gate)
            assertSame(draft, h.model.state.value.placement); h.assertNoMutation()
            h.model.confirmPlacement(); h.main()
            assertEquals(listOf("place:workshop:15:17"), h.base.calls.filter { it.startsWith("place:") })
        } finally { h.close() }
    }
}
