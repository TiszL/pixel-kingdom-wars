package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WalletRecentAuthTest {
    private val wallet = base58(ByteArray(32) { it.toByte() })
    private val signature = ByteArray(64) { (it + 1).toByte() }
    private val now = Instant.parse("2026-09-12T00:00:00Z")
    private val message = "Pixel Kingdom Wars\nქართული 🔐\nexact sensitive intent"
    private val intent = jsonBody("idempotencyKey" to "frozen-order", "grossAmount" to "100")
    private fun challenge() = jsonBody("message" to message, "challengeToken" to "challenge", "expiresAt" to now.plusSeconds(60).toString())
    private fun grant(purpose: String = "withdrawal", expiry: Instant = now.plusSeconds(120)) =
        jsonBody("purpose" to purpose, "grant" to "memory-only", "expiresAt" to expiry.toString())
    private fun signer(sign: suspend (ByteArray) -> ByteArray = { signature.copyOf() }) = object : WalletSigner {
        override val address = wallet
        override suspend fun signMessage(message: ByteArray) = sign(message)
    }

    @Test fun `exact unicode challenge and frozen intent yield an ephemeral proof`() = runBlocking {
        var signs = 0; var verifies = 0
        val auth = WalletRecentAuth({ body ->
            assertEquals("withdrawal", body.string("purpose")); assertEquals(intent, body["intent"]); challenge()
        }, { body ->
            verifies++; assertEquals(jsonBody("challengeToken" to "challenge", "signature" to base58(signature)), body); grant()
        }, { now })
        val proof = auth.prove(RecentAuthPurpose.WITHDRAWAL, signer { bytes ->
            signs++; assertArrayEquals(message.toByteArray(Charsets.UTF_8), bytes); signature
        }, wallet, intent) {}
        assertEquals(1, signs); assertEquals(1, verifies)
        assertEquals("memory-only", proof.grant)
        assertEquals(jsonBody("challengeToken" to "challenge", "signature" to base58(signature)), proof.withdrawalAuthorization())
        assertEquals("RecentWalletProof(redacted)", proof.toString())
    }

    @Test fun `identity changes after challenge or signing stop verification`() = runBlocking {
        for (atChallenge in listOf(true, false)) {
            var current = true; var verifies = 0; var signs = 0
            val auth = WalletRecentAuth({ challenge().also { if (atChallenge) current = false } }, { verifies++; grant() }, { now })
            try {
                auth.prove(RecentAuthPurpose.WITHDRAWAL, signer { signs++; current = false; signature }, wallet, intent) {
                    if (!current) throw CancellationException("Identity changed")
                }; fail("Stale proof continued")
            } catch (_: CancellationException) { }
            assertEquals(if (atChallenge) 0 else 1, signs); assertEquals(0, verifies)
        }
    }

    @Test fun `lost verification never repeats the signature or either POST`() = runBlocking {
        var asks = 0; var signs = 0; var verifies = 0
        val auth = WalletRecentAuth({ asks++; challenge() }, { verifies++; throw IOException("Lost response") }, { now })
        try { auth.prove(RecentAuthPurpose.WITHDRAWAL, signer { signs++; signature }, wallet, intent) {}; fail("Lost response accepted") }
        catch (_: IOException) { }
        assertEquals(1, asks); assertEquals(1, signs); assertEquals(1, verifies)
    }

    @Test fun `expired or wrong purpose responses cannot authorize another action`() = runBlocking {
        for (reply in listOf(grant("factor_change"), grant(expiry = now), grant() - "grant")) {
            val auth = WalletRecentAuth({ challenge() }, { JsonObject(reply) }, { now })
            try { auth.prove(RecentAuthPurpose.WITHDRAWAL, signer(), wallet, intent) {}; fail("Invalid grant accepted") }
            catch (_: IllegalArgumentException) { } catch (_: IllegalStateException) { }
        }
    }

    @Test fun `expired challenge or wrong wallet never reaches a signature`() = runBlocking {
        var signs = 0; var asks = 0
        val auth = WalletRecentAuth({ asks++; JsonObject(challenge() + ("expiresAt" to JsonPrimitive(now.toString()))) }, { grant() }, { now })
        try { auth.prove(RecentAuthPurpose.WITHDRAWAL, signer { signs++; signature }, wallet, intent) {}; fail("Expired challenge signed") }
        catch (_: IllegalArgumentException) { }
        try { auth.prove(RecentAuthPurpose.WITHDRAWAL, signer { signs++; signature }, "other", intent) {}; fail("Wrong wallet requested") }
        catch (_: IllegalStateException) { }
        assertEquals(1, asks); assertEquals(0, signs)
    }

    @Test fun `confirmation expiry during wallet prompt and malformed signatures prevent verification`() = runBlocking {
        for (expire in listOf(false, true)) {
            var clock = now; var verifies = 0
            val auth = WalletRecentAuth({ challenge() }, { verifies++; grant() }, { clock })
            try {
                auth.prove(RecentAuthPurpose.WITHDRAWAL, signer { if (expire) clock = now.plusSeconds(60); if (expire) signature else ByteArray(63) }, wallet, intent) {}
                fail("Invalid signing response verified")
            } catch (_: IllegalArgumentException) { }
            assertEquals(0, verifies)
        }
    }
}
