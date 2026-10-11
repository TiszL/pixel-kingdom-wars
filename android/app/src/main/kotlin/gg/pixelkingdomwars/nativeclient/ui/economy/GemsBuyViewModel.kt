package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.GemsBuyIntent
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.wallet.PreparedKeepDeposit
import gg.pixelkingdomwars.nativeclient.wallet.WalletPaymentException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class GemsBuyReview(val quote: GemsBuyIntent, val feeLamports: String)

/** Foreground is GET-only. Only explicit review/pay/check actions can create or reconcile an intent. */
class GemsBuyViewModel(private val repository: GemsBuyRepository,
    private val estimate: suspend (GemsBuyIntent) -> PreparedKeepDeposit,
    private val refreshBalances: suspend () -> Unit) : ScreenViewModel() {
    val state = repository.state
    private val mutableReview = MutableStateFlow<GemsBuyReview?>(null); val review = mutableReview.asStateFlow()
    private val mutablePaying = MutableStateFlow(false); val paying = mutablePaying.asStateFlow()
    private var hidden = false
    suspend fun foreground() { hidden = false; refresh()?.join() }
    fun refresh() = run { repository.open(); refreshBalances() }
    /** Opening an external wallet stops the activity; it must not invalidate its in-flight consent. */
    fun background() { hidden = true; if (!mutablePaying.value) dismiss() }
    fun dismiss() { if (!mutablePaying.value) { mutableReview.value = null; repository.dismiss() } }
    fun review(amount: String) = run { mutableReview.value = null; repository.review(amount); prepareReview() }
    fun reviewSaved() = run { mutableReview.value = null; repository.reviewSaved(); prepareReview() }
    private suspend fun prepareReview() {
        val q = requireNotNull(state.value.saved?.quote)
        val payment = estimate(q); repository.requirePaymentWindow(q)
        check(!hidden) { "Return to this screen and review the saved purchase." }
        mutableReview.value = GemsBuyReview(q, payment.feeLamports.toString())
    }
    fun pay(selected: GemsBuyReview, sender: GemsBuySender) = run {
        check(mutableReview.value === selected && state.value.canPay && !hidden) { "Review the original purchase before paying." }
        mutablePaying.value = true
        try {
            repository.pay(GemsBuySender { bytes, quote, record ->
                // Repository prepares again immediately before wallet handoff. Changed fees need fresh consent.
                if (quote != selected.quote || state.value.feeLamports != selected.feeLamports)
                    throw WalletPaymentException("The network fee changed. Review the original purchase again.", true)
                sender.send(bytes, quote, record)
            })
        } finally {
            mutablePaying.value = false; mutableReview.value = null; repository.dismiss()
        }
    }
    fun check() = run { repository.check() }
    fun abandon() = run { repository.abandon(); mutableReview.value = null }
    fun finish() = run { repository.finish(); mutableReview.value = null; notify("Original Gems credit confirmed.") }
}
