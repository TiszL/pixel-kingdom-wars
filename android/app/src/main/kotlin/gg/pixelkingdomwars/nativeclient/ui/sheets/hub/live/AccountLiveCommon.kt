package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.ui.economy.starterLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Shared pure pieces of the hub-side LIVE mappers written in this lane: `PassportLiveMapper.kt` (Lodge › PASSPORT,
 * `PassportUi`) and `AccountLiveMapper.kt` (Profile card header + KINGDOMS / WALLET / ACCOUNT tabs). State sources:
 * `RealmPassportRepository.state`, `AccountRepository.state`, `BaseRepository.state`, `EconomyRepository.state` and the
 * content catalogue, all read by the caller and handed in as plain data. No Compose UI, no repository, no network.
 */

/** The reason every money action of these sheets gives while its payment path is not bound (task rule: MS-M3 owns
 *  land purchase, faucet claims and every other spend; this lane never charges anything). */
internal const val MONEY_WIRING_PENDING: String = "wiring pending: MS-M3"

/** A realm's full display name: the native alias of `packages/shared/src/baseVisual.ts` REALM_NAMES (`starterLabel`),
 *  so `seeker-reach` is always "Solana Reach", never shortened. Blank or null is "…". */
internal fun liveRealmName(realmId: String?): String = realmId?.takeIf { it.isNotBlank() }?.let(::starterLabel) ?: UNKNOWN

/** Keep art tier 1..4 by the catalogue's `constants.ART_V2` rule (same rule as `army.live.buildingPortrait`); tier 1
 *  when the level or the rule is unknown (the portrait is art only, never a number shown to the player). */
internal fun keepTierOf(level: Int?, catalogue: JsonObject?): Int {
    val art = (catalogue?.get("constants") as? JsonObject)?.get("ART_V2") as? JsonObject
    val perTier = (art?.get("levelsPerTier") as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it > 0 }
    val tiers = (art?.get("tiers") as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it > 0 }
    if (level == null || perTier == null || tiers == null) return 1
    return ((level.coerceAtLeast(1) - 1) / perTier + 1).coerceIn(1, minOf(tiers, 4))
}

/** A SOL price the client does not know yet: CHECKING draws "…" and keeps the door enabled navigation (design
 *  correction 7). Land is priced only by the server's reservation / RPC estimate, never by this client. */
internal fun solPriceChecking(description: String = "Price shown at checkout"): PriceUi =
    PriceUi(Currency.SOL, null, PriceStatus.CHECKING, description = description)

/** "2 min ago" between a server instant and the device clock (skew clamped to "just now"); null when the instant is
 *  missing or not ISO-8601. */
internal fun agoLabel(iso: String?, nowMs: Long): String? {
    val at = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return null
    val seconds = ((nowMs - at) / 1000).coerceAtLeast(0)
    return when {
        seconds < 60 -> "just now"
        seconds < 3_600 -> "${seconds / 60} min ago"
        seconds < 86_400 -> "${seconds / 3_600} h ago"
        else -> "${seconds / 86_400} d ago"
    }
}
