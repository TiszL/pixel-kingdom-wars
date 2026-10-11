package gg.pixelkingdomwars.nativeclient.data

/** What the player typed into "New report" and has not sent. */
data class FeedbackReportDraft(val category: String = "", val title: String = "", val body: String = "", val includeBase: Boolean = false) {
    /** Only words count: a category or a ticked box alone is not something a player can lose. */
    val hasText: Boolean get() = title.isNotBlank() || body.isNotBlank()
}

/** Unsent feedback text for one signed-in session. Back, a closed keyboard or leaving the screen
 * must never cost a player their words (0.5.4: Back from the form discarded the report), so the
 * text outlives the screen. It is memory only: nothing a player has not chosen to send is written
 * to app storage, and it ends with the session graph at sign-out. Main-thread confined, like the screen. */
class FeedbackDrafts {
    var report = FeedbackReportDraft(); private set
    private var written = false
    private val replies = mutableMapOf<String, String>()
    /** An empty draft is how a deliberately discarded report is forgotten. */
    fun keepReport(draft: FeedbackReportDraft) { report = draft; written = true }
    /** The screen's saved copy knows more than this holder only in a new process. Once the holder
     * has been written it is the truth: a saved copy may still carry a report that was sent while
     * the screen was away, and must not bring it back as "Continue draft report". */
    fun restoreReport(saved: FeedbackReportDraft): FeedbackReportDraft { if (!written) keepReport(saved); return report }
    /** The server acknowledged these words, so they stop being a draft here, in the holder, where a
     * cancelled screen cannot skip it. Matched on the words sent (the server's trimmed copy), not on
     * the whole draft: a box ticked since Submit must not offer a sent report for sending again,
     * and words that differ were typed later and stay. */
    fun retireReport(title: String, body: String) {
        written = true; if (report.title.trim() == title.trim() && report.body.trim() == body.trim()) report = FeedbackReportDraft()
    }
    /** Forgets a reply only if it is still the text that was sent. */
    fun retireReply(reportId: String, body: String) { if (replies[reportId]?.trim() == body.trim()) replies.remove(reportId) }
    /** Replies are per conversation: text written for one report must never appear under another. */
    fun reply(reportId: String): String = replies[reportId].orEmpty()
    fun keepReply(reportId: String, text: String) { if (text.isBlank()) replies.remove(reportId) else replies[reportId] = text }
}

/** Why "Submit report" is unavailable, in the order a player fills the form; null when it can be
 * sent. A disabled button with no reason reads as "feedback does not work". */
fun feedbackSubmitBlocker(bounds: FeedbackBounds?, draft: FeedbackReportDraft, recurrenceRequired: Boolean, recurrence: Boolean): String? = when {
    bounds == null -> "Feedback limits are unavailable. Update game content."
    draft.category !in bounds.categories -> "Choose a category."
    draft.title.isBlank() -> "Add a title."
    draft.title.trim().length > bounds.titleMax -> "Shorten the title to ${bounds.titleMax} characters."
    draft.body.trim().length < bounds.bodyMin -> "Describe what happened in at least ${bounds.bodyMin} characters."
    draft.body.trim().length > bounds.bodyMax -> "Shorten the details to ${bounds.bodyMax} characters."
    recurrenceRequired && !recurrence -> "Confirm this closed issue is happening again."
    else -> null
}
