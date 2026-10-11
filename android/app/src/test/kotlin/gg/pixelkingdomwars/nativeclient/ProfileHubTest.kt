package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.profile.profileDeed
import org.junit.Assert.*
import org.junit.Test

class ProfileHubTest {
    private val first = BaseSummary("one", status = "active", slot = 1, deedAssetId = "deed-one")
    private val second = BaseSummary("two", status = "active", slot = 2, deedAssetId = "deed-two")
    @Test fun `selected deed and location always come from the same directory row`() {
        val account = AccountState(identity = Identity("wallet", deedAssetId = "deed-one"), directory = BaseDirectory(enabled = true, bases = listOf(first, second)), selectedBaseId = "two")
        assertEquals("deed-two" to second, profileDeed(account))
    }
    @Test fun `missing multi-base selection cannot borrow the wallet compatibility deed`() {
        val account = AccountState(identity = Identity("wallet", deedAssetId = "deed-one"), directory = BaseDirectory(enabled = true, bases = listOf(first, second)))
        assertNull(profileDeed(account))
        assertEquals("deed-one" to first, profileDeed(account.copy(directory = BaseDirectory(enabled = true, bases = listOf(first)))))
        assertNull(profileDeed(account.copy(directory = BaseDirectory(enabled = true, bases = listOf(first.copy(status = "inactive", slot = null))))))
    }
    @Test fun `legacy identity only pairs its deed with a matching location`() {
        val account = AccountState(identity = Identity("wallet", deedAssetId = "deed-two"), directory = BaseDirectory(bases = listOf(first, second)))
        assertEquals("deed-two" to second, profileDeed(account))
        assertEquals("deed-two" to null, profileDeed(account.copy(directory = BaseDirectory(bases = listOf(first)))))
    }
    @Test fun `rename confirmation requires exact available input and current profile rules`() {
        val profile = gg.pixelkingdomwars.nativeclient.data.PlayerProfile("wallet", "Old", null, null, 0)
        val checked = gg.pixelkingdomwars.nativeclient.data.NameAvailability("New", "New", true, null)
        val state = gg.pixelkingdomwars.nativeclient.data.ProfileState(profile, checked)
        assertTrue(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state, "New", true, false))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state, "Other", true, false))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state, "New", false, false))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state, "New", true, true))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state.copy(needsRefresh = true), "New", true, false))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state.copy(profile = profile.copy(cooldownDays = 1)), "New", true, false))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(state.copy(availability = checked.copy(available = false)), "New", true, false))
    }

    @Test fun `unloaded profile never admits a rename confirmation`() {
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.profile.profileRenameReady(gg.pixelkingdomwars.nativeclient.data.ProfileState(), "New", true, false))
    }
}
