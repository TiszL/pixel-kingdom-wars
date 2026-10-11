package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.WALLET
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetJournalTest {
    private val base = "11111111-1111-4111-8111-111111111111"
    @Test fun `intent is durable before admission and identity namespaces cannot cross`() {
        val disk = MemoryStore(); val journal = SkrFaucetJournal(disk, WALLET, "https://localhost:18443", "devnet")
        val intent = journal.begin(base); assertEquals(intent, journal.read())
        assertThrows(IllegalArgumentException::class.java) { SkrFaucetJournal(disk, WALLET, "https://another.invalid", "devnet").read() }
        assertThrows(IllegalArgumentException::class.java) { SkrFaucetJournal(disk, "other", "https://localhost:18443", "devnet").read() }
    }
    @Test fun `corrupt encryption payload is never treated as empty history`() {
        val disk = MemoryStore("not-json")
        assertThrows(Exception::class.java) { SkrFaucetJournal(disk, WALLET, "https://localhost:18443", "devnet").read() }
        assertEquals("not-json", disk.value)
    }
    @Test fun `old wallet callback cannot replace newer intent in same identity`() {
        val journal = SkrFaucetJournal(MemoryStore(), WALLET, "https://localhost:18443", "devnet")
        val first = journal.begin(base); val second = journal.begin(base)
        assertThrows(IllegalArgumentException::class.java) { journal.replace(first, first) }
        assertEquals(second, journal.read())
    }
}
