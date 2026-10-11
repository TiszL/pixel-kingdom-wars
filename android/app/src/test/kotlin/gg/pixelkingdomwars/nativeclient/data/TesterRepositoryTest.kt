package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TesterRepositoryTest {
    private val timestamp = "2026-09-12T00:00:00.000Z"
    private val campaign = """{"id":"founding-kingdoms","scoreType":"founding","name":"Founding Kingdoms","totalDays":14,
        "startAt":null,"endAt":null,"dayIndex":null,"rewardCopy":"Server reward description","whitelist":{"requiresLandDeed":true,"spots":300}}"""
    private val shortWallet = WALLET.take(4) + "…" + WALLET.takeLast(4)
    private fun progress(awards: String = "[]", wallet: String = shortWallet) = json("""{
        "wallet":"$wallet","name":"Tester","listed":false,"listedReason":"hidden","points":107,"rank":null,
        "milestonePoints":40,"feedbackPoints":12,"feedbackCount":2,"dailyPoints":50,"referralPoints":5,"landOwner":true,
        "milestones":[{"key":"first","category":"new_category","title":"Future milestone","hint":"Server hint","points":60,"achieved":true,"achievedAt":"$timestamp"}],
        "daily":{"todayPoints":7,"streakDays":4,"byKey":[{"key":"played","count":2,"points":7,"lastAt":"$timestamp"},{"key":"new_daily","count":1,"points":0,"lastAt":"$timestamp"}],
        "catalog":{"sources":[{"key":"played","category":"daily","title":"Play today","hint":"Play a battle","points":5,"cap":3}],
        "streaks":[{"key":"streak","title":"Keep playing","hint":"Play consecutive days","points":30,"days":7}],
        "categoryLabels":{"daily":"Daily play"},"lookbackDays":90}},
        "referrals":{"invited":4,"qualified":3,"activeToday":1},"campaign":$campaign,"justEarned":$awards}""")
    private fun award(key: String = "first", points: Int = 4) = """{"kind":"milestone","key":"$key","points":$points,"achievedAt":"$timestamp"}"""
    private fun boardRow(rank: Int) = """{"rank":$rank,"name":null,"wallet":"$shortWallet","points":10,"milestones":1,"feedback":0,"dailyPoints":4,"referralPoints":1,"landOwner":false,"lastAt":null}"""
    private fun board(rows: String = boardRow(1)) = json("""{"entries":[$rows],"totals":{"testers":8,"points":400,"feedback":12},"scoreType":"lifetime",
        "computedAt":"$timestamp","campaignIds":["founding-kingdoms","rewarded-playtest"],"campaign":$campaign}""")
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        var now = 100L
        var bounds: TesterBounds? = TesterBounds(1000, 2)
        val repo = LiveTesterRepository(session, holder, api, { bounds }, { now })
        init { api.onGet("/tester/me") { progress() }; api.onGet("/tester/leaderboard") { board() } }
    }
    @Test fun `catalog bounds come from verified content and missing limits prevent recompute GET`(): Unit = runBlocking {
        assertEquals(TesterBounds(127, 13), TesterBounds.from(json("""{"constants":{"TESTER_PROGRAM":{"recomputeMinIntervalMs":127,"leaderboardLimit":13}}}""")))
        assertNull(TesterBounds.from(json("""{"constants":{"TESTER_PROGRAM":{"recomputeMinIntervalMs":0,"leaderboardLimit":13}}}""")))
        val f = Fixture(); f.bounds = null
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.refreshProgress() } }
        assertTrue(f.api.gets.isEmpty())
    }
    @Test fun `server ledger totals survive changed catalogue points and capped activity`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refreshProgress(); val result = f.repo.state.value.progress!!
        assertEquals(40L, result.milestonePoints); assertEquals(60L, result.milestones.single().points)
        assertEquals(7L, result.daily.byKey.first().points); assertEquals(5L, result.daily.catalog.sources.single().points)
        assertEquals(0L, result.daily.byKey.last().points); assertEquals(107L, result.points)
        assertEquals("new_category", result.milestones.single().category); assertEquals("new_daily", result.daily.byKey.last().key)
        assertFalse(result.listed); assertEquals("hidden", result.listedReason); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `foreground and concurrent readers share one recompute result without reannouncing dismissed awards`(): Unit = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onGet("/tester/me") { started.complete(Unit); finish.await(); progress("[${award()}]") }
        val first = launch { f.repo.refreshProgress() }; started.await()
        val second = launch(start = CoroutineStart.UNDISPATCHED) { f.repo.refreshProgress(true) }
        finish.complete(Unit); first.join(); second.join()
        assertEquals(1, f.api.gets.size); assertTrue(f.repo.state.value.awardNotice!!.contains("Future milestone"))
        f.repo.dismissAward(); f.repo.refreshProgress(); assertEquals(1, f.api.gets.size); assertNull(f.repo.state.value.awardNotice)
    }
    @Test fun `shared interval expires at boundary and explicit refresh bypasses only cache age`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refreshProgress(); f.now += 999; f.repo.refreshProgress(); assertEquals(1, f.api.gets.size)
        f.now++; f.repo.refreshProgress(); assertEquals(2, f.api.gets.size)
        f.repo.refreshProgress(true); assertEquals(3, f.api.gets.size); assertTrue(f.api.gets.all { it.second.isEmpty() })
    }
    @Test fun `server award titles fall back for unknown keys and zero deltas never announce`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/tester/me") { progress("[${award(points = 0)},${award("unreleased_key", 5)},${award("played", 2)}]") }
        f.repo.refreshProgress(); val notice = f.repo.state.value.awardNotice!!
        assertFalse(notice.contains("+0")); assertTrue(notice.contains("unreleased_key")); assertTrue(notice.contains("Play today"))
        f.api.onGet("/tester/me") { progress("[${award(points = 0)}]") }; f.repo.refreshProgress(true); assertNull(f.repo.state.value.awardNotice)
    }
    @Test fun `offline refresh retains last server snapshot and explicit retry reads without point claims`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refreshProgress(); val old = f.repo.state.value.progress
        f.api.onGet("/tester/me") { throw IOException("Offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.refreshProgress(true) } }
        assertSame(old, f.repo.state.value.progress); assertFalse(f.repo.state.value.loadingProgress)
        f.api.onGet("/tester/me") { progress() }; f.repo.refreshProgress()
        assertEquals(3, f.api.gets.size); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `overlapping reads share failure instead of making an automatic recompute retry`(): Unit = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onGet("/tester/me") { started.complete(Unit); finish.await(); throw IOException("lost") }
        val first = async { runCatching { f.repo.refreshProgress() }.exceptionOrNull() }; started.await()
        val second = async(start = CoroutineStart.UNDISPATCHED) { runCatching { f.repo.refreshProgress(true) }.exceptionOrNull() }
        finish.complete(Unit); assertTrue(first.await() is IOException); assertTrue(second.await() is IOException); assertEquals(1, f.api.gets.size)
    }
    @Test fun `same-wallet session replacement fences late points and award notices`(): Unit = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onGet("/tester/me") { started.complete(Unit); finish.await(); progress("[${award()}]") }
        val read = launch { f.repo.refreshProgress() }; started.await(); signedIn(f.holder); finish.complete(Unit); read.join()
        assertNull(f.repo.state.value.progress); assertNull(f.repo.state.value.awardNotice); assertTrue(read.isCancelled)
        assertThrows(CancellationException::class.java) { runBlocking { f.repo.refreshBoard() } }; assertEquals(1, f.api.gets.size)
    }
    @Test fun `process recreation fetches fresh progress and cannot reconstruct a missed award`(): Unit = runBlocking {
        val first = Fixture(); first.api.onGet("/tester/me") { progress("[${award()}]") }; first.repo.refreshProgress()
        val restored = Fixture(); restored.repo.refreshProgress()
        assertEquals(first.repo.state.value.progress!!.points, restored.repo.state.value.progress!!.points)
        assertNull(restored.repo.state.value.awardNotice); assertTrue(restored.api.posts.isEmpty())
    }
    @Test fun `public board accepts colliding shortened wallets and never treats them as identities`(): Unit = runBlocking {
        val f = Fixture(); f.api.onGet("/tester/leaderboard") { board("${boardRow(1)},${boardRow(2)}") }; f.repo.refreshBoard()
        val rows = f.repo.state.value.board!!.entries; assertEquals(2, rows.size); assertEquals(rows[0].wallet, rows[1].wallet)
        assertEquals(listOf(1, 2), rows.map { it.rank }); assertNull(f.repo.state.value.progress); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `oversized or campaign-scored public board is refused while last good board remains`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refreshBoard(); val previous = f.repo.state.value.board
        for (raw in listOf(board("${boardRow(1)},${boardRow(2)},${boardRow(3)}"), JsonObject(board() + ("scoreType" to JsonPrimitive("founding"))))) {
            f.api.onGet("/tester/leaderboard") { raw }
            assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.refreshBoard() } }
            assertSame(previous, f.repo.state.value.board); assertFalse(f.repo.state.value.loadingBoard)
        }
    }
    @Test fun `foreign own-wallet label and incomplete private progression are compatibility failures`(): Unit = runBlocking {
        val f = Fixture()
        for (raw in listOf(progress(wallet = "foreign"), JsonObject(progress() - "listedReason"), JsonObject(progress() - "daily"))) {
            f.api.onGet("/tester/me") { raw }
            assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.refreshProgress(true) } }
            assertNull(f.repo.state.value.progress)
        }
    }
    @Test fun `campaign dates and land reward copy follow server phase without client time arithmetic`() {
        val parsed = TesterProgress.from(progress()).campaign
        assertEquals("Dates to be announced", parsed.dayLabel); assertEquals("Opens soon", parsed.copy(dayIndex = 0).dayLabel)
        assertEquals("Day 1 of 14", parsed.copy(dayIndex = 1).dayLabel); assertEquals("Closed", parsed.copy(dayIndex = 15).dayLabel)
        assertEquals("Server reward description", parsed.rewardCopy); assertEquals(300, parsed.whitelist.spots)
    }
}
