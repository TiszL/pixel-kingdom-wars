package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import kotlinx.coroutines.delay

/**
 * Design component: the chat peek (design/final/hub/chat-peek.png, SPEC §2.9 "Peek"): on Home only, while the drawer is
 * closed, a 280 × 58 charcoal plate beside the CHAT edge tab (x 54, aligned to the tab, y 759) with an 8 × 16 ink pointer
 * to the tab: crest 20, PS 11 gold-hi "MIRA · CLAN", one VT 20 line. Clan messages and @mentions only, never world chat
 * ([chatPeekAllowed]); 4 s; one at a time; a tap opens the drawer at that message. It never covers the MAIL or CHAT badges.
 */

/** One peek (SPEC §2.9 `ChatPeekUi`; fields after `text` were added). */
@Immutable data class ChatPeekUi(
    /** The author's 20 dp crest. */
    val crest: String,
    /** "MIRA". */
    val author: String,
    /** "CLAN" (never "WORLD"). */
    val channel: String,
    /** The message, one line with ellipsis. */
    val text: String,
    /** Identity of this peek: a new key restarts the 4 s hold. */
    val key: String = "$author:$text",
    /** The message the drawer scrolls to. */
    val messageId: String = key,
)

/**
 * The chat peek. Pass the peek to show, or null (it fades out 160 ms). Enter: slides 12 dp out of the tab + fade, 160 ms;
 * after 4 s it calls [onExpire] (the HUD mount sets it to null). A tap calls [onOpen] with the message id.
 *
 * Pointer rule: only the painted plate is a touch target (a scene-input region); the space around it reaches the
 * kingdom. Place it with the HUD (it is not full-screen).
 */
@Composable fun ChatPeek(ui: ChatPeekUi?, onOpen: (String) -> Unit, onExpire: () -> Unit, modifier: Modifier = Modifier) {
    val expire by rememberUpdatedState(onExpire)
    Presence(ui, PkwTokens.Motion.TOAST_IN, PkwTokens.Motion.TOAST_OUT) { peek, progress, active, reduced ->
        LaunchedEffect(peek.key) { delay(HubMotion.PEEK_HOLD.toLong()); expire() }
        val spoken = "${peek.author}, ${peek.channel}: ${peek.text}. Opens chat"
        Row(modifier.graphicsLayer {
            alpha = progress()
            translationX = if (reduced) 0f else -PkwTokens.Motion.TOAST_SLIDE_DP * density * (1f - progress())
        }, verticalAlignment = Alignment.CenterVertically) {
            // The 8 × 16 ink pointer to the CHAT tab.
            Canvas(Modifier.size(8.dp, 16.dp)) {
                drawPath(Path().apply { moveTo(size.width, 0f); lineTo(0f, size.height / 2f); lineTo(size.width, size.height); close() }, PkwTokens.Colors.ink)
            }
            Plate(PlateKind.CHARCOAL, Modifier.width(280.dp).heightIn(min = 58.dp)
                .clearAndSetSemantics {
                    contentDescription = spoken; role = Role.Button; liveRegion = LiveRegionMode.Polite
                    onClick(label = null, action = { if (active) onOpen(peek.messageId); true })
                }
                .clickable(role = Role.Button) { if (active) onOpen(peek.messageId) },
                contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 10.dp, bottom = 8.dp)) {
                Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    HubArt(peek.crest, 20.dp)
                    Column {
                        PkwText("${peek.author.uppercase()} · ${peek.channel.uppercase()}", PkwTokens.Type.caption, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                        PkwText(peek.text, PkwTokens.Type.body, color = PkwTokens.Colors.text)
                    }
                }
            }
        }
    }
}

@Preview(name = "Chat peek (chat-peek.png)", widthDp = 412, heightDp = 160)
@Composable private fun ChatPeekPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35)).padding(start = 46.dp, top = 40.dp)) {
        ChatPeek(ChatPeekUi("league-sol", "Mira", "CLAN", "@Rowan spot 142 is yours"), onOpen = {}, onExpire = {})
    }
}
