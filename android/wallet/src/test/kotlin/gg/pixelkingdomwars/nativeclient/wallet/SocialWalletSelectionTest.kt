package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

private class Store(var value: String? = null) : SecretStore {
    override fun read() = value
    override fun write(value: String) { this.value = value }
    override fun clear() { value = null }
}

/** The wallet a social account signs with is the one the server knows, never a substitute or a new one. */
class SocialWalletSelectionTest {
    @Test fun `the remembered server-confirmed wallet is selected whatever its position`() {
        assertEquals("B", selectExistingWallet("B", listOf("A", "B", "C")))
        assertEquals("A", selectExistingWallet("A", listOf("A")))
    }
    @Test fun `a remembered wallet missing from the account refuses instead of substituting`() {
        val error = assertThrows(SocialSignInException::class.java) { selectExistingWallet("B", listOf("A")) }
        assertTrue(error.message!!.contains("no replacement wallet was created"))
    }
    @Test fun `without memory only a single wallet is acceptable`() {
        assertEquals("A", selectExistingWallet(null, listOf("A")))
        assertTrue(assertThrows(SocialSignInException::class.java) { selectExistingWallet(null, emptyList()) }.message!!.contains("never creates wallets"))
        assertTrue(assertThrows(SocialSignInException::class.java) { selectExistingWallet(null, listOf("A", "B")) }.message!!.contains("more than one"))
    }
    @Test fun `the binding answers only for its own Privy user and survives garbage`() = runBlocking {
        val store = Store(); val binding = SocialBinding(store)
        assertNull(binding.walletOf("u1")); assertFalse(binding.isBound("A")); assertFalse(binding.hasBinding())
        binding.remember("u1", "A")
        assertEquals("A", binding.walletOf("u1")); assertNull(binding.walletOf("u2")); assertTrue(binding.isBound("A")); assertFalse(binding.isBound("B"))
        assertTrue("A sign-out that cannot name its wallet still learns a social account used this device", binding.hasBinding())
        store.value = "{not json"
        assertNull(binding.walletOf("u1")); assertFalse(binding.isBound("A")); assertFalse("Garbage is no binding", binding.hasBinding())
    }
    @Test fun `the marker is consumed exactly once and ignores unknown values`() = runBlocking {
        val store = Store(); val marker = SocialLoginMarker(store)
        assertNull(marker.consume())
        marker.set(SocialProvider.X)
        assertEquals("X", store.value); assertEquals(SocialProvider.X, marker.consume()); assertNull(store.value); assertNull(marker.consume())
        store.value = "PHONE"
        assertNull(marker.consume()); assertNull("An unknown marker is still cleared", store.value)
        marker.set(SocialProvider.EMAIL); marker.clear(); assertNull(store.value)
    }
}
