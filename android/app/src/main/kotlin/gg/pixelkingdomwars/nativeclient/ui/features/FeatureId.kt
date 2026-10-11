package gg.pixelkingdomwars.nativeclient.ui.features

/**
 * The id of one Feature Registry row (UX-ARCHITECTURE §6.1), for example `hud.profile` or `goldforge.forge`.
 *
 * Every door the UI draws (a command, an edge button, a resource row's GO) carries one, and every callback hands one
 * back, so a screen never decides where a tap goes: the registry does. Kept as a value class so it costs nothing at
 * runtime and cannot be confused with any other string.
 */
@JvmInline value class FeatureId(val value: String)
