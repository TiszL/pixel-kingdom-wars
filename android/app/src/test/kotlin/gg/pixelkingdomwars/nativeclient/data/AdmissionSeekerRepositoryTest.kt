package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AdmissionSeekerRepositoryTest {
    private val auxiliary = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val mint = "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD"
    private val nonce = "a".repeat(48)
    private fun status(linked: Boolean) = json("""{"linked":$linked,"seekerWallet":${if(linked) "\"$auxiliary\"" else "null"},"sgtMint":${if(linked) "\"$mint\"" else "null"},"memberNumber":null,"skrDomain":null,"verifiedAt":${if(linked) "\"2026-09-12T00:00:00Z\"" else "null"},"stale":false,"verificationSources":${if(linked) 1 else 0},"unconfirmed":$linked}""")
    private val message = listOf("localhost:18443 wants you to link a Solana Mobile Seeker wallet:", auxiliary, "",
        "Linking to Pixel Kingdom Wars account: $WALLET", "This proves you control the Seeker wallet. It grants no spending permission, triggers no blockchain transaction, and costs no fees.",
        "", "Nonce: $nonce", "Issued At: 2026-09-12T00:00:00.000Z").joinToString("\n")
    private inner class Fixture(val disk: MemoryStore = MemoryStore()) {
        val pending = PendingAdmission(WALLET, testToken(), SeekerIdentityStatus.from(status(false)))
        val api = FakeApiClient(); val journal = SeekerJournal(disk,WALLET,"https://localhost:18443")
        var current = true; var admitted = false; var row = status(false); var entered = 0; var signs = 0; var failEnter = false
        var bounds: SeekerBounds? = SeekerBounds(24,5)
        fun guard() { if (!current) throw SessionSupersededException() }
        val repo = AdmissionSeekerRepository(pending,"https://localhost:18443",api,journal,{bounds},::guard,{
            guard(); if(failEnter) throw IOException("Account refresh failed")
            entered++; current=false
        })
        val signer = SeekerProofWallet { ask,guard ->
            guard(); assertEquals(message, ask(auxiliary).toString(Charsets.UTF_8)); signs++
            guard(); SeekerLinkProof(auxiliary,ByteArray(64){3})
        }
        fun probe(wallet: String = WALLET) = buildJsonObject { put("wallet",wallet); put("admitted",admitted); put("seeker",row) }
        init {
            repo.interaction.setForeground(true)
            api.onPost("/alpha/seeker") { probe() }
            api.onPost("/seeker/link/challenge") { jsonBody("nonce" to nonce,"message" to message,"expiresAt" to "2026-09-12T00:05:00.000Z") }
            api.onPost("/seeker/link/verify") {
                assertEquals("link",journal.read()); assertFalse(disk.value!!.contains("signature")); assertFalse(disk.value!!.contains(nonce))
                row=status(true); admitted=true; buildJsonObject { put("seeker",row); put("username",JsonNull) }
            }
        }
    }
    @Test fun `admission checks never sign or install gameplay from badge alone`() = runBlocking {
        val f=Fixture(); f.row=status(true); f.repo.refresh()
        assertEquals(listOf("/alpha/seeker"),f.api.posts.map { it.first }); assertEquals(0,f.signs); assertEquals(0,f.entered)
        assertTrue(f.repo.state.value.loaded); assertTrue(f.repo.state.value.status!!.linked); assertTrue(f.current)
        assertTrue(f.api.gets.isEmpty()); assertTrue(f.api.deletes.isEmpty())
    }
    @Test fun `explicit auxiliary proof preserves pending game wallet and enters only after server admission`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.repo.link(f.signer," owner.skr ")
        assertEquals(listOf("/alpha/seeker","/seeker/link/challenge","/seeker/link/verify","/alpha/seeker"), f.api.posts.map { it.first })
        assertEquals("owner.skr",f.api.posts[2].second.string("skrDomain")); assertEquals(WALLET,f.pending.wallet)
        assertEquals(1,f.entered); assertEquals(1,f.signs); assertFalse(f.repo.state.value.status!!.linked)
    }
    @Test fun `server admitted can enter without any Seeker link and bootstrap failures remain retryable`() = runBlocking {
        val f=Fixture(); f.admitted=true; f.failEnter=true; f.repo.refresh()
        assertEquals(0,f.entered); assertNotNull(f.repo.state.value.error); assertTrue(f.current)
        f.failEnter=false; f.repo.refresh(); assertEquals(1,f.entered); assertEquals(0,f.signs)
    }
    @Test fun `lost verification recovers after restart with admission probe only and never replays signature`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.api.onPost("/seeker/link/verify") { f.row=status(true); throw IOException("lost") }
        f.repo.link(f.signer,""); assertEquals("link",f.journal.read())
        f.repo.link(f.signer,""); assertEquals(1,f.signs)
        val restored=Fixture(f.disk); restored.row=f.row; restored.repo.refresh()
        assertEquals(listOf("/alpha/seeker"),restored.api.posts.map { it.first }); assertNull(restored.disk.value)
        assertEquals(0,restored.signs); assertEquals(0,restored.entered)
    }
    @Test fun `failure to hydrate admitted account retains interrupted label`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.failEnter=true; f.repo.link(f.signer,"")
        assertEquals("link",f.journal.read()); assertEquals(0,f.entered); assertNotNull(f.repo.state.value.error)
        f.failEnter=false; f.repo.refresh(); assertEquals(1,f.entered); assertEquals(1,f.signs)
    }
    @Test fun `wrong wallet or malformed admission verdict cannot open gameplay`() = runBlocking {
        for(wrongWallet in listOf(true,false)) {
            val f=Fixture(); f.admitted=true
            f.api.onPost("/alpha/seeker") { if(wrongWallet) f.probe(auxiliary) else JsonObject(f.probe()+("admitted" to JsonPrimitive("true"))) }
            f.repo.refresh(); assertEquals(0,f.entered); assertNotNull(f.repo.state.value.error)
        }
    }
    @Test fun `superseded proof or probe never acts on a new account or clears its journal`() = runBlocking {
        val f=Fixture(); f.repo.refresh()
        try { f.repo.link(SeekerProofWallet { ask,_ -> ask(auxiliary); f.current=false; SeekerLinkProof(auxiliary,ByteArray(64){3}) },""); fail("Old proof") } catch (_: CancellationException) {}
        assertEquals(2,f.api.posts.size); assertNull(f.disk.value); assertEquals(0,f.entered)
        val other=Fixture(); other.journal.begin("link"); other.api.onPost("/alpha/seeker") { other.current=false; other.probe() }
        try { other.repo.refresh(); fail("Old probe") } catch (_: CancellationException) {}
        assertEquals("link",other.journal.read())
    }
    @Test fun `pre admission pause without stop waits for resumed screen before verification`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); val signed=CompletableDeferred<Unit>()
        val work=launch { f.repo.link(SeekerProofWallet { ask,guard ->
            f.repo.interaction.onLifecycleEvent(androidx.lifecycle.Lifecycle.Event.ON_PAUSE); ask(auxiliary); guard(); signed.complete(Unit); SeekerLinkProof(auxiliary,ByteArray(64){3})
        },"") }
        signed.await(); yield(); assertEquals(2,f.api.posts.size); assertNull(f.disk.value)
        f.repo.interaction.onLifecycleEvent(androidx.lifecycle.Lifecycle.Event.ON_RESUME); work.join(); assertEquals(1,f.entered)
    }
    @Test fun `Back cancels wallet approval without durable proof or verification`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); val opened=CompletableDeferred<Unit>()
        val work=launch { f.repo.link(SeekerProofWallet { ask,_ -> ask(auxiliary); opened.complete(Unit); awaitCancellation() },"") }
        opened.await(); f.repo.interaction.close(); work.cancelAndJoin()
        assertNull(f.disk.value); assertEquals(2,f.api.posts.size); assertEquals(0,f.entered)
    }
    @Test fun `missing shared bounds and foreign journal block any link ceremony`() = runBlocking {
        val f=Fixture(); f.repo.refresh(); f.bounds=null; f.repo.link(f.signer,"")
        assertEquals(0,f.signs); assertEquals(1,f.api.posts.size)
        val corrupt=Fixture(MemoryStore(jsonBody("wallet" to auxiliary,"origin" to "https://localhost:18443","action" to "link").toString()))
        corrupt.repo.refresh(); assertTrue(corrupt.api.posts.isEmpty()); assertNotNull(corrupt.repo.state.value.error)
    }
}
