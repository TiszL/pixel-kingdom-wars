package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Lodge › SEND with no vehicle installed (design/final/voyage/send-locked.png, SPEC §6): a new player
 * learns the loop and goes to the one place that unblocks it. The furled-sail empty state, the eight raw resources the 32
 * islands bring home (each a door to the resource drawer), "HOW A TRIP WORKS" in three steps, and a BLUE GO TO BERTH
 * (navigation is blue; the Lodge has no gold job here). Variants: no Berth built (BUILD BERTH), Keep too low (LOCKED).
 * "Starter installed but out" is not this screen: it is SEND with every card AWAY.
 *
 * Pointer rule: only the resource cards and the primary take touches.
 */

/** Which blocker the player meets. */
enum class LodgeLockedVariant {
    /** A Berth exists but holds no vehicle: GO TO BERTH. */
    NO_VEHICLE,
    /** No Berth on the base: BUILD BERTH (Build shop, focused on the Berth). */
    NO_BERTH,
    /** The Berth cannot be built yet: LOCKED with [LodgeLockedUi.unlockReason] ("Unlocks at Keep 5"). */
    BERTH_LOCKED,
}

/** One raw resource card (a door to the drawer at that row). */
@Immutable data class VoyageResourceUi(
    val id: String,
    /** 64 px art drawn at 32 dp. */
    val icon: String,
    /** "Heartwood Logs" (screen readers). */
    val name: String,
)

/** Everything the locked SEND draws. */
@Immutable data class LodgeLockedUi(
    val variant: LodgeLockedVariant,
    /** BERTH_LOCKED's reason. */
    val unlockReason: String? = null,
    /** The eight realm raw resources, in drawer order. */
    val resources: List<VoyageResourceUi> = emptyList(),
    /** "32" from the route catalogue; "…" while it loads. */
    val islandCount: String = "…",
)

/** The locked SEND's callbacks (SPEC §6). */
@Immutable data class LodgeLockedActions(
    /** GO TO BERTH → the Berth sheet (SPEC: FocusBuilding("berth", Berth(FLEET, "starter")); the camera flight is renderer work). */
    val onGoBerth: () -> Unit = {},
    /** BUILD BERTH → Build shop focused on the Berth; also called on the LOCKED primary so the caller can say why. */
    val onBuildBerth: () -> Unit = {},
    /** A resource card → the resource drawer at that row ("every resource is a door"). */
    val onResource: (id: String) -> Unit = {},
)

/** The locked SEND body. */
@Composable fun ColumnScope.LodgeLockedBody(ui: LodgeLockedUi, on: LodgeLockedActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon("ui:exhausted-status", 64.dp, alpha = 0.4f)
        PkwText(if (ui.variant == LodgeLockedVariant.NO_VEHICLE) "No boat at the Berth yet" else "Build a Berth first", PkwTokens.Type.lead,
            color = c.textOnParch, textAlign = TextAlign.Center)
        PkwText(if (ui.variant == LodgeLockedVariant.NO_VEHICLE) "Your free starter boat waits at the Berth. Install it there, then sail from here."
            else "The Berth docks your boats. Build one, install the free starter boat, then sail from here.",
            PkwTokens.Type.body, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
    }
    // send-locked.html divider: 2 dp parch-dk at 60 %.
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(2.dp).background(c.parchmentLo.copy(alpha = 0.6f)))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        PkwText("${ui.islandCount} ISLANDS", PkwTokens.Type.caption, color = c.textOnParch2)
        PkwText("${if (ui.resources.isEmpty()) "…" else ui.resources.size} resources to bring home", PkwTokens.Type.small, color = c.textOnParch2)
    }
    // A 4 × 2 grid of 72 × 60 CreamCards, 8 apart, centred (send-locked.html grid).
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.resources.chunked(4).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { r ->
                    Plate(PlateKind.CREAM, Modifier.size(72.dp, 60.dp)
                        .clearAndSetSemantics { contentDescription = "${r.name}. Where it comes from"; role = Role.Button; onClick(label = null, action = { on.onResource(r.id); true }) }
                        .clickable(role = Role.Button) { on.onResource(r.id) }) {
                        VoyageIcon(r.icon, 32.dp, Modifier.align(Alignment.Center))
                    }
                }
                repeat(4 - row.size) { Box(Modifier.size(72.dp, 60.dp)) }
            }
        }
    }
    PkwText("HOW A TRIP WORKS", PkwTokens.Type.caption, Modifier.fillMaxWidth().padding(top = 8.dp), color = c.textOnParch2, textAlign = TextAlign.Center)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Step("1", "Install a boat at the Berth", Modifier.weight(1f)) {
            Box(Modifier.size(56.dp)) {
                PixelSprite(berthArt(VehicleFamily.STARTER), 1, Modifier.size(56.dp), 56f, 54f)
                VehicleSprite(VehicleFamily.STARTER, null, 1, Modifier.size(56.dp))
            }
        }
        Step("2", "Pick an island here", Modifier.weight(1f)) { PkwIcon("ui:lodge-menu", 32.dp) }
        Step("3", "Collect what it brings", Modifier.weight(1f)) { PkwIcon("ui:ready-status", 32.dp) }
    }
}

/** One "HOW A TRIP WORKS" card (CreamCard, ≥ 104 tall): gold number, art, two VT lines. Not a target. */
@Composable private fun Step(n: String, text: String, modifier: Modifier, art: @Composable () -> Unit) {
    Plate(PlateKind.CREAM, modifier.heightIn(min = 104.dp), contentPadding = PaddingValues(start = 4.dp, top = 8.dp, end = 4.dp, bottom = 6.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(n, PkwTokens.Type.label, color = PkwTokens.Colors.gold.lo)
                art()
            }
            PkwText(text, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
        }
    }
}

/**
 * The pinned blue GO TO BERTH (or BUILD BERTH / LOCKED). send-locked.png's sub-line is "the camera flies there", but
 * tonight GO TO BERTH opens the Berth sheet without a camera flight (renderer work), so the line says what happens.
 */
@Composable fun ColumnScope.LodgeLockedFooter(ui: LodgeLockedUi, on: LodgeLockedActions) {
    when (ui.variant) {
        LodgeLockedVariant.NO_VEHICLE -> PrimaryButton("GO TO BERTH", on.onGoBerth, Modifier.fillMaxWidth(), verb = Verb.BLUE, sub = GO_TO_BERTH_SUB)
        LodgeLockedVariant.NO_BERTH -> PrimaryButton("BUILD BERTH", on.onBuildBerth, Modifier.fillMaxWidth(), verb = Verb.BLUE, sub = "opens the build shop")
        LodgeLockedVariant.BERTH_LOCKED -> PrimaryButton("BUILD BERTH", on.onBuildBerth, Modifier.fillMaxWidth(), verb = Verb.BLUE,
            state = CommandState.LOCKED, reason = ui.unlockReason ?: "Unlocks at a higher Keep level")
    }
}

/** GO TO BERTH's sub-line: what the tap does tonight (it opens the Berth sheet; there is no camera flight yet). */
const val GO_TO_BERTH_SUB = "opens the Berth"
