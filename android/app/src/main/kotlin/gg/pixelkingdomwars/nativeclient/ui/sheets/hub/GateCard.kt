package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import kotlinx.coroutines.delay

/**
 * Design component: the gates (design/final/hub/update.png, maintenance.png; SPEC §3.7). A gate sits over everything,
 * sheets included: the world is parked and dimmed about 70 %, and a centred WoodFrame (x 16..396) says what is happening.
 * Update: the new Gold Forge on a sunray stage, "UPDATE TO KEEP PLAYING" (required) or "A NEW VERSION IS READY"
 * (optional, with LATER), what's new, gold UPDATE. Maintenance ("raising the drawbridge", owner's words): the approved
 * logo, the dwarf smith at work, the ETA, "Your kingdom is safe", stone CHECK AGAIN with the auto-check countdown and no
 * primary (the player has no job here). No emoji.
 */

/** Which gate. */
enum class GateKind { UPDATE_REQUIRED, UPDATE_OPTIONAL, MAINTENANCE }

/** Everything a gate draws (SPEC §3.7 `GateUi`; fields after `nextCheckIn` were added with defaults). */
@Immutable data class GateUi(
    val kind: GateKind,
    /** PS 13 ("UPDATE TO KEEP PLAYING", "A NEW VERSION IS READY", "RAISING THE DRAWBRIDGE"). */
    val title: String,
    /** VT 20 ("This version can't join the realm any more. Your kingdom stays exactly as it is."). */
    val body: String,
    /** WHAT'S NEW rows from the server's release notes; empty hides the section. */
    val notes: List<RowUi>,
    /** "0.7.0 · 38 MB · dApp Store" under UPDATE; null draws none. */
    val sizeLine: String?,
    /** Maintenance ETA ("20 minutes", drawn gold in "Back in about …"); null says "Back soon." */
    val etaLine: String?,
    /** "0:24" ([checkCountdown]) for "auto-check in 0:24"; null draws none. */
    val nextCheckIn: String?,
    /** CHECK AGAIN is running (dots). */
    val checking: Boolean = false,
    /** UPDATE is opening the store / in-app updater (dots). */
    val updating: Boolean = false,
    /** The maintenance reassurance row. */
    val safeTitle: String = "Your kingdom is safe",
    val safeLine: String = "Shields hold, timers keep running",
)

/** Gate callbacks. Back: only the optional update dismisses (= [onLater]); see [gateDismissible]. */
@Immutable data class GateActions(
    /** Opens the store listing or the in-app updater (existing flow). */
    val onUpdate: () -> Unit = {},
    /** Optional update only. */
    val onLater: () -> Unit = {},
    /** Maintenance CHECK AGAIN (the host also auto-checks every 30 s). */
    val onCheck: () -> Unit = {},
)

/**
 * A gate. Pass the gate to show, or null (it fades out 220 ms over the live world).
 *
 * Pointer rule: a gate is modal over everything, so its dim (a ModalScrim) is composed only while a gate is shown and
 * swallows taps (a tap does nothing; it never dismisses). Only the card's buttons act.
 */
@Composable fun GateCard(ui: GateUi?, on: GateActions, modifier: Modifier = Modifier) {
    Presence(ui, PkwTokens.Motion.PLATE_IN, PkwTokens.Motion.SHEET_IN) { gate, progress, active, _ ->
        Box(modifier.fillMaxSize()) {
            ModalScrim(HubMotion.GATE_DIM * progress(), onTap = {})
            Column(Modifier.align(Alignment.Center).padding(horizontal = 16.dp).widthIn(max = 380.dp).fillMaxWidth()
                .graphicsLayer { alpha = progress() }.semantics { paneTitle = gate.title; liveRegion = LiveRegionMode.Assertive },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (gate.kind == GateKind.MAINTENANCE) HubArt("logo", 211.dp, height = 147.dp, contentDescription = "Pixel Kingdom Wars")
                Plate(PlateKind.WOOD, Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp)) {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (gate.kind == GateKind.MAINTENANCE) MaintenanceHeader() else UpdateHeader()
                        Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                            Column(Modifier.fillMaxWidth().padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                PkwText(gate.title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.textOnParch,
                                    textAlign = TextAlign.Center, maxLines = 2)
                                if (gate.kind == GateKind.MAINTENANCE) MaintenanceBody(gate) else UpdateBody(gate)
                            }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                            when (gate.kind) {
                                GateKind.MAINTENANCE -> StoneBusyButton("CHECK AGAIN", gate.checking, { if (active) on.onCheck() }, Modifier.fillMaxWidth(),
                                    sub = gate.nextCheckIn?.let { "auto-check in $it" })
                                GateKind.UPDATE_OPTIONAL, GateKind.UPDATE_REQUIRED -> {
                                    if (gateDismissible(gate.kind)) SecondaryButton("LATER", { if (active) on.onLater() }, Modifier.width(100.dp))
                                    PrimaryButton("UPDATE", { if (active) on.onUpdate() }, Modifier.weight(1f), sub = gate.sizeLine,
                                        state = if (gate.updating) CommandState.BUSY else CommandState.ENABLED)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The 184 dp update header: the new Gold Forge (112 art × 3 = 168 dp) on the sunray stage, the "NEW VERSION" plate. */
@Composable private fun UpdateHeader() {
    LivingHeader(onClose = null, stage = HeaderStage.SUNRAYS, rayCentre = Offset(0.5f, 0.55f), height = 184.dp) {
        HubArt("goldforge-t3-idle", 168.dp, Modifier.align(Alignment.Center).padding(top = 12.dp), contentDescription = "The new Gold Forge")
        Plate(PlateKind.CHARCOAL, Modifier.align(Alignment.TopStart).padding(10.dp), blocksScene = false,
            contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 12.dp, bottom = 8.dp)) {
            PkwText("NEW VERSION", PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
        }
    }
}

/** The 176 dp forge header: stepped radial glow, sunrays and the dwarf smith (64 art × 2 = 128 dp, 16 frames at 12 fps). */
@Composable private fun MaintenanceHeader() {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val frame by produceState(0, reduced, inspection) {
        if (reduced || inspection) return@produceState
        val start = System.currentTimeMillis()
        while (true) {
            delay(1000L / HubMotion.DWARF_FPS)
            value = spriteFrame(System.currentTimeMillis() - start, HubMotion.DWARF_FRAMES, HubMotion.DWARF_FPS)
        }
    }
    LivingHeader(onClose = null, stage = HeaderStage.FORGE_GLOW, rayCentre = Offset(0.5f, 0.55f), height = 176.dp) {
        HubArt("gf-dwarf-smith", 128.dp, Modifier.align(Alignment.Center), contentDescription = "The dwarf smith at work", frame = frame)
    }
}

@Composable private fun UpdateBody(gate: GateUi) {
    PkwText(gate.body, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 4)
    if (gate.notes.isNotEmpty()) {
        SectionHeader("WHAT'S NEW")
        gate.notes.forEach { note ->
            CardRow(height = 58.dp) {
                note.icon?.let { Well(it, iconSize = if (it.startsWith("ui:")) 32.dp else 36.dp) }
                RowText(note.title, note.sub)
            }
        }
    }
}

@Composable private fun MaintenanceBody(gate: GateUi) {
    val eta = gate.etaLine
    val text = buildAnnotatedString {
        append(gate.body)
        if (eta == null) append(" Back soon.")
        else {
            append(" Back in about ")
            withStyle(SpanStyle(color = PkwTokens.Colors.gold.lo)) { append(eta) }
            append(".")
        }
    }
    Text(text, style = PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center)
    CardRow(height = 58.dp) {
        Well("shield", light = true, iconSize = 36.dp)
        RowText(gate.safeTitle, gate.safeLine)
    }
}

// ---- Previews (update.png, maintenance.png numbers) ----

private val sampleUpdate = GateUi(GateKind.UPDATE_REQUIRED, "UPDATE TO KEEP PLAYING",
    "This version can't join the realm any more. Your kingdom stays exactly as it is.",
    listOf(RowUi("forge", "keep", "The new Gold Forge", "Smelt, claim KEEP, buy Gems", RowKind.INFO),
        RowUi("seeker", "ui:seeker-navigation", "Auctions on Seeker Island", "Bid on spots from the map", RowKind.INFO),
        RowUi("workshop", "ui:workshop-menu", "Crafting at the Workshop", "Refine, cast and craft gear", RowKind.INFO)),
    sizeLine = "0.7.0 · 38 MB · dApp Store", etaLine = null, nextCheckIn = null)

@Preview(name = "Gate: update required (update.png)", widthDp = 412, heightDp = 915)
@Composable private fun GateUpdatePreview() { Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) { GateCard(sampleUpdate, GateActions()) } }

@Preview(name = "Gate: update optional (LATER)", widthDp = 412, heightDp = 915)
@Composable private fun GateUpdateOptionalPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        GateCard(sampleUpdate.copy(kind = GateKind.UPDATE_OPTIONAL, title = "A NEW VERSION IS READY", notes = emptyList()), GateActions())
    }
}

@Preview(name = "Gate: maintenance (maintenance.png)", widthDp = 412, heightDp = 915)
@Composable private fun GateMaintenancePreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        GateCard(GateUi(GateKind.MAINTENANCE, "RAISING THE DRAWBRIDGE", "The realm is being upgraded.", emptyList(), null, "20 minutes",
            checkCountdown(24)), GateActions())
    }
}

@Preview(name = "Gate: maintenance, no ETA, checking", widthDp = 412, heightDp = 915)
@Composable private fun GateMaintenanceCheckingPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        GateCard(GateUi(GateKind.MAINTENANCE, "RAISING THE DRAWBRIDGE", "The realm is being upgraded.", emptyList(), null, null, null, checking = true), GateActions())
    }
}
