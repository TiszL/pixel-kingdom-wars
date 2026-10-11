package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HeaderStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LivingHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

/**
 * Design component: the land gate, "CLAIM YOUR LAND" (design/final/account/land-gate.png, SPEC §2.1), a FULL card: the
 * living header (the player's base, the deed in a gold well), what land gives (four benefit tiles), the free-camp rule,
 * the eight realm crests, PAID ONCE with the SOL cost pill, "Already own land? · Use that wallet" + SWITCH, and the foot
 * LATER + CHOOSE REALM. Destination: `LandGate`. Entries: the land herald on Home, Profile › KINGDOMS (first land), a
 * locked feature that needs land, the faucet's GET LAND, a vacant parcel on the map.
 *
 * Copy to verify with the owner (SPEC §2.1): "Your base stays" — free-tier carry-over beyond the base is an open owner
 * decision, so nothing more is promised.
 */

/** One benefit tile (icon 36 / 32 + two VT lines). */
@Immutable data class LandBenefitUi(val icon: String, val text: String)

/** One realm crest in the "8 REALMS" row. */
@Immutable data class RealmChipUi(val id: String, val name: String, val thumb: ImageBitmap?)

/** Everything the land gate draws (SPEC §2.1 `LandGateUiState`). */
@Immutable data class LandGateUi(
    /** The land price (SOL "0.2"); CHECKING draws "…", SHORT the red pill (tap = Need-more). Never repriced by the server. */
    val price: PriceUi,
    /** This wallet already holds its one land: the primary locks with the one-land rule. */
    val alreadyOwned: Boolean,
    /** No wallet linked: the primary becomes gold CONNECT WALLET ("Land is paid from a wallet"). */
    val walletLinked: Boolean,
    /** The eight realms (crest thumbs from the realm atlas). */
    val realms: List<RealmChipUi>,
    /** Server off: the primary locks with this reason. */
    val serverOffReason: String? = null,
    /** A live crop of the player's base for the header; null draws charcoal. */
    val headerSnapshot: ImageBitmap? = null,
    val benefits: List<LandBenefitUi> = defaultLandBenefits(),
    val title: String = "CLAIM YOUR LAND",
    val subtitle: String = "Your base gets a place on the map",
    val priceLine: String = "One land per wallet. Your base stays.",
)

/** The four benefits of land (SPEC §2.1). */
fun defaultLandBenefits(): List<LandBenefitUi> = listOf(
    LandBenefitUi("map", "Your kingdom on the world map"),
    LandBenefitUi("itm_deed_earth", "A Kingdom Deed in your wallet"),
    LandBenefitUi("trophy", "Leagues and weekly rewards"),
    LandBenefitUi("keep", "KEEP from the Gold Forge"),
)

/** Land gate callbacks (SPEC §2.1). */
@Immutable data class LandGateActions(
    val onChooseRealm: () -> Unit = {},
    /** No wallet linked: start the wallet connect. */
    val onConnectWallet: () -> Unit = {},
    val onLater: () -> Unit = {},
    /** "Already own land? Use that wallet": sign out to the title with the wallet path. */
    val onSwitchWallet: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** The SHORT cost pill: Need-more (Profile › WALLET TEST SOL on devnet). */
    val onNeedMore: () -> Unit = {},
    /** A locked primary was tapped: toast this reason. */
    val onExplain: (String) -> Unit = {},
)

/**
 * The land gate card. [modifier] is the FULL-card area (x 8..404, y 14 to bottom − 14); the frame starts at y 60.
 *
 * Pointer rule: the root is the hub's plain `HubCard` Column; only the wood frame, the cost pill and the buttons take
 * touches. The 60 % scrim under it is the SheetHost's, composed only while the card is shown.
 */
@Composable fun LandGateCard(ui: LandGateUi, on: LandGateActions, modifier: Modifier = Modifier,
    beforeBenefits: @Composable ColumnScope.() -> Unit = {}, afterBenefits: @Composable ColumnScope.() -> Unit = {}) {
    val look = landGatePrimary(ui.walletLinked, ui.alreadyOwned, ui.serverOffReason)
    HubCard(modifier,
        footer = {
            SecondaryButton("LATER", on.onLater, Modifier.width(104.dp).heightIn(min = 60.dp), contentDescription = "Later")
            PrimaryButton(look.label, {
                when (primaryTap(look)) {
                    PrimaryTap.ACT -> if (ui.walletLinked) on.onChooseRealm() else on.onConnectWallet()
                    PrimaryTap.NEED_MORE -> on.onNeedMore()
                    PrimaryTap.EXPLAIN -> look.reason?.let(on.onExplain)
                    PrimaryTap.IGNORE -> Unit
                }
            }, Modifier.weight(1f), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason, reasonOnDark = true)
        },
        header = { LandHeader(ui.headerSnapshot, on.onClose, ui.title, ui.subtitle) }) {
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            beforeBenefits()
            SectionHeader("LAND GIVES YOU")
            ui.benefits.chunked(2).forEach { pair ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    pair.forEach { benefit ->
                        AccountCard(Modifier.weight(1f).heightIn(min = 112.dp).clearAndSetSemantics { contentDescription = benefit.text },
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            HubArt(benefit.icon, if (benefit.icon.startsWith("itm_") || benefit.icon.startsWith("ui:")) 32.dp else 36.dp,
                                Modifier.padding(top = 6.dp))
                            PkwText(benefit.text, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                        }
                    }
                    if (pair.size == 1) Box(Modifier.weight(1f))
                }
            }
            CardRow(height = 70.dp) {
                Well("shield", size = 56.dp, light = true, iconSize = 36.dp)
                RowText("Free camps only fight free camps.", "Landed kingdoms can raid and be raided.")
            }
            SectionHeader(if (ui.realms.isEmpty()) "REALMS" else "${ui.realms.size} REALMS", note = "you pick one next")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                ui.realms.forEach { RealmThumb(it.thumb, it.name, Modifier.weight(1f).height(40.dp)) }
            }
            AccountCard(Modifier.fillMaxWidth().padding(top = 4.dp), rim = PkwTokens.Colors.gold.face, face = PkwTokens.Colors.selectedTint) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Well("sol", size = 56.dp, light = true, iconSize = 48.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PkwText("PAID ONCE", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                            PriceChip(ui.price, onClick = if (ui.price.status == PriceStatus.SHORT) on.onNeedMore else null)
                        }
                        PkwText(ui.priceLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
                    }
                }
            }
            if (!ui.alreadyOwned) CardRow(height = 72.dp) {
                Well("ui_portrait_keep_t1", size = 56.dp, iconSize = 48.dp)
                RowText("Already own land?", "Use that wallet")
                SecondaryButton("SWITCH", on.onSwitchWallet, Modifier.width(104.dp), contentDescription = "Already own land? Switch to that wallet")
            }
            afterBenefits()
        }
    }
}

/** The 138 dp living header: base crop, 70 dp ink fade, the deed in a gold well 84, title and sub, red close. */
@Composable private fun LandHeader(snapshot: ImageBitmap?, onClose: () -> Unit, title: String, subtitle: String) {
    LivingHeader(onClose, stage = HeaderStage.NONE, height = PROFILE_HEADER_H) {
        if (snapshot != null) CoverImage(snapshot, Modifier.fillMaxSize()) else RealmHeaderArt(Modifier.fillMaxSize())
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(70.dp).background(PkwTokens.Colors.ink.copy(alpha = 0.55f)))
        Row(Modifier.align(Alignment.BottomStart).padding(start = 14.dp, bottom = 12.dp, end = 64.dp), verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            GoldWell(size = 84.dp, light = true) { HubArt("itm_deed_earth", 64.dp) }
            Column(Modifier.padding(bottom = 4.dp).semantics(mergeDescendants = true) { heading() }) {
                PkwText(title, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp, maxLines = 2)
                PkwText(subtitle, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp, maxLines = 2)
            }
        }
    }
}

// ---- Previews (land-gate.png and the SPEC's states) ----

@Preview(name = "Land gate (land-gate.png)", widthDp = 412, heightDp = 915)
@Composable private fun LandGatePreview() { HubPreviewStage { LandGateCard(sampleLandGate, LandGateActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Land gate: no wallet (CONNECT WALLET)", widthDp = 412, heightDp = 915)
@Composable private fun LandGateNoWalletPreview() {
    HubPreviewStage { LandGateCard(sampleLandGate.copy(walletLinked = false), LandGateActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Land gate: funds short, price unknown realms", widthDp = 412, heightDp = 915)
@Composable private fun LandGateShortPreview() {
    HubPreviewStage { LandGateCard(sampleLandGate.copy(price = PriceUi(Currency.SOL, "0.2", PriceStatus.SHORT)), LandGateActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Land gate: price checking (…)", widthDp = 412, heightDp = 915)
@Composable private fun LandGateCheckingPreview() {
    HubPreviewStage { LandGateCard(sampleLandGate.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING)), LandGateActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Land gate: server off (LOCKED)", widthDp = 412, heightDp = 915)
@Composable private fun LandGateOffPreview() {
    HubPreviewStage { LandGateCard(sampleLandGate.copy(serverOffReason = "Land sales are paused right now"), LandGateActions(), Modifier.fillMaxSize()) }
}
