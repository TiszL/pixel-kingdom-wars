package gg.pixelkingdomwars.nativeclient.renderer.gl3

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30

/**
 * Texture formats the world engines allocate (core.js `BYTES` / `FORMAT_OF` / `TYPE_OF`). Bytes feed the allocator
 * tally (`gpuMB`); upload format and type are derived here so a caller cannot pair an integer texture with a float
 * upload. [id] is a small stable number used in the (program, state) pair key: a pipeline variant depends on the
 * target's format (plan §5.3).
 */
enum class Gl3Format(val internal: Int, val bytesPerTexel: Int, val uploadFormat: Int, val uploadType: Int, val integer: Boolean) {
    R8(GL30.GL_R8, 1, GL30.GL_RED, GL20.GL_UNSIGNED_BYTE, false),
    RG8(GL30.GL_RG8, 2, GL30.GL_RG, GL20.GL_UNSIGNED_BYTE, false),
    RGBA8(GL30.GL_RGBA8, 4, GL20.GL_RGBA, GL20.GL_UNSIGNED_BYTE, false),
    /** The world surface's colour format (r/g/b 8, a 0, plan §3.3): a scratch target standing in for the screen. */
    RGB8(GL30.GL_RGB8, 4, GL20.GL_RGB, GL20.GL_UNSIGNED_BYTE, false),
    /** The world surface's depth format (depth 16): the depth partner of a screen-standing scratch target. */
    DEPTH16(GL20.GL_DEPTH_COMPONENT16, 2, GL20.GL_DEPTH_COMPONENT, GL20.GL_UNSIGNED_SHORT, false),
    SRGB8_ALPHA8(GL30.GL_SRGB8_ALPHA8, 4, GL20.GL_RGBA, GL20.GL_UNSIGNED_BYTE, false),
    R8UI(GL30.GL_R8UI, 1, GL30.GL_RED_INTEGER, GL20.GL_UNSIGNED_BYTE, true),
    RG8UI(GL30.GL_RG8UI, 2, GL30.GL_RG_INTEGER, GL20.GL_UNSIGNED_BYTE, true),
    RGBA8UI(GL30.GL_RGBA8UI, 4, GL30.GL_RGBA_INTEGER, GL20.GL_UNSIGNED_BYTE, true),
    R16UI(GL30.GL_R16UI, 2, GL30.GL_RED_INTEGER, GL20.GL_UNSIGNED_SHORT, true),
    RG16UI(GL30.GL_RG16UI, 4, GL30.GL_RG_INTEGER, GL20.GL_UNSIGNED_SHORT, true),
    RGBA16UI(GL30.GL_RGBA16UI, 8, GL30.GL_RGBA_INTEGER, GL20.GL_UNSIGNED_SHORT, true),
    R32UI(GL30.GL_R32UI, 4, GL30.GL_RED_INTEGER, GL20.GL_UNSIGNED_INT, true),
    R16F(GL30.GL_R16F, 2, GL30.GL_RED, GL30.GL_HALF_FLOAT, false),
    RG16F(GL30.GL_RG16F, 4, GL30.GL_RG, GL30.GL_HALF_FLOAT, false),
    RGBA16F(GL30.GL_RGBA16F, 8, GL20.GL_RGBA, GL30.GL_HALF_FLOAT, false),
    R32F(GL30.GL_R32F, 4, GL30.GL_RED, GL20.GL_FLOAT, false);

    /** 1-based: 0 in a state key means "the default framebuffer". */
    val id: Int get() = ordinal + 1

    /** Bytes of one layer with [levels] mip levels (each level halves, floored at 1 texel). */
    fun layerBytes(width: Int, height: Int, levels: Int): Long {
        var total = 0L
        for (level in 0 until levels) total += maxOf(1, width shr level).toLong() * maxOf(1, height shr level)
        return total * bytesPerTexel
    }
}
