package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.layout.offset
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CollapsingSheetColumn
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFitBox
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Design component: the BUILD tray (design/final/buildings/SPEC.md §3, build.png) and the new `BuildCard` (SPEC §0):
 * header (BUILD title plate, builders chip, close), six pictorial tabs (active one labelled, the rest icon-only with a
 * long-press label), and a parchment body of sections, each a 2-column grid of BuildCards in seven states.
 */

/** A BUILD card's state (SPEC §3.1). */
enum class BuildCardState {
    /** Can be placed: cream cost pill + time; a tap closes the tray and enters placement. */
    AVAILABLE,
    /** Not enough to pay: red cost pill; a tap pushes Need-more (no placement). */
    SHORT,
    /** Price not known yet: "…" pill; placement is allowed, PLACE waits for the price. */
    CHECKING,
    /** Needs another building first (Berth needs a Lodge): charcoal lock bar; a tap scrolls to that card and pulses it. */
    REQUIRES,
    /** Gated by Keep level: grey art, padlock, stone count, lock bar "Unlocks at Keep 11"; a tap shakes + toast GO. */
    LOCKED,
    /** All built: stone MAX tag + "more at Keep 12" / "one per kingdom"; a tap toasts "All built" + GO. */
    MAX,
    /** The server has it off: lock bar with the server's reason; a tap opens a half sheet with the reason. */
    UNAVAILABLE,
}

/** One BUILD card (SPEC §3.2). */
@Immutable data class BuildCardUi(
    /** The building type ("workshop"); what `onCard` hands back. */
    val type: String,
    /** PS name ("WORKSHOP"). */
    val name: String,
    /** VT purpose, two lines at most ("Refines raw realm finds into goods"; from the registry). */
    val purpose: String,
    /** Tier-1 art (`ui:workshop-t1-idle`, `ui:harv-<realm>-t1-idle`, or an existing GameArt name), drawn at 112 dp. */
    val art: String,
    /** The count tag ("0/1"). */
    val count: String,
    /** The count tag colour. SPEC calls this `Tone`; the kit's colour type is [Verb]: BLUE = can build, GREEN = all built,
     *  STONE = locked. */
    val countTone: Verb,
    /** The card state. */
    val state: BuildCardState,
    /** The build price; null while the catalogue has none (drawn "…"). See `cardPrice` for what the pill shows. */
    val price: PriceUi?,
    /** The build time ("2h"); null draws none. */
    val time: String?,
    /** REQUIRES / LOCKED / MAX / UNAVAILABLE: the bar's words ("Build a Lodge first", "Unlocks at Keep 11",
     *  "more at Keep 12", the server's reason). */
    val reason: String?,
    /** The gold NEW badge (until first seen). */
    val isNew: Boolean,
    /** REQUIRES: the building type it needs ("lodge"); the tray scrolls to that card and pulses it. */
    val requires: String?,
    /** 339e7ac0: previously admitted digits may be painted neutrally; never current funds or permission to place. */
    val priceHeld: Boolean = false,
    /** True: [purpose] carries the price words (hero recruitment's "Uses 1 hero contract · no KEEP"), so the footer draws
     *  no cost pill and no "…" in its place. */
    val priceInPurpose: Boolean = false,
)

/** One section of a tab (REALM TRADE, ECONOMY, ARMY, CLAN). */
@Immutable data class BuildSectionUi(
    /** Stable id. */
    val id: String,
    /** PS title ("REALM TRADE"). */
    val title: String,
    /** 64 px section icon, drawn at 32 dp (`ui:workshop-menu`). */
    val icon: String,
    /** VT count ("6 buildings"). */
    val count: String,
    /** Its cards, in the mapper's order. An empty section is hidden. */
    val cards: List<BuildCardUi>,
)

/** Everything the BUILD tray draws (SPEC §3.2). Opens instantly from the cached catalogue; unknown prices are "…". */
@Immutable data class BuildTrayUi(
    /** BUILDINGS, DEFENCES, TRAPS, HEROES, SUPPLIES, LAYOUTS (ids are the Destination tab values). */
    val tabs: List<TabUi>,
    /** The selected tab id. */
    val selectedTab: String,
    /** The builders chip ("1/2"). */
    val builders: String,
    /** True draws "free" beside the builders count. */
    val buildersFree: Boolean,
    /** The Shards row the HUD keeps above the tall sheet (DESIGN-SYSTEM §6 "Tall sheets: the stack shows only the currency
     *  that sheet spends"). Drawn by the HUD's ResourceStack, not by this composable. */
    val spend: ResourceChipUi,
    /** The selected tab's sections. */
    val sections: List<BuildSectionUi>,
    /** True shows "Tap one to place it. You pay on PLACE." (hidden after the first placement). */
    val firstTimeHint: Boolean,
    /** Added (SPEC §3 entry "BuildShop scrolled to X, its card pulsing"): a card type to scroll to and pulse on open. */
    val focusType: String? = null,
    /** Drawn centred on the parchment when no section has a card (SPEC §3.3 "never an empty grid"): the server's reason,
     *  or that the offers are still loading. */
    val emptyLine: String? = null,
)

/** The TRAPS tab / section icon (SPEC §5 `pkw_web_icon_powdercharge`). No kit or GameArt name resolves it, so the tray
 *  draws this drawable itself ([TrayIcon]). */
internal const val TRAY_POWDER_ICON = "pkw_web_icon_powdercharge"

/** The tray's callbacks (SPEC §3.2). */
class BuildTrayActions(
    /** A tab was chosen (LAYOUTS opens the layout editor; it renders no cards). */
    val onTab: (String) -> Unit,
    /** A card was tapped, in every state; route it with `cardTap(card.state)`. The tray itself only scrolls / pulses
     *  (REQUIRES) or shakes (LOCKED). */
    val onCard: (String) -> Unit,
    /** Close (red close, Back, scrim tap). */
    val onClose: () -> Unit,
    /** The builders chip: opens Builders. */
    val onBuilders: () -> Unit,
)

/** A one-shot visual cue on a card (pulse or shake); a new [tick] replays it. */
private data class CardCue(val type: String, val tick: Int)

/** Cards fade in 20 ms apart (SPEC §3.3; the token is DRAWER_ROW_STAGGER), only the first six. */
private const val STAGGERED_CARDS = 6
private const val CARD_STAGGER_MS = PkwTokens.Motion.DRAWER_ROW_STAGGER
/** The REQUIRES pulse: gold, 2 × 120 ms (SPEC §3.1). */
private const val PULSE_MS = 120
/** The active tab's width (SPEC §3.1). */
private val ACTIVE_TAB_W = 146.dp

/**
 * The BUILD tray (build.png). The SheetHost places it as a TALL sheet (y 104 to the bottom, left / right 4), slides it up
 * from 100 % with the 40 % scrim in 220 ms and out in 160 ms; it must be given a bounded height. Inside: header, tabs, and
 * the scrolling parchment of sections ([traySections]: empty ones hidden, a section with a NEW card first). Cards fade in
 * 20 ms apart (first six). A REQUIRES tap scrolls the required card into view and pulses it; a LOCKED tap shakes the card;
 * every tap also reaches [BuildTrayActions.onCard]. A tab change cross-fades the body in 120 ms.
 *
 * Pointer rule: this is one painted wood panel (a scene-input region) and only its tabs, chip, close and cards take taps.
 * The 40 % scrim under a TALL sheet is the SheetHost's (`SheetScrim`), composed only while the tray is shown; nothing here
 * is full-screen, a scrim, or a pointerInput root.
 */
@Composable fun BuildTray(ui: BuildTrayUi, on: BuildTrayActions, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val sections = remember(ui.sections) { traySections(ui.sections) }
    val positions = remember { HashMap<String, LayoutCoordinates>() }
    // Layout handles, not state: written during layout, read only when a card asks to be revealed.
    val content = remember { arrayOfNulls<LayoutCoordinates>(1) }
    var pulse by remember { mutableStateOf<CardCue?>(null) }
    var shake by remember { mutableStateOf<CardCue?>(null) }
    val enter = remember { Animatable(if (still) 1f else 0f) }
    val enterMs = PkwTokens.Motion.SHEET_IN + STAGGERED_CARDS * CARD_STAGGER_MS
    LaunchedEffect(Unit) { enter.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else enterMs, easing = LinearEasing)) }
    val fade = remember { Animatable(1f) }
    var lastTab by remember { mutableStateOf(ui.selectedTab) }
    LaunchedEffect(ui.selectedTab) {
        if (lastTab != ui.selectedTab) {
            lastTab = ui.selectedTab
            fade.snapTo(0f); fade.animateTo(1f, tween(PkwTokens.Motion.TAB_SWITCH))
        }
    }

    fun reveal(type: String) {
        val root = content[0] ?: return
        val card = positions[type]?.takeIf { it.isAttached && root.isAttached } ?: return
        val y = root.localPositionOf(card, Offset.Zero).y - with(density) { 8.dp.toPx() }
        scope.launch { scroll.animateScrollTo(y.roundToInt().coerceAtLeast(0)) }
        pulse = CardCue(type, (pulse?.tick ?: 0) + 1)
    }
    val currentOn by rememberUpdatedState(on)
    val tap: (BuildCardUi) -> Unit = { card ->
        when (cardTap(card.state)) {
            CardTap.SHOW_REQUIRED -> card.requires?.let(::reveal)
            CardTap.EXPLAIN_LOCKED -> shake = CardCue(card.type, (shake?.tick ?: 0) + 1)
            else -> {}
        }
        currentOn.onCard(card.type)
    }
    LaunchedEffect(ui.focusType) {
        val focus = ui.focusType ?: return@LaunchedEffect
        delay(PkwTokens.Motion.SHEET_IN.toLong()) // let the slide and the first layout settle
        reveal(focus)
    }

    Plate(PlateKind.WOOD, modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 9.dp, top = 9.dp, end = 9.dp, bottom = 0.dp)) {
        val headerAndTabs: @Composable ColumnScope.() -> Unit = {
            TrayHeader(ui, on)
            Spacer(Modifier.height(6.dp))
            BuildTabs(ui.tabs, ui.selectedTab, on.onTab)
        }
        val parchment: @Composable (Modifier) -> Unit = { placed ->
            Plate(PlateKind.PARCHMENT, placed, contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxSize().verticalScroll(scroll).onGloballyPositioned { content[0] = it }
                    .graphicsLayer { alpha = fade.value }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    var index = 0
                    if (sections.isEmpty()) ui.emptyLine?.let { line ->
                        PkwText(line, PkwTokens.Type.body, Modifier.fillMaxWidth().padding(vertical = 24.dp), color = PkwTokens.Colors.textOnParch2,
                            textAlign = TextAlign.Center, maxLines = 4)
                    }
                    sections.forEach { section ->
                        SectionHeader(section)
                        if (ui.firstTimeHint && section === sections.first()) PkwText("Tap one to place it. You pay on PLACE.",
                            PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
                        section.cards.chunked(2).forEach { pair ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                pair.forEach { card ->
                                    val i = index++
                                    // Card i fades over SHEET_IN starting i × 20 ms into the enter timeline; later cards do not fade.
                                    val fadeIn: () -> Float = if (i >= STAGGERED_CARDS) ({ 1f }) else if (reduced) ({ enter.value })
                                        else ({ ((enter.value * enterMs - i * CARD_STAGGER_MS) / PkwTokens.Motion.SHEET_IN).coerceIn(0f, 1f) })
                                    BuildCard(card, { tap(card) }, Modifier.weight(1f).onGloballyPositioned { positions[card.type] = it },
                                        pulse = pulse?.takeIf { it.type == card.type }?.tick ?: 0,
                                        shake = shake?.takeIf { it.type == card.type }?.tick ?: 0, fadeIn = fadeIn)
                                }
                                if (pair.size == 1) Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                    Spacer(Modifier.navigationBarsPadding())
                }
            }
        }
        // K-night-A11 (owner, BUILD > HEROES cut-offs in landscape): a tray under SheetFit.FRAMED_MIN_DP scrolls its header
        // and tabs away with a page of cards the visible height; the cards keep their own scroll.
        SheetFitBox(Modifier.fillMaxWidth()) { compact ->
            if (!compact) Column(Modifier.fillMaxSize()) {
                headerAndTabs()
                parchment(Modifier.fillMaxWidth().weight(1f))
            } else CollapsingSheetColumn(Modifier.fillMaxSize(), collapsing = headerAndTabs, page = parchment)
        }
    }
}

/** BUILD title plate, builders chip (tap → Builders), spacer, red close. */
@Composable private fun TrayHeader(ui: BuildTrayUi, on: BuildTrayActions) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Plate(PlateKind.CHARCOAL, Modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) { heading() },
            contentPadding = PaddingValues(start = 12.dp, top = 6.dp, end = 12.dp, bottom = 8.dp), blocksScene = false) {
            PkwText("BUILD", PkwTokens.Type.title, Modifier.align(Alignment.CenterStart), color = c.gold.hi, outline = 1.dp)
        }
        val spoken = "Builders ${ui.builders}${if (ui.buildersFree) " free" else ""}. Opens builders"
        Box(Modifier.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.onClick(label = null, action = { on.onBuilders(); true }) }
            .clickable(role = Role.Button, onClick = on.onBuilders), contentAlignment = Alignment.Center) {
            Plate(PlateKind.VEIL, Modifier.heightIn(min = 34.dp), contentPadding = PaddingValues(start = 3.dp, top = 2.dp, end = 8.dp, bottom = 2.dp),
                blocksScene = false) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    PkwIcon("builder", 30.dp)
                    PkwText(ui.builders, PkwTokens.Type.caption, color = c.text, outline = 1.dp)
                    if (ui.buildersFree) PkwText("free", PkwTokens.Type.small, color = c.text)
                }
            }
        }
        Spacer(Modifier.weight(1f))
        CloseSquare(on.onClose, contentDescription = "Close build")
    }
}

/**
 * The tray's tabs (SPEC §3.1 / §6.6): the active tab is 146 dp, parchment, icon + label, open into the panel; inactive tabs
 * share the rest, wood, icon only, labelled for screen readers, and a long-press shows the label in a pill. The kit's
 * TabStrip labels every tab at equal width, which does not fit six tabs at 412 dp, so this variant lives here.
 */
@Composable private fun BuildTabs(tabs: List<TabUi>, selected: String, onSelect: (String) -> Unit) {
    if (tabs.isEmpty()) return
    var tooltip by remember { mutableStateOf<String?>(null) }
    Box(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            tabs.forEach { tab ->
                val active = tab.id == selected
                BuildTab(tab, active, { onSelect(tab.id) }, { shown -> tooltip = if (shown) tab.label else null },
                    if (active) Modifier.width(ACTIVE_TAB_W) else Modifier.weight(1f))
            }
        }
        tooltip?.let { label ->
            Box(Modifier.align(Alignment.TopCenter).offset(y = (-40).dp).background(PkwTokens.Colors.ink.copy(alpha = 0.86f))
                .padding(horizontal = 10.dp, vertical = 4.dp).clearAndSetSemantics { }) {
                PkwText(label, PkwTokens.Type.body, color = PkwTokens.Colors.text)
            }
        }
    }
}

@Composable private fun BuildTab(tab: TabUi, active: Boolean, onClick: () -> Unit, onLabel: (Boolean) -> Unit, modifier: Modifier) {
    val reduced = LocalReducedMotion.current
    var pressed by remember { mutableStateOf(false) }
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "tab")
    val currentClick by rememberUpdatedState(onClick)
    val currentLabel by rememberUpdatedState(onLabel)
    val spoken = listOfNotNull(tab.label, if (tab.locked) "locked" else null, tab.badge?.description).joinToString(", ")
    Box(modifier) {
        Box(Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.tabH).sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = spoken; role = Role.Tab; this.selected = active
                this.onClick(label = null, action = { currentClick(); true })
                if (!active) this.onLongClick(label = "Show name", action = { currentLabel(true); true })
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = { pressed = true; tryAwaitRelease(); pressed = false; currentLabel(false) },
                    onLongPress = { currentLabel(true) },
                    onTap = { currentClick() },
                )
            }
            .offset { IntOffset(0, (2.dp.toPx() * press).roundToInt()) }
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                if (active) {
                    fillStepped(0f, 0f, w, h + 8.dp.toPx(), CornerProfiles.S, PkwTokens.Colors.ink)
                    insideStepped(i, i, w - i, h + 8.dp.toPx(), CornerProfiles.S) {
                        drawRect(PkwTokens.Colors.parchment)
                        band(i, w - i, i, 3.dp.toPx(), PkwTokens.Colors.parchmentHi)
                    }
                } else {
                    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                        drawRect(PkwTokens.Colors.wood)
                        band(i, w - i, i, 3.dp.toPx(), PkwTokens.Colors.woodHi)
                        band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), PkwTokens.Colors.woodLo)
                    }
                }
            }, contentAlignment = Alignment.Center) {
            Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    TrayIcon(tab.icon, trayTabIconSize(tab.icon), alpha = if (tab.locked) 0.5f else 1f)
                    if (tab.locked) PkwIcon("shape:lock", 16.dp, Modifier.align(Alignment.BottomEnd), tint = PkwTokens.Colors.gold.face)
                }
                if (active) PkwText(tab.label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
            }
        }
        if (tab.badge != null) Badge(tab.badge, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp))
    }
}

/** SPEC §5 tab icon sizes: the 32 px hammer and chest at 32 dp, 64 px Phase E art at 32, the 24 px shield, powder charge,
 *  layout and the 48 px Vex at 24. */
internal fun trayTabIconSize(icon: String): Dp =
    if (icon.startsWith("ui:") || icon == "itm_hammer" || icon == "itm_chest") 32.dp else 24.dp

/** A tray icon: the powder charge (no kit name resolves it) drawn from its drawable at 24 dp in a [size] box, nearest
 *  sampled; every other name is the kit's [PkwIcon]. Decorative (the tab / header carries the words). */
@Composable private fun TrayIcon(name: String, size: Dp, alpha: Float = 1f) {
    if (name != TRAY_POWDER_ICON) { PkwIcon(name, size, alpha = alpha); return }
    val bitmap = ImageBitmap.imageResource(R.drawable.pkw_web_icon_powdercharge)
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(24.dp)) {
            val k = minOf(this.size.width / bitmap.width, this.size.height / bitmap.height)
            val w = (bitmap.width * k).roundToInt(); val h = (bitmap.height * k).roundToInt()
            drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
                dstOffset = IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()),
                dstSize = IntSize(w, h), alpha = alpha, filterQuality = FilterQuality.None)
        }
    }
}

/** Section header (32 tall): 64 px icon at 32, PS title, spacer, VT count. */
@Composable private fun SectionHeader(section: BuildSectionUi) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TrayIcon(section.icon, 32.dp)
        PkwText(section.title, PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch)
        PkwText(section.count, PkwTokens.Type.small, color = c.textOnParch2)
    }
}

/**
 * One `BuildCard` (SPEC §3.1, ≈184 × 208): cream card, 100 dp grass well with the tier-1 art bottom-aligned at -10, count
 * tag top-left, gold NEW badge outside the corner, PS name, two VT purpose lines, and a footer: cost pill + time, or the
 * state bar. The whole card is one ≥ 48 dp button that answers in every state (the caller routes by `cardTap`). Press drops
 * the face 2 dp in 60 ms; [pulse] (a new value) flashes a gold rim 2 × 120 ms; [shake] shakes 2 dp × 2 in 160 ms.
 */
@Composable fun BuildCard(ui: BuildCardUi, onClick: () -> Unit, modifier: Modifier = Modifier, pulse: Int = 0, shake: Int = 0,
    fadeIn: () -> Float = { 1f }) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "card")
    val glow = remember { Animatable(0f) }
    LaunchedEffect(pulse) {
        if (pulse == 0) return@LaunchedEffect
        repeat(if (reduced) 1 else 2) { glow.snapTo(1f); glow.animateTo(0f, tween(PULSE_MS, easing = LinearEasing)) }
    }
    val wobble = remember { Animatable(0f) }
    LaunchedEffect(shake) {
        if (shake == 0 || reduced) return@LaunchedEffect
        wobble.snapTo(0f); wobble.animateTo(1f, tween(PkwTokens.Motion.INVALID_SHAKE, easing = LinearEasing)); wobble.snapTo(0f)
    }
    val locked = ui.state == BuildCardState.LOCKED
    val price = cardPrice(ui)
    val spoken = listOfNotNull(ui.name, ui.count, ui.purpose,
        when (ui.state) {
            BuildCardState.AVAILABLE, BuildCardState.SHORT, BuildCardState.CHECKING -> price?.let(::priceDescription)
            else -> ui.reason
        }, ui.time?.takeIf { price != null }?.let { "takes $it" }, if (ui.isNew) "new" else null).joinToString(". ")
    Box(modifier.graphicsLayer {
        alpha = fadeIn()
        translationX = if (wobble.value == 0f) 0f else (2.dp.toPx() * sin(wobble.value * 4f * PI.toFloat()))
    }) {
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().sceneInputRegion()
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .offset { IntOffset(0, (2.dp.toPx() * press).roundToInt()) }
            .drawWithContent {
                // The card's 4 dp #E6CF94 bottom band is the CREAM plate's own; the REQUIRES pulse draws a gold rim on top.
                drawContent()
                if (glow.value > 0f) drawRect(c.gold.hi.copy(alpha = glow.value), style = Stroke(3.dp.toPx()))
            }, blocksScene = false) {
            Column(Modifier.fillMaxWidth()) {
                Box(Modifier.fillMaxWidth().height(100.dp).clipToBounds().drawBehind { drawGrassWell() }) {
                    BuildingArt(ui.art, 112.dp, Modifier.align(Alignment.BottomCenter).offset(y = 10.dp), dim = locked)
                    if (locked) PkwIcon("shape:lock", 38.dp, Modifier.align(Alignment.Center), tint = c.gold.face)
                    Tag(ui.count, if (locked) Verb.STONE else ui.countTone, Modifier.align(Alignment.TopStart).padding(start = 6.dp, top = 6.dp))
                }
                PkwText(ui.name, PkwTokens.Type.label, Modifier.padding(start = 2.dp, top = 7.dp), color = c.textOnParch)
                PkwText(ui.purpose, PkwTokens.Type.small, Modifier.padding(horizontal = 2.dp).height(40.dp), color = c.textOnParch2, maxLines = 2)
                Box(Modifier.fillMaxWidth().height(34.dp).padding(top = 2.dp), contentAlignment = Alignment.CenterStart) { CardFooter(ui, price) }
            }
        }
        if (ui.isNew) Badge(BadgeUi("NEW", BadgeTone.REWARD, "New building"), Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-6).dp))
    }
}

@Composable private fun CardFooter(ui: BuildCardUi, price: PriceUi?) {
    val c = PkwTokens.Colors
    when (ui.state) {
        BuildCardState.AVAILABLE, BuildCardState.SHORT, BuildCardState.CHECKING ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (price != null) PriceChip(price)
                else if (!ui.priceInPurpose) PkwText(UNKNOWN, PkwTokens.Type.caption, color = c.textOnParch)
                if (ui.time != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    PkwIcon("timer", 24.dp)
                    PkwText(ui.time, PkwTokens.Type.caption, color = c.textOnParch)
                }
            }
        BuildCardState.MAX -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Tag("MAX", Verb.STONE)
            ui.reason?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
        }
        BuildCardState.REQUIRES, BuildCardState.LOCKED, BuildCardState.UNAVAILABLE -> LockBar(buildCardReasonLabel(ui))
    }
}

/** The charcoal lock bar (30 tall): padlock + VT gold reason. Paint only (the card is the button). */
@Composable private fun LockBar(text: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 30.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, PkwTokens.Colors.charcoal)
    }.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
        PkwText(text, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.gold.hi)
    }
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper) ----

private val sampleTabs = listOf(
    TabUi("BUILDINGS", "itm_hammer", "BUILDINGS", null, false),
    TabUi("DEFENCES", "shield", "DEFENCES", null, false),
    TabUi("TRAPS", TRAY_POWDER_ICON, "TRAPS", null, false),
    TabUi("HEROES", "hero_vex_portrait", "HEROES", null, false),
    TabUi("SUPPLIES", "itm_chest", "SUPPLIES", BadgeUi("1", BadgeTone.COUNT, "1 new supply"), false),
    TabUi("LAYOUTS", "layout", "LAYOUTS", null, false),
)

private fun shards(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SHARDS, amount, status)

private val sampleRealmTrade = BuildSectionUi("realm-trade", "REALM TRADE", "ui:workshop-menu", "6 buildings", listOf(
    BuildCardUi("workshop", "WORKSHOP", "Refines raw realm finds into goods", "ui:workshop-t1-idle", "0/1", Verb.BLUE,
        BuildCardState.AVAILABLE, shards("40,000"), "2h", null, isNew = true, requires = null),
    BuildCardUi("lodge", "LODGE", "Sends expeditions to the islands", "ui:lodge-t1-idle", "0/1", Verb.BLUE,
        BuildCardState.SHORT, shards("55,000"), "3h", null, isNew = true, requires = null),
    BuildCardUi("berth", "BERTH", "Docks and services your boats", "ui:berth-starter-intact", "0/1", Verb.BLUE,
        BuildCardState.REQUIRES, null, null, "Build a Lodge first", isNew = false, requires = "lodge"),
    BuildCardUi("harvester", "HARVESTER", "Gathers your realm's raw finds", "ui:harv-cinderfall-t1-idle", "1/1", Verb.GREEN,
        BuildCardState.MAX, null, null, "more at Keep 12", isNew = false, requires = null),
    BuildCardUi("market", "MARKET", "Buy and sell with other players", "ui:market-t1-idle", "0/1", Verb.STONE,
        BuildCardState.LOCKED, null, null, "Unlocks at Keep 11", isNew = false, requires = null),
    BuildCardUi("goldforge", "GOLD FORGE", "Smelts ingots, claims KEEP", "ui:goldforge-t1-idle", "1/1", Verb.GREEN,
        BuildCardState.MAX, null, null, "one per kingdom", isNew = false, requires = null),
))

private val sampleEconomy = BuildSectionUi("economy", "ECONOMY", "shards", "2 buildings", listOf(
    BuildCardUi("mine", "MINE", "Digs Shards every hour", "building-mine", "2/3", Verb.BLUE,
        BuildCardState.CHECKING, shards(null, PriceStatus.CHECKING), "45m", null, isNew = false, requires = null),
    BuildCardUi("vault", "VAULT", "Keeps Shards safe from raids", "building-vault", "1/2", Verb.BLUE,
        BuildCardState.UNAVAILABLE, null, null, "Vault building is paused", isNew = false, requires = null),
))

private val sampleTray = BuildTrayUi(
    tabs = sampleTabs, selectedTab = "BUILDINGS", builders = "1/2", buildersFree = true,
    spend = ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.62f, false, null, name = "Shards", accent = ResourceAccent.SHARDS),
    sections = listOf(sampleEconomy, sampleRealmTrade), firstTimeHint = true,
)

private val previewTrayActions = BuildTrayActions(onTab = {}, onCard = {}, onClose = {}, onBuilders = {})

@Composable private fun TrayPreviewFrame(ui: BuildTrayUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        Box(Modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = PkwTokens.Scrim.SHEET_TALL)))
        BuildTray(ui, previewTrayActions, Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Build tray: BUILDINGS (build.png; NEW section sorts first)", widthDp = 412, heightDp = 915)
@Composable private fun BuildTrayPreview() = TrayPreviewFrame(sampleTray)

@Preview(name = "Build tray: prices still loading (cached catalogue, never empty)", widthDp = 412, heightDp = 915)
@Composable private fun BuildTrayLoadingPreview() = TrayPreviewFrame(sampleTray.copy(firstTimeHint = false, sections = listOf(sampleRealmTrade.copy(
    cards = sampleRealmTrade.cards.map { if (it.state == BuildCardState.AVAILABLE || it.state == BuildCardState.SHORT)
        it.copy(state = BuildCardState.CHECKING, price = shards(null, PriceStatus.CHECKING)) else it }))))

@Preview(name = "Build tray: price fetch failed (pills say unavailable)", widthDp = 412, heightDp = 915)
@Composable private fun BuildTrayErrorPreview() = TrayPreviewFrame(sampleTray.copy(buildersFree = false, builders = "0/2",
    sections = listOf(sampleRealmTrade.copy(cards = sampleRealmTrade.cards.map {
        if (it.state == BuildCardState.AVAILABLE || it.state == BuildCardState.SHORT) it.copy(state = BuildCardState.AVAILABLE,
            price = shards(null, PriceStatus.UNAVAILABLE)) else it }))))

@Preview(name = "Build card states", widthDp = 400, heightDp = 480)
@Composable private fun BuildCardStatesPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        sampleRealmTrade.cards.take(4).chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { pair.forEach { BuildCard(it, {}, Modifier.weight(1f)) } }
        }
    }
}

@Preview(name = "Build tray: tabs", widthDp = 412, heightDp = 90)
@Composable private fun BuildTabsPreview() {
    Column(Modifier.background(PkwTokens.Colors.wood).padding(start = 8.dp, end = 8.dp, top = 20.dp)) {
        BuildTabs(sampleTabs, "BUILDINGS") {}
        Box(Modifier.fillMaxWidth().height(12.dp).background(PkwTokens.Colors.parchment))
    }
}

@Preview(name = "Build card: locked, narrow", widthDp = 200, heightDp = 260)
@Composable private fun BuildCardLockedPreview() {
    Box(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp).size(184.dp, 240.dp)) {
        BuildCard(sampleRealmTrade.cards[4], {})
    }
}
