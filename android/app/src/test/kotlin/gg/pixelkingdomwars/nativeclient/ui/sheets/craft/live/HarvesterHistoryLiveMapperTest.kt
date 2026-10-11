package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HaulKind
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Receipt-only HISTORY: source validation, account/base/facility scope, and honest incomplete coverage.
 * Authored before implementation; execution belongs exclusively to Cedar3. */
class HarvesterHistoryLiveMapperTest {
    private val wallet = "DaEy4YZ9xwiGzw1nTQVB1vxCTZRBQJhbmLU55BXQ2jgi"
    private val identity = HarvesterIdentity("https://api.example.gg", "devnet", wallet)
    private val base = "12345678-1234-4678-9abc-def012345601"
    private val harvester = "12345678-1234-4678-9abc-def012345602"
    private val sourceId = "12345678-1234-4678-9abc-def012345603"
    private val other = "12345678-1234-4678-9abc-def012345609"
    private val admitted = "2030-01-01T00:00:00.000Z"
    private val lease = "2030-01-02T00:00:00.000Z"
    private val serverNow = "2030-01-02T01:00:00.000Z"
    private val policy = HarvesterPolicy(1, 1, "48", "12", 21_600, 86_400, 1, 10_000, 0)
    private val resources = listOf("frost_quartz", "heartwood_logs", "sunstone_rubble", "crown_iron_ore",
        "rough_prism", "storm_ore", "thorn_fibre", "ember_nodules")

    private fun operation(
        count: Int = 2,
        id: String = sourceId,
        baseId: String = base,
        harvesterId: String = harvester,
        resource: String = "crown_iron_ore",
        realm: String = "crownlands",
        terms: HarvesterPolicy = policy,
        closed: Boolean = false,
    ): HarvesterOperation {
        val facility = HarvesterFacility(baseId, harvesterId, "12345678-1234-4678-9abc-def012345604", "2029-12-31T00:00:00.000Z")
        val command = HarvesterCommand(HarvesterRequest(id, baseId, harvesterId, null, 1), facility, realm, terms, null)
        val source = HarvesterSource(id, baseId, harvesterId, 1, realm, resource, admitted, lease,
            facility.completedBuildJobId, facility.harvesterCompletedAt,
            HarvesterTerm("12345678-1234-4678-9abc-def012345605", "0".repeat(64), "2029-12-01T00:00:00.000Z", "2030-02-01T00:00:00.000Z"), terms)
        val events = (1..count).map { ordinal ->
            val at = "2030-01-01T${(ordinal * 6).toString().padStart(2, '0')}:00:00.000Z"
            HarvesterEvent(id, ordinal, (ordinal + 3).toString(), resource, 1, at, at,
                admitted, terms.grossPerCadence, terms.grossPerCadence, "0", 1, 10_000, 0, "0", "0")
        }
        val closure = if (closed) HarvesterClosure(id, "deactivation", events.last().earnedAt, count) else null
        return HarvesterOperation(command, 1, HarvesterProof(wallet, id, serverNow, "accepted",
            HarvesterReceipt(wallet, command.request, source), HarvesterSettlement(events, closure, null)), null)
    }

    private fun view(op: HarvesterOperation = operation()): HarvesterView {
        val source = op.proof!!.originalReceipt!!.source
        return HarvesterView(wallet, base, serverNow, HarvesterFeatures(HarvesterFeature(1, 1)), true,
            StarterExpeditionHome("free_assignment", 1, "crownlands"), listOf(source.facility()), source.summary(), source.summary(), policy,
            resources.map { OrdinaryRawStock(it, "0", "0", "0") })
    }

    private fun state(op: HarvesterOperation? = operation(), archives: List<HarvesterOperation> = emptyList(), busy: Boolean = false) =
        HarvesterState(HarvesterJournal(1, identity, 3, op, archives.map { HarvesterArchive(it, "accepted", null) }), view(), busy = busy, advertised = true)

    private fun history(state: HarvesterState = state(), expected: HarvesterIdentity = identity, selected: String? = harvester,
        current: Boolean = true, running: Boolean = false, error: String? = null) =
        harvesterHistoryLiveUi(state, expected, base, selected, current, running, error)

    @Test fun `history shows validated net receipts newest first without inventing chart totals`() {
        val ui = history()
        assertEquals("crown_iron_ore", ui.resourceId)
        assertEquals(listOf("$sourceId:2", "$sourceId:1"), ui.groups.flatMap { it.rows }.map { it.id })
        assertEquals(listOf("12", "12"), ui.groups.flatMap { it.rows }.map { it.quantity })
        assertEquals(7, ui.days.size)
        assertTrue(ui.days.all { it.total == null && it.amount == null })
        assertNull(ui.weekTotal)
        assertNull(ui.nextCursor)
        assertTrue(ui.coverageNote!!.contains("Daily and weekly totals are unavailable"))
        assertEquals("2 Jan · 01:00 UTC", ui.updatedAt)
    }

    @Test fun `journal identity must match origin cluster and wallet`() {
        listOf(identity.copy(origin = "https://other.example.gg"), identity.copy(cluster = "mainnet-beta"),
            identity.copy(wallet = "11111111111111111111111111111111")).forEach { expected ->
            val ui = history(expected = expected)
            assertTrue(ui.groups.isEmpty())
            assertFalse(ui.checkAllowed)
            assertTrue(ui.load is CraftHydration.Error)
        }
    }

    @Test fun `a stale owner projection cannot expose receipts or enable checking`() {
        val ui = history(current = false)
        assertTrue(ui.groups.isEmpty())
        assertFalse(ui.checkAllowed)
        assertNull(ui.updatedAt)
        assertEquals("History unavailable", ui.emptyTitle)
        assertEquals(CraftHydration.Error("History is paused while another review or read finishes."), ui.load)
        assertFalse(ui.emptyReason.contains("current account"))
    }

    @Test fun `archived receipts from other bases facilities and resources never enter this history`() {
        val rows = history(state(archives = listOf(
            operation(id = other, baseId = other), operation(id = other, harvesterId = other),
            operation(id = other, resource = "storm_ore", realm = "stormcairn"),
        ))).groups.flatMap { it.rows }
        assertEquals(listOf("$sourceId:2", "$sourceId:1"), rows.map { it.id })
    }

    @Test fun `an explicit different Harvester cannot borrow the selected source`() {
        assertTrue(history(selected = other).groups.isEmpty())
    }

    @Test fun `a missing building selection resolves only the current source Harvester`() {
        assertEquals(2, history(selected = null).groups.flatMap { it.rows }.size)
        val noSource = state().copy(view = view().copy(source = null, walletSource = null))
        assertTrue(history(noSource, selected = null).groups.isEmpty())
    }

    @Test fun `duplicate preserved receipt snapshots produce each haul only once`() {
        // Defensive mapper fixture: HarvesterStore already forbids duplicate operation keys in a real journal.
        val ui = history(state(operation(), listOf(operation(count = 1), operation())))
        assertEquals(listOf("$sourceId:2", "$sourceId:1"), ui.groups.flatMap { it.rows }.map { it.id })
    }

    @Test fun `conflicting observations for one source are withheld instead of picking a quantity`() {
        // Defensive mapper fixture: HarvesterStore already forbids these conflicting duplicate-key snapshots.
        val op = operation()
        val proof = op.proof!!
        val settlement = proof.settlement!!
        val changed = op.copy(proof = proof.copy(settlement = settlement.copy(events = settlement.events.mapIndexed { i, event ->
            if (i == 0) event.copy(grossQuantity = "0", netQuantity = "0") else event
        })))
        assertTrue(history(state(op, listOf(changed))).groups.isEmpty())
    }

    @Test fun `failed refresh without a view preserves older dated rows and reports the read failure`() {
        val original = operation()
        val older = original.copy(proof = original.proof!!.copy(serverNow = "2030-01-01T18:00:00.000Z"))
        val ui = history(state(older).copy(view = null), error = "Could not refresh")
        assertEquals(2, ui.groups.flatMap { it.rows }.size)
        assertEquals(CraftHydration.Error("Could not refresh"), ui.load)
        assertEquals("1 Jan · 18:00 UTC", ui.errorShowing)
        assertEquals("Could not refresh", ui.emptyReason)
        assertTrue(ui.groups.none { it.label == "TODAY · UTC" })
        assertTrue(ui.groups.all { it.label.contains("1 JAN 2030") })
        assertTrue(ui.days.all { it.label == "…" && !it.today && it.total == null && it.amount == null })
        assertTrue(ui.checkAllowed)
    }

    @Test fun `refresh loading without a view retains dated rows and blocks a second check`() {
        val ui = history(state().copy(view = null), running = true)
        assertEquals(2, ui.groups.flatMap { it.rows }.size)
        assertEquals(CraftHydration.Loading, ui.load)
        assertTrue(ui.checking)
        assertFalse(ui.checkAllowed)
        assertTrue(ui.groups.none { it.label == "TODAY · UTC" })
        assertTrue(ui.days.all { it.label == "…" && !it.today })
    }

    @Test fun `only an actual closure receipt adds a stopped row and no level event is fabricated`() {
        val rows = history(state(operation(closed = true))).groups.flatMap { it.rows }
        assertEquals(1, rows.count { it.kind == HaulKind.PAUSED })
        assertEquals("$sourceId:closed", rows.first { it.kind == HaulKind.PAUSED }.id)
        assertFalse(rows.any { it.kind == HaulKind.LEVEL })
        assertFalse(history().groups.flatMap { it.rows }.any { it.kind == HaulKind.PAUSED })
    }

    @Test fun `no saved receipts means unknown coverage not zero production`() {
        val ui = history(state(op = null))
        assertTrue(ui.groups.isEmpty())
        assertTrue(ui.days.all { it.total == null && it.amount == null })
        assertNull(ui.weekTotal)
        assertEquals("No saved hauls", ui.emptyTitle)
        assertTrue(ui.emptyReason.contains("may not include every haul"))
    }

    @Test fun `large exact quantities cannot overflow an invented aggregate`() {
        val big = policy.copy(grossPerWalletUtcDay = Long.MAX_VALUE.toString(), grossPerCadence = Long.MAX_VALUE.toString())
        val rows = history(state(operation(terms = big))).groups.flatMap { it.rows }
        assertEquals(listOf("9,223,372,036,854,775,807", "9,223,372,036,854,775,807"), rows.map { it.quantity })
        assertNull(history(state(operation(terms = big))).weekTotal)
    }

    @Test fun `malformed overrange or foreign proof observations are not displayed`() {
        val op = operation()
        val proof = op.proof!!
        val settlement = proof.settlement!!
        val invalid = op.copy(proof = proof.copy(settlement = settlement.copy(events = settlement.events.map {
            it.copy(netQuantity = "9223372036854775808")
        })))
        assertTrue(history(state(invalid)).groups.isEmpty())
        assertTrue(history(state(op.copy(proof = proof.copy(wallet = "11111111111111111111111111111111")))).groups.isEmpty())
    }

    // Repointed for the in-place Harvester sheet: Home now mounts HomeHarvesterOwnerSheet (its own file), which keeps every
    // guard of the HomeHarvesterSheet host it replaces; that old body stays in HomeRouteDispatcher.kt as dead source tonight.
    private fun mountedHomeSource(): String = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeHarvesterOwnerSheet.kt")
        .readText().substringAfter("@Composable internal fun HomeHarvesterOwnerSheet(")

    @Test fun `Home mounts scoped round two history and retires the raw source controls row`() {
        val source = mountedHomeSource()
        assertTrue(source.contains("harvesterHistoryLiveUi("))
        assertTrue(source.contains("graph.origin.toHttpUrl().toString().trimEnd('/')"))
        assertTrue(source.contains("graph.cluster.id, session.session.wallet"))
        assertTrue(source.contains("identity.baseId, facts?.buildingId, projectionCurrent, refreshing, refreshError"))
        assertTrue(source.contains("historyTab = history"))
        assertFalse(source.contains("historyTab = null"))
        assertFalse(source.contains("Source controls and original receipts"))
        assertFalse(source.contains("HarvesterViewModel(")); assertFalse(source.contains("HarvesterRepository("))
    }
    @Test fun `history check rechecks owner admission and never repeats a busy or reviewed read`() {
        val source = mountedHomeSource()
        assertTrue(source.contains("currentCanRead() && owner.projection.currentState() === state"))
        assertTrue(source.contains("owner.projection.canRead() && !refreshing"))
        assertTrue(source.contains("latestState != null && !latestState.busy && latestState.review == null"))
        assertTrue(source.contains("onCheck = { if (canCheckNow()) retry++"))
        // Rewritten for Harvester START: START now opens the in-sheet reviewed owner (its guard and refusal live in
        // openReview, still counted below) instead of hopping to the old Harvester screen.
        assertTrue(source.contains("reviewStart = { openReview(facts?.buildingId) }"))
        assertTrue(source.contains("refresh = { if (canCheckNow()) retry++"))
        // Updated from 3 for the in-place sheet: the three original refusals stay (START via openReview, RETRY, HISTORY
        // CHECK) and two doors that used to fall silent now explain too: the shared `checked` guard of every in-sheet door
        // (COLLECT, UPGRADE, refine and sell GO, receipt CHECK, need-more) and ORIGINAL REQUESTS on the owner-missing plate.
        assertEquals("START, RETRY, HISTORY CHECK, the in-sheet doors and owner-missing recovery each explain a refused guard", 5,
            Regex("""else\s+explain\(homeReadRefusalReason\(""").findAll(source).count())
        assertTrue(source.contains("owner.refresh.invoke(Unit)"))
    }
    @Test fun `designed history recovery is optional explicit and invokes the original guarded route`() {
        val footer = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/craft/HarvesterHistoryTab.kt").readText()
        assertTrue(footer.contains("val onOpenOriginal: (() -> Unit)? = null"))
        assertTrue(footer.contains("on.onOpenOriginal?.let { original ->"))
        assertTrue(footer.contains("SecondaryButton(\"ORIGINAL REQUESTS\", original"))
        val source = mountedHomeSource()
        assertTrue(source.contains("onOpenOriginal = if (projectionCurrent && canCheckNow()) ({ if (canCheckNow()) onLegacy() }) else null"))
    }
    // Rewritten for the in-place sheet (name and one assertion): the header art is no longer withheld. It now arrives from
    // the mount (the server art map's key and tier), and the host still derives neither; the inline review stays off.
    @Test fun `Home binds yield time to observed server time takes artwork from the mount and leaves inline review unavailable`() {
        val source = mountedHomeSource()
        assertTrue(source.contains("java.time.Instant.parse(it.serverNow).toEpochMilli()"))
        assertTrue(source.contains("Math.subtractExact("))
        assertTrue(source.contains("remember(view?.serverNow)"))
        assertTrue(source.contains("System.currentTimeMillis()"))
        assertTrue(source.contains("serverOffsetMs = serverOffset"))
        assertFalse(source.contains("serverOffsetMs = 0"))
        assertTrue(source.contains("artKey = artKey, tier = artTier(facts?.level)"))
        assertFalse(source.contains("artKey = null"))
        assertTrue(source.contains("copy(review = null)"))
    }
    @Test fun `Home retains account source seen markers and existing receipt check without synthetic delivery`() {
        val source = mountedHomeSource()
        assertTrue(source.contains("HomeHarvesterSeen(")); assertTrue(source.contains("seen.observe(sourceId, latest)"))
        assertTrue(source.contains("seen.acknowledge(source, harvesterLatestSequence(current.journal, source))"))
        assertTrue(source.contains("owner.check.invoke(Unit)"))
        assertFalse(source.contains("markDelivered(")); assertFalse(source.contains("model.confirm("))
    }

    @Test fun `only a validated current view can identify the current UTC day`() {
        val original = operation()
        val proof = original.copy(proof = original.proof!!.copy(serverNow = "2030-01-01T18:00:00.000Z"))
        val observed = state(proof).copy(view = view().copy(serverNow = "2030-01-01T18:00:00.000Z"))
        val ui = history(observed)
        assertEquals("TODAY · UTC", ui.groups.single().label)
        assertTrue(ui.days.last().today); assertEquals("Today", ui.days.last().label)
        assertNull(ui.weekTotal); assertTrue(ui.days.all { it.total == null && it.amount == null })
    }

    @Test fun `an invalid view time cannot substitute a receipt time for today`() {
        val ui = history(state().copy(view = view().copy(serverNow = "unreadable")))
        assertEquals(2, ui.groups.flatMap { it.rows }.size)
        assertTrue(ui.groups.none { it.label == "TODAY · UTC" })
        assertTrue(ui.days.all { it.label == "…" && !it.today })
    }

    @Test fun `read failure takes precedence over a missing Harvester selection with saved receipts`() {
        val ui = history(state().copy(view = null), selected = null, error = "The realm could not be reached")
        assertEquals(CraftHydration.Error("The realm could not be reached"), ui.load)
        assertEquals("The realm could not be reached", ui.emptyReason)
        assertFalse(ui.emptyReason.contains("Choose a Harvester"))
        assertFalse(ui.checkAllowed)
    }
}
