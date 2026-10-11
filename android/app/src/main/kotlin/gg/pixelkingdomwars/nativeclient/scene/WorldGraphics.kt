package gg.pixelkingdomwars.nativeclient.scene

import android.content.res.Configuration
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import com.badlogic.gdx.ApplicationListener
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.LifecycleListener
import com.badlogic.gdx.backends.android.AndroidApplicationBase
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidApplicationLogger
import com.badlogic.gdx.backends.android.AndroidClipboard
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import com.badlogic.gdx.backends.android.AndroidGraphics
import com.badlogic.gdx.backends.android.AndroidNet
import com.badlogic.gdx.backends.android.AndroidVisibilityListener
import com.badlogic.gdx.backends.android.surfaceview.FillResolutionStrategy
import com.badlogic.gdx.backends.android.surfaceview.GLSurfaceView20
import com.badlogic.gdx.backends.android.surfaceview.ResolutionStrategy
import com.badlogic.gdx.utils.GdxNativesLoader
import com.badlogic.gdx.utils.GdxRuntimeException
import gg.pixelkingdomwars.nativeclient.scene.world.RenderModeGate
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEgl
import javax.microedition.khronos.egl.EGL10
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.egl.EGLContext
import javax.microedition.khronos.egl.EGLDisplay
import javax.microedition.khronos.opengles.GL10

/**
 * The world surface's context factory (GLOBE-NATIVE-PLAN §5.7 "Detection"). libGDX's `GLSurfaceView20$ContextFactory`
 * asks only for the client version (so a GPU reset is never reported), reads a STATIC target version that the last
 * constructed `GLSurfaceView20` anywhere in the app wrote, and falls back to ES 2 silently. This one walks
 * [WorldEgl.worldLadder] (robust ES 3 → plain ES 3 → ES 2), records what it made in [created] (the shared worker
 * must match it) and counts contexts in [generation] (libGDX gives the listener no callback when it recreates one).
 */
class WorldContextFactory(private val version: Int, private val log: (String) -> Unit = { Log.w(TAG, it) }) : GLSurfaceView.EGLContextFactory {
    @Volatile var created: WorldEgl.ContextSpec? = null; private set
    @Volatile var generation = 0; private set

    override fun createContext(egl: EGL10, display: EGLDisplay, config: EGLConfig): EGLContext {
        val extensions = egl.eglQueryString(display, EGL10.EGL_EXTENSIONS)
        for (spec in WorldEgl.worldLadder(version, extensions)) {
            val context = egl.eglCreateContext(display, config, EGL10.EGL_NO_CONTEXT, spec.attributes())
            if (context != null && context != EGL10.EGL_NO_CONTEXT) {
                created = spec; generation++
                log("world context $spec (generation $generation)")
                return context
            }
            log("eglCreateContext($spec) failed 0x${Integer.toHexString(egl.eglGetError())}")
        }
        created = null
        return EGL10.EGL_NO_CONTEXT
    }

    override fun destroyContext(egl: EGL10, display: EGLDisplay, context: EGLContext) {
        if (!egl.eglDestroyContext(display, context)) log("eglDestroyContext failed 0x${Integer.toHexString(egl.eglGetError())}")
    }

    companion object { const val TAG = "PKWWorldGL" }
}

/**
 * libGDX's `AndroidGraphics` for the world surface (GLOBE-NATIVE-PLAN §5.6, §5.7):
 * - its `GLSurfaceView20` uses [WorldContextFactory] (robust context, reset detection);
 * - [requestRendering] only marks the [FramePacer] dirty: libGDX's touch handler calls it on every touch event, which
 *   would otherwise render at the panel's 120 Hz;
 * - [setContinuousRendering] is the pacer's motion flag, never the view's render mode, EXCEPT inside libGDX's pause
 *   handshake ([gate], entered by [WorldApplicationFragment.onPause]): `AndroidFragmentApplication.onPause` turns
 *   continuous rendering on so the GL thread processes `pause()`/`destroy()`, and `destroy()` waits with no timeout.
 *   Routing that call to the pacer would deadlock the UI thread ([RenderModeGate]).
 * - `onDrawFrame` tells the pacer when a frame starts, stamps its presentation time before the swap, and reports the
 *   frame's GL-thread CPU time. libGDX's queued pause event calls `onDrawFrame(null)`: that is not a paced frame.
 */
class WorldGraphics private constructor(app: AndroidApplicationBase, config: AndroidApplicationConfiguration, strategy: ResolutionStrategy) :
    AndroidGraphics(app, config, strategy) {

    // Set inside createGLSurfaceView, which the superclass constructor calls: lateinit has no initializer to reset them.
    lateinit var contextFactory: WorldContextFactory; private set
    lateinit var pacer: FramePacer; private set
    lateinit var surfaceView: GLSurfaceView20; private set

    val gate = RenderModeGate()
    @Volatile var framesDrawn = 0L; private set
    /** GL thread: once per drawn frame, with the frame's start and its `onDrawFrame` CPU time (a primitive
     *  interface, not a Kotlin function type, so a frame boxes nothing). */
    @Volatile var frameListener: FrameListener? = null
    /** GL thread: the surface's buffer size after every `onSurfaceChanged` (the `setFixedSize` check, plan §5.5). */
    @Volatile var surfaceListener: ((width: Int, height: Int) -> Unit)? = null

    override fun createGLSurfaceView(app: AndroidApplicationBase, resolutionStrategy: ResolutionStrategy): GLSurfaceView20 {
        val setup = checkNotNull(PENDING.get()) { "WorldGraphics must be built through WorldGraphics.create" }
        contextFactory = setup.factory
        pacer = setup.pacer
        if (!checkGL20()) throw GdxRuntimeException("libGDX requires OpenGL ES 2.0")
        val chooser = eglConfigChooser
        val view = GLSurfaceView20(app.context, resolutionStrategy, if (config.useGL30) 3 else 2)
        if (chooser != null) view.setEGLConfigChooser(chooser)
        else view.setEGLConfigChooser(config.r, config.g, config.b, config.a, config.depth, config.stencil)
        view.setEGLContextFactory(setup.factory) // before setRenderer: the GL thread starts there
        view.setRenderer(this)
        surfaceView = view
        return view
    }

    override fun requestRendering() { pacer.markDirty() }

    override fun setContinuousRendering(isContinuous: Boolean) {
        if (gate.setContinuous(isContinuous)) super.setContinuousRendering(isContinuous) else pacer.setContinuous(isContinuous)
    }

    override fun isContinuousRendering(): Boolean = gate.isContinuous(super.isContinuousRendering())

    /** The current world context's native handle (`EGL14.eglGetCurrentContext().nativeHandle`), taken in
     *  `onSurfaceCreated`, which `GLSurfaceView` calls for every new context: `Gl3Core.beginFrame` compares it per frame
     *  without allocating an `EGLContext` wrapper each time (plan §5.7, §5.9). */
    @Volatile var contextHandle = 0L; private set

    override fun onSurfaceCreated(gl: GL10?, config: javax.microedition.khronos.egl.EGLConfig?) {
        contextHandle = android.opengl.EGL14.eglGetCurrentContext().nativeHandle
        super.onSurfaceCreated(gl, config)
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        super.onSurfaceChanged(gl, width, height)
        pacer.surfaceReady()
        surfaceListener?.invoke(width, height)
    }

    override fun onDrawFrame(gl: GL10?) {
        if (gl == null) { super.onDrawFrame(null); return }
        pacer.frameStarted()
        val start = System.nanoTime()
        super.onDrawFrame(gl)
        val cpu = System.nanoTime() - start
        pacer.beforeSwap()
        framesDrawn++
        frameListener?.onFrame(start, cpu)
    }

    /** The real view render mode is on-demand from the start (GLSurfaceView defaults to continuous). */
    private fun renderOnDemand() { super.setContinuousRendering(false) }

    fun interface FrameListener { fun onFrame(startNanos: Long, cpuNanos: Long) }

    private class Setup(val factory: WorldContextFactory, val pacer: FramePacer)

    companion object {
        private val PENDING = ThreadLocal<Setup>()

        /** UI thread. The superclass constructor calls [createGLSurfaceView] before this class's fields exist, so the
         *  factory and pacer travel through a thread-local for the duration of the constructor. */
        fun create(app: AndroidApplicationBase, config: AndroidApplicationConfiguration, strategy: ResolutionStrategy,
                   factory: WorldContextFactory, pacer: FramePacer): WorldGraphics {
            PENDING.set(Setup(factory, pacer))
            try {
                return WorldGraphics(app, config, strategy).also { it.renderOnDemand(); pacer.attach(it.surfaceView) }
            } finally { PENDING.remove() }
        }
    }
}

/**
 * A libGDX fragment whose view can be built on [WorldGraphics] (GLOBE-NATIVE-PLAN §3.3, §5.6, §5.7).
 *
 * `AndroidFragmentApplication.initializeForView` builds its `AndroidGraphics` inline, so [initializeWorldView] is a copy
 * of libGDX 1.13.1's `initializeForView(listener, config)`, taken from its bytecode (javap) statement for statement,
 * with one change: `graphics = WorldGraphics.create(…)`. The anonymous audio lifecycle listener (`$1`) is reproduced
 * as an object. `LibGdxPinTest` fails on a libGDX version bump and checks every member this copy touches, so the
 * copy is re-derived instead of silently drifting.
 *
 * [initializeForView] (the libGDX original) stays available and unchanged for the legacy path.
 */
open class WorldApplicationFragment : AndroidFragmentApplication() {
    /** The world graphics when [initializeWorldView] built this fragment's view; null on the legacy path. */
    var worldGraphics: WorldGraphics? = null; private set

    fun initializeWorldView(listener: ApplicationListener, config: AndroidApplicationConfiguration,
                            factory: WorldContextFactory, pacer: FramePacer): View {
        if (version < 19) throw GdxRuntimeException("libGDX requires Android API Level 19 or later.")
        GdxNativesLoader.load()
        setApplicationLogger(AndroidApplicationLogger())
        val world = WorldGraphics.create(this, config, config.resolutionStrategy ?: FillResolutionStrategy(), factory, pacer)
        this.graphics = world
        worldGraphics = world
        this.input = createInput(this, requireActivity(), world.surfaceView, config)
        this.audio = createAudio(requireActivity(), config)
        this.files = createFiles()
        this.net = AndroidNet(this, config)
        this.listener = listener
        this.handler = Handler(Looper.myLooper() ?: Looper.getMainLooper())
        this.clipboard = AndroidClipboard(requireActivity())
        val audio = this.audio
        addLifecycleListener(object : LifecycleListener {
            override fun resume() { audio.resume() }
            override fun pause() { audio.pause() }
            override fun dispose() { audio.dispose() }
        })
        Gdx.app = this
        Gdx.input = this.input
        Gdx.audio = this.audio
        Gdx.files = this.files
        Gdx.graphics = this.graphics
        Gdx.net = this.net
        createWakeLock(config.useWakelock)
        useImmersiveMode(config.useImmersiveMode)
        if (config.useImmersiveMode) AndroidVisibilityListener().createListener(this)
        if (resources.configuration.keyboard != Configuration.KEYBOARD_NOKEYS) this.input.setKeyboardAvailable(true)
        return world.surfaceView
    }

    override fun onResume() {
        super.onResume()
        worldGraphics?.pacer?.start()
    }

    override fun onPause() {
        val world = worldGraphics
        if (world == null) { super.onPause(); return }
        world.pacer.stop()
        world.gate.during { super.onPause() }
    }

    override fun onDestroyView() {
        worldGraphics?.pacer?.release()
        super.onDestroyView()
    }
}
