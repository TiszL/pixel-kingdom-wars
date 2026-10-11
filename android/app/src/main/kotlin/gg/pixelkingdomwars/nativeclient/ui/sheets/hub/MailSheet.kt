package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: Mail (design/final/hub/mail.png), its empty state (mail-empty.png) and the letter modal over it
 * (mail-open.png, drawn by [LetterModal]); SPEC §2.4, §3.5. Destination: `Mail` (FULL card, no tabs). League rewards,
 * event gifts, clan invites, news. Opening a letter marks it read (server `markRead`); past claims live in History, never
 * as "receipt" wording here.
 */

/** One LetterRow (CardRow 64). */
@Immutable data class LetterRowUi(
    val id: String,
    /** The sender's icon in a dark Well (league crest 40, `itm_crest` 32, shield 36, `itm_banner` 32, `keep` 36, …). */
    val senderIcon: String,
    /** VT 20 subject. */
    val subject: String,
    /** VT 18 "sender · age" ("League office · 2h ago"). */
    val senderLine: String,
    /** Unread: 12 dp red square in the Well, `unread` row tint. */
    val unread: Boolean,
    /** The attached reward pill ("12K"); null when none or already claimed. */
    val reward: PriceUi?,
)

/** Everything the Mail card draws (SPEC §2.4 State; fields after `load` were added with defaults). */
@Immutable data class MailUi(
    /** "ALL", "REWARDS" or "NEWS" (or an [extraChips] id such as "ARCHIVE"). */
    val filter: String,
    /** Counts per filter id (ALL, REWARDS); drawn through [mailFilterChips]. A missing ALL count is "…". */
    val counts: Map<String, Int>,
    val letters: List<LetterRowUi>,
    /** The footer CLAIM ALL n; hidden when null or n = 0. */
    val claimAll: ClaimAllUi?,
    /** More letters on the server: a MORE row at the end calls `onLoadMore`. */
    val hasMore: Boolean,
    val load: LoadState,
    /** SHARDS + GEMS (what letters pay out). */
    val readouts: List<ResourceChipUi> = emptyList(),
    /** The open letter (a child surface over the inbox, not a Destination); null when none is open. */
    val open: LetterUi? = null,
    /** The empty inbox (mail-empty.png). */
    val empty: EmptyStateUi = EmptyStateUi("shape:mail", "No letters yet", "League rewards, event gifts and clan invites arrive here.",
        "SEE QUESTS", FeatureId("hud.quests")),
    /** Footnote under the list. */
    val footnote: String? = "Letters keep 30 days. Rewards wait until you claim.",
    /** CLAIM ALL is waiting for its receipt. */
    val claimAllBusy: Boolean = false,
    /** The MORE row is fetching. */
    val loadingMore: Boolean = false,
    /** VT 18 line under the chips: the server's unread and pending-reward counts ("9 unread · 4 pending rewards"). */
    val statusLine: String? = null,
    /** Why there is no CLAIM ALL (the server has no batch claim): "Open each reward letter to claim." */
    val batchUnavailable: String? = null,
    /** The ARCHIVE list is shown: no inbox counts. */
    val archived: Boolean = false,
    /** A saved claim whose result is not settled; drawn whatever letter or page is shown. */
    val recovery: MailRecoveryUi? = null,
    /** A read hold, an owner change or the server's last claim notice. */
    val notice: String? = null,
    /** Chips after ALL · REWARDS · NEWS (the ARCHIVE list). */
    val extraChips: List<FilterChipUi> = emptyList(),
)

/** A saved mail claim (the existing claim journal) whose result is not settled. CHECK AGAIN only reads; RETRY resends the
 *  same saved claim and is offered only without a receipt and for the saved destination. */
@Immutable data class MailRecoveryUi(
    /** The letter the saved claim belongs to (its idempotency key). */
    val mailId: String,
    /** Where the claim goes and what each button does. */
    val line: String,
    val retryAllowed: Boolean,
    /** A request is running: CHECK AGAIN shows dots. */
    val busy: Boolean = false,
    /** The server answered `unknown` for exactly this saved claim: CLOSE is offered (owner 2026-10-06), with [observation]. */
    val closeAllowed: Boolean = false,
    val observation: String? = null,
)

/** Mail callbacks (SPEC §2.4; the ones after `onClose` were added with defaults). */
@Immutable data class MailActions(
    val onFilter: (String) -> Unit = {},
    /** Open a letter (and mark it read on the server). */
    val onOpen: (String) -> Unit = {},
    val onClaim: (String) -> Unit = {},
    val onClaimAll: () -> Unit = {},
    val onArchive: (String) -> Unit = {},
    /** The letter's CHANGE kingdom. */
    val onChangeKingdom: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** Close / Back on the open letter: back to the inbox. */
    val onCloseLetter: () -> Unit = {},
    /** CHECK AGAIN on a claim whose result is uncertain (same idempotency key). */
    val onRecheck: (String) -> Unit = {},
    /** Blue GO on a letter that needs a base ("Select a Land Deed first" → `Profile(KINGDOMS)`). */
    val onGo: (HubLink) -> Unit = {},
    /** The empty inbox's SEE QUESTS. */
    val onEmptyGo: (FeatureId) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    /** RETRY on a saved claim without a receipt: resends that same saved claim, never a new one. */
    val onRetryClaim: (String) -> Unit = {},
    /** CLOSE on a saved claim the server answered `unknown` for: one more GET, then forgotten on this device; never a POST. */
    val onCloseClaim: (String) -> Unit = {},
)

/**
 * The Mail card, and the open letter over it. [modifier] is the FULL-card area (see [HubCard]).
 *
 * Pointer rule: the root is a plain Box holding the [HubCard] Column; only painted rows, chips and buttons take touches.
 * The letter's 55 % scrim is composed only while a letter is open (it is the modal's own scrim).
 */
@Composable fun MailSheet(ui: MailUi, on: MailActions, modifier: Modifier = Modifier) {
    val claimAll = ui.claimAll
    Box(modifier) {
        HubCard(Modifier.fillMaxSize(), readouts = ui.readouts,
            footer = if (claimAll != null && claimAllShown(claimAll) && ui.letters.isNotEmpty()) ({
                PrimaryButton("CLAIM ALL ${claimAll.count}", on.onClaimAll, Modifier.weight(1f), sub = claimAll.summary,
                    state = if (ui.claimAllBusy) CommandState.BUSY else CommandState.ENABLED)
            }) else null,
            header = { CompactHeader("MAIL", null, on.onClose, iconContent = { EnvelopeGlyph(Modifier.size(30.dp, 22.dp)) }) }) {
            MailBody(ui, on)
        }
        LetterModal(ui.open, on, Modifier.fillMaxSize())
    }
}

@Composable private fun ColumnScope.MailBody(ui: MailUi, on: MailActions) {
    FilterChipStrip(mailFilterChips(ui.counts) + ui.extraChips, ui.filter, on.onFilter, Modifier.padding(bottom = 8.dp))
    listOfNotNull(ui.statusLine, ui.batchUnavailable, ui.notice).forEach {
        PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(bottom = 4.dp), color = PkwTokens.Colors.textOnParch2, maxLines = 3)
    }
    ui.recovery?.let { MailRecoveryBlock(it, on, Modifier.padding(bottom = 6.dp)) }
    val view = boardView(ui.load, ui.letters.isNotEmpty())
    if (view == BoardView.ERROR_KEPT || view == BoardView.ERROR_EMPTY) (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport, Modifier.padding(bottom = 4.dp)) }
    when {
        view == BoardView.SKELETON -> Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) { repeat(5) { SkeletonRow(height = 64.dp) } }
        ui.letters.isEmpty() && view != BoardView.ERROR_EMPTY -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            val go = ui.empty.go
            Column(Modifier.padding(bottom = 80.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                HubEmptyState(ui.empty.headline, ui.empty.reason,
                    drawn = { EnvelopeGlyph(Modifier.size(96.dp, 68.dp), alpha = 0.4f) },
                    goLabel = ui.empty.goLabel, goIcon = "quest", onGo = if (go != null) ({ on.onEmptyGo(go) }) else null)
                // A filtered partial page is not an empty mailbox: the next page stays one tap away.
                if (ui.hasMore) StoneBusyButton("MORE LETTERS", ui.loadingMore, on.onLoadMore, Modifier.width(220.dp))
            }
        }
        else -> LazyColumn(Modifier.fillMaxWidth().weight(1f).graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(ui.letters, key = { it.id }) { letter -> LetterRow(letter) { on.onOpen(letter.id) } }
            if (ui.hasMore) item(key = "more") { StoneBusyButton("MORE LETTERS", ui.loadingMore, on.onLoadMore, Modifier.fillMaxWidth()) }
            ui.footnote?.let { note ->
                item(key = "footnote") {
                    PkwText(note, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp), color = PkwTokens.Colors.textOnParch2,
                        textAlign = TextAlign.Center, maxLines = 2)
                }
            }
        }
    }
}

/** The saved claim: its line, stone CHECK AGAIN (a read, always offered) and RETRY only when [MailRecoveryUi.retryAllowed]. */
@Composable private fun MailRecoveryBlock(ui: MailRecoveryUi, on: MailActions, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwText(ui.line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = 4)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StoneBusyButton("CHECK AGAIN", ui.busy, { on.onRecheck(ui.mailId) }, Modifier.weight(1f))
            if (ui.retryAllowed) SecondaryButton("RETRY", { on.onRetryClaim(ui.mailId) }, Modifier.width(112.dp),
                contentDescription = "Retry the saved claim")
        }
        ui.observation?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
        if (ui.closeAllowed) SecondaryButton(Copy.CLOSE_REQUEST.uppercase(), { on.onCloseClaim(ui.mailId) }, Modifier.fillMaxWidth(),
            contentDescription = "Close the saved claim")
    }
}

@Composable private fun LetterRow(letter: LetterRowUi, onOpen: () -> Unit) {
    val spoken = listOfNotNull(if (letter.unread) "Unread" else null, letter.subject, letter.senderLine,
        letter.reward?.let { "reward attached, " + priceDescription(it).replace("Costs ", "") }).joinToString(", ")
    CardRow(variant = if (letter.unread) RowVariant.UNREAD else RowVariant.PLAIN, height = 64.dp, onClick = onOpen, description = spoken) {
        Box {
            Well(letter.senderIcon, iconSize = if (letter.senderIcon.startsWith("league")) 40.dp else 32.dp)
            if (letter.unread) Box(Modifier.align(Alignment.TopEnd).padding(3.dp).size(12.dp).background(PkwTokens.Colors.red.face))
        }
        RowText(letter.subject, letter.senderLine)
        letter.reward?.let { PriceChip(it) }
        RowChevron()
    }
}

/**
 * A hub EmptyState (SPEC §3.5): centred at about 40 % height, the authored 64 dp [icon] at 40 % (or a [drawn] shape),
 * a VT 24 headline, a VT 18 reason, and at most one blue button 220 × 52 to the place that produces the content.
 * (The kit EmptyState draws its own parchment plate and a full-width button; inside a card body the SPEC wants neither.)
 */
@Composable internal fun HubEmptyState(headline: String, reason: String, modifier: Modifier = Modifier, icon: String? = null,
    drawn: (@Composable () -> Unit)? = null, goLabel: String? = null, goIcon: String? = null, onGo: (() -> Unit)? = null) {
    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when {
            drawn != null -> drawn()
            icon != null -> HubArt(icon, 64.dp, alpha = 0.4f)
        }
        PkwText(headline, PkwTokens.Type.lead, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
        PkwText(reason, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
        if (goLabel != null && onGo != null) SecondaryButton(goLabel, onGo, Modifier.width(220.dp), verb = Verb.BLUE, icon = goIcon)
    }
}

// ---- Previews (mail.png, mail-empty.png, mail-open.png numbers) ----

internal val sampleLetters = listOf(
    LetterRowUi("l1", "league-gold", "Weekly league reward", "League office · 2h ago", true, PriceUi(Currency.SHARDS, "12K", PriceStatus.OK)),
    LetterRowUi("l2", "itm_crest", "Founding Kingdoms: day 5", "Event · 9h ago", true, PriceUi(Currency.GEMS, "50", PriceStatus.OK)),
    LetterRowUi("l3", "shield", "Your walls held!", "Defence · yesterday", false, null),
    LetterRowUi("l4", "itm_banner", "Mira invited you", "Iron Wardens · 2d ago", false, null),
    LetterRowUi("l5", "keep", "Claims open Wed 14 Oct", "Gold Forge news · 3d ago", false, null),
    LetterRowUi("l6", "ui:seeker-navigation", "Auctions are coming", "Seeker Island · 5d ago", false, null),
    LetterRowUi("l7", "attack", "Raided by DuneLord", "Defence · 6d ago · REVENGE inside", false, null),
    LetterRowUi("l8", "ui_portrait_keep_t1", "Welcome, Keeper", "Pixel Kingdom Wars · 9d ago", false, null),
)

internal val sampleMail = MailUi(filter = MAIL_ALL, counts = mapOf(MAIL_ALL to 8, MAIL_REWARDS to 2), letters = sampleLetters,
    claimAll = ClaimAllUi(2, "12,000 Shards · 50 Gems"), hasMore = false, load = LoadState.Ready, readouts = sampleReadouts)

internal val sampleLetter = LetterUi("l1", "league-gold", "WEEKLY REWARD", "League office · 2h ago",
    "Well fought, Keeper. You finished week 41 in the Gold league with 1,284 trophies and 5 rated wins.",
    listOf(ItemTileUi("shards", "shards", "12,000", "12,000 Shards"), ItemTileUi("crownsteel", "ui:crystal-fragments", "x2", "Crownsteel, 2"),
        ItemTileUi("gems", "gem-32", "50", "50 Gems")),
    destination = "Ironhold", needsBase = true, expiresIn = "6 days", state = LetterState.CLAIMABLE)

@Preview(name = "Mail (mail.png)", widthDp = 412, heightDp = 915)
@Composable private fun MailPreview() { HubPreviewStage { MailSheet(sampleMail, MailActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Mail: empty (mail-empty.png)", widthDp = 412, heightDp = 915)
@Composable private fun MailEmptyPreview() {
    HubPreviewStage { MailSheet(sampleMail.copy(counts = mapOf(MAIL_ALL to 0), letters = emptyList(), claimAll = null), MailActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Mail: letter open (mail-open.png)", widthDp = 412, heightDp = 915)
@Composable private fun MailOpenPreview() { HubPreviewStage { MailSheet(sampleMail.copy(open = sampleLetter), MailActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Mail: loading", widthDp = 412, heightDp = 915)
@Composable private fun MailLoadingPreview() {
    HubPreviewStage { MailSheet(sampleMail.copy(counts = emptyMap(), letters = emptyList(), claimAll = null, load = LoadState.Loading), MailActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Mail: error with kept letters, more to load", widthDp = 412, heightDp = 915)
@Composable private fun MailErrorPreview() {
    HubPreviewStage {
        MailSheet(sampleMail.copy(hasMore = true, load = LoadState.Error("Can't reach the post office.", asOf = "14:02")), MailActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Mail: saved claim, no batch claim", widthDp = 412, heightDp = 915)
@Composable private fun MailRecoveryPreview() {
    HubPreviewStage {
        MailSheet(sampleMail.copy(claimAll = null, statusLine = "2 unread · 2 pending rewards", batchUnavailable = "Open each reward letter to claim.",
            recovery = MailRecoveryUi("l1", "A claim to base Ironhold was interrupted before its result arrived. CHECK AGAIN asks the server; " +
                "RETRY sends the same claim again.", retryAllowed = true),
            extraChips = listOf(FilterChipUi("ARCHIVE", "ARCHIVE"))), MailActions(), Modifier.fillMaxSize())
    }
}
