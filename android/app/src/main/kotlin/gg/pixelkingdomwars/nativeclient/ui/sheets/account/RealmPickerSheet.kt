package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Seal
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CompactHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonBlock
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton

/**
 * Design component: choose your realm (design/final/account/land-realm.png, SPEC §2.2): the tall sheet over the real
 * globe (compact header with the map icon, the one-line lead, a 2-column RealmCard grid with Solana Reach as the locked
 * SKR variant, and the gold SETTLE IN <REALM> with "0.2 SOL · one land per wallet"), plus the two globe pieces the world
 * layer anchors: the selected realm's [RealmMarkerPlate] and the [GlobeSlowPlate] (never a black hole). After the BUY LAND
 * Seal ([landSealUi]) the footer runs the money sequence and, for a lost answer, says the payment is being checked and
 * keeps CHECK AGAIN (design correction 7).
 */

/** One RealmCard (66 tall). */
@Immutable data class RealmCardUi(
    val id: String,
    /** "Crownlands" (drawn upper-case). */
    val name: String,
    /** "3,112 kingdoms" or "…". */
    val kingdoms: String,
    /** The realm thumb (48 × 52) from the realm atlas; null draws the stone stand-in. */
    val thumb: ImageBitmap?,
    val lock: RealmLock = RealmLock.NONE,
    /** Live owner can distinguish a reserved allocation from an available SKR unlock. */
    val lockReason: String? = null,
)

/** The land payment after the Seal. */
@Immutable data class LandPaymentUi(
    /** The money sequence stage (Check wallet → Sending → SENT / FAILED). */
    val stage: MoneyStage,
    val outcome: PaymentOutcome = PaymentOutcome.IN_FLIGHT,
    /** An authoritative refusal's own reason. */
    val serverReason: String? = null,
    /** CHECK AGAIN is reading. */
    val rechecking: Boolean = false,
)

/** Everything the realm picker draws (SPEC §2.2 `RealmPickerUiState`). */
@Immutable data class RealmPickerUi(
    val realms: List<RealmCardUi>,
    val selectedId: String?,
    /** The land price for the sub-line and the Seal. */
    val price: PriceUi,
    /** Realm counts are loading: skeleton cards. */
    val loading: Boolean = false,
    /** Set after BUY LAND was confirmed; null before. */
    val payment: LandPaymentUi? = null,
    /** The live owner may require an inspected exact tile before reserving its quote. */
    val primaryOverride: PrimaryLook? = null,
)

/** Realm picker callbacks (SPEC §2.2). */
@Immutable data class RealmPickerActions(
    /** A realm card: the globe spins to it (400 ms `Out`). */
    val onSelectRealm: (String) -> Unit = {},
    /** SETTLE: raise the BUY LAND Seal ([landSealUi]). */
    val onSettle: (String) -> Unit = {},
    /** A locked card (Solana Reach): explain the SKR unlock and offer its map. */
    val onLockedRealm: (String) -> Unit = {},
    /** A SHORT price on SETTLE: Need-more. */
    val onNeedMore: () -> Unit = {},
    /** A disabled / locked SETTLE: toast this reason. */
    val onExplain: (String) -> Unit = {},
    /** FAILED / refused: send again (a new idempotency key only after an authoritative refusal). */
    val onRetryPayment: () -> Unit = {},
    /** CHECK AGAIN: re-read a payment whose answer was lost (same idempotency key). */
    val onRecheckPayment: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** A reviewed map draft can return without a selected list realm. */
    val onPrimary: (() -> Unit)? = null,
)

/**
 * The realm picker sheet. The host places it at y 338 dp to the bottom over the globe (220 ms up, 160 ms out) and gives
 * it a bounded height.
 *
 * Pointer rule: one painted wood panel; only its cards, close and footer buttons take touches. No scrim: the globe
 * above stays live (it spins to the selection).
 */
@Composable fun RealmPickerSheet(ui: RealmPickerUi, on: RealmPickerActions, modifier: Modifier = Modifier,
    beforeRealms: @Composable ColumnScope.() -> Unit = {}, afterRealms: @Composable ColumnScope.() -> Unit = {}) {
    val c = PkwTokens.Colors
    val selected = ui.realms.firstOrNull { it.id == ui.selectedId }
    Plate(PlateKind.WOOD, modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxSize()) {
            CompactHeader("CHOOSE YOUR REALM", "map", on.onClose)
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    // The frame's lead line comes first; the host's notices sit between it and the grid.
                    PkwText("Each realm has its own look and its own ore. You can visit all of them.", PkwTokens.Type.small,
                        color = c.textOnParch2, maxLines = 2)
                    beforeRealms()
                    if (ui.loading && ui.realms.isEmpty()) repeat(4) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            repeat(2) { SkeletonRealmCard(Modifier.weight(1f)) }
                        }
                    }
                    ui.realms.chunked(2).forEach { pair ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            pair.forEach { realm ->
                                RealmCard(realm, realm.id == ui.selectedId, Modifier.weight(1f)) {
                                    if (realm.lock == RealmLock.NONE) on.onSelectRealm(realm.id) else on.onLockedRealm(realm.id)
                                }
                            }
                            if (pair.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                    afterRealms()
                }
            }
            Spacer(Modifier.height(10.dp))
            SettleFooter(ui, selected, on)
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable private fun SettleFooter(ui: RealmPickerUi, selected: RealmCardUi?, on: RealmPickerActions) {
    val look = ui.primaryOverride ?: settleLook(selected?.name, selected?.lock, ui.price)
    val payment = ui.payment
    if (payment == null) {
        PrimaryButton(look.label, {
            when (primaryTap(look)) {
                PrimaryTap.ACT -> on.onPrimary?.invoke() ?: selected?.let { on.onSettle(it.id) }
                PrimaryTap.NEED_MORE -> on.onNeedMore()
                PrimaryTap.EXPLAIN -> look.reason?.let(on.onExplain)
                PrimaryTap.IGNORE -> Unit
            }
        }, Modifier.fillMaxWidth(), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason, reasonOnDark = true)
        return
    }
    val line = landPaymentLine(payment.outcome, payment.serverReason)
    Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when (payment.outcome) {
            PaymentOutcome.CHECKING -> StoneBusyButton("CHECK AGAIN", payment.rechecking, on.onRecheckPayment, Modifier.fillMaxWidth().heightIn(min = 60.dp))
            PaymentOutcome.REFUSED -> MoneyButton(MoneyStage.FAILED, look.label, on.onRetryPayment, retryLabel = "TRY AGAIN")
            PaymentOutcome.IN_FLIGHT -> MoneyButton(payment.stage, look.label, on.onRetryPayment)
        }
        // On the dark wood: a refusal in `danger` (the dark-plate reason colour), a check in plain text (it is not an error).
        line?.let {
            PkwText(it, PkwTokens.Type.small, color = if (payment.outcome == PaymentOutcome.REFUSED) PkwTokens.Colors.danger else PkwTokens.Colors.text,
                textAlign = TextAlign.Center, maxLines = 2)
        }
    }
}

/** A RealmCard (66 tall): thumb 48 × 52, PS 11 name, VT 18 count; selected = gold 3 dp rim + `#FFF3C8`; locked variants. */
@Composable private fun RealmCard(realm: RealmCardUi, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = PkwTokens.Colors
    val face = when {
        selected -> c.selectedTint
        realm.lock != RealmLock.NONE -> HubColors.rowDim
        else -> c.cream
    }
    val spoken = listOfNotNull(realm.name, realm.kingdoms.takeIf { realm.lock == RealmLock.NONE }, realm.lockReason ?: when (realm.lock) {
        RealmLock.FULL -> "full right now"; RealmLock.SKR_UNLOCK -> "opens with SKR"; RealmLock.NONE -> null
    }, if (selected) "selected" else null).joinToString(", ")
    AccountCard(modifier, rim = if (selected) c.gold.face else null, face = face, minHeight = 66.dp, onClick = onClick, description = spoken,
        contentPadding = 6.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RealmThumb(realm.thumb, realm.name, Modifier.size(48.dp, 52.dp))
            Column(Modifier.weight(1f)) {
                PkwText(realm.name.uppercase(), PkwTokens.Type.caption, color = c.textOnParch, maxLines = 2)
                when (realm.lock) {
                    RealmLock.NONE -> PkwText(realm.kingdoms, PkwTokens.Type.small, color = c.textOnParch2)
                    RealmLock.FULL -> PkwText(realm.lockReason ?: "Full right now", PkwTokens.Type.small, color = c.textOnParch2)
                    RealmLock.SKR_UNLOCK -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        PkwIcon("skr", 24.dp)
                        PkwText(realm.lockReason ?: "SKR unlock", PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
                    }
                }
            }
        }
    }
}

@Composable private fun SkeletonRealmCard(modifier: Modifier) {
    AccountCard(modifier, minHeight = 66.dp, contentPadding = 6.dp) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            SkeletonBlock(Modifier.size(48.dp, 52.dp), dark = true)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SkeletonBlock(Modifier.fillMaxWidth(0.8f).height(14.dp))
                SkeletonBlock(Modifier.fillMaxWidth(0.6f).height(12.dp))
            }
        }
    }
}

/**
 * The globe's selected-realm marker (land-realm.png): a charcoal plate with the realm thumb and its PS name in gold, a
 * 6 dp stem and the 3 dp gold-hi `TileSelect` square. World-anchored by the globe layer at the realm's centre (the
 * square's centre is this composable's bottom-centre). Paint only: a pan may start on it.
 */
@Composable fun RealmMarkerPlate(name: String, thumb: ImageBitmap?, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Column(modifier.clearAndSetSemantics { contentDescription = "$name selected" }, horizontalAlignment = Alignment.CenterHorizontally) {
        Plate(PlateKind.CHARCOAL, contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 12.dp, bottom = 8.dp), blocksScene = false) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RealmThumb(thumb, name, Modifier.size(36.dp, 30.dp))
                PkwText(name.uppercase(), PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
            }
        }
        Box(Modifier.width(6.dp).height(6.dp).background(c.ink))
        Box(Modifier.size(44.dp).drawBehind {
            val s = 3.dp.toPx(); val o = 1.dp.toPx()
            drawRect(c.gold.face.copy(alpha = 0.20f))
            // Ink outline, then the gold-hi square inside it.
            drawRect(c.ink, Offset.Zero, Size(size.width, s + o)); drawRect(c.ink, Offset(0f, size.height - s - o), Size(size.width, s + o))
            drawRect(c.ink, Offset.Zero, Size(s + o, size.height)); drawRect(c.ink, Offset(size.width - s - o, 0f), Size(s + o, size.height))
            drawRect(c.gold.hi, Offset(o, o), Size(size.width - 2 * o, s)); drawRect(c.gold.hi, Offset(o, size.height - s - o), Size(size.width - 2 * o, s))
            drawRect(c.gold.hi, Offset(o, o), Size(s, size.height - 2 * o)); drawRect(c.gold.hi, Offset(size.width - s - o, o), Size(s, size.height - 2 * o))
        })
    }
}

/**
 * The globe atlas failed or is slow (SPEC §2.2): a charcoal plate "Globe is loading slowly" + stone RETRY. Never a black
 * hole. Pointer rule: a painted plate (a scene-input region); only RETRY acts.
 */
@Composable fun GlobeSlowPlate(retrying: Boolean, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Plate(PlateKind.CHARCOAL, modifier, contentPadding = PaddingValues(start = 12.dp, top = 8.dp, end = 8.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PkwText("Globe is loading slowly", PkwTokens.Type.body, color = PkwTokens.Colors.text)
            StoneBusyButton("RETRY", retrying, onRetry, Modifier.width(96.dp))
        }
    }
}

// ---- Previews (land-realm.png, land-seal.png and the SPEC's states) ----

@Composable private fun GlobeStage(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF05060C))) {
        Column(Modifier.align(Alignment.TopCenter).padding(top = 140.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            RealmMarkerPlate("Crownlands", null)
        }
        Box(Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = 338.dp)) { content() }
    }
}

@Preview(name = "Realm picker (land-realm.png)", widthDp = 412, heightDp = 915)
@Composable private fun RealmPickerPreview() { GlobeStage { RealmPickerSheet(sampleRealmPicker, RealmPickerActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Realm picker: loading", widthDp = 412, heightDp = 915)
@Composable private fun RealmPickerLoadingPreview() {
    GlobeStage { RealmPickerSheet(RealmPickerUi(emptyList(), null, sampleLandPrice, loading = true), RealmPickerActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Realm picker: realm full", widthDp = 412, heightDp = 915)
@Composable private fun RealmPickerFullPreview() {
    GlobeStage {
        RealmPickerSheet(sampleRealmPicker.copy(realms = sampleRealmPicker.realms.map { if (it.id == "crownlands") it.copy(lock = RealmLock.FULL) else it }),
            RealmPickerActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Realm picker: sending", widthDp = 412, heightDp = 915)
@Composable private fun RealmPickerSendingPreview() {
    GlobeStage { RealmPickerSheet(sampleRealmPicker.copy(payment = LandPaymentUi(MoneyStage.SENDING)), RealmPickerActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Realm picker: checking a lost answer", widthDp = 412, heightDp = 915)
@Composable private fun RealmPickerCheckingPreview() {
    GlobeStage {
        RealmPickerSheet(sampleRealmPicker.copy(payment = LandPaymentUi(MoneyStage.SENDING, PaymentOutcome.CHECKING)), RealmPickerActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Realm picker: refused (authoritative)", widthDp = 412, heightDp = 915)
@Composable private fun RealmPickerRefusedPreview() {
    GlobeStage {
        RealmPickerSheet(sampleRealmPicker.copy(payment = LandPaymentUi(MoneyStage.FAILED, PaymentOutcome.REFUSED, "The wallet declined")),
            RealmPickerActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Globe slow plate", widthDp = 412, heightDp = 120)
@Composable private fun GlobeSlowPreview() { Box(Modifier.fillMaxSize().background(PkwTokens.Colors.ink).padding(8.dp)) { GlobeSlowPlate(false, {}) } }

@Preview(name = "BUY LAND seal (land-seal.png)", widthDp = 412, heightDp = 915)
@Composable private fun LandSealPreview() {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF2F4A2A))) {
        Seal(landSealUi("Crownlands", PriceUi(Currency.SOL, "0.2", PriceStatus.OK), armedAtMs = 0L), onConfirm = {}, onCancel = {})
    }
}
