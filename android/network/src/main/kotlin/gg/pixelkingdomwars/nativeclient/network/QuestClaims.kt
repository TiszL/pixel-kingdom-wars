package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** Claims use the permanent server quest identity. A lost reply is reconciled by
 * reading that base's board; never infer a credit or automatically repeat a POST. */
suspend fun claimQuestReward(
    questId: String,
    readBoard: suspend () -> JsonObject,
    sendClaim: suspend () -> Unit,
): JsonObject {
    require(questId.matches(Regex("[0-9a-fA-F-]{36}")))
    val before = readBoard()
    val quest = before.objects("quests").firstOrNull { it.string("id") == questId }
        ?: error("This quest is no longer on this base's board. Refresh your quests.")
    if (quest.flag("claimed")) return before
    check(quest.flag("completed")) { "Complete this quest before claiming its reward." }
    try { sendClaim() }
    catch (e: CancellationException) { throw e }
    catch (e: Exception) {
        // A revoked session must be handled by the account boundary immediately.
        if (e is ApiException && e.status == 401) throw e
        val after = try { readBoard() } catch (cancel: CancellationException) { throw cancel }
            catch (readError: Exception) { if(readError is ApiException && readError.status == 401) throw readError; throw e }
        if (after.objects("quests").any { it.string("id") == questId && it.flag("claimed") }) return after
        throw e
    }
    return readBoard()
}
