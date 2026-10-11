package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HeaderStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LivingHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Design component: the Profile FullCard with the account cluster's four tabs PROFILE · KINGDOMS · WALLET · ACCOUNT
 * (design/final/account/profile-kingdoms.png, profile-wallet.png, profile-account.png; SPEC §4, rule 0.4). The shared
 * 138 dp header: the player's own base crop, ink fade, the gold-framed tiered Keep portrait with the blue level badge, PS 13
 * kingdom name in gold, VT 20 player name + the lime SEEKER tag, stone gear (Settings) and red close. Tabs are
 * [StackedTabs]. Destination: `Profile(tab)` (FULL card).
 *
 * The PROFILE tab's body is the hub's (hub/hub.png); it is handed in as [profileTab] because that body is private to
 * `sheets/hub/ProfileHubSheet.kt` (see MOUNT-ACCOUNT.md).
 */

/** The shared Profile header (SPEC §4). */
@Immutable data class ProfileHeaderUi(
    /** PS 13 gold ("IRONHOLD") or "…". */
    val kingdomName: String,
    /** VT 20 ("Rowan") or "…". */
    val playerName: String,
    /** The level badge ("12" or "…"). */
    val keepLevel: String,
    /** Keep tier 1..4 for the portrait art. */
    val keepTier: Int,
    /** The lime "SEEKER #142" tag; null when not Seeker-admitted. */
    val seekerMember: String?,
    /** A live crop of the player's own Keep area at a whole-number zoom; null draws the charcoal fallback. */
    val snapshot: ImageBitmap?,
)

/** Everything the Profile card draws. */
@Immutable data class ProfileCardUi(
    val header: ProfileHeaderUi,
    /** "PROFILE", "KINGDOMS", "WALLET" or "ACCOUNT". */
    val selectedTab: String,
    val kingdoms: KingdomsUi,
    val wallet: WalletUi,
    val account: AccountUi,
    /** The four tabs (build with [profileCardTabs] to set badges). */
    val tabs: List<TabUi> = profileCardTabs(header.keepTier),
    val notice: String? = null,
    val refreshing: Boolean = false,
)

/**
 * PROFILE (Keep portrait 28) · KINGDOMS (map 24) · WALLET (Solana mark 24) · ACCOUNT (shield 24). [kingdomsBadge] is where
 * the land herald lives after its third session (SPEC §1.2) and the "a kingdom needs you" count.
 */
fun profileCardTabs(keepTier: Int, kingdomsBadge: BadgeUi? = null, walletBadge: BadgeUi? = null): List<TabUi> = listOf(
    TabUi(PROFILE_TAB, keepPortrait(keepTier), "PROFILE", null, false),
    TabUi(KINGDOMS_TAB, "map", "KINGDOMS", kingdomsBadge, false),
    TabUi(WALLET_TAB, "sol", "WALLET", walletBadge, false),
    TabUi(ACCOUNT_TAB, "shield", "ACCOUNT", null, false),
)

const val PROFILE_TAB = "PROFILE"
const val KINGDOMS_TAB = "KINGDOMS"
const val WALLET_TAB = "WALLET"
const val ACCOUNT_TAB = "ACCOUNT"

/** The Profile card's callbacks: the frame's own plus each tab's. */
@Immutable data class ProfileCardActions(
    val onTab: (String) -> Unit = {},
    /** The stone gear: push Settings(GAME). */
    val onSettings: () -> Unit = {},
    val onClose: () -> Unit = {},
    val kingdoms: KingdomsActions = KingdomsActions(),
    val wallet: WalletActions = WalletActions(),
    val account: AccountActions = AccountActions(),
    val onRefresh: () -> Unit = {},
)

/**
 * The Profile card. [modifier] is the FULL-card area (x 8..404, y 14 dp under the status inset to 14 dp above the gesture
 * inset; the frame starts 46 dp lower, see the hub's `HubCard`). Tab changes cross-fade the body for 120 ms.
 *
 * Pointer rule: the root is the hub's plain `HubCard` Column; only the painted wood frame, tabs, rows and buttons take
 * touches. The 60 % FULL-card scrim belongs to the SheetHost, composed only while the card is shown.
 */
@Composable fun ProfileCard(ui: ProfileCardUi, on: ProfileCardActions, modifier: Modifier = Modifier,
    profileTab: (@Composable ColumnScope.() -> Unit)? = null,
    accountExtras: (@Composable ColumnScope.() -> Unit)? = null) {
    HubCard(modifier, selectedTab = ui.selectedTab,
        footer = if (ui.selectedTab == ACCOUNT_TAB) ({ AccountFooter(ui.account, on.account, Modifier.weight(1f)) }) else null,
        header = {
            ProfileHeader(ui.header, on)
            Spacer(Modifier.height(10.dp))
            StackedTabs(ui.tabs, ui.selectedTab, on.onTab, Modifier.padding(horizontal = 2.dp))
        }) {
        if (ui.notice != null) {
            gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow(height = 72.dp) {
                RowText(ui.notice, null)
                gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton("REFRESH", on.onRefresh,
                    enabled = !ui.refreshing, contentDescription = "Refresh Profile")
            }
        }
        when (ui.selectedTab) {
            KINGDOMS_TAB -> ProfileKingdomsBody(ui.kingdoms, on.kingdoms)
            WALLET_TAB -> ProfileWalletBody(ui.wallet, on.wallet)
            ACCOUNT_TAB -> ProfileAccountBody(ui.account, on.account, accountExtras)
            else -> if (profileTab != null) profileTab(this) else Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                NoteLine("Your kingdom's news opens here.")
            }
        }
    }
}

/**
 * The 138 dp header (SPEC §4, profile-*.html `.lhead`): the player's base, a 70 dp ink fade (transparent to ink 86 % at
 * 60 %), the 84 dp gold well at 12 / 36 with the 40 dp LevelBadge at 72 / 22, names at x 106 (PS 13, 6 dp, VT 20 + tag),
 * gear and close.
 */
@Composable private fun ProfileHeader(ui: ProfileHeaderUi, on: ProfileCardActions) {
    LivingHeader(on.onClose, stage = HeaderStage.NONE, height = PROFILE_HEADER_H, onGear = on.onSettings) {
        val snapshot = ui.snapshot
        // No live Keep render yet: the approved realm painting's Keep band, never the old flat charcoal (RealmHeaderArt.kt).
        if (snapshot != null) CoverImage(snapshot, Modifier.fillMaxSize())
        else RealmHeaderArt(Modifier.fillMaxSize())
        val fade = PkwTokens.Colors.ink.copy(alpha = 0.86f)
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(70.dp)
            .background(Brush.verticalGradient(0f to Color.Transparent, 0.6f to fade, 1f to fade)))
        Row(Modifier.align(Alignment.BottomStart).padding(start = 12.dp, bottom = 15.dp), verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.padding(bottom = 3.dp)) {
                GoldWell(size = 84.dp) { HubArt(keepPortrait(ui.keepTier), 56.dp) }
                LevelBadge(ui.keepLevel, Modifier.align(Alignment.TopEnd).offset(x = 16.dp, y = (-14).dp))
            }
            Column(Modifier.clearAndSetSemantics {
                contentDescription = listOfNotNull(ui.kingdomName, ui.playerName, "Keep level ${ui.keepLevel}", ui.seekerMember).joinToString(", ")
            }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(ui.kingdomName, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(ui.playerName, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp)
                    ui.seekerMember?.let { StatusTag(it, Verb.GOLD, lime = true) }
                }
            }
        }
    }
}

/** The account header's height (SPEC §4: 138). */
internal val PROFILE_HEADER_H = 138.dp

/**
 * The text column of a Profile tab row (account.css `.kname` + `.ksub`): the PS 12 name ("SEED VAULT", "2-STEP CODE",
 * "ADD A KINGDOM") over a VT 18 sub-line [gap] below. Sentence rows ("A deed sent to you", "2 need you · 41 done") keep the
 * hub's VT 20 [RowText] (`.kline`).
 */
@Composable internal fun RowScope.NameRowText(title: String, sub: String?, modifier: Modifier = Modifier, gap: Dp = 4.dp) {
    Column(modifier.weight(1f)) {
        PkwText(title, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
        if (sub != null) PkwText(sub, PkwTokens.Type.small, Modifier.padding(top = gap), color = PkwTokens.Colors.textOnParch2)
    }
}

/** The 40 dp blue LevelBadge that overlaps the portrait's top-right (DESIGN-SYSTEM §6 LevelBadge). Paint only. */
@Composable internal fun LevelBadge(level: String, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Box(modifier.size(PkwTokens.Dims.levelBadge).drawBehind {
        val w = size.width; val h = size.height; val i = 2.dp.toPx()
        fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
        insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
            drawRect(c.blue.face)
            band(i, w - i, i, 3.dp.toPx(), c.blue.hi)
            band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), c.blue.lo)
        }
    }, contentAlignment = Alignment.Center) { PkwText(level, PkwTokens.Type.label, color = c.label, outline = 1.dp) }
}

/** A bitmap covering its box at a whole-number scale, nearest sampled (the header crops). Decorative. */
@Composable internal fun CoverImage(bitmap: ImageBitmap, modifier: Modifier = Modifier) {
    Canvas(modifier.clearAndSetSemantics { }) {
        val k = maxOf(1, ceil(maxOf(size.width / bitmap.width, size.height / bitmap.height)).toInt())
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
            dstOffset = IntOffset(((size.width - w) / 2f).roundToInt(), ((size.height - h) / 2f).roundToInt()), dstSize = IntSize(w, h),
            filterQuality = FilterQuality.None)
    }
}

// ---- Previews (profile-kingdoms.png, profile-wallet.png, profile-account.png) ----

@Preview(name = "Profile: KINGDOMS (profile-kingdoms.png)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileKingdomsPreview() { HubPreviewStage { ProfileCard(sampleProfileCard, ProfileCardActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Profile: WALLET (profile-wallet.png)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileWalletPreview() {
    HubPreviewStage { ProfileCard(sampleProfileCard.copy(selectedTab = WALLET_TAB), ProfileCardActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Profile: ACCOUNT (profile-account.png)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileAccountPreview() {
    HubPreviewStage { ProfileCard(sampleProfileCard.copy(selectedTab = ACCOUNT_TAB), ProfileCardActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Profile: PROFILE slot (hub body handed in)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileSlotPreview() {
    HubPreviewStage { ProfileCard(sampleProfileCard.copy(selectedTab = PROFILE_TAB), ProfileCardActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Profile: header unknown (loading)", widthDp = 412, heightDp = 915)
@Composable private fun ProfileUnknownPreview() {
    HubPreviewStage {
        ProfileCard(sampleProfileCard.copy(header = sampleProfileCard.header.copy(kingdomName = "…", playerName = "…", keepLevel = "…", seekerMember = null)),
            ProfileCardActions(), Modifier.fillMaxSize())
    }
}
