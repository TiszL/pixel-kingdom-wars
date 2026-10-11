package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Wallet credit is independent of base selection. An available kingdom snapshot refreshes second. */
class GemsBuyBalances(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val refreshAccount: suspend () -> Unit,
    private val hasSelectedSnapshot: () -> Boolean, private val refreshSelected: suspend () -> Unit) {
    private val mutable = MutableStateFlow<WalletFunds?>(null); val state = mutable.asStateFlow()
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    suspend fun refresh() {
        guard(); val wallet = WalletFunds.from(api.get("/wallet/balances")); guard(); mutable.value = wallet
        refreshAccount(); guard()
        if (hasSelectedSnapshot()) { refreshSelected(); guard() }
    }
}
