package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ClanActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ClanSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowChevron
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleSwitch
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait

/**
 * Design component: Clan › CHARTER (design/final/account/clan-charter.png, SPEC §5.2): the clan's registered record, held
 * by the captain's wallet (native `CharterScreen.kt`). A gold-rimmed charter card, four facts (CAPTAIN · JOINING ·
 * FOUNDED · ROSTER), CAPTAIN TOOLS (HAND OVER "Both wallets approve", INVITE ONLY), the rule that rewards owed to members
 * are paid before leadership changes hands, and the "Charter history" row. A member sees the tools locked ("captain"); the
 * captain sees them live (HAND OVER → the offer half sheet → Seal; INVITE ONLY → toggle → Seal). Every pending request
 * keeps its recovery row at the top (money moved is money honoured). Paused: the tools lock with the reason while the
 * history stays.
 *
 * It is the CHARTER body for the hub's `ClanSheet(charter = { ClanCharterBody(...) })`; it does not scroll itself.
 *
 * Unobserved ([ClanCharterUi.observationKnown] false: the existing Charter owner has not supplied registration or its
 * journal here): the facts the clan read proves are drawn, FOUNDED stays "…", both tools wear the padlock + "captain"
 * and a tap says where they live ([ClanCharterUi.pausedReason]); "Charter history" opens that owner.
 */

/** A saved charter request that still needs the player (a sale awaiting the second wallet, a recovery). */
@Immutable data class CharterRequestUi(
    val id: String,
    /** "Hand over to Seraphine". */
    val title: String,
    /** "Waiting for her wallet · 0.4 SOL". */
    val sub: String,
)

/** Everything the CHARTER tab draws (SPEC §5.2 `CharterUiState`). */
@Immutable data class ClanCharterUi(
    val registered: Boolean,
    /** "IRON WARDENS". */
    val clanName: String,
    /** The clan banner art ("itm_banner"). */
    val bannerIcon: String,
    /** "Mira" or "…". */
    val captainName: String,
    val captainTier: Int?,
    /** "Open to all" / "By invite". */
    val joining: String,
    /** "12 Sep" or "…". */
    val founded: String,
    /** "18 of 30" or "…". */
    val roster: String,
    val amCaptain: Boolean,
    /** INVITE ONLY is on (the captain's toggle state). */
    val inviteOnly: Boolean,
    /** Requests that still need the player; drawn first. */
    val pending: List<CharterRequestUi> = emptyList(),
    /** Server pause ("Charter changes are paused"); null = live. */
    val pausedReason: String? = null,
    /** False when the existing Charter owner has not supplied registration or journal evidence. */
    val observationKnown: Boolean = true,
)

/** CHARTER callbacks (SPEC §5.2). */
@Immutable data class ClanCharterActions(
    /** HAND OVER (captain): the offer half sheet (buyer, SOL price, "leave after this sale") → Seal. */
    val onHandOver: () -> Unit = {},
    /** INVITE ONLY (captain): the new value, confirmed by a Seal. */
    val onInviteOnly: (Boolean) -> Unit = {},
    val onHistory: () -> Unit = {},
    /** Not registered, captain: REGISTER → Seal. */
    val onRegister: () -> Unit = {},
    /** A pending request's recovery row. */
    val onPending: (String) -> Unit = {},
    /** A locked tool was tapped: toast this reason. */
    val onExplain: (String) -> Unit = {},
)

/** The CHARTER body (non-scrolling; the host's slot scrolls it). Pointer rule: only its rows and buttons take touches. */
@Composable fun ClanCharterBody(ui: ClanCharterUi, on: ClanCharterActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ui.pending.forEach { request ->
            CardRow(variant = RowVariant.READY, height = 64.dp, onClick = { on.onPending(request.id) }, description = "${request.title}. ${request.sub}") {
                Well("replay", size = 48.dp, light = true, iconSize = 36.dp)
                RowText(request.title, request.sub)
                RowChevron()
            }
        }
        if (!ui.observationKnown) {
            RegisteredCharter(ui, on)
        } else if (!ui.registered) {
            AccountCard(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, contentPadding = 12.dp) {
                Well(ui.bannerIcon, size = 72.dp, light = true, iconSize = 64.dp)
                PkwText("Register your clan", PkwTokens.Type.title, color = c.textOnParch)
                PkwText("A registered clan has a charter held by the captain's wallet.", PkwTokens.Type.small, color = c.textOnParch2,
                    textAlign = TextAlign.Center, maxLines = 2)
                if (ui.amCaptain && ui.pausedReason == null) PrimaryButton("REGISTER", on.onRegister, Modifier.fillMaxWidth().padding(top = 4.dp))
                else PkwText(ui.pausedReason ?: "Your captain registers the clan.", PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center)
            }
        } else RegisteredCharter(ui, on)
    }
}

/** How a captain tool row is locked: the word beside its padlock, and what a tap explains. */
@Immutable internal data class CharterToolLock(val note: String, val reason: String)

/**
 * The captain tools' lock (clan-charter.png): unobserved → padlock + "captain", a tap explains where the tools live
 * ([ClanCharterUi.pausedReason]); observed → the pause reason, or "captain" for a member; null = the captain's live tools.
 */
internal fun charterToolLock(ui: ClanCharterUi): CharterToolLock? {
    if (!ui.observationKnown) return CharterToolLock("captain", ui.pausedReason ?: lockReason("captain", ui.captainName))
    val lock = charterToolsLock(ui.amCaptain, ui.pausedReason) ?: return null
    return CharterToolLock(lock, lockReason(lock, ui.captainName))
}

/** The registered charter: card, facts, captain tools, the payout rule and the history row. */
@Composable private fun RegisteredCharter(ui: ClanCharterUi, on: ClanCharterActions) {
    val c = PkwTokens.Colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AccountCard(Modifier.fillMaxWidth(), rim = c.gold.face, face = c.selectedTint) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // clan-charter.png: the banner at 64 in a light 76 well.
                Well(ui.bannerIcon, size = 76.dp, light = true, iconSize = 64.dp)
                Column(Modifier.weight(1f)) {
                    PkwText("${ui.clanName.uppercase()} CHARTER", PkwTokens.Type.label, color = c.textOnParch, maxLines = 2)
                    PkwText(if (ui.observationKnown) "A registered clan. The charter is held by the captain's wallet."
                        else "Registration and saved changes are read in Clan Charters & Invitations.", PkwTokens.Type.body, color = c.textOnParch, maxLines = 3)
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FactCard("CAPTAIN", Modifier.weight(1f), description = "Captain ${ui.captainName}") {
                HubArt(ui.captainTier?.let(::keepPortrait) ?: "building-keep", 24.dp)
                PkwText(ui.captainName, PkwTokens.Type.body, color = c.textOnParch)
            }
            FactCard("JOINING", Modifier.weight(1f), description = "Joining: ${ui.joining}") { PkwText(ui.joining, PkwTokens.Type.body, color = c.textOnParch) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FactCard("FOUNDED", Modifier.weight(1f), description = "Founded ${ui.founded}") { PkwText(ui.founded, PkwTokens.Type.body, color = c.textOnParch) }
            FactCard("ROSTER", Modifier.weight(1f), description = "Roster ${ui.roster}") { PkwText(ui.roster, PkwTokens.Type.body, color = c.textOnParch) }
        }
        val lock = charterToolLock(ui)
        SectionHeader("CAPTAIN TOOLS", note = when {
            !ui.observationKnown && ui.amCaptain -> "in Kingdoms & Activities"
            ui.observationKnown && ui.pausedReason != null -> "paused"
            ui.amCaptain -> "yours to use"
            else -> "only ${ui.captainName} can use these"
        })
        CardRow(height = 64.dp, onClick = if (lock != null) ({ on.onExplain(lock.reason) }) else null,
            description = if (lock != null) "Hand over, locked. ${lock.reason}" else null) {
            Well("itm_banner", size = 48.dp, light = true, iconSize = 32.dp)
            RowText("HAND OVER", "Both wallets approve", titleColor = if (lock != null) c.textOnParch2 else c.textOnParch)
            if (lock != null) LockNote(lock.note)
            else SecondaryButton("OFFER", on.onHandOver, Modifier.width(96.dp), contentDescription = "Hand over the charter")
        }
        InviteOnlyRow(ui, lock, on)
        NoteLine("Rewards the clan owes its members are paid out before leadership changes hands.")
        CardRow(height = 64.dp, onClick = on.onHistory, description = if (ui.observationKnown) "Charter history. Every change and approval"
            else "Charter history. Open Kingdoms and Activities, then choose Clan Charters and Invitations") {
            Well("replay", size = 48.dp, light = true, iconSize = 36.dp)
            RowText("Charter history", if (ui.observationKnown) "Every change and approval" else "In Kingdoms & Activities")
            RowChevron()
        }
    }
}

/** The toast for a locked tool: the pause reason, or who holds the tools. */
private fun lockReason(lock: String, captain: String): String = if (lock == "captain") "Only the captain, $captain, can use this." else lock

/** INVITE ONLY: locked like HAND OVER, or the captain's toggle (the whole row toggles; a Seal confirms). */
@Composable private fun InviteOnlyRow(ui: ClanCharterUi, lock: CharterToolLock?, on: ClanCharterActions) {
    if (lock != null) {
        CardRow(height = 64.dp, onClick = { on.onExplain(lock.reason) }, description = "Invite only, locked. ${lock.reason}") {
            Well("referral", size = 48.dp, light = true, iconSize = 32.dp)
            RowText("INVITE ONLY", "Members join by invite", titleColor = PkwTokens.Colors.textOnParch2)
            LockNote(lock.note)
        }
        return
    }
    val spoken = "Invite only. ${if (ui.inviteOnly) "on" else "off"}. Members join by invite"
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp)
        .clearAndSetSemantics {
            contentDescription = spoken; role = Role.Switch; toggleableState = ToggleableState(ui.inviteOnly)
            this.onClick(label = null, action = { on.onInviteOnly(!ui.inviteOnly); true })
        }
        .clickable(role = Role.Switch) { on.onInviteOnly(!ui.inviteOnly) }) {
        CardRow(height = 64.dp) {
            Well("referral", size = 48.dp, light = true, iconSize = 32.dp)
            RowText("INVITE ONLY", "Members join by invite")
            ToggleSwitch(ui.inviteOnly, true)
        }
    }
}

// ---- Previews (clan-charter.png and the SPEC's states) ----

@Preview(name = "Clan CHARTER (clan-charter.png)", widthDp = 412, heightDp = 915)
@Composable private fun ClanCharterPreview() {
    HubPreviewStage {
        ClanSheet(sampleClanShell.copy(selectedTab = "CHARTER"), ClanActions(), Modifier.fillMaxSize(),
            charter = { ClanCharterBody(sampleCharter, ClanCharterActions()) })
    }
}

@Preview(name = "Clan CHARTER: captain view with a pending sale", widthDp = 412, heightDp = 915)
@Composable private fun ClanCharterCaptainPreview() {
    HubPreviewStage {
        ClanSheet(sampleClanShell.copy(selectedTab = "CHARTER"), ClanActions(), Modifier.fillMaxSize(),
            charter = { ClanCharterBody(sampleCharter.copy(amCaptain = true, captainName = "Rowan",
                pending = listOf(CharterRequestUi("r1", "Hand over to Seraphine", "Waiting for her wallet · 0.4 SOL"))), ClanCharterActions()) })
    }
}

@Preview(name = "Clan CHARTER body: paused / not registered", widthDp = 412, heightDp = 700)
@Composable private fun ClanCharterStatesPreview() {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.parchment).padding(8.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ClanCharterBody(sampleCharter.copy(registered = false, amCaptain = true), ClanCharterActions())
        ClanCharterBody(sampleCharter.copy(registered = false), ClanCharterActions())
        ClanCharterBody(sampleCharter.copy(amCaptain = true, pausedReason = "Charter changes are paused"), ClanCharterActions())
    }
}
