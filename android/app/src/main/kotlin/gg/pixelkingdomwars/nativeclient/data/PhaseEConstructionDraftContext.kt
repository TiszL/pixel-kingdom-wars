package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.atomic.AtomicBoolean

/** Identity of existing local intent only. This never proves art residency or permits an order.
 * A retired token stays retired even when a StateFlow collector misses a brief refusal. */
class PhaseEConstructionDraftContext internal constructor(private val requireCurrent: () -> Unit) {
    private val retired = AtomicBoolean(false)
    fun isCurrent(): Boolean {
        if (retired.get()) return false
        return try { requireCurrent(); !retired.get() } catch (_: Exception) { false }
    }
    internal fun retire() { retired.set(true) }
    /** Atomic fence only; unlike isCurrent this invokes no caller code under provider locks. */
    internal fun isRetired(): Boolean = retired.get()
}

enum class PhaseEConstructionPreparation { PREPARING, READY, REFUSED }

/** The raw base identifies which preparation this status describes, never a construction price
 * or permission. Missing status is closed; null art must not be interpreted as PREPARING. */
class PhaseEConstructionPreparationState internal constructor(
    val context: PhaseEConstructionDraftContext?,
    internal val base: JsonObject,
    val phase: PhaseEConstructionPreparation,
)

/** One mounted provider/binder, two observations. Neither channel opens or owns another source. */
class PhaseEConstructionRuntime internal constructor(
    val constructionArt: StateFlow<PhaseEConstructionArt?>,
    val constructionPreparation: StateFlow<PhaseEConstructionPreparationState?>,
)
