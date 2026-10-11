package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.model.FantasySearchResult

/**
 * The search drawer's RECENT section (design/final/map/SPEC.md §2.4, map-search: "empty query: Recent (up to 5)"): the
 * kingdoms this player pressed GO on, newest first, one row per deed (realm + tile), at most [limit]. Each row is the
 * owner search's own [FantasySearchResult] as it was when chosen, so a GO on it flies to that kingdom, never to whatever
 * the last query returned. Process memory only (no storage, no network): it lives as long as the World tab's screen.
 * [limit] is the SPEC's list length, not a game number. UI thread only.
 */
internal class WorldSearchRecent(private val limit: Int = 5) {
    private val recent = ArrayList<FantasySearchResult>()

    /** The player chose [result]: it moves to the top, replacing an older row for the same deed. */
    fun record(result: FantasySearchResult) {
        recent.removeAll { it.realmId == result.realmId && it.tileId == result.tileId }
        recent.add(0, result)
        while (recent.size > limit.coerceAtLeast(0)) recent.removeAt(recent.lastIndex)
    }

    /** The rows newest first (a copy: a later [record] never changes a list already drawn). */
    fun rows(): List<FantasySearchResult> = recent.toList()
}
