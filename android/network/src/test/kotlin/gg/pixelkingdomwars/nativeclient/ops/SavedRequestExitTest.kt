package gg.pixelkingdomwars.nativeclient.ops

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06: "we need to fix root causes for that kind of every case to be ready for production" — no saved money
 * request may block play forever on this device. Every operation therefore declares its way out
 * ([MoneyOpSpec.savedRequestExit]), and this test fails for a new operation that ships without one, or for a spec class the
 * list below does not know, so a journal cannot be added without its close rule.
 */
class SavedRequestExitTest {
    private val specs: Map<String, MoneyOpSpec<*>> = mapOf(
        "TrainingBatchSpec" to TrainingBatchSpec, "ConstructionSpec" to ConstructionSpec, "TrainingCancelSpec" to TrainingCancelSpec,
        "ResearchSpec" to ResearchSpec, "TrainingFinishSpec" to TrainingFinishSpec, "LandReservationSpec" to LandReservationSpec,
        "WallRowSpec" to WallRowSpec, "LayoutUnlockSpec" to LayoutUnlockSpec, "HeroUpgradeSpec" to HeroUpgradeSpec,
        "HeroRecoverySpec" to HeroRecoverySpec, "ItemBuySpec" to ItemBuySpec, "ItemUseSpec" to ItemUseSpec,
        "GemsFromKeepSpec" to GemsFromKeepSpec, "GemsToShardsSpec" to GemsToShardsSpec, "GemsTaskClaimSpec" to GemsTaskClaimSpec,
        "KeepConversionSpec" to KeepConversionSpec, "ForgeContributionSpec" to ForgeContributionSpec, "WithdrawalSpec" to WithdrawalSpec,
        "WithdrawalUnwindSpec" to WithdrawalUnwindSpec, "MarketListSpec" to MarketListSpec, "MarketReserveSpec" to MarketReserveSpec,
        "MarketCancelSpec" to MarketCancelSpec, "MailClaimSpec" to MailClaimSpec, "HeroRecruitmentSpec" to HeroRecruitmentSpec("devnet"),
        "WallBatchSpec" to WallBatchSpec("devnet"), "ClanCommandSpec" to ClanCommandSpec(IntentKind.CLAN_LEAVE, "devnet"),
        "ForgeClaimSpec" to ForgeClaimSpec("devnet"),
    )
    /** Specs declared outside this module; their own module's tests pin their exit (ClansRepository's ClanChangeSpec). */
    private val elsewhere = setOf("ClanChangeSpec")
    /** Shared bases that are never instantiated themselves; each concrete subclass is listed above. */
    private val bases = setOf("GemsSpec", "EconomySpec", "MarketSpec")

    @Test fun `every money operation declares how a saved request of it can never block play forever`() {
        for ((name, spec) in specs) assertNotEquals("$name has no declared way out", SavedRequestExit.UNDECLARED, spec.savedRequestExit)
        assertEquals("Only training has a server closure route", listOf("TrainingBatchSpec"),
            specs.filterValues { it.savedRequestExit == SavedRequestExit.SERVER_CLOSE }.keys.toList())
        // A request no read can resolve may only stop blocking after a refused retry when the server replays its key.
        for ((name, spec) in specs.filterValues { it.savedRequestExit == SavedRequestExit.PARK_AFTER_RETRY_REFUSED })
            assertTrue("$name parks only retryable kinds", spec.kind in setOf(IntentKind.LAND_RESERVATION, IntentKind.ITEM_BUY, IntentKind.ITEM_USE,
                IntentKind.MARKET_LIST, IntentKind.MARKET_RESERVE, IntentKind.MARKET_CANCEL))
    }

    @Test fun `no money operation spec exists that this list does not classify`() {
        val roots = listOf(File("src/main/kotlin"), File("../app/src/main/kotlin")).filter { it.isDirectory }
        assertTrue("the source tree is readable from the test", roots.isNotEmpty())
        val declaration = Regex("""(?:object|class)\s+(\w+)(?:<[^>]*>)?\s*(?:\([^()]*\))?\s*:\s*(?:MoneyOpSpec<|GemsSpec\(|EconomySpec\(|MarketSpec<)""")
        val found = roots.flatMap { root -> root.walk().filter { it.extension == "kt" }.flatMap { file ->
            declaration.findAll(file.readText()).map { it.groupValues[1] }.toList() } }.toSet()
        assertTrue("the scan finds the known specs", "ConstructionSpec" in found && "TrainingBatchSpec" in found)
        val unknown = found - specs.keys - elsewhere - bases
        assertTrue("A new money operation must declare its saved-request exit and be listed here: $unknown", unknown.isEmpty())
    }

    @Test fun `a request no read can resolve is never blocking forever on its own terms`() {
        // Rewritten 2026-10-06 (owner review B1/M2): supersedable now reads the device-side facts (last attempt time, last
        // answer, a refused retry) and the clock, and a refused retry only counts when the spec proves the refusal came after
        // the server's key lookup. The rules below are the ones that keep a player from paying twice.
        val now = 10 * SAVED_REQUEST_MIN_AGE_MS
        // A read taken right after the send settles nothing; one taken the minimum age later does.
        val fresh = SavedRequestFacts(attemptedAtMs = now, answeredAtMs = now)
        val settledFacts = SavedRequestFacts(attemptedAtMs = 0, answeredAtMs = SAVED_REQUEST_MIN_AGE_MS)
        // Legacy research or finish orders without a usable target can never be read: they stop blocking at once.
        val legacyResearch = PendingIntent(IntentKind.RESEARCH, WALLET, BASE, "legacy-research-key", "/army/research",
            kotlinx.serialization.json.buildJsonObject { put("idempotencyKey", kotlinx.serialization.json.JsonPrimitive("legacy-research-key")) },
            "Research", kotlinx.serialization.json.buildJsonObject { put("action", kotlinx.serialization.json.JsonPrimitive("start")) }, attempted = true, attemptRevision = 1)
        assertTrue(supersedable(ResearchSpec, legacyResearch, fresh, now))
        assertFalse("never a proven acceptance", supersedable(ResearchSpec, legacyResearch.copy(receipt = ReceiptDocument.fromPost(
            kotlinx.serialization.json.buildJsonObject {})), settledFacts, now))
        // An item purchase keeps blocking: no refusal the server gives a replay is raised after its key lookup, so none can
        // prove the original never committed; a new purchase would carry a new key and could charge twice.
        val item = ItemBuySpec.intent(WALLET, BASE, "keg_of_haste", "item-key-0001", "60", "Keg").copy(attempted = true, attemptRevision = 1)
        for (status in listOf(400, 401, 403, 404, 409, 422, 429)) for (spec in listOf<MoneyOpSpec<*>>(ItemBuySpec, ItemUseSpec, MarketListSpec, MarketReserveSpec, MarketCancelSpec))
            assertFalse("${spec.kind} $status", spec.refusedAfterKeyLookup(item, gg.pixelkingdomwars.nativeclient.network.ApiException(status, null, "refused")))
        assertFalse(supersedable(ItemBuySpec, item, settledFacts.copy(answer = SavedRequestFacts.UNSUPPORTED), now))
        // A key-scoped receipt kind stops blocking after a settled `unknown` or `absent` check, never before the minimum age.
        val cancel = cancelIntent().copy(attempted = true, attemptRevision = 1)
        assertTrue(supersedable(TrainingCancelSpec, cancel, settledFacts.copy(answer = SavedRequestFacts.UNKNOWN), now))
        assertFalse(supersedable(TrainingCancelSpec, cancel, fresh.copy(answer = SavedRequestFacts.UNKNOWN), now))
        assertFalse("never without a check", supersedable(TrainingCancelSpec, cancel, settledFacts, now))
        assertFalse("never on an answer read before the minimum age", supersedable(TrainingCancelSpec, cancel,
            settledFacts.copy(answer = SavedRequestFacts.UNKNOWN, answeredAtMs = SAVED_REQUEST_MIN_AGE_MS - 1), now))
        // Training has its own server closure route: CLOSE is its way out and it never stops blocking on its own.
        assertFalse(supersedable(TrainingBatchSpec, trainingIntent().copy(attempted = true, attemptRevision = 1),
            settledFacts.copy(answer = SavedRequestFacts.UNKNOWN, retryRefused = true), now))
    }
}
