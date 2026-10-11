package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedTextField
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.pageInsets
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.LivePlaytestRepository
import gg.pixelkingdomwars.nativeclient.data.PlaytestBounds
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.*

@Composable fun PlaytestCampaignScreen(repository: LivePlaytestRepository, bounds: PlaytestBounds?, onFeedback: () -> Unit, onBack: () -> Unit) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val uri = LocalUriHandler.current
    var selected by rememberSaveable(repository) { mutableStateOf(bounds?.foundingId) }
    var url by rememberSaveable(repository, selected) { mutableStateOf("") }
    var report by rememberSaveable(repository, selected) { mutableStateOf<String?>(null) }
    var showRules by rememberSaveable(repository, selected) { mutableStateOf(false) }
    var showFounders by rememberSaveable(repository, selected) { mutableStateOf(false) }
    var error by remember(repository, selected) { mutableStateOf<String?>(null) }
    suspend fun request(block: suspend () -> Unit) {
        error = null
        try { block() } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message ?: "Campaign connection interrupted. Check any saved request." }
    }
    fun back() { repository.close(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    DisposableEffect(repository) { onDispose { repository.close() } }
    LaunchedEffect(repository, selected, bounds, lifecycle) {
        val limits = bounds ?: return@LaunchedEffect
        val id = selected ?: limits.foundingId.also { selected = it }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            request { if (repository.state.value.selectedId == id) repository.refresh() else repository.open(id) }
            while (isActive) { delay(limits.pollMs); request { repository.refresh() } }
        }
    }
    val c = state.campaign
    val enabled = bounds != null && state.canAct
    // Second old-screen sweep (owner 2026-10-06): the Founding Kingdoms card's RULES door opens the designed page (its
    // title plate and red close replace the old Back row). The list is lazy, so the page hands it the bounded height.
    DesignedPage("PLAYTEST CAMPAIGNS", ::back, scrollState = null) {
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { scope.launch { request { repository.refresh() } } }, enabled = !state.busy) { Text("Refresh") }
            }
            bounds?.let { rules -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected == rules.foundingId, { repository.close(); selected = rules.foundingId }, label = { Text(rules.foundingName) })
                FilterChip(selected == rules.rewardedId, { repository.close(); selected = rules.rewardedId }, label = { Text(rules.rewardedName) })
            } } ?: Notice("Campaign rules are unavailable. Update game content.", true)
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Notice("$it Previously loaded information may be out of date.", true) }
            state.notice?.let { Notice(it, false) }
            state.pending?.let { pending ->
                Notice("Saved ${pending.kind} request for ${pending.campaignId}. ${pending.reportId ?: pending.url ?: "Participation"}", false)
                OutlinedButton(onClick = { scope.launch { request { repository.checkPending() } } }, enabled = !state.busy) { Text("Check saved receipt") }
                OutlinedButton(onClick = { scope.launch { request { repository.retry() } } }, enabled = !state.busy) { Text("Retry saved request") }
                // Dead-end audit 2026-10-06: a request the campaign never recorded must not block every new one.
                if (pending.participantReceipt == null && pending.submissionReceipt == null)
                    OutlinedButton(onClick = { scope.launch { request { repository.closeUnrecorded() } } }, enabled = !state.busy) { Text("Close if the campaign has no record") }
            }
        }
        if (c != null && c.id == selected && bounds != null) {
            item { CampaignCard(c.name) {
                Text("${c.phase} · ${bounds.durationDays} days")
                Text("Starts ${c.startAt ?: "to be announced"} · Ends ${c.endAt ?: "to be announced"}")
                Text(c.reconciledAt?.let { "Scores updated $it" } ?: "Scores have not been updated yet")
                if (c.stale) Notice("Score update is delayed.", false)
                Text("Campaign points start fresh. Lifetime tester points keep growing separately.")
                c.spots?.let { Text("${it.total} whitelist spots · ${it.reserved} reserved for original minters + ${it.ranked} ranked campaign awards") }
                val mine = c.standings.find { it.isYou }
                Text(mine?.let { "Your campaign score: ${it.points} · ${it.activeDays} active UTC days · ${it.longestStreak} day best streak" } ?: "Your campaign activity has not been scored yet.")
                if (c.kind == "founding") {
                    Text("Automatic participation")
                    val checkpoint = c.checkpoint
                    if (checkpoint?.available == true && checkpoint.count != null) Text("Checkpoint ${checkpoint.count} / ${checkpoint.target}${if (checkpoint.frozen) " · held until launch" else ""}")
                    else Text("Checkpoint verification is unavailable. The server will retry verification.")
                    checkpoint?.verification?.lastSuccessAt?.let { Text("Last verified $it") }
                    if (c.founders.isNotEmpty()) TextButton(onClick = { showFounders = !showFounders }) { Text(if (c.snapshotAt != null) "Guaranteed recipients · frozen snapshot" else "Verified original minters · snapshot not frozen") }
                } else {
                    val participant = c.participant
                    when { participant?.disqualifiedAt != null -> Text("Disqualified: ${participant.disqualificationReason ?: "See the campaign rules."}")
                        participant != null -> Text("Participating since ${participant.joinedAt}")
                        c.canEnter -> { Text("Participation is optional. Join to begin earning campaign points."); Button(onClick = { scope.launch { request { repository.participate(c) } } }, enabled = enabled) { Text("Participate") } }
                        else -> Text("Registration is not open.") }
                    participant?.bonusAt?.let { Text("${bounds.bonusPoints} lifetime participation points earned · $it") }
                    mine?.let { Text("${it.revenge} qualifying revenge wins · ${it.stages} distinct three-star stages") }
                }
                TextButton(onClick = { showRules = !showRules }) { Text("Rules & rewards") }
                if (showRules) {
                    if (c.kind == "founding") Text("Verified original minters keep their guaranteed spots after selling. Other ranked spots require deed eligibility at close. The server determines eligibility and awards.")
                    else {
                        Text("Only activity after launch and your participation counts. Play on ${bounds.bonusDays} distinct UTC days to earn ${bounds.bonusPoints} lifetime points once.")
                        Text("Feedback review points count toward lifetime totals. Eligible private reports can separately win Bug Scout awards. Duplicate reports are ineligible.")
                        Text("Daily activity, caps and streak rewards match normal play. Campaign streaks start fresh. Score ties use active days, the earliest time reaching the score, then wallet address.")
                        Text("One gameplay award and one Bug Scout award per wallet; a video award may also be earned. Gameplay awards follow the listed order, skipping earlier winners.")
                        Text("Revenge counts up to ${bounds.revengeWinsPerOpponentDay} wins per opposing wallet per UTC day. Daily Defender uses active days, then longest streak. Realm Explorer counts distinct three-star stages during participation.")
                        Text("Videos need objective feedback and gameplay evidence. Honest criticism is welcome; praise, views and likes give no advantage.")
                        Text(bounds.videoWeights.entries.joinToString(" · ") { "${it.key}: ${it.value}%" })
                        c.prizes.forEach { Text("${it.title} · $${it.amountUsd}") }
                    }
                }
            } }
            if (showFounders) items(c.founders, key = { "founder:${it.position}" }) { founder -> Text("${founder.position}. ${founder.username.ifBlank { "Keeper" }} · ${founder.wallet}") }
            if (c.kind == "rewarded" && c.participant != null) {
                item { CampaignCard("Your submissions") {
                    Text("Enter an original public gameplay video, or choose a private report created during eligible participation. Reports and judging notes stay private.")
                    OutlinedTextField(url, { url = it }, label = { Text("Public HTTPS video-post URL") }, enabled = state.canType && c.canSubmit, modifier = Modifier.fillMaxWidth())
                    Button(onClick = { val frozen = url; scope.launch { request { repository.submitVideo(c, frozen) } } }, enabled = enabled && c.canSubmit && url.isNotBlank()) { Text("Submit video") }
                    OutlinedButton(onClick = { scope.launch { request { repository.reports() } } }, enabled = !state.busy) { Text("Choose a private report") }
                    OutlinedButton(onClick = onFeedback) { Text("Create or read feedback") }
                    if (!c.canSubmit) Text("Submissions require a running campaign and eligible participation.")
                } }
                items(state.reports?.feedback.orEmpty(), key = { "report:${it.id}" }) { row ->
                    val alreadyEntered = c.ownSubmissions.any { it.reportId == row.id }
                    FilterChip(report == row.id, { report = row.id }, label = { Text(row.title + if (alreadyEntered) " · already entered" else "") }, enabled = enabled && c.canSubmit && !alreadyEntered)
                }
                item {
                    if (state.reports?.nextCursor != null) OutlinedButton(onClick = { scope.launch { request { repository.reports(true) } } }, enabled = !state.busy) { Text("More reports") }
                    report?.let { reportId -> Button(onClick = { scope.launch { request { repository.submitReport(c, reportId) } } }, enabled = enabled && c.canSubmit) { Text("Enter selected report") } }
                }
                items(c.ownSubmissions, key = { "submission:${it.id}" }) { entry -> CampaignCard("${entry.kind} · ${entry.createdAt}") {
                    entry.reportId?.let { Text("Report $it") }
                    entry.url?.let { link -> Text(link); TextButton(onClick = { uri.openUri(link) }) { Text("View submitted post") } }
                } }
            }
            item { Text("${c.name} standings", style = MaterialTheme.typography.titleMedium); if (c.standings.isEmpty()) Text("No scored activity yet.") }
            items(c.standings, key = { "standing:${it.rank}" }) { row -> CampaignCard("#${row.rank} · ${row.username.ifBlank { row.wallet }}${if (row.isYou) " · You" else ""}") {
                Text("${row.points} points · ${row.activeDays} active days · ${row.longestStreak} best streak")
                if (c.kind == "rewarded") Text("${row.revenge} revenge wins · ${row.stages} three-star stages")
                Text(if (row.guaranteed) "Guaranteed spot" else if (row.eligible) "Eligible" else "Not eligible")
            } }
            if (c.winners.isNotEmpty()) item { CampaignCard("Recorded awards") {
                Text("These are the server's award results. This view does not confirm payment.")
                c.winners.forEach { winner -> Text("${c.prizes.find { it.id == winner.prizeId }?.title ?: "Whitelist spot"} · ${winner.username.ifBlank { winner.wallet }}${if (winner.amountUsd > 0) " · $${winner.amountUsd}" else ""}") }
            } }
        }
    }
    }
}
@Composable private fun CampaignCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(title, style = MaterialTheme.typography.titleMedium); content() } }
}
