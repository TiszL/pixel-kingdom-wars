package gg.pixelkingdomwars.nativeclient.ui.community

/** The hosted chat frame over the base. Since the designed drawer (hub SPEC §2.9, chat.png) chat is one modal drawer
 * from the left, 88 % of this frame wide ([gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ChatDrawer]), with the world
 * live under its scrim, in portrait and landscape alike. It replaces the 0.5.x shapes (a 60 % bottom sheet in portrait,
 * a 40 % side column in landscape, a compact one-line log in short frames), so the frame here is simply all of it.
 *
 * Typing (owner 0.5.4, "chatbox is not convenient to use": with the keyboard up the chat must take everything above the
 * keyboard): the caller intersects the safe area and the keyboard once ([hostedChatFrame]) and passes what is left, so
 * the composer pinned to the drawer's foot always sits above the keyboard. Nothing under the chat is resized or moved.
 * [docked] is false only for a frame that has not been measured yet (zero, negative or not finite). */
internal data class ChatDock(val docked: Boolean, val widthDp: Float, val heightDp: Float)
internal fun chatDock(widthDp: Float, usableHeightDp: Float): ChatDock {
    val width = widthDp.takeIf { it.isFinite() && it > 0 } ?: 0f
    val height = usableHeightDp.takeIf { it.isFinite() && it > 0 } ?: 0f
    return ChatDock(width > 0f && height > 0f, width, height)
}

/** Chat sits above an inline build sheet and below a real spend/retreat confirmation. */
internal const val CHAT_DOCK_BACK_PRIORITY = 300
