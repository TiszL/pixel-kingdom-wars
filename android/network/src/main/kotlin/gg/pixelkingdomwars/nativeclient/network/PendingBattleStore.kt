package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.time.Instant

@Serializable data class PendingBattleWrite(val id: String, val path: String, val body: JsonObject, val attempted: Boolean = false)
/** The march the create request named (web `RaidTarget`): an explicit PvP defender, or the automatic match's
 * exclusion; once the server answers, the defender it chose. Campaign stages keep [PendingBattle.stage]. */
@Serializable data class PendingRaidTarget(val defenderWallet: String? = null, val defenderBaseId: String? = null,
    val excludeBaseId: String? = null, val name: String? = null)
@Serializable data class PendingBattle(val wallet: String, val baseId: String, val raidId: String? = null, val stage: Int? = null,
    val create: PendingBattleWrite? = null, val writes: List<PendingBattleWrite> = emptyList(), val target: PendingRaidTarget? = null,
    /** Immutable server row metadata for the staging label only; never an order/expiry/recovery gate. */
    val ordersDeadlineAt: String? = null) {
    /** Web `canChooseNextTarget`: only a stable PvP march (a defender deed, not PvE or campaign) can be re-rolled. */
    val pvpDefenderBaseId: String? get() = if (stage == null) target?.defenderBaseId else null
}

internal fun battleOrdersDeadlineEpochMs(value: String?): Long? = value?.let {
    runCatching { Instant.parse(it).toEpochMilli() }.getOrNull()
}

/** Optional display metadata must not make an otherwise recoverable battle unreadable. */
internal fun battleOrdersDeadlineAt(value: JsonElement?): String? = (value as? JsonPrimitive)
    ?.takeIf { it.isString }?.content?.takeIf { battleOrdersDeadlineEpochMs(it) != null }

/** Durable intent and an immutable server deadline: no cached balances, battle result, snapshots or simulation clocks.
 * Supply an origin-namespaced EncryptedStore. Logout never erases uncertain writes. */
class PendingBattleStore(private val store: SecretStore) {
    private fun key(wallet: String, base: String) = JsonArray(listOf(JsonPrimitive(wallet), JsonPrimitive(base))).toString()
    private fun entries(): JsonObject {
        val raw = store.read() ?: return buildJsonObject {}
        require(raw.length <= 8 * 1024 * 1024) { "Saved battles exceed device storage capacity" }
        val data = Json.parseToJsonElement(raw).jsonObject
        require(data.string("schemaVersion") == "1") { "Saved battle requests require a compatible client" }
        return requireNotNull(data["requests"] as? JsonObject)
    }
    private fun decode(value: JsonElement?, wallet: String, base: String): PendingBattle? = value?.let {
        val record = it.jsonObject
        val displayDeadline = battleOrdersDeadlineAt(record["ordersDeadlineAt"])
        val readable = if (displayDeadline == null) JsonObject(record - "ordersDeadlineAt") else record
        Json.decodeFromJsonElement<PendingBattle>(readable).also { value -> require(value.wallet == wallet && value.baseId == base) }
    }
    @Synchronized fun get(wallet: String, base: String): PendingBattle? = decode(entries()[key(wallet, base)], wallet, base)
    private fun validate(value: PendingBattle) {
        require(value.wallet.isNotEmpty() && value.baseId.isNotEmpty() && value.writes.size <= CLIENT_COMMAND_CEILING)
        require(value.writes.map { it.id }.distinct().size == value.writes.size)
    }
    @Synchronized fun put(value: PendingBattle) {
        validate(value)
        write(entries() + (key(value.wallet, value.baseId) to Json.encodeToJsonElement(value)))
    }
    /** A stale coordinator must not overwrite a newer intent for the same wallet/deed. */
    @Synchronized fun replace(expected: PendingBattle?, value: PendingBattle): Boolean {
        validate(value)
        val rows = entries()
        val id = key(value.wallet, value.baseId)
        if (decode(rows[id], value.wallet, value.baseId) != expected) return false
        write(rows + (id to Json.encodeToJsonElement(value)))
        return true
    }
    @Synchronized fun clear(wallet: String, base: String, expected: PendingBattle): Boolean {
        val rows = entries()
        if (decode(rows[key(wallet, base)], wallet, base) != expected) return false
        write(rows - key(wallet, base)); return true
    }
    private fun write(entries: Map<String, JsonElement>) {
        if (entries.isEmpty()) store.clear() else {
            val data = buildJsonObject { put("schemaVersion", 1); put("requests", JsonObject(entries)) }.toString()
            require(data.length <= 8 * 1024 * 1024) { "Saved battles exceed device storage capacity" }
            store.write(data)
        }
    }
}
