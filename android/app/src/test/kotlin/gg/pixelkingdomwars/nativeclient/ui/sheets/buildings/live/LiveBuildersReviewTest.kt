package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LiveBuildersReviewTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"CAPS":{"buildersMax":4,"builderPricesSol":[2,10,20]}}}""").jsonObject
    private fun state(free: Int = 1, jobs: String = "[]", owned: Int = 2) = KingdomUiState(catalogue = catalogue,
        home = BaseState(base = BaseSnapshot.from(Json.parseToJsonElement("""{
        "baseId":"11111111-1111-4111-8111-111111111111","player":{"keepLevel":20,"builders":$owned},
        "freeBuilders":$free,"buildings":[{"id":"building-a","type":"keep","level":1,"tx":1,"ty":1}],"jobs":$jobs}""").jsonObject)))
    private val paid = """[{"id":"job-a","kind":"upgrade","buildingId":"building-a","finishCostKeep":"37"}]"""
    private fun mapped(s: KingdomUiState = state(), busy: Boolean = false, canHire: Boolean = true) =
        requireNotNull(liveBuildersReview(s, busy, canHire, 0))

    @Test fun `server free count determines owned rows even when job details are absent`() {
        val ui = mapped().ui
        assertEquals(2, ui.owned); assertEquals(1, ui.free); assertEquals(4, ui.maximum)
        assertEquals(listOf(BuilderStatus.WORKING, BuilderStatus.FREE), ui.rows.map { it.status })
        assertEquals(PriceStatus.UNAVAILABLE, ui.rows.first().finish?.status)
        assertNull(ui.rows.first().focus)
    }
    @Test fun `only next hire uses the original SOL offer and navigation gate`() {
        val hire = requireNotNull(mapped().ui.hire)
        assertEquals(3, hire.number); assertEquals("10", hire.price.amount)
        assertEquals(Currency.SOL, hire.price.currency); assertEquals(PriceStatus.OK, hire.price.status)
        assertEquals(PriceStatus.UNAVAILABLE, mapped(canHire = false).ui.hire?.price?.status)
        assertNull(mapped(state(free = 4, owned = 4)).ui.hire)
    }
    @Test fun `inconsistent or missing roster data cannot invent builders`() {
        assertNull(liveBuildersReview(state(free = 3), false, true, 0))
        assertNull(liveBuildersReview(state().copy(catalogue = null), false, true, 0))
        val base = state().base!!
        val missing = BaseSnapshot.from(JsonObject(base.raw - "freeBuilders"))
        assertNull(liveBuildersReview(state().copy(home = BaseState(base = missing)), false, true, 0))
    }
    @Test fun `job row retains the exact original job and opaque local focus identity`() {
        val state = state(jobs = paid)
        val review = mapped(state)
        assertSame(state.base!!.jobs.single(), review.jobsByNumber[1])
        assertEquals("job-a", review.ui.rows.first().focus?.value)
        // 77b11dda: typed balances cannot reproduce the fresh exact-currency review; never pin a guessed price.
        val row = review.ui.rows.first()
        assertNull(row.finish?.amount)
        assertEquals(PriceStatus.CHECKING, row.finish?.status)
        assertEquals(FinishKind.FINISH, finishLook(row.finish, row.busy, row.checking).kind)
    }
    @Test fun `free completion needs explicit server zero and unsupported paid builds stay unavailable`() {
        val free = mapped(state(jobs = paid.replace("37", "0"))).ui.rows.first()
        assertEquals(PriceStatus.SERVER_ZERO, free.finish?.status)
        assertEquals(PriceStatus.UNAVAILABLE, mapped(state(jobs = paid.replace("upgrade", "build"))).ui.rows.first().finish?.status)
        assertEquals(PriceStatus.UNAVAILABLE, mapped(state(jobs = paid.replace("37", "broken"))).ui.rows.first().finish?.status)
    }
    @Test fun `busy construction recovery and order gates disable row finish`() {
        assertTrue(mapped(state(jobs = paid), busy = true).ui.rows.first().busy)
        val saved = InterruptedIntent(PendingIntent(IntentKind.CONSTRUCTION, "test-wallet", null, "saved-builder-key",
            "/base/jobs/job-a/finish", JsonObject(emptyMap()), "Saved construction"))
        assertEquals(PriceStatus.UNAVAILABLE, mapped(state(jobs = paid).copy(interrupted = listOf(saved))).ui.rows.first().finish?.status)
        for (state in listOf(state(jobs = paid).copy(ordersAllowed = false), state(jobs = paid).copy(deedActionsAllowed = false))) {
            assertEquals(PriceStatus.UNAVAILABLE, mapped(state).ui.rows.first().finish?.status)
        }
    }
    @Test fun `more jobs than working slots are preserved as extra jobs without changing free count`() {
        // Rewritten 2026-10-06 (night UI, slice C): the extra job used to be drawn in a separate non-design ACTIVE JOBS
        // panel. It is now an extra row of the same designed list (builders.png has no second panel), titled JOB rather
        // than BUILDER n because no such builder exists, and it still reaches its exact job by tap and by FINISH.
        val review = mapped(state(free = 2, jobs = paid))
        assertEquals(2, review.ui.free)
        assertEquals(listOf(BuilderStatus.FREE, BuilderStatus.FREE), review.ui.rows.take(2).map { it.status })
        val extra = review.ui.rows.drop(2).single()
        assertEquals(BuilderStatus.WORKING, extra.status); assertEquals(UNSLOTTED_JOB_TITLE, extra.title)
        assertEquals("job-a", extra.focus?.value)
        assertSame(review.extraJobs.single(), review.jobsByNumber[extra.number])
        assertEquals(listOf("job-a"), review.extraJobs.map { it.id })
        // Owned slots never borrow the extra row's key or title.
        assertTrue(review.ui.rows.take(2).all { it.title == null && it.number <= review.ui.owned })
    }
    @Test fun `hire line wording follows builders png and the locked state`() {
        // The frame's hint replaces the old non-design sentence; the next slot opens only after this hire.
        val ui = mapped().ui
        assertEquals("Tap a builder to fly to the job.", ui.hint)
        assertEquals("Builder 4 opens after 3.", ui.hire?.nextLockedLine)
        val last = requireNotNull(mapped(state(owned = 3, free = 3)).ui.hire)
        assertEquals(4, last.number); assertNull(last.nextLockedLine)
        assertEquals("All builder slots are yours.", mapped(state(free = 4, owned = 4)).ui.hireLine)
        // A catalogue without a hire price is SPEC R2.1's locked state, not a vague "offer unavailable".
        val noPrices = state().copy(catalogue = Json.parseToJsonElement("""{"constants":{"CAPS":{"buildersMax":4}}}""").jsonObject)
        val locked = mapped(noPrices).ui
        assertNull(locked.hire); assertEquals("Hiring opens later", locked.hireLine)
    }
    @Test fun `scene tap keeps external owner first and consumes only an open Builders sheet`() {
        val calls = mutableListOf<String>()
        assertTrue(consumeBuildersTap(true, { calls += "owner"; true }, { calls += "close" }))
        assertEquals(listOf("owner"), calls)
        calls.clear()
        assertTrue(consumeBuildersTap(true, { calls += "owner"; false }, { calls += "close" }))
        assertEquals(listOf("owner", "close"), calls)
        assertFalse(consumeBuildersTap(false, { false }, { fail("closed sheet must not close again") }))
    }

    @Test fun `Gems enabled but short with KEEP covering still claims neither currency nor amount`() {
        // The owner re-reads raw gameCurrency capability, absent from typed Balances, before choosing currency.
        val initial = state(jobs = paid)
        val balances = Balances(shards = "0", keep = "100", gems = "1", features = BalanceFeatures(GemsFeature(1, 1)))
        for (funds in listOf(balances, balances.copy(keep = "0"), null)) {
            val row = mapped(initial.copy(home = initial.home.copy(balances = funds))).ui.rows.first()
            val price = requireNotNull(row.finish)
            assertNull(price.amount); assertEquals(PriceStatus.CHECKING, price.status)
            assertEquals("shape:unknown", price.icon)
            assertFalse(priceDescription(price).contains("Gems")); assertFalse(priceDescription(price).contains("KEEP"))
            assertEquals(FinishKind.FINISH, finishLook(price, row.busy, row.checking).kind)
        }
    }
    @Test fun `refused finish still hides unreviewed amount and stays unavailable`() {
        val row = mapped(state(jobs = paid).copy(ordersAllowed = false)).ui.rows.first()
        assertEquals(PriceStatus.UNAVAILABLE, row.finish?.status); assertNull(row.finish?.amount)
        assertEquals(FinishKind.OFF, finishLook(row.finish, row.busy, row.checking).kind)
    }
    @Test fun `unmatched jobs retain building label time left and progress`() {
        // Free count is canonical; extra jobs still need their full original presentation outside worker slots.
        val jobs = paid.replace("\"finishCostKeep\":\"37\"", "\"finishCostKeep\":\"37\",\"startedAt\":\"1970-01-01T00:00:00Z\",\"finishesAt\":\"1970-01-01T00:00:10Z\"")
        val state = state(free = 2, jobs = jobs)
        val detail = liveBuilderJobDetail(state, mapped(state).extraJobs.single(), 5000)
        assertTrue(detail.line.contains("KEEP")); assertTrue(detail.line.contains("UPGRADE"))
        assertEquals("5s remaining", detail.progress?.remaining); assertEquals(0.5f, detail.progress?.fraction)
    }
    @Test fun `production mount retains owners and hides Builders behind editor and tray but opens it over placement`() {
        // Composables do not run on the JVM; pin the three owner seams and the actual visibility predicate.
        val screen = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue(screen.contains("onFinish = { job -> buildersOpen = false; model.finishBuilderJob(job) }"))
        assertTrue(screen.contains("onHire = { base.baseId?.let { buildersOpen = false; onBasePurchase(\"builder\", it, null) } }"))
        // 02aedc7d nests sibling local sheets here; keep the Builders seam and exactly one external-owner call.
        val tap = screen.substringAfter("val latestBeforeSceneTap").substringBefore("var selectedAtMs")
        assertTrue(tap.contains("consumeBuildersTap(buildersVisible,"))
        assertEquals(1, Regex("\\bonBeforeSceneTap\\b").findAll(tap).count())
        // Rewritten 2026-10-06 (fix-builder-bug): the predicate used to end `&& local.placement == null`, so the placement
        // band's NO_BUILDER PLACE (whose only job is "tap → Builders", buildings/SPEC.md §4.3) set the flag and showed nothing
        // until placement ended: a door that did nothing, then a sheet popping up later. Builders now opens over the band
        // (HIRE reaches the same purchase owner); flying to a job leaves placement first, and opening the tray drops a stale
        // Builders so it cannot pop over the placement a card starts. The tray's own door leaves the tray first.
        assertTrue(screen.contains("val buildersVisible = buildersOpen && !editing && !local.buildMenu\n"))
        val viewJob = screen.substringAfter("onViewJob = { job ->").substringBefore("}, onFinish")
        assertTrue(viewJob.indexOf("model.cancelPlacement()") in 0 until viewJob.indexOf("model.selectJob(job)"))
        assertTrue(screen.contains("LaunchedEffect(local.buildMenu) { if (local.buildMenu) buildersOpen = false }"))
        assertTrue(screen.contains("onBuilders = { model.closeBuildMenu(); buildersOpen = true }"))
        assertTrue(screen.contains("onPlace = model::confirmPlacement, onCancel = model::cancelPlacement, onBuilders = { buildersOpen = true }"))
        assertTrue(screen.contains("if (buildersVisible && base != null) LiveBuildersHost"))
        assertTrue(screen.contains("BackHandlerAt(BackPriority.SHEET, enabled = buildersVisible)"))
        val host = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/live/LiveBuildersHost.kt").readText()
        // Rewritten 2026-10-06 (night UI, slice C): the host used to draw unmatched jobs in its own ACTIVE JOBS panel with
        // VIEW JOB buttons. Every job now reaches the designed sheet as a row (see the extra-jobs case above), a row tap
        // is onViewJob, and the host draws no second panel.
        assertFalse(host.contains("ACTIVE JOBS")); assertFalse(host.contains("VIEW JOB"))
        assertTrue(host.contains("review.jobsByNumber.values.firstOrNull { it.id == token.value }?.let(onViewJob)"))
        // HIRE reaches the Home purchase owner when the mount passes one, and keeps the old screen only as the fallback.
        assertTrue(host.contains("onHire = { if (flow != null) flow.primary() else onHire() }"))
    }
}
