package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowChevron
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

/**
 * Design component: Profile › WALLET (design/final/account/profile-wallet.png, SPEC §4.2): the linked wallet (+ DevTag,
 * COPY), "IN YOUR WALLET · yours, not the game's" with the SKR and KEEP ValueTiles (each a blue door to where it is
 * used), any extra token rows the server sends (QA chain lane only), the SOL row (+ TEST SOL on devnet), the DAILY TEST SKR
 * faucet row and the HISTORY entry. Readouts come from the
 * server-side wallet read; unknown is "…". Gems are not here (they live in the game, not the wallet). No custodial
 * wording anywhere (rule 0.5).
 */

/** Everything the WALLET tab draws (SPEC §4.2 `WalletUiState`). Amounts arrive formatted or "…". */
@Immutable data class WalletUi(
    /** A wallet is linked to this account; false makes the tab one LINK WALLET card. */
    val linked: Boolean,
    /** PS 12 wallet app ("SEED VAULT"). */
    val walletName: String,
    /** "7xKp…4f2k" ([shortAddress]). */
    val shortAddress: String,
    /** "this phone"; null draws none. */
    val deviceNote: String?,
    /** Devnet: DevTag, TEST SOL and the faucet row. Mainnet: none of them. */
    val devnet: Boolean,
    val skr: String,
    val keep: String,
    val sol: String,
    /** The faucet's state; [FaucetUi.Hidden] hides the row. */
    val faucet: FaucetUi,
    /** History counts ("2 need you · 41 done"); null = unknown. */
    val historyNeedsYou: Int?,
    val historyDone: Int?,
    /** The devnet SOL faucet request is in flight. */
    val testSolBusy: Boolean = false,
    /** Non-null reasons draw the designed unavailable state instead of promising a working door. */
    val seekerUnavailable: String? = null,
    val historyUnavailable: String? = null,
    val testSolUnavailable: String? = null,
    /** Rows the server's wallet read sent beyond the catalogue's tokens (the QA chain lane's test SKR), in server order,
     *  drawn after the SKR and KEEP tiles. Empty on production, which sends none: the tab is then unchanged. */
    val extraTokens: List<WalletTokenRowUi> = emptyList(),
)

/** One extra wallet token row: the server's symbol and its amount, formatted like the tiles ("…" unread, "0" not held). */
@Immutable data class WalletTokenRowUi(val symbol: String, val amount: String)

/** The kit has no art per extra token; the legacy wallet page's non-KEEP token icon (EconomyScreen ON-CHAIN BALANCES). */
internal const val EXTRA_TOKEN_ICON: String = "star"

/** WALLET callbacks (SPEC §4.2). */
@Immutable data class WalletActions(
    /** COPY: put the full address on the clipboard, toast "Copied". */
    val onCopyAddress: () -> Unit = {},
    /** SKR tile: fly to Seeker Island. */
    val onSeekerIsland: () -> Unit = {},
    /** KEEP tile: fly to the Gold Forge. */
    val onGoldForge: () -> Unit = {},
    /** TEST SOL (devnet SOL faucet). */
    val onTestSol: () -> Unit = {},
    /** The faucet row: open the drawer's faucet card at SKR (SPEC §6.1). */
    val onClaimFaucet: () -> Unit = {},
    /** HISTORY: push `WalletHistory`. */
    val onHistory: () -> Unit = {},
    /** No wallet: LINK WALLET. */
    val onLinkWallet: () -> Unit = {},
)

/** The WALLET body inside the Profile card's parchment. Pointer rule: only its buttons and the two door rows take touches. */
@Composable fun ColumnScope.ProfileWalletBody(ui: WalletUi, on: WalletActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!ui.linked) {
            AccountCard(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalAlignment = Alignment.CenterHorizontally, contentPadding = 12.dp) {
                Well("sol", size = 64.dp, light = true, iconSize = 48.dp)
                PkwText("Link a wallet to buy land and hold KEEP", PkwTokens.Type.body, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                PrimaryButton("LINK WALLET", on.onLinkWallet, Modifier.fillMaxWidth().padding(top = 6.dp), icon = "sol")
            }
        } else LinkedWallet(ui, on)
    }
}

/** The linked-wallet rows (everything but the LINK WALLET card). */
@Composable private fun LinkedWallet(ui: WalletUi, on: WalletActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            PkwText("LINKED WALLET", PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch)
            if (ui.devnet) DevTag()
        }
        // profile-wallet.html: kcard 76, light well 56 with the Solana mark at 36, PS 12 app name, stone COPY 64 × 48.
        CardRow(height = 76.dp) {
            Well("sol", size = 56.dp, light = true, iconSize = 36.dp)
            NameRowText(ui.walletName, listOfNotNull(ui.shortAddress, ui.deviceNote).joinToString(" · "))
            SecondaryButton("COPY", on.onCopyAddress, Modifier.size(64.dp, 48.dp), contentDescription = "Copy wallet address ${ui.shortAddress}")
        }
        SectionHeader("IN YOUR WALLET", note = "yours, not the game's")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ValueTile("skr", "SKR", ui.skr, AccountColors.skrValue, "Bid for Seeker Island spots", "SEEKER ISLAND", on.onSeekerIsland, Modifier.weight(1f), ui.seekerUnavailable)
            ValueTile("keep", "KEEP", ui.keep, AccountColors.keepValue, "Buy Gems and trade at the Market", "GOLD FORGE", on.onGoldForge, Modifier.weight(1f))
        }
        // Extra rows the server sent (none on production): the SOL row's kcard 64 with the token's own symbol, paint only.
        ui.extraTokens.forEach { row ->
            CardRow(height = 64.dp) {
                PkwIcon(EXTRA_TOKEN_ICON, 24.dp)
                NameRowText("${row.amount} ${row.symbol}", "on the game network", gap = 2.dp)
            }
        }
        // The SOL row: the Solana mark at 24, PS 12 amount, stone TEST SOL 104 × 44 (devnet only).
        CardRow(height = 64.dp) {
            PkwIcon("sol", 24.dp)
            NameRowText("${ui.sol} SOL", "for land and network fees", gap = 2.dp)
            if (ui.devnet) {
                if (ui.testSolUnavailable == null) StoneBusyButton("TEST SOL", ui.testSolBusy, on.onTestSol, Modifier.size(104.dp, 44.dp))
                else SecondaryButton("TEST SOL", {}, Modifier.size(104.dp, 44.dp), enabled = false,
                    contentDescription = "Test SOL unavailable. ${ui.testSolUnavailable}")
            }
        }
        if (ui.devnet) ui.testSolUnavailable?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3) }
        // Every faucet state but Ready is one row target (NeedsDeed, Unavailable, Claimed, Checking open the faucet sheet,
        // which says why); Ready keeps its own gold CLAIM 88 × 48.
        faucetRowLine(ui.faucet)?.let { line ->
            val ready = ui.faucet is FaucetUi.Ready
            CardRow(variant = if (ready) RowVariant.READY else RowVariant.PLAIN, height = 72.dp,
                onClick = if (ready) null else on.onClaimFaucet, description = "Daily test SKR. $line") {
                Well("skr", size = 52.dp, light = true, iconSize = 36.dp)
                NameRowText("DAILY TEST SKR", line)
                if (ready) ChunkyBox(c.gold, on.onClaimFaucet, "Claim daily test SKR. $line", Modifier.size(88.dp, 48.dp)) {
                    PkwText("CLAIM", PkwTokens.Type.label, color = c.label, outline = 1.dp)
                } else RowChevron()
            }
        }
        SectionHeader("HISTORY", note = "every payment and claim")
        val badge = countBadge(ui.historyNeedsYou, "need you")
        CardRow(height = 72.dp, onClick = if (ui.historyUnavailable == null) on.onHistory else null,
            description = listOfNotNull("History", ui.historyUnavailable ?: historyLine(ui.historyNeedsYou, ui.historyDone), badge?.description).joinToString(". ")) {
            Well("replay", size = 52.dp, light = true, iconSize = 36.dp)
            RowText(if (ui.historyUnavailable == null) historyLine(ui.historyNeedsYou, ui.historyDone) else "UNAVAILABLE",
                ui.historyUnavailable ?: "Grouped by building and island")
            if (ui.historyUnavailable == null) { badge?.let { Badge(it) }; RowChevron() }
        }
        Spacer(Modifier.heightIn(min = 4.dp))
    }
}

/**
 * A ValueTile (166 tall): currency icon + name, the value in PS 16 [valueColor], the VT 18 purpose and a full-width blue
 * door to where the currency is used (blue = go to a place).
 */
@Composable private fun ValueTile(icon: String, name: String, value: String, valueColor: Color, purpose: String, goLabel: String,
    onGo: () -> Unit, modifier: Modifier, unavailable: String? = null) {
    val c = PkwTokens.Colors
    AccountCard(modifier.heightIn(min = 166.dp)) {
        Column(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "$name in your wallet: $value. $purpose" },
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwIcon(icon, 24.dp)
                PkwText(name, PkwTokens.Type.caption, color = c.textOnParch2)
            }
            PkwText(value, PkwTokens.Type.numeralL, color = valueColor)
            PkwText(purpose, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2)
        }
        // The tile's door is a full-width blue button 44 tall (profile-wallet.html), under the purpose line.
        SecondaryButton(if (unavailable == null) goLabel else "UNAVAILABLE", onGo, Modifier.fillMaxWidth().height(44.dp),
            verb = Verb.BLUE, enabled = unavailable == null,
            contentDescription = unavailable ?: "Go to ${goLabel.lowercase()}")
        unavailable?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3) }
    }
}

// ---- Previews ----

@Preview(name = "WALLET: not linked", widthDp = 412, heightDp = 915)
@Composable private fun WalletUnlinkedPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = WALLET_TAB, wallet = sampleWallet.copy(linked = false)), ProfileCardActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "WALLET: mainnet (no DevTag, TEST SOL or faucet)", widthDp = 412, heightDp = 915)
@Composable private fun WalletMainnetPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = WALLET_TAB, wallet = sampleWallet.copy(devnet = false, faucet = FaucetUi.Hidden)),
            ProfileCardActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "WALLET: an extra token row from the server (QA chain lane)", widthDp = 412, heightDp = 915)
@Composable private fun WalletExtraTokenPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = WALLET_TAB, wallet = sampleWallet.copy(extraTokens = listOf(WalletTokenRowUi("tSKR", "1,000")))),
            ProfileCardActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "WALLET: unknown readouts, faucet claimed", widthDp = 412, heightDp = 915)
@Composable private fun WalletUnknownPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(selectedTab = WALLET_TAB, wallet = sampleWallet.copy(skr = "…", keep = "…", sol = "…",
            faucet = FaucetUi.ClaimedToday("7h 12m"), historyNeedsYou = null, historyDone = null)), ProfileCardActions(), Modifier.fillMaxSize())
    }
}
