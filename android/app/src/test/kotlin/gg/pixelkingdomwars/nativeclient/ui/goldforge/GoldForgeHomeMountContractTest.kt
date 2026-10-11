package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BalanceFeatures
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.GemsFeature
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.home.*
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import org.junit.Assert.*
import org.junit.Test

/** Authored before mount implementation. Cedar3 alone executes this contract. */
class GoldForgeHomeMountContractTest {
    private val identity = HomeRouteIdentity(Any(), "base-1", 7)

    @Test fun `read may begin only for admitted current owner`() {
        val gate = GoldForgeHomeReadGate(identity)
        assertNull(gate.begin(null, true))
        assertNull(gate.begin(identity, false))
        assertNotNull(gate.begin(identity, true))
    }

    @Test fun `late read cannot publish into replaced session base or ABA generation`() {
        val gate = GoldForgeHomeReadGate(identity)
        val ticket = requireNotNull(gate.begin(identity, true))
        assertTrue(gate.accepts(ticket, identity, true))
        for (current in listOf(null, identity.copy(session = Any()), identity.copy(baseId = "base-2"),
            identity.copy(baseSelectionGeneration = 8))) assertFalse(gate.accepts(ticket, current, true))
        assertFalse(gate.accepts(ticket, identity, false))
    }

    @Test fun `a newer refresh supersedes an older read even within same kingdom`() {
        val gate = GoldForgeHomeReadGate(identity)
        val first = requireNotNull(gate.begin(identity, true))
        val second = requireNotNull(gate.begin(identity, true))
        assertFalse(gate.accepts(first, identity, true))
        assertTrue(gate.accepts(second, identity, true))
    }

    @Test fun `disposed host cannot begin or publish reads`() {
        val gate = GoldForgeHomeReadGate(identity)
        val ticket = requireNotNull(gate.begin(identity, true))
        gate.close()
        assertFalse(gate.accepts(ticket, identity, true))
        assertNull(gate.begin(identity, true))
    }

    // Rewritten for Gold Forge v2 (A4): LEGACY is now a mounted Home tab, so it restores like the other three; an unknown tab still does not.
    @Test fun `only mounted Gold Forge tabs restore in the tall host`() {
        for (tab in listOf(null, "SMELT", "CLAIM", "GEMS", "LEGACY")) {
            val frame = mountedHomeSheetFrame(SheetEntry(Destination.GoldForge(tab)))
            assertNotNull(frame)
            assertEquals(SheetSize.TALL, frame!!.size)
        }
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.GoldForge("missing"))))
        assertNotNull(mountedHomeSheetFrame(SheetEntry(Destination.GoldForge("SMELT"), selectedTab = "LEGACY")))
    }

    // Rewritten for Gold Forge v2 (A4): goldforge.legacy joined the FORGE entry; ids outside the five still throw.
    @Test fun `Forge aggregate entry accepts all five Gold Forge ids and rejects other groups`() {
        val ids = listOf("goldforge.open", "goldforge.smelt", "goldforge.claim", "goldforge.gems", "goldforge.legacy")
        for (id in ids) assertEquals(id, gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest.Open(
            gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(id), identity,
            gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection(),
            entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.FORGE).featureId.value)
        for (id in listOf("goldforge.missing", "build.supplies", "harvester.harvest")) {
            assertThrows(IllegalArgumentException::class.java) { gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest.Open(
                gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(id), identity,
                gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection(),
                entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.FORGE) }
        }
    }

    @Test fun `Forge aggregate cannot broaden into World or a resource drawer`() {
        val id = gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.open")
        val selection = gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection()
        assertThrows(IllegalArgumentException::class.java) { gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest.Open(
            id, identity, selection, hostTab = gg.pixelkingdomwars.nativeclient.ui.home.HomeTab.WORLD,
            entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.FORGE) }
        assertThrows(IllegalArgumentException::class.java) { gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest.Open(
            id, identity, selection, resources = Destination.Resources(),
            entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.FORGE) }
    }

    @Test fun `Forge HUD uses exact supplied wallet rows and clears other chrome`() {
        val home = gg.pixelkingdomwars.nativeclient.ui.home.homeHudState(
            gg.pixelkingdomwars.nativeclient.data.BaseState(balances = gg.pixelkingdomwars.nativeclient.model.Balances("17", "999999")),
            null, 0, true, 0, 0, selectionOpen = false, toolsOpen = true)
        val rows = goldForgeHomeUi(GoldForgeHomeData(identity, "wallet"), identity).sheet.stack
        val projected = goldForgeHomeHud(home, rows, true)
        assertSame(rows, projected.resources)
        assertEquals(listOf("Gems", "Wallet KEEP"), projected.resources.map { it.name })
        assertEquals(listOf("…", "…"), projected.resources.map { it.value })
        assertFalse(projected.deckVisible); assertFalse(projected.toolsOpen)
        assertNull(projected.herald); assertNull(projected.context)
        assertSame(home, goldForgeHomeHud(home, null, false))
    }

    // da6ceb38 MAJOR-1/MINOR-5: canonical registry and the real mounted host must agree with each drawn door.
    @Test fun `completed Gold Forge door navigates through canonical registry and mounted host`() {
        val f = ForgeDoorFixture()
        assertTrue(f.dispatcher.handleFeatureDoor(FeatureId("goldforge.open")))
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.GoldForge()), f.opened)
        assertNull(f.requests.pending.value)
        assertTrue(f.reasons.isEmpty())
    }

    @Test fun `rendered Gems GO resolves from the same supported balance fact and never disappears silently`() {
        val f = ForgeDoorFixture(GemsFeature(version = 1, receipts = 1))
        val gems = homeResourceDrawer(f.home, "gems").groups.flatMap { it.rows }.single { it.id == "gems" }
        val go = requireNotNull(gems.earnedAtFeature)
        assertEquals(FeatureId("goldforge.gems"), go)
        assertEquals(GateFact.Allowed, f.gemsFact())
        assertTrue(f.dispatcher.handleFeatureDoor(go))
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.GoldForge("GEMS")), f.opened)
        assertNull(f.requests.pending.value)
        assertTrue(f.reasons.isEmpty())
    }

    @Test fun `unsupported or absent Gems protocol renders no Gems GO and supplies no invented allowed fact`() {
        for (feature in listOf(null, GemsFeature(version = 2, receipts = 1), GemsFeature(version = 1, receipts = 2))) {
            val f = ForgeDoorFixture(feature)
            val rows = homeResourceDrawer(f.home, null,
                wallet = gg.pixelkingdomwars.nativeclient.model.WalletFunds(null, mapOf("KEEP" to "7"), 1L),
                walletLinked = true).groups.flatMap { it.rows }
            assertTrue(rows.none { it.id == "gems" || it.earnedAtFeature == FeatureId("goldforge.gems") })
            assertEquals(GateFact.Unknown, f.gemsFact())
            // The still-visible KEEP row has a working aggregate door; this does not claim that a hidden Gems GO was drawn.
            val go = requireNotNull(rows.single { it.id == "keep" }.earnedAtFeature)
            assertTrue(f.dispatcher.handleFeatureDoor(go))
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.requests.pending.value as HomeRequest.Open))
            assertEquals(listOf(Destination.GoldForge()), f.opened)
        }
    }

    @Test fun `rendered Gems GO preserves its queued outcome while admission is held and opens once released`() {
        val f = ForgeDoorFixture(GemsFeature(version = 1, receipts = 1))
        val go = requireNotNull(homeResourceDrawer(f.home, "gems").groups.flatMap { it.rows }
            .single { it.id == "gems" }.earnedAtFeature)
        assertTrue(f.dispatcher.handleFeatureDoor(go))
        val request = f.requests.pending.value as HomeRequest.Open
        f.blocked = true
        f.mount.reportBlocked(false)
        assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
        assertSame(request, f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
        f.blocked = false
        f.mount.reportBlocked(false)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.GoldForge("GEMS")), f.opened)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.opened.size)
    }

    @Test fun `Gold Forge requests captured before session base or generation replacement cannot navigate`() {
        for (replacement in listOf("session", "base", "generation", "missing")) {
            val f = ForgeDoorFixture(GemsFeature(version = 1, receipts = 1))
            assertTrue(f.dispatcher.handleFeatureDoor(FeatureId("goldforge.gems")))
            val request = f.requests.pending.value as HomeRequest.Open
            f.current = when (replacement) {
                "session" -> f.identity.copy(session = Any())
                "base" -> f.identity.copy(baseId = "other")
                "generation" -> f.identity.copy(baseSelectionGeneration = 2)
                else -> null
            }
            assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
            assertNull(f.requests.pending.value)
            assertTrue(f.opened.isEmpty())
        }
    }

    @Test fun `a Gold Forge click without a current kingdom is visibly refused and never queued`() {
        val f = ForgeDoorFixture()
        f.current = null
        assertTrue(f.dispatcher.handleFeatureDoor(FeatureId("goldforge.open")))
        assertNull(f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
        assertEquals(listOf("This feature is waiting for your kingdom to finish loading."), f.reasons)
    }

    @Test fun `an incomplete Gold Forge explains its canonical lock instead of consuming a drawn aggregate silently`() {
        val f = ForgeDoorFixture()
        f.completed = false
        assertTrue(f.dispatcher.handleFeatureDoor(FeatureId("goldforge.open")))
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertNull(f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
        assertEquals(1, f.reasons.size)
        assertTrue(f.reasons.single().isNotBlank())
    }

    // The source pin connects the real navigation fixture to the narrowly granted PkwApp observation, not a test-only gate.
    @Test fun `PkwApp supplies the actual supported Gems balance fact used to draw the GO`() {
        val observed = pkwSource().substringAfter("val observedFeatures = mapOf(").substringBefore("val gates = it.gates")
        val compact = observed.replace(Regex("\\s+"), "")
        assertTrue(compact.contains("\"gems\"toif(session.base.state.value.balances?.features?.gems?.supported==true)"))
        val gems = compact.substringAfter("\"gems\"toif(")
        assertTrue(gems.contains("GateFact.Allowed"))
        assertTrue(gems.contains("elsegg.pixelkingdomwars.nativeclient.ui.features.GateFact.Unknown") ||
            gems.contains("elseGateFact.Unknown"))
    }

    @Test fun `ForgeRoute fallback replaces its old back stack while returning the typed request to Home`() {
        val bridge = pkwSource().substringAfter("composable<ForgeRoute>").substringBefore("composable<")
        val compact = bridge.replace(Regex("\\s+"), "")
        assertTrue(compact.contains("HomeRequestEntry.FORGE"))
        assertTrue(compact.contains("popBackStack<HomeRoute>(inclusive=false)"))
        val fallback = compact.substringAfter("navigate(HomeRoute)")
        assertTrue(fallback.contains("popUpTo(0){inclusive=true}"))
        assertTrue(fallback.contains("launchSingleTop=true"))
    }

    // Rewritten for Gold Forge v2 (A4): SMELT controls now open the contribution owner's route, not the Economy alias.
    @Test fun `each Gold Forge controls door hands off to its existing route without reopening the display bridge`() {
        val body = pkwSource().replace("gg.pixelkingdomwars.nativeclient.ui.goldforge.", "")
            .substringAfter("GoldForgeHomeNotice(goldForgeNotice,").substringBefore("is Destination.Leagues ->")
        val compact = body.replace(Regex("\\s+"), "")
        assertTrue(compact.contains("onOpenControls="))
        assertTrue(compact.contains("handoff"))
        assertTrue(compact.contains("navigate(MiningContributionRoute)"))
        assertTrue(compact.contains("navigate(GemsBuyRoute)"))
        assertTrue(compact.contains("navigate(BasesRoute(notice="))
        assertTrue(body.contains("ACTIVITIES & RECEIPTS"))
        assertTrue(body.contains("KEEP MINING & CLAIM RECEIPTS"))
        assertFalse(compact.contains("navigate(ForgeRoute)"))
        val mount = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/goldforge/GoldForgeHomeMount.kt").readText()
        assertFalse(mount.contains("MiningClaimsClient("))
        assertFalse(mount.contains("MiningClaimsRegistration("))
    }

    @Test fun `forge controls alias preserves the existing Economy Forge owners and confirmation arguments`() {
        val controls = pkwSource().replace("gg.pixelkingdomwars.nativeclient.ui.goldforge.", "")
            .substringAfter("composable<GoldForgeControlsRoute>").substringBefore("composable<")
        val compact = controls.replace(Regex("\\s+"), "")
        assertTrue(compact.contains("valconfirmations=remember(s,wallet){graph.withdrawalConfirmations(wallet)}"))
        assertTrue(compact.contains("EconomyViewModel(s.economy)"))
        assertTrue(compact.contains("ReferralViewModel(s.referrals)"))
        assertTrue(compact.contains("ForgeClaimsViewModel(s.forgeClaims)"))
        assertTrue(compact.contains("WithdrawalUnwindViewModel(s.withdrawalUnwind)"))
        assertTrue(compact.contains("s.session.wallet,account.selectedBaseId,account.landOwned,graph.keepConfirm,confirmations"))
        assertTrue(compact.contains("initialPage=gg.pixelkingdomwars.nativeclient.data.EconomyPage.FORGE"))
        assertTrue(compact.contains("remember(s){runCatching{s.miningContribution}}"))
        // Rewritten for the in-place SMELT tab: the entry now opens KEEP mining on the Gold Forge through
        // openMiningContribution (filed receipts keep their original history owner), never the old route directly.
        assertTrue(compact.contains("account.baseSelectionGeneration){openMiningContribution(graph,s,navController)}"))
        assertTrue(compact.contains("onGems={navController.navigate(GemsRoute)}"))
        assertFalse(compact.contains("navigate(ForgeRoute)"))
    }

    @Test fun `initial read remains checking and wakes once on admitted observation without polling`() {
        val mount = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/goldforge/GoldForgeHomeMount.kt").readText()
        val compact = mount.replace(Regex("\\s+"), "")
        assertTrue(compact.contains("varreadsbyremember(identity){mutableStateOf(GoldForgeHomeData(identity,session.session.wallet,loading=true))}"))
        assertTrue(compact.contains("varhasReadStartedbyremember(identity){mutableStateOf(false)}"))
        assertTrue(compact.contains("hasReadStarted=true"))
        val lifecycle = compact.substringAfter("LaunchedEffect(gate,lifecycle)").substringBefore("valbound=")
        assertTrue(lifecycle.contains("repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        assertTrue(lifecycle.contains("snapshotFlow{"))
        assertTrue(lifecycle.contains(".first{admitted->admitted&&refresh()}"))
        assertTrue(lifecycle.lastIndexOf("refresh()") < lifecycle.indexOf("awaitCancellation()"))
        assertFalse(lifecycle.contains("while("))
        assertFalse(lifecycle.contains("delay("))
    }

    @Test fun `normal capability off observations never open a purchase owner or invent amounts`() = kotlinx.coroutines.runBlocking {
        val supported = capability()
        for (cap in listOf(null, supported.copy(enabled = false), supported.copy(sources = emptyList()),
            supported.copy(destinationAta = null))) {
            val owner = gg.pixelkingdomwars.nativeclient.data.GemsBuyState()
            var probes = 0; var opens = 0
            val result = goldForgeBuyRead({ owner }, { probes++; cap }, { opens++ }, {})
            assertSame(owner, result.owner)
            assertTrue(result.capabilityObserved)
            assertEquals(1, probes); assertEquals(0, opens)
        }
    }

    @Test fun `capability network and concurrency errors are retryable failures never OFF`() {
        val owner = gg.pixelkingdomwars.nativeclient.data.GemsBuyState()
        for (error in listOf(java.io.IOException("offline"), IllegalStateException("concurrent read"),
            kotlinx.coroutines.CancellationException("closed"))) {
            val caught = runCatching { kotlinx.coroutines.runBlocking {
                goldForgeBuyRead({ owner }, { throw error }, { fail("must not open after failed probe") }, {})
            } }.exceptionOrNull()
            assertSame(error, caught)
        }
        val refused = IllegalStateException("A wallet purchase is already in progress.")
        val caught = runCatching { kotlinx.coroutines.runBlocking {
            goldForgeBuyRead({ owner }, { capability() }, { throw refused }, {})
        } }.exceptionOrNull()
        assertSame(refused, caught)
    }

    @Test fun `busy replaced and invalidated owners cannot publish an OFF observation`() {
        var owner = gg.pixelkingdomwars.nativeclient.data.GemsBuyState(busy = true)
        assertThrows(IllegalStateException::class.java) { kotlinx.coroutines.runBlocking {
            goldForgeBuyRead({ owner }, { fail("busy must not read"); null }, {}, {})
        } }
        owner = gg.pixelkingdomwars.nativeclient.data.GemsBuyState()
        assertThrows(IllegalStateException::class.java) { kotlinx.coroutines.runBlocking {
            goldForgeBuyRead({ owner }, { owner = owner.copy(); null }, {}, {})
        } }
        var current = true
        assertThrows(IllegalStateException::class.java) { kotlinx.coroutines.runBlocking {
            goldForgeBuyRead({ owner }, { current = false; null }, {}, { check(current) })
        } }
    }

    @Test fun `available capability calls only the existing read and saved evidence bypasses the capability probe`() = kotlinx.coroutines.runBlocking {
        var owner = gg.pixelkingdomwars.nativeclient.data.GemsBuyState()
        var opens = 0
        val read = goldForgeBuyRead({ owner }, { capability() }, {
            opens++; owner = owner.copy(available = true, capability = capability())
        }, {})
        assertEquals(1, opens); assertSame(owner, read.owner); assertFalse(read.capabilityObserved)
        owner = owner.copy(saved = gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy(
            gg.pixelkingdomwars.nativeclient.data.GemsBuyDraft("wallet", "https://example.invalid", "devnet", "key", 3)))
        val saved = goldForgeBuyRead({ owner }, { fail("saved evidence must use its existing recovery read"); null }, { opens++ }, {})
        assertSame(owner, saved.owner); assertFalse(saved.capabilityObserved); assertEquals(2, opens)
    }

    // Extended for Gold Forge v2 (A4): the LEGACY tab needs a labelled door too.
    @Test fun `every tab has a navigation labelled door and explicit Gems OFF cannot offer a purchase`() {
        for (tab in listOf("SMELT", "CLAIM", "GEMS", "LEGACY")) {
            val door = goldForgeHomeActionDoor(tab, false)
            assertEquals(tab, door.tab); assertTrue(door.enabled)
            assertTrue(door.label.startsWith("OPEN "))
        }
        assertEquals("OPEN CLAIMS IN BASES", goldForgeHomeActionDoor("CLAIM", false, true).label)
        val off = goldForgeHomeActionDoor("GEMS", true)
        assertFalse(off.enabled)
        assertTrue(requireNotNull(off.reason).contains("unavailable"))
    }

    @Test fun `unknown or unavailable claims offer Bases without promising an absent claim entry`() {
        for (available in listOf(null, false)) {
            val door = goldForgeHomeActionDoor("CLAIM", false, available)
            assertEquals("OPEN BASES", door.label)
            assertFalse(door.claimEntryAvailable)
            assertNotNull(door.reason)
        }
        assertTrue(goldForgeHomeActionDoor("CLAIM", false, true).claimEntryAvailable)
    }

    @Test fun `notice scroll bounds stay outside the portrait and landscape sheet panel`() {
        val portrait = goldForgeNoticeBounds(412f, 915f)
        assertEquals(272f, portrait.width, 0f)
        assertTrue(portrait.height + 10f <= 104f)
        val narrow = goldForgeNoticeBounds(320f, 700f)
        assertTrue(narrow.width + 16f + gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry.STACK_W +
            gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry.GUTTER <= 320f)
        for ((width, height) in listOf(411f to 330f, 800f to 360f, 1200f to 800f)) {
            val bounds = goldForgeNoticeBounds(width, height)
            val panel = gg.pixelkingdomwars.nativeclient.ui.sheets.sheetHostLayout(SheetSize.TALL, width, height)
            assertTrue(bounds.width + 16f <= width - panel.widthDp)
            assertTrue(bounds.height + 20f <= height)
        }
        assertEquals(0f, goldForgeNoticeBounds(0f, 0f).height, 0f)
    }

    @Test fun `an outgoing replaced or changed-tab controls door cannot hand off a different sheet`() {
        val entry = SheetEntry(Destination.GoldForge(), selectedTab = "SMELT")
        val door = goldForgeHomeActionDoor("SMELT", false)
        assertTrue(goldForgeHomeDoorCurrent(entry, entry, door, "SMELT"))
        assertFalse(goldForgeHomeDoorCurrent(entry, null, door, "SMELT"))
        assertFalse(goldForgeHomeDoorCurrent(entry, entry.copy(), door, "SMELT"))
        assertFalse(goldForgeHomeDoorCurrent(entry, entry, door, "GEMS"))
        val changed = entry.copy(selectedTab = "GEMS")
        assertFalse(goldForgeHomeDoorCurrent(changed, changed, door, "SMELT"))
        assertFalse(goldForgeHomeDoorCurrent(entry, entry, door.copy(enabled = false), "SMELT"))
        val foreign = SheetEntry(Destination.Leagues())
        assertFalse(goldForgeHomeDoorCurrent(foreign, foreign, door, "SMELT"))
    }

    private fun capability() = gg.pixelkingdomwars.nativeclient.model.GemsCapability(true,
        listOf("wallet-keep"), "11111111111111111111111111111113", 1, 17, 3, 91)

    private fun pkwSource() = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()

    private class ForgeDoorFixture(feature: GemsFeature? = null) {
        val identity = HomeRouteIdentity(Any(), "base", 1)
        var current: HomeRouteIdentity? = identity
        var blocked = false
        var completed = true
        val home = BaseState(balances = Balances("12", "99", gems = "8", features = BalanceFeatures(feature)))
        val requests = HomeRequests()
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        val host = HomeSheetRouteHost({ current }, { blocked }, { reasons += it })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it }).also { it.reportBlocked(false) }
        fun gemsFact(): GateFact = if (home.balances?.features?.gems?.supported == true) GateFact.Allowed else GateFact.Unknown
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), {
            current?.let { HomeRouteContext(it, GateContext(baseId = it.baseId,
                buildings = mapOf("goldforge" to BuildingGateState(1, completed)),
                serverFeatures = mapOf("gems" to gemsFact()))) }
        }, host)
    }
}
