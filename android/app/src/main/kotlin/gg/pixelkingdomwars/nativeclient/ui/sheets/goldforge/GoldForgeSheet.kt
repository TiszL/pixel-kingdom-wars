package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.VeilChip
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi

/**
 * Design component: the Gold Forge sheet (design/final/goldforge/SPEC.md §1; `smelt.png`, `claim.png`, `gems.png`): a
 * TALL kit [SheetFrame] whose living header is the 204 dp `GoldForgeHero` — the animated [GoldForgeScene] with the
 * title plate (GOLD FORGE + LV n), History (only while [GoldForgeSheetUi.history]) and close, and the live VeilChip ("Furnace lit · next coins in 6h 20m") —
 * then the SMELT · CLAIM · GEMS (· LEGACY) tabs, the parchment body and the pinned footer (each tab's one primary and its
 * footnote). The default tab rule is [goldForgeDefaultTab]; the tab row is [goldForgeTabs].
 *
 * Seals and the celebration are overlays, not part of the sheet: compose [GoldForgeSeals] in the OverlayHost (the
 * seals centre on the screen over a 55 % scrim). The 2-row resource stack (GEMS + wallet KEEP, [GoldForgeSheetUi.stack])
 * and the toast zone (8, 10, w 272) are the host's: see MOUNT-GOLDFORGE.md.
 *
 * Bridge: while a tab's Ui is null (tonight GF-B1 keeps the existing money bodies bound in MS-E's `GoldForgeHost`, and
 * LEGACY may keep `GoldForgeLegacyBody`), [bridge] draws that tab's body instead; with no bridge a "Checking the
 * forge…" line shows (never a blank body).
 *
 * Pointer rule: the root is the kit [SheetFrame], a painted panel that is never full-screen; it has no clickable,
 * pointerInput, draggable or scrim of its own, so it takes touches only on its painted parts (tabs, buttons, tiles).
 * Everything outside it reaches the kingdom. The 40 % TALL scrim is the SheetHost's (`SheetScrim(SheetSize.TALL, …)`),
 * under the frame, composed only while the sheet is shown.
 */
@Immutable data class GoldForgeSheetUi(
    /** "LV 3" (or "…"). */
    val level: String,
    val heroStatus: HeroStatusUi,
    /** built && !underConstruction && !destroyed (GF-A2); NOT "contributed today". */
    val sceneWorking: Boolean,
    /** [goldForgeTabs]: SMELT, CLAIM, GEMS (+ LEGACY only while [legacy] is set). */
    val tabs: List<TabUi>,
    /** One of [GoldForgeTabs] (case-insensitive). */
    val selectedTab: String,
    /** The host's 2-row stack: GEMS (`gem`) then wallet KEEP (`keep`); "…" until read, never 0. Not drawn by the sheet. */
    val stack: List<ResourceChipUi>,
    val smelt: SmeltUi?,
    val claim: ClaimUi?,
    val gems: GemsUi?,
    /** The custodial LEGACY tab's state; null hides the tab. */
    val legacy: LegacyUi? = null,
    val title: String = "GOLD FORGE",
    /** TALL on phones (the SPEC); the host may give FULL in landscape. */
    val size: SheetSize = SheetSize.TALL,
    /** Shows the header History button. Set it only when [GoldForgeSheetActions.onHistory] opens a real
     *  `WalletHistory(home = "goldforge")`; false (the default) hides it, so no dead button ships. */
    val history: Boolean = false,
)

/** The sheet's callbacks (SPEC `GoldForgeActions`, named after MS-E's `GoldForgeSheetActions`). */
@Immutable data class GoldForgeSheetActions(
    val onTab: (String) -> Unit = {},
    /** Close (the red square, Back, the SheetHost's scrim tap). The host ignores it while a payment is in flight. */
    val onClose: () -> Unit = {},
    /** History: `WalletHistory(home = "goldforge")`. The button shows only while [GoldForgeSheetUi.history] is true. */
    val onHistory: () -> Unit = {},
    val smelt: SmeltActions = SmeltActions(),
    val claim: ClaimActions = ClaimActions(),
    val gems: GemsActions = GemsActions(),
    val legacy: LegacyActions = LegacyActions(),
)

/**
 * The Gold Forge sheet. Give it the SheetHost's TALL slot (left / right 4, top 104 to the bottom; it needs a bounded
 * height). The host's slot is already inset: the sheet applies no window insets of its own (single inset ownership).
 * [scene] carries the foundry layers and the caller-decoded bitmaps; [scrollState] is hoisted so the host can keep the
 * body offset across re-opens. Pass null while the shown body owns its own vertical or lazy scrolling (the GF-B1 bridged
 * money bodies): the kit [SheetFrame] then skips its outer scroll and the body gets the bounded remaining height.
 *
 * Pointer rule: the root is the kit [SheetFrame] (a painted panel, never full-screen, no scrim of its own); only its
 * painted parts take touches. The TALL scrim is the SheetHost's, composed only while the sheet is shown.
 */
@Composable fun GoldForgeSheet(ui: GoldForgeSheetUi, on: GoldForgeSheetActions, modifier: Modifier = Modifier,
    scene: GoldForgeSceneUi = GoldForgeSceneUi(), scrollState: ScrollState? = rememberScrollState(),
    bridge: (@Composable ColumnScope.(tab: String) -> Unit)? = null) {
    val tab = ui.selectedTab.uppercase()
    val line = heroStatusLine(ui.heroStatus)
    val smelt = ui.smelt
    val claim = ui.claim
    val gems = ui.gems
    // The gesture inset is the SheetHost's (its slot is already inset), not the sheet's: applying it here would double it.
    val footer: @Composable ColumnScope.() -> Unit = {
        when {
            tab == GoldForgeTabs.SMELT && smelt != null -> SmeltFooter(smelt, on.smelt)
            tab == GoldForgeTabs.CLAIM && claim != null -> ClaimFooter(claim, on.claim)
            tab == GoldForgeTabs.GEMS && gems != null -> GemsFooter(gems, on.gems)
        }
        Spacer(Modifier.height(8.dp))
    }
    SheetFrame(SheetFrameUi(ui.title, null, ui.size, ui.tabs, ui.selectedTab, titleTag = ui.level, history = ui.history),
        onClose = on.onClose, modifier = modifier, onTab = on.onTab, onHistory = on.onHistory,
        header = {
            GoldForgeScene(scene, ui.sceneWorking, Modifier.matchParentSize())
            VeilChip(line.text, Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 9.dp), emphasis = line.emphasis,
                dot = line.dot, contentDescription = line.spoken)
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp).background(PkwTokens.Colors.ink))
        },
        footer = footer, scrollState = scrollState, headerHeight = PkwTokens.Dims.goldForgeHeaderH) {
        val legacy = ui.legacy
        when {
            tab == GoldForgeTabs.SMELT && smelt != null -> SmeltBody(smelt, on.smelt)
            tab == GoldForgeTabs.CLAIM && claim != null -> ClaimBody(claim, on.claim)
            tab == GoldForgeTabs.GEMS && gems != null -> GemsBody(gems, on.gems)
            tab == GoldForgeTabs.LEGACY && legacy != null && bridge == null -> LegacyBody(legacy, on.legacy)
            bridge != null -> bridge.invoke(this, tab)
            else -> PkwText("Checking the forge…", PkwTokens.Type.body, Modifier.padding(8.dp), color = PkwTokens.Colors.textOnParch2)
        }
    }
}

/**
 * The Gold Forge's three Seals (SMELT consent, CLAIM, BUY GEMS) for the OverlayHost, in one call: each is composed only
 * from its tab's `seal` field, so with no seal up nothing is painted and nothing takes touches. Keep composing it (with
 * the seals cleared) through the exits; [onExitFinished] fires once per seal that leaves. The Gem spend Seal
 * ([GemSpendSeal]) is game-wide and composed on its own.
 *
 * Pointer rule: a seal root is full-screen (its 55 % scrim, a tap = BACK) only while that seal is shown or animating out.
 */
@Composable fun GoldForgeSeals(ui: GoldForgeSheetUi?, on: GoldForgeSheetActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    SmeltSeal(ui?.smelt?.seal, on.smelt, modifier, clock, onExitFinished)
    ClaimSeal(ui?.claim, on.claim, modifier, clock, onExitFinished)
    GemsSeal(ui?.gems, on.gems, modifier, clock, onExitFinished)
}

@Composable private fun SheetPreviewFrame(ui: GoldForgeSheetUi, bridge: (@Composable ColumnScope.(tab: String) -> Unit)? = null) {
    val plan = goldForgeScenePlan()
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg)) {
        GoldForgeSheet(ui, GoldForgeSheetActions(), Modifier.fillMaxSize().padding(start = 4.dp, top = PkwTokens.Dims.tallSheetTop, end = 4.dp),
            scene = GoldForgeSceneUi(plan, previewSceneArt(plan)), bridge = bridge)
    }
}

@Preview(name = "Gold Forge sheet: SMELT", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeSmeltPreview() = SheetPreviewFrame(GoldForgeSamples.sheet)

@Preview(name = "Gold Forge sheet: SMELT held", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeHeldPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(smelt = GoldForgeSamples.smeltHeld))

@Preview(name = "Gold Forge sheet: CLAIM ready", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeClaimPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.CLAIM,
    tabs = goldForgeTabs(claimReady = true, gemsWaiting = 0, legacy = false)))

@Preview(name = "Gold Forge sheet: CLAIM locked", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeClaimLockedPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.CLAIM,
    claim = GoldForgeSamples.claimLocked))

@Preview(name = "Gold Forge sheet: CLAIM error, reconnecting hero", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeErrorPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.CLAIM,
    heroStatus = HeroStatusUi(HeroStatusKind.RECONNECTING), claim = GoldForgeSamples.claimReady.copy(phase = ClaimPhase.ERROR, ready = "…")))

@Preview(name = "Gold Forge sheet: CLAIM waiting for the wallet", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeClaimWalletPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.CLAIM,
    claim = GoldForgeSamples.claimReady.copy(stage = MoneyStage.CHECK_WALLET)))

@Preview(name = "Gold Forge sheet: GEMS, purchase waiting", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeGemsPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.GEMS,
    tabs = goldForgeTabs(claimReady = false, gemsWaiting = 1, legacy = false), gems = GoldForgeSamples.gems.copy(pendingRecovery = true)))

@Preview(name = "Gold Forge sheet: LEGACY tab, forge at rest", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeLegacyPreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(selectedTab = GoldForgeTabs.LEGACY,
    tabs = goldForgeTabs(claimReady = false, gemsWaiting = 0, legacy = true), sceneWorking = false,
    heroStatus = HeroStatusUi(HeroStatusKind.AT_REST, reason = "upgrading"),
    legacy = LegacyUi(custodyOpen = true, owed = "120", savedRequest = true)))

@Preview(name = "Gold Forge sheet: under construction, bridged body", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeBridgePreview() = SheetPreviewFrame(GoldForgeSamples.sheet.copy(smelt = null, sceneWorking = false,
    heroStatus = HeroStatusUi(HeroStatusKind.UNDER_CONSTRUCTION, time = "1h 12m"))) { tab ->
    PkwText("Existing $tab body (bridge)", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
}

@Preview(name = "Gold Forge seals: SMELT consent over the sheet", widthDp = 412, heightDp = 915)
@Composable private fun GoldForgeSealsPreview() {
    val ui = GoldForgeSamples.sheet.copy(smelt = GoldForgeSamples.smeltChoosing.copy(state = SmeltState.REVIEW, seal = GoldForgeSamples.smeltSeal))
    Box(Modifier.fillMaxSize()) {
        SheetPreviewFrame(ui)
        GoldForgeSeals(ui, GoldForgeSheetActions(), clock = { 300L })
    }
}
