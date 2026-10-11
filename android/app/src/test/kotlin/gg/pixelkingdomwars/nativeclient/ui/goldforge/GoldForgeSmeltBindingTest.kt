package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSamples
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.smeltPrimaryCommand
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.smeltPrimaryLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.smeltPrimaryTap
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** The pure decisions behind the Home-mounted SMELT binding: what a tap does, what it says when refused, and what is shown. */
class GoldForgeSmeltBindingTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val identity = MiningContributionIdentity("https://example.invalid", "devnet", wallet)
    private val scope = GoldForgeSmeltScope(wallet, base, 7)
    private fun view() = MiningContributionView(wallet, base, 3, "2026-10-05", "2026-10-05T04:00:00.000Z",
        true, "free", "100", "20", "80", true,
        miningContributionResourceIds(3).map { MiningContributionStock(it, if (it == "forge_ingot" || it == "shards") "30" else "0", "7") },
        MiningConsistencyPolicy(7, 17, 119))
    private fun state(current: MiningContributionView? = view()) =
        MiningContributionState(MiningContributionJournal(1, identity, 0, null, emptyList()), current, advertised = true)
    private fun command() = MiningContributionCommand.review(identity, view(), key, listOf(MiningContributionLine("forge_ingot", "3")))
    private fun proof(settlement: MiningContributionSettlement? = null) = command().let { command -> MiningContributionProof(wallet, key,
        "2026-10-05T04:00:00.000Z", "accepted", MiningContributionReceipt(key, "00000000-0000-4000-8000-000000000003", wallet,
            "2026-10-05", command.request, command.lines, command.totalValue, "2026-10-05T03:59:00.000Z"), settlement) }
    private fun saved(operation: MiningContributionOperation) = state().let { it.copy(journal = it.journal.copy(operation = operation)) }
    private fun draft() = MiningContributionOperation(command(), null, null, null)
    private fun heldOperation() = MiningContributionOperation(command(), null, proof(), null)
    private fun settledOperation() = MiningContributionOperation(command(), null,
        proof(MiningContributionSettlement("consumed", "2026-10-05T04:00:00.000Z")), null)
    private fun edit(s: MiningContributionState, quantities: Map<String, String>, edit: GoldForgeSmeltEdit, admitted: Boolean = true,
        busy: Boolean = false, allowed: Boolean = true) = goldForgeSmeltEditResult(s, scope, quantities, "forge_ingot", edit, admitted, busy, allowed)

    // ---- Tile edits ----

    /** SPEC §3a: a tap past the daily allowance is refused out loud with the designed toast, never silently clamped. */
    @Test fun `a tap past the daily allowance explains instead of clamping`() {
        val refused = edit(state(), mapOf("forge_ingot" to "11"), GoldForgeSmeltEdit.ADD)
        assertNull(refused.quantities)
        assertEquals("Today's allowance is full", refused.explanation)
    }

    /** An uncapped deed furnace has no allowance, so running out of stock must not be blamed on one. */
    @Test fun `a tap past the stock says there is no more instead of blaming the allowance`() {
        val deed = view().copy(pool = "deed", dailyCapValue = null, remainingValue = null)
        val refused = edit(state(deed), mapOf("forge_ingot" to "30"), GoldForgeSmeltEdit.ADD)
        assertNull(refused.quantities)
        assertEquals(GOLD_FORGE_SMELT_NO_MORE, refused.explanation)
    }

    /** An admitted edit changes only the basket, through the same exact arithmetic as the original owner. */
    @Test fun `an admitted edit returns the new basket and no explanation`() {
        val added = edit(state(), emptyMap(), GoldForgeSmeltEdit.ADD)
        assertEquals(mapOf("forge_ingot" to "1"), added.quantities); assertNull(added.explanation)
        assertEquals(emptyMap<String, String>(), edit(state(), mapOf("forge_ingot" to "1"), GoldForgeSmeltEdit.MINUS).quantities)
    }

    /** A tile tap while the owner reads, or while game orders are paused, must say why instead of doing nothing. */
    @Test fun `edits wait out loud while the owner is busy or orders are paused`() {
        assertEquals("The forge is checking. Try again in a moment.",
            edit(state(), emptyMap(), GoldForgeSmeltEdit.ADD, admitted = false, busy = true).explanation)
        assertEquals("Game orders are paused. Original receipts remain available.",
            edit(state(), emptyMap(), GoldForgeSmeltEdit.ADD, admitted = false, allowed = false).explanation)
        assertNull(edit(state(), emptyMap(), GoldForgeSmeltEdit.ADD, admitted = false, busy = true).quantities)
    }

    /** One basket a day: a saved original blocks new edits, and the reason names what the player can do about it. */
    @Test fun `a saved original refuses new edits with its own reason`() {
        assertEquals(GOLD_FORGE_SMELT_SAVED_FIRST, edit(saved(draft()), emptyMap(), GoldForgeSmeltEdit.ADD).explanation)
        assertEquals("One basket a day · the furnace relights at midnight (00:00 UTC)",
            edit(saved(heldOperation()), emptyMap(), GoldForgeSmeltEdit.ADD).explanation)
        assertEquals(GOLD_FORGE_SMELT_SETTLED, edit(saved(settledOperation()), emptyMap(), GoldForgeSmeltEdit.ADD).explanation)
    }

    /** The server's development and pause locks are explained in the primary's own words. */
    @Test fun `server locks refuse edits with the designed reasons`() {
        assertEquals("New smelting is paused",
            edit(state(view().copy(acceptingContributions = false)), emptyMap(), GoldForgeSmeltEdit.ADD).explanation)
        assertEquals("Build the mining buildings first",
            edit(state(view().copy(developmentReady = false)), emptyMap(), GoldForgeSmeltEdit.ADD).explanation)
    }

    // ---- SMELT ----

    /** SMELT reaches `model.start(lines)` only with an admitted, non-empty basket that fits; otherwise it says why. */
    @Test fun `SMELT starts only an admitted non empty basket that fits`() {
        val ok = goldForgeSmeltStart(state(), scope, mapOf("forge_ingot" to "3"), true, false, true)
        assertEquals(listOf(MiningContributionLine("forge_ingot", "3")), ok.lines); assertNull(ok.explanation)
        assertEquals("Tap what to smelt first", goldForgeSmeltStart(state(), scope, emptyMap(), true, false, true).explanation)
        assertEquals(GOLD_FORGE_SMELT_UPDATE_BASKET,
            goldForgeSmeltStart(state(), scope, mapOf("forge_ingot" to "12"), true, false, true).explanation)
        assertNull(goldForgeSmeltStart(state(), scope, mapOf("forge_ingot" to "3"), false, true, true).lines)
        assertNull(goldForgeSmeltStart(saved(draft()), scope, mapOf("forge_ingot" to "3"), true, false, true).lines)
        assertNull(goldForgeSmeltStart(state(), scope.copy(baseId = key), mapOf("forge_ingot" to "3"), true, false, true).lines)
    }

    // ---- Primary tap routing ----

    private class Calls {
        val log = mutableListOf<String>()
        val actions = SmeltActions(onSmelt = { log += "smelt" }, onFindRaid = { log += "raid" }, onRetry = { log += "retry" },
            onExplain = { log += "explain $it" })
    }
    private fun tap(state: SmeltState, items: Int): List<String> =
        Calls().also { smeltPrimaryTap(smeltPrimaryLook(state, smeltPrimaryCommand(state, items)), it.actions) }.log

    /** Each designed primary does its one job; an off or locked face explains itself, so no tap is ever dead. */
    @Test fun `the SMELT primary routes each face to its action or its reason`() {
        assertEquals(listOf("smelt"), tap(SmeltState.CHOOSING, 7))
        assertEquals(listOf("raid"), tap(SmeltState.HELD, 0))
        assertEquals(listOf("retry"), tap(SmeltState.ERROR, 0))
        assertEquals(listOf("explain Tap what to smelt first"), tap(SmeltState.CHOOSING, 0))
        assertEquals(listOf("explain New smelting is paused"), tap(SmeltState.PAUSED, 7))
        assertEquals(listOf("explain Build the mining buildings first"), tap(SmeltState.NOT_READY, 0))
        // A busy face and the QUALIFIED plate have nothing to press.
        assertEquals(emptyList<String>(), tap(SmeltState.LOADING, 0))
        assertEquals(emptyList<String>(), tap(SmeltState.QUALIFIED, 0))
    }

    // ---- What is shown ----

    /** The saved-basket controls replace the body only when a saved original has no designed face; a held face hides them. */
    @Test fun `recovery appears only when a saved original has no designed face`() {
        assertTrue(goldForgeSmeltRecoveryNeeded(null, draft()))
        assertFalse(goldForgeSmeltRecoveryNeeded(GoldForgeSamples.smeltHeld, heldOperation()))
        assertFalse(goldForgeSmeltRecoveryNeeded(null, null))
        assertFalse(goldForgeSmeltRecoveryNeeded(GoldForgeSamples.smeltChoosing, null))
    }

    /** A routine read clears the owner's view; the values already shown stay, with the primary turned into "Checking". */
    @Test fun `a routine read never blanks the body already shown`() {
        val shown = requireNotNull(goldForgeSmeltShown(null, GoldForgeSamples.smeltChoosing, reading = true))
        assertEquals(GoldForgeSamples.smeltChoosing.tiles, shown.tiles)
        assertEquals(GoldForgeSamples.smeltChoosing.committed, shown.committed)
        assertEquals("Checking", shown.primary.caption); assertEquals(CommandState.BUSY, shown.primary.state)
        assertNull(shown.seal)
        // A loading map during a read keeps the kept values too; the first load with nothing kept shows the skeleton.
        assertEquals("Checking", goldForgeSmeltShown(GoldForgeSamples.smeltLoading, GoldForgeSamples.smeltChoosing, true)?.primary?.caption)
        assertSame(GoldForgeSamples.smeltLoading, goldForgeSmeltShown(GoldForgeSamples.smeltLoading, null, true))
        // Fresh data replaces the kept body as soon as it lands.
        assertSame(GoldForgeSamples.smeltHeld, goldForgeSmeltShown(GoldForgeSamples.smeltHeld, GoldForgeSamples.smeltChoosing, true))
    }

    /** Outside a read, an absent body is real (a saved basket): an old body must not cover the recovery controls. */
    @Test fun `an old body is forgotten once the owner is idle without one`() {
        assertNull(goldForgeSmeltShown(null, GoldForgeSamples.smeltChoosing, reading = false))
        assertNull(goldForgeSmeltKept(GoldForgeSamples.smeltChoosing, null, reading = false))
        assertSame(GoldForgeSamples.smeltChoosing, goldForgeSmeltKept(GoldForgeSamples.smeltChoosing, null, reading = true))
        assertSame(GoldForgeSamples.smeltChoosing, goldForgeSmeltKept(GoldForgeSamples.smeltChoosing, GoldForgeSamples.smeltLoading, reading = true))
        assertSame(GoldForgeSamples.smeltHeld, goldForgeSmeltKept(GoldForgeSamples.smeltChoosing, GoldForgeSamples.smeltHeld, reading = false))
    }

    /** Only an accepted original still waiting for settlement is re-read on start, so a settled one is never polled. */
    @Test fun `only an accepted unsettled original is watched for settlement`() {
        assertEquals(key, goldForgeSmeltSettlementWatch(saved(heldOperation())))
        assertNull(goldForgeSmeltSettlementWatch(saved(settledOperation())))
        assertNull(goldForgeSmeltSettlementWatch(saved(draft())))
        assertNull(goldForgeSmeltSettlementWatch(state()))
    }

    // ---- Source contracts ----

    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    /** "I accept these basket terms." was new consent wording (A4); only repository or frame wording may gate a basket. */
    @Test fun `the smelt owner no longer carries the unapproved consent label`() {
        assertFalse(source("ui/goldforge/GoldForgeSmeltOwner.kt").contains("I accept these basket terms."))
        assertFalse(source("ui/goldforge/GoldForgeSmeltOwner.kt").contains("GoldForgeSmeltConsentSeal"))
        assertTrue(source("ui/goldforge/GoldForgeSmeltOwner.kt").contains("SmeltSeal(ui.seal, actions)"))
    }

    /** The Home binding acts in place: no hop to the old route, and its only money calls are the existing owner's. */
    @Test fun `the Home binding never hops to the old route and adds no payment code`() {
        val binding = source("ui/goldforge/GoldForgeSmeltBinding.kt")
        assertFalse(binding.contains("MiningContributionRoute"))
        assertFalse(binding.contains("navigate("))
        assertTrue(binding.contains("model.start(lines)"))
        assertTrue(binding.contains("model.confirm(review)"))
        for (forbidden in listOf("postMiningContribution", "signAndSend", "MobileWalletAdapter", ".post(", "ApiClient"))
            assertFalse(forbidden, binding.contains(forbidden))
    }
}
