package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.countUpText
import gg.pixelkingdomwars.nativeclient.ui.kit.integerArtScale
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: Gold Forge › LEGACY, round 2 (design/final/goldforge/legacy.png; SPEC "E1.1 Gold Forge LEGACY tab",
 * registry row 43 `GoldForge(tab = "LEGACY")`). Replaces the round-1 signpost `LegacyTab.kt`. Purpose: "money moved is
 * money honoured" (D-009) for the in-game KEEP balance from before the update — what is saved, what happens to it
 * (D-152: on update day it becomes Gems 1:1, automatically: nothing to claim, no SOL), and the old withdrawals still on
 * their way. The tab exists only while the server says so (`AnyOf(SF(forge.legacyLive), HasHistory(forge.owed),
 * HasHistory(forge.saved))`); it is never a HUD chip, and the saved KEEP never appears as a readout (the top stack shows
 * Gems only: what the balance becomes).
 *
 * Layout: the dark well 132 (CLAIM recipe, rays 60 %): storage crate 128 (64 art × 2), "SAVED IN THE FORGE", KEEP 24 +
 * the outlined figure, "from before the update", "yours, kept safe"; "WHAT HAPPENS · nothing to do" with three step
 * cards (1 Saved here now [gold rim] · 2 Gems on update day · 3 1,820 Gems to spend) and "Each KEEP becomes a Gem. The
 * date comes to your Mail first." (drawn only with [LegacyV2Ui.conversionPlanCurrent]: no server sets `forge.legacyLive`
 * or an update day yet, so the live adapter hides it); "ON THEIR WAY TO YOUR WALLET" with ONE 84 dp summary card ("2 on the way · 1 arrived",
 * "Next in 2d 4h · 1 being checked", "Tap to see each one.", chevron) that opens the forge history list
 * ([LegacyWithdrawalsList], each withdrawal a 76 dp row). No gold primary: nothing here is a purchase, the update needs
 * no action. The slogan is a design rule only (not on screen). Copy: "withdraw/withdrawal" only on this tab; never
 * "custody", "custodial", "escrow", "transaction" or "cutover".
 *
 * Motion: tab in 120 ms (SheetFrame); a successful return ticks the well's figure up over 600 ms (the cluster's count-up);
 * no celebration (a recovery, not a reward). Reduced motion: switches.
 *
 * Pointer rule: drawn inside the Gold Forge sheet's painted parchment panel; only the summary card, the row actions and
 * the ConfirmDialog's buttons take touches (each ≥ 48 dp, a scene-input region). The ConfirmDialog ([LegacyReturnConfirm])
 * is full-screen with its 55 % scrim only while shown.
 */

/** Where an old withdrawal stands (SPEC `LegacyWithdrawalUi.State`). */
enum class WithdrawalState { UNLOCKING, CHECKING, SENT, RETURNED, REFUSED }

/** One old withdrawal (SPEC `LegacyWithdrawalUi(id, amount, state, line, canReturn, proof)`; `busy` was added). */
@Immutable data class LegacyWithdrawalUi(
    val id: String,
    /** KEEP, server-formatted ("200"). */
    val amount: String,
    val state: WithdrawalState,
    /** One VT 18 line, never wrapping ("In your wallet in 2d 4h", "In your wallet since 12 Sep"). */
    val line: String,
    /** The server says a refund is safe: UNLOCKING offers BACK TO FORGE (the native `WithdrawalUnwindPanel`). */
    val canReturn: Boolean,
    /** The history id of the proof (SENT); null = none. */
    val proof: String?,
    /** Added: BACK TO FORGE is in flight (stone dots "Bringing back"; the summary keeps its last counts). */
    val busy: Boolean = false,
)

/** Gold Forge › LEGACY state (SPEC `LegacyUi`, renamed because the round-1 `LegacyUi` in LegacyTab.kt takes the name;
 *  fields after `live` were added). */
@Immutable data class LegacyV2Ui(
    /** KEEP saved in the forge: the server's decimal ("1820", drawn "1,820" through [legacySavedText]) or a figure already
     *  formatted ("1,820"); null/"…" = unknown, "0" only when the server says 0. */
    val saved: String?,
    /** The update day ("14 Oct"); null = "The date comes to your Mail first" (the frame never invents one). */
    val cutoverAt: String?,
    /** "Each KEEP becomes a Gem" (from GEMS); no "=" exchange-rate line. */
    val rate: String,
    /** Old withdrawals still tracked; empty hides the section and the card. */
    val withdrawals: List<LegacyWithdrawalUi>,
    /** "2 min ago"; null = unknown. */
    val refreshedAgo: String?,
    /** `SF(forge.legacyLive)`; the live chip says "Furnace lit" only (the host's hero status). */
    val live: Boolean,
    /** Added: after the update, "Turned into 1,820 Gems on 14 Oct" (+ green DONE); null before it. */
    val convertedLine: String? = null,
    /** Added: the soonest UNLOCKING arrival ("2d 4h") for "Next in 2d 4h". */
    val nextIn: String? = null,
    /** Added: a refresh is running (2 dp stone line; last good values stay). */
    val loading: Boolean = false,
    /** Added: the forge can't reach the server: the saved figure keeps its last good value labelled "as of 14:20" (the
     *  toast is the host's). */
    val asOf: String? = null,
    /** Added: the update is running ("The forge is moving saved KEEP into Gems"): every row action is off with this reason
     *  (the herald banner is the host's). */
    val frozenReason: String? = null,
    /** The owner has current authority for the conversion plan. False keeps only the saved balance and history. */
    val conversionPlanCurrent: Boolean = true,
)

/** Gold Forge › LEGACY callbacks (SPEC: onHistory(id), onReturn(id) → ConfirmDialog → onConfirmReturn(id), onCheck(id),
 *  onTab(tab), onClose()). */
@Immutable data class LegacyV2Actions(
    /** The summary card → the forge history list (null = the whole list); a SENT row's chevron → its proof. */
    val onHistory: (id: String?) -> Unit = {},
    /** BACK TO FORGE on an UNLOCKING row → raise the ConfirmDialog. */
    val onReturn: (id: String) -> Unit = {},
    /** The ConfirmDialog's BRING BACK (no wallet step). */
    val onConfirmReturn: (id: String) -> Unit = {},
    /** The ConfirmDialog's BACK / scrim / system Back. */
    val onCancelReturn: () -> Unit = {},
    /** CHECK AGAIN on a CHECKING row: re-read the original request (never send it again). */
    val onCheck: (id: String) -> Unit = {},
    /** A tab tap (the sheet's `onTab` when mounted in the Gold Forge sheet). */
    val onTab: (String) -> Unit = {},
    /** Close (the sheet's `onClose`). */
    val onClose: () -> Unit = {},
    /** A refused action while frozen: toast the reason. */
    val onExplain: (String?) -> Unit = {},
)

/** The LEGACY body (no footer, no gold primary). */
@Composable fun ColumnScope.LegacyV2Body(ui: LegacyV2Ui, on: LegacyV2Actions) {
    val c = PkwTokens.Colors
    if (ui.loading) Box(Modifier.fillMaxWidth().height(2.dp).background(c.stone.face))
    SavedWell(ui)
    if (ui.conversionPlanCurrent) {
        // legacy.png sets "nothing to do" right after the heading, not at the row's far end.
        SectionRow("WHAT HAPPENS", tag = { PkwText("nothing to do", PkwTokens.Type.small, color = c.textOnParch2) })
        StepRow(legacySteps(ui))
        PkwText(legacyRateNote(ui.rate, ui.cutoverAt), PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 2)
    }
    if (ui.withdrawals.isNotEmpty()) {
        SectionRow("ON THEIR WAY TO YOUR WALLET")
        SummaryCard(ui, on)
    }
}

/** The dark well (132): crate 128, "SAVED IN THE FORGE", KEEP 24 + the outlined figure, two lines; or "Nothing saved
 *  here"; or the converted line + DONE. Geometry from legacy.html: the crate sits 14 dp inside the 3 dp shell (DarkWell
 *  pads 8, so 6 + 3 more), 2 dp below its top, and may overhang the 114 dp content box (132 − DarkWell's 8 + 10 padding)
 *  like the frame's clipped `img` does, so the crate never grows the well past 132; its bottom rows are transparent. The
 *  text column starts 8 dp after the crate. */
@Composable private fun SavedWell(ui: LegacyV2Ui) {
    val c = PkwTokens.Colors
    val state = legacyWellState(ui)
    DarkWell(Modifier.fillMaxWidth().heightIn(min = 132.dp), rays = 0.6f) {
        Row(Modifier.fillMaxWidth().align(Alignment.CenterStart).padding(start = 9.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(width = 128.dp, height = 114.dp)) {
                LegacyArt("gf:storage_crate", 128.dp, Modifier.offset(y = 4.dp).requiredSize(128.dp), contentDescription = "The forge's storage crate")
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                when (state) {
                    LegacyWellState.NOTHING_SAVED -> PkwText("Nothing saved here", PkwTokens.Type.body, color = c.text, maxLines = 2)
                    LegacyWellState.CONVERTED -> {
                        PkwText(ui.convertedLine.orEmpty(), PkwTokens.Type.body, color = c.text, maxLines = 3)
                        Tag("DONE", Verb.GREEN)
                    }
                    LegacyWellState.SAVED -> {
                        PkwText("SAVED IN THE FORGE", PkwTokens.Type.small, color = c.muted)
                        // KEEP 24 + PS 16 outlined (TOKENS numeralL, as the CLAIM tray's figure), 8 dp apart.
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            GfIcon("gf:keep_24", 24.dp)
                            CountUpFigure(legacySavedText(ui.saved))
                        }
                        // One line on the 412 dp frame; a narrower phone wraps it instead of cutting it.
                        PkwText("from before the update", PkwTokens.Type.body, color = c.text, maxLines = 2)
                        PkwText(legacySavedCaption(ui.asOf), PkwTokens.Type.small, color = c.muted)
                    }
                }
            }
        }
    }
}

/** The 84 dp summary card (legacy.html `.lrow`): KEEP 24, PS 12 "2 on the way · 1 arrived", VT 18 "Next in 2d 4h · 1
 *  being checked", VT 18 "Tap to see each one.", the chevron in its 48 dp box; cream with the 4 dp `#E8D3A0` lip, 6 dp side
 *  padding, 8 dp gaps. The whole card is one ≥ 48 dp target that opens the history list (`onHistory(null)`). */
@Composable private fun SummaryCard(ui: LegacyV2Ui, on: LegacyV2Actions) {
    val c = PkwTokens.Colors
    val s = legacySummary(ui.withdrawals)
    val title = legacySummaryTitle(s)
    val line = legacySummaryLine(s, ui.nextIn)
    Row(Modifier.fillMaxWidth().heightIn(min = 84.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = listOfNotNull(title, line, "Tap to see each one").joinToString(". "); role = Role.Button
            this.onClick(label = null, action = { on.onHistory(null); true })
        }
        .clickable(role = Role.Button) { on.onHistory(null) }
        .drawBehind { creamRow(c.cream) }
        .padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GfIcon("gf:keep_24", 24.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            PkwText(title, PkwTokens.Type.label, color = c.textOnParch)
            line?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
            PkwText("Tap to see each one.", PkwTokens.Type.small, color = c.textOnParch2)
        }
        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { Chevron() }
    }
}

/** The `.lrow` paint: 2 dp ink, [face], and the 4 dp `#E8D3A0` lip (TOKENS creamLo) along the bottom, as the CLAIM
 *  DestinationRow draws it. */
private fun DrawScope.creamRow(face: Color) {
    val c = PkwTokens.Colors
    drawRect(c.ink)
    val i = 2.dp.toPx()
    drawRect(face, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
    drawRect(c.creamLo, Offset(i, size.height - i - 4.dp.toPx()), Size(size.width - 2 * i, 4.dp.toPx()))
}

/**
 * The forge history list behind the summary card (SPEC: not drawn as a frame; it reuses the Profile › HISTORY row
 * recipe): one 76 dp row per withdrawal — amount + tag, one VT 18 line, and BACK TO FORGE (UNLOCKING, only when safe),
 * CHECK AGAIN (CHECKING, on a #FFF3C8 row), a proof chevron (SENT) or dots "Bringing back" while a return is in flight.
 * Mount it as the body of `WalletHistory(home = "goldforge", section = "legacy")` or inside the History hub.
 *
 * Pointer rule: a plain column inside its host's painted panel; only the row actions take touches.
 */
@Composable fun ColumnScope.LegacyWithdrawalsList(ui: LegacyV2Ui, on: LegacyV2Actions) {
    val c = PkwTokens.Colors
    ui.frozenReason?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, maxLines = 2) }
    ui.withdrawals.forEach { w -> WithdrawalRow(w, withdrawalLook(w, frozen = ui.frozenReason != null), on) }
}

/** One 76 dp withdrawal row (the `.lrow` recipe: 6 dp side padding, 8 dp gaps, the cream or `#FFF3C8` CHECKING face with
 *  its 4 dp lip): amount + tag, then exactly one VT 18 line that never wraps (an over-long line ends in "…"). */
@Composable private fun WithdrawalRow(w: LegacyWithdrawalUi, look: WithdrawalLook, on: LegacyV2Actions) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).drawBehind { creamRow(if (look.tinted) c.selectedTint else c.cream) }
        .padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GfIcon("gf:keep_24", 24.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText("${legacySavedText(w.amount)} KEEP", PkwTokens.Type.label, color = c.textOnParch)
                Tag(look.tag, look.verb)
            }
            PkwText(look.line, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 1)
        }
        when {
            w.busy -> Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BusyDots()
                PkwText("Bringing back", PkwTokens.Type.small, color = c.textOnParch2)
            }
            look.action == WithdrawalAction.BACK_TO_FORGE ->
                SecondaryButton("BACK TO FORGE", { on.onReturn(w.id) }, Modifier.width(136.dp), contentDescription = "Bring ${legacySavedText(w.amount)} KEEP back to the forge")
            look.action == WithdrawalAction.CHECK_AGAIN ->
                SecondaryButton("CHECK AGAIN", { on.onCheck(w.id) }, Modifier.width(128.dp), contentDescription = "Check this withdrawal again")
            look.action == WithdrawalAction.PROOF -> Box(Modifier.size(48.dp).sceneInputRegion()
                .clearAndSetSemantics { contentDescription = "See the proof"; role = Role.Button; this.onClick(label = null, action = { on.onHistory(w.proof); true }) }
                .clickable(role = Role.Button) { on.onHistory(w.proof) }, contentAlignment = Alignment.Center) { Chevron() }
        }
    }
}

/**
 * The BACK TO FORGE ConfirmDialog (SPEC E1.1): "Bring 200 KEEP back to the forge? The forge checks this one again first.
 * No wallet step." — not a money Seal (nothing leaves the wallet), so no arming bar: stone BACK + green BRING BACK.
 *
 * Pointer rule: pass the row to confirm, or null. Full-screen with its 55 % scrim only while shown or animating out (the
 * cluster's `ForgeSeal` shell); a scrim tap is BACK, never confirm.
 */
@Composable fun LegacyReturnConfirm(target: LegacyWithdrawalUi?, on: LegacyV2Actions, modifier: Modifier = Modifier, onExitFinished: () -> Unit = {}) {
    ForgeSeal(target, { "BACK TO THE FORGE" }, { on.onCancelReturn() }, modifier, onExitFinished) { w, active ->
        PkwText(returnConfirmLine(w.amount), PkwTokens.Type.body, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch,
            textAlign = TextAlign.Center, maxLines = 4)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            SecondaryButton("BACK", { if (active) on.onCancelReturn() }, Modifier.width(PkwTokens.Dims.sealBackW))
            PrimaryButton("BRING BACK", { if (active) on.onConfirmReturn(w.id) }, Modifier.weight(1f), verb = Verb.GREEN)
        }
    }
}

/** The well's figure: PS 16 (TOKENS numeralL) outlined gold-hi; a changed whole number counts up over 600 ms (kit
 *  `countUpText` rules; only plain or comma-grouped whole numbers count, "…" switches). Reduced motion switches. */
@Composable private fun CountUpFigure(value: String) {
    val reduced = LocalReducedMotion.current
    var from by remember { mutableStateOf(value) }
    val t = remember { Animatable(1f) }
    LaunchedEffect(value) {
        if (!reduced && from != value) {
            t.snapTo(0f)
            t.animateTo(1f, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out))
        }
        from = value
    }
    PkwText(countUpText(from, value, t.value), PkwTokens.Type.numeralL, color = PkwTokens.Colors.gold.hi, outline = 2.dp)
}

/** The LEGACY tab's art: the storage crate copy (`gf:storage_crate`, 64 px, ASSET-COPIES-r2-goldforge.md) at a whole
 *  scale with nearest sampling; every other name goes to [GfIcon]. Paint only. */
@Composable private fun LegacyArt(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null) {
    if (name != "gf:storage_crate") { GfIcon(name, size, modifier, contentDescription); return }
    val bitmap = ImageBitmap.imageResource(R.drawable.pkw_ui_gf_storage_crate)
    val described = if (contentDescription == null) Modifier.clearAndSetSemantics { } else Modifier.clearAndSetSemantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) {
        val k = minOf(integerArtScale(this.size.width, bitmap.width), integerArtScale(this.size.height, bitmap.height))
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
            dstOffset = IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()),
            dstSize = IntSize(w, h), filterQuality = FilterQuality.None)
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun ListPreviewHost(ui: LegacyV2Ui) {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.parchment).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        LegacyWithdrawalsList(ui, LegacyV2Actions())
    }
}

@Preview(name = "LEGACY history list: unlocking, checking, sent, refused, bringing back", widthDp = 398, heightDp = 520)
@Composable private fun LegacyListPreview() = ListPreviewHost(GoldForgeR2Samples.legacy.copy(withdrawals = GoldForgeR2Samples.legacy.withdrawals +
    LegacyWithdrawalUi("w-4", "60", WithdrawalState.REFUSED, "", canReturn = false, proof = null) +
    LegacyWithdrawalUi("w-5", "40", WithdrawalState.UNLOCKING, "In your wallet in 5d 1h", canReturn = true, proof = null, busy = true)))

@Preview(name = "LEGACY history list: frozen during the update", widthDp = 398, heightDp = 420)
@Composable private fun LegacyListFrozenPreview() = ListPreviewHost(GoldForgeR2Samples.legacy.copy(frozenReason = "The forge is moving saved KEEP into Gems."))

@Preview(name = "LEGACY: BACK TO FORGE confirm", widthDp = 412, heightDp = 640)
@Composable private fun LegacyConfirmPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg)) {
        LegacyReturnConfirm(GoldForgeR2Samples.legacy.withdrawals.first(), LegacyV2Actions())
    }
}
