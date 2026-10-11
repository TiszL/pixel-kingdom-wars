package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import kotlin.math.roundToInt

/**
 * Design component: the pictorial sheet tabs (DESIGN-SYSTEM §6 Tabs). Equal widths, 48 tall, 4 dp apart. The active tab
 * is parchment with ink-on-parchment text and no bottom rim, so it runs on into the panel below; inactive tabs are wood
 * with outlined text. Icon 24 dp (64 px art at 32 dp) + label; a badge sits outside the tab's corner; a locked tab shows a
 * padlock and still calls back so the caller can say why. Pressing drops a tab 2 dp. Each tab is its own ≥ 48 dp target;
 * the strip itself has no pointer handling.
 *
 * [compact] (the BUILD tray's six tabs at 412 dp, buildings/SPEC.md §3.1): the active tab is [activeTabWidth] wide with
 * icon + label; inactive tabs share the rest and draw their icon only (their label stays their screen-reader name).
 */
@Composable fun TabStrip(tabs: List<TabUi>, selected: String?, onSelect: (String) -> Unit, modifier: Modifier = Modifier,
    compact: Boolean = false, activeTabWidth: Dp = COMPACT_ACTIVE_TAB_W) {
    if (tabs.isEmpty()) return
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        tabs.forEach { tab ->
            val active = tab.id == selected
            val width = if (compact && active) Modifier.width(activeTabWidth) else Modifier.weight(1f)
            Tab(tab, active, { onSelect(tab.id) }, width, showLabel = !compact || active)
        }
    }
}

/** The compact strip's active tab width (buildings/SPEC.md §3.1: 146 dp). */
private val COMPACT_ACTIVE_TAB_W = 146.dp

@Composable private fun Tab(tab: TabUi, active: Boolean, onClick: () -> Unit, modifier: Modifier, showLabel: Boolean = true) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed) 1f else 0f, tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "tab")
    val spoken = listOfNotNull(tab.label, if (tab.locked) "locked" else null, tab.badge?.description).joinToString(", ")
    Box(modifier) {
        Box(Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.tabH).sceneInputRegion()
            .clearAndSetSemantics {
                contentDescription = spoken; role = Role.Tab; selected = active
                this.onClick(label = null, action = { onClick(); true })
            }
            .clickable(interactionSource = interaction, indication = null, role = Role.Tab, onClick = onClick)
            .offset { IntOffset(0, (2.dp.toPx() * press).roundToInt()) }
            .drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                if (active) {
                    // Ink rim on three sides; open at the bottom into the parchment panel.
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
                    PkwIcon(tab.icon, if (tab.icon.startsWith("ui:")) 32.dp else 24.dp, alpha = if (tab.locked) 0.5f else 1f)
                    if (tab.locked) PkwIcon("shape:lock", 16.dp, Modifier.align(Alignment.BottomEnd), tint = PkwTokens.Colors.gold.face)
                }
                if (showLabel) {
                    if (active) PkwText(tab.label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
                    else PkwText(tab.label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
                }
            }
        }
        if (tab.badge != null) Badge(tab.badge, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp))
    }
}

@Preview(name = "Tab strip", widthDp = 380, heightDp = 120)
@Composable private fun TabStripPreview() {
    Column(Modifier.background(PkwTokens.Colors.wood).padding(8.dp)) {
        TabStrip(listOf(
            TabUi("SMELT", "ui:ready-status", "SMELT", null, false),
            TabUi("CLAIM", "keep", "CLAIM", BadgeUi("!", BadgeTone.READY, "Ready to claim"), false),
            TabUi("GEMS", "gem", "GEMS", null, true),
        ), selected = "SMELT", onSelect = {})
        Box(Modifier.fillMaxWidth().height(40.dp).background(PkwTokens.Colors.parchment))
    }
}

@Preview(name = "Tab strip, compact (six tabs, icon-only inactive)", widthDp = 412, heightDp = 120)
@Composable private fun CompactTabStripPreview() {
    Column(Modifier.background(PkwTokens.Colors.wood).padding(8.dp)) {
        TabStrip(listOf(
            TabUi("BUILDINGS", "shape:hammer", "BUILDINGS", null, false),
            TabUi("DEFENCES", "shield", "DEFENCES", null, false),
            TabUi("TRAPS", "ui:queue-status", "TRAPS", BadgeUi("NEW", BadgeTone.REWARD, "New trap"), false),
            TabUi("HEROES", "ui:exp", "HEROES", null, true),
            TabUi("SUPPLIES", "ui:expedition-kit", "SUPPLIES", null, false),
            TabUi("LAYOUTS", "ui:navigation-kit", "LAYOUTS", null, false),
        ), selected = "BUILDINGS", onSelect = {}, compact = true)
        Box(Modifier.fillMaxWidth().height(40.dp).background(PkwTokens.Colors.parchment))
    }
}
