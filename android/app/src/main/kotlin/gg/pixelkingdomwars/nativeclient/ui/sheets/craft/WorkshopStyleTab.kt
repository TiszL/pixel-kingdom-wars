package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Workshop › STYLE (craft/SPEC.md §2.7, workshop-style.png): the Market Awning TierPicker (ON / OWNED /
 * CRAFT / MKT n), the PreviewCard on grass, YOU NEED, and the BOAT TRAIL row (Aurora Wake: SHOW / HIDE, or selectable
 * to craft). Looks only, no stats. An owned tier's primary is a free green SHOW ON MARKET or stone HIDE.
 *
 * Pointer rule: drawn inside the Workshop sheet's painted panel; only tier cards, the wake row / its button and the
 * primary take touches.
 */

/** One awning tier (SPEC §2.7 `awning.tiers[…]`). */
@Immutable data class AwningTierUi(
    /** 1..4. */
    val tier: Int,
    /** The craft recipe; null when it cannot be crafted. */
    val recipeId: String?,
    /** The Market level it needs. */
    val requiredMarketLevel: Int,
    val inputs: List<RecipeInputUi>,
    val durationSec: Long?,
    val owned: Boolean,
    val craftable: Boolean,
    val lockReason: LockReasonUi? = null,
    /** Exact output and applied state supplied by the existing appearance owner. */
    val outputId: String? = null,
    val ownerApplied: Boolean? = null,
    val ownerTag: String? = null,
)

/** `awning{tiers, appliedTier?, previewVerified}`. */
@Immutable data class AwningUi(
    val tiers: List<AwningTierUi>,
    /** The tier shown on the Market now; null = none. */
    val appliedTier: Int?,
    /** False: the preview art is not verified, so crafting is held (owner-specific state). */
    val previewVerified: Boolean,
)

/** The Aurora Wake recipe. */
@Immutable data class WakeRecipeUi(val recipeId: String, val inputs: List<RecipeInputUi>, val durationSec: Long?)

/** `wake{owned, shown, recipe?}`. */
@Immutable data class WakeUi(val owned: Boolean, val shown: Boolean, val recipe: WakeRecipeUi?)

/** Workshop › STYLE state (SPEC §2.7; fields after `saved` were added). */
@Immutable data class WorkshopStyleUi(
    val awning: AwningUi,
    val wake: WakeUi,
    /** The Market's level; null = unknown (treated as too low to show a tier). */
    val marketLevel: Int?,
    val job: BenchJobUi?,
    val saved: SavedOpUi?,
    /** The selected tier (null = the default: first craftable). */
    val selectedTier: Int? = null,
    /** True when the wake row is selected (the PreviewCard shows the wake; the primary is CRAFT WAKE). */
    val wakeSelected: Boolean = false,
    val stock: Map<String, StockUi> = emptyMap(),
    val items: Map<String, CraftItemUi> = emptyMap(),
    val shards: Long? = null,
    val actionsAllowed: Boolean = true,
    val acceptingJobs: Boolean = true,
    val hydration: CraftHydration = CraftHydration.Ready,
    val submit: SubmitUi = SubmitUi(),
    val serverOffsetMs: Long = 0L,
    val ownerControls: WorkshopStyleOwnerControls? = null,
)

/** The actual owners expose a kingdom-wide Awning Boolean and an account-wide Wake Boolean. */
@Immutable data class WorkshopStyleOwnerControls(
    val primary: CraftPrimaryUi?,
    val canToggleWake: Boolean,
    val wakeEnabled: Boolean?,
    val status: String,
    val awningSetting: String,
    val wakeSetting: String,
    val canRefresh: Boolean,
    val awningPreference: CraftPrimaryUi? = null,
    val ownedAwnings: String = "",
    val canOpenOriginals: Boolean = false,
)

/** Workshop › STYLE callbacks (SPEC §2.7). */
@Immutable data class WorkshopStyleActions(
    val onSelectTier: (tier: Int) -> Unit = {},
    /** Selects the (not yet crafted) wake. */
    val onSelectWake: () -> Unit = {},
    /** Opens the review half sheet for the recipe, then starts. */
    val onCraft: (recipeId: String) -> Unit = {},
    /** Shows [tier] on the Market (free); null hides the awning. */
    val onApply: (tier: Int?) -> Unit = {},
    /** Shows or hides the owned wake (free). */
    val onToggleWake: (show: Boolean) -> Unit = {},
    val onSetAwningPreference: (enabled: Boolean) -> Unit = {},
    val onRefreshWakePreference: () -> Unit = {},
    /** Verified owner pixels. Presence suppresses every static preview fallback. */
    val preview: (@Composable (outputId: String, modifier: Modifier) -> Unit)? = null,
)

/** The STYLE body. */
@Composable internal fun ColumnScope.WorkshopStyleBody(ui: WorkshopStyleUi, on: WorkshopSheetActions, destinationsAvailable: Boolean = true) {
    val c = PkwTokens.Colors
    val owner = ui.ownerControls
    ui.saved?.let { RecoveryRow(it, on.onCheckSaved) }
    SectionLabel("MARKET AWNING", "looks only, no stats")
    val selected = selectedAwning(ui)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ui.awning.tiers.forEach { tier ->
            TierCard(tier, if (tier.ownerApplied != null) tier.tier.takeIf { tier.ownerApplied == true } else ui.awning.appliedTier,
                !ui.wakeSelected && tier.tier == selected?.tier, on.style.onSelectTier, Modifier.weight(1f), on.style.preview)
        }
    }
    if (!ui.awning.previewVerified && !ui.wakeSelected) {
        EmptyState(EmptyStateUi("ui:market-menu", "Preview unavailable. Crafting is held.", "The awning art is still being checked.", null, null), onGo = {})
        // No tier card can carry the kingdom setting or ownership here, so the owner's own lines stay readable.
        owner?.let {
            PkwText(it.awningSetting, PkwTokens.Type.small, color = c.textOnParch2)
            if (it.ownedAwnings.isNotBlank()) PkwText(it.ownedAwnings, PkwTokens.Type.small, color = c.textOnParch2)
        }
    } else if (ui.wakeSelected) {
        PreviewCard("craft:item_aurora_wake", 64, "AURORA WAKE", "A permanent account appearance.",
            owner?.wakeSetting ?: "Show or hide it any time, free.", "aurora_wake", on.style.preview)
    } else if (selected != null) {
        PreviewCard(awningSprite(selected.tier), 112, "AWNING ${romanTier(selected.tier)}",
            "For a level ${selected.requiredMarketLevel} Market. Crafted once, yours for good.",
            owner?.awningSetting ?: "Show or hide it any time, free.", selected.outputId, on.style.preview)
    }
    // The kingdom-wide HIDE normally sits on an owned tier's primary. With no owned tier in the picker it would have no
    // door, so only then it stays here (SHOW needs an owned tier, so it is never offered from this spot).
    val footerToggles = owner?.primary?.action.let { it == PrimaryAction.SHOW || it == PrimaryAction.HIDE }
    owner?.awningPreference?.takeIf { preference -> preference.action == PrimaryAction.HIDE && ui.awning.tiers.none { it.owned } &&
        !footerToggles }?.let { preference ->
        CraftPrimaryButton(preference, { action -> if (action == PrimaryAction.HIDE) on.style.onSetAwningPreference(false) }, Modifier.fillMaxWidth())
    }
    val craftable = if (ui.wakeSelected) !ui.wake.owned else if (owner != null) selected?.owned == false
        else selected?.let { awningTierState(it, ui.awning.appliedTier) == AwningTierState.CRAFTABLE } == true
    val lines = styleLines(ui)
    if (craftable && lines.isNotEmpty()) {
        SectionLabel("YOU NEED", "for ${if (ui.wakeSelected) "Aurora Wake" else "Awning ${romanTier(selected?.tier ?: 1)}"}")
        lines.forEach { line ->
            IngredientRow(line, onGo = { l -> val here = l.goRecipeId; if (here != null) on.onGoRecipe(here) else on.onGo(l.itemId) },
                showGo = destinationsAvailable)
        }
    }
    SectionLabel("BOAT TRAIL", "shows behind your boat")
    WakeRow(ui, on.style)
    if (owner?.canRefresh == true) SecondaryButton("CHECK ACCOUNT SETTING", on.style.onRefreshWakePreference, Modifier.fillMaxWidth())
    if (ui.job != null) PkwText("The bench is busy. This craft can start when it is free.", PkwTokens.Type.small, color = c.textOnParch2)
    // The owner's queue and consent status: kept readable, below the designed parts rather than above the picker.
    owner?.let { PkwText(it.status, PkwTokens.Type.small, color = c.textOnParch2) }
}

/** One TierPicker card (CreamCard 108): the tier sprite at 56 (112 art at k = 1), the roman numeral, the state tag.
 *  A locked tier is dimmed. Its own target. */
@Composable private fun TierCard(tier: AwningTierUi, applied: Int?, selected: Boolean, onSelect: (Int) -> Unit, modifier: Modifier,
    preview: (@Composable (String, Modifier) -> Unit)? = null) {
    val c = PkwTokens.Colors
    val state = awningTierState(tier, applied)
    val defaultTag = awningTag(tier, applied)
    val tag = if (state == AwningTierState.APPLIED) defaultTag.first else tier.ownerTag ?: defaultTag.first
    val verb = defaultTag.second
    CreamCard(modifier.heightIn(min = 108.dp)
        .clearAndSetSemantics {
            contentDescription = "Awning ${romanTier(tier.tier)}, $tag"; role = Role.Button; this.selected = selected
            onClick(label = null, action = { onSelect(tier.tier); true })
        }
        .clickable(role = Role.Button) { onSelect(tier.tier) },
        rim = if (selected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(start = 2.dp, top = 6.dp, end = 2.dp, bottom = 8.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            // A locked tier is dimmed whether the pixels are the bundled sprite or the owner's verified preview.
            if (preview != null) tier.outputId?.let { preview(it, Modifier.size(56.dp).alpha(if (state == AwningTierState.LOCKED) 0.45f else 1f)) }
            else CraftIcon(awningSprite(tier.tier), 56.dp, alpha = if (state == AwningTierState.LOCKED) 0.45f else 1f)
            PkwText(romanTier(tier.tier), PkwTokens.Type.caption, color = c.textOnParch)
            Tag(tag, verb)
        }
    }
}

/** PreviewCard (CreamCard 124): a grass well 116 with the art, the name and two VT 18 lines. */
@Composable private fun PreviewCard(art: String, artDp: Int, title: String, line: String, freeLine: String,
    outputId: String? = null, preview: (@Composable (String, Modifier) -> Unit)? = null) {
    val c = PkwTokens.Colors
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 124.dp), contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 10.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(116.dp).clipToBounds().drawBehind { drawGrass() }, contentAlignment = Alignment.Center) {
                if (preview != null) outputId?.let { preview(it, Modifier.size(artDp.dp)) }
                else CraftIcon(art, artDp.dp, contentDescription = title)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwText(title, PkwTokens.Type.label, color = c.textOnParch)
                PkwText(line, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3)
                // The owner's kingdom setting sentence replaces the mock's short line; it must not be cut off.
                PkwText(freeLine, PkwTokens.Type.small, color = c.textOnParch, maxLines = 5)
            }
        }
    }
}

/** The Aurora Wake row: owned → stone SHOW / HIDE (free); not crafted → the row selects the wake recipe. */
@Composable private fun WakeRow(ui: WorkshopStyleUi, on: WorkshopStyleActions) {
    val c = PkwTokens.Colors
    val owned = ui.wake.owned
    val status = ui.ownerControls?.wakeSetting ?: when {
        owned && ui.wake.shown -> "Owned · shown now"
        owned -> "Owned · hidden now"
        ui.wake.recipe != null -> "Not crafted · tap to see it"
        else -> "Not crafted yet"
    }
    val select = if ((!owned || ui.ownerControls != null) && ui.wake.recipe != null) Modifier
        .clearAndSetSemantics {
            contentDescription = "Aurora Wake. $status"; role = Role.Button; selected = ui.wakeSelected
            onClick(label = null, action = { on.onSelectWake(); true })
        }
        .clickable(role = Role.Button) { on.onSelectWake() } else Modifier
    CreamCard(Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.ingredientRowH).then(select),
        rim = if (ui.wakeSelected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CraftIcon("craft:item_aurora_wake", 32.dp)
            Column(Modifier.weight(1f)) {
                PkwText("Aurora Wake", PkwTokens.Type.body, color = c.textOnParch)
                PkwText(status, PkwTokens.Type.small, color = c.textOnParch2)
            }
            val shown = ui.ownerControls?.wakeEnabled ?: ui.wake.shown
            if (owned || ui.ownerControls?.wakeEnabled == true) SecondaryButton(if (shown) "HIDE" else "SHOW", { on.onToggleWake(!shown) }, Modifier.size(84.dp, 44.dp),
                enabled = ui.ownerControls?.canToggleWake ?: ui.actionsAllowed,
                contentDescription = if (shown) "Hide the Aurora Wake" else "Show the Aurora Wake")
        }
    }
}

/** The STYLE footer: the primary (craft gold, SHOW green, HIDE stone, locked charcoal) and the note. */
@Composable internal fun ColumnScope.WorkshopStyleFooter(ui: WorkshopStyleUi, on: WorkshopSheetActions, primary: CraftPrimaryUi?) {
    val tier = selectedAwning(ui)
    if (primary != null) {
        CraftPrimaryButton(primary, { action ->
            when (action) {
                PrimaryAction.START -> (if (ui.wakeSelected) ui.wake.recipe?.recipeId else tier?.recipeId)?.let(on.style.onCraft)
                PrimaryAction.SHOW -> if (ui.ownerControls != null) on.style.onSetAwningPreference(true) else tier?.let { on.style.onApply(it.tier) }
                PrimaryAction.HIDE -> if (ui.ownerControls != null) on.style.onSetAwningPreference(false) else on.style.onApply(null)
                PrimaryAction.RETRY -> on.onRetry()
                PrimaryAction.NEED_MORE -> primary.price?.let(on.onNeedMore)
                else -> Unit
            }
        }, Modifier.fillMaxWidth().padding(top = if (primary.price != null) 14.dp else 0.dp))
    }
    val notice = submitNotice(ui.submit) ?: (ui.hydration as? CraftHydration.Error)?.message
    val input = styleLines(ui).singleOrNull()?.name
    val note = when {
        notice != null -> notice
        primary?.action == PrimaryAction.SHOW || primary?.action == PrimaryAction.HIDE -> "Showing it is free. Hide it any time."
        ui.wakeSelected -> "${input ?: "The inputs"} ${if (input != null) "is" else "are"} spent when you start. The wake stays yours."
        primary?.action == PrimaryAction.START || primary?.state == CommandState.SHORT ->
            "${input ?: "The inputs"} ${if (input != null) "is" else "are"} spent when you start. The awning stays yours."
        else -> null
    }
    if (note != null) FooterNote(note, danger = notice != null)
    ui.ownerControls?.let { owner ->
        if (owner.canRefresh) SecondaryButton("CHECK APPEARANCES", on.onRetry, Modifier.fillMaxWidth())
        // Never a silent disabled door: without a current account the originals cannot open, so the button is not drawn
        // (the header History hides with it).
        if (owner.canOpenOriginals) SecondaryButton("ORIGINAL REQUESTS", on.onHistory, Modifier.fillMaxWidth())
    }
}


// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Workshop › STYLE (workshop-style.png)", widthDp = 412, heightDp = 811)
@Composable private fun StylePreview() = WorkshopPreviewHost(CraftSamples.workshop(style = CraftSamples.style))

@Preview(name = "Workshop › STYLE owned tier (SHOW ON MARKET)", widthDp = 412, heightDp = 811)
@Composable private fun StyleOwnedPreview() = WorkshopPreviewHost(CraftSamples.workshop(style = CraftSamples.style.copy(selectedTier = 2)))

@Preview(name = "Workshop › STYLE locked tier", widthDp = 412, heightDp = 811)
@Composable private fun StyleLockedPreview() = WorkshopPreviewHost(CraftSamples.workshop(style = CraftSamples.style.copy(selectedTier = 4)))

@Preview(name = "Workshop › STYLE preview unverified", widthDp = 412, heightDp = 811)
@Composable private fun StyleUnverifiedPreview() = WorkshopPreviewHost(CraftSamples.workshop(style = CraftSamples.style.copy(
    awning = CraftSamples.style.awning.copy(previewVerified = false))))
