package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.TrainingQuote
import gg.pixelkingdomwars.nativeclient.network.TrainingScheduling
import gg.pixelkingdomwars.nativeclient.network.trainingConfirmation
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyViewModel
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Screen view models against fake repositories: state transitions, error routing, consent flow. */
@OptIn(ExperimentalCoroutinesApi::class)
class ViewModelTests {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    private fun observer() = ReceiptObserver(PendingIntentStore(MemoryStore()))
    private val actions = InterruptedActions({}, {}, {})

    @Test fun `kingdom placement runs tap to tile to confirm through the base repository`() {
        val base = FakeBaseRepository(); base._state.value = BaseState(base = BaseSnapshot.from(baseJson()))
        val model = KingdomViewModel(base, FakeContentRepository(), observer(), actions, versionCode = 1)
        // A Home read re-reads mining too (web `useMineStatus` reloads on every base refresh): the cache day and the mine sheet stay current.
        assertEquals(listOf("refresh", "mine"), base.calls)
        model.startPlacement("mine"); model.pickTile(3.7f, 4.2f)
        assertEquals(3 to 4, model.state.value.placement!!.tile)
        model.confirmPlacement()
        assertEquals(listOf("refresh", "mine", "place:mine:3:4"), base.calls); assertNull(model.state.value.placement)
    }
    @Test fun `kingdom errors become a notice and a retired build blocks orders`() {
        val base = FakeBaseRepository(); base.failWith = IllegalStateException("Builders are busy")
        val model = KingdomViewModel(base, FakeContentRepository(), observer(), actions, versionCode = 1)
        model.collectMine()
        assertEquals("Builders are busy", model.notice.value!!.message); assertTrue(model.notice.value!!.error)
        val gated = KingdomViewModel(FakeBaseRepository(), FakeContentRepository(minimumBuild = 2), observer(), actions, versionCode = 1)
        assertFalse(gated.state.value.ordersAllowed)
        gated.upgrade("x")
        assertTrue(gated.notice.value!!.message.contains("update"))
    }
    @Test fun `a saved construction intent disables building until it is resolved`() {
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        store.create(PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "key-1-0000", "/base/buildings", json("""{"idempotencyKey":"key-1-0000"}"""), "Build mine", attempted = true))
        kotlinx.coroutines.runBlocking { observer.refresh(WALLET) }
        val model = KingdomViewModel(FakeBaseRepository(), FakeContentRepository(), observer, actions, versionCode = 1)
        assertTrue(model.state.value.constructionBlocked)
        assertEquals(IntentKind.CONSTRUCTION, model.state.value.interrupted.single().kind)
    }
    @Test fun `army quantities build the draft in order and the quote clears them once reviewed`() {
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(army = ArmyState.from(armyJson()))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        model.setQuantity("bowman", "2"); model.setQuantity("highlander", "1"); model.setQuantity("bowman", "3")
        assertEquals("""[{"troop":"bowman","count":3},{"troop":"highlander","count":1}]""", model.state.value.draft!!.composition().toString())
        model.setQuantity("bowman", "x"); assertEquals("3", model.state.value.quantities["bowman"])
        model.quote()
        assertEquals("""quote:[{"troop":"bowman","count":3},{"troop":"highlander","count":1}]""", army.calls.last())
        val quote = TrainingQuote.from(quoteJson())
        army._state.value = army._state.value.copy(reviewed = ReviewedQuote(model.state.value.draft!!, quote, trainingConfirmation(quote.raw, BASE_ID, "key-1-0000", TrainingScheduling.SEQUENTIAL), TrainingScheduling.SEQUENTIAL))
        assertTrue("The reviewed quote owns the intent", model.state.value.quantities.isEmpty()); assertFalse(model.state.value.composerEnabled)
        model.confirmTraining(); assertEquals("confirm", army.calls.last())
    }
    @Test fun `army consent flow surfaces repository failures and interrupted intents block the composer`() {
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(army = ArmyState.from(armyJson()))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(), observer, { WALLET }, { BASE_ID }, actions, versionCode = 1)
        army.failWith = IllegalStateException("Recover the interrupted training request before starting another batch.")
        model.setQuantity("bowman", "1"); model.quote()
        assertTrue(model.notice.value!!.message.contains("interrupted"))
        store.create(PendingIntent(IntentKind.TRAINING_BATCH, WALLET, BASE_ID, "key-1-0000", TrainingBatchSpec.PATH, json("""{"idempotencyKey":"key-1-0000"}"""), "Train army", attempted = true))
        kotlinx.coroutines.runBlocking { observer.refresh(WALLET) }
        assertTrue(model.state.value.trainingBlocked); assertFalse(model.state.value.composerEnabled)
    }
    @Test fun `a known short KEEP balance names the shortfall for the paid finish and an unknown balance never blocks`() {
        val army = FakeArmyRepository(); val base = FakeBaseRepository()
        val queue = """[{"id":"22222222-2222-4222-8222-222222222222","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z"}]"""
        army._state.value = ArmyDomainState(army = ArmyState.from(armyJson(queue = """[{"id":"22222222-2222-4222-8222-222222222222","troop":"bowman"}]""", finishAllQueue = queue, maxCostKeep = "3")))
        val model = ArmyViewModel(army, base, FakeContentRepository(), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        assertNull("No balance known: the server decides", model.state.value.finishShortfall)
        base._state.value = BaseState(balances = gg.pixelkingdomwars.nativeclient.model.Balances(shards = "3130", keep = "0"))
        assertEquals("NEED 3 KEEP · HAVE 0", model.state.value.finishShortfall)
        base._state.value = BaseState(balances = gg.pixelkingdomwars.nativeclient.model.Balances(shards = "3130", keep = "3.5"))
        assertNull(model.state.value.finishShortfall)
    }
    @Test fun `finish all and cancellation delegate with the chosen row and free flag`() {
        val army = FakeArmyRepository()
        val queued = armyJson(queue = """[{"id":"22222222-2222-4222-8222-222222222222","troop":"bowman","canCancel":true,"refundShards":"10"}]""")
        army._state.value = ArmyDomainState(army = ArmyState.from(queued))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        val choice = requireNotNull(model.state.value.cancellation(model.state.value.domain.army!!.queue.single()))
        model.cancelQueued(choice); model.finishAll(free = true)
        assertEquals(listOf("army", "cancel:22222222-2222-4222-8222-222222222222", "finishAll:true"), army.calls)
    }
    @Test fun `attack refreshes campaign and history and routes stage attacks and replays`() {
        val battle = FakeBattleRepository()
        val model = AttackViewModel(battle)
        model.attack(3); model.openReplay("6b993df1-1af2-41b4-9a65-638428c388a3")
        assertEquals(listOf("campaign", "history", "attack:3", "replay:6b993df1-1af2-41b4-9a65-638428c388a3"), battle.calls)
    }
    @Test fun `the raid chooser sends the automatic match and history rows send revenge continue watch and the row's own replay route`() {
        val battle = FakeBattleRepository()
        val model = AttackViewModel(battle)
        model.openChooser(); assertTrue(model.chooser.value)
        model.autoMatch(); assertFalse("The chooser closes as the create starts", model.chooser.value)
        val defence = gg.pixelkingdomwars.nativeclient.model.BattleRecord("6b993df1-1af2-41b4-9a65-638428c388a3", BASE_ID, "defender", "pvp", result = "defeat",
            opponent = gg.pixelkingdomwars.nativeclient.model.BattleOpponent("deed-9", "AttackerWallet", "Kane"), replayAccess = "deed")
        model.revenge(defence); model.revenge(defence.copy(role = "attacker"))
        model.openReplay(defence.copy(replayAccess = "participant"))
        model.resume(gg.pixelkingdomwars.nativeclient.model.PendingMarch("c0ffee00-1af2-41b4-9a65-638428c388a3"))
        model.watchLive("6b993df1-1af2-41b4-9a65-638428c388a3", BASE_ID)
        assertEquals(listOf("campaign", "history", "pvp:-:-:-", "pvp:AttackerWallet:deed-9:-", "replay:/battles/participated/6b993df1-1af2-41b4-9a65-638428c388a3/replay",
            "resume:c0ffee00-1af2-41b4-9a65-638428c388a3", "watch:6b993df1-1af2-41b4-9a65-638428c388a3:$BASE_ID"), battle.calls)
        assertEquals("The chooser request retains the Kingdom scene", gg.pixelkingdomwars.nativeclient.ui.home.HomeTab.KINGDOM, gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest.RaidChooser.homeTab)
    }
    @Test fun `battle boards refresh when the selected deed changes without replacing the account session`() {
        val battle = FakeBattleRepository(); val account = FakeAccountRepository()
        val model = AttackViewModel(battle, account)
        account._state.value = account._state.value.copy(selectedBaseId = "c0ffee00-1af2-41b4-9a65-638428c388a3")
        assertEquals(listOf("campaign", "history", "campaign", "history"), battle.calls)
        assertNull(model.notice.value)
    }
    @Test fun `a known raid lock refuses kingdom orders in production's words and an unknown lock only disables`() {
        val base = FakeBaseRepository()
        val locked = kotlinx.coroutines.flow.MutableStateFlow(gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid("6b993df1-1af2-41b4-9a65-638428c388a3", "live"), known = true))
        val model = KingdomViewModel(base, FakeContentRepository(), observer(), actions, versionCode = 1, deedInterlock = locked)
        model.collectMine()
        assertEquals(Copy.ACTIVE_RAID_MESSAGE, model.notice.value!!.message); assertFalse(model.state.value.deedActionsAllowed); assertTrue("The raid lock permits read-only base and mining refreshes", base.calls.all { it == "refresh" || it == "mine" })
        locked.value = gg.pixelkingdomwars.nativeclient.network.RaidInterlockState()
        assertFalse("Unknown until a canonical read: buttons stay off, nothing is refused with a message", model.state.value.deedActionsAllowed)
        locked.value = gg.pixelkingdomwars.nativeclient.network.RaidInterlockState(null, known = true)
        assertTrue(model.state.value.deedActionsAllowed)
        model.collectMine(); assertEquals("Only the unlocked tap may mutate the base", listOf("collect"), base.calls.filterNot { it == "refresh" || it == "mine" })
    }
    @Test fun `the bases screen opens a deed through the account selection and activates only with base-scoped mutations`() {
        val account = FakeAccountRepository(); val base = FakeBaseRepository()
        val directory = """{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"nextLandPurchaseKind":"deed","capabilities":{"baseScopedReads":true,"baseScopedMutations":%s,"cellReservations":true},"bases":[{"id":"$BASE_ID","status":"active","keepLevel":2,"slot":1},{"id":"11111111-1111-4111-8111-111111111111","status":"inactive","keepLevel":1,"slot":null}]}"""
        account._state.value = account._state.value.copy(directory = gg.pixelkingdomwars.nativeclient.model.BaseDirectory.from(json(directory.format("false"))))
        val model = gg.pixelkingdomwars.nativeclient.ui.more.BasesViewModel(account, base, FakeContentRepository())
        assertEquals(listOf("directory"), account.calls)
        model.open("11111111-1111-4111-8111-111111111111")
        assertEquals(listOf("directory", "select:11111111-1111-4111-8111-111111111111"), account.calls); assertEquals(listOf("refresh"), base.calls)
        model.activate("11111111-1111-4111-8111-111111111111")
        assertEquals("Read-only capabilities lock activation before any POST", Copy.ACTIVATION_LOCKED, model.notice.value!!.message)
        account._state.value = account._state.value.copy(directory = gg.pixelkingdomwars.nativeclient.model.BaseDirectory.from(json(directory.format("true"))))
        model.setReplace(BASE_ID); model.activate("11111111-1111-4111-8111-111111111111")
        assertEquals("activate:11111111-1111-4111-8111-111111111111:$BASE_ID", account.calls.last()); assertNull(model.state.value.replaceBaseId)
    }
    @Test fun `the land picker lists a realm's purchasable tiles, marks settled ones and drafts only an available tile`() {
        val land = FakeLandRepository(); val world = FakeWorldRepository(); val account = FakeAccountRepository()
        world._state.value = WorldState(globe = gg.pixelkingdomwars.nativeclient.model.FantasyGlobe.from(json("""{"worldId":"fantasy-v1","catalogHash":"c","ready":true,
            "realms":[{"realmId":"frostveil","total":9,"occupied":1,"held":0,"available":8,"anchorTileId":7},{"realmId":"seeker-reach","total":3,"occupied":0,"held":0,"available":0}]}""")))
        world.occupied = setOf(7); world.parcels[8] = "held"
        val catalog = FantasyCatalog.parse(json("""{"membershipSha256":"c147","regions":[{"id":"frostveil","runs":[[0,8]]},{"id":"seeker-reach","runs":[[9,11]]}],"genesisRuns":[[9,9]],"seekerRuns":[[10,11]]}"""), 6, 4)
        val model = gg.pixelkingdomwars.nativeclient.ui.land.LandViewModel(land, world, account, FakeBaseRepository(), observer(), FakeContentRepository(), { catalog }, actions) { after -> after() }
        model.open("entry")
        assertEquals(listOf("open:entry"), land.calls); assertTrue("A loaded globe is not re-read on open", world.calls.isEmpty())
        model.refreshWorld(); assertEquals(listOf("globe"), world.calls)
        model.pickRealm("frostveil")
        val picker = model.state.value.picker
        assertEquals("Candidates start one row above the realm anchor", listOf(1, 2, 3, 4, 5, 6, 7, 8), picker.tiles.map { it.tileId })
        assertTrue(picker.tiles.single { it.tileId == 7 }.occupied); assertEquals("One viewport read spans the candidates (x 0..5, y 0..1)", "markers:0,0,5,1", world.calls.last())
        model.inspectTile(8)
        assertEquals("held", model.state.value.picker.tiles.single { it.tileId == 8 }.availability); assertEquals("draft:null", land.calls.last()); assertTrue(model.notice.value!!.error)
        model.inspectTile(3)
        assertEquals("draft:3", land.calls.last()); assertEquals(3, model.state.value.checkout.draftedTile)
        model.reserveDrafted(); assertEquals("reserve:3", land.calls.last())
        model.clearRealm(); assertNull(model.state.value.picker.realmId); assertEquals("draft:null", land.calls.last())
        model.reserveRandom(); assertEquals("reserve:null", land.calls.last())
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.land.LandStage.PICK, model.state.value.stage)
    }
    @Test fun `entering the game after a credit re-reads identity, directory and Home from the server first`() {
        val land = FakeLandRepository(); val account = FakeAccountRepository(); val base = FakeBaseRepository()
        val model = gg.pixelkingdomwars.nativeclient.ui.land.LandViewModel(land, FakeWorldRepository(), account, base, observer(), FakeContentRepository(), { null }, actions) { after -> after() }
        var entered = 0
        model.enterGame { entered++ }
        assertEquals(listOf("identity", "directory"), account.calls); assertEquals(listOf("refresh"), base.calls); assertEquals(1, entered)
        land._state.value = LandCheckoutState(phase = LandPhase.CREDITED, reservation = gg.pixelkingdomwars.nativeclient.model.LandDeposit(id = "d", baseId = BASE_ID))
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.land.LandStage.MINTING, model.state.value.stage); assertTrue(model.state.value.paymentCredited)
        var signedOut = 0
        model.signOut { signedOut++ }; assertEquals(1, signedOut)
    }
    @Test fun `a superseded session ends an action silently and a plain failure is shown once`() {
        val base = FakeBaseRepository()
        val model = KingdomViewModel(base, FakeContentRepository(), observer(), actions, versionCode = 1)
        base.failWith = gg.pixelkingdomwars.nativeclient.network.SessionSupersededException()
        model.collectMine(); assertNull(model.notice.value)
        base.failWith = java.io.IOException("Connection reset")
        model.collectMine(); assertEquals("Connection reset", model.notice.value!!.message)
        model.dismissNotice(); assertNull(model.notice.value)
    }

    private val composerCatalogue = json("""{"display":{"research":{"troops":["highlander","bowman","gloamfang"]}},"constants":{"TROOPS":{"highlander":{"pts":2,"costKeep":12,"hp":120,"dps":18,"speedTilesPerSec":1.2,"range":"melee"},"bowman":{"pts":1,"costKeep":10,"hp":45,"dps":14,"speedTilesPerSec":1.4,"range":3.5},"gloamfang":{"pts":10,"costKeep":80,"hp":1,"dps":1,"speedTilesPerSec":1,"range":"melee"}},
        "TROOP_LEVELING":{"statMultPerLevel":1.2,"maxLevel":20},"ELITE_TROOP_UNLOCKS":{"itemByTroop":{"gloamfang":"item_troop_gloamfang"}},"ITEMS":{"item_troop_gloamfang":{"costKeep":0,"acquisition":{"type":"drop"}}},"DARK_ATTACKER_TROOPS":["gloamfang"],
        "ECONOMY":{"speedupKeepPer30Sec":2,"speedupGranularitySec":30,"speedupQuadraticSoftUnits":9000},"TRAINING_PRESETS":{"slots":3,"nameMaxLength":32,"maxCompositionUnits":3}}}""")
    @Test fun `taps add units only inside both capacities the selection limit and the writ gate`() {
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(army = ArmyState.from(armyJson()))  // 10 highlanders = 20/20 camp pts, queue 0/10
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(composerCatalogue), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        assertEquals(listOf("highlander", "bowman", "gloamfang"), model.state.value.trainTable)
        model.selectOne("bowman")
        assertEquals("A full camp takes nothing", emptyMap<String, String>(), model.state.value.quantities); assertEquals(gg.pixelkingdomwars.nativeclient.ui.army.CapacityReason.ARMY, model.state.value.capacityReason("bowman"))
        army._state.value = ArmyDomainState(army = ArmyState.from(json(armyJson().toString().replace("\"rosterPts\":20", "\"rosterPts\":10"))))
        model.selectOne("bowman"); model.selectOne("bowman"); model.selectOne("highlander")
        assertEquals(mapOf("bowman" to "2", "highlander" to "1"), model.state.value.quantities); assertEquals(4, model.state.value.room!!.draftPts)
        model.selectOne("bowman")
        assertEquals("TRAINING_PRESETS.maxCompositionUnits caps the draft", "2", model.state.value.quantities["bowman"]); assertEquals(gg.pixelkingdomwars.nativeclient.ui.army.CapacityReason.SELECTION, model.state.value.capacityReason("bowman"))
        model.selectOne("gloamfang")
        assertNull("A writ-gated troop never enters the draft", model.state.value.quantities["gloamfang"]); assertTrue(model.state.value.unlock("gloamfang").locked); assertTrue(model.state.value.rollout("gloamfang").locked)
        model.selectOne("bowman", -1); model.selectOne("bowman", -1); model.selectOne("bowman", -1)
        assertNull("−1 removes the row at zero and never goes negative", model.state.value.quantities["bowman"])
    }
    @Test fun `tap-tap-tap cancellation resolves distinct latest-finishing rows serially and sums one burst notice`() {
        val army = FakeArmyRepository()
        val queue = """[{"id":"11111111-1111-4111-8111-111111111111","troop":"bowman","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z","canCancel":true,"refundShards":"10"},
            {"id":"22222222-2222-4222-8222-222222222222","troop":"bowman","startedAt":"2026-09-11T00:00:09Z","finishesAt":"2026-09-11T00:00:18Z","canCancel":true,"refundShards":"10"},
            {"id":"33333333-3333-4333-8333-333333333333","troop":"highlander","startedAt":"2026-09-11T00:00:18Z","finishesAt":"2026-09-11T00:00:30Z","canCancel":true,"refundShards":"12"}]"""
        army._state.value = ArmyDomainState(army = ArmyState.from(armyJson(queue = queue)))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(composerCatalogue), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        army.gate = kotlinx.coroutines.CompletableDeferred()
        model.cancelOne("bowman"); model.cancelOne("bowman"); model.cancelOne("bowman"); model.cancelOne("highlander")
        assertEquals("Three taps decrement at once; the fourth bowman tap is a no-op", setOf("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"), model.state.value.pendingCancelIds)
        assertEquals("Only the first POST is in flight while the chain is held", listOf("army"), army.calls)
        army.gate!!.complete(Unit)
        assertEquals("Latest-finishing first, each id once", listOf("army", "cancel:22222222-2222-4222-8222-222222222222", "cancel:11111111-1111-4111-8111-111111111111", "cancel:33333333-3333-4333-8333-333333333333"), army.calls)
        // Owner 2026-09-17: a cancel confirmation is a transient toast, never a notice that sits on the screen.
        assertEquals("3 TROOPS CANCELLED · +32 SHARDS", Toasts.queue.items.value.last().message); assertFalse(Toasts.queue.items.value.last().error)
        assertNull("The burst leaves no persistent notice behind", model.notice.value)
        army._state.value = ArmyDomainState(army = ArmyState.from(armyJson()))
        assertTrue("Fresh /army data retires the pending ids", model.state.value.pendingCancelIds.isEmpty())
    }
    @Test fun `a refused cancel rolls only its own tap back and the burst names one troop`() {
        val army = FakeArmyRepository()
        val queue = """[{"id":"11111111-1111-4111-8111-111111111111","troop":"bowman","finishesAt":"2026-09-11T00:00:09Z","canCancel":true,"refundShards":"10"},{"id":"22222222-2222-4222-8222-222222222222","troop":"bowman","finishesAt":"2026-09-11T00:00:18Z","canCancel":true,"refundShards":"10"}]"""
        army._state.value = ArmyDomainState(army = ArmyState.from(armyJson(queue = queue)))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(composerCatalogue), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        army.onCall = { if (it == "cancel:22222222-2222-4222-8222-222222222222") throw IllegalStateException("training already finished or was cancelled") }
        army.gate = kotlinx.coroutines.CompletableDeferred()
        model.cancelOne("bowman"); model.cancelOne("bowman")
        army.gate!!.complete(Unit)
        assertEquals(setOf("11111111-1111-4111-8111-111111111111"), model.state.value.pendingCancelIds)
        assertEquals("1 BOWMAN CANCELLED · +10 SHARDS", Toasts.queue.items.value.last().message)
    }
    @Test fun `legacy live price remains displayable but cannot bypass exact paid training review`() {
        val army = FakeArmyRepository(); val base = FakeBaseRepository()
        val queue = """[{"id":"22222222-2222-4222-8222-222222222222","troop":"bowman","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z"}]"""
        army._state.value = ArmyDomainState(army = ArmyState.from(armyJson(queue = queue, finishAllQueue = queue, maxCostKeep = "3")))
        val model = ArmyViewModel(army, base, FakeContentRepository(composerCatalogue), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        val now = java.time.Instant.parse("2026-09-11T00:00:00Z").toEpochMilli()
        assertEquals("3", model.state.value.liveFinishCost(now)!!.toString()); assertNull(model.state.value.liveFinishCost(now)?.let { model.state.value.shortfall(it.toString()) })
        base._state.value = BaseState(balances = gg.pixelkingdomwars.nativeclient.model.Balances(shards = "1", keep = "2"))
        assertEquals("NEED 3 KEEP · HAVE 2", model.state.value.shortfall("3"))
        model.finishAll(free = false, displayedCostKeep = "3")
        assertTrue(army.calls.none { it.startsWith("finishAll:") })
        assertEquals("Review the exact training currency before paying.", model.notice.value?.message)
        assertNull("No coefficients: no live price, the ceiling still applies", ArmyViewModel(army, base, FakeContentRepository(), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1).state.value.liveFinishCost(now))
    }
    @Test fun `the saved-army editor keeps order edits local and saves a plan through the repository`() {
        val army = FakeArmyRepository(); army._state.value = ArmyDomainState(army = ArmyState.from(armyJson()), presets = listOf(gg.pixelkingdomwars.nativeclient.model.TrainingPreset(2, "RAID", listOf(gg.pixelkingdomwars.nativeclient.model.TroopCount("bowman", 5)))))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(composerCatalogue), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        model.togglePresets(); assertTrue(model.state.value.presetsOpen); assertFalse("Presets already loaded are not re-read", army.calls.contains("presets"))
        model.editPreset(1); assertEquals(gg.pixelkingdomwars.nativeclient.ui.army.PresetDraft(1, "ARMY 1", emptyList(), existing = false), model.state.value.presetDraft)
        model.addRow("bowman"); model.addRow("highlander"); model.addRow("bowman"); model.editCount(0, 4); model.moveRow(0, 1); model.editName("OPENER")
        assertEquals(listOf(gg.pixelkingdomwars.nativeclient.model.TroopCount("highlander", 1), gg.pixelkingdomwars.nativeclient.model.TroopCount("bowman", 4)), model.state.value.presetDraft!!.composition)
        model.removeRow(0); model.savePreset()
        assertEquals("savePreset:1:OPENER:bowman=4", army.calls.last()); assertNull(model.state.value.presetDraft)
        model.previewPreset(2); assertEquals("quote:[{\"troop\":\"bowman\",\"count\":5}]:plan", army.calls.last())
        model.retrainPrevious(); assertEquals("previous", army.calls.last())
        model.editPreset(2); assertTrue(model.state.value.presetDraft!!.existing); model.deletePreset(); assertEquals("deletePreset:2", army.calls.last())
    }
    @Test fun `a research completion observed in the army read is announced once`() {
        val army = FakeArmyRepository()
        army._state.value = ArmyDomainState(army = ArmyState.from(json(armyJson().toString().replace("\"research\":[]", "\"research\":[{\"troop\":\"bowman\",\"toLevel\":2,\"finishesAt\":\"2026-09-11T00:00:09Z\"}]"))))
        val model = ArmyViewModel(army, FakeBaseRepository(), FakeContentRepository(composerCatalogue), observer(), { WALLET }, { BASE_ID }, actions, versionCode = 1)
        val before = Toasts.queue.items.value.size
        army._state.value = ArmyDomainState(army = ArmyState.from(json(armyJson().toString().replace("\"bowman\":1", "\"bowman\":2"))))
        // Owner 2026-09-17: the completion is announced as a transient toast, so it cannot get stuck on the screen.
        assertEquals("BOWMAN L2 RESEARCHED", Toasts.queue.items.value.last().message)
        assertTrue("The toast queue holds it, not the screen notice", Toasts.queue.items.value.size > before || Toasts.queue.items.value.size == Toasts.queue.maxVisible); assertNull(model.notice.value)
    }
}
