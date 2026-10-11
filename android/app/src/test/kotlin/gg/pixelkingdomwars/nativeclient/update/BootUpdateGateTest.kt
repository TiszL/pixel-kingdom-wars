package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.LaunchMode
import gg.pixelkingdomwars.nativeclient.model.ApiJson
import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.ui.boot.BootDestination
import gg.pixelkingdomwars.nativeclient.ui.boot.bootDestination
import gg.pixelkingdomwars.nativeclient.update.UpdateAction.*
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-09-27: "when you launch game it should find newer version on loading before game is launched ... if for
 * example I deploy next huge update and this version won't be able to launch game also won't be able to update". WHY
 * these pins matter: the boot gate is the one path every installed build keeps to the next build. If the offer depends on
 * any other capabilities field, or the launch can outrun the check, or a failure screen has no way to the update, a
 * server deploy can strand a build that no longer opens the game with no in-app way off it. */
@OptIn(ExperimentalCoroutinesApi::class)
class BootUpdateGateTest {
    private val bytes = "the signed apk".toByteArray()
    private val origin = "https://play.pixelkingdomwars.com"
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun offerJson(offer: NativeUpdateOffer) = ApiJson.encodeToString(NativeUpdateOffer.serializer(), offer)
    /** Today's capabilities answer (backend 97771ef7), carrying [offer]. */
    private fun capabilities(offer: NativeUpdateOffer?, sim: Int = 16, minimum: Long = 0) = json(
        """{"protocolVersion":1,"simVersion":$sim,"minimumVersionCode":$minimum,"contentManifestUrl":"$origin/native-content/manifest.json",
        "presentation":{"enabled":true},"worldV2":{"enabled":true}${offer?.let { ",\"update\":${offerJson(it)}" } ?: ""}}""")

    /** The repository's own work runs on [scope]; in `runTest` the gate runs on the test scope itself, whose virtual clock
     * `advanceUntilIdle` drives (it stops at background work). */
    private inner class Box(scope: CoroutineScope, var metered: Boolean = false) {
        val sessions = FakeSessions()
        var downloads = 0
        var gate: CompletableDeferred<Unit>? = null
        /** A download that fails every time, as a 404 or a 5xx from the APK host does. */
        var networkFails = false
        private val directory: File = Files.createTempDirectory("boot-gate").toFile().apply { deleteOnExit() }
        val marker = MemoryInstallMarker()
        val repository = UpdateRepository(scope, origin, { running(25) },
            object : ApkDownloader {
                override suspend fun download(offer: NativeUpdateOffer, url: okhttp3.HttpUrl, onProgress: (Long, Long) -> Unit): DownloadedApk {
                    downloads++; gate?.await()
                    if (networkFails) throw UpdateFailure(UpdateFailureKind.NETWORK, "HTTP 404")
                    onProgress(bytes.size.toLong(), bytes.size.toLong())
                    return DownloadedApk(File(directory, "${offer.latestVersionCode}.apk").apply { writeBytes(bytes) })
                }
            },
            UpdateVerifier { ArchiveInfo(PACKAGE, it.name.substringBefore('.').toLong(), listOf(SIGNER)) }, UpdateInstaller(sessions),
            { metered }, MutableStateFlow(true), marker, {})
        fun decide(gate: BootUpdateGate, incompatible: Boolean = false) = bootUpdateDecision(gate.check.value, repository.state.value,
            repository.isMandatoryBlocking.value, incompatible, gate.later.value, gate.released.value)
        /** The gate for this build (code 25), as AppGraph builds it. */
        fun boot(scope: CoroutineScope, fetch: suspend () -> JsonObject) = BootUpdateGate(scope, repository, fetch, versionCode = 25)
        /** PkwApp's decision for one frame, through the gate (loaded content: SIM 16, opened unless [contentFailed]). */
        fun decideFrame(gate: BootUpdateGate, contentFailed: Boolean = false) = gate.decide(gate.check.value, repository.state.value,
            repository.isMandatoryBlocking.value, contentFailed, if (contentFailed) null else 16, gate.later.value, gate.released.value)
        /** One PkwApp frame for a signed-in launch: the decision, the route it gives, and what the gate does with both. */
        fun frame(gate: BootUpdateGate): Job? {
            val decision = decideFrame(gate)
            return gate.onFrame(bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_IN, false, decision), decision, repository.state.value.offer)
        }
        suspend fun awaitInstallerCommit() = withTimeout(5_000) { while (sessions.committed == 0) delay(10) }
    }

    @Test fun `the boot read keeps the offer through any change in the fields around it`() {
        // Codes 26-28 lose the whole offer when any sibling field changes type (strict decode). The boot read must not:
        // a server that adds, drops or reshapes everything else still reaches this build with its update.
        val offer = offer(bytes)
        val today = publicUpdateView(capabilities(offer))
        assertEquals(PublicUpdateView(offer, 0, 16, readable = true), today)
        // "economy" was an unknown key when this case was written (released line, e06a1451). The Phase E union made it a
        // known, strictly decoded NativeCapabilities field (9d1e5c1a), so this case now uses a key this build truly does not
        // know; a reshaped KNOWN sibling is unreadable while the offer stands, exactly like the future-server case below.
        val added = publicUpdateView(json("""{"protocolVersion":1,"simVersion":16,"treasury":{"gems":[1,2]},"seasons":"S3","update":${offerJson(offer)}}"""))
        assertEquals("unknown siblings change nothing", PublicUpdateView(offer, 0, 16, readable = true), added)
        val reshapedEconomy = publicUpdateView(json("""{"protocolVersion":1,"simVersion":16,"economy":{"gems":[1,2]},"update":${offerJson(offer)}}"""))
        assertEquals("a reshaped known sibling keeps the offer", PublicUpdateView(offer, 0, 16, readable = false), reshapedEconomy)
        val removed = publicUpdateView(json("""{"update":${offerJson(offer)}}"""))
        assertEquals("the required siblings are gone: this build cannot read the answer, but the offer stands",
            PublicUpdateView(offer, 0, null, readable = false), removed)
        // A future server: protocol 2, SIM as an object, presentation as a list, and new keys inside the offer itself.
        val futureOffer = offerJson(offer).removeSuffix("}") + ""","rolloutPercent":50,"minSdk":33,"notes":{"en":"Realms"}}"""
        val future = publicUpdateView(json("""{"protocolVersion":{"major":2},"simVersion":{"id":18},"presentation":["modern"],
            "contentManifestUrl":42,"minimumVersionCode":26,"update":$futureOffer}"""))
        assertEquals(PublicUpdateView(offer, 26, null, readable = false), future)
    }

    @Test fun `a malformed offer is no offer and a malformed floor is no floor`() {
        // Failing open on a broken field is the rule: a garbled floor must not retire every build, a garbled offer must
        // not be downloaded. Only a well-formed offer and a well-formed floor count.
        for (bad in listOf("null", "7", "\"soon\"", """{"latestVersionCode":27}""", offerJson(offer(bytes)).replace("\"sizeBytes\":${bytes.size}", "\"sizeBytes\":\"many\"")))
            assertNull(bad, publicUpdateView(json("""{"protocolVersion":1,"simVersion":16,"update":$bad}""")).update)
        for ((floor, expected) in listOf("\"abc\"" to 0L, "-5" to 0L, "{\"code\":30}" to 0L, "null" to 0L, "31" to 31L))
            assertEquals(floor, expected, publicUpdateView(json("""{"protocolVersion":1,"simVersion":16,"minimumVersionCode":$floor}""")).minimumVersionCode)
    }

    @Test fun `a server that never answers holds the launch no longer than the budget`() = runTest {
        // A captive portal or a stalled deploy must cost at most the budget, then the launch goes on as before the gate.
        val box = Box(backgroundScope); var calls = 0
        val gate = box.boot(this) { calls++; awaitCancellation() }
        gate.start()
        advanceTimeBy(BOOT_CHECK_BUDGET_MS - 1); runCurrent()
        assertEquals(BootCheck.Pending, gate.check.value)
        assertEquals("the boot screen waits while the check runs", BootDestination.LOADING,
            bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_IN, false, box.decide(gate)))
        advanceTimeBy(2); runCurrent()
        assertEquals(BootCheck.Done(null), gate.check.value)
        assertEquals("one request, never answered", 1, calls)
        assertEquals(BootDestination.HOME, bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_IN, false, box.decide(gate)))
    }

    @Test fun `offline, the check gives up after one quick retry and the launch goes on as before`() = runTest {
        // No network is the common failure: it must cost one short retry pause, never the budget, and never block entry.
        val box = Box(backgroundScope); var calls = 0
        val offline = box.boot(this) { calls++; throw IOException("offline") }
        offline.start(); advanceUntilIdle()
        assertEquals(BootCheck.Done(null), offline.check.value); assertEquals(2, calls)
        assertEquals("only the retry pause was spent", BOOT_CHECK_RETRY_MS, currentTime)
        assertEquals(BootUpdate.NONE, box.decide(offline))
        assertEquals(BootDestination.TITLE, bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_OUT, false, box.decide(offline)))
        // A deploy's 503 that clears by the retry still reaches the offer.
        var tries = 0
        val flaky = box.boot(this) { if (tries++ == 0) throw IOException("503") else capabilities(offer(bytes)) }
        flaky.start(); advanceUntilIdle()
        assertEquals(offer(bytes), (flaky.check.value as BootCheck.Done).view?.update)
        assertEquals(BootUpdate.OPTIONAL, box.decide(flaky))
    }

    @Test fun `a 426 re-check keeps the answer on screen until a newer one arrives`() = runTest {
        // A 426 or an unreadable response during the launch asks again; the required screen or card already showing must
        // not drop back to the loading card for the length of the re-check, nor lose its answer when the re-check fails.
        val box = Box(backgroundScope); var online = true
        val gate = box.boot(this) { if (online) capabilities(offer(bytes)) else awaitCancellation() }
        gate.start(); advanceUntilIdle()
        val answered = gate.check.value
        assertEquals(offer(bytes), (answered as BootCheck.Done).view?.update)
        online = false
        val again = gate.refresh()!!; runCurrent()
        assertSame("a refresh while one runs is the same check", again, gate.refresh())
        assertEquals("still the last answer while the re-check runs", answered, gate.check.value)
        advanceUntilIdle()
        assertEquals("a re-check without an answer keeps it", answered, gate.check.value)
        assertEquals(BootUpdate.OPTIONAL, box.decide(gate))
    }

    @Test fun `a mandatory offer blocks every way into the game and starts the update by itself`() = runBlocking {
        // The owner's lever for "this version must not play": no route past the boot screen, the download starts without a
        // tap and the verified file goes straight to Android's installer (whose own dialog is the player's confirmation).
        val box = Box(this); val wiring = CoroutineScope(coroutineContext + Job())
        val gate = box.boot(wiring) { capabilities(offer(bytes, mandatory = true)) }
        gate.start()!!.join()
        assertEquals(BootUpdate.REQUIRED, box.decide(gate))
        for (phase in AccountPhase.entries) for (ready in listOf(true, false)) for (error in listOf(null, "Bundle damaged"))
            assertEquals("$phase ready=$ready", BootDestination.UPDATE_REQUIRED, bootDestination(LaunchMode.ACCOUNT, ready, error, phase, false, box.decide(gate)))
        gate.later()
        assertEquals("LATER cannot pass a required update", BootUpdate.REQUIRED, box.decide(gate))
        gate.onDecision(BootUpdate.REQUIRED)!!.join()
        box.awaitInstallerCommit()
        assertEquals(UpdateState.Installing(offer(bytes, mandatory = true)), box.repository.state.value)
        assertEquals("downloaded once, installed without a second tap", 1, box.downloads)
        assertEquals(26L, box.marker.pendingVersionCode)
        wiring.cancel()
    }

    @Test fun `an optional offer shows the card, LATER opens the game with the banner kept, UPDATE NOW installs`() = runBlocking {
        val box = Box(this); val wiring = CoroutineScope(coroutineContext + Job())
        val gate = box.boot(wiring) { capabilities(offer(bytes)) }
        gate.start()!!.join()
        assertEquals(BootUpdate.OPTIONAL, box.decide(gate))
        assertEquals("the card shows while the kingdom still loads", BootDestination.UPDATE_AVAILABLE,
            bootDestination(LaunchMode.ACCOUNT, false, null, AccountPhase.RESTORING, false, box.decide(gate)))
        // Unmetered: the file downloads in the background so UPDATE NOW is one tap; nothing installs without the tap.
        box.gate = CompletableDeferred()
        val transfer = gate.onDecision(BootUpdate.OPTIONAL)!!; yield()
        assertEquals(listOf(UPDATE_NOW, LATER), bootCardActions(box.repository.state.value, box.repository.installRequested.value))
        box.gate!!.complete(Unit); transfer.join()
        assertEquals(UpdateState.ReadyToInstall(offer(bytes)), box.repository.state.value); assertEquals(0, box.sessions.committed)
        // LATER: the launch goes on, and the Title/Home banner still carries the verified file.
        gate.later()
        assertEquals(BootUpdate.NONE, box.decide(gate))
        assertEquals(BootDestination.HOME, bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_IN, false, box.decide(gate)))
        assertEquals(UpdatePresentation.Banner, updatePresentation(box.repository.state.value, box.repository.isMandatoryBlocking.value))
        // UPDATE NOW: the installer at once, no second download.
        box.repository.updateNow()!!.join()
        assertEquals(1, box.sessions.committed); assertEquals(1, box.downloads)

        // UPDATE NOW during the background download queues the install; the card then keeps only LATER.
        val midway = Box(this); midway.gate = CompletableDeferred()
        val midGate = midway.boot(wiring) { capabilities(offer(bytes)) }; midGate.start()!!.join()
        val running = midGate.onDecision(BootUpdate.OPTIONAL)!!; yield()
        assertSame("the running transfer, not a second one", running, midway.repository.updateNow())
        assertEquals(listOf(LATER), bootCardActions(midway.repository.state.value, midway.repository.installRequested.value))
        midway.gate!!.complete(Unit); running.join(); midway.awaitInstallerCommit()
        assertEquals(1, midway.downloads)

        // Metered: no background download; UPDATE NOW asks first, exactly as the banner does.
        val metered = Box(this, metered = true)
        val meteredGate = metered.boot(wiring) { capabilities(offer(bytes)) }; meteredGate.start()!!.join()
        assertNull(meteredGate.onDecision(BootUpdate.OPTIONAL)); assertEquals(0, metered.downloads)
        assertNull(metered.repository.updateNow())
        assertEquals(UpdateState.NeedsMeteredConsent(offer(bytes)), metered.repository.state.value)
        assertEquals(listOf(DOWNLOAD_ANYWAY, LATER), bootCardActions(metered.repository.state.value, metered.repository.installRequested.value))
        metered.repository.updateNow(consentToMetered = true)!!.join(); metered.awaitInstallerCommit()
        wiring.cancel()
    }

    @Test fun `every boot failure leads to the update when one is offered, and to today's route when none is`() {
        // A build the server moved past must never meet a dead end while an installable build exists. Without an offer the
        // launch behaves exactly as before the gate: a content failure keeps its retry, the rest keep their notices.
        val optional = offer(bytes)
        val offered = UpdateState.Offered(optional, false, optional.sizeBytes)
        fun done(raw: String) = BootCheck.Done(publicUpdateView(json(raw)))
        data class Failure(val name: String, val check: BootCheck, val contentFailed: Boolean, val withoutOffer: BootDestination)
        val failures = listOf(
            Failure("content refused", done("""{"protocolVersion":1,"simVersion":16}"""), true, BootDestination.CONTENT_FAILED),
            Failure("SIM mismatch", done("""{"protocolVersion":1,"simVersion":17}"""), false, BootDestination.HOME),
            Failure("floor retirement", done("""{"protocolVersion":1,"simVersion":16,"minimumVersionCode":26}"""), false, BootDestination.HOME),
            Failure("capabilities unreadable", done("""{"protocolVersion":"two","simVersion":16,"presentation":"on"}"""), false, BootDestination.HOME),
        )
        for (failure in failures) {
            val incompatible = bootIncompatible(failure.check, 25, failure.contentFailed, if (failure.contentFailed) null else 16)
            fun route(state: UpdateState) = bootDestination(LaunchMode.ACCOUNT, !failure.contentFailed, if (failure.contentFailed) "Bundle damaged" else null,
                AccountPhase.SIGNED_IN, false, bootUpdateDecision(failure.check, state, false, incompatible, later = true, released = false))
            assertEquals("${failure.name}: even after LATER, the offer becomes required", BootDestination.UPDATE_REQUIRED, route(offered))
            assertEquals("${failure.name} without an offer", failure.withoutOffer, route(UpdateState.Idle))
        }
        val healthy = done("""{"protocolVersion":1,"simVersion":16}""")
        assertFalse("a build the server still serves is never forced", bootIncompatible(healthy, 25, false, 16))
        assertEquals(BootUpdate.OPTIONAL, bootUpdateDecision(healthy, offered, false, false, later = false, released = false))
        // The required screen always keeps a way forward: the update's own action, or CHECK AGAIN when it has none.
        val prompt = SystemPrompt { }
        for (state in listOf(UpdateState.Offered(optional, true, optional.sizeBytes), UpdateState.NeedsMeteredConsent(optional), UpdateState.Downloading(optional, 1, 2),
                UpdateState.ReadyToInstall(optional), UpdateState.AwaitingUserAction(optional, prompt), UpdateState.AwaitingPermission(optional, prompt),
                UpdateState.Failed(optional, UpdateFailureKind.NETWORK, true)))
            assertTrue("$state", updateForwardAction(state) != null && !bootRetryOffered(state, failedThisLaunch = false))
        for (state in listOf(UpdateState.Failed(optional, UpdateFailureKind.SIGNER, false), UpdateState.Declined(optional), UpdateState.Installed(optional)))
            assertTrue("$state has no forward action, so CHECK AGAIN shows", bootRetryOffered(state, failedThisLaunch = false))
        for (state in listOf(UpdateState.Verifying(optional), UpdateState.Installing(optional)))
            assertFalse("$state is still moving: nothing to retry yet", bootRetryOffered(state, failedThisLaunch = false))
    }

    @Test fun `the gate decides this launch only, so a later offer never pulls a player out of the game`() {
        // Once the game has opened (a battle may be running), a new mandatory row is the Title/Home screen's job, as
        // before; routing back to the boot screen would drop the player out of whatever they were doing.
        val required = offer(bytes, mandatory = true)
        val state = UpdateState.Offered(required, true, required.sizeBytes)
        val check = BootCheck.Done(publicUpdateView(capabilities(required)))
        assertEquals(BootUpdate.REQUIRED, bootUpdateDecision(check, state, true, true, later = false, released = false))
        assertEquals(BootUpdate.NONE, bootUpdateDecision(check, state, true, true, later = false, released = true))
        assertEquals(BootUpdate.NONE, bootUpdateDecision(BootCheck.Pending, state, true, true, later = false, released = true))
        assertEquals(BootDestination.HOME, bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_IN, false, BootUpdate.NONE))
        assertEquals("the in-game chrome takes it", UpdatePresentation.FullScreen, updatePresentation(state, true))
        for (destination in BootDestination.entries) assertEquals(destination.name,
            destination in setOf(BootDestination.LOADING, BootDestination.CONTENT_FAILED, BootDestination.UPDATE_REQUIRED, BootDestination.UPDATE_AVAILABLE), destination.bootScreen)
    }

    @Test fun `a public offer survives the restore's sign-in, and the caller's tester row replaces its background download`() = runBlocking {
        // The restore installs a session a moment after the boot gate showed the stable offer. Clearing it there made the
        // launch race past the gate; keeping a tester's own row behind the stable download would hide the tester build.
        val box = Box(this); box.gate = CompletableDeferred()
        val stable = offer(bytes); val tester = offer(bytes, code = 27)
        box.repository.onOffer(stable, sessionBound = false)
        val transfer = box.repository.prefetch()!!; yield()
        assertTrue(box.repository.state.value is UpdateState.Downloading)
        box.repository.onCallerChanged()
        assertTrue("the stable offer and its transfer survive the sign-in", box.repository.state.value is UpdateState.Downloading && transfer.isActive)
        box.repository.onOffer(tester, sessionBound = true)
        assertEquals(UpdateState.Offered(tester, false, tester.sizeBytes), box.repository.state.value)
        withTimeout(5_000) { transfer.join() }; assertTrue(transfer.isCancelled)
        // A session-bound offer still belongs to its caller alone.
        box.repository.onCallerChanged()
        assertEquals(UpdateState.Idle, box.repository.state.value)
    }

    @Test fun `the 426 dialog leads to the offered build, and to browsing only without one`() = runBlocking {
        // "Continue browsing" was the only button: a build the server stopped fighting with had no way to its update.
        val optional = offer(bytes)
        assertEquals(UPDATE_NOW, incompatibleResponseAction(UpdateState.Offered(optional, false, optional.sizeBytes)))
        assertEquals("an earlier NOT NOW does not hide it now", UPDATE_NOW, incompatibleResponseAction(UpdateState.Declined(optional)))
        assertEquals(UPDATE_NOW, incompatibleResponseAction(UpdateState.Failed(optional, UpdateFailureKind.NETWORK, true)))
        assertNull(incompatibleResponseAction(UpdateState.Idle))
        assertNull(incompatibleResponseAction(UpdateState.Installed(optional)))
        // The real path: the game is open (the launch released), the server answers 426, PkwApp forwards it to the gate,
        // the tolerant re-check finds the build the owner just published, and the dialog's UPDATE NOW downloads it and
        // hands it to Android's installer without a second tap.
        val box = Box(this); val wiring = CoroutineScope(coroutineContext + Job())
        var served: NativeUpdateOffer? = null
        val gate = box.boot(wiring) { capabilities(served) }
        gate.beginLaunch(); gate.start()!!.join()
        assertNull("no offer at launch: straight into the game", box.frame(gate)); assertTrue(gate.released.value)
        assertNull("without an offer the dialog keeps only Continue browsing", gate.dialogUpdate(box.repository.state.value))
        served = optional
        gate.onServerMovedOn()!!.join()
        assertEquals(UpdateState.Offered(optional, false, optional.sizeBytes), box.repository.state.value)
        assertEquals("the open game is never pulled back to the boot screen", BootUpdate.NONE, box.decideFrame(gate))
        // Past the boot screen the re-check does not hold its offer: the caller's own answer may still withdraw the row.
        box.repository.onOffer(null, sessionBound = true)
        assertNull(gate.dialogUpdate(box.repository.state.value))
        gate.onServerMovedOn()!!.join()
        val update = gate.dialogUpdate(box.repository.state.value) ?: error("the 426 dialog must lead to the offered build")
        update()!!.join(); box.awaitInstallerCommit()
        assertEquals(UpdateState.Installing(optional), box.repository.state.value)
        assertEquals(1, box.downloads)
        wiring.cancel()
    }

    @Test fun `every launch meets the gate again, even in a process a finished Activity left alive`() = runBlocking {
        // Exit is Activity.finish(): the process, AppGraph and this gate may live on. The next tap on the icon is a new
        // Activity and a new BootViewModel; if the last launch's release or LATER carried over, it went straight to Home and
        // never looked for the mandatory row the owner published in between.
        val box = Box(this); val wiring = CoroutineScope(coroutineContext + Job())
        var served: NativeUpdateOffer? = null
        val gate = box.boot(wiring) { capabilities(served) }
        gate.beginLaunch(); gate.start()!!.join()
        assertNull(box.frame(gate)); assertTrue("nothing to offer: the game opened", gate.released.value)
        served = offer(bytes, mandatory = true)
        gate.beginLaunch()
        assertFalse(gate.released.value)
        assertEquals("the new launch waits for its own check, even before it starts", BootUpdate.CHECKING, box.decideFrame(gate))
        gate.start()!!.join()
        assertEquals(BootUpdate.REQUIRED, box.decideFrame(gate))
        assertEquals(BootDestination.UPDATE_REQUIRED, bootDestination(LaunchMode.ACCOUNT, true, null, AccountPhase.SIGNED_IN, false, box.decideFrame(gate)))

        // LATER is this launch's answer too: the next launch shows the card again.
        val optional = Box(this, metered = true)
        val card = optional.boot(wiring) { capabilities(offer(bytes)) }
        card.beginLaunch(); card.start()!!.join()
        assertEquals(BootUpdate.OPTIONAL, optional.decideFrame(card))
        card.later(); optional.frame(card)
        assertTrue(card.released.value)
        card.beginLaunch(); card.start()!!.join()
        assertEquals(BootUpdate.OPTIONAL, optional.decideFrame(card))
        wiring.cancel()
    }

    @Test fun `each frame's decision is acted on once, and the first screen past the boot route releases the launch`() = runBlocking {
        // PkwApp forwards every frame. The gate, not a LaunchedEffect key, makes a decision act once: a second download
        // start would restart a failed transfer on every recomposition. The boot card is still the boot screen: only a
        // screen past it ends the launch's gate.
        val box = Box(this); box.gate = CompletableDeferred(); val wiring = CoroutineScope(coroutineContext + Job())
        val gate = box.boot(wiring) { capabilities(offer(bytes)) }
        gate.beginLaunch()
        assertNull("nothing while the check runs", gate.onFrame(BootDestination.LOADING, BootUpdate.CHECKING, null))
        gate.start()!!.join()
        val decision = box.decideFrame(gate); assertEquals(BootUpdate.OPTIONAL, decision)
        val prefetch = gate.onFrame(BootDestination.UPDATE_AVAILABLE, decision, box.repository.state.value.offer)!!; yield()
        assertTrue(box.repository.state.value is UpdateState.Downloading)
        assertNull("the same frame again starts nothing", gate.onFrame(BootDestination.UPDATE_AVAILABLE, decision, box.repository.state.value.offer))
        assertFalse("the boot card does not release the launch", gate.released.value)
        gate.later(); box.frame(gate)
        assertTrue("Home released it", gate.released.value)
        box.gate!!.complete(Unit); prefetch.join()
        assertEquals("downloaded once, never installed without the tap", 1, box.downloads); assertEquals(0, box.sessions.committed)
        wiring.cancel()

        // The decision reads this build's own version, content and SIM, exactly as bootIncompatible defines them.
        val offered = UpdateState.Offered(offer(bytes), false, bytes.size.toLong())
        fun served(minimum: Long) = BootCheck.Done(publicUpdateView(capabilities(offer(bytes), minimum = minimum)))
        fun decide(check: BootCheck = served(25), mandatory: Boolean = false, contentFailed: Boolean = false, sim: Int? = 16, later: Boolean = false, released: Boolean = false) =
            gate.decide(check, offered, mandatory, contentFailed, sim, later, released)
        assertEquals("a floor at this build still serves it", BootUpdate.OPTIONAL, decide())
        assertEquals("a floor above this build retires it", BootUpdate.REQUIRED, decide(check = served(26)))
        assertEquals(BootUpdate.REQUIRED, decide(contentFailed = true, sim = null))
        assertEquals(BootUpdate.REQUIRED, decide(sim = 17))
        assertEquals(BootUpdate.REQUIRED, decide(mandatory = true))
        assertEquals(BootUpdate.NONE, decide(later = true))
        assertEquals(BootUpdate.NONE, decide(check = served(26), released = true))
    }

    @Test fun `the boot screen's own offer holds for the launch, so an empty answer cannot lift a required update`() = runBlocking {
        // Owner 2026-09-27: "a version that can no longer launch must still be able to update". On a metered network the
        // required download waits for the player's consent, so no transfer protects the offer: the restore's session-bound
        // check for a wallet without the row, or a public answer racing a withdrawal, used to clear it, lift REQUIRED and
        // open the game.
        val box = Box(this, metered = true); val wiring = CoroutineScope(coroutineContext + Job())
        val required = offer(bytes, mandatory = true)
        val gate = box.boot(wiring) { capabilities(required) }
        gate.beginLaunch(); gate.start()!!.join()
        assertNull(box.frame(gate))
        assertEquals(UpdateState.NeedsMeteredConsent(required), box.repository.state.value)
        box.repository.onOffer(null, sessionBound = true)
        box.repository.onOffer(null, sessionBound = false)
        assertEquals(UpdateState.NeedsMeteredConsent(required), box.repository.state.value)
        assertTrue(box.repository.isMandatoryBlocking.value)
        assertEquals(BootUpdate.REQUIRED, box.decideFrame(gate))
        // A different eligible row (the caller's own tester build) still replaces it.
        val tester = offer(bytes, code = 27, mandatory = true)
        box.repository.onOffer(tester, sessionBound = true)
        assertEquals(UpdateState.Offered(tester, true, bytes.size.toLong()), box.repository.state.value)
        assertEquals(BootUpdate.REQUIRED, box.decideFrame(gate))

        // Once the launch has left the boot screen the hold ends: in the game the channel's own rules apply again.
        val optional = Box(this, metered = true)
        val card = optional.boot(wiring) { capabilities(offer(bytes)) }
        card.beginLaunch(); card.start()!!.join()
        optional.repository.onOffer(null, sessionBound = true)
        assertEquals("held while the card shows", UpdateState.Offered(offer(bytes), false, bytes.size.toLong()), optional.repository.state.value)
        card.later(); optional.frame(card); assertTrue(card.released.value)
        optional.repository.onOffer(null, sessionBound = true)
        assertEquals(UpdateState.Idle, optional.repository.state.value)
        wiring.cancel()
    }

    @Test fun `CHECK AGAIN without an answer keeps the verdict that this build can no longer run`() = runTest {
        // The floor retired this build and an optional offer exists: REQUIRED. A CHECK AGAIN that meets no network used to
        // publish "no answer", turning the verdict into an optional card whose LATER opens a build the server refuses.
        val box = Box(backgroundScope); var online = true
        val gate = box.boot(this) { if (online) capabilities(offer(bytes), minimum = 26) else throw IOException("offline") }
        gate.beginLaunch(); gate.start(); advanceUntilIdle()
        assertEquals(BootUpdate.REQUIRED, box.decideFrame(gate))
        online = false
        gate.checkAgain(contentFailed = false) { fail("the content opened; only the check runs again") }; advanceUntilIdle()
        assertEquals(26L, (gate.check.value as BootCheck.Done).view?.minimumVersionCode)
        assertEquals(BootUpdate.REQUIRED, box.decideFrame(gate))
        // A content failure's CHECK AGAIN is the content retry, which starts a fresh check itself (launchBoot).
        var restarted = 0
        assertNull(gate.checkAgain(contentFailed = true) { restarted++ }); assertEquals(1, restarted)
    }

    @Test fun `a tester row that replaces the public download is started again, and the stale install request goes`() = runBlocking {
        // A retired build (the floor is above it) is downloading the stable row when the restore's session-bound check names
        // the tester's own row. The replacement cancelled the stable transfer but kept UPDATE NOW pointed at its file, and
        // the unchanged REQUIRED decision never started the tester build: the required screen sat on DOWNLOAD.
        val box = Box(this); box.gate = CompletableDeferred(); val wiring = CoroutineScope(coroutineContext + Job())
        val stable = offer(bytes); val tester = offer(bytes, code = 27)
        val gate = box.boot(wiring) { capabilities(stable, minimum = 26) }
        gate.beginLaunch(); gate.start()!!.join()
        val first = box.frame(gate)!!; yield()
        assertEquals(UpdateState.Downloading(stable, 0, stable.sizeBytes), box.repository.state.value)
        assertTrue(box.repository.installRequested.value)
        assertNull("the same frame acts once", box.frame(gate))
        box.repository.onOffer(tester, sessionBound = true)
        assertEquals(UpdateState.Offered(tester, false, tester.sizeBytes), box.repository.state.value)
        assertFalse("UPDATE NOW named the stable file", box.repository.installRequested.value)
        assertEquals(BootUpdate.REQUIRED, box.decideFrame(gate))
        val second = box.frame(gate) ?: error("REQUIRED with a new offer must start it")
        assertTrue(box.repository.installRequested.value)
        box.gate!!.complete(Unit); second.join(); box.awaitInstallerCommit()
        assertEquals(UpdateState.Installing(tester), box.repository.state.value)
        assertTrue(first.isCancelled); assertEquals(27L, box.marker.pendingVersionCode)
        wiring.cancel()
    }

    @Test fun `once the required update has failed, the dApp Store line and CHECK AGAIN stay for the launch`() = runBlocking {
        // A 404 or 5xx from the APK host fails every download (NETWORK, retryable): TRY AGAIN was the only button, and a
        // download that can never finish locked the player out of the game with no other way on.
        val box = Box(this); box.networkFails = true; val wiring = CoroutineScope(coroutineContext + Job())
        val required = offer(bytes, mandatory = true)
        val gate = box.boot(wiring) { capabilities(required) }
        fun retryOffered() = bootRetryOffered(box.repository.state.value, gate.failedThisLaunch(box.repository.failures.value))
        gate.beginLaunch(); gate.start()!!.join()
        box.gate = CompletableDeferred()
        val first = box.frame(gate)!!; yield()
        assertFalse("a download under way is its own way forward", retryOffered())
        box.gate!!.complete(Unit); first.join()
        val failed = box.repository.state.value
        assertTrue("$failed", failed is UpdateState.Failed && failed.retryable && failed.kind == UpdateFailureKind.NETWORK)
        assertEquals(TRY_AGAIN, updateForwardAction(failed)); assertTrue("next to TRY AGAIN", retryOffered())
        box.gate = CompletableDeferred()
        val retry = box.repository.updateNow()!!; yield()
        assertTrue(box.repository.state.value is UpdateState.Downloading); assertTrue("and while TRY AGAIN runs", retryOffered())
        box.gate!!.complete(Unit); retry.join()
        // The next launch starts clean: its download is its own way forward until it fails.
        box.networkFails = false; box.gate = CompletableDeferred()
        gate.beginLaunch(); gate.start()!!.join()
        val next = box.frame(gate)!!; yield()
        assertTrue(box.repository.state.value is UpdateState.Downloading); assertFalse(retryOffered())
        box.gate!!.complete(Unit); next.join(); box.awaitInstallerCommit()
        wiring.cancel()
    }

    @Test fun `PkwApp and the boot screen hand every frame and event to the gate`() {
        // PkwApp is Compose-only and the module has no Compose test runtime (see TitleWallpaperTest), so the lines that hand
        // its frames and events to the gate are pinned in source; everything they call is tested above. Without one of them
        // a launch skips the gate, never starts a required update, never releases, or leaves the 426 dialog a dead end.
        val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
        val app = File("$root/ui/nav/PkwApp.kt").readText()
        for (line in listOf(
            "val bootUpdate = graph.bootUpdates.decide(bootCheck, updateState, updateMandatory, content.error != null && !content.ready, content.simVersion, bootLater, bootReleased)",
            "val destination = bootDestination(graph.mode, content.ready, content.error, account.phase, account.busy, bootUpdate)",
            "LaunchedEffect(destination, bootUpdate, updateState.offer) { graph.bootUpdates.onFrame(destination, bootUpdate, updateState.offer) }",
            "is RoutingEvent.UpdateRequired -> { gate = Gate.Update(event.message); graph.bootUpdates.onServerMovedOn() }",
            "needs a newer native app.\"); graph.bootUpdates.onServerMovedOn() }",
            "val dialogUpdate = graph.bootUpdates.dialogUpdate(updateState)",
            // Hub mount: the 426 gate is the designed ServerGateCard; UPDATE still leads to the offer instead of a dead end.
            "dialogUpdate = if (dialogUpdate != null) ({ gate = null; dialogUpdate() }) else null",
            // Hub mount: the boot route is the designed boot gate; its update decisions moved into BootGate.kt (below).
            "BootGateScreen(graph, destination, content.error, bootBusy) { boot.start() }",
        )) assertTrue(line, line in app)
        // Rewritten for the hub mount: the required gate's CHECK AGAIN and the optional gate's LATER keep the strips'
        // decisions, and the D-193 strip with its tip stays the one surface under the gate card.
        val gate = File("$root/ui/boot/BootGate.kt").readText()
        for (line in listOf(
            "graph.bootUpdates.checkAgain(content.error != null && !content.ready, onRetryBoot)",
            "onLater = { graph.bootUpdates.later() }",
            "BootScreen(bootLoadingStrip(null, retrying = false, onRetryBoot), rememberBootTip())",
        )) assertTrue(line, line in gate)
        for (flow in listOf("check", "later", "released")) assertTrue(flow, "by graph.bootUpdates.$flow.collectAsState()" in app)
        val boot = File("$root/ui/boot/BootScreen.kt").readText()
        assertTrue("each Activity launch begins the gate's launch before its boot starts", "init { graph.bootUpdates.beginLaunch(); start() }" in boot)
        assertTrue("launchBoot(graph.mode.offline, { graph.bootUpdates.start() }, { graph.account.restore() }, { graph.content.initialize() })" in boot)
        val screen = File("$root/update/UpdateScreen.kt").readText()
        // D-193: the required update is the boot strip; CHECK AGAIN is its second, ghost button under the same rule.
        assertTrue("val retryOffered = bootRetryOffered(state, gate.failedThisLaunch(failures))" in screen)
        assertTrue("if (retryOffered) StripButton(\"CHECK AGAIN\", onRetry, ghost = true)" in screen)
        assertTrue("val failures by repository.failures.collectAsState()" in screen)
        assertTrue("{ gameApi.getPublic(\"/native/capabilities\") }, versionCode.toLong(), enabled = !mode.offline)" in File("$root/AppGraph.kt").readText())
    }
}
