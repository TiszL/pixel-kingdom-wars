package gg.pixelkingdomwars.nativeclient.ui.layout

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.network.layoutSlotLabel
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.renderer.CameraInsets
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.InterruptedBanner
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.plateContentPadding
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.EditorGlyph
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.LayoutEditor
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.LayoutEditorActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.NUDGE_STEPS
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.arrowGlyph
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.editorHint
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.slotRefusal

/** The words an off panel button says while an order or a layout request is in flight (BuildingCommandAdapter's own). */
private const val WORKING = "Working…"

/** The editor's first-use hint (DESIGN-SYSTEM §6 Layout editor: "A one-line hint pill shows on the first use"): shown the
 *  first time the editor opens in this app session. There is no saved "seen" flag, so a new session shows it once more. */
private object EditorHintMemory { var shown = false }

/**
 * The layout editor over the live kingdom. The designed wall kit ([LayoutEditor], editor.png) owns the screen; the
 * compatibility panel (building moves, the tray, presets, the FARM unlock, Fit) has no design frame, so it is kept for
 * its functions but collapsed by default behind one kit stone button (BUILDINGS & PRESETS) and drawn with kit plates. It
 * opens by itself while the layout is locked, the layouts failed to load, or a building waits in the tray (the designed
 * SAVE refuses until it is placed). A locked FARM tapped in the designed bar opens it at the unlock.
 */
@Composable fun LayoutEditorOverlay(model: LayoutEditorViewModel, onInsets: (CameraInsets) -> Unit = {},
    status: @Composable () -> Unit = {}, onBuildMore: (() -> Unit)? = null, onFit: () -> Unit) {
    val state by model.state.collectAsState()
    val reportInsets by rememberUpdatedState(onInsets)
    val latestBuild by rememberUpdatedState(onBuildMore)
    val buildExit = remember(model) { LayoutBuildExit(model) { latestBuild?.invoke() } }
    DisposableEffect(model) { onDispose { buildExit.clear(); reportInsets(CameraInsets()) } }
    BackHandlerAt(BackPriority.CONFIRM, enabled = state.local.discardOpen, onBack = buildExit::cancelDiscard)
    BackHandlerAt(BackPriority.LAYOUT_EDITOR, enabled = state.open && !state.local.discardOpen) { model.close() }
    val firstUse = remember(model) { !EditorHintMemory.shown.also { EditorHintMemory.shown = true } }
    val ui = state.layoutEditorUi(anchor = null, showHint = firstUse)
    val textMeasurer = rememberTextMeasurer()
    var toolsOpen by remember { mutableStateOf(false) }
    LaunchedEffect(state.slot, state.locked, state.local.loadError) {
        if (state.locked || state.local.loadError != null) toolsOpen = true
    }
    val trayHasBuildings = state.draft?.trayIds?.any { state.buildingsById[it]?.type != "wall" } == true
    LaunchedEffect(trayHasBuildings) { if (trayHasBuildings) toolsOpen = true }
    val compatibility = state.layoutEditorCompatibilityUi()
    val legacy = layoutEditorCompatibilityActions(model)
    val kit = layoutEditorActions(model,
        onBuildMore = { if (latestBuild != null) buildExit.request() else Toasts.post("BUILD navigation is unavailable here") },
        onExplain = { Toasts.post(it) },
        onDiscarded = buildExit::confirmDiscard, onDiscardCancelled = buildExit::cancelDiscard)
    // The designed bar's HOME / FARM stay tappable when they cannot switch: a locked FARM opens its unlock in the panel,
    // anything else says why.
    val on = LayoutEditorActions(onClose = kit.onClose, onSlot = kit.onSlot, onPaint = kit.onPaint, onErase = kit.onErase,
        onSelectRun = kit.onSelectRun, onPan = kit.onPan, onPaintLevel = kit.onPaintLevel, onConfirm = kit.onConfirm,
        onCancel = kit.onCancel, onUndo = kit.onUndo, onMove = kit.onMove, onSave = kit.onSave,
        onConfirmDiscard = kit.onConfirmDiscard, onCancelDiscard = kit.onCancelDiscard, onBuildMore = kit.onBuildMore,
        onExplain = kit.onExplain,
        onSlotRefused = { id ->
            val now = model.currentEditorState()
            val locked = now.layouts?.slot(id)?.locked == true
            if (locked && now.layoutEditorCompatibilityUi().canOpenLockedFarm) { toolsOpen = true; legacy.onLockedFarm() }
            else Toasts.post(slotRefusal(id, locked, now.wallPending != null))
        })
    val density = LocalDensity.current
    val direction = androidx.compose.ui.platform.LocalLayoutDirection.current
    val safe = WindowInsets.safeDrawing
    val safeLeft = safe.getLeft(density, direction); val safeRight = safe.getRight(density, direction)
    val safeTop = safe.getTop(density); val safeBottom = safe.getBottom(density)
    // No pointer node on this root or the canvas. Only painted status/panel controls fence the scene.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val viewportHeight = maxHeight
        val short = maxWidth > viewportHeight * 1.1f && viewportHeight < 500.dp
        val compact = maxWidth < 560.dp && !short
        var panelSize by remember { mutableStateOf(IntSize.Zero) }
        var statusHeight by remember { mutableIntStateOf(0) }
        val showCompatibility = !state.local.discardOpen
        val sidePanelWidth = layoutEditorSidePanelWidth(maxWidth.value,
            with(density) { (safeLeft + safeRight).toDp().value }, short)
        val sidePanel = sidePanelWidth != null
        val panelWidth = (sidePanelWidth ?: 0f).dp
        val canvasWidth = maxWidth - if (sidePanel) panelWidth else 0.dp
        val pill = ui.refusal ?: ui.notice ?: if (ui.showHint || ui.stroke?.pending == true || ui.selectedRunCount > 0)
            editorHint(ui.tool, ui.selectedRunCount, ui.stroke?.pending == true) else null
        // Match HintPill's two lines and actual font scale. Shared kit sources and types remain untouched.
        val textWidth = (with(density) { (canvasWidth - 40.dp).roundToPx() } - safeLeft - safeRight).coerceAtLeast(1)
        val pillHeight = pill?.let { textMeasurer.measure(it, style = PkwTokens.Type.body,
            overflow = TextOverflow.Ellipsis, maxLines = 2, constraints = Constraints(maxWidth = textWidth)).size.height } ?: 0
        // The designed bar (8 + 52) and the pill's 8 dp gap, plus the pill; the strip and its shelf at the bottom.
        val kitTop = with(density) { 68.dp.roundToPx() + if (pill != null) 9.dp.roundToPx() else 0 } + pillHeight
        val kitBottom = with(density) { 101.dp.roundToPx() }
        val viewportPx = with(density) { viewportHeight.roundToPx() }
        val sceneMinimum = with(density) { 48.dp.roundToPx() }
        val spare = (viewportPx - safeTop - safeBottom - kitTop - kitBottom - sceneMinimum).coerceAtLeast(0)
        // Status stays scrollable; compatibility controls use the side in short landscape, or the remaining footer budget.
        val statusLimit = minOf(with(density) { (viewportHeight / 4).roundToPx() }, spare)
        val footerLimit = minOf(with(density) { (viewportHeight * .48f).roundToPx() },
            (spare - if (showCompatibility) statusHeight else 0).coerceAtLeast(0))
        SideEffect {
            reportInsets(layoutEditorCameraInsets(CameraInsets(safeLeft, safeTop, safeRight, safeBottom),
                kitTop, kitBottom, if (showCompatibility) statusHeight else 0,
                if (showCompatibility) panelSize else IntSize.Zero, sidePanel))
        }
        val canvas: @Composable (Modifier) -> Unit = { modifier ->
            Box(modifier) {
                LayoutEditor(ui, on, Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)))
                if (showCompatibility) Column(Modifier.align(Alignment.TopCenter)
                    .padding(top = with(density) { (safeTop + kitTop).toDp() })
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                    .heightIn(max = with(density) { statusLimit.toDp() }).onSizeChanged { statusHeight = it.height }
                    // The recovery lines are kit herald plates now (HomeRecoveryPlates.kt), so no veil band is drawn behind them.
                    .verticalScroll(rememberScrollState()).sceneInputRegion()) {
                    status()
                }
            }
        }
        val panel: @Composable (Modifier) -> Unit = { modifier ->
            Column(modifier.onSizeChanged { panelSize = it }
                .drawBehind { drawPlate(PlateKind.CHARCOAL) }.sceneInputRegion()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                .then(if (sidePanel) Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Bottom)) else Modifier)
                .padding(plateContentPadding(PlateKind.CHARCOAL))
                .verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (!toolsOpen) {
                    SecondaryButton("BUILDINGS & PRESETS", { toolsOpen = true }, Modifier.fillMaxWidth(),
                        contentDescription = "Buildings and presets: move buildings, the tray and saved presets")
                    return@Column
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    SecondaryButton("CLOSE BUILDING TOOLS", { toolsOpen = false }, Modifier.weight(1f))
                    IconSquare("locate", Verb.STONE, onFit, "Fit base")
                }
                if (compatibility.showLockedFarm) PanelButton("FARM LOCKED", compatibility.canOpenLockedFarm,
                    slotRefusal("FARM", locked = false, strokePending = state.wallPending != null), legacy.onLockedFarm, Modifier.fillMaxWidth())
                LayoutEditorTools(model, Modifier.heightIn(max = viewportHeight / 3))
                if (!state.locked && state.draft != null) LayoutEditorFooter(model, compact || sidePanel, short)
            }
        }
        // Only the kit's discard modal covers the scene; confirmation removes the compatibility panel.
        if (sidePanel) Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(panelWidth).fillMaxHeight()) {
                if (showCompatibility) panel(Modifier.fillMaxSize())
            }
            canvas(Modifier.weight(1f).fillMaxHeight())
        } else Column(Modifier.fillMaxSize()) {
            canvas(Modifier.weight(1f).fillMaxWidth())
            if (showCompatibility) panel(Modifier.fillMaxWidth().heightIn(max = with(density) { footerLimit.toDp() }))
        }
    }
}

/** A compatibility-panel button: [verb] while it [can] act, the OFF face otherwise; an off button says [reason] on a tap
 *  instead of doing nothing. */
@Composable private fun PanelButton(label: String, can: Boolean, reason: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    verb: Verb = Verb.STONE) {
    SecondaryButton(label, { if (can) onClick() else Toasts.post(reason) }, modifier, verb = if (can) verb else Verb.OFF)
}

/** Scrollable tools; tray and consent actions have their own fixed footer. */
@Composable private fun LayoutEditorTools(model: LayoutEditorViewModel, modifier: Modifier) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val data = state.layouts
    val draft = state.draft
    val compatibility = state.layoutEditorCompatibilityUi()
    val on = layoutEditorCompatibilityActions(model)
    val c = PkwTokens.Colors
    val wait = if (busy || state.local.busy != null) WORKING else "Finish the current layout action first"
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.local.notice?.let {
            PkwText(it, PkwTokens.Type.body, color = if (it.contains("FAILED") || it.contains("BLOCK")) c.danger else c.text, maxLines = 3)
        }
        InterruptedBanner(state.interrupted.filter { it.kind == IntentKind.LAYOUT_UNLOCK }, busy, model.interrupted.check, model.interrupted.close, model.interrupted.retry)
        if (data == null) {
            PkwText(state.local.loadError ?: "READING SERVER LAYOUTS…", PkwTokens.Type.body, color = c.muted, maxLines = 3)
            if (state.local.loadError != null) PanelButton("RETRY", !busy, WORKING, model::reload)
            SecondaryButton("CANCEL", model::close)
            return@Column
        }
        val slot = state.currentSlot
        if (slot == null) { PkwText("LAYOUT SLOT UNAVAILABLE", PkwTokens.Type.body, color = c.text); return@Column }
        if (slot.locked) {
            PkwText("${layoutSlotLabel("FARM")} SLOT LOCKED", PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
            PkwText("UNLOCKS A SECOND SERVER-STORED POSITION SET FOR THIS DEED.", PkwTokens.Type.small, color = c.muted, maxLines = 3)
            // The existing unlock order (Shards, server-priced); its saved receipt is the InterruptedBanner above.
            val can = state.local.busy == null && !state.unlockBlocked && !busy && state.deedActionsAllowed
            val why = when {
                state.unlockBlocked -> "Check the saved unlock first"
                !state.deedActionsAllowed -> "Layout editing is unavailable"
                else -> WORKING
            }
            PrimaryButton(if (state.local.busy == "unlock") "UNLOCKING…" else "UNLOCK · ${data.farmUnlock.costShards} SHARDS",
                { if (can) model.unlock() else Toasts.post(why) }, Modifier.fillMaxWidth(),
                state = when { state.local.busy == "unlock" -> CommandState.BUSY; can -> CommandState.ENABLED; else -> CommandState.DISABLED },
                reason = why.takeIf { !can && state.local.busy != "unlock" }, reasonOnDark = true)
            PanelButton("CANCEL", state.local.busy == null, WORKING, model::close)
            return@Column
        }
        PkwText(layoutSlotLabel(slot.slot), PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
        PkwText(when {
            slot.compatibility == "needs_repair" -> "REPAIR COPY LOADED FROM LIVE BASE"
            slot.compatibility == "empty" -> "NEW COPY LOADED FROM LIVE BASE"
            data.active.slot == slot.slot -> "ACTIVE ON THE BASE"
            else -> "SAVED SERVER PRESET"
        }, PkwTokens.Type.small, color = c.muted)
        PkwText("${draft?.positions?.size ?: 0} PLACED · ${draft?.trayIds?.size ?: 0} IN TRAY", PkwTokens.Type.small, color = c.muted)
        if (!state.keepPlaced) PkwText("KEEP REQUIRED · PLACE IT BEFORE SAVING", PkwTokens.Type.small, color = c.gold.hi, maxLines = 2)
        state.selected?.let { selected ->
            PkwText("${layoutBuildingName(selected.type)} · L${selected.level}", PkwTokens.Type.label, color = c.text, outline = 1.dp)
            PkwText("${selected.id.take(8)} · ${if (state.selectedInTray) "IN TRAY" else "ON PLOT"}", PkwTokens.Type.small, color = c.muted)
            if (!state.selectedInTray) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                NUDGE_STEPS.forEach { (dx, dy, turns) ->
                    val can = compatibility.canEditBuildings
                    val way = when { dx < 0 -> "left"; dx > 0 -> "right"; dy < 0 -> "up"; else -> "down" }
                    ChunkyBox(PkwTokens.ramp(if (can) Verb.STONE else Verb.OFF), { if (can) on.onNudge(dx, dy) else Toasts.post(wait) },
                        "Move building $way one tile", Modifier.size(PkwTokens.Dims.minTap), stateDescription = if (can) null else wait) {
                        EditorGlyph(arrowGlyph(turns), 24.dp, c.label)
                    }
                }
            }
            PanelButton("MOVE TO TRAY", compatibility.canEditBuildings && !state.selectedInTray, wait, on.onMoveToTray)
        }
        PanelButton("PICK UP ALL", compatibility.canEditBuildings, wait, on.onPickUpAll)
        var help by remember { mutableStateOf(false) }
        QuietButton(if (help) "HIDE HOW TO EDIT" else "HOW TO EDIT", { help = !help })
        if (help) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // Native gestures: hold-and-drag is not offered; a tap-to-tile placement is.
            PkwText("TAP A BUILDING TO SELECT IT, THEN TAP ITS NEW TILE. DRAG EMPTY GROUND TO PAN; PINCH TO ZOOM.", PkwTokens.Type.small, color = c.muted, maxLines = 3)
            PkwText("SELECT A TRAY ITEM, THEN TAP ITS NEW TILE. THE PAD NUDGES ONE TILE.", PkwTokens.Type.small, color = c.muted, maxLines = 3)
            PkwText("WALLS USE OWNED TRAYED WALLS. DRAG A RUN, THEN KEEP OR DROP IT. PICK UP ALL INCLUDES THE KEEP.", PkwTokens.Type.small, color = c.muted, maxLines = 3)
            PkwText("CANCEL SENDS NOTHING. SAVE REQUIRES EVERY BUILDING AND EXACTLY ONE KEEP ON THE PLOT.", PkwTokens.Type.small, color = c.muted, maxLines = 3)
        }
    }
}

/** The tray (stored buildings, walls grouped by level) and the preset actions: CANCEL, SAVE PRESET, SAVE & APPLY. */
@Composable private fun LayoutEditorFooter(model: LayoutEditorViewModel, compact: Boolean, short: Boolean) {
    val state by model.state.collectAsState()
    val draft = state.draft ?: return
    val compatibility = state.layoutEditorCompatibilityUi()
    val on = layoutEditorCompatibilityActions(model)
    val walls = layoutEditorActions(model, {}, {})
    val c = PkwTokens.Colors
    val wait = if (state.local.busy != null) WORKING else "Finish the current layout action first"
    val saveReason = state.layoutEditorUi(anchor = null, showHint = false).saveBlockedReason ?: "Nothing to save yet"
    val tray: @Composable (Modifier) -> Unit = { modifier ->
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            PkwText("TRAY", PkwTokens.Type.label, Modifier.width(if (short) 48.dp else 56.dp), color = c.gold.hi, outline = 1.dp)
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (draft.trayIds.isEmpty()) PkwText("EMPTY · EVERY BUILDING IS PLACED", PkwTokens.Type.small, color = c.muted)
                val groups = state.trayedWallGroups
                draft.trayIds.forEach { id ->
                    val building = state.buildingsById[id] ?: return@forEach
                    val selected: Boolean
                    val label: String
                    val click: () -> Unit
                    if (building.type == "wall") {
                        val ids = groups[building.level].orEmpty()
                        if (ids.firstOrNull() != id) return@forEach
                        selected = state.local.wallPaintLevel == building.level
                        label = "WALLS ×${ids.size}"
                        click = { walls.onPaintLevel(building.level) }
                    } else {
                        selected = draft.selectedId == id
                        label = layoutBuildingName(building.type)
                        click = { on.onTrayItem(id) }
                    }
                    val can = compatibility.canEditBuildings
                    ChunkyBox(PkwTokens.ramp(if (!can) Verb.OFF else if (selected) Verb.GOLD else Verb.STONE), { if (can) click() else Toasts.post(wait) },
                        "$label, level ${building.level}, ${id.take(8)}${if (selected) ", selected" else ""}",
                        Modifier.width(if (short) 70.dp else 82.dp).heightIn(min = if (short) 62.dp else 78.dp),
                        stateDescription = if (can) null else wait) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            PkwIcon(state.catalogue?.let { sheetBuildingPortrait(it, building.type, building.level,
                                state.base?.raw?.objects("heroes")?.firstOrNull { row -> row.string("hero") == if (building.type == "heroaltar") "vex" else "theodor" }?.string("level")?.toIntOrNull()) }
                                ?: "building-${building.type}", if (short) 32.dp else 40.dp)
                            PkwText(label, PkwTokens.Type.caption, color = c.label, outline = 1.dp)
                            PkwText("LEVEL ${building.level}", PkwTokens.Type.small, color = c.label)
                        }
                    }
                }
            }
        }
    }
    val actions: @Composable (Modifier) -> Unit = { modifier ->
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val button = if (compact) Modifier.weight(1f) else Modifier
            PanelButton("CANCEL", state.local.busy == null, WORKING, model::close, button)
            if (compatibility.showSavePreset) PanelButton("SAVE PRESET", compatibility.canSavePreset, saveReason, on.onSavePreset, button)
            PanelButton(if (state.local.busy == "apply") "APPLYING…" else "SAVE & APPLY", compatibility.canSaveApply, saveReason, on.onSaveApply, button,
                verb = Verb.GREEN)
        }
    }
    if (compact) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) { tray(Modifier.fillMaxWidth()); actions(Modifier.fillMaxWidth()) }
    else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) { tray(Modifier.weight(1f)); actions(Modifier) }
}
