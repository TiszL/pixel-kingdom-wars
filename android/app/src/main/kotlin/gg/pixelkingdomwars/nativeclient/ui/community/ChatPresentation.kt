package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.data.ChatCardState
import gg.pixelkingdomwars.nativeclient.model.ChatAuthorCard
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Source chat/protocol.ts: this is composer feedback; the server still validates text and recipients. */
internal data class ChatDraftMeasure(val text: String, val graphemes: Int, val bytes: Int, val lines: Int, val valid: Boolean)
internal fun chatDraftMeasure(raw: String, bounds: ChatBounds?, countGraphemes: (String) -> Int): ChatDraftMeasure {
    val text = raw.replace("\r\n", "\n").replace('\r', '\n')
    val count = countGraphemes(text)
    val bytes = text.toByteArray(Charsets.UTF_8).size
    val lines = text.split('\n').size
    return ChatDraftMeasure(text, count, bytes, lines, bounds != null && text.isNotBlank() && count <= bounds.maxGraphemes && bytes <= bounds.maxUtf8Bytes && lines <= bounds.maxLines)
}
/** Compose TextFieldValue offsets, like the source textarea, are UTF-16. This only inserts display text. */
internal fun insertChatMention(text: String, start: Int, end: Int, name: String): Pair<String, Int> {
    val from = minOf(start, end).coerceIn(0, text.length)
    val to = maxOf(start, end).coerceIn(from, text.length)
    val prefix = text.substring(0, from)
    val insertion = (if (prefix.isNotEmpty() && !prefix.last().isWhitespace()) " " else "") + "@$name "
    return (prefix + insertion + text.substring(to)) to (from + insertion.length)
}
internal fun chatInitials(name: String): String = name.trim().codePoints().limit(2).toArray().let { if (it.isEmpty()) "?" else buildString { it.forEach { code -> appendCodePoint(code) } }.uppercase(Locale.getDefault()) }
internal fun chatClock(raw: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    runCatching { DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).withZone(zone).format(Instant.parse(raw)) }.getOrDefault("")
/** Older history and redactions must not create a NEW badge; decimal IDs remain lossless. */
internal fun chatArrivals(after: String?, ids: List<String>): Set<String> = if (after == null) emptySet() else ids.filter { it.toBigInteger() > after.toBigInteger() }.toSet()

// ---- 0.5.5 chat rework (owner: "chatbox is not convenient to use"). Everything below is presentation only:
// no limit, cadence or moderation rule lives here; the catalogue and the server still own those.

/** One row of the log. [head] starts a run: it carries the avatar, name and time; the rest of the run is text only. */
internal data class ChatRow(val message: ChatMessage, val head: Boolean, val own: Boolean)
/** Layout rhythm, not tuning: a pause this long starts a new run so its time is shown again. */
internal const val CHAT_GROUP_WINDOW_MS = 5 * 60_000L
/** Public chat exposes no author key, so a run is the same display identity on the same side of the
 * viewer-relative permission (own messages are the ones that cannot be blocked) without a long pause. */
internal fun chatRows(messages: List<ChatMessage>, windowMs: Long = CHAT_GROUP_WINDOW_MS): List<ChatRow> {
    var previous: ChatMessage? = null
    return messages.map { message ->
        val before = previous; previous = message
        val head = before == null || before.author != message.author || before.canBlock != message.canBlock ||
            Instant.parse(message.createdAt).toEpochMilli() - Instant.parse(before.createdAt).toEpochMilli() !in 0..windowMs
        ChatRow(message, head, own = !message.canBlock)
    }
}
/** Today is a bare clock; an older run says which day instead of pretending it was today. */
internal fun chatStamp(raw: String, now: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String = runCatching {
    val at = Instant.parse(raw)
    if (at.atZone(zone).toLocalDate() == now.atZone(zone).toLocalDate()) chatClock(raw, zone, locale)
    else DateTimeFormatter.ofPattern("d MMM", locale).withZone(zone).format(at).uppercase(locale)
}.getOrDefault("")

/** Hint only, never a gate: the server's validator stays the judge of links and markup (apps/api chat/service.ts
 * likelyUrl + markup). A false positive here must not stop a legitimate message, so SEND ignores it. */
private val chatLinkHint = Regex("""(?:\b(?:https?|ftp)://|\bwww\.|(?:[\p{L}\p{N}][\p{L}\p{N}-]{0,62}\.)+\p{L}{2,63}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b)""", RegexOption.IGNORE_CASE)
private val chatMarkupHint = Regex("""<[^>]*>|\[[^\]]*]\([^)]*\)|`|\*\*|__""")
internal fun chatLooksLinked(text: String) = chatLinkHint.containsMatchIn(text) || chatMarkupHint.containsMatchIn(text)

/** The counter used to own a permanent row under the field. It now speaks only when the player needs it:
 * close to the catalogue limit, over a limit, or when the text looks like a link / markup. */
internal data class ChatCounter(val text: String, val warning: Boolean)
internal const val CHAT_COUNTER_NEAR = 40
internal fun chatCounter(measure: ChatDraftMeasure, bounds: ChatBounds?, near: Int = CHAT_COUNTER_NEAR): ChatCounter? {
    if (bounds == null || measure.text.isBlank()) return null
    val parts = mutableListOf<String>()
    val overLength = measure.graphemes > bounds.maxGraphemes
    val overLines = measure.lines > bounds.maxLines
    val overBytes = !overLength && measure.bytes > bounds.maxUtf8Bytes
    if (overLength || bounds.maxGraphemes - measure.graphemes <= near) parts += "${measure.graphemes}/${bounds.maxGraphemes}"
    if (overLines) parts += "${measure.lines}/${bounds.maxLines} LINES"
    if (overBytes) parts += "MESSAGE TOO LARGE"
    val linked = chatLooksLinked(measure.text)
    if (linked) parts += "NO LINKS OR MARKUP"
    return if (parts.isEmpty()) null else ChatCounter(parts.joinToString(" · "), overLength || overLines || overBytes || linked)
}

/** Why the composer is closed, in one line, with the one thing that fixes it. Busy is never a reason: a field
 * that follows `busy` loses focus, the keyboard and the characters typed meanwhile (feedback form, 921871b). */
internal enum class ChatUnlock { PROFILE, LAND }
internal data class ChatLock(val line: String, val unlock: ChatUnlock?)
internal fun chatLock(status: ChatStatus?, limitsKnown: Boolean, mutedUntil: (String) -> String): ChatLock? = when {
    !limitsKnown -> ChatLock("CHAT LIMITS UNAVAILABLE — UPDATE GAME CONTENT", null)
    status == null || status.canSend -> null
    status.sendBlockedReason == "USERNAME_REQUIRED" -> ChatLock("SET A USERNAME TO CHAT", ChatUnlock.PROFILE)
    status.sendBlockedReason == "DEED_REQUIRED" -> ChatLock("A DEED IS REQUIRED TO CHAT", ChatUnlock.LAND)
    status.sendBlockedReason == "MUTED" -> ChatLock(status.mutedUntil?.let { "MUTED UNTIL ${mutedUntil(it)}" } ?: "CHAT MUTED", null)
    else -> ChatLock("CHAT IS READ ONLY", null)
}
/** SEND (button and keyboard action). `sending` is this composer's own flight, not the repository's busy:
 * a poll in flight must not grey the button out several times a minute. `pendingSaved` means the saved outbox has
 * no free slot (dead-end audit 2026-10-06, shape B): one unconfirmed message no longer holds SEND. */
internal fun chatCanSend(status: ChatStatus?, limitsKnown: Boolean, pendingSaved: Boolean, sending: Boolean, measure: ChatDraftMeasure) =
    limitsKnown && status?.canSend == true && !pendingSaved && !sending && measure.valid

/** What is left in the field after a send. A failure never reaches this: the draft is simply kept. Text typed
 * while the send was in flight survives; only the part that was delivered is removed. */
internal fun chatDraftAfterSend(current: String, sent: String): String = when {
    current == sent -> ""
    current.startsWith(sent) -> current.substring(sent.length).trimStart()
    else -> current
}
internal sealed interface ChatSubmit {
    data class Sent(val draft: String) : ChatSubmit
    data class Failed(val draft: String, val reason: String) : ChatSubmit
}
internal suspend fun chatSubmit(sent: String, draft: () -> String, send: suspend (String) -> Unit): ChatSubmit =
    try { send(sent); ChatSubmit.Sent(chatDraftAfterSend(draft(), sent)) }
    catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
    catch (failure: Exception) { ChatSubmit.Failed(draft(), failure.message ?: "Chat connection interrupted. Refresh to check.") }

/** Follow-the-latest decision for one new message list. The player stays pinned to the newest message while
 * already there, when their own message lands, and on first load; scrolled up or holding a selected message,
 * arrivals only count into the NEW MESSAGES chip. Older pages and redactions are never arrivals ([chatArrivals]). */
internal data class ChatFollow(val tail: String?, val unseen: Set<String>, val scrollToLatest: Boolean)
internal fun chatFollow(tail: String?, rows: List<ChatRow>, following: Boolean, unseen: Set<String>, listVisible: Boolean, holding: Boolean = false): ChatFollow {
    val ids = rows.map { it.message.id }
    val arrivals = chatArrivals(tail, ids)
    val newest = ids.lastOrNull()
    val first = tail == null && newest != null
    val nextTail = if (newest != null && (tail == null || newest.toBigInteger() > tail.toBigInteger())) newest else tail
    val ownArrived = rows.any { it.own && it.message.id in arrivals }
    // [holding]: a message is selected. Its REPORT / BLOCK must not slide away under the player's finger because
    // somebody else spoke; arrivals wait in the chip until the actions are put away.
    val scroll = listVisible && ids.isNotEmpty() && (first || ownArrived || following && !holding)
    val strangers = rows.filter { !it.own && it.message.id in arrivals }.map { it.message.id }
    return ChatFollow(nextTail, if (scroll) emptySet() else (unseen + strangers).intersect(ids.toSet()), scroll)
}
internal fun chatNewLabel(count: Int) = if (count == 1) "1 NEW MESSAGE ↓" else "$count NEW MESSAGES ↓"

/** REPORT / BLOCK used to sit under every message and cost the log half its height. They now belong to the one
 * message the player tapped. Every capability is still here, behind the same confirmations. */
internal enum class ChatMessageAction { MENTION, PROFILE, COPY, REPORT, BLOCK }
/** PROFILE is on every message: a grouped line shows no avatar or name to tap, and a compact landscape line
 * writes its name inside the text. A player may open their own card. */
internal fun chatMessageActions(row: ChatRow, canMention: Boolean): List<ChatMessageAction> = buildList {
    if (!row.own && canMention) add(ChatMessageAction.MENTION)
    add(ChatMessageAction.PROFILE); add(ChatMessageAction.COPY); add(ChatMessageAction.REPORT)
    if (row.message.canBlock) add(ChatMessageAction.BLOCK)
}
/** Tapping the selected message again puts its actions away; a message that left the log takes them with it. */
internal fun chatSelect(selected: String?, tapped: String): String? = tapped.takeIf { it != selected }
internal fun chatSelectionIn(selected: String?, rows: List<ChatRow>): String? = selected?.takeIf { id -> rows.any { it.message.id == id } }

/** REPORT files ONE message (the wire is /chat/messages/:id/report), also when it was pressed on a player's card —
 * and a card opened from an avatar or a name is always bound to the HEAD line of a run, the only line that has them.
 * So the dialog says whose words and which words are about to go to moderators: a report from the card cannot
 * silently file an innocuous head line instead of the abusive one under it, and a neighbouring-line mis-tap in the
 * dense log is seen before one of the day's reports is spent. Line breaks are flattened so the two quoted lines
 * show the most text. */
internal data class ChatReportPrompt(val author: String, val quote: String)
internal fun chatReportPrompt(message: ChatMessage) = ChatReportPrompt(message.author.name, "“" + message.text.trim().replace(Regex("""\s*\n\s*"""), " ") + "”")
internal const val CHAT_REPORT_OTHER_HINT = "Not this one? Go back and tap the message you mean."

/** REPORT and BLOCK were on screen under every message; behind a tap they need to be findable. The log says so
 * under its newest message until the player has opened a message's actions once. Nothing to say in an empty log
 * or one that holds only the viewer's own messages, and a short typing frame keeps its few rows for messages. */
internal const val CHAT_ACTIONS_HINT = "TAP A MESSAGE TO REPORT OR BLOCK"
internal fun chatActionsHint(rows: List<ChatRow>, usedActions: Boolean, shortFrame: Boolean): String? =
    CHAT_ACTIONS_HINT.takeIf { !usedActions && !shortFrame && rows.any { !it.own } }

/** The one-row saved-message recovery: a multi-line message must not hide everything after its first line break. */
internal fun chatInterruptedLine(text: String) = "INTERRUPTED: " + text.replace('\n', ' ')
internal const val CHAT_RECOVERY_HINT = "TAP IT TO RETRY — NEW MESSAGES STILL SEND"

// ---- player card (owner 2026-09-18: "when you click on a player inside chat it should show profile info — how many
// bases the player has and the highest level keep base, such things, but do not overdo it").

/** What a player can do about the author from their card: exactly that message's own MENTION / REPORT / BLOCK,
 * behind the same confirmations. The viewer's own card is facts only. */
internal fun chatCardActions(row: ChatRow, canMention: Boolean): List<ChatMessageAction> =
    if (row.own) emptyList() else chatMessageActions(row, canMention).filter { it == ChatMessageAction.MENTION || it == ChatMessageAction.REPORT || it == ChatMessageAction.BLOCK }

/** The whole card: three facts and nothing else. A null [value] is a fact still loading; an empty one is a
 * line that says everything by itself. Numbers are the server's, shown as sent. */
internal data class ChatCardFact(val label: String, val value: String?)
internal fun chatCardFacts(card: ChatAuthorCard?, number: (Int) -> String = Int::toString): List<ChatCardFact> = listOf(
    when { card == null -> ChatCardFact("KINGDOMS", null); card.bases == 0 -> ChatCardFact("NO KINGDOM YET", ""); else -> ChatCardFact("KINGDOMS", number(card.bases)) },
    ChatCardFact("HIGHEST KEEP", card?.let { it.highestKeepLevel?.let { level -> "LEVEL $level" } ?: "—" }),
    ChatCardFact("TROPHIES", card?.let { number(it.trophies) }))
internal fun chatCardClan(card: ChatAuthorCard): String? = card.clan?.let { "[${it.tag}] ${it.name}" }
internal const val CHAT_CARD_UNAVAILABLE = "PROFILE UNAVAILABLE"
/** The line under a rate-limited card; null once the named wait has passed and TRY AGAIN takes its place. */
internal fun chatCardWaitLine(untilMs: Long?, nowMs: Long): String? = when {
    untilMs == null -> "TRY AGAIN LATER"
    untilMs <= nowMs -> null
    else -> "TRY AGAIN IN ${(untilMs - nowMs + 999) / 1_000}s"
}
/** Everything the plate draws under the name row, decided here so a test can hold it. [facts] while the card is
 * being read or was read; otherwise one [note] line, with [retry] once a named wait has passed. [actions] are the
 * message's own and need nothing from the card response, so they are offered in EVERY state: the route is absent in
 * production today and every card there ends Unavailable. A player who tapped someone to report or block them must
 * not watch REPORT / BLOCK vanish under the finger into a dead end (58e2776: report and block are findable). */
internal data class ChatCardBody(val facts: List<ChatCardFact>?, val note: String?, val retry: Boolean, val actions: List<ChatMessageAction>)
internal fun chatCardBody(state: ChatCardState, row: ChatRow, canMention: Boolean, nowMs: Long, number: (Int) -> String = Int::toString): ChatCardBody {
    val actions = chatCardActions(row, canMention)
    return when (state) {
        ChatCardState.Loading -> ChatCardBody(chatCardFacts(null, number), null, false, actions)
        is ChatCardState.Loaded -> ChatCardBody(chatCardFacts(state.card, number), null, false, actions)
        ChatCardState.Unavailable -> ChatCardBody(null, CHAT_CARD_UNAVAILABLE, false, actions)
        is ChatCardState.RateLimited -> chatCardWaitLine(state.untilMs, nowMs).let { ChatCardBody(null, it ?: "TRY AGAIN", it == null, actions) }
    }
}
/** Shorter than this, the frame (a landscape phone with the keyboard up is ~150dp) cannot hold the plate: opening
 * a card puts the keyboard away and the chat returns to its reading frame. Taller frames keep the keyboard. */
internal const val CHAT_CARD_MIN_FRAME_DP = 300f
internal fun chatCardClosesKeyboard(frameHeightDp: Float) = frameHeightDp.isFinite() && frameHeightDp < CHAT_CARD_MIN_FRAME_DP
