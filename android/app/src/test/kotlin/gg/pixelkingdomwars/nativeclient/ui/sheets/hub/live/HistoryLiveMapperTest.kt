package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.GemsBuyDraft
import gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.more.HISTORY_REPORT_DOOR
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptDetail
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptFamily
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptRow
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptSource
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.BoardView
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.boardView
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC §2.8 History over what the existing owners retain. WHY these pins matter: money moved is money honoured, so an
 * unfinished request (a saved original its owner still holds, a saved mail claim, a saved Gems request) must stay on top
 * as NEEDS YOU under every filter and every load state, with OPEN leading only to a recovery door the mount can open;
 * History never invents a row for a place with no retained journal; a routine refresh never blanks what was shown; and
 * player copy never says receipt or transaction (DS §9). History only: nothing here may start new work. */
class HistoryLiveMapperTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val now = Instant.parse("2026-10-05T12:00:00Z").toEpochMilli()

    private fun row(family: PhaseEReceiptFamily, source: PhaseEReceiptSource, status: String, title: String = "Ingot refining",
                    details: List<Pair<String, String>> = emptyList(), id: String = "${family.name}:${source.name}:$status") =
        PhaseEReceiptRow(id, family, source, "key-$id", title, status, BASE_ID, details.map { (label, value) -> PhaseEReceiptDetail(label, value) })

    private fun intent(kind: String, key: String, attempted: Boolean = false, receipt: JsonObject? = null) = PendingIntent(
        kind = kind, wallet = WALLET, baseId = BASE_ID, idempotencyKey = key, path = "/gems/convert",
        body = JsonObject(emptyMap()), label = "Gems request", attempted = attempted, receipt = receipt)

    private fun view(rows: List<PhaseEReceiptRow>, needs: List<gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryRowUi> = emptyList(),
                     filter: String = HISTORY_ALL, load: LoadState = LoadState.Ready) = liveHistoryUi(rows, needs, filter, load, now, zone)

    private fun groupIds(view: HistoryView) = view.ui.groups.flatMap { group -> group.rows.map { it.id } }

    @Test fun `a saved original its owner still holds is NEEDS YOU with that building's recovery door`() {
        val pending = row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.PENDING, "CHECK NEEDED", title = "Ingot collection")
        val shown = view(listOf(pending))
        val needs = shown.ui.needsYou.single()
        assertEquals(pending.id, needs.id)
        assertEquals(HistoryStatus.NEEDS_YOU, needs.status)
        assertEquals(HubLink(FeatureId("workshop.craft")), needs.recovery)
        assertEquals("Ingot collection not finished", needs.title)
        assertTrue("an unfinished request is not also filed as history", groupIds(shown).isEmpty())
        // Accepted but not yet hydrated is still the owner's current operation: it stays NEEDS YOU until archived as final.
        for (status in listOf("SAVED DRAFT", "CHECK NEEDED", "ACCEPTED", "COLLECTED", "DECLINED", "SOMETHING NEW"))
            assertEquals(status, HistoryStatus.NEEDS_YOU, historyStatus(PhaseEReceiptSource.PENDING, status))
    }

    @Test fun `NEEDS YOU stays under every filter and every load state until the owner archives it`() {
        val pending = row(PhaseEReceiptFamily.STARTER_EXPEDITION, PhaseEReceiptSource.PENDING, "CHECK NEEDED", title = "Starter expedition")
        for (filter in HISTORY_FILTERS) for (load in listOf(LoadState.Loading, LoadState.Ready, LoadState.Error("Can't refresh your history.")))
            assertEquals("$filter $load", listOf(pending.id), view(listOf(pending), filter = filter, load = load).ui.needsYou.map { it.id })
        // Once the owner archives the accepted order, the row leaves NEEDS YOU and is filed as history (SENT).
        val archived = row(PhaseEReceiptFamily.STARTER_EXPEDITION, PhaseEReceiptSource.ARCHIVED, "ACCEPTED", title = "Starter expedition")
        val done = view(listOf(archived))
        assertTrue(done.ui.needsYou.isEmpty())
        assertEquals(HistoryStatus.SENT, done.ui.groups.single().rows.single().status)
    }

    @Test fun `every OPEN door is one the mount can open and each family opens its own building`() {
        // The mount's openHubLink maps exactly these ids; anything else would be a door that does nothing.
        assertEquals(setOf("workshop.craft", "refining.open", "harvester.harvest", "berth.fleet", "lodge.expedition", "hud.mail", "goldforge.gems"),
            HISTORY_RECOVERY_DOORS)
        val doors = mapOf(PhaseEReceiptFamily.WORKSHOP to "workshop.craft", PhaseEReceiptFamily.REFINING to "refining.open",
            PhaseEReceiptFamily.STARTER_FLEET to "berth.fleet", PhaseEReceiptFamily.STARTER_EXPEDITION to "lodge.expedition",
            PhaseEReceiptFamily.HARVESTER to "harvester.harvest")
        for ((family, door) in doors) {
            val needs = view(listOf(row(family, PhaseEReceiptSource.PENDING, "CHECK NEEDED"))).ui.needsYou.single()
            assertEquals("$family", door, needs.recovery?.feature?.value)
        }
        val extra = historyNeeds(intent(IntentKind.MAIL_CLAIM, "mail-0001-letter"), listOf(intent(IntentKind.GEMS_FROM_KEEP, "gems-0001-key")),
            SavedGemsBuy(GemsBuyDraft(WALLET, "https://play.pixelkingdomwars.com", "devnet", "buy-0001-key", 500)))
        assertEquals(listOf("hud.mail", "goldforge.gems", "goldforge.gems"), extra.map { it.recovery?.feature?.value })
        for (row in extra) assertTrue(row.recovery!!.feature.value in HISTORY_RECOVERY_DOORS)
        // ErrorRow › Report goes to the Feedback door the mount maps for every Profile feedback door.
        assertEquals("profile.feedback", HISTORY_REPORT_DOOR)
    }

    @Test fun `mail and Gems requests are NEEDS YOU while their owner holds them and gone once it lets go`() {
        val needs = historyNeeds(intent(IntentKind.MAIL_CLAIM, "mail-0001-letter", attempted = true),
            listOf(intent(IntentKind.GEMS_FROM_KEEP, "gems-0001-key"), intent(IntentKind.GEMS_TO_SHARDS, "gems-0002-key", attempted = true,
                receipt = JsonObject(mapOf("id" to JsonPrimitive("r1"))))),
            SavedGemsBuy(GemsBuyDraft(WALLET, "https://play.pixelkingdomwars.com", "devnet", "buy-0001-key", 500), attempted = true))
        assertEquals(4, needs.size)
        assertTrue(needs.all { it.status == HistoryStatus.NEEDS_YOU })
        // The stage words say honestly where each request stands; none claims it finished.
        assertEquals(listOf("Mail · sent, being checked", "Gold Forge · not sent yet", "Gold Forge · accepted, finishing", "Gold Forge · sent, being checked"),
            needs.map { it.sub })
        assertTrue("nothing saved, nothing to show", historyNeeds(null, emptyList(), null).isEmpty())
        // They are drawn ahead of the journals' rows and survive any filter.
        val shown = view(listOf(row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.PENDING, "CHECK NEEDED")), needs, filter = HISTORY_BERTH)
        assertEquals(needs.map { it.id } + "WORKSHOP:PENDING:CHECK NEEDED", shown.ui.needsYou.map { it.id })
    }

    @Test fun `each filter keeps only its place and ALL keeps everything`() {
        val rows = listOf(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptFamily.REFINING, PhaseEReceiptFamily.STARTER_FLEET,
            PhaseEReceiptFamily.STARTER_EXPEDITION, PhaseEReceiptFamily.HARVESTER).map { row(it, PhaseEReceiptSource.ARCHIVED, "ACCEPTED") }
        val ids = rows.associate { it.family to it.id }
        assertEquals(rows.map { it.id }.toSet(), groupIds(view(rows)).toSet())
        // Ingot and material refining both happen at the Workshop.
        assertEquals(setOf(ids[PhaseEReceiptFamily.WORKSHOP], ids[PhaseEReceiptFamily.REFINING]), groupIds(view(rows, filter = HISTORY_WORKSHOP)).toSet())
        assertEquals(listOf(ids[PhaseEReceiptFamily.STARTER_EXPEDITION]), groupIds(view(rows, filter = HISTORY_LODGE)))
        assertEquals(listOf(ids[PhaseEReceiptFamily.STARTER_FLEET]), groupIds(view(rows, filter = HISTORY_BERTH)))
        assertTrue("no Gold Forge journal is projected yet: an empty list, never a borrowed row", groupIds(view(rows, filter = HISTORY_GOLDFORGE)).isEmpty())
        // An id the strip does not draw falls back to ALL, never to a card that looks empty.
        val unknown = view(rows, filter = "MARKET")
        assertEquals(HISTORY_ALL, unknown.ui.filter)
        assertEquals(rows.size, groupIds(unknown).size)
    }

    @Test fun `the chip strip starts with ALL and every WalletHistory home opens a chip`() {
        assertEquals(HISTORY_ALL, HISTORY_FILTERS.first())
        assertEquals("the drawn chips are exactly the ids the host may hand back", HISTORY_FILTERS.toList(), historyFilterChips().map { it.id })
        val homes = mapOf("all" to HISTORY_ALL, "goldforge" to HISTORY_GOLDFORGE, "workshop" to HISTORY_WORKSHOP, "lodge" to HISTORY_LODGE,
            "berth" to HISTORY_BERTH, "market" to HISTORY_ALL, "islands" to HISTORY_ALL, "purchases" to HISTORY_ALL, "" to HISTORY_ALL,
            "nonsense" to HISTORY_ALL, "WORKSHOP" to HISTORY_WORKSHOP, "GOLDFORGE" to HISTORY_GOLDFORGE, "Gold Forge" to HISTORY_GOLDFORGE)
        for ((home, chip) in homes) assertEquals(home, chip, historyFilterFor(home))
        for (chip in HISTORY_FILTERS) assertEquals("a chip id handed back maps to itself", chip, historyFilterFor(chip))
    }

    @Test fun `with nothing retained the card shows its empty state and never an invented row`() {
        val empty = view(emptyList())
        assertTrue(empty.ui.needsYou.isEmpty() && empty.ui.groups.isEmpty() && empty.details.isEmpty())
        assertFalse("everything retained is shown, so there is never a MORE row", empty.ui.hasMore)
        // Ready with no data draws the live board, which is the designed "Nothing here yet"; before the first read it is
        // skeleton rows, so the empty words never appear before History has looked.
        assertEquals(BoardView.LIVE, boardView(empty.ui.load, hasData = false))
        assertEquals(BoardView.SKELETON, boardView(view(emptyList(), load = LoadState.Loading).ui.load, hasData = false))
        val sheet = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/hub/HistorySheet.kt").readText()
        assertTrue("the designed empty copy", "HubEmptyState(\"Nothing here yet\", \"Claims, purchases and expeditions show up here.\", icon = \"replay\")" in sheet)
        // Families this card does not project (their owners are registration-scoped) are dropped, never misfiled.
        val unprojected = listOf(PhaseEReceiptFamily.AWNING, PhaseEReceiptFamily.WAKE, PhaseEReceiptFamily.EQUIPMENT,
            PhaseEReceiptFamily.VEHICLE, PhaseEReceiptFamily.MARKET).flatMap {
            listOf(row(it, PhaseEReceiptSource.PENDING, "CHECK NEEDED"), row(it, PhaseEReceiptSource.ARCHIVED, "ACCEPTED"))
        }
        val dropped = view(unprojected)
        assertTrue(dropped.ui.needsYou.isEmpty() && dropped.ui.groups.isEmpty())
        for (family in PhaseEReceiptFamily.values().filter { it in unprojected.map { row -> row.family } }) assertNull(historyPlaceName(family))
    }

    @Test fun `rows fall into TODAY YESTERDAY and EARLIER by when they happened and undated rows go last`() {
        val today = row(PhaseEReceiptFamily.REFINING, PhaseEReceiptSource.ARCHIVED, "COMPLETED", id = "today",
            details = listOf("Started at" to "2026-10-05T08:00:00Z", "Completed at" to "2026-10-05T09:30:00Z",
                // A ready-at is a future time, never when something happened.
                "Ready at" to "2026-10-06T09:30:00Z"))
        val yesterday = row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.SERVER, "COLLECTED", id = "yesterday",
            details = listOf("Collected at" to "2026-10-04T20:00:00Z"))
        val older = row(PhaseEReceiptFamily.STARTER_FLEET, PhaseEReceiptSource.SERVER, "INSTALLED", id = "older",
            details = listOf("Installed at" to "2026-09-21T08:00:00Z"))
        val undated = row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.ARCHIVED, "SAVED DRAFT", id = "undated")
        val shown = view(listOf(undated, older, yesterday, today))
        assertEquals(listOf("today", "yesterday", "earlier"), shown.ui.groups.map { it.id })
        assertEquals(listOf("TODAY", "YESTERDAY", "EARLIER"), shown.ui.groups.map { it.title })
        assertEquals(listOf("today"), shown.ui.groups[0].rows.map { it.id })
        assertEquals(listOf("yesterday"), shown.ui.groups[1].rows.map { it.id })
        assertEquals(listOf("older", "undated"), shown.ui.groups[2].rows.map { it.id })
        assertEquals(Instant.parse("2026-10-05T09:30:00Z"), historyHappenedAt(today))
        assertTrue(shown.ui.groups[0].rows.single().sub.endsWith("09:30"))
        assertTrue("an older row reads its day", shown.ui.groups[2].rows.first().sub.endsWith("21 Sep"))
    }

    @Test fun `a status is claimed done only when the owner said final`() {
        assertEquals(HistoryStatus.SENT, historyStatus(PhaseEReceiptSource.ARCHIVED, "ACCEPTED"))
        assertEquals(HistoryStatus.RETURNED, historyStatus(PhaseEReceiptSource.ARCHIVED, "RETURNED"))
        for (closed in listOf("COLLECTED", "COMPLETED", "INSTALLED", "CLOSED"))
            assertEquals(closed, HistoryStatus.DONE, historyStatus(PhaseEReceiptSource.SERVER, closed))
        // Still moving on the server (an expedition in flight, a job refining or ready, a source observed): PENDING.
        for (moving in listOf("ACCEPTED", "READY", "REFINING", "OBSERVED", "CHECK NEEDED", "SOMETHING NEW"))
            assertEquals(moving, HistoryStatus.PENDING, historyStatus(PhaseEReceiptSource.SERVER, moving))
        assertEquals("an archived order whose answer was never seen is not claimed done", HistoryStatus.PENDING,
            historyStatus(PhaseEReceiptSource.ARCHIVED, "CHECK NEEDED"))
    }

    @Test fun `a routine refresh keeps the server rows that were already shown`() {
        val saved = row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.ARCHIVED, "COLLECTED", id = "saved")
        val server = row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.SERVER, "REFINING", id = "server")
        // The Workshop refresh clears its view while it reads: the shown server row stays beside the live saved ones.
        assertEquals(listOf("saved", "server"), keptHistoryRows(listOf(saved, server), listOf(saved), refreshing = true).map { it.id })
        // Once the read is over, the owner's answer is the truth, even when the server no longer lists the job.
        assertEquals(listOf("saved"), keptHistoryRows(listOf(saved, server), listOf(saved), refreshing = false).map { it.id })
        // A fresh server answer replaces the kept one; nothing is shown twice.
        val fresh = row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.SERVER, "READY", id = "fresh")
        assertEquals(listOf("saved", "fresh"), keptHistoryRows(listOf(saved, server), listOf(saved, fresh), refreshing = true).map { it.id })
        assertEquals(listOf("saved"), keptHistoryRows(null, listOf(saved), refreshing = true).map { it.id })
    }

    @Test fun `copy never says receipt or transaction and every drawn row has a read-only detail`() {
        val rows = listOf(
            row(PhaseEReceiptFamily.WORKSHOP, PhaseEReceiptSource.ARCHIVED, "COLLECTED", title = "Ingot collection",
                details = listOf("Receipt" to "rcpt-1", "Collected at" to "2026-10-05T09:00:00Z", "Note" to "Transaction receipt kept")),
            row(PhaseEReceiptFamily.HARVESTER, PhaseEReceiptSource.PENDING, "CHECK NEEDED", title = "Harvester source receipt"))
        val shown = view(rows)
        val words = shown.ui.needsYou.flatMap { listOf(it.title, it.sub) } +
            shown.ui.groups.flatMap { group -> listOf(group.title) + group.rows.flatMap { listOf(it.title, it.sub) } } +
            shown.ui.filters.map { it.label } +
            shown.details.values.flatMap { detail -> listOf(detail.title) + detail.fields.flatMap { listOf(it.label, it.value) } }
        for (word in words) assertFalse(word, word.contains("receipt", ignoreCase = true) || word.contains("transaction", ignoreCase = true))
        // A row tap opens its detail: every group row has one, with where it happened and how it stands.
        assertEquals(groupIds(shown).toSet(), shown.details.keys)
        val detail = shown.details.getValue(rows[0].id)
        assertEquals(listOf("Where", "Status"), detail.fields.take(2).map { it.label })
        assertEquals("Workshop", detail.fields[0].value)
        assertTrue("the record line keeps its value", detail.fields.any { it.label == "Record" && it.value == "rcpt-1" })
    }
}
