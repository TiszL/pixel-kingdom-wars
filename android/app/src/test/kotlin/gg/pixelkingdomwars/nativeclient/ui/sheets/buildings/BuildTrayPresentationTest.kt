package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class BuildTrayPresentationTest {
    private fun card(reason: String?, state: BuildCardState = BuildCardState.UNAVAILABLE) =
        BuildCardUi("mine", "MINE", "", "", "0/1", Verb.BLUE, state, null, null, reason, false, null)

    @Test fun `ordinary cards use their own transparent identity sources`() {
        for (type in listOf("mine", "vault", "barracks", "forge", "camp", "clanhall")) {
            val name = ordinaryBuildTrayPortrait(type)
            assertEquals("ui:$type-t1-identity", name)
            assertNotNull(buildingArtDrawable(name!!))
        }
        val reader = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/live/LiveBuildingFactsReader.kt").readText()
        val discovery = reader.substringAfter("private fun discoveryPortrait").substringBefore("private fun newConstructionPortrait")
        assertTrue(discovery.contains("ordinaryBuildTrayPortrait(type)?.let { return it }"))
    }
    @Test fun `transparent tray art cannot claim an unknown or Phase E building`() {
        for (type in listOf("workshop", "lodge", "market", "harvester", "berth", "goldforge", "heroaltar", "cannon", "future"))
            assertNull(ordinaryBuildTrayPortrait(type))
        assertNull(buildingArtDrawable("ui:future-t1-identity"))
    }
    @Test fun `unavailable price is short on the card and unchanged in its explanation`() {
        val ui = card("Price unavailable right now")
        assertEquals("No price yet", buildCardReasonLabel(ui))
        assertEquals("Price unavailable right now", ui.reason)
        assertEquals(CardTap.EXPLAIN_UNAVAILABLE, cardTap(ui.state))
        assertEquals("Check payment", buildCardReasonLabel(card("Check the saved payment first")))
        assertEquals("Unavailable", buildCardReasonLabel(card("Building unavailable right now")))
        assertEquals("Unlocks at Keep 8", buildCardReasonLabel(card("Unlocks at Keep 8", BuildCardState.LOCKED)))
        assertEquals("An exact server reason", buildCardReasonLabel(card("An exact server reason")))
    }
    @Test fun `unavailable card tap explains without entering placement or changing admission`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/live/LiveSheetHosts.kt").readText()
        val branch = host.substringAfter("CardTap.EXPLAIN_UNAVAILABLE ->").substringBefore("else -> Unit")
        assertTrue(branch.contains("card.reason?.let { explain(it) }"))
        assertTrue(host.contains("dispatchLiveBuildCard(card, review.costs, facts.busy, routes.onPick,"))
        assertTrue(host.contains("{ needMoreFor = it }, routes.onGoToBuilding, { Toasts.post(it) })"))
        assertFalse(branch.contains("onPick"))
        val tray = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/BuildTray.kt").readText()
        assertTrue(tray.contains("LockBar(buildCardReasonLabel(ui))"))
        assertTrue(tray.substringAfter("val spoken = listOfNotNull(ui.name").substringBefore("Plate(PlateKind.CREAM").contains("else -> ui.reason"))
    }
    @Test fun `bundled identity PNGs retain exact authored bytes and alpha channel`() {
        val pins = mapOf(
            "mine" to "1b1b45e61655a8ac01b1a9ac278bebd36d64e6955b75646a8546093de5e766bd",
            "vault" to "7f4239d63036c952af57f36c3e24328f919545616e3fec04f54d269d86dc0697",
            "barracks" to "0b3e328b614213cf68739783c51972acda7c640be2ba079d73997014b955f784",
            "forge" to "2e97893ae4f6a406bbd1daf86a1b7e6b04c5128e131362710d57883c7c8acdc9",
            "camp" to "6d8f848031da09cf7f73b718567755c43f21d654a8892828a0d2797bae8ac882",
            "clanhall" to "c66919313b5dfae207c0bd8fedbf8947b571b7dba71f3d02e85bd618a4de93a3")
        for ((type, expected) in pins) {
            val bytes = File("src/main/res/drawable-nodpi/pkw_ui_${type}_t1_identity.png").readBytes()
            assertEquals(expected, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
            assertEquals("PNG", String(bytes.copyOfRange(1, 4), Charsets.US_ASCII))
            assertEquals(6, bytes[25].toInt()) // PNG RGBA, not the opaque atlas portrait.
        }
    }
}
