package gg.pixelkingdomwars.nativeclient.scene.world

import com.badlogic.gdx.ApplicationListener
import com.badlogic.gdx.Version
import com.badlogic.gdx.backends.android.AndroidApplicationBase
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import com.badlogic.gdx.backends.android.AndroidGraphics
import com.badlogic.gdx.backends.android.surfaceview.GLSurfaceView20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import java.io.File
import java.lang.reflect.Modifier
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The world surface is built on libGDX internals read with javap (GLOBE-NATIVE-PLAN §5.7: "the copy is pinned to libGDX
 * 1.13.1 by a test that fails on a version bump"). `WorldApplicationFragment.initializeWorldView` copies
 * `AndroidFragmentApplication.initializeForView`; `WorldGraphics` overrides `AndroidGraphics.createGLSurfaceView`,
 * `requestRendering`, `setContinuousRendering` and `onDrawFrame`; `RenderModeGate` depends on the exact `onPause`
 * sequence. If libGDX changes any of those class files, these tests fail and the copy must be re-derived, instead of the
 * world surface silently drifting from the library it copies.
 */
class WorldHostPinTest {
    private fun sha256(type: Class<*>): String {
        val path = type.name.substringAfterLast('.').let { "$it.class" }
        val bytes = type.getResourceAsStream(path)!!.use { it.readBytes() }
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    @Test fun `libGDX is exactly the 1_13_1 build the world surface was derived from`() {
        assertEquals("1.13.1", Version.VERSION)
        assertEquals("AndroidFragmentApplication (initializeForView, onPause, onResume)",
            "dd3bcc760e39a52c8f7fc830cef121723b00709662b47ab92ad10e234540b1d7", sha256(AndroidFragmentApplication::class.java))
        assertEquals("AndroidGraphics (constructor, createGLSurfaceView, setupGL, pause, destroy, onDrawFrame)",
            "87901461902d622b276961046261fce0a890d9d578c194eb1c7b89e3897315dd", sha256(AndroidGraphics::class.java))
        assertEquals("GLSurfaceView20 (init installs its own context factory before ours replaces it)",
            "6383088b7a132d8d72accaa48efb0eda116d8bb9cbc573166068205e9aedb35b", sha256(GLSurfaceView20::class.java))
    }

    @Test fun `every libGDX member the copied initializer and the overrides touch still exists with the same access`() {
        val fragment = AndroidFragmentApplication::class.java
        for (field in listOf("graphics", "input", "audio", "files", "net", "clipboard", "listener"))
            assertTrue("$field", Modifier.isProtected(fragment.getDeclaredField(field).modifiers))
        assertTrue(Modifier.isPublic(fragment.getDeclaredField("handler").modifiers))
        fragment.getDeclaredMethod("initializeForView", ApplicationListener::class.java, AndroidApplicationConfiguration::class.java)
        assertTrue(Modifier.isProtected(fragment.getDeclaredMethod("createWakeLock", Boolean::class.javaPrimitiveType).modifiers))
        assertTrue(Modifier.isProtected(fragment.getDeclaredMethod("createFiles").modifiers))
        // AndroidGraphics' methods take javax.microedition GL10, which the JVM test classpath lacks, so its members are
        // checked in the class file's constant pool (names and descriptors) instead of by reflection.
        val pool = String(AndroidGraphics::class.java.getResourceAsStream("AndroidGraphics.class")!!.use { it.readBytes() }, Charsets.ISO_8859_1)
        val base = "Lcom/badlogic/gdx/backends/android/AndroidApplicationBase;"
        val strategy = "Lcom/badlogic/gdx/backends/android/surfaceview/ResolutionStrategy;"
        for (member in listOf("createGLSurfaceView", "($base$strategy)Lcom/badlogic/gdx/backends/android/surfaceview/GLSurfaceView20;",
                "($base" + "Lcom/badlogic/gdx/backends/android/AndroidApplicationConfiguration;$strategy)V",
                "requestRendering", "setContinuousRendering", "isContinuousRendering", "onDrawFrame", "(Ljavax/microedition/khronos/opengles/GL10;)V",
                "onSurfaceChanged", "(Ljavax/microedition/khronos/opengles/GL10;II)V",
                "onSurfaceCreated", "(Ljavax/microedition/khronos/opengles/GL10;Ljavax/microedition/khronos/egl/EGLConfig;)V", "checkGL20", "getEglConfigChooser", "getGL30"))
            assertTrue(member, member in pool)
    }

    /** libGDX's queued pause event calls `onDrawFrame(null)`: a non-null Kotlin parameter would throw inside the UI
     *  thread's pause wait. The overrides must declare `GL10?`. */
    @Test fun `WorldGraphics accepts the null GL10 of libGDX's queued pause frame`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/WorldGraphics.kt").readText()
        assertTrue(Regex("""override fun onDrawFrame\(gl: GL10\?\)""").containsMatchIn(source))
        assertTrue(Regex("""override fun onSurfaceChanged\(gl: GL10\?,""").containsMatchIn(source))
    }

    /**
     * The zero-allocation steady frame (plan §5.9) runs through AndroidGl3 on the device, where no JVM allocation test
     * can reach it: no method body may allocate. Allocation is allowed only in property initializers.
     */
    @Test fun `AndroidGl3 allocates nothing outside its preallocated fields`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/AndroidGles3Ext.kt").readLines()
        val allocation = Regex("""\b(IntArray|LongArray|FloatArray|ByteArray|arrayOf|intArrayOf|longArrayOf|floatArrayOf|listOf|mutableListOf|ArrayList|HashMap)\s*\(|ByteBuffer\.allocate|\.copyOf\(|StringBuilder\(""")
        val offenders = source.withIndex().filter { (_, line) -> allocation.containsMatchIn(line) && !line.trimStart().startsWith("private val ") && !line.trimStart().startsWith("*") }
        assertEquals("allocating lines: $offenders", emptyList<Any>(), offenders.map { it.index + 1 })
        // every Gl3 method is implemented (the compiler checks the signatures; this checks nothing was left abstract)
        val implemented = Class.forName("gg.pixelkingdomwars.nativeclient.scene.AndroidGl3")
        for (method in Gl3::class.java.methods) assertTrue(method.name, !Modifier.isAbstract(implemented.getMethod(method.name, *method.parameterTypes).modifiers))
    }

    /**
     * N0 review defect 3 (2026-09-25): below ES 3.2 the `GLES32` entry points are logging stubs, so an unchecked call turns
     * reset detection off and makes every staged copy a silent no-op. Every ES 3.2 or extension entry point in AndroidGl3
     * must sit on the branch of the path `WorldEngineGuard` chose, and the probe must go through AndroidGl3 (it reported
     * copies an ES 3.1 stub never made).
     */
    @Test fun `ES 3_2 and extension entry points run only on the path the engine guard chose`() {
        val code = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/AndroidGles3Ext.kt").readLines()
            .filter { val t = it.trimStart(); !t.startsWith("*") && !t.startsWith("/**") && !t.startsWith("//") && !t.startsWith("import ") }
        val es32 = code.filter { "GLES32." in it }
        assertEquals("the reset query and the copy", 2, es32.size)
        for (line in es32) assertTrue(line, Regex("""(ResetQuery|CopyImage)\.ES32 -> GLES32\.""").containsMatchIn(line))
        val ext = code.filter { "GLES31Ext." in it }
        assertEquals(1, ext.size)
        for (line in ext) assertTrue(line, "CopyImage.EXT -> GLES31Ext.glCopyImageSubDataEXT(" in line)
        val probe = File("src/debug/kotlin/gg/pixelkingdomwars/nativeclient/scene/probe/DeviceProbe.kt").readText()
        assertTrue("the probe calls ES 3.2 only through AndroidGl3's chosen paths", "GLES32." !in probe && "GLES31Ext." !in probe)
    }

    @Test fun `the world GL thread never blocks the CPU on the GPU`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/AndroidGles3Ext.kt").readText()
        for (blocking in listOf("glFinish", "glReadPixels", "glGetQueryObject")) assertTrue(blocking, blocking !in source)
        assertTrue("waitSync is the GPU-side wait", Regex("""glWaitSync\(sync, 0, GLES30\.GL_TIMEOUT_IGNORED\)""").containsMatchIn(source))
    }
}
