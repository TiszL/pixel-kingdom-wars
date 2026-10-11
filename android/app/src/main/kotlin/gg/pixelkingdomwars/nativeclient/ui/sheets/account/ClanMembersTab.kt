package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipStrip
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait

/**
 * Design component: Clan › MEMBERS (design/final/account/clan-members.png, SPEC §5.1): sort chips TROPHIES · WINS ·
 * ONLINE n, MemberRows (tiered Keep portrait with the green online dot, name + role tag LEADER / ELDER / YOU / NEW,
 * "Keep 14 · online now", league crest + trophies; you = gold rim), a tapped row expanding an action strip (blue VISIT,
 * PROMOTE locked for a member, KICK for the leader) and the note "Only the leader and elders can promote or remove."
 *
 * It is the MEMBERS body for the hub's `ClanSheet` (which keeps the clan header, the tabs and the LEAVE + CLAN CHAT
 * foot). The body does not scroll itself: the sheet's slot wraps it in its scrolling column.
 *
 * Only what the Ui provides is drawn: the sort chips are [ClanMembersUi.sorts]; with [ClanMembersUi.onlineKnown] false
 * there is no online dot, no ONLINE count and no "online now" / "seen" text, so a row reads "Keep 14".
 */

/** One clan member (SPEC §5.1 `Member`). */
@Immutable data class ClanMemberUi(
    val id: String,
    val name: String,
    val role: ClanRole,
    val isYou: Boolean,
    /** The green NEW tag (joined this week). */
    val isNew: Boolean = false,
    /** "14" or "…". */
    val keepLevel: String,
    /** Keep tier 1..4 for the portrait (by Keep level). */
    val keepTier: Int?,
    /** "online now", "seen 2h ago", "…". */
    val lastSeen: String,
    val online: Boolean,
    /** For sorting; null = unknown (sorts last). */
    val trophies: Long?,
    /** Formatted ("2,140") or "…". */
    val trophiesText: String,
    /** This week's wins (WINS sort); null = unknown. */
    val wins: Int?,
    /** The member's league crest art ("league-gold"). */
    val leagueCrest: String,
)

/** Everything the MEMBERS tab draws (SPEC §5.1 `ClanMembersUiState`). */
@Immutable data class ClanMembersUi(
    val sort: MemberSort,
    val members: List<ClanMemberUi>,
    val myRole: ClanRole,
    /** The row whose action strip is open; null = none. */
    val expandedId: String?,
    val sorts: List<MemberSort> = MemberSort.entries,
    val onlineKnown: Boolean = true,
    val visitUnavailable: String? = null,
    val promoteUnavailable: String? = null,
)

/** MEMBERS callbacks (SPEC §5.1). */
@Immutable data class ClanMembersActions(
    val onSort: (MemberSort) -> Unit = {},
    /** Open this row's strip (null closes it). */
    val onExpand: (String?) -> Unit = {},
    /** VISIT: watch their base (no attack). */
    val onVisit: (String) -> Unit = {},
    val onPromote: (String) -> Unit = {},
    /** KICK: raise the ConfirmDialog (`ClanUi.confirm`). */
    val onKick: (String) -> Unit = {},
    /** A locked control was tapped: toast this reason. */
    val onExplain: (String) -> Unit = {},
)

/** The reason a member sees on the locked PROMOTE. */
private const val PROMOTE_REASON = "Only the leader and elders can promote or remove."

/** The sort chips: only the sorts the Ui provides, and the ONLINE count only when online status is known. */
internal fun clanMemberChips(ui: ClanMembersUi): List<FilterChipUi> {
    val online = ui.members.count { it.online }
    return ui.sorts.map { sort -> FilterChipUi(sort.name, sort.name, count = if (sort == MemberSort.ONLINE && ui.onlineKnown) "$online" else null) }
}

/** A row's VT 18 line: "Keep 14 · online now", or just "Keep 14" while online status is unknown (never "…"). */
internal fun clanMemberLine(member: ClanMemberUi, onlineKnown: Boolean): String =
    if (onlineKnown) "Keep ${member.keepLevel} · ${member.lastSeen}" else "Keep ${member.keepLevel}"

/**
 * The MEMBERS body (non-scrolling; the host's slot scrolls it). Pointer rule: each row is one target (it holds no other
 * control); the strip's buttons are their own targets. Nothing is full-screen.
 */
@Composable fun ClanMembersBody(ui: ClanMembersUi, on: ClanMembersActions, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FilterChipStrip(clanMemberChips(ui), ui.sort.name, { id -> MemberSort.entries.firstOrNull { it.name == id }?.let(on.onSort) })
        sortMembers(ui.members, ui.sort).forEach { member ->
            val expanded = member.id == ui.expandedId && !member.isYou
            MemberRow(member, expanded, ui.onlineKnown) { on.onExpand(if (expanded) null else member.id) }
            AnimatedVisibility(expanded,
                enter = if (reduced) fadeIn(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
                    else expandVertically(tween(PkwTokens.Motion.SELECT, easing = PkwTokens.Motion.Out)) + fadeIn(tween(PkwTokens.Motion.SELECT)),
                exit = if (reduced) fadeOut(tween(PkwTokens.Motion.REDUCED_CROSSFADE))
                    else shrinkVertically(tween(MEMBER_STRIP_OUT_MS)) + fadeOut(tween(MEMBER_STRIP_OUT_MS))) {
                MemberStrip(member, memberPowers(ui.myRole, member), on, ui.visitUnavailable, ui.promoteUnavailable)
            }
        }
        NoteLine(ui.promoteUnavailable ?: PROMOTE_REASON)
        if (!ui.onlineKnown) NoteLine("Online status and weekly wins are unavailable.")
    }
}

/** The strip's collapse (SPEC §7: 120 ms). */
private const val MEMBER_STRIP_OUT_MS = 120

@Composable private fun MemberRow(member: ClanMemberUi, expanded: Boolean, onlineKnown: Boolean, onTap: () -> Unit) {
    val c = PkwTokens.Colors
    val roleWord = when { member.isYou -> "you"; member.role == ClanRole.LEADER -> "leader"; member.role == ClanRole.ELDER -> "elder"; else -> null }
    val spoken = listOfNotNull(member.name, roleWord, if (member.isNew) "new" else null, clanMemberLine(member, onlineKnown),
        "${member.trophiesText} trophies", if (!member.isYou) (if (expanded) "actions open" else "tap for actions") else null).joinToString(", ")
    CardRow(variant = when { member.isYou -> RowVariant.YOU; expanded -> RowVariant.READY; else -> RowVariant.PLAIN }, height = 60.dp,
        onClick = if (member.isYou) null else onTap, description = spoken) {
        Box {
            // clan-members.png: the tiered Keep portrait at 28 in the dark 48 well.
            Well(member.keepTier?.let(::keepPortrait) ?: "building-keep", size = 48.dp, iconSize = 28.dp)
            if (onlineKnown && member.online) OnlineDot(Modifier.align(Alignment.BottomEnd).offset(x = 3.dp, y = 3.dp))
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(member.name, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.textOnParch)
                when {
                    member.isYou -> StatusTag("YOU", Verb.GOLD)
                    member.role == ClanRole.LEADER -> StatusTag("LEADER", Verb.GOLD)
                    member.role == ClanRole.ELDER -> StatusTag("ELDER", Verb.BLUE)
                    member.isNew -> StatusTag("NEW", Verb.GREEN)
                }
            }
            PkwText(clanMemberLine(member, onlineKnown), PkwTokens.Type.small, color = c.textOnParch2)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            HubArt(member.leagueCrest, 20.dp)
            PkwText(member.trophiesText, PkwTokens.Type.label, color = c.textOnParch)
        }
    }
}

/**
 * The action strip under an open row (clan-members.png: 58 dp in, 48 tall): blue VISIT 96, PROMOTE (green, or charcoal +
 * padlock), KICK for the leader. A closed door still answers: VISIT / PROMOTE explain their reasons.
 */
@Composable private fun MemberStrip(member: ClanMemberUi, powers: MemberPowers, on: ClanMembersActions, visitUnavailable: String?, promoteUnavailable: String?) {
    Row(Modifier.fillMaxWidth().padding(start = 58.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        SecondaryButton("VISIT", { if (visitUnavailable != null) on.onExplain(visitUnavailable) else on.onVisit(member.id) },
            Modifier.width(96.dp).height(MEMBER_STRIP_H), verb = Verb.BLUE, contentDescription = "Visit ${member.name}'s base")
        if (powers.canPromote && promoteUnavailable == null) SecondaryButton("PROMOTE", { on.onPromote(member.id) }, Modifier.weight(1f).height(MEMBER_STRIP_H),
            verb = Verb.GREEN, contentDescription = "Promote ${member.name}")
        else ChunkyBox(PkwTokens.Colors.charcoalRamp, { on.onExplain(promoteUnavailable ?: PROMOTE_REASON) }, "Promote, locked. ${promoteUnavailable ?: PROMOTE_REASON}",
            Modifier.weight(1f).height(MEMBER_STRIP_H)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwIcon("shape:lock", 20.dp, tint = PkwTokens.Colors.gold.face)
                PkwText("PROMOTE", PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
            }
        }
        if (powers.canKick) SecondaryButton("KICK", { on.onKick(member.id) }, Modifier.width(84.dp).height(MEMBER_STRIP_H), verb = Verb.RED,
            contentDescription = "Kick ${member.name}")
    }
}

/** The strip's buttons: 48 dp (the design's VISIT 96 × 48), the minimum touch target. */
private val MEMBER_STRIP_H = 48.dp

// ---- Previews (clan-members.png) ----

@Preview(name = "Clan MEMBERS body (clan-members.png): member view, Seraphine open", widthDp = 412, heightDp = 760)
@Composable private fun ClanMembersBodyPreview() {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.parchment).padding(8.dp).verticalScroll(rememberScrollState())) {
        ClanMembersBody(sampleMembers, ClanMembersActions())
    }
}

@Preview(name = "Clan MEMBERS body: leader view, sorted by ONLINE", widthDp = 412, heightDp = 760)
@Composable private fun ClanMembersLeaderPreview() {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.parchment).padding(8.dp).verticalScroll(rememberScrollState())) {
        ClanMembersBody(sampleMembers.copy(myRole = ClanRole.LEADER, sort = MemberSort.ONLINE, expandedId = "m4"), ClanMembersActions())
    }
}

@Preview(name = "Clan MEMBERS body: unknown trophies", widthDp = 412, heightDp = 400)
@Composable private fun ClanMembersUnknownPreview() {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.parchment).padding(8.dp)) {
        ClanMembersBody(sampleMembers.copy(members = sampleMembers.members.take(2).map { it.copy(trophies = null, trophiesText = UNKNOWN, lastSeen = UNKNOWN) },
            expandedId = null), ClanMembersActions())
    }
}
