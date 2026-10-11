package gg.pixelkingdomwars.nativeclient.ops

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Money-operation kinds. One outstanding intent per kind per wallet; a saved intent of a kind
 * blocks new intents of that kind until it is resolved by a receipt, closure or explicit retirement. */
object IntentKind {
    const val TRAINING_BATCH = "training-batch"
    const val TRAINING_CANCEL = "training-cancel"
    const val TRAINING_FINISH = "training-finish"
    const val CONSTRUCTION = "construction"
    const val RESEARCH = "research"
    /** Land checkout reservation (`POST /deposits` kind entry|deed): reserves a tile, moves no money. */
    const val LAND_RESERVATION = "land-reservation"
    /** Wall row upgrade (`POST /base/walls/:id/upgrade-row`): one quoted SHARD purchase, replayed by key. */
    const val WALL_ROW = "wall-row"
    const val WALL_BATCH = "wall-batch-v1"
    /** Second layout slot unlock (`POST /base/layouts/FARM/unlock`): one SHARD spend, replayed by key. */
    const val LAYOUT_UNLOCK = "layout-unlock"
    /** Hero level purchase (`POST /heroes/:hero/upgrade`) and paid recovery finish (`POST /heroes/:hero/recovery/speedup`): KEEP. */
    const val HERO_UPGRADE = "hero-upgrade"
    const val HERO_RECOVERY = "hero-recovery"
    const val HERO_RECRUITMENT = "hero-recruitment-v1"
    /** Shop purchase (`POST /items/buy`, KEEP) and consumable use (`POST /items/use`, spends the owned unit). */
    const val ITEM_BUY = "item-buy"
    const val ITEM_USE = "item-use"
    /** Mail claim is intrinsically idempotent by immutable mail UUID, not a new request UUID. */
    const val MAIL_CLAIM = "mail-claim"
    /** Existing clan management; leave may credit a SHARDS chest, so uncertain changes stay journaled. */
    const val CLAN_LEAVE = "clan-leave"
    const val CLAN_KICK = "clan-kick"
    /** Kept for receipts saved by old clients; new Gems flows never create this kind. */
    const val KEEP_CONVERSION = "keep-conversion"
    const val GEMS_FROM_KEEP = "gems-from-keep"
    const val GEMS_TO_SHARDS = "gems-to-shards"
    const val GEMS_TASK_CLAIM = "gems-task-claim"
    const val FORGE_CONTRIBUTION = "forge-contribution"
    const val FORGE_CLAIM = "forge-claim-v1"
    const val WITHDRAWAL = "withdrawal-request"
    /** Cancelling/refunding the exact existing withdrawal is intrinsically row-idempotent. */
    const val WITHDRAWAL_UNWIND = "withdrawal-unwind"
    const val MARKET_LIST = "market-list"
    const val MARKET_RESERVE = "market-reserve"
    const val MARKET_CANCEL = "market-cancel"
    val all: Set<String> = setOf(TRAINING_BATCH, TRAINING_CANCEL, TRAINING_FINISH, CONSTRUCTION, RESEARCH, LAND_RESERVATION, WALL_ROW, LAYOUT_UNLOCK,
        HERO_UPGRADE, HERO_RECOVERY, HERO_RECRUITMENT, ITEM_BUY, ITEM_USE, MAIL_CLAIM, CLAN_LEAVE, CLAN_KICK, KEEP_CONVERSION, FORGE_CONTRIBUTION, FORGE_CLAIM, WITHDRAWAL,
        MARKET_LIST, MARKET_RESERVE, MARKET_CANCEL, WITHDRAWAL_UNWIND, WALL_BATCH, GEMS_FROM_KEEP, GEMS_TO_SHARDS, GEMS_TASK_CLAIM)
}

/** Durable intent only: the exact body that was (or will be) POSTed, the quote or target the player
 * consented to, and — once known — the receipt the server issued. Never balances or snapshots.
 *
 * [attempted] is set before the POST leaves the device; [receipt] is set the moment acceptance is
 * proven and survives until the domain snapshot has been re-read (hydrate-before-publish). */
@Serializable data class PendingIntent(
    val kind: String,
    val wallet: String,
    val baseId: String?,
    val idempotencyKey: String,
    val path: String,
    val body: JsonObject,
    val label: String,
    val quote: JsonObject? = null,
    val attempted: Boolean = false,
    val receipt: JsonObject? = null,
    /** K155 command-local header, frozen with the body. Absent legacy requests never opt in. */
    val expectedCurrency: String? = null,
    /** Durable dispatch generation. Missing legacy values mean zero, never a proven first response. */
    val attemptRevision: Long = 0,
) {
    // Owner review 2026-10-06 (m2): device-side facts about a request (attempt time, last answer, a refused retry) live in
    // the journal's "facts" map (PendingIntentStore), never here, so an older build's strict decoder still reads every intent.
    init {
        require(kind in IntentKind.all) { "Unknown money operation kind" }
        require(wallet.isNotBlank() && label.isNotBlank())
        require(idempotencyKey.length in 8..128) { "Invalid idempotency key" }
        require(path.startsWith('/') && !path.startsWith("//") && !path.contains('?') && !path.contains('#') && !path.contains(".."))
        require(attemptRevision >= 0 && (attempted || attemptRevision == 0L)) { "Invalid dispatch revision" }
        require(receipt == null || attempted) { "A receipt proves an attempted request" }
        require(expectedCurrency == null || expectedCurrency in setOf("KEEP", "GEMS"))
    }
    /** Called before dispatch, including retries; overflow fails closed without changing storage. */
    fun nextAttempt(): PendingIntent {
        check(receipt == null) { "Accepted requests cannot be resent" }
        check(attemptRevision < Long.MAX_VALUE) { "Saved request dispatch revision is exhausted" }
        return copy(attempted = true, attemptRevision = attemptRevision + 1)
    }
    val identity: IntentIdentity get() = IntentIdentity(kind, wallet)
}

data class IntentIdentity(val kind: String, val wallet: String)
