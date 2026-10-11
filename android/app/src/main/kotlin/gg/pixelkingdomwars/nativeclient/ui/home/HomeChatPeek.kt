package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.ChatLauncherState
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatPeek
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatPeekUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.chatPeekAllowed

/*
 * The Home chat peek (hub SPEC §2.9 "Peek", chat-peek.png): while the drawer is closed, a message that @mentions the
 * player shows for 4 s beside the CHAT edge tab, one at a time, and a tap opens the drawer at that message.
 *
 * Never world chat: the server has one channel (GLOBAL) and a peek for every global line would be a world-chat ticker,
 * which the SPEC forbids. Only the server's own mention bit raises a peek, and it is labelled as a mention of the player,
 * never as a channel. The closed launcher keeps only opaque ids and that bit (web parity), so a peek has text only when
 * the open reader already holds the message; otherwise there is no peek (the CHAT tab's @ badge still says it).
 */

/** The peek's channel label: the line is here because it mentions the player, not because of where it was said. */
internal const val CHAT_PEEK_CHANNEL = "@YOU"
/** Public chat carries no author crest; the drawer draws the same one. */
internal const val CHAT_PEEK_CREST = "shape:chat"

/** The next peek, or null: the oldest unread @mention whose text is known and that has not peeked yet. Nothing while
 *  the drawer is open or chat is off for this account. */
internal fun homeChatPeekUi(state: ChatState, launcher: ChatLauncherState, shownIds: Set<String>): ChatPeekUi? {
    if (launcher.open || !launcher.enabled || !chatPeekAllowed(CHAT_PEEK_CHANNEL, mentionsMe = true, drawerOpen = launcher.open)) return null
    val waiting = launcher.unreadMessages.filter { (id, mention) -> mention && id !in shownIds }.keys
    // Another player's line only: the viewer's own messages are the ones they cannot block.
    val message = state.messages.filter { it.id in waiting && it.canBlock }.minByOrNull { it.id.toBigInteger() } ?: return null
    return ChatPeekUi(CHAT_PEEK_CREST, message.author.name, CHAT_PEEK_CHANNEL, message.text.replace(Regex("\\s+"), " ").trim(),
        key = "mention:${message.id}", messageId = message.id)
}

/** The ids that have peeked, plus [id]. Only ids still unread are kept: the rest can never peek again (the launcher only
 *  ever adds newer ids), so the set stays as small as the launcher's own bounded map. */
internal fun homeChatPeekShown(shownIds: Set<String>, launcher: ChatLauncherState, id: String): Set<String> =
    shownIds.filterTo(HashSet()) { it in launcher.unreadMessages } + id

/** SPEC §2.9: the plate starts at x 54 with its 8 dp ink pointer just before it, touching the 44 dp CHAT tab. */
private const val CHAT_PEEK_START = HudGeometry.TAB_W + 2
private const val CHAT_PEEK_H = 58
/** Centred on the CHAT tab, the lowest left tab, whose foot is TABS_BOTTOM above the safe bottom. */
private const val CHAT_PEEK_BOTTOM = HudGeometry.TABS_BOTTOM - (CHAT_PEEK_H - HudGeometry.TAB_H) / 2

/**
 * The peek layer for the Home world view. It holds which messages have peeked (so none repeats) and shows one at a time;
 * [enabled] false (the drawer open, chat off, not Home) puts the showing peek away. A tap hands [onOpen] the message id.
 *
 * Pointer rule: the root is a plain full-size layout with no pointer handling; only the painted peek plate takes touches.
 */
@Composable internal fun HomeChatPeekLayer(session: SessionGraph, enabled: Boolean, onOpen: (messageId: String) -> Unit, modifier: Modifier = Modifier) {
    val state by session.chat.state.collectAsState()
    val launcher by session.chat.launcher.collectAsState()
    var shownIds by remember(session) { mutableStateOf(emptySet<String>()) }
    var showing by remember(session) { mutableStateOf<ChatPeekUi?>(null) }
    val next = if (enabled) homeChatPeekUi(state, launcher, shownIds) else null
    LaunchedEffect(enabled, next?.messageId, showing == null) {
        if (!enabled) { showing = null; return@LaunchedEffect }
        if (showing == null && next != null) { showing = next; shownIds = homeChatPeekShown(shownIds, launcher, next.messageId) }
    }
    Box(modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        ChatPeek(showing.takeIf { enabled }, onOpen = { id -> showing = null; onOpen(id) }, onExpire = { showing = null },
            modifier = Modifier.align(Alignment.BottomStart).padding(start = CHAT_PEEK_START.dp, bottom = CHAT_PEEK_BOTTOM.dp))
    }
}
