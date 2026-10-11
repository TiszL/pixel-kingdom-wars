package gg.pixelkingdomwars.nativeclient.ui.profile

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.PassportSection
import gg.pixelkingdomwars.nativeclient.data.PassportTestWire
import gg.pixelkingdomwars.nativeclient.data.RealmPassportRepository
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.ui.hud.DRAWER_PASSPORT
import gg.pixelkingdomwars.nativeclient.ui.hud.drawerLodgeGroup
import gg.pixelkingdomwars.nativeclient.ui.home.homeResourceDrawer
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner 2026-10-11 "where is EXP and Renown?": Profile and the resource drawer show the Renown the server publishes
 * (`GET /realm-passport/mining/current`, the same number as the Lodge PASSPORT tab) and nothing else. A player must never
 * see a broken field, so a Passport the server cannot serve hides the card / tile instead of drawing a dash or a zero, and
 * EXP, which no native read carries, stays hidden rather than invented. Synthetic wire values, not tuning.
 */
class ProfileRenownTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val repo = RealmPassportRepository(session, holder, api)
    }

    private fun home() = BaseState(base = BaseSnapshot(baseId = "base-a", visualContext = null, player = PlayerSummary(keepLevel = 7),
        energy = null, armyStatus = null, claim = null, buildings = emptyList(), obstacles = emptyList(), jobs = emptyList(),
        freeBuilders = 0, raw = JsonObject(emptyMap())))

    @Test fun `served Renown reaches the Profile card and the drawer LODGE tile`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/realm-passport/mining/current") { PassportTestWire.current() }
        f.repo.current()
        val current = f.repo.state.value.current

        // The published cumulative value ("2" on the wire), exactly as the Lodge PASSPORT tab shows it.
        val renown = profileRenown(current, previous = null)
        assertEquals("2", renown)
        assertEquals("2", profileHubBody(home(), LoadState.Ready, renown = renown).renown)

        val lodge = requireNotNull(drawerLodgeGroup(current))
        assertEquals("2", lodge.rows.single().value)
        assertFalse(lodge.rows.single().empty)
        // The tile's GO opens the Passport, where the record behind the number lives.
        assertEquals(DRAWER_PASSPORT, lodge.rows.single().earnedAtFeature)
        // The mounted drawer draws the strip only because the server served it.
        assertTrue(homeResourceDrawer(home(), null, materials = listOf(lodge)).groups.any { it.id == "lodge" })
    }

    @Test fun `a refused Passport (503 REALM_PASSPORT_UNAVAILABLE) hides Renown instead of drawing a broken field`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/realm-passport/mining/current") { throw ApiException(503, "REALM_PASSPORT_UNAVAILABLE", "Realm Passport is unavailable") }
        f.repo.current()
        val current = f.repo.state.value.current
        assertNotNull("the repository records the refusal", current.error)

        // Even a value shown before the refusal is not kept: an unavailable service is not a number.
        assertNull(profileRenown(current, previous = "2"))
        assertNull(profileHubBody(home(), LoadState.Ready, renown = profileRenown(current, null)).renown)
        assertNull(drawerLodgeGroup(current))
        assertTrue(homeResourceDrawer(home(), null, materials = listOfNotNull(drawerLodgeGroup(current))).groups.none { it.id == "lodge" })
    }

    @Test fun `every unavailable Passport answer hides Renown`() = runBlocking {
        for (reason in listOf("SOURCE_UNAVAILABLE", "SOURCE_CONFLICT", "NOT_CONFIGURED")) {
            val f = Fixture()
            f.api.onGet("/realm-passport/mining/current") { PassportTestWire.unavailable(reason) }
            f.repo.current()
            val current = f.repo.state.value.current
            assertEquals(reason, current.observation?.unavailableReason)
            assertNull(reason, profileRenown(current, previous = "2"))
            assertNull(reason, drawerLodgeGroup(current))
        }
    }

    @Test fun `Renown is never guessed before the read and a refresh in flight does not blink the card`() {
        // Never read (or the account's Passport owner is absent): nothing to show, not "0".
        assertNull(profileRenown(null, previous = null))
        assertNull(profileRenown(PassportSection(), previous = "2"))
        assertNull(drawerLodgeGroup(PassportSection()))
        // A first read in flight has nothing to keep, so the card stays hidden rather than showing a placeholder.
        assertNull(profileRenown(PassportSection(busy = true), previous = null))
        // A routine refresh over a value already shown keeps it until the server answers.
        assertEquals("2", profileRenown(PassportSection(busy = true), previous = "2"))
    }

    @Test fun `a home read without EXP keeps the EXP card hidden and does not crash`() = runBlocking {
        // PlayerSummary carries no experience field: the card is hidden, never a sample "LV 7" or a zero bar.
        assertNull(profileHubBody(home(), LoadState.Ready, renown = "2").exp)
        assertNull(profileHubBody(null, LoadState.Loading).exp)
        // The drawer's LODGE strip carries Renown only; it never adds an EXP tile.
        val f = Fixture()
        f.api.onGet("/realm-passport/mining/current") { PassportTestWire.current() }
        f.repo.current()
        assertEquals(listOf("renown"), requireNotNull(drawerLodgeGroup(f.repo.state.value.current)).rows.map { it.id })
    }
}
