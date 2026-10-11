package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.kit.profilePx
import gg.pixelkingdomwars.nativeclient.ui.kit.steppedPath
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Alchemy Lab research (design/final/army/SPEC.md §4; research.png, research-busy.png). Lab free: the
 * 4-column ResearchCard grid (a tap selects, never starts), the ResearchDetail card for the selection and the gold
 * RESEARCH primary (Shards, no Seal). Lab busy: the ResearchJobCard on top, the grid dimmed under "NEXT UP" (each card
 * keeping its look), and the green FINISH primary; its price is the server review's ("Price shown in review"), which opens
 * the Gems Seal or the KEEP review. Lab upgrading: the panel at 60 % and RESEARCH in its L state.
 */

/** A research card's state (SPEC §4 `ResearchCard` table). */
enum class ResearchCardState {
    /** Researchable now. */
    DEFAULT,
    /** The current selection: gold rim, selected tint and the gold target badge. */
    SELECTED,
    /** Not affordable: red cost; a tap opens Need-more. */
    SHORT,
    /** Already at the Lab's level: "Lab cap"; a tap offers the Lab upgrade. */
    LAB_CAP,
    /** At the troop's maximum level: "Max level". */
    MAX,
    /** The troop is not unlocked: padlock + "Unlock it first". */
    LOCKED,
    /** The troop the Lab is researching now: "In the Lab". */
    IN_LAB,
    /** Another troop is in the Lab: dimmed; a tap explains one at a time. */
    BUSY,
}

/** One research card (SPEC §4). */
@Immutable data class ResearchCardUi(
    /** Troop id. */
    val troop: String,
    /** Display name. */
    val name: String,
    /** 56 px portrait. */
    val portrait: String,
    /** The current level tag ("L4"). */
    val level: String,
    /** The Shards price of the next level; null when there is none (cap, max, locked). */
    val nextPrice: PriceUi?,
    /** Card state. */
    val state: ResearchCardState,
    /** The target level shown on the gold badge when selected ("L5"). */
    val target: String? = null,
    /** Why a tap does not select it (LAB_CAP "Upgrade the Alchemy Lab to Lv 7", LOCKED / MAX the server's line); read by
     *  screen readers. Null for a card that selects. */
    val reason: String? = null,
    /** While the Lab works ([ResearchCardState.BUSY]) the look the card keeps under the dim (research-busy.png: prices,
     *  "Max level", "Unlock it first"); null draws DEFAULT. A tap still only explains one troop at a time. */
    val busyLook: ResearchCardState? = null,
)

/** The running research (SPEC §4 `ResearchJobCard`). */
@Immutable data class ResearchJobUi(
    val troop: String,
    val name: String,
    val portrait: String,
    /** "L4". */
    val from: String,
    /** "L5". */
    val to: String,
    /** Seconds left; null = "…". */
    val remainingSec: Long?,
    /** 0..1 done; null draws an empty meter. */
    val progress: Float?,
    /** FINISH with its Gems price (opens the Seal). */
    val finish: CommandUi,
)

/** The selection's detail card (SPEC §4 `ResearchDetail`). */
@Immutable data class ResearchDetailUi(
    val troop: String,
    val name: String,
    /** The next tier's portrait. */
    val portrait: String,
    val from: String,
    val to: String,
    /** 2-4 stats the catalogue lists for the troop. */
    val stats: List<StatDeltaUi>,
    /** Research time in seconds; null = "…". */
    val durationSec: Long?,
    /** Its Shards price. */
    val price: PriceUi,
)

/** Everything the Research sheet draws (SPEC §4 `ResearchUi`). */
@Immutable data class ResearchUi(
    /** Lab header; chip "Lab is free", or the timer + "Bowman L5 in 10h 41m". */
    val header: SheetHeaderUi,
    /** The Lab level (troops max out at it). */
    val labLevel: Int,
    /** The running research; null when the Lab is free. */
    val job: ResearchJobUi?,
    /** Cards in catalogue order. */
    val cards: List<ResearchCardUi>,
    /** The selection's detail; null shows none. Default: the first affordable card (`defaultResearchSelection`). */
    val selected: ResearchDetailUi?,
    /** Lab free: price + "takes 17h 50m", gold RESEARCH "Bowman to L5". Busy: "Skip the wait, / or let it finish.", green
     *  FINISH with its Gems [CommandUi.price]. Lab upgrading: LOCKED "Lab is upgrading · 3h". */
    val footer: FooterUi,
    /** Loading: skeletons when there is no last good view. */
    val loading: Boolean = false,
    /** No verified catalogue: this EmptyState (the existing copy "Research controls need the latest verified game
     *  catalogue.") with REFRESH replaces the grid. */
    val catalogueMissing: EmptyStateUi? = null,
    /** A saved finish payment is pending (existing recovery): the blue row's text; null hides it. */
    val pendingPayment: String? = null,
    /** The Lab is upgrading: the panel at 60 %. */
    val paused: Boolean = false,
)

/** Research callbacks (SPEC §1.2 + §4). */
@Immutable data class ResearchActions(
    val onClose: () -> Unit = {},
    val onHistory: () -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    /** Selects a card (never starts). */
    val onSelect: (String) -> Unit = {},
    /** RESEARCH: Shards, no Seal. */
    val onResearch: () -> Unit = {},
    /** FINISH: the Seal. */
    val onFinish: () -> Unit = {},
    /** A lab-cap card: FocusBuilding("forge", then = Upgrade("forge")). */
    val onLabCap: () -> Unit = {},
    /** A short card: Need-more for Shards (spec `onShort()`; the troop is passed so the sheet can say which). */
    val onShort: (String) -> Unit = {},
    /** A locked card: the reason. */
    val onLocked: (String) -> Unit = {},
    /** A card tapped while the Lab works: the toast "The Lab works on one troop at a time." */
    val onBusyCard: (String) -> Unit = {},
    /** REFRESH on the no-catalogue state. */
    val onRefresh: () -> Unit = {},
    /** CHECK on the pending-payment row: the existing recovery flow. */
    val onCheckPayment: () -> Unit = {},
    val onNeedMore: (PriceUi) -> Unit = {},
    val onRefused: (CommandUi) -> Unit = {},
)

/**
 * The Alchemy Lab research sheet (research.png / research-busy.png). [modifier] must give it a bounded height.
 *
 * Pointer rule: a painted panel inside the SheetHost; no full-screen clickable, pointerInput, scrim or draggable here.
 */
@Composable fun ResearchSheet(ui: ResearchUi, on: ResearchActions, modifier: Modifier = Modifier,
    /** Rows the live host paints at the top of the panel (a saved research payment's recovery); null draws nothing. */
    recovery: (@Composable ColumnScope.() -> Unit)? = null) {
    val busy = ui.job != null
    val c = PkwTokens.Colors
    // research.html: "takes 17h 50m" in t-ink; research-busy.html: "Skip the wait," t-ink over "or let it finish." t-ink2.
    ArmyTallSheet(ui.header, emptyList(), null, on.onClose, on.onHistory, {}, modifier,
        footer = {
            ArmyFooter(ui.footer, if (busy) on.onFinish else on.onResearch, on.onNeedMore, on.onRefused, infoWidth = if (busy) 150.dp else 132.dp,
                infoColor = if (busy) c.textOnParch2 else c.textOnParch, firstInfoColor = c.textOnParch)
        }) { recovery?.invoke(this); ResearchBody(ui, on) }
}

@Composable private fun ColumnScope.ResearchBody(ui: ResearchUi, on: ResearchActions) {
    val c = PkwTokens.Colors
    val job = ui.job
    ui.pendingPayment?.let { NoticeRow(it, "CHECK", on.onCheckPayment) }
    Column(Modifier.fillMaxWidth().dimmed(ui.paused, 0.6f, 1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (job != null) {
            ResearchJobCard(job)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                PkwText("NEXT UP", PkwTokens.Type.caption, Modifier.weight(1f), color = c.textOnParch)
                PkwText("pick when the Lab is free", PkwTokens.Type.small, color = c.textOnParch2)
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                PkwText("UPGRADE TROOPS", PkwTokens.Type.caption, Modifier.weight(1f), color = c.textOnParch)
                PkwText("one at a time", PkwTokens.Type.small, color = c.textOnParch2)
            }
            PkwText("Troops max out at the Lab's level.", PkwTokens.Type.small, color = c.textOnParch2)
        }
        when {
            ui.catalogueMissing != null -> EmptyState(ui.catalogueMissing, onGo = { on.onRefresh() })
            ui.loading && ui.cards.isEmpty() -> SkeletonGrid(4, 8, PkwTokens.Dims.troopCardH)
            else -> CellGrid(ui.cards, 4, modifier = Modifier.padding(top = 6.dp).dimmed(job != null, 0.62f, 0.55f)) { card, m ->
                ResearchCard(card, job != null, on, m)
            }
        }
        if (job == null) {
            val reduced = LocalReducedMotion.current
            Crossfade(ui.selected, label = "research-detail",
                animationSpec = tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH)) { detail ->
                if (detail != null) ResearchDetail(detail)
            }
        }
    }
}

/** ResearchCard (the TroopCard body): the tag shows the current level, the cost row the next level's Shards price; the
 *  state replaces the cost ("Lab cap", "Max level", "In the Lab", "Unlock it first"). Taps routed by [researchTap]. */
@Composable private fun ResearchCard(card: ResearchCardUi, labBusy: Boolean, on: ResearchActions, modifier: Modifier) {
    val c = PkwTokens.Colors
    // While the Lab works every card is BUSY (the tap explains); it is drawn as it would be under the dim.
    val look = if (card.state == ResearchCardState.BUSY) card.busyLook ?: ResearchCardState.DEFAULT else card.state
    val selected = look == ResearchCardState.SELECTED
    val locked = look == ResearchCardState.LOCKED
    val tap = {
        when (researchTap(card.state, labBusy)) {
            ResearchTap.SELECT -> on.onSelect(card.troop)
            ResearchTap.NEED_MORE -> on.onShort(card.troop)
            ResearchTap.LAB_CAP -> on.onLabCap()
            ResearchTap.LOCKED -> on.onLocked(card.troop)
            ResearchTap.BUSY -> on.onBusyCard(card.troop)
            ResearchTap.NONE -> Unit
        }
    }
    val stateLine = when (look) {
        ResearchCardState.LAB_CAP -> "Lab cap"
        ResearchCardState.MAX -> "Max level"
        ResearchCardState.IN_LAB -> "In the Lab"
        else -> null
    }
    val spoken = listOfNotNull(card.name, card.level, if (locked) "Unlock it first" else stateLine ?: card.nextPrice?.let(::priceDescription),
        card.reason, if (selected) "selected, target ${card.target ?: UNKNOWN}" else null).joinToString(", ")
    Box(modifier) {
        ArmyCard(Modifier.fillMaxWidth().height(PkwTokens.Dims.troopCardH).goldLoCardShell(selected),
            body = when (look) {
                ResearchCardState.SELECTED -> c.selectedTint
                ResearchCardState.LAB_CAP -> ArmyInk.labCapBody
                ResearchCardState.LOCKED -> ArmyInk.lockedBody
                else -> null
            },
            rim = if (selected) c.gold.face else null, padding = PaddingValues(start = 4.dp, top = 6.dp, end = 4.dp, bottom = 8.dp),
            onClick = tap, description = spoken, selected = selected) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    // research.html `.tc.lock .por`: a darker well and the art grey at 45 %, the gold padlock on top.
                    PortraitWell(card.portrait, level = if (locked) null else card.level, saturation = if (locked) 0f else 1f,
                        artAlpha = if (locked) 0.45f else 1f, well = if (locked) LockedWell else ArmyInk.well)
                    if (locked) PkwIcon("shape:lock", 24.dp, tint = c.gold.face)
                }
                if (locked) PkwText("Unlock it first", PkwTokens.Type.small, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                else {
                    PkwText(card.name, PkwTokens.Type.small, color = c.textOnParch)
                    val price = card.nextPrice
                    if (stateLine != null || price == null) PkwText(stateLine ?: UNKNOWN, PkwTokens.Type.small, color = c.textOnParch)
                    else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        PkwIcon(currencyIcon(price.currency, price.icon), 24.dp)
                        PkwText(priceText(price), PkwTokens.Type.caption,
                            color = if (look == ResearchCardState.SHORT || price.status == PriceStatus.SHORT) c.shortText else c.textOnParch)
                    }
                }
            }
        }
        if (selected && card.target != null) {
            Badge(BadgeUi(card.target, BadgeTone.REWARD, "Target ${card.target}"), Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-8).dp))
        }
    }
}

/** A locked card's portrait well (research.html `.tc.lock .por`, `#1A171E`). */
private val LockedWell = Color(0xFF1A171E)

/** The selected card's gold-lo shell (research.html `.tc.sel .card`): the 2 dp ink outline around the card body is
 *  repainted gold-lo; the body and its 3 dp gold rim are untouched. */
internal fun Modifier.goldLoCardShell(on: Boolean): Modifier = if (!on) this else drawWithContent {
    drawContent()
    val i = 2.dp.toPx()
    val inner = steppedPath(i, i, size.width - 2 * i, size.height - 2 * i, profilePx(CornerProfiles.S, density))
    clipPath(inner, ClipOp.Difference) { fillStepped(0f, 0f, size.width, size.height, CornerProfiles.M, PkwTokens.Colors.gold.lo) }
}

/** ResearchDetail: next-tier portrait, "BOWMAN L4 → L5" and the stat rows. */
@Composable private fun ResearchDetail(d: ResearchDetailUi) {
    ArmyCard(Modifier.fillMaxWidth(), padding = PaddingValues(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PortraitWell(d.portrait)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(d.name.uppercase(), PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    LevelArrow(d.from, d.to)
                }
                d.stats.take(4).forEach { StatDeltaRow(it, keyWidth = 96.dp) }
            }
        }
    }
}

/** ResearchJobCard: gold rim on the selected tint, the troop, "L4 → L5", a 14 dp green meter, "Researching" and the time. */
@Composable private fun ResearchJobCard(job: ResearchJobUi) {
    val time = armyDuration(job.remainingSec)
    ArmyCard(Modifier.fillMaxWidth(), body = PkwTokens.Colors.selectedTint, rim = PkwTokens.Colors.gold.face, padding = PaddingValues(10.dp),
        description = "Researching ${job.name} ${job.from} to ${job.to}, $time left") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PortraitWell(job.portrait)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText(job.name.uppercase(), PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                    LevelArrow(job.from, job.to)
                }
                ParchMeter(job.progress, "Research progress", height = 14.dp)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    PkwText("Researching", PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
                    PkwText(time, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------------------------------

internal object ResearchSamples {
    private fun card(id: String, name: String, level: String, cost: String?, state: ResearchCardState = ResearchCardState.DEFAULT, target: String? = null) =
        ResearchCardUi(id, name, "ui_portrait_${id}_t1", level,
            cost?.let { ArmySamples.shards(it, if (state == ResearchCardState.SHORT) PriceStatus.SHORT else PriceStatus.OK) }, state, target)
    private val header = SheetHeaderUi("ALCHEMY LAB", "LV 6", HeaderChipUi(null, "Lab is free", null),
        HeaderArtUi(SpriteRef("ui_portrait_forge_t2", 56), 1, ArmySamples.walkers(listOf("ui_portrait_bowman_t2"), Dir8.S, 50, start = 300),
            buildingScale = 3, buildingXDp = 210, buildingYDp = 30))
    val cards = listOf(
        card("highlander", "Highlander", "L3", "1,200"),
        card("bowman", "Bowman", "L4", "1,600", ResearchCardState.SELECTED, "L5"),
        card("kegrunner", "Keg Runner", "L2", "800"),
        card("plunderer", "Plunderer", "L6", null, ResearchCardState.LAB_CAP),
        card("tunneler", "Tunneler", "L2", "800"),
        card("mage", "Mage", "L1", "400"),
        card("turrider", "Tur Rider", "L5", "48K", ResearchCardState.SHORT),
        card("giant", "Giant", "L1", "400"),
        card("bilgewraith", "Bilgewraith", "L1", "400"),
        card("hexbarrow", "Hexbarrow", "L1", null, ResearchCardState.LOCKED),
        card("direwyvern", "Dire Wyvern", "L1", null, ResearchCardState.LOCKED),
        card("dragon", "Dragon", "L1", null, ResearchCardState.MAX),
    )
    val free = ResearchUi(
        header = header, labLevel = 6, job = null, cards = cards,
        selected = ResearchDetailUi("bowman", "Bowman", "ui_portrait_bowman_t2", "L4", "L5",
            listOf(StatDeltaUi("Hitpoints", "45", "54"), StatDeltaUi("Damage/s", "14", "17")), 64_200, ArmySamples.shards("1,600")),
        footer = FooterUi(listOf("takes 17h 50m"), listOf(ArmySamples.shards("1,600")),
            ArmySamples.cmd("forge.research", "RESEARCH", Verb.GOLD, sub = "Bowman to L5")),
    )
    val busy = free.copy(
        header = header.copy(chip = HeaderChipUi("timer", "Bowman L5 in", "10h 41m")),
        job = ResearchJobUi("bowman", "Bowman", "ui_portrait_bowman_t2", "L4", "L5", 38_460, 0.4f,
            ArmySamples.cmd("forge.finish", "FINISH", Verb.GREEN, price = ArmySamples.gems("38"))),
        cards = cards.map {
            if (it.troop == "bowman") it.copy(state = ResearchCardState.IN_LAB, target = null)
            else it.copy(state = ResearchCardState.BUSY, busyLook = if (it.state == ResearchCardState.SELECTED) ResearchCardState.DEFAULT else it.state)
        },
        selected = null,
        footer = FooterUi(listOf("Skip the wait,", "or let it finish."), emptyList(),
            ArmySamples.cmd("forge.finish", "FINISH", Verb.GREEN, price = ArmySamples.gems("38"))),
    )
}

@Preview(name = "Research: Lab free, Bowman selected (research.png)", widthDp = 412, heightDp = 915)
@Composable private fun ResearchFreePreview() {
    SheetPreviewFrame(ArmySheetKind.RESEARCH) { ResearchSheet(ResearchSamples.free, ResearchActions(), it) }
}

@Preview(name = "Research: one running, FINISH primary (research-busy.png)", widthDp = 412, heightDp = 915)
@Composable private fun ResearchBusyPreview() {
    SheetPreviewFrame(ArmySheetKind.RESEARCH) { ResearchSheet(ResearchSamples.busy, ResearchActions(), it) }
}

@Preview(name = "Research: Lab upgrading (locked) + pending finish payment", widthDp = 412, heightDp = 915)
@Composable private fun ResearchLockedPreview() {
    val ui = ResearchSamples.free.copy(paused = true, pendingPayment = "A finish payment is waiting",
        footer = ResearchSamples.free.footer.copy(primary = ArmySamples.cmd("forge.research", "RESEARCH", Verb.GOLD, CommandState.LOCKED,
            reason = "Lab is upgrading · 3h")))
    SheetPreviewFrame(ArmySheetKind.RESEARCH) { ResearchSheet(ui, ResearchActions(), it) }
}

@Preview(name = "Research: no catalogue, loading, sending", widthDp = 1236, heightDp = 915)
@Composable private fun ResearchStatesPreview() {
    val noCatalogue = ResearchSamples.free.copy(cards = emptyList(), selected = null,
        catalogueMissing = EmptyStateUi("ui_portrait_forge_t1", "Research is unavailable",
            "Research controls need the latest verified game catalogue.", "REFRESH", FeatureId("forge.research")),
        footer = FooterUi(emptyList(), emptyList(), ArmySamples.cmd("forge.research", "RESEARCH", Verb.GOLD, CommandState.DISABLED,
            reason = "Research needs the latest catalogue")))
    val loading = ResearchSamples.free.copy(cards = emptyList(), selected = null, loading = true,
        footer = FooterUi(listOf(UNKNOWN), listOf(ArmySamples.shards(null, PriceStatus.CHECKING)),
            ArmySamples.cmd("forge.research", "RESEARCH", Verb.GOLD, sub = "checking price")))
    val sending = ResearchSamples.free.copy(footer = ResearchSamples.free.footer.copy(
        primary = ArmySamples.cmd("forge.research", "Sending", Verb.GOLD, CommandState.BUSY)))
    Row(Modifier.fillMaxSize()) {
        listOf(noCatalogue, loading, sending).forEach { ui ->
            Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.RESEARCH) { ResearchSheet(ui, ResearchActions(), it) } }
        }
    }
}
