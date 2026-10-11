package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize

/*
 * Design component: the Lodge tall sheet with the round-2 frames composed in (voyage/SPEC.md "Round 2 additions": E1.1
 * PASSPORT, E1.2 paid expedition, E1.3 CRAFTED dispatch; UX-ARCHITECTURE §7.3 `Destination.Lodge(tab, mode, routeId)`).
 * An EXTENSION of the committed `LodgeSheet.kt` (not an edit): the same kit SheetFrame, VoyageChart header, tabs
 * (`lodgeTabs`) and the committed SEND / picker / locked / TRIPS bodies, plus
 * - SEND: the STARTER · CRAFTED mode chips while [LodgeSheetR2Ui.craftedOffered] (SF(phaseE.advancedDispatch) + a Berth);
 *   CRAFTED shows [AdvancedSendBody] / [AdvancedSendFooter]; STARTER keeps the committed route-first body with the
 *   round-2 footer [LodgeSendFooterV2] ("SEND · with a 7-day permit", no SOL on the sheet);
 * - PASSPORT: its own header ([PassportHeader]: grass, Lodge, the passport book, "4 of 8 realms"), [PassportBody] and the
 *   pinned [PassportFooter] (blue SEND A TRIP), instead of the committed `passport` slot.
 * The permit Seal ([PermitSeal]) is the OverlayHost's.
 *
 * Pointer rule: the root is the kit SheetFrame, a painted wood panel; nothing here is a full-screen clickable, pointer
 * input, draggable or scrim. The TALL sheet's 40 % scrim belongs to the SheetHost, only while the sheet is shown; the
 * permit Seal's 55 % scrim to the OverlayHost, only while it shows.
 */

/** The Lodge sheet with its round-2 states. */
@Immutable data class LodgeSheetR2Ui(
    /** The round-1 sheet (level, tab, chart, SEND / picker / locked / TRIPS, supply stack, History, passport gate). */
    val base: LodgeSheetUi,
    /** The SEND mode ([LodgeSendMode.STARTER] route-first, [LodgeSendMode.CRAFTED] vehicle-first); Destination `mode`
     *  "advanced" maps to CRAFTED, anything else to STARTER. */
    val mode: String = LodgeSendMode.STARTER,
    /** True shows the STARTER · CRAFTED chips (SF(phaseE.advancedDispatch) and a Berth exists). */
    val craftedOffered: Boolean = false,
    /** The CRAFTED panel's state; null while CRAFTED has no data (the STARTER body shows). */
    val advanced: AdvancedSendUi? = null,
    /** PASSPORT; null draws a "Checking…" passport (never a blank tab). */
    val passport: PassportUi? = null,
    /** The permit length for "SEND · with a 7-day permit" (server). */
    val permitDays: Int? = null,
    val readError: String? = null,
)

/** The Lodge sheet's callbacks: round 1 plus the round-2 panels'. */
@Immutable data class LodgeSheetR2Actions(
    val base: LodgeSheetActions = LodgeSheetActions(),
    /** STARTER / CRAFTED chip (→ `replace(Lodge(SEND, mode))`). */
    val onMode: (String) -> Unit = {},
    val advanced: AdvancedSendActions = AdvancedSendActions(),
    val passport: PassportActions = PassportActions(),
    val onRetry: () -> Unit = {},
)

/**
 * The Lodge sheet, round 2. [modifier] must give it a bounded height (the SheetHost: TALL, from y 104 to the bottom).
 *
 * Pointer rule: the root is the kit SheetFrame (a painted wood panel); no full-screen clickable, pointerInput, scrim or
 * draggable here. The TALL 40 % scrim is the SheetHost's, only while shown; empty space outside reaches the kingdom.
 */
@Composable fun LodgeSheetR2(ui: LodgeSheetR2Ui, on: LodgeSheetR2Actions, modifier: Modifier = Modifier) {
    val base = ui.base
    val advanced = ui.advanced?.takeIf { ui.craftedOffered && ui.mode == LodgeSendMode.CRAFTED && base.tab == LodgeSheetUi.TAB_SEND }
    val key = lodgeR2PanelKey(ui)
    // Panel swaps in place: a 120 ms fade-in (SPEC §3 motion 2), never a new page.
    val reduced = LocalReducedMotion.current
    val fade = remember { Animatable(1f) }
    var lastKey by remember { mutableStateOf(key) }
    LaunchedEffect(key) {
        if (lastKey != key) {
            lastKey = key
            fade.snapTo(0f)
            fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH))
        }
    }
    val passport = ui.passport
    // Before its first snapshot PASSPORT draws "…" stats and skeleton stamps with its SEND A TRIP (SPEC E1.1 loading).
    val passportShown = lodgePassportShown(ui)
    val footerContent: @Composable ColumnScope.() -> Unit = {
        when {
            key == "SEND_CRAFTED" -> advanced?.let { AdvancedSendFooter(it, on.advanced) }
            key == LodgeSheetUi.TAB_TRIPS -> LodgeTripsFooter(base.trips, on.base.trips)
            key == "SEND_LOCKED" -> base.locked?.let { LodgeLockedFooter(it, on.base.locked) }
            key == LodgeSheetUi.TAB_SEND -> base.send?.let { LodgeSendFooterV2(it, on.base.send, ui.permitDays) }
            key == LodgeSheetUi.TAB_PASSPORT -> PassportFooter(passportShown, on.passport)
            else -> Unit
        }
    }
    // The picker has no pinned primary (a tile tap chooses); CRAFTED without a vehicle shows its empty doors only.
    val hasFooter = (key == "SEND_CRAFTED" && advanced?.vehicle != null) || key == LodgeSheetUi.TAB_TRIPS ||
        (key == "SEND_LOCKED" && base.locked != null) || (key == LodgeSheetUi.TAB_SEND && base.send != null) ||
        key == LodgeSheetUi.TAB_PASSPORT
    val selectedTab = when (key) {
        LodgeSheetUi.TAB_TRIPS, LodgeSheetUi.TAB_PASSPORT -> key
        else -> LodgeSheetUi.TAB_SEND
    }
    SheetFrame(SheetFrameUi("LODGE", null, SheetSize.TALL, lodgeTabs(base), selectedTab, titleTag = base.level,
        history = base.history && base.locked == null), onClose = on.base.onClose, modifier = modifier,
        onTab = on.base.onTab, onHistory = on.base.onHistory,
        header = {
            if (key == LodgeSheetUi.TAB_PASSPORT && passport != null) PassportHeader(passport)
            else VoyageChart(base.chart)
        },
        footer = if (hasFooter) footerContent else null) {
        Column(Modifier.fillMaxWidth().graphicsLayer { alpha = fade.value }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ui.readError?.let { reason ->
                gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState(
                    gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi("ui:lodge-menu", "LODGE", reason, null, null), onGo = {})
                gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton("RETRY", on.onRetry, Modifier.fillMaxWidth())
            }
            if (lodgeModeChipsShown(ui)) LodgeModeChips(if (advanced != null) LodgeSendMode.CRAFTED else ui.mode, on.onMode)
            when (key) {
                "SEND_CRAFTED" -> advanced?.let { AdvancedSendBody(it, on.advanced) }
                LodgeSheetUi.TAB_TRIPS -> LodgeTripsBody(base.trips, on.base.trips)
                LodgeSheetUi.TAB_PASSPORT -> PassportBody(passportShown, on.passport)
                "SEND_LOCKED" -> base.locked?.let { LodgeLockedBody(it, on.base.locked) }
                "SEND_PICKER" -> LodgeRoutePickerBody(base.picker ?: LodgePickerUi(base.send?.routes.orEmpty(), null, null, emptyMap(), RouteFilter.ALL, loading = true),
                    on.base.picker)
                else -> base.send?.let { LodgeSendBody(it, on.base.send) }
            }
        }
    }
}

/** Which panel the round-2 sheet shows: the CRAFTED panel ("SEND_CRAFTED") on the SEND tab while CRAFTED is offered and
 *  chosen, else the round-1 [LodgeSheetUi.panelKey]. */
internal fun lodgeR2PanelKey(ui: LodgeSheetR2Ui): String {
    val baseKey = ui.base.panelKey
    val onSendTab = baseKey == LodgeSheetUi.TAB_SEND || baseKey == "SEND_PICKER" || baseKey == "SEND_LOCKED"
    val crafted = ui.advanced != null && ui.craftedOffered && ui.mode == LodgeSendMode.CRAFTED && ui.base.tab == LodgeSheetUi.TAB_SEND
    return if (crafted && onSendTab) "SEND_CRAFTED" else baseKey
}

/**
 * The STARTER · CRAFTED chips show on SEND while CRAFTED is offered, but not over the no-vehicle panel: send-locked.png
 * has none, and its one door is GO TO BERTH. A player already in CRAFTED keeps them, so STARTER stays one tap away.
 */
internal fun lodgeModeChipsShown(ui: LodgeSheetR2Ui): Boolean {
    val key = lodgeR2PanelKey(ui)
    val sendTab = key != LodgeSheetUi.TAB_TRIPS && key != LodgeSheetUi.TAB_PASSPORT
    return ui.craftedOffered && sendTab && key != "SEND_LOCKED"
}

/** PASSPORT before its first snapshot: "…" stats and skeleton stamps (SPEC E1.1 loading), never a blank tab. */
internal val PASSPORT_FIRST_LOAD = PassportUi(UNKNOWN, UNKNOWN, UNKNOWN, emptyList(), emptyList(), null, SourceState.OK, loading = true)

/** The passport the tab draws: the live one, or [PASSPORT_FIRST_LOAD] while none has arrived. */
internal fun lodgePassportShown(ui: LodgeSheetR2Ui): PassportUi = ui.passport ?: PASSPORT_FIRST_LOAD

/** Renders the round-2 Lodge sheet the way the SheetHost does on the 412 × 915 phone (y 104 → bottom). */
@Composable internal fun LodgeR2PreviewHost(ui: LodgeSheetR2Ui) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        LodgeSupplyStack(ui.base.supplyStack, {}, Modifier.align(Alignment.TopEnd).padding(top = 14.dp, end = 8.dp))
        LodgeSheetR2(ui, LodgeSheetR2Actions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}
