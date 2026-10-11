package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/**
 * Design component: the Gold Forge LEGACY tab, the server-declared 4th tab for the custodial Forge until the D153.262
 * cutover (design/final/goldforge/SPEC.md §7.4: "EmptyState + recovery buttons, outside this spec"; not mocked, the
 * owner decision on showing it is still open). It is a signpost only: it states whether the old Forge still takes
 * deposits, shows KEEP still owed and any saved request, and sends the player to the EXISTING recovery surfaces (the
 * old Forge route, `KeepDepositRoute(recoveryOnly)`); it moves no money itself. The tab exists only while the mapper
 * sets `GoldForgeSheetUi.legacy` (custody open, KEEP owed, or a saved request), matching MS-E's `GoldForgeTab.LEGACY`.
 *
 * Pointer rule: a plain layout inside the painted parchment; only the GO buttons take touches.
 */
@Immutable data class LegacyUi(
    /** Custody metadata is observed and open (`keepCustodyAllowsNewActions`): the old Forge still takes deposits. */
    val custodyOpen: Boolean,
    /** KEEP still owed by the old Forge, formatted ("120"); null = nothing owed; "…" = not read yet. */
    val owed: String?,
    /** A saved deposit, withdrawal or claim exists that can be checked and finished. */
    val savedRequest: Boolean,
    /** An optional server line ("Cutover on Wed 14 Oct"). */
    val reason: String? = null,
)

/** LEGACY callbacks. */
@Immutable data class LegacyActions(
    /** Open the existing old Forge surface (deposits only while custody is open; payouts and recovery always). */
    val onOpenLegacy: () -> Unit = {},
    /** CHECK the saved request (the existing by-key read; never a new deposit). */
    val onCheckSaved: () -> Unit = {},
)

/** The LEGACY body. It has no primary and no footer: every door is a GO row. */
@Composable fun LegacyBody(ui: LegacyUi, on: LegacyActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionRow("OLD FORGE")
        PkwText(if (ui.custodyOpen) "The old Forge still takes deposits until the cutover. New coins come from SMELT and CLAIM."
            else "The old Forge takes no new deposits. Anything saved there stays recoverable.",
            PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch, maxLines = 3)
        ui.owed?.let { CalloutRow("gf:keep_24", "$it KEEP owed by the old Forge", "Collect it in the old Forge") }
        if (ui.savedRequest) GoRow("shape:chest", "A saved request", "Check it to finish it", on.onCheckSaved, "Check the saved request")
        GoRow("keep", "Open the old Forge", if (ui.custodyOpen) "deposits, payouts and recovery" else "payouts and recovery",
            on.onOpenLegacy, "Open the old Forge")
        ui.reason?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2) }
    }
}

@Preview(name = "LEGACY: custody open, KEEP owed", widthDp = 398, heightDp = 420)
@Composable private fun LegacyOpenPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp)) {
        LegacyBody(LegacyUi(custodyOpen = true, owed = "120", savedRequest = false, reason = "Cutover on Wed 14 Oct"), LegacyActions())
    }
}

@Preview(name = "LEGACY: closed, saved request", widthDp = 398, heightDp = 420)
@Composable private fun LegacyClosedPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp)) {
        LegacyBody(LegacyUi(custodyOpen = false, owed = null, savedRequest = true), LegacyActions())
    }
}
