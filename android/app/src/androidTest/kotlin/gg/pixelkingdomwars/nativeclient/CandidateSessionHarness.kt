package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelFileDescriptor
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** Test APK only. Imports our generated operator's real signature-authenticated QA
 * session before normal MainActivity restoration. No fixture graph or auth bypass. */
internal object CandidateSessionHarness {
    private const val ORIGIN = "https://qa.pixelkingdomwars.com"
    private const val TARGET = "gg.pixelkingdomwars.twa.debug"
    private const val INPUT = "/data/local/tmp/pkw-candidate-session.json"
    private const val CLEANUP_SCRIPT = "if rm -f '$INPUT' && [ ! -e '$INPUT' ]; then echo removed; fi\n"
    private const val PURPOSE = "pkw-generated-candidate-operator-v1"
    private const val INPUT_LIMIT = 16384
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun InputStream.bounded(limit: Int): ByteArray {
        val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
        while(true) { val count=read(buffer);if(count<0)break;check(out.size()+count<=limit);out.write(buffer,0,count) }
        return out.toByteArray()
    }
    private class MemoryStore(private var value: String? = null): SecretStore {
        override fun read()=value
        override fun write(value: String) {this.value=value}
        override fun clear() {value=null}
    }
    private fun removeInput(instrumentation: Instrumentation): Boolean {
        if(Build.VERSION.SDK_INT<Build.VERSION_CODES.S)return false
        // UiAutomation's String command uses Runtime.exec, not a shell parser.
        // Send this fixed script over stdin; no session value enters a command.
        val pipes=instrumentation.uiAutomation.executeShellCommandRw("sh")
        return ParcelFileDescriptor.AutoCloseInputStream(pipes[0]).use { output ->
            ParcelFileDescriptor.AutoCloseOutputStream(pipes[1]).use { input ->
                input.write(CLEANUP_SCRIPT.toByteArray(Charsets.UTF_8))
            }
            // Closing stdin before reading lets the shell exit and close stdout.
            output.bounded(64).toString(Charsets.UTF_8).trim()=="removed"
        }
    }
    fun bootstrap(instrumentation: Instrumentation) {
        val context=instrumentation.targetContext
        var succeeded=false
        try {
            check(Build.VERSION.SDK_INT>=Build.VERSION_CODES.S)
            check(BuildConfig.NATIVE_CANDIDATE && BuildConfig.BUILD_TYPE=="debug" && !BuildConfig.DEBUG)
            check(BuildConfig.API_ORIGIN==ORIGIN && BuildConfig.WALLET_IDENTITY_ORIGIN==ORIGIN && Build.HARDWARE=="ranchu")
            check(context.packageName==TARGET && instrumentation.context.packageName=="$TARGET.test")
            check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE==0)
            val pm=context.packageManager
            check(pm.checkSignatures(context.packageName,instrumentation.context.packageName)==PackageManager.SIGNATURE_MATCH)
            check(pm.getInstrumentationInfo(instrumentation.componentName,0).targetPackage==TARGET)
            val bytes=ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat $INPUT")).use {it.bounded(INPUT_LIMIT)}
            val input=Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
            check(input.keys==setOf("purpose","origin","wallet","cookie","cookieExpiresAtMs","createdAtMs","expected"))
            check(input.string("purpose")==PURPOSE && input.string("origin")==ORIGIN)
            val now=System.currentTimeMillis();val created=input.getValue("createdAtMs").jsonPrimitive.long
            check(created<=now && now-created<=5*60*1000)
            val expected=input.getValue("expected").jsonObject
            check(expected.keys==setOf("sourceCommit","packHash","manifestFileSha256","nativeBuildSha","nativeVersionCode","simVersion"))
            check(expected.string("nativeBuildSha")==BuildConfig.NATIVE_BUILD_SHA && expected.getValue("nativeVersionCode").jsonPrimitive.int==BuildConfig.VERSION_CODE)
            check(expected.getValue("simVersion").jsonPrimitive.int==15)
            val manifestBytes=context.assets.open("native/manifest.json").use {it.bounded(16*1024*1024)}
            check(hash(manifestBytes)==expected.string("manifestFileSha256"))
            val manifest=nativeContentManifest(Json.parseToJsonElement(manifestBytes.toString(Charsets.UTF_8)).jsonObject,15)
            check(manifest.contentVersion==expected.string("packHash") && manifest.sourceCommit==expected.string("sourceCommit"))
            val wallet=requireNotNull(input.string("wallet"));check(wallet.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")))
            val raw=requireNotNull(input.string("cookie"));check(raw.length<=8192 && '\r' !in raw && '\n' !in raw)
            val origin=ORIGIN.toHttpUrl();val parsedCookie=requireNotNull(Cookie.parse(origin,raw))
            check(parsedCookie.name=="shardkeep_session" && parsedCookie.hostOnly && parsedCookie.domain==origin.host && parsedCookie.secure && parsedCookie.httpOnly && parsedCookie.path=="/" && parsedCookie.expiresAt>now)
            val cookieExpiry=input.getValue("cookieExpiresAtMs").jsonPrimitive.long
            check(cookieExpiry>now && cookieExpiry<=parsedCookie.expiresAt)
            // Max-Age was relative to the host's response, not this later import.
            val cookie=Cookie.Builder().name(parsedCookie.name).value(parsedCookie.value).hostOnlyDomain(parsedCookie.domain)
                .path(parsedCookie.path).secure().httpOnly().expiresAt(cookieExpiry).build()
            val store=EncryptedStore(context,storageNamespace(ORIGIN,"session"))
            val existing=store.read()
            val journal=EncryptedStore(context,storageNamespace(ORIGIN,"pending-battles"))
            fun assertNoPending() {
                val saved=journal.read() ?: return
                check(saved.length<=8*1024*1024)
                val value=Json.parseToJsonElement(saved).jsonObject
                check(value.string("schemaVersion")=="1" && value.getValue("requests").jsonObject.isEmpty())
            }
            assertNoPending()
            val incomingStore=MemoryStore();val incoming=SessionCookieJar(origin,incomingStore)
            incoming.saveFromResponse(origin,listOf(cookie))
            val api=GameApi(ORIGIN,incoming,"${BuildConfig.VERSION_NAME}:${BuildConfig.VERSION_CODE}:${BuildConfig.NATIVE_BUILD_SHA}") {15}
            runBlocking {
                if(existing!=null) {
                    // A stale/unreadable session is not permission to replace an unknown owner.
                    val oldApi=GameApi(ORIGIN,SessionCookieJar(origin,MemoryStore(existing)),"candidate-session-check")
                    check(oldApi.get("/me").string("wallet")==wallet)
                }
                check(api.get("/me").string("wallet")==wallet)
                val cap=api.get("/native/capabilities");val presentation=cap.getValue("presentation").jsonObject
                check(cap.string("sourceCommit")==manifest.sourceCommit && cap.getValue("simVersion").jsonPrimitive.int==15)
                check(cap.getValue("minimumVersionCode").jsonPrimitive.int<=BuildConfig.VERSION_CODE)
                check(cap.string("contentManifestUrl")=="$ORIGIN/native-content/${manifest.contentVersion}/manifest.json")
                check(presentation.flag("enabled") && JsonPrimitive(2) in presentation.getValue("protocolVersions").jsonArray && JsonPrimitive(2) in presentation.getValue("raidProtocolVersions").jsonArray)
            }
            assertNoPending();check(store.read()==existing)
            // Only now cross the durable boundary, through the existing cookie-jar policy.
            SessionCookieJar(origin,store).saveFromResponse(origin,listOf(cookie))
            check(SessionCookieJar(origin,store).loadForRequest(origin.resolve("/api/me")!!).single {it.name==cookie.name}.value==cookie.value)
            succeeded=true
        } finally {
            val removed=try { removeInput(instrumentation) } catch (_: Exception) { false }
            // Closed evidence only; no wallet, cookies, paths to credentials, or raw failures.
            File(context.noBackupFilesDir,"candidate-session-${System.currentTimeMillis()}.json").writeText(buildJsonObject {
                put("success",succeeded && removed);put("inputDeleted",removed);put("normalSignatureSessionVerified",succeeded)
                put("walletSdkApprovalTested",false);put("gameplayRequests",0)
            }.toString())
            check(removed)
        }
    }
}
