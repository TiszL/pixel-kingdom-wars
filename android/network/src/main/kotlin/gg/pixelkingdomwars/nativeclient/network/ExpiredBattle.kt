package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** Only the current unstarted-live expiry shape is understood. Old/unknown
 * terminal formats keep recovery data rather than being inferred from an empty pending list. */
internal fun requireExpiredReservation(value: JsonObject, previous: LiveBattleState): List<JsonObject> {
    require(value.string("source")=="live" && value.string("status")=="expired" && value.string("raidProtocolVersion")=="2")
    require(value["result"]==JsonNull && (value["events"] as? JsonArray)?.isEmpty()==true)
    val clock=requireNotNull(value["clock"] as? JsonObject)
    val parsed=runCatching { BattleClock.read(clock,0) }.getOrElse {
        throw IllegalArgumentException("Expired reservation clock is invalid",it)
    }
    require(clock.battleInt("protocolVersion")==2 && clock["anchorWallAt"]==JsonNull && clock["battleEndsAt"]==JsonNull &&
        clock.battleInt("anchorSimMs")==0 && clock.battleInt("simNowMs")==0 && parsed.value.revision==0L && parsed.value.rate==1) {
        "Started battle expiry requires another recovery format"
    }
    val commands=requireNotNull(value["commands"] as? JsonArray).map { it.jsonObject }
    require(commands.size<=CLIENT_COMMAND_CEILING && value.battleInt("lastSequence")==commands.size-1)
    require(commands.mapIndexed { index,command -> command.battleInt("sequence")==index }.all { it })
    val ids=commands.map { it.battleString("clientCommandId").also { id -> require(id.isNotBlank()) } }
    require(ids.toSet().size==ids.size)
    // Canonical v2 expiry excludes armed/started raids. Only a prestart buff
    // can be accepted without crossing that irreversible lifecycle boundary.
    require(commands.all { it.string("kind")=="buff" }) { "Expired reservation contains a started battle command" }
    require(previous.result==null) { "Expiry contradicts the persisted battle result" }
    previous.clock?.value?.let {
        require(it.protocolVersion==2 && it.revision==0L && it.rate==1 && it.anchorWallAt==null &&
            it.battleEndsAt==null && it.anchorSimMs==0L && it.simNowMs==0L) { "Expiry contradicts the observed battle clock" }
    }
    // The complete terminal journal may add unseen buffs, but cannot erase or
    // rewrite any immutable command receipt already acknowledged by the server.
    val receiptFields=listOf("sequence","clientCommandId","kind","serverOffsetMs","acceptedAt")
    require(previous.commands.all { known ->
        val terminal=commands.getOrNull(known.battleInt("sequence"))
        terminal!=null && receiptFields.all { terminal[it]==known[it] } &&
            (terminal["payload"] as? JsonObject)?.get("buff")== (known["payload"] as? JsonObject)?.get("buff")
    }) { "Expiry contradicts the accepted battle journal" }
    return commands
}
