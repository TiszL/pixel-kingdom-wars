package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubColors
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Design component: the account cluster's shared parts (design/final/account/SPEC.md §0, `_build/account.css`):
 * `Tabs.Stacked` (§0.2, the cluster's one new primitive), the striped `DevTag` (§0.6), the gold-framed portrait Well,
 * the CreamCard column ([AccountCard]), a realm thumbnail at a whole-number scale, the padlock note and the PS letter
 * well (no authored Google / X marks). All are compositions of kit plates, kit stepped drawing and hub parts.
 *
 * Pointer rule: only [StackedTabs]' tabs and an [AccountCard] given an onClick take touches; nothing here is
 * full-screen or a scrim.
 */

/** Literal colours the account SPEC names that are not kit tokens. */
internal object AccountColors {
    /** SKR value on parchment (`#3F6E14`). */
    val skrValue = Color(0xFF3F6E14)
    /** KEEP value on parchment (`#8F5A12`, the gold lip). */
    val keepValue = Color(0xFF8F5A12)
    /** The ready faucet / best-match card face. */
    val readyFace = Color(0xFFEEF7D8)
    /** Empty phase step / disabled token. */
    val emptyStep = Color(0xFFD6C49A)
    /** DevTag stripes. */
    val devStripe = Color(0xFF3A353F)
    val devFace = Color(0xFF2A2630)
    /** The online dot. */
    val online = Color(0xFF3FBF3A)
}

/** The stacked tab's height: 56 dp (SPEC §0.2). */
private val STACKED_TAB_H = 56.dp

/**
 * `Tabs.Stacked` (SPEC §0.2): 56 dp tabs, the icon (24, or 32 for 64 px art; 28 for a Keep portrait) above a PS 11 label,
 * the width following the label (`flex: 1 1 auto`: each tab's share grows with its label), 4 dp apart. The active tab is
 * parchment and runs on into the panel below; inactive tabs are wood with outlined labels. A badge sits at −8 / −4
 * outside the corner; a locked tab shows a padlock and still calls back so the caller can say why. Pressing drops a tab
 * 2 dp. Each tab is its own ≥ 48 dp target; the strip itself has no pointer handling.
 */
@Composable fun StackedTabs(tabs: List<TabUi>, selected: String?, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    if (tabs.isEmpty()) return
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        tabs.forEach { tab -> StackedTab(tab, tab.id == selected, { onSelect(tab.id) }, Modifier.weight(stackedTabWeight(tab.label))) }
    }
}

/** A tab's share of the strip: its label length plus a fixed part (CSS `flex: 1 1 auto` approximated). */
internal fun stackedTabWeight(label: String): Float = label.length.coerceAtLeast(4) + 3f

@Composable internal fun StackedTab(tab: TabUi, active: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "stackedTab")
    val spoken = listOfNotNull(tab.label, if (tab.locked) "locked" else null, tab.badge?.description).joinToString(", ")
    val c = PkwTokens.Colors
    val iconSize = when {
        tab.icon.startsWith("ui_portrait") -> 28.dp
        tab.icon.startsWith("ui:") || tab.icon.startsWith("itm_") -> 32.dp
        else -> 24.dp
    }
    Box(modifier) {
        Box(Modifier.fillMaxWidth().height(STACKED_TAB_H).sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = spoken; role = Role.Tab; this.selected = active
                this.onClick(label = null, action = { onClick(); true })
            }
            .clickable(interactionSource = interaction, indication = null, role = Role.Tab, onClick = onClick)
            .offset { IntOffset(0, (2.dp.toPx() * press).roundToInt()) }
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                if (active) {
                    fillStepped(0f, 0f, w, h + 8.dp.toPx(), CornerProfiles.S, c.ink)
                    insideStepped(i, i, w - i, h + 8.dp.toPx(), CornerProfiles.S) {
                        drawRect(c.parchment)
                        band(i, w - i, i, 3.dp.toPx(), c.parchmentHi)
                    }
                } else {
                    fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                        drawRect(c.wood)
                        band(i, w - i, i, 3.dp.toPx(), c.woodHi)
                        band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), c.woodLo)
                    }
                }
            }) {
            HubArt(tab.icon, iconSize, Modifier.align(Alignment.TopCenter).padding(top = 3.dp), alpha = if (tab.locked) 0.5f else 1f)
            if (tab.locked) PkwIcon("shape:lock", 16.dp, Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 4.dp), tint = c.gold.face)
            if (active) PkwText(tab.label, PkwTokens.Type.caption, Modifier.align(Alignment.BottomCenter).padding(bottom = 1.dp), color = c.textOnParch)
            else PkwText(tab.label, PkwTokens.Type.caption, Modifier.align(Alignment.BottomCenter).padding(bottom = 3.dp), color = c.label, outline = 1.dp)
        }
        tab.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp)) }
    }
}

/**
 * The striped stone DevTag (SPEC §0.6): "DEVNET" / "DEVNET PRICE" on test tokens. Dark face with diagonal stripes, a light
 * rim and an outlined caption. Paint only; never rendered on mainnet (the mapper passes devnet = false).
 */
@Composable fun DevTag(modifier: Modifier = Modifier, text: String = "DEVNET") {
    val c = PkwTokens.Colors
    Box(modifier.heightIn(min = 30.dp).clearAndSetSemantics { contentDescription = "$text, test network" }.drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(c.stone.hi)
            val j = 2.dp.toPx()
            drawRect(AccountColors.devFace, Offset(i + j, i + j), Size(w - 2 * (i + j), h - 2 * (i + j)))
            clipRect(i + j, i + j, w - i - j, h - i - j) {
                val step = 8.dp.toPx(); val stripe = 3.dp.toPx()
                var x = -h
                while (x < w + h) {
                    val p = Path().apply { moveTo(x, h); lineTo(x + h, 0f); lineTo(x + h + stripe, 0f); lineTo(x + stripe, h); close() }
                    drawPath(p, AccountColors.devStripe)
                    x += step
                }
            }
        }
    }.padding(horizontal = 10.dp, vertical = 2.dp), contentAlignment = Alignment.Center) {
        PkwText(text, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
    }
}

/**
 * The gold-framed Well (SPEC §2.1 header well 84, §2.4 well 132, §4 portrait well): ink shell, a 3 dp gold ring, then a
 * dark `#2A2430` (or [light] parchment) inner face. Draws [content] centred.
 */
@Composable fun GoldWell(modifier: Modifier = Modifier, size: Dp = 84.dp, light: Boolean = false, content: @Composable BoxScope.() -> Unit) {
    val c = PkwTokens.Colors
    Box(modifier.size(size).drawBehind {
        val w = this.size.width; val h = this.size.height; val i = 3.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(c.gold.face); band(i, w - i, i, 3.dp.toPx(), c.gold.hi) }
        val j = 7.dp.toPx()
        fillStepped(j, j, w - j, h - j, CornerProfiles.S, if (light) HubColors.wellLight else HubColors.wellDark)
    }, contentAlignment = Alignment.Center, content = content)
}

/**
 * A realm thumbnail (SPEC §2.2 RealmCard thumb 48 × 52, crests 24): the mapper's bitmap from the realm atlas, covering the
 * box at a whole number of device pixels per image pixel, nearest sampled, centred and clipped. With no bitmap (atlas
 * not loaded yet) a stone square with the map icon stands in: honest, never an invented picture.
 */
@Composable fun RealmThumb(thumb: ImageBitmap?, description: String, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    if (thumb == null) {
        Box(modifier.clearAndSetSemantics { contentDescription = description }.background(c.ink).padding(2.dp).background(c.stone.mid),
            contentAlignment = Alignment.Center) { PkwIcon("map", 24.dp, alpha = 0.7f) }
        return
    }
    Canvas(modifier.clipToBounds().clearAndSetSemantics { contentDescription = description }) {
        val k = maxOf(1, ceil(maxOf(size.width / thumb.width, size.height / thumb.height)).toInt())
        val w = thumb.width * k; val h = thumb.height * k
        drawImage(thumb, srcOffset = IntOffset.Zero, srcSize = IntSize(thumb.width, thumb.height),
            dstOffset = IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), dstSize = IntSize(w, h),
            filterQuality = FilterQuality.None)
        val r = 2.dp.toPx()
        drawRect(c.ink, Offset.Zero, Size(size.width, r)); drawRect(c.ink, Offset(0f, size.height - r), Size(size.width, r))
        drawRect(c.ink, Offset.Zero, Size(r, size.height)); drawRect(c.ink, Offset(size.width - r, 0f), Size(r, size.height))
    }
}

/**
 * A CreamCard column (SPEC §0 `CreamCard`): ink S shell with a 2 dp rim, [face] (cream by default) with a 3 dp lower band,
 * and an optional 3 dp [rim] colour inside (gold = selected / you, green = ready / entered, blood = lost deed). With
 * [onClick] the whole card is one target (then it holds no other control) described by [description].
 */
@Composable fun AccountCard(
    modifier: Modifier = Modifier,
    rim: Color? = null,
    face: Color = PkwTokens.Colors.cream,
    minHeight: Dp = 48.dp,
    onClick: (() -> Unit)? = null,
    description: String? = null,
    contentPadding: Dp = 8.dp,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = PkwTokens.Colors
    val tap = if (onClick == null) Modifier else Modifier
        .clearAndSetSemantics {
            if (description != null) contentDescription = description
            role = Role.Button
            this.onClick(label = null, action = { onClick(); true })
        }
        .clickable(role = Role.Button, onClick = onClick)
    Column(modifier.heightIn(min = maxOf(minHeight, if (onClick != null) PkwTokens.Dims.minTap else 0.dp)).then(tap).drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(face)
            band(i, w - i, h - i - 3.dp.toPx(), 3.dp.toPx(), c.creamLo)
            if (rim != null) {
                val r = 3.dp.toPx()
                drawRect(rim, Offset(i, i), Size(w - 2 * i, r))
                drawRect(rim, Offset(i, h - i - r), Size(w - 2 * i, r))
                drawRect(rim, Offset(i, i), Size(r, h - 2 * i))
                drawRect(rim, Offset(w - i - r, i), Size(r, h - 2 * i))
            }
        }
    }.padding(contentPadding), horizontalAlignment = horizontalAlignment, verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
}

/** A VT 18 note on parchment (the SPEC's grey explainer lines). */
@Composable fun NoteLine(text: String, modifier: Modifier = Modifier, maxLines: Int = 3) {
    PkwText(text, PkwTokens.Type.small, modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, maxLines = maxLines)
}

/** A padlock + VT 18 word ("captain"): why a tool is not this player's. Paint only. */
@Composable fun LockNote(text: String, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
        PkwText(text, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

/** A light Well with a PS letter (G, X, @): the stand-in for brand marks we do not have (SPEC §4.3 Assets). */
@Composable fun LetterWell(letter: String, modifier: Modifier = Modifier, size: Dp = 48.dp) {
    Box(modifier.size(size).background(HubColors.wellLightBorder).padding(2.dp).background(HubColors.wellLight), contentAlignment = Alignment.Center) {
        PkwText(letter, PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch)
    }
}

/** The small square online dot on a portrait's corner (SPEC §5.1). Paint only. */
@Composable fun OnlineDot(modifier: Modifier = Modifier) {
    Box(modifier.size(12.dp).background(PkwTokens.Colors.ink).padding(2.dp).background(AccountColors.online))
}

/** A count badge for tabs and rows, or null for ≤ 0. */
internal fun countBadge(count: Int?, what: String): BadgeUi? =
    if (count == null || count <= 0) null else BadgeUi(if (count > 99) "99+" else "$count", BadgeTone.COUNT, "$count $what")

@Preview(name = "Account parts", widthDp = 412, heightDp = 420)
@Composable private fun AccountPartsPreview() {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.wood).padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StackedTabs(sampleProfileTabs, "WALLET", {})
        Column(Modifier.fillMaxWidth().background(PkwTokens.Colors.parchment).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                DevTag(); DevTag(text = "DEVNET PRICE"); LetterWell("G"); OnlineDot()
                GoldWell(size = 64.dp) { HubArt("ui_portrait_keep_t3", 48.dp) }
                RealmThumb(null, "Crownlands", Modifier.size(48.dp, 52.dp))
            }
            AccountCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.gold.face) { PkwText("A gold-rimmed card", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch) }
            LockNote("captain")
            NoteLine("Switching changes which base you see and give orders to.")
        }
    }
}
