package gg.pixelkingdomwars.nativeclient.scene.world

/**
 * Switches for the world surface while the GL30 engines are being built (GLOBE-NATIVE-PLAN §9, N0).
 *
 * [gl30Requested] (honoured in debug builds only) runs the World tab's unchanged legacy globe on the GL30 world
 * surface: `WorldGraphics` with the robust context factory, the frame pacer, the engine guard, a background-compiled
 * smoke program through `Gl3Core`, and the `Gdx.gl30` leak fix on leave. It exists so N0's gate can prove, on the
 * guarded SwiftShader emulator and on the Seeker, that a GL30 context comes up and that World → Kingdom leaves no GL30
 * handle behind. Default off: until N1 the World tab is exactly today's legacy globe on libGDX's ES 2 surface.
 *
 * Set from the debug launch extra `worldGl30` (a one-line change in `MainActivity`, owned by the integration commit).
 */
object WorldEngineFlags {
    @Volatile var gl30Requested: Boolean = false
    /** N1/N2 (debug builds only, launch extra `worldLegacy`): keep the legacy globe on a build whose World tab would run
     *  the GL30 engines, for the owner's side-by-side (RG-1). Default off. */
    @Volatile var legacyWorld: Boolean = false
}
