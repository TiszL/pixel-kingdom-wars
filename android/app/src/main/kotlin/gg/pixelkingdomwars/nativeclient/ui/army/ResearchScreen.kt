@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.army

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.zIndex
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.researchGemSpendUi
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.model.ResearchSpeedupIntent
import gg.pixelkingdomwars.nativeclient.ops.ResearchSpec
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.serialization.json.*
import kotlinx.coroutines.flow.first

/** SHARDS start/cancel remain distinct from a server-quoted, always explicit currency FINISH. */
@Composable fun ResearchScreen(model: ArmyViewModel, baseGeneration: Long = 0, actionsAllowed: Boolean = true, onBack: () -> Unit) {
    val state by model.state.collectAsState()
    val actionBusy by model.busy.collectAsState()
    val busy = actionBusy || state.domain.loading
    val notice by model.notice.collectAsState()
    val now = displayClock()
    var cancelIntent by remember(state.baseId, state.wallet, state.domain.army) { mutableStateOf<CancelJobIntent?>(null) }
    val dialogOpen = state.domain.researchReview != null || cancelIntent != null
    BackHandlerAt(BackPriority.SHEET, enabled = dialogOpen) { model.dismissResearchReview(); cancelIntent = null }
    BackHandlerAt(BackPriority.SCREEN, enabled = !dialogOpen) { model.dismissResearchReview(); onBack() }
    val army = researchCurrentArmy(state, baseGeneration); val base = state.home.base?.takeIf { it.baseId == state.baseId }; val catalogue = state.catalogue; val balances = state.home.balances
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) { model.dismissResearchReview(); cancelIntent = null } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismissResearchReview() }
    }
    LaunchedEffect(model, lifecycle, state.wallet, baseGeneration, actionsAllowed) {
        model.dismissResearchReview(); cancelIntent = null
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.busy.first { !it }
            model.refreshResearch()?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    // Web ResearchTray auto-refetch: when the research completes the level lands without a tap (the server
    // completes lazily on GET /army); an already-elapsed row retries shortly rather than freezing at 0:00.
    val activeFinish = army?.research?.firstOrNull()?.finishesAt
    LaunchedEffect(activeFinish) {
        val end = activeFinish?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            kotlinx.coroutines.delay(if (end <= System.currentTimeMillis()) 2_000 else end - System.currentTimeMillis() + 1_500)
            model.busy.first { !it }
            model.refreshResearch()?.join()
            kotlinx.coroutines.awaitCancellation()
        }
    }
    val statusContent: @Composable () -> Unit = {
        notice?.let { Notice(it.message, it.error, model::dismissNotice) }
        state.domain.error?.takeIf { notice == null }?.let { Notice(it, error = true, onDismiss = model::clearNotice) }
        state.domain.message?.let { Notice(it, onDismiss = model::clearNotice) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = SurfaceInk.gold)
        ResearchPending(state, busy, state.ordersAllowed && actionsAllowed, model)

    }
    // Second old-screen sweep (owner 2026-10-06): the designed page (wood frame, parchment) replaces the dark page and
    // its header. The body keeps its own pinned-card layout, so the page hands it the bounded height (scrollState = null).
    DesignedPage("ALCHEMY LAB", onClose = { model.dismissResearchReview(); onBack() }, scrollState = null) researchScreen@ {
        if (army == null || base == null || catalogue == null || balances == null) {
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                statusContent()
                TextButton(onClick = model::refreshResearch, enabled = !busy) { Text(if (state.baseId == null) "CHECK SAVED PAYMENT" else "LOAD RESEARCH") }
                if (state.baseId == null) Text("Select a kingdom to view current research. Saved payments can still be checked here.")
            }
            return@researchScreen
        }
        val supported = researchConsentSupported(army.raw)
        val enabled = supported && !busy && state.ordersAllowed && actionsAllowed && state.domain.researchReview == null && state.interrupted.none { it.kind == IntentKind.RESEARCH }
        fun action(kind: String, troop: String, target: Int, price: String, finishesAt: String? = null, episodeId: JsonElement? = null) = buildJsonObject {
            put("action", kind); put("troop", troop); put("level", requireNotNull(army.levels[troop])); put("toLevel", target); put("price", price); put("baseId", requireNotNull(state.baseId))
            finishesAt?.let { put("finishesAt", it); put("episodeId", episodeId ?: JsonNull) }
        }
        val balanceTree = buildJsonObject { put("shards", balances.shards); put("keep", balances.keep) }
        val activeRows = army.raw.objects("research")
        val activeContent: @Composable () -> Unit = {
        activeRows.forEach { row ->
            val troop = row.string("troop") ?: return@forEach
            val target = row.string("toLevel")?.toIntOrNull() ?: return@forEach
            val remaining = researchRemaining(row, now)
            val progress = researchDisplayProgress(catalogue, target, remaining)
            val finishContent: @Composable () -> Unit = {
                if (researchFinishOffered(army.raw, row)) Button(onClick = { model.reviewResearchFinish(troop) },
                    enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text("REVIEW FINISH PRICE") }
            }
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("RESEARCH IN PROGRESS", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    GameArt(armyPortrait(catalogue, troop, army.levels[troop]), Modifier.size(52.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(trainingTroopLabel(troop), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.text)
                        Text("LEVEL ${target - 1} → $target", fontSize = 15.sp, lineHeight = 19.sp, color = SurfaceInk.muted)
                    }
                }
                Text(if (remaining == 0L) "COMPLETING" else remaining?.let { "READY IN ${fmtDur(it)}" } ?: "Timer unavailable", fontSize = 17.sp, lineHeight = 21.sp, color = SurfaceInk.goldHi)
                if (progress == null) LinearProgressIndicator(Modifier.fillMaxWidth())
                else LinearProgressIndicator(progress, Modifier.fillMaxWidth())
                finishContent()
                val refund = row.string("refundShards")
                if (row.containsKey("episodeId") && row.flag("canCancel") && refund != null && remaining?.let { it > 0 } == true)
                    // CANCEL asks first, quoting the server's recorded refund and the exact research shown.
                    TextButton(onClick = { cancelIntent = CancelJobIntent("RESEARCH", "${trainingTroopLabel(troop)} L${target - 1}→L$target", refund) {
                        model.submitResearch(action("cancel", troop, target, refund, row.string("finishesAt"), row["episodeId"])) } }, enabled = enabled,
                        modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("CANCEL", fontSize = 15.sp, lineHeight = 19.sp)
                            Text("+${fmtN(refund)} SHARDS", fontSize = 15.sp, lineHeight = 19.sp)
                        }
                    }
                else if (!row.flag("canCancel")) Text("PRE-UPDATE RESEARCH FINISHES NORMALLY", Modifier.fillMaxWidth(), fontSize = 13.sp, lineHeight = 17.sp, color = SurfaceInk.muted)
            } }
        }
        }
        val choices = researchChoices(catalogue, base.raw, army.raw, balanceTree)
        val choicesContent: @Composable () -> Unit = {
            statusContent()
            if (!supported) Text("Research orders will be available when this server enables the compatible native update. Your levels and queue remain visible.")
            if (choices.isEmpty()) Text("Research controls need the latest verified game catalogue.")
            Text("UPGRADE TROOPS", style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi)
            Text("Research strengthens your troops. Each upgrade uses the cost and time shown.", fontSize = 14.sp, lineHeight = 18.sp, color = SurfaceInk.muted)
            choices.forEach { choice ->
                ResearchChoiceRow(choice, armyPortrait(catalogue, choice.troop, choice.level), activeRows.any { it.string("troop") == choice.troop }, enabled, state.unlock(choice.troop)) {
                    model.submitResearch(action("start", choice.troop, choice.target, choice.cost.toString()))
                }
            }
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // Preserve the web's pinned FINISH card whenever it fits. Short/large-text screens keep
            // one scroll owner below the fixed close header, so none of the actions can be stranded.
            if (maxHeight < 560.dp || LocalDensity.current.fontScale > 1.3f) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    activeContent()
                    choicesContent()
                }
            } else Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                activeContent()
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) { choicesContent() }
            }
        }
    }
    CancelJobConfirmDialog(cancelIntent) { cancelIntent = null }
    ResearchCurrencyConfirm(state, busy, actionsAllowed, model, baseGeneration)
}

/** A cached DTO is not the new selection's current army, including an A-to-B-to-A round trip. */
internal fun researchCurrentArmy(state: ArmyUiState, generation: Long) = state.domain.army.takeIf {
    state.baseId != null && state.domain.armyBaseId == state.baseId && state.domain.armyBaseGeneration == generation
}
internal fun researchFinishOffered(army: JsonObject, row: JsonObject): Boolean =
    ((army["features"] as? JsonObject)?.get("researchSpeedupReceipts") as? JsonObject)?.get("version") == JsonPrimitive(1) && row["finishQuote"] is JsonObject
internal fun researchReviewTerms(state: ArmyUiState): ResearchSpeedupIntent? = state.domain.researchReview?.intent?.let {
    runCatching { ResearchSpec.exact(it) }.getOrNull()
}
@Composable private fun ResearchPending(state: ArmyUiState, busy: Boolean, allowed: Boolean, model: ArmyViewModel) {
    val pending = state.interrupted.filter { it.kind == IntentKind.RESEARCH }
    val legacy = pending.filter { it.intent.expectedCurrency == null }
    InterruptedBanner(legacy, busy, model.interrupted.check, model.interrupted.close, model.interrupted.retry)
    pending.filter { it.intent.expectedCurrency != null }.forEach { saved ->
        val terms = runCatching { ResearchSpec.exact(saved.intent) }.getOrNull()
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("SAVED RESEARCH PAYMENT", style = MaterialTheme.typography.titleSmall)
            terms?.let { Text("${trainingTroopLabel(it.troop)} · L${it.currentLevel} → L${it.toLevel} · up to ${fmtN(it.maxCostKeep)} ${it.expectedCurrency}") }
            Text(if (saved.proven) "Original payment confirmed. Refresh current army and balances." else "The original payment is unresolved. Check its receipt before another finish.")
            Text("Kingdom ${saved.intent.baseId ?: "original kingdom"}")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { model.interrupted.check(IntentKind.RESEARCH) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (saved.proven) "REFRESH CURRENT STATE" else "CHECK ORIGINAL RECEIPT") }
                if (!saved.proven && terms != null) TextButton(onClick = model::reviewResearchSaved,
                    enabled = !busy && allowed && state.baseId == saved.intent.baseId, modifier = Modifier.fillMaxWidth()) { Text("REVIEW SAME PAYMENT") }
            }
        } }
    }
}
@Composable internal fun ResearchCurrencyConfirm(state: ArmyUiState, busy: Boolean, allowed: Boolean, model: ArmyViewModel,
    baseGeneration: Long) {
    val reviewed = state.domain.researchReview
    val armedAtMs = remember(reviewed) { System.currentTimeMillis() }
    val gems = researchGemSpendUi(state, baseGeneration, allowed, busy, displayClock(), armedAtMs)
    GemSpendSeal(gems, GemSpendActions(onConfirm = {
        val current = model.state.value
        if (reviewed != null && current.domain.researchReview == reviewed && !model.busy.value && allowed && current.ordersAllowed &&
            researchGemSpendUi(current, baseGeneration, allowed, false, System.currentTimeMillis(), armedAtMs) != null)
            model.confirmResearchFinish()
    }, onBack = model::dismissResearchReview), Modifier.zIndex(PkwTokens.Z.SEAL))
    if (reviewed == null) return
    val terms = researchReviewTerms(state) ?: return
    if (terms.expectedCurrency == gg.pixelkingdomwars.nativeclient.model.GameCurrency.GEMS) return
    AlertDialog(onDismissRequest = model::dismissResearchReview, title = { Text("FINISH RESEARCH") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("${trainingTroopLabel(terms.troop)} · LEVEL ${terms.currentLevel} → ${terms.toLevel}")
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GameArt(if (terms.expectedCurrency.name == "GEMS") "gem" else "keep", Modifier.size(24.dp), terms.expectedCurrency.name)
                Text("Up to ${fmtN(terms.maxCostKeep)} ${terms.expectedCurrency}")
            }
            // Owner 2026-10-06 17:24: player words as the Gems Seal (SealWords.kt); the frozen episode/completion stay in the request.
            Text(gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealKingdomLine(state.home.base, terms.baseId))
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealTimeFromNow(terms.finishesAt, displayClock())?.let { Text("Research completes $it") }
            Text("This payment keeps the reviewed currency and research episode. The charge may decrease as the timer runs.")
            if (reviewed.intent.attempted) Text("Retry the same saved payment and key. No replacement order will be created.")
        } },
        confirmButton = { Button(onClick = model::confirmResearchFinish, enabled = !busy && allowed && state.ordersAllowed) { Text("PAY ${terms.expectedCurrency}") } },
        dismissButton = { TextButton(onClick = model::dismissResearchReview) { Text("CANCEL") } })
}

/** Web army.helpers researchProgress: the server uses the canonical from-level duration. */
private fun researchDisplayProgress(catalogue: JsonObject, target: Int, remaining: Long?): Float? {
    val constants = catalogue["constants"] as? JsonObject
    val leveling = constants?.get("TROOP_LEVELING") as? JsonObject
    val seconds = ((leveling?.get("researchTimeSec") as? JsonArray)?.getOrNull(target - 2) as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    return if (remaining == null || seconds == null) null else (1f - remaining.toFloat() / seconds).coerceIn(0f, 1f)
}

@Composable private fun ResearchChoiceRow(choice: ResearchChoice, portrait: String, researching: Boolean, enabled: Boolean, unlock: TroopUnlock, onStart: () -> Unit) {
    val seconds = choice.seconds
    val reason = when {
        choice.reason == "Forge is researching" -> if (researching) "RESEARCH IN PROGRESS" else "ALCHEMY LAB IS RESEARCHING"
        choice.reason == "Maximum level" -> "MAXIMUM LEVEL"
        // The source-derived writ helper names its acquisition path instead of the wire item id.
        choice.reason?.startsWith("Requires item_") == true -> (unlock as? TroopUnlock.Elite)?.label
            ?: "UNLOCK ${trainingTroopLabel(choice.troop)} FIRST"
        else -> choice.reason
    }
    Card(Modifier.fillMaxWidth()) { Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            GameArt(portrait, Modifier.size(52.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(trainingTroopLabel(choice.troop), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.text)
                Text(if (choice.reason == "Maximum level") "LEVEL ${choice.level}" else "LEVEL ${choice.level} → ${choice.target}", fontSize = 15.sp, lineHeight = 19.sp, color = SurfaceInk.goldHi)
            }
        }
        if (reason != null) Text(reason, fontSize = 15.sp, lineHeight = 19.sp, color = SurfaceInk.muted)
        else if (choice.cost != null && seconds != null) {
            Text("RESEARCH TIME ${fmtDur(seconds)}", fontSize = 15.sp, lineHeight = 19.sp, color = SurfaceInk.muted)
            // Starting research remains the original direct SHARDS spend with its visible cost.
            Button(onClick = onStart, enabled = enabled && choice.reason == null, modifier = Modifier.fillMaxWidth()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("RESEARCH L${choice.target}", fontSize = 17.sp, lineHeight = 21.sp)
                    Text("${fmtN(choice.cost.toString())} SHARDS", fontSize = 17.sp, lineHeight = 21.sp)
                }
            }
        }
    } }
}
