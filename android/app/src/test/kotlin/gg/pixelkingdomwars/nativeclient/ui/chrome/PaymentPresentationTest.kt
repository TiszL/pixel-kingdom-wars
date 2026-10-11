package gg.pixelkingdomwars.nativeclient.ui.chrome

import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-09-17: the Solana payment dialogs were "not quite good". Owner 2026-09-18: "SOL spending flow is
 * frustrating… flow should be simple, as in most games, but secure." The happy path is now price tap -> one confirm ->
 * wallet -> it confirms and closes by itself, so the plans changed shape: the manual CHECK / VERIFY controls moved
 * under the collapsed DETAILS disclosure (`detailActions`) and an attempted payment has NO gold plate at all.
 *
 * These tests were rewritten, not deleted: they used to pin "exactly one gold plate, CHECK and VERIFY beside it". The
 * rules they protect are unchanged and are what a presentation rewrite can silently break: a wallet approval is never
 * offered once a payment was attempted; nothing closes a possibly-paid purchase; every recovery action is still
 * reachable in the same state behind the same gate; finishing stays behind the repository's hydration gate. Nothing
 * here decides money; `enabled` only echoes the repository. */
class PaymentPresentationTest {
    private fun List<PaymentAction>.ids() = map { it.id }
    private fun List<PaymentAction>.primary() = single { it.role == PaymentActionRole.PRIMARY }
    private fun List<PaymentAction>.byId(id: String) = single { it.id == id }
    private fun assertAtMostOnePrimary(plan: PaymentPlan) {
        assertTrue("At most one gold plate: $plan", plan.actions.count { it.role == PaymentActionRole.PRIMARY } <= 1)
        assertTrue("DETAILS never carries a gold plate: $plan", plan.detailActions.none { it.role == PaymentActionRole.PRIMARY })
    }

    // ---- the payment window replaces the ISO timestamp ----

    @Test fun `the payment window reads as m ss under an hour, shared duration words above, and CLOSED at zero`() {
        assertEquals("PAY WITHIN 4:12", payWithinText(252))
        assertEquals("PAY WITHIN 0:09", payWithinText(9))
        assertEquals("PAY WITHIN 59:59", payWithinText(3_599))
        assertEquals("PAY WITHIN 1h 30m", payWithinText(5_400))
        assertEquals("PAYMENT WINDOW CLOSED", payWithinText(0))
        assertEquals("Never a negative countdown", "PAYMENT WINDOW CLOSED", payWithinText(-5))
    }

    @Test fun `the ISO deadline becomes a countdown rounded up to the next second, and an unreadable stamp shows nothing`() {
        val until = "2026-09-17T17:56:41.332Z"
        val untilMs = java.time.Instant.parse(until).toEpochMilli()
        assertEquals("PAY WITHIN 4:12", payWithinLabel(until, untilMs - 252_000))
        assertEquals("A partial second still counts as one", "PAY WITHIN 0:01", payWithinLabel(until, untilMs - 1))
        assertEquals("PAYMENT WINDOW CLOSED", payWithinLabel(until, untilMs))
        assertEquals("PAYMENT WINDOW CLOSED", payWithinLabel(until, untilMs + 60_000))
        assertNull("Nothing is invented for a deadline the client cannot read", payWithinLabel("soon", untilMs))
        assertNull(payWithinLabel(null, untilMs))
    }

    @Test fun `the payment window only earns a line in its last minute, because the happy path goes straight to the wallet`() {
        val until = "2026-09-17T17:56:41.332Z"
        val untilMs = java.time.Instant.parse(until).toEpochMilli()
        assertNull("Plenty of time: no countdown in the happy path", payWindowUrgent(until, untilMs - 252_000))
        assertNull(payWindowUrgent(until, untilMs - 61_000))
        assertEquals("PAY WITHIN 1:00", payWindowUrgent(until, untilMs - 60_000))
        assertEquals("PAY WITHIN 0:09", payWindowUrgent(until, untilMs - 9_000))
        assertEquals("PAYMENT WINDOW CLOSED", payWindowUrgent(until, untilMs + 5_000))
        assertNull("Nothing is invented for a deadline the client cannot read", payWindowUrgent("soon", untilMs))
        assertNull(payWindowUrgent(null, untilMs))
    }

    @Test fun `the one status line follows the tap from price to wallet to confirming and is silent when nothing is in flight`() {
        assertEquals("GETTING YOUR PRICE…", paymentProgressLine(exists = false, attempted = false, signed = false, paying = true))
        assertNull(paymentProgressLine(exists = false, attempted = false, signed = false, paying = false))
        assertEquals("OPENING WALLET…", paymentProgressLine(exists = true, attempted = false, signed = false, paying = true))
        assertNull("A declined, unpaid plate shows the failure sentence and RETRY, not a progress line", paymentProgressLine(exists = true, attempted = false, signed = false, paying = false))
        assertEquals("CONFIRM IN YOUR WALLET…", paymentProgressLine(exists = true, attempted = true, signed = false, paying = true))
        val confirming = paymentProgressLine(exists = true, attempted = true, signed = true, paying = true)!!
        assertTrue(confirming.startsWith("CONFIRMING…")); assertTrue("A signed payment says it is safe to leave", confirming.contains("SAFE TO LEAVE"))
        assertEquals("A recorded signature confirms the same way after the tap is over", confirming, paymentProgressLine(exists = true, attempted = true, signed = true, paying = false))
    }

    /** Rewritten 2026-09-18 (review, major): this used to pin the uncertain line EQUAL to the confirming line. That was the
     * defect: with no recorded signature nothing proves the wallet signed or sent anything (an association timeout or
     * a dismissed sheet lands here — today's Seeker failure), yet the plate promised "WE FINISH IT WHEN YOU COME BACK"
     * and the server later expired it. The protected rule is unchanged (never ask to pay again); the new rule is that
     * the finishing promise needs a signature. */
    @Test fun `an uncertain wallet reply is never promised to finish, it is being checked and must not be paid again`() {
        val uncertain = paymentProgressLine(exists = true, attempted = true, signed = false, paying = false)!!
        assertTrue(uncertain.contains("CHECKING")); assertTrue(uncertain.contains("DO NOT PAY AGAIN"))
        assertFalse("No finishing promise without a signature", uncertain.contains("WE FINISH IT")); assertFalse(uncertain.startsWith("CONFIRMING"))
        assertTrue(paymentUncertain(attempted = true, signed = false, paying = false))
        assertFalse("The wallet sheet is still open: not uncertain yet", paymentUncertain(attempted = true, signed = false, paying = true))
        assertFalse(paymentUncertain(attempted = true, signed = true, paying = false)); assertFalse(paymentUncertain(attempted = false, signed = false, paying = false))
        val checking = PaymentPill("CHECKING", PaymentTone.TROUBLE)
        assertEquals("Never CONFIRMING for a payment nobody can prove was sent", checking, basePurchasePill("pending", attempted = true, uncertain = true))
        assertEquals(checking, marketPaymentPill("reserved", attempted = true, uncertain = true)); assertEquals(checking, keepDepositPill(null, attempted = true, uncertain = true))
        assertEquals("The server's verdict still wins", PaymentPill("DONE", PaymentTone.DONE), basePurchasePill("credited", attempted = true, uncertain = true))
    }

    @Test fun `a PAY failure sentence stays with its purchase and status, and goes when either changes`() {
        val failure = PayFailure("Payment outcome is uncertain — the wallet did not answer in time.", "key-1" to "pending")
        assertEquals(failure.message, failure.shownFor("key-1" to "pending"))
        assertNull("The server answered: the sentence is history", failure.shownFor("key-1" to "credited"))
        assertNull("Another purchase never inherits it", failure.shownFor("key-2" to "pending")); assertNull(failure.shownFor(null))
    }

    // ---- status pills ----

    @Test fun `pills read NOT PAID then CONFIRMING then DONE, and an attempted wallet payment is never shown as unpaid`() {
        assertEquals(PaymentPill("NOT PAID", PaymentTone.OPEN), marketPaymentPill("reserved", attempted = false))
        assertEquals(PaymentPill("CONFIRMING", PaymentTone.SENT), marketPaymentPill("reserved", attempted = true))
        assertEquals(PaymentPill("CONFIRMING", PaymentTone.SENT), marketPaymentPill("committed", attempted = true))
        assertEquals(PaymentPill("DONE", PaymentTone.DONE), marketPaymentPill("settled", attempted = true))
        assertEquals(PaymentPill("ENDED", PaymentTone.CLOSED), marketPaymentPill("cancelled", attempted = false))
        assertEquals(PaymentPill("ENDED", PaymentTone.CLOSED), marketPaymentPill("superseded", attempted = true))

        assertEquals(PaymentPill("CHECKING", PaymentTone.TROUBLE), basePurchasePill(null, attempted = false))
        assertEquals(PaymentPill("NOT PAID", PaymentTone.OPEN), basePurchasePill("pending", attempted = false))
        assertEquals(PaymentPill("CONFIRMING", PaymentTone.SENT), basePurchasePill("pending", attempted = true))
        assertEquals(PaymentPill("DONE", PaymentTone.DONE), basePurchasePill("credited", attempted = true))
        assertEquals(PaymentPill("FAILED", PaymentTone.TROUBLE), basePurchasePill("failed", attempted = true))
        assertEquals(PaymentPill("ENDED", PaymentTone.CLOSED), basePurchasePill("expired", attempted = false))

        assertEquals(PaymentPill("NOT PAID", PaymentTone.OPEN), keepDepositPill(null, attempted = false))
        assertEquals(PaymentPill("CONFIRMING", PaymentTone.SENT), keepDepositPill(null, attempted = true))
        assertEquals(PaymentPill("DONE", PaymentTone.DONE), keepDepositPill("credited", attempted = true))
        assertEquals(PaymentPill("FAILED", PaymentTone.TROUBLE), keepDepositPill("failed", attempted = true))
        assertEquals(PaymentPill("ENDED", PaymentTone.CLOSED), keepDepositPill("expired", attempted = false))
    }

    // ---- base purchase (energy, builder, expansion, mine, shield) ----

    private fun base(status: String?, attempted: Boolean, canPay: Boolean = false, canFinish: Boolean = false, busy: Boolean = false,
        supported: Boolean = true, enabled: Boolean = true, paying: Boolean = false) = basePurchasePlan(status, attempted, canPay, canFinish, busy, supported, enabled, "2", paying)

    @Test fun `an unpaid base quote is only seen after a declined or interrupted tap, so its one gold plate is RETRY and recovery sits under DETAILS`() {
        val plan = base("pending", attempted = false, canPay = true)
        assertEquals(listOf(PaymentActions.PAY), plan.actions.ids())
        assertEquals("RETRY · 2 SOL", plan.actions.primary().label)
        assertEquals("OPENING WALLET…", base("pending", attempted = false, canPay = false, busy = true, paying = true).actions.primary().label)
        assertEquals(setOf(PaymentActions.CHECK, PaymentActions.VERIFY), plan.detailActions.ids().toSet())
        assertFalse("PAY only echoes the repository's canPay gate", base("pending", attempted = false, canPay = false).actions.primary().enabled)
        assertFalse("A pending quote still reserves its target: the store does not let it close, so no CLOSE is offered",
            plan.all.ids().any { it == PaymentActions.CLOSE || it == PaymentActions.FINISH })
    }

    /** Review 2026-09-18 (major): an unpaid quote that can no longer be paid cannot be closed locally and blocks every
     * base purchase, so a disabled RETRY must never be its only plate, and its line must not promise that it clears
     * by itself or blame a price hold when purchases are simply unavailable. */
    @Test fun `an unpaid base quote that cannot be paid shows CHECK NOW and VERIFY PAYMENT instead of a dead RETRY`() {
        fun blocked(busy: Boolean = false, paying: Boolean = false) = basePurchasePlan("pending", false, false, false, busy, true, true, "2", paying, payable = false)
        val plan = blocked()
        assertEquals(listOf(PaymentActions.CHECK, PaymentActions.VERIFY), plan.actions.ids()); assertTrue(plan.detailActions.isEmpty())
        assertEquals(PaymentActions.CHECK, plan.actions.primary().id); assertTrue("Every visible plate works", plan.actions.all { it.enabled })
        assertFalse("No wallet approval for a quote that cannot be paid", plan.all.ids().contains(PaymentActions.PAY))
        assertFalse("A pending quote is still never closed locally", plan.all.ids().any { it == PaymentActions.CLOSE || it == PaymentActions.FINISH })
        blocked(busy = true).all.forEach { assertFalse(it.enabled) }
        assertEquals("The running PAY tap keeps its own plate", listOf(PaymentActions.PAY), blocked(busy = true, paying = true).actions.ids())
        assertTrue("An attempted payment is never offered these as its happy path",
            basePurchasePlan("pending", true, false, false, false, true, true, "2", false, payable = false).actions.isEmpty())
    }

    @Test fun `the blocked unpaid line says when buying works again, never that it clears by itself, and never blames a hold for a pause`() {
        val retryAt = "2026-09-13T00:30:00.000Z"; val at = java.time.Instant.parse(retryAt).toEpochMilli()
        val waiting = unpaidQuoteBlockedLine(available = true, retryAt = retryAt, nowMs = at - 581_000)
        assertTrue(waiting.startsWith("PRICE HOLD ENDED — NOTHING WAS CHARGED.")); assertTrue(waiting.contains("BUY AGAIN IN 9:41"))
        val over = unpaidQuoteBlockedLine(available = true, retryAt = retryAt, nowMs = at + 1)
        assertTrue("Past the server's window only VERIFY can end it; say so", over.contains("VERIFY PAYMENT")); assertEquals(over, unpaidQuoteBlockedLine(true, "soon", at))
        listOf(waiting, over).forEach { assertFalse(it.contains("by itself", ignoreCase = true)); assertFalse(it.contains("clears", ignoreCase = true)) }
        val paused = unpaidQuoteBlockedLine(available = false, retryAt = retryAt, nowMs = at - 581_000)
        assertFalse("No hold ended when the server simply is not offering this purchase", paused.contains("HOLD ENDED")); assertTrue(paused.contains("NOTHING WAS CHARGED")); assertTrue(paused.contains("CHECK NOW"))
    }

    @Test fun `an attempted base payment never offers a second wallet approval, has no gold plate, and CHECK and VERIFY stay reachable`() {
        val plan = base("pending", attempted = true, canPay = true)
        assertTrue("It confirms by itself: nothing to tap", plan.actions.isEmpty())
        assertFalse("No new wallet approval for an attempted payment", plan.all.ids().contains(PaymentActions.PAY))
        assertEquals(listOf(PaymentActions.CHECK, PaymentActions.VERIFY), plan.detailActions.ids())
        assertFalse("Nothing closes a possibly-paid quote", plan.all.ids().contains(PaymentActions.CLOSE) || plan.all.ids().contains(PaymentActions.FINISH))
    }

    @Test fun `a credited base purchase finishes only through the repository's canFinish gate and can still be refreshed`() {
        val ready = base("credited", attempted = true, canFinish = true)
        assertEquals(PaymentActions.FINISH, ready.actions.primary().id); assertEquals("OK", ready.actions.primary().label); assertTrue(ready.actions.primary().enabled)
        assertEquals(listOf(PaymentActions.CHECK), ready.detailActions.ids())
        assertFalse("Unhydrated original deed: OK shown but not enabled", base("credited", attempted = true, canFinish = false).actions.byId(PaymentActions.FINISH).enabled)
        assertFalse("VERIFY (reconcile) was never offered once the server credited", ready.all.ids().contains(PaymentActions.VERIFY))
    }

    @Test fun `a failed or expired base quote closes only when unpaid, and an attempted one keeps CHECK and VERIFY and no close`() {
        listOf("expired", "failed").forEach { status ->
            val unpaid = base(status, attempted = false, canFinish = true)
            assertEquals(PaymentActions.CLOSE, unpaid.actions.primary().id); assertTrue(unpaid.actions.primary().enabled)
            assertFalse("Closing still echoes the repository's gate", base(status, attempted = false, canFinish = false).actions.primary().enabled)
            val paid = base(status, attempted = true, canFinish = false)
            assertTrue("An attempted payment is never closed as if unpaid", paid.actions.isEmpty())
            assertEquals(setOf(PaymentActions.CHECK, PaymentActions.VERIFY), paid.all.ids().toSet())
        }
    }

    @Test fun `an unknown quote reply offers check, retry of the same request and cancel, gated like the previous screen`() {
        val plan = base(null, attempted = false)
        assertEquals(listOf(PaymentActions.CHECK, PaymentActions.RETRY_QUOTE, PaymentActions.CANCEL_UNQUOTED), plan.actions.ids())
        assertFalse("Retry needs the server feature, exactly as before", base(null, attempted = false, supported = false).actions.byId(PaymentActions.RETRY_QUOTE).enabled)
        assertFalse(base(null, attempted = false, enabled = false).actions.byId(PaymentActions.RETRY_QUOTE).enabled)
        assertTrue(base(null, attempted = false).actions.byId(PaymentActions.CANCEL_UNQUOTED).enabled)
        base(null, attempted = false, busy = true).all.forEach { assertFalse("Busy disables every plate: ${it.id}", it.enabled) }
    }

    // ---- market purchase ----

    private fun market(state: String, attempted: Boolean, canPay: Boolean = false, sender: Boolean = true, bounds: Boolean = true,
        busy: Boolean = false, hydrated: Boolean = false, leaveAllowed: Boolean = true) =
        marketPaymentPlan(state, attempted, canPay, sender, bounds, busy, hydrated, leaveAllowed, "0.68")

    @Test fun `an unpaid reservation offers RETRY as the gold plate and CANCEL as a ghost, both behind their old gates`() {
        val plan = market("reserved", attempted = false, canPay = true)
        assertEquals("RETRY · 0.68 SOL", plan.actions.primary().label)
        assertEquals(listOf(PaymentActions.PAY, PaymentActions.LEAVE), plan.actions.ids())
        assertEquals(listOf(PaymentActions.CHECK), plan.detailActions.ids())
        assertFalse("A disconnected wallet cannot approve", market("reserved", attempted = false, canPay = true, sender = false).actions.primary().enabled)
        assertFalse("Unknown bounds block approval and checks", market("reserved", attempted = false, canPay = true, bounds = false).actions.primary().enabled)
        assertFalse(market("reserved", attempted = false, bounds = false).detailActions.byId(PaymentActions.CHECK).enabled)
        assertFalse("A pending MARKET_RESERVE intent blocks leaving", market("reserved", attempted = false, leaveAllowed = false).actions.byId(PaymentActions.LEAVE).enabled)
        assertEquals(PaymentActionRole.GHOST, plan.actions.byId(PaymentActions.LEAVE).role)
    }

    @Test fun `once a market payment was attempted only CHECK remains, under DETAILS, because leaving would hide a possibly-paid reservation`() {
        listOf("reserved", "committed", "cancelled", "superseded").forEach { state ->
            val plan = market(state, attempted = true, canPay = true)
            assertTrue("Nothing to tap while it confirms ($state)", plan.actions.isEmpty())
            assertEquals(listOf(PaymentActions.CHECK), plan.detailActions.ids())
        }
        listOf("cancelled", "superseded").forEach { state ->
            assertEquals("An unpaid ended reservation can still be left with one tap", listOf(PaymentActions.LEAVE), market(state, attempted = false).actions.ids())
        }
    }

    @Test fun `a settled market purchase finishes only once hydrated and can be refreshed`() {
        val plan = market("settled", attempted = true, hydrated = true)
        assertEquals("OK", plan.actions.primary().label); assertEquals(PaymentActions.FINISH, plan.actions.primary().id); assertTrue(plan.actions.primary().enabled)
        assertEquals("REFRESH", plan.detailActions.byId(PaymentActions.CHECK).label)
        assertFalse("OK waits for the balances and inventory refresh", market("settled", attempted = true, hydrated = false).actions.primary().enabled)
    }

    // ---- KEEP deposit ----

    private fun deposit(status: String?, attempted: Boolean, canPay: Boolean = false, bounds: Boolean = true, busy: Boolean = false, hydrated: Boolean = false) =
        keepDepositPlan(status, attempted, canPay, bounds, busy, hydrated, "1,000")

    @Test fun `an unpaid deposit offers RETRY and CANCEL, with CHECK under DETAILS`() {
        val plan = deposit(null, attempted = false, canPay = true)
        assertEquals("RETRY · 1,000 KEEP", plan.actions.primary().label)
        assertEquals(listOf(PaymentActions.PAY, PaymentActions.CLOSE), plan.actions.ids())
        assertEquals("CANCEL", plan.actions.byId(PaymentActions.CLOSE).label)
        assertEquals(listOf(PaymentActions.CHECK), plan.detailActions.ids())
        assertFalse("Missing content bounds block approval", deposit(null, attempted = false, canPay = true, bounds = false).actions.primary().enabled)
        assertFalse(deposit(null, attempted = false, bounds = false).detailActions.byId(PaymentActions.CHECK).enabled)
    }

    @Test fun `a paid deposit is checked, never cancelled or closed, until the server credits it`() {
        val paid = deposit(null, attempted = true, canPay = true)
        assertTrue(paid.actions.isEmpty()); assertEquals(listOf(PaymentActions.CHECK), paid.detailActions.ids())
        listOf("failed", "expired").forEach { status ->
            assertEquals("Attempted: no close", listOf(PaymentActions.CHECK), deposit(status, attempted = true).all.ids())
            assertEquals(listOf(PaymentActions.CLOSE, PaymentActions.CHECK), deposit(status, attempted = false).all.ids())
        }
        val credited = deposit("credited", attempted = true, hydrated = true)
        assertEquals("OK", credited.actions.primary().label); assertTrue(credited.actions.primary().enabled)
        assertFalse("OK waits for hydration", deposit("credited", attempted = true, hydrated = false).actions.primary().enabled)
        assertTrue(credited.detailActions.ids().contains(PaymentActions.CHECK))
    }

    @Test fun `on every surface an attempted payment never offers PAY, LEAVE or CLOSE, and no plan has two gold plates`() {
        val statuses = listOf(null, "pending", "credited", "expired", "failed")
        for (status in statuses) for (attempted in listOf(false, true)) for (canFinish in listOf(false, true)) {
            val plan = base(status, attempted, canPay = true, canFinish = canFinish); assertAtMostOnePrimary(plan)
            if (attempted && status != null) assertTrue("$status: $plan", plan.all.ids().none { it in setOf(PaymentActions.PAY, PaymentActions.CLOSE, PaymentActions.CANCEL_UNQUOTED) })
        }
        for (state in listOf("reserved", "committed", "settled", "cancelled", "superseded")) for (attempted in listOf(false, true)) {
            val plan = market(state, attempted, canPay = true); assertAtMostOnePrimary(plan)
            if (attempted) assertTrue("$state: $plan", plan.all.ids().none { it in setOf(PaymentActions.PAY, PaymentActions.LEAVE) })
        }
        for (status in listOf(null, "pending", "credited", "expired", "failed")) for (attempted in listOf(false, true)) {
            val plan = deposit(status, attempted, canPay = true); assertAtMostOnePrimary(plan)
            if (attempted) assertTrue("$status: $plan", plan.all.ids().none { it in setOf(PaymentActions.PAY, PaymentActions.CLOSE) })
        }
    }
}
