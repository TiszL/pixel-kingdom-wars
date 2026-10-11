package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.onParchment
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import androidx.compose.ui.unit.Dp
import java.math.BigInteger

/* Shared plate chrome for the wallet, market and deposit pages (web menu.tsx Chip / Phead / Btn tabs).
 * Every piece is drawn on the forged HUD kit; nothing here is a Material default. */

/** Web ScrollPage `tabs`: gold Btn for the selected tab, ghost for the rest — here a gold plate versus a sunk tab plate. */
@Composable internal fun <T> PlateTabs(tabs: List<Pair<T, String>>, selected: T, modifier: Modifier = Modifier, enabled: Boolean = true, onSelect: (T) -> Unit) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        tabs.forEach { (key, label) ->
            val active = key == selected
            PixelPlate(if (active) "gold" else "tab-sunk", Modifier.weight(1f).heightIn(min = 44.dp).alpha(if (enabled) 1f else .5f)
                .semantics { this.selected = active }.clickable(enabled = enabled, role = Role.Tab, interactionSource = remember { MutableInteractionSource() }, indication = null) { onSelect(key) },
                PaddingValues(horizontal = 6.dp, vertical = 7.dp)) {
                Text(label, Modifier.fillMaxWidth(), color = if (active) Palette.ink else SurfaceInk.muted, style = MaterialTheme.typography.labelMedium,
                    textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Web Chip link row: icon, label, optional value, and the gold chevron when it navigates. */
@Composable internal fun PlateRow(label: String, art: String, modifier: Modifier = Modifier, value: String? = null, note: String? = null,
    enabled: Boolean = true, accent: Boolean = false, onClick: (() -> Unit)? = null) {
    PixelPlate("shard", modifier.fillMaxWidth().heightIn(min = 48.dp).alpha(if (enabled) 1f else .55f)
        .then(if (onClick != null) Modifier.clickable(enabled = enabled, role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick) else Modifier),
        PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GameArt(art, Modifier.size(22.dp))
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.bodyMedium, color = if (accent) SurfaceInk.goldHi else SurfaceInk.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            value?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = SurfaceInk.goldHi, maxLines = 1) }
            if (onClick != null) Text("›", color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleMedium)
        }
    }
}

/** HUD resource chip (web wallet.tsx balance Chip): icon, small label, one-line value on the shard or keep plate. */
@Composable internal fun HudChip(art: String, label: String, value: String, modifier: Modifier = Modifier, kind: String = "shard",
    note: String? = null, valueColor: Color = SurfaceInk.goldHi) {
    PixelPlate(kind, modifier.heightIn(min = 52.dp).semantics(mergeDescendants = true) { contentDescription = "$label $value" }, PaddingValues(horizontal = 10.dp, vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GameArt(art, Modifier.size(22.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            Text(value, style = MaterialTheme.typography.titleMedium, color = valueColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Web Panel9 section: riveted panel, gold title bar with an optional note or an X that the caller owns. */
@Composable internal fun TitledPlate(title: String, modifier: Modifier = Modifier, note: String? = null, gold: Boolean = false,
    art: String? = null, onDismiss: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    PixelPanel(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 6.dp, top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            art?.let { GameArt(it, Modifier.size(20.dp)) }
            Text(title, Modifier.weight(1f), color = if (gold) SurfaceInk.goldHi else SurfaceInk.gold,
                style = if (gold) MaterialTheme.typography.titleSmall else MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            note?.let { Text(it, color = SurfaceInk.faint, style = MaterialTheme.typography.labelSmall, maxLines = 1) }
            onDismiss?.let { dismiss ->
                Box(Modifier.size(36.dp).semantics { contentDescription = "Hide $title" }
                    .clickable(role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss), contentAlignment = Alignment.Center) {
                    CloseGlyph(18.dp)
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

/** Web `<details><summary>` on a tab plate: the chevron is the only state cue, so it is also announced. */
@Composable internal fun DisclosurePlate(title: String, open: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PixelPlate(if (open) "tab" else "tab-sunk", Modifier.fillMaxWidth().heightIn(min = 44.dp)
            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
            .clickable(role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onToggle), PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), color = SurfaceInk.goldHi, style = MaterialTheme.typography.labelMedium)
                Text(if (open) "▾" else "▸", color = if (open) SurfaceInk.gold else SurfaceInk.faint, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (open) content()
    }
}

/** Web empty-state line: centred faint copy on a plate rather than bare text on the backdrop. */
@Composable internal fun EmptyPlate(text: String, modifier: Modifier = Modifier) {
    PixelPlate("shard", modifier.fillMaxWidth(), PaddingValues(12.dp)) {
        Text(text, Modifier.fillMaxWidth(), color = SurfaceInk.faint, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
}

/** A notice the player can put away. Dismissal is per message: a new message shows again. Errors stay red. */
/** A notice the player can close. `onDismiss` clears the owning state so the message does not return on the next
 * recomposition; without it the plate only hides locally for this message. */
@Composable internal fun DismissableNotice(message: String, error: Boolean = false, onDismiss: (() -> Unit)? = null) {
    var hidden by remember(message) { mutableStateOf(false) }
    if (hidden) return
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Box(Modifier.weight(1f)) { Notice(message, error) }
        Box(Modifier.size(40.dp).semantics { contentDescription = "Dismiss notice" }
            .clickable(role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null) { hidden = true; onDismiss?.invoke() }, contentAlignment = Alignment.Center) {
            CloseGlyph(16.dp)
        }
    }
}

/** A plate's small dismiss mark: the bitmap X on a dark plate, the kit close glyph in brown ink on the parchment. */
@Composable private fun CloseGlyph(size: Dp) {
    if (onParchment()) PkwIcon("shape:close", size, tint = PkwTokens.Colors.textOnParch2) else GameArt("close", Modifier.size(size))
}

/** Catalogue item art by its `asset` name (web MarketItemArt); the bag glyph stands in for an item with no art. */
@Composable internal fun ItemArt(asset: String?, modifier: Modifier = Modifier, description: String? = null) {
    GameArt(asset ?: "bag", modifier, description)
}

/** Web market listing tag: AT FLOOR / +N% OVER / YOUR LISTING. The one number that decides a purchase is
 * whether this unit is the cheapest of its item, so it is computed here, deterministically, from the server's
 * whole-book floor — never from the visible slice. */
internal data class FloorTag(val text: String, val atFloor: Boolean)
internal fun marketFloorTag(priceLamports: String, floorLamports: String?, mine: Boolean): FloorTag {
    if (mine) return FloorTag("YOUR LISTING", false)
    val price = BigInteger(priceLamports)
    val floor = floorLamports?.let(::BigInteger)?.takeIf { it.signum() > 0 } ?: return FloorTag("AT FLOOR", true)
    if (price <= floor) return FloorTag("AT FLOOR", true)
    val over = (price - floor).multiply(BigInteger.valueOf(100)).add(floor.shiftRight(1)).divide(floor)
    return FloorTag("+$over% OVER", false)
}

/** The deposit page's ON-CHAIN KEEP row reads the same server field the wallet page lists (`/wallet/balances`
 * tokens, symbol KEEP). Null = that read has not answered; "UNAVAILABLE" = the server answered null for KEEP,
 * which is a failed cluster read, never an empty wallet (walletBalances.ts shape discipline). */
internal fun onChainKeep(funds: WalletFunds?): String? {
    funds ?: return null
    val entry = funds.tokens.entries.firstOrNull { it.key.equals("KEEP", ignoreCase = true) } ?: return "UNAVAILABLE"
    return entry.value ?: "UNAVAILABLE"
}

/** Web DepositScreen +100 / +1K shortcuts: whole-KEEP addition that refuses to leave the catalogue bound. */
internal fun keepDepositShortcut(current: String, delta: Long, maximum: BigInteger): String? {
    val base = current.replace(Regex("[\\s,]"), "").ifEmpty { "0" }
    if (!base.matches(Regex("[0-9]+"))) return null
    val next = BigInteger(base).add(BigInteger.valueOf(delta))
    return if (next.signum() > 0 && next <= maximum) next.toString() else null
}
