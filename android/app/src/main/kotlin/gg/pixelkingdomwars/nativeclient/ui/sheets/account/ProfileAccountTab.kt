package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubTextField
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleSwitch
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

/**
 * Design component: Profile › ACCOUNT (design/final/account/profile-account.png, SPEC §4.3): NAME (input + green SAVE),
 * SIGN IN WITH (wallet, Google, X rows: ON or a blue LINK), SECURITY (2-STEP CODE toggle, BACKUP CODES + VIEW), and the
 * stone SIGN OUT on the wood footer with "Your kingdom stays." (not red: nothing is destroyed). Settings' old ACCOUNT tab
 * becomes a door to this tab (rule 0.4).
 */

/** One SIGN IN WITH row. */
@Immutable data class ProviderRowUi(
    val kind: ProviderKind,
    /** VT 18: "Seed Vault · 7xKp…4f2k", "t•••@gmail.com" (masked by the mapper), or "not linked". */
    val label: String,
    val linked: Boolean,
    /** LINK / unlink is in flight. */
    val busy: Boolean = false,
)

/** Everything the ACCOUNT tab draws (SPEC §4.3 `AccountUiState`). */
@Immutable data class AccountUi(
    /** The NAME field's current text (hoisted). */
    val nameDraft: String,
    /** The saved display name (SAVE enables only for a change). */
    val savedName: String,
    /** The server's refusal ("That name is taken"); drawn in [PkwTokens.Colors.shortText] under the field. */
    val nameError: String?,
    val nameSaving: Boolean,
    val providers: List<ProviderRowUi>,
    /** 2-step code on / off; null = unknown (toggle disabled, "…"). */
    val totpEnabled: Boolean?,
    /** Backup codes left; null = unknown. */
    val backupCodesLeft: Int?,
    /** SIGN OUT is in flight. */
    val signingOut: Boolean = false,
    /** The existing owner has loaded the rename rules and permits editing. */
    val nameEditingEnabled: Boolean = true,
)

/** ACCOUNT callbacks (SPEC §4.3). */
@Immutable data class AccountActions(
    /** The NAME field changed (the mapper keeps [AccountUi.nameDraft]). */
    val onNameDraft: (String) -> Unit = {},
    val onSaveName: (String) -> Unit = {},
    /** LINK a sign-in method. */
    val onLink: (ProviderKind) -> Unit = {},
    /** A linked row was tapped: raise the unlink ConfirmDialog. Never called for the last method ([canUnlink]). */
    val onUnlink: (ProviderKind) -> Unit = {},
    /** The 2-step code toggle: start the `SecurityRoute` flow for [on]. */
    val onToggleTotp: (Boolean) -> Unit = {},
    val onViewBackupCodes: () -> Unit = {},
    /** SIGN OUT: raise the stone/stone ConfirmDialog. */
    val onSignOut: () -> Unit = {},
)

/** The ACCOUNT body inside the Profile card's parchment. Pointer rule: only the field, buttons and rows take touches. */
@Composable fun ColumnScope.ProfileAccountBody(ui: AccountUi, on: AccountActions,
    extras: (@Composable ColumnScope.() -> Unit)? = null) {
    val c = PkwTokens.Colors
    val linked = ui.providers.associate { it.kind to it.linked }
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("NAME", note = "shown to other players")
        // profile-account.html: input 52 + green SAVE 88 × 52, 6 dp apart.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            HubTextField(ui.nameDraft, on.onNameDraft, "Display name", Modifier.weight(1f), placeholder = "Your name", enabled = !ui.nameSaving && ui.nameEditingEnabled)
            if (ui.nameSaving) StoneBusyButton("SAVE", true, {}, Modifier.size(88.dp, 52.dp))
            else SecondaryButton("SAVE", { on.onSaveName(ui.nameDraft.trim()) }, Modifier.width(88.dp), verb = Verb.GREEN,
                enabled = ui.nameEditingEnabled && nameSaveEnabled(ui.nameDraft, ui.savedName, ui.nameSaving), contentDescription = "Save name")
        }
        ui.nameError?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText, maxLines = 2) }

        SectionHeader("SIGN IN WITH", note = "any one opens this account")
        ui.providers.forEach { row -> ProviderRow(row, canUnlink(linked, row.kind), on) }

        SectionHeader("SECURITY")
        TotpRow(ui.totpEnabled, on.onToggleTotp)
        // BACKUP CODES: kcard 66, light well 48 with the info icon at 24, stone VIEW 72 × 44.
        CardRow(height = ACCOUNT_ROW_H) {
            Well("info", size = 48.dp, light = true, iconSize = 24.dp)
            NameRowText("BACKUP CODES", "${ui.backupCodesLeft?.toString() ?: UNKNOWN} left · keep them safe")
            SecondaryButton("VIEW", on.onViewBackupCodes, Modifier.size(72.dp, 44.dp), contentDescription = "View backup codes")
        }
        extras?.invoke(this)
    }
}

/** The ACCOUNT tab's row height (profile-account.html `.kcard` 66). */
private val ACCOUNT_ROW_H = 66.dp

/** A SIGN IN WITH row (kcard 66): light well 48 (the Solana mark at 24, or a PS letter), PS 12 name, VT 18 label, then the
 *  green ON tag or a blue LINK 72 × 44. */
@Composable private fun ProviderRow(row: ProviderRowUi, unlinkable: Boolean, on: AccountActions) {
    val title = when (row.kind) {
        ProviderKind.WALLET -> "WALLET"; ProviderKind.GOOGLE -> "GOOGLE"; ProviderKind.X -> "X"; ProviderKind.EMAIL -> "EMAIL"
    }
    val tap: (() -> Unit)? = if (row.linked && unlinkable && !row.busy) ({ on.onUnlink(row.kind) }) else null
    CardRow(height = ACCOUNT_ROW_H, onClick = tap,
        description = if (tap != null) "$title linked, ${row.label}. Tap to unlink" else null) {
        if (row.kind == ProviderKind.WALLET) Well("sol", size = 48.dp, light = true, iconSize = 24.dp)
        else LetterWell(providerLetter(row.kind), size = 48.dp)
        NameRowText(title, row.label)
        when {
            row.busy -> StoneBusyButton(if (row.linked) "ON" else "LINK", true, {}, Modifier.size(72.dp, 44.dp))
            row.linked -> StatusTag("ON", Verb.GREEN)
            else -> SecondaryButton("LINK", { on.onLink(row.kind) }, Modifier.size(72.dp, 44.dp), verb = Verb.BLUE, contentDescription = "Link $title")
        }
    }
}

/** The 2-STEP CODE row: a tap anywhere toggles; the row states the state. Unknown → disabled with "…". */
@Composable private fun TotpRow(enabled: Boolean?, onToggle: (Boolean) -> Unit) {
    val known = enabled != null
    val on = enabled == true
    val sub = if (known) "Asked on a new phone" else UNKNOWN
    Row(Modifier.fillMaxWidth().heightIn(min = ACCOUNT_ROW_H)
        .clearAndSetSemantics {
            contentDescription = "2-step code. ${if (!known) "unknown" else if (on) "on" else "off"}. $sub"
            role = Role.Switch; toggleableState = ToggleableState(on)
            if (!known) disabled()
            this.onClick(label = null, action = { if (known) onToggle(!on); known })
        }
        .clickable(enabled = known, role = Role.Switch) { onToggle(!on) }) {
        CardRow(height = ACCOUNT_ROW_H) {
            Well("shield", size = 48.dp, light = true, iconSize = 24.dp)
            NameRowText("2-STEP CODE", sub)
            ToggleSwitch(on, known)
        }
    }
}

/**
 * The ACCOUNT footer on the wood (SPEC §4.3): stone SIGN OUT full width × 56 and the VT 18 reassurance. Put it in the
 * card's footer row with `Modifier.weight(1f)`.
 */
@Composable fun AccountFooter(ui: AccountUi, on: AccountActions, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (ui.signingOut) StoneBusyButton("SIGN OUT", true, {}, Modifier.fillMaxWidth().heightIn(min = 56.dp))
        else SecondaryButton("SIGN OUT", on.onSignOut, Modifier.fillMaxWidth().heightIn(min = 56.dp), contentDescription = "Sign out")
        // VT 18 in the frame's `--muted` on the wood footer.
        PkwText("Your kingdom stays. Sign in again with your wallet or Google.", PkwTokens.Type.small,
            color = PkwTokens.Colors.muted, textAlign = TextAlign.Center, maxLines = 2)
    }
}

// ---- Previews ----

@Preview(name = "ACCOUNT: name taken, last method has no unlink", widthDp = 412, heightDp = 915)
@Composable private fun AccountNameTakenPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = ACCOUNT_TAB, account = sampleAccount.copy(nameDraft = "Mira", nameError = "That name is taken",
            providers = sampleAccount.providers.map { if (it.kind == ProviderKind.GOOGLE) it.copy(linked = false, label = "not linked") else it })),
            ProfileCardActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "ACCOUNT: saving, unknown security", widthDp = 412, heightDp = 915)
@Composable private fun AccountSavingPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = ACCOUNT_TAB, account = sampleAccount.copy(nameDraft = "Rowan II", nameSaving = true,
            totpEnabled = null, backupCodesLeft = null)), ProfileCardActions(), Modifier.fillMaxSize())
    }
}
