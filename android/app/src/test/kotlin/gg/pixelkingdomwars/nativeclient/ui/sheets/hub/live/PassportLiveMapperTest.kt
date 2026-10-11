package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.PassportCurrent
import gg.pixelkingdomwars.nativeclient.data.PassportExpedition
import gg.pixelkingdomwars.nativeclient.data.PassportExpeditions
import gg.pixelkingdomwars.nativeclient.data.PassportObservation
import gg.pixelkingdomwars.nativeclient.data.PassportPublished
import gg.pixelkingdomwars.nativeclient.data.PassportSection
import gg.pixelkingdomwars.nativeclient.data.RealmPassportState
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SourceState
import java.time.Instant
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The passport is a record: it may only show what the server recorded. A partial history must never draw a false
 *  "not yet" stamp or a short trip total, unknown renown is "…" (never 0), and paging must not lose earlier returns. */
class PassportLiveMapperTest {
    private val now = Instant.parse("2030-01-10T12:00:00Z").toEpochMilli()
    private val utc = ZoneOffset.UTC
    private val serverNow = "2030-01-10T11:58:00.000Z"

    private fun id(n: Int) = "00000000-0000-4000-8000-%012d".format(n)
    private fun row(n: Int, realm: String, kind: String = "starter", route: String = "common_$realm", returned: String = "2030-01-09T21:40:00.000Z") =
        PassportExpedition(kind, id(n), id(1000 + n), id(9), realm, route, if (kind == "starter") 1 else null, if (kind == "advanced") 2 else null,
            "2030-01-09T10:00:00.000Z", "2030-01-09T20:00:00.000Z", returned)
    private fun page(kind: String, rows: List<PassportExpedition>, next: String? = null) =
        PassportSection(PassportObservation(PassportExpeditions(kind, rows, next), serverNow, null))
    private fun current(renown: String, days: String) =
        PassportSection(PassportObservation(PassportCurrent(1L, "1", "3", PassportPublished(renown, days), null), serverNow, null))
    private fun complete(kind: String, vararg rows: PassportExpedition) = PassportReturns(kind, rows.toList(), complete = true)

    @Test fun `a fully read history stamps each realm with its count, in the game's realm order, home tagged`() {
        val starter = complete("starter", row(1, "crownlands"), row(2, "crownlands"), row(3, "seeker-reach"))
        val advanced = complete("advanced", row(4, "frostveil", kind = "advanced", route = "glasswake-keys-3"))
        val ui = passportLiveUi(RealmPassportState(current = current("120", "14")), starter, advanced, "crownlands", 3, now, utc)
        assertEquals(listOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall"),
            ui.stamps.map { it.realmId })
        assertEquals(2, ui.stamps.single { it.realmId == "crownlands" }.trips)
        assertTrue(ui.stamps.single { it.realmId == "crownlands" }.home)
        assertEquals("Solana Reach", ui.stamps.single { it.realmId == "seeker-reach" }.name)
        assertEquals("voyage:rough-prism", ui.stamps.single { it.realmId == "seeker-reach" }.resourceIcon)
        assertEquals("4", ui.trips)
        assertEquals("120", ui.renown)
        assertEquals("14", ui.days)
        assertEquals(SourceState.OK, ui.sourceState)
    }

    @Test fun `a history with pages left draws no stamps and a lower-bound trip count, never a false not-yet`() {
        val starter = PassportReturns("starter", List(20) { row(it + 1, "crownlands") }, complete = false)
        val ui = passportLiveUi(RealmPassportState(), starter, complete("advanced"), null, 2, now, utc)
        assertTrue(ui.stamps.isEmpty())
        assertEquals("20+", ui.trips)
        val unread = passportLiveUi(RealmPassportState(), null, null, null, 2, now, utc)
        assertEquals(UNKNOWN, unread.trips)
    }

    @Test fun `renown and days come only from the published observation, unknown is the ellipsis`() {
        val ui = passportLiveUi(RealmPassportState(), complete("starter"), complete("advanced"), null, 2, now, utc)
        assertEquals(UNKNOWN, ui.renown)
        assertEquals(UNKNOWN, ui.days)
    }

    @Test fun `the next page is merged into the held returns and a re-emitted page changes nothing`() {
        val first = accumulateReturns(null, page("starter", List(20) { row(it + 1, "elderwood") }, next = id(20)), "starter")
        assertFalse(first!!.complete)
        val second = accumulateReturns(first, page("starter", listOf(row(21, "sunscar"))), "starter")
        assertEquals(21, second!!.rows.size)
        assertTrue(second.complete)
        assertEquals(second, accumulateReturns(second, page("starter", listOf(row(21, "sunscar"))), "starter"))
        // another kind's page or an unavailable read keeps the last good rows
        assertEquals(second, accumulateReturns(second, page("advanced", emptyList()), "starter"))
        val unavailable = PassportSection<PassportExpeditions>(PassportObservation(null, serverNow, "SOURCE_UNAVAILABLE"))
        assertEquals(second, accumulateReturns(second, unavailable, "starter"))
    }

    @Test fun `a conflict outranks an outage, and a server without the history says not configured`() {
        val conflict = RealmPassportState(expeditions = PassportSection(PassportObservation(null, serverNow, "SOURCE_CONFLICT")),
            current = PassportSection(error = "Current participation could not be verified. Try again."))
        assertEquals(SourceState.CONFLICT, passportLiveSource(conflict))
        assertEquals(SourceState.UNAVAILABLE, passportLiveSource(RealmPassportState(current = PassportSection(error = "x"))))
        assertEquals(SourceState.NOT_CONFIGURED,
            passportLiveSource(RealmPassportState(expeditions = PassportSection(PassportObservation(null, serverNow, "NOT_CONFIGURED")))))
        // mining-current not configured only leaves renown at "…"; the stamps' source is still fine
        assertEquals(SourceState.OK,
            passportLiveSource(RealmPassportState(current = PassportSection(PassportObservation(null, serverNow, "NOT_CONFIGURED")))))
    }

    @Test fun `last returns are newest first with full route names and honest vehicle words`() {
        val starter = complete("starter", row(1, "crownlands", returned = "2030-01-08T09:10:00.000Z"))
        val advanced = complete("advanced", row(2, "frostveil", kind = "advanced", route = "glasswake-keys-3", returned = "2030-01-09T21:40:00.000Z"))
        val ui = passportLiveUi(RealmPassportState(), starter, advanced, null, 2, now, utc)
        assertEquals(listOf("Glasswake Keys 3", "Common Crownlands"), ui.recent.map { it.routeName })
        assertEquals(listOf("Crafted vehicle", "Starter boat"), ui.recent.map { it.vehicle })
        assertEquals("yesterday 21:40", ui.recent[0].at)
        assertEquals(id(1002), ui.recent[0].id)
    }

    @Test fun `a realm that goes from no trips to one pops, nothing pops on the first map`() {
        val before = passportStamps(listOf(complete("starter"), complete("advanced")), null)
        val after = passportStamps(listOf(complete("starter", row(1, "thornwake")), complete("advanced")), null)
        assertEquals("thornwake", newStampRealm(before, after))
        assertNull(newStampRealm(emptyList(), after))
        assertNull(newStampRealm(after, after))
    }

    @Test fun `refreshed line and return times read from the clock without guessing`() {
        assertEquals("2 min ago", agoLabel(serverNow, now))
        assertNull(agoLabel("not a time", now))
        assertEquals("today 11:00", returnTimeLabel("2030-01-10T11:00:00.000Z", now, utc))
        assertEquals("3 Jan", returnTimeLabel("2030-01-03T11:00:00.000Z", now, utc))
        assertEquals(UNKNOWN, returnTimeLabel("bad", now, utc))
    }

    @Test fun `the passport actions never spend, and a stamp tap explains instead of doing nothing`() {
        val said = mutableListOf<String>()
        var refreshed = 0
        val on = passportLiveActions({ refreshed++ }, {}, {}, { said += it })
        on.onStamp("seeker-reach")
        on.onRefreshStamps()
        assertEquals(1, refreshed)
        assertTrue(said.single().startsWith("Solana Reach"))
    }
}
