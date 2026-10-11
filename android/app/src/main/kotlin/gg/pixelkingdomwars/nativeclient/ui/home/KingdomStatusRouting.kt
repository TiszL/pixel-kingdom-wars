package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import gg.pixelkingdomwars.nativeclient.ui.ScreenNotice
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/*
 * Design component: where the Kingdom's status lines go now that Home keeps its scene clear (home-budget.png: at rest the
 * permanent HUD is the only chrome; DESIGN-SYSTEM §6 Toast "4 s; max 3; the same key merges").
 *
 * KingdomScreen used to stack every status line in a permanent column over the scene (the screen notice, the kingdom
 * read's error and confirmation, the content-update line, the missing-timing line, a progress bar). Routine lines now
 * become one kit toast each, posted once, and the line is then retired with the owner's own dismiss callback, exactly as
 * the old X did. What must stay visible stays where it is (KEEP):
 * - saved payments and receipts (InterruptedBanner, BuilderFinishPending, HeroRecruitmentHistory, WallBatchHistory):
 *   decision 2026-10-06, saved payments must stay visible until the player checks them;
 * - the downloaded content pack's APPLY: it is an action, not a message;
 * - an error while a sheet that prints errors itself is open (the old BuildingSheet, the wall-row quote, builders,
 *   obstacle): the sheet shows it, so it is neither toasted nor retired under the player's eyes. When the sheet closes
 *   and the error is still there it is toasted then, as the old column showed it then.
 */

/** One Kingdom status line's owner. */
internal enum class KingdomStatusSource {
    /** The screen model's notice (`ScreenNotice`): an action's refusal or confirmation. Retired with `dismissNotice`. */
    NOTICE,
    /** The kingdom read's error (`BaseState.error`). Retired with `clearNotice`. */
    HOME_ERROR,
    /** The kingdom's own confirmation (`BaseState.message`: "+200 SHARDS", "QUEST CLAIMED"). Retired with `clearNotice`. */
    HOME_MESSAGE,
    /** The content owner's update line (`KingdomUiState.updateNotice`). Retired with `dismissUpdateNotice`. */
    UPDATE_NOTICE,
    /** The pack's missing-timing line (`CatalogueTimings.compatibilityNotice`): derived, nothing to retire. */
    TIMING_NOTICE,
    /** A downloaded content pack waiting for APPLY. */
    CONTENT_UPDATE,
    /** Saved payments and receipts. */
    RECOVERY,
}

/** What happens to a status line: a toast, an error toast (blood body), or it stays where it is. */
internal enum class KingdomStatusRoute { TOAST, ERROR_TOAST, KEEP }

/** The routing table (see the file comment). [error] is the notice's own flag; [sheetShowsErrors] is true while a sheet
 *  that prints errors itself is open. */
internal fun kingdomStatusRoute(source: KingdomStatusSource, error: Boolean = false, sheetShowsErrors: Boolean = false): KingdomStatusRoute =
    when (source) {
        KingdomStatusSource.RECOVERY, KingdomStatusSource.CONTENT_UPDATE -> KingdomStatusRoute.KEEP
        KingdomStatusSource.HOME_ERROR -> if (sheetShowsErrors) KingdomStatusRoute.KEEP else KingdomStatusRoute.ERROR_TOAST
        KingdomStatusSource.NOTICE -> when {
            !error -> KingdomStatusRoute.TOAST
            sheetShowsErrors -> KingdomStatusRoute.KEEP
            else -> KingdomStatusRoute.ERROR_TOAST
        }
        KingdomStatusSource.HOME_MESSAGE, KingdomStatusSource.UPDATE_NOTICE, KingdomStatusSource.TIMING_NOTICE -> KingdomStatusRoute.TOAST
    }

/** The status lines as the screen holds them now (null = none). */
internal data class KingdomStatusFacts(
    val notice: ScreenNotice? = null,
    val homeError: String? = null,
    val homeMessage: String? = null,
    val updateNotice: String? = null,
    val timingNotice: String? = null,
    /** A sheet that prints errors itself is open (the old BuildingSheet, the wall-row quote, builders, obstacle). */
    val sheetShowsErrors: Boolean = false,
)

/** What was posted: per source the line last posted (forgotten once that source went away, so a repeat is a new line),
 *  and every text posted with when, so the same words from two owners (the notice and the read error carry the same
 *  exception message) merge into one toast within a toast's life. */
internal data class KingdomStatusMemory(
    val posted: Map<KingdomStatusSource, String> = emptyMap(),
    val recent: Map<String, Long> = emptyMap(),
)

/** One toast to post. */
internal data class KingdomStatusPost(val source: KingdomStatusSource, val text: String, val error: Boolean)

/** One pass: the toasts to post, the owner callbacks to run, and the memory for the next pass. */
internal data class KingdomStatusStep(
    val posts: List<KingdomStatusPost>,
    /** Retire the screen notice (`model.dismissNotice`). */
    val dismissNotice: Boolean,
    /** Retire the kingdom's error and confirmation, and the screen notice with them (`model.clearNotice`). */
    val clearHome: Boolean,
    /** Retire the content owner's line (`model.dismissUpdateNotice`). */
    val dismissUpdate: Boolean,
    val memory: KingdomStatusMemory,
)

/**
 * Routes [facts] once (pure; KingdomStatusToasts runs it on every change). A line is posted when its source shows a text
 * it has not posted yet and no owner posted the same words in the last toast life ([mergeMs]); a KEEP line is neither
 * posted nor retired. `clearNotice` also retires the screen notice and the read error, so it never runs while a sheet
 * still shows one of them.
 */
internal fun kingdomStatusStep(facts: KingdomStatusFacts, memory: KingdomStatusMemory, nowMs: Long,
    mergeMs: Long = PkwTokens.Motion.TOAST_HOLD.toLong()): KingdomStatusStep {
    val posts = mutableListOf<KingdomStatusPost>()
    val posted = memory.posted.toMutableMap()
    val recent = memory.recent.filterValues { nowMs - it < mergeMs }.toMutableMap()
    fun consider(source: KingdomStatusSource, text: String?, error: Boolean): KingdomStatusRoute? {
        if (text.isNullOrBlank()) { posted.remove(source); return null }
        val route = kingdomStatusRoute(source, error, facts.sheetShowsErrors)
        if (route == KingdomStatusRoute.KEEP) return route
        if (memory.posted[source] != text && text !in recent) {
            posts += KingdomStatusPost(source, text, route == KingdomStatusRoute.ERROR_TOAST)
            recent[text] = nowMs
        }
        posted[source] = text
        return route
    }
    val notice = consider(KingdomStatusSource.NOTICE, facts.notice?.message, facts.notice?.error == true)
    val error = consider(KingdomStatusSource.HOME_ERROR, facts.homeError, true)
    val message = consider(KingdomStatusSource.HOME_MESSAGE, facts.homeMessage, false)
    val update = consider(KingdomStatusSource.UPDATE_NOTICE, facts.updateNotice, false)
    consider(KingdomStatusSource.TIMING_NOTICE, facts.timingNotice, false)
    val kept = notice == KingdomStatusRoute.KEEP || error == KingdomStatusRoute.KEEP
    return KingdomStatusStep(
        posts = posts,
        dismissNotice = notice != null && notice != KingdomStatusRoute.KEEP,
        clearHome = !kept && (error != null || message != null),
        dismissUpdate = update != null,
        memory = KingdomStatusMemory(posted, recent),
    )
}

/** The routing memory lives as long as the app process, so leaving Home and coming back never repeats a line the
 *  player already saw (the derived timing line has nothing to retire). Touched on the main thread only. */
private object KingdomStatusHistory {
    var memory = KingdomStatusMemory()
}

/**
 * Posts each new Kingdom status line once through the app-wide kit toast ([Toasts], drawn by KitToastLayer) and then
 * retires it with its owner's callback: [onClearNotice] (`model::clearNotice`, the kingdom error and confirmation, and the
 * screen notice with them), [onDismissNotice] (`model::dismissNotice`) or [onDismissUpdateNotice]
 * (`model::dismissUpdateNotice`). Draws nothing. Saved payments, receipts and the content APPLY are not passed here:
 * they stay in KingdomScreen's column.
 */
@Composable internal fun KingdomStatusToasts(
    notice: ScreenNotice?, homeError: String?, homeMessage: String?, updateNotice: String?, timingNotice: String?,
    sheetShowsErrors: Boolean,
    onDismissNotice: () -> Unit, onClearNotice: () -> Unit, onDismissUpdateNotice: () -> Unit,
) {
    val dismissNotice by rememberUpdatedState(onDismissNotice)
    val clearNotice by rememberUpdatedState(onClearNotice)
    val dismissUpdate by rememberUpdatedState(onDismissUpdateNotice)
    val facts = KingdomStatusFacts(notice, homeError, homeMessage, updateNotice, timingNotice, sheetShowsErrors)
    LaunchedEffect(facts) {
        val step = kingdomStatusStep(facts, KingdomStatusHistory.memory, System.currentTimeMillis())
        KingdomStatusHistory.memory = step.memory
        step.posts.forEach { Toasts.post(it.text, it.error) }
        if (step.clearHome) clearNotice() else if (step.dismissNotice) dismissNotice()
        if (step.dismissUpdate) dismissUpdate()
    }
}
