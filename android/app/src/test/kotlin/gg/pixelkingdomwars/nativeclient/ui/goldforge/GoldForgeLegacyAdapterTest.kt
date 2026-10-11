package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.EconomyState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.model.WithdrawalRecord
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LEGACY_CHECKING_LINE
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LEGACY_FORBIDDEN_WORDS
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LegacyV2Ui
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.WithdrawalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.legacySavedCaption
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.legacySavedText
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Authored before the adapter; UNRUN. Execution belongs to the integrator. */
class GoldForgeLegacyAdapterTest {
    private val base = "00000000-0000-4000-8000-000000000001"
    private val id = "00000000-0000-4000-8000-000000000002"
    private val other = "00000000-0000-4000-8000-000000000003"
    private val signature = "1".repeat(64)
    private fun state(keep: String = "23") = EconomyState(baseId = base, balances = Balances("0", keep))
    private fun row(status: String = "unbonding") = WithdrawalRecord(id = id, status = status,
        gross = "200", fee = "3", net = "197", destination = "11111111111111111111111111111112",
        createdAt = "2026-10-01T12:00:00Z", unbondsAt = "2026-10-04T12:00:00Z",
        signature = null, refundable = false, mint = null, completedAt = null)
    private fun map(s: EconomyState = state(), current: Boolean = true, balanceCurrent: Boolean = true,
        withdrawalsCurrent: Boolean = true, selectedBase: String? = base, failedAt: String? = null) =
        goldForgeLegacyUi(s, selectedBase, current, balanceCurrent, withdrawalsCurrent, failedAt)

    @Test fun `retired identity suppresses retained balance and history`() {
        assertNull(map(state().copy(withdrawals = listOf(row("sent").copy(signature = signature,
            completedAt = "2026-10-04T12:00:01Z"))), current = false))
    }

    @Test fun `positive current in game KEEP alone admits Legacy without conversion claims`() {
        val ui = requireNotNull(map(state("9007199254740993.123")))
        assertEquals("9007199254740993.123", ui.saved)
        assertTrue(ui.withdrawals.isEmpty())
        assertFalse(ui.conversionPlanCurrent); assertFalse(ui.live)
        assertNull(ui.cutoverAt); assertNull(ui.convertedLine); assertEquals("", ui.rate)
        assertNull(ui.nextIn); assertNull(ui.refreshedAgo); assertNull(ui.asOf)
    }

    @Test fun `empty unknown and server zero do not create a Legacy tab`() {
        assertNull(map(EconomyState(baseId = base)))
        listOf("0", "0.00", "", "-1", "1e3", "NaN").forEach { assertNull(map(state(it))) }
        assertNull(map(state(), balanceCurrent = false))
    }

    @Test fun `wallet KEEP never substitutes for saved in game KEEP`() {
        assertNull(map(EconomyState(baseId = base, wallet = WalletFunds(null, mapOf("KEEP" to "999"), 0))))
        val ui = requireNotNull(map(EconomyState(baseId = base, wallet = WalletFunds(null,
            mapOf("KEEP" to "999"), 0), withdrawals = listOf(row()))))
        assertNull(ui.saved)
    }

    // Rewritten 2026-10-06 (S4, owner rule "a routine refresh must not blank data that was already shown"): this case
    // also pinned `loading = true` as withholding the amount, which hid the saved figure (and the whole tab when nothing
    // else was tracked) on every refresh. The host's identity witness already proves the value came from its last good
    // read, so loading now keeps it (SPEC E1.1 loading: last good values + the 2 dp line), pinned by
    // `a routine refresh keeps the proven saved amount and row states`. Base mismatch and a failed read still withhold it.
    @Test fun `base mismatch and failed balance reads withhold saved amount`() {
        listOf(state().copy(baseId = "other"),
            state().copy(errors = mapOf("/balances" to "unavailable"))).forEach { value ->
            assertNull(map(value))
            assertNull(requireNotNull(map(value.copy(withdrawals = listOf(row())))).saved)
        }
    }

    @Test fun `current tracked withdrawals keep unknown and zero saved balances distinct`() {
        assertNull(requireNotNull(map(EconomyState(baseId = base, withdrawals = listOf(row())))).saved)
        assertEquals("0", requireNotNull(map(state("0").copy(withdrawals = listOf(row())))).saved)
        assertNull(requireNotNull(map(state().copy(withdrawals = listOf(row())), balanceCurrent = false)).saved)
    }

    @Test fun `fresh unbonding row has no refund action or guessed arrival countdown`() {
        val ui = requireNotNull(map(state("0").copy(withdrawals = listOf(row().copy(refundable = true)))))
        val item = ui.withdrawals.single()
        assertEquals(WithdrawalState.UNLOCKING, item.state)
        assertEquals("200", item.amount); assertFalse(item.canReturn); assertNull(item.proof)
        assertFalse(item.line.contains("In your wallet")); assertNull(ui.nextIn)
    }

    // Rewritten 2026-10-06 (S4, owner rule "a routine refresh must not blank data that was already shown"): this case
    // also pinned `loading = true` as turning every row CHECKING, so each refresh flashed "being checked" over proven
    // payouts. A read in flight disproves nothing the host's witness proved; loading now keeps the row states (pinned by
    // `a routine refresh keeps the proven saved amount and row states`). A stale witness or a failed read still cannot
    // claim SENT or UNLOCKING.
    @Test fun `stale and failed history reads cannot claim sent or unlocking`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val s = state("0").copy(withdrawals = listOf(sent, row().copy(id = "other")))
        listOf(requireNotNull(map(s, withdrawalsCurrent = false)),
            requireNotNull(map(s.copy(errors = mapOf("/withdrawals" to "failed"))))).forEach { ui ->
            assertTrue(ui.withdrawals.all { it.state == WithdrawalState.CHECKING && it.proof == null && !it.canReturn })
        }
    }

    @Test fun `fresh sent observation requires valid signature and completion date`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val item = requireNotNull(map(state("0").copy(withdrawals = listOf(sent)))).withdrawals.single()
        assertEquals(WithdrawalState.SENT, item.state); assertEquals(id, item.proof)
        assertFalse(item.canReturn); assertEquals("200", item.amount)
    }

    @Test fun `incomplete malformed or reversed sent evidence stays checking`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        listOf(sent.copy(signature = null), sent.copy(signature = "not-a-signature"),
            sent.copy(completedAt = null), sent.copy(completedAt = "not-a-date"),
            sent.copy(completedAt = "2026-09-30T12:00:00Z"), sent.copy(createdAt = "unknown"),
            sent.copy(gross = "oops"), sent.copy(net = "200")).forEach { value ->
            val item = requireNotNull(map(state("0").copy(withdrawals = listOf(value)))).withdrawals.single()
            assertEquals(WithdrawalState.CHECKING, item.state); assertNull(item.proof); assertFalse(item.canReturn)
        }
    }

    @Test fun `exact decimal amounts compare numerically without rounding`() {
        val sent = row("sent").copy(gross = "200.00", fee = "3.0", net = "197",
            signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val item = requireNotNull(map(state("0").copy(withdrawals = listOf(sent)))).withdrawals.single()
        assertEquals(WithdrawalState.SENT, item.state); assertEquals("200.00", item.amount)
    }

    @Test fun `duplicate history ids cannot prove terminal state`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val rows = requireNotNull(map(state("0").copy(withdrawals = listOf(sent, sent)))).withdrawals
        assertTrue(rows.all { it.state == WithdrawalState.CHECKING && it.proof == null })
    }

    @Test fun `cancelled refunded failed and unknown rows never invent return proof`() {
        listOf("cancelled", "refunded", "failed", "processing", "unknown").forEach { status ->
            val value = row(status).copy(refundable = true, completedAt = "2026-10-04T12:00:01Z")
            val item = requireNotNull(map(state("0").copy(withdrawals = listOf(value)))).withdrawals.single()
            assertEquals(WithdrawalState.CHECKING, item.state); assertFalse(item.canReturn); assertNull(item.proof)
        }
    }

    @Test fun `malformed history amount stays unknown instead of zero`() {
        val item = requireNotNull(map(state("0").copy(withdrawals = listOf(row().copy(gross = "NaN")))))
            .withdrawals.single()
        assertEquals("…", item.amount); assertEquals(WithdrawalState.CHECKING, item.state)
    }

    @Test fun `existing Legacy samples retain conversion section by default`() {
        assertTrue(LegacyV2Ui("1", null, "Each KEEP becomes a Gem", emptyList(), null, true).conversionPlanCurrent)
    }

    // Owner rule: a routine refresh must not blank data that was already shown. A refresh in flight keeps the witnessed
    // saved amount (so a saved-only tab does not vanish) and every proven row state, under the 2 dp loading line.
    @Test fun `a routine refresh keeps the proven saved amount and row states`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val alone = requireNotNull(map(state().copy(loading = true)))
        assertEquals("23", alone.saved); assertTrue(alone.loading)
        val ui = requireNotNull(map(state().copy(loading = true, withdrawals = listOf(sent, row().copy(id = other)))))
        assertEquals(listOf(WithdrawalState.SENT, WithdrawalState.UNLOCKING), ui.withdrawals.map { it.state })
        assertEquals("23", ui.saved)
        // Without the host's witness the same refresh still proves nothing.
        val loading = state().copy(loading = true, withdrawals = listOf(sent))
        assertNull(requireNotNull(map(loading, balanceCurrent = false)).saved)
        assertEquals(WithdrawalState.CHECKING, requireNotNull(map(loading, withdrawalsCurrent = false)).withdrawals.single().state)
    }

    // legacy.png: a SENT row reads "In your wallet since 12 Sep". The day is the proven completion (completedAt, never
    // createdAt or unbondsAt, which would date a payout before it arrived) on the player's own calendar, not UTC's.
    @Test fun `sent row names the day it completed in the device zone`() {
        assertEquals("In your wallet since 12 Sep", legacySentLine(Instant.parse("2026-09-12T08:00:00Z"), ZoneId.of("UTC")))
        val late = Instant.parse("2026-10-04T12:00:01Z")
        assertEquals("In your wallet since 4 Oct", legacySentLine(late, ZoneId.of("UTC")))
        assertEquals("In your wallet since 5 Oct", legacySentLine(late, ZoneId.of("Pacific/Auckland")))
        assertEquals("In your wallet since 3 Oct", legacySentLine(Instant.parse("2026-10-04T03:00:00Z"), ZoneId.of("America/Los_Angeles")))
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-09T12:00:00Z")
        val item = requireNotNull(map(state("0").copy(withdrawals = listOf(sent)))).withdrawals.single()
        assertEquals(WithdrawalState.SENT, item.state)
        assertEquals(legacySentLine(Instant.parse("2026-10-09T12:00:00Z")), item.line)
        // Created 1 Oct and unbonding 4 Oct in every zone; only completedAt gives 9 or 10 Oct.
        assertTrue(item.line, Regex("In your wallet since (9|10) Oct").matches(item.line))
    }

    // SPEC E1.1 honest-state copy: an unconfirmed row opens with "Being checked" and never claims it "stays saved" (not
    // proven) or that anything "failed" (even for a server status of "failed"); no adapter line uses a forbidden word.
    @Test fun `checking row says being checked and no adapter line uses a forbidden word`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val rows = listOf(sent, row().copy(id = other), row("failed").copy(id = "00000000-0000-4000-8000-000000000004"))
        val fresh = requireNotNull(map(state("0").copy(withdrawals = rows))).withdrawals
        assertEquals(listOf(WithdrawalState.SENT, WithdrawalState.UNLOCKING, WithdrawalState.CHECKING), fresh.map { it.state })
        val checking = fresh.last().line
        assertEquals("Being checked · original record kept", checking)
        assertTrue(checking.startsWith("Being checked")); assertFalse(checking.contains("stays saved"))
        assertEquals("Withdrawal is unlocking.", fresh[1].line)
        val stale = requireNotNull(map(state("0").copy(withdrawals = rows), withdrawalsCurrent = false)).withdrawals
        assertTrue(stale.all { it.line == LEGACY_CHECKING_LINE })
        (fresh + stale).map { it.line }.forEach { line ->
            LEGACY_FORBIDDEN_WORDS.forEach { word -> assertFalse("'$line' says '$word'", line.contains(word, ignoreCase = true)) }
        }
    }

    // SPEC E1.1 error: the last good view stays and the saved figure is labelled "as of 14:20". The host passes the clock of
    // its last good read; without it a failed balance read still withholds the amount, and nothing clears the history.
    @Test fun `failed read keeps the last good saved amount labelled as of without clearing history`() {
        val sent = row("sent").copy(signature = signature, completedAt = "2026-10-04T12:00:01Z")
        val failed = state().copy(errors = mapOf("/balances" to "unavailable", "/withdrawals" to "unavailable"),
            withdrawals = listOf(sent, row().copy(id = other)))
        val ui = requireNotNull(map(failed, failedAt = "14:20"))
        assertEquals("23", ui.saved); assertEquals("14:20", ui.asOf)
        assertEquals("as of 14:20", legacySavedCaption(ui.asOf))
        assertEquals(listOf(id, other), ui.withdrawals.map { it.id })
        // A failed history read cannot confirm a status now: the rows stay, each labelled CHECKING.
        assertTrue(ui.withdrawals.all { it.state == WithdrawalState.CHECKING && it.proof == null && !it.canReturn })
        // Saved only: the tab stays with its last good amount instead of disappearing.
        assertEquals("23", requireNotNull(map(state().copy(errors = mapOf("/balances" to "unavailable")), failedAt = "14:20")).saved)
        // No witness: nothing to keep.
        assertNull(requireNotNull(map(failed, balanceCurrent = false, failedAt = "14:20")).saved)
        // No clock or a malformed one: no retained amount and no label.
        listOf(null, "2pm", "24:00", "").forEach { clock ->
            val value = requireNotNull(map(failed, failedAt = clock))
            assertNull(value.saved); assertNull(value.asOf)
        }
        assertNull(requireNotNull(map()).asOf)
    }

    // legacy.png draws "1,820": the raw validated server decimal is drawn through exactAmount (every digit, grouped, never
    // rounded); an unknown amount stays "…" and only a server zero reads "0".
    @Test fun `saved figure is drawn exact and grouped while unknown stays an ellipsis`() {
        assertEquals("1,820", legacySavedText(requireNotNull(map(state("1820"))).saved))
        assertEquals("9,007,199,254,740,993.123", legacySavedText(requireNotNull(map(state("9007199254740993.123"))).saved))
        val unknown = requireNotNull(map(EconomyState(baseId = base, withdrawals = listOf(row()))))
        assertNull(unknown.saved); assertEquals("…", legacySavedText(unknown.saved))
        val zero = requireNotNull(map(state("0").copy(withdrawals = listOf(row()))))
        assertEquals("0", legacySavedText(zero.saved))
        assertEquals("200", legacySavedText(zero.withdrawals.single().amount))
    }
}
