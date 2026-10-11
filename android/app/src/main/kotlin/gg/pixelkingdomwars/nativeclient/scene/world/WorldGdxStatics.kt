package gg.pixelkingdomwars.nativeclient.scene.world

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.android.AndroidGL20
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30

/**
 * libGDX's static GL handles across the World (GLES 3) and Kingdom/battle (GLES 2) surfaces (GLOBE-NATIVE-PLAN §3.3).
 *
 * libGDX 1.13.1 (javap) leaks the GL30 handle across fragments: `AndroidGraphics.setupGL` writes `Gdx.gl30` only in its
 * GL30 branch and never clears it in the GL20 branch, `AndroidFragmentApplication.onResume` resets `Gdx.app`, `input`
 * and `graphics` but not `gl30`, and `SpriteBatch.<init>` picks the VAO vertex path when `Gdx.gl30 != null`. One World
 * visit would therefore put Kingdom and battle on GLES 3 VAO calls inside ES 2 contexts.
 *
 * - [clearGl30] runs when the world surface pauses or is disposed (GL thread) and again after its view is destroyed
 *   (UI thread): no GL30 handle survives the World tab.
 * - [restoreGl30] runs when the world surface resumes. The plan names only the clear; without the restore a World tab
 *   that was backgrounded would come back with `Gdx.gl30 == null` (libGDX's `setupGL` returns early when its own
 *   handle exists), and every libGDX object built on the VAO path would crash on its next bind.
 *
 * The handles are stateless wrappers over `android.opengl.GLES20/30`, so any GL20 instance is equivalent.
 */
object WorldGdxStatics {
    /** Clears every GL3x handle; returns true when one was set (the leak this closes). */
    fun clearGl30(plain: () -> GL20 = { AndroidGL20() }): Boolean {
        val leaked = Gdx.gl30 != null || Gdx.gl31 != null || Gdx.gl32 != null || Gdx.gl is GL30 || Gdx.gl20 is GL30
        Gdx.gl30 = null; Gdx.gl31 = null; Gdx.gl32 = null
        if (Gdx.gl is GL30 || Gdx.gl20 is GL30) {
            val gl20 = plain()
            check(gl20 !is GL30) { "The GL20 replacement must not be a GL30 handle" }
            Gdx.gl = gl20; Gdx.gl20 = gl20
        }
        return leaked
    }

    /** Puts the world surface's own GL30 handle back (null: nothing to restore, the surface runs ES 2). */
    fun restoreGl30(gl30: GL30?) {
        if (gl30 == null) return
        Gdx.gl = gl30; Gdx.gl20 = gl30; Gdx.gl30 = gl30
    }
}
