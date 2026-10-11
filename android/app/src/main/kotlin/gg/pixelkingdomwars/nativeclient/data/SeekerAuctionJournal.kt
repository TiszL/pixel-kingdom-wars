package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

enum class SeekerAuctionKind(val wire: String) { BID("bid"), WITHDRAW("withdraw") }

/**
 * One Seeker auction wallet step, saved BEFORE the wallet is asked. [newTotalRaw] is the reviewed escrow total of a bid
 * (null for a withdrawal); [preparedBlockhash] and [lastValidBlockHeight] are the server's quote. [signature] arrives from
 * the shared payment rail the moment the wallet answers; [opaqueSend] is true when the wallet itself broadcast (its signed
 * blockhash is then unknown, so block height alone can never retire it). [lastFound] is the last `/tx/:signature`
 * observation's `found` (null = not observed yet).
 */
data class SeekerAuctionAttempt(val intentId: String, val kind: SeekerAuctionKind, val round: String, val spot: Int,
    val newTotalRaw: String?, val preparedBlockhash: String, val lastValidBlockHeight: String,
    val signature: String? = null, val opaqueSend: Boolean = false, val lastFound: Boolean? = null)

/** The caller supplies EncryptedStore under storageNamespace(origin, "seeker-auction-$cluster-$wallet"), as
 * [SkrFaucetJournal]. Missing data is an empty list; unreadable or foreign data throws (fail closed, never "no intent").
 * Every change is a compare-and-set on the exact saved attempt, so a stale callback cannot overwrite newer evidence. */
class SeekerAuctionJournal(private val store: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    private val monitor = locks.computeIfAbsent(listOf(origin, cluster, wallet)) { Any() }
    /** One auction action or reconciliation at a time per identity, across session replacement. */
    internal val admission: Mutex = admissions.computeIfAbsent(listOf(origin, cluster, wallet)) { Mutex() }

    fun read(): List<SeekerAuctionAttempt> = synchronized(monitor) {
        val text = store.read() ?: return@synchronized emptyList()
        val row = Json.parseToJsonElement(text).jsonObject
        require(row.keys == setOf("version", "wallet", "origin", "cluster", "attempts") && row["version"] == JsonPrimitive(1))
        require(row.text("wallet") == wallet && row.text("origin") == origin && row.text("cluster") == cluster)
        row.getValue("attempts").jsonArray.map { attempt(it.jsonObject) }.also { all ->
            require(all.map { it.intentId }.toSet().size == all.size)
        }
    }

    fun add(attempt: SeekerAuctionAttempt) = synchronized(monitor) {
        val all = read()
        require(all.none { it.intentId == attempt.intentId }) { "Saved auction intent already exists." }
        write(all + attempt)
    }

    /** Only evidence may change: the signature once (null to a value, with its broadcast kind) and the last observation. */
    fun replace(expected: SeekerAuctionAttempt, next: SeekerAuctionAttempt) = synchronized(monitor) {
        val all = read()
        require(expected in all) { "Saved auction intent changed." }
        require(next.copy(signature = null, opaqueSend = false, lastFound = null) == expected.copy(signature = null, opaqueSend = false, lastFound = null))
        if (expected.signature != null) require(next.signature == expected.signature && next.opaqueSend == expected.opaqueSend)
        write(all.map { if (it == expected) next else it })
    }

    fun remove(expected: SeekerAuctionAttempt) = synchronized(monitor) {
        val all = read()
        require(expected in all) { "Saved auction intent changed." }
        write(all - expected)
    }

    private fun write(all: List<SeekerAuctionAttempt>) {
        all.forEach(::validate)
        if (all.isEmpty()) { store.clear(); return }
        store.write(buildJsonObject {
            put("version", 1); put("wallet", wallet); put("origin", origin); put("cluster", cluster)
            put("attempts", JsonArray(all.map { a -> buildJsonObject {
                put("intentId", a.intentId); put("kind", a.kind.wire); put("round", a.round); put("spot", a.spot)
                put("newTotalRaw", a.newTotalRaw?.let(::JsonPrimitive) ?: JsonNull)
                put("preparedBlockhash", a.preparedBlockhash); put("lastValidBlockHeight", a.lastValidBlockHeight)
                put("signature", a.signature?.let(::JsonPrimitive) ?: JsonNull); put("opaqueSend", a.opaqueSend)
                put("lastFound", a.lastFound?.let(::JsonPrimitive) ?: JsonNull)
            } }))
        }.toString())
    }

    private fun attempt(row: JsonObject): SeekerAuctionAttempt {
        require(row.keys == setOf("intentId", "kind", "round", "spot", "newTotalRaw", "preparedBlockhash", "lastValidBlockHeight",
            "signature", "opaqueSend", "lastFound"))
        val kind = SeekerAuctionKind.entries.single { it.wire == row.text("kind") }
        return SeekerAuctionAttempt(row.text("intentId"), kind, row.text("round"), requireNotNull(row.number("spot")),
            row.nullText("newTotalRaw"), row.text("preparedBlockhash"), row.text("lastValidBlockHeight"), row.nullText("signature"),
            row.flag("opaqueSend") ?: error("opaqueSend"), row.flag("lastFound")).also(::validate)
    }

    private fun validate(a: SeekerAuctionAttempt) {
        require(UUID.fromString(a.intentId).toString() == a.intentId)
        require(u64(a.round) && a.spot >= 0 && u64(a.lastValidBlockHeight) && a.preparedBlockhash.matches(address))
        when (a.kind) {
            SeekerAuctionKind.BID -> require(a.newTotalRaw != null && u64(a.newTotalRaw) && a.newTotalRaw != "0")
            SeekerAuctionKind.WITHDRAW -> require(a.newTotalRaw == null)
        }
        a.signature?.let { require(it.matches(signature) && it.any { c -> c != '1' }) }
        if (a.signature == null) require(!a.opaqueSend && a.lastFound == null)
    }

    private companion object {
        val locks = ConcurrentHashMap<List<String>, Any>()
        val admissions = ConcurrentHashMap<List<String>, Mutex>()
        val address = Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")
        val signature = Regex("[1-9A-HJ-NP-Za-km-z]{64,88}")
        fun u64(value: String) = value.length <= 20 && value.matches(Regex("0|[1-9][0-9]*")) && value.toULongOrNull() != null
    }
}
private fun JsonObject.text(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun JsonObject.nullText(key: String) = if (get(key) == JsonNull) null else text(key)
private fun JsonObject.number(key: String) = (get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
private fun JsonObject.flag(key: String): Boolean? = if (get(key) == JsonNull) null else
    requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
