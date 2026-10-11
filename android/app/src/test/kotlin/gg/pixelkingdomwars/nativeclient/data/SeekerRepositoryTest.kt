package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerRepositoryTest {
    private val auxiliary = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val mint = "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD"
    private val nonce = "a".repeat(48)
    private fun status(linked: Boolean, domain: String? = null, stale: Boolean = false) = json("""{"linked":$linked,"seekerWallet":${if(linked) "\"$auxiliary\"" else "null"},"sgtMint":${if(linked) "\"$mint\"" else "null"},"memberNumber":null,"skrDomain":${domain?.let { "\"$it\"" } ?: "null"},"verifiedAt":${if(linked) "\"2026-09-12T00:00:00Z\"" else "null"},"stale":$stale,"verificationSources":${if(linked) 1 else 0},"unconfirmed":$linked}""")
    private fun message() = listOf("localhost:18443 wants you to link a Solana Mobile Seeker wallet:", auxiliary, "",
        "Linking to Pixel Kingdom Wars account: $WALLET", "This proves you control the Seeker wallet. It grants no spending permission, triggers no blockchain transaction, and costs no fees.",
        "", "Nonce: $nonce", "Issued At: 2026-09-12T00:00:00.000Z").joinToString("\n")
    private inner class Fixture(val disk: MemoryStore = MemoryStore()) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SeekerJournal(disk, session)
        var row = status(false); var hydration = 0; var offline = false; var signs = 0
        var afterChallenge: () -> Unit = {}; var afterSign: () -> Unit = {}
        val repo = SeekerRepository(session, holder, api, journal, { SeekerBounds(24,5) }) { if (offline) throw IOException("offline"); hydration++ }
        val signer = SeekerProofWallet { challenge, guard ->
            guard(); val bytes = challenge(auxiliary); assertEquals(message(), bytes.toString(Charsets.UTF_8)); afterChallenge()
            guard(); signs++; afterSign(); SeekerLinkProof(auxiliary, ByteArray(64) { 3 })
        }
        init {
            repo.interaction.setForeground(true)
            api.onGet("/seeker/status") { row }
            api.onPost("/seeker/link/challenge") { assertEquals(auxiliary, it.string("seekerWallet"));
                jsonBody("nonce" to nonce, "message" to message(), "expiresAt" to "2026-09-12T00:05:00.000Z") }
            api.onPost("/seeker/link/verify") { body ->
                assertEquals("link", journal.read()); assertEquals(auxiliary, body.string("seekerWallet")); assertNotNull(body.string("signature"))
                assertFalse(disk.value!!.contains("signature")); assertFalse(disk.value!!.contains(nonce))
                row = status(true); buildJsonObject { put("seeker", row); put("username", JsonNull) }
            }
            api.onPost("/seeker/skr/adopt") { assertEquals("domain", journal.read()); row = status(true, "owner.skr"); buildJsonObject { put("seeker",row); put("username","owner") } }
            api.onDelete("/seeker/link") { assertEquals("unlink",journal.read()); row=status(false); json("{\"ok\":true}") }
        }
    }
    @Test fun `link signs only auxiliary challenge and hydrates server badge without changing session`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.repo.link(f.signer, "")
        assertEquals(listOf("/seeker/link/challenge", "/seeker/link/verify"), f.api.posts.map { it.first })
        assertSame(f.session, f.holder.session.value); assertEquals(WALLET, f.session.wallet)
        assertTrue(f.repo.state.value.status!!.verified); assertTrue(f.repo.state.value.status!!.unconfirmed)
        assertEquals(2,f.hydration); assertNull(f.disk.value)
    }
    @Test fun `domain is optional and cosmetic while server discovery owns its result`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.repo.link(f.signer, "  mine.skr  ")
        assertEquals("mine.skr", f.api.posts.last().second.string("skrDomain")); assertNull(f.repo.state.value.status!!.skrDomain)
        f.repo.adoptDomain(); assertEquals("owner.skr",f.repo.state.value.status!!.skrDomain); assertEquals(1,f.signs)
        assertSame(f.session,f.holder.session.value)
    }
    @Test fun `lost verification persists only action label and restart reads current state without another signature`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.api.onPost("/seeker/link/verify") { f.row=status(true); throw IOException("lost") }
        f.repo.link(f.signer,""); assertEquals("link",f.journal.read()); assertFalse(f.repo.state.value.status!!.linked)
        f.repo.link(f.signer,""); assertEquals(1,f.signs)
        val restored=Fixture(f.disk); restored.row=f.row; restored.repo.refresh()
        assertTrue(restored.api.posts.isEmpty()); assertTrue(restored.repo.state.value.status!!.linked); assertNull(restored.disk.value)
        assertTrue(restored.repo.state.value.notice!!.contains("not resubmitted"))
    }
    @Test fun `unlink and interrupted unlink render only server state and never repeat DELETE on refresh`() = runBlocking {
        val f=Fixture(); f.row=status(true); f.repo.refresh(); f.repo.unlink()
        assertFalse(f.repo.state.value.status!!.linked); assertEquals(1,f.api.deletes.size); assertSame(f.session,f.holder.session.value)
        f.row=status(true); f.repo.refresh(); f.api.onDelete("/seeker/link") { f.row=status(false); throw IOException("lost") }
        f.repo.unlink(); assertTrue(f.repo.state.value.status!!.linked); assertEquals("unlink",f.journal.read())
        f.repo.refresh(); assertFalse(f.repo.state.value.status!!.linked); assertEquals(2,f.api.deletes.size)
    }
    @Test fun `lost cosmetic adoption keeps request for GET recovery without replaying domain mutation`() = runBlocking {
        val f=Fixture(); f.row=status(true); f.repo.refresh()
        f.api.onPost("/seeker/skr/adopt") { f.row=status(true,"owner.skr"); throw IOException("lost") }
        f.repo.adoptDomain(); assertNull(f.repo.state.value.status!!.skrDomain); assertEquals("domain",f.journal.read())
        f.repo.refresh(); assertEquals("owner.skr",f.repo.state.value.status!!.skrDomain); assertEquals(1,f.api.posts.size)
    }
    @Test fun `failed hydration keeps pending request without publishing accepted badge`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.offline=true; f.repo.link(f.signer,"")
        assertFalse(f.repo.state.value.status!!.linked); assertEquals("link",f.journal.read())
        f.offline=false; f.repo.refresh(); assertTrue(f.repo.state.value.status!!.linked); assertEquals(2,f.api.posts.size)
    }
    @Test fun `declined signing sends no verification and leaves no durable challenge`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.repo.link(SeekerProofWallet { ask,_ -> ask(auxiliary); throw IOException("declined") },"")
        assertEquals(listOf("/seeker/link/challenge"),f.api.posts.map { it.first }); assertNull(f.disk.value)
    }
    @Test fun `identity supersession during challenge or signing cannot link old game account`() = runBlocking {
        for (after in listOf(false,true)) {
            val f=Fixture(); f.repo.refresh()
            if(after) f.afterSign={ signedIn(f.holder) } else f.afterChallenge={ signedIn(f.holder) }
            try { f.repo.link(f.signer,""); fail("Old epoch must cancel") } catch (_: CancellationException) {}
            assertEquals(listOf("/seeker/link/challenge"),f.api.posts.map { it.first }); assertNull(f.disk.value)
        }
    }
    @Test fun `cancelled wallet operation cannot continue after screen Back`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); val entered=CompletableDeferred<Unit>()
        val job=launch { f.repo.link(SeekerProofWallet { ask,_ -> ask(auxiliary); entered.complete(Unit); awaitCancellation() },"") }
        entered.await(); job.cancelAndJoin(); assertEquals(1,f.api.posts.size); assertNull(f.disk.value)
    }
    @Test fun `concurrent taps produce one auxiliary wallet challenge`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); val entered=CompletableDeferred<Unit>(); val release=CompletableDeferred<Unit>()
        val first=launch { f.repo.link(SeekerProofWallet { ask,_ -> ask(auxiliary); entered.complete(Unit); release.await(); SeekerLinkProof(auxiliary,ByteArray(64){3}) },"") }
        entered.await(); f.repo.link(f.signer,""); release.complete(Unit); first.join(); assertEquals(2,f.api.posts.size)
    }
    @Test fun `wrong server link and stale proof cannot grant native badge`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.api.onPost("/seeker/link/verify") { buildJsonObject { put("seeker", status(false)) } }
        f.repo.link(f.signer,""); assertFalse(f.repo.state.value.status!!.verified); assertNotNull(f.disk.value)
        f.row=status(true,stale=true); f.repo.refresh(); assertTrue(f.repo.state.value.status!!.linked); assertFalse(f.repo.state.value.status!!.verified)
    }
    @Test fun `manual recheck passes server hint and malformed or cross-identity journal blocks mutations`() = runBlocking {
        val f=Fixture(); f.repo.refresh(true); assertEquals(mapOf("refresh" to "1"),f.api.gets.single().second)
        val corrupt=Fixture(MemoryStore("invalid")); corrupt.repo.refresh(); corrupt.repo.link(corrupt.signer,"")
        assertFalse(corrupt.repo.state.value.loaded); assertTrue(corrupt.api.posts.isEmpty())
        f.journal.begin("domain"); assertThrows(IllegalStateException::class.java) { SeekerJournal(f.disk,signedIn(testHolder(),"other")).read() }
        Unit
    }
    @Test fun `canonical controls and strict status never invent badge or domain`() {
        assertNull(SeekerBounds.from(json("{}")))
        assertEquals(SeekerBounds(12,7),SeekerBounds.from(json("""{"constants":{"SEEKER":{"recheckHours":12,"linkChallengeTtlMin":7}}}""")))
        assertThrows(Exception::class.java) { SeekerIdentityStatus.from(json("""{"linked":true}""")) }
        assertThrows(Exception::class.java) { SeekerIdentityStatus.from(JsonObject(status(true)+("sgtMint" to JsonPrimitive("wrong")))) }
    }

    @Test fun `background cancels ordinary mutations after acceptance without clearing recovery`() = runBlocking {
        for (unlink in listOf(true, false)) {
            val f=Fixture(); f.row=status(true); f.repo.refresh()
            if(unlink) f.api.onDelete("/seeker/link") { f.repo.interaction.onLifecycleEvent(androidx.lifecycle.Lifecycle.Event.ON_PAUSE); f.row=status(false); json("{\"ok\":true}") }
            else f.api.onPost("/seeker/skr/adopt") { f.repo.interaction.onLifecycleEvent(androidx.lifecycle.Lifecycle.Event.ON_PAUSE); f.row=status(true,"a.skr"); buildJsonObject { put("seeker",f.row) } }
            try { if(unlink) f.repo.unlink() else f.repo.adoptDomain(); fail("Background response must cancel") } catch (_: CancellationException) {}
            assertNotNull(f.journal.read()); assertEquals(1,f.api.gets.size)
            f.repo.interaction.setForeground(true); f.repo.refresh(); assertNull(f.journal.read())
        }
    }
    @Test fun `translucent wallet activity pause without stop waits for resume before verification`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); val signed=CompletableDeferred<Unit>()
        val job=launch { f.repo.link(SeekerProofWallet { ask,guard ->
            f.repo.interaction.onLifecycleEvent(androidx.lifecycle.Lifecycle.Event.ON_PAUSE); guard(); ask(auxiliary); guard(); signed.complete(Unit)
            SeekerLinkProof(auxiliary,ByteArray(64){3})
        },"") }
        signed.await(); yield(); assertEquals(1,f.api.posts.size); assertNull(f.disk.value)
        f.repo.interaction.onLifecycleEvent(androidx.lifecycle.Lifecycle.Event.ON_RESUME); job.join(); assertEquals(2,f.api.posts.size); assertTrue(f.repo.state.value.status!!.verified)
    }
    @Test fun `background screen cannot start an action and disposed wallet proof cannot verify on return`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.repo.interaction.setForeground(false)
        try { f.repo.link(f.signer,""); fail("Background action") } catch (_: CancellationException) {}
        assertTrue(f.api.posts.isEmpty()); f.repo.interaction.setForeground(true)
        f.afterSign={ f.repo.interaction.close(); f.repo.interaction.setForeground(true) }
        try { f.repo.link(f.signer,""); fail("Disposed proof") } catch (_: CancellationException) {}
        assertEquals(1,f.api.posts.size); assertNull(f.disk.value)
    }
}
