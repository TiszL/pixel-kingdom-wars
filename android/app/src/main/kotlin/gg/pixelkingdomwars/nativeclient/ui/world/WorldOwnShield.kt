package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.model.FantasyMarker
import gg.pixelkingdomwars.nativeclient.model.FantasyOwnedTile
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Your own shield on the realm map (N3's shield domes). Every kingdom's dome comes from the realm feed's `shielded`
 * (D-181, [realmHudBases]); the `/base` read the Home screen holds for your selected base can only ADD its dome (a
 * shield the feed has not polled yet, such as one you just bought), timed by that read so it goes the moment the shield
 * ends. It never removes a dome the feed shows: a Home read can predate the shield (QA's fixtures, or a raid-loss shield
 * that lands with no Home refresh), and the feed is the raid gate's own answer at its read. The read's `shield` decides
 * it (base.ts, baseShields.ts `resolveEffectiveShieldStatus`):
 * - `null` means no shield;
 * - `active: false` means none, or an ordinary shield a warzone suppresses (not protection, so no dome);
 * - otherwise `remainingMs` counts down on the monotonic clock from when the world saw the read, as [WorldDeadline]
 *   does. The device calendar never decides it.
 */
class WorldOwnShield private constructor(val baseId: String, private val clock: WorldDeadline?) {
    /** True or false for the base this read belongs to; null (unknown, no dome) for any other base. */
    fun shielded(baseId: String, nowNanos: Long): Boolean? =
        if (!baseId.equals(this.baseId, ignoreCase = true)) null else clock != null && clock.remaining(nowNanos) > 0

    /** Monotonic ms until the dome goes, or null when there is no dome to time. */
    fun remainingMs(nowNanos: Long): Long? = clock?.remaining(nowNanos)?.takeIf { it > 0 }

    companion object {
        /** From the Home read's base id and raw `/base` body, seen at [receivedAtNanos]. Null when there is no read, or it
         *  carries no `shield` field (unknown: no dome, and nothing claims the base is unshielded). */
        fun from(baseId: String?, raw: JsonObject?, receivedAtNanos: Long): WorldOwnShield? {
            val id = baseId?.takeIf { it.isNotBlank() } ?: return null
            if (raw == null || !raw.containsKey("shield")) return null
            val shield = raw["shield"] as? JsonObject ?: return WorldOwnShield(id, null)
            val active = (shield["active"] as? JsonPrimitive)?.booleanOrNull == true
            val left = (shield["remainingMs"] as? JsonPrimitive)?.longOrNull
            return WorldOwnShield(id, if (active && left != null && left > 0) WorldDeadline("shield", left, receivedAtNanos) else null)
        }
    }
}

/**
 * The realm map's bases in [realmId]: first the kingdoms of the bounded viewport read in this realm, then your own deeds
 * here that the read did not carry. Every kingdom carries the feed's `shielded` (D-181, owner: a dome on EVERY shielded
 * kingdom, as the web; server PR #147), so each shielded one gets a dome, and each one the feed called unshielded passes
 * the UNSHIELDED chip (SHARDKEEP D-191), yours included. An older server omits the bit: such a kingdom's shield stays
 * null, unknown, so it draws no dome and never passes UNSHIELDED (the realm map hides the chip, [HudChips.realm]; an
 * absent bit is never read as "open to a raid", D-169 / D-181). Your selected base's Home read ([own]) adds a dome the
 * feed does not show yet and times it; it never hides the feed's (code 30 on the Seeker: a Home read without a shield
 * read before the shield existed would have cleared the feed's dome), and it answers for your own base when the feed
 * carried no bit. Your other deeds the feed did not carry stay unknown (null, no dome). [realmOf] maps a catalog tile to
 * its realm.
 * A missing or blank name reads "Keeper", and "Your kingdom" on your own deeds ([kingdomName], [RealmHudBase.nameless]),
 * the name the app already gives a player with no name (`Identity.displayName`, the home bar's YOUR KINGDOM). At map zoom the name tag is all a kingdom shows
 * (D-NEXT); code 31 on the Seeker drew the owner's own tag with an empty name, then as a stranger's "Keeper". Each base
 * carries its owner's profile image path ([RealmHudBase.avatarUrl]) for that tag.
 */
internal fun realmHudBases(realmId: String?, markers: List<FantasyMarker>, owned: List<FantasyOwnedTile>, realmOf: (Int) -> String?,
                           columns: Int, own: WorldOwnShield?, nowNanos: Long): List<RealmHudBase> {
    val mine = owned.filter { it.realmId == realmId }.associateBy { it.tileId }
    fun ownRead(tileId: Int): Boolean? = mine[tileId]?.let { own?.shielded(it.baseId, nowNanos) }
    val fromFeed = markers.filter { m -> realmOf(m.tileId) == realmId }.map { m ->
        val ownUp = ownRead(m.tileId)
        RealmHudBase(m.tileId, m.tileId % columns, m.tileId / columns, kingdomName(m.name, m.tileId in mine), m.keepLevel ?: 1, m.tileId in mine,
            shield = if (m.shieldUp || ownUp == true) true else m.shielded ?: ownUp, avatarUrl = m.avatarUrl, nameless = m.name.isNullOrBlank())
    }
    val known = fromFeed.mapTo(HashSet()) { it.tileId }
    return fromFeed + mine.values.filter { it.tileId !in known }.map {
        RealmHudBase(it.tileId, it.tileId % columns, it.tileId / columns, kingdomName(it.name, true), it.keepLevel ?: 1, true,
            shield = ownRead(it.tileId), avatarUrl = it.avatarUrl, nameless = it.name.isNullOrBlank())
    }
}

/** A nameless player's own kingdom, as `Identity.displayName` names it. */
internal const val YOUR_KINGDOM = "Your kingdom"
/** A nameless rival's kingdom. */
internal const val KEEPER = "Keeper"

/**
 * The one rule that names a kingdom on the world screens: its player's name, or, when the feed or the parcel read has
 * none (null, empty or blank), [YOUR_KINGDOM] for your own and [KEEPER] for anyone else's. The map tag, the card while
 * it loads and the loaded card all use it, so a kingdom's name never flips as the card fills in (integration review of
 * 560fe54: the owner's own nameless kingdom read "Your kingdom" on its tag, then a blank title once its card loaded).
 */
internal fun kingdomName(name: String?, yours: Boolean): String = name?.takeIf { it.isNotBlank() } ?: if (yours) YOUR_KINGDOM else KEEPER
