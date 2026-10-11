package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.serialization.json.*
import java.math.BigInteger

internal const val PAID_KEY = "00000000-0000-4000-8000-000000000017"
internal const val PAID_DEPOSIT = "00000000-0000-4000-8000-000000000018"
internal const val PAID_BUILDING = "00000000-0000-4000-8000-000000000019"
internal const val PAID_OTHER = "00000000-0000-4000-8000-000000000020"
internal const val PAID_LAND = "2026-09-01T00:00:00.000Z"
internal const val PAID_NOW = "2026-09-13T00:00:00.000Z"
internal val PAID_SIGNATURE = base58(ByteArray(64) { 21 })
internal val PAID_REFERENCE = base58(ByteArray(32) { 2 })
internal fun paidCatalogue() = json("""{"constants":{"RAID_ENERGY":{"solLamportsPerEnergy":31,"packLamports":97,"packSize":5},"SHIELD":{"extendCostSolLamports":300000001,"extendHours":7},"WARZONE":{"shieldCostSolLamports":1027,"shieldDurationHours":11,"shieldLiquidityDirectBps":3333},"CAPS":{"buildersMax":3,"builderPricesSol":[0.5,0.75],"expansionsMax":2,"claimTilesByExpansion":[14,16,18],"expansionReqKeepLevel":[3,6],"expansionPriceSolByIndex":[0.15,0.25]},"STRUCTURES":{"mine":{"maxLevel":6},"goldforge":{"maxLevel":6}},"UPGRADE_COSTS":{"mine":[1,2,3,31,47],"goldforge":[13,23,33,43,53]},"UPGRADE_TIMES_SEC":{"mine":[1,2,3,37,49],"goldforge":[19,29,39,49,59]},"LAND_CHECKOUT_RECOVERY":{"requestTimeoutMs":15000}},"display":{"upgradeSolLamports":{"mine":{"5":"17000000","6":"19000000"},"goldforge":{"2":"23000000"}}}}""")
internal fun paidBase(): JsonObject = baseJson().let { raw -> JsonObject(raw + mapOf(
    "player" to JsonObject(raw.getValue("player").jsonObject + ("keepLevel" to JsonPrimitive(6))),
    "buildings" to buildJsonArray { add(buildJsonObject { put("id", PAID_BUILDING); put("type", "mine"); put("level", 4); put("tx", 10); put("ty", 10) }) }
)) }
internal fun paidOffer(kind: String = "builder") = requireNotNull(basePurchaseOffer(paidCatalogue(), BaseSnapshot.from(paidBase()), kind, if (kind == "mine") PAID_BUILDING else null))
internal fun paidQuote(request: BasePurchaseRequest = paidOffer().request(PAID_KEY), wallet: String = WALLET): BasePurchaseQuote {
    val offer = paidOffer(request.kind); val a = ChainAddresses.DEVNET
    return BasePurchaseQuote.from(buildJsonObject {
        put("version", 1); put("depositId", PAID_DEPOSIT); put("wallet", wallet); put("request", request.raw)
        put("baseEpoch", buildJsonObject { put("landPaidAt", PAID_LAND); put("deedAssetId", JsonNull) })
        put("reference", PAID_REFERENCE); put("amountLamports", offer.amountLamports); put("quotedCostShards", offer.maxCostShards?.let(::JsonPrimitive) ?: JsonNull)
        offer.energyQuantity?.let { put("energyQuantity", it) }
        put("rail", buildJsonObject { put("cluster", "devnet"); put("coreProgram", a.coreProgram); put("configPda", a.config); put("treasuryLiquidity", a.treasuryLiquidity); put("treasuryDev", a.treasuryDev); put("treasuryOps", a.treasuryOps); put("systemProgram", "11111111111111111111111111111111")
            put("mode", when (request.kind) { "builder", "shield", "energy", "energy_pack" -> "buy_sink"; "warzone_shield" -> "warzone_split"; else -> "sol_transfer" })
            put("sinkKind", when (request.kind) { "energy" -> JsonPrimitive(3); "energy_pack" -> JsonPrimitive(7); "builder" -> JsonPrimitive(8); "shield" -> JsonPrimitive(4); "warzone_shield" -> JsonPrimitive(6); else -> JsonNull })
            put("destination", if (request.kind in setOf("builder", "shield", "energy", "energy_pack")) JsonNull else JsonPrimitive(a.treasuryLiquidity))
            offer.directLamports?.let { put("directLamports", it) }; offer.splitLamports?.let { put("splitLamports", it) } })
        put("createdAt", PAID_NOW); put("payableUntil", "2026-09-13T00:10:00.000Z"); put("retryAt", "2026-09-13T00:11:00.000Z")
    })
}
internal fun paidState(q: BasePurchaseQuote = paidQuote(), status: String = "pending", signature: String? = null, shieldGranted: Boolean = true): BasePurchaseState = BasePurchaseState.from(buildJsonObject {
    put("quote", q.raw); put("status", status); put("paymentSignature", signature?.let(::JsonPrimitive) ?: JsonNull)
    val credited = status == "credited"; val terminalPaid = credited || status == "failed"
    put("txSignature", if (terminalPaid) JsonPrimitive(signature ?: PAID_SIGNATURE) else JsonNull); put("amount", if (terminalPaid) JsonPrimitive(q.amountLamports) else JsonNull)
    put("finalizedAt", if (terminalPaid) JsonPrimitive("2026-09-13T00:01:00.000Z") else JsonNull)
    put("receipt", if (!credited) JsonNull else buildJsonObject {
        put("version", 1); put("depositId", q.depositId); put("acceptedAt", "2026-09-13T00:01:00.000Z"); put("txSignature", requireNotNull(signature)); put("amountLamports", q.amountLamports)
        if (q.request.kind in setOf("shield", "warzone_shield")) put("shield", buildJsonObject {
            put("granted", shieldGranted); put("expiresAt", if (shieldGranted) JsonPrimitive("2026-09-15T00:01:00.000Z") else JsonNull)
        })
        q.energyQuantity?.let { quantity -> put("energy", buildJsonObject { put("quantity", quantity) }) }
        put("shards", q.quotedCostShards?.let { buildJsonObject { put("receiptId", PAID_OTHER); put("currency", "SHARDS"); put("amount", it) } } ?: JsonNull)
    })
})
internal fun paidStatus(key: String, p: BasePurchaseState? = null, enabled: Boolean = true, serverNow: String = PAID_NOW) = buildJsonObject {
    put("version", 1); put("wallet", WALLET); put("idempotencyKey", key); put("enabled", enabled); put("serverNow", serverNow); put("purchase", p?.raw ?: JsonNull)
}

internal class PaidFixture {
    val holder = testHolder(); val session = signedIn(holder); val disk = MemoryStore()
    val store = BasePurchaseStore(disk, WALLET, session.origin, "devnet")
    var base: String? = BASE_ID; var catalogue = paidCatalogue(); var now = 0L; var allowed = true; var enabled = true; var supported = true
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(
        BaseSummary(BASE_ID, "active", slot = 1, landPaidAt = PAID_LAND), BaseSummary(PAID_OTHER, "active", slot = 2, landPaidAt = PAID_LAND)))
    var beforeGet: suspend (String) -> Unit = {}; var onAccount: suspend () -> Unit = {}; var beforePrepare: suspend () -> Unit = {}
    var afterQuote: suspend () -> Unit = {}; var onVerify: suspend () -> Unit = {}; var onHydrate: suspend () -> Unit = {}
    var serverNow = PAID_NOW
    /** Device wall clock and the cluster's verdict on a recorded signature ([UnpaidAttempt]). */
    var wall = 1_000_000L; var landings = 0; var landing: suspend (String) -> SignatureLanding = { error("No signature was recorded") }
    /** The last-valid block height of the prepared payment's blockhash; null is a payment prepared without one. */
    var lastValid: Long? = 500L
    var hydrated = 0; var prepared = 0; var baseRaw = paidBase(); var balance = "999999"; var row: BasePurchaseState? = null
    var quoteReplyLost = false; var quoteNotAccepted = false; var quoteChange: (BasePurchaseQuote) -> BasePurchaseQuote = { it }
    var quoteRejected = false; var cancelReplyLost = false; var cancelled = false
    var cancelChange: (JsonObject) -> JsonObject = { it }
    var getChange: (JsonObject) -> JsonObject = { it }; var verifyFail = false
    val gets = mutableListOf<Pair<String, Map<String, String>>>(); val posts = mutableListOf<Pair<String, JsonObject>>()
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets += path to query; beforeGet(path)
            return getChange(when {
                path.startsWith(BasePurchaseRepository.PATH + "/") -> {
                    if (!supported) throw ApiException(404, null, "unsupported")
                    val key = path.substringAfterLast('/'); paidStatus(key, row?.takeIf { it.quote.request.key == key }, enabled, serverNow)
                }
                path == "/base" -> { check(query["baseId"] == BASE_ID); baseRaw }
                path == "/balances" -> balancesJson(balance)
                path == "/tutorial" -> tutorialJson()
                else -> error("Unexpected GET $path")
            })
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            posts += path to body
            return when {
                path == BasePurchaseRepository.PATH + "/quote" -> {
                    val saved = requireNotNull(store.read()); check(saved.purchase == null && saved.request.raw == body && !saved.attempted)
                    if (quoteRejected) throw ApiException(422, null, "Shield is not eligible")
                    check(!cancelled) { "A cancelled request cannot create a late quote" }
                    if (!quoteNotAccepted) row = paidState(quoteChange(paidQuote(saved.request)))
                    afterQuote()
                    if (quoteReplyLost) throw java.io.IOException("lost quote response")
                    paidStatus(saved.request.key, row, enabled, serverNow)
                }
                path.endsWith("/cancel-unquoted") -> {
                    check(body.isEmpty()); val key = path.removeSuffix("/cancel-unquoted").substringAfterLast('/')
                    val purchase = row?.takeIf { it.quote.request.key == key }
                    if (purchase == null) cancelled = true
                    val receipt = buildJsonObject {
                        put("version", 1); put("wallet", WALLET); put("idempotencyKey", key)
                        put("cancelled", purchase == null); put("purchase", purchase?.raw ?: JsonNull)
                    }
                    if (cancelReplyLost) throw java.io.IOException("lost cancellation response")
                    cancelChange(receipt)
                }
                path == "/deposits/$PAID_DEPOSIT/paid" -> { check(body.string("signature") == store.read()?.signature); json("{}") }
                path == "/deposits/$PAID_DEPOSIT/verify" -> { if (verifyFail) throw java.io.IOException("verify unavailable"); onVerify(); json("{}") }
                else -> error("Unexpected POST $path")
            }
        }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
        override suspend fun delete(path: String): JsonObject = error("No DELETE")
    }
    fun repository() = BasePurchaseRepository(session, holder, api, store, SolanaCluster.DEVNET, { base }, { directory }, { catalogue }, { allowed },
        { onAccount() }, { hydrated++; onHydrate() }, { prepared++; beforePrepare(); PreparedBasePurchase(byteArrayOf(1), BigInteger.valueOf(5000), lastValid) }, { now },
        { signature, height -> landings++; check(signature == PAID_SIGNATURE); check(height == store.read()?.lastValidBlockHeight) { "The height saved with THIS payment" }; landing(signature) }, { wall })
    suspend fun ready(kind: String = "builder"): BasePurchaseRepository = repository().also { r -> r.open(); r.review(kind, BASE_ID, if (kind == "mine") PAID_BUILDING else null); r.create(requireNotNull(r.state.value.review)) }
    fun sender(action: suspend () -> Unit = {}) = BasePurchaseSender { _, q, record -> check(store.read()?.attempted == true); check(store.read()?.purchase?.quote == q); action(); record(PAID_SIGNATURE); PAID_SIGNATURE }
}
