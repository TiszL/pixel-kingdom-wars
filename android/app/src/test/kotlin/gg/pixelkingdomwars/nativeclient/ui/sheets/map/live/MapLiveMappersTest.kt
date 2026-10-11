package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.DivineCommand
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentFixtures
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentJournal
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentState
import gg.pixelkingdomwars.nativeclient.data.DivineJournal
import gg.pixelkingdomwars.nativeclient.data.DivineObservation
import gg.pixelkingdomwars.nativeclient.data.DivineSavedEvent
import gg.pixelkingdomwars.nativeclient.data.DivineTrialFixtures
import gg.pixelkingdomwars.nativeclient.data.DivineTrialState
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsContinuationIntent
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsJournal
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsOperation
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsSavedTrust
import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsState
import gg.pixelkingdomwars.nativeclient.data.RealmSalesJournal
import gg.pixelkingdomwars.nativeclient.data.RealmSalesOperation
import gg.pixelkingdomwars.nativeclient.data.RealmSalesSavedPolicy
import gg.pixelkingdomwars.nativeclient.data.RealmSalesState
import gg.pixelkingdomwars.nativeclient.data.SeekerResourceClaimsState
import gg.pixelkingdomwars.nativeclient.data.SeekerShardsClaimsState
import gg.pixelkingdomwars.nativeclient.data.taxFailureFixture
import gg.pixelkingdomwars.nativeclient.divine.dt
import gg.pixelkingdomwars.nativeclient.divine.dobj
import gg.pixelkingdomwars.nativeclient.divinefragments.fo
import gg.pixelkingdomwars.nativeclient.divinefragments.ft
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsCaps
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsContinuationRequest
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsFailureEnvelope
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsRecoveryEnvelope
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsPrepareRequest
import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePreparation
import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePrepareRequest
import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalesProtocolPolicy
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsEntitlement
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsEntitlementView
import gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimJournal
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimCommand
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimJournal
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimOperation
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimRequest
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceEntitlement
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceEntitlementView
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FragmentSource
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SourceState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TermState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Map displays preserve the server's amounts, original destinations and receipts: unknown is never zero,
 * stale discovery cannot repeat a paid claim, and presentation cannot arm a financial command. */
class MapLiveMappersTest {
    private val identity = StarterIdentity("https://map.example.test", "devnet", "1".repeat(32))
    private val term = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val base = "00000000-0000-4000-8000-000000000003"
    private val policy = RealmSalesSavedPolicy(RealmSalesProtocolPolicy(1, 60, 86400, 100, 8, 10, 604800, 50000000, 10000, 8000, 2000), 20, 7)

    private fun material(resource: String = "heartwood_beams", due: String = "7", spot: Int = 0) =
        SeekerResourceEntitlement(term, "a".repeat(64), "2026-09-21T00:00:00.000Z", "2026-09-28T00:00:00.000Z",
            spot, resource, 1, due, due, "0", due)
    private fun materials(rows: List<SeekerResourceEntitlement>, next: String? = null) = SeekerResourceClaimsState(
        SeekerResourceClaimJournal(1, identity, 0, null, emptyList()),
        SeekerResourceEntitlementView(1, identity.wallet, true, false, "available", null, null, next, rows))
    private fun trial(attempts: List<JsonObject> = emptyList(), participant: Boolean = true): DivineTrialState {
        val f = DivineTrialFixtures
        val saved = DivineSavedEvent(f.rules.raw, f.event, if (participant) f.participant(attempts = attempts) else null)
        return DivineTrialState(DivineJournal(identity = f.identity(), events = listOf(saved)), selectedId = saved.id)
    }
    private fun awardPage(delivered: Boolean = false): JsonObject {
        val f = DivineFragmentFixtures
        return f.page(listOf(buildJsonObject { put("award", f.award); put("delivery", if (delivered) f.receipt(f.command()) else JsonNull) }))
    }

    private fun fixture(name: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/" + name)).readText()).jsonObject
    private fun permitFixture(): Pair<RealmSalesState, RealmSalesSavedPolicy> {
        val raw = fixture("realm-sale-repository-fixture.json")
        val savedPolicy = RealmSalesSavedPolicy.from(raw.getValue("policy").jsonObject)
        val p = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, savedPolicy.protocol)
        val op = RealmSalesOperation(RealmSalePrepareRequest(p.idempotencyKey, p.spot, p.realm), savedPolicy, true, p, false, null, false, false, null)
        val actor = StarterIdentity(identity.origin, identity.cluster, p.wallet)
        return RealmSalesState(loaded = true, journal = RealmSalesJournal(1, actor, 1, op, null, emptyList(), false)) to savedPolicy
    }
    private fun taxRecovery(kind: String = "combined") = MiningTaxClaimsRecoveryEnvelope.from(
        fixture("mining-tax-journal-fixtures.json").getValue("recoveries").jsonObject.getValue(kind).jsonObject)
    private fun taxOperation(recovery: MiningTaxClaimsRecoveryEnvelope): MiningTaxClaimsOperation {
        val p = requireNotNull(recovery.preparation)
        val trust = MiningTaxClaimsSavedTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress,
            p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
        val daySec = fixture("mining-tax-journal-fixtures.json").getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long
        return MiningTaxClaimsOperation(MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), trust, daySec,
            true, p, emptyList(), emptyList(), false, setup = recovery.takeIf { it.status == "setup" },
            settlement = recovery.takeIf { it.status == "settled" })
    }
    private fun taxState(op: MiningTaxClaimsOperation, held: Boolean = false) = MiningTaxClaimsState(loaded = true,
        journal = MiningTaxClaimsJournal(1, StarterIdentity(identity.origin, identity.cluster, requireNotNull(op.preparation).wallet),
            1, op, null, emptyList(), held))

    @Test fun `display hints cannot become spend authority even when their reason is copied`() {
        val hint = MapActionHint("Review the original claim")
        assertEquals(CommandState.DISABLED, hint.copy(reason = "Receipt is available").state)
    }

    @Test fun `missing permit directory does not invent tiles seller quota or an enabled purchase`() {
        val ui = realmPermitDisplay(null, 0, null, null)
        assertEquals("1", ui.spotNumber)
        assertNull(ui.priceLamports); assertNull(ui.quotaLine); assertNull(ui.quoteTotalLamports)
        assertTrue(ui.primary.reason.contains("availability"))
    }

    @Test fun `permit policy display retains exact lamports and duration without inventing availability`() {
        val ui = realmPermitDisplay(RealmSalesState(loaded = true), Int.MAX_VALUE, 2, policy)
        assertEquals("2,147,483,648", ui.spotNumber)
        assertEquals("50000000", ui.priceLamports); assertEquals(604800L, ui.durationSeconds)
        assertNull(ui.quotaLine)
        assertTrue(ui.primary.reason.contains("availability"))
    }

    @Test fun `saved permit request survives a different displayed spot and has no replacement action`() {
        val op = RealmSalesOperation(RealmSalePrepareRequest(key, 4, 2), policy, true, null, false, null, false, false, null)
        val state = RealmSalesState(loaded = true, journal = RealmSalesJournal(1, identity, 1, op, null, emptyList(), false))
        val ui = realmPermitDisplay(state, 9, 3, policy)
        assertEquals(key, ui.recovery?.key); assertNull(ui.quoteTotalLamports); assertNull(ui.quotaLine)
        assertTrue(ui.primary.reason.contains("saved purchase"))
    }

    @Test fun `unknown materials do not become zero or ready shares`() {
        val ui = seekerMaterialsDisplay(null)
        assertTrue(ui.sourceUnavailable); assertTrue(ui.current.isEmpty()); assertTrue(ui.earlier.isEmpty())
        assertTrue(ui.primary.reason.contains("history is unavailable"))
    }

    @Test fun `resource identity includes material and page is not labelled current without term evidence`() {
        val ui = seekerMaterialsDisplay(materials(listOf(material(), material("frostglass"))))
        assertEquals(2, ui.earlier.map { it.id }.distinct().size)
        assertTrue(ui.current.isEmpty())
        assertTrue(ui.scopeLine.contains("page")); assertFalse(ui.scopeLine.contains("all", ignoreCase = true))
        assertTrue(ui.earlier.all { it.state == TermState.READY })
    }

    @Test fun `known current term totals stay exact per material and remain page scoped`() {
        val max = "9223372036854775807"
        val ui = seekerMaterialsDisplay(materials(listOf(material(due = max), material(due = max, spot = 1), material("frostglass", "2")), next = term), term)
        assertEquals(listOf("18,446,744,073,709,551,614", "2"), ui.current.map { it.amount })
        assertTrue(ui.earlier.first().sub.startsWith("9,223,372,036,854,775,807 Heartwood Beams"))
        assertTrue(ui.hasMore); assertTrue(ui.scopeLine.contains("page"))
        assertTrue(ui.primary.reason.contains("one share"))
    }

    @Test fun `large Shards amounts are grouped without passing through floating point`() {
        val row = SeekerShardsEntitlement(term, "a".repeat(64), "2026-09-21T00:00:00.000Z", "2026-09-28T00:00:00.000Z",
            0, 1, "9007199254740993", "9007199254740993", "0", "9007199254740993")
        val state = SeekerShardsClaimsState(SeekerShardsClaimJournal(1, identity, 0, null, emptyList()),
            SeekerShardsEntitlementView(1, identity.wallet, true, "SHARDS", "available", null, null, null, listOf(row)))
        val ui = seekerShardsDisplay(state, term)
        assertEquals("9,007,199,254,740,993", ui.current.single().amount)
        assertTrue(ui.earlier.single().sub.startsWith("9,007,199,254,740,993 Shards"))
    }

    @Test fun `fragment stock and shares arrive grouped while their original identities stay exact`() {
        val f = DivineFragmentFixtures
        val row = JsonObject(f.raw.fo("entitlement") + mapOf("poolTotal" to JsonPrimitive("9007199254740994"),
            "previousTotal" to JsonPrimitive("0"), "cumulativeTotal" to JsonPrimitive("4503599627370497"),
            "claimable" to JsonPrimitive("4503599627370497")))
        val state = DivineFragmentState(stock = buildJsonObject {
            put("version", 1); put("resourceId", "crystal_fragment"); put("wallet", f.wallet)
            put("baseId", f.base); put("available", "9007199254740993")
        }, claims = f.page(listOf(row)))
        val ui = divineFragmentsDisplay(state, f.base, true)
        assertEquals("9,007,199,254,740,993", ui.inKingdom)
        assertEquals("4,503,599,627,370,497", ui.waiting.single().ui.amount)
        assertEquals("share:" + row.ft("termId") + ":0", ui.waiting.single().key)
        assertNull(ui.totalWaiting)
    }

    @Test fun `attempted resource claim keeps original recovery and suppresses stale current amount`() {
        val row = material()
        val command = SeekerResourceClaimCommand(SeekerResourceClaimRequest(key, base, term, row.resourceId, 0), row.termHash, null)
        val state = materials(listOf(row)).let { it.copy(journal = it.journal.copy(operation = SeekerResourceClaimOperation(command, 1, null))) }
        val ui = seekerMaterialsDisplay(state, term)
        assertEquals(key, ui.recovery.single().key); assertEquals(TermState.CHECKING, ui.earlier.single().state)
        assertTrue(ui.current.isEmpty())
        assertTrue(ui.primary.reason.contains("saved claim"))
    }

    @Test fun `unavailable resource page retains saved request even though amounts are unknown`() {
        val row = material()
        val command = SeekerResourceClaimCommand(SeekerResourceClaimRequest(key, base, term, row.resourceId, 0), row.termHash, null)
        val state = materials(emptyList()).let { it.copy(view = it.view!!.copy(status = "unavailable", reason = "SOURCE_INTEGRITY"),
            journal = it.journal.copy(operation = SeekerResourceClaimOperation(command, 1, null))) }
        val ui = seekerMaterialsDisplay(state)
        assertTrue(ui.sourceUnavailable); assertEquals(key, ui.recovery.single().key); assertTrue(ui.earlier.isEmpty())
    }

    @Test fun `shards zero is shown only from a known row and is not ready`() {
        val row = SeekerShardsEntitlement(term, "a".repeat(64), "2026-09-21T00:00:00.000Z", "2026-09-28T00:00:00.000Z", 0, 1, "9", "9", "9", "0")
        val state = SeekerShardsClaimsState(SeekerShardsClaimJournal(1, identity, 0, null, emptyList()),
            SeekerShardsEntitlementView(1, identity.wallet, true, "SHARDS", "available", null, null, null, listOf(row)))
        val ui = seekerShardsDisplay(state, term)
        assertEquals("0", ui.current.single().amount); assertEquals(TermState.NONE, ui.earlier.single().state)
        assertFalse(ui.sourceUnavailable)
    }

    @Test fun `trial army allowance and cutoff come from retained policy without a preview hero`() {
        val state = trial(listOf(DivineTrialFixtures.complete))
        val ui = divineTrialsDisplay(state)
        val p = DivineTrialFixtures.rules.policy
        assertEquals(p.dobj("army").keys, ui.army.map { it.troop }.toSet())
        assertEquals(p.getValue("attemptsPerWallet").jsonPrimitive.int - 1, ui.triesLeft)
        assertEquals(p.getValue("divineSites").jsonPrimitive.int, ui.cutoff)
        assertNull(ui.hero); assertTrue(ui.army.all { it.portrait.isEmpty() })
    }

    @Test fun `missing trial participant does not invent remaining attempts`() {
        val ui = divineTrialsDisplay(trial(participant = false))
        assertNull(ui.triesLeft); assertNull(ui.best); assertNull(ui.replayAttemptId)
        assertTrue(ui.primary.reason.contains("Refresh trial participation"))
    }

    @Test fun `committed trial has recovery and never a completed score or replay`() {
        val ui = divineTrialsDisplay(trial(listOf(DivineTrialFixtures.committed)))
        assertNull(ui.best); assertNull(ui.replayAttemptId)
        assertEquals(DivineTrialFixtures.committed.dt("id"), ui.recovery.single().key)
    }

    @Test fun `completed trial exposes server result without inventing live rank or field size`() {
        val ui = divineTrialsDisplay(trial(listOf(DivineTrialFixtures.complete)))
        val result = DivineTrialFixtures.complete.dobj("result")
        assertEquals(result.getValue("stars").jsonPrimitive.int, ui.best?.stars)
        assertEquals(result.getValue("destruction").jsonPrimitive.content + "%", ui.best?.pct)
        assertEquals(UNKNOWN, ui.best?.rank); assertEquals(UNKNOWN, ui.best?.of)
        assertEquals(DivineTrialFixtures.complete.dt("id"), ui.replayAttemptId)
    }

    @Test fun `held trial evidence disables planner and remains visible for recovery`() {
        val state = trial(listOf(DivineTrialFixtures.admitted))
        val saved = state.selected!!.copy(held = listOf(DivineObservation(null, buildJsonObject {})))
        val ui = divineTrialsDisplay(state.copy(journal = state.journal!!.copy(events = listOf(saved))))
        assertNull(ui.planAttemptId); assertFalse(ui.recovery.isEmpty())
        assertTrue(ui.primary.reason.contains("original trial result"))
    }

    @Test fun `fragment stock belongs to the original selected kingdom only`() {
        val f = DivineFragmentFixtures
        val state = DivineFragmentState(stock = buildJsonObject { put("baseId", f.base); put("available", "17") }, available = true)
        assertEquals("17", divineFragmentsDisplay(state, f.base, true).inKingdom)
        assertEquals(UNKNOWN, divineFragmentsDisplay(state, "different", true).inKingdom)
        assertEquals(UNKNOWN, divineFragmentsDisplay(state, null, true).inKingdom)
    }

    @Test fun `fragment source uses settled net amount and excludes a delivered award`() {
        val f = DivineFragmentFixtures
        val ui = divineFragmentsDisplay(DivineFragmentState(awards = awardPage(), available = true), f.base, true)
        assertEquals(f.award.ft("net"), ui.waiting.single().ui.amount)
        assertEquals(FragmentSource.SOLO, ui.waiting.single().ui.kind)
        assertNull(ui.totalWaiting)
        assertTrue(divineFragmentsDisplay(DivineFragmentState(awards = awardPage(true)), f.base, true).waiting.isEmpty())
    }

    @Test fun `disabled fragment discovery cannot hide an uncertain saved delivery`() {
        val f = DivineFragmentFixtures
        val command = f.command().copy(sent = true)
        val state = DivineFragmentState(journal = DivineFragmentJournal(identity = f.identity(), commands = listOf(command)), awards = awardPage())
        val ui = divineFragmentsDisplay(state, f.base, false)
        assertFalse(ui.featureOff); assertEquals(command.key, ui.recovery.single().key)
        assertEquals(SourceState.NONE, ui.waiting.single().ui.state); assertNull(ui.waiting.single().ui.amount)
        assertTrue(ui.primary.reason.contains("saved original delivery"))
    }

    @Test fun `fragment shares retain term and spot identity and do not merge into an award`() {
        val f = DivineFragmentFixtures
        val row = f.raw.fo("entitlement")
        val state = DivineFragmentState(awards = awardPage(), claims = f.page(listOf(row)), available = true)
        val ui = divineFragmentsDisplay(state, f.base, true)
        assertEquals(2, ui.waiting.size); assertEquals(2, ui.waiting.map { it.key }.distinct().size)
        assertEquals(setOf(FragmentSource.SOLO, FragmentSource.SEEKER), ui.waiting.map { it.ui.kind }.toSet())
        assertNull(ui.totalWaiting)
    }

    @Test fun `unknown clan membership differs from confirmed absence and no closed trial is default selected`() {
        val unknown = divineSceneDoors(null, null, null, null, entered = true)
        val absent = divineSceneDoors(false, true, ClanMembership(null), null, entered = true)
        assertNull(unknown.selected); assertTrue(unknown.east.reason!!.contains("Checking"))
        assertTrue(absent.east.reason!!.contains("Join a clan")); assertNull(absent.selected)
        val open = divineSceneDoors(true, false, null, trial(), entered = true)
        assertEquals(DivineDoor.WEST, open.selected)
        assertEquals(DivineDoor.EAST, divineSceneDoors(true, false, null, trial(), picked = DivineDoor.EAST, entered = true).selected)
    }

    @Test fun `an accepted fragment receipt hides stale undelivered discovery`() {
        val f = DivineFragmentFixtures
        val command = f.command().let { it.copy(sent = true, receipt = f.receipt(it)) }
        val state = DivineFragmentState(journal = DivineFragmentJournal(identity = f.identity(), commands = listOf(command)), awards = awardPage())
        val ui = divineFragmentsDisplay(state, f.base, true)
        assertTrue(ui.waiting.isEmpty()); assertTrue(ui.recovery.isEmpty())
    }

    @Test fun `missing tax discovery cannot invent paid KEEP`() {
        val ui = realmCutDisplay(MiningTaxClaimsState(loaded = true))
        assertTrue(ui.discoveryUnavailable); assertNull(ui.proposedKeepBaseUnits); assertNull(ui.paidKeepBaseUnits)
        assertNull(ui.round)
        assertTrue(ui.primary.reason.contains("Round discovery is unavailable"))
    }

    @Test fun `the tax display preserves original caps so a later selection cannot change consent`() {
        val caps = MiningTaxClaimsCaps("21", "34", "55")
        val trust = MiningTaxClaimsSavedTrust(identity.wallet, identity.wallet, identity.wallet, identity.wallet, identity.wallet, 1, "b".repeat(64))
        val operation = MiningTaxClaimsOperation(MiningTaxClaimsPrepareRequest(key, "9", 4, caps), trust, 86400, true, null,
            emptyList(), emptyList(), false, null, null)
        val state = MiningTaxClaimsState(loaded = true, journal = MiningTaxClaimsJournal(1, identity, 1, operation, null, emptyList(), false))
        val ui = realmCutDisplay(state)
        assertEquals("9", ui.round); assertEquals("5", ui.spotNumber); assertEquals(key, ui.recovery?.key)
        assertEquals("21", ui.originalMaxFeeLamports); assertEquals("34", ui.originalMaxRentLamports)
        assertEquals("55", ui.originalMaxTotalLamports); assertNull(ui.paidKeepBaseUnits)
    }

    @Test fun `an accepted Seeker receipt hides only a stale page so later earnings remain visible`() {
        val f = DivineFragmentFixtures
        val command = f.command("claim").let { it.copy(sent = true, receipt = f.receipt(it)) }
        val row = f.raw.fo("entitlement")
        val state = DivineFragmentState(journal = DivineFragmentJournal(identity = f.identity(), commands = listOf(command)), claims = f.page(listOf(row)))
        assertTrue(divineFragmentsDisplay(state, f.base, true).waiting.isEmpty())
        val fresh = JsonObject(row + mapOf("previousTotal" to JsonPrimitive("5"), "cumulativeTotal" to JsonPrimitive("7"),
            "poolTotal" to JsonPrimitive("14"), "claimable" to JsonPrimitive("2")))
        val ui = divineFragmentsDisplay(state.copy(claims = f.page(listOf(fresh))), f.base, true)
        assertEquals("2", ui.waiting.single().ui.amount)
        assertEquals(SourceState.READY, ui.waiting.single().ui.state)
    }

    @Test fun `the highest accepted total applies only to its original term spot and term hash`() {
        val f = DivineFragmentFixtures
        val first = f.command("claim").let { it.copy(sent = true, receipt = f.receipt(it)) }
        val later = f.command("claim", f.id(8)).let { it.copy(sent = true,
            receipt = JsonObject(f.receipt(it) + mapOf("previousTotal" to JsonPrimitive("5"), "cumulativeTotal" to JsonPrimitive("8"),
                "poolTotal" to JsonPrimitive("16"), "quantity" to JsonPrimitive("3")))) }
        val row = JsonObject(f.raw.fo("entitlement") + mapOf("previousTotal" to JsonPrimitive("5"), "cumulativeTotal" to JsonPrimitive("8"),
            "poolTotal" to JsonPrimitive("16"), "claimable" to JsonPrimitive("3")))
        val state = DivineFragmentState(journal = DivineFragmentJournal(identity = f.identity(), commands = listOf(later, first)), claims = f.page(listOf(row)))
        assertTrue(divineFragmentsDisplay(state, f.base, true).waiting.isEmpty())
        for (different in listOf(JsonObject(row + ("spotId" to JsonPrimitive(1))),
            JsonObject(row + ("termId" to JsonPrimitive(f.id(99)))), JsonObject(row + ("termHash" to JsonPrimitive("c".repeat(64)))))) {
            assertEquals("3", divineFragmentsDisplay(state.copy(claims = f.page(listOf(different))), f.base, true).waiting.single().ui.amount)
        }
    }

    @Test fun `a saved committed submission prevents reopening a stale admitted attempt`() {
        val f = DivineTrialFixtures
        val state = trial(listOf(f.admitted))
        val command = DivineCommand(key, "submit", buildJsonObject { put("orders", f.complete.getValue("orders")) },
            f.admitted.dt("id"), sent = true, response = f.committed)
        val saved = state.selected!!.copy(commands = listOf(command))
        val ui = divineTrialsDisplay(state.copy(journal = state.journal!!.copy(events = listOf(saved))))
        assertNull(ui.planAttemptId); assertNull(ui.triesLeft); assertNull(ui.replayAttemptId)
        assertEquals(key, ui.recovery.single().key)
    }

    @Test fun `the saved permit quote appears only for its original spot and realm`() {
        val (state, savedPolicy) = permitFixture()
        val ui = realmPermitDisplay(state, 0, 0L, savedPolicy)
        assertEquals("12005000", ui.quoteTotalLamports)
        assertEquals("1 of 10 in the saved quote", ui.quotaLine)
        assertEquals(state.journal!!.operation!!.request.idempotencyKey, ui.recovery?.key)
        assertTrue(ui.primary.reason.contains("saved purchase"))
        for ((spot, realm) in listOf(1 to 0L, 0 to 1L, 0 to null)) {
            val changed = realmPermitDisplay(state, spot, realm, savedPolicy)
            assertNull(changed.quoteTotalLamports); assertNull(changed.quotaLine)
            assertEquals(ui.recovery?.key, changed.recovery?.key)
        }
    }

    @Test fun `only a finalized settled tax receipt exposes the exact paid KEEP base units`() {
        val op = taxOperation(taxRecovery())
        val ui = realmCutDisplay(taxState(op))
        assertEquals("3", ui.paidKeepBaseUnits)
        assertEquals(op.preparation!!.intended.claimBaseUnits, ui.proposedKeepBaseUnits)
        assertEquals("1000", ui.originalMaxRentLamports)
        assertEquals("1010", ui.originalMaxTotalLamports)
        assertEquals(op.request.idempotencyKey, ui.recovery?.key)
        assertTrue(ui.primary.reason.contains("original tax claim"))
    }

    @Test fun `setup alone cannot display KEEP as paid before the claim finalizes`() {
        val op = taxOperation(taxRecovery("setup"))
        val ui = realmCutDisplay(taxState(op))
        assertNull(ui.paidKeepBaseUnits)
        assertEquals(op.preparation!!.intended.claimBaseUnits, ui.proposedKeepBaseUnits)
        assertEquals(op.request.idempotencyKey, ui.recovery?.key)
        assertTrue(ui.phase!!.contains("KEEP PAYMENT PENDING"))
    }

    @Test fun `held or conflicting tax evidence hides paid amounts while retaining the original recovery`() {
        val recovery = taxRecovery()
        val op = taxOperation(recovery)
        val failure = MiningTaxClaimsFailureEnvelope.from(taxFailureFixture(recovery))
        val continuation = MiningTaxClaimsContinuationIntent(
            MiningTaxClaimsContinuationRequest("00000000-0000-4000-8000-000000000099", op.request.caps), true, null)
        // Overlay each observation independently so no earlier guard can make a later guard's assertion pass.
        val variants = listOf(taxState(op, held = true), taxState(op.copy(failureObserved = true)),
            taxState(op.copy(failure = failure)), taxState(op.copy(continuationObserved = true)),
            taxState(op.copy(continuation = continuation)), taxState(op.copy(unattributedObserved = true)))
        variants.forEach { state ->
            val ui = realmCutDisplay(state)
            assertNull(ui.paidKeepBaseUnits)
            assertEquals(op.request.idempotencyKey, ui.recovery?.key)
            assertEquals(op.preparation!!.intended.claimBaseUnits, ui.proposedKeepBaseUnits)
        }
    }

    @Test fun `a settled envelope cannot bypass final claim and receipt phase checks`() {
        val envelope = taxRecovery()
        val settlement = requireNotNull(envelope.settlement)
        val op = taxOperation(envelope)
        val variants = listOf(envelope.copy(status = "setup"),
            envelope.copy(settlement = settlement.copy(claimFinalized = false)),
            envelope.copy(settlement = settlement.copy(receipt = settlement.receipt.copy(phase = "setup"))))
        variants.forEach { observed ->
            val ui = realmCutDisplay(taxState(op.copy(settlement = observed)))
            assertNull(ui.paidKeepBaseUnits)
            assertEquals(op.request.idempotencyKey, ui.recovery?.key)
        }
    }

    @Test fun `completed and abandoned responses prevent a stale participant from reopening the planner`() {
        val f = DivineTrialFixtures
        val state = trial(listOf(f.admitted))
        val abandoned = JsonObject(f.admitted + mapOf("status" to JsonPrimitive("abandoned"), "completedAt" to f.complete.getValue("completedAt")))
        for ((kind, response) in listOf("submit" to f.complete, "abandon" to abandoned)) {
            val request = if (kind == "submit") buildJsonObject { put("orders", f.complete.getValue("orders")) } else buildJsonObject {}
            val command = DivineCommand(key, kind, request, f.admitted.dt("id"), sent = true, response = response)
            val saved = state.selected!!.copy(commands = listOf(command))
            val ui = divineTrialsDisplay(state.copy(journal = state.journal!!.copy(events = listOf(saved))))
            assertNull(ui.planAttemptId); assertNull(ui.triesLeft)
            assertEquals(key, ui.recovery.single().key)
        }
    }

    @Test fun `an admission missing from stale participation makes the remaining allowance unknown`() {
        val f = DivineTrialFixtures
        val state = trial()
        val admissionKey = f.admitted.dt("idempotencyKey")
        val command = DivineCommand(admissionKey, "attempts", buildJsonObject { put("baseId", f.base); put("idempotencyKey", admissionKey) },
            sent = true, response = f.admitted)
        val saved = state.selected!!.copy(commands = listOf(command))
        val ui = divineTrialsDisplay(state.copy(journal = state.journal!!.copy(events = listOf(saved))))
        assertNull(ui.triesLeft); assertNull(ui.planAttemptId)
        assertEquals(admissionKey, ui.recovery.single().key)
    }

    @Test fun `an older admission response must not hide a later completed participant attempt`() {
        val f = DivineTrialFixtures
        val state = trial(listOf(f.complete))
        val admissionKey = f.admitted.dt("idempotencyKey")
        val command = DivineCommand(admissionKey, "attempts", buildJsonObject { put("baseId", f.base); put("idempotencyKey", admissionKey) },
            sent = true, response = f.admitted)
        val saved = state.selected!!.copy(commands = listOf(command))
        val ui = divineTrialsDisplay(state.copy(journal = state.journal!!.copy(events = listOf(saved))))
        assertEquals(f.rules.policy.getValue("attemptsPerWallet").jsonPrimitive.int - 1, ui.triesLeft)
        assertEquals(f.complete.dt("id"), ui.replayAttemptId); assertTrue(ui.recovery.isEmpty())
    }
}
