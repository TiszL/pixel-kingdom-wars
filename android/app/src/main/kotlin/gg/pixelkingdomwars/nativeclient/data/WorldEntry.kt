package gg.pixelkingdomwars.nativeclient.data

/**
 * Why another screen opened the World tab (GLOBE-NATIVE-PLAN §1.1 N4; the web's `worldIntent`, GLOBE-PRODUCTION-PLAN
 * §2.2.1). It rides the existing `HomeRequest` queue (`HomeRequest.World`), so the tab switch and the intent survive the
 * hand-off together, and the World screen consumes it exactly once. An entry never adds server behaviour: it only says
 * where the globe starts and which existing read or action the HUD offers first.
 */
sealed interface WorldEntry {
    /** F5: choose land on the map (LandGate "choose your land on the map"). The card's CHOOSE THIS LAND drafts the tile
     *  through the existing `draftLand` and returns to LandGate's drafted-tile state. */
    data object ChooseLand : WorldEntry
    /** F13: find a PvP rival (the raid chooser's WORLD, a battle's WORLD MAP). The card's SCOUT and RAID stay gated by the
     *  server's parcel detail; nothing is computed here. */
    data object Rivals : WorldEntry
    /** F14: the inventory's "View deeds": one owned deed opens it like MY PARCEL, several mark your realms on the globe. */
    data object MyDeeds : WorldEntry
    /** Profile › WALLET's SKR tile (SEEKER ISLAND) and the SKR faucet sheet's Seeker door (owner 2026-10-06): the globe
     *  opens with Seeker Island selected and its D-172 island panel up, the same step as the island rail's chip. */
    data object SeekerIsland : WorldEntry
    /** The Berth's and Lodge's craft-vehicle GO ("Public Workshop, Solana Island"; owner 2026-10-06: it landed on the
     *  base screen): the globe opens with Solana Island selected and its Public Workshop sheet up, the island rail chip's
     *  own step. The sheet's CRAFT VEHICLE then opens the one vehicle owner's craft page. */
    data object SolanaIsland : WorldEntry
}
