package gg.pixelkingdomwars.nativeclient.ui.land

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.LandDeposit
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.math.BigInteger

/** The land screen's SOL readout: the Home HUD's wallet read feeds the chip and the ten-second poll never occupies the action slot. */
@OptIn(ExperimentalCoroutinesApi::class)
class LandFundingViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val actions = InterruptedActions({}, {}, {})

    @Test fun `the server wallet read feeds the funding chip and a poll without a reservation re-reads it off the busy slot`() {
        val land = FakeLandRepository(); val funds = MutableStateFlow<WalletFunds?>(WalletFunds("1.5", emptyMap(), 0)); var reads = 0
        val model = LandViewModel(land, FakeWorldRepository(), FakeAccountRepository(), FakeBaseRepository(), ReceiptObserver(PendingIntentStore(MemoryStore())), FakeContentRepository(),
            { null }, actions, funds, { reads++ }) { after -> after() }
        assertEquals("1.5", model.state.value.funds?.sol)
        assertEquals(BigInteger.valueOf(1_500_000_000L), model.state.value.funding.balanceLamports)
        model.pollFunding()
        assertEquals(1, reads); assertFalse("A funding poll must not disable PAY or flash the progress bar", model.busy.value)
        assertTrue("No reservation: nothing to price by RPC", land.calls.none { it == "estimate" })
        funds.value = WalletFunds("2", emptyMap(), 1)
        assertEquals(BigInteger.valueOf(2_000_000_000L), model.state.value.funding.balanceLamports)
    }

    @Test fun `a priced reservation polls its RPC estimate instead, so the balance the PAY button trusts is the one refreshed`() {
        val land = FakeLandRepository(); var reads = 0
        land._state.value = LandCheckoutState(phase = LandPhase.READY, reservation = LandDeposit(id = "d", amountLamports = "200000000"))
        val model = LandViewModel(land, FakeWorldRepository(), FakeAccountRepository(), FakeBaseRepository(), ReceiptObserver(PendingIntentStore(MemoryStore())), FakeContentRepository(),
            { null }, actions, MutableStateFlow(null), { reads++ }) { after -> after() }
        model.pollFunding()
        assertEquals(listOf("estimate"), land.calls); assertEquals(0, reads)
        val funding = model.state.value.funding
        assertEquals("The frozen price is the need until the estimate adds fees", BigInteger.valueOf(200_000_000L), funding.requiredLamports)
        assertNull("An unpriced wallet is neither funded nor short", funding.funded)
    }
}
