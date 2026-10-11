package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.StackedTabs

/**
 * Design component: Clan (design/final/hub/clan.png, SPEC §2.5): your clan's weekly chest, top members, invite code,
 * LEAVE and CLAN CHAT, plus MEMBERS, the CHARTER / TOURNEY slots (existing bodies wrapped in the body kit), the no-clan
 * state and the leave / kick ConfirmDialog (confirm.png). Destination: `Clan(tab)` (FULL card). Home: the Clan Hall
 * building — every other door is `FocusBuilding("clanhall", then = Clan("CLAN"))`.
 *
 * Account SPEC §5 (clan-members.png, clan-charter.png, clan-tourney.png) settles the shared shell: the header crest is the
 * banner on light parchment, the tabs are `Tabs.Stacked` (icon over a PS 11 label, 56 dp, badge outside, a locked tab
 * keeps its padlock), and the foot is stone LEAVE 112 × 60 + the blue chat button, except on TOURNEY, whose foot is
 * RANKINGS + FIND MATCH when the host supplies it.
 */

/** A member's role tag. */
enum class MemberRole { LEADER, ELDER }

/** The chest card's "unavailable" sentence wraps on the card instead of being cut: the live sentence needs three lines on
 *  the 400 dp Seeker in portrait. At one line it read "Weekly chest totals and the reset time are…" (owner build 880a7e7a). */
internal const val CLAN_CHEST_NOTE_MAX_LINES = 3

/** The header's name column starts right of the 84 dp crest well (22 + 84 + 18) and ends clear of the 48 dp Close (8 + 48 + 8). */
internal const val CLAN_HEADER_TEXT_START_DP = 124
internal const val CLAN_HEADER_TEXT_END_DP = 64

/**
 * A clan name may take two lines in the header: the server allows 24 letters and one title line holds 20 in the 200 dp
 * name column of the 400 dp Seeker, so a long name was cut with "…". While the chest TimerChip holds the header's bottom
 * band the name keeps one line, so the tags row under it never reaches the chip.
 */
internal fun clanHeaderNameMaxLines(chestTimer: Boolean): Int = if (chestTimer) 1 else 2

/** One MemberRow (56). */
@Immutable data class MemberRowUi(
    val id: String,
    /** The member's Keep portrait (`ui_portrait_keep_t{tier}`), 28 dp in a dark Well 40. */
    val portrait: String,
    val name: String,
    /** LEADER (gold) / ELDER (blue); null draws none. */
    val role: MemberRole?,
    /** The player's own row: `you` variant + YOU tag. */
    val isYou: Boolean,
    /** "Keep 14". */
    val keepLine: String,
    /** This week's wins ("12", "…"). */
    val wins: String,
    /** The leader may kick this member (draws KICK on MEMBERS). */
    val canKick: Boolean = false,
)

/** The weekly chest card. */
@Immutable data class ClanChestUi(
    /** "42". */
    val wins: String,
    /** "60". */
    val goal: String,
    /** The player's share ("7"); null draws none. */
    val yours: String?,
    /** "18 more wins fill the chest for everyone". */
    val line: String,
    /** 0..1; null draws an empty track. */
    val progress: Float?,
)

/** A clan the player may join (no-clan state). */
@Immutable data class ClanRowUi(
    val id: String,
    val crest: String,
    val name: String,
    /** "[IRN] · 18/30 members · Keep 6+". */
    val sub: String,
    /** JOIN is waiting for the server. */
    val joinBusy: Boolean = false,
)

/** The CLAN tab when the player has no clan. */
@Immutable data class NoClanUi(
    /** "OPEN" (open clans) or "CODE" (join by code). */
    val filter: String,
    val filters: List<FilterChipUi> = listOf(FilterChipUi("OPEN", "OPEN CLANS"), FilterChipUi("CODE", "CODE")),
    val clans: List<ClanRowUi>,
    /** The CREATE CLAN cost pill; null when free or unpriced (never a fake "0"). */
    val createPrice: PriceUi?,
    val createState: CommandState = CommandState.ENABLED,
    val createReason: String? = null,
    /** The invite code being typed (CODE filter). */
    val codeDraft: String = "",
)

/** Everything the Clan card draws (SPEC §2.5 State; fields after `load` were added with defaults). */
@Immutable data class ClanUi(
    /** "IRON WARDENS"; null with no clan. */
    val name: String?,
    /** "[IRN]". */
    val tag: String?,
    /** Clan Hall tier 1..4 for `ui_portrait_clanhall_t{tier}`. */
    val hallTier: Int?,
    /** "18/30 members". */
    val members: String?,
    /** "OPEN" (green tag) or "INVITE ONLY" (stone tag); null draws none. */
    val inviteMode: String?,
    /** "12" for the stone "RANK 12" tag; null draws none. */
    val rank: String?,
    /** "4d 6h" for the "Chest in" chip; null hides it. */
    val chestEndsIn: String?,
    val chest: ClanChestUi?,
    /** TOP THIS WEEK. */
    val top: List<MemberRowUi>,
    /** "IRN-7Q2K"; null hides the invite row. */
    val inviteCode: String?,
    /** CLAN · MEMBERS · CHARTER · TOURNEY; a tab whose server feature is off is `locked` (the caller's onTab shows why). */
    val tabs: List<TabUi>,
    val selectedTab: String,
    /** Clan unread, for the CLAN CHAT red badge. */
    val chatUnread: Int,
    /** Non-null: the player is in no clan (CLAN tab shows the join / create state). */
    val noClan: NoClanUi?,
    /** True: clans need land; the CLAN tab shows "Clans need land" + GO. */
    val requiresLand: Boolean,
    val load: LoadState,
    /** MEMBERS tab rows (defaults to TOP THIS WEEK). */
    val allMembers: List<MemberRowUi> = top,
    /** The player leads the clan (KICK on MEMBERS). */
    val isLeader: Boolean = false,
    /** The leave / kick confirm being shown; null when none. */
    val confirm: ConfirmUi? = null,
    /** Where "Clans need land" GO goes (`LandGate(browse)`). */
    val landLink: HubLink? = null,
    /** Current command refusal; the callback explains rather than dropping the tap. */
    val leaveReason: String? = null,
    val chatLabel: String = "CLAN CHAT",
    val chestUnavailable: String = "Weekly chest details are unavailable.",
)

/**
 * CLAN · MEMBERS · CHARTER · TOURNEY (labels only), with the clan-members.png art: the crest (32) on CLAN, the members
 * pair on MEMBERS, the banner (32) on CHARTER, the trophy on TOURNEY. Locked ones come from the server feature flags.
 */
fun clanTabs(charterLocked: Boolean = false, tourneyLocked: Boolean = false): List<TabUi> = listOf(
    TabUi("CLAN", "itm_crest", "CLAN", null, false),
    TabUi("MEMBERS", "referral", "MEMBERS", null, false),
    TabUi("CHARTER", "itm_banner", "CHARTER", null, charterLocked),
    TabUi("TOURNEY", "trophy", "TOURNEY", null, tourneyLocked),
)

/** Clan callbacks. */
@Immutable data class ClanActions(
    /** Every tab tap, locked ones too: for a locked tab show its reason toast ("Tournaments open later") and do not switch. */
    val onTab: (String) -> Unit = {},
    /** COPY the invite code (toast "Invite code copied"). */
    val onCopyCode: () -> Unit = {},
    /** LEAVE: raise [ClanUi.confirm]. */
    val onLeave: () -> Unit = {},
    /** CLAN CHAT: open the Chat drawer at CLAN. */
    val onChat: () -> Unit = {},
    val onJoin: (String) -> Unit = {},
    val onCreate: () -> Unit = {},
    /** KICK: raise [ClanUi.confirm] for that member. */
    val onKick: (String) -> Unit = {},
    val onClose: () -> Unit = {},
    /** The ConfirmDialog's red primary / BACK. */
    val onConfirm: () -> Unit = {},
    val onConfirmBack: () -> Unit = {},
    /** No clan: OPEN CLANS / CODE. */
    val onFilter: (String) -> Unit = {},
    val onCodeDraft: (String) -> Unit = {},
    val onJoinByCode: () -> Unit = {},
    /** "Clans need land" GO. */
    val onGo: (HubLink) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
)

/**
 * The Clan card. [charter] and [tourney] are the existing bodies (`phasee/CharterScreen.kt`, `TournamentScreen.kt`)
 * extracted into body composables by the shell session; null draws a placeholder line. [tourneyFooter] replaces the
 * LEAVE + chat foot while TOURNEY is selected (clan-tourney.png: RANKINGS + FIND MATCH); null keeps LEAVE + chat.
 *
 * Pointer rule: the root is a plain Box (the [HubCard] Column plus the confirm); only painted rows and buttons take
 * touches. The confirm's 55 % scrim is composed only while [ClanUi.confirm] is set.
 */
@Composable fun ClanSheet(ui: ClanUi, on: ClanActions, modifier: Modifier = Modifier,
    charter: (@Composable ColumnScope.() -> Unit)? = null, tourney: (@Composable ColumnScope.() -> Unit)? = null,
    members: (@Composable ColumnScope.() -> Unit)? = null,
    status: (@Composable ColumnScope.() -> Unit)? = null,
    tourneyFooter: (@Composable RowScope.() -> Unit)? = null) {
    val noClan = ui.noClan
    val tourneyFoot: (@Composable RowScope.() -> Unit)? =
        if (ui.selectedTab == "TOURNEY" && ui.name != null && noClan == null) tourneyFooter else null
    Box(modifier) {
        HubCard(Modifier.fillMaxSize(), selectedTab = ui.selectedTab,
            footer = when {
                ui.requiresLand || (ui.name == null && noClan == null) -> null
                tourneyFoot != null -> tourneyFoot
                else -> ({
                    when {
                        noClan != null -> Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            noClan.createPrice?.let { PriceChip(it) }
                            PrimaryButton("CREATE CLAN", on.onCreate, Modifier.fillMaxWidth(), state = noClan.createState, reason = noClan.createReason)
                        }
                        else -> {
                            SecondaryButton("LEAVE", on.onLeave, Modifier.width(112.dp).heightIn(min = 60.dp), contentDescription = "Leave the clan")
                            PrimaryButton(ui.chatLabel, on.onChat, Modifier.weight(1f), verb = Verb.BLUE, icon = "shape:chat",
                                badge = badgeCount(ui.chatUnread)?.let { BadgeUi(it, BadgeTone.COUNT, "${ui.chatUnread} unread clan messages") })
                        }
                    }
                })
            },
            header = {
                ClanHeader(ui, on.onClose)
                // SPEC §0.2 / §5: Tabs.Stacked under the header, as on the clanless finder.
                if (ui.tabs.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    StackedTabs(ui.tabs, ui.selectedTab, on.onTab, Modifier.padding(horizontal = 2.dp))
                }
            }) {
            status?.invoke(this)
            when {
                ui.requiresLand -> NeedsLandBody(ui, on)
                ui.selectedTab == "MEMBERS" -> if (members != null) SlotBody(members, "") else MembersBody(ui, on, all = true)
                ui.selectedTab == "CHARTER" -> SlotBody(charter, "The clan charter opens here.")
                ui.selectedTab == "TOURNEY" -> SlotBody(tourney, "Tournaments open here.")
                else -> when {
                    ui.requiresLand -> NeedsLandBody(ui, on)
                    noClan != null -> NoClanBody(noClan, on)
                    else -> ClanBody(ui, on)
                }
            }
        }
        HubConfirmDialog(ui.confirm, on.onConfirm, on.onConfirmBack, Modifier.fillMaxSize())
    }
}

@Composable private fun ClanHeader(ui: ClanUi, onClose: () -> Unit) {
    LivingHeader(onClose, stage = HeaderStage.SUNRAYS, rayCentre = Offset(0.17f, 0.5f),
        timer = ui.chestEndsIn?.let { TimerUi("Chest in $it", "The weekly chest closes in $it") }) {
        Box(Modifier.align(Alignment.CenterStart).padding(start = 22.dp)) {
            Box(Modifier.size(84.dp).drawBehind {
                val w = size.width; val h = size.height; val i = 3.dp.toPx()
                fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
                insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(PkwTokens.Colors.gold.face) }
                val j = 7.dp.toPx()
                fillStepped(j, j, w - j, h - j, CornerProfiles.S, PkwTokens.Colors.parchment)
            }, contentAlignment = Alignment.Center) { HubArt("itm_banner", 64.dp) }
        }
        Column(Modifier.align(Alignment.TopStart).padding(start = CLAN_HEADER_TEXT_START_DP.dp, top = 12.dp, end = CLAN_HEADER_TEXT_END_DP.dp)
            .clearAndSetSemantics {
                contentDescription = listOfNotNull(ui.name ?: "Clan Hall", ui.tag, ui.members, ui.inviteMode, ui.rank?.let { "rank $it" }).joinToString(", ")
            }, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            PkwText(ui.name ?: "CLAN HALL", PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp,
                maxLines = clanHeaderNameMaxLines(chestTimer = ui.chestEndsIn != null))
            val line = listOfNotNull(ui.tag, ui.members).joinToString(" · ")
            if (line.isNotEmpty()) PkwText(line, PkwTokens.Type.body, color = PkwTokens.Colors.muted)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ui.inviteMode?.let { StatusTag(it, if (it == "OPEN") Verb.GREEN else Verb.STONE) }
                ui.rank?.let { StatusTag("RANK $it", Verb.STONE) }
            }
        }
    }
}

@Composable private fun ColumnScope.ClanBody(ui: ClanUi, on: ClanActions) {
    val view = boardView(ui.load, ui.top.isNotEmpty() || ui.chest != null)
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (view == BoardView.ERROR_KEPT || view == BoardView.ERROR_EMPTY) (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport) }
        SectionHeader("WEEKLY CHEST", note = "all members' wins")
        val chest = ui.chest
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 96.dp).graphicsLayer { alpha = boardAlpha(view) }, tint = PkwTokens.Colors.selectedTint, blocksScene = false) {
            if (chest == null && view == BoardView.SKELETON) Row(Modifier.fillMaxWidth().padding(6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SkeletonBlock(Modifier.size(60.dp), dark = true)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SkeletonBlock(Modifier.fillMaxWidth(0.5f).heightIn(min = 14.dp))
                    SkeletonBlock(Modifier.fillMaxWidth().heightIn(min = 16.dp))
                }
            } else if (chest == null) PkwText(ui.chestUnavailable, PkwTokens.Type.body, Modifier.align(Alignment.Center).padding(8.dp),
                color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = CLAN_CHEST_NOTE_MAX_LINES)
            else Row(Modifier.fillMaxWidth().padding(6.dp).clearAndSetSemantics {
                contentDescription = listOfNotNull("Weekly chest ${chest.wins} of ${chest.goal} wins", chest.yours?.let { "you: $it" }, chest.line).joinToString(". ")
            }, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Well("itm_banner", size = 60.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Row(verticalAlignment = Alignment.Bottom) {
                        PkwText("${chest.wins}/${chest.goal} WINS", PkwTokens.Type.label, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
                        chest.yours?.let { PkwText("you: $it", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
                    }
                    ProgressBar(chest.progress, "Chest ${chest.wins} of ${chest.goal}", verb = Verb.GOLD, height = 16.dp)
                    PkwText(chest.line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                }
            }
        }
        if (ui.top.isNotEmpty() || view == BoardView.SKELETON) SectionHeader("TOP THIS WEEK", right = "wins")
        if (view == BoardView.SKELETON) repeat(4) { SkeletonRow(height = 56.dp) }
        Column(Modifier.graphicsLayer { alpha = boardAlpha(view) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ui.top.forEach { MemberRow(it, kick = null) }
        }
        ui.inviteCode?.let { code ->
            CardRow(height = 58.dp) {
                Well("referral", light = true, iconSize = 36.dp)
                RowText("Invite code $code", "Joining is currently closed")
                SecondaryButton("COPY", on.onCopyCode, Modifier.width(84.dp), contentDescription = "Copy invite code $code")
            }
        }
    }
}

@Composable private fun ColumnScope.MembersBody(ui: ClanUi, on: ClanActions, all: Boolean) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionHeader("MEMBERS", note = ui.members, right = "wins")
        (if (all) ui.allMembers else ui.top).forEach { member ->
            MemberRow(member, kick = if (ui.isLeader && member.canKick && !member.isYou) ({ on.onKick(member.id) }) else null)
        }
    }
}

@Composable private fun MemberRow(member: MemberRowUi, kick: (() -> Unit)?) {
    CardRow(variant = if (member.isYou) RowVariant.YOU else RowVariant.PLAIN, height = 56.dp) {
        Well(member.portrait, size = 40.dp, iconSize = 28.dp)
        Column(Modifier.weight(1f).clearAndSetSemantics {
            contentDescription = listOfNotNull(member.name, member.role?.name?.lowercase(), if (member.isYou) "you" else null, member.keepLine,
                "${member.wins} wins").joinToString(", ")
        }) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(member.name, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch)
                when {
                    member.isYou -> StatusTag("YOU", Verb.GOLD)
                    member.role == MemberRole.LEADER -> StatusTag("LEADER", Verb.GOLD)
                    member.role == MemberRole.ELDER -> StatusTag("ELDER", Verb.BLUE)
                }
            }
            PkwText(member.keepLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        if (kick != null) SecondaryButton("KICK", kick, Modifier.width(72.dp), contentDescription = "Kick ${member.name}")
        else {
            HubArt("attack", 24.dp)
            PkwText(member.wins, PkwTokens.Type.label, Modifier.width(36.dp), color = PkwTokens.Colors.textOnParch)
        }
    }
}

@Composable private fun ColumnScope.NoClanBody(noClan: NoClanUi, on: ClanActions) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Well(null, size = 64.dp) { HubArt("itm_banner", 32.dp, alpha = 0.4f) }
            PkwText("You are not in a clan", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
            PkwText("Clans share a weekly chest and a chat.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        FilterChipStrip(noClan.filters, noClan.filter, on.onFilter)
        if (noClan.filter == "CODE") {
            HubTextField(noClan.codeDraft, on.onCodeDraft, "Clan invite code", placeholder = "IRN-7Q2K")
            SecondaryButton("JOIN", on.onJoinByCode, Modifier.fillMaxWidth(), verb = Verb.GREEN, enabled = noClan.codeDraft.isNotBlank())
        } else {
            if (noClan.clans.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText("No open clans right now", "Create one, or join with a code.") }
            noClan.clans.forEach { clan ->
                CardRow(height = 58.dp) {
                    Well(clan.crest, iconSize = 32.dp)
                    RowText(clan.name, clan.sub)
                    if (clan.joinBusy) StoneBusyButton("JOIN", true, {}, Modifier.width(72.dp))
                    else SecondaryButton("JOIN", { on.onJoin(clan.id) }, Modifier.width(72.dp), verb = Verb.GREEN, contentDescription = "Join ${clan.name}")
                }
            }
        }
    }
}

@Composable private fun ColumnScope.NeedsLandBody(ui: ClanUi, on: ClanActions) {
    val land = ui.landLink
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        HubEmptyState("CLANS REQUIRE LAND", "Clans need land. Claim a Land Deed to found or join a clan.", icon = "itm_deed_earth",
            goLabel = if (land != null) "GET LAND" else null, goIcon = "itm_deed_earth", onGo = if (land != null) ({ on.onGo(land) }) else null)
    }
}

@Composable private fun ColumnScope.SlotBody(slot: (@Composable ColumnScope.() -> Unit)?, placeholder: String) {
    if (slot != null) Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), content = slot)
    else Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        PkwText(placeholder, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
    }
}

// ---- Previews (clan.png, confirm.png numbers) ----

private fun member(id: String, name: String, keep: Int, wins: String, role: MemberRole? = null, you: Boolean = false) =
    MemberRowUi(id, keepPortrait(if (keep >= 13) 4 else 3), name, role, you, "Keep $keep", wins, canKick = !you && role == null)

private val sampleClan = ClanUi(
    name = "IRON WARDENS", tag = "[IRN]", hallTier = 2, members = "18/30 members", inviteMode = "OPEN", rank = "12", chestEndsIn = "4d 6h",
    chest = ClanChestUi("42", "60", "7", "18 more wins fill the chest for everyone", 0.7f),
    top = listOf(member("m1", "Mira", 14, "12", MemberRole.LEADER), member("m2", "Seraphine", 13, "9", MemberRole.ELDER),
        member("m3", "Rowan", 12, "7", you = true), member("m4", "Old Bramble", 10, "5"), member("m5", "Harrowgate", 9, "4")),
    inviteCode = "IRN-7Q2K", tabs = clanTabs(tourneyLocked = true), selectedTab = "CLAN", chatUnread = 3, noClan = null,
    requiresLand = false, load = LoadState.Ready,
)

@Preview(name = "Clan (clan.png)", widthDp = 412, heightDp = 915)
@Composable private fun ClanPreview() { HubPreviewStage { ClanSheet(sampleClan, ClanActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Clan: leave confirm (confirm.png)", widthDp = 412, heightDp = 915)
@Composable private fun ClanConfirmPreview() {
    HubPreviewStage {
        ClanSheet(sampleClan.copy(confirm = ConfirmUi("LEAVE IRON WARDENS?", "ui_portrait_clanhall_t2", keepPortrait(3),
            "You lose your share of this week's chest.", "Your kingdom and trophies stay.", "LEAVE CLAN")), ClanActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Clan: MEMBERS (leader sees KICK)", widthDp = 412, heightDp = 915)
@Composable private fun ClanMembersPreview() {
    HubPreviewStage { ClanSheet(sampleClan.copy(selectedTab = "MEMBERS", isLeader = true), ClanActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Clan: loading", widthDp = 412, heightDp = 915)
@Composable private fun ClanLoadingPreview() {
    HubPreviewStage {
        ClanSheet(sampleClan.copy(members = UNKNOWN, rank = null, chest = null, top = emptyList(), inviteCode = null, load = LoadState.Loading),
            ClanActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Clan: no clan", widthDp = 412, heightDp = 915)
@Composable private fun ClanNonePreview() {
    HubPreviewStage {
        ClanSheet(sampleClan.copy(name = null, tag = null, members = null, inviteMode = null, rank = null, chestEndsIn = null, chest = null,
            top = emptyList(), inviteCode = null, chatUnread = 0,
            noClan = NoClanUi("OPEN", clans = listOf(ClanRowUi("c1", "itm_crest", "Sunforge", "[SOL] · 24/30 members · Keep 6+"),
                ClanRowUi("c2", "itm_crest", "Oakmoot", "[OAK] · 11/30 members", joinBusy = true)),
                createPrice = PriceUi(Currency.SHARDS, "40,000", PriceStatus.OK))), ClanActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Clan: needs land", widthDp = 412, heightDp = 915)
@Composable private fun ClanNeedsLandPreview() {
    HubPreviewStage {
        ClanSheet(sampleClan.copy(name = null, tag = null, members = null, inviteMode = null, rank = null, chestEndsIn = null, chest = null,
            top = emptyList(), inviteCode = null, requiresLand = true, landLink = sampleLink("profile.land")), ClanActions(), Modifier.fillMaxSize())
    }
}
