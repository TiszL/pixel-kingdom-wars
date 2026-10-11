package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ops.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The actual AppGraph lazy delegate must outlive sessions: SecretStore's per-call safety
 * cannot protect a PendingIntentStore read/compare/write across two different monitors. */
class UnifiedPendingIntentsLifetimeTest {
    private fun intent(wallet:String=WALLET,key:String="original-command")=PendingIntent(
        IntentKind.HERO_UPGRADE,wallet,BASE_ID,key,"/heroes/hero/upgrade",
        buildJsonObject {put("baseId",BASE_ID);put("idempotencyKey",key)},"Upgrade hero",attempted=true,expectedCurrency="KEEP")

    @Test fun `concurrent session journal access initializes one store and preserves exact encrypted names`() {
        val opened=ConcurrentLinkedQueue<String>();val stores=ConcurrentHashMap<String,SecretStore>()
        val lifetime=unifiedPendingIntents {name->opened.add(name);stores.computeIfAbsent(name){MemoryStore()}}
        assertFalse(lifetime.isInitialized());assertTrue(opened.isEmpty())
        val start=CountDownLatch(1);val results=ConcurrentLinkedQueue<PendingIntentStore>();val failures=ConcurrentLinkedQueue<Throwable>()
        val workers=(1..8).map {thread(isDaemon=true) {try {check(start.await(5,TimeUnit.SECONDS));results.add(lifetime.value)} catch(e:Throwable){failures.add(e)}}}
        start.countDown();workers.forEach {it.join(5_000);assertFalse(it.isAlive)}
        assertTrue(failures.toString(),failures.isEmpty());assertEquals(8,results.size)
        results.forEach {assertSame(lifetime.value,it)}
        assertEquals(listOf("pending-intents","pending-training","pending-construction","training-cancellation","pending-research"),opened.toList())
    }

    @Test fun `late old-session refusal and another wallet writer share the complete compare-write lock`() {
        val entered=CountDownLatch(1);val release=CountDownLatch(1);val oldStarted=CountDownLatch(1)
        val failures=ConcurrentLinkedQueue<Throwable>();var block=false
        val disk=object:SecretStore {
            @Volatile var value:String?=null
            override fun read()=value
            override fun write(next:String) {
                if(block && Thread.currentThread().name=="replacement-session") {entered.countDown();check(release.await(5,TimeUnit.SECONDS))}
                value=next
            }
            override fun clear(){value=null}
        }
        val lifetime=unifiedPendingIntents {if(it=="pending-intents") disk else MemoryStore()}
        val oldSession=lifetime.value;val replacementSession=lifetime.value
        val original=intent();val other=intent("another-wallet","other-wallet-key")
        assertTrue(oldSession.create(original));block=true
        val writer=thread(name="replacement-session",isDaemon=true) {try {assertTrue(replacementSession.create(other))} catch(e:Throwable){failures.add(e)}}
        var late:Thread?=null
        try {
            assertTrue(entered.await(5,TimeUnit.SECONDS))
            late=thread(name="late-original-evidence",isDaemon=true) {try {oldStarted.countDown();assertTrue(oldSession.clearIfMatching(original))} catch(e:Throwable){failures.add(e)}}
            assertTrue(oldStarted.await(5,TimeUnit.SECONDS))
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            while(late.isAlive && late.state!=Thread.State.BLOCKED && System.nanoTime()<deadline) Thread.yield()
            assertEquals("The old session must wait through the new wallet's whole read/write",Thread.State.BLOCKED,late.state)
        } finally {release.countDown();writer.join(5_000);late?.join(5_000)}
        assertFalse(writer.isAlive);assertFalse(requireNotNull(late).isAlive);assertTrue(failures.toString(),failures.isEmpty())
        assertNull(lifetime.value.get(original.kind,original.wallet))
        assertEquals(other,lifetime.value.get(other.kind,other.wallet))
    }

    @Test fun `reauthentication never lets an old key clear or overwrite a new same-wallet intent`() {
        val stores=mutableMapOf<String,MemoryStore>();val lifetime=unifiedPendingIntents {stores.getOrPut(it){MemoryStore()}}
        val oldSession=lifetime.value;val original=intent();oldSession.create(original)
        val replacementSession=lifetime.value;assertTrue(replacementSession.clearIfMatching(original))
        val newer=intent(key="replacement-key");assertTrue(replacementSession.create(newer))
        assertFalse(oldSession.clearIfMatching(original))
        assertFalse(oldSession.replaceIfMatching(original,original.copy(receipt=buildJsonObject {put("status","accepted")})))
        assertEquals(newer,replacementSession.get(newer.kind,newer.wallet))
    }

    @Test fun `same lifetime migrates legacy data once without dropping another wallet and corruption fails closed`() {
        val stores=mutableMapOf<String,MemoryStore>();fun open(name:String)=stores.getOrPut(name){MemoryStore()}
        val other=intent("another-wallet","other-wallet-key");PendingIntentStore(open("pending-intents")).create(other)
        val body=buildJsonObject {put("baseId",BASE_ID);put("idempotencyKey","legacy-training-key")}
        open("pending-training").value=buildJsonObject {put("schemaVersion",1);put("requests",buildJsonObject {
            put(WALLET,buildJsonObject {put("body",body);put("quote",buildJsonObject {put("costShards","17")})})
        })}.toString()
        val lifetime=unifiedPendingIntents(::open)
        val inherited=lifetime.value.all(WALLET).single()
        assertEquals(IntentKind.TRAINING_BATCH,inherited.kind);assertEquals(body,inherited.body);assertTrue(inherited.attempted)
        assertNull(open("pending-training").value);assertEquals(other,lifetime.value.all(other.wallet).single())
        assertSame(lifetime.value,lifetime.value);assertEquals(inherited,lifetime.value.all(WALLET).single())
        open("pending-intents").value="{}"
        assertThrows(Exception::class.java){lifetime.value.create(intent())}
        assertEquals("{}",open("pending-intents").value)
    }
}
