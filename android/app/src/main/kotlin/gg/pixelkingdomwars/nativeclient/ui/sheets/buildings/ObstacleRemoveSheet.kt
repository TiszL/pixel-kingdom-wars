package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: obstacle REMOVE (design/final/buildings/SPEC.md R2.5 + critic fixes, obstacle-remove.png; registry
 * row 52): clear a rock, tree or stump with its cost, time and one confirm. Selecting the obstacle (ring + outline + the
 * committed NamePlate "MOSSY ROCK · Blocks this ground", bar REMOVE★ with its price pill) is the committed selection
 * overlay's; tap 2 or REMOVE opens this quote half sheet (top 640, ~30 %).
 */

/** The obstacle quote (SPEC R2.5 `ObstacleQuoteUi`, plus the recovery fields its states need). */
@Immutable data class ObstacleQuoteUi(
    /** The obstacle's id. */
    val obstacleId: String,
    /** Its name ("MOSSY ROCK"), the NamePlate title; the sheet title is [title]. */
    val name: String,
    /** Its own world sprite (an existing GameArt / scene name), drawn at world density in the grass well. */
    val sprite: String,
    /** The server price (Shards, or Gems: then REMOVE opens the Gems Seal; the host decides from the currency). */
    val price: PriceUi,
    /** "30s", "…". */
    val time: String,
    /** "1/2 free". */
    val builders: String,
    /** A reward line only if the server sends one (never invented): "Gives 120 Shards once". */
    val reward: String?,
    /** The quote state (VERIFYING keeps REMOVE as RETRY, see [quoteLook]). */
    val state: UpgradeState,
    /** The sheet title ("REMOVE ROCK", "REMOVE TREE"). */
    val title: String = "REMOVE",
    /** SHORT: how much more ("400"). */
    val shortfall: String? = null,
    /** NO_BUILDER: "2h 14m". */
    val builderFreeIn: String? = null,
    /** READ_ONLY (the herald's words), VERIFYING, or an error's "The price can't be checked right now. Try again.". */
    val reason: String? = null,
)

/** REMOVE callbacks (SPEC R2.5). */
class ObstacleActions(
    /** REMOVE (and RETRY after a lost answer). With a Gems price the host raises the Gems Seal instead of committing. */
    val onRemove: () -> Unit,
    /** NO_BUILDER: the Builders half sheet. */
    val onBuilders: () -> Unit,
    /** SHORT: Need-more for that currency key ("shards"). */
    val onGetMore: (String) -> Unit,
    /** Red close / Back / the scene's own tap. */
    val onClose: () -> Unit,
    /** "Report" while being checked. */
    val onReport: () -> Unit = {},
)

/**
 * The REMOVE half sheet (obstacle-remove.png): title "REMOVE ROCK" + red close; a 96 × 80 textured-grass well with the
 * obstacle sprite; "A builder clears it. The ground is free to build on after."; price / time / builders chips; the green
 * REMOVE primary "Uses 1 builder for 30s". Loading shows name, sprite and "…" chips at once, never blank. On success the
 * sheet closes, the plate becomes "Clearing · 30s" with a TimerPlate, and the obstacle fades 200 ms to grass (scene).
 *
 * Pointer rule: a HALF sheet has NO scrim. One painted wood panel (a scene-input region); only its buttons take taps.
 * Nothing here is full-screen, clickable on empty space, a pointerInput root, a scrim or draggable.
 */
@Composable fun ObstacleRemoveSheet(ui: ObstacleQuoteUi, on: ObstacleActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val look = quoteLook(ui.state, ui.price, ui.reason)
    val key = currencyName(ui.price.currency).lowercase()
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            HalfSheetHeader(ui.title, on.onClose, closeEnabled = look.kind != QuoteKind.STARTING)
            Spacer(Modifier.height(6.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(96.dp, 80.dp).clipToBounds().drawBehind { drawGrassWell() }
                            .clearAndSetSemantics { contentDescription = ui.name }, contentAlignment = Alignment.Center) {
                            R2Art(ui.sprite, 72.dp, 64.dp)
                        }
                        Column(Modifier.weight(1f)) {
                            PkwText("A builder clears it. The ground is free to build on after.", PkwTokens.Type.body, color = c.textOnParch, maxLines = 3)
                            ui.reward?.let { PkwText(it, PkwTokens.Type.small, color = c.green.lo) }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        val short = look.kind == QuoteKind.NEED_MORE
                        val pill = if (short && ui.price.status == PriceStatus.OK) ui.price.copy(status = PriceStatus.SHORT) else ui.price
                        PriceChip(pill, Modifier.heightIn(min = 30.dp), onClick = if (short) ({ on.onGetMore(key) }) else null)
                        if (short) PkwText("Need ${ui.shortfall ?: UNKNOWN} more ${currencyName(ui.price.currency)}", PkwTokens.Type.body, Modifier.weight(1f),
                            color = c.shortText, maxLines = 2)
                        else {
                            QuoteChip("timer", 24.dp, ui.time.ifBlank { UNKNOWN }, "Takes ${ui.time.ifBlank { UNKNOWN }}")
                            QuoteChip("builder", 30.dp, ui.builders.ifBlank { UNKNOWN }, "Builders ${ui.builders.ifBlank { UNKNOWN }}")
                        }
                    }
                    RemovePrimary(ui, look, on, key)
                }
            }
        }
    }
}

/** The primary that follows [quoteLook]: green REMOVE (hammer) "Uses 1 builder for 30s"; stone dots while the price is
 *  checked or the order is out; RETRY + "Being checked" + Report after a lost answer; off with the herald's reason. */
@Composable private fun RemovePrimary(ui: ObstacleQuoteUi, look: QuoteLook, on: ObstacleActions, key: String) {
    val full = Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.sheetPrimaryH)
    when (look.kind) {
        QuoteKind.COMMIT -> PrimaryButton("REMOVE", on.onRemove, full, verb = Verb.GREEN, icon = "itm_hammer", sub = "Uses 1 builder for ${ui.time}")
        QuoteKind.WAIT_PRICE -> PrimaryButton("Checking price", {}, full, state = CommandState.BUSY)
        QuoteKind.STARTING -> PrimaryButton("Starting…", {}, full, state = CommandState.BUSY)
        QuoteKind.RETRY -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            PrimaryButton("RETRY", on.onRemove, full, verb = Verb.GREEN, sub = look.reason ?: BEING_CHECKED)
            QuietButton("Report", on.onReport, onParchment = true, contentDescription = "Report a problem with this removal")
        }
        QuoteKind.NEED_MORE -> PrimaryButton(getLabel(ui.price.currency), { on.onGetMore(key) }, full, verb = Verb.BLUE,
            icon = currencyIcon(ui.price.currency, ui.price.icon), sub = "REMOVE needs ${currencyName(ui.price.currency)}")
        QuoteKind.NEED_BUILDER -> PrimaryButton("BUILDERS", on.onBuilders, full, verb = Verb.STONE, icon = "builder",
            sub = ui.builderFreeIn?.let { "Free in $it" })
        QuoteKind.OFF -> PrimaryButton("REMOVE", {}, full, verb = Verb.GREEN, state = CommandState.DISABLED, reason = look.reason)
    }
}

// ---- Previews ----

private val sampleRock = ObstacleQuoteUi("rock-14", "MOSSY ROCK", "ui_portrait_keep_t1", PriceUi(Currency.SHARDS, "1,200", PriceStatus.OK),
    "30s", "1/2 free", null, UpgradeState.READY, title = "REMOVE ROCK")
private val previewActions = ObstacleActions(onRemove = {}, onBuilders = {}, onGetMore = {}, onClose = {})

@Preview(name = "Remove: default (obstacle-remove.png)", widthDp = 412, heightDp = 915)
@Composable private fun RemoveDefaultPreview() = HalfSheetPreviewFrame { ObstacleRemoveSheet(sampleRock, previewActions, it) }

@Preview(name = "Remove: loading (… chips, REMOVE waits)", widthDp = 412, heightDp = 915)
@Composable private fun RemoveLoadingPreview() = HalfSheetPreviewFrame {
    ObstacleRemoveSheet(sampleRock.copy(state = UpgradeState.CHECKING, price = PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING), time = UNKNOWN, builders = UNKNOWN),
        previewActions, it)
}

@Preview(name = "Remove: short, no builder, reward line", widthDp = 824, heightDp = 915)
@Composable private fun RemoveShortPreview() {
    Row {
        Box(Modifier.size(412.dp, 915.dp)) { HalfSheetPreviewFrame { ObstacleRemoveSheet(sampleRock.copy(state = UpgradeState.SHORT,
            price = PriceUi(Currency.SHARDS, "1,200", PriceStatus.SHORT), shortfall = "400"), previewActions, it) } }
        Box(Modifier.size(412.dp, 915.dp)) { HalfSheetPreviewFrame { ObstacleRemoveSheet(sampleRock.copy(state = UpgradeState.NO_BUILDER,
            builders = "0/2 free", builderFreeIn = "2h 14m", reward = "Gives 120 Shards once"), previewActions, it) } }
    }
}

@Preview(name = "Remove: busy, being checked, read-only", widthDp = 1236, heightDp = 915)
@Composable private fun RemoveStatesPreview() {
    Row {
        Box(Modifier.size(412.dp, 915.dp)) { HalfSheetPreviewFrame { ObstacleRemoveSheet(sampleRock.copy(state = UpgradeState.BUSY), previewActions, it) } }
        Box(Modifier.size(412.dp, 915.dp)) { HalfSheetPreviewFrame { ObstacleRemoveSheet(sampleRock.copy(state = UpgradeState.VERIFYING), previewActions, it) } }
        Box(Modifier.size(412.dp, 915.dp)) { HalfSheetPreviewFrame { ObstacleRemoveSheet(sampleRock.copy(state = UpgradeState.READ_ONLY,
            reason = "Viewing another kingdom"), previewActions, it) } }
    }
}
