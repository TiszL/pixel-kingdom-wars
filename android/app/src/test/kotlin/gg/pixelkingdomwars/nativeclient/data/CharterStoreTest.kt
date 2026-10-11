package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CharterStoreTest {
    private val e=CharterFixtures.envelope()
    private class Fixture(actor:String){val memory=CharterFixtures.Memory();val identity=CharterFixtures.identity(actor);val store=CharterStore(memory,identity)}
    @Test fun `intent and action marker reopen before any external effect and unknown never clears`()=runBlocking {
        val f=Fixture(e.actor);f.store.begin(e.kind,e.key,e.state.charterObject("request"));f.store.attempt(e.key,"create")
        val reopened=CharterStore(f.memory,f.identity);assertEquals(listOf("create"),reopened.record(e.key).attempts)
        assertTrue(runCatching{reopened.attempt(e.key,"create")}.isFailure)
        assertTrue(runCatching{reopened.begin(e.kind,"10000000-0000-4000-8000-000000000001",e.state.charterObject("request"))}.isFailure)
    }
    @Test fun `failed intent write leaves no authority or partial record`()=runBlocking {
        val f=Fixture(e.actor);f.memory.fail=true;assertTrue(runCatching{f.store.begin(e.kind,e.key,e.state.charterObject("request"))}.isFailure);assertNull(f.memory.value)
        f.memory.fail=false;assertTrue(f.store.read().records.isEmpty())
    }
    @Test fun `owned response survives cancellation and immutable mismatch stays held`()=runBlocking {
        val f=Fixture(e.actor);f.store.discover(e.kind,e.key)
        withContext(NonCancellable){f.store.observe(e.key,e.raw);f.store.accept(e.key,e)}
        val changed=CharterEnvelope.from(JsonObject(e.raw+("state" to JsonObject(e.state+("original" to JsonObject(e.original+("reservationId" to JsonPrimitive("10000000-0000-4000-8000-000000000001"))))))))
        f.store.observe(e.key,changed.raw);assertTrue(runCatching{f.store.accept(e.key,changed)}.isFailure)
        val record=CharterStore(f.memory,f.identity).record(e.key);assertTrue(record.held);assertEquals(2,record.observations.size);assertEquals(e.raw,record.envelope)
    }
    @Test fun `late exact wallet signature is latched across failed durable write and flushes before effects`()=runBlocking {
        val f=Fixture(e.actor);f.store.discover(e.kind,e.key);f.store.accept(e.key,e);f.store.review(e.key,CharterFixtures.context(e));f.store.attempt(e.key,"wallet")
        val prepared=CharterTransaction.prepare(e.signing!!,CharterFixtures.pins,e.actor,CharterFixtures.crypto)
        val signed=prepared.verifySignedBase64(CharterFixtures.row.charterObject("creationWire").charterText("signedTransaction"));val record=CharterSignature(signed.wire,signed.signature,signed.transactionSignature)
        f.memory.fail=true;assertTrue(runCatching{f.store.signed(e.key,record)}.isFailure);assertTrue(runCatching{f.store.attempt(e.key,"deliver",true)}.isFailure)
        f.memory.fail=false;assertEquals(record,CharterStore(f.memory,f.identity).record(e.key).ownSignature)
    }
    @Test fun `owned signature latches before decryption reads and persisted tampering refuses on reopen`()=runBlocking {
        val f=Fixture(e.actor);f.store.discover(e.kind,e.key);f.store.accept(e.key,e);f.store.review(e.key,CharterFixtures.context(e));f.store.attempt(e.key,"wallet")
        val p=CharterTransaction.prepare(e.signing!!,CharterFixtures.pins,e.actor,CharterFixtures.crypto);val v=p.verifySignedBase64(CharterFixtures.row.charterObject("creationWire").charterText("signedTransaction"))
        f.memory.failRead=true;assertTrue(runCatching{f.store.signed(e.key,CharterSignature(v.wire,v.signature,v.transactionSignature))}.isFailure)
        f.memory.failRead=false;assertEquals(v.wire,CharterStore(f.memory,f.identity).record(e.key).ownSignature!!.wire)
        f.memory.value=f.memory.value!!.replace(v.signature,java.util.Base64.getEncoder().encodeToString(ByteArray(64){1}))
        assertTrue(runCatching{CharterStore(f.memory,f.identity).read()}.isFailure)
    }
    @Test fun `providerless history cannot downgrade retained signatures or replace prepared originals`()=runBlocking {
        val f=Fixture(e.actor);f.store.discover(e.kind,e.key);val signed=CharterFixtures.status(e,"signed",wire=CharterFixtures.row.charterObject("creationWire"));f.store.accept(e.key,signed)
        val missing=CharterFixtures.status(e,"signed");f.store.observe(e.key,missing.raw);assertTrue(runCatching{f.store.accept(e.key,missing)}.isFailure);assertEquals(signed.raw,f.store.record(e.key).envelope)
        f.store.observe(e.key,e.raw);f.store.accept(e.key,e);assertEquals(signed.raw,f.store.record(e.key).envelope)
    }
    @Test fun `cancelled creation can refine only to same terminal original payer refund`()=runBlocking {
        val f=Fixture(e.actor);f.store.discover(e.kind,e.key)
        val terminal=buildJsonObject{put("state","cancelled_unpaid");put("terminalId","20000000-0000-4000-8000-000000000001");put("terminalTransactionId",JsonNull);put("refundTransactionId",JsonNull);put("refundDestinationBaseId",JsonNull)}
        val cancelled=CharterFixtures.status(e,"cancelled_unpaid",terminal=terminal);f.store.accept(e.key,cancelled)
        val refunded=CharterFixtures.status(e,"refunded",terminal=JsonObject(terminal+mapOf("state" to JsonPrimitive("refunded"),"refundTransactionId" to JsonPrimitive("20000000-0000-4000-8000-000000000002"),"refundDestinationBaseId" to e.original.getValue("baseId"))))
        f.store.accept(e.key,refunded);assertEquals("refunded",CharterEnvelope.from(f.store.record(e.key).envelope!!).status)
        assertTrue(runCatching{f.store.accept(e.key,CharterFixtures.status(e,"activated",terminal=JsonObject(terminal+("state" to JsonPrimitive("activated")))))}.isFailure)
    }
    @Test fun `encrypted document identity never rebinds to another wallet or origin`()=runBlocking {
        val f=Fixture(e.actor);f.store.discover(e.kind,e.key);assertTrue(runCatching{CharterStore(f.memory,CharterFixtures.identity(e.actor)).read()}.isFailure)
    }
    @Test fun `malformed storage refuses rather than inventing a fresh journal`()=runBlocking {
        val f=Fixture(e.actor);f.memory.value="{";assertTrue(runCatching{f.store.read()}.isFailure);assertEquals("{",f.memory.value)
    }
}
