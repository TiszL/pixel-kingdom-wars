package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.kit.sealArmFraction
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageIcon

/**
 * Design component: the Market's round-2 Seal (design/final/craft/market-sol.png, the BUY Seal of SPEC E1.2; and the
 * LIST Seal of SPEC "Part two", specified, not rendered). The kit [gg.pixelkingdomwars.nativeclient.ui.kit.Seal] draws
 * currency tokens and plain lines only; these two Seals also need item / vehicle art on the pay → get row, the cream
 * fine-print box that names the realm's cut (the ONLY place the cut appears, with its icon and a darker lead), the VT 18
 * note and a confirm face with a sub-line ("0.08 SOL"). So this is the missing kit part, built inside the cluster from
 * kit pieces (Presence, ModalScrim, Plate, ChunkyBox, MoneyButton) and noted in MOUNT-r2-r2-craft-voyage-goldforge.md.
 *
 * WoodFrame x 24..388 on the 412 dp phone, centred, over the 55 % scrim; enter 160 ms scale 0.96 → 1 + fade, exit 120 ms;
 * the primary arms over 450 ms (an ink bar fills inside its lip) and ignores taps until `sealAccepts`. Money states:
 * Check wallet → Sending → moss SENT after the receipt; an authoritative refusal says so (red RETRY, or BACK only when
 * the lot is gone); an uncertain result says it is being checked and offers stone CHECK, never a second BUY.
 *
 * Pointer rule: pass the seal to show, or null. Only while a seal is shown (or animating out) is the root full-screen,
 * with the kit ModalScrim under it whose tap is BACK (never confirm, ignored while the wallet or server works). With null
 * nothing is composed, so touches reach the kingdom. Keep composing the same call with null through the exit:
 * [onExitFinished] then fires once. Back is the OverlayHost's (cancel, never confirm).
 */
@Immutable data class SealSideUi(
    /** The art: a kit / currency name ("sol", "keep"), a `craft:` item, a `ui:` icon or a `voyage:` vehicle idle. */
    val icon: String,
    /** The art size in dp (48 for tokens and 64 px icons, 56 for a 112 px vehicle). */
    val iconDp: Int,
    /** PS 14 under the art ("0.08", "T2", "10"); null draws no amount line. An unknown price is already "…". */
    val amount: String?,
    /** VT 18 under it ("SOL", "10/10 trips", "your stall"); null draws none. */
    val caption: String?,
    /** What a screen reader says for this side ("Pay 0.08 SOL"). */
    val description: String,
)

/** The cream fine-print box (2 dp ink rim with an icon and a lead, or the #C9A86A note rim without). */
@Immutable data class MarketFinePrintUi(
    /** 32 dp icon ("ui:market-menu"); null draws none. */
    val icon: String?,
    /** The darker lead ("The realm's cut:"); null draws none. */
    val lead: String?,
    /** The sentence, server-derived ("5% of the price, taken from the seller's share."). */
    val text: String,
)

/** Where a Market Seal stands. */
enum class MarketSealStage {
    /** Arming / armed: the gold primary. */
    READY,
    /** A request with no wallet step is in flight (LIST): stone dots. */
    BUSY,
    /** The wallet is asking the player. */
    CHECK_WALLET,
    /** Signed; the server has not answered. */
    SENDING,
    /** The receipt arrived (moss). */
    SENT,
    /** An AUTHORITATIVE refusal ([MarketSealUi.message] may say nothing was spent). */
    REFUSED,
    /** The answer was lost: being checked; stone CHECK (by-key read), never a second payment. */
    UNCERTAIN,
}

/** One Market round-2 Seal (SOL stall BUY, LIST). */
@Immutable data class MarketSealUi(
    /** PS 13 title ("BUY SURVEY BALLOON T2", "LIST 10 FROSTGLASS"). */
    val title: String,
    /** What the player gives. */
    val pay: SealSideUi,
    /** What the player gets; null draws the pay side only. */
    val gets: SealSideUi?,
    /** VT 19 lines under the pay → get row. */
    val lines: List<String>,
    /** The cream fine-print box (the realm's cut); null draws none. */
    val finePrint: MarketFinePrintUi?,
    /** The VT 18 note ("Paid from your wallet. You sign once."); null draws none. */
    val note: String?,
    /** The primary's label ("BUY", "LIST"). */
    val confirmLabel: String,
    /** The VT line inside the primary ("0.08 SOL"); null draws none. */
    val confirmSub: String?,
    /** Wall-clock ms the seal was raised, or when the quote landed (it arms 450 ms later). */
    val armedAtMs: Long,
    /** Where the request stands. */
    val stage: MarketSealStage = MarketSealStage.READY,
    /** False while the price is CHECKING: the primary shows "Checking price" and does not arm. */
    val quoteReady: Boolean = true,
    /** REFUSED / UNCERTAIN sentence ("Sold to someone else. Nothing was spent.", "Being checked · …"). */
    val message: String? = null,
    /** False on a refusal that cannot be retried (the lot sold to someone else): BACK only. */
    val retryable: Boolean = true,
    /** The stone back label. */
    val backLabel: String = "BACK",
    /** The existing owner's current admission; disabled is distinct from an unknown price. */
    val confirmEnabled: Boolean = true,
)

/** The Market Seal's callbacks. */
@Immutable data class MarketSealActions(
    /** The armed primary (BUY: the wallet payment; LIST: submit the listing). */
    val onConfirm: () -> Unit = {},
    /** BACK, a scrim tap or system Back (ignored while the wallet or server works). */
    val onBack: () -> Unit = {},
    /** Red RETRY after an authoritative, retryable refusal. */
    val onRetry: () -> Unit = {},
    /** CHECK after an uncertain result (the by-key read of the saved request). */
    val onCheck: () -> Unit = {},
)

/**
 * The Market round-2 Seal. Compose it from the OverlayHost (see [MarketSheetR2Seals]).
 *
 * Pointer rule: full-screen only while shown or animating out, with the 55 % ModalScrim whose tap is BACK; nothing is
 * composed with null.
 */
@Composable fun MarketSealV2(ui: MarketSealUi?, on: MarketSealActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    val c = PkwTokens.Colors
    Presence(ui, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT, onGone = onExitFinished) { seal, progress, active, reduced ->
        val working = seal.stage == MarketSealStage.CHECK_WALLET || seal.stage == MarketSealStage.SENDING || seal.stage == MarketSealStage.BUSY
        val back: () -> Unit = { if (active && !working) on.onBack() }
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = back)
            Plate(PlateKind.WOOD, Modifier.padding(horizontal = 24.dp).widthIn(max = 364.dp).fillMaxWidth()
                .semantics { paneTitle = seal.title; liveRegion = LiveRegionMode.Assertive }
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        PkwText(seal.title, PkwTokens.Type.title, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            SealSide(seal.pay)
                            seal.gets?.let { gets ->
                                PkwIcon("shape:go", 24.dp, tint = c.textOnParch)
                                SealSide(gets)
                            }
                        }
                        seal.lines.forEach { PkwText(it, PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 3) }
                        seal.finePrint?.let { FinePrintBox(it) }
                        seal.note?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2) }
                        // An UNCERTAIN answer always reads "Being checked · …" (design correction 7), whatever the message says.
                        (if (seal.stage == MarketSealStage.UNCERTAIN) solOutcomeLine(SolOutcomeUi(false, seal.message.orEmpty()))?.removeSuffix(" · ")
                            else seal.message)?.let {
                            PkwText(it, PkwTokens.Type.small, color = if (seal.stage == MarketSealStage.REFUSED) c.shortText else c.textOnParch2,
                                textAlign = TextAlign.Center, maxLines = 3)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton(seal.backLabel, back, Modifier.width(PkwTokens.Dims.sealBackW), enabled = !working)
                            SealPrimaryV2(seal, active, on, clock, Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}

/** The primary for the seal's stage (see [MarketSealV2]). */
@Composable private fun SealPrimaryV2(seal: MarketSealUi, active: Boolean, on: MarketSealActions, clock: () -> Long, modifier: Modifier) {
    when (seal.stage) {
        MarketSealStage.CHECK_WALLET -> MoneyButton(MoneyStage.CHECK_WALLET, seal.confirmLabel, {}, modifier)
        MarketSealStage.SENDING -> MoneyButton(MoneyStage.SENDING, seal.confirmLabel, {}, modifier)
        MarketSealStage.SENT -> MoneyButton(MoneyStage.SENT, seal.confirmLabel, {}, modifier)
        MarketSealStage.BUSY -> PrimaryButton(seal.confirmLabel, {}, modifier, state = CommandState.BUSY)
        MarketSealStage.REFUSED ->
            if (seal.retryable) MoneyButton(MoneyStage.FAILED, seal.confirmLabel, { if (active) on.onRetry() }, modifier)
            else PrimaryButton(seal.confirmLabel, {}, modifier, state = CommandState.DISABLED)
        // Not known to be a refusal: the by-key CHECK, never a fresh request.
        MarketSealStage.UNCERTAIN -> PrimaryButton("CHECK", { if (active) on.onCheck() }, modifier, verb = Verb.STONE)
        MarketSealStage.READY ->
            if (!seal.confirmEnabled) PrimaryButton(seal.confirmLabel, {}, modifier, state = CommandState.DISABLED)
            else if (!seal.quoteReady) PrimaryButton("Checking price", {}, modifier, verb = Verb.STONE, state = CommandState.BUSY)
            else ArmingFace(seal, active, on.onConfirm, clock, modifier)
    }
}

/** The gold confirm with its sub-line and the 450 ms arming bar; taps before `sealAccepts` are ignored, never queued. */
@Composable private fun ArmingFace(seal: MarketSealUi, active: Boolean, onConfirm: () -> Unit, clock: () -> Long, modifier: Modifier) {
    val c = PkwTokens.Colors
    val still = LocalInspectionMode.current
    val arm = remember(seal.armedAtMs) { Animatable(if (still) 1f else sealArmFraction(clock(), seal.armedAtMs)) }
    LaunchedEffect(seal.armedAtMs) {
        val remaining = ((1f - arm.value) * PkwTokens.Motion.SEAL_ARM).toInt()
        if (remaining > 0) arm.animateTo(1f, tween(remaining, easing = PkwTokens.Motion.Linear))
    }
    val confirm by rememberUpdatedState(onConfirm)
    ChunkyBox(c.gold, { if (active && sealAccepts(clock(), seal.armedAtMs)) confirm() },
        listOfNotNull(seal.confirmLabel, seal.confirmSub).joinToString(", "),
        modifier.heightIn(min = PkwTokens.Dims.sheetPrimaryH).drawWithContent {
            drawContent()
            val a = arm.value
            if (a < 1f) {
                val inset = 8.dp.toPx(); val h = 4.dp.toPx(); val y = size.height - 14.dp.toPx()
                drawRect(c.ink.copy(alpha = 0.30f), Offset(inset, y), Size(size.width - 2 * inset, h))
                drawRect(c.ink, Offset(inset, y), Size((size.width - 2 * inset) * a, h))
            }
        }, enabled = active) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(seal.confirmLabel, PkwTokens.Type.primary, color = c.label, outline = 2.dp)
            seal.confirmSub?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch) }
        }
    }
}

/** One side of pay → get: the art, PS 14 amount, VT 18 caption; read as one sentence. */
@Composable private fun SealSide(side: SealSideUi) {
    val c = PkwTokens.Colors
    Column(Modifier.widthIn(min = 96.dp).semantics(mergeDescendants = true) { contentDescription = side.description },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        MarketArt(side.icon, side.iconDp.dp)
        side.amount?.let { PkwText(it, PkwTokens.Type.primary, color = c.textOnParch) }
        side.caption?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
    }
}

/**
 * The cream fine-print box: 2 dp ink rim with the 32 dp icon and a darker lead (the realm's cut), or the 2 dp #C9A86A
 * rim of a plain note. VT 18. Paint only.
 */
@Composable internal fun FinePrintBox(fp: MarketFinePrintUi, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val rim = if (fp.icon != null || fp.lead != null) c.ink else c.parchmentLo
    Row(modifier.fillMaxWidth().drawBehind {
        drawRect(rim)
        val i = 2.dp.toPx()
        drawRect(c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    }.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        fp.icon?.let { MarketArt(it, 32.dp) }
        val text = buildAnnotatedString {
            fp.lead?.let { lead -> withStyle(SpanStyle(color = c.textOnParch)) { append(lead) }; append(" ") }
            append(fp.text)
        }
        Text(text, Modifier.weight(1f), color = c.textOnParch2, style = PkwTokens.Type.small, maxLines = 3)
    }
}

/**
 * Art for the Market's round-2 frames: `voyage:` names (vehicle idles, 112 px) through the voyage cluster's
 * [VoyageIcon]; everything else through [CraftIcon] (`craft:` copies, then the kit / GameArt). Whole-number scale,
 * nearest sampling (both callees). Paint only.
 */
@Composable internal fun MarketArt(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null, alpha: Float = 1f) {
    if (name.startsWith("voyage:")) VoyageIcon(name, size, modifier, contentDescription, alpha)
    else CraftIcon(name, size, modifier, contentDescription, alpha)
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun SealPreviewHost(ui: MarketSealUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { MarketSealV2(ui, MarketSealActions(), clock = { 10_000L }) }
}

@Preview(name = "Market seal: SOL stall BUY (market-sol.png)", widthDp = 412, heightDp = 640)
@Composable private fun SolSealPreview() = SealPreviewHost(CraftR2Samples.solSeal)

@Preview(name = "Market seal: price being checked (does not arm)", widthDp = 412, heightDp = 640)
@Composable private fun SolSealCheckingPreview() = SealPreviewHost(CraftR2Samples.solSeal.copy(quoteReady = false, pay = CraftR2Samples.solSeal.pay.copy(amount = "…")))

@Preview(name = "Market seal: sending", widthDp = 412, heightDp = 640)
@Composable private fun SolSealSendingPreview() = SealPreviewHost(CraftR2Samples.solSeal.copy(stage = MarketSealStage.SENDING))

@Preview(name = "Market seal: sold to someone else (authoritative)", widthDp = 412, heightDp = 640)
@Composable private fun SolSealRefusedPreview() = SealPreviewHost(CraftR2Samples.solSeal.copy(stage = MarketSealStage.REFUSED,
    message = "Sold to someone else. Nothing was spent.", retryable = false))

@Preview(name = "Market seal: uncertain (CHECK, never 'nothing was spent')", widthDp = 412, heightDp = 640)
@Composable private fun SolSealUncertainPreview() = SealPreviewHost(CraftR2Samples.solSeal.copy(stage = MarketSealStage.UNCERTAIN,
    message = "Being checked · the balloon appears in OWNED when the realm confirms"))

@Preview(name = "Market seal: LIST with the realm's cut", widthDp = 412, heightDp = 640)
@Composable private fun ListSealPreview() = SealPreviewHost(listSeal(CraftSamples.sell, 0L)!!)
