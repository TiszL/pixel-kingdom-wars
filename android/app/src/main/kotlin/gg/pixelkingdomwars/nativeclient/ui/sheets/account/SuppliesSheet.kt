package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Pips
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.fractionText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.pipFills
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/**
 * Design component: the shop, BUILD › SUPPLIES (design/final/account/shop.png, SPEC §3), a TALL sheet: the BUILD title
 * plate, the builders VeilChip and close; the scrolling `Tabs.Stacked` strip (SPEC §0.3: the active tab always in view,
 * the next one peeking); SHIELDS (three ItemCards, Gems pills, the selected one gold-rimmed), BUILDERS (3RD BUILDER, SOL
 * pill → SOL Seal), RAID ENERGY (REFILL TO 5 with pips), BOOSTS (the server catalogue decides; empty says so, nothing is
 * invented); foot stone INFO + gold BUY <offer> with its VT sub-line. Replaces `ShopRoute` / `BasePurchaseRoute`.
 * The HUD's resource stack above a tall sheet shows only GEMS (what this tab spends); SOL appears only on its pill.
 * Live prices are what the server prices them in (base supplies in SOL, catalogue items in KEEP); the frame's Gems are
 * placeholders (SPEC §9.2). INFO and refusal reasons show in a card inside the sheet, never a system dialog.
 */

/** One supply offer (SPEC §3 `SupplyOffer`). Every price comes from the server catalogue. */
@Immutable data class SupplyOfferUi(
    val id: String,
    val kind: SupplyKind,
    /** "2 DAYS", "3RD BUILDER", "REFILL TO 5". */
    val title: String,
    /** "adds 48h", "Paid once", "once a week". */
    val effect: String,
    /** "itm_shield", "builder", "energy". */
    val icon: String,
    val price: PriceUi,
    /** The footer primary when selected ("BUY 2-DAY SHIELD"). */
    val buyLabel: String,
    /** Its VT sub-line ("150 Gems · shield becomes 52h"); null draws none. */
    val buySub: String?,
    /** Cooldown / not buyable ("Next one in 2d"); the card shows it instead of its pill. */
    val lockedReason: String? = null,
    /** A stone tag ("MAX"). */
    val tag: String? = null,
)

/** Everything the SUPPLIES tab draws (SPEC §3 `SuppliesUiState`). */
@Immutable data class SuppliesUi(
    /** The BUILD tray's tabs (BUILDINGS · DEFENCE · TRAPS · HEROES · SUPPLIES · LAYOUTS). */
    val tabs: List<TabUi>,
    /** The builders chip ("1/2"). */
    val builders: String,
    /** True draws "free" beside the builders count. */
    val buildersFree: Boolean,
    /** "yours: 4h left"; null draws none. */
    val shieldLeft: String?,
    /** "2 hired"; null draws none. */
    val buildersHired: String?,
    /** Raid energy now / max (pips); null = unknown ("…"). */
    val energyNow: Int?,
    val energyMax: Int?,
    val offers: List<SupplyOfferUi>,
    val selectedId: String?,
    val selectedTab: String = SUPPLIES_TAB,
    /** False while any source is unknown/failed: never present a failed read as an empty sale. */
    val catalogueReady: Boolean = true,
    /** Live inventory includes gear and contracts as well as consumables. */
    val inventorySectionLabel: String = "BOOSTS",
    /** The INFO / refusal answer, drawn inside the sheet above the foot with a stone CLOSE; null draws none. */
    val info: String? = null,
)

const val SUPPLIES_TAB = "SUPPLIES"

/** SUPPLIES callbacks (SPEC §3). */
@Immutable data class SuppliesActions(
    /** Another BUILD tab: the tray takes over. */
    val onTab: (String) -> Unit = {},
    val onBuilders: () -> Unit = {},
    val onClose: () -> Unit = {},
    val onSelectOffer: (String) -> Unit = {},
    /** BUY (footer, or a row's pill): raise the KEEP Seal / open the SOL owner. */
    val onBuy: (String) -> Unit = {},
    val onInfo: (String?) -> Unit = {},
    /** A SHORT pill / primary: Need-more (the KEEP top-up owner for a KEEP price). */
    val onNeedMore: (String) -> Unit = {},
    /** A locked / disabled tap: show this reason. */
    val onExplain: (String) -> Unit = {},
    /** The info card's CLOSE. */
    val onCloseInfo: () -> Unit = {},
)

/**
 * The SUPPLIES sheet. The SheetHost places it as a TALL sheet (y 104 to the bottom, left / right 4) over its 40 % scrim
 * and gives it a bounded height.
 *
 * Pointer rule: one painted wood panel (a scene-input region); only its tabs, chip, close, cards, pills and footer take
 * touches. The TALL scrim is the SheetHost's, composed only while the sheet is shown.
 */
@Composable fun SuppliesSheet(ui: SuppliesUi, on: SuppliesActions, modifier: Modifier = Modifier,
    statusContent: @Composable () -> Unit = {}) {
    val c = PkwTokens.Colors
    val selected = ui.offers.firstOrNull { it.id == ui.selectedId }
    val look = supplyBuyLook(selected?.buyLabel, selected?.buySub, selected?.price, selected?.lockedReason)
    Plate(PlateKind.WOOD, modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 9.dp, top = 9.dp, end = 9.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxSize()) {
            ShopHeader(ui, on)
            Spacer(Modifier.height(6.dp))
            ScrollingStackedTabs(ui.tabs, ui.selectedTab, on.onTab)
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        statusContent()
                        if (ui.offers.isEmpty()) {
                            if (ui.catalogueReady) EmptyBoosts("Nothing on sale today", "New supplies show up here")
                        }
                        else ShopSections(ui, on)
                    }
                    ui.info?.let { SuppliesInfoCard(it, on.onCloseInfo) }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                ChunkyBox(c.stone, { on.onInfo(selected?.id) }, "Info", Modifier.size(68.dp, 60.dp)) { PkwIcon("info", 24.dp) }
                PrimaryButton(look.label, {
                    when (primaryTap(look)) {
                        PrimaryTap.ACT -> selected?.let { on.onBuy(it.id) }
                        PrimaryTap.NEED_MORE -> selected?.let { on.onNeedMore(it.id) }
                        PrimaryTap.EXPLAIN -> look.reason?.let(on.onExplain)
                        PrimaryTap.IGNORE -> Unit
                    }
                }, Modifier.weight(1f), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason, reasonOnDark = true)
            }
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable private fun ShopSections(ui: SuppliesUi, on: SuppliesActions) {
    val byKind = ui.offers.groupBy { it.kind }
    byKind[SupplyKind.SHIELD]?.let { shields ->
        SectionHeader("SHIELDS", note = "stops raids", right = ui.shieldLeft?.let { "yours: $it" })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            shields.take(3).forEach { ShieldCard(it, it.id == ui.selectedId, on, Modifier.weight(1f)) }
        }
    }
    byKind[SupplyKind.BUILDER]?.let { builders ->
        SectionHeader("BUILDERS", note = "one job each", right = ui.buildersHired)
        builders.forEach { OfferRow(it, it.id == ui.selectedId, on) {} }
    }
    byKind[SupplyKind.ENERGY]?.let { energy ->
        val right = if (ui.energyNow != null || ui.energyMax != null) fractionText(ui.energyNow, ui.energyMax) else null
        SectionHeader("RAID ENERGY", note = "one per attack", right = right)
        energy.forEach { offer ->
            OfferRow(offer, offer.id == ui.selectedId, on) {
                pipFills(ui.energyNow, ui.energyMax)?.let { Pips(it, "Raid energy ${fractionText(ui.energyNow, ui.energyMax)}", Modifier.width(120.dp)) }
            }
        }
    }
    SectionHeader(ui.inventorySectionLabel)
    val boosts = byKind[SupplyKind.BOOST].orEmpty()
    if (boosts.isEmpty()) {
        if (ui.catalogueReady) EmptyBoosts("None on sale today", "New ${ui.inventorySectionLabel.lowercase()} show up here")
    }
    else boosts.forEach { OfferRow(it, it.id == ui.selectedId, on) {} }
}

/** A shield ItemCard (150 tall): the shield in a 68 × 60 well, PS 11 title, VT 18 effect, the Gems pill; selected = gold rim. */
@Composable private fun ShieldCard(offer: SupplyOfferUi, selected: Boolean, on: SuppliesActions, modifier: Modifier) {
    val c = PkwTokens.Colors
    val spoken = listOfNotNull(offer.title, offer.effect, offer.lockedReason ?: priceDescription(offer.price), if (selected) "selected" else null).joinToString(", ")
    AccountCard(modifier, rim = if (selected) c.gold.face else null, face = if (selected) c.selectedTint else c.cream, minHeight = 150.dp,
        onClick = { if (offer.lockedReason != null) on.onExplain(offer.lockedReason) else on.onSelectOffer(offer.id) }, description = spoken,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(68.dp, 60.dp).background(HubColors.wellLightBorder).padding(2.dp).background(HubColors.wellLight), contentAlignment = Alignment.Center) {
            HubArt(offer.icon, 32.dp, alpha = if (offer.lockedReason != null) 0.45f else 1f)
            if (offer.lockedReason != null) PkwIcon("shape:lock", 24.dp, Modifier.align(Alignment.BottomEnd), tint = c.gold.face)
        }
        PkwText(offer.title, PkwTokens.Type.caption, color = c.textOnParch)
        PkwText(offer.effect, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center)
        if (offer.lockedReason != null) PkwText(offer.lockedReason, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
        else PriceChip(offer.price)
    }
}

/**
 * A supply row (78 tall): art in a 60 light well, PS title (+ tag), VT effect or [extra] (120-wide energy pips), and the
 * price pill as its own door (OK → the Seal, SHORT → Need-more). The row itself selects the offer for the footer.
 */
@Composable private fun OfferRow(offer: SupplyOfferUi, selected: Boolean, on: SuppliesActions, extra: @Composable () -> Unit) {
    val c = PkwTokens.Colors
    AccountCard(Modifier.fillMaxWidth(), rim = if (selected) c.gold.face else null, face = if (selected) c.selectedTint else c.cream, minHeight = 78.dp,
        contentPadding = 8.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.weight(1f).heightIn(min = PkwTokens.Dims.minTap)
                .clearAndSetSemantics {
                    contentDescription = listOfNotNull(offer.title, offer.effect, if (selected) "selected" else null).joinToString(", ")
                    role = Role.Button; this.onClick(label = null, action = { on.onSelectOffer(offer.id); true })
                }
                .clickable(role = Role.Button) { on.onSelectOffer(offer.id) },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Well(offer.icon, size = 60.dp, light = true, iconSize = if (offer.icon == "builder") 56.dp else 36.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText(offer.title, PkwTokens.Type.label, color = c.textOnParch)
                        offer.tag?.let { StatusTag(it, Verb.STONE) }
                    }
                    PkwText(offer.effect, PkwTokens.Type.small, color = c.textOnParch2)
                    extra()
                }
            }
            val locked = offer.lockedReason
            when {
                locked != null -> LockNote(locked)
                else -> PriceChip(offer.price, onClick = {
                    when (offer.price.status) {
                        PriceStatus.SHORT -> on.onNeedMore(offer.id)
                        PriceStatus.UNAVAILABLE -> on.onExplain("Price unavailable right now")
                        else -> on.onBuy(offer.id)
                    }
                })
            }
        }
    }
}

/** The dashed-look empty row (SPEC §3 BOOSTS, shop.html `.kcard.dash`: parchment face, parchment-dark inner rim): the swift
 *  boots at 45 % in a 60 light well, "None on sale today / New boosts show up here". */
@Composable private fun EmptyBoosts(title: String, sub: String) {
    AccountCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.parchmentLo, face = PkwTokens.Colors.parchment, minHeight = 78.dp,
        contentPadding = 8.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well("ui_icon_swiftboots", size = 60.dp, light = true, iconSize = 36.dp, alpha = 0.45f)
            Column {
                PkwText(title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                PkwText(sub, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
        }
    }
}

/** The INFO answer inside the sheet (never a system dialog): a cream card with the reason or offer facts and a stone CLOSE. */
@Composable private fun SuppliesInfoCard(text: String, onClose: () -> Unit) {
    AccountCard(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        PkwText(text, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch, maxLines = 8)
        SecondaryButton("CLOSE", onClose, Modifier.align(Alignment.End))
    }
}

/** BUILD title plate, builders VeilChip "1/2 free" (40 tall; tap → Builders), spacer, red close (shop.html `.chead`). */
@Composable private fun ShopHeader(ui: SuppliesUi, on: SuppliesActions) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Plate(PlateKind.CHARCOAL, Modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) { heading() },
            contentPadding = PaddingValues(start = 12.dp, top = 6.dp, end = 12.dp, bottom = 8.dp), blocksScene = false) {
            PkwText("BUILD", PkwTokens.Type.title, Modifier.align(Alignment.CenterStart), color = c.gold.hi, outline = 2.dp)
        }
        val spoken = "Builders ${ui.builders}${if (ui.buildersFree) " free" else ""}. Opens builders"
        Box(Modifier.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.onClick(label = null, action = { on.onBuilders(); true }) }
            .clickable(role = Role.Button, onClick = on.onBuilders), contentAlignment = Alignment.Center) {
            Plate(PlateKind.VEIL, Modifier.heightIn(min = 40.dp), contentPadding = PaddingValues(start = 4.dp, top = 2.dp, end = 10.dp, bottom = 2.dp),
                blocksScene = false) {
                Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    PkwIcon("builder", 30.dp)
                    PkwText(ui.builders, PkwTokens.Type.label, color = c.text, outline = 1.dp)
                    if (ui.buildersFree) PkwText("free", PkwTokens.Type.small, color = c.muted)
                }
            }
        }
        Spacer(Modifier.weight(1f))
        CloseSquare(on.onClose, contentDescription = "Close build")
    }
}

/**
 * The scrolling `Tabs.Stacked` strip (SPEC §0.3): every tab labelled, the strip scrolls sideways, and on a tab change it
 * scrolls the active tab fully into view with the next tab peeking at the right edge (180 ms `out`;
 * [stackedTabScrollTarget]).
 */
@Composable fun ScrollingStackedTabs(tabs: List<TabUi>, selected: String?, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    if (tabs.isEmpty()) return
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val viewport = with(density) { maxWidth.toPx() }
        val widths = tabs.map { with(density) { scrollingTabWidthDp(it.label).dp.toPx() } }
        val gap = with(density) { 4.dp.toPx() }
        val active = tabs.indexOfFirst { it.id == selected }.coerceAtLeast(0)
        var first by remember { mutableStateOf(true) }
        LaunchedEffect(active, viewport) {
            val target = stackedTabScrollTarget(widths, gap, active, viewport, with(density) { 28.dp.toPx() }, scroll.value.toFloat()).roundToInt()
            if (first || reduced || inspection) scroll.scrollTo(target) else scroll.animateScrollTo(target, tween(STRIP_SCROLL_MS, easing = PkwTokens.Motion.Out))
            first = false
        }
        Row(Modifier.horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            tabs.forEach { tab -> StackedTab(tab, tab.id == selected, { onSelect(tab.id) }, Modifier.width(scrollingTabWidthDp(tab.label).dp)) }
        }
    }
}

/** The strip's auto-scroll (SPEC §7: 180 ms `out`). */
private const val STRIP_SCROLL_MS = 180

// ---- Previews (shop.png and the SPEC's states) ----

@Composable private fun TallStage(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF2F4A2A))) {
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.SHEET_TALL)))
        Box(Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = 104.dp)) { content() }
    }
}

@Preview(name = "Shop: SUPPLIES (shop.png)", widthDp = 412, heightDp = 915)
@Composable private fun ShopPreview() { TallStage { SuppliesSheet(sampleSupplies, SuppliesActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Shop: short of Gems (Need-more)", widthDp = 412, heightDp = 915)
@Composable private fun ShopShortPreview() {
    TallStage {
        SuppliesSheet(sampleSupplies.copy(offers = sampleSupplies.offers.map {
            if (it.kind == SupplyKind.SHIELD && it.id != "shield-1d") it.copy(price = it.price.copy(status = PriceStatus.SHORT)) else it
        }), SuppliesActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Shop: shield cooldown, builders at max", widthDp = 412, heightDp = 915)
@Composable private fun ShopLockedPreview() {
    TallStage {
        SuppliesSheet(sampleSupplies.copy(selectedId = "shield-7d", offers = sampleSupplies.offers.map {
            when (it.id) {
                "shield-7d" -> it.copy(lockedReason = "Next one in 2d")
                "builder-3" -> it.copy(tag = "MAX", lockedReason = "All builders hired")
                else -> it
            }
        }), SuppliesActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Shop: INFO card in the sheet", widthDp = 412, heightDp = 915)
@Composable private fun ShopInfoPreview() { TallStage { SuppliesSheet(sampleSupplies.copy(info = "Item limit reached"), SuppliesActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Shop: nothing on sale", widthDp = 412, heightDp = 915)
@Composable private fun ShopEmptyPreview() { TallStage { SuppliesSheet(sampleSupplies.copy(offers = emptyList(), selectedId = null), SuppliesActions(), Modifier.fillMaxSize()) } }
