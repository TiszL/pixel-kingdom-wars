package gg.pixelkingdomwars.nativeclient.data

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06: "we need to fix root causes for that kind of every case to be ready for production" — no saved request
 * may block play forever on this device. Every journal file that persists a request before it is sent is listed here with
 * its way out and the test that pins it (notes/d-recovery.md "Dead-end audit"). A new journal file fails this test until it
 * is classified, so a journal cannot ship without its close rule. MoneyOp kinds are pinned per spec by the network module's
 * SavedRequestExitTest.
 */
class SavedRequestJournalRegistryTest {
    private data class Exit(val rule: String, val pinnedBy: String?)

    private val journals: Map<String, Exit> = mapOf(
        "PendingIntentStore.kt" to Exit("every MoneyOp kind declares SavedRequestExit", "SavedRequestExitTest"),
        "BaseClaimJournal.kt" to Exit("server cancel-unaccepted fences an unknown key", "BaseClaimRepositoryTest"),
        "BasePurchaseStore.kt" to Exit("server cancel-unquoted fences an unknown key; known-server support holds are an owner decision", "BasePurchaseRepositoryTest"),
        "BoundCosmeticStore.kt" to Exit("archive after a same-key unknown reply", "BoundCosmeticUnknownCloseTest"),
        "BoundCosmeticWorkshopStores.kt" to Exit("archive after a same-key unknown reply", "BoundCosmeticUnknownCloseTest"),
        "CandidateExpansionStore.kt" to Exit("finish after a same-action unquoted read", "CandidateExpansionUnquotedFinishTest"),
        "CharterStore.kt" to Exit("sale: closeAbsent after by-key sale:null (creation open: uncoded 404)", "CharterAbsentCloseTest"),
        "DivineFragmentStore.kt" to Exit("closeAbsent after a fresh receipt read without a receipt", "DivineFragmentServerUnknownCloseTest"),
        "DivineTrialStore.kt" to Exit("closeAbsent when the complete participant record lacks the key", "DivineTrialServerUnknownCloseTest"),
        "EquipmentStore.kt" to Exit("discard after a same-action by-key unknown", "EquipmentUnknownCloseTest"),
        "FreeBasePurchaseStore.kt" to Exit("close after a same-action by-key receipt:null", "FreeBasePurchaseCloseTest"),
        "FreeBasePurchaseStores.kt" to Exit("close after a same-action by-key receipt:null", "FreeBasePurchaseCloseTest"),
        "GemsBuyStore.kt" to Exit("unsent: abandon after unknown; attempted+expired is an owner decision", "GemsBuyRepositoryTest"),
        "GemsBuyStores.kt" to Exit("unsent: abandon after unknown; attempted+expired is an owner decision", "GemsBuyRepositoryTest"),
        "HarvesterStore.kt" to Exit("archive reason unknown after a fresh by-key unknown", "HarvesterUnknownCloseTest"),
        "HarvesterStores.kt" to Exit("archive reason unknown after a fresh by-key unknown", "HarvesterUnknownCloseTest"),
        "KeepDepositStore.kt" to Exit("unsent closes locally; known-server support holds are an owner decision", "KeepDepositRepositoryTest"),
        "KeepEquipmentMarketStore.kt" to Exit("closedAbsent after a coded by-key 404", "KeepEquipmentMarketUnknownCloseTest"),
        "MarketPurchaseStore.kt" to Exit("created only from a server receipt; close/leave exists", "MarketPurchaseStoreTest"),
        "MigrationStore.kt" to Exit("retry of the same key is the door itself", "MigrationRepositoryTest"),
        "MiningClaimsStore.kt" to Exit("archiveAbsent after a fresh unknown (expired unsigned preparation open)", "MiningClaimsCloseTest"),
        "MiningClaimsStores.kt" to Exit("archiveAbsent after a fresh unknown", "MiningClaimsCloseTest"),
        "MiningContributionStore.kt" to Exit("archiveUnknown after a fresh unknown", "MiningContributionCloseTest"),
        "MiningContributionStores.kt" to Exit("archiveUnknown after a fresh unknown", "MiningContributionCloseTest"),
        "MiningTaxClaimsStore.kt" to Exit("archiveAbsent after a fresh unknown", "MiningTaxClaimsCloseTest"),
        "OrdinaryCraftingStore.kt" to Exit("archive reason unknown after a fresh by-key unknown", "OrdinaryCraftingUnknownCloseTest"),
        "OrdinaryCraftingStores.kt" to Exit("archive reason unknown after a fresh by-key unknown", "OrdinaryCraftingUnknownCloseTest"),
        "PendingBattleStore.kt" to Exit("DISCARD SAVED REQUEST (D153.333 d); the server pending list stays the ground truth", "BattleCoordinatorTest"),
        "RealmSalesStore.kt" to Exit("archiveUnanswered after both by-key reads are absent (expired unsigned preparation open)", "RealmSalesUnansweredCloseTest"),
        "ReferralJournal.kt" to Exit("close after the status read shows no relationship", "ReferralCloseTest"),
        "RetirementStore.kt" to Exit("retry of the same key is the door itself", "RetirementRepositoryTest"),
        "SecurityRecoveryStore.kt" to Exit("blocks no door; actions follow the server phase", null),
        "SeekerAuctionJournal.kt" to Exit("GET /tx/:signature: finalized → accepted after a fresh round; unseen past the quoted blockhash's height → closed (never by height for a wallet broadcast); else released only by a finalized round view (window closed, settled, escrow at total; withdrawal: nothing refundable); same-or-lower total refused meanwhile", "SeekerAuctionSavedStepExitTest"),
        "SeekerResourceClaimStore.kt" to Exit("archive server-unknown after a fresh receipt:null", "SeekerResourceClaimsCloseTest"),
        "SeekerResourceClaimStores.kt" to Exit("archive server-unknown after a fresh receipt:null", "SeekerResourceClaimsCloseTest"),
        "SeekerShardsClaimStore.kt" to Exit("archive server-unknown after a fresh receipt:null", "SeekerShardsClaimsCloseTest"),
        "SeekerShardsClaimStores.kt" to Exit("archive server-unknown after a fresh receipt:null", "SeekerShardsClaimsCloseTest"),
        "SkrFaucetJournal.kt" to Exit("complete grant scan releases a grant-less intent (not wired; page size from catalogue)", "SkrFaucetNoDayReleaseTest"),
        "StarterExpeditionStore.kt" to Exit("archive reason unknown after a fresh by-key unknown", "StarterExpeditionUnknownCloseTest"),
        "StarterExpeditionStores.kt" to Exit("archive reason unknown after a fresh by-key unknown", "StarterExpeditionUnknownCloseTest"),
        "StarterFleetStore.kt" to Exit("archive reason unknown after a fresh by-key unknown", "StarterFleetUnknownCloseTest"),
        "StarterFleetStores.kt" to Exit("archive reason unknown after a fresh by-key unknown", "StarterFleetUnknownCloseTest"),
        "TournamentStore.kt" to Exit("closeAbsent after a by-key null; closed records reserve no capacity", "TournamentAbsentCloseTest"),
        "VehicleStore.kt" to Exit("closeUnknown after a by-key unknown or coded 404 (collect has no key route)", "VehicleServerUnknownCloseTest"),
        "WorkshopStore.kt" to Exit("archive reason unknown after a fresh by-key unknown", "WorkshopUnknownCloseTest"),
        "WorkshopStores.kt" to Exit("archive reason unknown after a fresh by-key unknown", "WorkshopUnknownCloseTest"),
        // Not request journals: they persist no request that refuses a door.
        "EncryptedStore.kt" to Exit("storage primitive", null),
        "LocalReportStore.kt" to Exit("local diagnostics", null),
        "NotificationJournal.kt" to Exit("push binding", null),
    )
    /** Request outboxes that live inside a repository file rather than their own store file. */
    private val outboxes = mapOf(
        "ChatOutbox" to "ChatOutboxShapeBTest", "FeedbackOutbox" to "FeedbackKeepAsideTest", "CampaignOutbox" to "PlaytestCampaignCloseTest",
    )

    private val mains = listOf(File("src/main/kotlin"), File("../network/src/main/kotlin"))
    private val tests = listOf(File("src/test/kotlin"), File("../network/src/test/kotlin"))
    private fun named(roots: List<File>, name: String) = roots.filter { it.isDirectory }.any { root -> root.walk().any { it.name == name } }

    @Test fun `every journal that saves a request names its way out and the test that pins it`() {
        assertTrue("the source tree is readable from the test", mains.all { it.isDirectory })
        val found = mains.flatMap { root -> root.walk().filter { it.isFile && (it.name.endsWith("Store.kt") || it.name.endsWith("Stores.kt") || it.name.endsWith("Journal.kt")) }.map { it.name }.toList() }.toSet()
        val unknown = found - journals.keys
        assertTrue("A new journal must be classified here with its way out (notes/d-recovery.md): $unknown", unknown.isEmpty())
        for ((name, exit) in journals) {
            assertTrue("$name is still a journal file", name in found)
            exit.pinnedBy?.let { assertTrue("$name's exit is pinned by $it", named(tests, "$it.kt")) }
        }
        for ((outbox, test) in outboxes) assertTrue("$outbox is pinned by $test", named(tests, "$test.kt"))
    }
}
