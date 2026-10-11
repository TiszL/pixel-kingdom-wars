package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*

/** V1 alone sends an idempotency key. Old legacy clan journals must never enter this protocol. */
class ClanCommandSpec(override val kind: String, private val cluster: String) : MoneyOpSpec<ClanCommandReceipt> {
    init { require(kind in setOf(IntentKind.CLAN_LEAVE, IntentKind.CLAN_KICK)); require(cluster in setOf("devnet", "mainnet-beta")) }
    private val action = if (kind == IntentKind.CLAN_LEAVE) "leave" else "kick"
    /** The by-key status answers `receipt: null` only for this wallet's exact key (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    val path = "/clans/v1/$action"
    fun intent(wallet: String, key: String, clan: String, name: String, base: String?, target: String?): PendingIntent {
        ClanCommandContract.wallet(wallet); ClanCommandContract.id(key); ClanCommandContract.id(clan)
        base?.let(ClanCommandContract::id); target?.let(ClanCommandContract::wallet)
        require(name.isNotBlank()); require(if (action == "leave") target == null else target != null && base == null)
        return PendingIntent(kind, wallet, base, key, path, buildJsonObject {
            put("idempotencyKey", key); put("clanId", clan)
            if (action == "leave") put("baseId", base?.let(::JsonPrimitive) ?: JsonNull) else put("wallet", target)
        }, if (action == "leave") "Leave $name" else "Remove clan member", buildJsonObject {
            put("clanName", name); put("clanId", clan); put("cluster", cluster)
        })
    }
    fun validate(intent: PendingIntent) {
        require(intent.kind == kind); val quote = requireNotNull(intent.quote)
        val expected = this.intent(intent.wallet, intent.idempotencyKey, ClanCommandContract.text(quote, "clanId"),
            ClanCommandContract.text(quote, "clanName"), intent.baseId,
            if (action == "kick") ClanCommandContract.text(intent.body, "wallet") else null)
        require(intent.path == expected.path && intent.body == expected.body && quote == expected.quote)
    }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest {
        validate(intent); return ReceiptRequest("/clans/v1/commands/${intent.idempotencyKey}", emptyMap())
    }
    private fun match(intent: PendingIntent, raw: JsonObject): ClanCommandReceipt {
        validate(intent)
        return ClanCommandReceipt.from(raw).also { r ->
            require(r.actor == intent.wallet && r.idempotencyKey == intent.idempotencyKey && r.kind == action &&
                r.clanId == ClanCommandContract.text(intent.body, "clanId") && r.baseId == intent.baseId &&
                r.target == (if (action == "kick") ClanCommandContract.text(intent.body, "wallet") else null))
        }
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ClanCommandReceipt> = try {
        validate(intent); val status = ClanCommandStatus.from(response)
        require(status.wallet == intent.wallet && status.idempotencyKey == intent.idempotencyKey)
        if (status.receipt == null) Receipt.Unknown else Receipt.Accepted(match(intent, response["receipt"]!!.jsonObject), ReceiptDocument.fromReceiptRoute(response))
    } catch (_: Exception) { throw ApiCompatibilityException("/clans/v1/commands/${intent.idempotencyKey}") }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): ClanCommandReceipt = match(intent, response)
    override fun restore(intent: PendingIntent, document: JsonObject): ClanCommandReceipt = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        ReceiptDocument.SOURCE_RECEIPT -> requireNotNull((decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value)
        else -> error("Unrecognized clan command proof")
    }
}
