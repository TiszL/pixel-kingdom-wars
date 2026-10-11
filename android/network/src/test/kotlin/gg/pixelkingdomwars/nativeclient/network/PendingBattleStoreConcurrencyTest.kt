package gg.pixelkingdomwars.nativeclient.network

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.junit.Test
import org.junit.Assert.*

class PendingBattleStoreConcurrencyTest {
    private class SlowSecret : SecretStore {
        @Volatile var value: String? = null
        @Volatile var pauseNextWrite = false
        val writing = CountDownLatch(1)
        val resume = CountDownLatch(1)
        override fun read() = value
        override fun write(value: String) {
            if (pauseNextWrite) {
                pauseNextWrite = false; writing.countDown()
                check(resume.await(5, TimeUnit.SECONDS))
            }
            this.value = value
        }
        override fun clear() { value = null }
    }
    @Test fun `session replacement cannot lose another wallet journal while old persistence finishes`() {
        val secret = SlowSecret()
        // AppGraph owns this journal for its whole origin lifetime; repositories change per session.
        val owner = PendingBattleStore(secret)
        val old = PendingBattle("first-wallet", "first-base", raidId = "old-raid")
        val next = PendingBattle("second-wallet", "second-base", raidId = "new-raid")
        val executor = Executors.newFixedThreadPool(2)
        try {
            secret.pauseNextWrite = true
            val firstSession = executor.submit<Boolean> { owner.replace(null, old) }
            assertTrue(secret.writing.await(5, TimeUnit.SECONDS))
            val entered = CountDownLatch(1)
            val nextSession = executor.submit<Boolean> { entered.countDown(); owner.replace(null, next) }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertThrows(TimeoutException::class.java) { nextSession.get(100, TimeUnit.MILLISECONDS) }
            secret.resume.countDown()
            assertTrue(firstSession.get(5, TimeUnit.SECONDS)); assertTrue(nextSession.get(5, TimeUnit.SECONDS))
            assertEquals(old, owner.get(old.wallet, old.baseId)); assertEquals(next, owner.get(next.wallet, next.baseId))
        } finally { secret.resume.countDown(); executor.shutdownNow() }
    }
    @Test fun `same wallet recovery must observe prior persistence before replacing its original intent`() {
        val secret = SlowSecret(); val owner = PendingBattleStore(secret)
        val original = PendingBattle("wallet", "base", raidId = "original-id")
        val replacement = original.copy(raidId = "different-id")
        val executor = Executors.newFixedThreadPool(2)
        try {
            secret.pauseNextWrite = true
            val oldSession = executor.submit<Boolean> { owner.replace(null, original) }
            assertTrue(secret.writing.await(5, TimeUnit.SECONDS))
            val newSession = executor.submit<Boolean> { owner.replace(null, replacement) }
            secret.resume.countDown(); assertTrue(oldSession.get(5, TimeUnit.SECONDS))
            assertFalse("A new session must recover the saved original request, not invent another", newSession.get(5, TimeUnit.SECONDS))
            assertEquals(original, owner.get("wallet", "base"))
            assertTrue(owner.replace(original, replacement))
            assertFalse("An obsolete receipt cannot erase a newer intent", owner.clear("wallet", "base", original))
            assertEquals(replacement, owner.get("wallet", "base"))
        } finally { secret.resume.countDown(); executor.shutdownNow() }
    }
}
