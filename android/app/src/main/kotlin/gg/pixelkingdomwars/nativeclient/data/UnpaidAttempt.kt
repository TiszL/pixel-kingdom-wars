package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding

/** Retiring an ATTEMPTED payment that provably moved no money. Without it a wallet timeout, a dropped wallet
 * association, a process death under the wallet sheet or a refused relay left `attempted = true` for good: once the
 * server ended the reservation/quote unpaid, no store could close it and the rail refused every later purchase.
 *
 * Every leg must hold, and each store's `retireUnpaidAttempt` checks all of them again under its own lock:
 *  1. The server's latest receipt for THIS id + reference is terminal-UNPAID (market `superseded`/`cancelled`, deposit
 *     `expired`). The server settles by reference key and exact balance deltas, never by what this client remembers,
 *     and ends a reservation/quote unpaid only after its finalized reference scan found no payment. A payment that did
 *     land therefore reads `settled`/`credited` — or `failed`, which is funds RECEIVED and is never retired.
 *  2. The attempt is older than [MARGIN_MS], measured from the LATEST stamp the device holds: when the attempt began
 *     and when its wallet step ended ([oldEnough]). The market rail also needs the SERVER's clock to be that far past
 *     the quote's payment deadline, so a device clock that jumped forward cannot shorten the margin.
 *  3. A recorded signature is cleared by the cluster itself ([cleared]); with none recorded there is nothing to ask.
 * Anything short of that — a pending/reserved/committed receipt, a young attempt, a signature the cluster knows, a
 * null status whose expiry is not proven, an unavailable RPC — leaves the purchase saved and is asked again later. */
internal object UnpaidAttempt {
    /** Transport safety, NOT a game number. It must exceed the worst case of a wallet that follows the protocol: the
     * wallet adapter (clientlib 2.0.7) allows about 30 s to associate, 90 s to authorize and 90 s for
     * `sign_and_send`, and `sign_and_send` lets the wallet name a FRESH blockhash, valid for about 150 blocks
     * (60–90 s, up to ~2 min on a slow cluster). A payment can therefore be broadcast ~210 s after the attempt began
     * and still land ~330 s after it, AFTER this app recorded a timeout with no signature. Five minutes was below
     * that; ten minutes is above it, and it is counted from the end of the wallet step whenever that was seen. */
    const val MARGIN_MS = 10 * 60_000L

    /** [attemptedAtMs] is the persisted wall-clock start of the attempt; [walletEndedAtMs] is when its wallet step
     * ended (the wallet answered, failed uncertainly, or a signature was first recorded). The margin runs from the
     * LATEST of the two: a wallet can only broadcast while its step is open, and the step may outlast any budget.
     * A purchase saved before [walletEndedAtMs] existed falls back to the start alone. One saved before either
     * existed is old only once its quote's own payment deadline is more than the margin in the past, because no
     * attempt could begin after that deadline. With none of them, the age is unknown and nothing is retired. */
    fun oldEnough(attemptedAtMs: Long?, walletEndedAtMs: Long?, legacyDeadlineMs: Long?, nowMs: Long): Boolean {
        val latest = listOfNotNull(attemptedAtMs, walletEndedAtMs).maxOrNull()
        return when {
            latest != null -> nowMs - latest >= MARGIN_MS
            legacyDeadlineMs != null -> nowMs - legacyDeadlineMs > MARGIN_MS
            else -> false
        }
    }

    /** No signature: nothing to disprove. A recorded one needs the cluster to say it is finalized with an error (a
     * Solana transaction is atomic, so an errored one transferred nothing and can never run again), or that it never
     * processed it. "Never processed" counts only as [SignatureLanding.NOT_FOUND], which the RPC layer answers only
     * once the node has FINALIZED past the [lastValidBlockHeight] saved with the payment — so a purchase saved
     * without that height is never retired on a null status. A missing verdict (RPC unavailable) clears nothing. */
    fun cleared(signature: String?, landing: SignatureLanding?, lastValidBlockHeight: Long?): Boolean = when {
        signature == null -> landing == null
        landing == SignatureLanding.FAILED_FINALIZED -> true
        landing == SignatureLanding.NOT_FOUND -> lastValidBlockHeight != null
        else -> false
    }

    /** With a signature the cluster itself answered, so the notice states a fact. With NONE, all this device knows is
     * that the server ended the payment unpaid and the margin passed: the wallet is the only witness of what it
     * sent, so the notice says so instead of promising that nothing was charged. */
    fun notice(landing: SignatureLanding?, deposit: Boolean = false): String = when {
        landing == SignatureLanding.FAILED_FINALIZED && deposit -> "THAT DEPOSIT FAILED ON THE NETWORK — NO KEEP LEFT YOUR WALLET, ONLY THE SMALL NETWORK FEE. YOU CAN DEPOSIT AGAIN."
        landing == SignatureLanding.FAILED_FINALIZED -> "THAT PAYMENT FAILED ON THE NETWORK — ONLY THE SMALL NETWORK FEE WAS SPENT. YOU CAN BUY AGAIN."
        landing == SignatureLanding.NOT_FOUND && deposit -> "THAT DEPOSIT NEVER WENT THROUGH — NOTHING WAS SENT. YOU CAN DEPOSIT AGAIN."
        landing == SignatureLanding.NOT_FOUND -> "THAT PAYMENT NEVER WENT THROUGH — NOTHING WAS CHARGED. YOU CAN BUY AGAIN."
        deposit -> "THAT DEPOSIT DID NOT GO THROUGH ON OUR SIDE. IF YOUR WALLET SHOWS IT SENT, CONTACT SUPPORT BEFORE DEPOSITING AGAIN."
        else -> "THAT PAYMENT DID NOT GO THROUGH ON OUR SIDE. IF YOUR WALLET SHOWS A CHARGE, CONTACT SUPPORT BEFORE BUYING AGAIN."
    }

    /** The plate's line while an ended attempt waits for the margin or the cluster's answer. */
    const val CHECKING = "CHECKING THAT NOTHING WAS CHARGED — THIS CLEARS BY ITSELF IN A FEW MINUTES."
    const val CHECKING_DEPOSIT = "CHECKING THAT NOTHING WAS SENT — THIS CLEARS BY ITSELF IN A FEW MINUTES."
}
