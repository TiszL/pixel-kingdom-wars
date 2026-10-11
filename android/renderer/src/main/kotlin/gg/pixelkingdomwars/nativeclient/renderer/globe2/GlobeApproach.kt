package gg.pixelkingdomwars.nativeclient.renderer.globe2

/**
 * D-NEXT approach prefetch (native only): when the player is about to dive, ask the host for the realm's core FAR set
 * before the dive does. The owner pinch-dives without opening the realm panel, so nothing was prefetched and every dive
 * was cold (2.6–3.0 s, 5.7 s the first; a prefetched one lands in 0.47 s on the Seeker). Two signs, over a realm whose
 * map can open:
 * - the camera has rested [restMs] at an altitude of at most [restAlt] (the player looks at the realm up close), or
 * - a pinch aims below [pinchAlt] (the dive is coming; its floor is at 0.3).
 *
 * Never while the globe spins (inertia) or flies (a selection's or the dive's own flight: the dive prepares its realm
 * itself). Conflated: one [step] answer per realm while the camera stays in the zone ([restAlt] over that realm); leaving
 * the zone (the sea, another realm, higher up) re-arms it, and another realm answers anew. Pure, GL thread, no
 * allocation.
 */
class GlobeApproach(val restMs: Double = REST_MS, val restAlt: Double = REST_ALT, val pinchAlt: Double = PINCH_ALT) {
    /** The realm the last [step] answer named while the camera stays in its zone (null once it left, or none): the
     *  renderer builds no island close-up beside that realm's prefetch. */
    var fired: String? = null; private set
    private var restSince = Double.NaN
    private var restRealm: String? = null

    /**
     * One globe frame. [realmId]: the realm under the view centre when its map can open, else null; [alt] and [targetAlt]:
     * the camera's altitude and its zoom target's; [pinching]: two fingers are down; [moving]: anything moved this frame
     * (gestures, zoom, lens, selection); [spinning], [flying]: inertia and camera flights. Returns the realm to prefetch,
     * or null.
     */
    fun step(nowMs: Double, realmId: String?, alt: Double, targetAlt: Double, pinching: Boolean, moving: Boolean,
             spinning: Boolean, flying: Boolean): String? {
        if (realmId == null || minOf(alt, targetAlt) > restAlt) { reset(); return null }
        if (spinning || flying) { restSince = Double.NaN; return null }
        if (moving) restSince = Double.NaN
        else if (restSince.isNaN() || realmId != restRealm) { restSince = nowMs; restRealm = realmId }
        val due = (pinching && targetAlt < pinchAlt) ||
            (!restSince.isNaN() && alt <= restAlt && nowMs - restSince >= restMs)
        if (!due || fired == realmId) return null // (another realm under the view answers anew)
        fired = realmId
        return realmId
    }

    /** ms until a rest in progress would answer ([step] needs a frame then; at 0 fps the globe draws none), -1 for none. */
    fun wakeInMs(nowMs: Double): Double {
        if (restSince.isNaN() || restRealm == null || restRealm == fired) return -1.0
        return maxOf(0.0, restSince + restMs - nowMs)
    }

    /** Forget everything (a dive began, the globe slept or restored). */
    fun reset() { fired = null; restSince = Double.NaN; restRealm = null }

    companion object {
        /** The rest before an approach answers: `GPU_SAFE.rehearseIdleMs`, the same idle the globe waits before any
         *  rehearsal (a camera still for that long is looking, not passing over). */
        const val REST_MS = 400.0
        /** Resting at or below this altitude over a realm (the realm fills the view; the dive floor is at 0.3). */
        const val REST_ALT = 0.6
        /** A pinch whose target is below this altitude is on its way to a dive. */
        const val PINCH_ALT = 0.5
    }
}
