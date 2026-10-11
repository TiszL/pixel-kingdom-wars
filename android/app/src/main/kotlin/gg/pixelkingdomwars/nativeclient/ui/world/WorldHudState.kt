package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.data.WorldEntry
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority

/** Where the World tab is: on the globe, flying into a realm map, on the map, or flying back out (plan §3.5). */
enum class WorldHudMode { GLOBE, DIVING, REALM, LEAVING }
/** What the globe's panel/sheet shows. REALM is the D-166 realm panel; ISLAND the D-172 Phase E island panel; the
 *  others are the native F-flow panels. */
enum class GlobePanel { NONE, REALM, PARCEL, WARZONE, EXPLORE, PARCEL_HELP, ISLAND }

/** The selected deed on a realm map (a base, or open land): catalog tile id and deed column/row. */
data class RealmCard(val tileId: Int, val x: Int, val y: Int)

/** A realm map's camera as the engine last showed it: [x], [y] the realm-local deed point at the screen centre and [d]
 *  device px per deed (the realm frame's `cameraX`, `cameraY`, `cameraScale`). What a resume lands on. [card] (catalog
 *  columns/rows) and [filter] are the HUD's selected deed and chip, which the new engine takes with the landing, before
 *  the camera is placed ([WorldHudFlow.engineMounted]); null leaves the new engine's own (nothing selected, all shown). */
data class RealmResume(val realmId: String, val x: Double, val y: Double, val d: Double, val card: RealmCard? = null, val filter: WorldFilter? = null)

/** Why the World tab is open (a [WorldEntry] from another screen, GLOBE-NATIVE-PLAN §1.1 N4): the globe's hint pill says
 *  it, and the realm panel and the card offer its action first. It lasts until the World tab closes. */
enum class WorldHudIntent { NONE, CHOOSE_LAND, RIVALS, MY_DEEDS }

/**
 * The world HUD's own state (UI thread, immutable snapshots). Server state (parcels, counts, search) stays in
 * `WorldViewModel`; this only says which surface, panel and control is open. Every transition is a pure function that
 * returns the next state and the engine intents it implies, so the back chain and the dive/leave flow are JVM-tested.
 */
data class WorldHudUi(
    val mode: WorldHudMode = WorldHudMode.GLOBE,
    /** The selected realm on the globe, or the open realm map's realm. */
    val realmId: String? = null,
    val panel: GlobePanel = GlobePanel.NONE,
    val peek: Boolean = false,
    /** The EXPLORE panel's chosen chain (catalogue chain id), null for the list. */
    val chainId: String? = null,
    /** The EXPLORE panel's selected small island, `<chain>/<slot>`; null for the chain list. */
    val archipelagoId: String? = null,
    /** The ISLAND panel's Phase E island (`seeker-island`, `solana-island`, `divine-isle`). */
    val islandId: String? = null,
    val globeSearch: Boolean = false,
    val hint: Boolean = true,
    val noMap: String? = null,
    val night: Boolean = false,
    val motion: Boolean = true,
    /** The realm panel was opened by MY PARCEL: "My base" is its gold CTA and "Enter map" steps down (main.js `opts.mine`). */
    val mineCta: Boolean = false,
    /** A fresh open (fade, staggered children, stats count-up) versus a reveal on the way back from a realm map, which
     *  slides in solid with its content in place (index.html `#panel.ready`). [panelSerial] counts fresh opens. */
    val panelFresh: Boolean = true,
    val panelSerial: Int = 0,
    // ---- realm map ----
    val filter: RealmFilter = RealmFilter(),
    val levelOpen: Boolean = false,
    val card: RealmCard? = null,
    val miniOpen: Boolean = true,
    val miniPin: Boolean = false,
    val realmSearch: Boolean = false,
    /** What the dive should select once it lands: your base ("My base" CTA) or a searched/drafted tile. */
    val pendingMine: Boolean = false,
    val pendingTile: RealmCard? = null,
    // ---- N4 flows ----
    val intent: WorldHudIntent = WorldHudIntent.NONE,
    /** Choose mode: the open-deed candidates already offered on this map (newest last, bounded), so Next moves on. */
    val offered: List<Int> = emptyList(),
    /** The realm map's WARZONE status panel (F16), opened from its top-bar chip while a warzone is active. */
    val warzoneOpen: Boolean = false,
    /** A search result in another realm (F9 "Go to ‹realm›"): once this map has left, dive there with it selected. */
    val pendingJump: Pair<String, RealmCard>? = null,
    /** A resume in flight ([WorldHudFlow.engineMounted]): the new engine dives back to this camera, and the realm controls
     *  above (filter, card, minimap, panels) wait for it. */
    val resume: RealmResume? = null,
)

/** One transition: the next state and the intents to offer the engines, in order. */
data class HudStep(val ui: WorldHudUi, val intents: List<WorldIntent> = emptyList())

object WorldHudFlow {
    private fun WorldHudUi.step(vararg intents: WorldIntent) = HudStep(this, intents.toList())

    // ---- globe ----
    fun selectRealm(ui: WorldHudUi, realmId: String, mine: Boolean = false): HudStep =
        ui.copy(realmId = realmId, panel = GlobePanel.REALM, peek = false, globeSearch = false, hint = false, noMap = null, chainId = null,
            mineCta = mine, panelFresh = true, panelSerial = ui.panelSerial + 1)
            .step(WorldIntent.Select(WorldTarget.Realm(realmId)), WorldIntent.FlyTo(WorldTarget.Realm(realmId)))
    /** Exploration islands (RG-1): the EXPLORE panel opens on the island's chain. Island ids are `<chainId>/<slot>`. */
    fun selectIsland(ui: WorldHudUi, islandId: String): HudStep =
        ui.copy(panel = GlobePanel.EXPLORE, chainId = islandId.substringBefore('/'), archipelagoId = islandId, peek = false, globeSearch = false, hint = false, noMap = null)
            .step(WorldIntent.Select(WorldTarget.Island(islandId)), WorldIntent.FlyTo(WorldTarget.Island(islandId)))
    fun deselect(ui: WorldHudUi): HudStep = ui.copy(panel = GlobePanel.NONE, peek = false, chainId = null, archipelagoId = null, islandId = null, mineCta = false).step(WorldIntent.Select(null))
    /**
     * The engine's selection changed (`GlobeEvents.selected`). A tap on a Phase E island selects it in the engine, which
     * reports it here only (D-172): the ISLAND panel opens on it, with no intent back (the island is already selected
     * and framed). The engine's deselect closes that panel. Realm selections are answered through [globePick], so they,
     * and any id that is not a Phase E island, change nothing here.
     */
    fun globeSelected(ui: WorldHudUi, realmId: String?, islandId: String?): HudStep = when {
        ui.mode != WorldHudMode.GLOBE -> ui.step()
        islandId != null && PhaseEIslands.byId(islandId) != null ->
            if (ui.panel == GlobePanel.ISLAND && ui.islandId == islandId) ui.step()
            else ui.copy(panel = GlobePanel.ISLAND, islandId = islandId, realmId = null, chainId = null, peek = false, globeSearch = false, hint = false,
                noMap = null, mineCta = false, panelFresh = true, panelSerial = ui.panelSerial + 1).step()
        realmId == null && islandId == null && ui.panel == GlobePanel.ISLAND -> ui.copy(panel = GlobePanel.NONE, islandId = null, peek = false).step()
        else -> ui.step()
    }
    fun globePick(ui: WorldHudUi, target: WorldTarget?): HudStep = when (target) {
        is WorldTarget.Realm -> selectRealm(ui, target.realmId)
        is WorldTarget.Island -> selectIsland(ui, target.islandId)
        else -> deselect(ui).let { HudStep(it.ui.copy(hint = false), it.intents) }
    }
    fun openPanel(ui: WorldHudUi, panel: GlobePanel): HudStep =
        ui.copy(panel = panel, peek = false, globeSearch = false, hint = false, chainId = if (panel == GlobePanel.EXPLORE) ui.chainId else null,
            archipelagoId = null, mineCta = false, panelFresh = true, panelSerial = ui.panelSerial + 1).step()

    // ---- dive and leave (plan §3.5) ----
    fun enterMap(ui: WorldHudUi, realmId: String, mine: Boolean = false, tile: RealmCard? = null): HudStep =
        if (ui.mode != WorldHudMode.GLOBE) ui.step()
        else ui.copy(mode = WorldHudMode.DIVING, realmId = realmId, pendingMine = mine, pendingTile = tile, globeSearch = false, noMap = null)
            .step(WorldIntent.Dive(realmId))
    /** The realm panel's Enter map and My base (GlobeHud `realmCtaRows`): the player browses the realm or goes to their
     *  base, and choose mode ends there. Only "Choose land here" ([enterMap] as it is) dives on in choose mode. Owner,
     *  Seeker code 31b (2026-09-26): an intent must not stick beyond the flow that set it; a plain Enter map landed on a
     *  suggested open deed with "Next open deed", and every later realm panel offered choose land again. */
    fun browseMap(ui: WorldHudUi, realmId: String, mine: Boolean): HudStep =
        enterMap(if (ui.mode == WorldHudMode.GLOBE && ui.intent == WorldHudIntent.CHOOSE_LAND) ui.copy(intent = WorldHudIntent.NONE) else ui, realmId, mine)
    /**
     * The dive landed: a fresh map (approved HUD defaults), then whatever the dive was for: a searched or drafted tile, your
     * base (at [myBaseD]: TRUE's `BANDS.myBaseD`, or MAP's select distance when this realm has no ready detail, F7), or in
     * choose mode the suggested open deed [openDeed] (GLOBE-PRODUCTION-PLAN §1.3 step 3: the card is up at once).
     */
    fun dived(ui: WorldHudUi, realmId: String, myBase: RealmCard?, openDeed: RealmCard? = null, myBaseD: Double = HudBands.MY_BASE_D): HudStep {
        if (ui.resume?.realmId == realmId) return resumed(ui, realmId)
        val fresh = ui.copy(mode = WorldHudMode.REALM, realmId = realmId, panel = GlobePanel.NONE, filter = RealmFilter(), levelOpen = false,
            card = null, miniOpen = true, miniPin = false, realmSearch = false, pendingMine = false, pendingTile = null, warzoneOpen = false, offered = emptyList(),
            resume = null)
        val suggested = openDeed.takeIf { ui.intent == WorldHudIntent.CHOOSE_LAND && ui.pendingTile == null && !ui.pendingMine }
        val target = ui.pendingTile ?: (if (ui.pendingMine) myBase else null) ?: suggested ?: return fresh.step()
        val step = selectDeed(fresh, target, fly = true, d = if (target == myBase) myBaseD else HudBands.SELECT_D)
        return if (target === suggested) HudStep(step.ui.copy(offered = listOf(target.tileId)), step.intents) else step
    }
    /** A dive that failed puts the realm's panel back so Enter map can retry, and says so ([DIVE_FAILED]) only when the
     *  player was still diving: one ended by their own Back (heard while LEAVING) is a cancel, not a map that could not
     *  load. A resume that failed (the new engine refused it, its realm has no map now, its dive stalled) falls back to
     *  the new engine's clean globe instead ([engineMounted]), silently: that engine never selected the realm. */
    fun diveFailed(ui: WorldHudUi, realmId: String): HudStep =
        if (ui.resume != null) onNewGlobe(ui).step()
        else ui.copy(mode = WorldHudMode.GLOBE, realmId = realmId, panel = GlobePanel.REALM, pendingMine = false, pendingTile = null, panelFresh = false,
            noMap = if (ui.mode == WorldHudMode.DIVING) DIVE_FAILED else null).step()
    /** The globe's notice after a dive that failed on its own ([diveFailed]). */
    const val DIVE_FAILED = "This realm map could not load — tap Enter map to retry"
    fun leave(ui: WorldHudUi): HudStep = if (ui.mode != WorldHudMode.REALM && ui.mode != WorldHudMode.DIVING) ui.step()
        else ui.copy(mode = WorldHudMode.LEAVING, realmSearch = false, levelOpen = false).step(WorldIntent.Leave)
    /** The engine began a dive the HUD did not start (a pinch-in past the globe's dive altitude): the same DIVING state as
     *  [enterMap], with nothing to select on landing and no intent back (the engine is already diving). */
    fun diving(ui: WorldHudUi, realmId: String): HudStep = if (ui.mode != WorldHudMode.GLOBE) ui.step()
        else ui.copy(mode = WorldHudMode.DIVING, realmId = realmId, pendingMine = false, pendingTile = null, globeSearch = false, noMap = null).step()
    /** The engine began to leave the map, whoever asked (a pinch-out, too): LEAVING composes no realm HUD, so the minimap's
     *  frame goes before the first fade frame. No intent back: the engine is already leaving. [left] follows at the fade's end. */
    fun leaving(ui: WorldHudUi): HudStep = if (ui.mode != WorldHudMode.REALM && ui.mode != WorldHudMode.DIVING) ui.step()
        else ui.copy(mode = WorldHudMode.LEAVING, realmSearch = false, levelOpen = false).step()
    /** Back on the globe: the realm the map showed is selected again with its panel (main.js leaveRealm). A pending
     *  cross-realm jump ([jump]) dives straight on into the other realm instead. */
    fun left(ui: WorldHudUi, realmId: String): HudStep {
        val back = ui.copy(mode = WorldHudMode.GLOBE, realmId = realmId, panel = GlobePanel.REALM, peek = false, card = null, realmSearch = false, levelOpen = false,
            mineCta = false, panelFresh = false, warzoneOpen = false, pendingJump = null, resume = null)
        val jump = ui.pendingJump ?: return back.step(WorldIntent.Select(WorldTarget.Realm(realmId)))
        return enterMap(back.copy(panel = GlobePanel.NONE), jump.first, tile = jump.second)
    }
    /** The engine answered a Leave with `NothingToLeave`: it is on the globe with no realm map shown or loading. The leave
     *  completes at once as [left] (never at the 4 s watchdog, under no HUD: LEAVING composes none). */
    fun nothingToLeave(ui: WorldHudUi): HudStep = if (ui.mode != WorldHudMode.LEAVING) ui.step()
        else ui.realmId?.let { left(ui, it) } ?: onNewGlobe(ui).step()
    /**
     * A new engine mounted under this HUD. Every engine starts on the globe with nothing selected, and the old one ended
     * without a leave: a stopped app (the lock screen, Home and back) ends the model's visit (`art` goes null), the old
     * host is released without GL and says nothing, and the next visit's art mounts a new host. Before this the HUD stayed
     * on the old engine's realm map, its chrome over the new globe (owner, Seeker code 31: "it automatically zooms out to
     * globe with minimap preserved transparent").
     *
     * On a realm map ([last] is the camera it showed last), or still diving back to one: the owner's "Same map, same spot".
     * The new engine dives straight back to that camera (a dive's HUD, under its clouds), and the realm controls come
     * back as the player left them once the map is on screen ([dived]). Anything else (a dive or a leave in flight, the
     * globe, no camera for this realm) starts over on the new globe as on entering the World tab; only the player's own
     * choices carry over: the World entry's intent and the night and motion toggles.
     */
    fun engineMounted(ui: WorldHudUi, last: RealmResume?, chips: List<HudChip> = HudChips.ALL): WorldHudUi {
        val camera = ui.resume?.takeIf { ui.mode == WorldHudMode.DIVING }
            ?: last?.takeIf { ui.mode == WorldHudMode.REALM && it.realmId == ui.realmId } ?: return onNewGlobe(ui)
        // the selected deed and the chip land with the camera (WorldEngineHost.landResume), never after it ([resumed]);
        // the chip as the map can show it now ([shownFilter], D-191: the next visit starts before a read carries the bit)
        val target = camera.copy(card = ui.card, filter = engineFilter(shownFilter(ui.filter, chips)))
        return ui.copy(mode = WorldHudMode.DIVING, realmId = target.realmId, resume = target, panel = GlobePanel.NONE, peek = false,
            globeSearch = false, realmSearch = false, noMap = null, pendingMine = false, pendingTile = null, pendingJump = null)
    }
    private fun onNewGlobe(ui: WorldHudUi) = WorldHudUi(intent = ui.intent, night = ui.night, motion = ui.motion)
    /** The resume landed: the realm map the app stopped on, its controls as the player left them. The new engine already
     *  has the filter and the selected deed: they came with the resume and were set before its camera was placed
     *  (WorldEngineHost.landResume). Nothing goes to it now: the engine's select always flies (to SELECT_D from below
     *  it, else a re-centre on the deed), which would take the map off the spot the player left. */
    private fun resumed(ui: WorldHudUi, realmId: String): HudStep = ui.copy(mode = WorldHudMode.REALM, realmId = realmId, resume = null).step()
    /** F9 "Go to ‹realm›": a search result in another realm. Leave this map; [left] dives on into that realm with the
     *  result selected (the same select-and-fly as a globe search result). */
    fun jump(ui: WorldHudUi, realmId: String, card: RealmCard): HudStep =
        if (ui.mode != WorldHudMode.REALM || realmId == ui.realmId) selectDeed(ui.copy(realmSearch = false), card, fly = true)
        else leave(ui.copy(pendingJump = realmId to card, card = null, warzoneOpen = false))

    // ---- realm map ----
    fun selectDeed(ui: WorldHudUi, card: RealmCard?, fly: Boolean, d: Double = HudBands.SELECT_D): HudStep {
        val realm = ui.realmId ?: return ui.step()
        if (card == null) return ui.copy(card = null, miniPin = false).step(WorldIntent.Select(null))
        val target = WorldTarget.Deed(realm, card.x, card.y)
        val next = ui.copy(card = card)
        return if (fly) next.step(WorldIntent.Select(target), WorldIntent.FlyTo(target, d)) else next.step(WorldIntent.Select(target))
    }
    /** The player's filter [filter] ([WorldHudUi.filter] keeps it as chosen); the engine applies it as [chips] can show it
     *  ([shownFilter]). The default, every chip, is the filter as it is. */
    fun setFilter(ui: WorldHudUi, filter: RealmFilter, chips: List<HudChip> = HudChips.ALL): HudStep =
        ui.copy(filter = filter).step(WorldIntent.SetFilter(engineFilter(shownFilter(filter, chips))))
    /**
     * SHARDKEEP D-191: the filter a realm map applies is one its toolbar can show. The Unshielded chip waits for a parcels
     * read that carries the shield bit ([HudChips.realm], D-181), and a stopped app's next visit starts without that
     * knowledge (`WorldViewModel.foreground`), so the chip can go while it is the pressed one. Its kind then applies as
     * "all" with the same level range: engine, toolbar (All pressed), counters and tags agree, and no kingdom hides
     * behind a chip the player can neither see nor release (under Unshielded with no read, every kingdom, your own
     * shielded one included). [WorldHudUi.filter] keeps the player's choice: once the chip is back it applies again
     * ([chipsShown]).
     */
    fun shownFilter(filter: RealmFilter, chips: List<HudChip>): RealmFilter =
        if (chips.any { it.filter && it.id == filter.kind }) filter else filter.copy(kind = "all")
    /** D-191: on the realm map, whenever its chips change (a read carried the shield bit; a new visit starts without it)
     *  or the map comes up (a landing, a resume among them), the engine gets the filter the toolbar shows ([shownFilter]).
     *  Nothing off the map: a dive or a leave has no filter to apply. */
    fun chipsShown(ui: WorldHudUi, chips: List<HudChip>): HudStep =
        if (ui.mode != WorldHudMode.REALM) ui.step() else ui.step(WorldIntent.SetFilter(engineFilter(shownFilter(ui.filter, chips))))
    /** ui.js minimap toggle: portrait with the card up pins/unpins it for that card; otherwise it opens/closes. */
    fun toggleMinimap(ui: WorldHudUi, shown: Boolean, portraitCardUp: Boolean): WorldHudUi = when {
        shown && portraitCardUp -> ui.copy(miniPin = false)
        shown -> ui.copy(miniOpen = false)
        else -> ui.copy(miniOpen = true, miniPin = portraitCardUp || ui.miniPin)
    }

    /** The approved chips as the engine's filter: a kind plus an optional level range (null = 1–20). */
    fun engineFilter(f: RealmFilter): WorldFilter {
        val levels = if (f.lo > 1 || f.hi < 20) f.lo..f.hi else null
        val kind = when (f.kind) {
            "mine" -> WorldFilterKind.MINE; "clan" -> WorldFilterKind.CLAN; "attack" -> WorldFilterKind.ATTACKABLE
            "unshielded" -> WorldFilterKind.UNSHIELDED; else -> if (levels != null) WorldFilterKind.LEVEL else WorldFilterKind.ALL
        }
        return WorldFilter(kind, levels)
    }

    /** The realm map's bases for the engine: catalog deed columns/rows, levels, contracts.js FLAG bits, and whether each
     *  base's shield bit is known at all ([WorldBases.shieldKnown]: the engine's UNSHIELDED passes only a known, clear
     *  bit, D-191). */
    fun basesSnapshot(epoch: Long, realmId: String, bases: List<RealmHudBase>, filter: RealmFilter, card: RealmCard?, myClan: String?): WorldBases {
        val n = bases.size
        val x = IntArray(n); val y = IntArray(n); val level = IntArray(n); val flags = IntArray(n); val shieldKnown = BooleanArray(n)
        bases.forEachIndexed { i, b ->
            x[i] = b.x; y[i] = b.y; level[i] = b.level; shieldKnown[i] = b.shield != null
            var f = HudFlag.OCCUPIED
            if (b.mine) f = f or HudFlag.MINE
            if (b.shield == true) f = f or HudFlag.SHIELD
            if (b.attackable == true) f = f or HudFlag.ATTACKABLE
            if (b.clan != null && b.clan == myClan) f = f or HudFlag.CLAN
            if (filter.passes(b, myClan)) f = f or HudFlag.FILTERED_IN
            if (card?.tileId == b.tileId) f = f or HudFlag.SELECTED
            flags[i] = f
        }
        return WorldBases(epoch, realmId, x, y, level, flags, shieldKnown)
    }

    // ---- N4: entries from other screens (WorldEntry) and the intents they start ----
    /**
     * Applies a [WorldEntry] as the World tab opens. ChooseLand and Rivals start on the globe with the intent's hint;
     * MyDeeds (F14) opens your one deed like MY PARCEL ([myParcel]), marks your realms in the rail when you hold deeds in
     * several, and shows the parcel help when you hold none. [ownedTiles] counts your deeds (`me.ownedTiles`), [mine] is
     * the deed MY PARCEL would pick and [mapped] whether its realm has a map.
     */
    fun entry(ui: WorldHudUi, entry: WorldEntry, ownedTiles: Int, ownedRealms: Int, mine: RealmCard?, mineRealm: String?, mapped: Boolean): HudStep {
        fun start(intent: WorldHudIntent): HudStep =
            if (ui.mode != WorldHudMode.GLOBE) ui.copy(intent = intent).step()
            else deselect(ui.copy(intent = intent, hint = true, globeSearch = false, offered = emptyList())).let { HudStep(it.ui.copy(hint = true), it.intents) }
        return when (entry) {
            WorldEntry.ChooseLand -> start(WorldHudIntent.CHOOSE_LAND)
            WorldEntry.Rivals -> start(WorldHudIntent.RIVALS)
            WorldEntry.MyDeeds -> when {
                ownedTiles == 0 || mine == null || mineRealm == null -> openPanel(ui.copy(intent = WorldHudIntent.NONE), GlobePanel.PARCEL_HELP)
                ownedTiles == 1 || ownedRealms == 1 -> myParcel(ui.copy(intent = WorldHudIntent.NONE), mineRealm, mapped)
                else -> start(WorldHudIntent.MY_DEEDS)
            }
            // Profile › WALLET's SEEKER ISLAND door (owner 2026-10-06): the island rail's own step, so the panel and the
            // engine selection match a chip tap exactly. Off the globe (a realm map is open) it changes nothing.
            WorldEntry.SeekerIsland -> PhaseEIslands.select(ui.copy(intent = WorldHudIntent.NONE), PhaseEIslands.SEEKER_ISLAND_ID)
            // The Berth's and Lodge's craft-vehicle GO (owner 2026-10-06): the same chip step, onto the Public Workshop sheet.
            WorldEntry.SolanaIsland -> PhaseEIslands.select(ui.copy(intent = WorldHudIntent.NONE), PhaseEIslands.SOLANA_ISLAND_ID)
        }
    }
    /** MY PARCEL (F7): the realm with your base, "My base" its gold CTA (main.js tools `mine`); in a realm without a map the
     *  globe's parcel panel shows the deed instead (the caller reads it with `select`). */
    fun myParcel(ui: WorldHudUi, realmId: String, mapped: Boolean): HudStep =
        if (mapped) selectRealm(ui, realmId, mine = true)
        else openPanel(ui.copy(realmId = realmId), GlobePanel.PARCEL).let { HudStep(it.ui, listOf(WorldIntent.Select(WorldTarget.Realm(realmId)), WorldIntent.FlyTo(WorldTarget.Realm(realmId)))) }
    /** F6: a tile drafted for checkout reopens straight into its realm map with the deed selected, in choose mode so "Next
     *  open deed" can pick another; without a map the globe's parcel panel shows it. */
    fun reopenDraft(ui: WorldHudUi, realmId: String, card: RealmCard, mapped: Boolean): HudStep {
        val choose = ui.copy(intent = WorldHudIntent.CHOOSE_LAND, hint = false)
        return if (mapped) enterMap(choose, realmId, tile = card)
        else openPanel(choose.copy(realmId = realmId), GlobePanel.PARCEL).let { HudStep(it.ui, listOf(WorldIntent.Select(WorldTarget.Realm(realmId)), WorldIntent.FlyTo(WorldTarget.Realm(realmId)))) }
    }
    /** The globe hint pill: a no-map notice first, then the intent's instruction (GLOBE-PRODUCTION-PLAN §1.3 step 2's
     *  banner), else [fallback]. While an intent is active the pill stays up after the first touch. */
    fun hint(ui: WorldHudUi, fallback: String): String = ui.noMap ?: when (ui.intent) {
        WorldHudIntent.CHOOSE_LAND -> "Choose a realm for your land"
        WorldHudIntent.RIVALS -> "Choose a realm to find a rival"
        WorldHudIntent.MY_DEEDS -> "Your realms are marked · tap one for your bases"
        WorldHudIntent.NONE -> fallback
    }
    fun hintShown(ui: WorldHudUi): Boolean = ui.hint || ui.noMap != null || ui.intent != WorldHudIntent.NONE
    /** Choose mode's "Next open deed ▶" (`land-map-open-deed`): select the caller's [WorldOpenDeeds] candidate and fly to
     *  it; it joins [WorldHudUi.offered] so the next tap walks on. Null (nothing open in reach) changes nothing. */
    fun nextOpenDeed(ui: WorldHudUi, card: RealmCard?): HudStep {
        if (card == null || ui.mode != WorldHudMode.REALM) return ui.step()
        val step = selectDeed(ui.copy(realmSearch = false, warzoneOpen = false), card, fly = true, d = HudBands.SELECT_D)
        return HudStep(step.ui.copy(offered = (ui.offered.filter { it != card.tileId } + card.tileId).takeLast(OFFERED_MAX)), step.intents)
    }
    const val OFFERED_MAX = 64
    /** The realm map's WARZONE chip (F16): its status panel opens over the map and closes the level panel. */
    fun toggleWarzone(ui: WorldHudUi): WorldHudUi = ui.copy(warzoneOpen = !ui.warzoneOpen, levelOpen = false)

    // ---- the back chain (plan §3.5, BackRegistry): card or search → realm map → globe selection/sheet → base ----
    /** The Back layers this state enables, highest priority first. */
    fun backLayers(ui: WorldHudUi): List<Int> = buildList {
        if (ui.mode == WorldHudMode.REALM && (ui.realmSearch || ui.levelOpen || ui.warzoneOpen || ui.card != null)) add(BackPriority.REALM_CARD)
        if (ui.mode == WorldHudMode.GLOBE && ui.globeSearch) add(BackPriority.GLOBE_LIST)
        if (ui.mode == WorldHudMode.REALM || ui.mode == WorldHudMode.DIVING) add(BackPriority.REALM_MAP)
        if (ui.mode == WorldHudMode.GLOBE && ui.panel != GlobePanel.NONE) add(BackPriority.GLOBE_LAYERS)
        // A leave in flight swallows Back until the globe is up again; the app's SCREEN handler (Home) waits.
        if (ui.mode == WorldHudMode.LEAVING) add(BackPriority.REALM_MAP)
    }
    /** What Back does at [priority] (ui.js `escape()` order inside the card layer: search, level panel, card; the
     *  native warzone panel closes after the level panel). */
    fun back(ui: WorldHudUi, priority: Int): HudStep = when (priority) {
        BackPriority.REALM_CARD -> when {
            ui.realmSearch -> ui.copy(realmSearch = false).step()
            ui.levelOpen -> ui.copy(levelOpen = false).step()
            ui.warzoneOpen -> ui.copy(warzoneOpen = false).step()
            else -> selectDeed(ui, null, fly = false)
        }
        BackPriority.GLOBE_LIST -> ui.copy(globeSearch = false).step()
        BackPriority.REALM_MAP -> if (ui.mode == WorldHudMode.LEAVING) ui.step() else leave(ui)
        BackPriority.GLOBE_LAYERS -> deselect(ui)
        else -> ui.step()
    }
}
