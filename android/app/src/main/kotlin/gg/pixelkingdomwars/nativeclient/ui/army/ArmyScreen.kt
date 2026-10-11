@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.army

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip
import gg.pixelkingdomwars.nativeclient.ui.chrome.DropdownMenu
import gg.pixelkingdomwars.nativeclient.ui.chrome.DropdownMenuItem
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedTextField
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput

import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.data.ReviewedQuote
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.PaidTrainingFinishIntent
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.TrainingFinishSpec
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.trainingFinishGemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendSeal
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.coroutines.flow.first

internal fun trainingTroopLabel(troop: String) = Copy.troopName(troop)
/** Source ui/icons.ts troopPortrait: only a real server level selects a levelled portrait.
 * Tier bounds come from the same exported ART_V2 constants as the current web renderer. */
internal fun armyPortrait(catalogue: JsonObject?, troop: String, level: Int?): String {
    val art = ((catalogue?.get("constants") as? JsonObject)?.get("ART_V2") as? JsonObject)
    val roots = (art?.get("troops") as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty()
    if (troop !in roots && troop != "wyrmling") return "trp_${troop}_portrait"
    val tiers = art?.string("tiers")?.toIntOrNull()?.takeIf { it > 0 }
    val perTier = art?.string("levelsPerTier")?.toIntOrNull()?.takeIf { it > 0 }
    val tier = if (level == null || tiers == null || perTier == null) 1
        else (((level.coerceAtLeast(1).toLong() - 1) / perTier) + 1).coerceAtMost(tiers.toLong()).toInt()
    return "ui_portrait_${troop}_t$tier"
}

/** A troop's training time as the cell prints it: whole seconds through the shared fmtDur ("12s", "1m 30s"),
 * a fractional pack value verbatim ("7.5s") — never rounded up into a time the server does not charge. */
internal fun troopTrainTime(trainSec: Double): String =
    if (trainSec == Math.floor(trainSec)) fmtDur(trainSec.toLong()) else "${trainSec}s"

/** The cell's one price line (web TrainTray "⟡12 · 2P" plus the Codex time): "12 SHARDS · 12s". `costKeep` is
 * a SHARD price under its pre-split name; null when the pack does not price the troop, so the cell says "—"
 * instead of inventing a number. */
internal fun troopCostLine(catalogue: JsonObject?, troop: String): String? {
    val stats = troopStats(catalogue, troop) ?: return null
    val cost = stats.string("costKeep") ?: return null
    val time = stats.string("trainSec")?.toDoubleOrNull()?.let { troopTrainTime(it) }
    return "${fmtN(cost)} SHARDS" + (time?.let { " · $it" } ?: "")
}

/** The cell's stat line (web TrainTray): HP/DMG only at a REAL server level (scaled by the pack's
 * `TROOP_LEVELING.statMultPerLevel`, rounded like the web), SPD/RNG unleveled, then the population points. */
internal fun troopCellStats(catalogue: JsonObject?, troop: String, level: Int?): String? {
    val stats = troopStats(catalogue, troop) ?: return null
    val mult = ((catalogue?.get("constants") as? JsonObject)?.get("TROOP_LEVELING") as? JsonObject)?.string("statMultPerLevel")?.toDoubleOrNull()
    val parts = mutableListOf<String>()
    if (level != null && mult != null) {
        val scale = Math.pow(mult, (level - 1).toDouble())
        parts += "HP ${Math.round((stats.string("hp")?.toDoubleOrNull() ?: 0.0) * scale)} · DMG ${Math.round((stats.string("dps")?.toDoubleOrNull() ?: 0.0) * scale)}"
    }
    parts += "SPD ${stats.string("speedTilesPerSec") ?: "—"} · RNG ${stats.string("range")?.let { if (it == "melee") "M" else it } ?: "—"}"
    troopPoints(catalogue, troop)?.let { parts += "$it PTS" }
    return parts.joinToString(" · ")
}

private fun epoch(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
private val TRAINING_KINDS = setOf(IntentKind.TRAINING_BATCH, IntentKind.TRAINING_CANCEL, IntentKind.TRAINING_FINISH)

/** Army tab (web screens/army.tsx TrainTray + ArmyRoster + ArmyScreen, trainingPresets.tsx): the base-wide
 * readiness header, saved armies and the previous-attack retrain, the sequential queue with FINISH ALL and
 * the tap-tap-tap −1 chips, the capacity lines, the TRAIN cards and the roster. Every price is a catalogue
 * lookup or a server figure; the server re-validates every POST. */
@Composable fun ArmyScreen(model: ArmyViewModel, keepConfirm: KeepConfirmPreference, requests: HomeRequests, onBack: () -> Unit = {},
    baseGeneration: Long = 0, actionsAllowed: Boolean = true, recoveryOnly: Boolean = false, onOpenResearch: () -> Unit) {
    val state by model.state.collectAsState()
    val actionBusy by model.busy.collectAsState()
    val busy = actionBusy || state.domain.loading
    val notice by model.notice.collectAsState()
    val now = displayClock()
    val army = trainingCurrentArmy(state, baseGeneration)
    var infoTroop by remember { mutableStateOf<String?>(null) }
    val request by requests.pending.collectAsState()
    // A queued Barracks/objective request survives the Home tab switch and is consumed only here.
    // Ordinary ARMY entry still opens ready troops; entering training never buys or clears a draft.
    var rosterOpen by remember { mutableStateOf(request != HomeRequest.Training) }
    var reviewHeight by remember { mutableStateOf(104.dp) }
    val density = LocalDensity.current.density
    LaunchedEffect(request) {
        if (!recoveryOnly && request == HomeRequest.Training) { rosterOpen = false; requests.consume(HomeRequest.Training) }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) model.dismissTrainingFinishReview() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismissTrainingFinishReview() }
    }
    LaunchedEffect(model, lifecycle, state.wallet, state.baseId, baseGeneration, actionsAllowed, state.ordersAllowed) {
        model.dismissTrainingFinishReview()
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.busy.first { !it }
            model.refreshTrainingFinish()?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    // Web TrainTray auto-refetch: when the in-progress unit finishes the queue advances without a tap
    // (the server completes training lazily); an already-elapsed head retries shortly.
    val headFinish = if (recoveryOnly) null else army?.queue?.firstOrNull()?.finishesAt
    LaunchedEffect(headFinish) {
        val end = epoch(headFinish) ?: return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            kotlinx.coroutines.delay(if (end <= System.currentTimeMillis()) 2_000 else end - System.currentTimeMillis() + 1_500)
            model.busy.first { !it }
            model.refreshTrainingFinish()?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    val otherDialog = !recoveryOnly && (state.domain.reviewed != null || state.presetDraft != null)
    BackHandlerAt(BackPriority.SHEET, enabled = otherDialog || state.domain.trainingFinishReview != null) {
        when { state.domain.trainingFinishReview != null -> model.dismissTrainingFinishReview(); state.presetDraft != null -> model.cancelEditing(); else -> model.dismissQuote() }
    }
    BackHandlerAt(BackPriority.SCREEN, !otherDialog && state.domain.trainingFinishReview == null) { model.dismissTrainingFinishReview(); onBack() }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val pinnedReview = maxHeight >= 420.dp && LocalDensity.current.fontScale <= 1.3f
    // The primary TRAIN control: one gold Button that opens the server quote (REVIEW TRAINING → ADD TO QUEUE);
    // nothing is bought until the quote is confirmed, so the selection rides on the plate as its second line.
    val reviewContent: @Composable () -> Unit = {
        Button(onClick = model::quote, enabled = !busy && state.composerEnabled && state.draftUnits > 0, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)) {
            GameArt("army", Modifier.size(24.dp))
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("REVIEW TRAINING", style = MaterialTheme.typography.labelLarge)
                Text("${state.draftUnits} SELECTED${state.room?.draftPts?.let { " · $it POPULATION" } ?: ""}", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
    // The pinned REVIEW TRAINING plate is the designed page's footer (the sheet's one primary), not a bar over its frame.
    DesignedPage(if (recoveryOnly) "TRAINING PAYMENT" else if(rosterOpen) "ARMY" else "TRAIN TROOPS", { model.dismissTrainingFinishReview(); onBack() },
        footer = if (!recoveryOnly && !rosterOpen && army != null && pinnedReview) ({ reviewContent() }) else null) {
        if (!recoveryOnly) PixelPlate("bar", Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(!rosterOpen, { rosterOpen = false }, label = { Text("TRAIN") })
                FilterChip(rosterOpen, { rosterOpen = true }, label = { Text("ARMY") })
            }
        }
        // The base-wide readiness the /base read already carries: capacity figures, never a raid verdict (D-094).
        if (!recoveryOnly && rosterOpen) state.home.base?.armyStatus?.let { status ->
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                FlowRow(horizontalArrangement=Arrangement.spacedBy(16.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                    Text("${status.readyTroopCount} READY", style = MaterialTheme.typography.titleSmall, color=SurfaceInk.goldHi)
                    Text("${status.trainingTroopCount} TRAINING", style = MaterialTheme.typography.labelMedium, color=SurfaceInk.muted)
                }
                ArmyMeter("READY ARMY",status.readyPts,status.campCapacityPts)
            } }
        }
        notice?.let { Notice(it.message, it.error, model::dismissNotice) }
        state.domain.error?.takeIf { notice == null }?.let { Notice(it, error = true, onDismiss = model::clearNotice) }
        state.domain.message?.let { Notice(it, onDismiss = model::clearNotice) }
        if (busy || state.domain.loading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = SurfaceInk.gold)
        TrainingFinishPending(state, busy, actionsAllowed, recoveryOnly, model)
        if (recoveryOnly) {
            if (!busy && notice == null && state.interrupted.none { it.kind == IntentKind.TRAINING_FINISH && it.intent.wallet == state.wallet }) Text("No saved training payment is waiting for recovery.")
            TextButton(onClick = model::refreshTrainingFinish, enabled = !busy) { Text("CHECK SAVED PAYMENT") }
            return@DesignedPage
        }
        if (state.interrupted.any { it.kind == IntentKind.RESEARCH })
            TextButton(onClick = onOpenResearch, modifier = Modifier.fillMaxWidth()) { Text("CHECK RESEARCH PAYMENT") }
        if (army == null) { if (!busy) TextButton(onClick = model::refreshTrainingFinish) { Text(if (state.baseId == null) "CHECK SAVED PAYMENT" else "RETRY ARMY") }; return@DesignedPage }
        when (state.domain.scheduling) {
            // A gate, not a failure: the app needs an update before it can train.
            TrainingScheduling.UNSUPPORTED -> Text("Training requires a compatible app update. Existing troops and training are preserved.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.gold)
            else -> {}
        }
        if (!rosterOpen) {
        if (army.freeFinishAllReviewRequired) Text("YOUR FREE FINISH ELIGIBILITY REQUIRES REVIEW. YOUR TROOPS STILL TRAIN NORMALLY.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        TrainQueue(state, army, now, busy, actionsAllowed, model)
        CapacityLines(state, army, busy, model)
        TrainingPresets(state, busy, model)
        TrainCards(state, army, busy, model)
        } else ArmyRoster(state, army, infoTroop) { infoTroop = if (infoTroop == it) null else it }
        OutlinedButton(onClick = onOpenResearch,modifier=Modifier.fillMaxWidth()) { GameArt("energy", Modifier.size(20.dp)); Text("OPEN ALCHEMY LAB") }
        if (!rosterOpen) {
            if (!pinnedReview) reviewContent()
        }
    }
    }
    if (!recoveryOnly) {
        state.domain.reviewed?.let { reviewed -> ReviewTrainingDialog(reviewed, busy || state.trainingBlocked, onConfirm = model::confirmTraining, onDismiss = model::dismissQuote) }
        state.presetDraft?.let { draft -> PresetEditorDialog(draft, state, busy, model) }
    }
    TrainingFinishCurrencyConfirm(state, busy, actionsAllowed, baseGeneration, model)
}

/** Current display and payment review must belong to this selection, including an A-to-B-to-A change. */
internal fun trainingCurrentArmy(state: ArmyUiState, generation: Long) = state.domain.army.takeIf {
    state.baseId != null && state.domain.armyBaseId == state.baseId && state.domain.armyBaseGeneration == generation
}
internal fun trainingFinishOffered(army: JsonObject): Boolean =
    ((army["features"] as? JsonObject)?.get("trainingFinishReceipts") as? JsonObject)?.get("version") == JsonPrimitive(1) &&
        army["finishAllQuote"] is JsonObject && army["freeFinishAllOffer"] == JsonNull && army["freeFinishAllReviewRequired"] == JsonPrimitive(false)
internal fun modernTrainingFinish(intent: PendingIntent): Boolean =
    intent.expectedCurrency != null || intent.quote?.containsKey("paidTrainingFinish") == true
internal fun trainingFinishReviewTerms(state: ArmyUiState): PaidTrainingFinishIntent? = state.domain.trainingFinishReview?.intent?.let {
    runCatching { TrainingFinishSpec.exact(it) }.getOrNull()
}
@Composable private fun TrainingFinishPending(state: ArmyUiState, busy: Boolean, allowed: Boolean, recoveryOnly: Boolean, model: ArmyViewModel) {
    val pending = state.interrupted.filter { it.intent.wallet == state.wallet && it.kind in TRAINING_KINDS && (!recoveryOnly || it.kind == IntentKind.TRAINING_FINISH) }
    InterruptedBanner(pending.filter { it.kind != IntentKind.TRAINING_FINISH || !modernTrainingFinish(it.intent) },
        busy, model.interrupted.check, model.interrupted.close, model.interrupted.retry)
    pending.filter { it.kind == IntentKind.TRAINING_FINISH && modernTrainingFinish(it.intent) }.forEach { saved ->
        val terms = runCatching { TrainingFinishSpec.exact(saved.intent) }.getOrNull()
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("SAVED TRAINING PAYMENT", style = MaterialTheme.typography.titleSmall)
            terms?.let { Text("${it.queue.size} training slots · up to ${fmtN(it.maxCostKeep)} ${it.expectedCurrency}") }
            Text(if (saved.proven) "Original payment confirmed. Refresh current army and balances." else "The original payment is unresolved. Check its receipt before another finish.")
            Text("Kingdom ${saved.intent.baseId ?: "original kingdom"}")
            Button(onClick = { model.interrupted.check(IntentKind.TRAINING_FINISH) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (saved.proven) "REFRESH CURRENT STATE" else "CHECK ORIGINAL RECEIPT")
            }
            if (!saved.proven && terms != null) TextButton(onClick = model::reviewTrainingFinishSaved,
                enabled = !busy && allowed && state.ordersAllowed && state.baseId != null && state.baseId == saved.intent.baseId,
                modifier = Modifier.fillMaxWidth()) { Text("REVIEW SAME PAYMENT") }
        } }
    }
}
@Composable internal fun TrainingFinishCurrencyConfirm(state: ArmyUiState, busy: Boolean, allowed: Boolean, generation: Long, model: ArmyViewModel) {
    val armedAtMs = remember(state.domain.trainingFinishReview, state.wallet, state.baseId, generation) { System.currentTimeMillis() }
    val gems = trainingFinishGemSpendUi(state, generation, busy, allowed, displayClock(), armedAtMs)
    // Keep the nullable mount alive through dismissal so the designed Seal finishes its exit animation.
    // All confirmation and saved-payment recovery still go through the original reviewed owner.
    GemSpendSeal(gems, GemSpendActions(onConfirm = { model.confirmTrainingFinish() }, onBack = model::dismissTrainingFinishReview),
        Modifier.zIndex(PkwTokens.Z.SEAL))
    val reviewed = state.domain.trainingFinishReview ?: return
    val terms = trainingFinishReviewTerms(state) ?: return
    if (reviewed.intent.wallet != state.wallet || state.baseId == null || terms.baseId != state.baseId || reviewed.generation != generation) return
    if (terms.expectedCurrency == gg.pixelkingdomwars.nativeclient.model.GameCurrency.GEMS) return
    AlertDialog(onDismissRequest = model::dismissTrainingFinishReview, title = { Text("FINISH ALL TRAINING") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GameArt(if (terms.expectedCurrency.name == "GEMS") "gem" else "keep", Modifier.size(24.dp), terms.expectedCurrency.name)
                Text("Up to ${fmtN(terms.maxCostKeep)} ${terms.expectedCurrency}")
            }
            // Owner 2026-10-06 17:24: the same player words as the Gems Seal (trainingFinishConsentLines); the frozen rows stay in the request.
            gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.trainingFinishConsentLines(terms, reviewed.intent.attempted, state.home.base,
                displayClock(), "the shown currency").forEach { Text(it) }
        } },
        confirmButton = { Button(onClick = model::confirmTrainingFinish, enabled = !busy && allowed && state.ordersAllowed) { Text("PAY ${terms.expectedCurrency}") } },
        dismissButton = { TextButton(onClick = model::dismissTrainingFinishReview) { Text("CANCEL") } })
}

/** Web trainingPresets.tsx: REVIEW TRAINING (the manual draft), RETRAIN PREVIOUS ARMY, SAVED ARMIES (three
 * slots with PREVIEW / EDIT). Saved armies are wallet plans; every use goes through the server quote. */
@Composable private fun TrainingPresets(state: ArmyUiState, busy: Boolean, model: ArmyViewModel) {
    val blocked = busy || !state.composerEnabled
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
        OutlinedButton(onClick = model::retrainPrevious, enabled = !blocked,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) { GameArt("replay", Modifier.size(18.dp)); Text("RETRAIN PREVIOUS ARMY", style = MaterialTheme.typography.labelMedium) }
        TextButton(onClick = model::togglePresets, enabled = !blocked,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) { Text(if(state.presetsOpen) "HIDE SAVED ARMIES" else "SAVED ARMIES", style = MaterialTheme.typography.labelMedium) }
    }
    if (state.presetsOpen) Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text("Adds troops to this base. Saved armies are shared across your owned bases.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        val rules = state.presetRules
        // A missing pack rule is a gate ("update the game"), not a failure.
        if (rules == null) Text("Saved armies need a game content update.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.gold)
        else (1..rules.slots).forEach { slot ->
            val preset = state.domain.presets?.firstOrNull { it.slot == slot }
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(10.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                Text("$slot. ${preset?.name ?: "EMPTY SLOT"}",color=SurfaceInk.goldHi, style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                    if (preset != null) Button(onClick = { model.previewPreset(slot) }, enabled = !blocked) { Text("PREVIEW") }
                    OutlinedButton(onClick = { model.editPreset(slot) }, enabled = !busy) { Text("EDIT") }
                }
            } }
        }
    }
}

/** The queue keeps its live timer and cancellation chips; paid finish opens the server's exact review. */
@Composable private fun TrainQueue(state: ArmyUiState, army: ArmyState, now: Long, busy: Boolean, actionsAllowed: Boolean, model: ArmyViewModel) {
    if (army.queue.isEmpty()) return
    val head = army.queue.first()
    val start = epoch(head.startedAt); val end = epoch(head.finishesAt)
    val remSec = end?.let { ((it - now + 999).floorDiv(1000)).coerceAtLeast(0) } ?: 0
    val waiting = start != null && start > now
    val free = army.freeFinishAllOffer
    val paid = trainingFinishOffered(army.raw)
    val finishAll: () -> Unit = {
        if (free != null) model.finishAll(free = true)
        else model.reviewTrainingFinish()
    }
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(10.dp),verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("TRAINING QUEUE", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi)
        PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(8.dp)) { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GameArt(armyPortrait(state.catalogue,head.troop,army.levels[head.troop]),Modifier.size(44.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(trainingTroopLabel(head.troop),style=MaterialTheme.typography.titleSmall,color=SurfaceInk.text)
                    Text(if(waiting) "WAITING" else if(remSec>0) "TRAINING" else "COMPLETING", style = MaterialTheme.typography.labelSmall, color=SurfaceInk.muted)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    GameArt("timer", Modifier.size(18.dp))
                    Text(if (waiting) "STARTS IN ${fmtDur(((start!! - now + 999).floorDiv(1000)))}" else if (remSec > 0) fmtDur(remSec) else "DONE", style = MaterialTheme.typography.labelLarge, color = SurfaceInk.goldHi)
                }
            }
            baseJobProgress(head.startedAt, head.finishesAt, now)?.let { LinearProgressIndicator(progress = { it.fraction }, modifier = Modifier.fillMaxWidth()) }
        } }
        Button(onClick = finishAll, enabled = !busy && !state.trainingBlocked && state.composerEnabled && actionsAllowed && (free != null || paid),modifier=Modifier.fillMaxWidth().heightIn(min = 56.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
            GameArt("energy", Modifier.size(22.dp))
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (free != null) "FINISH ALL" else "REVIEW FINISH PRICE", style = MaterialTheme.typography.labelLarge)
                Text(if (free != null) "FREE" else "WHOLE TRAINING QUEUE", style = MaterialTheme.typography.labelSmall)
            }
        }
        if (free == null && !paid) Text("Paid finish needs a current compatible server quote. Your troops still train normally.", style = MaterialTheme.typography.bodySmall)
        if (free != null) Text("ONE FREE FINISH FOR YOUR FIRST ARMY · NO KEEP NEEDED", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.gold)
        val waitingCount = army.queue.count { row -> epoch(row.startedAt)?.let { it > now } == true }
        FlowRow(horizontalArrangement=Arrangement.spacedBy(12.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
            Text("ALL READY IN ${fmtDur(queueRemainingSec(army.queue, now))}", style = MaterialTheme.typography.labelMedium, color=SurfaceInk.goldHi)
            Text("$waitingCount WAITING", style = MaterialTheme.typography.labelMedium, color=SurfaceInk.muted)
        }
        if(army.queue.any {it.scheduleVersion!=2})Text("Earlier training keeps its original timers.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
        // Every row — head included — grouped by troop, counting only rows no tap has spoken for (×0 stays put through a burst).
        val grouped = LinkedHashMap<String, Int>()
        army.queue.forEach { grouped[it.troop] = (grouped[it.troop] ?: 0) + (if (it.id in state.pendingCancelIds) 0 else 1) }
        // The queue as a strip of portraits with counts; a refundable tile is the −1 tap (D-096 tap-tap-tap).
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            grouped.forEach { (troop, count) ->
                val refundable = trainingCancelTarget(army.queue, troop)
                val next = refundable?.let { nextTrainingCancelTarget(army.queue, troop, state.pendingCancelIds) }
                val refund = refundable?.let { (next ?: it).refundShards }
                QueueTile(armyPortrait(state.catalogue, troop, army.levels[troop]), trainingTroopLabel(troop), count, refund,
                    enabled = refundable != null && !state.trainingBlocked && state.composerEnabled) { model.cancelOne(troop) }
            }
        }
        if (army.queue.any { !it.canCancel }) Text("PRE-UPDATE TRAINING FINISHES NORMALLY · NO ESTIMATED REFUNDS", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
    } }
}

/** One troop type in the queue: its portrait and count on a shard plate; where the server quotes a refund the
 * tile is the −1 tap and says what comes back. Never disabled mid-burst by `busy` (a swallowed tap is the bug). */
@Composable private fun QueueTile(portrait: String, name: String, count: Int, refund: String?, enabled: Boolean, onCancelOne: () -> Unit) {
    val description = if (refund != null) "$name ×$count, cancel one for ${fmtN(refund)} shards" else "$name ×$count in queue"
    PixelPlate("shard", Modifier.widthIn(min = 76.dp).heightIn(min = 56.dp).alpha(if (refund == null || enabled) 1f else .6f)
        .semantics { contentDescription = description }
        .then(if (refund != null) Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onCancelOne) else Modifier), PaddingValues(horizontal = 6.dp, vertical = 4.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                GameArt(portrait, Modifier.size(30.dp))
                Text("×$count", style = MaterialTheme.typography.labelLarge, color = if (count > 0) SurfaceInk.goldHi else SurfaceInk.muted)
            }
            Text(refund?.let { "−1 · +${fmtN(it)}" } ?: "IN QUEUE", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted, maxLines = 1, softWrap = false)
        }
    }
}

@Composable private fun CapacityLines(state: ArmyUiState, army: ArmyState, busy: Boolean, model: ArmyViewModel) {
    val queuedPts = state.room?.queuePts ?: army.queuedPts
    var detailsOpen by remember(state.baseId) { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
        ArmyMeter("ARMY CAPACITY",army.rosterPts+queuedPts,army.campCapacityPts)
        ArmyMeter("TRAINING QUEUE",queuedPts,army.barracksQueuePts)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { detailsOpen = !detailsOpen }, modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp)) {
                Text(if (detailsOpen) "− CAPACITY DETAILS" else "+ CAPACITY DETAILS", style = MaterialTheme.typography.labelSmall)
            }
            TextButton(onClick=model::refresh,enabled=!busy,contentPadding=PaddingValues(horizontal=8.dp,vertical=4.dp)) {Text("REFRESH", style = MaterialTheme.typography.labelSmall)}
        }
        if (detailsOpen) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${army.rosterPts} ready + $queuedPts queued population", style = MaterialTheme.typography.bodySmall, color=SurfaceInk.muted)
            Text("Troops use population in the Camp and training queue.", style = MaterialTheme.typography.bodySmall, color=SurfaceInk.muted)
        }
    } }
}

@Composable private fun ArmyMeter(label:String,used:Int,capacity:Int,detail:String?=null) {
    Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
        FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalArrangement=Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color=SurfaceInk.muted)
            Text("$used / $capacity PTS", style = MaterialTheme.typography.labelSmall, color=SurfaceInk.text)
        }
        if(capacity>0)LinearProgressIndicator((used.toFloat()/capacity).coerceIn(0f,1f),Modifier.fillMaxWidth())
        detail?.let {Text(it, style = MaterialTheme.typography.labelSmall, color=SurfaceInk.muted)}
    }
}

/** The Barracks TRAIN cards (web TrainTray): pack order, levelled HP/DMG, cost and points, the writ / rollout
 * lock or the capacity reason, and a −/count/+ stepper. Taps change only the local draft. */
@Composable private fun TrainCards(state: ArmyUiState, army: ArmyState, busy: Boolean, model: ArmyViewModel) {
    val catalogue = state.catalogue
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text("SELECT TROOPS", style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi)
        Text("Tap a troop to add one. Nothing is bought until you confirm the review.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
    }
    TroopGrid(state.trainTable) { troop, modifier ->
        val unlock = state.unlock(troop); val rollout = state.rollout(troop)
        val locked = unlock.locked || rollout.locked
        val count = state.quantities[troop]?.toIntOrNull() ?: 0
        val reason = state.capacityReason(troop)
        val level = army.levels[troop]
        val canAdd = !busy && !locked && reason == null && state.composerEnabled
        val name = trainingTroopLabel(troop)
        PixelPlate("shard", modifier.then(if (count > 0) Modifier.border(2.dp, SurfaceInk.gold) else Modifier)
            .semantics { selected = count > 0; contentDescription = "$name, $count selected" }
            .clickable(enabled = canAdd, role = Role.Button) { model.selectOne(troop) }, PaddingValues(8.dp)) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GameArt(armyPortrait(catalogue, troop, level), Modifier.size(48.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(name, style = MaterialTheme.typography.titleSmall, color = if (count > 0) SurfaceInk.goldHi else SurfaceInk.text)
                            level?.let { Text("L$it", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.goldHi) }
                        }
                        when {
                            rollout.locked -> Text(rollout.message.orEmpty(), style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
                            // The unlock path is a gate, not a failure: gold names what opens it (web goldHi).
                            unlock is TroopUnlock.Elite -> Text(unlock.label, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.gold)
                            unlock is TroopUnlock.Keep -> Text(unlock.label, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.gold)
                            else -> Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                GameArt("shards", Modifier.size(14.dp))
                                Text(troopCostLine(catalogue, troop) ?: "—", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi, maxLines = 1)
                            }
                        }
                    }
                }
                troopCellStats(catalogue, troop, level)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted) }
                if (!locked && reason != null) Text(reason.label, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
                TroopStepper(count, canRemove = !busy && count > 0, canAdd = canAdd, name = name,
                    onRemove = { model.selectOne(troop, -1) }, onAdd = { model.selectOne(troop) })
            }
        }
    }
}

/** −1 / count / +1 on one row, each end a 48dp target; the count is the selection the review will quote. */
@Composable private fun TroopStepper(count: Int, canRemove: Boolean, canAdd: Boolean, name: String, onRemove: () -> Unit, onAdd: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = onRemove, enabled = canRemove, modifier = Modifier.size(48.dp).semantics { contentDescription = "Remove one $name" },
            contentPadding = PaddingValues(0.dp)) { Text("−", style = MaterialTheme.typography.titleMedium) }
        Box(Modifier.weight(1f).heightIn(min = 48.dp).background(SurfaceInk.well).border(1.dp, if (count > 0) SurfaceInk.gold else SurfaceInk.ruleLt), contentAlignment = Alignment.Center) {
            Text(count.toString(), style = MaterialTheme.typography.titleMedium, color = if (count > 0) SurfaceInk.goldHi else SurfaceInk.muted, textAlign = TextAlign.Center)
        }
        Button(onClick = onAdd, enabled = canAdd, modifier = Modifier.size(48.dp).semantics { contentDescription = "Add one $name" },
            contentPadding = PaddingValues(0.dp)) { Text("+", style = MaterialTheme.typography.titleMedium) }
    }
}

/** The page owns scrolling. A simple responsive grid keeps all troops reachable in the same direction. */
@Composable private fun TroopGrid(troops: List<String>, content: @Composable (String, Modifier) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = when {
            maxWidth < 320.dp || LocalDensity.current.fontScale > 1.3f -> 1
            maxWidth >= 700.dp -> 3
            else -> 2
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            troops.chunked(columns).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { troop -> content(troop, Modifier.weight(1f)) }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

/** Web ArmyRoster: every troop names itself, a gold border marks what you have, a tap shows the Codex prose. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun ArmyRoster(state: ArmyUiState, army: ArmyState, infoTroop: String?, onInfo: (String) -> Unit) {
    Text("ROSTER", style = MaterialTheme.typography.titleSmall, color = SurfaceInk.gold)
    TroopGrid(state.trainTable) { troop, modifier ->
        val n = army.counts[troop] ?: 0
        PixelPlate("shard", modifier.then(if (infoTroop == troop || n > 0) Modifier.border(2.dp, SurfaceInk.gold) else Modifier)
            .semantics { selected = infoTroop == troop }.clickable(role = Role.Button) { onInfo(troop) }, PaddingValues(8.dp)) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    GameArt(armyPortrait(state.catalogue, troop, army.levels[troop]), Modifier.size(48.dp))
                    Column(Modifier.weight(1f)) {
                        Text("×$n", style = MaterialTheme.typography.titleMedium, color = if (n > 0) SurfaceInk.goldHi else SurfaceInk.muted)
                        army.levels[troop]?.let { Text("LEVEL $it", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted) }
                    }
                }
                Text(trainingTroopLabel(troop), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.text)
                Text(if (infoTroop == troop) "HIDE DETAILS" else "TROOP DETAILS", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
            }
        }
    }
    infoTroop?.let { troop ->
        val entry = CodexData.troop(state.catalogue, troop)
        Column(Modifier.fillMaxWidth().background(SurfaceInk.card).border(2.dp, SurfaceInk.muted).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(trainingTroopLabel(troop), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.gold)
            if (entry != null) { Text(entry.who, style = MaterialTheme.typography.bodySmall); entry.strat?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) } }
            else Text("Field reports on this troop are still being written. Its numbers in the Barracks are live.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        }
    }
    Text("ARMY ${army.rosterPts}/${army.campCapacityPts} PTS · LIVES HERE BETWEEN RAIDS", style = MaterialTheme.typography.bodyMedium, color = SurfaceInk.muted)
}

/** Web REVIEW TRAINING (trainingPresets.tsx): what was requested, what queues, the remainder and its reason,
 * SHARDS / CAMP / BARRACKS after the purchase, the sequential window, ADD TO QUEUE · n · cost SHARDS. */
@Composable fun ReviewTrainingDialog(reviewed: ReviewedQuote, busy: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val quote = reviewed.quote; val schedule = reviewed.schedule
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("REVIEW TRAINING") },
        text = { Column(Modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Additional troops for this base. Only the listed queueable troops will be purchased.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            Column(Modifier.fillMaxWidth().border(2.dp, SurfaceInk.gold).padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("TRAINING COST", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    GameArt("shards", Modifier.size(22.dp))
                    Text("${fmtN(quote.costShards)} SHARDS", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
                }
                Text("${quote.availableShards?.let { fmtN(it) } ?: "—"} SHARDS AVAILABLE", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
            }
            quote.requested.forEach { row ->
                val accepted = quote.queueable.firstOrNull { it.troop == row.troop }?.count ?: 0
                val rest = quote.remaining.firstOrNull { it.troop == row.troop }
                Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(trainingTroopLabel(row.troop), style = MaterialTheme.typography.titleSmall, color = SurfaceInk.text)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("REQUESTED ${row.count}", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.muted)
                        Text("QUEUE $accepted", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi)
                    }
                    rest?.let { Text("REMAINING ${it.count} · ${it.reason.orEmpty()}", color = SurfaceInk.gold, style = MaterialTheme.typography.labelSmall) }
                } }
            }
            quote.camp?.let { ArmyMeter("ARMY AFTER TRAINING", it.after, it.capacity, "${it.used} → ${it.after} population") }
            quote.barracks?.let { ArmyMeter("QUEUE AFTER PURCHASE", it.after, it.capacity, "${it.used} → ${it.after} population") }
            if (quote.queueable.isNotEmpty()) Text("ALL READY IN ${fmtDur(quote.completionSec?.toBigDecimalOrNull()?.setScale(0, java.math.RoundingMode.CEILING)?.toLong() ?: 0)}", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi)
            else Text("NO TROOPS AVAILABLE TO QUEUE", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.muted)
            if (schedule != null && quote.queueable.isNotEmpty()) {
                Text("WAIT ${fmtDur((schedule.waitMs + 999) / 1000)} · TRAIN ${fmtDur((schedule.durationMs + 999) / 1000)}", style = MaterialTheme.typography.labelMedium)
                (schedule.consent["unitDurations"] as? JsonArray)?.firstOrNull()?.let { first ->
                    (first as? JsonObject)?.get("durationMs")?.jsonPrimitive?.content?.toLongOrNull()?.let { Text("NEXT TROOP IN ${fmtDur((schedule.waitMs + it + 999) / 1000)}", style = MaterialTheme.typography.labelMedium) }
                }
                Text("STARTS ${schedule.startsAt}\nFINISHES ${schedule.finishesAt}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
            }
            if (quote.remaining.isNotEmpty()) Text("The remainder will not train automatically. Preview it again when you have room or SHARDS.", color = SurfaceInk.gold, style = MaterialTheme.typography.bodySmall)
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        } },
        confirmButton = { Button(onClick = onConfirm, enabled = !busy && quote.queueable.isNotEmpty(), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("ADD TO QUEUE", style = MaterialTheme.typography.labelLarge)
                Text("${quote.unitCount} TROOPS · ${fmtN(quote.costShards)} SHARDS", style = MaterialTheme.typography.labelSmall)
            }
        } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("CLOSE") } })
}

/** Web "SAVED ARMY n" editor: a name, ordered rows with counts, ↑ ↓ ×, ADD TROOP…, SAVE / DELETE PRESET / CANCEL. */
@Composable private fun PresetEditorDialog(draft: PresetDraft, state: ArmyUiState, busy: Boolean, model: ArmyViewModel) {
    val rules = state.presetRules
    var adding by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { if (!busy) model.cancelEditing() }, title = { Text("SAVED ARMY ${draft.slot}") },
        text = { Column(Modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = draft.name, onValueChange = { if (rules == null || it.length <= rules.nameMaxLength) model.editName(it) }, label = { Text("Army preset name") }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            Text("Additional troops, filled in this order. Saving spends nothing.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            draft.composition.forEachIndexed { index, row ->
                Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        GameArt(armyPortrait(state.catalogue, row.troop, state.domain.army?.levels?.get(row.troop)), Modifier.size(28.dp))
                        Text("${index + 1}. ${trainingTroopLabel(row.troop)}", style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi)
                    }
                    OutlinedTextField(value = row.count.toString(), onValueChange = { text -> text.toIntOrNull()?.let { model.editCount(index, it) } ?: if (text.isEmpty()) model.editCount(index, 0) else Unit },
                        label = { Text("TROOP COUNT") }, singleLine = true, enabled = !busy,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(onClick = { model.moveRow(index, -1) }, enabled = !busy && index > 0,
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) { Text("↑ UP", style = MaterialTheme.typography.labelSmall) }
                        OutlinedButton(onClick = { model.moveRow(index, 1) }, enabled = !busy && index < draft.composition.lastIndex,
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)) { Text("↓ DOWN", style = MaterialTheme.typography.labelSmall) }
                        TextButton(onClick = { model.removeRow(index) }, enabled = !busy) { Text("REMOVE", style = MaterialTheme.typography.labelSmall) }
                    }
                } }
            }
            val addable = state.trainTable.filter { troop -> draft.composition.none { it.troop == troop } }
            Box { OutlinedButton(onClick = { adding = true }, enabled = !busy && addable.isNotEmpty()) { Text("ADD TROOP…") }
                DropdownMenu(expanded = adding, onDismissRequest = { adding = false }) { addable.forEach { troop -> DropdownMenuItem(text = { Text(trainingTroopLabel(troop)) }, onClick = { adding = false; model.addRow(troop) }) } } }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        } },
        confirmButton = { FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = model::savePreset, enabled = !busy && draft.name.isNotBlank() && draft.composition.isNotEmpty() && rules != null) { Text("SAVE") }
            if (draft.existing) TextButton(onClick = model::deletePreset, enabled = !busy) { Text("DELETE PRESET") }
        } },
        dismissButton = { TextButton(onClick = model::cancelEditing, enabled = !busy) { Text("CANCEL") } })
}
