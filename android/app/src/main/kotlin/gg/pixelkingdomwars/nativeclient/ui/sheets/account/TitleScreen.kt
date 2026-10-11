package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CompactHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubTextField
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ReportLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowChevron
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

/**
 * Design component: the first launch (design/final/account/onboard-title.png, SPEC §1.1), the Gate before Home: the bright
 * realm wallpaper (the existing `LoadingBackdrop`, the same painting and crop as the boot loading screen), the settings square, the logo, and
 * one WoodFrame card with the FUN-TO-EARN line, gold CONNECT WALLET ("Seed Vault, Phantom, Solflare, Backpack") and
 * stone PLAY NOW ("with Google, X or email"), then "0.6.5 (31) · Terms · Privacy". The same card carries the returning
 * player ("CONTINUE AS 7xKp…4f2k"), the 2-step code and the Seeker admission states. [SignInProvidersSheet] is the PLAY
 * NOW half sheet (with [EmailSignInStep] inside it), [WalletCodeSheet] the game wallet's authenticator prompt and
 * [TitleSettingsSheet] the settings square's sheet. Google / X / email have no authored marks: text only (SPEC §1.1 Assets).
 *
 * Public wording overrides the frame: the frame's FREE TO PLAY headline and PLAY FREE button sell free play, so the card
 * says [TITLE_HEADLINE] and [TITLE_PLAY_LABEL] (owner rule: never sell free, say Fun-to-Earn).
 */

/** The card's headline (the frame's FREE TO PLAY, replaced by the public wording rule). */
internal const val TITLE_HEADLINE = "FUN-TO-EARN"

/** The stone button and the provider sheet's title (the frame's PLAY FREE, replaced by the public wording rule). */
internal const val TITLE_PLAY_LABEL = "PLAY NOW"

/** One PLAY NOW provider row (Google, X, email). */
@Immutable data class SignInProviderUi(
    val id: String,
    /** "Continue with Google". */
    val label: String,
    /** The PS letter in the well ("G", "X", "@"). */
    val letter: String,
    val busy: Boolean = false,
    val enabled: Boolean = true,
)

/** Which card the title shows. */
enum class TitleStage {
    /** CONNECT WALLET / PLAY NOW (or CONTINUE AS for a returning player). */
    CHOOSE,
    /** The 2-step code (`TotpRoute`): six cells + green CONFIRM. */
    TOTP,
    /** The Seeker admission gate (`AdmissionRoute`): "Your Genesis Token is your invite". */
    ADMISSION,
}

/** The 2-step code state. */
@Immutable data class TotpUi(
    /** 0..6 digits ([totpDraft]). */
    val code: String,
    /** The server's refusal ("That code did not match"); null = none. */
    val error: String?,
    val busy: Boolean,
)

/** The Seeker admission state. */
@Immutable data class AdmissionUi(
    /** The server's admission line ("No Genesis Token found in 7xKp…4f2k"). */
    val line: String,
    /** CHECK AGAIN is reading. */
    val checking: Boolean,
)

/** Everything the title screen draws (SPEC §1.1 `TitleUiState`). */
@Immutable data class TitleUi(
    /** "0.6.5 (31)". */
    val version: String,
    /** A Mobile Wallet Adapter wallet is installed; false disables CONNECT WALLET with the reason. */
    val walletAdapterAvailable: Boolean,
    /** The returning player's short address; non-null turns the primary into "CONTINUE AS …". */
    val lastWalletLabel: String?,
    val socialProviders: List<SignInProviderUi>,
    /** What is in flight. */
    val busy: TitleBusy? = null,
    /** The last failure, in plain words (drawn in the card with Report). Never "nothing was spent": no money moves here. */
    val error: String? = null,
    val stage: TitleStage = TitleStage.CHOOSE,
    val totp: TotpUi? = null,
    val admission: AdmissionUi? = null,
    /** Signed in: the card slides down 160 ms while Home fades in beneath (no blank frame). */
    val leaving: Boolean = false,
    /** The live owner can offer wallet replacement without inventing a remembered address. */
    val showAnotherWallet: Boolean = false,
    val walletUnavailable: String? = null,
    val socialUnavailable: String? = null,
    val settingsAvailable: Boolean = true,
    val legalAvailable: Boolean = true,
    val reportAvailable: Boolean = true,
)

/** Title callbacks (SPEC §1.1). */
@Immutable data class TitleActions(
    val onConnectWallet: () -> Unit = {},
    /** Returning player: "Use another wallet". */
    val onUseAnotherWallet: () -> Unit = {},
    /** PLAY NOW: open [SignInProvidersSheet]. */
    val onPlayFree: () -> Unit = {},
    val onSettings: () -> Unit = {},
    val onTerms: () -> Unit = {},
    val onPrivacy: () -> Unit = {},
    val onTotpCode: (String) -> Unit = {},
    val onTotpConfirm: () -> Unit = {},
    val onTotpBack: () -> Unit = {},
    val onAdmissionRecheck: () -> Unit = {},
    /** The error line's Report: Feedback, prefilled. */
    val onReport: () -> Unit = {},
)

/** The title's enter timeline: 220 ms per element plus three 30 ms button staggers. */
private const val TITLE_ENTER_MS = 220 + 3 * 30

/**
 * The title screen, full screen before Home.
 *
 * Pointer rule: the root is a plain Box; the wallpaper and logo are paint only. Only the settings square, the card's
 * buttons and the footer links take touches. There is no scrim and no root pointer handling.
 */
@Composable fun TitleScreen(
    ui: TitleUi, on: TitleActions, modifier: Modifier = Modifier,
    header: @Composable ColumnScope.() -> Unit = {},
    extras: @Composable ColumnScope.() -> Unit = {},
) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val enter = remember { Animatable(if (inspection) 1f else 0f) }
    LaunchedEffect(Unit) {
        enter.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else TITLE_ENTER_MS, easing = LinearEasing))
    }
    val leave = remember { Animatable(0f) }
    LaunchedEffect(ui.leaving) {
        leave.animateTo(if (ui.leaving) 1f else 0f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.SHEET_OUT,
            easing = PkwTokens.Motion.In))
    }
    // Element i starts i × 30 ms into the timeline and runs 220 ms (`out`).
    fun step(i: Int): Float = if (reduced) enter.value
        else PkwTokens.Motion.Out.transform(((enter.value * TITLE_ENTER_MS - i * PkwTokens.Motion.COMMAND_STAGGER) / PkwTokens.Motion.SHEET_IN).coerceIn(0f, 1f))

    BoxWithConstraints(modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Palette.surface, Palette.backdrop)))) {
        val landscape = maxWidth > maxHeight
        // The loading wallpaper itself (exactly 2x on the Seeker), so boot → title → Home never changes the painting.
        LoadingBackdrop(portrait = !landscape, modifier = Modifier.fillMaxSize(), brightness = .9f)
        // 300 dp ink gradient (35 % → 0) at the top, so the logo and gear read.
        Box(Modifier.fillMaxWidth().height(300.dp).background(Brush.verticalGradient(listOf(PkwTokens.Colors.ink.copy(alpha = 0.35f), Color.Transparent))))
        if (ui.settingsAvailable) IconSquare("settings", Verb.STONE, on.onSettings, "Settings", Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp))
        HubArt("logo", if (landscape) maxWidth * .38f else 316.dp, Modifier.align(if (landscape) Alignment.CenterStart else Alignment.TopCenter).statusBarsPadding().padding(top = if (landscape) 0.dp else 46.dp)
            .graphicsLayer { val p = step(0); alpha = p; if (!reduced) translationY = -12.dp.toPx() * (1f - p) },
            height = if (landscape) maxHeight * .48f else 220.dp, contentDescription = "Pixel Kingdom Wars")
        Column(Modifier.align(if (landscape) Alignment.CenterEnd else Alignment.BottomCenter)
            .fillMaxWidth(if (landscape) .58f else 1f).widthIn(max = 560.dp)
            .heightIn(max = maxHeight).statusBarsPadding().navigationBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 6.dp)
            .graphicsLayer {
                val p = step(0)
                alpha = p * (1f - leave.value)
                if (!reduced) translationY = 40.dp.toPx() * (1f - p) + 300.dp.toPx() * leave.value
            }, horizontalAlignment = Alignment.CenterHorizontally) {
            Plate(PlateKind.WOOD, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp)) {
                Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(10.dp), blocksScene = false) {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        header()
                        when (ui.stage) {
                            TitleStage.CHOOSE -> ChooseCard(ui, on) { i -> step(i) }
                            TitleStage.TOTP -> TotpCard(ui.totp ?: TotpUi("", null, false), on)
                            TitleStage.ADMISSION -> AdmissionCard(ui.admission ?: AdmissionUi("", false), on)
                        }
                        ui.error?.let { error ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                PkwText(error, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.shortText, maxLines = 6)
                                if (ui.reportAvailable) ReportLink(on.onReport)
                            }
                        }
                        extras()
                    }
                }
            }
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                PkwText(ui.version, PkwTokens.Type.small, Modifier.clearAndSetSemantics { contentDescription = "Version ${ui.version}" },
                    color = PkwTokens.Colors.text, outline = 1.dp)
                if (ui.legalAvailable) {
                    PkwText(" · ", PkwTokens.Type.small, color = PkwTokens.Colors.text, outline = 1.dp)
                    FooterLink("Terms", on.onTerms)
                    PkwText(" · ", PkwTokens.Type.small, color = PkwTokens.Colors.text, outline = 1.dp)
                    FooterLink("Privacy", on.onPrivacy)
                }
            }
        }
    }
}

/** The plain ground under the wallpaper (the wallpaper's own grass), for any edge it does not cover. */
private val TITLE_GROUND = Color(0xFF3F6B2E)

/** The CHOOSE card: FUN-TO-EARN line, the wallet money button, PLAY NOW. [step] is the stagger progress of element i. */
@Composable private fun ChooseCard(ui: TitleUi, on: TitleActions, step: (Int) -> Float) {
    val c = PkwTokens.Colors
    Row(Modifier.fillMaxWidth().graphicsLayer { alpha = step(1) }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Well("ui_portrait_keep_t1", size = 60.dp, iconSize = 56.dp)
        Column(Modifier.weight(1f)) {
            PkwText(TITLE_HEADLINE, PkwTokens.Type.title, color = c.textOnParch)
            PkwText("Build, train and raid now. Buy land when you want your kingdom on the world map.", PkwTokens.Type.body,
                color = c.textOnParch2, maxLines = 3)
        }
    }
    val stage = titleConnectStage(ui.busy)
    val label = titleConnectLabel(ui.lastWalletLabel)
    Box(Modifier.fillMaxWidth().graphicsLayer { alpha = step(2) }) {
        when {
            stage != MoneyStage.READY -> MoneyButton(stage, label, on.onConnectWallet, Modifier.heightIn(min = 68.dp))
            ui.busy != null -> PrimaryButton(label, on.onConnectWallet, Modifier.fillMaxWidth(), state = CommandState.BUSY)
            !ui.walletAdapterAvailable -> PrimaryButton(label, on.onConnectWallet, Modifier.fillMaxWidth(), state = CommandState.DISABLED,
                reason = ui.walletUnavailable ?: "No wallet app on this phone. Install Phantom or Solflare, or play with Google, X or email.")
            else -> PrimaryButton(label, on.onConnectWallet, Modifier.fillMaxWidth().heightIn(min = 68.dp), icon = "sol",
                sub = if (ui.lastWalletLabel == null) "Seed Vault, Phantom, Solflare, Backpack" else null)
        }
    }
    if ((ui.lastWalletLabel != null || ui.showAnotherWallet) && ui.busy == null)
        SecondaryButton("USE ANOTHER WALLET", on.onUseAnotherWallet, Modifier.fillMaxWidth().graphicsLayer { alpha = step(2) })
    ui.socialUnavailable?.let { reason ->
        SecondaryButton(TITLE_PLAY_LABEL, on.onPlayFree, Modifier.fillMaxWidth(), enabled = false)
        PkwText(reason, PkwTokens.Type.small, color = c.shortText, maxLines = 3)
        return
    }
    val socialBusy = ui.busy == TitleBusy.SOCIAL
    ChunkyBox(PkwTokens.Colors.stone, on.onPlayFree, if (socialBusy) "Play now, working" else "Play now with Google, X or email",
        Modifier.fillMaxWidth().heightIn(min = 60.dp).graphicsLayer { alpha = step(3) }, enabled = !socialBusy && ui.busy == null) {
        if (socialBusy) BusyDots()
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwText(TITLE_PLAY_LABEL, PkwTokens.Type.primary, color = c.label, outline = 2.dp)
            PkwText("with Google, X or email", PkwTokens.Type.small, color = c.label)
        }
    }
}

/** The 2-step code card (`TotpRoute`): six cells, green CONFIRM, stone BACK. */
@Composable private fun TotpCard(totp: TotpUi, on: TitleActions) {
    val c = PkwTokens.Colors
    PkwText("2-STEP CODE", PkwTokens.Type.title, color = c.textOnParch)
    PkwText("Enter the 6 digits from your authenticator app.", PkwTokens.Type.body, color = c.textOnParch2, maxLines = 2)
    CodeCells(totp.code, on.onTotpCode, enabled = !totp.busy)
    totp.error?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText, maxLines = 2) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        SecondaryButton("BACK", on.onTotpBack, Modifier.width(100.dp).heightIn(min = 60.dp), enabled = !totp.busy)
        val ready = totp.code.length == TOTP_CELLS
        PrimaryButton("CONFIRM", on.onTotpConfirm, Modifier.weight(1f), verb = Verb.GREEN,
            state = when { totp.busy -> CommandState.BUSY; ready -> CommandState.ENABLED; else -> CommandState.DISABLED },
            reason = if (!ready && !totp.busy) "Type all 6 digits" else null)
    }
}

/**
 * Six 48 × 56 code cells over one numeric field (the real field is invisible; the cells draw its digits). The whole row
 * is the field's touch target. [label] is what a screen reader calls the field (the 2-step, e-mail or wallet code).
 */
@Composable private fun CodeCells(code: String, onCode: (String) -> Unit, enabled: Boolean, label: String = "2-step code") {
    val c = PkwTokens.Colors
    BasicTextField(
        value = code,
        onValueChange = { onCode(totpDraft(it)) },
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "$label, ${code.length} of $TOTP_CELLS digits" },
        decorationBox = { inner ->
            Box {
                Box(Modifier.size(1.dp).graphicsLayer { alpha = 0f }) { inner() }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    repeat(TOTP_CELLS) { i ->
                        val active = i == code.length && enabled
                        Box(Modifier.weight(1f).height(56.dp).drawBehind {
                            val w = size.width; val h = size.height; val r = 2.dp.toPx()
                            fillStepped(0f, 0f, w, h, CornerProfiles.S, if (active) c.gold.face else c.ink)
                            insideStepped(r, r, w - r, h - r, CornerProfiles.S) {
                                drawRect(HubColors.fieldFace); band(r, w - r, r, 3.dp.toPx(), HubColors.fieldInset)
                            }
                        }, contentAlignment = Alignment.Center) {
                            PkwText(code.getOrNull(i)?.toString() ?: "", PkwTokens.Type.numeralL, color = c.textOnParch)
                        }
                    }
                }
            }
        },
    )
}

/** The Seeker admission card (`AdmissionRoute`): SGT copy, the server line, CHECK AGAIN, another wallet. */
@Composable private fun AdmissionCard(admission: AdmissionUi, on: TitleActions) {
    val c = PkwTokens.Colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Well("ui:seeker-navigation", size = 60.dp, light = true, iconSize = 32.dp)
        Column(Modifier.weight(1f)) {
            PkwText("SEEKER ALPHA", PkwTokens.Type.title, color = c.textOnParch)
            PkwText("Your Genesis Token is your invite.", PkwTokens.Type.body, color = c.textOnParch2, maxLines = 2)
        }
    }
    if (admission.line.isNotBlank()) PkwText(admission.line, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 8)
    StoneBusyButton("CHECK AGAIN", admission.checking, on.onAdmissionRecheck, Modifier.fillMaxWidth().heightIn(min = 60.dp))
    SecondaryButton("USE ANOTHER WALLET", on.onUseAnotherWallet, Modifier.fillMaxWidth())
}

/** A footer link: outlined VT 18 white, a 48 dp row target (not underlined blue: it sits on the wallpaper). */
@Composable private fun FooterLink(label: String, onClick: () -> Unit) {
    Box(Modifier.defaultMinSize(PkwTokens.Dims.minTap, PkwTokens.Dims.minTap)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) {
        PkwText(label, PkwTokens.Type.small, color = PkwTokens.Colors.text, outline = 1.dp)
    }
}

/** PLAY NOW's provider half sheet callbacks. */
@Immutable data class SignInProvidersActions(
    val onProvider: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The PLAY NOW half sheet (SPEC §1.1): one 60 dp row per provider (Google, X, email), letter wells (no brand marks).
 * A HALF sheet has no scrim; the host slides it up 180 ms / out 140 ms and Back closes it.
 *
 * Pointer rule: one painted wood panel; only its rows and close take touches.
 */
@Composable fun SignInProvidersSheet(
    providers: List<SignInProviderUi>, on: SignInProvidersActions, modifier: Modifier = Modifier,
    extras: @Composable ColumnScope.() -> Unit = {},
) {
    Plate(PlateKind.WOOD, modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxWidth()) {
            CompactHeader(TITLE_PLAY_LABEL, "ui_portrait_keep_t1", on.onClose)
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    providers.forEach { p ->
                        AccountCard(Modifier.fillMaxWidth(), minHeight = 60.dp, onClick = if (p.busy || !p.enabled) null else ({ on.onProvider(p.id) }),
                            description = p.label, contentPadding = 6.dp) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                LetterWell(p.letter)
                                RowText(p.label, null)
                                if (p.busy) BusyDots()
                            }
                        }
                    }
                    NoteLine("Your kingdom is saved to this sign-in. Link a wallet later to buy land.")
                    extras()
                }
            }
            Box(Modifier.navigationBarsPadding())
        }
    }
}

/** Which e-mail step the PLAY NOW sheet shows. */
enum class EmailSignInStage { ADDRESS, CODE }

/** The e-mail sign-in inside the PLAY NOW sheet (SPEC §1.1 states: the address, then the 2-step card's code input). */
@Immutable data class EmailSignInUi(
    val stage: EmailSignInStage,
    /** ADDRESS: the address being typed. CODE: the address the code was sent to. */
    val email: String,
    /** CODE: 0..6 digits ([totpDraft]). */
    val code: String = "",
    /** The address can be sent / all six digits are in (the live owner's own rule). */
    val ready: Boolean = false,
    /** A sign-in is running: nothing can be sent twice. */
    val busy: Boolean = false,
)

/** E-mail step callbacks. */
@Immutable data class EmailSignInActions(
    val onEmail: (String) -> Unit = {},
    val onSend: () -> Unit = {},
    val onCode: (String) -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onChangeEmail: () -> Unit = {},
    val onCancel: () -> Unit = {},
)

/**
 * The e-mail step under the provider rows: the kit TextField and gold SEND CODE, then the same six cells and green CONFIRM
 * as the 2-step card, with stone CANCEL 100 and the quiet "Use a different email". A not-ready primary shows why below it.
 */
@Composable fun EmailSignInStep(ui: EmailSignInUi, on: EmailSignInActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (ui.stage) {
            EmailSignInStage.ADDRESS -> {
                HubTextField(ui.email, on.onEmail, Copy.SOCIAL_EMAIL_FIELD, placeholder = Copy.SOCIAL_EMAIL_FIELD, enabled = !ui.busy)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                    SecondaryButton(Copy.SOCIAL_CANCEL.uppercase(), on.onCancel, Modifier.width(100.dp).heightIn(min = 60.dp), enabled = !ui.busy)
                    PrimaryButton(Copy.SOCIAL_SEND_CODE.uppercase(), on.onSend, Modifier.weight(1f),
                        state = when { ui.busy -> CommandState.BUSY; ui.ready -> CommandState.ENABLED; else -> CommandState.DISABLED },
                        reason = if (!ui.ready && !ui.busy) "Type your email address" else null)
                }
            }
            EmailSignInStage.CODE -> {
                PkwText(Copy.socialCodeSent(ui.email), PkwTokens.Type.body, color = c.textOnParch2, maxLines = 3)
                CodeCells(ui.code, on.onCode, enabled = !ui.busy, label = Copy.SOCIAL_CODE_FIELD)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                    SecondaryButton(Copy.SOCIAL_CANCEL.uppercase(), on.onCancel, Modifier.width(100.dp).heightIn(min = 60.dp), enabled = !ui.busy)
                    PrimaryButton("CONFIRM", on.onConfirm, Modifier.weight(1f), verb = Verb.GREEN,
                        state = when { ui.busy -> CommandState.BUSY; ui.ready -> CommandState.ENABLED; else -> CommandState.DISABLED },
                        reason = if (!ui.ready && !ui.busy) "Type all 6 digits" else null)
                }
                if (!ui.busy) QuietButton(Copy.SOCIAL_CHANGE_EMAIL, on.onChangeEmail, onParchment = true)
            }
        }
    }
}

/** The game wallet's own authenticator prompt (the embedded wallet's MFA, not the game's 2-step login code). */
@Immutable data class WalletCodeUi(
    val title: String,
    val detail: String,
    /** False: this wallet's method cannot be answered here; only the cancel button shows and [detail] says where to verify. */
    val supported: Boolean,
    /** 0..6 digits ([totpDraft]). */
    val code: String,
    /** What a screen reader calls the code field. */
    val fieldLabel: String,
    val confirmLabel: String,
    val cancelLabel: String,
)

/**
 * The wallet code half sheet: the title's wood panel with the existing security copy, the 2-step card's six cells and a
 * green confirm. Closing it cancels the running sign-in (the host's owner decides what that means).
 *
 * Pointer rule: one painted wood panel; only the cells, close and the two buttons take touches.
 */
@Composable fun WalletCodeSheet(ui: WalletCodeUi, onCode: (String) -> Unit, onConfirm: () -> Unit, onCancel: () -> Unit,
    modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.WOOD, modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxWidth()) {
            CompactHeader(ui.title.uppercase(), "sol", onCancel)
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PkwText(ui.detail, PkwTokens.Type.body, color = c.textOnParch2, maxLines = 6)
                    if (ui.supported) CodeCells(ui.code, onCode, enabled = true, label = ui.fieldLabel)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                        if (ui.supported) {
                            SecondaryButton(ui.cancelLabel.uppercase(), onCancel, Modifier.width(100.dp).heightIn(min = 60.dp))
                            val ready = ui.code.length == TOTP_CELLS
                            PrimaryButton(ui.confirmLabel.uppercase(), onConfirm, Modifier.weight(1f), verb = Verb.GREEN,
                                state = if (ready) CommandState.ENABLED else CommandState.DISABLED,
                                reason = if (!ready) "Type all 6 digits" else null)
                        } else SecondaryButton(ui.cancelLabel.uppercase(), onCancel, Modifier.fillMaxWidth().heightIn(min = 60.dp))
                    }
                }
            }
            Box(Modifier.navigationBarsPadding())
        }
    }
}

/** The title settings sheet (the 48 × 48 stone square, SPEC §1.1: sound and About inside, plus the account doors). */
@Immutable data class TitleSettingsUi(
    /** This device's music / sound effects preferences; null hides that row (no device preferences reached the title). */
    val music: Boolean?,
    val soundFx: Boolean?,
    /** Signed out with nothing running: the account doors can start. Otherwise they say why they wait. */
    val accountIdle: Boolean,
    /** A transferred deed can be claimed from here (the host offered the existing claim route). */
    val claimDeed: Boolean,
    /** The network line ("SOLANA MOBILE · DEVNET"). */
    val network: String,
)

/** Title settings callbacks. */
@Immutable data class TitleSettingsActions(
    val onMusic: (Boolean) -> Unit = {},
    val onSoundFx: (Boolean) -> Unit = {},
    val onRestore: () -> Unit = {},
    val onClaimDeed: () -> Unit = {},
    val onAbout: () -> Unit = {},
    val onPlayWeb: () -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The settings half sheet: SOUND & FEEL toggles (the Settings hub's own rows and words), then ACCOUNT & SUPPORT doors
 * (restore the saved session, claim a transferred deed, About with the legal and support pages, the web game) and the
 * network line. There is no language row: the game has one language today.
 *
 * Pointer rule: one painted wood panel; only its rows and close take touches.
 */
@Composable fun TitleSettingsSheet(ui: TitleSettingsUi, on: TitleSettingsActions, modifier: Modifier = Modifier) {
    Plate(PlateKind.WOOD, modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxWidth()) {
            CompactHeader("SETTINGS", "settings", on.onClose)
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (ui.soundFx != null || ui.music != null) SectionHeader("SOUND & FEEL")
                    ui.soundFx?.let { sfx -> ToggleRow("Sound effects", "Battle sounds and scene ambience", sfx, on.onSoundFx) }
                    ui.music?.let { music -> ToggleRow("Music", "World and battle themes", music, on.onMusic) }
                    SectionHeader("ACCOUNT & SUPPORT")
                    TitleDoor(Copy.RESTORE_SESSION, ui.accountIdle, on.onRestore)
                    if (ui.claimDeed) TitleDoor("Claim a transferred deed", ui.accountIdle, on.onClaimDeed)
                    TitleDoor("About, legal & support", ui.accountIdle, on.onAbout)
                    TitleDoor(Copy.PLAY_WEB, true, on.onPlayWeb)
                    NoteLine(ui.network)
                }
            }
            Box(Modifier.navigationBarsPadding())
        }
    }
}

/** One settings door (CardRow 56 + chevron). While a sign-in runs it dims and says why instead of acting. */
@Composable private fun TitleDoor(label: String, enabled: Boolean, onClick: () -> Unit) {
    CardRow(variant = if (enabled) RowVariant.PLAIN else RowVariant.DIM, onClick = onClick, description = label, enabled = enabled) {
        RowText(label, if (enabled) null else "Wait for the current sign-in to finish.")
        RowChevron()
    }
}

// ---- Previews (onboard-title.png and the SPEC's states) ----

@Preview(name = "Title (onboard-title.png)", widthDp = 412, heightDp = 915)
@Composable private fun TitlePreview() { TitleScreen(sampleTitle, TitleActions()) }

@Preview(name = "Title: returning player", widthDp = 412, heightDp = 915)
@Composable private fun TitleReturningPreview() { TitleScreen(sampleTitle.copy(lastWalletLabel = "7xKp…4f2k"), TitleActions()) }

@Preview(name = "Title: wallet connecting (Check wallet)", widthDp = 412, heightDp = 915)
@Composable private fun TitleConnectingPreview() { TitleScreen(sampleTitle.copy(busy = TitleBusy.WALLET_CHECK), TitleActions()) }

@Preview(name = "Title: 2-step code", widthDp = 412, heightDp = 915)
@Composable private fun TitleTotpPreview() {
    TitleScreen(sampleTitle.copy(stage = TitleStage.TOTP, totp = TotpUi("4821", "That code did not match. Try the newest one.", false)), TitleActions())
}

@Preview(name = "Title: Seeker admission", widthDp = 412, heightDp = 915)
@Composable private fun TitleAdmissionPreview() {
    TitleScreen(sampleTitle.copy(stage = TitleStage.ADMISSION, admission = AdmissionUi("No Genesis Token found in 7xKp…4f2k.", false)), TitleActions())
}

@Preview(name = "Title: error with Report", widthDp = 412, heightDp = 915)
@Composable private fun TitleErrorPreview() {
    TitleScreen(sampleTitle.copy(error = "The wallet did not answer. Try again."), TitleActions())
}

@Preview(name = "PLAY NOW providers (half sheet)", widthDp = 412, heightDp = 400)
@Composable private fun ProvidersPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6B2E))) {
        SignInProvidersSheet(sampleTitle.socialProviders, SignInProvidersActions(), Modifier.align(Alignment.BottomCenter))
    }
}

@Preview(name = "PLAY NOW: e-mail code step", widthDp = 412, heightDp = 640)
@Composable private fun EmailCodePreview() {
    Box(Modifier.fillMaxSize().background(TITLE_GROUND)) {
        SignInProvidersSheet(sampleTitle.socialProviders, SignInProvidersActions(), Modifier.align(Alignment.BottomCenter), extras = {
            EmailSignInStep(EmailSignInUi(EmailSignInStage.CODE, "player@example.com", "4821"), EmailSignInActions())
        })
    }
}

@Preview(name = "Game wallet code (half sheet)", widthDp = 412, heightDp = 420)
@Composable private fun WalletCodePreview() {
    Box(Modifier.fillMaxSize().background(TITLE_GROUND)) {
        WalletCodeSheet(WalletCodeUi("Verify your game wallet", "Enter the 6-digit code from the wallet's authenticator.", true, "48",
            "Wallet authenticator code", "Approve", "Cancel"), {}, {}, {}, Modifier.align(Alignment.BottomCenter))
    }
}

@Preview(name = "Title settings (half sheet)", widthDp = 412, heightDp = 640)
@Composable private fun TitleSettingsPreview() {
    Box(Modifier.fillMaxSize().background(TITLE_GROUND)) {
        TitleSettingsSheet(TitleSettingsUi(music = true, soundFx = false, accountIdle = true, claimDeed = true, network = "SOLANA MOBILE · DEVNET"),
            TitleSettingsActions(), Modifier.align(Alignment.BottomCenter))
    }
}
