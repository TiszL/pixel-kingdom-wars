package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Workshop › INGOTS (craft/SPEC.md §2.5, workshop-ingots.png idle, workshop-ready.png collect): the
 * AllowanceCard (TODAY / HOLDING), the HeldCard with GO to the Gold Forge, the casting bench (empty, casting, cooled),
 * and the CAST stepper or the COLLECT primary. Forge Ingots are the one Workshop job with a real server collect: COLLECT
 * runs gold → "Collecting" → moss COLLECTED only after the receipt, then the held count counts up (SPEC §2.5).
 *
 * Pointer rule: drawn inside the Workshop sheet's painted panel; only the GO, steppers and the primary take touches.
 */

/** Ingots held and on the way (SPEC §2.5 `inventory{held, pending}`). Null = unknown. */
@Immutable data class IngotInventoryUi(val held: Long?, val pending: Long?)

/** Today's casting allowance (`allowance.daily{used, cap, remaining}`). */
@Immutable data class IngotDailyUi(val used: Long?, val cap: Long?, val remaining: Long?)

/** The holding room (`allowance.holding{held, pending, cap, remaining}`). */
@Immutable data class IngotHoldingUi(val held: Long?, val pending: Long?, val cap: Long?, val remaining: Long?)

/** `allowance{daily, holding, resetsAt}`; [resetsAtMs] is server epoch ms. */
@Immutable data class IngotAllowanceUi(val daily: IngotDailyUi, val holding: IngotHoldingUi, val resetsAtMs: Long?)

/** `batch{size}`: the most ingots one cast makes. */
@Immutable data class IngotBatchUi(val size: Long?)

/** An ingot job's state (`job.state(RUNNING|READY|COLLECTING)`). */
enum class IngotJobState { RUNNING, READY, COLLECTING }

/** The casting job (`job{jobId, ingots, readyAt, state}`). */
@Immutable data class IngotJobUi(
    val jobId: String,
    val ingots: Long,
    /** Server epoch ms. */
    val readyAtMs: Long?,
    val state: IngotJobState,
    /** Server epoch ms it started, if known. */
    val startedAtMs: Long? = null,
    /** Local "done at" clock time; blank draws none. */
    val doneAt: String = "",
)

/** Where the COLLECT receipt sequence stands (SPEC §2.5 COLLECT sequence). */
enum class CollectStage {
    /** Nothing in flight. */
    IDLE,
    /** Stone dots "Collecting". */
    COLLECTING,
    /** Moss "COLLECTED": the server receipt arrived. Only now does the held count count up. */
    COLLECTED,
    /** Red RETRY; the host posts "The Workshop can't reach the server. Try again." Nothing is counted locally. */
    FAILED,
}

/** Workshop › INGOTS state (SPEC §2.5 `WorkshopUiState.Ingots`; fields after `saved` were added). */
@Immutable data class WorkshopIngotsUi(
    val inventory: IngotInventoryUi,
    val allowance: IngotAllowanceUi,
    /** Shards per ingot (server); null = unknown (the pill shows "…"). */
    val shardsPerIngot: Long?,
    val batch: IngotBatchUi,
    /** The casting job, if any. */
    val job: IngotJobUi?,
    /** The Shards balance; null = unknown. */
    val shards: Long?,
    /** False = read-only base. */
    val actionsAllowed: Boolean,
    /** A saved request from earlier. */
    val saved: SavedOpUi?,
    /** The chosen quantity (clamped to 1..min(batch, today left, holding room)). */
    val quantity: Int = 1,
    /** Seconds per ingot ("takes 2m 00s" for 4); null = unknown. */
    val secondsPerIngot: Long? = null,
    val hydration: CraftHydration = CraftHydration.Ready,
    /** The CAST request's state. */
    val submit: SubmitUi = SubmitUi(),
    /** The COLLECT receipt sequence. */
    val collect: CollectStage = CollectStage.IDLE,
    /** Server clock − device clock, ms. */
    val serverOffsetMs: Long = 0L,
)

/** Workshop › INGOTS callbacks (SPEC §2.5). */
@Immutable data class WorkshopIngotsActions(
    /** ±1; the view model clamps. */
    val onQty: (Int) -> Unit = {},
    /** Opens the review half sheet for [n] ingots, then starts. */
    val onCast: (n: Int) -> Unit = {},
    /** The server collect (receipt sequence). */
    val onCollect: (jobId: String) -> Unit = {},
    /** → `Destination.GoldForge(tab = SMELT)`. */
    val onGoGoldForge: () -> Unit = {},
    /** Original receipt read only: bind to WorkshopRepository.check(), never confirm/reviewSaved/retry.
     * Null keeps CHECK unavailable until the existing owner supplies this dedicated adapter. */
    val onCheckOriginalReceipt: ((String) -> Unit)? = null,
)

/** The INGOTS body. */
@Composable internal fun ColumnScope.WorkshopIngotsBody(ui: WorkshopIngotsUi, on: WorkshopSheetActions, nowMs: Long,
    destinationsAvailable: Boolean = true) {
    val c = PkwTokens.Colors
    ui.saved?.let { saved ->
        val check = ingotsOriginalCheck(ui, on)
        if (check != null) RecoveryRow(saved, check)
        else CreamCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                PkwText(saved.title, PkwTokens.Type.body, color = c.textOnParch)
                PkwText(saved.line, PkwTokens.Type.small, color = c.textOnParch2)
                PkwText(if (saved.checking) "Checking original receipt" else "Original receipt check is unavailable.",
                    PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
        on.savedDoor?.let { SavedDoorButton(it) }
    }
    SectionLabel("FORGE INGOTS", "Shards in, ingots out")
    AllowanceCard(ui, nowMs)
    HeldCard(ui, on.ingots.onGoGoldForge, destinationsAvailable)
    val job = ui.job
    SectionLabel("CASTING BENCH", right = ingotsBenchLabel(ui))
    when {
        !ingotsObservationKnown(ui) -> DashedBox {
            PkwText(ingotsBenchUnknownText(ui), PkwTokens.Type.body, color = c.textOnParch2, maxLines = 3)
        }
        job == null -> DashedBox {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CraftIcon("craft:ingot_mold_empty", 64.dp, alpha = 0.55f)
                PkwText("Empty. Cast up to ${groupDigits(ui.batch.size)} ingots in one batch.", PkwTokens.Type.body, color = c.textOnParch2, maxLines = 2)
            }
        }
        job.state == IngotJobState.READY || ui.collect != CollectStage.IDLE -> IngotReadyCard(job)
        else -> {
            val reduced = LocalReducedMotion.current
            BenchCard(title = "CASTING ${groupDigits(job.ingots)} INGOTS", tag = "WORKING", tagVerb = Verb.GOLD,
                input = { CraftAtlasLoop(CraftAtlases.ingotCasting, 8, 32.dp, still = "craft:inv_forge_ingot") },
                outputIcon = "craft:inv_forge_ingot", outputBadge = "x${groupDigits(job.ingots)}",
                progress = jobProgress(job.startedAtMs, job.readyAtMs, ui.secondsPerIngot?.let { it * job.ingots }, nowMs, ui.serverOffsetMs,
                    if (reduced) 60_000L else 1L),
                leftText = countdownText(secondsLeft(job.readyAtMs, nowMs, ui.serverOffsetMs)),
                doneLine = if (job.doneAt.isBlank()) "left" else "left · done at ${job.doneAt}", appearKey = job.jobId)
        }
    }
}

/** AllowanceCard (CreamCard 78, two columns): TODAY used/cap with a gold bar and "resets in", HOLDING held+pending/cap with
 *  a green bar and "room for n more". */
@Composable private fun AllowanceCard(ui: WorkshopIngotsUi, nowMs: Long) {
    val d = ui.allowance.daily
    val h = ui.allowance.holding
    val holdingNow = if (h.held != null && h.pending != null) runCatching { Math.addExact(h.held, h.pending) }.getOrNull() else null
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 78.dp), contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 10.dp, bottom = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            AllowanceColumn("TODAY", "${groupDigits(d.used)}/${groupDigits(d.cap)}", fraction(d.used, d.cap), Verb.GOLD,
                "resets in ${timeLeft(secondsLeft(ui.allowance.resetsAtMs, nowMs, ui.serverOffsetMs))}", Modifier.weight(1f))
            AllowanceColumn("HOLDING", "${groupDigits(holdingNow)}/${groupDigits(h.cap)}", fraction(holdingNow, h.cap), Verb.GREEN,
                "room for ${groupDigits(h.remaining)} more", Modifier.weight(1f))
        }
    }
}

private fun fraction(part: Long?, whole: Long?): Float? = if (part == null || whole == null || whole <= 0L) null else (part.toFloat() / whole).coerceIn(0f, 1f)

@Composable private fun AllowanceColumn(title: String, value: String, fill: Float?, verb: Verb, line: String, modifier: Modifier) {
    val c = PkwTokens.Colors
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PkwText(title, PkwTokens.Type.caption, color = c.textOnParch)
            Spacer(Modifier.weight(1f))
            PkwText(value, PkwTokens.Type.caption, color = c.textOnParch)
        }
        ProgressBar(fill, "$title $value", verb = verb, height = 14.dp)
        PkwText(line, PkwTokens.Type.small, color = c.textOnParch2)
    }
}

/** HeldCard (CreamCard 84): the ingot stack, "8 INGOTS HELD", the Gold Forge line and a blue GO (KEEP token) that pulses
 *  once when the holding room is full. The held count counts up after a collect receipt. */
@Composable private fun HeldCard(ui: WorkshopIngotsUi, onGo: () -> Unit, destinationsAvailable: Boolean) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val full = ui.allowance.holding.remaining == 0L
    val pulse = remember { Animatable(1f) }
    LaunchedEffect(full) {
        if (full && !reduced) pulse.animateTo(1f, keyframes { durationMillis = PkwTokens.Motion.BADGE_POP * 2; 1.12f at PkwTokens.Motion.BADGE_POP })
    }
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 84.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(72.dp) { CraftIcon("craft:ingot_stack", 64.dp) }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    CountUpText(groupDigits(ui.inventory.held), PkwTokens.Type.label)
                    PkwText("INGOTS HELD", PkwTokens.Type.label, color = c.textOnParch)
                }
                PkwText("Smelt them at the Gold Forge for KEEP.", PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
            }
            if (destinationsAvailable) GoButton(onGo, "Go to the Gold Forge to smelt your ingots", Modifier.size(64.dp, 60.dp)
                .graphicsLayer { scaleX = pulse.value; scaleY = pulse.value }, icon = "keep")
        }
    }
}

/** The cooled batch (workshop-ready.png): green-rim card, the ready frames played once, the green "x4", READY. */
@Composable private fun IngotReadyCard(job: IngotJobUi) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 104.dp), rim = CardRim.READY, contentPadding = PaddingValues(start = 10.dp, top = 8.dp, end = 10.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box {
                Well(72.dp) { CraftAtlasLoop(CraftAtlases.ingotReady, 12, 64.dp, once = true, contentDescription = "Cooled ingots") }
                Badge(BadgeUi("x${groupDigits(job.ingots)}", BadgeTone.READY, "${job.ingots} ingots ready"),
                    Modifier.align(Alignment.BottomEnd).offset(x = 8.dp, y = 4.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText("${groupDigits(job.ingots)} INGOTS COOLED", PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.textOnParch)
                    Tag("READY", Verb.GREEN)
                }
                PkwText("Collect to move them to your holding room.", PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
            }
        }
    }
}

/** The INGOTS footer: CAST stepper + primary, or the full-width COLLECT; and the note. */
@Composable internal fun ColumnScope.WorkshopIngotsFooter(ui: WorkshopIngotsUi, on: WorkshopSheetActions, primary: CraftPrimaryUi) {
    val collecting = ui.job?.state == IngotJobState.READY || ui.job?.state == IngotJobState.COLLECTING || ui.collect != CollectStage.IDLE
    val running = ui.job?.state == IngotJobState.RUNNING
    val stepper = ingotsObservationKnown(ui) && ui.actionsAllowed && !collecting && !running &&
        primary.state != CommandState.BUSY && ui.hydration !is CraftHydration.Error
    val qty = ingotQuantity(ui)
    val max = ingotQuantityMax(ui)
    Row(Modifier.fillMaxWidth().padding(top = if (primary.price != null) 14.dp else 0.dp), verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (stepper) QtyStepper(qty.toString(), "max ${groupDigits(max)}", { on.ingots.onQty(-1) }, { on.ingots.onQty(1) }, "ingots",
            minusEnabled = qty > 1, plusEnabled = max != null && qty < max)
        CraftPrimaryButton(primary, { action ->
            when (action) {
                PrimaryAction.START -> on.ingots.onCast(qty)
                PrimaryAction.COLLECT -> ui.job?.jobId?.let(on.ingots.onCollect)
                PrimaryAction.RETRY -> on.onRetry()
                PrimaryAction.NEED_MORE -> primary.price?.let(on.onNeedMore)
                else -> Unit
            }
        }, Modifier.weight(1f))
    }
    val notice = submitNotice(ui.submit) ?: (ui.hydration as? CraftHydration.Error)?.message
        ?: if (ui.collect == CollectStage.FAILED) "The Workshop can't reach the server. Try again." else null
    when {
        notice != null -> FooterNote(notice, danger = true)
        !ingotsObservationKnown(ui) -> FooterNote(ingotsBenchUnknownText(ui))
        collecting -> FooterNote("The bench is free again after you collect.")
        running -> FooterNote("The bench takes one batch at a time.")
        else -> FooterNote("Shards are spent when you start. No refunds.")
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Workshop › INGOTS idle (workshop-ingots.png)", widthDp = 412, heightDp = 811)
@Composable private fun IngotsIdlePreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingots))

@Preview(name = "Workshop › INGOTS ready to collect (workshop-ready.png)", widthDp = 412, heightDp = 811)
@Composable private fun IngotsReadyPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingotsReady, ingotsReady = true))

@Preview(name = "Workshop › INGOTS casting (busy)", widthDp = 412, heightDp = 811)
@Composable private fun IngotsCastingPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingots.copy(
    job = IngotJobUi("job-c", 4, CraftSamples.NOW + 95_000L, IngotJobState.RUNNING, doneAt = "14:34"))))

@Preview(name = "Workshop › INGOTS collected (receipt success)", widthDp = 412, heightDp = 811)
@Composable private fun IngotsCollectedPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingotsReady.copy(
    collect = CollectStage.COLLECTED, inventory = IngotInventoryUi(12, 0))))

@Preview(name = "Workshop › INGOTS collect failed", widthDp = 412, heightDp = 811)
@Composable private fun IngotsFailedPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingotsReady.copy(collect = CollectStage.FAILED)))

@Preview(name = "Workshop › INGOTS daily cap hit", widthDp = 412, heightDp = 811)
@Composable private fun IngotsCapPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingots.copy(
    allowance = CraftSamples.ingots.allowance.copy(daily = IngotDailyUi(20, 20, 0)))))

@Preview(name = "Workshop › INGOTS holding full", widthDp = 412, heightDp = 811)
@Composable private fun IngotsHoldingFullPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingots.copy(
    allowance = CraftSamples.ingots.allowance.copy(holding = IngotHoldingUi(30, 0, 30, 0)))))

@Preview(name = "Workshop › INGOTS short of Shards", widthDp = 412, heightDp = 811)
@Composable private fun IngotsShortPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingots.copy(shards = 3_000)))

@Preview(name = "Workshop › INGOTS loading", widthDp = 412, heightDp = 811)
@Composable private fun IngotsLoadingPreview() = WorkshopPreviewHost(CraftSamples.workshop(ingots = CraftSamples.ingots.copy(
    hydration = CraftHydration.Loading, inventory = IngotInventoryUi(null, null))))
