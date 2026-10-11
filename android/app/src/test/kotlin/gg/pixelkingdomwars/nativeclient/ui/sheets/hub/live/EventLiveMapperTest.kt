package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.PlaytestState
import gg.pixelkingdomwars.nativeclient.data.SavedCampaignRequest
import gg.pixelkingdomwars.nativeclient.data.TesterState
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.PlaytestCampaign
import gg.pixelkingdomwars.nativeclient.model.TesterProgress
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.EventPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import org.junit.Assert.*
import org.junit.Test

/** The event card shows whitelist-relevant numbers: every one must be the server's, and every door must be one of four. */
class EventLiveMapperTest {
    private val stamp = "2026-09-12T00:00:00.000Z"
    private val founding = "founding-kingdoms"
    private val rewarded = "rewarded-playtest"

    private fun standing(rank: Int, points: Long, you: Boolean = false, guaranteed: Boolean = false, eligible: Boolean = true) =
        """{"rank":$rank,"wallet":"${if (you) WALLET else "Wallet$rank"}","username":"Keeper$rank","points":$points,"activeDays":4,
        "longestStreak":3,"revenge":0,"stages":0,"achievedAt":null,"eligible":$eligible,"guaranteed":$guaranteed,"isYou":$you}"""

    private fun participant(disqualified: Boolean = false, reason: String? = null) = """{"campaignId":"$rewarded","wallet":"$WALLET",
        "joinedAt":"$stamp","disqualifiedAt":${if (disqualified) "\"$stamp\"" else "null"},
        "disqualificationReason":${reason?.let { "\"$it\"" } ?: "null"},"bonusAt":null}"""

    private fun campaign(id: String = founding, phase: String = "running", registrationOpen: Boolean = true, participant: String = "null",
        standings: List<String> = emptyList(), checkpoint: String = "null", prizes: String = "[]", winners: String = "[]") =
        PlaytestCampaign.from(json("""{"id":"$id","kind":"${if (id == founding) "founding" else "rewarded"}","name":"Founding Kingdoms",
        "phase":"$phase","startAt":"$stamp","endAt":"2026-09-26T00:00:00.000Z","registrationOpen":$registrationOpen,"revision":1,
        "reconciledAt":null,"snapshotAt":null,"checkpoint":$checkpoint,"spots":null,"stale":false,"measurementSince":null,
        "participant":$participant,"standings":[${standings.joinToString(",")}],"founders":[],"winners":$winners,"prizes":$prizes,
        "ownSubmissions":[]}"""))

    private val todayRows = """[{"key":"raid_win","count":2,"points":40,"lastAt":"$stamp"},{"key":"mystery","count":1,"points":5,"lastAt":"$stamp"}]"""
    private fun progress(dayIndex: String = "3", byKey: String = todayRows) = TesterProgress.from(json("""{
        "wallet":"DnF3…fVUX","name":"Tester","listed":true,"listedReason":"listed","points":107,"rank":4,
        "milestonePoints":40,"feedbackPoints":12,"feedbackCount":2,"dailyPoints":50,"referralPoints":5,"landOwner":true,"milestones":[],
        "daily":{"todayPoints":45,"streakDays":4,"byKey":$byKey,
        "catalog":{"sources":[{"key":"raid_win","category":"battle","title":"Win a raid","hint":"Win any raid","points":20,"cap":5},
        {"key":"bug_report","category":"feedback","title":"Report a bug","hint":"Send a report","points":10,"cap":3}],
        "streaks":[{"key":"streak_7","title":"Keep playing","hint":"Play consecutive days","points":30,"days":7}],
        "categoryLabels":{"battle":"Battles"},"lookbackDays":90}},
        "referrals":{"invited":0,"qualified":0,"activeToday":0},
        "campaign":{"id":"$founding","scoreType":"founding","name":"Founding Kingdoms","totalDays":14,"startAt":null,"endAt":null,
        "dayIndex":$dayIndex,"rewardCopy":"Top ranks earn a founding spot","whitelist":{"requiresLandDeed":true,"spots":300}},
        "justEarned":[]}"""))

    private fun saved() = SavedCampaignRequest(WALLET, "https://localhost:18443", rewarded, "e6a7e153-ddaf-43c8-ab97-f05ef927ca74", "participate")

    @Test fun `server campaign phase maps to the three card states and nothing unread becomes live`() {
        // The LIVE tag and the TODAY section must follow the server phase; a guessed LIVE would invite play that does not count.
        assertEquals(EventPhase.UPCOMING, eventPhaseOf("draft"))
        assertEquals(EventPhase.UPCOMING, eventPhaseOf("scheduled"))
        assertEquals(EventPhase.LIVE, eventPhaseOf("running"))
        assertEquals(EventPhase.CLOSED, eventPhaseOf("ended"))
        assertEquals(EventPhase.CLOSED, eventPhaseOf("finalized"))
        assertEquals(EventPhase.CLOSED, eventPhaseOf("cancelled"))
        val upcoming = liveEventUi(campaign(phase = "scheduled"), TesterState(), PlaytestState())
        assertEquals(EventPhase.UPCOMING, upcoming.phase)
        assertTrue(upcoming.startsLine!!.startsWith("Starts "))
        val unread = liveEventUi(null, TesterState(), PlaytestState(), load = LoadState.Loading)
        assertEquals(EventPhase.UPCOMING, unread.phase)
        assertEquals(LoadState.Loading, unread.load)
        assertTrue(unread.ranks.isEmpty() && unread.prizes.isEmpty() && unread.standing == null)
    }

    @Test fun `unknown daily cap reads UNKNOWN and today points come only from the server read`() {
        // The server sends per-activity caps but no total cap: a summed or zero cap would be a client-computed number.
        val read = liveEventUi(campaign(), TesterState(progress = progress()), PlaytestState())
        assertEquals("45", read.todayPoints)
        assertEquals(UNKNOWN, read.todayCap)
        val unread = liveEventUi(campaign(), TesterState(), PlaytestState())
        assertEquals(UNKNOWN, unread.todayPoints)
        assertEquals(UNKNOWN, unread.todayCap)
        assertNotEquals("0", unread.todayCap)
    }

    @Test fun `activity rows come only from the server catalogue with its own counts and caps`() {
        // No progress read means no rows at all; an unknown server key has no title or cap and is never drawn as a row.
        assertTrue(liveEventUi(campaign(), TesterState(), PlaytestState()).activities.isEmpty())
        val rows = liveEventUi(campaign(), TesterState(progress = progress()), PlaytestState()).activities
        assertEquals(listOf("Win a raid", "Report a bug", "Keep playing"), rows.map { it.title })
        val raid = rows[0]
        assertEquals(2, raid.count); assertEquals(5, raid.cap); assertEquals("20", raid.pointsEach)
        assertEquals("hud.attack", raid.door?.feature?.value); assertFalse(raid.done)
        val bug = rows[1]
        assertEquals(0, bug.count); assertEquals(3, bug.cap); assertEquals("settings.feedback", bug.door?.feature?.value)
        // A streak has no server cap: no bar (cap 0) and its own sub line instead of a fabricated "0/0".
        val streak = rows[2]
        assertEquals(0, streak.cap); assertNotNull(streak.sub); assertNull(streak.door)
        val capped = liveEventUi(campaign(), TesterState(progress = progress(byKey = """[{"key":"raid_win","count":5,"points":100,"lastAt":"$stamp"}]""")),
            PlaytestState()).activities.first()
        assertTrue(capped.done); assertNull(capped.door)
    }

    @Test fun `join opens only while registration is open and the player has not joined`() {
        // JOIN is the existing participate owner: offering it when the server would refuse is a door that cannot act.
        val open = campaign(id = rewarded)
        assertFalse(liveEventUi(open, TesterState(), PlaytestState()).joined)
        assertTrue(eventCanJoin(open, PlaytestState()))
        val closed = campaign(id = rewarded, registrationOpen = false)
        assertTrue(liveEventUi(closed, TesterState(), PlaytestState()).joined)
        assertFalse(eventCanJoin(closed, PlaytestState()))
        val joined = campaign(id = rewarded, participant = participant())
        assertTrue(liveEventUi(joined, TesterState(), PlaytestState()).joined)
        assertFalse(eventCanJoin(joined, PlaytestState()))
        // Founding participation is automatic: never a JOIN footer.
        assertTrue(liveEventUi(campaign(), TesterState(), PlaytestState()).joined)
        assertFalse(eventCanJoin(campaign(), PlaytestState()))
        // A saved or in-flight request blocks a second JOIN, and the saved one is resolved on the rules page.
        assertFalse(eventCanJoin(open, PlaytestState(pending = saved())))
        assertFalse(eventCanJoin(open, PlaytestState(busy = true)))
        val pending = liveEventUi(open, TesterState(), PlaytestState(pending = saved())).load
        assertTrue(pending is LoadState.Error && pending.message.contains("saved join request"))
    }

    @Test fun `disqualified line carries the server reason or the old rules fallback`() {
        // A disqualified player must see why their points do not count, in the server's words.
        val reason = "Two kingdoms on one wallet"
        assertEquals(reason, liveEventUi(campaign(id = rewarded, participant = participant(true, reason)), TesterState(), PlaytestState()).disqualified)
        assertEquals("See the campaign rules.", liveEventUi(campaign(id = rewarded, participant = participant(true)), TesterState(), PlaytestState()).disqualified)
        assertNull(liveEventUi(campaign(id = rewarded, participant = participant()), TesterState(), PlaytestState()).disqualified)
    }

    @Test fun `ranks keep the server order and only the server YOU row is pinned`() {
        // Ties are broken by the server (active days, time, wallet); re-sorting by points would show a different ladder.
        val ui = liveEventUi(campaign(standings = listOf(standing(1, 100), standing(2, 300, you = true), standing(3, 200))),
            TesterState(progress = progress()), PlaytestState())
        assertEquals(listOf("1", "2", "3"), ui.ranks.map { it.rankText })
        assertEquals(listOf("100", "300", "200"), ui.ranks.map { it.points })
        assertEquals("2", ui.ranks.single { it.isYou }.rankText)
        assertEquals("2", ui.you?.rankText)
        assertEquals("2", ui.standing?.rank)
        assertEquals("300", ui.standing?.points)
        assertEquals("Top ranks earn a founding spot", ui.standing?.goalLine)
        val absent = liveEventUi(campaign(standings = listOf(standing(1, 100))), TesterState(), PlaytestState())
        assertNull(absent.you); assertNull(absent.standing)
        assertTrue(absent.ranks.none { it.isYou })
    }

    @Test fun `event feature fact is unknown before a read and allowed only while the server says live`() {
        // The EVENT edge button and its sheet gate on this fact; before any read the HUD must not guess either way.
        assertEquals(GateFact.Unknown, homeEventFeatureFact(TesterState(), PlaytestState()))
        assertNull(homeEventEdgeButton(TesterState(), PlaytestState()))
        val live = TesterState(progress = progress(dayIndex = "3"))
        assertEquals(GateFact.Allowed, homeEventFeatureFact(live, PlaytestState()))
        val button = homeEventEdgeButton(live, PlaytestState())
        assertEquals(HudIds.EVENT, button?.id)
        assertNotNull(button?.badge)
        assertTrue(homeEventFeatureFact(TesterState(progress = progress(dayIndex = "0")), PlaytestState()) is GateFact.Denied)
        assertTrue(homeEventFeatureFact(TesterState(progress = progress(dayIndex = "15")), PlaytestState()) is GateFact.Denied)
        assertTrue(homeEventFeatureFact(TesterState(progress = progress(dayIndex = "null")), PlaytestState()) is GateFact.Denied)
        // A read campaign phase outranks the tester day counter.
        assertTrue(homeEventFeatureFact(live, PlaytestState(campaign = campaign(phase = "ended"))) is GateFact.Denied)
        assertNull(homeEventEdgeButton(live, PlaytestState(campaign = campaign(phase = "ended"))))
        assertEquals(GateFact.Allowed, homeEventFeatureFact(TesterState(), PlaytestState(campaign = campaign(phase = "running"))))
    }

    @Test fun `activity doors only ever lead to the four event doors`() {
        // EventHub hands these to the Home host; any other id would be a door the host cannot open.
        assertEquals("hud.attack", eventActivityDoor("raid_win", "battle")?.feature?.value)
        assertEquals("settings.feedback", eventActivityDoor("bug_report", null)?.feature?.value)
        assertEquals("hud.quests", eventActivityDoor("quest_claimed", "daily")?.feature?.value)
        assertEquals("profile.kingdoms", eventActivityDoor("land_deed", null)?.feature?.value)
        assertNull(eventActivityDoor("cache_claimed", "daily"))
        val rows = liveEventUi(campaign(), TesterState(progress = progress()), PlaytestState()).activities
        assertTrue(rows.mapNotNull { it.door?.feature?.value }.all { it in EVENT_DOOR_FEATURES })
    }

    @Test fun `founding checkpoint tag shows until the server reports a counted checkpoint`() {
        // The old screen said the server retries verification; the card keeps that as the Being checked tag.
        assertNotNull(liveEventUi(campaign(), TesterState(), PlaytestState()).checkpoint)
        val verified = """{"count":12,"target":50,"frozen":false,"available":true,"verification":{"status":"verified","lastSuccessAt":"$stamp","lastAttemptAt":"$stamp"}}"""
        assertNull(liveEventUi(campaign(checkpoint = verified), TesterState(), PlaytestState()).checkpoint)
        assertNull(liveEventUi(campaign(id = rewarded), TesterState(), PlaytestState()).checkpoint)
    }

    @Test fun `prizes show how they are won and the server result without money amounts`() {
        // Finance language rule: the server has amountUsd but the surface never shows it; results are the server's own.
        val prizes = """[{"id":"bug-1","title":"Bug Scout","amountUsd":25,"category":"report","metric":"judged"},
            {"id":"bug-2","title":"Bug Scout","amountUsd":25,"category":"report","metric":"judged"},
            {"id":"champion","title":"Crown Champion","amountUsd":100,"category":"gameplay","metric":"score"}]"""
        val winners = """[{"prizeId":"bug-2","wallet":"$WALLET","username":"Me","amountUsd":25,"category":"report"}]"""
        val ui = liveEventUi(campaign(id = rewarded, phase = "finalized", prizes = prizes, winners = winners), TesterState(), PlaytestState(),
            ownWallet = WALLET)
        assertEquals(listOf("Bug Scout", "Crown Champion"), ui.prizes.map { it.title })
        assertEquals("Awarded to you", ui.prizes.first().result)
        assertNull(ui.prizes.last().result)
        assertTrue(ui.prizes.none { p -> listOf(p.title, p.howWon, p.result.orEmpty()).any { it.contains("$") || it.contains("25") || it.contains("100") } })
        assertTrue(ui.resultsLine.contains("server's award results"))
    }
}
