package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.ChatAuthorCard
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the player-card plate shows for the one message whose author was tapped. */
sealed interface ChatCardState {
    data object Loading : ChatCardState
    data class Loaded(val card: ChatAuthorCard) : ChatCardState
    /** One neutral answer for an unknown, removed, expired or blocked message, a server that has no such route
     * yet, a failed read and a response this client cannot read. The contract forbids telling them apart. */
    data object Unavailable : ChatCardState
    /** [untilMs] is on the owner's clock; null when the server named no wait. Never retried by itself. */
    data class RateLimited(val untilMs: Long?) : ChatCardState
}
data class ChatCardView(val messageId: String, val state: ChatCardState)

/** Sanity bound for a wait the server names, so a malformed answer cannot lock cards for a day. Not tuning. */
private const val CHAT_CARD_WAIT_MAX_S = 3_600L
private val chatCardWait = Regex("""try again in ([0-9]{1,6})s\b""")
/** The branch is status + code only. The card bucket's 429 sends no Retry-After header (apps/api chat/routes.ts):
 * its wait exists only as the trailing `<N>s` of the message, so N — never the decision — is read from there. */
internal fun chatCardWaitSeconds(failure: ApiException): Long? =
    (failure.retryAfterSeconds ?: chatCardWait.find(failure.message)?.groupValues?.get(1)?.toLongOrNull())?.coerceIn(1, CHAT_CARD_WAIT_MAX_S)
internal fun chatCardFailure(failure: Exception, nowMs: Long): ChatCardState =
    if (failure is ApiException && failure.status == 429) ChatCardState.RateLimited(chatCardWaitSeconds(failure)?.let { nowMs + it * 1_000 })
    else ChatCardState.Unavailable

/** One open card at a time, owned by the open chat and gone with it: nothing here touches disk.
 * - A card is read only by [open], which the UI calls from an explicit tap; nothing is ever prefetched.
 * - Opening the message that is already loading or shown is not a second GET; a loaded card is reused while
 *   the chat stays open (the card bucket is per wallet and every read spends it, 404s included).
 * - [dismiss], or opening another message, cancels the read in flight.
 * - After a 429 no card is read before the named wait has passed, whichever message is tapped; the plate's
 *   TRY AGAIN is the player's own tap. Failures are not remembered, so a later tap asks again.
 * Main-thread confined, like the Compose state that drives it. */
class ChatAuthorCards(private val scope: CoroutineScope, val now: () -> Long, private val fetch: suspend (String) -> ChatAuthorCard) {
    private val mutable = MutableStateFlow<ChatCardView?>(null)
    val open = mutable.asStateFlow()
    private val loaded = HashMap<String, ChatAuthorCard>()
    private var flight: Job? = null
    private var limitedUntil: Long? = null

    fun open(messageId: String) {
        val showing = mutable.value
        if (showing?.messageId == messageId && (showing.state is ChatCardState.Loading || showing.state is ChatCardState.Loaded)) return
        flight?.cancel(); flight = null
        loaded[messageId]?.let { mutable.value = ChatCardView(messageId, ChatCardState.Loaded(it)); return }
        limitedUntil?.takeIf { it > now() }?.let { mutable.value = ChatCardView(messageId, ChatCardState.RateLimited(it)); return }
        mutable.value = ChatCardView(messageId, ChatCardState.Loading)
        flight = scope.launch {
            val state = try { ChatCardState.Loaded(fetch(messageId)) } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { chatCardFailure(failure, now()) }
            ensureActive()
            if (mutable.value?.messageId != messageId) return@launch
            if (state is ChatCardState.Loaded) loaded[messageId] = state.card
            if (state is ChatCardState.RateLimited) limitedUntil = state.untilMs
            mutable.value = ChatCardView(messageId, state)
        }
    }
    fun dismiss() { flight?.cancel(); flight = null; mutable.value = null }
    /** A message that left the log (redacted, its author blocked, trimmed) takes its card with it. */
    fun retain(messageIds: Set<String>) {
        loaded.keys.retainAll(messageIds)
        if (mutable.value?.let { it.messageId !in messageIds } == true) dismiss()
    }
}
