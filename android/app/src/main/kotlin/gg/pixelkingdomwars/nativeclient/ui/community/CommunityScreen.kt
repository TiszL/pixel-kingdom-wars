package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePageHeader
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.CommunityRepository
import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.model.LeagueOverview
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import kotlinx.serialization.json.*
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

enum class CommunityPage { MAIL, LEAGUES }

@Composable fun CommunityScreen(repository: CommunityRepository, page: CommunityPage, baseId: String?, onBack: () -> Unit, catalogue: JsonObject? = null, keepLevel: Int? = null) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var archived by rememberSaveable { mutableStateOf(false) }
    var confirmation by remember { mutableStateOf<Pair<MailMessage, String?>?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    suspend fun request(block: suspend () -> Unit) {
        error = null
        try { block() } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message ?: "Connection interrupted. Refresh to check the server." }
    }
    fun back() {
        if (confirmation != null) confirmation = null
        else if (page == CommunityPage.MAIL && state.detail != null) {
            repository.closeMail()
            scope.launch { request { repository.refreshMail(archived) } }
        } else onBack()
    }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    LaunchedEffect(repository, page, baseId, archived, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            request {
                if (page == CommunityPage.MAIL) { repository.checkClaim(); repository.refreshMail(archived) }
                else repository.refreshLeagues()
            }
        }
    }
    // A deed switch dismisses unsubmitted consent; the persisted claim retains its original base.
    LaunchedEffect(baseId) { confirmation = null }
    Column(Modifier.fillMaxSize().background(Palette.card).windowInsetsPadding(WindowInsets.safeDrawing)) {
        GamePageHeader(if (page == CommunityPage.MAIL) "KEEP MAIL" else "RANKED LEAGUES", onBack)
        if (page == CommunityPage.MAIL) Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(false to "INBOX", true to "ARCHIVE").forEach { (tab, label) ->
                val click = { repository.closeMail(); archived = tab }
                if (archived == tab) Button(onClick = click, enabled = !state.busy, modifier = Modifier.weight(1f), contentPadding = PaddingValues(6.dp)) { Text(label, fontSize = 17.sp) }
                else TextButton(onClick = click, enabled = !state.busy, modifier = Modifier.weight(1f), contentPadding = PaddingValues(6.dp)) { Text(label, fontSize = 17.sp) }
            }
        }
        LazyColumn(Modifier.weight(1f).widthIn(max = if (page == CommunityPage.MAIL) 788.dp else 848.dp).fillMaxWidth().align(Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(14.dp)) {
            item {
                if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                error?.let { Notice("$it Previously loaded information may be out of date.", true) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    if (page == CommunityPage.MAIL) state.status?.let { Text("${it.unread} UNREAD · ${it.pendingRewards} PENDING REWARDS", fontSize = 13.sp, color = Palette.textFaint) }
                    TextButton(onClick = { scope.launch { request {
                        if (page == CommunityPage.LEAGUES) repository.refreshLeagues()
                        else state.detail?.let { repository.openMail(it.id) } ?: repository.refreshMail(archived)
                    } } }, enabled = !state.busy, contentPadding = PaddingValues(4.dp)) { Text("REFRESH", fontSize = 14.sp) }
                }
            }
            if (page == CommunityPage.MAIL) {
                item {
                    state.pendingClaim?.let { pending ->
                        Notice("Interrupted mail claim. ${pending.baseId?.let { "Saved base: $it" } ?: "KEEP belongs to your wallet."}", false)
                        OutlinedButton(onClick = { scope.launch { request { repository.checkClaim() } } }, enabled = !state.busy) { Text("Check claim receipt") }
                        if (pending.receipt == null && (pending.baseId == null || pending.baseId == baseId)) {
                            OutlinedButton(onClick = { scope.launch { request { repository.retryClaim() } } }, enabled = !state.busy) { Text("Retry this saved claim") }
                        }
                    }
                    state.claimNotice?.let { Notice(it, false) }
                }
                val message = state.detail
                if (message != null) {
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            TextButton(onClick = ::back, contentPadding = PaddingValues(5.dp)) { Text("‹ BACK TO MAIL", fontSize = 16.sp) }
                            PixelPanel(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text("${message.sender.uppercase()} · ${communityDate(message.createdAt)}", fontSize = 14.sp, color = Palette.goldDp)
                                    Text(message.subject.uppercase(), fontSize = 27.sp, lineHeight = 31.sp, color = Palette.goldHi)
                                }
                            }
                            SelectionContainer { Text(message.body, Modifier.padding(vertical = 8.dp), fontSize = 20.sp, lineHeight = 27.sp) }
                            if (message.attachments.isNotEmpty()) CommunityCard("ATTACHED REWARD") {
                                MailRewards(message)
                                val date = when (message.rewardState) { "claimed" -> message.claimedAt; "expired" -> message.expiredAt; else -> message.expiresAt }
                                Text("${if (message.rewardState == "pending") "EXPIRES" else message.rewardState.orEmpty().uppercase()} ${communityDate(date)}", fontSize = 14.sp, color = Palette.textFaint)
                            }
                            message.claimBaseId?.let { Text("Claim destination: $it", fontSize = 14.sp) }
                            if (message.readAt == null) OutlinedButton(onClick = { scope.launch { request { repository.markRead() } } }, enabled = !state.busy) { Text("MARK AS READ", fontSize = 16.sp) }
                            if (message.rewardState == "pending" && message.needsBase && baseId == null) Text("Select a Land Deed to receive SHARDS and items.")
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (message.rewardState == "pending") Button(onClick = { confirmation = message to if (message.needsBase) baseId else null },
                                    enabled = !state.busy && state.pendingClaim == null && (!message.needsBase || baseId != null)) { Text("CLAIM REWARD", fontSize = 17.sp) }
                                if (message.archivedAt == null) OutlinedButton(onClick = { scope.launch { request { repository.archive() } } }, enabled = !state.busy) { Text("ARCHIVE", fontSize = 17.sp) }
                            }
                        }
                    }
                } else {
                    items(state.mailbox?.messages.orEmpty(), key = { it.id }) { message ->
                        val unread = message.readAt == null
                        Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).background(if (unread) Palette.gold.copy(alpha = .08f) else Palette.card)
                            .border(2.dp, if (unread) Palette.gold else Palette.border).clickable(enabled = !state.busy, role = Role.Button) { scope.launch { request { repository.openMail(message.id) } } }
                            .padding(horizontal = 13.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(if (message.kind == "reward") "◆" else "▰", fontSize = 22.sp, color = if (unread) Palette.goldHi else Palette.goldDp)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(message.subject.uppercase(), fontSize = 21.sp, letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (unread) Palette.text else Palette.muted)
                                Text("${message.sender.uppercase()} · ${communityDate(message.createdAt)}", fontSize = 14.sp, color = Palette.textFaint)
                            }
                            if (message.rewardState == "pending") Text("CLAIM", Modifier.background(Palette.gold).border(2.dp, Palette.ink).padding(horizontal = 8.dp, vertical = 4.dp), fontSize = 14.sp, color = Palette.ink)
                        }
                    }
                    if (state.mailbox?.messages?.isEmpty() == true) item { Text(if (archived) "NO ARCHIVED MESSAGES" else "YOUR INBOX IS CLEAR", Modifier.fillMaxWidth().padding(vertical = 28.dp), fontSize = 18.sp, color = Palette.textFaint, textAlign = TextAlign.Center) }
                    if (state.mailbox?.nextCursor != null) item { OutlinedButton(onClick = { scope.launch { request { repository.moreMail() } } }, enabled = !state.busy) { Text("LOAD MORE", fontSize = 17.sp) } }
                }
            } else if (state.leagueBaseId == baseId) state.leagues?.let { overview ->
                item { LeaguePresentation(overview, catalogue, keepLevel) }
            }
        }
    }
    confirmation?.let { (message, frozenBase) ->
        AlertDialog(onDismissRequest = { confirmation = null }, title = { Text("Claim this reward?") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MailRewards(message)
                Text(if (message.needsBase) "SHARDS and items go to base $frozenBase. KEEP goes to your wallet's in-game balance." else "KEEP goes to your wallet's in-game balance.")
            } },
            dismissButton = { TextButton(onClick = { confirmation = null }) { Text("Back") } },
            confirmButton = { Button(onClick = { confirmation = null; scope.launch { request { repository.claim(message.id, frozenBase) } } }, enabled = !state.busy) { Text("Claim") } })
    }
}

@Composable private fun MailRewards(message: MailMessage) {
    message.attachments.forEach { reward ->
        Text(if (reward.kind == "ITEM") "${requireNotNull(reward.itemId).replace('_', ' ').uppercase(java.util.Locale.ROOT)} ×${reward.qty}"
            else "${fmtN(requireNotNull(reward.amount))} ${reward.kind}")
    }
    message.rewardState?.let { Text("Reward: $it") }
}
@Composable private fun CommunityCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium); content()
    } }
}

private fun leagueColor(tier: String) = when (tier) {
    "bronze" -> Color(0xFFC08551); "silver" -> Color(0xFFDDE4E9); "gold" -> Color(0xFFF4D77B); "sol" -> Color(0xFF14F195); else -> Palette.textFaint
}
@Composable private fun LeagueWell(current: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().background(Palette.card).border(2.dp, if (current) Palette.goldDp else Palette.border).padding(9.dp), verticalArrangement = Arrangement.spacedBy(5.dp), content = content)
}
@Composable private fun LeagueHeading(text: String) { Text(text, Modifier.padding(top = 8.dp, bottom = 4.dp), fontSize = 15.sp, letterSpacing = 2.sp, color = Palette.textFaint) }
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun LeaguePresentation(data: LeagueOverview, catalogue: JsonObject?, keepLevel: Int?) {
    val now = displayClock()
    val you = data.you
    val thresholds = leagueThresholds(catalogue)
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        LeagueWell {
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(11.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                you?.let { GameArt("league-${it.tier}", Modifier.size(68.dp)) }
                Column(Modifier.weight(1f).widthIn(min = 135.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(you?.let { "${it.tier.uppercase()} LEAGUE" } ?: "NO RANKED DEED", fontSize = 25.sp, color = you?.let { leagueColor(it.tier) } ?: Palette.textFaint)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) { GameArt("trophy", Modifier.size(18.dp)); Text("${you?.trophies?.toString()?.let(::fmtN) ?: "—"} TROPHIES", fontSize = 21.sp) }
                    you?.let { standing -> leagueProgress(catalogue, standing.tier, standing.trophies)?.let { progress ->
                        Box(Modifier.fillMaxWidth().height(8.dp).background(Palette.backdrop).border(1.dp, Palette.border)) { Box(Modifier.fillMaxHeight().fillMaxWidth(progress.fraction).background(leagueColor(standing.tier))) }
                        Text(progress.nextTier?.let { "${progress.remaining} TO ${it.uppercase()}" } ?: "TOP TIER", fontSize = 13.sp, color = Palette.textFaint)
                    } }
                }
                Column(horizontalAlignment = Alignment.End) { Text("WINDOW CLOSES IN", fontSize = 11.sp, color = Palette.textFaint); Text(leagueRemaining(data.week.closesAt, now)?.let(::fmtDur)?.uppercase() ?: "—", fontSize = 19.sp, color = Palette.goldHi) }
            }
        }
        LeagueWell {
            Text(data.rewards.status.uppercase(), Modifier.background(when (data.rewards.status) { "active" -> Palette.success; "scheduled" -> Palette.gold; else -> Palette.textFaint }).padding(horizontal = 6.dp, vertical = 3.dp), fontSize = 13.sp, color = Palette.backdrop)
            Text(when (data.rewards.status) {
                "disabled" -> "REWARDS ARE DISABLED. NO CACHE WILL BE CREATED FOR THIS WINDOW."
                "scheduled" -> "FIRST SETTLEMENT IS SCHEDULED FOR ${communityDate(data.rewards.firstSettlementAt, java.time.ZoneId.of("UTC"))} UTC."
                else -> "REWARDS ACTIVE · NEXT SETTLEMENT ${communityDate(data.week.settlesAt, java.time.ZoneId.of("UTC"))} UTC."
            }, fontSize = 13.sp, color = Palette.muted)
        }
        LeagueWell {
            Text("RATED ATTACKS · ${you?.currentWeekRatedAttacks ?: "—"} / ${data.rewards.minRatedAttacks}", fontSize = 20.sp, color = Palette.goldHi)
            Text(when {
                you == null -> "SELECT A LANDED DEEDED BASE TO ENTER THE LADDER."
                you.rewardCandidate -> "THIS BASE IS YOUR WALLET’S CURRENT REWARD CANDIDATE."
                you.blockedByHigherBase -> "ANOTHER BASE IN THIS WALLET CURRENTLY RANKS HIGHER."
                you.trophies <= 0 -> "EARN A TROPHY TO BECOME REWARD-ELIGIBLE."
                !you.participationMet -> "COMPLETE THE ATTACK REQUIREMENT BEFORE THE WINDOW CLOSES."
                else -> "THIS BASE IS NOT CURRENTLY A REWARD CANDIDATE."
            }, fontSize = 13.sp, color = if (you?.rewardCandidate == true) Palette.success else Palette.textFaint)
        }
        LeagueHeading("REWARD LADDER")
        if (leagueRules(catalogue) == null || thresholds == null) Text("Verified league rewards are unavailable. Update game content.", fontSize = 14.sp, color = Palette.textFaint)
        communityLeagueTiers.forEachIndexed { index, tier ->
            LeagueWell(you?.tier == tier) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    GameArt("league-$tier", Modifier.size(44.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(tier.uppercase(), fontSize = 19.sp, letterSpacing = 2.sp, color = leagueColor(tier))
                        val low = thresholds?.getOrNull(index); val high = thresholds?.getOrNull(index + 1)
                        Text(if (low == null) "TROPHY RANGE —" else if (high == null) "$low+ TROPHIES" else "$low–${high - 1} TROPHIES", fontSize = 13.sp, color = Palette.textFaint)
                        Text("▸ ${leagueCache(catalogue, tier, keepLevel)?.let(::fmtN) ?: "—"} SHARDS at Keep ${keepLevel ?: "—"}", fontSize = 14.sp, color = Palette.muted)
                        val rewards = (leagueRules(catalogue)?.get("weeklyItemsByTier") as? JsonObject)?.get(tier) as? JsonArray
                        rewards?.forEach { raw -> (raw as? JsonObject)?.let { item ->
                            val id = item.string("itemId"); val quantity = item.string("qty")
                            if (id != null && quantity != null) Text("▸ $quantity × ${communityItemName(catalogue, id)}", fontSize = 14.sp, color = Palette.muted)
                        } }
                    }
                    if (you?.tier == tier) Text("YOU", fontSize = 12.sp, color = Palette.goldHi)
                }
            }
        }
        Text("Trophies are cumulative and never reset. Complete ${data.rewards.minRatedAttacks} resolved attacks on deeded player bases during this earning window. At most ${data.rewards.maxRewardedBasesPerWallet} base per wallet earns: highest tier, then trophies, then base ID. Rewards settle automatically at ${communityDate(data.week.settlesAt, java.time.ZoneId.of("UTC"))} UTC.", fontSize = 13.sp, lineHeight = 18.sp, color = Palette.textFaint)
        LeagueHeading("GLOBAL STANDINGS")
        if (data.board.isEmpty()) LeagueWell { Text("NO RANKED BASES YET.", fontSize = 14.sp, color = Palette.textFaint) }
        data.board.forEach { entry -> LeagueWell(entry.you) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("#${entry.rank}", Modifier.width(34.dp), fontSize = 16.sp, color = Palette.textFaint, textAlign = TextAlign.End)
                GameArt("league-${entry.tier}", Modifier.size(26.dp))
                Text(if (entry.you) "YOU" else entry.name?.takeIf { it.isNotBlank() } ?: "UNNAMED KEEP", Modifier.weight(1f), fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(fmtN(entry.trophies.toString()), fontSize = 17.sp, color = leagueColor(entry.tier))
            }
        } }
        LeagueHeading("LAST SETTLEMENT")
        LeagueWell {
            val receipt = data.lastSettlement
            if (receipt == null) Text("NO REWARD RECEIPT YET.", fontSize = 14.sp, color = Palette.textFaint)
            else Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                GameArt("league-${receipt.tier}", Modifier.size(44.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("${receipt.week} · ${receipt.tier.uppercase()} · ${fmtN(receipt.trophies.toString())} TROPHIES", fontSize = 14.sp)
                    Text("${fmtN(receipt.cacheShards)} SHARDS · KEEP ${receipt.keepLevel}", fontSize = 14.sp, color = Palette.muted)
                    receipt.items.forEach { Text("${it.qty} × ${communityItemName(catalogue, it.itemId)}", fontSize = 14.sp, color = Palette.muted) }
                    Text("SETTLED ${communityDate(receipt.settledAt)}", fontSize = 13.sp, color = Palette.textFaint)
                }
            }
        }
    }
}
