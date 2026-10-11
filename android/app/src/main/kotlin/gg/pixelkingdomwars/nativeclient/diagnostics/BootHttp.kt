package gg.pixelkingdomwars.nativeclient.diagnostics

import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Response
import java.io.IOException

/** Route words the client itself names (its own path literals), so a boot HTTP line shows which read it was. Anything else —
 *  a base id, a wallet, a key, an unknown word — is `:id`. */
internal val BOOT_HTTP_WORDS: Set<String> = ("access activity adopt advanced-expeditions allocations alpha army assets assets-v2 attempts " +
    "auctions auth avatar avatars awards awning balances base bases batch battles bids blocks bound-cosmetics buildings buy by-key " +
    "campaign campaigns cancel cancellations candidate capabilities challenge charter chat check claim claims clans clear client close " +
    "code collect collection commands continuation continuations continue contribute contributions convert craft current deliveries " +
    "deposits devnet-faucet devnet-skr-faucet divine-fragments divine-trials economy entitlements entries events expansions expeditions " +
    "failures fantasy feedback fills finish fleet forge free-purchases from-keep frozen gems global globe grants harvesters heroes " +
    "history inclusions installations issues items jobs keep-equipment-market kick layouts leaderboard leagues leave link list listings " +
    "login logout mail map market me messages migrations mine mining mining-tax move-batch native notifications obstacles operations " +
    "ordinary-crafting ordinary-equipment originals page paid-route parcels participated pending playtest policy preference prepare " +
    "presets previous protection purchases quests quote raids realm-passport realm-sales receipt recruit referrals refunds releases " +
    "research reservations reserve resource-claims retirements review round routes rpc sales scout search season seeker services shards " +
    "skr solana sources speedup starter-expeditions starter-fleet stats status stock submit subscribe tasks telemetry terms tester " +
    "to-shards tournaments trades train training tutorial tx use username v1 vehicles verify wakes wallet walls withdrawals workshop " +
    "raid-events active-raid").split(' ').toSet()

/** `/api/vehicles/fleet?x=1` → `/vehicles/fleet`; `/api/bases/<id>/raid-events` → `/bases/:id/raid-events`. */
internal fun bootHttpTemplate(encodedPath: String): String = encodedPath.substringBefore('?').substringBefore('#').split('/')
    .filter { it.isNotEmpty() }.let { if (it.firstOrNull() == "api") it.drop(1) else it }.take(4)
    .joinToString("/", prefix = "/") { if (it in BOOT_HTTP_WORDS) it else ":id" }

/** wait = enqueued → request sent (dispatcher queue, the Home-first hold, connection setup); ms = enqueued → done. */
internal fun bootHttpLine(template: String, waitMs: Long, totalMs: Long, code: Int?, failure: String?): String =
    "$template wait=$waitMs ms=$totalMs " + if (failure == null) "code=${code ?: 0}" else "failed=$failure"

/**
 * Cold-start measurement 2026-10-06 (demo build, QA chain lane): the Home's GET /base answered 14.5 s after Home composed and
 * nothing showed which reads ran meanwhile. For the first [WINDOW_MS] of each launch, every game-API call leaves one PKWLoad
 * line when it ends: `HTTP <route template> wait=<ms> ms=<ms> code=<n>|failed=<exception class>`.
 */
internal object BootHttp {
    const val WINDOW_MS = 30_000L
    val listeners = EventListener.Factory { call ->
        if (BootTimeline.inWindow(WINDOW_MS)) Listener(bootHttpTemplate(call.request().url.encodedPath)) else EventListener.NONE
    }
    private class Listener(private val template: String) : EventListener() {
        @Volatile private var started = 0L
        @Volatile private var sent = 0L
        @Volatile private var code: Int? = null
        override fun callStart(call: Call) { started = System.nanoTime() }
        override fun requestHeadersStart(call: Call) { if (sent == 0L) sent = System.nanoTime() }
        override fun responseHeadersEnd(call: Call, response: Response) { code = response.code }
        override fun callEnd(call: Call) = done(null)
        override fun callFailed(call: Call, ioe: IOException) = done(ioe.javaClass.simpleName)
        private fun done(failure: String?) {
            val now = System.nanoTime(); val waited = (if (sent != 0L) sent else now) - started
            SceneLoadLog.mark(LoadEvent.HTTP, bootHttpLine(template, waited / 1_000_000, (now - started) / 1_000_000, code, failure))
        }
    }
}
