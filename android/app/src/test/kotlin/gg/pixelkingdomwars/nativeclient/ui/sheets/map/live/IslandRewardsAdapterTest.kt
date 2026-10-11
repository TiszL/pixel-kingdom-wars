package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import androidx.compose.runtime.snapshots.Snapshot
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsJournal
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsOperation
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsSavedTrust
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsState
import gg.pixelkingdomwars.nativeclient.data.SeekerResourceClaimsState
import gg.pixelkingdomwars.nativeclient.data.SeekerShardsClaimsState
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsCaps
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsPrepareRequest
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimJournal
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsEntitlement
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsEntitlementView
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimCommand
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimJournal
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimOperation
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimRequest
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceEntitlement
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceEntitlementView
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivityGroup
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivityRegistry
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandRewardsActivity
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandRewardsSibling
import gg.pixelkingdomwars.nativeclient.ui.phasee.phaseEActivityNamed
import gg.pixelkingdomwars.nativeclient.ui.phasee.phaseELaunchWhenRegistered
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPickUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RewardsTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TermState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.rewardsTabId
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** ISLAND REWARDS only presents the three claim owners: a saved claim is never hidden behind the designed body, the primary
 * opens one row's original review (never a CLAIM ALL), no term tile or KEEP decimal is invented, and every tab tap reaches
 * the registration that owns that tab. */
class IslandRewardsAdapterTest {
    private val identity = StarterIdentity("https://map.example.test", "devnet", "1".repeat(32))
    private val term = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val base = "00000000-0000-4000-8000-000000000003"
    private val kingdom = islandRewardsKingdom(base)

    private fun material(resource: String = "heartwood_beams", due: String = "7", spot: Int = 0) =
        SeekerResourceEntitlement(term, "a".repeat(64), "2026-09-21T00:00:00.000Z", "2026-09-28T00:00:00.000Z",
            spot, resource, 1, due, due, "0", due)
    private fun materials(rows: List<SeekerResourceEntitlement>, enabled: Boolean = true) = SeekerResourceClaimsState(
        SeekerResourceClaimJournal(1, identity, 0, null, emptyList()),
        SeekerResourceEntitlementView(1, identity.wallet, enabled, false, "available", null, null, null, rows))
    private fun shards(due: String) = SeekerShardsClaimsState(SeekerShardsClaimJournal(1, identity, 0, null, emptyList()),
        SeekerShardsEntitlementView(1, identity.wallet, true, "SHARDS", "available", null, null, null, listOf(
            SeekerShardsEntitlement(term, "a".repeat(64), "2026-09-21T00:00:00.000Z", "2026-09-28T00:00:00.000Z", 0, 1, due, due, "0", due))))
    private fun savedTax(): MiningTaxClaimsState {
        val caps = MiningTaxClaimsCaps("21", "34", "55")
        val trust = MiningTaxClaimsSavedTrust(identity.wallet, identity.wallet, identity.wallet, identity.wallet, identity.wallet, 1, "b".repeat(64))
        val operation = MiningTaxClaimsOperation(MiningTaxClaimsPrepareRequest(key, "9", 4, caps), trust, 86400, true, null,
            emptyList(), emptyList(), false, null, null)
        return MiningTaxClaimsState(loaded = true, journal = MiningTaxClaimsJournal(1, identity, 1, operation, null, emptyList(), false))
    }
    private fun shareUi(state: SeekerResourceClaimsState, kingdom: KingdomPickUi? = this.kingdom, paused: Boolean = false, loading: Boolean = false) =
        islandRewardsUi(RewardsTab.MATERIALS, seekerMaterialsDisplay(state), null, loading, kingdom, paused)
    private fun noRoundsUi() = islandRewardsUi(RewardsTab.REALMS_CUT, null, realmCutDisplay(MiningTaxClaimsState(loaded = true)), false, null)

    @Test fun `a retained original claim forces the original screen so saved money is never hidden`() {
        val row = material()
        val command = SeekerResourceClaimCommand(SeekerResourceClaimRequest(key, base, term, row.resourceId, 0), row.termHash, null)
        val saved = materials(listOf(row)).let { it.copy(journal = it.journal.copy(operation = SeekerResourceClaimOperation(command, 1, null))) }
        val ui = shareUi(saved)
        assertEquals(key, ui.recovery.single().key)
        assertTrue(islandRewardsOriginalRequired(ui.recovery.isNotEmpty(), review = false))
        assertNotEquals(CommandState.ENABLED, ui.primary.state)
        // A saved tax claim is the same: its original screen owns setup, signing, submission and the receipt.
        val tax = islandRewardsUi(RewardsTab.REALMS_CUT, null, realmCutDisplay(savedTax()), false, null)
        assertTrue(islandRewardsOriginalRequired(tax.recovery.isNotEmpty(), review = false))
        // An open review also belongs to the original screen; only with neither may the designed body show.
        assertTrue(islandRewardsOriginalRequired(recovery = false, review = true))
        assertFalse(islandRewardsOriginalRequired(shareUi(materials(listOf(row))).recovery.isNotEmpty(), review = false))
    }

    // Rewritten (owner 2026-10-06): MATERIALS / SHARDS now claim in place, so their primary reads CLAIM "no wallet needed"
    // instead of REVIEW CLAIM. Still one row per review (never a CLAIM ALL), with no price and no tax Seal; REALM'S CUT keeps
    // REVIEW CLAIM because its wallet claim stays on the original screen.
    @Test fun `the share primary claims one row in place and the realm cut primary still only reviews`() {
        val ready = shareUi(materials(listOf(material(), material("frostglass"))))
        assertEquals(RewardsTab.MATERIALS, ready.tab); assertEquals(RewardsTab.entries.size, ready.tabs.size)
        assertEquals(FeatureId("island.seeker.rewards.claim"), ready.primary.id)
        assertEquals("CLAIM", ready.primary.caption)
        assertEquals("no wallet needed", ready.primary.sub)
        assertEquals(CommandState.ENABLED, ready.primary.state)
        assertNull(ready.primary.price); assertNull(ready.seal)
        assertNotNull(ready.primary.badge)
        assertNotNull(ready.tabs.single { it.id == rewardsTabId(RewardsTab.MATERIALS) }.badge)
        val shardsReady = islandRewardsUi(RewardsTab.SHARDS, seekerShardsDisplay(shards("9")), null, false, kingdom)
        assertEquals("CLAIM", shardsReady.primary.caption); assertEquals(CommandState.ENABLED, shardsReady.primary.state)
        val tax = islandRewardsUi(RewardsTab.REALMS_CUT, null, realmCutDisplay(savedTax()), false, null, keepDecimals = 9)
        assertEquals("REVIEW CLAIM", tax.primary.caption); assertNull(tax.primary.sub)
        for (ui in listOf(ready, shardsReady, shareUi(materials(emptyList())), noRoundsUi(), tax)) {
            assertFalse(ui.primary.caption.contains("ALL")); assertNull(ui.seal)
        }
    }

    @Test fun `a saved share claim is finished on this sheet and never pointed at the old flow`() {
        val row = material()
        val command = SeekerResourceClaimCommand(SeekerResourceClaimRequest(key, base, term, row.resourceId, 0), row.termHash, null)
        val saved = materials(listOf(row)).let { it.copy(journal = it.journal.copy(operation = SeekerResourceClaimOperation(command, null, null))) }
        val ui = shareUi(saved)
        // A second claim is never opened beside a saved one; the reason sends the player to that row, not to another screen.
        assertEquals(CommandState.DISABLED, ui.primary.state); assertNull(ui.primary.badge)
        assertTrue(ui.primary.reason!!.contains("saved claim"))
        assertFalse(ui.primary.reason!!.contains("existing"))
        // Missing share history still says so plainly and names where saved receipts are.
        val unavailable = shareUi(materials(emptyList()).copy(view = null))
        assertTrue(unavailable.lockedLine!!.contains("unavailable")); assertFalse(unavailable.lockedLine!!.contains("existing"))
    }

    @Test fun `nothing ready leaves the primary disabled with a reason the player can read`() {
        val cases = listOf(shareUi(materials(emptyList())),
            // A server zero is shown on its row but is never something to claim.
            shareUi(materials(listOf(material(due = "0")))),
            islandRewardsUi(RewardsTab.SHARDS, seekerShardsDisplay(shards("0")), null, false, kingdom),
            noRoundsUi())
        cases.forEach { ui ->
            assertEquals(CommandState.DISABLED, ui.primary.state)
            assertFalse(ui.primary.reason.isNullOrBlank())
            assertTrue(ui.tabs.all { it.badge == null })
        }
    }

    @Test fun `paused claims and a missing kingdom never enable a review`() {
        val rows = listOf(material())
        // The page still lists the share as READY; the owner's paused rule is what keeps the review closed.
        val paused = shareUi(materials(rows, enabled = false), paused = true)
        assertEquals(TermState.READY, paused.earlier.single().state)
        assertEquals(CommandState.LOCKED, paused.primary.state); assertTrue(paused.paused)
        assertTrue(paused.primary.reason!!.contains("paused"))
        val homeless = shareUi(materials(rows), kingdom = null)
        assertEquals(CommandState.DISABLED, homeless.primary.state)
        assertTrue(homeless.primary.reason!!.contains("kingdom")); assertNull(homeless.destination)
        // A CHANGE that could not change anything here is never drawn.
        assertFalse(islandRewardsKingdom(base)!!.changeable); assertNull(islandRewardsKingdom(null))
    }

    @Test fun `no current term tiles are drawn without a server term id`() {
        val state = materials(listOf(material(), material("frostglass", "2")))
        val ui = shareUi(state)
        assertTrue(ui.current.isEmpty()); assertNull(ui.termLine)
        assertFalse(ui.sectionTitle.contains("THIS TERM"))
        assertEquals(seekerMaterialsDisplay(state).scopeLine.uppercase(), ui.sectionTitle)
        assertEquals(2, ui.earlier.size)
        val shardsUi = islandRewardsUi(RewardsTab.SHARDS, seekerShardsDisplay(shards("9")), null, false, kingdom)
        assertTrue(shardsUi.current.isEmpty()); assertFalse(shardsUi.sectionTitle.contains("THIS TERM"))
    }

    @Test fun `the tax row never formats base units as KEEP decimals without a known denomination`() {
        val cut = realmCutDisplay(savedTax()).copy(proposedKeepBaseUnits = "1500000000")
        val unknown = islandRewardsUi(RewardsTab.REALMS_CUT, null, cut, false, null).taxRounds.single()
        assertEquals(PriceStatus.UNAVAILABLE, unknown.amount.status); assertNull(unknown.amount.amount)
        assertEquals(TermState.CHECKING, unknown.state); assertEquals(key, unknown.recoveryKey)
        val known = islandRewardsUi(RewardsTab.REALMS_CUT, null, cut, false, null, keepDecimals = 9).taxRounds.single()
        assertEquals("1.5", known.amount.amount); assertEquals(PriceStatus.OK, known.amount.status)
        // A malformed amount stays unavailable even with a denomination; it never becomes a number.
        val malformed = islandRewardsUi(RewardsTab.REALMS_CUT, null, cut.copy(proposedKeepBaseUnits = "1.5"), false, null, keepDecimals = 9)
        assertEquals(PriceStatus.UNAVAILABLE, malformed.taxRounds.single().amount.status)
    }

    @Test fun `missing round discovery is said plainly and never drawn as no permits sold`() {
        val ui = noRoundsUi()
        assertTrue(ui.taxRounds.isEmpty()); assertNull(ui.destination)
        assertTrue(ui.lockedLine!!.contains("Round discovery is unavailable"))
        // While the first read is out the body claims nothing yet.
        assertNull(islandRewardsUi(RewardsTab.REALMS_CUT, null, realmCutDisplay(null), true, null).lockedLine)
    }

    @Test fun `a routine refresh keeps the rows already shown`() {
        val shown = shareUi(materials(listOf(material())))
        val refreshing = shareUi(materials(emptyList()).copy(view = null), loading = true)
        assertSame(shown, islandRewardsShown(refreshing, shown, busy = true))
        // Only a first read, with nothing kept yet, draws the loading view, and loading never says history is unavailable.
        assertSame(refreshing, islandRewardsShown(refreshing, null, busy = true))
        assertEquals(LoadState.Loading, refreshing.load); assertNull(refreshing.lockedLine)
        val settled = shareUi(materials(emptyList()))
        assertSame(settled, islandRewardsShown(settled, shown, busy = false))
    }

    @Test fun `a failed read keeps what is shown and offers retry`() {
        val ui = islandRewardsUi(RewardsTab.MATERIALS, seekerMaterialsDisplay(materials(listOf(material()))), null, false, kingdom,
            error = "Connection interrupted. Please retry.")
        assertEquals("Connection interrupted. Please retry.", (ui.load as LoadState.Error).message)
        assertEquals(1, ui.earlier.size)
    }

    @Test fun `each rewards tab opens the registration that owns it and its own tab stays put`() {
        assertEquals(PhaseEActivity.SHARDS, islandRewardsSibling(RewardsTab.MATERIALS, rewardsTabId(RewardsTab.SHARDS)))
        assertEquals(PhaseEActivity.MINING_TAX, islandRewardsSibling(RewardsTab.MATERIALS, rewardsTabId(RewardsTab.REALMS_CUT)))
        assertEquals(PhaseEActivity.RESOURCES, islandRewardsSibling(RewardsTab.REALMS_CUT, rewardsTabId(RewardsTab.MATERIALS)))
        RewardsTab.entries.forEach { assertNull(islandRewardsSibling(it, rewardsTabId(it))) }
        assertEquals(RewardsTab.entries.size, RewardsTab.entries.map(::islandRewardsActivity).toSet().size)
        assertTrue(RewardsTab.entries.all { islandRewardsActivity(it).group == PhaseEActivityGroup.SHARES })
    }

    @Test fun `phaseEActivityNamed round trips every activity and rejects unknown names`() {
        PhaseEActivity.entries.forEach { assertEquals(it, phaseEActivityNamed(it.name)) }
        listOf(null, "", "resources", " RESOURCES", "NOT_AN_ACTIVITY").forEach { assertNull(phaseEActivityNamed(it)) }
    }

    @Test fun `a pending launch opens an already registered activity exactly once`() = runBlocking {
        val registry = PhaseEActivityRegistry(); var opened = 0
        registry.register(PhaseEActivity.SHARDS, Any()) { opened++ }
        assertTrue(phaseELaunchWhenRegistered(registry, PhaseEActivity.SHARDS))
        assertEquals(1, opened)
    }

    @Test fun `a pending launch waits for the owning registration to register`() = runBlocking {
        val registry = PhaseEActivityRegistry(); var opened = 0
        val pending = async { phaseELaunchWhenRegistered(registry, PhaseEActivity.RESOURCES) }
        yield()
        // The sibling's registration composes after the current screen closes; the launch must not be lost in between.
        registry.register(PhaseEActivity.RESOURCES, Any()) { opened++ }
        Snapshot.sendApplyNotifications()
        assertTrue(pending.await())
        assertEquals(1, opened)
    }

    @Test fun `a pending launch that never becomes launchable settles false and opens nothing`() = runBlocking {
        val registry = PhaseEActivityRegistry(); var opened = 0
        registry.register(PhaseEActivity.SHARDS, Any()) { opened++ }
        registry.registerDoor(PhaseEActivity.MINING_TAX, Any(), { false }, { opened++ }, null)
        // The caller then tells the player the activity is not open; nothing else is opened in its place.
        assertFalse(phaseELaunchWhenRegistered(registry, PhaseEActivity.MINING_TAX, timeoutMs = 50))
        assertFalse(phaseELaunchWhenRegistered(registry, PhaseEActivity.RESOURCES, timeoutMs = 50))
        assertEquals(0, opened)
    }
}
