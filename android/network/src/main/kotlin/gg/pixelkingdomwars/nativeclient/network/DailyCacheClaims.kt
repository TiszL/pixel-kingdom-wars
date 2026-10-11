package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.DailyCacheClaim
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** The daily cache claim (web `ClaimScreen` → `POST /mine/claim`). One POST; a definitive refusal paid
 * nothing. A lost reply is reconciled by re-reading `/mine/status`: the server marks the claimed day in
 * the same transaction that credits the cache, so a cache that was claimable before and is not after
 * was paid (its amount is then unknown, never guessed). Nothing is resent automatically. */
suspend fun claimDailyCache(
    before: MineStatus?,
    readStatus: suspend () -> JsonObject,
    sendClaim: suspend () -> JsonObject,
): DailyCacheClaim? {
    try { return DailyCacheClaim.from(sendClaim()) }
    catch (e: CancellationException) { throw e }
    catch (e: Exception) {
        // Validation, auth and rate limits reject before the credit; only a lost reply can have paid.
        if (e is ApiException && e.status < 500) throw e
        if (before?.cache?.claimable != true) throw e
        val after = try { MineStatus.from(readStatus()) } catch (cancel: CancellationException) { throw cancel }
            catch (readError: Exception) { if (readError is ApiException && readError.status == 401) throw readError; throw e }
        if (after.cache?.claimable == false) return null
        throw e
    }
}
