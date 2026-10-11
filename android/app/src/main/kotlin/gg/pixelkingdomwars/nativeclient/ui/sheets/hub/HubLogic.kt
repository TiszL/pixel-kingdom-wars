package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * The pure rules behind the hub cluster (design/final/hub/SPEC.md), with no Compose: ordering, step counts, what a
 * state draws, input bounds and the few timings the SPEC names that TOKENS.json does not. JVM-tested in HubLogicTest;
 * the composables and the Codex mappers both call these, so the screen and the mapper can never disagree.
 */

/** Timings and alphas the hub SPEC names that are not in TOKENS.json (source: the SPEC section in each comment). */
object HubMotion {
    /** §2.2: pips pop in with a 40 ms stagger. */
    const val PIP_STAGGER = 40
    /** §1 Skeleton: a stepped opacity pulse in 600 ms steps, down to 0.6. */
    const val SKELETON_STEP = 600
    const val SKELETON_LOW_ALPHA = 0.6f
    /** §3.4: after 8 s with no data an in-card loading switches to the error state. */
    const val LOADING_TIMEOUT = 8_000
    /** §3.6: retry is automatic once after 5 s, then manual. */
    const val AUTO_RETRY = 5_000
    /** §3.4: the boot tip rotates every 4 s (cross-fade = TOKENS `REDUCED_CROSSFADE` / `TAB_SWITCH`, 120 ms). */
    const val TIP_ROTATE = 4_000
    /** §3.4: the boot wallpaper cross-fades into the live world in 300 ms. */
    const val WALLPAPER_CROSSFADE = 300
    /** §3.7: maintenance auto-checks every 30 s. */
    const val MAINTENANCE_CHECK_SECONDS = 30
    /** §3.7: the dwarf smith animates 16 frames at 12 fps. */
    const val DWARF_FRAMES = 16
    const val DWARF_FPS = 12
    /** §2.9: a swipe left of more than 30 % of the drawer's width closes it. */
    const val DRAWER_SWIPE_CLOSE = 0.30f
    /** §3.6: kept data under an error stays at 60 %. */
    const val KEPT_ALPHA = 0.60f
    /** §2.3: a DONE quest row draws at 55 %. */
    const val DONE_ALPHA = 0.55f
    /** §2.4: an expired letter's reward tiles draw at 45 %. */
    const val EXPIRED_ALPHA = 0.45f
    /** §3.7: a gate dims the parked world by about 70 % (60 % scrim + 25 % ink). */
    const val GATE_DIM = 0.70f
    /** §2.4: the letter card closes 160 ms after a claim lands (TOKENS `PLATE_IN`). */
    const val LETTER_CLOSE_AFTER_CLAIM = PkwTokens.Motion.PLATE_IN
    /** §2.7: the Feedback "Sent" state closes after 900 ms (TOKENS `CELEBRATE`). */
    const val FEEDBACK_SENT_CLOSE = PkwTokens.Motion.CELEBRATE
    /** §2.9: the chat peek holds 4 s (TOKENS `TOAST_HOLD`). */
    const val PEEK_HOLD = PkwTokens.Motion.TOAST_HOLD
}

// ---- Loading and error (SPEC §3.4, §3.6) ----

/** What a data-dependent block draws. */
enum class BoardView {
    /** Nothing to show yet: Skeleton blocks inside the real shells. */
    SKELETON,
    /** Current data. */
    LIVE,
    /** A refresh is running over data already shown: the last good view stays, the section note says what is loading. */
    REFRESHING,
    /** Kept data labelled "as of …". */
    STALE,
    /** The read failed and data is kept: ErrorRow on top, kept rows at 60 %. */
    ERROR_KEPT,
    /** The read failed with nothing kept: ErrorRow plus an empty-state icon only. */
    ERROR_EMPTY,
}

/** How a block with [hasData] draws under [load]. A card never blanks and never shows a spinner page. */
fun boardView(load: LoadState, hasData: Boolean): BoardView = when (load) {
    LoadState.Loading -> if (hasData) BoardView.REFRESHING else BoardView.SKELETON
    LoadState.Ready -> BoardView.LIVE
    is LoadState.Stale -> if (hasData) BoardView.STALE else BoardView.SKELETON
    is LoadState.Error -> if (hasData) BoardView.ERROR_KEPT else BoardView.ERROR_EMPTY
}

/** The alpha of kept data under [view] (60 % only under an error). */
fun boardAlpha(view: BoardView): Float = if (view == BoardView.ERROR_KEPT) HubMotion.KEPT_ALPHA else 1f

/** True once an in-card loading has waited [timeoutMs] with no data: the mapper switches the card to its error state. */
fun loadingTimedOut(startedAtMs: Long, nowMs: Long, timeoutMs: Int = HubMotion.LOADING_TIMEOUT): Boolean = nowMs - startedAtMs >= timeoutMs

// ---- Profile hub (SPEC §2.1) ----

/** At most four RIGHT NOW rows. */
const val RIGHT_NOW_MAX = 4

/** The RIGHT NOW rows to draw: by priority (claim > collect > auction > builder > quest), stable inside a priority, ≤ 4. */
fun rightNowRows(rows: List<NowRowUi>, max: Int = RIGHT_NOW_MAX): List<NowRowUi> = rows.sortedBy { it.priority.ordinal }.take(max.coerceAtLeast(0))

/** Only the top RIGHT NOW row uses the `ready` look, and only when it is claimable or collectable. */
fun nowRowReady(index: Int, row: NowRowUi): Boolean = index == 0 && row.ready

// ---- Steps and counts ----

/** The Pips cells for [done] of [total]: null (draw none) when either is unknown or [total] ≤ 0, never a fake zero. */
fun pipFills(done: Int?, total: Int?): List<Boolean>? {
    if (done == null || total == null || total <= 0) return null
    val filled = done.coerceIn(0, total)
    return List(total) { it < filled }
}

/** "3/5", with "…" for an unknown side. */
fun fractionText(done: Int?, total: Int?): String = "${done?.toString() ?: UNKNOWN}/${total?.toString() ?: UNKNOWN}"

/** A text field counter: "23/80", or "23" when the server gave no bound. */
fun counterText(length: Int, max: Int?): String = if (max == null) "$length" else "$length/$max"

/** Cuts [text] to the server bound [max] (null = no bound). */
fun clampInput(text: String, max: Int?): String = if (max == null || max < 0) text else text.take(max)

/** "CLAIM n" shows only for a real count above zero (Quests, Mail footers are hidden at n = 0). */
fun claimAllShown(claimAll: ClaimAllUi?): Boolean = claimAll != null && claimAll.count > 0

// ---- Quests (SPEC §2.3) ----

/** Quest rows in draw order: ready to claim, then in progress (and locked), then done; stable inside each group. */
fun orderQuests(rows: List<QuestRowUi>): List<QuestRowUi> = rows.sortedBy {
    when (it.state) {
        QuestState.READY -> 0
        QuestState.GO, QuestState.LOCKED -> 1
        QuestState.DONE -> 2
    }
}

// ---- Mail (SPEC §2.4) ----

const val MAIL_ALL = "ALL"
const val MAIL_REWARDS = "REWARDS"
const val MAIL_NEWS = "NEWS"

/** The Mail filter chips: ALL with its count ("…" while unknown), REWARDS with a gold count badge, NEWS plain. */
fun mailFilterChips(counts: Map<String, Int>): List<FilterChipUi> {
    val all = counts[MAIL_ALL]
    val rewards = counts[MAIL_REWARDS] ?: 0
    return listOf(
        FilterChipUi(MAIL_ALL, "ALL", count = all?.toString() ?: UNKNOWN, description = "All letters, ${all ?: "count unknown"}"),
        FilterChipUi(MAIL_REWARDS, "REWARDS", badge = badgeCount(rewards)?.let { BadgeUi(it, BadgeTone.REWARD, "$rewards rewards to claim") },
            description = if (rewards > 0) "Rewards, $rewards to claim" else "Rewards"),
        FilterChipUi(MAIL_NEWS, "NEWS", description = "News"),
    )
}

/** What a letter's footer offers in each state. */
@Immutable data class LetterControls(
    /** Draw the gold CLAIM (or RETRY after an authoritative refusal). */
    val claim: Boolean,
    /** CLAIM shows stone dots and takes no tap. */
    val claimBusy: Boolean,
    /** The CLAIM label. */
    val claimLabel: String,
    /** ARCHIVE takes taps. */
    val archiveEnabled: Boolean,
    /** The reward tiles' alpha (45 % once expired). */
    val tileAlpha: Float,
    /** The result is uncertain: show the "being checked" line and CHECK AGAIN, never "nothing was spent". */
    val recheck: Boolean,
)

/**
 * A letter's footer by [state] (SPEC §2.4 + design correction 7). An uncertain claim (CHECKING) keeps its recovery
 * action and cannot be archived; only an authoritative refusal (FAILED) offers RETRY.
 */
fun letterControls(state: LetterState, hasRewards: Boolean): LetterControls = when (state) {
    LetterState.READ -> LetterControls(false, false, "CLAIM", archiveEnabled = true, tileAlpha = 1f, recheck = false)
    LetterState.CLAIMABLE -> LetterControls(hasRewards, false, "CLAIM", archiveEnabled = true, tileAlpha = 1f, recheck = false)
    LetterState.CLAIMING -> LetterControls(hasRewards, true, "CLAIM", archiveEnabled = false, tileAlpha = 1f, recheck = false)
    LetterState.CHECKING -> LetterControls(false, false, "CLAIM", archiveEnabled = false, tileAlpha = 1f, recheck = true)
    LetterState.CLAIMED -> LetterControls(false, false, "CLAIM", archiveEnabled = true, tileAlpha = 1f, recheck = false)
    LetterState.EXPIRED -> LetterControls(false, false, "CLAIM", archiveEnabled = true, tileAlpha = HubMotion.EXPIRED_ALPHA, recheck = false)
    LetterState.FAILED -> LetterControls(hasRewards, false, "RETRY", archiveEnabled = true, tileAlpha = 1f, recheck = false)
}

// ---- History (SPEC §2.8) ----

/** A status Tag's look. */
@Immutable data class StatusLook(val label: String, val verb: Verb, val dots: Boolean)

/** History statuses: SENT / DONE / RETURNED moss, HELD stone, PENDING stone with dots, NEEDS_YOU blue OPEN. */
fun historyStatusLook(status: HistoryStatus): StatusLook = when (status) {
    HistoryStatus.SENT -> StatusLook("SENT", Verb.MOSS, false)
    HistoryStatus.DONE -> StatusLook("DONE", Verb.MOSS, false)
    HistoryStatus.RETURNED -> StatusLook("RETURNED", Verb.MOSS, false)
    HistoryStatus.HELD -> StatusLook("HELD", Verb.STONE, false)
    HistoryStatus.PENDING -> StatusLook("PENDING", Verb.STONE, true)
    HistoryStatus.NEEDS_YOU -> StatusLook("OPEN", Verb.BLUE, false)
}

// ---- Leagues (SPEC §2.2) ----

/** Rank medal tones. */
enum class MedalTone { GOLD, SILVER, BRONZE, NONE }

/** 1 gold, 2 silver, 3 bronze; anything else (or unknown) is a plain number. */
fun medalTone(rank: Int?): MedalTone = when (rank) {
    1 -> MedalTone.GOLD
    2 -> MedalTone.SILVER
    3 -> MedalTone.BRONZE
    else -> MedalTone.NONE
}

/** The weekly reward's progress label beside its pips. The server counts RATED ATTACKS (`minRatedAttacks`), never wins,
 *  so neither the label nor what a screen reader hears may call them wins. */
fun ratedAttacksLabel(done: Int?, needed: Int?): String = "ATTACKS ${fractionText(done, needed)}"
fun ratedAttacksSpoken(done: Int?, needed: Int?): String = "Rated attacks ${fractionText(done, needed)}"

// ---- Chat (SPEC §2.9) ----

const val CHAT_WORLD = "WORLD"
const val CHAT_CLAN = "CLAN"

/** Why the CLAN tab is locked while clan chat does not exist: chat is GLOBAL (the WORLD tab). */
const val CLAN_CHAT_LOCKED = "Clan chat is not open yet. Chat is global for now."
/** The paused EmptyState. Chat is GLOBAL, so it never claims that another channel still works. */
const val CHAT_PAUSED_TITLE = "Global chat is paused"
const val CHAT_PAUSED_LINE = "It will be back soon."

/** The drawer's tabs: WORLD, and CLAN locked (padlock; it still calls back so the drawer can say why) while
 *  [ChatUi.clanLockedReason] is set. */
fun chatTabs(ui: ChatUi): List<TabUi> = listOf(CHAT_WORLD to "map", CHAT_CLAN to "itm_banner").map { (id, icon) ->
    val n = ui.unread[id] ?: 0
    TabUi(id, icon, id, badgeCount(n)?.let { BadgeUi(it, BadgeTone.COUNT, "$n unread") }, locked = id == CHAT_CLAN && ui.clanLockedReason != null)
}

/** What replaces the composer: the locked CLAN tab's reason while CLAN is picked, else the server's [ChatUi.blockedReason]. */
fun chatBlockedReason(ui: ChatUi): String? = ui.clanLockedReason?.takeIf { ui.tab == CHAT_CLAN } ?: ui.blockedReason

/**
 * Whether a new message may raise the Home chat peek: never while the drawer is open, never for world chat (even an
 * @mention there), always for clan messages, and for an @mention on any other non-world channel.
 */
fun chatPeekAllowed(channel: String, mentionsMe: Boolean, drawerOpen: Boolean): Boolean =
    !drawerOpen && channel != CHAT_WORLD && (channel == CHAT_CLAN || mentionsMe)

/** True when a drag of [dragPx] (negative = left) on a drawer [widthPx] wide should close it. */
fun drawerSwipeCloses(dragPx: Float, widthPx: Float): Boolean = widthPx > 0f && -dragPx > widthPx * HubMotion.DRAWER_SWIPE_CLOSE

/** Whether SEND takes a tap: allowed, nothing blocking (a locked CLAN tab included), not already sending, a non-blank draft. */
fun chatCanSend(ui: ChatUi): Boolean = ui.canSend && chatBlockedReason(ui) == null && !ui.sending && ui.draft.isNotBlank()

// ---- Feedback (SPEC §2.7) ----

/** A report's unread-replies badge. The server sends only WHETHER a report has an unread reply, never how many, so a
 *  mapper passes null for "unread, count not sent": the badge reads "…" (never an invented count); 0 draws none. */
fun reportUnreadBadge(unread: Int?): BadgeUi? =
    if (unread == null) BadgeUi(UNKNOWN, BadgeTone.COUNT, "Unread replies")
    else badgeCount(unread)?.let { BadgeUi(it, BadgeTone.COUNT, "$unread unread replies") }

/** Close / Back on a draft with text (not yet sent) must ask "Discard this report?" first. */
fun feedbackNeedsDiscardConfirm(title: String, body: String, send: MoneylessSendState): Boolean =
    send != MoneylessSendState.SENT && (title.isNotBlank() || body.isNotBlank())

/** SEND takes a tap only with a category, a title, both within the server's bounds, and nothing in flight or sent. */
fun feedbackCanSend(ui: FeedbackUi): Boolean {
    if (ui.category == null || ui.title.isBlank()) return false
    if (ui.send == MoneylessSendState.SENDING || ui.send == MoneylessSendState.SENT) return false
    val titleOk = ui.bounds.titleMax?.let { ui.title.length <= it } ?: true
    val bodyOk = ui.bounds.bodyMax?.let { ui.body.length <= it } ?: true
    return titleOk && bodyOk
}

// ---- Settings (SPEC §2.6) ----

/** The toggles of [tab] grouped by section, sections in the order they first appear. */
fun toggleSections(toggles: List<ToggleRowUi>, tab: String): List<Pair<String, List<ToggleRowUi>>> =
    toggles.filter { it.tab == tab }.groupBy { it.section }.toList()

// ---- Gates and boot (SPEC §3.4, §3.7) ----

/** Only the optional update can be dismissed (LATER, Back); the required update and maintenance cannot. */
fun gateDismissible(kind: GateKind): Boolean = kind == GateKind.UPDATE_OPTIONAL

/** "auto-check in 0:24" countdown text from whole seconds (never negative). */
fun checkCountdown(seconds: Int): String {
    val s = seconds.coerceAtLeast(0)
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

/** Which boot tip shows [elapsedMs] after the first one (rotates every 4 s); -1 when there are none. */
fun tipIndex(elapsedMs: Long, count: Int, periodMs: Int = HubMotion.TIP_ROTATE): Int =
    if (count <= 0 || periodMs <= 0) -1 else ((elapsedMs.coerceAtLeast(0L) / periodMs) % count).toInt()

/** The frame of a looping sprite strip [elapsedMs] in, at [fps]. */
fun spriteFrame(elapsedMs: Long, frames: Int, fps: Int): Int =
    if (frames <= 0 || fps <= 0) 0 else ((elapsedMs.coerceAtLeast(0L) * fps / 1000L) % frames).toInt()
