package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.data.SavedChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CHAT_CLAN
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CHAT_WORLD
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatItemUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.CLAN_CHAT_UNAVAILABLE_REASON
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * The designed Chat drawer (hub SPEC §2.9, chat.png) fed from the live global chat (LiveChatRepository). Presentation
 * only: the repository, the catalogue CHAT bounds and the server still own every limit, cadence and moderation rule,
 * and the old composer's rules (ChatPresentation.kt) decide SEND, the lock line and the counter exactly as before.
 *
 * The server has one channel, GLOBAL, drawn as the WORLD tab; CLAN stays locked with its reason. The wire carries no
 * emote, system event or shared place, so the drawer never shows one: an emote tap says so instead.
 */

/** Every author draws this crest: public chat carries no league or clan per author (the card reads those on a tap). */
internal const val CHAT_CREST = "shape:chat"
/** The clan-tag slot names a verified Seeker, which the old log marked with ◈ beside the name. */
internal const val CHAT_SEEKER_TAG = "SEEKER"
/** The saved (interrupted) message is the viewer's own; the outbox keeps no display name. */
internal const val CHAT_OWN_NAME = "You"
internal const val CHAT_PENDING_TIME = "NOT SENT"

internal const val CHAT_ITEM_OLDER = "older"
internal const val CHAT_ITEM_RECOVERY = "recovery"
internal const val CHAT_ITEM_EMPTY = "empty"
internal const val CHAT_ITEM_OFFLINE = "offline"
internal const val CHAT_ITEM_COUNTER = "counter"
/** The newest line of the log, always last while the log has messages. The drawer's list keeps its place by item key,
 *  so a list whose newest line never changes key keeps a reader at the newest end when a message arrives (the old log's
 *  follow-latest), while a reader up in history stays where they are. */
internal const val CHAT_ITEM_TAIL = "tail"

internal const val CHAT_OLDER_LINE = "PULL DOWN FOR EARLIER MESSAGES"
internal const val CHAT_OLDER_LOADING = "LOADING EARLIER MESSAGES…"
internal const val CHAT_TAIL_HINT = "Long-press a message to report, block or mention"
internal const val CHAT_EMPTY_LINE = "NO MESSAGES YET"
internal const val CHAT_LOADING_LINE = "LOADING CHAT…"
internal const val CHAT_PAUSED_STRIP = "GLOBAL CHAT IS TEMPORARILY DISABLED"
internal const val CHAT_EMOTES_CLOSED = "Emotes are not open on this server yet."
internal const val CHAT_PLACES_CLOSED = "Shared places are not open on this server yet."
internal const val CHAT_RETRY_GONE = "That message was already resolved. Check the log."
internal const val CHAT_RETRY_BUSY = "Chat is still finishing a request. Try again in a moment."
internal const val CHAT_RETRY_PAUSED = "Chat is paused. Your message stays saved until it is back."
internal const val CHAT_PENDING_HINT = "Tap your unsent message to retry it."
internal const val CHAT_MESSAGE_GONE = "This message is no longer available"
internal const val CHAT_LAND_CLOSED = "Land is not available from this screen."
internal const val CHAT_DOOR_CLOSED = "This is not available from chat yet."
internal const val CHAT_BLOCKS_LINE = "Their messages are hidden. Unblocking restores future and available recent messages."

/** The blocked strip's two doors (SET USERNAME, GET LAND). The drawer hands the link back; [chatUnlockFor] reads it. */
internal val CHAT_USERNAME_LINK = HubLink(FeatureId("hud.profile"))
internal val CHAT_LAND_LINK = HubLink(FeatureId("profile.land"))

/** The id of the interrupted-message bubble: never a server id, so it can never collide with a message. */
internal fun chatPendingId(saved: SavedChatMessage) = "pending:${saved.clientMessageId}"

/** "Today", or the day of an older run ("14 Sep"): a divider above the first message of each local day. */
internal fun chatDayLabel(date: LocalDate, today: LocalDate, locale: Locale): String =
    if (date == today) "Today" else DateTimeFormatter.ofPattern("d MMM", locale).format(date)

/** One server message as a drawer line. Only server-resolved spans are handles; a recipient id never reaches the client. */
internal fun chatMessageItem(message: ChatMessage, zone: ZoneId, locale: Locale): ChatItemUi.Message = ChatItemUi.Message(
    id = message.id, author = message.author.name, crest = CHAT_CREST,
    tag = CHAT_SEEKER_TAG.takeIf { message.author.seekerVerified },
    time = chatClock(message.createdAt, zone, locale), text = message.text,
    // Own messages are the ones the viewer cannot block (the viewer-relative permission, as the old log used).
    mine = !message.canBlock, mentionsMe = message.mentioned,
    mentionHandle = message.mentions.firstOrNull()?.let { message.text.substring(it.start, it.end) })

/**
 * The drawer from the live state.
 * - [measured] is the draft as the old composer measured it (catalogue bounds); over a bound, SEND is refused and the
 *   counter line says why, as the old counter did.
 * - [sending] is this composer's own flight: it refuses SEND but is never handed to the drawer as [ChatUi.sending],
 *   because the designed field disables itself while sending, and a disabled field drops focus, the keyboard and what
 *   the player typed meanwhile (the rule ChatScreen has kept since 921871b).
 * - [focusHold] is a peeked message the drawer is opening at: while set (and present) the log ends at that message, so
 *   the drawer's list first lays out with it newest; the caller clears it a frame later and the list keeps it in view.
 */
internal fun chatDrawerUi(
    state: ChatState, bounds: ChatBounds?, draft: String, measured: ChatDraftMeasure,
    tab: String = CHAT_WORLD, sending: Boolean = false, offline: String? = null, canGetLand: Boolean = true,
    focusHold: String? = null, loadingOlder: Boolean = false,
    now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault(),
): ChatUi {
    val status = state.status
    val paused = status?.enabled == false
    val lock = if (paused) null else chatLock(status, bounds != null) { chatClock(it, zone, locale) }
    val focusAt = focusHold?.let { id -> state.messages.indexOfFirst { it.id == id } }?.takeIf { it >= 0 }
    val shown = if (focusAt != null) state.messages.subList(0, focusAt + 1) else state.messages
    val today = now.atZone(zone).toLocalDate()
    val channel = if (tab == CHAT_CLAN) CHAT_CLAN else CHAT_WORLD
    // The CLAN tab has no channel behind it: its thread is empty and the locked strip says why (never world lines).
    val items = if (channel == CHAT_CLAN) emptyList<ChatItemUi>() else buildList<ChatItemUi> {
        if (state.before != null) add(ChatItemUi.System(CHAT_ITEM_OLDER, null, if (loadingOlder) CHAT_OLDER_LOADING else CHAT_OLDER_LINE, Verb.STONE))
        var day: LocalDate? = null
        for (message in shown) {
            val date = runCatching { Instant.parse(message.createdAt).atZone(zone).toLocalDate() }.getOrNull()
            if (date != null && date != day) { add(ChatItemUi.Day("day:$date", chatDayLabel(date, today, locale))); day = date }
            add(chatMessageItem(message, zone, locale))
        }
        if (focusAt != null) return@buildList
        // The saved outbox message until the server confirms it: once the log holds it as the viewer's own (same UUID),
        // the next read clears the outbox, so it is never drawn twice.
        val saved = state.pending?.takeIf { pending -> state.messages.none { it.clientMessageId == pending.clientMessageId && !it.canBlock } }
        if (saved != null) {
            add(ChatItemUi.Message(chatPendingId(saved), CHAT_OWN_NAME, CHAT_CREST, null, CHAT_PENDING_TIME, saved.text,
                mine = true, mentionsMe = false, failed = true))
            add(ChatItemUi.System(CHAT_ITEM_RECOVERY, null, CHAT_RECOVERY_HINT, Verb.STONE))
        }
        if (state.messages.isEmpty() && saved == null && !paused) add(ChatItemUi.System(CHAT_ITEM_EMPTY, null,
            // Without catalogue bounds chat never reads (the strip says why), so it is not "loading".
            if (offline == null && bounds != null && (state.busy || status == null)) CHAT_LOADING_LINE else CHAT_EMPTY_LINE, Verb.STONE))
        offline?.let { add(ChatItemUi.System(CHAT_ITEM_OFFLINE, null, it, Verb.RED)) }
        if (lock == null && !paused) chatCounter(measured, bounds)?.let { add(ChatItemUi.System(CHAT_ITEM_COUNTER, null, it.text, if (it.warning) Verb.RED else Verb.STONE)) }
        if (state.messages.isNotEmpty()) add(ChatItemUi.Day(CHAT_ITEM_TAIL, CHAT_TAIL_HINT))
    }
    val unlock = lock?.unlock?.takeIf { it != ChatUnlock.LAND || canGetLand }
    return ChatUi(
        tab = channel,
        // The drawer is the reader: everything in it has been read (opening marks the launcher read).
        unread = mapOf(CHAT_WORLD to 0, CHAT_CLAN to 0),
        items = items, draft = draft,
        canSend = chatCanSend(status, bounds != null, state.outboxFull, sending, measured), // shape B: only a full outbox holds SEND
        blockedReason = if (paused) CHAT_PAUSED_STRIP else lock?.line,
        sending = false,
        blockedAction = when (unlock) { ChatUnlock.PROFILE -> "SET USERNAME"; ChatUnlock.LAND -> "GET LAND"; null -> null },
        blockedLink = when (unlock) { ChatUnlock.PROFILE -> CHAT_USERNAME_LINK; ChatUnlock.LAND -> CHAT_LAND_LINK; null -> null },
        paused = paused,
        emotesOpen = false,
        clanLockedReason = CLAN_CHAT_UNAVAILABLE_REASON,
    )
}

/** Which unlock a blocked-strip door is; null for a link chat does not own (the tap then says so, never nothing). */
internal fun chatUnlockFor(link: HubLink): ChatUnlock? = when (link.feature) {
    CHAT_USERNAME_LINK.feature -> ChatUnlock.PROFILE
    CHAT_LAND_LINK.feature -> ChatUnlock.LAND
    else -> null
}

/** A tap on a failed bubble: null retries the ONE saved message (the outbox's exact text and UUID), otherwise why not
 *  yet. Busy is a reason here, not a queue: a second retry behind the first would find the outbox already cleared. */
internal fun chatRetryRefusal(state: ChatState, itemId: String): String? {
    val saved = state.pending
    return when {
        saved == null || itemId != chatPendingId(saved) -> CHAT_RETRY_GONE
        state.busy -> CHAT_RETRY_BUSY
        state.status?.enabled != true -> CHAT_RETRY_PAUSED
        else -> null
    }
}

/** A long-press: null opens that message's options; otherwise the reason (the unsent bubble retries on a tap instead). */
internal fun chatLongPressRefusal(itemId: String, messages: List<ChatMessage>): String? = when {
    messages.any { it.id == itemId } -> null
    itemId.startsWith("pending:") -> CHAT_PENDING_HINT
    else -> CHAT_MESSAGE_GONE
}

/** A drag past the oldest loaded line asks for the next older page: only while one exists, and one request at a time. */
internal fun chatPullLoadsOlder(availableY: Float, state: ChatState, inFlight: Boolean): Boolean =
    availableY > 0f && state.before != null && !state.busy && !inFlight

/** The face of an option in the long-press sheet: REPORT and BLOCK are the destructive ones, PROFILE opens a card. */
internal fun chatActionVerb(action: ChatMessageAction): Verb = when (action) {
    ChatMessageAction.REPORT, ChatMessageAction.BLOCK -> Verb.RED
    ChatMessageAction.PROFILE -> Verb.BLUE
    ChatMessageAction.MENTION, ChatMessageAction.COPY -> Verb.STONE
}

/** What a screen reader says for an option, the words the old message actions used. */
internal fun chatActionDescription(action: ChatMessageAction, author: String): String = when (action) {
    ChatMessageAction.MENTION -> "Mention $author"; ChatMessageAction.PROFILE -> "Profile of $author"; ChatMessageAction.COPY -> "Copy message text"
    ChatMessageAction.REPORT -> "Report this message"; ChatMessageAction.BLOCK -> "Block $author"
}

/** BLOCK asks first, with the old dialog's words, on the designed destructive confirm (SPEC §3.3: non-money). */
internal fun chatBlockConfirm(author: String) = ConfirmUi(title = "BLOCK $author?", fromIcon = null, toIcon = null,
    line = "Their messages will be hidden from your chat.", subLine = "You can unblock them later.", confirmLabel = "BLOCK")
