package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.chrome.pageInsets
import android.graphics.BitmapFactory
import android.icu.text.BreakIterator
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.ChatAuthorCards
import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.data.ChatState
import gg.pixelkingdomwars.nativeclient.data.ProfileBounds
import gg.pixelkingdomwars.nativeclient.data.LiveChatRepository
import gg.pixelkingdomwars.nativeclient.model.ChatMessage
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.PkwType
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CHAT_WORLD
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatDrawer
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubConfirmDialog
import kotlinx.coroutines.*
import java.time.Instant

/** The hosted frame both PkwApp and the emulator chat host use: safe area and keyboard are intersected once
 * here (the shared page insets, as one union) and never again inside [ChatScreen]. */
internal class HostedChatFrame(val insets: WindowInsets, val dock: ChatDock)
@Composable internal fun hostedChatFrame(maxWidth: Dp, maxHeight: Dp): HostedChatFrame {
    val density = LocalDensity.current
    val insets = WindowInsets.safeDrawing.union(WindowInsets.ime)
    val usable = maxHeight - with(density) { (insets.getTop(this) + insets.getBottom(this)).toDp() }
    return HostedChatFrame(insets, chatDock(maxWidth.value, usable.value))
}
/** One composition survives IME/resize changes, so the draft, the open options and the player card never remount.
 * The designed drawer fills the frame ([ChatDock]); [focusMessageId] opens it at that message (a chat peek's tap). */
@Composable internal fun BoxScope.HostedChat(frame: HostedChatFrame, repository: LiveChatRepository, bounds: ChatBounds?, avatarBounds: ProfileBounds?,
    onProfile: () -> Unit, onLand: (() -> Unit)?, onBack: () -> Unit, onReleased: () -> Unit, focusMessageId: String? = null) {
    Box(Modifier.matchParentSize().windowInsetsPadding(frame.insets)) {
        ChatScreen(repository, bounds, avatarBounds, onProfile = onProfile, onBack = onBack, modifier = Modifier.fillMaxSize(),
            hosted = true, docked = frame.dock.docked, onReleased = onReleased, onLand = onLand, focusMessageId = focusMessageId)
    }
}

/**
 * Global chat as the designed Chat drawer (hub SPEC §2.9, chat.png), fed by [chatDrawerUi]. Every capability of the
 * 0.5.x screen stays: refresh on open and the server's poll cadence, earlier pages (pull past the oldest line), SEND
 * within the catalogue bounds, the saved-message outbox (the unsent bubble retries on a tap), mention highlighting, a
 * long-press for MENTION · PROFILE · COPY · REPORT · BLOCK plus BLOCKED PLAYERS (UNBLOCK) and REFRESH, the player card,
 * the composer above the keyboard, and Back. Errors and notices are toasts (the app-wide KitToastLayer).
 * [docked] is kept for the existing call sites; the drawer has one shape.
 */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable fun ChatScreen(repository: LiveChatRepository, bounds: ChatBounds?, avatarBounds: ProfileBounds?, onProfile: () -> Unit, onBack: () -> Unit,
    modifier: Modifier = Modifier, hosted: Boolean = false, docked: Boolean = false, onReleased: () -> Unit = {}, onLand: (() -> Unit)? = null,
    focusMessageId: String? = null) {
    val released by rememberUpdatedState(onReleased)
    DisposableEffect(repository) { repository.setLauncherOpen(true); onDispose { repository.setLauncherOpen(false); released() } }
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable(repository) { mutableStateOf("") }
    var tab by rememberSaveable(repository) { mutableStateOf(CHAT_WORLD) }
    // A failed read stays said in the log (until a read succeeds); a failed order or a notice is a toast.
    var offline by remember(repository) { mutableStateOf<String?>(null) }
    var sending by remember(repository) { mutableStateOf(false) }
    var loadingOlder by remember(repository) { mutableStateOf(false) }
    var options by remember(repository) { mutableStateOf<String?>(null) }
    var showBlocks by rememberSaveable(repository) { mutableStateOf(false) }
    var report by remember(repository) { mutableStateOf<ChatMessage?>(null) }
    var block by remember(repository) { mutableStateOf<ChatMessage?>(null) }
    var focusHold by remember(repository, focusMessageId) { mutableStateOf(focusMessageId) }
    // Player cards live exactly as long as this open chat: read on a tap, held in memory, never written anywhere.
    val cards = remember(repository, scope) { ChatAuthorCards(scope, android.os.SystemClock::elapsedRealtime, repository::authorCard) }
    val card by cards.open.collectAsState()
    val keyboard = LocalSoftwareKeyboardController.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val clipboard = LocalClipboardManager.current
    val rows = remember(state.messages) { chatRows(state.messages) }
    val measured = remember(draft, bounds) { chatDraftMeasure(draft, bounds, ::chatGraphemes) }
    // Dead-end audit 2026-10-06 (shape B): an unconfirmed saved message stays with its RETRY; only a full outbox holds SEND.
    val canSend = chatCanSend(state.status, bounds != null, state.outboxFull, sending, measured)
    val canMention = state.status?.canSend == true && !state.outboxFull && bounds != null
    val today = remember(state.messages) { Instant.now() }
    suspend fun order(action: suspend () -> Unit) {
        try { action() } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { Toasts.post(failure.message ?: "Chat connection interrupted. Refresh to check.", error = true) }
    }
    suspend fun read(action: suspend () -> Unit) {
        try { action(); offline = null } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { offline = failure.message ?: "Chat connection interrupted. Refresh to check." }
    }
    fun send() {
        if (!canSend) return
        val text = draft
        sending = true
        // The field is never disabled for this flight: focus, the keyboard and anything typed meanwhile stay.
        scope.launch {
            try {
                when (val result = chatSubmit(text, { draft }) { repository.send(it) }) {
                    is ChatSubmit.Sent -> draft = result.draft
                    is ChatSubmit.Failed -> Toasts.post(result.reason, error = true)
                }
            } finally { sending = false }
        }
    }
    fun mention(message: ChatMessage) {
        if (!canMention) return
        val (text, _) = insertChatMention(draft, draft.length, draft.length, message.author.name)
        if (!chatDraftMeasure(text, bounds, ::chatGraphemes).valid) { Toasts.post("MESSAGE IS FULL — MAKE ROOM FOR THE MENTION", error = true); return }
        // Mentioning someone is a decision to type: the world composer takes it and the keyboard is asked for.
        draft = text; tab = CHAT_WORLD; keyboard?.show()
    }
    fun act(action: ChatMessageAction, message: ChatMessage) {
        options = null
        when (action) {
            ChatMessageAction.MENTION -> mention(message)
            ChatMessageAction.PROFILE -> cards.open(message.id)
            ChatMessageAction.COPY -> { clipboard.setText(AnnotatedString(message.text)); Toasts.post("MESSAGE COPIED") }
            ChatMessageAction.REPORT -> report = message
            ChatMessageAction.BLOCK -> block = message
        }
    }
    fun back() { when { report != null -> report = null; block != null -> block = null; card != null -> cards.dismiss(); options != null -> options = null; showBlocks -> showBlocks = false; else -> onBack() } }
    BackHandlerAt(if (hosted) CHAT_DOCK_BACK_PRIORITY else BackPriority.SCREEN) { back() }
    LaunchedEffect(repository, bounds, lifecycle) {
        if (bounds == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Only a successful current read closes disabled chat; an old cached status or a failed read cannot.
            read { repository.refresh(); if (repository.state.value.status?.enabled == false) onBack() }
            while (isActive) {
                val status = repository.state.value.status
                delay(if (status?.enabled == false) status.pollClosedMs else status?.pollOpenMs ?: bounds.pollOpenMs)
                read { repository.poll(); if (repository.state.value.status?.enabled == false) onBack() }
            }
        }
    }
    // The routine "Message sent." is for screen readers only (below); every other notice passes as a toast.
    LaunchedEffect(state.notice) { state.notice?.takeIf { it != LiveChatRepository.SENT_NOTICE }?.let { Toasts.post(it) } }
    LaunchedEffect(rows) {
        val ids = rows.mapTo(HashSet()) { it.message.id }
        cards.retain(ids); options = options?.takeIf { it in ids }
    }
    // Opening at a peeked message: the drawer's log keeps its place by item key, so it is first laid out ending at that
    // message ([chatDrawerUi] focusHold) and given the newer lines two frames later; they arrive below it and the
    // message stays in view. A message that is not in the log releases the hold at once.
    LaunchedEffect(focusHold, state.messages) {
        val held = focusHold ?: return@LaunchedEffect
        if (state.messages.any { it.id == held }) { withFrameNanos { }; withFrameNanos { } }
        focusHold = null
    }
    val pullOlder = remember(repository) { object : NestedScrollConnection {
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (tab == CHAT_WORLD && chatPullLoadsOlder(available.y, repository.state.value, loadingOlder)) {
                loadingOlder = true
                scope.launch { try { order { repository.older() } } finally { loadingOlder = false } }
            }
            return Offset.Zero
        }
    } }
    val ui = chatDrawerUi(state, bounds, draft, measured, tab = tab, sending = sending, offline = offline, canGetLand = onLand != null,
        focusHold = focusHold, loadingOlder = loadingOlder, now = today)
    val actions = ChatActions(
        onTab = { tab = it },
        onDraft = { draft = it },
        onSend = ::send,
        onToggleEmotes = { Toasts.post(CHAT_EMOTES_CLOSED) },
        onEmote = { Toasts.post(CHAT_EMOTES_CLOSED) },
        onGo = { Toasts.post(CHAT_PLACES_CLOSED) },
        onLongPress = { id ->
            val refusal = chatLongPressRefusal(id, state.messages)
            if (refusal != null) { Toasts.post(refusal) } else { options = id }
        },
        onRetry = { id -> val refusal = chatRetryRefusal(state, id); if (refusal != null) Toasts.post(refusal) else scope.launch { order { repository.retry() } } },
        onBlockedAction = { link -> when (chatUnlockFor(link)) {
            ChatUnlock.PROFILE -> onProfile()
            ChatUnlock.LAND -> { val land = onLand; if (land != null) land() else Toasts.post(CHAT_LAND_CLOSED) }
            null -> Toasts.post(CHAT_DOOR_CLOSED)
        } },
        onClose = ::back,
    )
    val frame = if (hosted) modifier else modifier.fillMaxSize().background(PkwTokens.Colors.bg).pageInsets()
    BoxWithConstraints(frame.onPreviewKeyEvent { event ->
        when {
            hosted && event.key == Key.Escape && event.type == KeyEventType.KeyUp -> { back(); true }
            // A hardware Enter sends like SEND; Shift+Enter and anything over the log (options, card, dialogs) pass on.
            event.type == KeyEventType.KeyDown && (event.key == Key.Enter || event.key == Key.NumPadEnter) && !event.isShiftPressed && !event.isAltPressed &&
                canSend && options == null && card == null && !showBlocks && report == null && block == null -> { send(); true }
            else -> false
        }
    }
        // With the keyboard up the system spends Back on the keyboard first and the card would stay. A player who
        // opened a card over it means the card, so it closes on that Back. The draft is never touched.
        .onInterceptKeyBeforeSoftKeyboard { event ->
            if (card != null && event.key == Key.Back) { if (event.type == KeyEventType.KeyUp) cards.dismiss(); true } else false
        }) {
        ChatDrawer(ui, actions, Modifier.nestedScroll(pullOlder))
        if (state.notice == LiveChatRepository.SENT_NOTICE) Box(Modifier.size(1.dp).semantics { liveRegion = LiveRegionMode.Polite; contentDescription = LiveChatRepository.SENT_NOTICE })
        val chosen = options?.let { id -> rows.firstOrNull { it.message.id == id } }
        if (chosen != null) ChatOptionsSheet(chosen, chatMessageActions(chosen, canMention), onAction = { act(it, chosen.message) },
            onBlocked = { options = null; showBlocks = true; scope.launch { order { repository.refreshBlocks() } } },
            onRefresh = { options = null; scope.launch { read { repository.refresh() } } }, onDismiss = { options = null })
        if (showBlocks) ChatBlocksSheet(state, maxHeight, onUnblock = { id -> scope.launch { order { repository.unblock(id) } } },
            onMore = { scope.launch { order { repository.refreshBlocks(true) } } },
            onRefresh = { scope.launch { order { repository.refreshBlocks() } } }, onDismiss = { showBlocks = false })
        // The plate is drawn inside the chat frame, which already ends at the keyboard: it can never be under it.
        // A frame too short to hold it (landscape with the keyboard up) puts the keyboard away instead.
        val shown = card; val about = shown?.let { open -> rows.firstOrNull { it.message.id == open.messageId } }
        val frameHeight = maxHeight
        LaunchedEffect(shown?.messageId) { if (shown != null && chatCardClosesKeyboard(frameHeight.value)) keyboard?.hide() }
        if (shown != null && about != null) ChatAuthorCardPlate(shown, about, canMention, frameHeight, cards.now,
            avatar = { url, size -> if (avatarBounds != null) ChatAvatar(repository, url, avatarBounds, size) },
            onAction = { action -> cards.dismiss(); act(action, about.message) }, onRetry = { cards.open(shown.messageId) }, onDismiss = cards::dismiss)
        HubConfirmDialog(block?.let { chatBlockConfirm(it.author.name) }, onConfirm = {
            val chosenBlock = block; block = null
            if (chosenBlock != null) scope.launch { order { repository.block(chosenBlock.id) } }
        }, onBack = { block = null })
        // REPORT (SPEC §2.9 "existing logic and copy"): the same server reasons and the same report call, in the kit's wood
        // half sheet like the options above (was the old dark AlertDialog).
        report?.let { chosen -> ChatReportSheet(chosen, onReason = { reason ->
            report = null; scope.launch { order { repository.report(chosen.id, reason) } }
        }, onDismiss = { report = null }) }
    }
}

/** Long-press a message (SPEC §2.9 "half sheet with COPY · REPORT · BLOCK, existing logic and copy"): that message's own
 * actions ([chatMessageActions], behind the same confirmations) and the two drawer-wide doors the old header menu held,
 * BLOCKED PLAYERS and REFRESH. A tap on the scrim, the X or Back puts it away. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun BoxScope.ChatOptionsSheet(row: ChatRow, actions: List<ChatMessageAction>, onAction: (ChatMessageAction) -> Unit,
    onBlocked: () -> Unit, onRefresh: () -> Unit, onDismiss: () -> Unit) {
    ModalScrim(PkwTokens.Scrim.SHEET_TALL, onTap = onDismiss)
    val prompt = chatReportPrompt(row.message)
    Plate(PlateKind.WOOD, Modifier.align(Alignment.BottomCenter).padding(8.dp).widthIn(max = CHAT_SHEET_MAX_WIDTH).fillMaxWidth()
        .semantics { paneTitle = "Message options" }) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(prompt.author, PkwTokens.Type.caption, Modifier.weight(1f).semantics { heading() }, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                CloseSquare(onDismiss, contentDescription = "Close message options")
            }
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(prompt.quote, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 3)
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (action in actions) SecondaryButton(action.name, { onAction(action) }, verb = chatActionVerb(action),
                            contentDescription = chatActionDescription(action, row.message.author.name))
                    }
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        SecondaryButton("BLOCKED PLAYERS", onBlocked)
                        SecondaryButton("REFRESH", onRefresh, contentDescription = "Refresh chat")
                    }
                }
            }
        }
    }
}

/** REPORT on one message: the quoted line, the server's report reasons as buttons and the hint the old dialog carried.
 * A tap on the scrim, the X or Back puts it away without reporting. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun BoxScope.ChatReportSheet(message: ChatMessage, onReason: (String) -> Unit, onDismiss: () -> Unit) {
    ModalScrim(PkwTokens.Scrim.SHEET_TALL, onTap = onDismiss)
    val prompt = chatReportPrompt(message)
    Plate(PlateKind.WOOD, Modifier.align(Alignment.BottomCenter).padding(8.dp).widthIn(max = CHAT_SHEET_MAX_WIDTH).fillMaxWidth()
        .semantics { paneTitle = "Report this message" }) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText("REPORT THIS MESSAGE", PkwTokens.Type.caption, Modifier.weight(1f).semantics { heading() }, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                CloseSquare(onDismiss, contentDescription = "Close report")
            }
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
                        PkwText(prompt.author, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch, maxLines = 1)
                        PkwText(prompt.quote, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 2)
                    }
                    PkwText(CHAT_REPORT_OTHER_HINT, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (reason in LiveChatRepository.REPORT_REASONS) {
                            val words = reason.replace('_', ' ')
                            SecondaryButton(words.uppercase(), { onReason(reason) }, contentDescription = "Report as $words")
                        }
                    }
                }
            }
        }
    }
}

/** The blocked players (the old BLOCKED PLAYERS page) as a half sheet over the drawer: UNBLOCK each, LOAD MORE, REFRESH.
 * The list is the server's; a busy repository queues each order behind the read in flight. */
@Composable private fun BoxScope.ChatBlocksSheet(state: ChatState, frameHeight: Dp, onUnblock: (String) -> Unit, onMore: () -> Unit,
    onRefresh: () -> Unit, onDismiss: () -> Unit) {
    ModalScrim(PkwTokens.Scrim.SHEET_TALL, onTap = onDismiss)
    val blocks = state.blocks
    Plate(PlateKind.WOOD, Modifier.align(Alignment.BottomCenter).padding(8.dp).widthIn(max = CHAT_SHEET_MAX_WIDTH).fillMaxWidth()
        .heightIn(max = frameHeight * CHAT_BLOCKS_MAX_HEIGHT).semantics { paneTitle = "Blocked players" }) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText("BLOCKED PLAYERS", PkwTokens.Type.caption, Modifier.weight(1f).semantics { heading() }, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                CloseSquare(onDismiss, contentDescription = "Close blocked players")
            }
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f, fill = false), blocksScene = false) {
                LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    item(key = "line") { PkwText(CHAT_BLOCKS_LINE, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3) }
                    items(blocks?.blocks.orEmpty(), key = { it.id }) { entry ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PkwText(entry.author.name, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
                            SecondaryButton("UNBLOCK", { onUnblock(entry.id) }, contentDescription = "Unblock ${entry.author.name}")
                        }
                    }
                    if (blocks == null) item(key = "loading") {
                        PkwText(if (state.busy) "LOADING…" else "Tap REFRESH to load the list.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
                    } else if (blocks.blocks.isEmpty()) item(key = "none") {
                        PkwText("NO BLOCKED PLAYERS", PkwTokens.Type.body, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
                    }
                    if (blocks?.nextBefore != null) item(key = "more") { SecondaryButton("LOAD MORE", onMore, contentDescription = "More blocked accounts") }
                }
            }
            SecondaryButton("REFRESH", onRefresh, Modifier.fillMaxWidth(), contentDescription = "Refresh blocked players")
        }
    }
}
private val CHAT_SHEET_MAX_WIDTH = 420.dp
private const val CHAT_BLOCKS_MAX_HEIGHT = .8f

@Composable internal fun ChatAction(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    selected: Boolean = false, content: @Composable RowScope.() -> Unit) {
    Row(modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp).alpha(if (enabled) 1f else .5f).background(Palette.card)
        .border(2.dp, if (selected) Palette.goldDp else Palette.borderLt).semantics { contentDescription = label }
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically, content = content)
}
/** A borderless 48dp square control for the player card's header. */
@Composable internal fun ChatIcon(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.size(48.dp).background(if (selected) Palette.card else Color.Transparent).semantics { contentDescription = label }
        .clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center, content = content)
}

private val CHAT_AVATAR = 32.dp
@Composable internal fun ChatMessageActionButton(action: ChatMessageAction, author: String, onClick: () -> Unit) = ChatAction(chatActionDescription(action, author), onClick) {
    Text(action.name, fontSize = 14.sp, color = if (action == ChatMessageAction.REPORT || action == ChatMessageAction.BLOCK) Palette.muted else Palette.goldHi)
}

private fun chatGraphemes(text: String): Int {
    val iterator = BreakIterator.getCharacterInstance()
    iterator.setText(text)
    var count = 0
    iterator.first()
    while (iterator.next() != BreakIterator.DONE) count++
    return count
}

@Composable internal fun ChatAvatar(repository: LiveChatRepository, url: String, bounds: ProfileBounds, size: Dp = CHAT_AVATAR) {
    var image by remember(repository, url) { mutableStateOf<ImageBitmap?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(repository, url, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        try {
            val bytes = repository.avatar(url, bounds.maxImageBytes)
            image = withContext(Dispatchers.IO) {
                val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dimensions)
                require(dimensions.outWidth in 1..bounds.imageSize && dimensions.outHeight in 1..bounds.imageSize)
                requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)).asImageBitmap()
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { image = null }
        }
    }
    image?.let { Image(it, "Player avatar", Modifier.size(size)) }
}
