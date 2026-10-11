package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.CommunityRepository
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.model.MailPage
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.home.hudMineFraction
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.HomeCommunityReads
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MAIL_ALL
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MailActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MailSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_ARCHIVE
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_BATCH_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_BUSY
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_HUB_FILTERS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_KINGDOMS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_QUESTS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_SAVED_CLAIM
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MailFailure
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveMailHubUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.mailRetryAllowed
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.mailRewardTiles
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/*
 * The designed Mail sheet (design/final/hub SPEC §2.4, §3.5: mail.png, mail-open.png, mail-empty.png) over the existing
 * CommunityRepository, which stays the only claim owner (MAIL-HANDOFF: its MoneyOp journal keys a claim by the letter
 * UUID, keeps the saved destination through uncertainty and recovers by GET). Every list read, MORE, letter open,
 * mark-read, archive, claim, check and retry goes through the shared HomeCommunityReads queue, and only the response
 * to this host's own request enters its card.
 */

/** The selection generation keeps A -> B -> A from reviving an old letter's consent; the session is compared by identity. */
internal data class MailScope(val session: Any, val baseId: String?, val generation: Long)

internal fun mailScopeCurrent(expected: MailScope, actual: MailScope?): Boolean =
    actual != null && expected.session === actual.session && expected.baseId == actual.baseId &&
        expected.generation == actual.generation

internal const val MAIL_HOLD = "Mail is paused while another action finishes."
internal const val MAIL_OWNER_CHANGED = "Your kingdom changed. Open Mail again."

/** What a step did, for [mailAccept]: only a claim, check or retry may carry the server's claim notice. */
internal enum class MailOp { LIST, LETTER, CLAIM }

/** The one claim consent: the exact letter shown and the destination it named. */
internal data class MailClaimReview(val owner: MailScope, val message: MailMessage, val baseId: String?)

/** SHARDS and items go to the owner's selected deed; a KEEP-only reward names no destination at all. */
internal fun mailClaimReview(owner: MailScope, shown: MailMessage): MailClaimReview =
    MailClaimReview(owner, shown, owner.baseId.takeIf { shown.needsBase })

/**
 * Why a reviewed claim may not be sent now, or null. [opened] is the letter the player reviewed, [live] the repository's
 * detail at this moment: a retained callback cannot claim a changed letter or reward, for a changed owner, during a busy
 * or held read, while a saved claim waits ([reviewReason]) or without the deed a SHARDS or item reward needs.
 */
internal fun mailClaimUnavailable(scope: MailScope, current: MailScope?, opened: MailMessage, live: MailMessage?,
    busy: Boolean, readHold: Boolean, reviewReason: String?): String? = when {
    !mailScopeCurrent(scope, current) -> MAIL_OWNER_CHANGED
    busy -> MAIL_BUSY
    readHold -> MAIL_HOLD
    reviewReason != null -> reviewReason
    live == null || live != opened -> "This letter changed. Open it again before claiming."
    opened.rewardState != "pending" -> "This letter has no reward waiting."
    opened.needsBase && scope.baseId == null -> "Select a Land Deed first."
    else -> null
}

/** RETRY resends the saved claim only: the same letter, no receipt yet, and its saved destination still selected. */
internal fun mailRetryUnavailable(mailId: String, saved: PendingIntent?, selectedBaseId: String?): String? = when {
    saved == null || saved.idempotencyKey != mailId -> "This saved claim changed. Tap CHECK AGAIN."
    saved.receipt != null -> "The server already accepted this claim. Tap CHECK AGAIN to finish it."
    !mailRetryAllowed(saved, selectedBaseId) -> "Select base ${saved.baseId} again to retry this claim."
    else -> null
}

/** Mail opens exactly two doors; anything else is explained, never silently dropped. */
internal fun mailDoor(feature: FeatureId): FeatureId? = feature.takeIf { it == MAIL_QUESTS || it == MAIL_KINGDOMS }

/** Another owner may have replaced the shared page while this request waited: read page one again rather than append
 *  an old cursor to a different list. */
internal fun mailMoreRefreshes(shared: CommunityState, shown: MailPage?, archived: Boolean): Boolean =
    shared.archived != archived || shared.mailbox != shown

/** Only the response to this host's own request may enter its card, never a later repository publication. */
internal suspend fun readCurrentMail(requireCurrent: () -> Unit, read: suspend () -> CommunityState): CommunityState {
    requireCurrent()
    val observed = read()
    requireCurrent()
    return observed
}

/**
 * The card's next accepted snapshot after one of its own requests. [page] is the list this request itself read (null
 * when it read none): a mark-read, archive or claim clears the shared page, and the card then keeps its last page of
 * the same list rather than blanking it. A detail is kept only for the letter this card opened. The saved claim is the
 * repository's end-of-request truth; a claim notice is taken only from a claim, check or retry.
 */
internal fun mailAccept(previous: CommunityState?, observed: CommunityState, page: MailPage?, archived: Boolean,
    openId: String?, op: MailOp): CommunityState = CommunityState(
    mailbox = page ?: previous?.takeIf { it.archived == archived }?.mailbox,
    archived = archived,
    status = observed.status ?: previous?.status,
    detail = observed.detail?.takeIf { it.id == openId } ?: previous?.detail?.takeIf { it.id == openId },
    pendingClaim = observed.pendingClaim,
    claimNotice = if (op == MailOp.CLAIM) observed.claimNotice else previous?.claimNotice,
    serverUnknownClaimKey = observed.serverUnknownClaimKey,
)

/**
 * The list this step itself read, or null. A LIST step always ends in a list read or throws. The repository's StateFlow
 * keeps the old object when the server answers with an unchanged list (an equal state is not published again), so for a
 * LIST an identical page is still this step's own read: the Home resume prefetch had already read the same letters, and
 * an identity test turned every re-list of an unchanged inbox into "Mail could not be read" (owner's Seeker, 2026-10-06).
 * Identity still decides for open, archive and claim, which may read no list at all.
 */
internal fun mailReadPage(op: MailOp, before: MailPage?, observed: CommunityState, archived: Boolean): MailPage? =
    observed.mailbox?.takeIf { (op == MailOp.LIST || it !== before) && observed.archived == archived }

/** The claim confirmation shows the frozen destination and the exact attached amounts. */
internal fun mailClaimConfirmUi(review: MailClaimReview, catalogue: JsonObject?): ConfirmUi {
    val keepToo = review.baseId != null && review.message.attachments.any { it.kind == "KEEP" }
    val line = if (review.baseId != null) "SHARDS and items go to base ${review.baseId}." else "KEEP goes to your wallet's in-game balance."
    val rewards = mailRewardTiles(review.message, catalogue).joinToString(" · ") { it.description }
    return ConfirmUi("CLAIM THIS REWARD?", null, null, line,
        listOfNotNull(rewards, "KEEP goes to your wallet's in-game balance.".takeIf { keepToo }).joinToString(". "),
        "CLAIM", tone = Verb.GOLD)
}

/** After an acknowledged change the shared page is cleared; read the list again (GET). A failed read keeps the shown list. */
private suspend fun relistMail(repository: CommunityRepository, archived: Boolean): String? = try {
    repository.refreshMail(archived); null
} catch (cancelled: CancellationException) { throw cancelled }
catch (_: Exception) { "Mail could not be refreshed. The last list is still shown." }

/** The card's read: the saved claim is checked first (a GET, as the old screen did on start), then the chosen list. A
 *  failed check never hides the list; it is reported. */
internal suspend fun readMailList(repository: CommunityRepository, archived: Boolean, requireCurrent: () -> Unit): String? {
    val check = try { repository.checkClaim(); null } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { "The saved claim could not be checked. Tap CHECK AGAIN." }
    requireCurrent()
    repository.refreshMail(archived)
    return check
}

internal suspend fun moreMailLetters(repository: CommunityRepository, shown: MailPage?, archived: Boolean) {
    if (shown?.nextCursor == null) return
    if (mailMoreRefreshes(repository.state.value, shown, archived)) repository.refreshMail(archived) else repository.moreMail()
}

/** Opening is a GET; the one explicit mark-read POST follows only for that exact unread letter and is never repeated on
 *  its own. Returns what the player must be told, or null. */
internal suspend fun openMailLetter(repository: CommunityRepository, id: String, archived: Boolean, requireCurrent: () -> Unit): String? {
    repository.openMail(id)
    requireCurrent()
    val opened = repository.state.value.detail?.takeIf { it.id == id } ?: error("This letter could not be opened. Try again.")
    if (opened.readAt != null) return null
    try { repository.markRead() } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { return "This letter could not be marked read. Nothing else changed." }
    requireCurrent()
    return relistMail(repository, archived)
}

/** The confirmed claim: rechecked against the live detail inside the queue, then sent through the existing claim owner. */
internal suspend fun claimMailLetter(repository: CommunityRepository, review: MailClaimReview, archived: Boolean,
    unavailable: (MailMessage?) -> String?, requireCurrent: () -> Unit): String? {
    unavailable(repository.state.value.detail)?.let { error(it) }
    repository.claim(review.message.id, review.baseId)
    requireCurrent()
    return relistMail(repository, archived)
}

internal suspend fun archiveMailLetter(repository: CommunityRepository, id: String, archived: Boolean, requireCurrent: () -> Unit): String? {
    check(repository.state.value.detail?.id == id) { "This letter changed. Open it again before archiving." }
    repository.archive()
    requireCurrent()
    return relistMail(repository, archived)
}

/** CHECK AGAIN is a GET through the claim owner; the list is read again only when the check settled the claim. */
internal suspend fun checkMailClaim(repository: CommunityRepository, archived: Boolean, requireCurrent: () -> Unit): String? {
    repository.checkClaim()
    requireCurrent()
    return if (repository.state.value.mailbox == null) relistMail(repository, archived) else null
}

internal suspend fun retryMailClaim(repository: CommunityRepository, mailId: String, selectedBaseId: String?, archived: Boolean,
    requireCurrent: () -> Unit): String? {
    mailRetryUnavailable(mailId, repository.state.value.pendingClaim, selectedBaseId)?.let { error(it) }
    repository.retryClaim()
    requireCurrent()
    return relistMail(repository, archived)
}

/** CLOSE (owner 2026-10-06) is the claim owner's own closure: one more GET of the letter, then the saved claim is forgotten
 *  on this device only if its reward is still pending; nothing is sent. Its observation is told like the herald's. */
internal suspend fun closeMailClaim(repository: CommunityRepository, archived: Boolean, requireCurrent: () -> Unit): String? {
    val result = repository.closeClaim()
    requireCurrent()
    val relisted = if (repository.state.value.mailbox == null) relistMail(repository, archived) else null
    return relisted ?: Copy.observation(result)
}

private fun mailClock(): String =
    DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.now())

/**
 * The designed Mail sheet for the Home sheet host ([hosted]) and for MailRoute and the MAIL deep link. [onFeature] only
 * ever receives `hud.quests` (SEE QUESTS) and `profile.kingdoms` (CHANGE, Select a Land Deed). [reads] is the Home
 * queue; without it the card uses its own queue into the same repository.
 */
@Composable internal fun MailHub(
    graph: AppGraph,
    session: SessionGraph,
    onClose: () -> Unit,
    onFeature: (FeatureId) -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(),
    hosted: Boolean = false,
    selectedFilter: String? = null,
    onFilter: ((String) -> Unit)? = null,
    canRead: () -> Boolean = { true },
    onReport: () -> Unit = {},
    reads: HomeCommunityReads? = null,
    explain: (String) -> Unit = { Toasts.post(it) },
) {
    val account by graph.account.state.collectAsState()
    val owner = remember(session, account.selectedBaseId, account.baseSelectionGeneration) {
        MailScope(session.session, account.selectedBaseId, account.baseSelectionGeneration)
    }
    // A new owner is a new card: an unsent claim review, an open letter and a kept list never cross a deed switch.
    key(owner) {
        MailHubContent(graph, session, owner, onClose, onFeature, modifier, hosted, selectedFilter, onFilter,
            canRead, onReport, reads, explain)
    }
}

@Composable private fun MailHubContent(
    graph: AppGraph, session: SessionGraph, owner: MailScope, onClose: () -> Unit, onFeature: (FeatureId) -> Unit,
    modifier: Modifier, hosted: Boolean, selectedFilter: String?, onFilter: ((String) -> Unit)?,
    canRead: () -> Boolean, onReport: () -> Unit, reads: HomeCommunityReads?, explain: (String) -> Unit,
) {
    val content by graph.content.state.collectAsState()
    val base by session.base.state.collectAsState()
    // Standalone (MailRoute, MAIL deep link) the card queues its own requests into the same repository.
    val ownQueue = remember(session) { HomeCommunityReads(session.community) }
    val queue = reads ?: ownQueue
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latestCanRead by rememberUpdatedState(canRead)
    val latestExplain by rememberUpdatedState(explain)
    val scope = rememberCoroutineScope()
    var localFilter by rememberSaveable { mutableStateOf(MAIL_ALL) }
    val filter = selectedFilter?.takeIf { it in MAIL_HUB_FILTERS } ?: localFilter
    val wantArchive = filter == MAIL_ARCHIVE
    var accepted by remember { mutableStateOf<CommunityState?>(null) }
    var acceptedAt by remember { mutableStateOf<String?>(null) }
    var load by remember { mutableStateOf<LoadState>(LoadState.Loading) }
    var inFlight by remember { mutableIntStateOf(0) }
    var refresh by remember { mutableIntStateOf(0) }
    var openId by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<MailClaimReview?>(null) }
    var claimingId by remember { mutableStateOf<String?>(null) }
    var claimedNowId by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<MailFailure?>(null) }
    val now = displayClock()

    fun current(): MailScope? {
        val live = graph.account.state.value
        if (graph.sessionGraph.value !== session || graph.holder.current !== session.session || live.session !== session.session) return null
        return MailScope(session.session, live.selectedBaseId, live.baseSelectionGeneration)
    }
    fun requireOwner() { if (!mailScopeCurrent(owner, current())) throw CancellationException("Mail owner changed") }
    fun busy(): Boolean = inFlight > 0
    fun shownPage(): MailPage? = accepted?.takeIf { it.archived == wantArchive }?.mailbox
    fun control(action: () -> Unit) {
        val reason = when {
            !mailScopeCurrent(owner, current()) -> MAIL_OWNER_CHANGED
            !latestCanRead() -> MAIL_HOLD
            else -> null
        }
        if (reason != null) latestExplain(reason) else action()
    }

    /** One request through the shared queue. Admission is rechecked after the wait; the owner before and after. */
    fun launchMail(op: MailOp, onDone: (CommunityState) -> Unit = {}, onFailed: (Exception) -> Unit = {},
        block: suspend (CommunityRepository) -> String?) {
        val archived = wantArchive
        if (op == MailOp.LIST) load = LoadState.Loading
        inFlight++
        scope.launch {
            var settled: CommunityState? = null
            try {
                var observed: CommunityState? = null
                var before: MailPage? = null
                var warning: String? = null
                queue.read { repository ->
                    requireOwner()
                    check(latestCanRead()) { MAIL_HOLD }
                    before = repository.state.value.mailbox
                    observed = readCurrentMail(::requireOwner) {
                        try { warning = block(repository) } finally { settled = repository.state.value }
                        repository.state.value
                    }
                }
                requireOwner()
                val result = requireNotNull(observed)
                val page = mailReadPage(op, before, result, archived)
                accepted = mailAccept(accepted, result, page, archived, openId, op)
                if (page != null) { acceptedAt = mailClock(); load = LoadState.Ready }
                else if (op == MailOp.LIST) { load = LoadState.Error("Mail could not be read for this view. Try again.", asOf = acceptedAt) }
                warning?.let { latestExplain(it) }
                onDone(result)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (mailScopeCurrent(owner, current())) {
                    // An interrupted claim leaves its saved intent: the recovery block must appear even when the step failed.
                    settled?.let { end -> accepted = (accepted ?: CommunityState(archived = archived)).copy(pendingClaim = end.pendingClaim,
                        serverUnknownClaimKey = end.serverUnknownClaimKey) }
                    val message = error.message ?: "Connection interrupted. Refresh to check the server."
                    if (op == MailOp.LIST) load = LoadState.Error(message, asOf = acceptedAt) else latestExplain(message)
                    onFailed(error)
                }
            } finally {
                inFlight--
                if (op == MailOp.CLAIM) claimingId = null
            }
        }
    }

    fun closeLetter() {
        openId = null; claimedNowId = null; failure = null; confirm = null
        // Closing never clears a saved claim; it stops a late detail from reopening.
        session.community.closeMail()
    }
    /** Only a claim this player just saw acknowledged (claim, retry or CHECK AGAIN on the open letter) closes the letter. */
    fun claimedNow(id: String?): (CommunityState) -> Unit = { result ->
        if (id != null && openId == id && result.detail?.id == id && result.detail?.rewardState == "claimed") { claimedNowId = id }
    }
    fun openLetter(id: String) = control {
        when {
            busy() -> latestExplain(MAIL_BUSY)
            shownPage()?.messages?.none { it.id == id } != false -> latestExplain("This letter is no longer in the list. Refresh Mail.")
            else -> {
                openId = id; claimedNowId = null; failure = null
                launchMail(MailOp.LETTER, onFailed = { if (openId == id) { openId = null } }) { openMailLetter(it, id, wantArchive, ::requireOwner) }
            }
        }
    }
    fun claimTap(id: String) = control {
        if (busy()) { latestExplain(MAIL_BUSY); return@control }
        val shown = accepted?.detail?.takeIf { it.id == id && openId == id }
        if (shown == null) { latestExplain("Open the letter again before claiming."); return@control }
        val reason = mailClaimUnavailable(owner, current(), shown, session.community.state.value.detail, busy(), !latestCanRead(),
            accepted?.pendingClaim?.let { MAIL_SAVED_CLAIM })
        if (reason != null) latestExplain(reason) else { confirm = mailClaimReview(owner, shown) }
    }
    fun confirmClaim() {
        val review = confirm ?: return
        confirm = null
        val reason = mailClaimUnavailable(review.owner, current(), review.message, session.community.state.value.detail, busy(),
            !latestCanRead(), accepted?.pendingClaim?.let { MAIL_SAVED_CLAIM })
        if (reason != null) { latestExplain(reason); return }
        val id = review.message.id
        claimingId = id; failure = null
        launchMail(MailOp.CLAIM, onDone = claimedNow(id), onFailed = { error ->
            // Only a server refusal that left no saved claim is final for this letter; an uncertain one shows CHECKING.
            if (error is ApiException && accepted?.pendingClaim?.idempotencyKey != id) { failure = MailFailure(id, error.message) }
        }) { repository ->
            claimMailLetter(repository, review, wantArchive, { live ->
                // Inside the queue this request is the admitted one, so its own busy state is not a refusal.
                mailClaimUnavailable(review.owner, current(), review.message, live, false, !latestCanRead(),
                    repository.state.value.pendingClaim?.let { MAIL_SAVED_CLAIM })
            }, ::requireOwner)
        }
    }
    fun archiveTap(id: String) = control {
        val shown = accepted?.detail?.takeIf { it.id == id && openId == id }
        val reason = when {
            shown == null -> "Open the letter again before archiving."
            busy() -> MAIL_BUSY
            accepted?.pendingClaim?.idempotencyKey == id -> "This reward's claim is still being checked. Archive it after CHECK AGAIN settles it."
            shown.archivedAt != null -> "This letter is already archived."
            else -> null
        }
        if (reason != null) latestExplain(reason)
        else launchMail(MailOp.LETTER, onDone = { if (openId == id) closeLetter() }) { archiveMailLetter(it, id, wantArchive, ::requireOwner) }
    }
    fun recheck() = control {
        val saved = accepted?.pendingClaim?.idempotencyKey
        if (busy()) latestExplain(MAIL_BUSY)
        else launchMail(MailOp.CLAIM, onDone = claimedNow(saved)) { checkMailClaim(it, wantArchive, ::requireOwner) }
    }
    fun retryTap(id: String) = control {
        val reason = if (busy()) MAIL_BUSY else mailRetryUnavailable(id, accepted?.pendingClaim, owner.baseId)
        if (reason != null) latestExplain(reason)
        else launchMail(MailOp.CLAIM, onDone = claimedNow(id)) { retryMailClaim(it, id, owner.baseId, wantArchive, ::requireOwner) }
    }
    fun closeClaimTap(id: String) = control {
        val saved = accepted?.pendingClaim
        val reason = when {
            busy() -> MAIL_BUSY
            saved == null || saved.idempotencyKey != id || saved.receipt != null || accepted?.serverUnknownClaimKey != id ->
                "This saved claim changed. Tap CHECK AGAIN."
            else -> null
        }
        if (reason != null) latestExplain(reason)
        else launchMail(MailOp.CLAIM, onDone = claimedNow(id)) { closeMailClaim(it, wantArchive, ::requireOwner) }
    }
    fun more() = control {
        val page = shownPage()
        when {
            busy() -> latestExplain(MAIL_BUSY)
            page?.nextCursor == null -> latestExplain("There are no more letters to load.")
            else -> launchMail(MailOp.LIST) { moreMailLetters(it, page, wantArchive); null }
        }
    }
    fun chooseFilter(id: String) = control {
        if (id !in MAIL_HUB_FILTERS) latestExplain("This Mail filter is not available.")
        else { localFilter = id; onFilter?.invoke(id) }
    }
    fun retryList() = control { if (busy()) latestExplain(MAIL_BUSY) else refresh++ }
    fun door(feature: FeatureId) = control {
        val target = mailDoor(feature)
        if (target == null) latestExplain("This destination is not available from Mail.") else onFeature(target)
    }
    fun changeKingdom() = control {
        val saved = accepted?.pendingClaim?.takeIf { it.idempotencyKey == openId }
        if (saved != null) latestExplain("This saved claim keeps its destination: ${saved.baseId?.let { "base $it" } ?: "your wallet"}.")
        else onFeature(MAIL_KINGDOMS)
    }

    LaunchedEffect(owner, lifecycle, refresh, wantArchive) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            launchMail(MailOp.LIST) { readMailList(it, wantArchive, ::requireOwner) }
            awaitCancellation()
        }
    }

    BackHandlerAt(BackPriority.CONFIRM, enabled = confirm != null) { confirm = null }
    BackHandlerAt(BackPriority.SHEET, enabled = openId != null) { closeLetter() }
    if (!hosted) BackHandlerAt(BackPriority.SCREEN) { onClose() }

    val unavailable = when {
        !mailScopeCurrent(owner, current()) -> MAIL_OWNER_CHANGED
        !latestCanRead() -> MAIL_HOLD
        else -> null
    }
    val listed = accepted?.takeIf { it.archived == wantArchive }
    // The open letter is this card's own detail; until its GET lands, the row the player tapped (same server letter).
    val shownLetter = openId?.let { id -> accepted?.detail?.takeIf { it.id == id } ?: listed?.mailbox?.messages?.firstOrNull { it.id == id } }
    val view = (accepted ?: CommunityState()).copy(mailbox = listed?.mailbox, archived = wantArchive, detail = shownLetter, busy = busy())
    // Readouts as on the Home HUD, only for the owner's own deed (another deed's balance is never shown as this one's).
    val balances = base.balances.takeIf { owner.baseId != null && base.base?.baseId == owner.baseId }
    val gemsOn = balances?.features?.gems?.supported == true
    val readouts = buildList {
        add(ResourceChipUi(HudIds.SHARDS, "shards", compactAmount(balances?.shards), hudMineFraction(base).takeIf { balances != null }, false, null,
            name = "Shards", accent = ResourceAccent.SHARDS, exactDescription = "Shards ${exactAmount(balances?.shards)}"))
        if (gemsOn) add(ResourceChipUi(HudIds.GEMS, "gem", compactAmount(balances?.gems), null, false, null,
            name = "Gems", accent = ResourceAccent.GEMS, exactDescription = "Gems ${exactAmount(balances?.gems)}"))
    }
    val ui = liveMailHubUi(view, filter, load, owner.baseId, now, claimedNowId, unavailable, content.catalogue, claimingId, failure)
        .copy(readouts = readouts)
    Box(modifier) {
        MailSheet(ui, MailActions(
            onFilter = ::chooseFilter,
            onOpen = ::openLetter,
            onClaim = ::claimTap,
            onClaimAll = { latestExplain(MAIL_BATCH_UNAVAILABLE) },
            onArchive = ::archiveTap,
            onChangeKingdom = ::changeKingdom,
            onLoadMore = ::more,
            onClose = onClose,
            onCloseLetter = ::closeLetter,
            onRecheck = { recheck() },
            onGo = { link -> door(link.feature) },
            onEmptyGo = ::door,
            onRetry = ::retryList,
            onReport = { control(onReport) },
            onRetryClaim = ::retryTap,
            onCloseClaim = ::closeClaimTap,
        ), Modifier.fillMaxSize())
        HubConfirmDialog(confirm?.let { mailClaimConfirmUi(it, content.catalogue) }, onConfirm = ::confirmClaim,
            onBack = { confirm = null }, modifier = Modifier.fillMaxSize())
    }
}
