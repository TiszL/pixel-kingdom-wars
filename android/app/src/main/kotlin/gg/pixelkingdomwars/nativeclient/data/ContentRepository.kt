package gg.pixelkingdomwars.nativeclient.data

import android.app.Application
import android.os.Build
import gg.pixelkingdomwars.nativeclient.content.*
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.UUID
import android.util.Log
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.network.string
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Fixed before content loading starts. A failed debug fixture never becomes an account session. */
enum class LaunchMode(val offline: Boolean) {
    ACCOUNT(false), OFFLINE_BASE(true), OFFLINE_BATTLE(true);
    companion object {
        fun fromLaunch(debug: Boolean, preview: String?): LaunchMode = when {
            !debug -> ACCOUNT
            preview == "base" -> OFFLINE_BASE
            preview == "battle" -> OFFLINE_BATTLE
            else -> ACCOUNT
        }
    }
}

data class ContentState(
    val assets: File? = null,
    val catalogue: JsonObject? = null,
    val renderCatalogue: JsonObject? = null,
    val error: String? = null,
    val contentUpdate: String? = null,
    val updateNotice: String? = null,
    val minimumNativeBuild: Int = 0,
    val checking: Boolean = false,
    /** Full optional pins for exactly the admitted catalogue; published in the same state transition. */
    val manifest: NativeContentManifest? = null,
    /** An eligible mandatory app update (M45 §5) pauses orders until it installs; account access stays available. */
    val updateMandatoryBlocked: Boolean = false,
) {
    val ready: Boolean get() = assets != null && catalogue != null && renderCatalogue != null
    val simVersion: Int? get() = catalogue?.string("simVersion")?.toIntOrNull()
    /** `rendererContractVersion` of the LOADED render catalogue: what `X-PKW-Renderer-Contract` declares, so the
     * API names only ground this pack can draw (docs/UPDATE_COMPATIBILITY.md, contract 15). Null until published. */
    val rendererContract: Int? get() = renderCatalogue?.string("rendererContractVersion")?.toIntOrNull()
    /** `minimumVersionCode` from `/native/capabilities`: an explicit server retirement gates orders. */
    fun allowsGameOrders(versionCode: Int): Boolean = versionCode >= minimumNativeBuild && !updateMandatoryBlocked
}

interface ContentRepository {
    val state: StateFlow<ContentState>
    val mode: LaunchMode
    /** Prepares bundled content and restores any downloaded generation; safe to call repeatedly. */
    suspend fun initialize()
    /** SIM named by the loaded catalogue, or by the bundled manifest before the catalogue is published. */
    fun simVersion(): Int?
    fun allowsGameOrders(versionCode: Int): Boolean = state.value.allowsGameOrders(versionCode)
    suspend fun checkUpdates(api: ApiClient, force: Boolean)
    /** Activates a prepared generation; [canActivate] must refuse while a battle or replay is visible. */
    suspend fun applyUpdate(canActivate: () -> Boolean)
    /** Retire the content-update line once read; the pending update itself stays until applied. */
    fun dismissUpdateNotice() {}
    suspend fun loadPreviewFixtures(): Pair<JsonObject, JsonObject?>
}

/** Port of the content half of the former `GameModel`: bundle preparation, admitted catalogue,
 * downloaded generations and the `/native/capabilities` update check. Not account-scoped. */
class LiveContentRepository(private val application: Application, override val mode: LaunchMode, private val origin: String,
                            private val debug: Boolean, private val versionCode: Int,
                            /** Receives each decoded capabilities response (the in-app update channel reads its offer). */
                            private val onCapabilities: (NativeCapabilities) -> Unit = {}) : ContentRepository {
    private val _state = MutableStateFlow(ContentState())
    override val state: StateFlow<ContentState> = _state.asStateFlow()
    // Cold-start measurement 2026-10-06 (BOOT_CONTENT ms=1973 on a warm pack): each preparation stage is also a PKWLoad line
    // (BOOT_CONTENT_STAGE), which candidate builds print; the PKWContentLoad Log.i line is debug-only and R8 strips it there.
    private val loadSink: ((ContentLoadSample) -> Unit)? = { sample ->
        if (debug) Log.i("PKWContentLoad", sample.diagnostic())
        gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.contentStage(sample.stage.name, sample.elapsedNanos / 1_000_000,
            sample.files, sample.bytes, sample.succeeded)
    }
    private val verifier by lazy { contentVerifierFingerprint(application) }
    private val updates by lazy { NativeContentUpdates(File(application.noBackupFilesDir, storageNamespace(origin, "content-updates")), origin, onLoad = loadSink, verifier = verifier) }
    private val readiness = ContentUpdateReadiness()
    private val gate = Mutex()
    @Volatile private var bundledSimVersion: Int? = null
    private var phase = StartupPhase.START
    private val startupClaim = LocalCandidateStartup()

    private fun step(next: StartupPhase) { phase = next; if (debug) Log.i("PKWStartup", next.name) }

    override fun simVersion(): Int? = _state.value.simVersion ?: bundledSimVersion

    override suspend fun initialize() {
        gate.withLock {
            if (_state.value.ready) return
            val started = gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.clock()
            startupClaim.normalStartup()
            try {
                readiness.load {
                    step(StartupPhase.PREPARING_BUNDLE)
                    val (assets, manifest) = withContext(Dispatchers.IO) {
                        val bytes = application.assets.open("native/manifest.json").use { it.readBytes() }
                        val raw = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                        bundledSimVersion = raw["simVersion"]?.jsonPrimitive?.intOrNull
                        BundledContent.prepare(application.noBackupFilesDir, bytes, debug, loadSink, verifier = verifier) { path -> application.assets.open("native/$path") } to raw
                    }
                    step(StartupPhase.READING_BUNDLE)
                    val context = withContext(Dispatchers.IO) { contentLoadWork(ContentLoadStage.BUNDLE_HEADERS, loadSink) {
                        val bundledCatalogue = Json.parseToJsonElement(File(assets, "catalogue.json").readText()).jsonObject
                        val bundledRenderer = (manifest["rendererContractVersion"] as? JsonPrimitive)?.intOrNull
                            ?: GameContentCache.admitted(assets, loadSink).renderCatalogue.getValue("rendererContractVersion").jsonPrimitive.int
                        ContentUpdateContext(requireNotNull(manifest.string("contentVersion")), requireNotNull(bundledCatalogue.string("simVersion")).toInt(), bundledRenderer)
                    } }
                    step(StartupPhase.RESTORING_CONTENT)
                    val restored = if (mode.offline) null else updates.restore(context.simVersion, context.rendererVersion, context.bundledVersion)
                    if (restored != null) publish(restored, updates.admittedManifest(restored))
                    else publish(withContext(Dispatchers.IO) { GameContentCache.admitted(assets, loadSink) },
                        nativeContentManifest(manifest, context.simVersion))
                    context
                }
                step(StartupPhase.CONTENT_READY)
                gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.stage(gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent.BOOT_CONTENT, started)
                _state.update { it.copy(error = null) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (!mode.offline) gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.record(
                    gg.pixelkingdomwars.nativeclient.telemetry.NativeError.STARTUP, error)
                if (debug) Log.i("PKWStartup", startupFailureDiagnostic(phase, error))
                _state.update { it.copy(error = error.message ?: "Game content could not be prepared") }
                throw error
            } finally { readiness.finishStartup() }
        }
    }

    /** Explicit test-APK bootstrap only. It never changes installed compatibility or updater
     * admission. A failed attempt is terminal for this repository: no bundle fallback. */
    suspend fun bootstrapLocalCandidate(directory: File, manifestBytes: ByteArray, expectedSha256: String): Closeable {
        val ownedBytes = manifestBytes.copyOf()
        gate.withLock {
            startupClaim.candidateStartup()
            var owned: LocalCandidateLease? = null
            try {
                requireLocalCandidateEnvironment(BuildConfig.DEBUG && debug, BuildConfig.APPLICATION_ID,
                    Build.HARDWARE, mode, BuildConfig.API_ORIGIN, origin)
                readiness.load {
                    val admitted = withContext(Dispatchers.IO) {
                        val context = currentCoroutineContext()
                        owned = retainLocalCandidate(application.noBackupFilesDir, directory, ownedBytes, expectedSha256) {
                            context.ensureActive()
                        }
                        val verified = requireNotNull(owned)
                        GameContentCache.admitted(directory, loadSink).also {
                            validateLocalCandidateHeaders(it.catalogue, it.renderCatalogue, verified.manifest)
                            context.ensureActive()
                        }
                    }
                    currentCoroutineContext().ensureActive()
                    val manifest = requireNotNull(owned).manifest
                    bundledSimVersion = manifest.simVersion
                    publish(admitted, manifest)
                    ContentUpdateContext(manifest.contentVersion, manifest.simVersion, 15)
                }
                readiness.finishStartup()
                step(StartupPhase.CONTENT_READY)
                return requireNotNull(owned).also { owned = null }
            } finally { owned?.close() }
        }
    }

    private fun publish(content: AdmittedGameContent, manifest: NativeContentManifest) {
        check(content.catalogue.getValue("simVersion").jsonPrimitive.int == manifest.simVersion)
        GameContentCache.retainOnly(content.directory)
        _state.update { it.copy(assets = content.directory, catalogue = content.catalogue, renderCatalogue = content.renderCatalogue, manifest = manifest) }
    }

    override suspend fun checkUpdates(api: ApiClient, force: Boolean) {
        if (mode.offline) return
        val context = readiness.current ?: run { if (debug) Log.i("PKWStartup", "UPDATE_WAITING_CONTENT"); return }
        if (!readiness.beginCheck(force, System.nanoTime())) return
        _state.update { it.copy(checking = true) }
        try {
            gate.withLock {
                val capabilities = NativeCapabilities.from(api.get("/native/capabilities"))
                onCapabilities(capabilities)
                val minimum = capabilities.minimumVersionCode.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                _state.update { it.copy(minimumNativeBuild = minimum) }
                if (minimum > versionCode) { _state.update { it.copy(updateNotice = "A newer app is required for the latest native features. Install the reviewed APK or the available store update.") }; return@withLock }
                val url = capabilities.contentManifestUrl ?: return@withLock
                if (force) _state.update { it.copy(updateNotice = "Checking game content…") }
                val pending = updates.prepare(url, context.simVersion, context.bundledVersion, context.rendererVersion)
                _state.update { it.copy(contentUpdate = pending, updateNotice = when {
                    pending != null -> "Game content is ready to apply."
                    force -> "Game content is up to date."
                    else -> null
                }) }
            }
        } catch (error: SessionSupersededException) { readiness.sessionSuperseded(); throw error }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            Log.w("PKWContentUpdate", "release=$versionCode ${contentUpdateDiagnostic(error)}")
            _state.update { it.copy(updateNotice = "The content update could not finish. Your current content is still available.") }
        } finally { _state.update { it.copy(checking = false) } }
    }

    override suspend fun applyUpdate(canActivate: () -> Boolean) {
        gate.withLock {
            check(canActivate()) { "Finish the battle before applying content" }
            check(!_state.value.checking) { "Wait for the content download to finish" }
            try {
                updates.activate()?.let { directory ->
                    val admitted = withContext(Dispatchers.IO) { GameContentCache.admitted(directory, loadSink) }
                    publish(admitted, updates.admittedManifest(admitted))
                }
                _state.update { it.copy(contentUpdate = null, updateNotice = "Game content updated.") }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                Log.w("PKWContentUpdate", "release=$versionCode ${contentUpdateDiagnostic(error)}")
                throw error
            }
        }
    }

    override fun dismissUpdateNotice() { _state.update { it.copy(updateNotice = null) } }

    fun blockOrdersForUpdate(blocked: Boolean) { _state.update { it.copy(updateMandatoryBlocked = blocked) } }

    override suspend fun loadPreviewFixtures(): Pair<JsonObject, JsonObject?> {
        check(debug && mode.offline)
        val assets = requireNotNull(_state.value.assets)
        return withContext(Dispatchers.IO) {
            // Fixtures are extracted but never hashed at launch; the preview is the scene that reads them.
            BundledContent.verifyFixtures(assets)
            val base = Json.parseToJsonElement(File(assets, "fixtures/base.json").readText()).jsonObject
            val replay = if (mode == LaunchMode.OFFLINE_BATTLE) Json.parseToJsonElement(File(assets, "fixtures/replay.json").readText()).jsonObject else null
            base to replay
        }
    }

    fun close() { if (!mode.offline) { updates.cancelDownloads(); CoroutineScope(Dispatchers.IO).launch { updates.close() } } }
}

/** Pure guard/fence helpers keep the explicit local seam testable without weakening Android guards. */
internal class LocalCandidateStartup {
    private var normal = false
    private var candidate = false
    fun normalStartup() { check(!candidate) { "Local candidate bootstrap did not complete" }; normal = true }
    fun candidateStartup() { check(!normal && !candidate) { "Content startup already claimed" }; candidate = true }
}

internal fun requireLocalCandidateEnvironment(debug: Boolean, packageId: String, hardware: String,
    mode: LaunchMode, buildOrigin: String, repositoryOrigin: String) {
    check(debug && packageId == "gg.pixelkingdomwars.twa.debug" && hardware == "ranchu" && mode == LaunchMode.ACCOUNT &&
        buildOrigin == "https://127.0.0.1:18443" && repositoryOrigin == buildOrigin) { "Local candidate bootstrap refused" }
}

internal class LocalCandidateLease(val manifest: NativeContentManifest, private val storeLease: ContentLease,
    private val sceneLease: ContentLease) : Closeable {
    override fun close() { try { sceneLease.close() } finally { storeLease.close() } }
}

/** Reads only an already installed immutable generation. Fresh install is owned by the test APK.
 * A unique verifier forces complete core hashing even if another build left a valid stat stamp. */
internal fun retainLocalCandidate(noBackup: File, directory: File, bytes: ByteArray, expectedHash: String,
    checkpoint: () -> Unit = {}): LocalCandidateLease {
    val owned = bytes.copyOf()
    require(owned.size in 1..16 * 1024 * 1024 && expectedHash.matches(Regex("[a-f0-9]{64}")))
    require(MessageDigest.getInstance("SHA-256").digest(owned).joinToString("") { "%02x".format(it) } == expectedHash)
    val raw = Json.parseToJsonElement(owned.decodeToString()).jsonObject
    require(raw["rendererContractVersion"] == JsonPrimitive(15))
    val manifest = nativeContentManifest(raw, 18)
    val root = File(noBackup, storageNamespace("https://127.0.0.1:18443", "content-updates"))
    // Android may alias the trusted Context parent (/data/user/0 -> /data/data).
    // Canonicalize only that anchor; caller generation spelling and both owned
    // descendants must still match exactly, with no root/generation symlinks.
    require(root.canonicalFile == File(noBackup.canonicalFile, root.name))
    require(Files.isDirectory(root.toPath(), LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(root.toPath()))
    require(directory.absoluteFile.normalize() == File(root, manifest.contentVersion) &&
        directory.canonicalFile == File(root.canonicalFile, manifest.contentVersion))
    require(Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(directory.toPath()))
    val expected = ContentManifest(1, manifest.sourceCommit, manifest.contentVersion,
        manifest.files.map { ContentFile(it.path, it.sha256, it.size, it.tier) })
    checkpoint()
    var hashed = false
    val store = ContentStore(root, verifier = "local-candidate-${UUID.randomUUID()}", onVerification = { hashed = it.hashed })
    val retained = store.retain(manifest.contentVersion)
    try {
        check(hashed && retained.manifest == expected) { "Local candidate receipt differs" }
        checkpoint()
        val scene = SceneContentLeases.acquire(root, directory)
        return LocalCandidateLease(manifest, retained, scene)
    } catch (failure: Throwable) { retained.close(); throw failure }
}

internal fun validateLocalCandidateHeaders(catalogue: JsonObject, render: JsonObject, manifest: NativeContentManifest) {
    require(catalogue["schemaVersion"] == JsonPrimitive(1) && catalogue["sourceCommit"] == JsonPrimitive(manifest.sourceCommit) &&
        catalogue["simVersion"] == JsonPrimitive(manifest.simVersion) && manifest.simVersion == 18 &&
        render["schemaVersion"] == JsonPrimitive(1) && render["rendererContractVersion"] == JsonPrimitive(15))
}
