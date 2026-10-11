package gg.pixelkingdomwars.nativeclient.notifications

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ui.nav.GameLinkContract
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

@Serializable data class NotificationBinding(val wallet: String, val bindingId: String, val token: String,
    val previousToken: String? = null, val active: Boolean = false, val seen: List<String> = emptyList(), val consented: Boolean = true)

data class NativePush(val bindingId: String, val eventId: String, val kind: String,
    val title: String, val body: String, val url: String)

/** One encrypted device capability. A new consent/identity gets a new binding; queued old pushes cannot follow it. */
class NotificationJournal(private val secret: SecretStore) {
    private var blocked = false
    @Synchronized fun read(): NotificationBinding? = secret.read()?.let {
        Json.decodeFromString<NotificationBinding>(it).also(::validate)
    }
    private fun validate(b: NotificationBinding) {
        require(b.wallet.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")) && uuid(b.bindingId))
        require(token(b.token) && (b.previousToken == null || token(b.previousToken)))
        require(b.seen.size <= MAX_SEEN && b.seen.all(::uuid) && b.seen.distinct().size == b.seen.size)
        require(!b.active || b.consented)
    }
    @Synchronized fun save(b: NotificationBinding) { validate(b); secret.write(Json.encodeToString(b)) }
    @Synchronized fun clear() = secret.clear()
    @Synchronized fun clearIf(b: NotificationBinding) {
        val now = read()
        if (now?.wallet == b.wallet && now.bindingId == b.bindingId && now.token == b.token) clear()
    }
    @Synchronized fun block() { blocked = true }
    @Synchronized fun revoke() {
        blocked = true
        read()?.let { save(it.copy(active = false, consented = false)) }
    }
    @Synchronized fun activate(b: NotificationBinding) { save(b); blocked = false }
    @Synchronized fun matches(b: NotificationBinding): Boolean = read()?.let {
        it.consented && it.wallet == b.wallet && it.bindingId == b.bindingId && it.token == b.token
    } == true
    @Synchronized fun confirm(b: NotificationBinding) {
        check(matches(b)) { "The notification binding changed." }
        activate(requireNotNull(read()).copy(active = true, previousToken = null))
    }
    @Synchronized fun rotate(token: String): Boolean {
        require(NotificationJournal.token(token))
        val b = read()?.takeIf { it.consented } ?: return false
        if (b.token != token) save(b.copy(token = token, previousToken = b.token, active = false))
        return true
    }
    @Synchronized fun active(bindingId: String): Boolean = !blocked && read()?.let { it.active && it.bindingId == bindingId } == true
    @Synchronized fun accept(data: Map<String, String>): NativePush? {
        if (blocked) return null
        val b = read()?.takeIf { it.active } ?: return null
        if (data.keys != setOf("version", "bindingId", "eventId", "kind", "title", "body", "url") || data["version"] != "1") return null
        val event = data.getValue("eventId")
        if (data["bindingId"] != b.bindingId || !uuid(event) || event in b.seen) return null
        val kind = data.getValue("kind")
        val target = when (kind) { "raided" -> "raidlog"; "mail" -> "mail"; "build", "training", "mine_full" -> "base"; else -> return null }
        val url = data.getValue("url")
        if (url != "/?screen=$target" && !(kind == "mine_full" && url == "/?screen=bases")) return null
        val title = data.getValue("title"); val body = data.getValue("body")
        if (title.length !in 1..120 || body.length !in 1..500 || (title + body).any { it.code < 32 && it != '\n' }) return null
        // Persist dedup before handing off to Android. A killed process cannot repeat the same delivery.
        save(b.copy(seen = (b.seen + event).takeLast(MAX_SEEN)))
        return NativePush(b.bindingId, event, kind, title, body, GameLinkContract.ORIGIN + url)
    }
    /** The same lock serializes display with logout's block-then-cancel operation. */
    @Synchronized fun dispatch(data: Map<String, String>, display: (NativePush) -> Unit) {
        accept(data)?.let(display)
    }
    companion object {
        // Device storage bound, independent of any gameplay number or server notification cap.
        private const val MAX_SEEN = 128
        fun uuid(raw: String) = runCatching { UUID.fromString(raw).toString() == raw }.getOrDefault(false)
        fun token(raw: String) = raw.length in 32..4096 && raw.none(Char::isWhitespace)
    }
}
