package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.FeedbackBounds
import gg.pixelkingdomwars.nativeclient.data.FeedbackIssueBounds
import kotlinx.coroutines.CancellationException

/**
 * The designed Feedback card (SPEC §2.7 NEW, part two §C MY REPORTS). Both entry paths, the standalone route and the
 * typed Home sheet ([hosted]), share one account-owned repository and the same body. Tab ids are [FEEDBACK_TABS].
 * Nothing here sends on its own: every send, reply and saved-request step is the existing [FeedbackScreen] owner's.
 */
@Composable fun FeedbackHub(
    graph: AppGraph, session: SessionGraph, onBack: () -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false,
    selectedTab: String? = null, onTab: ((String) -> Unit)? = null, canRead: () -> Boolean = { true },
) {
    val account by graph.account.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val tester by session.tester.state.collectAsState()
    val base by session.base.state.collectAsState()
    val baseId = account.selectedBaseId
    val generation = account.baseSelectionGeneration
    val latestCanRead by rememberUpdatedState(canRead)
    // Equal wallet text is not the same owner: the graph, the holder and the account must all still be this session.
    fun current(): Boolean {
        val now = graph.account.state.value
        return graph.sessionGraph.value === session && graph.holder.current === session.session &&
            now.session === session.session && now.selectedBaseId == baseId && now.baseSelectionGeneration == generation
    }
    key(session, baseId, generation) {
        LaunchedEffect(session, baseId, generation) {
            if (current() && latestCanRead()) {
                // GET /tester/me only; the shared reader refuses a refresh inside its own minimum interval. A failed read
                // keeps this session's last points on screen (a refresh never blanks them); none read yet stays "…".
                try { session.tester.refreshProgress() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { }
            }
        }
        FeedbackScreen(repository = session.feedback, bounds = FeedbackBounds.from(content.catalogue), baseId = baseId,
            issueBounds = FeedbackIssueBounds.from(content.catalogue), onBack = onBack, modifier = modifier,
            // The kingdom name comes from the same selected base the report would include, never another kingdom's.
            kingdomName = base.base?.takeIf { baseId != null && it.baseId == baseId }?.player?.name?.takeIf { it.isNotBlank() },
            testerPoints = tester.progress?.points?.toString()?.takeIf { current() },
            hosted = hosted, selectedTab = selectedTab, onTab = onTab, ownerCurrent = ::current, canRead = canRead)
    }
}
