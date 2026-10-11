package gg.pixelkingdomwars.nativeclient.ui.phasee

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Source-level Compose call-site contract. Device restoration proof still belongs to the content pipeline. */
class PhaseERoutedStructureTest {
    @Test fun `NavHost content has one unconditional call site across session restoration`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/phasee/PhaseERoutedBuildingScope.kt").readText()
        assertEquals("Two call sites discard destination remembers on session changes", 1,
            Regex("\\bcontent\\(\\)").findAll(source).count())
        val body = source.substring(source.indexOf("@Composable internal fun PhaseERoutedBuildingScope"),
            source.indexOf("@Composable private fun PhaseERoutedBuildingSessionScope"))
        assertTrue(body.indexOf("CompositionLocalProvider") < body.indexOf("content()"))
        assertTrue(body.indexOf("Box(") < body.indexOf("content()"))
        assertTrue(body.indexOf("content()") < body.indexOf("if (session != null)"))
    }
    @Test fun `restored owned receipt sheets preserve history mode with the same actor keys`() {
        for (name in listOf("KeepEquipmentMarketRegistration", "EquipmentRegistration", "PaidStarterExpeditionRegistration", "VehicleRegistration")) {
            val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/phasee/$name.kt").readText()
            val show = Regex("var show by rememberSaveable\\(([^)]*)\\)").find(source)
            val history = Regex("var historyOnly by rememberSaveable\\(([^)]*)\\)").find(source)
            assertNotNull("$name must save its open state", show)
            assertNotNull("$name must save receipt-only mode", history)
            val keys = show!!.groupValues[1].replace(" ", "")
            assertEquals(name, keys, history!!.groupValues[1].replace(" ", ""))
            assertEquals(name, "session.session.wallet,session.session.origin", keys)
        }
    }
    @Test fun `restored vehicle sheet keeps its explicit entry point for the same actor`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/phasee/VehicleRegistration.kt").readText()
        assertTrue(Regex("var entryPoint by rememberSaveable\\(session\\.session\\.wallet,\\s*session\\.session\\.origin\\)").containsMatchIn(source))
    }

}
