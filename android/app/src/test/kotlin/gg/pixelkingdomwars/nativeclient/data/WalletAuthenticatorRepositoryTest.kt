package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.PrivyTotpSetup
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class WalletAuthenticatorRepositoryTest {
    private class Fixture {
        var current = true; var embedded = true; var enrolled = false
        val calls = mutableListOf<String>()
        var onBegin: suspend () -> Unit = {}; var onFinish: suspend () -> Unit = {}
        val repo = WalletAuthenticatorRepository("wallet", { check(current) }, { embedded },
            read = { guard -> guard(); calls += "read"; enrolled },
            begin = { guard -> guard(); calls += "begin"; onBegin(); guard(); PrivyTotpSetup("wallet", "user", "SECRET") },
            finish = { _, code, guard -> guard(); calls += "finish:$code"; onFinish(); guard(); enrolled = true })
        init { repo.setForeground(true) }
        suspend fun setup(): PrivyTotpSetup { repo.refresh(); repo.start(true); return requireNotNull(repo.state.value.setup) }
    }
    @Test fun `explicit acknowledged setup is verified and confirmed from fresh provider state`() = runBlocking {
        val f = Fixture(); val setup = f.setup(); assertEquals("SECRET", setup.secret)
        f.repo.verify(setup, "123456")
        assertEquals(listOf("read", "read", "begin", "finish:123456", "read"), f.calls)
        assertEquals(true, f.repo.state.value.enrolled); assertNull(f.repo.state.value.setup)
    }
    @Test fun `risk acknowledgement is required before generating irreversible factor setup`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.repo.start(false)
        assertEquals(listOf("read"), f.calls); assertNull(f.repo.state.value.setup)
    }
    @Test fun `another device enrollment is observed before a new secret can replace it`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.enrolled = true; f.repo.start(true)
        assertEquals(listOf("read", "read"), f.calls); assertEquals(true, f.repo.state.value.enrolled)
    }
    @Test fun `external wallet does not initialize provider or offer a factor`() = runBlocking {
        val f = Fixture(); f.embedded = false; f.repo.refresh(); f.repo.start(true)
        assertEquals(false, f.repo.state.value.embedded); assertTrue(f.calls.isEmpty())
    }
    @Test fun `background erases setup and rejects late generation publication`() = runBlocking {
        val f = Fixture(); f.repo.refresh(); f.onBegin = { f.repo.setForeground(false) }
        try { f.repo.start(true); fail("must cancel") } catch (_: CancellationException) {}
        assertNull(f.repo.state.value.setup); assertFalse(f.repo.state.value.busy)
    }
    @Test fun `discarded setup cannot enroll even if the same wallet remains active`() = runBlocking {
        val f = Fixture(); val setup = f.setup(); f.repo.dismissSetup(); f.repo.verify(setup, "123456")
        assertFalse(f.calls.any { it.startsWith("finish:") }); assertNull(f.repo.state.value.setup)
    }
    @Test fun `unknown enrollment clears secret and performs no automatic retry`() = runBlocking {
        val f = Fixture(); val setup = f.setup(); f.onFinish = { f.enrolled = true; error("lost reply with secret") }
        f.repo.verify(setup, "123456")
        assertNull(f.repo.state.value.setup); assertNull(f.repo.state.value.enrolled)
        assertFalse(f.repo.state.value.message!!.contains("secret")); assertEquals(1, f.calls.count { it.startsWith("finish:") })
        f.repo.refresh(); assertEquals(true, f.repo.state.value.enrolled)
        assertEquals(1, f.calls.count { it.startsWith("finish:") })
    }
    @Test fun `identity changes invalidate pending setup without submitting its code`() = runBlocking {
        val f = Fixture(); val setup = f.setup(); f.current = false
        try { f.repo.verify(setup, "123456"); fail("identity fence") } catch (_: IllegalStateException) {}
        assertFalse(f.calls.any { it.startsWith("finish:") }); assertNull(f.repo.state.value.setup)
    }
    @Test fun `process recreation restores no secret or enrollment acknowledgement`() = runBlocking {
        val f = Fixture(); f.setup(); val reopened = Fixture()
        assertNull(reopened.repo.state.value.setup); assertNull(reopened.repo.state.value.enrolled)
    }
    @Test fun `transient setup object does not expose the secret in diagnostic text`() {
        val setup = PrivyTotpSetup("wallet", "user", "SECRET")
        assertFalse(setup.toString().contains("SECRET"))
    }
}
