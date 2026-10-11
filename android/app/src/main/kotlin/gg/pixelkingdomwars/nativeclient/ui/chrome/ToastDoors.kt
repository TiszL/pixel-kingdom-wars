package gg.pixelkingdomwars.nativeclient.ui.chrome

import gg.pixelkingdomwars.nativeclient.data.FeedbackDrafts
import gg.pixelkingdomwars.nativeclient.data.FeedbackReportDraft
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The two doors an app-wide toast can open (hub SPEC §3.2, toasts.png bottom): the error toast's "Report" link (Feedback,
 * prefilled) and the blue GO (a feature's own surface). [KitToastLayer] sits above every screen and has no navigation of
 * its own, so the app root binds the doors it can actually open and the layer draws a door only while it is bound: a
 * Report or GO that could not open would be a dead control.
 *
 * A binding is closed by whoever made it (a DisposableEffect). [AutoCloseable.close] clears the door only while that
 * binding is still the current one, so the late dispose of an old binding never unbinds the newer one that replaced it.
 */
object ToastDoors {
    private class Door<T>(val handler: (T) -> Boolean)

    private var reportDoor: Door<String>? = null
    private var goDoor: Door<FeatureId>? = null
    private val reportMutable = MutableStateFlow(false)
    private val goMutable = MutableStateFlow(false)

    /** True while a Report door is bound: the layer draws "Report" on an error toast only then. */
    val reportBound: StateFlow<Boolean> = reportMutable.asStateFlow()
    /** True while a GO door is bound: the layer draws a toast's GO only then. */
    val goBound: StateFlow<Boolean> = goMutable.asStateFlow()

    /** Binds the Report door; [handler] gets the toast's sentence and answers whether it opened Feedback. */
    @Synchronized fun bindReport(handler: (message: String) -> Boolean): AutoCloseable {
        val door = Door(handler)
        reportDoor = door; reportMutable.value = true
        return object : AutoCloseable { override fun close() { closeReport(door) } }
    }

    /** Binds the GO door; [handler] gets the toast's feature and answers whether it opened it. */
    @Synchronized fun bindGo(handler: (feature: FeatureId) -> Boolean): AutoCloseable {
        val door = Door(handler)
        goDoor = door; goMutable.value = true
        return object : AutoCloseable { override fun close() { closeGo(door) } }
    }

    /** Opens Feedback for [message]; false when no door is bound or the bound one refused. The handler runs outside the
     *  lock, so a handler that navigates (and so disposes and rebinds) cannot deadlock. */
    fun report(message: String): Boolean {
        val door = currentReport() ?: return false
        return door.handler(message)
    }

    /** Opens [feature]; false when no door is bound or the bound one refused. */
    fun go(feature: FeatureId): Boolean {
        val door = currentGo() ?: return false
        return door.handler(feature)
    }

    @Synchronized private fun currentReport(): Door<String>? = reportDoor
    @Synchronized private fun currentGo(): Door<FeatureId>? = goDoor
    /** Identity, not equality: only the binding that is still current may clear its door. */
    @Synchronized private fun closeReport(door: Door<String>) {
        if (reportDoor === door) { reportDoor = null; reportMutable.value = false }
    }
    @Synchronized private fun closeGo(door: Door<FeatureId>) {
        if (goDoor === door) { goDoor = null; goMutable.value = false }
    }
}

/**
 * The report a toast's "Report" starts (hub SPEC §3.2 "→ Feedback, prefilled"): the catalogue's bug category and the
 * toast's own sentence as the details. Null when the player already has words in a draft: their text is never
 * overwritten (0.5.4: lost words read as "feedback does not work"), so Feedback opens on what they wrote. The title stays
 * empty for the player to name; the "include my base" choice is theirs and is kept.
 */
internal fun toastReportDraft(existing: FeedbackReportDraft, message: String, categories: List<String>): FeedbackReportDraft? {
    if (existing.hasText) return null
    return FeedbackReportDraft(category = categories.firstOrNull { it.equals("bug", ignoreCase = true) } ?: "", title = "",
        body = message.trim(), includeBase = existing.includeBase)
}

/** Stores the toast's report in the session's unsent drafts (see [toastReportDraft]); true when it was prefilled. */
internal fun prefillToastReport(drafts: FeedbackDrafts, message: String, categories: List<String>): Boolean =
    toastReportDraft(drafts.report, message, categories)?.let { drafts.keepReport(it); true } ?: false
