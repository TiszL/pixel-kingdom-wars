package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.WorldParcelFailureKind
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomSheetKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapTagUi
import gg.pixelkingdomwars.nativeclient.ui.world.RealmHudBase
import gg.pixelkingdomwars.nativeclient.ui.world.RealmHudModel
import gg.pixelkingdomwars.nativeclient.ui.world.WorldUiState
import gg.pixelkingdomwars.nativeclient.ui.world.loadedCardTitle
import gg.pixelkingdomwars.nativeclient.ui.world.parcelDeadlines
import gg.pixelkingdomwars.nativeclient.ui.world.pendingCardTitle
import gg.pixelkingdomwars.nativeclient.ui.world.rivalAttackTag
import gg.pixelkingdomwars.nativeclient.ui.world.worldBlockReason
import gg.pixelkingdomwars.nativeclient.ui.world.worldDuration
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/*
 * The kingdom sheet's mapper (design/final/map/SPEC.md §2.3, map-base.png) over the same parcel read the old base card
 * drew (`ParcelCardBody`, ui/world/ParcelCard.kt): `WorldUiState.selected.detail` (player, shield, actions.scout and
 * actions.attack with allowed / blockedBy / keepReach), `globe.me.ownedTiles` (your own deed) and `parcelFailure` (land
 * gate, 429, other). Pure: no Compose, no view model and no clock of its own ([nowNanos] is the host's), so every rule
 * here runs on the JVM.
 *
 * Nothing is decided here that the read or the catalogue does not say: SCOUT and ATTACK are exactly `actions.*.allowed`;
 * a refusal is the server's `blockedBy` in words ([worldBlockReason]); "NO SHIELD" only when the read carries a shield
 * whose `active` is false; the shield time is the read's `remainingMs`; the Claim fact is the catalogue's table. ATTACK
 * has no price, because the read carries no energy field. Raids are instant, so no copy says travel or arrival.
 */

/** What the host does with a sheet command, by the command's id. Each one is an existing entry point (no new owner). */
internal enum class KingdomDoor(val id: FeatureId, val icon: String) {
    /** `WorldViewModel.scout()`. */
    SCOUT(FeatureId("map.scout"), "scout"),
    /** `WorldViewModel.attack()`. */
    ATTACK(FeatureId("map.attack"), "attack"),
    /** Your active deed: open that base. */
    GO_HOME(FeatureId("map.home"), "locate"),
    /** Your inactive deed: Your Bases. */
    MANAGE_DEED(FeatureId("map.manageDeed"), "itm_deed_earth"),
    /** Open land: `WorldViewModel.draftLand` into the land gate (registry row 95). */
    CHOOSE_THIS_LAND(FeatureId("map.buyLand"), "itm_deed_earth"),
    /** A land-gate refusal (402/403): the land gate. */
    CHOOSE_LAND(FeatureId("map.landGate"), "itm_deed_earth"),
    /** Any other refusal: `WorldViewModel.retryParcel()`. */
    RETRY(FeatureId("map.parcelRetry"), "replay"),
    /** Choose mode: the next open deed. */
    NEXT_OPEN_DEED(FeatureId("map.nextOpenDeed"), "shape:go"),
    /** The realm map's fly-in on the selected deed. */
    LOOK_CLOSER(FeatureId("map.lookCloser"), "locate");

    companion object {
        /** The door a command opens; null for no command (or an id this sheet never sets). */
        fun of(command: CommandUi?): KingdomDoor? = command?.let { c -> KingdomDoor.entries.firstOrNull { it.id == c.id } }
    }
}

/**
 * The kingdom sheet for the selected deed, or null when nothing is selected. [silhouette] is the map's own marker for
 * the deed (name and keep level while the read runs); [keepPortrait] and [claimTiles] are the catalogue's; [choose] is
 * the land chooser's mode (NEXT OPEN DEED in place of CHOOSE LAND).
 */
internal fun kingdomPanelUi(current: WorldUiState, columns: Int, rows: Int, realmName: String?, silhouette: RealmHudBase?, busy: Boolean,
    keepPortrait: (Int) -> String, claimTiles: (Int) -> Int?, nowNanos: Long, choose: Boolean): KingdomPanelUi? {
    val id = current.selectedTileId ?: return null
    val cols = columns.coerceAtLeast(1)
    val x = id % cols; val y = id / cols
    val parcel = current.selected
    val detail = parcel?.detail as? JsonObject
    val player = detail?.get("player") as? JsonObject
    val own = current.globe?.me?.ownedTiles?.firstOrNull { it.tileId == id }
    val failure = current.parcelFailure?.takeIf { it.tileId == id }
    val next = if (choose) kingdomCommand(KingdomDoor.NEXT_OPEN_DEED, "NEXT OPEN DEED", Verb.BLUE, busy = false, primary = false) else null
    val realmTags = listOfNotNull(realmName?.let { MapTagUi(it.uppercase(), Verb.STONE) })

    // Your own deed (SPEC §2.3 "Your own kingdom"): header + GO HOME. A player is never offered a raid on themself.
    if (own != null) {
        val level = player?.string("keepLevel")?.toIntOrNull() ?: own.keepLevel ?: silhouette?.level
        val title = if (detail != null) loadedCardTitle(player, true) else pendingCardTitle(silhouette, own, x, y)
        val home = if (own.active) kingdomCommand(KingdomDoor.GO_HOME, "GO HOME", Verb.BLUE, busy)
            else kingdomCommand(KingdomDoor.MANAGE_DEED, "MANAGE DEED", Verb.BLUE, busy)
        return KingdomPanelUi(id, KingdomSheetKind.OWN, title, kingdomLevelTag(level), level?.let(keepPortrait), emptyList(), emptyList(), null,
            null, null, home, null, false)
    }

    // No read yet: the map's silhouette, then the read's outcome (a refusal in the server's words).
    if (parcel == null) {
        val level = silhouette?.level
        val title = pendingCardTitle(silhouette, null, x, y)
        if (failure != null) {
            val primary = when {
                failure.kind != WorldParcelFailureKind.LAND_GATE -> kingdomCommand(KingdomDoor.RETRY, "RETRY", Verb.BLUE, busy = false)
                choose -> null
                else -> kingdomCommand(KingdomDoor.CHOOSE_LAND, "CHOOSE LAND", Verb.GOLD, busy)
            }
            return KingdomPanelUi(id, KingdomSheetKind.FAILED, title, kingdomLevelTag(level), level?.let(keepPortrait), realmTags, emptyList(), failure.message,
                null, null, primary, next, false)
        }
        return KingdomPanelUi(id, KingdomSheetKind.LOADING, title, kingdomLevelTag(level), level?.let(keepPortrait), realmTags, emptyList(),
            if (silhouette != null) "Loading details..." else "Checking this parcel...", null, null, null, next, false)
    }

    // An inspectable kingdom: SCOUT and ATTACK exactly as the server's actions say.
    if (detail != null) {
        val level = player?.string("keepLevel")?.toIntOrNull()
        val actions = detail["actions"] as? JsonObject
        val scout = actions?.get("scout") as? JsonObject
        val attack = actions?.get("attack") as? JsonObject
        val shield = detail["shield"] as? JsonObject
        val active = kingdomFlag(shield, "active")
        val tags = buildList {
            when {
                kingdomFlag(shield, "suppressedByWarzone") == true -> add(MapTagUi("SHIELD SUPPRESSED", Verb.RED))
                active == true -> {
                    val left = parcelDeadlines(detail, current.selectedAtNanos).firstOrNull { it.key.startsWith("shield:") }?.remaining(nowNanos)
                    add(MapTagUi(if (left != null) "SHIELD ${worldDuration(left)}" else "SHIELD", Verb.STONE))
                }
                // Only a read that says so: a missing shield object or flag is unknown, never a promise of no shield.
                active == false -> add(MapTagUi("NO SHIELD", Verb.RED))
            }
            rivalAttackTag(false, attack)?.let { add(MapTagUi(it.uppercase(), Verb.RED)) }
            addAll(realmTags)
        }
        val facts = RealmHudModel.cardFacts(player?.string("trophies")?.toLongOrNull(), player?.containsKey("clanTag") == true,
            player?.string("clanTag"), level?.let(claimTiles), x, y, cols, rows)
        return KingdomPanelUi(id, KingdomSheetKind.RIVAL, loadedCardTitle(player, false), kingdomLevelTag(level), level?.let(keepPortrait), tags, facts,
            failure?.message,
            kingdomAction(scout, KingdomDoor.SCOUT, "SCOUT", primary = false, verb = Verb.BLUE, sub = null, busy = busy),
            kingdomAction(attack, KingdomDoor.ATTACK, "ATTACK", primary = true, verb = Verb.RED, sub = "raid this kingdom", busy = busy),
            null, next, facts.isNotEmpty())
    }

    // Land: open (CHOOSE THIS LAND), or held / reserved / assigned (its reason; RETRY after a failed re-read).
    val facts = buildList {
        realmName?.let { add("Realm" to it) }
        add("Parcel" to "$x, $y")
        add("Location" to RealmHudModel.lonLat(x, y, cols, rows))
    }
    if (parcel.available) {
        return KingdomPanelUi(id, KingdomSheetKind.OPEN_LAND, "Open deed", null, null, realmTags, facts, failure?.message ?: "No kingdom yet · wild land",
            null, null, kingdomCommand(KingdomDoor.CHOOSE_THIS_LAND, "CHOOSE THIS LAND", Verb.GOLD, busy), next, true)
    }
    val note = when (parcel.availability) {
        "held" -> "Another checkout currently holds this parcel."
        "reserved" -> parcel.tile.allocation?.let { "${it.uppercase()} reserve · not available for ordinary purchase." }
            ?: "Reserved · not available for ordinary purchase."
        else -> "This land is already assigned. Its base is not currently available for inspection."
    }
    val retry = failure?.takeIf { it.kind != WorldParcelFailureKind.LAND_GATE }?.let { kingdomCommand(KingdomDoor.RETRY, "RETRY", Verb.BLUE, busy = false) }
    return KingdomPanelUi(id, KingdomSheetKind.CLOSED_LAND, "Deed $x, $y", null, null, realmTags, facts, failure?.message ?: note,
        null, null, retry, next, true)
}

/**
 * The routine-refresh rule: while a re-read of the SAME deed is running ([fresh] is LOADING), the sheet keeps the
 * kingdom it already showed ([last], a RIVAL or OWN for that tile) with its commands BUSY, instead of falling back to
 * the silhouette and blanking what the player was reading. A refusal, another deed or any other state shows [fresh].
 */
internal fun keptKingdomPanel(fresh: KingdomPanelUi, last: KingdomPanelUi?): KingdomPanelUi {
    if (fresh.kind != KingdomSheetKind.LOADING || last == null || last.tileId != fresh.tileId) return fresh
    if (last.kind != KingdomSheetKind.RIVAL && last.kind != KingdomSheetKind.OWN) return fresh
    fun held(c: CommandUi?) = c?.copy(state = CommandState.BUSY)
    return last.copy(scout = held(last.scout), attack = held(last.attack), primary = held(last.primary), secondary = fresh.secondary)
}

/** The realm map's LOOK CLOSER ("VIEW DEED" on land with no kingdom), added by the host when it can fly in. */
internal fun lookCloserCommand(kingdom: Boolean): CommandUi =
    kingdomCommand(KingdomDoor.LOOK_CLOSER, if (kingdom) "LOOK CLOSER" else "VIEW DEED", Verb.STONE, busy = false, primary = false)

/** SCOUT or ATTACK from the read's `actions.*`: BUSY while an action runs, ENABLED only when `allowed` is true, else
 *  DISABLED with the server's `blockedBy` in words (a missing reason still says "Temporarily unavailable"). */
private fun kingdomAction(o: JsonObject?, door: KingdomDoor, caption: String, primary: Boolean, verb: Verb, sub: String?, busy: Boolean): CommandUi {
    val allowed = kingdomFlag(o, "allowed") == true
    val reason = if (allowed) null else worldBlockReason(o?.string("blockedBy").orEmpty(), o?.get("keepReach") as? JsonObject)
    val state = when { busy -> CommandState.BUSY; allowed -> CommandState.ENABLED; else -> CommandState.DISABLED }
    return CommandUi(door.id, door.icon, caption, null, primary, state, reason, null, verb = verb, sub = sub)
}

private fun kingdomCommand(door: KingdomDoor, caption: String, verb: Verb, busy: Boolean, primary: Boolean = true): CommandUi =
    CommandUi(door.id, door.icon, caption, null, primary, if (busy) CommandState.BUSY else CommandState.ENABLED, null, null, verb = verb)

/** A boolean the read sent; null when the key is missing or not a boolean (never guessed). */
private fun kingdomFlag(o: JsonObject?, key: String): Boolean? = (o?.get(key) as? JsonPrimitive)?.booleanOrNull

private fun kingdomLevelTag(level: Int?): String? = level?.let { "LV $it" }
