@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.WorldParcelFailure
import gg.pixelkingdomwars.nativeclient.data.WorldParcelFailureKind
import gg.pixelkingdomwars.nativeclient.model.FantasyOwnedTile
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The base card (ui.js `card(b)`, D-167) and the globe's parcel panel: one server-driven body. Everything it shows or
 * enables comes from the existing parcel read (`GET /globe/fantasy/parcels/:tileId` through `WorldViewModel.select`):
 * the keeper, keep level, trophies, clan tag and shield of an inspectable base; SCOUT and RAID exactly as the server's
 * `actions.scout/attack.allowed` say, with its `blockedBy` reason in words; OPEN BASE for your own deed; the land gate
 * (CHOOSE THIS LAND → `draftLand`, held, reserved) for open land. No outcome, cost or eligibility is computed here; the
 * Claim fact is the catalogue's keep-level table.
 *
 * Layout as ui.js: avatar + name, keep level and tags; the facts beside the kingdom illustration; the action bar last,
 * opaque, with the card scrolling under it. On the realm map [onLookCloser] adds ui.js "Look closer" ("View deed" on open
 * land); it is a ghost button here because RAID or OPEN BASE is the card's one gold action (the web's are still "soon").
 * [short] is the short landscape (height ≤ 520 dp): a 40 dp avatar, no illustration and no note, as the web's media rule.
 *
 * N4 (GLOBE-NATIVE-PLAN §1.1, GLOBE-PRODUCTION-PLAN §2.6.4, F8, F11, F12):
 *  - while the dwell or the read runs, the card is the base's [silhouette] from the viewport markers (name, keep level,
 *    the level's kingdom illustration and its F11 caption), never a blank "checking";
 *  - a refused read says why: the land gate (402/403, "Choose land" → LandGate; in choose mode the next open deed
 *    instead), "Details are busy" (429) or the server's words, each with RETRY where a retry can help;
 *  - OPEN BASE on your own active deed selects that base and opens it ([onOpenBase], web `openBase`); an inactive deed
 *    goes to Your Bases (MANAGE DEED), as before;
 *  - choose mode ([onNextOpen]) puts "Next open deed ▶" in the action bar in place of "Look closer".
 */
@Composable internal fun ColumnScope.ParcelCardBody(model: WorldViewModel, current: WorldUiState, selectedBaseId: String?, busy: Boolean,
    columns: Int, rows: Int, onOpenLand: () -> Unit, onOpenBases: () -> Unit, realmName: String?, short: Boolean = false,
    onLookCloser: (() -> Unit)? = null, bottomInset: Float = 0f, silhouette: RealmHudBase? = null, onNextOpen: (() -> Unit)? = null,
    onOpenBase: ((String) -> Unit)? = null) {
    val t = LocalHudType.current
    val id = current.selectedTileId
    val body = Modifier.padding(start = 16.dp, end = 16.dp)
    if (id == null) return
    val parcel = current.selected
    val x = id % columns; val y = id / columns
    val own = current.globe?.me?.ownedTiles?.firstOrNull { it.tileId == id }
    val failure = current.parcelFailure?.takeIf { it.tileId == id }
    val openOwn: (() -> Unit)? = own?.let { o -> { if (o.active && onOpenBase != null) onOpenBase(o.baseId) else onOpenBases() } }
    if (parcel == null) {
        // The silhouette (dwell rule step 1): what the viewport markers already say, then the read's outcome.
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(end = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val level = silhouette?.level
            Row(body, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (silhouette != null) HudAvatar(if (short) 40.dp else 56.dp, mine = own != null)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    HudText(pendingCardTitle(silhouette, own, x, y), t.title, color = HudStyle.goldHi, maxLines = 2, line = 1.1f)
                    if (level != null) KeepLevel(level)
                    if (own != null) Row { HudTag("Your base", HudTagTone.GOLD) }
                }
                if (!short && level != null) GameArt(model.keepPortrait(level), Modifier.size(56.dp, 53.dp), contentDescription = "Illustration of a level $level kingdom")
            }
            Column(body, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (!short && level != null) HudText("Illustration of a level-$level kingdom", t.cap, color = HudStyle.textFaint, spacing = 1f)
                if (failure != null) HudText(failure.message, t.body, color = if (failure.kind == WorldParcelFailureKind.OTHER) HudStyle.danger else HudStyle.textDim, maxLines = 4)
                else HudText(if (silhouette != null || own != null) "Loading details…" else "Checking this parcel…", t.cap, color = HudStyle.textFaint, spacing = 1f)
            }
        }
        CardActions(bottomInset) {
            when {
                openOwn != null -> HudButton(openOwn, Modifier.weight(1f), kind = HudButtonKind.GOLD, enabled = !busy) {
                    HudText(if (own?.active == true) "Open base" else "Manage deed", t.ui, spacing = 1f, caps = true) }
                failure?.kind == WorldParcelFailureKind.LAND_GATE && onNextOpen == null -> HudButton(onOpenLand, Modifier.weight(1f), kind = HudButtonKind.GOLD, enabled = !busy) {
                    HudText("Choose land", t.ui, spacing = 1f, caps = true) }
                failure != null && failure.kind != WorldParcelFailureKind.LAND_GATE -> HudButton(model::retryParcel, Modifier.weight(1f)) {
                    HudText("Retry", t.ui, spacing = 1f, caps = true) }
                else -> Unit
            }
            CardTail(detail = silhouette != null, onLookCloser, onNextOpen)
        }
        return
    }
    val detail = parcel.detail as? JsonObject
    val player = detail?.get("player") as? JsonObject
    val shield = detail?.get("shield") as? JsonObject
    val actions = detail?.get("actions") as? JsonObject
    val scout = actions?.get("scout") as? JsonObject; val attack = actions?.get("attack") as? JsonObject
    fun allowed(o: JsonObject?) = o?.get("allowed")?.jsonPrimitive?.booleanOrNull == true

    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(end = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (detail != null) {
            val level = player?.string("keepLevel")?.toIntOrNull()
            Row(body, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                HudAvatar(if (short) 40.dp else 56.dp, mine = own != null)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    HudText(loadedCardTitle(player, own != null), t.title, color = HudStyle.goldHi, maxLines = 2, line = 1.1f)
                    if (level != null) KeepLevel(level)
                    val protected = shield?.get("active")?.jsonPrimitive?.booleanOrNull == true
                    val suppressed = shield?.get("suppressedByWarzone")?.jsonPrimitive?.booleanOrNull == true
                    // wraps: in a warzone "Shield suppressed" + "You can attack" is wider than the landscape card's column
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (own != null) HudTag("Your base", HudTagTone.GOLD)
                        when { suppressed -> HudTag("Shield suppressed", HudTagTone.RED); protected -> HudTag("Shielded", HudTagTone.BLUE) }
                        rivalAttackTag(own != null, attack)?.let { HudTag(it, HudTagTone.RED) }
                    }
                }
            }
            // `.row2`: the facts beside the kingdom illustration (hidden in a short landscape, where its caption goes too)
            val facts = RealmHudModel.cardFacts(player?.string("trophies")?.toLongOrNull(), player?.containsKey("clanTag") == true,
                player?.string("clanTag"), level?.let(model::claimTiles), x, y, columns, rows)
            Row(body, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) { facts.forEach { (k, v) -> Fact(k, v) } }
                if (!short && level != null) GameArt(model.keepPortrait(level), Modifier.size(56.dp, 53.dp).offset(4.dp),
                    contentDescription = "Illustration of a level $level kingdom")
            }
            Column(body, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (shield != null) Box(Modifier.semantics(mergeDescendants = true) {}) { ParcelShieldClock(detail, current.selectedAtNanos) }
                // F11 (GLOBE-PRODUCTION-PLAN): the kingdom art never implies a real layout
                if (!short) level?.let { HudText("Illustration of a level-$it kingdom", t.cap, color = HudStyle.textFaint, spacing = 1f) }
            }
            if (own == null) {
                attack?.string("blockedBy")?.let { HudText(worldBlockReason(it, attack["keepReach"] as? JsonObject), t.cap, body, color = HudStyle.textDim, maxLines = 3) }
                scout?.string("blockedBy")?.takeIf { it != attack?.string("blockedBy") }?.let { HudText(worldBlockReason(it), t.cap, body, color = HudStyle.textDim, maxLines = 3) }
            }
        } else {
            Column(body, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                HudText(if (parcel.available) "Open deed" else if (own != null) "Your deed" else "Deed ${x}, ${y}", t.title, color = HudStyle.goldHi, maxLines = 2)
                if (!short) HudText(when (parcel.availability) {
                    "available" -> "No kingdom yet · wild land"; "held" -> "Another checkout currently holds this parcel."
                    "reserved" -> "${parcel.tile.allocation?.uppercase()} reserve · not available for ordinary purchase."
                    else -> "This land is already assigned. Its base is not currently available for inspection."
                }, t.cap, color = HudStyle.textFaint, maxLines = 3)
            }
            Column(body, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                realmName?.let { Fact("Realm", it) }
                Fact("Parcel", "$x, $y")
                Fact("Location", RealmHudModel.lonLat(x, y, columns, rows))
            }
        }
        if (detail != null) Column(body) { DeedPreview(model, id, selectedBaseId, detail) }
        failure?.let { HudText(it.message, t.cap, body, color = HudStyle.textDim, maxLines = 3) }
    }
    // ---- the action bar (.hud-foot, `.rmx-card .acts`): opaque #1d1a24 under a 2 dp border line; the card scrolls under it ----
    CardActions(bottomInset) {
        when {
            openOwn != null -> HudButton(openOwn, Modifier.weight(1f), kind = HudButtonKind.GOLD, enabled = !busy) {
                HudText(if (own?.active == true) "Open base" else "Manage deed", t.ui, spacing = 1f, caps = true) }
            detail != null -> {
                HudButton({ model.scout() }, Modifier.weight(1f), enabled = !busy && allowed(scout)) { HudIcon("scout"); HudText("Scout", t.ui, spacing = 1f, caps = true) }
                HudButton({ model.attack() }, Modifier.weight(1f), kind = HudButtonKind.GOLD, enabled = !busy && allowed(attack)) { HudIcon("attack"); HudText("Raid", t.ui, spacing = 1f, caps = true) }
            }
            // `data-tutorial-target="land-globe-confirm"`, aria-label "CHOOSE LAND" on the web (GLOBE-PRODUCTION-PLAN §1.3 step 4)
            parcel.available -> HudButton({ model.draftLand(onOpenLand) }, Modifier.weight(1f), kind = HudButtonKind.GOLD, enabled = !busy, description = "Choose land") {
                HudText("Choose this land", t.ui, spacing = 1f, caps = true) }
            failure != null && failure.kind != WorldParcelFailureKind.LAND_GATE -> HudButton(model::retryParcel, Modifier.weight(1f)) {
                HudText("Retry", t.ui, spacing = 1f, caps = true) }
            else -> Unit
        }
        CardTail(detail = detail != null, onLookCloser, onNextOpen)
    }
}

/** The card's title while its read runs: the map's own name for the kingdom ([silhouette], already [kingdomName]'s), else
 *  your deed's under the same rule, else the deed's place. */
internal fun pendingCardTitle(silhouette: RealmHudBase?, own: FantasyOwnedTile?, x: Int, y: Int): String =
    silhouette?.name ?: own?.let { kingdomName(it.name, yours = true) } ?: "Deed $x, $y"

/** The card's title once the parcel read lands: the read's player name under the same [kingdomName] rule as the tag and
 *  the loading card. `?: "Keeper"` alone left a nameless player's title blank (an empty name is not null), so the owner's
 *  own nameless kingdom went from "Your kingdom" to an empty title as its card loaded (review of 560fe54). */
internal fun loadedCardTitle(player: JsonObject?, own: Boolean): String = kingdomName(player?.string("name"), own)

/** A rival's attack tag, shown exactly when the server's `actions.attack.allowed` is true. Owner 2026-09-26: raiding has
 *  no location rule ("you can attack anyone despite their location if not shielded"), so it says "You can attack", never
 *  a range. */
internal fun rivalAttackTag(own: Boolean, attack: JsonObject?): String? =
    if (!own && attack?.get("allowed")?.jsonPrimitive?.booleanOrNull == true) "You can attack" else null

/** `.hud-level`: "KEEP LEVEL <b>L</b>/20" (the level in gold at the UI size) and the meter. */
@Composable private fun KeepLevel(level: Int) {
    val t = LocalHudType.current
    Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "Keep level $level of 20" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            HudText("Keep level ", t.kick, color = HudStyle.textDim, spacing = 1f, caps = true, line = 1f)
            HudText(level.toString(), t.ui, color = HudStyle.goldHi, line = 1f)
            HudText("/20", t.kick, color = HudStyle.textDim, spacing = 1f, line = 1f)
        }
        HudMeter(level / 20f, Modifier.weight(1f))
    }
}

/** The card's action bar (`.rmx-card .acts`): opaque #1d1a24 under a 2 dp border line; the card scrolls under it. */
@Composable private fun CardActions(bottomInset: Float, content: @Composable androidx.compose.foundation.layout.FlowRowScope.() -> Unit) {
    FlowRow(Modifier.fillMaxWidth().padding(top = 2.dp).drawBehind {
        drawRect(HudStyle.actsFill); drawRect(HudStyle.border, size = Size(size.width, 2.dp.toPx()))
    }.semantics { contentDescription = "Base actions" }
        .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = (12f + bottomInset).dp),
        horizontalArrangement = Arrangement.spacedBy(HudStyle.gap.dp), verticalArrangement = Arrangement.spacedBy(HudStyle.gap.dp), content = content)
}

/** The bar's last button: choose mode's "Next open deed ▶" (`land-map-open-deed`), else ui.js "Look closer" / "View deed". */
@Composable private fun androidx.compose.foundation.layout.FlowRowScope.CardTail(detail: Boolean, onLookCloser: (() -> Unit)?, onNextOpen: (() -> Unit)?) {
    val t = LocalHudType.current
    when {
        onNextOpen != null -> HudButton(onNextOpen, Modifier.weight(1f), description = "Next open deed") {
            HudText("Next open deed", t.ui, spacing = 1f, caps = true); HudIcon("next") }
        onLookCloser != null -> HudButton(onLookCloser, Modifier.weight(1f), kind = HudButtonKind.GHOST) {
            HudText(if (detail) "Look closer" else "View deed", t.ui, spacing = 1f, caps = true) }
    }
}

@Composable private fun Fact(label: String, value: String) {
    val t = LocalHudType.current
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
        HudText(label, t.cap, Modifier.width(88.dp), color = HudStyle.textFaint, spacing = 1f, caps = true)
        HudText(value, t.body, color = HudStyle.text, maxLines = 2)
    }
}
