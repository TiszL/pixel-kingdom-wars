package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Choreographer
import android.view.accessibility.AccessibilityNodeInfo
import gg.pixelkingdomwars.nativeclient.scene.KingdomFragment
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import gg.pixelkingdomwars.nativeclient.content.*
import gg.pixelkingdomwars.nativeclient.data.LaunchMode
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.Closeable
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Read-only paired QA on a fresh private emulator. Normal ACCOUNT composition and repository
 * selection are retained; candidate admission neither activates content nor changes updater policy. */
internal object PairedServiceHarness {
    private fun surfaces(view: View): List<SurfaceView> = when(view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
    fun capture(i: Instrumentation, expectedHash: String): String {
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID=="gg.pixelkingdomwars.twa.debug" &&
            Build.HARDWARE=="ranchu" && BuildConfig.API_ORIGIN=="https://127.0.0.1:18443")
        require(expectedHash.matches(Regex("[a-f0-9]{64}")))
        val context=i.targetContext
        val output=File(context.noBackupFilesDir,"paired-service/${System.currentTimeMillis()}")
        check(output.mkdirs())
        val input=File(context.noBackupFilesDir,"local-ui-session.json")
        var lease:Closeable?=null
        var activity:MainActivity?=null
        var status="running"; var stage="input"; var failure:String?=null
        val facts=linkedMapOf<String,JsonElement>()
        fun receipt() { File(output,"receipt.json").writeText(buildJsonObject {
            put("status",status); put("stage",stage); put("failureClass",failure?.let(::JsonPrimitive) ?: JsonNull)
            put("manifestSha256",expectedHash); put("candidateOnly",true); put("accountMode",true)
            put("harnessGameplayPosts",0); put("walletApprovalTested",false); put("physicalDevice",false); put("packRepinned",false)
            facts.forEach { (key,value)->put(key,value) }
        }.toString()) }
        fun <T> main(block:()->T):T { val result=AtomicReference<T>(); i.runOnMainSync { result.set(block()) }; return result.get() }
        fun await(label:String, condition:()->Boolean) {
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60)
            while(System.nanoTime()<deadline) { if(condition())return; Thread.sleep(25) }
            error("Paired wait failed: $label")
        }
        try {
            require(input.isFile && input.length() in 1..16384)
            val session=Json.parseToJsonElement(input.readText()).jsonObject
            check(session.keys==setOf("origin","cookie","wallet","baseId") && session.string("origin")==BuildConfig.API_ORIGIN)
            val wallet=requireNotNull(session.string("wallet")); val baseId=requireNotNull(session.string("baseId"))
            require(baseId.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")))
            val origin=BuildConfig.API_ORIGIN.toHttpUrl()
            val jar=SessionCookieJar(origin,EncryptedStore(context,storageNamespace(BuildConfig.API_ORIGIN,"session")))
            jar.saveFromResponse(origin,listOf(requireNotNull(Cookie.parse(origin,requireNotNull(session.string("cookie"))+"; Path=/; Secure; HttpOnly"))))
            check(input.delete())
            val api=GameApi(BuildConfig.API_ORIGIN,jar,"paired-service-instrumentation")
            stage="read-only-api"
            val identity=runBlocking { api.get("/me") }; check(identity.string("wallet")==wallet)
            val base=runBlocking { api.get("/base",mapOf("baseId" to baseId)) }
            check(base.string("baseId")==baseId)
            val capabilities=runBlocking { api.get("/native/capabilities") }
            facts["requestedBaseId"]=JsonPrimitive(baseId); facts["walletVerified"]=JsonPrimitive(true)
            facts["baseResponseSha256"]=JsonPrimitive(serviceGlHash(base.toString().toByteArray()))
            // Public capability data only; no /me payload, cookie or private profile enters evidence.
            facts["capabilities"]=capabilities
            stage="candidate-install"
            val candidate=File("/data/local/tmp/pkw-service-art-fixture")
            val manifestFile=serviceGlFile(candidate,"manifest.json"); require(manifestFile.length() in 1..16L*1024*1024)
            val bytes=manifestFile.readBytes(); check(serviceGlHash(bytes)==expectedHash)
            val raw=Json.parseToJsonElement(bytes.decodeToString()).jsonObject
            require(raw["rendererContractVersion"]==JsonPrimitive(15))
            val manifest=nativeContentManifest(raw,18)
            stage="manifest-parsed"
            val root=File(context.noBackupFilesDir,storageNamespace(BuildConfig.API_ORIGIN,"content-updates"))
            check(root.mkdir()) { "Fresh absent candidate root required" }
            check(root.canonicalFile.parentFile==context.noBackupFilesDir.canonicalFile)
            val store=ContentStore(root,verifier="paired-install")
            val assets=store.install(ContentManifest(1,manifest.sourceCommit,manifest.contentVersion,
                manifest.files.map { ContentFile(it.path,it.sha256,it.size,it.tier) })) { serviceGlFile(candidate,it.path).inputStream() }
            stage="store-installed"
            facts["canonicalNoBackupEqualsAbsolute"]=JsonPrimitive(context.noBackupFilesDir.canonicalFile==context.noBackupFilesDir.absoluteFile.normalize())
            facts["canonicalRootEqualsAbsolute"]=JsonPrimitive(root.canonicalFile==root.absoluteFile.normalize())
            facts["canonicalGenerationEqualsAbsolute"]=JsonPrimitive(assets.canonicalFile==assets.absoluteFile.normalize())
            receipt()
            val graph=(context.applicationContext as PkwApplication).graph(LaunchMode.ACCOUNT)
            stage="bootstrap-entered"
            lease=runBlocking { graph.content.bootstrapLocalCandidate(assets,bytes,expectedHash) }
            facts["contentVersion"]=JsonPrimitive(manifest.contentVersion); facts["sourceCommit"]=JsonPrimitive(manifest.sourceCommit)
            facts["simVersion"]=JsonPrimitive(18); facts["rendererContractVersion"]=JsonPrimitive(15)
            stage="normal-account-ui"
            activity=i.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            await("account base") { graph.sessionGraph.value?.base?.state?.value?.base != null }
            val account=graph.account.state.value
            val loaded=requireNotNull(graph.sessionGraph.value?.base?.state?.value?.base)
            facts["actualSelectedBaseId"]=account.selectedBaseId?.let(::JsonPrimitive) ?: JsonNull
            facts["actualLoadedBaseId"]=loaded.baseId?.let(::JsonPrimitive) ?: JsonNull
            receipt()
            check(account.identity?.wallet==wallet && account.selectedBaseId==baseId && loaded.baseId==baseId) { "Actual UI base differs" }
            check(graph.content.state.value.assets==assets && graph.content.simVersion()==18)
            await("normal GL surface") { main { surfaces(requireNotNull(activity).window.decorView).any { it.width>0 && it.height>0 } } }
            stage="normal-scene-reveal"
            fun nodes(node: AccessibilityNodeInfo?): List<AccessibilityNodeInfo> = if(node==null) emptyList()
                else listOf(node)+(0 until node.childCount).flatMap { nodes(node.getChild(it)) }
            var dismissedTip=false
            fun visibleUiReady(): Boolean {
                i.uiAutomation.clearCache()
                val rootNode=i.uiAutomation.rootInActiveWindow ?: return false
                val all=nodes(rootNode).filter { it.isVisibleToUser }
                val tip=all.firstOrNull { it.text?.toString()=="Got it" && it.packageName?.toString() in setOf("android","com.android.systemui") }
                if(tip!=null) {
                    var target:AccessibilityNodeInfo?=tip
                    repeat(3) {
                        val current=target
                        if(current!=null && current.packageName?.toString() in setOf("android","com.android.systemui") && current.isClickable) {
                            dismissedTip=current.performAction(AccessibilityNodeInfo.ACTION_CLICK) || dismissedTip
                            return false
                        }
                        target=current?.parent
                    }
                    return false
                }
                return rootNode.packageName?.toString()==BuildConfig.APPLICATION_ID && all.none {
                    it.text?.toString() in setOf("Opening your kingdom…","Opening the replay…","Entering battle…")
                }
            }
            var presented:KingdomFragment?=null
            await("actual account scene draw and reveal") {
                val ready=main {
                    requireNotNull(activity).supportFragmentManager.fragments.filterIsInstance<KingdomFragment>().singleOrNull()?.takeIf {
                        it.hasPresentedScene && it.renderer!=null && it.battle==null && it.scene?.baseId==baseId && it.assetPath==assets.absolutePath
                    }
                }
                val uiReady=visibleUiReady()
                if(ready!=null && uiReady) { presented=ready;true } else false
            }
            repeat(3) {
                val frame=CountDownLatch(1);main { Choreographer.getInstance().postFrameCallback { frame.countDown() } }
                check(frame.await(12,TimeUnit.SECONDS))
            }
            check(visibleUiReady())
            check(main { requireNotNull(presented).hasPresentedScene && presented?.scene?.baseId==baseId &&
                requireNotNull(activity).supportFragmentManager.fragments.contains(presented) })
            check(graph.account.state.value.selectedBaseId==baseId && graph.sessionGraph.value?.base?.state?.value?.base?.baseId==baseId)
            check(graph.content.state.value.assets==assets && graph.content.state.value.manifest==manifest)
            facts["systemFullscreenTipDismissed"]=JsonPrimitive(dismissedTip)
            facts["normalScenePresented"]=JsonPrimitive(true);facts["openingOverlayAbsent"]=JsonPrimitive(true)
            facts["presentedSceneBaseId"]=JsonPrimitive(baseId);facts["naturalUiFramesAfterReveal"]=JsonPrimitive(3)
            val surface=main { surfaces(requireNotNull(activity).window.decorView).single() }
            val bitmap=Bitmap.createBitmap(surface.width,surface.height,Bitmap.Config.ARGB_8888)
            try {
                val latch=CountDownLatch(1); var code=-1
                PixelCopy.request(surface,bitmap,{ code=it;latch.countDown() },Handler(Looper.getMainLooper()))
                check(latch.await(12,TimeUnit.SECONDS) && code==PixelCopy.SUCCESS)
                val sampled=(0 until 16).flatMap { y->(0 until 16).map { x->bitmap.getPixel(x*(bitmap.width-1)/15,y*(bitmap.height-1)/15) } }.toSet().size
                facts["sceneSampledColours"]=JsonPrimitive(sampled)
                check(sampled>1) { "Normal scene is still a solid frame" }
                val png=File(output,"normal-account-base.png"); png.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) }
                facts["scenePngSha256"]=JsonPrimitive(serviceGlHash(png.readBytes()))
            } finally { bitmap.recycle() }
            val screen=i.uiAutomation.takeScreenshot(); check(screen!=null)
            try { File(output,"normal-account-ui.png").outputStream().use { check(screen.compress(Bitmap.CompressFormat.PNG,100,it)) } }
            finally { screen.recycle() }
            facts["minimumNativeBuild"]=JsonPrimitive(graph.content.state.value.minimumNativeBuild)
            facts["updateNotice"]=graph.content.state.value.updateNotice?.let(::JsonPrimitive) ?: JsonNull
            facts["normalUpdaterRendererMaximum"]=JsonPrimitive(14)
            status="captured-needs-pixel-review"; stage="complete"
        } catch(error:Throwable) {
            status="failed";failure=error.javaClass.simpleName
            error.stackTrace.firstOrNull { it.className.startsWith("gg.pixelkingdomwars.") }?.let {
                facts["failureSite"]=JsonPrimitive("${it.className}.${it.methodName}:${it.lineNumber}")
            }
            throw error
        }
        finally {
            if(input.exists())check(input.delete())
            activity?.let { host->main { host.finish() };i.waitForIdleSync() }
            // SceneHost retains its own global generation lease until asynchronous GL teardown.
            lease?.close(); receipt()
        }
        return output.name
    }
}
