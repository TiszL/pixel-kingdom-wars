package gg.pixelkingdomwars.nativeclient.scene

import android.content.Context
import android.hardware.display.DisplayManager
import android.opengl.EGL14
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.view.Choreographer
import android.view.Display
import android.view.Surface
import android.view.SurfaceHolder
import gg.pixelkingdomwars.nativeclient.scene.world.PacerClock
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEgl
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 60 fps on a 120 Hz panel (GLOBE-NATIVE-PLAN §5.6). The world surface always renders on demand
 * (`RENDERMODE_WHEN_DIRTY`); this pacer, on its own `HandlerThread` and `Choreographer` (so Compose jank never delays a
 * frame request), calls `GLSurfaceView.requestRender()` on every [PacerClock.interval]-th vsync while the world is
 * dirty or in motion, and the GL thread stamps each frame with `eglPresentationTimeANDROID` (the Swappy method) so the
 * compositor presents it exactly `interval` vsyncs after its start.
 *
 * - `WorldGraphics.requestRendering()` (touch, intents, postRunnable) only calls [markDirty]; nothing else requests a
 *   render, so a touch storm at 120 Hz still renders at 60.
 * - [setContinuous] is motion (a gesture, inertia, a flight, a fade, or the legacy renderer's animation flag).
 * - [requestIn] is the idle scheduler's next timed frame; `IdleScheduler.NEVER` posts nothing: at 0 fps no timer
 *   wakes the CPU, and the vsync callback stops re-posting as soon as nothing is wanted.
 * - A `DisplayManager` listener keeps the refresh rate current; `Surface.setFrameRate(60, DEFAULT, ONLY_IF_SEAMLESS)`
 *   is a power hint only (API 30+), re-applied on every `surfaceCreated` and cleared on [stop].
 * - [stop] (pause) and [release] never block; [release] quits the thread without joining it.
 */
class FramePacer(context: Context, targetFps: Int, private val log: (String) -> Unit = {}) {
    private val displays = context.getSystemService(DisplayManager::class.java)
    private val displayId = Display.DEFAULT_DISPLAY
    private val clock = PacerClock(targetFps, displays?.getDisplay(displayId)?.refreshRate ?: 60f)
    private val thread = HandlerThread("world-pacer", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
    private val handler = Handler(thread.looper)
    private var choreographer: Choreographer? = null
    private val dirty = AtomicBoolean(true)
    private val posted = AtomicBoolean(false)
    @Volatile private var continuous = false
    @Volatile private var inFlight = false
    @Volatile private var running = false
    @Volatile private var released = false
    @Volatile private var view: GLSurfaceView? = null
    private var hintedSurface: Surface? = null

    /** The presentation target of the last started frame (CLOCK_MONOTONIC ns); read by the GL thread. */
    @Volatile var presentationTargetNs = 0L; private set
    @Volatile var refreshHz = clock.refreshHz; private set
    @Volatile var interval = clock.interval; private set
    @Volatile var targetFps = targetFps; private set
    @Volatile var framesStarted = 0L; private set
    @Volatile var presentationsSet = 0L; private set
    val isContinuous: Boolean get() = continuous

    private val frameCallback = Choreographer.FrameCallback { frameTimeNanos -> onVsync(frameTimeNanos) }
    private val kick = Runnable {
        if (!running || released) { posted.set(false); return@Runnable }
        val c = choreographerOrInit()
        c.removeFrameCallback(frameCallback) // never two callbacks in one vsync
        c.postFrameCallback(frameCallback)
    }
    private val delayedDirty = Runnable { markDirty() }
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) = Unit
        override fun onDisplayRemoved(id: Int) = Unit
        override fun onDisplayChanged(id: Int) { if (id == displayId) displays?.getDisplay(id)?.refreshRate?.let(::refresh) }
    }
    private val holderCallback = object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) { hint(holder.surface) }
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
        override fun surfaceDestroyed(holder: SurfaceHolder) { if (hintedSurface === holder.surface) hintedSurface = null }
    }

    init { displays?.registerDisplayListener(displayListener, handler) }

    /** UI thread, once the view exists. */
    fun attach(view: GLSurfaceView) {
        this.view = view
        view.holder.addCallback(holderCallback)
        if (view.holder.surface?.isValid == true) hint(view.holder.surface)
    }

    /** Any thread: something changed, draw one frame at the next paced vsync. */
    fun markDirty() { dirty.set(true); ensurePosted() }

    /** Any thread: motion on/off. */
    fun setContinuous(on: Boolean) { continuous = on; if (on) ensurePosted() }

    /** Any thread: one frame after [delayMs] (the idle cadence); `Long.MAX_VALUE` cancels and posts nothing. */
    fun requestIn(delayMs: Long) {
        handler.removeCallbacks(delayedDirty)
        when {
            delayMs == Long.MAX_VALUE -> Unit
            delayMs <= 0L -> markDirty()
            else -> handler.postDelayed(delayedDirty, delayMs)
        }
    }

    /** Any thread: the ladder's frame rate (60, or 30 at L3). */
    fun setTargetFps(fps: Int) {
        handler.post { clock.setTarget(fps); targetFps = clock.targetFps; interval = clock.interval }
    }

    /** UI thread (resume). The first wanted vsync starts at once. */
    fun start() {
        if (released) return
        handler.post { clock.reset() }
        inFlight = false
        running = true
        view?.holder?.surface?.takeIf { it.isValid }?.let(::hint)
        if (dirty.get() || continuous) ensurePosted()
    }

    /** UI thread (pause). No more requests; the frame-rate vote is withdrawn. */
    fun stop() {
        running = false
        handler.removeCallbacks(delayedDirty)
        clearHint()
    }

    /** UI thread (the surface is going away). Never joins. */
    fun release() {
        if (released) return
        released = true; running = false
        handler.removeCallbacksAndMessages(null)
        runCatching { displays?.unregisterDisplayListener(displayListener) }
        view?.holder?.removeCallback(holderCallback)
        clearHint()
        view = null
        thread.quitSafely()
    }

    // ---------------------------------------------------------------- GL thread

    private var eglDisplay: EGLDisplay? = null
    private var eglSurface: EGLSurface? = null
    private var presentationTime = false

    /** GL thread, `onSurfaceChanged`: cache the draw surface and whether presentation times are supported. */
    fun surfaceReady() {
        val display = EGL14.eglGetCurrentDisplay()
        eglDisplay = display
        eglSurface = EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW)
        presentationTime = display != EGL14.EGL_NO_DISPLAY &&
            WorldEgl.listed(EGL14.eglQueryString(display, EGL14.EGL_EXTENSIONS), WorldEgl.EXT_PRESENTATION_TIME)
    }

    val presentationTimeSupported: Boolean get() = presentationTime

    private var frameTargetNs = 0L

    /** GL thread, at the start of `onDrawFrame`: the requested frame is being drawn. Its presentation target is taken
     *  now, before the pacer can start the next frame and move [presentationTargetNs] on. */
    fun frameStarted() { frameTargetNs = presentationTargetNs; inFlight = false }

    /** GL thread, after the frame's GL work and before `GLSurfaceView` swaps. */
    fun beforeSwap() {
        val target = frameTargetNs
        val display = eglDisplay; val surface = eglSurface
        if (!presentationTime || target == 0L || display == null || surface == null || surface == EGL14.EGL_NO_SURFACE) return
        if (EGLExt.eglPresentationTimeANDROID(display, surface, target)) presentationsSet++
    }

    // ---------------------------------------------------------------- pacer thread

    private fun choreographerOrInit(): Choreographer = choreographer ?: Choreographer.getInstance().also { choreographer = it }

    private fun ensurePosted() {
        if (running && !released && posted.compareAndSet(false, true)) handler.post(kick)
    }

    private fun refresh(hz: Float) {
        clock.setRefresh(hz)
        refreshHz = clock.refreshHz; interval = clock.interval
    }

    private fun onVsync(frameTimeNanos: Long) {
        if (!running || released) { posted.set(false); return }
        val want = continuous || dirty.get()
        if (inFlight && clock.inFlightExpired(frameTimeNanos)) inFlight = false
        if (clock.onVsync(frameTimeNanos, want, inFlight)) {
            dirty.set(false)
            inFlight = true
            presentationTargetNs = clock.presentationTargetNs()
            framesStarted++
            view?.requestRender()
        }
        if (continuous || dirty.get()) { choreographerOrInit().postFrameCallback(frameCallback); return }
        posted.set(false)
        // a markDirty() that raced the flag above must not be lost
        if ((dirty.get() || continuous) && running) ensurePosted()
    }

    private fun hint(surface: Surface) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !surface.isValid) return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                surface.setFrameRate(targetFps.toFloat(), Surface.FRAME_RATE_COMPATIBILITY_DEFAULT, Surface.CHANGE_FRAME_RATE_ONLY_IF_SEAMLESS)
            else surface.setFrameRate(targetFps.toFloat(), Surface.FRAME_RATE_COMPATIBILITY_DEFAULT)
            hintedSurface = surface
        }.onFailure { log("frame-rate hint failed: ${it.message}") }
    }

    private fun clearHint() {
        val surface = hintedSurface ?: return
        hintedSurface = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !surface.isValid) return
        runCatching { surface.setFrameRate(0f, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT) }
    }
}
