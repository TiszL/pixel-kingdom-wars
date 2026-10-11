package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.TabStrip
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the Chat drawer (design/final/hub/chat.png, SPEC §2.9). Destination: `Chat(tab)` (DRAWER: left, 88 %
 * wide, the world live under a 40 % scrim). Tabs WORLD · CLAN with unread badges (CLAN locked with its reason while clan
 * chat does not exist: chat is GLOBAL); a bottom-anchored thread (newest next
 * to the composer); day dividers, messages (own right-aligned with a gold rim, @mentions with a gold left bar), system
 * lines, shared places with GO, emotes; the composer (emote, text field, the one gold SEND) or the blocked strip.
 */

/** One thread item. */
sealed interface ChatItemUi {
    /** Stable id (lazy key; long-press / retry hand it back). */
    val id: String

    /** A day divider ("Today"). */
    @Immutable data class Day(override val id: String, val label: String) : ChatItemUi

    /** A message: crest 20 + name + clan tag + time, then the bubble. */
    @Immutable data class Message(
        override val id: String,
        val author: String,
        val crest: String,
        /** "[IRN]"; null draws none. */
        val tag: String?,
        val time: String,
        val text: String,
        /** The player's own: right-aligned, gold rim. */
        val mine: Boolean,
        /** Mentions the player: gold left bar; [mentionHandle] drawn in `#8A5A12`. */
        val mentionsMe: Boolean,
        /** "@Rowan" as it appears in [text]. */
        val mentionHandle: String? = null,
        /** Sending failed: red "!" badge + "Tap to retry". */
        val failed: Boolean = false,
    ) : ChatItemUi

    /** A centred system line: stone for battles ("MIRA WON A RAID · +24"), blue for clan events ("HARROWGATE JOINED"). */
    @Immutable data class System(override val id: String, val icon: String?, val text: String, val tone: Verb) : ChatItemUi

    /** A shared place: CardRow 60 in the thread + GO. */
    @Immutable data class Place(
        override val id: String,
        val author: String,
        val crest: String,
        val icon: String,
        /** "Spot 142". */
        val title: String,
        /** "Seeker Island · live". */
        val sub: String,
        val destination: HubLink,
    ) : ChatItemUi

    /** An emote (`ui_emote_*` at 36 in a cream bubble). */
    @Immutable data class Emote(override val id: String, val author: String, val crest: String, val time: String, val emote: String,
        val mine: Boolean) : ChatItemUi
}

/** Everything the Chat drawer draws (SPEC §2.9 State; fields after `sending` were added with defaults). */
@Immutable data class ChatUi(
    /** "WORLD" or "CLAN". */
    val tab: String,
    /** Unread per tab id (tab badges). */
    val unread: Map<String, Int>,
    /** Oldest first; drawn bottom-anchored. */
    val items: List<ChatItemUi>,
    val draft: String,
    /** The server allows sending on this tab. */
    val canSend: Boolean,
    /** Non-null: the composer is replaced by this reason ("Set a username first" / "Clans need land" / "Chat is paused"). */
    val blockedReason: String?,
    /** SEND is in flight (dots). */
    val sending: Boolean,
    /** The blocked strip's blue action label ("SET USERNAME", "GET LAND"); null draws none. */
    val blockedAction: String? = null,
    val blockedLink: HubLink? = null,
    /** Chat (it is GLOBAL) is switched off: EmptyState [CHAT_PAUSED_TITLE] (no button). */
    val paused: Boolean = false,
    /** The emote strip above the composer is open. */
    val emotesOpen: Boolean = false,
    /** The six authored emotes. */
    val emotes: List<String> = listOf("ui_emote_gg", "ui_emote_salute", "ui_emote_laugh", "ui_emote_nicewalls", "ui_emote_ouch", "ui_emote_revenge"),
    /** Clan chat does not exist yet, so by default the CLAN tab is locked (padlock) and, when picked, this reason replaces
     *  its composer ([chatBlockedReason]). Null only once the server has a clan channel. */
    val clanLockedReason: String? = CLAN_CHAT_LOCKED,
)

/** Chat callbacks. */
@Immutable data class ChatActions(
    val onTab: (String) -> Unit = {},
    val onDraft: (String) -> Unit = {},
    val onSend: () -> Unit = {},
    val onToggleEmotes: () -> Unit = {},
    val onEmote: (String) -> Unit = {},
    /** A shared place's GO. */
    val onGo: (HubLink) -> Unit = {},
    /** Long-press a message: the existing COPY · REPORT · BLOCK half sheet. */
    val onLongPress: (String) -> Unit = {},
    /** Tap a failed own message. */
    val onRetry: (String) -> Unit = {},
    val onBlockedAction: (HubLink) -> Unit = {},
    /** Close: the X, a scrim tap, a left swipe past 30 %, and Back. */
    val onClose: () -> Unit = {},
)

/**
 * The Chat drawer. Pass the drawer to show, or null (it slides out: in 220 ms `out`, out 160 ms `in`; the scrim fades with
 * it). A swipe left of more than 30 % of its width closes it.
 *
 * Pointer rule: the root Box has no pointer handling of its own; its 40 % scrim is composed only while the drawer is
 * shown (a DRAWER is modal, arch §4.1) and a tap on it closes the drawer. The panel is a painted plate.
 */
@Composable fun ChatDrawer(ui: ChatUi?, on: ChatActions, modifier: Modifier = Modifier) {
    val close by rememberUpdatedState(on.onClose)
    Presence(ui, PkwTokens.Motion.SHEET_IN, PkwTokens.Motion.SHEET_OUT) { chat, progress, active, reduced ->
        var drag by remember { mutableFloatStateOf(0f) }
        var widthPx by remember { mutableIntStateOf(0) }
        Box(modifier.fillMaxSize()) {
            ModalScrim(PkwTokens.Scrim.SHEET_TALL * progress(), onTap = { if (active) close() })
            Box(Modifier.fillMaxHeight().fillMaxWidth(0.88f).padding(top = 8.dp, bottom = 14.dp)
                .onSizeChanged { widthPx = it.width }
                .graphicsLayer {
                    val p = progress()
                    translationX = drag + if (reduced) 0f else -(1f - p) * size.width
                    alpha = if (reduced) p else 1f
                }
                .semantics { paneTitle = "Chat" }
                .draggable(rememberDraggableState { delta -> drag = (drag + delta).coerceAtMost(0f) }, Orientation.Horizontal,
                    enabled = active, onDragStopped = {
                        if (drawerSwipeCloses(drag, widthPx.toFloat())) close()
                        else animate(drag, 0f, animationSpec = tween(PkwTokens.Motion.RELEASE)) { value, _ -> drag = value }
                    })) {
                Plate(PlateKind.WOOD, Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp)) {
                    DrawerContent(chat, on)
                }
            }
        }
    }
}

@Composable private fun DrawerContent(ui: ChatUi, on: ChatActions) {
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TabStrip(chatTabs(ui), ui.tab, on.onTab, Modifier.weight(1f))
            CloseSquare(on.onClose, contentDescription = "Close chat")
        }
        Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f), blocksScene = false) {
            Column(Modifier.fillMaxSize()) {
                if (ui.paused) Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    HubEmptyState(CHAT_PAUSED_TITLE, CHAT_PAUSED_LINE, icon = "map")
                } else LazyColumn(Modifier.fillMaxWidth().weight(1f), reverseLayout = true, verticalArrangement = Arrangement.spacedBy(6.dp),
                    contentPadding = PaddingValues(vertical = 6.dp)) {
                    items(ui.items.asReversed(), key = { it.id }) { item -> ChatItem(item, on) }
                }
                if (ui.emotesOpen && chatBlockedReason(ui) == null) Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    ui.emotes.forEach { emote ->
                        ChunkyBox(PkwTokens.Colors.stone, { on.onEmote(emote) }, "Send emote ${emote.removePrefix("ui_emote_")}", Modifier.size(48.dp)) {
                            HubArt(emote, 36.dp)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                // A locked CLAN tab says why, with no action; otherwise the server's own reason and its action.
                val clanLocked = ui.clanLockedReason?.takeIf { ui.tab == CHAT_CLAN }
                val blocked = ui.blockedReason
                if (clanLocked != null) BlockedStrip(clanLocked, null, null, on)
                else if (blocked != null) BlockedStrip(blocked, ui.blockedAction, ui.blockedLink, on) else Composer(ui, on)
            }
        }
    }
}

@Composable private fun Composer(ui: ChatUi, on: ChatActions) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ChunkyBox(PkwTokens.Colors.stone, on.onToggleEmotes, if (ui.emotesOpen) "Hide emotes" else "Emotes", Modifier.size(52.dp, 56.dp)) {
            HubArt("ui_emote_salute", 36.dp)
        }
        HubTextField(ui.draft, on.onDraft, "Message", Modifier.weight(1f),
            placeholder = if (ui.tab == CHAT_CLAN) "Message your clan" else "Message world chat", enabled = !ui.sending)
        val canSend = chatCanSend(ui)
        ChunkyBox(PkwTokens.ramp(if (canSend || ui.sending) Verb.GOLD else Verb.OFF), on.onSend, if (ui.sending) "Sending" else "Send",
            Modifier.size(76.dp, 56.dp), enabled = canSend) {
            if (ui.sending) BusyDots() else PkwText("SEND", PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

@Composable private fun BlockedStrip(reason: String, action: String?, link: HubLink?, on: ChatActions) {
    Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 56.dp), blocksScene = false) {
        Row(Modifier.fillMaxWidth().align(Alignment.Center).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText(reason, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
            if (action != null && link != null) SecondaryButton(action, { on.onBlockedAction(link) }, verb = Verb.BLUE)
        }
    }
}

@Composable private fun ChatItem(item: ChatItemUi, on: ChatActions) {
    when (item) {
        is ChatItemUi.Day -> PkwText(item.label, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(vertical = 4.dp), color = HubColors.dayDivider,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        is ChatItemUi.System -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            StatusTag(item.text, item.tone, Modifier.semantics { contentDescription = item.text }, tall = true, icon = item.icon)
        }
        is ChatItemUi.Message -> MessageItem(item, on)
        is ChatItemUi.Place -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            AuthorLine(item.crest, item.author, null, null, mine = false, note = "shared a place")
            Bubble(mine = false, mention = false, modifier = Modifier.widthIn(max = 290.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Well(item.icon)
                    Column(Modifier.weight(1f)) {
                        PkwText(item.title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                        PkwText(item.sub, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    }
                    GoButton({ on.onGo(item.destination) }, contentDescription = "Go to ${item.title}, ${item.sub}", modifier = Modifier.width(58.dp))
                }
            }
        }
        is ChatItemUi.Emote -> Column(Modifier.fillMaxWidth(), horizontalAlignment = if (item.mine) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(3.dp)) {
            AuthorLine(item.crest, item.author, null, item.time, item.mine)
            Bubble(mine = item.mine, mention = false, modifier = Modifier.clearAndSetSemantics { contentDescription = "${item.author}: emote ${item.emote.removePrefix("ui_emote_")}" }) {
                HubArt(item.emote, 36.dp)
            }
        }
    }
}

@Composable private fun MessageItem(item: ChatItemUi.Message, on: ChatActions) {
    val spoken = listOfNotNull(item.author, item.tag, item.time, item.text, if (item.failed) "not sent, tap to retry" else null).joinToString(", ")
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (item.mine) Alignment.End else Alignment.Start, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        AuthorLine(item.crest, item.author, item.tag, item.time, item.mine)
        Box {
            Bubble(item.mine, item.mentionsMe, Modifier.widthIn(max = 290.dp).heightIn(min = PkwTokens.Dims.minTap)
                .clearAndSetSemantics {
                    contentDescription = spoken
                    onLongClick(label = "Message options", action = { on.onLongPress(item.id); true })
                    if (item.failed) onClick(label = "Retry", action = { on.onRetry(item.id); true })
                }
                .pointerInput(item.id, item.failed) {
                    detectTapGestures(onLongPress = { on.onLongPress(item.id) }, onTap = { if (item.failed) on.onRetry(item.id) })
                }) {
                val handle = item.mentionHandle
                val text = buildAnnotatedString {
                    val at = if (handle != null) item.text.indexOf(handle) else -1
                    if (handle == null || at < 0) append(item.text)
                    else {
                        append(item.text.substring(0, at))
                        withStyle(SpanStyle(color = HubColors.mention)) { append(handle) }
                        append(item.text.substring(at + handle.length))
                    }
                }
                Text(text, style = PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
            }
            if (item.failed) Badge(BadgeUi("!", BadgeTone.COUNT, "Not sent"), Modifier.align(Alignment.TopStart).padding(start = 0.dp))
        }
        if (item.failed) PkwText("Tap to retry", PkwTokens.Type.small, color = PkwTokens.Colors.danger)
    }
}

/** Crest 20 + PS 11 name + VT 18 clan tag + VT 18 time (or a note like "shared a place"). */
@Composable private fun AuthorLine(crest: String, author: String, tag: String?, time: String?, mine: Boolean, note: String? = null) {
    Row(Modifier.clearAndSetSemantics { }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        HubArt(crest, 20.dp)
        PkwText(author, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        tag?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
        note?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
        time?.let { PkwText(it, PkwTokens.Type.small, color = HubColors.dayDivider) }
        if (mine) Spacer(Modifier.width(2.dp))
    }
}

/** The bubble: ink S shell, cream, VT 20. Own: `#FFF3C8` with a 3 dp gold rim. @mention: `#FFF3C8` with a 4 dp gold left bar. */
@Composable private fun Bubble(mine: Boolean, mention: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = PkwTokens.Colors
    Box(modifier.drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(if (mine || mention) c.selectedTint else c.cream)
            if (mine) {
                val r = 3.dp.toPx()
                drawRect(c.gold.face, Offset(i, i), Size(w - 2 * i, r)); drawRect(c.gold.face, Offset(i, h - i - r), Size(w - 2 * i, r))
                drawRect(c.gold.face, Offset(i, i), Size(r, h - 2 * i)); drawRect(c.gold.face, Offset(w - i - r, i), Size(r, h - 2 * i))
            } else if (mention) drawRect(c.gold.face, Offset(i, i), Size(4.dp.toPx(), h - 2 * i))
        }
    }.padding(start = if (mention) 14.dp else 12.dp, end = 12.dp, top = 8.dp, bottom = 9.dp)) { content() }
}

// ---- Previews (chat.png numbers) ----

internal val sampleChat = ChatUi(
    tab = CHAT_CLAN, unread = mapOf("WORLD" to 0, "CLAN" to 0),
    items = listOf(
        ChatItemUi.Day("d1", "Today"),
        ChatItemUi.Message("m1", "Old Bramble", "league-silver", "[IRN]", "13:52", "Chest is at 42. Two raids each and we fill it.", false, false),
        ChatItemUi.Message("m2", "Seraphine", "league-gold", "[IRN]", "14:01", "Anyone else bidding on the Seeker spots tonight?", false, false),
        ChatItemUi.System("s1", "attack", "MIRA WON A RAID · +24", Verb.STONE),
        ChatItemUi.Message("m3", "Mira", "league-sol", "[IRN]", "14:03", "@Rowan spot 142 is yours to take, I am out", false, true, "@Rowan"),
        ChatItemUi.Place("p1", "Mira", "league-sol", "ui:seeker-navigation", "Spot 142", "Seeker Island · live", sampleLink("island.seeker")),
        ChatItemUi.Message("m4", "Rowan", "league-gold", "[IRN]", "14:04", "On it. Raising to 150 now.", true, false),
        ChatItemUi.Emote("e1", "Old Bramble", "league-silver", "14:05", "ui_emote_salute", false),
        ChatItemUi.System("s2", "itm_banner", "HARROWGATE JOINED", Verb.BLUE),
    ),
    // chat.png draws the clan channel the design expects; live chat leaves CLAN locked until it exists.
    draft = "", canSend = true, blockedReason = null, sending = false, clanLockedReason = null,
)

@Preview(name = "Chat: CLAN locked (clan chat does not exist yet)", widthDp = 412, heightDp = 915)
@Composable private fun ChatClanLockedPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        ChatDrawer(sampleChat.copy(items = emptyList(), clanLockedReason = CLAN_CHAT_LOCKED), ChatActions())
    }
}

@Preview(name = "Chat drawer (chat.png)", widthDp = 412, heightDp = 915)
@Composable private fun ChatDrawerPreview() { Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) { ChatDrawer(sampleChat, ChatActions()) } }

@Preview(name = "Chat: blocked (needs land), emotes open", widthDp = 412, heightDp = 915)
@Composable private fun ChatBlockedPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        ChatDrawer(sampleChat.copy(blockedReason = "Clans need land", blockedAction = "GET LAND", blockedLink = sampleLink("profile.land")), ChatActions())
    }
}

@Preview(name = "Chat: world paused, sending, failed", widthDp = 412, heightDp = 915)
@Composable private fun ChatPausedPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        ChatDrawer(sampleChat.copy(tab = CHAT_WORLD, paused = true, draft = "gg", sending = true), ChatActions())
    }
}

@Preview(name = "Chat: failed own message, emote strip", widthDp = 412, heightDp = 915)
@Composable private fun ChatFailedPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A))) {
        ChatDrawer(sampleChat.copy(emotesOpen = true, draft = "brb",
            items = sampleChat.items + ChatItemUi.Message("m5", "Rowan", "league-gold", "[IRN]", "14:06", "brb, wall upgrade", true, false, failed = true)), ChatActions())
    }
}
