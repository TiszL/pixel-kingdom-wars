package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.FeedbackIssueBounds
import gg.pixelkingdomwars.nativeclient.data.LiveFeedbackRepository
import gg.pixelkingdomwars.nativeclient.model.FeedbackIssue
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowChevron
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import kotlinx.coroutines.*

@Composable internal fun KnownIssues(repository: LiveFeedbackRepository, bounds: FeedbackIssueBounds?, query: String, category: String,
    enabled: Boolean, onEvidence: (FeedbackIssue) -> Unit) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    var error by remember(repository) { mutableStateOf<String?>(null) }
    suspend fun request(action: suspend () -> Unit) {
        error = null
        try { action() } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message ?: "Known issues are unavailable" }
    }
    // Keyed on what is actually sent: a trailing space or text past the limit is not a new search.
    val needle = query.trim().take(bounds?.queryMax ?: 0)
    LaunchedEffect(repository, bounds, needle, category) {
        if (bounds != null && category.isNotBlank()) {
            delay(bounds.debounceMs)
            request { repository.searchIssues(needle, category) }
        }
    }
    // The kit body (hub SPEC §1 SectionHeader, CardRow, Chevron; stone and gold buttons) with the reviewed words and calls
    // unchanged; it was the old dark web plates on the parchment card.
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("KNOWN ISSUES")
        PkwText("Published summaries from the team. Confirming a match records that you are affected; it earns no points and shares no private evidence.",
            PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4)
        if (bounds == null) PkwText("Known-issue search limits are unavailable. Update game content.", PkwTokens.Type.small,
            color = PkwTokens.Colors.danger, maxLines = 2)
        error?.let {
            PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.danger, maxLines = 3)
            SecondaryButton("RETRY SEARCH", { scope.launch { request { repository.searchIssues(query.trim().take(requireNotNull(bounds).queryMax), category) } } },
                enabled = enabled && bounds != null, contentDescription = "Retry search")
        }
        state.issues.forEach { issue ->
            CardRow(onClick = { scope.launch { request { repository.openIssue(issue.id) } } }, enabled = enabled, description = issue.title) {
                RowText(issue.title, null)
                RowChevron()
            }
        }
        state.selectedIssue?.let { issue ->
            Plate(PlateKind.CREAM, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(issue.title, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch, maxLines = 2)
                    PkwText("${issue.status} · ${issue.affectedPlayerCount} affected", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    PkwText(issue.summary, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
                    issue.workaround?.let { PkwText("Workaround: $it", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE) }
                    issue.fixedRelease?.let { PkwText("Fixed in: $it", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
                    val confirmed = issue.id in state.confirmedIssues
                    // A DISABLED kit primary still answers a tap, so the old `enabled` rule guards the call itself.
                    PrimaryButton(if (confirmed) "CONFIRMED — THANK YOU" else "I HAVE THIS TOO", { if (enabled && !confirmed) scope.launch { request { repository.confirmIssue(issue) } } },
                        Modifier.fillMaxWidth(), state = if (enabled && !confirmed) CommandState.ENABLED else CommandState.DISABLED)
                    SecondaryButton("ADD PRIVATE EVIDENCE", { onEvidence(issue) }, Modifier.fillMaxWidth(), enabled = enabled,
                        contentDescription = "Add private evidence")
                }
            }
        }
        if (state.issues.isEmpty() && !state.busy && !state.searching && error == null && bounds != null)
            PkwText("No matching published issue. You can submit a different problem.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
    }
}
