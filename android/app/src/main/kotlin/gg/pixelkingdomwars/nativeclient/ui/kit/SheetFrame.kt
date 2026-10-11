package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the Sheet frame (DESIGN-SYSTEM §6 Sheet, Sheet header art, Tabs) and the modal scrim.
 *
 * [SheetFrame] is the wood-framed sheet: a header (the living header art when given, else a title row), the tab strip,
 * a parchment body that scrolls, and a footer pinned under the body (the sheet's one primary). It fills the space its
 * host gives it; size, position and the slide in / out motion belong to the SheetHost (values in [PkwTokens.Motion]).
 *
 * Pointer rule: the frame is a painted panel (a scene-input region) and never full-screen. A HALF sheet has no scrim: a
 * tap outside it reaches the kingdom, and the host closes the sheet from the scene's own tap. [ModalScrim] exists only
 * under a TALL / FULL sheet or a seal, and only while one is shown.
 *
 * Kit successor parameters (all defaulted, so earlier calls compile unchanged):
 * - [scrollState]: the body's scroll owner, hoisted so the SheetHost can save and restore a sheet's offset (design review
 *   ruling 092decf3 item 5). Pass null for a LAZY body: the frame then does not scroll, the body gets the bounded
 *   remaining height, and the body's `LazyColumn` (with its own hoisted `LazyListState`) should take
 *   `Modifier.weight(1f, fill = false)`.
 * - [headerHeight]: the living header's height, 136 dp by default; the Gold Forge hero is
 *   [PkwTokens.Dims.goldForgeHeaderH] (204 dp).
 * - [SheetFrameUi.titleTagTo]: draws a level transition on the title plate ([SheetTitlePlate]).
 * FULL sheet geometry (top 60, bottom 14 + gesture inset) is the host's: [sheetEdgesDp], [PkwTokens.Dims.fullSheetTop].
 */
@Composable fun SheetFrame(ui: SheetFrameUi, onClose: () -> Unit, modifier: Modifier = Modifier, onTab: (String) -> Unit = {},
    onHistory: () -> Unit = {}, header: (@Composable BoxScope.() -> Unit)? = null, footer: (@Composable ColumnScope.() -> Unit)? = null,
    scrollState: ScrollState? = rememberScrollState(), headerHeight: Dp = PkwTokens.Dims.sheetHeaderH,
    body: @Composable ColumnScope.() -> Unit) {
    val reduced = LocalReducedMotion.current
    val fade = remember { Animatable(1f) }
    var lastTab by remember { mutableStateOf(ui.selectedTab) }
    LaunchedEffect(ui.selectedTab) {
        if (lastTab != ui.selectedTab) {
            lastTab = ui.selectedTab
            fade.snapTo(0f)
            fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH))
        }
    }
    // kit-2.png TALL SHEET: a living header runs full-bleed inside the 3 dp ink rim with a 3 dp ink rule under it; the
    // tabs and the parchment then sit 8 dp inside the wood. A sheet without header art keeps the plain wood padding.
    val living = header != null || ui.portrait != null
    val inner = if (living) Modifier.padding(horizontal = 8.dp) else Modifier
    Plate(PlateKind.WOOD, modifier, contentPadding = if (living) livingSheetWoodPadding() else plateContentPadding(PlateKind.WOOD)) {
        val headerAndTabs: @Composable ColumnScope.() -> Unit = {
            if (living) LivingHeader(ui, onClose, onHistory, header, headerHeight)
            else TitleRow(ui, onClose, onHistory)
            Spacer(Modifier.height(if (living) 8.dp else 6.dp))
            if (ui.tabs.isNotEmpty()) TabStrip(ui.tabs, ui.selectedTab, onTab, inner)
        }
        val scroll = if (scrollState != null) Modifier.verticalScroll(scrollState) else Modifier
        val designed: @Composable () -> Unit = {
            Column(Modifier.fillMaxWidth()) {
                headerAndTabs()
                Column(Modifier.fillMaxWidth().weight(1f, fill = ui.size != SheetSize.HALF).then(inner)) {
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f, fill = ui.size != SheetSize.HALF), blocksScene = false) {
                        Column(Modifier.fillMaxWidth()) {
                            Column(Modifier.fillMaxWidth().weight(1f, fill = false).then(scroll)
                                .graphicsLayer { alpha = fade.value }.padding(horizontal = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = body)
                            if (footer != null) Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = footer)
                        }
                    }
                }
            }
        }
        // K-night-A11 (owner, hero altar / army cut-offs in landscape): a TALL / FULL frame under SheetFit.FRAMED_MIN_DP
        // scrolls its header and tabs away with the body (a page of the visible height) and keeps the footer (UPGRADE,
        // ATTACK, ...) pinned below on its own parchment strip. HALF keeps the designed wrap-content tree.
        if (ui.size == SheetSize.HALF) designed()
        else SheetFitBox(Modifier.fillMaxWidth()) { compact ->
            if (!compact) designed()
            else CollapsingSheetColumn(Modifier.fillMaxSize(), collapsing = headerAndTabs,
                // An if-expression types each branch as the composable slot (a lambda returned through let would not be).
                footer = if (footer == null) null else ({
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().then(inner).padding(top = 6.dp), blocksScene = false) {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp), content = footer)
                    }
                })) { page ->
                Plate(PlateKind.PARCHMENT, page.then(inner), blocksScene = false) {
                    Column(Modifier.fillMaxSize().then(scroll).graphicsLayer { alpha = fade.value }.padding(horizontal = 2.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp), content = body)
                }
            }
        }
    }
}

/** The plain header: title plate (+ level tag), optional History, close. */
@Composable private fun TitleRow(ui: SheetFrameUi, onClose: () -> Unit, onHistory: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SheetTitlePlate(ui.title, Modifier.weight(1f), ui.titleTag, ui.titleTagTo)
        if (ui.history) IconSquare("replay", Verb.STONE, onHistory, "History")
        CloseSquare(onClose)
    }
}

/** The living header ([height], 136 dp by default, 204 dp for the Gold Forge hero): the caller's art (or the static
 *  portrait), title plate top-left, History and close top-right, the live chip bottom-left. Cropped to the frame. */
@Composable private fun LivingHeader(ui: SheetFrameUi, onClose: () -> Unit, onHistory: () -> Unit, header: (@Composable BoxScope.() -> Unit)?,
    height: Dp) {
    Box(Modifier.fillMaxWidth().height(height).clipToBounds().background(PkwTokens.Colors.card).livingHeaderRule()) {
        if (header != null) header.invoke(this) else ui.portrait?.let { PkwIcon(it, 112.dp, Modifier.align(Alignment.Center)) }
        SheetTitlePlate(ui.title, Modifier.align(Alignment.TopStart).padding(6.dp), ui.titleTag, ui.titleTagTo)
        // kit-2.png: close 8 dp from the right and 4 from the top, History 6 dp to its left.
        Row(Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (ui.history) IconSquare("replay", Verb.STONE, onHistory, "History")
            CloseSquare(onClose)
        }
        ui.live?.let { TimerChip(it, Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 9.dp)) }
    }
}

/** The wood padding of a sheet with a living header: only the 3 dp ink rim at the top and sides (the header runs
 *  full-bleed inside it), the rim and lip at the bottom. Keep STORES draws its own header with the same frame. */
internal fun livingSheetWoodPadding(): PaddingValues = PaddingValues(start = 3.dp, top = 3.dp, end = 3.dp, bottom = 10.dp)

/** The 3 dp ink rule along the bottom of a living header, drawn over the header art. */
private fun Modifier.livingHeaderRule(): Modifier = drawWithContent {
    drawContent()
    val t = 3.dp.toPx()
    drawRect(PkwTokens.Colors.ink, Offset(0f, size.height - t), Size(size.width, t))
}

/**
 * Design component: the sheet's charcoal title plate (DESIGN-SYSTEM §6 Sheet header; buildings/SPEC.md UPGRADE title):
 * PS 13 gold-hi [title] and the blue level [tag]; with [tagTo] it is a level transition, blue [tag] → gold step arrow →
 * green [tagTo] ("LV 2 → LV 3"). A heading for screen readers ("Barracks, level LV 2 to LV 3"). Paint only: not a touch
 * target, not a scene-input region.
 */
@Composable fun SheetTitlePlate(title: String, modifier: Modifier = Modifier, tag: String? = null, tagTo: String? = null) {
    val spoken = when {
        tag != null && tagTo != null -> "$title, level $tag to $tagTo"
        tag != null -> "$title, $tag"
        else -> title
    }
    Box(modifier) {
        Plate(PlateKind.CHARCOAL, Modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) { heading(); contentDescription = spoken },
            blocksScene = false) {
            Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(title, PkwTokens.Type.title, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                if (tag != null) Tag(tag, Verb.BLUE)
                if (tag != null && tagTo != null) {
                    StepArrowGlyph(Modifier.size(12.dp, 14.dp))
                    Tag(tagTo, Verb.GREEN)
                }
            }
        }
    }
}

/** The gold right-pointing step arrow between two level tags (an ink-rimmed stepped triangle). Decorative. */
@Composable private fun StepArrowGlyph(modifier: Modifier, color: Color = PkwTokens.Colors.gold.face) {
    androidx.compose.foundation.Canvas(modifier.clearAndSetSemantics { }) {
        val w = size.width; val h = size.height
        val path = Path().apply { moveTo(0f, 0f); lineTo(w, h / 2f); lineTo(0f, h); close() }
        drawPath(path, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        val inner = Path().apply { moveTo(i, i * 1.6f); lineTo(w - i * 1.8f, h / 2f); lineTo(i, h - i * 1.6f); close() }
        drawPath(inner, color)
        drawLine(PkwTokens.Colors.gold.hi, Offset(i, i * 1.6f), Offset(i, h - i * 1.6f), strokeWidth = 1.dp.toPx())
    }
}

/**
 * Design component: the VeilChip (DESIGN-SYSTEM §5 VeilChip, army/SPEC.md §1 `HeaderChip`): 30 dp tall veil with a 10 dp
 * status [dot] (a verb colour) or a 24 dp [icon], a VT 20 [text] and an optional gold-hi [emphasis] ("Ready in", "0:42").
 * The sheet header's bottom-left chip. Paint only (not a touch target, not a scene-input region); read as one sentence.
 */
@Composable fun VeilChip(text: String, modifier: Modifier = Modifier, icon: String? = null, emphasis: String? = null, dot: Verb? = null,
    contentDescription: String = listOfNotNull(text, emphasis).joinToString(" ")) {
    Plate(PlateKind.VEIL, modifier.heightIn(min = PkwTokens.Dims.timerChipH).clearAndSetSemantics { this.contentDescription = contentDescription },
        contentPadding = PaddingValues(start = 6.dp, top = 2.dp, end = 8.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (dot != null) Box(Modifier.size(10.dp).background(PkwTokens.ramp(dot).face))
            if (icon != null) PkwIcon(icon, 24.dp)
            PkwText(text, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
            if (emphasis != null) PkwText(emphasis, PkwTokens.Type.body, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
        }
    }
}

/**
 * The scrim under a modal surface (TOKENS.json `color.scrim`). Full-screen by necessity, so it is allowed ONLY while a
 * TALL / FULL sheet or a seal is shown; compose it only then. A tap on it calls [onTap] (close / cancel; never confirm).
 * It is decoration for screen readers: the surface's own close button is the accessible way out.
 */
@Composable fun ModalScrim(alpha: Float, onTap: () -> Unit, modifier: Modifier = Modifier) {
    val currentTap by rememberUpdatedState(onTap)
    Box(modifier.fillMaxSize().background(PkwTokens.Colors.scrim.copy(alpha = alpha.coerceIn(0f, 1f)))
        .sceneInputRegion().clearAndSetSemantics { }
        .pointerInput(Unit) { detectTapGestures { currentTap() } })
}

/** The scrim a sheet of [size] takes: none for HALF (the kingdom stays touchable), 40 % for TALL, 60 % for FULL. Pass
 *  [progress] (0..1) from the host's enter / exit animation. */
@Composable fun SheetScrim(size: SheetSize, onTap: () -> Unit, progress: Float = 1f) {
    val alpha = sheetScrimAlpha(size)
    if (alpha <= 0f) return
    ModalScrim(alpha * progress, onTap)
}

@Preview(name = "Tall sheet", widthDp = 412, heightDp = 600)
@Composable private fun SheetFramePreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg)) {
        SheetFrame(
            SheetFrameUi("GOLD FORGE", null, SheetSize.TALL, listOf(
                TabUi("SMELT", "ui:ready-status", "SMELT", null, false),
                TabUi("CLAIM", "keep", "CLAIM", null, true),
                TabUi("GEMS", "gem", "GEMS", null, false)), "SMELT", titleTag = "LV 3",
                live = TimerUi("6h 20m", "Pool closes in 6 hours 20 minutes"), history = true),
            onClose = {}, modifier = Modifier.fillMaxSize().padding(PaddingValues(8.dp)),
            header = { Box(Modifier.fillMaxSize().background(PkwTokens.Colors.surface)) },
            footer = { PrimaryButton("SMELT 1", {}) },
        ) {
            PkwText("TODAY'S SMELT", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
            PkwText("Each ingot adds Shards to today's mining pool.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = 2)
            Spacer(Modifier.width(1.dp))
        }
    }
}

@Preview(name = "Gold Forge hero header (204 dp), level transition, chip", widthDp = 412, heightDp = 700)
@Composable private fun HeroSheetPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg)) {
        SheetFrame(
            SheetFrameUi("GOLD FORGE", null, SheetSize.FULL, emptyList(), null, titleTag = "LV 3", titleTagTo = "LV 4"),
            onClose = {}, modifier = Modifier.fillMaxSize().padding(PaddingValues(start = 4.dp, top = 60.dp, end = 4.dp, bottom = 14.dp)),
            header = {
                Box(Modifier.fillMaxSize().background(PkwTokens.Colors.surface))
                VeilChip("Smelted 2/3 · pool", Modifier.align(Alignment.BottomStart).padding(6.dp), dot = Verb.GREEN, emphasis = "6h 20m")
            },
            headerHeight = PkwTokens.Dims.goldForgeHeaderH,
        ) {
            PkwText("Upgrade adds a fourth smelt slot.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
        }
    }
}

@Preview(name = "Half sheet, no header art", widthDp = 412, heightDp = 360)
@Composable private fun HalfSheetPreview() {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg), contentAlignment = Alignment.BottomCenter) {
        SheetFrame(SheetFrameUi("NEED MORE", null, SheetSize.HALF, emptyList(), null), onClose = {}, modifier = Modifier.fillMaxWidth()) {
            PkwText("Need 12,400 more Shards", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
        }
    }
}
