package gg.pixelkingdomwars.nativeclient.diagnostics

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Deliberately separate from NativeDiagnosticsRuntime: no transport, telemetry or account dependency. */
object LocalBattleReports {
    data class Status(val enabled: Boolean = false, val records: Int = 0, val busy: Boolean = false, val message: String? = null)
    private val mutable = MutableStateFlow(Status())
    val status = mutable.asStateFlow()
    private val consent = LocalReportConsent()
    private val foreground = AtomicBoolean(false)
    private val sceneSequence = AtomicLong()
    private val sceneOwner = AtomicLong()
    private val visible = AtomicBoolean(false)
    private val latest = AtomicReference<LocalSceneSnapshot?>()
    private val writing = AtomicBoolean(false)
    private val eraseThrough = AtomicLong()
    private val watch = LocalStallWatch()
    private val lifecycle = LocalLifecycleWatch()
    private val commands = LocalCommandTiming(::mono)
    private val preparations = LocalPreparationTiming(::mono)
    private val observerUpdate = AtomicBoolean(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val disk = Dispatchers.IO.limitedParallelism(1)
    private val main = Handler(Looper.getMainLooper())
    private var context: Context? = null
    private var store: LocalReportStore? = null // Serial IO only.
    private var observer: Job? = null
    private var configured = false
    @Volatile private var posted: Runnable? = null // Only observer or Main; removal is thread safe.
    private val build = "${BuildConfig.VERSION_NAME}:${BuildConfig.VERSION_CODE}:${BuildConfig.NATIVE_BUILD_SHA}"
    private fun mono() = System.nanoTime() / 1_000_000
    @Synchronized fun initialize(app: Context) {
        if (context != null) return
        context = app.applicationContext
        updateObserver()
    }
    // A span may begin on GL during pause after visibility was cleared. Coalesce
    // observer changes off Main/GL; the instrumentation never takes this monitor.
    private fun requestObserver() {
        if (observerUpdate.compareAndSet(false, true)) scope.launch {
            observerUpdate.set(false); updateObserver()
        }
    }
    @Synchronized private fun updateObserver() {
        if (!consent.enabled || context == null ||
            (!(foreground.get() && visible.get()) && !lifecycle.hasWork(consent.generation) && !commands.hasWork(consent.generation) && !preparations.hasWork(consent.generation))) {
            observer?.cancel(); observer = null; disarm(); return
        }
        if (observer != null) return
        observer = scope.launch {
            try { while (isActive) {
                val generation = consent.generation
                val armed = consent.enabled && foreground.get() && visible.get()
                watch.arm(armed, mono())
                if (armed) watch.probe(mono())?.let { token ->
                    Runnable { watch.acknowledge(token) }.also { posted = it; main.post(it) }
                }
                if (writing.compareAndSet(false, true)) {
                    val observation = if (armed) watch.observation(mono()) else null
                    val snapshot = latest.get()?.takeIf { it.valid() }
                    val spans = lifecycle.sample(generation, mono())
                    val commandBatch = commands.sample(generation)
                    val preparationBatch = preparations.sample(generation)
                    if ((observation != null && snapshot != null) || spans != null || commandBatch != null || preparationBatch != null) scope.launch(disk) {
                        try {
                            if (!active(generation)) return@launch
                            val at = System.currentTimeMillis()
                            val old = storage().load(at)
                            val frames = if (observation != null && snapshot != null) old.frames + LocalFrameRecord(
                                at, snapshot.kind.name.lowercase(), observation.mainMs, observation.glMs,
                                observation.inside, snapshot.queueDepth, snapshot.textureMiB, snapshot.pendingWallUploads,
                                snapshot.viewportWidth, snapshot.viewportHeight, snapshot.cameraX, snapshot.cameraY, snapshot.cameraZoom, build)
                                else old.frames
                            // A completed span replaces its earlier unfinished observation.
                            val records = (old.lifecycle + spans?.records.orEmpty()).associateBy { it.at to it.id }.values
                                .sortedWith(compareBy({ it.at }, { it.id })).takeLast(64)
                            val commandRecords = (old.commands + commandBatch?.records.orEmpty()).associateBy { it.at to it.alias }.values
                                .sortedWith(compareBy({ it.at }, { it.alias })).takeLast(LocalCommandTiming.RECORD_LIMIT)
                            val preparationRecords = (old.preparations + preparationBatch?.records.orEmpty()).associateBy { it.at to it.ordinal }.values
                                .sortedWith(compareBy({ it.at }, { it.ordinal })).takeLast(LocalPreparationTiming.LIMIT)
                            save(old.copy(frames = frames.takeLast(32), lifecycle = records, commands = commandRecords, preparations = preparationRecords), generation)
                            if (active(generation) && spans != null) lifecycle.saved(spans)
                            if (active(generation) && commandBatch != null) commands.saved(commandBatch)
                            if (active(generation) && preparationBatch != null) preparations.saved(preparationBatch)
                        } catch (_: Exception) {
                            message(generation, "Local report could not be saved.")
                            // Do not keep polling in the background forever for a
                            // completed span when local storage is unavailable.
                            if (spans != null) lifecycle.saved(spans)
                            if (commandBatch != null) commands.saved(commandBatch)
                            if (preparationBatch != null) preparations.saved(preparationBatch)
                        }
                        finally { writing.set(false); requestObserver() }
                    } else writing.set(false)
                }
                if (!armed && !lifecycle.hasWork(consent.generation) && !commands.hasWork(consent.generation) && !preparations.hasWork(consent.generation)) { requestObserver(); break }
                delay(500)
            } } finally {
                val finished = currentCoroutineContext()[Job]
                synchronized(this@LocalBattleReports) {
                    if (observer === finished) { observer = null; requestObserver() }
                }
            }
        }
    }
    @Synchronized fun setEnabled(on: Boolean) {
        val changed = consent.change(on)
        if (changed == null && configured) return
        configured = true
        val generation = changed ?: consent.invalidate()
        if (!on) eraseThrough.set(generation)
        lifecycle.reset(generation); commands.reset(generation); preparations.reset(generation); disarm(); updateObserver()
        mutable.value = Status(enabled = on)
        scope.launch(disk) {
            try {
                if (consent.generation != generation) return@launch
                if (!on) { storage(); return@launch }
                inspect(generation, history = false, raw = false)
                if (!active(generation)) return@launch
                val at = System.currentTimeMillis()
                val old = storage().load(at)
                save(old.copy(markers = (old.markers + LocalProcessMarker(Process.myPid(), at, build)).takeLast(8)), generation)
            } catch (_: Exception) {
                if (consent.generation == generation) mutable.value = mutable.value.copy(message = if (on) "Local report storage is unavailable." else "Couldn’t delete local reports. Try CLEAR LOCAL REPORTS again.")
            }
        }
    }
    fun foreground(on: Boolean) { foreground.set(on); updateObserver() }
    private fun disarm() { watch.arm(false, mono()); posted?.let(main::removeCallbacks); posted = null }
    fun openScene(): SceneLease = SceneLease(sceneSequence.incrementAndGet())
    class SceneLease internal constructor(private val token: Long) : LocalSceneDiagnostics {
        private val snapshot = AtomicReference(LocalSceneSnapshot(LocalSceneKind.LOADING, 0, 0.0, 0, 0, 0, 0.0, 0.0, 1.0))
        private val activated = AtomicBoolean(false)
        private fun owns() = sceneOwner.get() == token
        fun activate() {
            activated.set(true); sceneOwner.set(token); visible.set(false); updateObserver()
            latest.set(LocalSceneSnapshot(LocalSceneKind.LOADING, 0, 0.0, 0, 0, 0, 0.0, 0.0, 1.0))
        }
        fun visible(on: Boolean) { if (owns()) { visible.set(on); updateObserver() } }
        fun close() { if (sceneOwner.compareAndSet(token, 0)) { visible.set(false); updateObserver(); latest.set(null) } }
        override fun frameStarted() { if (owns()) watch.start(mono()) }
        override fun frameCompleted() { if (owns()) watch.complete(mono()) }
        override fun state(snapshot: LocalSceneSnapshot) { if (owns() && consent.enabled && snapshot.valid()) { this.snapshot.set(snapshot); latest.set(snapshot) } }
        override fun lifecycle(stage: LocalLifecycleStage): LocalLifecycleSpan? {
            if (!activated.get() || !consent.enabled) return null
            val ticket = lifecycle.begin(consent.generation, stage, snapshot.get(), mono(), System.currentTimeMillis(), build) ?: return null
            requestObserver()
            // Outgoing leases may close before GL acknowledges disposal. Keep the
            // captured safe context until end; clear/disable invalidates the ticket.
            return LocalLifecycleSpan { lifecycle.end(ticket, mono()); requestObserver() }
        }
    }
    /** One scope per account/base coordinator. Callbacks contain no persisted identifiers.
     * The predicate is a cheap current-session/base read; it never performs IO. */
    fun commandTiming(current: () -> Boolean, selection: () -> Long): CommandLease = CommandLease(current, selection)
    class CommandLease internal constructor(private val current: () -> Boolean, private val selection: () -> Long) : gg.pixelkingdomwars.nativeclient.network.BattleCommandTiming {
        private val sessions = commands.SelectionScope()
        private fun allowed() = consent.enabled && current()
        fun close() { preparations.close(this); sessions.close(); requestObserver() }
        internal fun drawTiming() = LocalCommandDrawTiming(commands) {
            if (!allowed()) null else sessions.current(selection())?.let { consent.generation to it }
        }
        internal fun bodySubmitted(view: LocalCommandDrawTiming, value: BattleCommandBodySubmission) {
            if (!allowed()) return
            view.submitted(value); requestObserver()
        }
        override fun preparation(): gg.pixelkingdomwars.nativeclient.network.BattlePreparationTiming? {
            if (!allowed()) return null
            val generation = consent.generation
            val selected = selection()
            val session = sessions.current(selected) ?: return null
            val observed = preparations.begin(generation, this, System.currentTimeMillis(), build) {
                allowed() && active(generation) && selection() == selected && session.active.get()
            } ?: return null
            requestObserver()
            return object : gg.pixelkingdomwars.nativeclient.network.BattlePreparationTiming by observed {
                override fun stage(stage: gg.pixelkingdomwars.nativeclient.network.BattlePreparationStage) { observed.stage(stage); requestObserver() }
                override fun finish(outcome: gg.pixelkingdomwars.nativeclient.network.BattlePreparationOutcome) { observed.finish(outcome); requestObserver() }
            }
        }
        internal fun preparationTrace(ordinal: Long, revision: String): LocalPreparationTrace? {
            if (!allowed()) return null
            val trace = preparations.mapping(consent.generation, this, ordinal, revision) ?: return null
            requestObserver()
            fun observed(value: LocalPreparationTrace): LocalPreparationTrace = object : LocalPreparationTrace {
                override fun stage(stage: LocalPreparationStage) { value.stage(stage); requestObserver() }
                override fun renderer(generation: Long) = value.renderer(generation)?.let(::observed)
                override fun finish(outcome: LocalPreparationOutcome) { value.finish(outcome); requestObserver() }
            }
            return observed(trace)
        }
        internal fun reusePreparation(ordinal: Long, revision: String) {
            if (!allowed()) return
            preparations.reuse(consent.generation, this, ordinal, revision)
            requestObserver()
        }
        override fun input(): gg.pixelkingdomwars.nativeclient.network.BattleInputTiming? {
            if (!allowed()) return null
            val generation = consent.generation
            val selectionEpoch = selection()
            val session = sessions.current(selectionEpoch) ?: return null
            val ticket = commands.input(generation, session, System.currentTimeMillis(), build) ?: return null
            requestObserver()
            return object : gg.pixelkingdomwars.nativeclient.network.BattleInputTiming {
                override fun admitted(id: String) {
                    if (!allowed() || !active(generation) || selection() != selectionEpoch || !session.active.get()) return
                    commands.bind(ticket, id); requestObserver()
                }
            }
        }
        override fun stage(id: String, stage: gg.pixelkingdomwars.nativeclient.network.BattleCommandStage) {
            if (!allowed()) return
            val session = sessions.current(selection()) ?: return
            commands.stage(consent.generation, session, id, stage); requestObserver()
        }
        override fun transport(id: String): gg.pixelkingdomwars.nativeclient.network.BattleCommandTransportTiming? {
            if (!allowed()) return null
            val generation = consent.generation
            val selectionEpoch = selection()
            val session = sessions.current(selectionEpoch) ?: return null
            val observer = commands.transport(generation, session, id) ?: return null
            requestObserver()
            return gg.pixelkingdomwars.nativeclient.network.BattleCommandTransportTiming { stage ->
                if (allowed() && active(generation) && selection() == selectionEpoch && session.active.get()) {
                    observer.stage(stage); requestObserver()
                }
            }
        }
    }
    fun clear() {
        val generation = consent.invalidate(); eraseThrough.set(generation); lifecycle.reset(generation); commands.reset(generation); preparations.reset(generation); disarm(); requestObserver()
        mutable.value = Status(consent.enabled, message = "Clearing local reports…")
        scope.launch(disk) { try {
            if (consent.generation != generation) return@launch
            storage()
            if (active(generation)) save(LocalReportBundle(markers = listOf(LocalProcessMarker(Process.myPid(), System.currentTimeMillis(), build))), generation)
            if (consent.generation == generation) mutable.value = mutable.value.copy(message = "Local reports cleared.")
        } catch (_: Exception) {
            if (consent.generation == generation) mutable.value = mutable.value.copy(message = "Local reports could not be cleared.")
        } }
    }
    /** Explicit consent to older exits; raw traces require a separate switch in the UI. */
    fun inspectHistory(raw: Boolean) = operation { generation -> inspect(generation, history = true, raw = raw) }
    fun exportPermit(raw: Boolean): LocalExportPermit? = consent.permit(raw)
    fun export(uri: Uri, permit: LocalExportPermit) {
        if (!active(permit.generation)) return
        operation("Export did not finish. Delete the incomplete file and try again.") { generation ->
            if (generation != permit.generation) return@operation
            val app = requireNotNull(context)
            val bundle = storage().load(System.currentTimeMillis())
            check(active(generation))
            app.contentResolver.openOutputStream(uri, "wt")?.use {
                storage().export(bundle, it, permit.raw) { active(generation) }
            } ?: error("No output")
            message(generation, "Report saved to your selected location.")
        }
    }
    private fun operation(failure: String = "Couldn’t finish. Your local report is still available.", block: (Long) -> Unit) {
        if (!consent.enabled || mutable.value.busy) return
        val generation = consent.generation; mutable.value = mutable.value.copy(busy = true, message = null)
        scope.launch(disk) {
            try { if (active(generation)) block(generation) }
            catch (_: Exception) { message(generation, failure) }
            finally { if (active(generation)) mutable.value = mutable.value.copy(busy = false) }
        }
    }
    private fun active(generation: Long) = consent.active(generation)
    private fun storage(): LocalReportStore {
        val result = store ?: LocalReportStore(File(requireNotNull(context).noBackupFilesDir, "local-battle-reports")).also { store = it }
        val erase = eraseThrough.get()
        if (erase != 0L) { result.clear(); eraseThrough.compareAndSet(erase, 0) }
        return result
    }
    private fun save(bundle: LocalReportBundle, generation: Long) {
        storage().save(bundle.retained(System.currentTimeMillis())) { active(generation) }
        if (active(generation)) mutable.value = mutable.value.copy(records = bundle.frames.size + bundle.exits.size + bundle.lifecycle.size + bundle.commands.size + bundle.preparations.size)
    }
    private fun message(generation: Long, text: String) { if (active(generation)) mutable.value = mutable.value.copy(message = text) }
    private fun inspect(generation: Long, history: Boolean, raw: Boolean) {
        if (Build.VERSION.SDK_INT < 30) { message(generation, "Android exit history is unavailable on this device. Live stall reports still work."); return }
        val app = requireNotNull(context)
        val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val processName = Application.getProcessName()
        val at = System.currentTimeMillis()
        val initial = storage().load(at)
        // Android applies the caller UID/package boundary; exact process match excludes SDK subprocesses.
        val exits = manager.getHistoricalProcessExitReasons(app.packageName, 0, 32).map { exit ->
            LocalExitCandidate(exit.timestamp, exit.pid, exit.processName.orEmpty(), reason(exit.reason), exit.status, exit.pss, exit.rss) { exit.traceInputStream }
        }
        val bundle = collectLocalExits(initial, exits, processName, at, history, raw, { active(generation) }) { slot, bytes ->
            storage().saveTrace(slot, bytes) { active(generation) }
        }
        save(bundle, generation)
        if (history) message(generation, "Recent exit history checked. ${bundle.traces.size} optional trace(s) saved locally.")
    }
    private fun reason(value: Int) = when (value) {
        ApplicationExitInfo.REASON_ANR -> "anr"
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native_crash"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
        ApplicationExitInfo.REASON_SIGNALED -> "signal"
        ApplicationExitInfo.REASON_USER_REQUESTED, ApplicationExitInfo.REASON_USER_STOPPED -> "user_exit"
        ApplicationExitInfo.REASON_EXIT_SELF -> "self_exit"
        else -> "other"
    }
}
