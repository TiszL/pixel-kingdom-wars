package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.ChatEvents
import gg.pixelkingdomwars.nativeclient.model.ChatStatus
import gg.pixelkingdomwars.nativeclient.model.chatDecimal

/** Web ChatLauncher: only opaque message IDs and the server's viewer-relative mention bit are retained. */
data class ChatLauncherState(val status: ChatStatus? = null, val cursor: String? = null,
    val open: Boolean = false, val capabilityMissing: Boolean = false,
    internal val unreadMessages: Map<String, Boolean> = emptyMap()) {
    val enabled: Boolean get() = status?.enabled == true && !capabilityMissing
    val unread: Int get() = unreadMessages.size
    val mentions: Int get() = unreadMessages.values.count { it }

    internal fun events(page: ChatEvents, limit: Int): ChatLauncherState {
        val after = chatDecimal(requireNotNull(cursor), true)
        require(limit > 0 && chatDecimal(page.nextAfter, true) >= after)
        require(page.events.all { chatDecimal(it.id) > after })
        val next = unreadMessages.toMutableMap()
        for (event in page.events) {
            if (event.type == "redaction") next.remove(event.messageId)
            else next[event.messageId] = requireNotNull(event.message).mentioned
        }
        // Raw cursor advances even when every event is invisible to this viewer.
        return copy(cursor = page.nextAfter, unreadMessages = next.entries.toList().takeLast(limit).associate { it.key to it.value })
    }
}
