package gg.pixelkingdomwars.nativeclient.data

import org.junit.Assert.*
import org.junit.Test

class DiagnosticsPreferencesTest {
    @Test fun `diagnostics stay off without an explicit persisted opt in`() {
        for (value in listOf(null, "0", "unexpected")) {
            val preferences = StoredDevicePreferences({ value }, { _, _ -> })
            assertFalse(preferences.diagnostics); assertFalse(preferences.state.value.diagnostics)
        }
        assertFalse(StoredDevicePreferences({ error("unreadable") }, { _, _ -> }).diagnostics)
    }

    @Test fun `diagnostics persist per device while money and sensory preferences remain unchanged`() {
        val disk = mutableMapOf<String, String>()
        fun open() = StoredDevicePreferences({ disk[it] }, { key, value -> disk[key] = value })
        val first = open(); val original = first.state.value
        first.diagnostics = true
        assertEquals("1", disk["skp_diag"])
        assertEquals(original.copy(diagnostics = true), open().state.value)
        val next = open(); next.diagnostics = false
        assertEquals("0", disk["skp_diag"]); assertEquals(original, open().state.value)
    }

    @Test fun `explicit opt out still takes effect when persistence fails`() {
        val preferences = StoredDevicePreferences({ if (it == "skp_diag") "1" else null }, { _, _ -> error("full") })
        assertTrue(preferences.diagnostics)
        preferences.diagnostics = false
        assertFalse(preferences.state.value.diagnostics)
    }
}
