package gg.pixelkingdomwars.nativeclient.update

import android.content.pm.PackageInstaller
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.telemetry.NativeError
import gg.pixelkingdomwars.nativeclient.telemetry.NativeError.*
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** M45 §5 state machine: explicit consent at every costly step, no download during battles, mandatory offers pause
 * orders and nothing else, and exactly the closed telemetry vocabulary in the order the steps happened. */
class UpdateRepositoryTest {
    private val bytes = "the signed apk".toByteArray()
    private val origin = "https://play.pixelkingdomwars.com"
    private fun capabilities(offer: NativeUpdateOffer?) = NativeCapabilities(1, 16, update = offer)

    private inner class Harness(val scope: CoroutineScope, battle: Boolean = false, var metered: Boolean = false,
                                var archive: ArchiveInfo? = ArchiveInfo(PACKAGE, 26, listOf(SIGNER)),
                                val marker: MemoryInstallMarker = MemoryInstallMarker(), val runningCode: Long = 25) {
        val activation = MutableStateFlow(!battle)
        var battle: Boolean get() = !activation.value; set(value) { activation.value = !value }
        val events = mutableListOf<NativeError>()
        val sessions = FakeSessions()
        val directory: File = Files.createTempDirectory("update-repository").toFile().apply { deleteOnExit() }
        var downloads = 0
        var gate: CompletableDeferred<Unit>? = null
        var networkFails = false
        var discarded = 0
        val repository = UpdateRepository(scope, origin, { running(runningCode) },
            object : ApkDownloader {
                override suspend fun download(offer: NativeUpdateOffer, url: okhttp3.HttpUrl, onProgress: (Long, Long) -> Unit): DownloadedApk {
                    downloads++; assertEquals("$origin${offer.apkPath}", url.toString())
                    gate?.await()
                    if (networkFails) throw UpdateFailure(UpdateFailureKind.NETWORK, "offline")
                    onProgress(bytes.size.toLong(), bytes.size.toLong())
                    return DownloadedApk(File(directory, "26.apk").apply { writeBytes(bytes) })
                }
                override fun discard() { discarded++ }
            },
            UpdateVerifier { archive }, UpdateInstaller(sessions), { metered }, activation, marker, { events += it })
    }

    @Test fun `an eligible offer is announced once per file and an ineligible one not at all`() = runBlocking {
        // Capabilities are rechecked on every resume; telemetry must count offers, not app launches.
        val h = Harness(this)
        h.repository.onCapabilities(capabilities(offer(bytes, signer = "a1".repeat(32))))
        assertEquals(UpdateState.Idle, h.repository.state.value)
        h.repository.onCapabilities(capabilities(offer(bytes))); h.repository.onCapabilities(capabilities(offer(bytes)))
        assertEquals(UpdateState.Offered(offer(bytes), false, bytes.size.toLong()), h.repository.state.value)
        val discardedWithOffer = h.discarded
        h.repository.onCapabilities(capabilities(null))
        assertEquals(UpdateState.Idle, h.repository.state.value)
        // Once no offer remains (the update installed or was withdrawn), stored APK bytes are released.
        assertEquals(discardedWithOffer + 1, h.discarded)
        assertEquals(listOf(UPDATE_OFFERED), h.events)
    }
    @Test fun `no download starts while a battle or replay is on screen`() = runBlocking {
        // Downloading competes with live battle traffic; the player is asked again later, which is not an error.
        val h = Harness(this, battle = true); h.repository.onCapabilities(capabilities(offer(bytes)))
        assertNull(h.repository.startDownload())
        assertEquals(UpdateState.WaitingForBattle(offer(bytes)), h.repository.state.value); assertEquals(0, h.downloads)
        h.battle = false; h.repository.startDownload()!!.join()
        assertEquals(UpdateState.ReadyToInstall(offer(bytes)), h.repository.state.value)
    }
    @Test fun `a battle that opens mid-download stops the transfer until the player asks again`() = runBlocking {
        // M45 §5 says never while a battle or replay is active, not only never starting one: a running 200 MB transfer
        // and its hash would compete with live battle traffic. The partial file stays, so the retry resumes it.
        val h = Harness(this); h.gate = CompletableDeferred(); h.repository.onCapabilities(capabilities(offer(bytes)))
        val job = h.repository.startDownload()!!; yield()
        assertTrue(h.repository.state.value is UpdateState.Downloading)
        // Bounded: a transfer that ignores the battle must fail this test, not hang the suite.
        h.battle = true; withTimeout(5_000) { job.join() }
        assertEquals(UpdateState.WaitingForBattle(offer(bytes)), h.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED), h.events)
        h.battle = false; h.gate = null; h.repository.startDownload()!!.join()
        assertEquals(UpdateState.ReadyToInstall(offer(bytes)), h.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DOWNLOADED, UPDATE_VERIFIED), h.events)
    }
    @Test fun `a metered network needs explicit consent once per offer`() = runBlocking {
        // A 200 MB transfer on mobile data must be the player's choice.
        val h = Harness(this, metered = true); h.repository.onCapabilities(capabilities(offer(bytes)))
        assertNull(h.repository.startDownload()); assertEquals(UpdateState.NeedsMeteredConsent(offer(bytes)), h.repository.state.value)
        assertEquals(0, h.downloads)
        h.repository.startDownload(consentToMetered = true)!!.join(); assertEquals(1, h.downloads)
        h.repository.startDownload()!!.join(); assertEquals("Consent is remembered for this offer", 2, h.downloads)
    }
    @Test fun `download, verify and install record the closed telemetry codes in order`() = runBlocking {
        val h = Harness(this); h.repository.onCapabilities(capabilities(offer(bytes)))
        h.repository.startDownload()!!.join()
        assertEquals(UpdateState.ReadyToInstall(offer(bytes)), h.repository.state.value)
        h.repository.install()!!.join()
        assertEquals(UpdateState.Installing(offer(bytes)), h.repository.state.value); assertEquals(1, h.sessions.committed)
        val prompt = SystemPrompt { }
        h.repository.onInstallEvent(InstallEvent.PendingUserAction(prompt))
        assertEquals(UpdateState.AwaitingUserAction(offer(bytes), prompt), h.repository.state.value)
        h.repository.onInstallEvent(InstallEvent.Success)
        assertEquals(UpdateState.Installed(offer(bytes)), h.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DOWNLOADED, UPDATE_VERIFIED, UPDATE_INSTALLED), h.events)
        // Counted here, so the next launch must not count the same install again from the marker.
        assertNull(h.marker.pendingVersionCode)
    }
    @Test fun `an install that replaces this process is counted once by the next launch`() = runBlocking {
        // A self-update kills the old process before STATUS_SUCCESS reaches it. Without the marker the funnel never shows
        // NATIVE_UPDATE_INSTALLED, the number the separate minimum-build decision (M45 D6) waits on.
        val marker = MemoryInstallMarker()
        val old = Harness(this, marker = marker); old.repository.onCapabilities(capabilities(offer(bytes)))
        old.repository.startDownload()!!.join(); old.repository.install()!!.join()
        assertEquals(26L, marker.pendingVersionCode)
        assertEquals("The player dismissed the system dialog: the relaunched old build counts nothing", emptyList<NativeError>(), Harness(this, marker = marker).events)
        assertEquals(listOf(UPDATE_INSTALLED), Harness(this, marker = marker, runningCode = 26).events)
        assertNull(marker.pendingVersionCode)
        assertEquals("Counted once", emptyList<NativeError>(), Harness(this, marker = marker, runningCode = 26).events)
    }
    @Test fun `a missing install grant waits for Settings and resumes after the grant`() = runBlocking {
        val h = Harness(this); h.sessions.permitted = false; h.repository.onCapabilities(capabilities(offer(bytes)))
        h.repository.startDownload()!!.join(); h.repository.install()!!.join()
        assertEquals(UpdateState.AwaitingPermission(offer(bytes), h.sessions.prompt), h.repository.state.value)
        h.repository.onForeground()?.join(); assertEquals("No grant, no session", 0, h.sessions.created)
        h.sessions.permitted = true; h.repository.onForeground()!!.join()
        assertEquals(1, h.sessions.committed)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DOWNLOADED, UPDATE_VERIFIED, UPDATE_FAILED_PERMISSION), h.events)
    }
    @Test fun `verification and installer failures are typed and reported once`() = runBlocking {
        // A foreign signer is not retryable (the published file is wrong); an installer failure is.
        val h = Harness(this, archive = ArchiveInfo(PACKAGE, 26, listOf("a1".repeat(32)))); h.repository.onCapabilities(capabilities(offer(bytes)))
        h.repository.startDownload()!!.join()
        assertEquals(UpdateState.Failed(offer(bytes), UpdateFailureKind.SIGNER, false, "The update is not signed by this app's publisher"), h.repository.state.value)
        assertFalse(File(h.directory, "26.apk").exists())
        val ok = Harness(this); ok.repository.onCapabilities(capabilities(offer(bytes)))
        ok.repository.startDownload()!!.join(); ok.repository.install()!!.join()
        ok.repository.onInstallEvent(installEvent(PackageInstaller.STATUS_FAILURE_ABORTED, "INSTALL_FAILED_ABORTED", null))
        assertEquals(UpdateState.Failed(offer(bytes), UpdateFailureKind.INSTALL, true, "INSTALL_FAILED_ABORTED"), ok.repository.state.value)
        assertNull("A refused install is not counted as installed on a later launch", ok.marker.pendingVersionCode)
        ok.repository.install()!!.join()
        assertEquals("An installer retry reuses the verified file", 1, ok.downloads); assertEquals(2, ok.sessions.committed)
        ok.repository.onInstallEvent(installEvent(PackageInstaller.STATUS_FAILURE_STORAGE, "INSTALL_FAILED_INSUFFICIENT_STORAGE", null))
        assertEquals(UpdateState.Failed(offer(bytes), UpdateFailureKind.INSTALL, true, "INSTALL_FAILED_INSUFFICIENT_STORAGE"), ok.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DOWNLOADED, UPDATE_FAILED_SIGNER), h.events)
        // Sentry 2026-09-27: the player's cancel and Android's refusal reach triage as different codes.
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DOWNLOADED, UPDATE_VERIFIED, UPDATE_INSTALL_CANCELLED, UPDATE_FAILED_INSTALL_STORAGE), ok.events)
        val offline = Harness(this).apply { networkFails = true }; offline.repository.onCapabilities(capabilities(offer(bytes)))
        offline.repository.startDownload()!!.join()
        assertEquals(UpdateState.Failed(offer(bytes), UpdateFailureKind.NETWORK, true, "offline"), offline.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_FAILED_NETWORK), offline.events)
    }
    @Test fun `cancelling a download returns to the offer`() = runBlocking {
        val h = Harness(this); h.gate = CompletableDeferred(); h.repository.onCapabilities(capabilities(offer(bytes)))
        val job = h.repository.startDownload()!!; yield()
        assertTrue(h.repository.state.value is UpdateState.Downloading)
        h.repository.cancel(); job.join()
        assertEquals(UpdateState.Offered(offer(bytes), false, bytes.size.toLong()), h.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED), h.events)
    }
    @Test fun `a declined optional offer stays declined for this process`() = runBlocking {
        // Re-announcing on every capabilities check would nag; the decline is counted once.
        val h = Harness(this); h.repository.onCapabilities(capabilities(offer(bytes)))
        h.repository.decline(); h.repository.onCapabilities(capabilities(offer(bytes))); h.repository.decline()
        assertEquals(UpdateState.Declined(offer(bytes)), h.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DECLINED), h.events)
        assertFalse(h.repository.isMandatoryBlocking.value)
    }
    @Test fun `a mandatory offer cannot be declined and pauses orders through ContentState only`() = runBlocking {
        // Mandatory rows gate orders via the existing allowsGameOrders mechanism; account access is untouched and
        // minimumVersionCode keeps its own independent meaning.
        val h = Harness(this); val mandatory = offer(bytes, mandatory = true)
        h.repository.onCapabilities(capabilities(mandatory))
        assertTrue(h.repository.isMandatoryBlocking.value)
        h.repository.decline()
        assertEquals(UpdateState.Offered(mandatory, true, bytes.size.toLong()), h.repository.state.value)
        assertEquals(listOf(UPDATE_OFFERED), h.events)
        assertFalse(ContentState(updateMandatoryBlocked = true).allowsGameOrders(26))
        assertTrue(ContentState(updateMandatoryBlocked = false).allowsGameOrders(26))
        assertFalse(ContentState(minimumNativeBuild = 27).allowsGameOrders(26))
        // An offer this build cannot install (foreign signer) never blocks orders.
        h.repository.onCapabilities(capabilities(offer(bytes, mandatory = true, signer = "a1".repeat(32))))
        assertFalse(h.repository.isMandatoryBlocking.value)
    }
    @Test fun `each caller gets its own offer, and a mandatory one pauses orders through ContentState`() = runBlocking {
        // M45 §1: tester rows reach only tester wallets and stable rows reach everyone, signed out included (the Title
        // banner). A tester's offer, download or mandatory pause must never carry over to the next account in this
        // process; and the AppGraph edge must really reach ContentState.allowsGameOrders, then lift with the offer.
        val h = Harness(this)
        val stable = offer(bytes); val tester = offer(bytes, code = 27, mandatory = true)
        val served = mapOf<String?, NativeUpdateOffer?>(null to stable, "tester-wallet" to tester, "player-wallet" to null)
        val callers = MutableStateFlow<String?>(null)
        val content = MutableStateFlow(ContentState())
        val wiring = CoroutineScope(coroutineContext + Job())
        wiring.bindUpdateChannel(h.repository, callers, { capabilities(served.getValue(callers.value)) }) { blocked ->
            content.update { it.copy(updateMandatoryBlocked = blocked) }
        }
        suspend fun settle() = repeat(5) { yield() }
        settle()
        assertEquals("Signed out, the stable row is offered", UpdateState.Offered(stable, false, bytes.size.toLong()), h.repository.state.value)
        assertTrue(content.value.allowsGameOrders(25))
        callers.value = "tester-wallet"; settle()
        assertEquals(UpdateState.Offered(tester, true, bytes.size.toLong()), h.repository.state.value)
        assertFalse("A mandatory row pauses orders", content.value.allowsGameOrders(25))
        h.gate = CompletableDeferred(); val transfer = h.repository.startDownload()!!; yield()
        callers.value = "player-wallet"; settle(); withTimeout(5_000) { transfer.join() }
        assertEquals(UpdateState.Idle, h.repository.state.value)
        assertTrue("The next account's orders are not paused by the tester's row", content.value.allowsGameOrders(25))
        assertEquals("The tester's transfer stopped with the caller change", listOf(UPDATE_OFFERED, UPDATE_OFFERED), h.events)
        wiring.cancel()
    }

    @Test fun `a signed-out launch gets the stable offer although restore swaps the session token mid-request`() = runBlocking {
        // Emulator acceptance (jdb): the startup check was bound to the launch token; BootScreen's restore replaced it, a
        // signed-out player's 401 replaced it again, the answer was discarded as superseded, and nothing re-fetched while
        // the player stayed signed out, so the offer never appeared. Stable rows are public: the check must not depend on
        // the session at all. [settled] never turns true here, so the offer can only come from the first request.
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val server = MockWebServer().apply { useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false); start() }
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val store = object : SecretStore { var value: String? = null
            override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
        val jar = SessionCookieJar(server.url("/"), store)
        // The player's own cookie is in the jar: the public check must leave it at home.
        jar.saveFromResponse(server.url("/"), listOf(okhttp3.Cookie.parse(server.url("/"), "shardkeep_session=old; Secure; HttpOnly; Path=/; Max-Age=3600")!!))
        val api = GameApi.withTransport(server.url("/").toString(), jar, "update-test", transport)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val requests = mutableListOf<RecordedRequest>()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(requests) { requests += request }
                entered.countDown(); check(release.await(10, TimeUnit.SECONDS))
                return MockResponse().setBody(Json.encodeToString(NativeCapabilities.serializer(), capabilities(offer(bytes))))
            }
        }
        val h = Harness(this); val wiring = CoroutineScope(coroutineContext + Job())
        try {
            wiring.bindUpdateChannel(h.repository, MutableStateFlow(null), { updateCapabilities(api, null) }, MutableStateFlow(false)) {}
            withContext(Dispatchers.IO) { check(entered.await(5, TimeUnit.SECONDS)) }
            // BootScreen's restore begins authentication; the cookie-less restore answers 401 and the jar is cleared.
            api.beginAuthentication(); api.forgetLocalSession()
            release.countDown()
            withTimeout(5_000) { h.repository.state.first { it is UpdateState.Offered } }
            assertEquals(UpdateState.Offered(offer(bytes), false, bytes.size.toLong()), h.repository.state.value)
            assertEquals("One request, no retry needed", 1, synchronized(requests) { requests.size })
            assertNull("A public check never carries a session cookie", requests.single().getHeader("Cookie"))
            assertEquals(listOf(UPDATE_OFFERED), h.events)
        } finally {
            release.countDown(); wiring.cancel(); server.shutdown()
            transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown()
        }
    }
    @Test fun `a check that fails is retried once after the account restore settles`() = runBlocking {
        // A token swap (or a dropped connection) can still lose the one startup check. Without a retry the offer waits for
        // an event that may never come for a signed-out player; the restore reaching SIGNED_OUT/SIGNED_IN is that event.
        // One retry only: a failing server must not turn into a request loop.
        for (failure in listOf<() -> Exception>({ SessionSupersededException() }, { IOException("connection reset") })) {
            val h = Harness(this); var calls = 0; var failures = 1
            val settled = MutableStateFlow(false)
            val wiring = CoroutineScope(coroutineContext + Job())
            wiring.bindUpdateChannel(h.repository, MutableStateFlow(null), {
                calls++; if (failures-- > 0) throw failure(); capabilities(offer(bytes))
            }, settled) {}
            suspend fun settle() = repeat(5) { yield() }
            settle()
            assertEquals("Waits for the restore instead of retrying at once", 1, calls); assertEquals(UpdateState.Idle, h.repository.state.value)
            settled.value = true; settle()
            assertEquals(2, calls); assertEquals(UpdateState.Offered(offer(bytes), false, bytes.size.toLong()), h.repository.state.value)
            wiring.cancel()
            // A second failure is not retried again; the next capabilities check (resume, sign-in) offers instead.
            val stubborn = Harness(this); var tries = 0; val flips = MutableStateFlow(false)
            val again = CoroutineScope(coroutineContext + Job())
            again.bindUpdateChannel(stubborn.repository, MutableStateFlow(null), { tries++; throw failure() }, flips) {}
            settle(); flips.value = true; settle(); flips.value = false; settle(); flips.value = true; settle()
            assertEquals(2, tries); assertEquals(UpdateState.Idle, stubborn.repository.state.value)
            again.cancel()
        }
    }
    @Test fun `a blocked install is counted once per offer however often the player meets the block`() = runBlocking {
        // NATIVE_UPDATE_FAILED_PERMISSION is the funnel step that says how many players stop at the unknown-sources
        // setting. Coming back from Settings, or meeting the same block again after a grant was revoked, is the same player
        // at the same step: counting each would inflate the drop-off the owner reads.
        val h = Harness(this); h.sessions.permitted = false; h.repository.onCapabilities(capabilities(offer(bytes)))
        h.repository.startDownload()!!.join(); h.repository.install()!!.join()
        assertEquals(UpdateState.AwaitingPermission(offer(bytes), h.sessions.prompt), h.repository.state.value)
        assertNull("Back from Settings without the grant: nothing new happens", h.repository.onForeground())
        // Android reports the grant, but it is revoked before the installer runs: the same block, not a new failure.
        h.sessions.permitted = true; val resumed = h.repository.onForeground()!!; h.sessions.permitted = false; resumed.join()
        assertEquals(UpdateState.AwaitingPermission(offer(bytes), h.sessions.prompt), h.repository.state.value)
        h.sessions.permitted = true; h.repository.onForeground()!!.join()
        assertEquals(1, h.sessions.committed)
        assertEquals(listOf(UPDATE_OFFERED, UPDATE_DOWNLOADED, UPDATE_VERIFIED, UPDATE_FAILED_PERMISSION), h.events)
    }
    @Test fun `the next launch releases the installed APK before any capabilities answer`() = runBlocking {
        // Emulator acceptance: after code 61 installed, its 200 MB APK stayed in cache/updates, because cleanup ran only
        // when a later capabilities answer showed no offer, and the startup race skipped that answer. A file at or below
        // the running version can never be installed again, so the launch itself releases it, network or not. A newer
        // partial download stays so it resumes; the install marker still counts the install exactly once.
        val directory = Files.createTempDirectory("update-cache").toFile()
        try {
            val installed = File(directory, "26-${sha(bytes)}.apk").apply { writeBytes(bytes) }
            val older = File(directory, "25-${sha(bytes)}.apk.part").apply { writeBytes(bytes) }
            val stray = File(directory, "download.tmp").apply { writeBytes(bytes) }
            val newer = File(directory, "27-${"b".repeat(64)}.apk.part").apply { writeText("resume me") }
            val events = mutableListOf<NativeError>(); val marker = MemoryInstallMarker(26)
            val process = CoroutineScope(coroutineContext + Job())
            UpdateRepository(process, origin, { running(26) }, UpdateDownloader(directory), UpdateVerifier { null },
                UpdateInstaller(FakeSessions()), { false }, MutableStateFlow(true), marker, { events += it })
            process.coroutineContext[Job]!!.children.forEach { it.join() }
            assertFalse(installed.exists()); assertFalse(older.exists()); assertFalse(stray.exists()); assertTrue(newer.exists())
            assertEquals(listOf(UPDATE_INSTALLED), events); assertNull(marker.pendingVersionCode)
            process.cancel()
        } finally { directory.deleteRecursively() }
    }

    @Test fun `a public answer never clears or downgrades an offer a session-bound check produced`() = runBlocking {
        // Owner 2026-09-27 (Seeker, code 26): "tester does not update itself on my seeker". The server shows a tester row
        // only to a request carrying the tester's session; an answer fetched without it sees stable rows only. Letting that
        // answer overwrite the session-bound one makes the tester offer vanish (or fall back to an older stable row) purely
        // by which request lands last. Only the session-bound view may say the row is gone.
        val h = Harness(this)
        val stable = offer(bytes); val tester = offer(bytes, code = 27)
        h.repository.onCapabilities(capabilities(tester), sessionBound = true)
        assertEquals(UpdateState.Offered(tester, false, bytes.size.toLong()), h.repository.state.value)
        h.repository.onCapabilities(capabilities(null), sessionBound = false)
        assertEquals("A public answer without the row keeps the tester offer", UpdateState.Offered(tester, false, bytes.size.toLong()), h.repository.state.value)
        h.repository.onCapabilities(capabilities(stable), sessionBound = false)
        assertEquals("Nor does the older stable row replace it", UpdateState.Offered(tester, false, bytes.size.toLong()), h.repository.state.value)
        h.repository.onCapabilities(capabilities(null), sessionBound = true)
        assertEquals("The session-bound view withdrew the row", UpdateState.Idle, h.repository.state.value)
        // A mandatory tester row keeps orders paused through a public answer as well.
        h.repository.onCapabilities(capabilities(offer(bytes, code = 27, mandatory = true)), sessionBound = true)
        h.repository.onCapabilities(capabilities(null), sessionBound = false)
        assertTrue(h.repository.isMandatoryBlocking.value)
        // Only a session-bound offer is protected: a signed-out player's public offer is withdrawn by the next public answer.
        h.repository.onCallerChanged()
        h.repository.onCapabilities(capabilities(stable), sessionBound = false)
        assertEquals(UpdateState.Offered(stable, false, bytes.size.toLong()), h.repository.state.value)
        h.repository.onCapabilities(capabilities(null), sessionBound = false)
        assertEquals(UpdateState.Idle, h.repository.state.value)
    }
    @Test fun `an answer without a row never cancels or unpauses the public transfer the boot gate started`() = runBlocking {
        // Owner 2026-09-27: "a version that can no longer launch must still be able to update". The boot gate's mandatory
        // stable offer is downloading when the restore's session-bound check answers for a wallet that sees no row (or races
        // a withdrawal). Taking that answer as "the caller's own row replaces the public one" cancelled the transfer,
        // deleted its partial file and lifted the pause: the player walked past a mandatory update.
        val h = Harness(this); h.gate = CompletableDeferred()
        val stable = offer(bytes, mandatory = true)
        h.repository.onOffer(stable, sessionBound = false)
        val transfer = h.repository.prefetch()!!; yield()
        val discarded = h.discarded
        h.repository.onOffer(null, sessionBound = true)
        assertTrue("the transfer goes on", h.repository.state.value is UpdateState.Downloading && transfer.isActive)
        assertTrue("orders stay paused", h.repository.isMandatoryBlocking.value)
        assertEquals("its partial file is kept", discarded, h.discarded)
        // Nor may a public answer without the row lower the pause while the transfer runs: the boot screen would drop from
        // REQUIRED to an optional card whose LATER opens the game.
        h.repository.onOffer(null, sessionBound = false)
        assertTrue(h.repository.state.value is UpdateState.Downloading && transfer.isActive)
        assertTrue(h.repository.isMandatoryBlocking.value)
        h.gate!!.complete(Unit); transfer.join()
        assertEquals(UpdateState.ReadyToInstall(stable), h.repository.state.value); assertTrue(h.repository.isMandatoryBlocking.value)
    }
    @Test fun `returning to the foreground asks again for a row published while the process lives, at most once a minute`() = runBlocking {
        // Owner 2026-09-27 (Seeker, code 26): the code 27 tester row was published at 08:35:55Z. The one check per signed-in
        // wallet had run at the 08:33:38Z cold start, the warm start at 08:39:18Z asked nothing, and the offer never
        // appeared. Every return to the screen asks again, as that wallet; flicking between apps is not a request per flick.
        val h = Harness(this)
        val tester = offer(bytes, code = 27); var published: NativeUpdateOffer? = null
        var now = 0L; val asked = mutableListOf<String?>()
        val foreground = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val wiring = CoroutineScope(coroutineContext + Job())
        wiring.bindUpdateChannel(h.repository, MutableStateFlow<String?>("tester-wallet"), { caller -> asked += caller; capabilities(published) },
            foreground = foreground, clock = { now }) {}
        withTimeout(5_000) { foreground.subscriptionCount.first { it > 0 } }
        assertEquals(listOf<String?>("tester-wallet"), asked); assertEquals(UpdateState.Idle, h.repository.state.value)
        published = tester
        suspend fun returnAt(ms: Long) { now = ms; foreground.emit(Unit); repeat(5) { yield() } }
        returnAt(59_999)
        assertEquals("Within a minute of the last check nothing is asked", 1, asked.size)
        returnAt(60_000)
        assertEquals("The foreground check is the signed-in wallet's own", listOf<String?>("tester-wallet", "tester-wallet"), asked)
        assertEquals(UpdateState.Offered(tester, false, bytes.size.toLong()), h.repository.state.value)
        returnAt(119_999); assertEquals(2, asked.size)
        returnAt(120_000); assertEquals(3, asked.size)
        wiring.cancel()
    }
    @Test fun `the foreground check leaves a running transfer and the system installer alone`() = runBlocking {
        // A return to the screen mid-download must not stop or restart the transfer, and while Android's installer holds
        // the update nothing may be re-offered or withdrawn under it: the check waits until the install leaves its hands.
        val h = Harness(this, archive = ArchiveInfo(PACKAGE, 27, listOf(SIGNER)))
        val tester = offer(bytes, code = 27); var calls = 0; var now = 0L
        val foreground = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val wiring = CoroutineScope(coroutineContext + Job())
        wiring.bindUpdateChannel(h.repository, MutableStateFlow<String?>("tester-wallet"), { calls++; capabilities(tester) },
            foreground = foreground, clock = { now }) {}
        withTimeout(5_000) { foreground.subscriptionCount.first { it > 0 } }
        suspend fun returnAt(ms: Long) { now = ms; foreground.emit(Unit); repeat(5) { yield() } }
        h.gate = CompletableDeferred(); val transfer = h.repository.startDownload()!!; yield()
        returnAt(60_000)
        assertEquals("No check during the transfer", 1, calls); assertTrue(transfer.isActive)
        h.gate!!.complete(Unit); transfer.join()
        assertEquals(UpdateState.ReadyToInstall(tester), h.repository.state.value)
        h.repository.install()!!.join(); assertEquals(UpdateState.Installing(tester), h.repository.state.value)
        returnAt(120_000); assertEquals("No check while the system installer holds the install", 1, calls)
        h.repository.onInstallEvent(InstallEvent.PendingUserAction(SystemPrompt { }))
        returnAt(180_000); assertEquals(1, calls)
        h.repository.onInstallEvent(installEvent(PackageInstaller.STATUS_FAILURE_ABORTED, "INSTALL_FAILED_ABORTED", null))
        returnAt(240_000); assertEquals("Out of the installer's hands, the check runs again", 2, calls)
        wiring.cancel()
    }
}
