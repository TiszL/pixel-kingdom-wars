package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Berth › FLEET on the first visit (design/final/voyage/berth-starter.png, SPEC §10): the free starter
 * boat waiting in its berth (a gold-rimmed hero card), the four crafted-vehicle families as teasers ("Craft one at Solana
 * Island ▸"), the craft link, and the pinned INSTALL FREE. After the install the primary becomes blue GO TO LODGE.
 *
 * States: STARTER_BERTH_UNAVAILABLE (LOCKED with the server reason), busy (stone dots "Installing"), success (the host's
 * banner "Starter Boat is in its berth"; then GO TO LODGE), error (the caller's toast + Report). SPEC §10 open question:
 * if the server requires a wallet signature for the starter, the host raises [VoyageSeal] with "Free · You sign once" and
 * no fee line; this panel does not assume either way.
 *
 * Pointer rule: only the teaser cards, the craft GO and the primary take touches.
 */

/** Everything the starter panel draws (SPEC §10 Data `StarterFleetUi`). */
@Immutable data class StarterFleetUi(
    /** The server offers the starter to this kingdom. */
    val available: Boolean,
    /** It is installed (the primary becomes GO TO LODGE). */
    val installed: Boolean,
    /** Why it is unavailable (STARTER_BERTH_UNAVAILABLE's server reason). */
    val reason: String?,
    /** An install request is in flight ("Installing"). */
    val pending: Boolean,
    /** Added (owner Seeker 2026-10-06): crafted vehicles are not open on this server; drawn as a quiet line under MORE BERTHS
     *  in place of the craft link, never a RETRY. Null while crafted vehicles are open (or unknown). */
    val craftedOff: String? = null,
    /** Added: the installed boat is at sea ("Back in 1h 12m"); null while it is docked or not installed. */
    val atSeaLine: String? = null,
)

/** The starter panel's callbacks (SPEC §10 Callbacks). */
@Immutable data class StarterFleetActions(
    /** INSTALL FREE (and the LOCKED tap, so the caller can say why). */
    val onInstallStarter: () -> Unit = {},
    /** The craft link → Solana Island Public Workshop. */
    val onCraftLink: () -> Unit = {},
    /** A teaser card → toast "Craft one at Solana Island ▸". */
    val onFamilyTeaser: (VehicleFamily) -> Unit = {},
    /** GO TO LODGE after the install: the camera flies to the Lodge and opens SEND. */
    val onGoLodge: () -> Unit = {},
)

/** The starter body. */
@Composable fun ColumnScope.BerthStarterBody(ui: StarterFleetUi, on: StarterFleetActions) {
    val c = PkwTokens.Colors
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 250.dp).border(3.dp, c.gold.face, PixelShapes.M), tint = c.selectedTint) {
        Column(Modifier.fillMaxWidth().padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText(when { ui.atSeaLine != null -> "YOUR BOAT IS AT SEA"; ui.installed -> "YOUR BOAT IS IN"; else -> "YOUR FIRST BOAT" },
                PkwTokens.Type.title, color = c.textOnParch)
            SeaWell(Modifier.size(200.dp, 132.dp)) {
                PixelSprite(berthArt(VehicleFamily.STARTER), 4, Modifier.fillMaxSize(), 56f, 54f)
                // At sea: the berth is empty until the boat comes back.
                if (ui.atSeaLine == null) VehicleSprite(VehicleFamily.STARTER, null, 4, Modifier.fillMaxSize())
            }
            ui.atSeaLine?.let { Tag(it, Verb.BLUE) }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText("Starter Boat", PkwTokens.Type.body, color = c.textOnParch)
                Tag("FREE", Verb.GREEN)
            }
            PkwText("Sails coast trips from the Lodge and brings back wood, ore and more.", PkwTokens.Type.small,
                color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
        }
    }
    VoyageLabel("MORE BERTHS", "for crafted vehicles")
    ui.craftedOff?.let {
        PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf(VehicleFamily.SURVEY_BALLOON, VehicleFamily.CARGO_CUTTER, VehicleFamily.COURIER_AIRSHIP, VehicleFamily.EXPEDITION_BARGE).forEach { f ->
            Plate(PlateKind.CREAM, Modifier.weight(1f).heightIn(min = 96.dp)
                .clearAndSetSemantics { contentDescription = "${familyName(f)}: craft one at Solana Island"; role = Role.Button
                    onClick(label = null, action = { on.onFamilyTeaser(f); true }) }
                .clickable(role = Role.Button) { on.onFamilyTeaser(f) }) {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    SeaWell(Modifier.fillMaxWidth().height(62.dp), grey = true) {
                        VehicleSprite(f, 1, wellScale(f, tallWell = false), Modifier.fillMaxSize(), dim = EMPTY_SLOT_DIM)
                    }
                    PkwText(familyShortName(f), PkwTokens.Type.small, color = c.textOnParch)
                }
            }
        }
    }
    if (ui.craftedOff == null)
        GoRow("ui:solana-navigation", "Craft vehicles", "Public Workshop, Solana Island", "GO", on.onCraftLink, "Go to the Public Workshop on Solana Island")
}

/** The pinned INSTALL FREE / Installing / LOCKED / GO TO LODGE. */
@Composable fun ColumnScope.BerthStarterFooter(ui: StarterFleetUi, on: StarterFleetActions) {
    when {
        ui.installed -> PrimaryButton("GO TO LODGE", on.onGoLodge, Modifier.fillMaxWidth(), verb = Verb.BLUE, sub = "send it from there")
        ui.pending -> PrimaryButton("Installing", {}, Modifier.fillMaxWidth(), verb = Verb.STONE, state = CommandState.BUSY)
        !ui.available -> PrimaryButton("INSTALL FREE", on.onInstallStarter, Modifier.fillMaxWidth(), state = CommandState.LOCKED,
            reason = ui.reason ?: "The starter boat is not available on this server yet")
        else -> PrimaryButton("INSTALL FREE", on.onInstallStarter, Modifier.fillMaxWidth(), sub = "then send it from the Lodge")
    }
}
