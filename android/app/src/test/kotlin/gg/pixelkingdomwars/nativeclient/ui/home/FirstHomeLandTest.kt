package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.ChipTone
import gg.pixelkingdomwars.nativeclient.ui.title.titleEmailCodeReady
import gg.pixelkingdomwars.nativeclient.ui.title.titleEmailReady
import gg.pixelkingdomwars.nativeclient.ui.title.titleSettingsUi
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Account SPEC §1.2: a landless player's first Home says "free camp" and carries one line about land. Land is the money
 * door of the game, so the line must reach only players the server says have none: telling a paying (or not yet known)
 * player to buy land again would invite a second payment. */
class FirstHomeLandTest {
    private val shieldRow = FeatureId("hud.shield")
    private fun hud(unreadRaids: Int = 0) = homeHudState(BaseState(), null, unreadRaids, false, 0, 0, false)

    @Test fun `only a player the server says is landless sees the land herald`() {
        val herald = requireNotNull(homeLandHeraldUi(false, null))
        assertEquals("Buy land to join the world map", herald.text)
        assertEquals("itm_deed_earth", herald.icon)
        assertNull("A landed player is never told to buy land", homeLandHeraldUi(true, null))
        assertNull("An unknown account (signed out or still loading) is never told to buy land", homeLandHeraldUi(null, null))
    }

    @Test fun `the land herald opens the land gate through the profile land row`() {
        assertEquals("profile.land is the row the mount step routes to the designed land gate",
            FeatureId("profile.land"), homeLandHeraldUi(false, null)?.target)
        assertEquals(LAND_HERALD_TARGET, homeLandHeraldUi(false, " ")?.target)
    }

    @Test fun `a defence notice outranks the land line whatever the land state`() {
        val notice = "YOUR BASE WAS RAIDED ×1 — OPEN RAID LOG"
        for (owned in listOf(false, true, null)) {
            val herald = requireNotNull(homeLandHeraldUi(owned, notice))
            assertEquals("The raid notice asks for the raid log first", homeHeraldUi(notice), herald)
            assertEquals(shieldRow, herald.target)
        }
    }

    @Test fun `the land herald keeps one key so it does not restart its banner on every refresh`() {
        assertEquals(homeLandHeraldUi(false, null)?.key, homeLandHeraldUi(false, "")?.key)
    }

    @Test fun `a landless camp shows free camp in place of the shield and its tap still opens the defence log`() {
        val camp = homeFreeCampHud(hud(), false)
        assertEquals("free camp", camp.shield.value)
        assertEquals("The chip keeps its registry row, so the tap is unchanged", shieldRow, camp.shield.id)
        assertTrue(camp.shield.description.startsWith("Free camp"))
        assertEquals("Only the shield segment changes", hud().copy(shield = camp.shield), camp)
    }

    @Test fun `landed and unknown players keep their shield`() {
        val base = hud()
        assertSame(base, homeFreeCampHud(base, true))
        assertSame(base, homeFreeCampHud(base, null))
    }

    @Test fun `a raided free camp keeps the raid news instead of the free camp label`() {
        val raided = hud(unreadRaids = 2)
        assertEquals(ChipTone.DANGER, raided.shield.tone)
        // Free camps fight free camps: hiding RAIDED behind the label would hide a real loss.
        assertEquals("RAIDED ×2", homeFreeCampHud(raided, false).shield.value)
    }
}

/** Account SPEC §1.1 under the public wording rule: the first screen sells Fun-to-Earn and never "free", and the sign-in
 * steps beside the card are the designed kit sheets (the Material dialog and fields were the old screen). */
class FirstLaunchTitleTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"

    @Test fun `the first screen never sells free play`() {
        val designed = File("$root/ui/sheets/account/TitleScreen.kt").readText()
        for (sold in listOf("\"FREE TO PLAY\"", "\"PLAY FREE\"", "play free.", "Play free"))
            assertFalse(sold, designed.contains(sold))
        assertTrue(designed.contains("TITLE_HEADLINE = \"FUN-TO-EARN\""))
        assertTrue(designed.contains("TITLE_PLAY_LABEL = \"PLAY NOW\""))
    }

    @Test fun `settings and e-mail and wallet code steps are designed sheets and not Material dialogs`() {
        val live = File("$root/ui/title/TitleScreens.kt").readText()
        for (material in listOf("AlertDialog(", "OutlinedTextField(", "TextButton("))
            assertFalse(material, live.contains(material))
        for (designed in listOf("TitleSettingsSheet(", "EmailSignInStep(", "WalletCodeSheet("))
            assertTrue(designed, live.contains(designed))
    }

    @Test fun `an e-mail or its code reaches the sign-in owner only when ready and nothing is running`() {
        assertTrue(titleEmailReady("player@example.com", true))
        assertFalse(titleEmailReady("player.example.com", true))
        assertFalse("A running sign-in holds SEND CODE", titleEmailReady("player@example.com", false))
        assertTrue(titleEmailCodeReady("123456", true))
        for (code in listOf("12345", "1234567", "12345a", "１２３４５６")) assertFalse(code, titleEmailCodeReady(code, true))
        assertFalse("A running sign-in holds CONFIRM", titleEmailCodeReady("123456", false))
    }

    @Test fun `settings show this device's sound and hold the account doors while a sign-in runs`() {
        val idle = titleSettingsUi(DeviceSettings(music = false, soundFx = true), idle = true, claimDeed = false)
        assertEquals(false, idle.music)
        assertEquals(true, idle.soundFx)
        assertTrue(idle.accountIdle)
        assertFalse("No claim route offered, no claim row", idle.claimDeed)
        val busy = titleSettingsUi(null, idle = false, claimDeed = true)
        assertNull("Without device preferences there is no sound row that would do nothing", busy.music)
        assertNull(busy.soundFx)
        assertFalse(busy.accountIdle)
        assertTrue(busy.claimDeed)
    }
}
