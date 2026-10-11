package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.internal.http2.ErrorCode
import okhttp3.internal.http2.StreamResetException
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class WorldContentTest {
    private fun hash(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString(""){"%02x".format(it)}
    private val artPath="atlas/fantasy/globe/realm-texture.png"
    private val bytes="pinned world pixels"
    private fun state(extra:Map<String,String> = emptyMap()):ContentState {
        val files=linkedMapOf(artPath to bytes).apply {putAll(extra)}
        return ContentState(catalogue=json("""{"simVersion":14,"sourceCommit":"${"a".repeat(40)}"}"""),
            renderCatalogue=buildJsonObject { put("fantasy",buildJsonObject {
                put("presentation",buildJsonObject {});put("globe",buildJsonObject {
                    put("files",buildJsonArray {files.forEach {(path,value)->add(buildJsonObject {
                        put("path",path);put("sha256",hash(value));put("size",value.length)
                    })}})
                })
            })})
    }
    private fun manifest(art:String=bytes,extra:Map<String,String> = emptyMap()):String {
        val files=sortedMapOf("catalogue.json" to "{}","render-catalog.json" to "{}","contracts.json" to "{}","atlas/meta.json" to "{}","kotlin/NativeContracts.kt" to "{}",artPath to art)
        files.putAll(extra)
        val entries=buildJsonArray{files.forEach{(path,value)->add(buildJsonObject{put("path",path);put("size",value.length);put("sha256",hash(value));put("tier",if(path.startsWith("atlas/fantasy/globe/"))"optional" else "core")})}}
        val identity=buildJsonObject{put("schemaVersion",1);put("sourceCommit","a".repeat(40));put("simVersion",14);put("files",entries)}
        return buildJsonObject{
            identity.forEach{(key,value)->put(key,value)};put("contentVersion",hash(identity.toString()))
            put("cataloguePath","catalogue.json");put("renderCataloguePath","render-catalog.json");put("contractPath","contracts.json");put("atlasMetadataPath","atlas/meta.json");put("kotlinModelsPath","kotlin/NativeContracts.kt")
        }.toString()
    }
    private fun fixture(availableBytes:(File)->Long = { it.usableSpace }, block:suspend (MockWebServer,WorldContent,FakeApiClient,File)->Unit) = runBlocking {
        val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trusted=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server=MockWebServer().apply{useHttps(tls.sslSocketFactory(),false);start()}
        val client=OkHttpClient.Builder().sslSocketFactory(trusted.sslSocketFactory(),trusted.trustManager).build()
        val root=Files.createTempDirectory("world-content-test").toFile();val api=FakeApiClient()
        api.onGet("/native/capabilities"){json("""{"protocolVersion":2,"simVersion":14,"contentManifestUrl":"${server.url("/content/manifest.json")}"}""")}
        try{block(server,WorldContent(root,server.url("/").toString(),transport=client,availableBytes=availableBytes),api,root)}finally{server.shutdown();root.deleteRecursively()}
    }
    @Test fun `optional content verifies once and reopens offline without account cookies`() = fixture {server,content,api,_->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody(bytes))
        val progress=mutableListOf<WorldContentProgress>()
        val first=content.acquire(state(),api,progress::add);assertEquals(bytes,File(first.directory,artPath).readText());first.close()
        assertEquals(listOf(WorldContentPhase.CHECKING_CACHE,WorldContentPhase.CHECKING_RELEASE,WorldContentPhase.DOWNLOADING,WorldContentPhase.VERIFYING,WorldContentPhase.READY),progress.map {it.phase})
        repeat(2){val request=server.takeRequest();assertEquals("GET",request.method);assertNull(request.getHeader("Cookie"))}
        api.onGet("/native/capabilities"){error("offline")}
        progress.clear()
        content.acquire(state(),api,progress::add).use{assertTrue(File(it.directory,artPath).isFile)}
        assertEquals(listOf(WorldContentPhase.CHECKING_CACHE,WorldContentPhase.READY),progress.map {it.phase})
        assertEquals(WorldContentProgress(WorldContentPhase.READY,1,1),progress.last())
        assertEquals(2,server.requestCount)
    }
    @Test fun `ground-only release reuses the verified globe offline without download progress`() = fixture {server,content,api,_->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody(bytes))
        val original=state()
        val directory=content.acquire(original,api).use { it.directory }
        val fantasy=original.renderCatalogue!!.getValue("fantasy").jsonObject
        val changed=original.copy(
            catalogue=json("""{"simVersion":14,"sourceCommit":"${"b".repeat(40)}"}"""),
            renderCatalogue=buildJsonObject { put("fantasy",buildJsonObject {
                fantasy.forEach { (key,value)->put(key,value) }
                put("ground",buildJsonObject { put("revision",2);put("sha256","c".repeat(64)) })
            }) },
        )
        api.onGet("/native/capabilities") { error("A ground release must not require online globe admission") }
        val progress=mutableListOf<WorldContentProgress>()
        content.acquire(changed,api,progress::add).use {
            assertEquals(directory,it.directory);assertEquals(bytes,File(it.directory,artPath).readText())
        }
        assertEquals(listOf(WorldContentPhase.CHECKING_CACHE,WorldContentPhase.READY),progress.map { it.phase })
        assertEquals(2,server.requestCount)
    }
    @Test fun `download progress credits only accepted files and readiness follows atomic activation`() = fixture {server,content,api,root->
        val extra=mapOf("atlas/fantasy/globe/surface-mask.png" to "accepted second file")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = MockResponse().setBody(when (request.path) {
                "/content/manifest.json" -> manifest(extra=extra)
                "/content/$artPath" -> bytes
                else -> extra.values.single()
            })
        }
        val progress=mutableListOf<WorldContentProgress>()
        content.acquire(state(extra),api) { step ->
            progress+=step
            if(step.phase==WorldContentPhase.READY)assertTrue("Ready is emitted only after the verified generation activates",File(root,"active").isFile)
            else assertFalse("Progress cannot make incomplete content renderable",File(root,"active").exists())
        }.close()
        assertEquals(listOf(0,1),progress.filter {it.phase==WorldContentPhase.DOWNLOADING}.map {it.verifiedFiles})
        assertEquals(WorldContentProgress(WorldContentPhase.READY,2,2),progress.last())
    }
    @Test fun `a corrupt file never earns verified progress and an explicit retry starts fresh`() = fixture {server,content,api,root->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody("wrong"))
        val progress=mutableListOf<WorldContentProgress>()
        assertThrows(IllegalArgumentException::class.java) {runBlocking {content.acquire(state(),api,progress::add)}}
        assertTrue(progress.all {it.verifiedFiles==0});assertTrue(progress.none {it.phase==WorldContentPhase.READY})
        assertFalse(File(root,"active").exists())
        progress.clear();server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody(bytes))
        content.acquire(state(),api,progress::add).close()
        assertEquals(WorldContentProgress(WorldContentPhase.CHECKING_CACHE,0,1),progress.first())
        assertEquals(WorldContentProgress(WorldContentPhase.READY,1,1),progress.last())
    }
    @Test fun `a newer manifest cannot replace the installed catalogue's globe pins`() = fixture {server,content,api,root->
        server.enqueue(MockResponse().setBody(manifest("changed")))
        assertThrows(IllegalArgumentException::class.java){runBlocking{content.acquire(state(),api)}}
        assertTrue(root.listFiles().orEmpty().none{it.name.matches(Regex("[a-f0-9]{64}"))});assertEquals(1,server.requestCount)
    }
    @Test fun `a truncated or corrupt download does not leave a renderable generation`() = fixture {server,content,api,root->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody("wrong"))
        assertThrows(IllegalArgumentException::class.java){runBlocking{content.acquire(state(),api)}}
        assertTrue(root.listFiles().orEmpty().none{it.name.matches(Regex("[a-f0-9]{64}"))})
    }
    @Test fun `leaving world cancels a stalled optional body and removes incomplete staging`() = fixture {server,content,api,root->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody(bytes).setBodyDelay(4,java.util.concurrent.TimeUnit.SECONDS))
        val progress=java.util.concurrent.CopyOnWriteArrayList<WorldContentProgress>()
        coroutineScope {
            val job=launch(Dispatchers.Default){content.acquire(state(),api,progress::add).close()}
            withContext(Dispatchers.IO){assertNotNull(server.takeRequest(5,java.util.concurrent.TimeUnit.SECONDS));assertNotNull(server.takeRequest(5,java.util.concurrent.TimeUnit.SECONDS))}
            withTimeout(1_000) {
                while(root.listFiles().orEmpty().filter{it.name.startsWith("prefetch-")}.none{it.listFiles().orEmpty().any(File::isFile)})delay(10)
            }
            withTimeout(2_000){job.cancelAndJoin()}
        }
        assertTrue(root.listFiles().orEmpty().none{it.name.startsWith("staging-")||it.name.startsWith("prefetch-")||it.name.matches(Regex("[a-f0-9]{64}"))})
        assertTrue(progress.none {it.phase==WorldContentPhase.READY || it.verifiedFiles>0})
    }
    @Test fun `viewer cancellation wins an HTTP2 reset before cancellation reaches the download child`():Unit = runBlocking {
        val operation=Job()
        val watcherCancelling=java.util.concurrent.CountDownLatch(1)
        val releaseWatcher=java.util.concurrent.CountDownLatch(1)
        // Hold cancellation in the earlier watcher, exactly where it closes HTTP calls in
        // production. The later download child is still active when its blocked read fails.
        val watcher=CoroutineScope(operation+Dispatchers.Default).launch(start=CoroutineStart.UNDISPATCHED) {
            suspendCancellableCoroutine<Unit> { waiting->waiting.invokeOnCancellation {
                watcherCancelling.countDown()
                check(releaseWatcher.await(5,java.util.concurrent.TimeUnit.SECONDS))
            } }
        }
        val download=Job(operation)
        val executor=java.util.concurrent.Executors.newSingleThreadExecutor()
        var cancellation:java.util.concurrent.Future<*>?=null
        try {
            assertThrows(CancellationException::class.java) {
                worldDownloadIO(operation,download) {
                    cancellation=executor.submit { operation.cancel() }
                    assertTrue(watcherCancelling.await(5,java.util.concurrent.TimeUnit.SECONDS))
                    assertFalse(operation.isActive)
                    assertTrue("Cancellation has not reached the download child yet",download.isActive)
                    throw StreamResetException(ErrorCode.CANCEL)
                }
            }
        } finally {
            releaseWatcher.countDown()
            try { cancellation?.get(5,java.util.concurrent.TimeUnit.SECONDS) }
            finally { operation.cancel();watcher.join();executor.shutdownNow() }
        }
    }
    @Test fun `an HTTP2 reset while the viewer remains active is still a transport failure`() {
        val operation=Job()
        val download=Job(operation)
        val reset=StreamResetException(ErrorCode.CANCEL)
        try {
            val thrown=assertThrows(StreamResetException::class.java) {
                worldDownloadIO(operation,download) { throw reset }
            }
            assertSame("An active viewer must see the original transport failure",reset,thrown)
            assertTrue(operation.isActive)
            assertTrue(download.isActive)
        } finally { operation.cancel() }
    }
    @Test fun `world downloads overlap three requests without unbounded concurrency or early activation`() = fixture {server,content,api,root->
        val extra=(1..5).associate { "atlas/fantasy/globe/part-$it.png" to "world part $it" }
        val requested=java.util.concurrent.atomic.AtomicInteger()
        val inFlight=java.util.concurrent.atomic.AtomicInteger()
        val peak=java.util.concurrent.atomic.AtomicInteger()
        val firstWave=java.util.concurrent.CountDownLatch(3)
        val release=java.util.concurrent.CountDownLatch(1)
        server.dispatcher=object : Dispatcher() {
            override fun dispatch(request:RecordedRequest):MockResponse {
                if(request.path=="/content/manifest.json")return MockResponse().setBody(manifest(extra=extra))
                requested.incrementAndGet()
                val active=inFlight.incrementAndGet();peak.accumulateAndGet(active,::maxOf)
                firstWave.countDown()
                try { check(release.await(5,java.util.concurrent.TimeUnit.SECONDS)) }
                finally {inFlight.decrementAndGet()}
                val path=requireNotNull(request.path).removePrefix("/content/")
                return MockResponse().setBody(if(path==artPath)bytes else extra.getValue(path))
            }
        }
        coroutineScope {
            val loading=async(Dispatchers.Default){content.acquire(state(extra),api)}
            try {
                assertTrue("Three downloads overlap before any body is released",withContext(Dispatchers.IO){firstWave.await(5,java.util.concurrent.TimeUnit.SECONDS)})
                assertEquals("The fourth request cannot start while all three download slots are occupied",3,requested.get())
                assertFalse("Unverified scratch files cannot activate",File(root,"active").exists())
            } finally {release.countDown()}
            loading.await().use {lease->
                assertEquals(bytes,File(lease.directory,artPath).readText())
                extra.forEach{(path,value)->assertEquals(value,File(lease.directory,path).readText())}
            }
        }
        assertEquals(3,peak.get())
        assertTrue(root.listFiles().orEmpty().none{it.name.startsWith("prefetch-")||it.name.startsWith("staging-")})
    }
    @Test fun `prefetched equal-length corruption still fails the authoritative content hash`() = fixture {server,content,api,root->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody("x".repeat(bytes.length)))
        val progress=java.util.concurrent.CopyOnWriteArrayList<WorldContentProgress>()
        assertThrows(IllegalArgumentException::class.java){runBlocking{content.acquire(state(),api,progress::add)}}
        assertFalse(File(root,"active").exists())
        assertTrue(progress.none{it.verifiedFiles>0||it.phase==WorldContentPhase.READY})
        assertTrue(root.listFiles().orEmpty().none{it.name.startsWith("prefetch-")||it.name.startsWith("staging-")||it.name.matches(Regex("[a-f0-9]{64}"))})
    }
    @Test fun `an oversized prefetched body is bounded by its pin and cleaned on failure`() = fixture {server,content,api,root->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody(bytes+"excess body"))
        assertThrows(IllegalArgumentException::class.java){runBlocking{content.acquire(state(),api)}}
        assertFalse(File(root,"active").exists())
        assertTrue(root.listFiles().orEmpty().none{it.name.startsWith("prefetch-")||it.name.startsWith("staging-")||it.name.matches(Regex("[a-f0-9]{64}"))})
    }

    @Test fun `cancellation at READY releases the new generation before the caller can own it`() = fixture {server,content,api,root->
        val advertised=java.util.concurrent.atomic.AtomicReference<Map<String,String>>(emptyMap())
        server.dispatcher=object : Dispatcher() {
            override fun dispatch(request:RecordedRequest):MockResponse {
                val extra=advertised.get()
                val body=when(request.path) {
                    "/content/manifest.json"->manifest(extra=extra)
                    "/content/$artPath"->bytes
                    else->extra.getValue(requireNotNull(request.path).removePrefix("/content/"))
                }
                return MockResponse().setBody(body)
            }
        }
        var cancelledVersion:String?=null
        var delivered=false
        coroutineScope {
            val loading=launch(Dispatchers.Default) {
                val viewer=currentCoroutineContext().job
                content.acquire(state(),api) {progress->
                    if(progress.phase==WorldContentPhase.READY) {
                        cancelledVersion=File(root,"active").readText()
                        viewer.cancel()
                    }
                }.use {delivered=true}
            }
            loading.join()
            assertTrue(loading.isCancelled)
        }
        assertNotNull(cancelledVersion)
        assertFalse("A closing viewer must not receive a retained lease",delivered)
        // Move beyond active + previous. An unclosed lease would keep this obsolete generation
        // forever; normal content pruning is the externally observable ownership contract.
        listOf("second","third","fourth").forEach {revision->
            val extra=mapOf("atlas/fantasy/globe/revision.png" to revision)
            advertised.set(extra)
            content.acquire(state(extra),api).close()
        }
        assertFalse("Cancelled handoff must not pin an obsolete world generation",File(root,requireNotNull(cancelledVersion)).exists())
    }
    @Test fun `cancellation on a cached READY handoff never transfers a lease to the closed viewer`() = fixture {server,content,api,_->
        server.enqueue(MockResponse().setBody(manifest()));server.enqueue(MockResponse().setBody(bytes))
        content.acquire(state(),api).close()
        api.onGet("/native/capabilities"){error("A cached world must not need the network")}
        var delivered=false
        coroutineScope {
            val loading=launch(Dispatchers.Default) {
                val viewer=currentCoroutineContext().job
                content.acquire(state(),api) {progress->if(progress.phase==WorldContentPhase.READY)viewer.cancel()}.use {delivered=true}
            }
            loading.join()
            assertTrue(loading.isCancelled)
        }
        assertFalse(delivered)
        content.acquire(state(),api).use {assertEquals(bytes,File(it.directory,artPath).readText())}
        assertEquals(2,server.requestCount)
    }

    private val regionPath="atlas/fantasy/globe/generated/heartlands-detail.png"
    private val chainColor="atlas/fantasy/globe/generated/aurora-detail.png"
    private val chainMask="atlas/fantasy/globe/generated/aurora-detail-mask.png"
    private val optional=linkedMapOf(regionPath to "regional pixels",chainColor to "island color",chainMask to "island mask")
    private fun groupedState():ContentState {
        val old=state(optional)
        val fantasy=old.renderCatalogue!!.getValue("fantasy").jsonObject
        return old.copy(renderCatalogue=buildJsonObject { put("fantasy",buildJsonObject {
            fantasy.forEach { (key,value)->put(key,value) }
            put("presentation",json("""{"regionalDetails":[{"id":"heartlands"}],"chains":[{"id":"aurora"}]}"""))
        }) })
    }
    private fun serveGroups(server:MockWebServer, override:(String)->String?={null}) {
        server.dispatcher=object:Dispatcher() {
            override fun dispatch(request:RecordedRequest):MockResponse {
                val path=request.path!!.removePrefix("/content/")
                val value=override(path) ?: if(path=="manifest.json")manifest(extra=optional) else if(path==artPath)bytes else optional.getValue(path)
                return MockResponse().setBody(value)
            }
        }
    }
    @Test fun `overview opens without optional transfers and regions and atomic chains reopen offline`() = fixture {server,content,api,root->
        serveGroups(server)
        val progress=mutableListOf<WorldContentProgress>()
        content.open(groupedState(),api,progress::add).use { world ->
            assertEquals("Only the release and overview may delay first draw",2,server.requestCount)
            assertEquals(bytes,File(world.overview.directory,artPath).readText())
            assertFalse(File(world.overview.directory,regionPath).exists())
            assertEquals(1,progress.last().totalFiles)
            withContext(Dispatchers.IO) { world.assets.acquire("region-heartlands") {}.use {
                assertEquals(optional.getValue(regionPath),it.directory.child(regionPath).readString())
            } }
            assertEquals(4,server.requestCount)
            withContext(Dispatchers.IO) { world.assets.acquire("chain-aurora") {}.use {
                assertEquals(optional.getValue(chainColor),it.directory.child(chainColor).readString())
                assertEquals(optional.getValue(chainMask),it.directory.child(chainMask).readString())
                assertTrue(File(root,"groups/chain-aurora/active").isFile)
            } }
        }
        assertEquals(7,server.requestCount)
        api.onGet("/native/capabilities") { error("All requested groups must reopen offline") }
        content.open(groupedState(),api).use { world -> withContext(Dispatchers.IO) {
            world.assets.acquire("region-heartlands") {}.close();world.assets.acquire("chain-aurora") {}.close()
        } }
        assertEquals(7,server.requestCount)
    }
    @Test fun `failed chain never activates half a mask and overview remains usable for retry`() = fixture {server,content,api,root->
        serveGroups(server) { if(it==chainMask)"x".repeat(optional.getValue(chainMask).length) else null }
        content.open(groupedState(),api).use { world ->
            withContext(Dispatchers.IO) { assertThrows(IllegalArgumentException::class.java) { world.assets.acquire("chain-aurora") {} } }
            assertFalse(File(root,"groups/chain-aurora/active").exists())
            assertEquals(bytes,File(world.overview.directory,artPath).readText())
            serveGroups(server)
            withContext(Dispatchers.IO) { world.assets.acquire("chain-aurora") {}.use { assertTrue(it.directory.child(chainMask).exists()) } }
            assertEquals(bytes,File(world.overview.directory,artPath).readText())
        }
    }
    @Test fun `corrupt cached mask repairs only that pin without redownloading healthy group files`() = fixture {server,content,api,root->
        serveGroups(server)
        var directory:File?=null
        content.open(groupedState(),api).use { world -> withContext(Dispatchers.IO) {
            world.assets.acquire("chain-aurora") {}.use { directory=it.directory.file() }
        } }
        content.awaitLeaseReleases()
        // No filesystem mutation while a renderer still owns this group.
        val mask=File(requireNotNull(directory),chainMask)
        mask.writeText("corrupt")
        val requested=java.util.concurrent.CopyOnWriteArrayList<String>()
        serveGroups(server) { requested+=it;null }
        content.open(groupedState(),api).use { world ->
            withContext(Dispatchers.IO) { world.assets.acquire("chain-aurora") {}.use {
                assertEquals(optional.getValue(chainMask),it.directory.child(chainMask).readString())
                assertEquals(optional.getValue(chainColor),it.directory.child(chainColor).readString())
            } }
            assertEquals(bytes,File(world.overview.directory,artPath).readText())
        }
        assertEquals(listOf("manifest.json",chainMask),requested.toList())
        assertTrue(File(root,"groups/overview/active").isFile)
    }
    @Test fun `cancelling a stalled regional acquisition preserves overview and permits a later request`() = fixture {server,content,api,root->
        serveGroups(server)
        content.open(groupedState(),api).use { world -> coroutineScope {
            val started=java.util.concurrent.CountDownLatch(1)
            server.dispatcher=object:Dispatcher() {
                override fun dispatch(request:RecordedRequest):MockResponse {
                    if(request.path=="/content/manifest.json")return MockResponse().setBody(manifest(extra=optional))
                    started.countDown()
                    return MockResponse().setBody(optional.getValue(regionPath)).setBodyDelay(4,java.util.concurrent.TimeUnit.SECONDS)
                }
            }
            val request=async(Dispatchers.IO) { runCatching { world.assets.acquire("region-heartlands") {} } }
            assertTrue(withContext(Dispatchers.IO) { started.await(5,java.util.concurrent.TimeUnit.SECONDS) })
            world.assets.cancelPending()
            val result=withTimeout(2_000) { request.await() }
            assertTrue(result.exceptionOrNull() is CancellationException)
            assertFalse(File(root,"groups/region-heartlands/active").exists())
            assertEquals(bytes,File(world.overview.directory,artPath).readText())
            serveGroups(server)
            withContext(Dispatchers.IO) { world.assets.acquire("region-heartlands") {}.close() }
        } }
    }
    @Test fun `low storage refuses missing detail while a warm overview stays available`() {
        val space=java.util.concurrent.atomic.AtomicLong(Long.MAX_VALUE)
        fixture(availableBytes={space.get()}) { server,content,api,root->
            serveGroups(server)
            content.open(groupedState(),api).close();content.awaitLeaseReleases()
            space.set(0)
            val requested=java.util.concurrent.CopyOnWriteArrayList<String>()
            serveGroups(server) { requested+=it;null }
            content.open(groupedState(),api).use { world->
                assertEquals(bytes,File(world.overview.directory,artPath).readText())
                withContext(Dispatchers.IO) { assertThrows(IllegalArgumentException::class.java) { world.assets.acquire("region-heartlands") {} } }
                assertEquals(bytes,File(world.overview.directory,artPath).readText())
            }
            assertEquals(listOf("manifest.json"),requested.toList())
            assertTrue(File(root,"groups/overview/active").isFile)
            assertFalse(File(root,"groups/region-heartlands/active").exists())
        }
    }

}
