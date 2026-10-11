package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId

/*
 * MS-C3 mount contract v1 §1 (Codex task-13 `mount-contract-v1/CONTRACT.md`, sha256 6964b7b3…): KingdomScreen's two
 * additive hooks, `onReviewBlockedChanged` and `onBeforeSceneTap`, as pure rules so they are JVM-tested
 * (KingdomMountHooksTest). KingdomScreen only wires them (docs/ui-rehaul/HOOKUP-home-layer-hooks.md).
 */

/** EXACTLY the legacy placement AlertDialog's rendering predicate in [KingdomScreen] (a placement selection alone is not
 *  it): a non-wall draft with a tile, a loaded base, no hero review and no live placement host. The dialog and the
 *  review signal both read this one function, so they can never disagree. */
internal fun legacyPlacementDialogVisible(draft: PlacementDraft?, baseLoaded: Boolean, heroReview: Boolean, livePlacement: Boolean): Boolean =
    draft != null && draft.type != "wall" && draft.tile != null && baseLoaded && !heroReview && !livePlacement

/** The altar review holds Home's placement surfaces from REVIEW until its CONFIRM returns: the confirm hides the review
 *  before the POST, and nothing (tile dialog, its scrim, the placement band) may be redrawn under the player's tap while
 *  the consented request is sent and hydrated ([gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState.confirming]). */
internal fun heroReviewHeld(hero: gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState): Boolean = hero.review != null || hero.confirming

/**
 * The OR of every private review / confirmation / modal state THIS KingdomScreen owns: the private KEEP-spend and
 * cancel-job [confirmation], the hero review, the builder-finish review, the wall-row quote, the legacy placement dialog
 * and the DAILY_CACHE / EXPAND sheets, and [solConsent]: a SOL purchase raised in place on Home (the SOL-step sheet, or a
 * Seal, wallet step or MFA prompt of HIRE BUILDER / EXPAND). A selected building, its BuildingSheet, the builders
 * overview, the build tray and receipt history are NOT blockers: they hold ordinary navigation doors. Busy, editing,
 * drawing and live placement are enforced separately (C3 combines them with this).
 */
internal fun kingdomReviewBlocked(state: KingdomUiState, confirmation: Boolean, heroReview: Boolean, livePlacement: Boolean,
    solConsent: Boolean = false): Boolean =
    confirmation || heroReview || state.home.builderFinishReview != null || state.local.wallRowQuote != null ||
        legacyPlacementDialogVisible(state.local.placement, state.base != null, heroReview, livePlacement) || state.local.sheet != null ||
        solConsent

/** Which Home surface drives the ONE SOL purchase owner (`HomeSolPurchase`) now. Two surfaces composed with the same
 *  owner would run two foreground loops, and one's dismiss would clear the other's price check, so exactly one gets it:
 *  the SOL-step upgrade sheet first (the player just asked for it), then Keep EXPAND, then Builders. Null: none is open. */
internal enum class HomeSolSurface { PAID_UPGRADE, EXPAND, BUILDERS }

internal fun homeSolSurface(paidUpgradeOpen: Boolean, expandOpen: Boolean, buildersOpen: Boolean): HomeSolSurface? = when {
    paidUpgradeOpen -> HomeSolSurface.PAID_UPGRADE
    expandOpen -> HomeSolSurface.EXPAND
    buildersOpen -> HomeSolSurface.BUILDERS
    else -> null
}

/** Where a Keep STORES GO lands (buildings/keep-stores.png). The hero's gear and the Barracks composer are this group's
 *  own doors, a hero contract goes to the BUILD tray's HEROES tab (it is used by placing its altar); every other GO is a
 *  Phase E building's registry door (Workshop, Harvester, Market), opened by the Home dispatcher or refused in words. */
internal enum class StoresGoTarget { HERO_GEAR, TRAIN, HERO_BUILD, REGISTRY }

internal fun storesGoTarget(id: FeatureId): StoresGoTarget = when (id.value) {
    "hero.gear" -> StoresGoTarget.HERO_GEAR
    "barracks.train" -> StoresGoTarget.TRAIN
    "build.heroes" -> StoresGoTarget.HERO_BUILD
    else -> StoresGoTarget.REGISTRY
}

/** What a Keep STORES GO says when its building's sheet is not mounted on Home yet (never a silent tap). */
internal const val STORES_DOOR_CLOSED = "That building's sheet is not open from the Keep yet."

/**
 * The hold-to-lift mode the Home scene receives (buildings/SPEC.md §1.2 item 4: a long press moves the building; web
 * BaseScene HOLD-TO-LIFT). Only the layout editor (its own scene) and an open wall-row quote take it away; the model's
 * [KingdomUiState.carryMode] holds the order rules. Land ownership is deliberately NOT an input: production runs
 * FREE_ONBOARDING, the move routes are `free` (auth only, apps/api/src/game/routes.ts) and the web arms a drag on any own
 * building, so a kingdom without a land deed moves its buildings too. Owner field result 2026-10-06 (QA wallet without
 * land, build 05a72df2): "not able to move the buildings" — the screen used to drop the mode for every landless kingdom.
 */
internal fun homeCarryMode(state: KingdomUiState, editing: Boolean): gg.pixelkingdomwars.nativeclient.renderer.CarryMode? =
    if (editing || state.local.wallRowQuote != null) null else state.carryMode

/** Whether an open wall-stroke drawing may stay on Home: orders admitted and no layout editor. The [homeCarryMode] rule:
 *  land ownership is NOT an input. Under FREE_ONBOARDING the wall batch route asks for land only when free onboarding is
 *  off (apps/api/src/game/routes.ts `if (!freeOnboarding) await app.requireLandOwned`), so a kingdom without a deed draws
 *  walls; the screen used to dismiss every landless drawing the moment WALL was picked. */
internal fun homeWallDrawingAllowed(state: KingdomUiState, editing: Boolean): Boolean =
    !editing && state.ordersAllowed && state.deedActionsAllowed

/** The wall stroke the Home scene receives: the open drawing's lease while a wall draft is placed on the geometry that lease
 *  was cut from, nothing is busy and no wall-row quote is open. The batch itself stays the wall repository's priced,
 *  idempotent order; nothing here prices or sends. */
internal fun homeWallStroke(state: KingdomUiState, wall: gg.pixelkingdomwars.nativeclient.data.WallBatchState, editing: Boolean,
    busy: Boolean): gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode? {
    val drawing = wall.drawing ?: return null
    return drawing.mode.takeIf { homeWallDrawingAllowed(state, editing) && state.local.wallRowQuote == null && !busy && !wall.busy &&
        state.local.placement?.type == "wall" && gg.pixelkingdomwars.nativeclient.scene.sameWallGeometry(state.base, drawing.base) }
}

/** The selected building's plate and command bar are drawn only while no building is lifted. A lifted piece owns the map,
 *  and the bar's buttons are painted chrome where the scene refuses a drag (NativeGameRenderer `touchDragged`
 *  `insideViewport`), so a carry dragged across one snapped back. The layer is unmounted, not faded: the 120 ms exit
 *  would keep those buttons for its length. The selection itself is untouched, so a slow tap keeps its tap-2 rule. */
internal fun selectionChromeShown(carrying: Boolean): Boolean = !carrying

/**
 * One registration of `onReviewBlockedChanged` (contract §1 lifecycle). [report] is the callback captured by THIS
 * registration, so disposal can never reach a newer owner (no rememberUpdatedState). Blocked is the default: at mount,
 * before a private confirmation opens, while paused, on disposal or replacement, and until a composition has published
 * an aggregate. Only a resumed registration whose last committed aggregate is clear reports false. A retired lease is
 * inert, so an old registration can never release its replacement. Repeated values are reported once.
 */
internal class ReviewBlockedLease(private val report: (Boolean) -> Unit) {
    private var composed: Boolean? = null
    private var resumed = false
    private var retired = false
    private var last: Boolean? = null

    /** Registration / mount: blocked until a resumed composition publishes a clear aggregate. */
    fun mount() = emit(true)
    /** Before an event opens a private confirmation: blocked first, so admission never sees the frame before it draws. */
    fun opening() = emit(true)
    /** After a committed composition: the current aggregate (still blocked while paused). Never an action or navigation. */
    fun publish(blocked: Boolean) { composed = blocked; emit(current()) }
    fun pause() { resumed = false; emit(true) }
    /** Resume recomputes from the last committed aggregate; an unpublished one stays blocked. */
    fun resume() { resumed = true; emit(current()) }
    /** Disposal or replacement: this registration's own callback hears blocked, then the lease is inert. */
    fun retire() { emit(true); retired = true }

    private fun current(): Boolean = !resumed || (composed ?: true)
    private fun emit(blocked: Boolean) {
        if (retired || last == blocked) return
        last = blocked
        report(blocked)
    }
}

/**
 * Resolved-tap interception (contract §1): asks [onBeforeSceneTap] FIRST on a resolved footprint or ground tap, before
 * any chip bookkeeping, primary command, selection, terrain or layout mutation. True means the owner consumed the tap
 * (a Half sheet's exit): the chip claim is [ArmyChipTapClaim.consume]d and the caller returns without mutating anything.
 * Never ask it on a pointer-down: a pan does not dismiss a Half sheet.
 */
internal fun sceneTapConsumed(onBeforeSceneTap: () -> Boolean, chipTap: ArmyChipTapClaim): Boolean {
    if (!onBeforeSceneTap()) return false
    chipTap.consume()
    return true
}
