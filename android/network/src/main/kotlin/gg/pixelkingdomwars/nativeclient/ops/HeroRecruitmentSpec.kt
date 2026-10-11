package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.serialization.json.*

class HeroRecruitmentSpec(private val cluster: String) : MoneyOpSpec<HeroRecruitmentReceipt> {
    override val kind = IntentKind.HERO_RECRUITMENT
    // These named refusals occur before recruitment mutates buildings, inventory or balances.
    // A conflicting idempotency key or generic HTTP failure never proves this command was refused.
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException): Boolean =
        error.status == 503 && error.code == "HERO_RECRUITMENT_DISABLED" ||
        error.status == 409 && error.code in setOf("BASE_ID_REQUIRED", "HERO_RECRUITMENT_CONTEXT_MISMATCH") ||
        error.status == 404 && error.code == "BASE_NOT_OWNED" ||
        error.status == 409 && error.code == "HERO_CONTRACT_UNAVAILABLE" && intent.body["heroContractOnly"] == JsonPrimitive(true) ||
        error.status == 409 && error.code == "HERO_RECRUIT_PRICE_CHANGED" && intent.body["heroContractOnly"] == JsonPrimitive(false)
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) = observedInitialRejection(intent, error)
    val path = "/heroes/recruit/v1"
    init { require(cluster in setOf("devnet", "mainnet-beta")) }
    fun intent(wallet: String, request: HeroRecruitmentRequest, definition: HeroAltarDefinition): PendingIntent {
        ClanCommandContract.wallet(wallet); request.validate(definition.plotTiles, definition.plotGeometry); require(request.type == definition.type)
        require(request.heroContractOnly || request.maxCostKeep == definition.costKeep)
        return PendingIntent(kind, wallet, request.baseId, request.idempotencyKey, path, request.body, "Place ${definition.name} altar", buildJsonObject {
            put("cluster", cluster); put("hero", definition.hero); put("type", definition.type); put("name", definition.name)
            put("itemId", definition.itemId); put("costKeep", definition.costKeep); put("keepLevel", definition.keepLevel)
            put("buildSec", definition.buildSec); put("plotTiles", definition.plotTiles); definition.plotGeometry?.let { put("plotGeometry", it.json) }
        })
    }
    fun definition(intent: PendingIntent): HeroAltarDefinition {
        val q = requireNotNull(intent.quote); val c = HeroRecruitmentContract
        val d = HeroAltarDefinition(c.text(q, "hero"), c.text(q, "type"), c.text(q, "name"), c.text(q, "itemId"), c.text(q, "costKeep"),
            c.integer(q, "keepLevel"), c.integer(q, "buildSec"), c.integer(q, "plotTiles"), q["plotGeometry"]?.let { PlotGeometry.saved(it.jsonObject) })
        require(c.hero(d.type) == d.hero && d.keepLevel > 0 && d.buildSec >= 0); ForgeClaimContract.amount(d.costKeep); require(d.costKeep != "0")
        val request = HeroRecruitmentRequest.from(intent.body, d.plotTiles, d.plotGeometry)
        val expected = this.intent(intent.wallet, request, d)
        require(intent.kind == kind && intent.path == path && intent.idempotencyKey == request.idempotencyKey && intent.baseId == request.baseId
            && intent.quote == expected.quote && intent.label == expected.label)
        return d
    }
    override fun validateSend(intent: PendingIntent) { definition(intent) }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest { definition(intent); return ReceiptRequest("$path/${intent.idempotencyKey}", emptyMap()) }
    /** The key-scoped v1 receipt answers `receipt: null` only for this wallet's exact key (no closure route exists): the
     * altar card's CLOSE may then forget it on this device (owner 2026-10-06, the same rule as construction). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun acknowledge(intent: PendingIntent, response: JsonObject): HeroRecruitmentReceipt = HeroRecruitmentReceipt.from(response, definition(intent)).also {
        require(it.actor == intent.wallet && it.request.body == intent.body)
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<HeroRecruitmentReceipt> = try {
        definition(intent); HeroRecruitmentContract.keys(response, "version", "wallet", "idempotencyKey", "enabled", "receipt")
        require(response["version"] == JsonPrimitive(1) && HeroRecruitmentContract.text(response, "wallet") == intent.wallet
            && HeroRecruitmentContract.text(response, "idempotencyKey") == intent.idempotencyKey); HeroRecruitmentContract.flag(response, "enabled")
        // Server 2026-10-06 (night/server): a locked read under the player row, so `receipt: null` proves no row holds this
        // key; it carries no absentAsOf, so MoneyOp applies the client minimum age before it can close anything.
        if (response["receipt"] == JsonNull) Receipt.Absent else Receipt.Accepted(acknowledge(intent, requireNotNull(response["receipt"] as? JsonObject)), ReceiptDocument.fromReceiptRoute(response))
    } catch (_: Exception) { throw ApiCompatibilityException("$path/${intent.idempotencyKey}") }
    override fun restore(intent: PendingIntent, document: JsonObject) = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        ReceiptDocument.SOURCE_RECEIPT -> requireNotNull((decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value)
        else -> error("Unrecognized recruitment proof")
    }
}
