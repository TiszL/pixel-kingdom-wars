package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipStrip
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HeaderStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubTextField
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LivingHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

/**
 * Design component: no clan yet, FIND · CREATE · INVITES (design/final/account/clan-find.png, clan-create.png, SPEC §5.4),
 * a FULL card: the Clan Hall header ("CLANS · Raid together"), `Tabs.Stacked`, then FIND (search, FOR YOU · MY REALM ·
 * OPEN chips, ClanCards with green JOIN / stone ASK / FULL, the best match green-rimmed, INVITE CODE + GO; foot blue
 * CREATE YOUR OWN), CREATE (live preview, NAME, TAG + JOINING, BANNER picker, MIN TROPHIES stepper, "You become the
 * captain"; foot the cost pills over gold CREATE CLAN → Seal), INVITES (pending invites). Entries: the Clan Hall CLAN★
 * while clanless, the Profile CLAN door, an invite letter. Destination: `Clan("FIND")`.
 *
 * Fields with no backing are not drawn rather than drawn as placeholders: a card's realm / joining minimum when
 * [ClanListingUi.realmKnown] / [ClanListingUi.minTrophiesKnown] are false, the BANNER picker with no banners, the MIN
 * TROPHIES stepper without server bounds, the INVITES badge while [ClanFinderUi.invitesKnown] is false.
 */

/** How a listed clan can be joined. */
enum class ClanJoinMode { OPEN, ASK, FULL }

/** A ClanCard's name may wrap to a second line (the card grows): one label line beside the tag holds about 16 letters on
 *  the 400 dp Seeker in portrait, and the server allows 24, so a long name lost its end to "…". */
internal const val CLAN_CARD_NAME_MAX_LINES = 2

/** One ClanCard (76 tall). */
@Immutable data class ClanListingUi(
    val id: String,
    /** "IRON WARDENS". */
    val name: String,
    /** "[IRN]". */
    val tag: String,
    val bannerIcon: String,
    val realmName: String,
    val realmThumb: ImageBitmap?,
    /** "18/30". */
    val members: String,
    /** The league crest of the minimum ("league-gold"). */
    val leagueCrest: String,
    /** "1,000+". */
    val minTrophies: String,
    val join: ClanJoinMode,
    /** The best match: green rim. */
    val bestMatch: Boolean = false,
    /** JOIN / ASK is in flight. */
    val busy: Boolean = false,
    /** JOIN / ASK cannot be sent from here: the button is drawn locked and a tap says this. */
    val joinUnavailable: String? = null,
    /** False: the server row carries no realm, so the realm crest and name are not drawn. */
    val realmKnown: Boolean = true,
    /** False: the server row carries no joining minimum, so the league crest and minimum are not drawn. */
    val minTrophiesKnown: Boolean = true,
)

/** One pending invite. */
@Immutable data class ClanInviteUi(val id: String, val clanName: String, val tag: String, val bannerIcon: String, val from: String)

/** The FIND tab (SPEC §5.4 `ClanSearchUiState`). */
@Immutable data class ClanSearchUi(
    val query: String,
    /** "FOR_YOU", "MY_REALM", "OPEN". */
    val filter: String,
    val results: List<ClanListingUi>,
    val codeDraft: String,
    val loading: Boolean = false,
    /** Joining by code cannot be sent from here: GO is drawn locked and a tap says this. */
    val codeUnavailable: String? = null,
    val observationKnown: Boolean = true,
    val filters: List<FilterChipUi> = listOf(FilterChipUi("FOR_YOU", "FOR YOU"), FilterChipUi("MY_REALM", "MY REALM"), FilterChipUi("OPEN", "OPEN")),
)

/** The CREATE tab (SPEC §5.4 `ClanCreateUiState`). */
@Immutable data class ClanCreateUi(
    val name: String,
    val tag: String,
    /** True = INVITE only, false = OPEN. */
    val inviteOnly: Boolean,
    val bannerId: String,
    /** The four authored banner / crest arts to pick from; empty hides the BANNER picker. */
    val banners: List<String>,
    val minTrophies: Int,
    /** Formatted MIN TROPHIES ("600"). */
    val minTrophiesText: String,
    /** The creation's SOL price (server catalogue); null hides its pill. A CHECKING price keeps CREATE enabled navigation. */
    val price: PriceUi?,
    /** The name / tag rule refusals the mapper derived from the catalogue (or the server's "That name is taken"). */
    val nameError: String? = null,
    val tagError: String? = null,
    /** "Rowan". */
    val captainName: String,
    /** No Clan Hall: CREATE locks with this ("Build a Clan Hall (Keep 4)"). */
    val hallLockedReason: String? = null,
    /** Creation continues in the existing owner's flow: this line sits above CREATE CLAN, whose tap hands off there. */
    val controlsOnlyReason: String? = null,
    /** Catalogue length limits for the drafts; null = unknown, the draft is not cut. */
    val nameMax: Int? = null,
    val tagMax: Int? = null,
    /** The NAME / TAG notes from the same rules ("3 to 16 letters", "3-4"); null draws none. */
    val nameRule: String? = null,
    val tagRule: String? = null,
    /** The creation's Shards price (server catalogue), drawn beside the SOL pill; null hides it. */
    val shardsPrice: PriceUi? = null,
    /** CREATE locks with this reason (for example the rules are not loaded); unlike [hallLockedReason] it offers no GO. */
    val lockedReason: String? = null,
)

/** Everything the clan finder draws. */
@Immutable data class ClanFinderUi(
    /** "FIND", "CREATE" or "INVITES". */
    val tab: String,
    val search: ClanSearchUi,
    val create: ClanCreateUi,
    val invites: List<ClanInviteUi>,
    /** Clan Hall tier 1..4 for the header portrait; null draws the tier-1 portrait. */
    val hallTier: Int?,
    /** MIN TROPHIES stepper bounds and step (server catalogue); 0 = no backing, the stepper is not drawn. */
    val minTrophiesStep: Int = 0,
    val minTrophiesMax: Int = 0,
    val invitesKnown: Boolean = true,
)

/** FIND · CREATE · INVITES (the INVITES badge = pending invites). */
fun clanFinderTabs(invites: Int): List<TabUi> = listOf(
    TabUi("FIND", "scout", "FIND", null, false),
    TabUi("CREATE", "itm_banner", "CREATE", null, false),
    TabUi("INVITES", "referral", "INVITES", countBadge(invites, "invites"), false),
)

/**
 * The TAG field's draft: the charter tag grammar's capitals and digits (`CharterProtocol` tag `[A-Z0-9]+`), cut at the
 * catalogue's [max] when it is known (never a local length).
 */
internal fun clanCreateTagDraft(raw: String, max: Int?): String {
    val cleaned = raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
    return if (max != null && max > 0) cleaned.take(max) else cleaned
}

/** The finder's tabs: no INVITES badge while invitations are not read (an unread count would be invented). */
internal fun clanFinderTabsFor(ui: ClanFinderUi): List<TabUi> = clanFinderTabs(if (ui.invitesKnown) ui.invites.size else 0)

/** The INVITES tab while no invitation read exists: one plain line instead of an invented empty list. */
internal const val CLAN_INVITES_CLOSED = "Clan invitations are not open yet."

/** The INVITES tab's line: [CLAN_INVITES_CLOSED] while invitations are not read, else none (the list draws). */
internal fun clanInvitesNote(ui: ClanFinderUi): String? = if (ui.invitesKnown) null else CLAN_INVITES_CLOSED

/**
 * CREATE CLAN from the form's own rules (SPEC §5.4): a lock ([ClanCreateUi.lockedReason], then no Clan Hall) shows its
 * reason; an empty or refused name / tag is DISABLED; an UNAVAILABLE price is DISABLED, a SHORT one opens Need-more; an
 * unknown (CHECKING) price stays enabled navigation (correction 7). The rules are the mapper's catalogue errors, never a
 * local length.
 */
internal fun clanCreateFormLook(create: ClanCreateUi): PrimaryLook {
    val label = "CREATE CLAN"
    val locked = create.lockedReason ?: create.hallLockedReason
    val prices = listOfNotNull(create.price, create.shardsPrice)
    val ready = create.name.isNotBlank() && create.tag.isNotBlank() && create.nameError == null && create.tagError == null
    return when {
        locked != null -> PrimaryLook(label, null, Verb.GOLD, CommandState.LOCKED, locked)
        !ready -> PrimaryLook(label, null, Verb.GOLD, CommandState.DISABLED, "Give the clan a name and a tag")
        prices.any { it.status == PriceStatus.UNAVAILABLE } -> PrimaryLook(label, null, Verb.GOLD, CommandState.DISABLED, "Price unavailable right now")
        prices.any { it.status == PriceStatus.SHORT } -> PrimaryLook(label, null, Verb.GOLD, CommandState.SHORT, "Not enough to create a clan")
        else -> PrimaryLook(label, null, Verb.GOLD, CommandState.ENABLED, null)
    }
}

/** Clan finder callbacks (SPEC §5.4). */
@Immutable data class ClanFinderActions(
    val onTab: (String) -> Unit = {},
    val onClose: () -> Unit = {},
    val onSearch: (String) -> Unit = {},
    val onFilter: (String) -> Unit = {},
    val onJoin: (String) -> Unit = {},
    /** ASK: send a request; the clan leader lets you in. */
    val onAsk: (String) -> Unit = {},
    val onCodeDraft: (String) -> Unit = {},
    val onCode: (String) -> Unit = {},
    /** The NAME field (already cut at [ClanCreateUi.nameMax]). */
    val onName: (String) -> Unit = {},
    /** The TAG field (already cleaned and cut by `clanCreateTagDraft` at [ClanCreateUi.tagMax]). */
    val onTag: (String) -> Unit = {},
    val onInviteOnly: (Boolean) -> Unit = {},
    val onBanner: (String) -> Unit = {},
    /** The new MIN TROPHIES ([stepMinTrophies]). */
    val onMinTrophies: (Int) -> Unit = {},
    /** CREATE CLAN: the review Seal, or the hand-off to the existing creation owner. */
    val onCreate: () -> Unit = {},
    val onNeedMore: () -> Unit = {},
    /** No Clan Hall: GO TO BUILD. */
    val onBuildHall: () -> Unit = {},
    val onAcceptInvite: (String) -> Unit = {},
    val onDeclineInvite: (String) -> Unit = {},
    val onExplain: (String) -> Unit = {},
    val onControls: () -> Unit = {},
)

/**
 * The clan finder card. [modifier] is the FULL-card area (x 8..404, y 14 to bottom − 14).
 *
 * Pointer rule: the root is the hub's plain `HubCard` Column; only the wood frame, tabs, fields, chips, cards and buttons
 * take touches. The 60 % scrim is the SheetHost's, composed only while the card is shown.
 */
@Composable fun ClanFinderSheet(ui: ClanFinderUi, on: ClanFinderActions, modifier: Modifier = Modifier,
    status: (@Composable ColumnScope.() -> Unit)? = null) {
    val create = ui.create
    val look = clanCreateFormLook(create)
    HubCard(modifier, selectedTab = ui.tab,
        footer = when (ui.tab) {
            "FIND" -> ({ PrimaryButton("CREATE YOUR OWN", { on.onTab("CREATE") }, Modifier.weight(1f), verb = Verb.BLUE) })
            "CREATE" -> ({
                Column(Modifier.weight(1f)) {
                    // clan-create.png: the CostPill rides 14 dp into the top of CREATE CLAN at the right; both catalogue
                    // prices (Shards and the SOL core fee) are shown, never a placeholder.
                    val pills = listOfNotNull(create.shardsPrice, create.price)
                    if (pills.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(end = 4.dp).zIndex(1f).offset(y = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
                        pills.forEach { PriceChip(it) }
                    }
                    PrimaryButton(look.label, {
                        when (primaryTap(look)) {
                            PrimaryTap.ACT -> on.onCreate()
                            PrimaryTap.NEED_MORE -> on.onNeedMore()
                            PrimaryTap.EXPLAIN -> look.reason?.let(on.onExplain)
                            PrimaryTap.IGNORE -> Unit
                        }
                    }, Modifier.fillMaxWidth(), verb = look.verb, state = look.state, reason = look.reason, reasonOnDark = true)
                }
            })
            else -> null
        },
        header = {
            FinderHeader(ui.hallTier, on.onClose)
            Spacer(Modifier.height(10.dp))
            StackedTabs(clanFinderTabsFor(ui), ui.tab, on.onTab, Modifier.padding(horizontal = 2.dp))
        }) {
        status?.invoke(this)
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            when (ui.tab) {
                "CREATE" -> CreateBody(ui, on)
                "INVITES" -> {
                    val note = clanInvitesNote(ui)
                    if (note != null) NoteLine(note) else InvitesBody(ui.invites, on)
                }
                else -> FindBody(ui.search, on)
            }
        }
    }
}

/** The finder's 110 dp LivingHeader (clan-find.png): the Clan Hall portrait in the gold well, PS 13 CLANS, VT "Raid together". */
@Composable private fun FinderHeader(hallTier: Int?, onClose: () -> Unit) {
    LivingHeader(onClose, stage = HeaderStage.SUNRAYS, rayCentre = Offset(0.17f, 0.5f), height = 110.dp) {
        GoldWell(Modifier.align(Alignment.CenterStart).padding(start = 22.dp), size = 84.dp) {
            HubArt("ui_portrait_clanhall_t${(hallTier ?: 1).coerceIn(1, 4)}", 56.dp)
        }
        Column(Modifier.align(Alignment.TopStart).padding(start = 124.dp, top = 22.dp, end = 64.dp).semantics(mergeDescendants = true) { heading() },
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText("CLANS", PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
            PkwText("Raid together", PkwTokens.Type.body, color = PkwTokens.Colors.muted)
        }
    }
}

@Composable private fun FindBody(search: ClanSearchUi, on: ClanFinderActions) {
    HubTextField(search.query, on.onSearch, "Search clans by name or tag", placeholder = "Name or tag")
    FilterChipStrip(search.filters, search.filter, on.onFilter)
    if (search.loading && search.results.isEmpty()) repeat(3) { SkeletonRow(height = 76.dp) }
    else if (!search.observationKnown) NoteLine("Clan standings have not been read. Refresh to try again.")
    else if (search.results.isEmpty()) CardRow(variant = RowVariant.DIM) { RowText("No clans match", "Try another name or refresh the standings.") }
    search.results.forEach { ClanCard(it, on) }
    val codeClosed = search.codeUnavailable
    NoteLine(codeClosed ?: "ASK sends a request; the clan leader lets you in.")
    SectionHeader("INVITE CODE", note = "from a friend")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        HubTextField(search.codeDraft, on.onCodeDraft, "Clan invite code", Modifier.weight(1f), placeholder = "IRN-7Q2K")
        if (codeClosed != null) LockedChunky("GO", codeClosed, "Join with invite code", Modifier.size(72.dp, 52.dp), on.onExplain)
        else GoButton({
            if (search.codeDraft.isNotBlank()) on.onCode(search.codeDraft.trim()) else on.onExplain("Type the invite code first.")
        }, contentDescription = "Join with invite code", modifier = Modifier.size(72.dp, 52.dp))
    }
}

/**
 * A charcoal button with the padlock and its verb (the design system's LOCKED face): the door still answers, a tap says
 * [reason]. Used where joining is not open from this client.
 */
@Composable private fun LockedChunky(label: String, reason: String, spoken: String, modifier: Modifier, onExplain: (String) -> Unit) {
    ChunkyBox(PkwTokens.Colors.charcoalRamp, { onExplain(reason) }, "$spoken, locked. $reason", modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwIcon("shape:lock", 16.dp, tint = PkwTokens.Colors.gold.face)
            PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

@Composable private fun ClanCard(clan: ClanListingUi, on: ClanFinderActions) {
    val c = PkwTokens.Colors
    CardRow(variant = if (clan.bestMatch) RowVariant.READY else RowVariant.PLAIN, height = 76.dp) {
        Well(clan.bannerIcon, size = 56.dp, light = true, iconSize = 32.dp)
        Column(Modifier.weight(1f).clearAndSetSemantics {
            contentDescription = listOfNotNull(clan.name, clan.tag, clan.realmName.takeIf { clan.realmKnown }, "${clan.members} members",
                if (clan.minTrophiesKnown) "${clan.minTrophies} trophies to join" else null).joinToString(", ")
        }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(clan.name.uppercase(), PkwTokens.Type.label, Modifier.weight(1f, fill = false), color = c.textOnParch,
                    maxLines = CLAN_CARD_NAME_MAX_LINES)
                PkwText(clan.tag, PkwTokens.Type.small, color = c.textOnParch2)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (clan.realmKnown) RealmThumb(clan.realmThumb, clan.realmName, Modifier.size(24.dp))
                // Without a realm the members count keeps its own (authored) members icon rather than a stand-in crest.
                else HubArt("referral", 20.dp)
                PkwText(clan.members, PkwTokens.Type.small, color = c.textOnParch2)
                if (clan.minTrophiesKnown) {
                    HubArt(clan.leagueCrest, 20.dp)
                    PkwText(clan.minTrophies, PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
        val closed = clan.joinUnavailable
        when {
            closed != null && clan.join != ClanJoinMode.FULL ->
                LockedChunky(if (clan.join == ClanJoinMode.ASK) "ASK" else "JOIN", closed, "Join ${clan.name}", Modifier.size(76.dp, 48.dp), on.onExplain)
            clan.busy -> StoneBusyButton(if (clan.join == ClanJoinMode.ASK) "ASK" else "JOIN", true, {}, Modifier.width(76.dp))
            clan.join == ClanJoinMode.OPEN -> SecondaryButton("JOIN", { on.onJoin(clan.id) }, Modifier.width(76.dp), verb = Verb.GREEN, contentDescription = "Join ${clan.name}")
            clan.join == ClanJoinMode.ASK -> SecondaryButton("ASK", { on.onAsk(clan.id) }, Modifier.width(76.dp), contentDescription = "Ask to join ${clan.name}")
            else -> StatusTag("FULL", Verb.STONE, tall = true)
        }
    }
}

@Composable private fun CreateBody(ui: ClanFinderUi, on: ClanFinderActions) {
    val create = ui.create
    val c = PkwTokens.Colors
    create.hallLockedReason?.let { reason ->
        AccountCard(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, contentPadding = 12.dp) {
            Well("ui_portrait_clanhall_t1", size = 64.dp, iconSize = 56.dp, alpha = 0.5f)
            PkwText(reason, PkwTokens.Type.body, color = c.textOnParch)
            SecondaryButton("GO TO BUILD", on.onBuildHall, Modifier.fillMaxWidth(), verb = Verb.BLUE, contentDescription = "Go to build. $reason")
        }
    }
    // clan-create.png: the live preview card (gold rim, banner well 64, PS name, "[TAG] · captain …").
    AccountCard(Modifier.fillMaxWidth(), rim = c.gold.face, face = c.selectedTint, minHeight = 84.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Well(create.bannerId, size = 64.dp, light = true, iconSize = 56.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwText(create.name.ifBlank { "YOUR CLAN" }.uppercase(), PkwTokens.Type.label, color = c.textOnParch)
                PkwText("${create.tag.ifBlank { "[TAG]" }.let { if (it.startsWith("[")) it else "[$it]" }} · captain ${create.captainName}",
                    PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
    SectionHeader("NAME", note = create.nameRule)
    HubTextField(create.name, { raw -> on.onName(create.nameMax?.let { raw.take(it) } ?: raw) }, "Clan name", placeholder = "Iron Wardens")
    create.nameError?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
        Column(Modifier.width(120.dp)) {
            SectionHeader("TAG", note = create.tagRule)
            HubTextField(create.tag, { raw -> on.onTag(clanCreateTagDraft(raw, create.tagMax)) }, "Clan tag", placeholder = "IRN")
        }
        Column(Modifier.weight(1f)) {
            SectionHeader("JOINING")
            FilterChipStrip(listOf(FilterChipUi("OPEN", "OPEN"), FilterChipUi("INVITE", "INVITE")), if (create.inviteOnly) "INVITE" else "OPEN",
                { on.onInviteOnly(it == "INVITE") })
        }
    }
    create.tagError?.let { PkwText(it, PkwTokens.Type.small, color = c.shortText) }
    // The BANNER picker and MIN TROPHIES stepper draw only when the owner supplies them (the live create request has
    // neither field, so the mapper passes no banners and no stepper bounds).
    if (create.banners.isNotEmpty()) {
        SectionHeader("BANNER")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            create.banners.take(4).forEach { banner ->
                val selected = banner == create.bannerId
                AccountCard(Modifier.weight(1f), rim = if (selected) c.gold.face else null, face = if (selected) c.selectedTint else c.cream, minHeight = 64.dp,
                    onClick = { on.onBanner(banner) }, description = if (selected) "Banner, selected" else "Banner", horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { HubArt(banner, 32.dp) }
                }
            }
        }
    }
    if (ui.minTrophiesStep > 0 && ui.minTrophiesMax > 0) {
        SectionHeader("MIN TROPHIES", note = "to join")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconSquare("shape:minus", Verb.STONE, { on.onMinTrophies(stepMinTrophies(create.minTrophies, -1, ui.minTrophiesStep, 0, ui.minTrophiesMax)) },
                "Fewer trophies to join", enabled = create.minTrophies > 0)
            AccountCard(Modifier.weight(1f).clearAndSetSemantics { contentDescription = "Minimum ${create.minTrophiesText} trophies" },
                minHeight = 52.dp, horizontalAlignment = Alignment.CenterHorizontally) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubArt("league-silver", 20.dp)
                    PkwText(create.minTrophiesText, PkwTokens.Type.label, color = c.textOnParch)
                }
            }
            IconSquare("shape:plus", Verb.STONE, { on.onMinTrophies(stepMinTrophies(create.minTrophies, 1, ui.minTrophiesStep, 0, ui.minTrophiesMax)) },
                "More trophies to join", enabled = create.minTrophies < ui.minTrophiesMax)
        }
    }
    CardRow(height = 66.dp) {
        Well("itm_banner", size = 48.dp, light = true, iconSize = 32.dp)
        RowText("You become the captain", "The clan charter is held by your wallet")
    }
    // The hand-off line sits right above CREATE CLAN: the tap continues in the existing creation owner.
    create.controlsOnlyReason?.let { NoteLine(it) }
}

@Composable private fun InvitesBody(invites: List<ClanInviteUi>, on: ClanFinderActions) {
    if (invites.isEmpty()) {
        CardRow(variant = RowVariant.DIM) { RowText("No invites yet", "A clan leader can send you one.") }
        return
    }
    invites.forEach { invite ->
        CardRow(height = 72.dp) {
            Well(invite.bannerIcon, size = 56.dp, light = true, iconSize = 32.dp)
            RowText("${invite.clanName.uppercase()} ${invite.tag}", "from ${invite.from}")
            IconSquare("shape:close", Verb.STONE, { on.onDeclineInvite(invite.id) }, "Decline the invite from ${invite.clanName}")
            SecondaryButton("JOIN", { on.onAcceptInvite(invite.id) }, Modifier.width(84.dp), verb = Verb.GREEN, contentDescription = "Join ${invite.clanName}")
        }
    }
}

// ---- Previews (clan-find.png, clan-create.png and the SPEC's states) ----

@Preview(name = "Clans: FIND (clan-find.png)", widthDp = 412, heightDp = 915)
@Composable private fun ClanFindPreview() { HubPreviewStage { ClanFinderSheet(sampleFinder, ClanFinderActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Clans: CREATE (clan-create.png)", widthDp = 412, heightDp = 915)
@Composable private fun ClanCreatePreview() { HubPreviewStage { ClanFinderSheet(sampleFinder.copy(tab = "CREATE"), ClanFinderActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Clans: CREATE, no Clan Hall, name taken", widthDp = 412, heightDp = 915)
@Composable private fun ClanCreateLockedPreview() {
    HubPreviewStage {
        ClanFinderSheet(sampleFinder.copy(tab = "CREATE", create = sampleFinder.create.copy(hallLockedReason = "Build a Clan Hall (Keep 4)",
            nameError = "That name is taken", price = null)), ClanFinderActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Clans: INVITES", widthDp = 412, heightDp = 915)
@Composable private fun ClanInvitesPreview() { HubPreviewStage { ClanFinderSheet(sampleFinder.copy(tab = "INVITES"), ClanFinderActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Clans: FIND loading", widthDp = 412, heightDp = 915)
@Composable private fun ClanFindLoadingPreview() {
    HubPreviewStage { ClanFinderSheet(sampleFinder.copy(search = sampleFinder.search.copy(results = emptyList(), loading = true)), ClanFinderActions(), Modifier.fillMaxSize()) }
}
