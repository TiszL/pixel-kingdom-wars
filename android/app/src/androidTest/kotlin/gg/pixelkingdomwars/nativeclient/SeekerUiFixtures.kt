package gg.pixelkingdomwars.nativeclient

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.MarketTradeViewModel
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterViewModel
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Instant

/** Existing repository interfaces feed the real view models. No AppGraph, disk store, HTTP client,
 * authentication or transaction is created. All non-display actions reject before doing any work. */
internal class SeekerUiFixtures(private val catalogue: JsonObject, private val home: BaseState, private val now: Long) {
    private val models = ViewModelStore()
    var prohibitedCalls = 0
        private set
    var refreshes = 0
        private set
    var cleared = false
        private set
    private fun prohibited(): Nothing { prohibitedCalls++; error("UI capture cannot perform an API or purchase action") }
    private val observer = ReceiptObserver(PendingIntentStore(MemoryOnlyStore()))
    private val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject = prohibited()
        override suspend fun post(path: String, body: JsonObject): JsonObject = prohibited()
        override suspend fun put(path: String, body: JsonObject): JsonObject = prohibited()
        override suspend fun delete(path: String): JsonObject = prohibited()
    }
    private val marketHolder = AccountSessionHolder()
    val baseId = requireNotNull(home.base?.baseId)
    val marketWallet = "1".repeat(32) // Explicit synthetic display address; no key exists in this fixture.
    val marketBounds = MarketTradeBounds.from(catalogue)

    private fun <T : ViewModel> own(type: Class<T>, factory: () -> T): T = ViewModelProvider(models,
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST") override fun <V : ViewModel> create(modelClass: Class<V>): V = factory() as V
        })[type]

    fun army(): ArmyViewModel = own(ArmyViewModel::class.java) {
        ArmyViewModel(armyRepository, baseRepository, contentRepository, observer,
            { home.base?.player?.wallet }, { baseId }, InterruptedActions({ prohibited() }, { prohibited() }, { prohibited() }), BuildConfig.VERSION_CODE)
    }

    fun roster(): RosterViewModel = own(RosterViewModel::class.java) {
        armyRepository.state.value = armyRepository.state.value.copy(inventory = inventoryState())
        RosterViewModel(armyRepository, baseRepository, contentRepository, observer,
            InterruptedActions({ prohibited() }, { prohibited() }, { prohibited() }), BuildConfig.VERSION_CODE)
            .apply { selectItem("keg_of_haste") }
    }

    fun community(): CommunityRepository = object : CommunityRepository {
        // Explicit synthetic reward, already read and claimed; no real message or receipt is opened.
        override val state = MutableStateFlow(CommunityState(detail = MailMessage(
            id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sender = "admin", kind = "reward",
            subject = "Playtest reward", body = "Thank you for sharing your playtest feedback. Your reward has been delivered to your kingdom.",
            attachments = listOf(MailAttachment("SHARDS", amount = "1000"), MailAttachment("ITEM", itemId = "keg_of_haste", qty = 1)),
            rewardState = "claimed", claimBaseId = baseId, createdAt = Instant.ofEpochMilli(now - 3_600_000).toString(),
            expiresAt = Instant.ofEpochMilli(now + 86_400_000).toString(), readAt = Instant.ofEpochMilli(now - 1_800_000).toString(),
            archivedAt = null, claimedAt = Instant.ofEpochMilli(now - 1_800_000).toString(), expiredAt = null), status = MailStatus(1, 0, 0)))
        override suspend fun refreshMail(archived: Boolean) { refreshes++ }
        override suspend fun checkClaim() { refreshes++ } // No saved claim exists in this display fixture.
        override suspend fun refreshLeagues() = prohibited()
        override suspend fun moreMail() = prohibited()
        override suspend fun openMail(id: String) = prohibited()
        override fun closeMail() = prohibited()
        override suspend fun markRead() = prohibited()
        override suspend fun archive() = prohibited()
        override suspend fun claim(mailId: String, baseId: String?) = prohibited()
        override suspend fun retryClaim() = prohibited()
    }

    fun market(): MarketTradeViewModel = own(MarketTradeViewModel::class.java) {
        val origin = "https://localhost:18443"
        // Metadata only: this holder never installs a signed-in session, and no token is persisted.
        val session = AccountSession(marketWallet, origin, SessionCookieJar(origin.toHttpUrl(), MemoryOnlyStore()).sessionToken())
        val repository = MarketTransactionsRepository(session, marketHolder, api, PendingIntentStore(MemoryOnlyStore()), observer,
            MarketPurchaseStore(MemoryOnlyStore(), marketWallet, origin, "devnet"), SolanaCluster.DEVNET,
            { baseId }, { true }, { marketBounds }, { prohibited() }, { prohibited() }, { prohibited() }, { setOf(baseId) }, { 0L })
        MarketTradeViewModel(repository) // Never call foreground/open/check/pay; the panel receives its DTO below.
    }

    fun close() { models.clear(); marketHolder.replace(null); cleared = true }

    fun marketState(settled: Boolean): MarketTradeState {
        // Test-only terms mirror the reported 0.001 SOL item price; no reservation is created or stored.
        val quote = buildJsonObject {
            put("version", 1); put("idempotencyKey", "seeker-ui-reservation")
            put("reservationId", "55555555-5555-4555-8555-555555555555"); put("listingId", "66666666-6666-4666-8666-666666666666")
            put("itemId", "keg_of_haste"); put("buyer", marketWallet); put("seller", "2".repeat(32)); put("feeTreasury", "3".repeat(32)); put("reference", "4".repeat(32))
            put("sourceBaseId", "77777777-7777-4777-8777-777777777777"); put("buyerBaseId", baseId); put("cluster", "devnet")
            put("priceLamports", "1000000"); put("sellerLamports", "950000"); put("feeLamports", "50000"); put("feeBps", 500)
            put("createdAt", Instant.ofEpochMilli(now - 30_000).toString()); put("payableUntil", Instant.ofEpochMilli(now + 60_000).toString())
        }
        val signature = "5".repeat(64)
        val receipt = MarketReservationReceipt.from(buildJsonObject {
            put("quote", quote); put("serverNow", Instant.ofEpochMilli(now).toString()); put("payable", false)
            put("state", if (settled) "settled" else "committed"); put("paymentSignature", signature)
            put("txSignature", if (settled) JsonPrimitive(signature) else JsonNull)
            put("resolvedAt", if (settled) JsonPrimitive(Instant.ofEpochMilli(now).toString()) else JsonNull)
        })
        return MarketTradeState(supported = true, loaded = true, saved = SavedMarketPurchase(receipt.quote, receipt, attempted = true, signature = signature),
            hydrated = settled, destinationRefresh = if (settled) MarketDestinationRefresh(baseId, true, null) else null)
    }

    private val contentRepository = object : ContentRepository {
        override val state = MutableStateFlow(ContentState(catalogue = catalogue))
        override val mode = LaunchMode.ACCOUNT
        override suspend fun initialize() {}
        override fun simVersion() = state.value.simVersion
        override suspend fun checkUpdates(api: ApiClient, force: Boolean) = prohibited()
        override suspend fun applyUpdate(canActivate: () -> Boolean) = prohibited()
        override suspend fun loadPreviewFixtures(): Pair<JsonObject, JsonObject?> = prohibited()
    }

    private val baseRepository = object : BaseRepository {
        override val state = MutableStateFlow(home)
        // BaseRepository.balanceRevision became abstract in d82a758b; negative means unsupported (this fixture never publishes balances).
        override val balanceRevision: Long get() = -1L
        override val construction: MoneyOp<ConstructionAcceptance> get() = prohibited()
        override val wallRow: MoneyOp<WallRowAcceptance> get() = prohibited()
        override val layoutUnlock: MoneyOp<LayoutUnlockAcceptance> get() = prohibited()
        override suspend fun refresh() { refreshes++ }
        override suspend fun refreshQuests() { refreshes++ }
        override suspend fun refreshMine() { refreshes++ }
        override suspend fun collectMine() = prohibited()
        override suspend fun claimDailyCache() = prohibited()
        override suspend fun claimQuest(questId: String) = prohibited()
        override suspend fun tutorialAction(action: String) = prohibited()
        override suspend fun place(type: String, tx: Int, ty: Int) = prohibited()
        override suspend fun upgrade(buildingId: String) = prohibited()
        override suspend fun finishJob(jobId: String) = prohibited()
        override suspend fun cancelJob(jobId: String) = prohibited()
        override suspend fun repairTrap(buildingId: String) = prohibited()
        override suspend fun clearObstacle(obstacleId: String) = prohibited()
        override suspend fun quoteWallRow(wallId: String): WallRowQuote = prohibited()
        override suspend fun upgradeWallRow(quote: WallRowQuote): WallRowOutcome = prohibited()
        override suspend fun refreshLayouts(): Layouts = prohibited()
        override suspend fun unlockFarmLayout(): LayoutUnlockAcceptance = prohibited()
        override suspend fun saveLayout(slot: String, mode: String, geometryVersion: Int, expectedSlotEtag: String, expectedActiveEtag: String?, positions: List<LayoutPosition>): LayoutSaveResult = prohibited()
        override fun clearNotice() {}
    }

    private val armyRepository = object : ArmyRepository {
        override val state = MutableStateFlow(ArmyDomainState(army = armyState(), armyBaseId = baseId, armyBaseGeneration = 0))
        override val training: MoneyOp<TrainingAcceptance> get() = prohibited()
        override val cancellation: MoneyOp<CancellationAcceptance> get() = prohibited()
        override val finish: MoneyOp<FinishAcceptance> get() = prohibited()
        override val research: MoneyOp<ResearchAcceptance> get() = prohibited()
        override val heroUpgrade: MoneyOp<HeroUpgradeAcceptance> get() = prohibited()
        override val heroRecovery: MoneyOp<HeroRecoveryAcceptance> get() = prohibited()
        override val itemPurchase: MoneyOp<ItemPurchaseAcceptance> get() = prohibited()
        override val itemUse: MoneyOp<ItemUseAcceptance> get() = prohibited()
        override suspend fun refreshArmy() { refreshes++ }
        override suspend fun refreshHeroes() { refreshes++ }
        override suspend fun refreshInventory() { refreshes++ }
        override suspend fun quote(draft: ArmyTrainingDraft) = prohibited()
        override fun dismissQuote() = prohibited()
        override suspend fun confirmTraining() = prohibited()
        override suspend fun cancelQueued(choice: TrainingCancellationChoice) = prohibited()
        override suspend fun finishAll(free: Boolean, displayedCostKeep: String?) = prohibited()
        override suspend fun submitResearch(target: JsonObject) = prohibited()
        override suspend fun refreshPresets() { refreshes++ }
        override suspend fun savePreset(slot: Int, name: String, composition: List<TroopCount>) = prohibited()
        override suspend fun deletePreset(slot: Int) = prohibited()
        override suspend fun quotePrevious() = prohibited()
        override suspend fun upgradeHero(hero: String, level: Int, costKeep: String) = prohibited()
        override suspend fun recoverHero(hero: String, costKeep: String, recoveryUntil: String) = prohibited()
        override suspend fun buyItem(itemId: String) = prohibited()
        override suspend fun useItem(itemId: String, jobId: String?) = prohibited()
        override suspend fun equip(hero: String, slot: String, itemId: String?, expectedVersion: Int) = prohibited()
        override suspend fun markItemSeen(itemId: String) = prohibited()
        override fun clearNotice() {}
    }

    private fun inventoryState(): Inventory {
        val constants = catalogue.getValue("constants").jsonObject
        val rules = constants.getValue("INVENTORY").jsonObject
        val item = constants.getValue("ITEMS").jsonObject.getValue("keg_of_haste").jsonObject
        val quantity = 3 // Synthetic owned copies; item stats and capacity remain pinned catalogue values.
        return Inventory.from(buildJsonObject {
            put("catalogRevision", rules.getValue("catalogRevision")); put("heroGearCombatEnabled", true)
            put("catalog", buildJsonArray { add(JsonObject(item + ("id" to JsonPrimitive("keg_of_haste")))) })
            put("owned", buildJsonArray { add(buildJsonObject { put("itemId", "keg_of_haste"); put("qty", quantity.toString()); put("seen", true) }) })
            // selectItem must never mark a retained account's discovery state. This synthetic item is already seen.
            put("discovery", buildJsonArray { add(buildJsonObject { put("itemId", "keg_of_haste"); put("seenAt", Instant.ofEpochMilli(now).toString()) }) })
            put("capacity", buildJsonObject { put("used", quantity * item.getValue("weight").jsonPrimitive.int); put("max", rules.getValue("capacity")) })
            put("heroLoadouts", buildJsonArray { listOf("vex", "theodor").forEach { hero -> add(buildJsonObject {
                put("hero", hero); put("recruited", true); put("level", 20); put("available", true)
            }) } })
        })
    }

    private fun armyState(): ArmyState {
        val types = trainableTroops(catalogue)
        var nextStart = now - 1_000
        val queue = List(20) { if (it % 2 == 0) "highlander" else "bowman" }.mapIndexed { index, troop -> buildJsonObject {
            put("id", "88888888-8888-4888-8888-${index.toString().padStart(12, '0')}"); put("troop", troop); put("scheduleVersion", 2)
            // A synthetic sequential queue uses the pinned per-unit durations and SHARD debits.
            put("startedAt", Instant.ofEpochMilli(nextStart).toString())
            nextStart += requireNotNull(troopStats(catalogue, troop)?.string("trainSec")).toLong() * 1_000
            put("finishesAt", Instant.ofEpochMilli(nextStart).toString())
            put("canCancel", true); put("refundShards", requireNotNull(troopStats(catalogue, troop)?.string("costKeep")))
        } }
        val constants = requireNotNull(catalogue["constants"] as? JsonObject)
        val leveling = requireNotNull(constants["TROOP_LEVELING"] as? JsonObject)
        val target = 3
        val duration = (leveling.getValue("researchTimeSec").jsonArray[target - 2]).jsonPrimitive.long
        val researchCost = leveling.getValue("researchCostKeep").jsonArray[target - 2].jsonPrimitive.content
        return ArmyState.from(buildJsonObject {
            put("counts", buildJsonObject { put("highlander", 10); put("bowman", 6) })
            put("levels", buildJsonObject { types.forEach { put(it, if (it == "bowman") target - 1 else 1) } })
            put("queue", JsonArray(queue)); put("rosterPts", 10 * requireNotNull(troopPoints(catalogue, "highlander")) + 6 * requireNotNull(troopPoints(catalogue, "bowman")))
            put("queuedPts", queue.sumOf { requireNotNull(troopPoints(catalogue, it.getValue("troop").jsonPrimitive.content)) })
            put("campCapacityPts", 100); put("barracksQueuePts", 60); put("eliteUnlocks", buildJsonObject {})
            put("features", buildJsonObject {
                put("trainingScheduling", buildJsonObject { put("version", 2); put("mode", "sequential"); put("lanes", 1); put("consentRequired", true) })
                put("researchConsent", buildJsonObject { put("version", 1) })
            })
            put("finishAllQuote", buildJsonObject {
                put("version", 2); put("maxCostKeep", requireNotNull(speedupCostKeep(catalogue, (nextStart - now + 999) / 1000)).toString())
                put("queue", JsonArray(queue.map { JsonObject(it.filterKeys { key -> key in setOf("id", "startedAt", "finishesAt") }) }))
            })
            put("research", buildJsonArray { add(buildJsonObject {
                put("troop", "bowman"); put("toLevel", target); put("episodeId", "99999999-9999-4999-8999-999999999999")
                put("finishesAt", Instant.ofEpochMilli(now + duration * 1000).toString()); put("canCancel", true); put("refundShards", researchCost)
            }) })
        })
    }
}

private class MemoryOnlyStore : SecretStore {
    private var value: String? = null
    override fun read() = value
    override fun write(value: String) { this.value = value }
    override fun clear() { value = null }
}
