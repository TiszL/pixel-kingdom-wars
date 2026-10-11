package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.community.communityDate
import gg.pixelkingdomwars.nativeclient.ui.community.communityItemName
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LetterRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LetterState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LetterUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MAIL_ALL
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MAIL_NEWS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MAIL_REWARDS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MailRecoveryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.MailUi
import java.time.Instant
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/*
 * The designed Mail card (design/final/hub mail.png, mail-open.png, mail-empty.png) from the existing CommunityRepository
 * state. Display only: the MailHub host owns admission and every repository call; the repository stays the only claim
 * owner. Every amount is the server's exact integer, expiry and claim outcome come only from the server's rewardState,
 * and there is no batch claim on this server, so CLAIM ALL is never drawn.
 */

/** The fourth Mail filter: the server's archived list (`refreshMail(true)`). */
internal const val MAIL_ARCHIVE = "ARCHIVE"

/** Every Mail filter a sheet entry may restore. The Home mount uses this set as the Mail sheet's tabs. */
internal val MAIL_HUB_FILTERS: Set<String> = setOf("ALL", "REWARDS", "NEWS", "ARCHIVE")

/** The only two doors Mail opens: the empty inbox's SEE QUESTS and the letter's kingdom choice. */
internal val MAIL_QUESTS = FeatureId("hud.quests")
internal val MAIL_KINGDOMS = FeatureId("profile.kingdoms")

/** Shown where the design draws CLAIM ALL: the server has no batch claim. */
internal const val MAIL_BATCH_UNAVAILABLE = "Open each reward letter to claim."
internal const val MAIL_BUSY = "Mail is busy. Wait for the current request to finish."
internal const val MAIL_SAVED_CLAIM = "Check the saved claim before claiming another reward."

/** A claim the server refused for one letter (no saved claim was left): that letter shows FAILED with the server's words. */
internal data class MailFailure(val mailId: String, val message: String)

/** Only the server's sender picks the art (MailMessage admits `system` and `admin`); a subject never does. */
internal fun mailSenderIcon(sender: String): String = if (sender == "system") "ui_portrait_keep_t1" else "shape:mail"

private fun senderLine(message: MailMessage, nowMillis: Long): String =
    listOfNotNull(message.sender.replaceFirstChar { it.titlecase(Locale.ROOT) }, agoLabel(message.createdAt, nowMillis)).joinToString(" · ")

/** RewardStage tiles with the exact server integers: Shards and KEEP grouped, items "x2" with catalogue art and name. */
internal fun mailRewardTiles(message: MailMessage, catalogue: JsonObject?): List<ItemTileUi> = message.attachments.mapIndexed { index, reward ->
    when (reward.kind) {
        "SHARDS" -> (groupedAmount(reward.amount) ?: UNKNOWN).let { ItemTileUi("reward-$index", "shards", it, "$it Shards") }
        "KEEP" -> (groupedAmount(reward.amount) ?: UNKNOWN).let { ItemTileUi("reward-$index", "keep", it, "$it KEEP") }
        else -> {
            val item = reward.itemId.orEmpty()
            val qty = groupedAmount(reward.qty?.toString()) ?: UNKNOWN
            ItemTileUi("reward-$index", craftItemIcon(item), "x$qty", "${communityItemName(catalogue, item)}, $qty")
        }
    }
}

/** The row's reward pill: the first attachment of a pending reward, exact. A claimed or expired reward draws none. */
private fun mailRewardPill(message: MailMessage, catalogue: JsonObject?): PriceUi? {
    if (message.rewardState != "pending") return null
    val reward = message.attachments.firstOrNull() ?: return null
    fun amount(currency: Currency, name: String) = groupedAmount(reward.amount)?.let {
        PriceUi(currency, it, if (it == "0") PriceStatus.SERVER_ZERO else PriceStatus.OK, description = "$it $name")
    }
    return when (reward.kind) {
        "SHARDS" -> amount(Currency.SHARDS, "Shards")
        "KEEP" -> amount(Currency.KEEP, "KEEP")
        else -> reward.itemId?.let { item ->
            val qty = groupedAmount(reward.qty?.toString()) ?: UNKNOWN
            PriceUi(Currency.ITEM, "x$qty", PriceStatus.OK, icon = craftItemIcon(item), description = "${communityItemName(catalogue, item)}, $qty")
        }
    }
}

/** RETRY resends the same saved claim: only without a receipt, and only for the saved destination (or a KEEP-only claim). */
internal fun mailRetryAllowed(saved: PendingIntent, selectedBaseId: String?): Boolean =
    saved.receipt == null && (saved.baseId == null || saved.baseId == selectedBaseId)

/** The saved claim, reachable whatever letter or page is shown. CHECK AGAIN is always offered; it is a GET. CLOSE only once the
 *  server answered `unknown` for exactly this saved claim ([serverUnknownKey], owner 2026-10-06). */
internal fun mailRecoveryUi(saved: PendingIntent, selectedBaseId: String?, busy: Boolean, serverUnknownKey: String? = null): MailRecoveryUi {
    val closable = saved.receipt == null && saved.idempotencyKey == serverUnknownKey
    val where = saved.baseId?.let { "base $it" } ?: "your wallet's in-game KEEP balance"
    val retry = mailRetryAllowed(saved, selectedBaseId)
    val line = when {
        saved.receipt != null -> "The server accepted a saved claim to $where and your mail is being updated. CHECK AGAIN finishes it."
        retry -> "A claim to $where was interrupted before its result arrived. CHECK AGAIN asks the server; RETRY sends the same claim again."
        else -> "A claim to $where was interrupted before its result arrived. CHECK AGAIN asks the server; RETRY waits until base ${saved.baseId} is selected again."
    }
    return MailRecoveryUi(saved.idempotencyKey, line, retry, busy, closeAllowed = closable,
        observation = if (closable) Copy.observation(Receipt.Absent) else null)
}

private fun mailLetterUi(message: MailMessage, state: CommunityState, selectedBaseId: String?, nowMillis: Long, claimedNowId: String?,
    unavailable: String?, catalogue: JsonObject?, claimingId: String?, failure: MailFailure?): LetterUi {
    val saved = state.pendingClaim?.takeIf { it.idempotencyKey == message.id }
    val otherSaved = state.pendingClaim?.takeIf { it.idempotencyKey != message.id }
    val pending = message.rewardState == "pending"
    val letterState = when (message.rewardState) {
        null -> LetterState.READ
        "claimed" -> LetterState.CLAIMED
        "expired" -> LetterState.EXPIRED
        else -> when {
            saved != null -> LetterState.CHECKING
            claimingId == message.id -> LetterState.CLAIMING
            failure?.mailId == message.id -> LetterState.FAILED
            else -> LetterState.CLAIMABLE
        }
    }
    // A KEEP-only reward has no destination; a claimed one goes where the server says; a saved claim keeps its own base.
    val destination = when {
        !message.needsBase -> null
        message.rewardState == "claimed" -> message.claimBaseId
        !pending -> null
        saved != null -> saved.baseId
        else -> selectedBaseId
    }
    val busy = MAIL_BUSY.takeIf { state.busy }
    // The clock only words the time left; it never turns a server "pending" into an expiry.
    val expiresAt = message.expiresAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val keepToo = message.attachments.any { it.kind == "KEEP" }
    val status = when (message.rewardState) {
        "pending" -> "Expires ${communityDate(message.expiresAt)}"
        "claimed" -> if (message.needsBase) "Claimed ${communityDate(message.claimedAt)} into base ${message.claimBaseId}" +
            (if (keepToo) ". KEEP went to your wallet's in-game balance." else "")
            else "Claimed ${communityDate(message.claimedAt)} into your wallet's in-game KEEP balance."
        else -> null
    }
    return LetterUi(message.id, mailSenderIcon(message.sender), message.subject, senderLine(message, nowMillis), message.body,
        mailRewardTiles(message, catalogue), destination, message.needsBase,
        expiresIn = if (pending && expiresAt != null && expiresAt > nowMillis) fmtDur((expiresAt - nowMillis) / 1000) else null,
        state = letterState,
        expiredLine = if (message.rewardState == "expired") "This reward expired on ${communityDate(message.expiredAt ?: message.expiresAt)}" else null,
        checkingLine = if (saved?.receipt != null) "Accepted by the server. This letter is being updated."
            else "Being checked. Your reward stays in this letter until we know.",
        failureLine = failure?.takeIf { letterState == LetterState.FAILED && it.mailId == message.id }?.message,
        selectDeed = if (pending && message.needsBase && destination == null) HubLink(MAIL_KINGDOMS) else null,
        statusLine = status,
        claimUnavailable = if (!pending) null else unavailable ?: busy ?: when {
            otherSaved != null -> MAIL_SAVED_CLAIM
            message.needsBase && selectedBaseId == null -> "Select a Land Deed first."
            else -> null
        },
        archiveUnavailable = unavailable ?: busy ?: when {
            saved != null -> "This reward's claim is still being checked. Archive it after CHECK AGAIN settles it."
            message.archivedAt != null -> "This letter is already archived."
            else -> null
        },
        closeAfterClaim = message.rewardState == "claimed" && claimedNowId == message.id,
    )
}

/**
 * The Mail card. [state] is the host's accepted snapshot (its own responses only), with `busy` = a host request running
 * and `detail` = the letter the host opened. [selectedBaseId] is the owner's selected deed; [claimedNowId] is the one
 * letter whose claim this player just saw acknowledged (only it closes after the claim); [unavailable] is a read hold or
 * owner change that holds every action with a visible reason.
 */
internal fun liveMailHubUi(
    state: CommunityState,
    filter: String = MAIL_ALL,
    load: LoadState = if (state.mailbox == null) LoadState.Loading else LoadState.Ready,
    selectedBaseId: String? = null,
    nowMillis: Long = System.currentTimeMillis(),
    claimedNowId: String? = null,
    unavailable: String? = null,
    catalogue: JsonObject? = null,
    claimingId: String? = null,
    failure: MailFailure? = null,
): MailUi {
    val archived = state.archived || filter == MAIL_ARCHIVE
    // An inbox page never stands in for the archive (or the reverse) while the other list loads.
    val mailbox = state.mailbox?.takeIf { state.archived == archived }
    val selected = if (archived) MAIL_ARCHIVE else filter.takeIf { it in setOf(MAIL_ALL, MAIL_REWARDS, MAIL_NEWS) } ?: MAIL_ALL
    val messages = mailbox?.messages.orEmpty()
    val letters = messages.filter {
        when (selected) { MAIL_REWARDS -> it.kind == "reward"; MAIL_NEWS -> it.kind == "info"; else -> true }
    }.map { LetterRowUi(it.id, mailSenderIcon(it.sender), it.subject, senderLine(it, nowMillis), it.readAt == null, mailRewardPill(it, catalogue)) }
    // The archive has no inbox counts. pendingRewards is not the REWARDS filter total, so it is a line, not a chip count.
    val status = state.status?.takeIf { !archived }
    val incomplete = mailbox?.nextCursor != null
    val empty = when {
        archived -> EmptyStateUi("shape:mail", "No archived letters", "Letters you archive are kept here.", null, null)
        incomplete -> EmptyStateUi("shape:mail", "No matching letters loaded", "Choose ALL or load more letters to search older mail.", null, null)
        selected == MAIL_ALL -> EmptyStateUi("shape:mail", "No letters yet", "League rewards, event gifts and clan invites arrive here.",
            "SEE QUESTS", MAIL_QUESTS)
        else -> EmptyStateUi("shape:mail", "No matching letters", "No letters match this filter.", null, null)
    }
    val pendingRewards = status?.pendingRewards ?: 0
    return MailUi(selected, status?.let { mapOf(MAIL_ALL to it.total) }.orEmpty(), letters,
        claimAll = null,
        hasMore = incomplete,
        load = if (mailbox == null && load == LoadState.Ready) LoadState.Loading else load,
        empty = empty,
        footnote = null,
        loadingMore = state.busy && mailbox != null,
        statusLine = status?.let { "${it.unread} unread · ${it.pendingRewards} pending reward${if (it.pendingRewards == 1) "" else "s"}" },
        batchUnavailable = MAIL_BATCH_UNAVAILABLE.takeIf { !archived && (pendingRewards > 0 || messages.any { it.rewardState == "pending" }) },
        archived = archived,
        open = state.detail?.let { mailLetterUi(it, state, selectedBaseId, nowMillis, claimedNowId, unavailable, catalogue, claimingId, failure) },
        recovery = state.pendingClaim?.let { mailRecoveryUi(it, selectedBaseId, state.busy, state.serverUnknownClaimKey) },
        notice = listOfNotNull(unavailable, state.claimNotice).distinct().joinToString("\n").ifBlank { null },
        extraChips = listOf(FilterChipUi(MAIL_ARCHIVE, "ARCHIVE", description = "Archived letters")),
    )
}
