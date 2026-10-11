package gg.pixelkingdomwars.nativeclient.network

import org.junit.Assert.*
import org.junit.Test

class StorageNamespaceTest {
    @Test fun `production upgrade preserves existing credentials and ambiguous receipts`() {
        listOf("session","pending-training","base-selection","mwa").forEach {
            assertEquals(it,storageNamespace("https://play.pixelkingdomwars.com",it))
        }
    }
    @Test fun `local profiles cannot inherit production or another test server authentication`() {
        val local = storageNamespace("https://127.0.0.1:18443","session")
        assertNotEquals("session",local)
        assertNotEquals(local,storageNamespace("https://192.168.1.2:18443","session"))
        assertNotEquals(local,storageNamespace("https://127.0.0.1:18444","session"))
    }
}
