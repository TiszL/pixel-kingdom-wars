package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.chrome.TitleBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * The designed body for a standalone route that had only the old dark `GamePage` (owner 2026-10-06, screenshot 2: the
 * old "CLAIM TRANSFERRED DEED" page). It is the hub FullCard ([HubCard]) with the [CompactHeader] over the dimmed realm
 * wallpaper the designed land gate uses, so a deed claim, the base list, the SOL faucet and the account pages read as the
 * same family as the account frames (account/land-gate.png, account/profile-kingdoms.png).
 *
 * The [body] scrolls inside the parchment; the [footer] (the page's one primary and its stone partner) is pinned on the
 * wood below it. Pointer rule: the wood frame and its buttons are the only targets; the wallpaper is paint.
 */
@Composable fun RouteCardPage(title: String, icon: String?, onClose: () -> Unit, modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null, footer: (@Composable RowScope.() -> Unit)? = null,
    /** False for a body that holds its own scroller or a fixed-height reader (it then gets the bounded height). */
    scrolls: Boolean = true, body: @Composable ColumnScope.() -> Unit) {
    // The whole page is a scene-input region (as the old page was): a tap on the wallpaper never reaches a scene behind it.
    BoxWithConstraints(modifier.fillMaxSize().background(PkwTokens.Colors.ink).sceneInputRegion()) {
        TitleBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .35f)
        HubCard(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 4.dp, vertical = 8.dp),
            footer = footer, header = { CompactHeader(title, icon, onClose, onBack = onBack) }) {
            Column(Modifier.weight(1f).fillMaxWidth().then(if (scrolls) Modifier.verticalScroll(rememberScrollState()) else Modifier),
                verticalArrangement = Arrangement.spacedBy(8.dp), content = body)
        }
    }
}

/**
 * A notice inside a [RouteCardPage] (hub SPEC §3.6 ErrorRow grammar): a cream CardRow for information, the blood-rimmed
 * row with the alert art for a failure. [onRetry] adds the stone RETRY (busy dots while [retrying]); [onDismiss] adds a
 * stone close square. The message wraps; nothing on the page is blanked behind it.
 */
@Composable fun RouteNoticeRow(message: String, modifier: Modifier = Modifier, error: Boolean = false, retrying: Boolean = false,
    onRetry: (() -> Unit)? = null, onDismiss: (() -> Unit)? = null) {
    CardRow(modifier, variant = if (error) RowVariant.ERROR else RowVariant.PLAIN, height = 56.dp) {
        if (error) HubArt("alert", 32.dp)
        PkwText(message, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 6)
        if (onRetry != null) StoneBusyButton("RETRY", retrying, onRetry, Modifier.width(96.dp))
        if (onDismiss != null) IconSquare("shape:close", Verb.STONE, onDismiss, "Dismiss")
    }
}

/** One confirm for a [RouteConfirmDialog]: a question, every line of its consequence wording, the primary and its tone. */
@Immutable data class RouteConfirmUi(
    /** PS 13 question ("CLAIM THIS EXACT DEED?"). */
    val title: String,
    /** The consequence and reassurance sentences, drawn in full (VT 20 first, VT 18 after it). */
    val lines: List<String>,
    /** The primary's verb ("CLAIM DEED"). */
    val confirmLabel: String,
    /** The primary's face: GREEN to go ahead, RED for a removal, STONE for a neutral step. */
    val tone: Verb = Verb.GREEN,
    /** The stone back button's label. */
    val backLabel: String = "BACK",
    /** An optional authored Well above the question (the deed, the profile image). */
    val icon: String? = null,
)

/**
 * The hub ConfirmDialog (SPEC §3.3) for a route whose existing consequence wording is longer than [HubConfirmDialog]'s
 * three-line sentence: the same centred WoodFrame over the seal scrim, the same 300 ms tap-through lock on the primary,
 * Back and a scrim tap are BACK. Every line wraps in full, so no consent sentence is cut. Never used for money (that is
 * the kit `Seal`).
 */
@Composable fun RouteConfirmDialog(ui: RouteConfirmUi?, onConfirm: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }) {
    Presence(ui, PkwTokens.Motion.SEAL_IN, PkwTokens.Motion.SEAL_OUT) { shown, progress, active, reduced ->
        val openedAt = remember(shown) { clock() }
        Box(modifier.fillMaxWidth().fillMaxHeight(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) onBack() })
            Plate(PlateKind.WOOD, Modifier.padding(horizontal = 24.dp).widthIn(max = 364.dp).fillMaxWidth()
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                    Column(Modifier.fillMaxWidth().padding(8.dp).verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        shown.icon?.let { Well(it, size = 64.dp, light = true, iconSize = 48.dp) }
                        PkwText(shown.title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.textOnParch,
                            textAlign = TextAlign.Center, maxLines = 3)
                        shown.lines.forEachIndexed { index, line ->
                            PkwText(line, if (index == 0) PkwTokens.Type.body else PkwTokens.Type.small,
                                color = if (index == 0) PkwTokens.Colors.textOnParch else PkwTokens.Colors.textOnParch2,
                                textAlign = TextAlign.Center, maxLines = 8)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SecondaryButton(shown.backLabel, { if (active) onBack() }, Modifier.width(110.dp))
                            ChunkyBox(PkwTokens.ramp(shown.tone), {
                                if (active && sealAccepts(clock(), openedAt, PkwTokens.Motion.TAP_THROUGH_LOCK)) onConfirm()
                            }, shown.confirmLabel, Modifier.weight(1f).heightIn(min = 56.dp), enabled = active) {
                                PkwText(shown.confirmLabel, PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The hub TextField look (SPEC §1, [HubTextField]) for fields the hub field cannot serve: a numeric one-time code that
 * must stay masked ([secret]: dots, number keyboard) or an e-mail address (its keyboard). 52 tall, ink S shell, the
 * `#FFFAF0` face with the 3 dp inset, VT 20 ink, the placeholder until something is typed. [label] is what a screen
 * reader calls the field.
 */
@Composable fun RouteTextInput(value: String, onValueChange: (String) -> Unit, label: String, modifier: Modifier = Modifier,
    placeholder: String = label, enabled: Boolean = true, secret: Boolean = false, keyboardType: KeyboardType = KeyboardType.Text) {
    val c = PkwTokens.Colors
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().height(52.dp).semantics { contentDescription = label },
        enabled = enabled,
        singleLine = true,
        textStyle = PkwTokens.Type.body.copy(color = if (enabled) c.textOnParch else c.textOnParch2),
        cursorBrush = SolidColor(c.ink),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.NumberPassword else keyboardType),
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().fillMaxHeight().drawBehind {
                val w = size.width; val h = size.height; val i = 2.dp.toPx()
                fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
                insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(HubColors.fieldFace); band(i, w - i, i, 3.dp.toPx(), HubColors.fieldInset) }
            }.padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty() && placeholder.isNotEmpty()) PkwText(placeholder, PkwTokens.Type.body, color = HubColors.placeholder)
                inner()
            }
        },
    )
}

/** A field's PS 11 caption above it (the SPEC's field labels: "NAME", "CODE"). */
@Composable fun RouteFieldLabel(text: String, modifier: Modifier = Modifier) {
    PkwText(text, PkwTokens.Type.caption, modifier.padding(top = 4.dp), color = PkwTokens.Colors.textOnParch2)
}

/**
 * The older screens' all-capitals sentences ("ALL ACTIVE SLOTS ARE OCCUPIED. AN ADDITIONAL DEED …") drawn as the designed
 * VT sentences: lower case with a capital after each sentence end; the currency and brand words keep their capitals.
 * Text that already has lower case is returned unchanged. Only the letter case changes, never a word.
 */
internal fun plainSentences(text: String): String {
    if (text.none { it.isLowerCase() }) {
        val out = StringBuilder(text.length)
        var capital = true
        for (ch in text.lowercase()) {
            if (capital && ch.isLetter()) { out.append(ch.uppercaseChar()); capital = false } else out.append(ch)
            if (ch == '.' || ch == '!' || ch == '?') capital = true
        }
        return KEPT_CAPITALS.entries.fold(out.toString()) { acc, (word, kept) -> acc.replace(Regex("\\b$word\\b"), kept) }
    }
    return text
}

/** Words that keep their own spelling inside [plainSentences]: currencies, the chain, brand and allocation names. */
private val KEPT_CAPITALS: Map<String, String> = linkedMapOf(
    "keep" to "KEEP", "sol" to "SOL", "skr" to "SKR", "nft" to "NFT", "pkw" to "PKW",
    "seeker" to "Seeker", "genesis" to "Genesis", "earth" to "Earth",
)
