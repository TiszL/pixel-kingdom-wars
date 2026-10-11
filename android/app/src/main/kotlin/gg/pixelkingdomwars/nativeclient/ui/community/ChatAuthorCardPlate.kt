@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.data.ChatCardState
import gg.pixelkingdomwars.nativeclient.data.ChatCardView
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import kotlinx.coroutines.delay

/** The player card: a small plate at the foot of the chat frame, over a scrim that closes it. It shows who the
 * message says they are, three facts and that message's own MENTION / REPORT / BLOCK — and nothing else: no
 * wallet, no place, no raid or scout, no presence (owner: "do not overdo it"). It opens at once with the name and
 * avatar the message already has; the facts arrive, or one line says they did not. The actions stay either way
 * ([chatCardBody]): they are the message's, not the card's. */
@Composable internal fun BoxScope.ChatAuthorCardPlate(view: ChatCardView, row: ChatRow, canMention: Boolean, frameHeight: Dp, now: () -> Long,
    avatar: @Composable (String, Dp) -> Unit, onAction: (ChatMessageAction) -> Unit, onRetry: () -> Unit, onDismiss: () -> Unit) {
    val state = view.state; val message = row.message
    val card = (state as? ChatCardState.Loaded)?.card
    Box(Modifier.matchParentSize().background(Palette.backdrop.copy(alpha = .72f)).semantics { contentDescription = "Close player profile" }
        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onDismiss))
    Column(Modifier.align(Alignment.BottomCenter).padding(8.dp).widthIn(max = CHAT_CARD_MAX_WIDTH).fillMaxWidth().heightIn(max = (frameHeight - 16.dp).coerceAtLeast(0.dp))
        .drawBehind { drawRect(Palette.ink, Offset(4.dp.toPx(), 4.dp.toPx()), size) }.background(Palette.surface).border(2.dp, Palette.borderLt)
        .drawWithContent {
            drawContent()
            val inset = 5.dp.toPx(); val rivet = 5.dp.toPx()
            drawRect(Palette.gold, Offset(inset, inset), Size(rivet, rivet)); drawRect(Palette.gold, Offset(size.width - inset - rivet, inset), Size(rivet, rivet))
        }
        // A tap on the plate's own surface must not fall through to the scrim under it and close the card.
        .blockSceneInput().pointerInput(Unit) { detectTapGestures { } }.semantics { paneTitle = "Player profile" }.verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().background(Palette.ink).padding(start = 14.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(CHAT_CARD_AVATAR).background(Palette.panel).border(2.dp, Palette.goldDp), contentAlignment = Alignment.Center) {
                Text(chatInitials(message.author.name), style = MaterialTheme.typography.bodySmall, color = Palette.goldHi)
                (if (card != null) card.avatarUrl else message.author.avatarUrl)?.let { avatar(it, CHAT_CARD_AVATAR) }
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (card?.seekerVerified ?: message.author.seekerVerified) Text("◈", style = MaterialTheme.typography.bodySmall, color = Palette.goldHi, modifier = Modifier.semantics { contentDescription = "Verified Seeker" })
                    // Always the name this message shows. The card answers with the same string (the repository
                    // holds it to that); a rename after sending appears nowhere.
                    Text(message.author.name, Modifier.semantics { heading() }, style = MaterialTheme.typography.bodyMedium, color = Palette.goldHi, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                card?.let(::chatCardClan)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            ChatIcon("Close player profile", onDismiss) { GameArt("close", Modifier.size(20.dp)) }
        }
        Box(Modifier.fillMaxWidth().height(2.dp).background(Palette.border))
        // A rate-limited card counts its named wait down; every other state is still.
        var nowMs by remember(state) { mutableLongStateOf(now()) }
        if (state is ChatCardState.RateLimited) LaunchedEffect(state) { while (state.untilMs != null && nowMs < state.untilMs) { delay(250); nowMs = now() } }
        val body = chatCardBody(state, row, canMention, nowMs) { fmtN(it.toLong()) }
        body.facts?.let { facts ->
            Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).semantics { if (card == null) contentDescription = "Loading profile" }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (fact in facts) Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
                    Text(fact.label, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = Palette.textFaint, maxLines = 1)
                    when {
                        fact.value == null -> Box(Modifier.size(52.dp, 8.dp).background(Palette.panel))
                        fact.value.isNotEmpty() -> {
                            if (fact.label == "TROPHIES") GameArt("trophy", Modifier.padding(end = 5.dp).size(13.dp))
                            Text(fact.value, style = MaterialTheme.typography.bodySmall, color = Palette.text, maxLines = 1)
                        }
                    }
                }
            }
        }
        body.note?.let { CardNote(it, retry = onRetry.takeIf { body.retry }, onDismiss) }
        // Under the facts and under the one line alike: a card that cannot be read still reports and blocks.
        if (body.actions.isNotEmpty()) FlowRow(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (action in body.actions) ChatMessageActionButton(action, message.author.name) { onAction(action) }
        }
    }
}
/** One line and CLOSE. TRY AGAIN appears only once a named wait has passed, and only the player presses it. */
@Composable private fun CardNote(line: String, retry: (() -> Unit)?, onDismiss: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (retry == null) Text(line, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
        else { ChatAction("Try loading the profile again", retry) { Text(line, fontSize = 14.sp, color = Palette.goldHi) }; Spacer(Modifier.weight(1f)) }
        ChatAction("Close player profile", onDismiss) { Text("CLOSE", fontSize = 14.sp, color = Palette.muted) }
    }
}
private val CHAT_CARD_AVATAR = 40.dp
private val CHAT_CARD_MAX_WIDTH = 360.dp
