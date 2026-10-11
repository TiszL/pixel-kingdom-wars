package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait

/**
 * Design component: Profile › KINGDOMS (design/final/account/profile-kingdoms.png, SPEC §4.1): your bases with the
 * playing one gold-rimmed (PLAYING + DEED), the others with a blue SWITCH (green "!" when that kingdom needs you, with the
 * reason line under the card), ADD A KINGDOM, "<NAME> ON THE MAP" (TILE, SHIELD, blue SEE), "A DEED FROM A FRIEND?"
 * and the note that nothing moves between kingdoms. Landless: the land teaser + gold CLAIM YOUR LAND.
 */

/** Where one kingdom stands for this player. */
enum class KingdomStatus {
    /** The base being played (gold rim, PLAYING). */
    PLAYING,
    /** Another base of this account (SWITCH). */
    AVAILABLE,
    /** The deed / base authority is in another wallet (red rim + RECOVER). */
    DEED_ELSEWHERE,
}

/** One KingdomCard (84 tall). */
@Immutable data class KingdomCardUi(
    val id: String,
    /** PS 12 ("IRONHOLD"). */
    val name: String,
    /** "Crownlands". */
    val realmName: String,
    /** The realm crest / thumb (24 dp); null draws the stone stand-in. */
    val realmThumb: ImageBitmap?,
    /** "12" or "…". */
    val keepLevel: String,
    /** Keep tier 1..4 for the portrait. */
    val keepTier: Int,
    val status: KingdomStatus,
    /** Draws the stone DEED tag (the deed is in this wallet). */
    val hasDeed: Boolean,
    /** "Workshop batch ready": the green "!" on SWITCH and a VT line under the card; null = nothing waiting. */
    val needsYou: String? = null,
    /** SWITCH pressed and the other base is loading: busy dots, no second tap. */
    val switching: Boolean = false,
)

/** Everything the KINGDOMS tab draws (SPEC §4.1 `KingdomsUiState`). */
@Immutable data class KingdomsUi(
    val kingdoms: List<KingdomCardUi>,
    /** No land yet (`entryPaidAt == null`): the whole tab is the land teaser. */
    val landless: Boolean,
    /** The ADD A KINGDOM card's price (a server zero says "free"); null hides the card (feature off). */
    val addPrice: PriceUi?,
    /** The playing kingdom's name for "IRONHOLD ON THE MAP"; null hides that section. */
    val activeName: String?,
    /** Its tile ("4,812" or "…"). */
    val tile: String?,
    val tileThumb: ImageBitmap?,
    /** Its shield ("4h", "none", "…"). */
    val shield: String?,
    /** The landless teaser's land price (SOL 0.2 or "…"). */
    val landPrice: PriceUi? = null,
)

/** KINGDOMS callbacks. */
@Immutable data class KingdomsActions(
    /** SWITCH: cross-fade the camera to that base in 220 ms (both scenes live; never a blank page). */
    val onSwitch: (String) -> Unit = {},
    /** ADD A KINGDOM GO: realm picker (first land → land gate). */
    val onAddKingdom: () -> Unit = {},
    /** SEE: the realm map centred on the playing kingdom. */
    val onSeeOnMap: () -> Unit = {},
    /** CLAIM a deed sent by a friend (`BaseClaimRoute`). */
    val onClaimDeed: () -> Unit = {},
    /** RECOVER a kingdom whose deed is in another wallet. */
    val onRecover: (String) -> Unit = {},
    /** Landless: CLAIM YOUR LAND (land gate). */
    val onClaimLand: () -> Unit = {},
)

/**
 * The KINGDOMS body inside the Profile card's parchment (bounded height; it scrolls itself).
 *
 * Pointer rule: rows are paint; only SWITCH, GO, SEE, CLAIM, RECOVER and the landless primary take touches.
 */
@Composable fun ColumnScope.ProfileKingdomsBody(ui: KingdomsUi, on: KingdomsActions) {
    val mode = kingdomsMode(ui.landless, ui.kingdoms.size)
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (mode == KingdomsMode.LANDLESS) {
            LandlessTeaser(ui.landPrice, on.onClaimLand)
        } else {
            SectionHeader("YOUR KINGDOMS", right = "${ui.kingdoms.size}")
            ui.kingdoms.forEach { kingdom ->
                KingdomCard(kingdom, on, showSwitch = mode == KingdomsMode.MANY)
                // The frame's reason line sits under the card's text column (x 82), not centred.
                if (kingdom.status == KingdomStatus.AVAILABLE) kingdom.needsYou?.let {
                    PkwText("${kingdom.name.lowercase().replaceFirstChar { c -> c.uppercase() }}: $it", PkwTokens.Type.small,
                        Modifier.fillMaxWidth().padding(start = 82.dp, bottom = 2.dp), color = PkwTokens.Colors.textOnParch2)
                }
            }
            ui.addPrice?.let { price -> AddKingdomCard(price, on.onAddKingdom) }
            ui.activeName?.let { name ->
                SectionHeader("${name.uppercase()} ON THE MAP")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    FactCard("TILE", Modifier.weight(1f), description = "Tile ${ui.tile ?: UNKNOWN}") {
                        RealmThumb(ui.tileThumb, "Tile", Modifier.size(24.dp))
                        PkwText(ui.tile ?: UNKNOWN, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    }
                    FactCard("SHIELD", Modifier.weight(1f), description = "Shield ${ui.shield ?: UNKNOWN}") {
                        HubArt("shield", 24.dp)
                        PkwText(ui.shield ?: UNKNOWN, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    }
                    GoButton(on.onSeeOnMap, contentDescription = "See $name on the map", label = "SEE", icon = "map", modifier = Modifier.size(96.dp, 72.dp))
                }
            }
        }
        // A deed sent by a friend is also a way onto the map, so a landless player keeps this row under the teaser.
        SectionHeader("A DEED FROM A FRIEND?")
        CardRow(height = 72.dp) {
            Well("itm_deed_earth", size = 52.dp, light = true, iconSize = 32.dp)
            RowText("A deed sent to you", "Its base joins this list")
            SecondaryButton("CLAIM", on.onClaimDeed, Modifier.width(88.dp), contentDescription = "Claim a deed sent to you")
        }
        if (mode != KingdomsMode.LANDLESS)
            NoteLine("Switching changes which base you see and give orders to. Nothing moves between kingdoms.", Modifier.padding(horizontal = 2.dp))
    }
}

/**
 * The dashed ADD A KINGDOM card (account.css `.kcard.dash`: parchment face, 2 dp `parch-dk` inner rim, 84 tall): light
 * well 64 with the plus at 36, PS 12 title, VT 18 price line 6 dp below, blue GO 72 × 52. The price line is the server's
 * ("…" while CHECKING), never "free" without a server zero ([addKingdomSub]).
 */
@Composable private fun AddKingdomCard(price: PriceUi, onAdd: () -> Unit) {
    val sub = addKingdomSub(price)
    AccountCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.parchmentLo, face = PkwTokens.Colors.parchment, minHeight = 84.dp,
        contentPadding = 0.dp) {
        Row(Modifier.fillMaxWidth().heightIn(min = 84.dp).padding(start = 8.dp, end = 12.dp, top = 6.dp, bottom = 7.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well("plus", size = 64.dp, light = true, iconSize = 36.dp)
            NameRowText("ADD A KINGDOM", sub, gap = 6.dp)
            GoButton(onAdd, contentDescription = "Add a kingdom. $sub", modifier = Modifier.size(72.dp, 52.dp))
        }
    }
}

@Composable private fun KingdomCard(kingdom: KingdomCardUi, on: KingdomsActions, showSwitch: Boolean) {
    val c = PkwTokens.Colors
    val variant = when (kingdom.status) {
        KingdomStatus.PLAYING -> RowVariant.YOU
        KingdomStatus.DEED_ELSEWHERE -> RowVariant.ERROR
        KingdomStatus.AVAILABLE -> RowVariant.PLAIN
    }
    CardRow(variant = variant, height = 84.dp) {
        Well(keepPortrait(kingdom.keepTier), size = 64.dp, iconSize = 56.dp)
        Column(Modifier.weight(1f).clearAndSetSemantics {
            contentDescription = listOfNotNull(kingdom.name, kingdom.realmName, "Keep ${kingdom.keepLevel}",
                when (kingdom.status) { KingdomStatus.PLAYING -> "playing"; KingdomStatus.DEED_ELSEWHERE -> "deed is in another wallet"; else -> null },
                if (kingdom.hasDeed) "deed in your wallet" else null, kingdom.needsYou).joinToString(", ")
        }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PkwText(kingdom.name.uppercase(), PkwTokens.Type.label, color = c.textOnParch)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RealmThumb(kingdom.realmThumb, kingdom.realmName, Modifier.size(24.dp))
                PkwText("${kingdom.realmName} · Keep ${kingdom.keepLevel}", PkwTokens.Type.small, color = c.textOnParch2)
            }
            if (kingdom.status == KingdomStatus.DEED_ELSEWHERE)
                PkwText("Deed is in another wallet", PkwTokens.Type.small, color = c.shortText)
        }
        when (kingdom.status) {
            KingdomStatus.PLAYING -> Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                StatusTag("PLAYING", Verb.GOLD)
                if (kingdom.hasDeed) StatusTag("DEED", Verb.STONE)
            }
            KingdomStatus.DEED_ELSEWHERE -> SecondaryButton("RECOVER", { on.onRecover(kingdom.id) }, Modifier.width(104.dp),
                contentDescription = "Recover ${kingdom.name}")
            KingdomStatus.AVAILABLE -> if (showSwitch) Box {
                if (kingdom.switching) StoneBusyButton("SWITCH", true, {}, Modifier.size(88.dp, 52.dp))
                else SecondaryButton("SWITCH", { on.onSwitch(kingdom.id) }, Modifier.width(88.dp), verb = Verb.BLUE,
                    contentDescription = listOfNotNull("Switch to ${kingdom.name}", kingdom.needsYou).joinToString(". "))
                if (kingdom.needsYou != null && !kingdom.switching)
                    Badge(BadgeUi("!", BadgeTone.READY, "${kingdom.name} needs you"), Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-8).dp))
            }
        }
    }
}

/** A small CreamCard fact (TILE 4,812 / SHIELD 4h): PS 11 label over an icon + value row. Paint only. */
@Composable internal fun FactCard(label: String, modifier: Modifier = Modifier, description: String,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    AccountCard(modifier.heightIn(min = 72.dp).clearAndSetSemantics { contentDescription = description }) {
        PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

/** Landless: "whole tab = land gate teaser + gold CLAIM YOUR LAND" (SPEC §4.1). */
@Composable private fun LandlessTeaser(price: PriceUi?, onClaimLand: () -> Unit) {
    AccountCard(Modifier.fillMaxWidth().padding(top = 6.dp), rim = PkwTokens.Colors.gold.face, face = PkwTokens.Colors.selectedTint,
        horizontalAlignment = Alignment.CenterHorizontally, contentPadding = 12.dp) {
        GoldWell(size = 84.dp, light = true) { HubArt("itm_deed_earth", 64.dp) }
        PkwText("CLAIM YOUR LAND", PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch)
        PkwText("Your base gets a place on the world map, a Kingdom Deed in your wallet, leagues and the Gold Forge.",
            PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
        PrimaryButton("CLAIM YOUR LAND", onClaimLand, Modifier.fillMaxWidth().padding(top = 14.dp), price = price, icon = "itm_deed_earth")
    }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        PkwIcon("shield", 24.dp)
        PkwText(" Free camps only fight free camps.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

// ---- Previews ----

@Preview(name = "KINGDOMS: one kingdom (no SWITCH)", widthDp = 412, heightDp = 915)
@Composable private fun KingdomsOnePreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(kingdoms = sampleKingdoms.copy(kingdoms = sampleKingdoms.kingdoms.take(1))), ProfileCardActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "KINGDOMS: landless", widthDp = 412, heightDp = 915)
@Composable private fun KingdomsLandlessPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(kingdoms = KingdomsUi(emptyList(), landless = true, addPrice = null, activeName = null, tile = null,
            tileThumb = null, shield = null, landPrice = sampleLandPrice)), ProfileCardActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "KINGDOMS: deed in another wallet, priced second land", widthDp = 412, heightDp = 915)
@Composable private fun KingdomsDeedLostPreview() {
    HubPreviewStage {
        val lost = sampleKingdoms.kingdoms[1].copy(status = KingdomStatus.DEED_ELSEWHERE, needsYou = null)
        ProfileCard(sampleProfileCard.copy(kingdoms = sampleKingdoms.copy(kingdoms = listOf(sampleKingdoms.kingdoms[0], lost), addPrice = sampleLandPrice)),
            ProfileCardActions(), Modifier.fillMaxSize())
    }
}
