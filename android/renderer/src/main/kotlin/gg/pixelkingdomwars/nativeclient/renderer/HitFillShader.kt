package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.graphics.glutils.ShaderProgram

/** Phaser FILL discards texture RGB but retains texture × sprite alpha. SpriteBatch uses
 * straight-alpha textures, so this shader leaves premultiplication to its existing blend. */
object HitFillShader {
    fun create()=ShaderProgram(vertex,fragment).also {
        if(!it.isCompiled) { val log=it.log;it.dispose();error("Hit fill shader: $log") }
    }
    // libGDX 1.13.1 SpriteBatch attribute/uniform contract, including packed-alpha correction.
    val vertex="""
        attribute vec4 a_position;
        attribute vec4 a_color;
        attribute vec2 a_texCoord0;
        uniform mat4 u_projTrans;
        varying vec4 v_color;
        varying vec2 v_texCoords;
        void main() {
            v_color=a_color;
            v_color.a*=255.0/254.0;
            v_texCoords=a_texCoord0;
            gl_Position=u_projTrans*a_position;
        }
    """.trimIndent()
    val fragment="""
        #ifdef GL_ES
        precision mediump float;
        #define LOWP lowp
        #else
        #define LOWP
        #endif
        varying LOWP vec4 v_color;
        varying vec2 v_texCoords;
        uniform sampler2D u_texture;
        void main() {
            gl_FragColor=vec4(1.0,1.0,1.0,texture2D(u_texture,v_texCoords).a*v_color.a);
        }
    """.trimIndent()
}
