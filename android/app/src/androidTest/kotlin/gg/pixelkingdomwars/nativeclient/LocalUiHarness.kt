package gg.pixelkingdomwars.nativeclient

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Build
import android.os.Bundle
import gg.pixelkingdomwars.nativeclient.test.BuildConfig as TestBuildConfig
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File

/** Separate test APK only: authenticates an emulator with a locally generated
 * synthetic session, or an owner-authorized physical device whose runtime proof
 * matches the explicit test-APK-only build property. The property is absent by
 * default. Production origins remain refused; this never proves MWA/Privy approval. */
class LocalUiHarness : Instrumentation() {
    override fun newActivity(loader: ClassLoader, className: String, intent: Intent): Activity =
        super.newActivity(loader, className, intent).also(FloatingHudHarness::applyActivityConfiguration).also(SeekerUiHarness::applyActivityConfiguration)
    private var mode: String? = null
    private var reducedMotion = false
    private var orientation: String? = null
    private var profile: String? = null
    private var fixtureSha256: String? = null
    private var chatLock: String? = null
    private var chatArrivals = false
    private var chatSeconds = 600L
    private var chatRoute = false
    private var chatFailSend = false
    private var chatCards: String? = null
    override fun onCreate(arguments: Bundle?) {
        chatLock = arguments?.getString("chatLock")
        chatArrivals = arguments?.getString("chatArrivals") == "true"
        chatRoute = arguments?.getString("chatRoute") == "true"
        chatFailSend = arguments?.getString("chatFailSend") == "true"
        chatCards = arguments?.getString("chatCards")
        chatSeconds = arguments?.getString("chatSeconds")?.toLongOrNull()?.coerceIn(10, 3600) ?: 600L
        mode = arguments?.getString("mode")
        reducedMotion = arguments?.getString("reducedMotion") == "true"
        orientation = arguments?.getString("orientation")
        profile = arguments?.getString("profile")
        fixtureSha256 = arguments?.getString("fixtureSha256")
        super.onCreate(arguments); start()
    }
    override fun onStart() {
        if (mode == "candidate-session") {
            // The separately compiled test APK cannot reference Result.Companion:
            // the optimized target legitimately removes that unused field.
            var succeeded=false
            var linkageFailure=false
            try { CandidateSessionHarness.bootstrap(this);succeeded=true }
            catch (_: LinkageError) { linkageFailure=true }
            catch (_: Throwable) { /* Session failures never print credentials. */ }
            finish(if(succeeded) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(succeeded) "Generated QA tester session verified and stored. Launch the app normally; wallet SDK approval was not tested.\n"
                    else if(linkageFailure) "Candidate test bootstrap could not link against the optimized app. No credentials are printed; the host must remove any staged input.\n"
                    else "Candidate session bootstrap refused or failed. No credentials are printed; inspect its closed local receipt.\n")
            });return
        }
        if (mode == ChatUiHarness.MODE) {
            val result = runCatching { ChatUiHarness.host(this, chatLock, chatArrivals, chatSeconds, chatRoute, chatFailSend, chatCards) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Scripted offline chat host closed; receipt at $it. No account, network or production write.\n" },
                    { "Scripted offline chat host failed: ${it.message}\n" }))
            }); return
        }
        if (mode == CampaignEntryHarness.MODE) {
            val result = runCatching { CampaignEntryHarness.verify(this) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Offline campaign entry recovery passed; receipt at $it. No account or network requests.\n" },
                    { "Offline campaign entry recovery failed: ${it.message}. Inspect retained campaign-entry receipt.\n" }))
            }); return
        }
        if (mode == WallReceiptHarness.MODE) {
            val result = runCatching { WallReceiptHarness.verify(this) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Offline wall receipt lifecycle passed; receipt at $it. No account or network requests.\n" },
                    { "Offline wall receipt lifecycle failed: ${it.message}. Inspect retained wall-receipt evidence.\n" }))
            }); return
        }
        if (mode == "paired-service") {
            val result = runCatching { PairedServiceHarness.capture(this, requireNotNull(fixtureSha256)) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", if(result.isSuccess) "Paired candidate normal ACCOUNT capture completed; inspect private paired-service receipt. No gameplay commands submitted.\n"
                    else "Paired candidate capture refused or failed; inspect private paired-service receipt. No credentials are printed.\n")
            }); return
        }
        if (mode == "service-art-gl") {
            val result = runCatching { ServiceArtGlHarness.capture(this, requireNotNull(fixtureSha256), profile) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Offline candidate service GL captured at $it. Pixel review required; no account/provider or physical acceptance.\n" },
                    { "Service GL failed; inspect the retained no_backup/service-art-gl receipt.\n" }))
            }); return
        }
        if (mode == "home-camp-gl") {
            val result = runCatching { HomeCampGlHarness.capture(this, requireNotNull(fixtureSha256)) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Verified home camp GL checks saved at $it. No account or training actions used.\n" },
                    { "Home camp GL failed: ${it.message}. Inspect no_backup/home-camp-gl receipt.\n" }))
            }); return
        }
        if (mode == "layered-ground-gl") {
            val result = runCatching { LayeredGroundGlHarness.capture(this, requireNotNull(fixtureSha256), orientation, profile) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Verified layered ground GL capture saved at $it. No production content changed.\n" },
                    { "Layered ground GL failed: ${it.message}. Inspect no_backup/layered-ground-gl receipt.\n" }))
            }); return
        }
        if (mode == LayoutGridGlHarness.MODE) {
            val result = runCatching { LayoutGridGlHarness.verify(this, orientation) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Offline layout grid GL checks passed at $it. No account or network actions.\n" },
                    { "Layout grid GL failed: ${it.message}. Inspect retained layout-grid-gl receipt.\n" }))
            }); return
        }
        if (mode == "battle-input-gl") {
            val result = runCatching { BattleInputGlHarness.verify(this, orientation) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold({ "Native battle input GL checks passed at $it. No account or server commands used.\n" },
                    { "Native battle input GL checks failed: ${it.message}. Inspect retained battle-input-gl receipt.\n" }))
            })
            return
        }
        if (mode in SeekerUiHarness.modes) {
            val result = runCatching { SeekerUiHarness.capture(this, requireNotNull(mode), reducedMotion, orientation, profile) }
            finish(if (result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", result.fold(
                    { "Offline Seeker UI captured at $it. Inspect PNG and accessibility receipt; no account or wallet action tested.\n" },
                    { "Offline Seeker UI capture failed: ${it.message}. Inspect no_backup/seeker-ui receipt.\n" }))
            })
            return
        }
        if(mode=="stage100-gl") {
            val result=runCatching { Stage100GlHarness.capture(this,orientation) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Offline canonical Stage100 GL/lifecycle evidence captured in no_backup/stage100-gl. Visual review required; no physical Seeker acceptance.\n"
                    else "Offline Stage100 GL capture failed; inspect its retained receipt. No account or gameplay requests were made.\n")
            })
            return
        }
        if(mode=="login-navigation") {
            val result=runCatching { LoginNavigationHarness.verify(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Offline Android login navigation lifetime regression passed. No account or SDK authorization tested.\n"
                    else "Offline login navigation regression failed; inspect the local receipt.\n")
            })
            return
        }
        if(mode=="scene-opening-gl" || mode=="replay-opening-gl") {
            val result=runCatching { SceneOpeningGlHarness.capture(this,replay=mode=="replay-opening-gl") }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",result.fold({ "Production scene loading/reveal captured at $it. Inspect compositor and GL evidence.\n" },
                    { "Scene loading/reveal capture failed: ${it.message}. Inspect retained scene-opening-gl receipt.\n" }))
            })
            return
        }
        if(mode==RealmKitGlHarness.MODE) {
            val result=runCatching { RealmKitGlHarness.capture(this,requireNotNull(fixtureSha256),orientation,profile) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",result.fold({ "Revision-5 realm kit GL captures saved at $it. Pixel review required; no production content or Seeker acceptance.\n" },
                    { "Revision-5 realm kit GL capture failed: ${it.message}. Inspect no_backup/realm-kit-gl receipt.\n" }))
            })
            return
        }
        if(mode=="realm-ground-gl") {
            val result=runCatching { RealmGroundGlHarness.capture(this,requireNotNull(fixtureSha256),orientation) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",result.fold({ "Candidate native realm captures saved at $it. Pixel review required; no production content or Seeker acceptance.\n" },
                    { "Candidate native realm capture failed: ${it.message}. Inspect no_backup/realm-ground-gl receipt.\n" }))
            })
            return
        }
        if(mode=="world-detail-gl") {
            val result=runCatching { WorldDetailGlHarness.capture(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",result.fold({ "Offline world detail GL checkpoints passed; inspect retained screenshots. No account or network access.\n" },
                    { "Offline world detail GL failed: ${it.message}. Inspect no_backup/world-detail-gl receipt.\n" }))
            })
            return
        }
        if(mode=="globe-mask") {
            val result=runCatching { GlobeMaskHarness.verify(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Actual Android globe mask format regression passed.\n"
                    else "Actual Android globe mask format regression failed: ${result.exceptionOrNull()?.message}\n")
            })
            return
        }
        if(mode=="world-restoration" || mode=="scene-restoration") {
            val result=runCatching { WorldRestorationHarness.verify(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Offline World and Kingdom restoration removed cold fragments before GL view creation.\n"
                    else "Offline scene restoration failed; inspect the local restoration receipt.\n")
            })
            return
        }
        if(mode=="live-troop-stacks-gl") {
            val result=runCatching { LiveTroopStacksGlHarness.capture(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Synthetic live troop stack GL checkpoints captured; visual inspection required. No account accessed.\n"
                    else "Synthetic live troop stack GL capture failed; inspect the local stage receipt.\n")
            })
            return
        }
        if(mode=="burrow-motion-gl") {
            val result=runCatching { BurrowMotionGlHarness.capture(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Synthetic offline burrow GL checkpoints captured; visual inspection required. No account or gameplay outcome tested.\n"
                    else "Synthetic offline burrow GL capture failed; inspect the local stage receipt.\n")
            })
            return
        }
        if(mode=="gloamfang-motion-gl") {
            val result=runCatching { GloamfangMotionGlHarness.capture(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Synthetic offline Leap/Lunge GL checkpoints captured; visual inspection required. No account or gameplay outcome tested.\n"
                    else "Synthetic offline Leap/Lunge GL capture failed; inspect the local stage receipt.\n")
            })
            return
        }
        if(mode=="walls-gl") {
            val result=runCatching { WallGlHarness.capture(this) }
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Synthetic offline wall GL checkpoints captured; visual inspection required. No account or gameplay outcome tested.\n"
                    else "Synthetic offline wall GL capture failed; inspect the local stage receipt.\n")
            })
            return
        }
        val heroFixture=OfflineHeroGlFixture.entries.singleOrNull { it.mode==mode }
        if(heroFixture!=null) {
            val result=runCatching { MoonsunderGlHarness.capture(this,heroFixture) }
            // The helper finishes its activity and writes evidence before instrumentation exits.
            finish(if(result.isSuccess) Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
                putString("stream",if(result.isSuccess) "Synthetic offline ${heroFixture.label} GL checkpoints captured. No gameplay outcome or wallet approval tested.\n"
                    else "Synthetic offline ${heroFixture.label} GL capture failed; inspect the local stage receipt.\n")
            })
            return
        }
        val input=File(targetContext.noBackupFilesDir,"local-ui-session.json")
        var resultCode=Activity.RESULT_CANCELED
        var message="Local UI setup failed; no credentials are printed.\n"
        try {
            check(LocalUiDeviceAdmission.permits(
                debug = BuildConfig.DEBUG, hardware = Build.HARDWARE,
                expectedPhysicalDevice = TestBuildConfig.NATIVE_LOCAL_PHYSICAL_DEVICE,
                model = Build.MODEL, product = Build.PRODUCT, fingerprint = Build.FINGERPRINT))
            val origin=BuildConfig.API_ORIGIN.toHttpUrl()
            val labels=origin.host.split('.')
            val octets=labels.mapNotNull(String::toIntOrNull)
            val privateHost=origin.host in setOf("localhost","127.0.0.1") ||
                (labels.size==4 && octets.size==4 && octets.all { it in 0..255 } && (octets[0]==10 ||
                    (octets[0]==172 && octets[1] in 16..31) || (octets[0]==192 && octets[1]==168)))
            check(origin.isHttps && origin.port==18443 &&
                privateHost)
            val session=Json.parseToJsonElement(input.readText()).jsonObject
            check(session.string("origin")==BuildConfig.API_ORIGIN)
            val jar=SessionCookieJar(origin,EncryptedStore(targetContext,storageNamespace(BuildConfig.API_ORIGIN,"session")))
            jar.saveFromResponse(origin,listOf(requireNotNull(Cookie.parse(origin,
                requireNotNull(session.string("cookie"))+"; Path=/; Secure; HttpOnly"))))
            val api=GameApi(BuildConfig.API_ORIGIN,jar,"local-ui-instrumentation")
            val identity=runBlocking { api.get("/me") }
            check(identity.string("wallet")==session.string("wallet"))
            val fault=File(targetContext.noBackupFilesDir,"local-training-fault.json")
            val requestedFault=fault.exists()
            if(requestedFault) runBlocking { LocalTrainingRecoveryFaults.prepare(targetContext,api,session,fault) }
            message="Synthetic local session verified. " +
                    (if(requestedFault) "Requested local fault preparation completed. " else "No fault preparation was requested. ") +
                    "No wallet approval was tested.\n"
            resultCode=Activity.RESULT_OK
        } catch(_: Exception) {
            // Keep the generic failure message; never expose a session through diagnostics.
        } finally {
            if(input.exists() && !input.delete()) {
                resultCode=Activity.RESULT_CANCELED
                message="Local UI input cleanup failed; no credentials are printed.\n"
            }
        }
        // Instrumentation.finish may terminate this process before a finally block runs.
        finish(resultCode,Bundle().apply { putString("stream",message) })
    }
}
