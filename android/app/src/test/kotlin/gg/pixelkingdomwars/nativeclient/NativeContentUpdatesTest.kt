package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.content.*
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class NativeContentUpdatesTest {
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private class Pack(val manifest: JsonObject, val files: Map<String,String>)
    private val clip="""{"key":"body","atlasPath":"atlas/meta.json","frames":[["f1","f2"]],"rowOrder":["s"],"fps":10,"anchor":[0.5,0.5],"scale":1,"cellWidth":1,"cellHeight":1,"loop":false}"""
    private val basePresentation="""{"version":1,"tilePixels":64,"workingTypes":[],"wareTypes":[],"legacyIdleTypes":[],"idleState":"idle","workState":"work","buildState":"build","levelupState":"levelup","buildLoop":false,"jobs":{"travelMs":1,"gate":{"tileX":1,"offsetX":0,"offsetY":0},"site":{"offsetX":0,"offsetY":0},"scaffold":$clip,"builderByKeepLevel":{"1":{"walk":$clip,"attack":$clip}},"actorDepthOffset":0,"structureDepthOffset":0,"structureDepthScale":1}}"""
    private val currentRender by lazy { Json.parseToJsonElement(File("src/main/assets/native/render-catalog.json").readText()).jsonObject }
    // Synthetic metadata for updater state tests, not evidence that any kit pixels are installed.
    // Historical renderer-boundary cases retain their headers and combat rules, but all usable
    // generations now declare accepted kit ground. The authentic bundle test verifies the bytes.
    private val kitGround by lazy {
        val ground=currentRender.getValue("ground").jsonObject
        JsonObject(ground+("currentVisual" to JsonObject(ground.getValue("currentVisual").jsonObject+
            mapOf("artVersion" to JsonPrimitive(2),"groundRevision" to JsonPrimitive(5)))))
    }
    private val acceptedKits by lazy { buildJsonObject {
        put("version",1);put("status","accepted")
        put("manifests",buildJsonArray { kitGround.getValue("realms").jsonArray.forEach { realm ->
            val digest=hash("synthetic-kit:${realm.jsonPrimitive.content}")
            add(buildJsonObject { put("realmId",realm);put("sha256",digest)
                put("manifestPath","atlas/fantasy/layered-ground/$digest/manifest.json");put("size",1) })
        } })
    } }
    private fun render(renderer:Int,brokenHowl:Boolean=false,missingMotion:String?=null):String {
        val howl="""{"bodyState":"howl","releaseFrame":2,"target":"currentActorAtRelease","offsetX":0,"offsetY":0,"depthOffset":-1,"facing":"retainUnlessAimed","ownedCancellation":true,"clip":$clip${if(brokenHowl) "" else ",\"aim\":{\"minimumDeltaSquared\":0.25,\"retainWithinDegrees\":32.5}"}}"""
        val aim="""{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5}"""
        val leap="""{"bodyState":"leap","durationMs":200,"heightRatio":0.3,"positionSnapDistance":1,"position":"castToEventTargetParabola","easing":"linear","depth":"groundY","ordinaryPosition":"preserveBodyAndCounter","facing":"retainUnlessAimed","missingTarget":"snapOnly","ownedCancellation":true,"aim":$aim}"""
        val lunge="""{"bodyState":"lunge","position":"nextDeliveredPositionSnap","landing":"standOnDelivery","facing":"retainUnlessAimed","missingTarget":"snapOnly","aim":$aim}"""
        val motion=if(renderer>=11) (if(missingMotion=="leap") "" else ",\"leap\":$leap")+
            (if(missingMotion=="lunge") "" else ",\"lunge\":$lunge") else ""
        val clips=if(renderer>=11) """{"howl":$clip,"leap":$clip,"lunge":$clip,"prowl":$clip,"rend":$clip,"death":$clip}""" else """{"howl":$clip}"""
        val profile=if(renderer>=11) """{"stand":"prowl","move":"prowl","death":"death","melee":{"troop":"rend","building":"rend"}}""" else "{}"
        val actors=if(renderer>=10) """[{"type":"gloamfang","frameKey":"wolf","atlasPath":"atlas/meta.json","scale":1,"combat":{"clips":$clips,"profile":$profile,"howl":$howl$motion}}]""" else "[]"
        // Contract14 requires the actual admitted ground schema and shared loop speed.
        val base=if(renderer>=14) JsonObject(Json.parseToJsonElement(basePresentation).jsonObject +
            ("buildingLoopSpeed" to currentRender.getValue("basePresentation").jsonObject.getValue("buildingLoopSpeed"))).toString() else basePresentation
        val ground=",\"ground\":$kitGround,\"layeredGroundV5\":$acceptedKits"
        val services=if(renderer>=15) ",\"phaseE\":${currentRender.getValue("phaseE")}" else ""
        return """{"schemaVersion":1,"rendererContractVersion":$renderer,"entries":[],"actors":$actors,"terrain":{"frameKey":"land","atlasPath":"atlas/meta.json","scale":1}${if(renderer>=5) ",\"basePresentation\":$base" else ""}$ground$services}"""
    }
    private fun pack(marker: String, renderer: Int = 2, advertiseRenderer: Boolean = true, renderText:String=render(renderer), optionalFiles:Map<String,String> = emptyMap(), sim:Int=14): Pack {
        val files = sortedMapOf("atlas/meta.json" to "{}", "catalogue.json" to """{"schemaVersion":1,"simVersion":$sim,"marker":"$marker"}""",
            "contracts.json" to "{}", "kotlin/NativeContracts.kt" to "// inert source provenance",
            "render-catalog.json" to renderText).apply { putAll(optionalFiles) }
        val pins = files.map { (path,bytes) -> buildJsonObject {
            put("path",path);put("sha256",hash(bytes));put("size",bytes.toByteArray().size);put("tier",if(path in optionalFiles) "optional" else "core")
        } } + if(renderer>=15) currentRender.getValue("phaseE").jsonObject.getValue("groups").jsonArray.flatMap { group ->
            group.jsonObject.getValue("files").jsonArray.map { pin -> JsonObject(pin.jsonObject + ("tier" to JsonPrimitive("optional"))) }
        } else emptyList()
        val entries = JsonArray(pins.sortedBy { it.getValue("path").jsonPrimitive.content })
        val identity = buildJsonObject { put("schemaVersion",1);put("sourceCommit","a".repeat(40));put("simVersion",sim);put("files",entries) }
        val manifest = buildJsonObject {
            identity.forEach { (k,v) -> put(k,v) };put("contentVersion",hash(identity.toString()))
            if(advertiseRenderer) put("rendererContractVersion",renderer)
            put("cataloguePath","catalogue.json");put("renderCataloguePath","render-catalog.json")
            put("atlasMetadataPath","atlas/meta.json");put("contractPath","contracts.json");put("kotlinModelsPath","kotlin/NativeContracts.kt")
        }
        return Pack(manifest,files)
    }
    private fun burrowRender(unit:String,missing:String?=null):String {
        val body=Json.parseToJsonElement(clip).jsonObject
        val keyed=JsonObject(body+mapOf("fxCues" to buildJsonArray { add(buildJsonObject {
            put("fx","soil");put("frames",buildJsonArray { add(1) });put("effectKey","soil")
        }) }))
        val motion=buildJsonObject {
            put("controller","v2Burrow");put("enterState","burrow");put("tunnelState","tunnel");put("surfaceState","surface")
            put("positionSnapDistance",1);put("aim",buildJsonObject { put("minimumDeltaSquared",0.25);put("retainWithinDegrees",32.5) })
            put("soilDepthOffset",-1);put("movement","linearPreserveVerb");put("enterMovement","retain")
            put("emergeMovement","coordinatesKillRetainMovingFlagOtherwiseRetain");put("identicalRegistration","preservePhaseAndCallbacks")
            put("rowRegistration","preservePhaseReplaceCallbacks");put("soilOwnership","scene");put("coldPrefix","stableBurrowOrEmergeWithoutHistoricalCues")
        }
        val combat=buildJsonObject {
            if(missing!="controller") put("burrowMotion",motion)
            put("profile",buildJsonObject { put("stand","idle");put("move","walk");put("death","death");put("hit","hit")
                put("melee",buildJsonObject { put("troop","attack");put("building","attack") })
                put("burrow",buildJsonObject { put("enter","burrow");put("tunnel","tunnel");put("surface","surface") }) })
            put("clips",buildJsonObject {
                put("burrow",keyed);if(missing!="surface") put("surface",keyed)
                put("tunnel",JsonObject(body+("loop" to JsonPrimitive(true))))
                for(state in listOf("idle","walk","death","attack","hit"))if(state!=missing)put(state,body)
            })
            put("effects",buildJsonObject { put("soil",body) })
        }
        val source=Json.parseToJsonElement(render(12)).jsonObject
        val actor=buildJsonObject { put("type",unit);put("frameKey","digger");put("atlasPath","atlas/meta.json");put("scale",1);put("combat",combat) }
        return JsonObject(source+("actors" to JsonArray(source.getValue("actors").jsonArray+actor))).toString()
    }
    private fun withServer(block: (MockWebServer,OkHttpClient,File)->Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(),false);start() }
        val client = OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(),clientTls.trustManager)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
        val directory = Files.createTempDirectory("native-update-test").toFile()
        try { block(server,client,directory) } finally { server.shutdown();directory.deleteRecursively() }
    }
    private fun serve(server: MockWebServer,pack: Pack,tamper: Boolean = false) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertNull("Content must not carry wallet session cookies",request.getHeader("Cookie"))
                val path = request.path!!.removePrefix("/content/")
                return when {
                    path == "manifest.json" -> MockResponse().setBody(pack.manifest.toString())
                    path in pack.files -> MockResponse().setBody(if(tamper) "tampered" else pack.files.getValue(path))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }
    @Test fun `downloaded content only becomes visible after explicit safe activation`() = withServer { server,client,root -> runBlocking {
        val content = pack("first");serve(server,content)
        val updates = NativeContentUpdates(root,server.url("/").toString(),client)
        assertNotNull(updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled"))
        assertFalse(File(root,"active").exists())
        assertEquals("first",Json.parseToJsonElement(File(updates.activate(),"catalogue.json").readText()).jsonObject["marker"]!!.jsonPrimitive.content)
        updates.close()
    } }
    @Test fun `same active content recheck recovers a disconnected TLS read without downloading assets again`() = withServer { server,client,root -> runBlocking {
        val content=pack("installed");serve(server,content)
        // Match the local HTTPS server's HTTP/1.1 keep-alive transport.
        val updates=NativeContentUpdates(root,server.url("/").toString(),client.newBuilder().protocols(listOf(okhttp3.Protocol.HTTP_1_1)).build())
        val url=server.url("/content/manifest.json").toString()
        updates.prepare(url,14,"bundled");val active=updates.activate()!!
        val pointer=File(root,"active").readText()
        val original=server.dispatcher
        val attempts=java.util.concurrent.atomic.AtomicInteger()
        server.dispatcher=object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("GET",request.method)
                assertEquals("/content/manifest.json",request.path)
                assertNull(request.getHeader("Cookie"))
                return if(attempts.incrementAndGet()==1) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    else original.dispatch(request)
            }
        }
        try {
            assertNull(updates.prepare(url,14,"bundled"))
            assertEquals(2,attempts.get())
            assertEquals(pointer,File(root,"active").readText())
            assertEquals(active,updates.restore(14,bundledVersion="bundled")?.directory)
            assertNull(updates.activate())
        } finally { updates.close() }
    } }
    @Test fun `failed download leaves existing usable generation available across process restart`() = withServer { server,client,root -> runBlocking {
        val updates = NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,pack("good"));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        val good = updates.activate()!!
        serve(server,pack("bad"),tamper=true)
        assertTrue(runCatching { updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled") }.isFailure)
        updates.close()
        val restarted = NativeContentUpdates(root,server.url("/").toString(),client)
        assertEquals(good,restarted.restore(14,bundledVersion="bundled")?.directory);restarted.close()
    } }
    @Test fun `failed same generation rechecks report only safe stages and preserve active content`() = withServer { server,client,root -> runBlocking {
        val content=pack("retained");serve(server,content)
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val url=server.url("/content/manifest.json").toString()
        updates.prepare(url,14,"bundled");val active=updates.activate()!!
        var response=MockResponse().setResponseCode(503).setBody("private-response-must-not-be-logged")
        val attempts=java.util.concurrent.atomic.AtomicInteger()
        server.dispatcher=object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { attempts.incrementAndGet();return response }
        }
        try {
            var failure=runCatching { updates.prepare(url,14,"bundled") }.exceptionOrNull()
            assertEquals("MANIFEST_DOWNLOAD:HTTP_503",contentUpdateDiagnostic(failure as Exception))
            assertEquals("No unbounded application-level retries on HTTP failure",1,attempts.get())
            assertEquals(active.name,File(root,"active").readText())
            response=MockResponse().setBody("{\"private-malformed-value\":")
            failure=runCatching { updates.prepare(url,14,"bundled") }.exceptionOrNull()
            assertEquals("MANIFEST_VALIDATION:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
            assertEquals(active,updates.restore(14,bundledVersion="bundled")?.directory)
            assertNull(updates.activate())
            serve(server,content)
            assertNull("A later successful recheck clears no installed generation",updates.prepare(url,14,"bundled"))
        } finally { updates.close() }
    } }
    @Test fun `diagnostic wrapper propagates cancellation and never copies authentication error text`() {
        val cancelled=kotlinx.coroutines.CancellationException("private cancellation detail")
        val actual=runCatching { contentUpdateStep(ContentUpdateStage.MANIFEST_DOWNLOAD) { throw cancelled } }.exceptionOrNull()
        assertSame(cancelled,actual)
        assertEquals("CAPABILITIES:HTTP_401",contentUpdateDiagnostic(gg.pixelkingdomwars.nativeclient.network.ApiException(
            401,"private-code","private auth payload and URL")))
        assertEquals("CAPABILITIES:UNEXPECTED",contentUpdateDiagnostic(Exception("private unexpected message")))
    }
    @Test fun `corrupt active content restores the previous verified generation`() = withServer { server,client,root -> runBlocking {
        val updates = NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,pack("old"));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        val old = updates.activate()!!
        serve(server,pack("new"));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        val active = updates.activate()!!;updates.close()
        File(active,"catalogue.json").writeText("broken")
        val restarted = NativeContentUpdates(root,server.url("/").toString(),client)
        assertEquals(old,restarted.restore(14,bundledVersion="bundled")?.directory);restarted.close()
    } }
    @Test fun `failed replacement download cannot destroy an already ready update`() = withServer { server,client,root -> runBlocking {
        val updates = NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,pack("ready"));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        serve(server,pack("failed"),tamper=true)
        assertTrue(runCatching { updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled") }.isFailure)
        val ready = updates.activate()!!
        assertEquals("ready",Json.parseToJsonElement(File(ready,"catalogue.json").readText()).jsonObject["marker"]!!.jsonPrimitive.content)
        updates.close()
    } }
    @Test fun `repeated restoration does not strand an uncloseable battle lease`() = withServer { server,client,root -> runBlocking {
        val updates = NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,pack("old"));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        val old = updates.activate()!!
        assertEquals(old,updates.restore(14,bundledVersion="bundled")?.directory);assertEquals(old,updates.restore(14,bundledVersion="bundled")?.directory)
        serve(server,pack("next"));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        assertNotEquals("Every restore must release its prior lease before a safe activation",old,updates.activate())
        updates.close()
    } }
    @Test fun `travelling effects accept contract3 while unsupported updates retain installed content`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,pack("installed",2));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        assertNotNull(updates.activate())
        serve(server,pack("travelling",3));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled")
        val supported=updates.activate()!!
        // Contract 15 is the reviewed realm-kit contract (docs/REALM-KIT-PLAN.md E-8; docs/UPDATE_COMPATIBILITY.md); 16 is the first future one.
        serve(server,pack("future",16))
        assertTrue(runCatching { updates.prepare(server.url("/content/manifest.json").toString(),14,"bundled") }.isFailure)
        assertEquals(supported,updates.restore(14,bundledVersion="bundled")?.directory);updates.close()
    } }
    /** Renderer compatibility remains separate from the now-mandatory production kit admission. */
    @Test fun `realm kit renderer15 updates activate over a contract14 bundle only with accepted kit coverage`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val kit=pack("realm-kit",15)
        serve(server,kit)
        assertEquals(kit.manifest.getValue("contentVersion").jsonPrimitive.content,updates.prepare(url,14,"older-bundle",14))
        val active=updates.activate()!!
        assertEquals(15,updates.restore(14,14,bundledVersion="older-bundle")!!.renderCatalogue.getValue("rendererContractVersion").jsonPrimitive.int)
        assertEquals(active,updates.restore(14,14,bundledVersion="older-bundle")?.directory)
        val withoutKits=JsonObject(Json.parseToJsonElement(render(15)).jsonObject-"layeredGroundV5")
        serve(server,pack("retired-ground",15,renderText=withoutKits.toString()))
        assertTrue(runCatching { updates.prepare(url,14,"older-bundle",14) }.isFailure)
        assertEquals(active.name,File(root,"active").readText())
        assertEquals(active,updates.restore(14,14,bundledVersion="older-bundle")?.directory)
        assertNull(updates.activate())
        updates.close()
    } }
    @Test fun `revision-aware renderer14 updates activate and restore while future contracts preserve the exact generation`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val current=pack("revision-aware-ground",14)
        val version=current.manifest.getValue("contentVersion").jsonPrimitive.content
        serve(server,current)
        assertEquals(version,updates.prepare(url,14,"older-bundle",14))
        assertNull("Prepared content cannot change the visible generation",updates.restore(14,14,bundledVersion="older-bundle"))
        val active=updates.activate()!!
        assertEquals(version,active.name)
        updates.close()
        val restarted=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            assertEquals(active,restarted.restore(14,14,bundledVersion="older-bundle")?.directory)
            assertEquals(14,restarted.restore(14,14,bundledVersion="older-bundle")!!.renderCatalogue.getValue("rendererContractVersion").jsonPrimitive.int)
            assertNull("The same advertised generation needs no reinstall",restarted.prepare(url,14,"older-bundle",14))
            serve(server,pack("future",16)) // contract 15 is reviewed (realm kit); 16 is the first future contract
            val requests=server.requestCount
            assertTrue(runCatching { restarted.prepare(url,14,"older-bundle",14) }.isFailure)
            assertEquals("Future hints fetch no unreviewed asset bytes",requests+1,server.requestCount)
            assertEquals(active,restarted.restore(14,14,bundledVersion="older-bundle")?.directory)
            assertNull(restarted.activate())
        } finally { restarted.close() }
    } }
    @Test fun `SIM18 renderer15 metadata stages activates and restores without eagerly fetching service pixels`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val offered=pack("service-metadata",15,sim=18);serve(server,offered)
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val version=offered.manifest.getValue("contentVersion").jsonPrimitive.content
        assertEquals(version,updates.prepare(url,18,"private-bundle",15))
        assertFalse("An offer cannot publish itself",File(root,"active").exists())
        assertEquals("Only the manifest and core metadata are downloaded",1+offered.files.size,server.requestCount)
        val active=updates.activate()!!;updates.close()
        val restarted=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            val admitted=restarted.restore(18,15,bundledVersion="private-bundle")!!
            assertEquals(active,admitted.directory)
            assertEquals(15,admitted.renderCatalogue.getValue("rendererContractVersion").jsonPrimitive.int)
            val optional=restarted.admittedManifest(admitted).files.filter { it.tier=="optional" }
            val originalPins=currentRender.getValue("phaseE").jsonObject.getValue("groups").jsonArray
                .flatMap { it.jsonObject.getValue("files").jsonArray }.associate { it.jsonObject.getValue("path").jsonPrimitive.content to it.jsonObject }
            assertEquals(originalPins.keys,optional.map { it.path }.toSet())
            optional.forEach { pin ->
                assertEquals(originalPins.getValue(pin.path).getValue("sha256").jsonPrimitive.content,pin.sha256)
                assertEquals(originalPins.getValue(pin.path).getValue("size").jsonPrimitive.long,pin.size)
                assertFalse("Metadata admission is not optional pixel readiness",File(active,pin.path).exists())
            }
            assertNull(restarted.prepare(url,18,"private-bundle",15))
            assertEquals("Recovery only rechecks the manifest",2+offered.files.size,server.requestCount)
        } finally { restarted.close() }
    } }
    @Test fun `SIM17 clients refuse SIM18 offers and SIM18 clients refuse old live offers before asset reads`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            for((offered,supported) in listOf(18 to 17,17 to 18)) {
                serve(server,pack("wrong-live-sim",15,sim=offered));val requests=server.requestCount
                val failure=runCatching { updates.prepare(url,supported,"bundle",15) }.exceptionOrNull()
                assertEquals("MANIFEST_VALIDATION:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
                assertEquals(requests+1,server.requestCount)
                assertFalse(File(root,"active").exists());assertNull(updates.activate())
            }
        } finally { updates.close() }
    } }
    @Test fun `hashed renderer15 with absent or malformed service graph preserves active and ready metadata`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            serve(server,pack("active-services",15,sim=18));updates.prepare(url,18,"bundle",15);val active=updates.activate()!!
            serve(server,pack("ready-services",15,sim=18));val ready=updates.prepare(url,18,"bundle",15)!!
            val valid=Json.parseToJsonElement(render(15)).jsonObject
            val malformed=listOf(JsonObject(valid-"phaseE"),JsonObject(valid+("phaseE" to JsonObject(valid.getValue("phaseE").jsonObject+("groups" to JsonArray(emptyList()))))))
            for((index,render) in malformed.withIndex()) {
                serve(server,pack("bad-services-$index",15,renderText=render.toString(),sim=18))
                val failure=runCatching { updates.prepare(url,18,"bundle",15) }.exceptionOrNull()
                assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
                assertEquals(active,updates.restore(18,15,bundledVersion="bundle")?.directory)
                assertEquals(active.name,File(root,"active").readText())
            }
            assertEquals("A hash-valid malformed graph cannot displace the prepared generation",ready,updates.activate()!!.name)
        } finally { updates.close() }
    } }
    @Test fun `private SIM18 APK and rolled back SIM17 APK never restore each others cached live generations`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val old=NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,pack("old-client",14,sim=17));old.prepare(url,17,"old-bundle",14);val retainedOld=old.activate()!!;old.close()
        val next=NativeContentUpdates(root,server.url("/").toString(),client)
        assertNull(next.restore(18,15,bundledVersion="new-bundle"))
        assertTrue("Rejected old generations are retained",retainedOld.isDirectory)
        serve(server,pack("new-client",15,sim=18));next.prepare(url,18,"new-bundle",15);val retainedNew=next.activate()!!;next.close()
        val rollback=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            assertNull("Cross-SIM activation never grants a previous pointer; rollback uses its own bundled17",rollback.restore(17,14,bundledVersion="old-bundle"))
            assertTrue(retainedOld.isDirectory)
            assertTrue("New generation bytes are not deleted by rollback refusal",retainedNew.isDirectory)
            assertEquals("Refusal does not rewrite the new client's active pointer",retainedNew.name,File(root,"active").readText())
        } finally { rollback.close() }
    } }
    @Test fun `optional pins follow displayed content through a staged offer and process recovery without downloading audio`() = withServer { server,client,root -> runBlocking {
        val url=server.url("/content/manifest.json").toString()
        val oldPack=pack("old-audio",14,optionalFiles=mapOf("audio/world.mp3" to "old-audio-bytes"))
        val nextPack=pack("new-audio",14,optionalFiles=mapOf("audio/world.mp3" to "different-audio-bytes"))
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        serve(server,oldPack);updates.prepare(url,14,"bundle",14);updates.activate()
        val old=updates.restore(14,14,bundledVersion="bundle")!!
        val oldManifest=updates.admittedManifest(old)
        assertEquals("optional",oldManifest.files.single { it.path=="audio/world.mp3" }.tier)
        assertEquals(hash("old-audio-bytes"),oldManifest.files.single { it.path=="audio/world.mp3" }.sha256)
        assertFalse(File(old.directory,"audio/world.mp3").exists())
        serve(server,nextPack);updates.prepare(url,14,"bundle",14)
        assertEquals("A ready offer cannot retarget music in the visible scene",oldManifest,updates.admittedManifest(old))
        updates.close()
        val restarted=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            val requests=server.requestCount
            val restored=restarted.restore(14,14,bundledVersion="bundle")!!
            assertEquals(oldManifest,restarted.admittedManifest(restored))
            assertEquals("Restored pins come from the receipt, without a server fetch",requests,server.requestCount)
            restarted.prepare(url,14,"bundle",14);val next=restarted.activate()!!
            val selected=restarted.restore(14,14,bundledVersion="bundle")!!
            assertEquals(next,selected.directory)
            val manifest=restarted.admittedManifest(selected)
            assertNotEquals(oldManifest.contentVersion,manifest.contentVersion)
            assertEquals(hash("different-audio-bytes"),manifest.files.single { it.path=="audio/world.mp3" }.sha256)
            assertFalse(File(next,"audio/world.mp3").exists())
            assertTrue("An old scene cannot borrow the new generation's optional pins",runCatching { restarted.admittedManifest(old) }.isFailure)
        } finally { restarted.close() }
    } }
    @Test fun `optional receipt identity cannot be rebound to a different admitted simulation`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            serve(server,pack("pinned",14,optionalFiles=mapOf("audio/world.mp3" to "audio")))
            updates.prepare(server.url("/content/manifest.json").toString(),14,"bundle",14);updates.activate()
            val active=updates.restore(14,14,bundledVersion="bundle")!!
            val mismatched=AdmittedGameContent(active.directory,JsonObject(active.catalogue+("simVersion" to JsonPrimitive(15))),active.renderCatalogue,active.rendererTree)
            assertTrue(runCatching { updates.admittedManifest(mismatched) }.isFailure)
            assertEquals(14,updates.admittedManifest(active).simVersion)
        } finally { updates.close() }
    } }
    @Test fun `unsupported advertised renderer downloads no assets and preserves active and ready generations`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val url=server.url("/content/manifest.json").toString()
        serve(server,pack("active",9));updates.prepare(url,14,"bundled",9)
        val active=updates.activate()!!;val pointer=File(root,"active").readText()
        serve(server,pack("ready",9));val ready=updates.prepare(url,14,"bundled",9)!!
        val generations=root.walkTopDown().filter { it.isFile }.map { it.relativeTo(root).path }.toSet()
        try {
            // 16 is the first future contract: 15 is the reviewed realm-kit contract (docs/REALM-KIT-PLAN.md E-8).
            for(renderer in listOf(JsonPrimitive(16),JsonPrimitive(Int.MAX_VALUE),JsonPrimitive(8),JsonPrimitive("9"),JsonNull,buildJsonObject {})) {
                val source=pack("unacceptable",9)
                serve(server,Pack(JsonObject(source.manifest+ ("rendererContractVersion" to renderer)),source.files))
                val requests=server.requestCount
                val failure=runCatching { updates.prepare(url,14,"bundled",9) }.exceptionOrNull()
                assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
                assertEquals("Only the manifest may be fetched",requests+1,server.requestCount)
                assertEquals(pointer,File(root,"active").readText())
                assertEquals("Preflight cannot create or prune a content generation",generations,root.walkTopDown().filter { it.isFile }.map { it.relativeTo(root).path }.toSet())
                assertEquals(active,updates.restore(14,9,bundledVersion="bundled")?.directory)
            }
            assertEquals("A prior ready update must survive rejection",ready,updates.activate()!!.name)
        } finally { updates.close() }
    } }
    @Test fun `legacy missing header still validates hashed catalogue and cannot hide a future renderer`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val url=server.url("/content/manifest.json").toString()
        try {
            serve(server,pack("legacy",9,advertiseRenderer=false));updates.prepare(url,14,"bundled",9)
            val active=updates.activate()!!
            for(advertise in listOf(false,true)) {
                val future=pack("future-$advertise",16,advertiseRenderer=false) // 15 is reviewed (realm kit); 16 is the first future contract
                val offered=if(advertise) Pack(JsonObject(future.manifest+("rendererContractVersion" to JsonPrimitive(9))),future.files) else future
                serve(server,offered);val requests=server.requestCount
                val failure=runCatching { updates.prepare(url,14,"bundled",9) }.exceptionOrNull()
                assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
                assertTrue("A missing or false compatible hint cannot replace catalogue validation",server.requestCount>requests+1)
                assertEquals(active,updates.restore(14,9,bundledVersion="bundled")?.directory);assertNull(updates.activate())
            }
        } finally { updates.close() }
    } }
    @Test fun `new APK bundled renderer floor cannot be downgraded by old downloaded cache`() {
        // Retain every shipped boundary, including renderer15 service graph admission.
        for ((previous,required) in listOf(6 to 7,7 to 8,8 to 9,9 to 10,10 to 11,11 to 12,12 to 13,13 to 14,14 to 15)) withServer { server,client,root -> runBlocking {
            val old=NativeContentUpdates(root,server.url("/").toString(),client)
            serve(server,pack("old",previous));old.prepare(server.url("/content/manifest.json").toString(),14,"bundled-old")
            old.activate();old.close()
            val upgraded=NativeContentUpdates(root,server.url("/").toString(),client)
            assertNull("Keep bundled renderer$required when cached renderer$previous lacks its compiled semantics",upgraded.restore(14,required,bundledVersion="bundled"))
            serve(server,pack("old-update",previous))
            assertTrue(runCatching { upgraded.prepare(server.url("/content/manifest.json").toString(),14,"bundled-new",required) }.isFailure)
            serve(server,pack("new-update",required));upgraded.prepare(server.url("/content/manifest.json").toString(),14,"bundled-new",required)
            assertNotNull(upgraded.activate());upgraded.close()
        } }
    }
    private fun legacyActivate(root:File,pack:Pack):File {
        val manifest=ContentManifest(1,"a".repeat(40),pack.manifest.getValue("contentVersion").jsonPrimitive.content,
            pack.files.map { (path,bytes)->ContentFile(path,hash(bytes),bytes.toByteArray().size.toLong()) })
        val store=ContentStore(root);val directory=store.install(manifest) { pack.files.getValue(it.path).byteInputStream() }
        // Model a generation activated by this same APK bundle: real activation records the marker.
        File(root,"supersedes-${directory.name}").writeText("bundle")
        assertTrue(store.activate(manifest.contentVersion));return directory
    }
    @Test fun `hash-valid supported renderer with missing Howl aim cannot replace active or ready content`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client);val url=server.url("/content/manifest.json").toString()
        serve(server,pack("active",10));updates.prepare(url,14,"bundle",10);val active=updates.activate()!!
        serve(server,pack("ready",10));val ready=updates.prepare(url,14,"bundle",10)!!
        serve(server,pack("invalid",10,renderText=render(10,true)))
        val failure=runCatching { updates.prepare(url,14,"bundle",10) }.exceptionOrNull()
        assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
        assertEquals(active,updates.restore(14,10,bundledVersion="bundle")?.directory);assertEquals(active.name,File(root,"active").readText())
        assertEquals(ready,updates.activate()!!.name);updates.close()
    } }
    @Test fun `renderer11 missing either motion controller cannot replace active or ready content`() {
        for(missing in listOf("leap","lunge")) withServer { server,client,root -> runBlocking {
            val updates=NativeContentUpdates(root,server.url("/").toString(),client)
            val url=server.url("/content/manifest.json").toString()
            try {
                serve(server,pack("active",11));updates.prepare(url,14,"bundle",11);val active=updates.activate()!!
                serve(server,pack("ready",11));val ready=updates.prepare(url,14,"bundle",11)!!
                val activeBytes=File(active,"render-catalog.json").readText()
                val readyBytes=File(root,"$ready/render-catalog.json").readText()
                serve(server,pack("missing-$missing",11,renderText=render(11,missingMotion=missing)))
                val requests=server.requestCount
                val failure=runCatching { updates.prepare(url,14,"bundle",11) }.exceptionOrNull()
                assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
                assertTrue("Hash-valid files reach the semantic parser",server.requestCount>requests+1)
                assertEquals(activeBytes,File(active,"render-catalog.json").readText())
                assertEquals(readyBytes,File(root,"$ready/render-catalog.json").readText())
                assertEquals(active.name,File(root,"active").readText())
                assertEquals(active,updates.restore(14,11,bundledVersion="bundle")?.directory)
                assertEquals("A missing $missing cannot displace the ready lease",ready,updates.activate()!!.name)
            } finally { updates.close() }
        } }
    }
    @Test fun `incomplete burrow updates retain both the current scene and staged candidate`() {
        for(unit in listOf("tunneler","bilgewraith")) withServer { server,client,root -> runBlocking {
            val updates=NativeContentUpdates(root,server.url("/").toString(),client);val url=server.url("/content/manifest.json").toString()
            try {
                serve(server,pack("active",12,renderText=burrowRender(unit)));updates.prepare(url,14,"bundle",12)
                val active=updates.activate()!!
                serve(server,pack("ready",12,renderText=burrowRender(unit)));val ready=updates.prepare(url,14,"bundle",12)!!
                for(missing in listOf("controller","surface","attack","hit")) {
                    serve(server,pack("missing-$missing",12,renderText=burrowRender(unit,missing)))
                    val failure=runCatching { updates.prepare(url,14,"bundle",12) }.exceptionOrNull()
                    assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
                    assertEquals(active,updates.restore(14,12,bundledVersion="bundle")?.directory)
                    assertEquals(active.name,File(root,"active").readText())
                }
                assertEquals("A failed burrow upgrade cannot displace the valid staged scene",ready,updates.activate()!!.name)
            } finally { updates.close() }
        } }
    }
    @Test fun `semantic restore leases exact previous directory and bad active never overwrites its recovery pointer`() = withServer { server,client,root -> runBlocking {
        val good=legacyActivate(root,pack("previous",10))
        legacyActivate(root,pack("bad-active",10,renderText=render(10,true)))
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        assertEquals(good,updates.restore(14,10,bundledVersion="bundle")?.directory);assertEquals(good,updates.restore(14,10,bundledVersion="bundle")?.directory)
        serve(server,pack("replacement",10));updates.prepare(server.url("/content/manifest.json").toString(),14,"bundle",10)
        val next=updates.activate()!!;assertEquals(good.name,File(root,"previous").readText())
        File(next,"render-catalog.json").writeText("corrupt")
        updates.close();val restarted=NativeContentUpdates(root,server.url("/").toString(),client)
        assertEquals(good,restarted.restore(14,10,bundledVersion="bundle")?.directory);restarted.close()
    } }
    @Test fun `bad cached metadata without previous chooses bundle and publication validation rejects it`() = withServer { server,client,root -> runBlocking {
        val bad=legacyActivate(root,pack("bad-only",10,renderText=render(10,true)))
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        assertNull("Startup must choose its already verified bundle",updates.restore(14,10,bundledVersion="bundle"))
        var published=false
        assertTrue(runCatching { readValidatedGameContent(bad);published=true }.isFailure)
        assertFalse("Publication comes after all renderer metadata parses",published)
        updates.close()
    } }
    @Test fun `candidate corrupted after preparation cannot activate or release displayed generation`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client);val url=server.url("/content/manifest.json").toString()
        serve(server,pack("active",10));updates.prepare(url,14,"bundle",10);val active=updates.activate()!!
        serve(server,pack("ready",10));val ready=updates.prepare(url,14,"bundle",10)!!
        File(root,"$ready/render-catalog.json").writeText(render(10,true))
        assertTrue(runCatching { updates.activate() }.isFailure)
        assertEquals(active.name,File(root,"active").readText());assertEquals(active,updates.restore(14,10,bundledVersion="bundle")?.directory);updates.close()
    } }

    @Test fun `restore returns the admitted metadata for its exact leased directory once per call`() = withServer { server,client,root -> runBlocking {
        val active=legacyActivate(root,pack("restored",10))
        val samples=mutableListOf<ContentLoadSample>()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={samples.add(it);Unit})
        try {
            val restored=updates.restore(14,10,bundledVersion="bundle")!!
            assertEquals(active,restored.directory)
            assertEquals("restored",restored.catalogue.getValue("marker").jsonPrimitive.content)
            assertEquals(10,restored.renderCatalogue.getValue("rendererContractVersion").jsonPrimitive.int)
            assertEquals(1,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION })
            samples.clear()
            File(active,"catalogue.json").writeText("tampered")
            assertNull("A subsequent restore must verify bytes again, not reuse an earlier admission",updates.restore(14,10,bundledVersion="bundle"))
        } finally { updates.close() }
    } }
    @Test fun `fallback returns metadata from the accepted previous generation only`() = withServer { server,client,root -> runBlocking {
        val previous=legacyActivate(root,pack("good-previous",10))
        legacyActivate(root,pack("bad-current",10,renderText=render(10,true)))
        val samples=mutableListOf<ContentLoadSample>()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={samples.add(it);Unit})
        try {
            val restored=updates.restore(14,10,bundledVersion="bundle")!!
            assertEquals(previous,restored.directory)
            assertEquals("good-previous",restored.catalogue.getValue("marker").jsonPrimitive.content)
            assertEquals(2,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION })
            assertEquals(1,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION && it.succeeded })
        } finally { updates.close() }
    } }
    @Test fun `restore trusts a stamped generation without re-hashing and parses its catalogue once per process`() = withServer { server,client,root -> runBlocking {
        val active=legacyActivate(root,pack("stamped",10)) // install hashed while streaming; activation hashed again and stamped
        val samples=mutableListOf<ContentLoadSample>()
        fun stages(vararg wanted:ContentLoadStage)=samples.filter { it.stage in wanted }.map { it.stage to it.succeeded }
        val updates=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={samples.add(it);Unit})
        try {
            assertEquals(active,updates.restore(14,10,bundledVersion="bundle")?.directory)
            assertEquals("Launch selection stats the stamped files instead of hashing them",listOf(ContentLoadStage.STORE_TRUST to true),stages(ContentLoadStage.STORE_TRUST,ContentLoadStage.STORE_VERIFY))
            assertEquals(listOf(ContentLoadStage.RENDER_ADMISSION to true),stages(ContentLoadStage.RENDER_ADMISSION))
            assertEquals(active,updates.restore(14,10,bundledVersion="bundle")?.directory)
            assertEquals("A later selection of the same generation reuses its admitted parse",1,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION })
            assertEquals(0,samples.count { it.stage==ContentLoadStage.STORE_VERIFY })
            samples.clear()
            val rebuilt=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={samples.add(it);Unit},verifier="apk-2")
            try {
                assertEquals(active,rebuilt.restore(14,10,bundledVersion="bundle")?.directory)
                assertEquals("Another APK build hashes once, then owns the stamp",listOf(ContentLoadStage.STORE_VERIFY to true),stages(ContentLoadStage.STORE_TRUST,ContentLoadStage.STORE_VERIFY))
                samples.clear();rebuilt.restore(14,10,bundledVersion="bundle")
                assertEquals(listOf(ContentLoadStage.STORE_TRUST to true),stages(ContentLoadStage.STORE_TRUST,ContentLoadStage.STORE_VERIFY))
            } finally { rebuilt.close() }
        } finally { updates.close() }
    } }
    @Test fun `a cached generation below the bundled renderer floor is rejected by its header without a catalogue parse`() = withServer { server,client,root -> runBlocking {
        legacyActivate(root,pack("older",9))
        val samples=mutableListOf<ContentLoadSample>()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={samples.add(it);Unit})
        try {
            assertNull("Startup keeps its bundled renderer10",updates.restore(14,10,bundledVersion="bundle"))
            assertEquals(listOf(false),samples.filter { it.stage==ContentLoadStage.RENDER_HINT }.map { it.succeeded })
            assertEquals("The multi-megabyte parse is skipped for a contract the header already rules out",0,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION || it.stage==ContentLoadStage.RENDER_DECODE })
            samples.clear()
            assertNotNull("The same generation is still admitted by a build whose floor it meets",updates.restore(14,9,bundledVersion="bundle"))
            assertEquals(1,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION && it.succeeded })
        } finally { updates.close() }
    } }
    @Test fun `cancellation after restore admission never publishes a candidate`() = withServer { server,client,root -> runBlocking {
        val active=legacyActivate(root,pack("current",10))
        val parent=Job()
        var cancel=true
        val updates=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={
            if(cancel && it.stage==ContentLoadStage.RESTORE)parent.cancel()
        })
        try {
            var published=false
            val job=launch(parent) { updates.restore(14,10,bundledVersion="bundle");published=true }
            job.join();assertTrue(job.isCancelled);assertFalse(published)
            cancel=false
            assertEquals(active,updates.restore(14,10,bundledVersion="bundle")?.directory)
        } finally { updates.close();parent.cancelAndJoin() }
    } }

    @Test fun `a downloaded generation is restored only under the bundle it superseded`() = withServer { server,client,root -> runBlocking {
        serve(server,pack("download"))
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        updates.prepare(server.url("/content/manifest.json").toString(),14,"bundle-a");val active=updates.activate()!!
        updates.close()
        // The same APK bundle: the download still outranks it after a restart.
        val sameBundle=NativeContentUpdates(root,server.url("/").toString(),client)
        assertEquals(active,sameBundle.restore(14,bundledVersion="bundle-a")?.directory);sameBundle.close()
        // An upgraded APK ships a newer bundle: the older download must not hide it, and stays on disk.
        val upgraded=NativeContentUpdates(root,server.url("/").toString(),client)
        assertNull(upgraded.restore(14,bundledVersion="bundle-b"));upgraded.close()
        assertTrue(active.isDirectory);assertEquals(active.name,File(root,"active").readText())
        // Legacy downloads without a marker are treated as superseded.
        assertTrue(File(root,"supersedes-${active.name}").delete())
        val legacy=NativeContentUpdates(root,server.url("/").toString(),client)
        assertNull(legacy.restore(14,bundledVersion="bundle-a"));legacy.close()
    } }

    // Historical exact17 remains valid parser evidence; it is no longer a usable kitless generation.
    @Test fun `exact renderer17 metadata retains parser evidence but kitless GameContent and updater admission refuse it`() = withServer { server,client,root -> runBlocking {
        val dir=Files.createTempDirectory("exact17").toFile(); val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            val render=java.util.zip.GZIPInputStream(File("../test-fixtures/candidate-6f7a9e81-sim18-r17-fleet/render-catalog.json.gz").inputStream()).use { it.readBytes() }
            assertEquals("f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133",MessageDigest.getInstance("SHA-256").digest(render).joinToString("") { "%02x".format(it) })
            File(dir,"render-catalog.json").writeBytes(render); File(dir,"catalogue.json").writeBytes(File("../test-fixtures/candidate-6f7a9e81-sim18-r16-cosmetics/catalogue.json").readBytes())
            gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue.validate(render.toString(Charsets.UTF_8))
            val historicalRender=Json.parseToJsonElement(render.toString(Charsets.UTF_8)).jsonObject
            val historicalCatalogue=Json.parseToJsonElement(File(dir,"catalogue.json").readText()).jsonObject
            assertEquals(17,historicalRender.getValue("rendererContractVersion").jsonPrimitive.int); assertTrue(historicalRender.containsKey("fleetJourneys"))
            assertEquals(18,historicalCatalogue.getValue("simVersion").jsonPrimitive.int)
            assertEquals("Historical bytes remain authentic but cannot replace bundled kit ground",
                "Accepted realm kit ground is required",runCatching { readValidatedGameContent(dir) }.exceptionOrNull()?.message)
            // The updater's compatibility (2..15) is unchanged: an advertised contract17 generation is refused before any asset byte.
            val url=server.url("/content/manifest.json").toString(); serve(server,pack("future17",17)); val requests=server.requestCount
            assertTrue(runCatching { updates.prepare(url,14,"older-bundle",14) }.isFailure)
            assertEquals("a refused future hint fetches no asset bytes",requests+1,server.requestCount); assertNull(updates.activate())
        } finally { updates.close(); dir.deleteRecursively() }
    } }

    @Test fun `same-contract kitless offer preserves active kit and an already prepared kit candidate`() = withServer { server,client,root -> runBlocking {
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        val url=server.url("/content/manifest.json").toString()
        try {
            serve(server,pack("active-kit",15,sim=18));updates.prepare(url,18,"bundled-kit",15)
            val active=updates.activate()!!
            serve(server,pack("ready-kit",15,sim=18));val ready=updates.prepare(url,18,"bundled-kit",15)!!
            val old=JsonObject(Json.parseToJsonElement(render(15)).jsonObject-"layeredGroundV5")
            serve(server,pack("old-qa-offer",15,renderText=old.toString(),sim=18))
            val failure=runCatching { updates.prepare(url,18,"bundled-kit",15) }.exceptionOrNull()
            assertTrue(failure is ContentUpdateFailure)
            assertEquals("COMPATIBILITY:INVALID_DATA",contentUpdateDiagnostic(failure as Exception))
            assertEquals(active.name,File(root,"active").readText())
            assertEquals(active,updates.restore(18,15,bundledVersion="bundled-kit")?.directory)
            assertEquals("Refusing a later offer must retain the earlier valid pending lease",ready,updates.activate()!!.name)
        } finally { updates.close() }
    } }

    @Test fun `kitless cached generation yields to the bundle and cannot enter the admitted cache`() = withServer { server,client,root -> runBlocking {
        val old=JsonObject(Json.parseToJsonElement(render(15)).jsonObject-"layeredGroundV5")
        val retired=legacyActivate(root,pack("retired",15,renderText=old.toString(),sim=18))
        val updates=NativeContentUpdates(root,server.url("/").toString(),client)
        try {
            assertNull("No downloaded content replaces the bundled kit",updates.restore(18,15,bundledVersion="bundle"))
            assertEquals("Accepted realm kit ground is required",runCatching { GameContentCache.admitted(retired) }.exceptionOrNull()?.message)
            assertNull(GameContentCache.cached(retired))
            assertTrue("Refusal preserves retained bytes",retired.isDirectory)
            assertNull(updates.activate())
        } finally { updates.close() }
    } }

    @Test fun `activation rechecks cached kit admission before replacing the displayed generation`() = withServer { server,client,root -> runBlocking {
        val samples=mutableListOf<ContentLoadSample>()
        val updates=NativeContentUpdates(root,server.url("/").toString(),client,onLoad={samples.add(it);Unit})
        val url=server.url("/content/manifest.json").toString()
        try {
            serve(server,pack("active-kit",15,sim=18));updates.prepare(url,18,"bundle",15)
            val active=updates.activate()!!
            serve(server,pack("ready-kit",15,sim=18));val ready=updates.prepare(url,18,"bundle",15)!!
            // The parsed tree is mutable even though the store's verified bytes are immutable.
            // Refuse this cached metadata without changing bytes or relying on a hash failure.
            GameContentCache.cached(File(root,ready))!!.rendererTree.remove("layeredGroundV5")
            samples.clear()
            assertTrue(runCatching { updates.activate() }.isFailure)
            assertEquals(active.name,File(root,"active").readText())
            assertEquals(1,samples.count { it.stage==ContentLoadStage.RENDER_ADMISSION && !it.succeeded })
            assertEquals(active,updates.restore(18,15,bundledVersion="bundle")?.directory)
        } finally { updates.close() }
    } }
}
