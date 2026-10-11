package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

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
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
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
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.kit.sealArmFraction
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapIcon

/**
 * Design component: the voyage Seal, RE-DONE (design/final/voyage/berth-install.png and send-paid.png; SPEC "Round 2
 * additions: Part two — network cost only inside the Seal" and "E1.2 Paid expedition"). Replaces `VoyageSeal.kt`: the
 * separate SOL-icon fee line is gone. The network cost is folded into the Seal's FINE PRINT — a cream box with a 2 dp
 * #C9A86A rim, VT 18: "Paid from your wallet with a tiny network cost (about 0.00002 SOL). You sign once." ("(network
 * cost being checked)" while unknown; INSUFFICIENT_SOL turns the rim #A3261A with "Need about 0.00002 more SOL in your
 * wallet" + blue GO to Profile › WALLET). The permit Seal instead carries the realm's cut in a cream box with a 2 dp ink
 * rim and the Seeker spot icon ("The realm's cut: half to Spot 14 on Seeker Island, half to the game.") and a VT 18 note.
 * Rule for every voyage surface: SOL network cost, rent or setup lines appear only inside a Seal's fine print.
 *
 * Pay → get art: a vehicle in a 64 dp sea well → the family berth with it docked, the "1 → 10 trips" meter, a Tn+1
 * idle, the SOL token (48) + PS 14 amount, or a 64 dp sea well with the island cutout + "7 DAYS". Stone BACK and the gold
 * primary that arms over 450 ms (taps before `sealAccepts` are ignored, never queued); then Check wallet → Sending →
 * moss SENT after the server's result. Errors (design correction 7): an authoritative refusal shows red RETRY and may say
 * nothing was sent; an uncertain one says it is being checked and offers CHECK (the by-key read), never a fresh request.
 *
 * Pointer rule: pass the seal to show, or null. Only while shown (or animating out) is the root full-screen, with the kit
 * ModalScrim at 55 % whose tap is BACK (never confirm; ignored while the wallet or server is working). With null nothing
 * is composed, so touches reach the kingdom. Back must cancel too (OverlayHost `BackHandlerAt`).
 */
@Immutable data class VoyageSealSideUi(
    val kind: Kind,
    /** VEHICLE / BERTH: the family. */
    val family: VehicleFamily? = null,
    /** VEHICLE / BERTH: the tier. */
    val tier: Int? = null,
    /** TRIPS: "1 → 10 trips"; SOL: the amount ("0.01", "…"); ISLAND: "7 DAYS". */
    val text: String? = null,
    /** SOL: "SOL"; ISLAND: the realm ("Cinderfall"). */
    val caption: String? = null,
    /** ISLAND: the route whose cutout fills the well. */
    val route: RouteUi? = null,
) {
    enum class Kind {
        /** The vehicle idle in a 64 dp sea well (k 2). */
        VEHICLE,
        /** The family berth with that vehicle docked, 88 × 120 well. */
        BERTH,
        /** A full trips meter with its caption. */
        TRIPS,
        /** The SOL token 48 + PS 14 amount + VT "SOL". */
        SOL,
        /** A 64 dp sea well with the island cutout + PS 14 text + VT caption (a permit). */
        ISLAND,
    }
}

/** The realm's cut box (ink rim, icon 32, darker lead): the only place a split or a cut appears. */
@Immutable data class VoyageCutUi(
    /** 32 dp icon (`site:seeker-active` for a Seeker Island spot); null draws none. */
    val icon: String?,
    /** "The realm's cut:". */
    val lead: String,
    /** Server-formatted ("half to Spot 14 on Seeker Island, half to the game."). */
    val text: String,
)

/** The network-cost fine print (install / service). */
@Immutable data class NetworkCostUi(
    /** SPEC `feeLamportsEstimate` formatted in SOL ("0.00002"); null = not reviewed yet ("network cost being checked"). */
    val feeSol: String?,
)

/** "No spot sells Cinderfall permits today" + a blue door (SEEKER ISLAND); the primary is off. */
@Immutable data class VoyageUnavailableUi(val line: String, val goLabel: String)

/** One voyage Seal, round 2 (install, restore / upgrade, realm permit). */
@Immutable data class VoyageSealV2Ui(
    /** PS 13 title ("INSTALL SURVEY BALLOON", "RESTORE CARGO CUTTER", "PERMIT FOR CINDERFALL"). */
    val title: String,
    /** What the player gives. */
    val pay: VoyageSealSideUi,
    /** What the player gets; null draws the pay side only. */
    val gets: VoyageSealSideUi?,
    /** VT 19 lines ("Balloon T2 goes into this Berth for good. The wallet item is used up."). */
    val lines: List<String>,
    /** The realm's cut box (permit); null draws none. */
    val cut: VoyageCutUi?,
    /** The VT 18 note under the boxes ("Paid from your wallet. You sign once. The Cutter sails as soon as it is paid."). */
    val note: String?,
    /** The network-cost fine print (install / service); null draws none. */
    val network: NetworkCostUi?,
    /** INSUFFICIENT_SOL / SOL short: the red-rim sentence + GO WALLET (inside the network box when there is one). */
    val shortLine: String?,
    /** The primary's label ("INSTALL", "RESTORE", "BUY & SEND"). */
    val confirmLabel: String,
    /** The VT line inside the primary ("0.01 SOL"); null draws none. */
    val confirmSub: String?,
    /** Wall-clock ms the seal was raised or the quote landed (it arms 450 ms later). */
    val armedAtMs: Long,
    /** Where the request stands. */
    val state: VoyageSealState,
    /** The failed or uncertain step (state ERROR). */
    val error: VoyageMoneyErrorUi? = null,
    /** False while the price / fee is being checked: the primary reads "Checking" and does not arm. */
    val quoteReady: Boolean = true,
    /** PAUSED: the LOCKED reason ("Installs are paused. Your saved request is kept."). */
    val pausedReason: String? = null,
    /** The price is unavailable (no seller today): the line + a blue door; the primary is off. */
    val unavailable: VoyageUnavailableUi? = null,
    /** A server-free install (the starter, if a signature is asked): "Free · You sign once.", no network box. */
    val free: Boolean = false,
)

/** The seal's callbacks. */
@Immutable data class VoyageSealV2Actions(
    /** The armed primary (INSTALL / RESTORE / UPGRADE / BUY & SEND). */
    val onConfirm: () -> Unit = {},
    /** BACK, a scrim tap or system Back (ignored while CHECK_WALLET / SENDING). */
    val onBack: () -> Unit = {},
    /** Red RETRY after an authoritative refusal. */
    val onRetry: () -> Unit = {},
    /** CHECK after an uncertain result (the by-key read). */
    val onRecover: () -> Unit = {},
    /** GO on a SOL shortfall → Profile › WALLET. */
    val onAddSol: () -> Unit = {},
    /** The unavailable line's blue door (SEEKER ISLAND). */
    val onUnavailableGo: () -> Unit = {},
)

/**
 * The voyage seal, round 2. Compose it from the OverlayHost and keep composing it with null through its exit.
 *
 * Pointer rule: full-screen only while shown or animating out, with the 55 % ModalScrim whose tap is BACK; nothing is
 * composed with null.
 */
@Composable fun VoyageSealV2(ui: VoyageSealV2Ui?, on: VoyageSealV2Actions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    val c = PkwTokens.Colors
    Presence(ui, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT, onGone = onExitFinished) { seal, progress, active, reduced ->
        val working = seal.state == VoyageSealState.CHECK_WALLET || seal.state == VoyageSealState.SENDING
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
                            SealSideV2(seal.pay)
                            seal.gets?.let { PkwIcon("shape:go", 24.dp, tint = c.textOnParch); SealSideV2(it) }
                        }
                        seal.lines.forEach { PkwText(it, PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 3) }
                        seal.cut?.let { CutBox(it) }
                        seal.unavailable?.let { u ->
                            PkwText(u.line, PkwTokens.Type.body, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
                            SecondaryButton(u.goLabel, { if (active) on.onUnavailableGo() }, Modifier.fillMaxWidth(), verb = Verb.BLUE)
                        }
                        when {
                            seal.free -> PkwText("Free · You sign once.", PkwTokens.Type.small, color = c.textOnParch2)
                            seal.network != null -> NetworkBox(seal.network, seal.shortLine, { if (active) on.onAddSol() })
                            seal.shortLine != null -> NetworkBox(null, seal.shortLine, { if (active) on.onAddSol() })
                        }
                        seal.note?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 3) }
                        val error = seal.error
                        if (seal.state == VoyageSealState.ERROR && error != null) PkwText(moneyErrorLine(error), PkwTokens.Type.small,
                            color = if (error.authoritative) c.shortText else c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton("BACK", back, Modifier.width(PkwTokens.Dims.sealBackW), enabled = !working)
                            SealPrimaryV2(seal, active, on, clock, Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}

/** The primary for the current state ([sealV2Primary]). */
@Composable private fun SealPrimaryV2(ui: VoyageSealV2Ui, active: Boolean, on: VoyageSealV2Actions, clock: () -> Long, modifier: Modifier) {
    when (sealV2Primary(ui)) {
        SealV2Primary.LOCKED -> PrimaryButton(ui.confirmLabel, {}, modifier, state = CommandState.LOCKED, reason = ui.pausedReason)
        SealV2Primary.CHECK -> PrimaryButton("CHECK", { if (active) on.onRecover() }, modifier, verb = Verb.STONE)
        SealV2Primary.RETRY -> MoneyButton(MoneyStage.FAILED, ui.confirmLabel, { if (active) on.onRetry() }, modifier)
        SealV2Primary.MONEY -> MoneyButton(moneyStage(ui.state), ui.confirmLabel, {}, modifier)
        SealV2Primary.UNAVAILABLE -> PrimaryButton(ui.confirmLabel, {}, modifier, state = CommandState.DISABLED)
        SealV2Primary.SHORT -> PrimaryButton(ui.confirmLabel, {}, modifier, state = CommandState.DISABLED, reason = "Add SOL to your wallet first")
        SealV2Primary.CHECKING -> PrimaryButton("Checking", {}, modifier, verb = Verb.STONE, state = CommandState.BUSY)
        SealV2Primary.ARMING -> ArmingPrimaryV2(ui, active, on.onConfirm, clock, modifier)
    }
}

/** The gold primary with its sub-line and the 450 ms arming bar; taps before `sealAccepts` are ignored. */
@Composable private fun ArmingPrimaryV2(ui: VoyageSealV2Ui, active: Boolean, onConfirm: () -> Unit, clock: () -> Long, modifier: Modifier) {
    val c = PkwTokens.Colors
    val still = LocalInspectionMode.current
    val arm = remember(ui.armedAtMs) { Animatable(if (still) 1f else sealArmFraction(clock(), ui.armedAtMs)) }
    LaunchedEffect(ui.armedAtMs) {
        val remaining = ((1f - arm.value) * PkwTokens.Motion.SEAL_ARM).toInt()
        if (remaining > 0) arm.animateTo(1f, tween(remaining, easing = PkwTokens.Motion.Linear))
    }
    val confirm by rememberUpdatedState(onConfirm)
    ChunkyBox(c.gold, { if (active && sealAccepts(clock(), ui.armedAtMs)) confirm() }, listOfNotNull(ui.confirmLabel, ui.confirmSub).joinToString(", "),
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
            PkwText(ui.confirmLabel, PkwTokens.Type.primary, color = c.label, outline = 2.dp)
            ui.confirmSub?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch) }
        }
    }
}

/** One side of pay → get. */
@Composable private fun SealSideV2(art: VoyageSealSideUi) {
    val c = PkwTokens.Colors
    when (art.kind) {
        VoyageSealSideUi.Kind.VEHICLE -> SeaWell(Modifier.size(64.dp)) {
            art.family?.let { VehicleSprite(it, art.tier, 2, Modifier.fillMaxSize()) }
        }
        VoyageSealSideUi.Kind.BERTH -> SeaWell(Modifier.size(88.dp, 120.dp)) {
            art.family?.let { f ->
                PixelSprite(berthArt(f), 2, Modifier.size(82.dp, 114.dp), 56f, 54f, bottomArtY = 94)
                VehicleSprite(f, art.tier, 2, Modifier.size(82.dp, 114.dp))
            }
        }
        VoyageSealSideUi.Kind.TRIPS -> Column(Modifier.width(96.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            TripsMeter(10, 10, Modifier.fillMaxWidth(), height = 14.dp)
            PkwText(art.text ?: UNKNOWN, PkwTokens.Type.small, color = c.textOnParch)
        }
        VoyageSealSideUi.Kind.SOL -> Column(Modifier.widthIn(min = 96.dp).semantics(mergeDescendants = true) {
            contentDescription = "Pay ${art.text ?: UNKNOWN} SOL" }, horizontalAlignment = Alignment.CenterHorizontally) {
            PkwIcon("sol", 48.dp)
            PkwText(art.text ?: UNKNOWN, PkwTokens.Type.primary, color = c.textOnParch)
            PkwText(art.caption ?: "SOL", PkwTokens.Type.small, color = c.textOnParch2)
        }
        VoyageSealSideUi.Kind.ISLAND -> Column(Modifier.widthIn(min = 96.dp).semantics(mergeDescendants = true) {
            contentDescription = "Get ${art.text ?: UNKNOWN}, ${art.caption.orEmpty()}" }, horizontalAlignment = Alignment.CenterHorizontally) {
            SeaWell(Modifier.size(64.dp)) { art.route?.let { LocalVoyageArt.current.routeCutout(it, Modifier.size(60.dp)) } }
            PkwText(art.text ?: UNKNOWN, PkwTokens.Type.primary, color = c.textOnParch)
            art.caption?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
        }
    }
}

/** The realm's cut: cream, 2 dp ink rim, the 32 dp spot icon and the darker lead. Paint only. */
@Composable private fun CutBox(cut: VoyageCutUi) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().drawBehind {
        drawRect(c.ink)
        val i = 2.dp.toPx()
        drawRect(c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    }.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        cut.icon?.let { MapIcon(it, 32.dp) }
        Text(buildAnnotatedString {
            withStyle(SpanStyle(color = c.textOnParch)) { append(cut.lead) }
            append(" ")
            append(cut.text)
        }, Modifier.weight(1f), color = c.textOnParch2, style = PkwTokens.Type.small, maxLines = 3)
    }
}

/** The network-cost fine print: cream, 2 dp #C9A86A rim, VT 18; a SOL shortfall turns the rim #A3261A and adds GO WALLET. */
@Composable private fun NetworkBox(network: NetworkCostUi?, shortLine: String?, onAddSol: () -> Unit) {
    val c = PkwTokens.Colors
    val rim = if (shortLine != null) c.shortText else c.parchmentLo
    Row(Modifier.fillMaxWidth().drawBehind {
        drawRect(rim)
        val i = 2.dp.toPx()
        drawRect(c.cream, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    }.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            if (network != null) PkwText(networkCostLine(network.feeSol), PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3)
            if (shortLine != null) PkwText(shortLine, PkwTokens.Type.small, color = c.shortText, maxLines = 2)
        }
        if (shortLine != null) GoButton(onAddSol, "Open Profile, Wallet, to add SOL", Modifier.width(88.dp), label = "WALLET")
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun SealV2PreviewHost(ui: VoyageSealV2Ui) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { VoyageSealV2(ui, VoyageSealV2Actions(), clock = { 10_000L }) }
}

@Preview(name = "Voyage seal v2: install, network cost in the fine print (berth-install.png)", widthDp = 412, heightDp = 640)
@Composable private fun SealV2InstallPreview() = SealV2PreviewHost(VoyageR2Samples.installSeal)

@Preview(name = "Voyage seal v2: network cost being checked", widthDp = 412, heightDp = 640)
@Composable private fun SealV2FeeUnknownPreview() = SealV2PreviewHost(VoyageR2Samples.installSeal.copy(network = NetworkCostUi(null), quoteReady = false))

@Preview(name = "Voyage seal v2: INSUFFICIENT_SOL", widthDp = 412, heightDp = 640)
@Composable private fun SealV2ShortPreview() = SealV2PreviewHost(VoyageR2Samples.installSeal.copy(shortLine = "Need about 0.00002 more SOL in your wallet"))

@Preview(name = "Voyage seal v2: restore, sending", widthDp = 412, heightDp = 640)
@Composable private fun SealV2RestorePreview() = SealV2PreviewHost(VoyageR2Samples.restoreSeal.copy(state = VoyageSealState.SENDING))

@Preview(name = "Voyage seal v2: uncertain (CHECK)", widthDp = 412, heightDp = 640)
@Composable private fun SealV2UncertainPreview() = SealV2PreviewHost(VoyageR2Samples.installSeal.copy(state = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("The wallet didn't answer in time", authoritative = false)))

@Preview(name = "Voyage seal v2: declined (authoritative)", widthDp = 412, heightDp = 640)
@Composable private fun SealV2DeclinedPreview() = SealV2PreviewHost(VoyageR2Samples.installSeal.copy(state = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("You declined in the wallet", authoritative = true)))

@Preview(name = "Voyage seal v2: installs paused", widthDp = 412, heightDp = 640)
@Composable private fun SealV2PausedPreview() = SealV2PreviewHost(VoyageR2Samples.installSeal.copy(pausedReason = "Installs are paused. Your saved request is kept."))
