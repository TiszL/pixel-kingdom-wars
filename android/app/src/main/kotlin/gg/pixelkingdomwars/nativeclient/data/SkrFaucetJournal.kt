package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.serialization.json.*
import java.util.Base64
import java.util.UUID
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.sync.Mutex

data class SkrFaucetRecord(val intentId: String, val baseId: String, val grant: SkrFaucetGrant? = null,
    val attemptId: String? = null, val signedTransaction: String? = null, val preparePending: Boolean = false,
    val claimDay: String? = null)

/** The caller supplies EncryptedStore under storageNamespace(origin, "skr-faucet-$cluster-$wallet").
 * Missing data and unreadable data are distinct. Returned wallet evidence replaces only its own intent. */
class SkrFaucetJournal(private val store: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    private val monitor = locks.computeIfAbsent(listOf(origin, cluster, wallet)) { Any() }
    internal val admission = admissions.computeIfAbsent(listOf(origin, cluster, wallet)) { Mutex() }
    fun read(): SkrFaucetRecord? = synchronized(monitor) { store.read()?.let { text ->
        val row = Json.parseToJsonElement(text).jsonObject
        val version = row.getValue("version")
        require(version == JsonPrimitive(1) || version == JsonPrimitive(2))
        val fields = setOf("version", "wallet", "origin", "cluster", "intentId", "baseId", "grant", "attemptId", "signedTransaction", "preparePending")
        require(row.keys == if (version == JsonPrimitive(2)) fields + "claimDay" else fields)
        require(row.text("wallet") == wallet && row.text("origin") == origin && row.text("cluster") == cluster)
        val grant = if (row["grant"] == JsonNull) null else SkrFaucetGrant.from(row.getValue("grant").jsonObject)
        SkrFaucetRecord(row.text("intentId"), row.text("baseId"), grant, row.nullText("attemptId"), row.nullText("signedTransaction"),
            requireNotNull((row["preparePending"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull),
            if (version == JsonPrimitive(2)) row.nullText("claimDay") else null).also(::validate)
    } }
    /** Explicit replacement seam for recovery-policy tests. Live clients always use beginIfEmpty. */
    internal fun begin(baseId: String, claimDay: String? = null): SkrFaucetRecord = synchronized(monitor) {
        SkrFaucetRecord(UUID.randomUUID().toString(), baseId, claimDay = claimDay).also(::write)
    }
    fun beginIfEmpty(baseId: String, claimDay: String? = null): SkrFaucetRecord = synchronized(monitor) {
        check(read() == null) { "A saved faucet intent must be reconciled first." }
        begin(baseId, claimDay)
    }
    fun replace(expected: SkrFaucetRecord, next: SkrFaucetRecord) = synchronized(monitor) {
        require(read() == expected) { "Saved faucet intent changed." }
        require(next.intentId == expected.intentId && next.baseId == expected.baseId && next.claimDay == expected.claimDay)
        if (expected.grant != null && next.grant != null) require(expected.grant.sameIdentity(next.grant))
        write(next)
    }
    fun clear(expected: SkrFaucetRecord) = synchronized(monitor) { require(read() == expected); store.clear() }
    private fun validate(record: SkrFaucetRecord) {
        fun uuid(value: String) { require(UUID.fromString(value).toString() == value) }
        uuid(record.intentId); uuid(record.baseId); record.attemptId?.let(::uuid)
        record.claimDay?.let { require(it.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && LocalDate.parse(it).toString() == it) }
        require(record.attemptId == null || record.grant?.attempt?.id == record.attemptId)
        record.signedTransaction?.let { wire ->
            require(record.attemptId != null && !record.preparePending)
            require(wire.length <= 1644 && wire.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
            val bytes = Base64.getDecoder().decode(wire)
            require(bytes.size <= 1232 && Base64.getEncoder().encodeToString(bytes) == wire)
        }
    }
    private fun write(record: SkrFaucetRecord) {
        validate(record)
        store.write(buildJsonObject {
            put("version", 2); put("wallet", wallet); put("origin", origin); put("cluster", cluster)
            put("intentId", record.intentId); put("baseId", record.baseId)
            put("claimDay", record.claimDay?.let(::JsonPrimitive) ?: JsonNull)
            put("grant", record.grant?.raw ?: JsonNull); put("attemptId", record.attemptId?.let(::JsonPrimitive) ?: JsonNull)
            put("signedTransaction", record.signedTransaction?.let(::JsonPrimitive) ?: JsonNull); put("preparePending", record.preparePending)
        }.toString())
    }
    private companion object {
        val locks = ConcurrentHashMap<List<String>, Any>()
        val admissions = ConcurrentHashMap<List<String>, Mutex>()
    }
}
private fun JsonObject.text(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun JsonObject.nullText(key: String) = if (get(key) == JsonNull) null else text(key)
