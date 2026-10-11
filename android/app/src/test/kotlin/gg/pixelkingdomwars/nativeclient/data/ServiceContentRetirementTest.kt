package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetLease
import kotlinx.coroutines.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream

/** MS-C interface 505a2b5e377bcadb314837c2097ee13ccc36107eefa68d5f66996e1ce8274a6a.
 * The manual boundary stands for C's open ticket / B's listener drain. This suite
 * tests A's source lifetime only; it does not claim to test the sink or Main host. */
class ServiceContentRetirementTest {
    private class Retirement : ServiceContentRetirement {
        override var requested = false
            private set
        private val completion = CompletableDeferred<Unit>()
        val sources = mutableListOf<Pair<() -> Unit, () -> Unit>>()
        private val before = mutableListOf<() -> Unit>()
        var onRegister: (() -> Unit)? = null
        var physicalCalls = 0
            private set
        override fun registerSource(revoke: () -> Unit, close: () -> Unit) {
            check(!completion.isCompleted)
            sources += revoke to close
            onRegister?.invoke()
            if (requested) revoke()
        }
        override fun beforeSourceClose(close: () -> Unit) { before += close }
        override fun requestRetirement(): Deferred<Unit> {
            if (!requested) {
                requested = true
                sources.toList().forEach { it.first() }
            }
            return completion
        }
        fun finishAfterInvalidation() {
            if (completion.isCompleted) return
            check(requested)
            before.forEach { it() }
            sources.forEach { physicalCalls++; it.second() }
            completion.complete(Unit)
        }
    }

    private fun lifetime(source: ServiceContentSession): Job = ServiceContentSession::class.java
        .getDeclaredField("lifetime").apply { isAccessible = true }.get(source) as Job

    private fun withPending(coordinated: Boolean = true,
                            block: suspend (Job, Retirement, ServiceContentSession, Job) -> Unit) = runBlocking {
        val owner = SupervisorJob()
        val retirement = Retirement()
        val entered = CompletableDeferred<Job>()
        val attempts = AtomicInteger()
        val acquire: suspend (String, () -> Unit) -> ServiceAssetLease = { _, _ ->
            if (attempts.incrementAndGet() != 1) throw AssertionError("Rejected acquisition reached source")
            entered.complete(currentCoroutineContext().job)
            awaitCancellation()
        }
        val source = if (coordinated) ServiceContentSession(owner, {}, null, retirement, acquire)
            else ServiceContentSession(owner, {}, null, acquire)
        val waiting = async(Dispatchers.IO) { runCatching { source.assets.acquire("pe_workshop_t1") {} } }
        try {
            val acquisition = withTimeout(2_000) { entered.await() }
            block(owner, retirement, source, acquisition)
        } finally {
            source.close()
            if (coordinated) { retirement.requestRetirement(); retirement.finishAfterInvalidation() }
            owner.cancel()
            // Cleanup remains bounded even when the implementation under test fails to cancel.
            lifetime(source).cancel()
            withTimeout(2_000) { waiting.await() }
        }
    }


    @Test fun `active cancellation leaves the owner alive and admits a later acquisition`() = runBlocking {
        val owner = SupervisorJob(); val retirement = Retirement()
        val entered = CompletableDeferred<Job>(); val calls = AtomicInteger(); val releases = AtomicInteger()
        val source = ServiceContentSession(owner, {}, null, retirement) { _, _ ->
            if (calls.incrementAndGet() == 1) {
                entered.complete(currentCoroutineContext().job)
                awaitCancellation()
            }
            ServiceAssetLease(FileHandle(File("synthetic-not-opened"))) { releases.incrementAndGet() }
        }
        val waiting = async(Dispatchers.IO) { runCatching { source.assets.acquire("first") {} } }
        try {
            val acquisition = withTimeout(2_000) { entered.await() }
            source.assets.cancelPending()
            assertTrue(acquisition.isCancelled)
            assertTrue(withTimeout(2_000) { waiting.await().exceptionOrNull() } is CancellationException)
            assertFalse(retirement.requested); assertTrue(owner.isActive); assertTrue(source.assets.isCurrent())
            source.assets.acquire("second") {}.close()
            assertEquals(2, calls.get()); assertEquals(1, releases.get())
            assertTrue(source.assets.isCurrent())
        } finally {
            source.close(); retirement.finishAfterInvalidation(); lifetime(source).cancel(); owner.cancel()
            withTimeout(2_000) { waiting.await() }
        }
    }

    @Test fun `duplicate active renderer and fragment cancellation does not retire the source`() = withPending { owner, retirement, source, acquisition ->
        source.assets.cancelPending(); source.assets.cancelPending()
        assertTrue(acquisition.isCancelled)
        assertTrue(owner.isActive); assertTrue(source.assets.isCurrent()); assertFalse(retirement.requested)
        assertEquals(0, retirement.physicalCalls)
    }

    @Test fun `logically revoked active owner defers cancellation until unconditional physical close`() = withPending { _, retirement, source, acquisition ->
        retirement.sources.single().first()
        source.assets.cancelPending(); source.assets.cancelPending()
        assertTrue(acquisition.isActive)
        retirement.requestRetirement(); retirement.finishAfterInvalidation(); retirement.finishAfterInvalidation()
        assertTrue(acquisition.isCancelled); assertEquals(1, retirement.physicalCalls)
    }

    @Test fun `inactive owner pending cancellation waits for the registered physical close`() = withPending { owner, retirement, source, acquisition ->
        owner.cancel(); source.assets.cancelPending()
        assertTrue(acquisition.isActive)
        retirement.requestRetirement(); retirement.finishAfterInvalidation()
        assertTrue(acquisition.isCancelled); assertEquals(1, retirement.physicalCalls)
    }

    @Test fun `owner cancellation fences immediately but physical acquisition waits for invalidation`() = withPending { owner, retirement, source, acquisition ->
        owner.cancel()
        assertFalse(source.assets.isCurrent())
        assertTrue(acquisition.isActive)
        assertThrows(CancellationException::class.java) { source.assets.acquire("pe_workshop_t1") {} }
        retirement.requestRetirement()
        assertTrue(acquisition.isActive)
        retirement.finishAfterInvalidation()
        assertTrue(acquisition.isCancelled)
        assertEquals(1, retirement.physicalCalls)
    }

    @Test fun `explicit close requests retirement without cancelling physical work`() = withPending { _, retirement, source, acquisition ->
        source.close()
        assertTrue(retirement.requested)
        assertFalse(source.assets.isCurrent())
        assertTrue(acquisition.isActive)
        assertThrows(CancellationException::class.java) { source.assets.acquire("pe_workshop_t1") {} }
        retirement.finishAfterInvalidation()
        assertTrue(acquisition.isCancelled)
    }

    @Test fun `pending cancellation during retirement cannot bypass the listener drain`() = withPending { _, retirement, source, acquisition ->
        retirement.requestRetirement()
        source.assets.cancelPending()
        assertTrue(acquisition.isActive)
        retirement.finishAfterInvalidation()
        assertTrue(acquisition.isCancelled)
    }

    @Test fun `duplicate closes retain one registration and one physical cleanup`() = withPending { _, retirement, source, acquisition ->
        source.close(); source.close()
        val first = retirement.requestRetirement()
        assertSame(first, retirement.requestRetirement())
        assertEquals(1, retirement.sources.size)
        assertFalse(first.isCompleted)
        assertTrue(acquisition.isActive)
        retirement.finishAfterInvalidation(); retirement.finishAfterInvalidation(); source.close()
        assertTrue(first.isCompleted)
        assertEquals(1, retirement.physicalCalls)
        assertTrue(acquisition.isCancelled)
    }

    @Test fun `logical revocation does not require physical close to refuse new work`() = withPending { _, retirement, source, acquisition ->
        retirement.sources.single().first()
        assertFalse(source.assets.isCurrent())
        assertThrows(CancellationException::class.java) { source.assets.acquire("pe_workshop_t1") {} }
        assertTrue(acquisition.isActive)
        retirement.requestRetirement(); retirement.finishAfterInvalidation()
    }

    @Test fun `each acquisition checkpoint observes owner request and logical revocation`() = runBlocking {
        for (mode in listOf("owner", "request", "revoke")) {
            val owner = SupervisorJob(); val retirement = Retirement()
            val entered = CompletableDeferred<Job>(); val resume = CompletableDeferred<Unit>()
            val source = ServiceContentSession(owner, {}, null, retirement) { _, checkpoint ->
                entered.complete(currentCoroutineContext().job)
                resume.await()
                checkpoint()
                error("Retired checkpoint returned: $mode")
            }
            val waiting = async(Dispatchers.IO) { runCatching { source.assets.acquire("pe_workshop_t1") {} } }
            try {
                val acquisition = withTimeout(2_000) { entered.await() }
                when (mode) {
                    "owner" -> owner.cancel()
                    "request" -> retirement.requestRetirement()
                    "revoke" -> retirement.sources.single().first()
                }
                assertTrue(acquisition.isActive)
                resume.complete(Unit)
                val failure = withTimeout(2_000) { waiting.await().exceptionOrNull() }
                assertTrue("Checkpoint did not refuse $mode", failure is CancellationException)
                assertTrue(lifetime(source).isActive)
            } finally {
                source.close(); retirement.requestRetirement(); retirement.finishAfterInvalidation()
                lifetime(source).cancel(); owner.cancel()
                withTimeout(2_000) { waiting.await() }
            }
        }
    }

    @Test fun `registered physical close is idempotent and does not request itself again`() = withPending { _, retirement, source, acquisition ->
        val completed = AtomicInteger()
        lifetime(source).invokeOnCompletion { completed.incrementAndGet() }
        retirement.requestRetirement()
        val physical = retirement.sources.single().second
        physical(); physical()
        assertTrue(acquisition.isCancelled)
        withTimeout(2_000) { lifetime(source).join() }
        assertEquals(1, completed.get())
        assertEquals(1, retirement.sources.size)
    }

    @Test fun `cancelled owner construction registers a dark source for deferred cleanup`() {
        val owner = SupervisorJob().apply { cancel() }
        val retirement = Retirement().apply { requestRetirement() }
        val source = ServiceContentSession(owner, {}, null, retirement) { _, _ -> error("Dead owner acquired") }
        try {
            assertEquals(1, retirement.sources.size)
            assertFalse(source.assets.isCurrent())
            assertTrue(lifetime(source).isActive)
            assertThrows(CancellationException::class.java) { source.assets.acquire("pe_workshop_t1") {} }
        } finally { source.close(); retirement.finishAfterInvalidation() }
        assertTrue(lifetime(source).isCancelled)
        assertEquals(1, retirement.physicalCalls)
    }

    @Test fun `retirement racing registration revokes before the source can escape`() {
        val owner = SupervisorJob()
        val retirement = Retirement().apply { onRegister = { requestRetirement() } }
        val source = ServiceContentSession(owner, {}, null, retirement) { _, _ -> error("Retired source acquired") }
        try {
            assertTrue(retirement.requested)
            assertFalse(source.assets.isCurrent())
            assertTrue(lifetime(source).isActive)
        } finally { source.close(); retirement.finishAfterInvalidation(); owner.cancel() }
        assertEquals(1, retirement.physicalCalls)
    }

    @Test fun `source retirement preserves an independently retained renderer lease`() {
        val owner = SupervisorJob(); val retirement = Retirement(); val releases = AtomicInteger()
        val root = Files.createTempDirectory("retirement-held-lease").toFile()
        val source = ServiceContentSession(owner, {}, null, retirement) { _, checkpoint ->
            checkpoint(); ServiceAssetLease(FileHandle(root)) { releases.incrementAndGet() }
        }
        try {
            val lease = source.assets.acquire("pe_workshop_t1") {}
            source.close(); retirement.finishAfterInvalidation()
            assertEquals(0, releases.get())
            assertTrue(lease.directory.file().isDirectory)
            lease.close(); lease.close()
            assertEquals(1, releases.get())
        } finally { source.close(); retirement.finishAfterInvalidation(); owner.cancel(); root.deleteRecursively() }
    }

    @Test fun `legacy owner cancellation still cancels acquisition immediately`() = withPending(coordinated = false) { owner, _, source, acquisition ->
        owner.cancel()
        assertFalse(source.assets.isCurrent())
        assertTrue(acquisition.isCancelled)
    }

    @Test fun `legacy close still cancels acquisition immediately`() = withPending(coordinated = false) { _, _, source, acquisition ->
        source.close()
        assertFalse(source.assets.isCurrent())
        assertTrue(acquisition.isCancelled)
    }

    private object Pack {
        val root = File("../test-fixtures/candidate-6f7a9e81-sim18-r17-fleet-vehicle")
        val catalogue = Json.parseToJsonElement(File(root, "catalogue.json").readText()).jsonObject
        val render = Json.parseToJsonElement(GZIPInputStream(File(root, "render-catalog.json.gz").inputStream())
            .bufferedReader(Charsets.UTF_8).use { it.readText() }).jsonObject
        val manifest = nativeContentManifest(Json.parseToJsonElement(File(root, "manifest.json").readText()).jsonObject, 18)
        val state get() = ContentState(assets = root, catalogue = catalogue, renderCatalogue = render, manifest = manifest)
    }

    @Test fun `public opt in open registers its source before returning`() = runBlocking {
        val owner = SupervisorJob(); val retirement = Retirement()
        val root = Files.createTempDirectory("retirement-open").toFile()
        val content = ServiceContent(root, "https://localhost/")
        try {
            val source = content.open(Pack.state, FakeApiClient(), owner, retirement) {}
            assertEquals(1, retirement.sources.size)
            assertTrue(source.assets.isCurrent())
            source.close()
            assertTrue(retirement.requested)
            assertTrue(lifetime(source).isActive)
            retirement.finishAfterInvalidation()
            assertTrue(lifetime(source).isCancelled)
        } finally { retirement.requestRetirement(); retirement.finishAfterInvalidation(); owner.cancel(); root.deleteRecursively() }
    }

    @Test fun `late partial open after retirement never publishes and closes once after drain`() = runBlocking {
        val owner = SupervisorJob(); val retirement = Retirement().apply { onRegister = { requestRetirement() } }
        val root = Files.createTempDirectory("retirement-late-open").toFile()
        val content = ServiceContent(root, "https://localhost/")
        try {
            val failure = runCatching { content.open(Pack.state, FakeApiClient(), owner, retirement) {} }.exceptionOrNull()
            assertTrue(failure is CancellationException)
            assertEquals(1, retirement.sources.size)
            assertEquals(0, retirement.physicalCalls)
            assertFalse(retirement.requestRetirement().isCompleted)
            retirement.finishAfterInvalidation(); retirement.finishAfterInvalidation()
            assertEquals(1, retirement.physicalCalls)
        } finally { retirement.requestRetirement(); retirement.finishAfterInvalidation(); owner.cancel(); root.deleteRecursively() }
    }
}
