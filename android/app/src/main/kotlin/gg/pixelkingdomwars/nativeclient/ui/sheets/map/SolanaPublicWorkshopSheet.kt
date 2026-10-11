package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.vehicleIdleArt

/*
 * Design component: the Public Workshop sheet on Solana Island (design/final/map/SPEC.md §4.1, solana-island.png):
 * always open, whatever the licence draw. Header "PUBLIC WORKSHOP" + green OPEN, the line, YOU CAN CRAFT (up to three
 * CreamCards 84 with the T1 idle vehicle at 56, each a door into crafting that family), the public queue row, and the gold
 * CRAFT VEHICLE with its SOL CostPill (server price; "…" while checking, "unavailable" on failure). CRAFT opens the
 * existing VehicleCraftPanel through the one fleet-command owner; this sheet is never a second owner.
 */

/** One craftable vehicle family (SPEC §4.1 YOU CAN CRAFT). */
@Immutable data class CraftFamilyUi(val family: VehicleFamily, val name: String, val tier: Int? = 1)

/** Everything the Public Workshop sheet draws. */
@Immutable data class PublicWorkshopUi(
    /** Up to three families. */
    val families: List<CraftFamilyUi>,
    /** "Public queue: 3 ahead / about 20m · licence draw opens later" ("…" while unknown). */
    val queueLine: String,
    /** The per-try price (SOL); CHECKING draws "…", UNAVAILABLE "unavailable", SHORT the red pill. */
    val price: PriceUi,
    /** The primary's state: LOCKED with [reason] when the server has the feature off. */
    val state: CommandState = CommandState.ENABLED,
    val reason: String? = null,
    /** No Lodge yet: EmptyState "Build a Lodge to send vehicles" + GO TO LODGE. */
    val noLodge: Boolean = false,
    val testData: Boolean = false,
)

/** Public Workshop callbacks (SPEC §4.1). */
@Immutable data class PublicWorkshopActions(
    /** CRAFT VEHICLE (null family) or a family card: open crafting via `FleetCommandOwners.open(VEHICLES)`. */
    val onCraft: (VehicleFamily?) -> Unit = {},
    /** A SHORT pill: Need-more ("SOL comes from your wallet" + Profile › WALLET). */
    val onNeedMore: () -> Unit = {},
    val onGoLodge: () -> Unit = {},
    /** A locked / disabled primary: its reason (toast). */
    val onExplain: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The Public Workshop sheet (SPEC §4.1).
 *
 * Pointer rule: a HALF sheet with no scrim; only the painted frame, the family cards and the buttons take touches.
 */
@Composable fun PublicWorkshopSheet(ui: PublicWorkshopUi, on: PublicWorkshopActions, modifier: Modifier = Modifier) {
    val short = ui.price.status == PriceStatus.SHORT
    MapSheetFrame("PUBLIC WORKSHOP", "site:solana-active", on.onClose, modifier,
        tags = listOfNotNull(MapTagUi("OPEN", Verb.GREEN), MapTagUi("TEST DATA", Verb.STONE).takeIf { ui.testData }),
        footer = if (ui.noLodge) null else ({
            val state = if (short && ui.state == CommandState.ENABLED) CommandState.SHORT else ui.state
            PrimaryButton("CRAFT VEHICLE", {
                when (state) {
                    CommandState.ENABLED -> on.onCraft(null)
                    CommandState.SHORT -> on.onNeedMore()
                    CommandState.BUSY -> Unit
                    else -> on.onExplain(ui.reason ?: "Crafting is not open on this server yet")
                }
            }, Modifier.fillMaxWidth(), sub = "choose a vehicle and parts", state = state, reason = ui.reason,
                price = ui.price, onPrice = if (short) on.onNeedMore else null)
        })) {
        ParchLine("Craft vehicles here any time. Your Lodge sends them on expeditions.")
        if (ui.noLodge) {
            EmptyState(EmptyStateUi("ui:lodge-menu", "Build a Lodge to send vehicles", "Vehicles crafted here sail from your Lodge.",
                "GO TO LODGE", FeatureId("island.archipelago.lodge")), onGo = { on.onGoLodge() })
        } else {
            if (ui.families.isNotEmpty()) {
                MapSectionHeader("YOU CAN CRAFT")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ui.families.take(3).forEach { f -> FamilyCard(f, { on.onCraft(f.family) }, Modifier.weight(1f)) }
                }
            }
            MapRow {
                PkwIcon("ui:queue-status", 32.dp)
                RowText(ui.queueLine.ifBlank { UNKNOWN }, null)
            }
        }
    }
}

/** A CreamCard 84 with the family's idle vehicle at 56 and its VT 18 name; a door into crafting that family. */
@Composable private fun FamilyCard(f: CraftFamilyUi, onClick: () -> Unit, modifier: Modifier) {
    Plate(PlateKind.CREAM, modifier.heightIn(min = 84.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = "Craft a ${f.name}"; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)) {
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
            VoyageIcon(vehicleIdleArt(f.family, f.tier), 56.dp)
            PkwText(f.name, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
        }
    }
}

// ---- Previews ----

private val previewFamilies = listOf(CraftFamilyUi(VehicleFamily.SURVEY_BALLOON, "Survey Balloon"),
    CraftFamilyUi(VehicleFamily.CARGO_CUTTER, "Cargo Cutter"), CraftFamilyUi(VehicleFamily.COURIER_AIRSHIP, "Courier Airship"))

@Composable private fun Host(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Open, priced (solana-island sheet)", widthDp = 412, heightDp = 915)
@Composable private fun PublicOpenPreview() {
    Host {
        PublicWorkshopSheet(PublicWorkshopUi(previewFamilies, "Public queue: 3 ahead / about 20m · licence draw opens later",
            PriceUi(Currency.SOL, "0.05 / try", PriceStatus.OK)), PublicWorkshopActions())
    }
}

@Preview(name = "Price checking; SOL short; server off", widthDp = 412, heightDp = 1500)
@Composable private fun PublicStatesPreview() {
    Host {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PublicWorkshopSheet(PublicWorkshopUi(previewFamilies, UNKNOWN, PriceUi(Currency.SOL, null, PriceStatus.CHECKING)), PublicWorkshopActions())
            PublicWorkshopSheet(PublicWorkshopUi(previewFamilies.take(1), "Public queue: 0 ahead",
                PriceUi(Currency.SOL, "0.05 / try", PriceStatus.SHORT)), PublicWorkshopActions())
            PublicWorkshopSheet(PublicWorkshopUi(previewFamilies, UNKNOWN, PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE),
                state = CommandState.LOCKED, reason = "Crafting is not open on this server yet"), PublicWorkshopActions())
        }
    }
}

@Preview(name = "No Lodge yet", widthDp = 412, heightDp = 700)
@Composable private fun PublicNoLodgePreview() {
    Host { PublicWorkshopSheet(PublicWorkshopUi(emptyList(), UNKNOWN, PriceUi(Currency.SOL, null, PriceStatus.CHECKING), noLodge = true), PublicWorkshopActions()) }
}
