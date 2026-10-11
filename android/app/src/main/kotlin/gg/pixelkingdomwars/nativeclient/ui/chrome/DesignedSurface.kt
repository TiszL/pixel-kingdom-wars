@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.chrome

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.chunkyContentPadding
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Owner 2026-10-06 (OWNER-FEEDBACK-0450Z): "I should not see any even 1 of old screens". The second old-screen sweep.
 *
 * Every pre-rehaul owner body (receipts, saved-payment recovery, claims, permits, charters, tournaments, trials, the
 * Harvester / starter / Gems fallbacks) was drawn on the dark `GamePage` with the old chrome primitives (Palette text,
 * PixelPanel, the web Btn plates, the ink dialog). Those bodies own money consent wording and recovery sequencing, so
 * their logic, owners and sentences stay exactly as they are. What changes is the surface they are drawn on:
 *
 *  - [DesignedPage] replaces `GamePage`: the kit TALL sheet (wood frame, charcoal title plate, red close square,
 *    parchment body, optional kit tab strip and pinned footer) as one full-screen card over the opaque wood backdrop
 *    (the morning's full-screen sheet rule: nothing dim behind the camera cut-out, nothing under it).
 *  - Inside it [LocalSurfaceTone] is [SurfaceTone.PARCHMENT]. The chrome primitives the bodies already call (Button,
 *    OutlinedButton, TextButton, PixelPanel, PixelPlate, Card, the payment plate, the titled / disclosure plates, the
 *    field, checkbox, chip, divider, progress line and the dialog) read the tone and draw the kit material: cream
 *    cards, gold / stone chunky buttons with outlined labels, quiet blue links, the wood-framed parchment dialog.
 *  - [SurfaceInk] gives the text colours by their old names (`SurfaceInk.muted` for `Palette.muted`): on parchment the
 *    design's ink (`textOnParch`, `textOnParch2`, `shortText`), anywhere else exactly the old Palette colour. A body
 *    that moved to [SurfaceInk] therefore reads correctly on both surfaces, and a helper it shares with a still-dark
 *    surface is unchanged there.
 *
 * Outside a designed page the tone is [SurfaceTone.LEGACY] and every primitive draws exactly as before, except the
 * dialog, which is always the designed wood frame (charcoal body when its caller is still dark, so the caller's light
 * text stays readable).
 */

/** Which material a body drawn with the chrome primitives sits on. */
enum class SurfaceTone {
    /** The old dark page: every primitive draws its pre-rehaul look. */
    LEGACY,
    /** The designed parchment sheet body (and the cream cards on it). */
    PARCHMENT,
    /** A designed dark plate (a charcoal dialog body, a chunky button face): kit chrome, light text. */
    CHARCOAL,
}

/** The surface the enclosing body is drawn on; [DesignedPage] and the designed dialog provide it. */
val LocalSurfaceTone = staticCompositionLocalOf { SurfaceTone.LEGACY }

/** True while the enclosing body is on the designed parchment. */
@Composable @ReadOnlyComposable fun onParchment(): Boolean = LocalSurfaceTone.current == SurfaceTone.PARCHMENT

/** True while the enclosing body is any designed surface (the chrome buttons draw the kit chunky faces). */
@Composable @ReadOnlyComposable fun onDesignedSurface(): Boolean = LocalSurfaceTone.current != SurfaceTone.LEGACY

/**
 * Text colours by their old [Palette] names. On [SurfaceTone.PARCHMENT] each is the design's ink on light (colour pass
 * 2026-10-02: `textOnParch` 10:1, `textOnParch2` 5.8:1, `shortText` for a refusal, the deep green / gold lips for a
 * state word); anywhere else it is the exact old colour, so moving a body to these names never changes a dark surface.
 */
object SurfaceInk {
    val text: Color @Composable @ReadOnlyComposable get() = pick(Palette.text, ParchmentInk.text)
    val muted: Color @Composable @ReadOnlyComposable get() = pick(Palette.muted, ParchmentInk.muted)
    val faint: Color @Composable @ReadOnlyComposable get() = pick(Palette.textFaint, ParchmentInk.faint)
    /** Headings and the selected word: brown ink on parchment, never gold on light. */
    val goldHi: Color @Composable @ReadOnlyComposable get() = pick(Palette.goldHi, ParchmentInk.goldHi)
    /** An accent (a gold rim, a gold state word): the gold ramp's lip on parchment. */
    val gold: Color @Composable @ReadOnlyComposable get() = pick(Palette.gold, ParchmentInk.gold)
    val danger: Color @Composable @ReadOnlyComposable get() = pick(Palette.danger, ParchmentInk.danger)
    val success: Color @Composable @ReadOnlyComposable get() = pick(Palette.success, ParchmentInk.success)
    /** A hairline or a row rule. */
    val rule: Color @Composable @ReadOnlyComposable get() = pick(Palette.border, PkwTokens.Colors.parchmentLo)
    val ruleLt: Color @Composable @ReadOnlyComposable get() = pick(Palette.borderLt, PkwTokens.Colors.creamLo)
    /** A filled well or card behind text ([Palette.ink] / [Palette.card] on a dark page): cream on parchment. */
    val well: Color @Composable @ReadOnlyComposable get() = pick(Palette.ink, PkwTokens.Colors.cream)
    val card: Color @Composable @ReadOnlyComposable get() = pick(Palette.card, PkwTokens.Colors.cream)
    /** The selected tile or tab behind text ([Palette.panel] on a dark page): the kit's selected tint on parchment. */
    val selected: Color @Composable @ReadOnlyComposable get() = pick(Palette.panel, PkwTokens.Colors.selectedTint)

    @Composable @ReadOnlyComposable private fun pick(legacy: Color, parchment: Color): Color = if (onParchment()) parchment else legacy
}

/** The parchment values [SurfaceInk] swaps in for the old light text colours (pure, so a test can hold them to the
 *  4.5:1 reading floor on every light fill a converted body sits on: parchment, the cream card, the selected tint). */
internal object ParchmentInk {
    val text: Color = PkwTokens.Colors.textOnParch
    val muted: Color = PkwTokens.Colors.textOnParch2
    val faint: Color = PkwTokens.Colors.textOnParch2
    val goldHi: Color = PkwTokens.Colors.textOnParch
    val gold: Color = PkwTokens.Colors.gold.lo
    val danger: Color = PkwTokens.Colors.shortText
    val success: Color = PkwTokens.Colors.green.lo
    /** Every text colour above, by its old [Palette] name. */
    val byLegacyName: Map<String, Pair<Color, Color>> get() = mapOf(
        "text" to (Palette.text to text), "muted" to (Palette.muted to muted), "textFaint" to (Palette.textFaint to faint),
        "goldHi" to (Palette.goldHi to goldHi), "gold" to (Palette.gold to gold), "danger" to (Palette.danger to danger),
        "success" to (Palette.success to success))
}

/**
 * The designed page that replaces the old dark `GamePage` (same title / close / ColumnScope body contract, so a body
 * moves over unchanged): one full-screen kit TALL sheet. The opaque wood backdrop covers the whole window (behind the
 * camera cut-out and the gesture bar, nothing of the old page or the kingdom shows through); the wood frame sits inside
 * the safe-drawing and keyboard insets with its charcoal title plate and red close square; the parchment body scrolls
 * ([scrollState], hoisted so an owner can return to the top; null gives the body the bounded height instead, for an
 * owner that pins part of itself and scrolls the rest with `Modifier.weight`); [tabs] draw the kit tab strip; [footer]
 * is pinned under the body (the page's one primary). The body and footer are composed on [SurfaceTone.PARCHMENT].
 */
@Composable fun DesignedPage(title: String, onClose: () -> Unit, modifier: Modifier = Modifier,
    tabs: List<TabUi> = emptyList(), selectedTab: String? = null, onTab: (String) -> Unit = {},
    scrollState: ScrollState? = rememberScrollState(), footer: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.fillMaxSize()) {
        FullScreenSheetBackdrop()
        SheetFrame(SheetFrameUi(title, null, SheetSize.TALL, tabs, selectedTab.takeIf { tabs.isNotEmpty() }), onClose = onClose,
            modifier = Modifier.fillMaxSize().pageInsets().padding(horizontal = 4.dp, vertical = 4.dp), onTab = onTab,
            scrollState = scrollState,
            footer = if (footer == null) null else ({ ParchmentColumn(Modifier.fillMaxWidth(), 6.dp, footer) })) {
            ParchmentColumn((if (scrollState == null) Modifier.fillMaxSize() else Modifier.fillMaxWidth())
                .padding(horizontal = 6.dp, vertical = 4.dp), 10.dp, content)
        }
    }
}

/** A column whose content is composed on the parchment: brown ink as the default text colour. */
@Composable private fun ParchmentColumn(modifier: Modifier, spacing: Dp, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(spacing)) {
        val scope = this
        CompositionLocalProvider(LocalSurfaceTone provides SurfaceTone.PARCHMENT, LocalContentColor provides PkwTokens.Colors.textOnParch) {
            scope.content()
        }
    }
}

/**
 * The kit face of the chrome `Button` / `OutlinedButton` / `TextButton` on a designed surface (DESIGN-SYSTEM §6):
 * "gold" is the chunky gold primary, "sec" the chunky stone secondary, both with the white outlined label and the 3 dp
 * press; a disabled one is the off face. "ghost" is the quiet underlined link (blue lip on parchment, blue highlight on
 * a dark plate). The caller's click, enabled state and content (its label) are unchanged; only the paint differs.
 */
@Composable internal fun DesignedChromeButton(onClick: () -> Unit, modifier: Modifier, enabled: Boolean, variant: String,
    contentPadding: PaddingValues, content: @Composable RowScope.() -> Unit) {
    val direction = LocalLayoutDirection.current
    val horizontal = contentPadding.calculateLeftPadding(direction).coerceAtMost(14.dp)
    if (variant == "ghost") {
        val color = when {
            !enabled -> SurfaceInk.faint
            onParchment() -> PkwTokens.Colors.blue.lo
            else -> PkwTokens.Colors.blue.hi
        }
        val style = LocalTextStyle.current.merge(MaterialTheme.typography.labelLarge).copy(textDecoration = TextDecoration.Underline)
        Row(modifier.defaultMinSize(minWidth = PkwTokens.Dims.minTap, minHeight = PkwTokens.Dims.minTap).sceneInputRegion()
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = horizontal, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            val scope = this
            CompositionLocalProvider(LocalContentColor provides color, LocalTextStyle provides style) { scope.content() }
        }
        return
    }
    val ramp = PkwTokens.ramp(when { !enabled -> Verb.OFF; variant == "gold" -> Verb.GOLD; else -> Verb.STONE })
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed && enabled) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE,
            easing = if (pressed) PkwTokens.Motion.Linear else PkwTokens.Motion.Pop), label = "press")
    Box(modifier.defaultMinSize(minWidth = PkwTokens.Dims.minTap, minHeight = PkwTokens.Dims.minTap).sceneInputRegion()
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
        .drawBehind { drawChunky(ramp, press) }, contentAlignment = Alignment.Center) {
        Box(Modifier.padding(chunkyContentPadding()).offset { IntOffset(0, (3.dp.toPx() * press.coerceIn(0f, 1f)).roundToInt()) }
            .padding(horizontal = horizontal, vertical = 4.dp), contentAlignment = Alignment.Center) {
            OutlinedLabel(if (variant == "gold" && enabled) 2.dp else 1.dp, content)
        }
    }
}

/**
 * The kit's outlined label (KitText 2-pass outline) for a content slot. The slot is composed twice in the same padded
 * row: first as a silhouette (silent to screen readers) drawn eight times, [outline] apart in every direction, into an
 * offscreen layer that is then filled with ink (SrcIn), and then as the white fill on top. Because the silhouette is
 * made from the drawn pixels, a label that brings its own text style or colour, or an icon, still gets the ink rim.
 * Inside both passes the tone is [SurfaceTone.CHARCOAL], so a [SurfaceInk] colour keeps its light value on the face.
 */
@Composable private fun OutlinedLabel(outline: Dp, content: @Composable RowScope.() -> Unit) {
    val fill = LocalTextStyle.current.merge(MaterialTheme.typography.labelLarge)
    val ink = PkwTokens.Colors.ink
    Box(contentAlignment = Alignment.Center) {
        LabelRow(outline, fill, Modifier.clearAndSetSemantics { }
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
            .drawWithContent {
                val o = outline.toPx(); val pass = this
                for (dx in -1..1) for (dy in -1..1) if (dx != 0 || dy != 0) translate(dx * o, dy * o) { pass.drawContent() }
                drawRect(ink, blendMode = BlendMode.SrcIn)
            }, content)
        LabelRow(outline, fill, Modifier, content)
    }
}

/** One pass of [OutlinedLabel]: the slot in a row padded by the outline width, white by default, on a dark tone. */
@Composable private fun LabelRow(outline: Dp, style: TextStyle, modifier: Modifier, content: @Composable RowScope.() -> Unit) {
    Row(modifier.padding(outline), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically) {
        val scope = this
        CompositionLocalProvider(LocalSurfaceTone provides SurfaceTone.CHARCOAL, LocalContentColor provides PkwTokens.Colors.label,
            LocalTextStyle provides style) { scope.content() }
    }
}

/**
 * The designed dialog panel (DESIGN-SYSTEM §6 ConfirmDialog, kit-2.png SEAL) behind the chrome `AlertDialog`: the wood
 * frame, the charcoal title plate (gold-hi title, the caller's [icon]) and the red close square, then the [text] and
 * the actions on one body plate: parchment when [parchment] (the caller sits on a designed page and reads
 * [SurfaceInk]), charcoal otherwise (the caller's light text stays readable). The caller's buttons draw the kit faces
 * because the body is a designed surface. [wholePanelScrolls] keeps the old rule: on a short or large-text viewport the
 * whole panel scrolls, otherwise only the text does, so the actions stay reachable.
 */
@Composable internal fun DesignedDialogPanel(onDismissRequest: () -> Unit, confirmButton: @Composable () -> Unit, modifier: Modifier,
    dismissButton: (@Composable () -> Unit)?, icon: (@Composable () -> Unit)?, title: (@Composable () -> Unit)?,
    text: (@Composable () -> Unit)?, wholePanelScrolls: Boolean, parchment: Boolean) {
    val bodyTone = if (parchment) SurfaceTone.PARCHMENT else SurfaceTone.CHARCOAL
    val bodyColor = if (parchment) PkwTokens.Colors.textOnParch else Palette.text
    val heading: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Plate(PlateKind.CHARCOAL, Modifier.weight(1f).heightIn(min = 44.dp), blocksScene = false) {
                Row(Modifier.fillMaxWidth().align(Alignment.CenterStart).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    icon?.invoke()
                    Box(Modifier.weight(1f)) {
                        CompositionLocalProvider(LocalSurfaceTone provides SurfaceTone.CHARCOAL, LocalContentColor provides PkwTokens.Colors.gold.hi) {
                            ProvideTextStyle(MaterialTheme.typography.titleLarge) { title?.invoke() }
                        }
                    }
                }
            }
            CloseSquare(onDismissRequest)
        }
    }
    val body: @Composable () -> Unit = {
        if (text != null) Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp)) {
            ProvideTextStyle(MaterialTheme.typography.bodyMedium, content = text)
        }
    }
    val actions: @Composable () -> Unit = {
        FlowRow(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            dismissButton?.invoke(); confirmButton()
        }
    }
    Plate(PlateKind.WOOD, modifier) {
        CompositionLocalProvider(LocalSurfaceTone provides bodyTone) {
            if (wholePanelScrolls) Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                heading()
                Plate(if (parchment) PlateKind.PARCHMENT else PlateKind.CHARCOAL, Modifier.fillMaxWidth(), blocksScene = false) {
                    CompositionLocalProvider(LocalContentColor provides bodyColor) { Column(Modifier.fillMaxWidth()) { body(); actions() } }
                }
            } else Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                heading()
                Plate(if (parchment) PlateKind.PARCHMENT else PlateKind.CHARCOAL, Modifier.fillMaxWidth().weight(1f, fill = false), blocksScene = false) {
                    CompositionLocalProvider(LocalContentColor provides bodyColor) {
                        Column(Modifier.fillMaxWidth()) {
                            if (text != null) Box(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) { body() }
                            actions()
                        }
                    }
                }
            }
        }
    }
}
