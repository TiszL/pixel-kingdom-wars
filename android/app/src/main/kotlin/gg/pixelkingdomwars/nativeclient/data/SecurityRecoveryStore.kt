package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.jsonBody
import gg.pixelkingdomwars.nativeclient.network.string
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

enum class RecoveryAction { START, CONFIRM, CANCEL, SEND_COMPLETION, COMPLETE }
data class SavedRecoveryAction(val recoveryId: String, val action: RecoveryAction)

/** Only the original account/origin, recovery UUID and action are durable. Never codes, seeds or grants.
 * The supplied encrypted store must be dedicated to this account's security recovery. */
class SecurityRecoveryStore(private val store: SecretStore, private val wallet: String, private val origin: String) {
    fun read(): SavedRecoveryAction? {
        val raw = store.read()?.let { Json.parseToJsonElement(it) as JsonObject } ?: return null
        check(raw.string("wallet") == wallet && raw.string("origin") == origin) { "Recovery belongs to another account or server" }
        val id = requireNotNull(raw.string("recoveryId")); require(UUID.fromString(id).toString() == id.lowercase())
        return SavedRecoveryAction(id, RecoveryAction.valueOf(requireNotNull(raw.string("action"))))
    }
    fun write(value: SavedRecoveryAction) = store.write(jsonBody("wallet" to wallet, "origin" to origin,
        "recoveryId" to value.recoveryId, "action" to value.action.name).toString())
    fun clear() = store.clear()
}
