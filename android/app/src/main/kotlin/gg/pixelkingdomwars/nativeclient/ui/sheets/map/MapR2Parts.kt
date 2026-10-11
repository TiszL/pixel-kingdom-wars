package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.kit.sealArmFraction
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageIcon
import kotlin.math.ceil
import kotlin.math.roundToInt

/*
 * Design component: the parts map round 2 shares (design/final/map/SPEC.md "Round 2 additions" §A-§E): the recovery row
 * every money / claim sheet keeps for an uncertain result (design correction 7), the INTO kingdom row with CHANGE, the
 * header-art crop of a tall sheet's living header, the icon resolver for the round-2 art names, and the fine-print Seal
 * (seeker-permit-seal.png; the realm's-cut Seal reuses it).
 *
 * Kit gaps filled here (the kit is not edited): the kit `Seal` has no fine-print box, no "arms only when the quote
 * returns" state and no picture well on the get side, so [FinePrintSeal] is built from the same kit parts (Presence,
 * ModalScrim, WOOD / PARCHMENT plates, SecondaryButton, the 450 ms arming bar, MoneyButton).
 *
 * Pointer rule: only painted rows and buttons take touches; [FinePrintSeal]'s scrim exists only while a seal is shown or
 * animating out (the modal's own scrim). Nothing else here is full-screen.
 */

/** A saved request whose outcome is not known yet (design correction 7: never "nothing was spent" on a timeout). */
@Immutable data class RecoveryUi(
    /** The saved request's key, handed back by `onCheckSaved(key)` / `onRecover(key)`. */
    val key: String,
    /** VT line ("Your purchase is being checked"). */
    val line: String,
    /** The stone action ("CHECK SAVED OUTCOME", "CHECK SAVED RECEIPT", "CHECK RESULT"). */
    val actionLabel: String,
    /** The check is running: dots, no tap. */
    val busy: Boolean = false,
)

/** The INTO kingdom row (§B, §E): where a claim or delivery lands; CHANGE opens the kingdom picker half sheet. */
@Immutable data class KingdomPickUi(
    /** "Ironhold" ("…" while unknown). */
    val name: String,
    /** "Crownlands · Keep 12". */
    val sub: String,
    /** The Keep portrait art ("ui_portrait_keep_t3"), drawn at 28 in a dark 48 well. */
    val portrait: String?,
    /** §B "kingdom gone": the original kingdom is no longer available; its receipt is kept. */
    val gone: Boolean = false,
    /** False hides CHANGE (only one kingdom). */
    val changeable: Boolean = true,
)

/** Draws a round-2 art name at a whole-number scale: `site:` (map copies), `craft:` (craft copies), `voyage:` (voyage
 *  copies), anything else through the kit's [PkwIcon] (`ui:`, `shape:`, currencies, GameArt names). */
@Composable fun R2MapIcon(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null, alpha: Float = 1f) {
    when {
        name.startsWith("site:") -> MapIcon(name, size, modifier, contentDescription, alpha)
        name.startsWith("craft:") -> CraftIcon(name, size, modifier, contentDescription, alpha)
        name.startsWith("voyage:") -> VoyageIcon(name, size, modifier, contentDescription, alpha)
        else -> PkwIcon(name, size, modifier, contentDescription, alpha)
    }
}

/** A host-provided crop of the scene art (the isle around the ring, the crystal peaks, the island around your spot),
 *  covering [modifier]'s box at a whole-number scale, nearest sampled; null fills the island stage colour. Decorative. */
@Composable fun HeaderArtCrop(bitmap: ImageBitmap?, modifier: Modifier = Modifier) {
    if (bitmap == null) { Box(modifier.background(MapColors.stage)); return }
    Canvas(modifier.clipToBounds().clearAndSetSemantics { }) {
        val k = maxOf(1, ceil(maxOf(size.width / bitmap.width, size.height / bitmap.height)).toInt())
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, IntOffset.Zero, IntSize(bitmap.width, bitmap.height),
            IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), IntSize(w, h), filterQuality = FilterQuality.None)
    }
}

/** The INTO row (seeker-rewards.png, divine-fragments.png): dark 48 well with the Keep at 28, VT 20 name, VT 18 sub, stone
 *  CHANGE. "Kingdom gone" replaces the sub-line with the receipt-kept sentence. */
@Composable fun KingdomPickRow(pick: KingdomPickUi, onChange: () -> Unit, modifier: Modifier = Modifier) {
    MapRow(modifier) {
        ArtWell(48.dp, PkwTokens.Colors.charcoal) { pick.portrait?.let { PkwIcon(it, 28.dp) } }
        RowText(pick.name.ifBlank { UNKNOWN },
            if (pick.gone) "The original kingdom is no longer available. Its receipt is kept." else pick.sub)
        if (pick.changeable) SecondaryButton("CHANGE", onChange, Modifier.widthIn(min = 96.dp),
            contentDescription = "Change the kingdom it goes into, now ${pick.name}")
    }
}

/** The recovery row (design correction 7): `#FFF3C8`, the "being checked" line and the stone check button (dots while
 *  busy; busy never calls back). The caller keeps this row until the outcome is known. */
@Composable fun RecoveryRow(rec: RecoveryUi, onCheck: (String) -> Unit, modifier: Modifier = Modifier) {
    MapRow(modifier, tint = PkwTokens.Colors.selectedTint) {
        PkwIcon("ui:queue-status", 32.dp)
        RowText(rec.line, null)
        ChunkyBox(PkwTokens.Colors.stone, { onCheck(rec.key) }, if (rec.busy) "${rec.actionLabel}, working" else rec.actionLabel,
            Modifier.widthIn(min = 112.dp).heightIn(min = 48.dp), enabled = !rec.busy) {
            if (rec.busy) BusyDots()
            else PkwText(rec.actionLabel, PkwTokens.Type.caption, Modifier.padding(horizontal = 6.dp), color = PkwTokens.Colors.label,
                outline = 1.dp, textAlign = TextAlign.Center, maxLines = 2)
        }
    }
}

/** A row tag on parchment (READY, HELD, BEING CHECKED). Paint only. */
@Composable fun RowTag(tag: MapTagUi, modifier: Modifier = Modifier) {
    gg.pixelkingdomwars.nativeclient.ui.kit.Tag(tag.text, tag.verb, modifier)
}

// ---- The fine-print Seal (seeker-permit-seal.png) ----

/** The get side of a fine-print Seal: a 64 well with [icon] (or a token without a well) and the PS 12 [text]. */
@Immutable data class SealGetUi(val icon: String?, val text: String, val well: Boolean = true)

/** Everything the fine-print Seal draws. Built by `permitSealContent` / `realmsCutSealContent`. */
@Immutable data class FinePrintSealUi(
    /** PS 13 title ("BUY FROSTVEIL PERMIT"). */
    val title: String,
    /** The pay token (36 dp icon + PS 14 amount); "…" while CHECKING. */
    val pay: PriceUi,
    /** The get side; null draws the pay token only. */
    val gets: SealGetUi?,
    /** VT 20 lines ("Your expeditions may sail into Frostveil until Sat 10 Oct."). */
    val lines: List<String>,
    /** VT 18 secondary line ("Bought from Kaly's spot 7."); null draws none. */
    val secondary: String?,
    /** The cream fine-print box lines (all SOL cost lines live only here). */
    val finePrint: List<String>,
    /** The gold primary's label ("BUY"). */
    val confirmLabel: String,
    /** Wall-clock ms the primary started arming (the quote's arrival, so a CHECKING seal never pre-arms). */
    val armedAtMs: Long,
    /** The money sequence on the primary. */
    val stage: MoneyStage,
    /** False: the primary does not arm and ignores taps ([permitSealCanArm]). */
    val canArm: Boolean,
    /** Shown above the buttons while [canArm] is false ("Checking the price…"). */
    val waitLine: String?,
    val backLabel: String = "BACK",
)

/**
 * The fine-print Seal (DESIGN-SYSTEM §6 ConfirmDialog; seeker-permit-seal.png): a centred WoodFrame x 24..388 over the 55 %
 * scrim, PS 13 title, pay → get (SOL 36 + PS 14 → 64 well + PS 12), VT 20 lines, VT 18 secondary, the cream fine-print box
 * (2 dp `#C9A86A` rim), stone BACK 100 and the gold primary that arms over 450 ms. Enter 0.96 → 1 + fade 160 ms, exit 120.
 * After READY the primary runs the money sequence (Check wallet → Sending → SENT; RETRY on FAILED). Back / a scrim tap is
 * BACK, never confirm. Pass null to dismiss; keep composing it through the exit.
 *
 * Pointer rule: the root fills the screen only while a seal is shown or animating out; its scrim is the modal's own.
 */
@Composable fun FinePrintSeal(ui: FinePrintSealUi?, onConfirm: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    Presence(ui, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT, onGone = onExitFinished) { seal, progress, active, reduced ->
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) onBack() })
            Plate(PlateKind.WOOD, Modifier.padding(horizontal = 24.dp).widthIn(max = 364.dp).fillMaxWidth()
                .semantics { paneTitle = seal.title; liveRegion = LiveRegionMode.Assertive }
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        PkwText(seal.title, PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                        SealExchange(seal)
                        seal.lines.forEach { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 3) }
                        seal.secondary?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 2) }
                        if (seal.finePrint.isNotEmpty()) FinePrintBox(seal.finePrint)
                        seal.waitLine?.takeIf { !seal.canArm }?.let {
                            PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton(seal.backLabel, { if (active) onBack() }, Modifier.width(100.dp))
                            if (seal.stage == MoneyStage.READY) SealArmingPrimary(seal, active, onConfirm, clock, Modifier.weight(1f))
                            else MoneyButton(seal.stage, seal.confirmLabel, { if (active) onConfirm() }, Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}

/** pay → get: the 36 dp currency + PS 14 amount, the step arrow, then the 64 well + PS 12 text (or a bare token). */
@Composable private fun SealExchange(seal: FinePrintSealUi) {
    val pay = seal.pay
    val said = listOfNotNull(priceDescription(pay), seal.gets?.let { "for ${it.text}" }).joinToString(" ")
    Row(Modifier.clearAndSetSemantics { contentDescription = said }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PkwIcon(currencyIcon(pay.currency, pay.icon), 36.dp)
        PkwText(priceText(pay), PkwTokens.Type.primary,
            color = if (pay.status == PriceStatus.SHORT) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch)
        seal.gets?.let { gets ->
            PkwIcon("shape:go", 24.dp, tint = PkwTokens.Colors.textOnParch)
            val icon = gets.icon
            if (gets.well) ArtWell(64.dp, PkwTokens.Colors.charcoal) {
                if (icon != null) R2MapIcon(icon, 48.dp) else PkwText(gets.text.take(1), PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi)
            } else if (icon != null) R2MapIcon(icon, 36.dp)
            PkwText(gets.text, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
        }
    }
}

/** The cream fine-print box: 2 dp `#C9A86A` rim, VT 18 lines, left-aligned. */
@Composable private fun FinePrintBox(lines: List<String>) {
    Column(Modifier.fillMaxWidth().background(PkwTokens.Colors.cream).border(2.dp, FINE_PRINT_RIM).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        lines.forEach { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
    }
}

/** seeker-permit-seal.png: the fine-print box rim (`#C9A86A`, not a TOKENS.json colour). */
private val FINE_PRINT_RIM = Color(0xFFC9A86A)

/** The gold primary with its 450 ms arming bar; taps before [sealAccepts] (or while it cannot arm) are ignored. */
@Composable private fun SealArmingPrimary(seal: FinePrintSealUi, active: Boolean, onConfirm: () -> Unit, clock: () -> Long, modifier: Modifier) {
    val arm = remember(seal.armedAtMs, seal.canArm) { Animatable(if (seal.canArm) sealArmFraction(clock(), seal.armedAtMs) else 0f) }
    LaunchedEffect(seal.armedAtMs, seal.canArm) {
        if (!seal.canArm) return@LaunchedEffect
        val remaining = ((1f - arm.value) * PkwTokens.Motion.SEAL_ARM).toInt()
        if (remaining > 0) arm.animateTo(1f, tween(remaining, easing = PkwTokens.Motion.Linear))
    }
    val accepts = { active && seal.canArm && sealAccepts(clock(), seal.armedAtMs) }
    ChunkyBox(PkwTokens.Colors.gold, { if (accepts()) onConfirm() },
        if (seal.canArm) seal.confirmLabel else "${seal.confirmLabel}, ${seal.waitLine ?: "not ready"}",
        modifier.heightIn(min = PkwTokens.Dims.secondaryH).drawWithContent {
            drawContent()
            val a = arm.value
            if (a < 1f) {
                val inset = 6.dp.toPx(); val h = 4.dp.toPx()
                drawRect(PkwTokens.Colors.ink, Offset(inset, size.height - 6.dp.toPx()), Size((size.width - 2 * inset) * a, h))
            }
        }, enabled = active) {
        PkwText(seal.confirmLabel, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
    }
}

// ---- Previews ----

@Preview(name = "Recovery + INTO rows", widthDp = 412, heightDp = 300)
@Composable private fun R2RowsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        KingdomPickRow(KingdomPickUi("Ironhold", "Crownlands · Keep 12", "ui_portrait_keep_t3"), {})
        KingdomPickRow(KingdomPickUi("Saltmarsh", "Crownlands · Keep 4", "ui_portrait_keep_t1", gone = true), {})
        RecoveryRow(RecoveryUi("r1", "Your purchase is being checked", "CHECK SAVED OUTCOME"), {})
        RecoveryRow(RecoveryUi("r2", "Your purchase is being checked", "CHECK SAVED OUTCOME", busy = true), {})
    }
}

@Preview(name = "Fine-print Seal, armed", widthDp = 412, heightDp = 700)
@Composable private fun FinePrintSealPreview() {
    FinePrintSeal(FinePrintSealUi("BUY FROSTVEIL PERMIT", PriceUi(Currency.SOL, "0.01", PriceStatus.OK), SealGetUi(null, "7 DAYS"),
        listOf("Your expeditions may sail into Frostveil until Sat 10 Oct."), "Bought from Kaly's spot 7.",
        listOf("The price includes the realm's cut. With the network cost you approve at most 0.0121 SOL.", "Paid from your wallet. You sign once."),
        "BUY", 0L, MoneyStage.READY, canArm = true, waitLine = null), {}, {})
}
