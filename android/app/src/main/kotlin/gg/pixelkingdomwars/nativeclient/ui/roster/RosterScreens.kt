package gg.pixelkingdomwars.nativeclient.ui.roster

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.economy.PlateTabs

import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.Alignment
import androidx.compose.ui.zIndex
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.heroGemSpendUi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.basePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.flag
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseSol
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseTitle
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A missing or malformed server price is unavailable; only canonical whole KEEP can enter consent. */
private fun rosterKeepPrice(value: String?): String? = value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }

/** Web screens/heroRecovery.ts: the server owns availability; the clock only formats the remaining time. */
internal fun heroRecoveryLabel(recoveryUntil: String?, nowMs: Long, available: Boolean?): String? {
    if (available == true) return null
    val until = recoveryUntil?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return if (available == false) "RECOVERING · VERIFYING" else null
    val remaining = (until - nowMs + 999).floorDiv(1000)
    if (remaining <= 0) return if (available == false) "RECOVERING · VERIFYING" else null
    return "RECOVERING · ${fmtDur(remaining).uppercase()}"
}

@Composable private fun ScreenHeader(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { TextButton(onClick = onBack) { Text("Back") }; Text(title, style = MaterialTheme.typography.headlineSmall) }
}

@Composable private fun RosterHeader(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), fontSize = 24.sp, letterSpacing = 3.sp, color = SurfaceInk.goldHi)
        TextButton(onClick = onBack, modifier = Modifier.size(48.dp), contentPadding = PaddingValues(0.dp)) { GameArt("close", Modifier.size(22.dp), "Close $title") }
    }
}

/** Web heroPortrait.ts: the authoritative level selects T4; unknown levels keep the base portrait. */
internal fun rosterHeroPortrait(catalogue: JsonObject?, hero: String, level: Int?): String {
    val base = when (hero) { "vex" -> "hero_vex_portrait"; "theodor" -> "hero_theo_portrait"; else -> return "" }
    val art = (catalogue?.get("constants") as? JsonObject)?.get("ART_V2") as? JsonObject
    val perTier = (art?.get("levelsPerTier") as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it > 0 }
    val tiers = (art?.get("tiers") as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it > 0 }
    val tier = if (level == null || perTier == null || tiers == null) 1 else (((level.coerceAtLeast(1).toLong() - 1) / perTier) + 1).coerceAtMost(tiers.toLong()).toInt()
    return if (tier == 4) "${base}_t4" else base
}

/** HERO ROSTER (web screens/heroes.tsx HeroTray): every number rendered is the server's — level, stats,
 * prices — and both paid buttons fetch a fresh explicit currency confirmation. Recruiting is
 * placing the altar in the build tray (BUILD ▸ HEROES), so a locked row routes there. */
@Composable fun HeroesScreen(model: RosterViewModel, keepConfirm: KeepConfirmPreference, onBack: () -> Unit, onRecruit: () -> Unit) {
    val state by model.state.collectAsState(); val busy by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val now = displayClock()
    val lifecycle = LocalLifecycleOwner.current
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismissHeroReview() }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer); model.dismissHeroReview() }
    }
    LaunchedEffect(Unit) { model.loadHeroes() }
    // The roster re-reads when the base snapshot's hero recovery state changes (web `heroRecoveryRevision`).
    val recoveryRevision = state.home.base?.raw?.get("heroes")?.toString()
    var priorRevision by remember { mutableStateOf(recoveryRevision) }
    LaunchedEffect(recoveryRevision) { if (priorRevision != null && recoveryRevision != null && priorRevision != recoveryRevision) model.loadHeroes(); priorRevision = recoveryRevision }
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.heroReview != null) { model.dismissHeroReview() }
    BackHandlerAt(BackPriority.SCREEN, enabled = state.domain.heroReview == null) { onBack() }
    // Second old-screen sweep (owner 2026-10-06): the Hero Altar's history door opens this owner on the designed page.
    DesignedPage("HEROES", onBack) heroes@ {
        notice?.let { Notice(it.message, it.error, model::dismissNotice) }
        state.domain.error?.takeIf { notice == null }?.let { Notice(it, error = true, onDismiss = model::clearNotice) }
        state.domain.message?.let { Notice(it, onDismiss = model::clearNotice) }
        if (busy || state.domain.loading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = SurfaceInk.gold)
        InterruptedBanner(state.interrupted.filter { it.kind == IntentKind.HERO_UPGRADE || it.kind == IntentKind.HERO_RECOVERY }, busy, model.interrupted.check, model.interrupted.close, model.interrupted.retry)
        Text("HERO ROSTER · REVIEW CURRENCY BEFORE PAYING", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.muted)
        val roster = state.domain.heroes
        if (roster == null) { if (!busy) Text("LOADING HEROES…", color = SurfaceInk.muted); return@heroes }
        if (!roster.heroConsentSupported) Text("Hero upgrades and paid recovery need a server update.", color = SurfaceInk.muted)
        roster.heroes.forEach { hero -> HeroRow(hero, state, busy || state.heroesBlocked || !state.ordersAllowed, now, model, onRecruit) }
    }
    HeroCurrencyConfirm(state, busy, model)
}

@Composable private fun HeroRow(h: Hero, state: RosterUiState, busy: Boolean, now: Long, model: RosterViewModel, onRecruit: () -> Unit) {
    val recovery = heroRecoveryLabel(h.recoveryUntil, now, h.available)
    val maxed = h.next == null
    Card(Modifier.fillMaxWidth().alpha(if (h.recruited) 1f else .55f)) { Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(52.dp)) {
                GameArt(rosterHeroPortrait(state.catalogue, h.hero, h.level), Modifier.fillMaxSize())
                if (h.recruited) Text("L${h.level ?: "—"}", Modifier.align(Alignment.BottomEnd).background(Palette.gold).border(1.dp, Palette.ink).padding(horizontal = 3.dp), fontSize = 12.sp, color = Palette.ink)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(h.name.uppercase(), fontSize = 16.sp)
                Text((if (h.recruited) h.tierName else h.title).orEmpty().uppercase(), color = SurfaceInk.faint, fontSize = 13.sp)
                if (h.recruited) {
                    StatLine("HP", h.hp, h.gear?.hpBonus, h.next?.hp); StatLine("DPS", h.dps, h.gear?.dpsBonus, h.next?.dps)
                    recovery?.let { Text("$it · CANNOT ATTACK OR DEFEND", color = SurfaceInk.danger, fontSize = 13.sp) }
                } else Text("LOCKED · RECRUIT AT THE ALTAR — ${rosterKeepPrice(h.recruitCostKeep)?.let { "${fmtN(it)} KEEP" } ?: "PRICE UNAVAILABLE"} · KEEP L${h.unlockKeepLevel ?: "—"}", color = SurfaceInk.danger, fontSize = 14.sp)
            }
        }
        val skills = CodexData.heroSkills(state.catalogue, h.hero)
        if (skills.isNotEmpty()) Text(skills.joinToString(" · ") { "${it.name}${it.unlockLevel?.let { l -> " L$l" } ?: ""}" }, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            val finish = h.recoveryFinishNow
            when {
                finish != null -> {
                    val cost = rosterKeepPrice(finish.costKeep)
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Button(onClick = { model.reviewHeroRecovery(h.hero) },
                            enabled = !busy && cost != null && state.domain.heroes?.heroConsentSupported == true) { Text(if (cost != null) "REVIEW RECOVERY" else "PRICE UNAVAILABLE") }
                        if (cost == null) TextButton(onClick = model::loadHeroes, enabled = !busy) { Text("REFRESH RECOVERY PRICE") }
                    }
                }
                !h.recruited -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("NOT RECRUITED", color = SurfaceInk.muted, style = MaterialTheme.typography.bodySmall); OutlinedButton(onClick = onRecruit, enabled = !busy) { Text("RECRUIT AT THE ALTAR") } }
                maxed -> Text("MAX L${h.maxLevel ?: h.level}", color = SurfaceInk.gold)
                else -> {
                    val next = requireNotNull(h.next); val cost = rosterKeepPrice(next.costKeep)
                    // KEEP-only affordability cannot disable a Hero that Gems can fully fund.
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Button(onClick = { model.reviewHeroUpgrade(h.hero) },
                            enabled = !busy && cost != null && state.domain.heroes?.heroConsentSupported == true) { Text(if (cost != null) "REVIEW LEVEL ${next.level}" else "PRICE UNAVAILABLE") }
                        if (cost == null) TextButton(onClick = model::loadHeroes, enabled = !busy) { Text("REFRESH UPGRADE PRICE") }
                    }
                }
            }
        }
    } }
}

/** Always explicit; the KEEP "skip confirmation" preference cannot bypass exact currency consent. */
@Composable internal fun HeroCurrencyConfirm(state: RosterUiState, busy: Boolean, model: RosterViewModel) {
    val reviewed = state.domain.heroReview
    val armedAtMs = remember(reviewed) { System.currentTimeMillis() }
    val gems = heroGemSpendUi(state, busy, displayClock(), armedAtMs)
    GemSpendSeal(gems, GemSpendActions(onConfirm = {
        val current = model.state.value
        if (reviewed != null && current.domain.heroReview == reviewed && !model.busy.value &&
            !current.heroesBlocked && current.ordersAllowed && heroGemSpendUi(current, false, System.currentTimeMillis(), armedAtMs) != null)
            model.confirmHeroSpend()
    }, onBack = model::dismissHeroReview), Modifier.zIndex(PkwTokens.Z.SEAL))
    val intent = reviewed?.intent ?: return
    val cost = intent.quote?.get("costKeep")?.let { (it as? JsonPrimitive)?.content } ?: return
    val currency = intent.expectedCurrency ?: return
    if (currency == "GEMS") return
    AlertDialog(
        onDismissRequest = model::dismissHeroReview,
        title = { Text(intent.label) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GameArt(if (currency == "GEMS") "gem" else "keep", Modifier.size(24.dp), currency)
                Text("Up to ${fmtN(cost)} $currency")
            }
            Text(gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealKingdomLine(state.home.base, intent.baseId))
            Text(if (currency == "GEMS") "Pay with Gems. This confirmation cannot switch to KEEP." else "Pay with custodial KEEP. This confirmation cannot switch to Gems.")
            if (intent.kind == IntentKind.HERO_RECOVERY) Text("Recovers this injury only. The final charge may decrease as the timer runs.")
        } },
        confirmButton = { Button(onClick = { model.confirmHeroSpend() }, enabled = !busy && !state.heroesBlocked && state.ordersAllowed) { Text("PAY $currency") } },
        dismissButton = { TextButton(onClick = model::dismissHeroReview, enabled = !busy) { Text("CANCEL") } },
    )
}

/** "42 +6 → 55": the arrow half is suppressed at max level, the signed gear delta only when non-zero. */
@Composable private fun StatLine(label: String, current: String?, bonus: String?, next: String?) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
        Text(label, color = SurfaceInk.muted, style = MaterialTheme.typography.bodySmall)
        Text(fmtN(current ?: "0"))
        bonus?.takeIf { it != "0" }?.let { Text(if (it.startsWith("-")) fmtN(it) else "+${fmtN(it)}", color = if (it.startsWith("-")) SurfaceInk.danger else SurfaceInk.gold) }
        next?.takeIf { it != current }?.let { Text("→${fmtN(it)}", color = SurfaceInk.gold) }
    }
}

private val RARITY_ORDER = listOf("common", "uncommon", "rare", "epic", "legendary", "mythic")
private val STAT_LABEL = mapOf("hero_hp_bps" to "HERO HP", "hero_damage_bps" to "DAMAGE", "ability_damage_bps" to "ABILITY DAMAGE", "cooldown_reduction_bps" to "COOLDOWN",
    "move_speed_bps" to "MOVE SPEED", "incoming_damage_reduction_bps" to "INCOMING DAMAGE", "first_hit_reduction_bps" to "FIRST HIT", "wall_damage_bps" to "WALL DAMAGE",
    "allied_troop_hp_bps" to "TROOP HP", "allied_troop_damage_bps" to "TROOP DAMAGE")
private val BENEFICIAL_NEGATIVE = setOf("cooldown_reduction_bps", "incoming_damage_reduction_bps", "first_hit_reduction_bps")
/** Web `modifierLabel`: reduction stats flip only their DISPLAY sign (800 bps → "−8% incoming damage"). */
internal fun modifierLabel(stat: String, value: Int): String {
    val displayed = if (stat in BENEFICIAL_NEGATIVE) -value else value
    val sign = if (displayed > 0) "+" else if (displayed < 0) "−" else ""
    val magnitude = Math.abs(displayed)
    return "${STAT_LABEL[stat] ?: stat.uppercase()} $sign${if (magnitude % 100 == 0) (magnitude / 100).toString() else (magnitude / 100.0).toString()}%"
}
internal fun acquisitionLabel(item: ItemDefinition): String {
    val gate = item.acquisition ?: return "—"
    return when (gate.type) {
        "shop" -> "KEEP SHOP"
        "drop" -> "DROPS FROM GOLD FORGE"
        "keep_level" -> "KEEP LEVEL ${gate.keepLevel ?: "—"}"
        else -> "CAMPAIGN ${gate.stage ?: "—"} · 3★${if (gate.requiresMaxHero) " · MAX HERO" else ""}"
    }
}
/** Web shopCatalog.tsx `acquisitionLabel`: the sale-side wording of the same gate. */
internal fun shopAcquisitionLabel(item: ItemDefinition): String {
    val gate = item.acquisition ?: return "DROPS FROM GOLD FORGE"
    return when (gate.type) {
        "shop" -> "AVAILABLE NOW"
        "keep_level" -> "KEEP LEVEL ${gate.keepLevel ?: "—"} REQUIRED"
        "campaign_three_star" -> "CAMPAIGN ${gate.stage ?: "—"} · 3★${if (gate.requiresMaxHero) " · MAX HERO" else ""}"
        else -> "DROPS FROM GOLD FORGE"
    }
}

/** INVENTORY (web screens/inventory.tsx): hero loadouts, the paper doll, the owned-only bag with capacity by
 * weight, and the item detail with EQUIP / USE / SELL ON MARKET / VIEW ON GLOBE. Gameplay values come from
 * GET /items only. */
@Composable fun InventoryScreen(model: RosterViewModel, onBack: () -> Unit, onOpenShop: () -> Unit, onPlaceAltar: () -> Unit, onSell: (String) -> Unit, onViewDeeds: () -> Unit) {
    val state by model.state.collectAsState(); val busy by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val now = displayClock()
    LaunchedEffect(Unit) { model.loadInventory() }
    BackHandlerAt(BackPriority.SHEET, enabled = state.selectedItemId != null) { model.selectItem(null) }
    BackHandlerAt(BackPriority.SCREEN, enabled = state.selectedItemId == null) { onBack() }
    val data = state.domain.inventory
    // Second old-screen sweep (owner 2026-10-06): the GEAR door's full inventory on the designed page; the panes keep their
    // own bounded scrolls, so the page hands the body its height (scrollState = null).
    DesignedPage("INVENTORY", onBack, scrollState = null) {
    BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
        val viewportWidth = maxWidth
        val wide = viewportWidth >= 560.dp
        val short = wide && maxHeight <= 520.dp
        Column(Modifier.fillMaxSize()) {
            if (wide && !short) Text("KEEP QUARTERMASTER", color = SurfaceInk.faint, fontSize = 12.sp, letterSpacing = 2.sp)
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                data?.heroLoadouts?.forEach { entry ->
                    val recovery = heroRecoveryLabel(entry.recoveryUntil, now, entry.available)
                    val active = entry.hero == state.selectedHero
                    Row(Modifier.weight(1f).heightIn(min = 48.dp).background(if (active) SurfaceInk.selected else SurfaceInk.card)
                        .border(2.dp, if (recovery != null) SurfaceInk.danger else if (active) SurfaceInk.gold else SurfaceInk.rule)
                        .clickable(role = Role.Tab) { model.selectHero(entry.hero) }.semantics { selected = active }
                        .padding(horizontal = 5.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (viewportWidth > 340.dp && !short) GameArt(rosterHeroPortrait(state.catalogue, entry.hero, entry.level), Modifier.size(42.dp))
                        Column(Modifier.weight(1f)) {
                            Text(if (entry.hero == "theodor") "THEODOR" else entry.hero.uppercase(), fontSize = 18.sp, color = if (active) SurfaceInk.goldHi else SurfaceInk.muted)
                            if (!short) Text(if (!entry.recruited) "NOT RECRUITED" else recovery ?: "LEVEL ${entry.level}", fontSize = 12.sp, color = if (recovery != null) SurfaceInk.danger else SurfaceInk.faint)
                        }
                    }
                }
            }
            if (!wide) Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                BagPane.entries.forEach { pane -> FilterChip(state.bagPane == pane, { model.setBagPane(pane) }, Modifier.weight(1f), label = { Text(pane.name) }) }
            }
            notice?.let { Notice(it.message, it.error, model::dismissNotice) }
            state.domain.error?.takeIf { notice == null }?.let { Notice(it.uppercase(), error = true, onDismiss = model::clearNotice) }
            state.domain.message?.let { Notice(it, onDismiss = model::clearNotice) }
            if (busy || state.domain.loading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = SurfaceInk.gold)
            InterruptedBanner(state.interrupted.filter { it.kind == IntentKind.ITEM_USE || it.kind == IntentKind.ITEM_BUY }, busy, model.interrupted.check, model.interrupted.close, model.interrupted.retry)
            if (data == null) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { Text("OPENING THE ARMORY…", color = SurfaceInk.gold) }
            } else BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(8.dp)) {
                // Match the web's bottom detail surface while each top pane owns its finite scroll area.
                val detailHeight = minOf(maxHeight * (if (wide) .54f else .48f), if (wide) 220.dp else 350.dp)
                val detail = state.selectedItem
                val bottom = if (detail != null) detailHeight + 8.dp else 0.dp
                Row(Modifier.fillMaxSize().padding(bottom = bottom), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (wide || state.bagPane == BagPane.EQUIPMENT)
                        InventoryEquipment(state, model, now, if (wide) Modifier.width(300.dp).fillMaxHeight() else Modifier.fillMaxSize())
                    if (wide || state.bagPane == BagPane.BACKPACK)
                        InventoryBackpack(state, model, onOpenShop, Modifier.weight(1f).fillMaxHeight())
                }
                if (detail != null) ItemDetail(detail, state, busy || state.itemsBlocked, model, onPlaceAltar, onSell, onViewDeeds,
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = detailHeight))
            }
        }
    }
    }
}

// Presentation positions and empty-slot identities copied from inventory.css / SLOT_ART.
private val SLOT_COLUMNS = listOf(listOf("helm", "chest", "gloves", "boots", "banner"), listOf("amulet", "cloak", "ring", "weapon", "offhand"))
private fun slotArt(slot: String) = when (slot) { "weapon" -> "itm_hammer"; "offhand" -> "itm_shield"; else -> "itm_$slot" }
@Composable private fun inventoryRarity(rarity: String?) = when (rarity) {
    "uncommon" -> SurfaceInk.success; "rare" -> Color(0xFFBBD0D6); "epic" -> Color(0xFF9A78B8)
    "legendary" -> SurfaceInk.gold; "mythic" -> SurfaceInk.goldHi; else -> SurfaceInk.muted
}

@Composable private fun InventoryEquipment(state: RosterUiState, model: RosterViewModel, now: Long, modifier: Modifier) {
    val data = state.domain.inventory ?: return
    val hero = data.loadout(state.selectedHero)
    val gearSlots = ((state.catalogue?.get("constants") as? JsonObject)?.get("GEAR_SLOTS") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
    PixelPanel(modifier) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(8.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
                Text("${state.selectedHero.uppercase()} LOADOUT", fontSize = 18.sp, color = SurfaceInk.goldHi)
                Text("${hero?.setBonus?.pieces ?: 0}/${hero?.setBonus?.required ?: 9} WARDEN", fontSize = 11.sp, color = SurfaceInk.faint)
            }
            Row(Modifier.fillMaxWidth().height(304.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                @Composable fun slots(keys: List<String>) {
                    Column(Modifier.width(56.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        keys.forEach { slot ->
                            val item = hero?.equipment?.get(slot)?.let { data.item(it) }
                            if (slot !in gearSlots) Spacer(Modifier.size(56.dp)) else Box(Modifier.size(56.dp).background(SurfaceInk.card.copy(alpha = .8f))
                                .border(2.dp, if (item != null) SurfaceInk.gold else SurfaceInk.ruleLt)
                                .clickable(enabled = item != null, role = Role.Button) { item?.let { model.selectItem(it.id) } }
                                .semantics(mergeDescendants = true) { contentDescription = "$slot: ${item?.name ?: "empty"}" }, contentAlignment = Alignment.Center) {
                                GameArt(item?.asset ?: slotArt(slot), Modifier.size(if (item != null) 44.dp else 36.dp).alpha(if (item != null) 1f else .22f))
                                Text(slot.uppercase(), Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(SurfaceInk.well.copy(alpha = .82f)), fontSize = 9.sp, lineHeight = 12.sp, textAlign = TextAlign.Center, color = SurfaceInk.faint)
                            }
                        }
                    }
                }
                slots(SLOT_COLUMNS[0])
                Box(Modifier.weight(1f).fillMaxHeight().background(Brush.radialGradient(listOf(SurfaceInk.gold.copy(alpha = .16f), Color.Transparent)))
                    .border(1.dp, SurfaceInk.rule), contentAlignment = Alignment.Center) {
                    GameArt(if (state.selectedHero == "theodor") "hero_theo_idle_f1" else "hero_vex_idle_f1", Modifier.size(125.dp))
                    Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 26.dp).fillMaxWidth(.52f).height(4.dp).background(SurfaceInk.rule))
                }
                slots(SLOT_COLUMNS[1])
            }
            heroRecoveryLabel(hero?.recoveryUntil, now, hero?.available)?.let { Text("$it · UNAVAILABLE FOR ATTACK OR DEFENCE", Modifier.fillMaxWidth().border(1.dp, SurfaceInk.danger).padding(6.dp), color = SurfaceInk.danger, fontSize = 12.sp, textAlign = TextAlign.Center) }
            Column(Modifier.fillMaxWidth().border(1.dp, if (hero?.setBonus?.active == true && data.heroGearCombatEnabled) SurfaceInk.success else SurfaceInk.ruleLt).padding(5.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("WARDEN OF THE NINE", fontSize = 16.sp, color = if (hero?.setBonus?.active == true && data.heroGearCombatEnabled) SurfaceInk.success else SurfaceInk.faint)
                Text(when { !data.heroGearCombatEnabled -> "EQUIPMENT SAVED · COMBAT ROLLOUT OFF"; hero?.setBonus?.active == true -> "+8% NONHERO TROOP HP ACTIVE"; else -> "EQUIP 9 PIECES TO AWAKEN" }, fontSize = 11.sp, color = SurfaceInk.faint, textAlign = TextAlign.Center)
            }
            val shown = if (data.heroGearCombatEnabled) hero?.effectiveStats else hero?.baseStats
            if (hero != null && shown != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val values = listOf(Triple("HP", shown.hp, hero.baseStats?.hp), Triple("DAMAGE", shown.basicDamage, hero.baseStats?.basicDamage), Triple("SKILL", shown.skillDamageSeed, hero.baseStats?.skillDamageSeed))
                values.forEach { (label, value, base) -> Column(Modifier.weight(1f).background(SurfaceInk.well).padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(label, fontSize = 10.sp, color = SurfaceInk.faint); Text(fmtN(value), fontSize = 18.sp)
                    if (data.heroGearCombatEnabled && base != null && base != value) Text("BASE ${fmtN(base)}", fontSize = 9.sp, color = SurfaceInk.success)
                } }
            }
        }
    }
}

@Composable private fun InventoryBackpack(state: RosterUiState, model: RosterViewModel, onOpenShop: () -> Unit, modifier: Modifier) {
    val data = state.domain.inventory ?: return
    Card(modifier) {
        Row(Modifier.fillMaxWidth().background(SurfaceInk.well).horizontalScroll(rememberScrollState())) {
            BagTab.entries.forEach { tab -> FilterChip(state.bagTab == tab, { model.setBagTab(tab) }, label = { Text(tab.label, fontSize = 15.sp) }) }
        }
        data.capacity?.let { cap ->
            val pct = if (cap.max > 0) Math.min(100, Math.round(cap.used * 100.0 / cap.max).toInt()) else 0
            val label = when { cap.overflow -> "OVER CAPACITY"; pct >= 100 -> "PACK FULL"; pct >= 80 -> "NEAR CAPACITY"; else -> "CAPACITY" }
            val color = if (cap.overflow) SurfaceInk.danger else if (pct >= 80) SurfaceInk.gold else SurfaceInk.success
            Row(Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, fontSize = 13.sp, color = if (cap.overflow || pct >= 80) color else SurfaceInk.faint)
                LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.weight(1f).height(8.dp), color = color)
                Text("${cap.used}/${cap.max}", fontSize = 15.sp)
            }
        }
        val visible = state.visibleBagItems
        if (visible.isEmpty()) Column(Modifier.weight(1f).fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (state.bagTab == BagTab.ALL) "YOUR BACKPACK IS EMPTY" else "NO OWNED ${state.bagTab.label} ITEMS", color = SurfaceInk.faint, textAlign = TextAlign.Center)
            Button(onClick = onOpenShop) { Text("OPEN SHOP") }
        } else androidx.compose.foundation.lazy.grid.LazyVerticalGrid(columns = androidx.compose.foundation.lazy.grid.GridCells.Adaptive(58.dp), modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(7.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            items(visible.size, key = { visible[it].id }) { index ->
                val item = visible[index]; val deed = state.isDeed(item.id)
                val owned = if (deed) 1 else data.quantity(item.id); val equipped = data.equippedCount(item.id)
                val fresh = !deed && owned > 0 && !data.seen(item.id); val active = state.selectedItemId == item.id
                Box(Modifier.fillMaxWidth().aspectRatio(1f).background(if (active) SurfaceInk.selected else SurfaceInk.well.copy(alpha = .5f))
                    .border(2.dp, if (active) SurfaceInk.goldHi else inventoryRarity(item.rarity))
                    .clickable(role = Role.Button) { model.selectItem(if (active) null else item.id) }
                    .semantics(mergeDescendants = true) { selected = active; contentDescription = "${item.name ?: item.id}, $owned owned, ${if (deed) 1 else data.stored(item.id)} available, $equipped equipped${if (fresh) ", new" else ""}" }, contentAlignment = Alignment.Center) {
                    item.asset?.let { GameArt(it, Modifier.size(40.dp)) }
                    if (fresh) Box(Modifier.align(Alignment.TopEnd).size(8.dp).background(SurfaceInk.goldHi))
                    if (owned > 1) Text("×$owned", Modifier.align(Alignment.BottomEnd).background(SurfaceInk.well).padding(horizontal = 3.dp), fontSize = 13.sp, color = SurfaceInk.goldHi)
                    if (equipped > 0) Text("E${if (equipped > 1) "×$equipped" else ""}", Modifier.align(Alignment.BottomStart).background(Palette.success).padding(horizontal = 3.dp), fontSize = 10.sp, color = Palette.ink)
                    if (deed) Text(data.deeds.firstOrNull { it.id == item.id }?.status.orEmpty().uppercase(), Modifier.align(Alignment.BottomStart).background(Palette.gold).padding(horizontal = 3.dp), fontSize = 9.sp, color = Palette.ink)
                }
            }
            // Empty display cells match web's minimum18 slots; capacity still comes exclusively from /items.
            items((18 - visible.size).coerceAtLeast(0)) { Box(Modifier.fillMaxWidth().aspectRatio(1f).background(SurfaceInk.well.copy(alpha = .25f)).border(1.dp, SurfaceInk.rule)) }
        }
    }
}

@Composable private fun ItemDetail(selected: ItemDefinition, state: RosterUiState, busy: Boolean, model: RosterViewModel, onPlaceAltar: () -> Unit, onSell: (String) -> Unit, onViewDeeds: () -> Unit, modifier: Modifier = Modifier) {
    val data = state.domain.inventory ?: return
    val hero = data.loadout(state.selectedHero)
    val deed = state.isDeed(selected.id)
    val stored = if (deed) 1 else data.stored(selected.id)
    val currentSlotItem = if (selected.kind == "gear" && selected.slot != null) hero?.equipment?.get(selected.slot) else null
    val sellable = !deed && !selected.dropOnly && stored > 0
    val compared = currentSlotItem?.takeIf { it != selected.id }?.let { data.item(it) }
    Card(modifier) { Column(Modifier.verticalScroll(rememberScrollState()).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(48.dp).background(SurfaceInk.card).border(2.dp, inventoryRarity(selected.rarity)), contentAlignment = Alignment.Center) { selected.asset?.let { GameArt(it, Modifier.size(40.dp)) } }
            Column(Modifier.weight(1f)) {
                Text((selected.rarity ?: "").uppercase(), color = inventoryRarity(selected.rarity), fontSize = 11.sp)
                Text(selected.name ?: selected.id, color = SurfaceInk.goldHi, fontSize = 19.sp)
            }
            TextButton(onClick = { model.selectItem(null) }, modifier = Modifier.size(48.dp), contentPadding = PaddingValues(0.dp)) { GameArt("close", Modifier.size(22.dp), "Close item details") }
        }
        selected.rarity?.let { r -> RARITY_ORDER.indexOf(r).takeIf { it >= 0 }?.let { Text("${it + 1}/${RARITY_ORDER.size}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted) } }
        Text(selected.text, style = MaterialTheme.typography.bodySmall)
        selected.activation?.let { activation ->
            Text("UNUSED ×$stored${selected.maxOwned?.let { " · BAG LIMIT $it" } ?: ""}. " + when {
                activation.active && activation.kind == "hero" -> "HERO ALREADY RECRUITED ON THIS BASE. SELL THE UNUSED CONTRACT ON THE MARKET."
                activation.active -> "TRAINING ALREADY UNLOCKED. SELL THE UNUSED WRIT ON THE MARKET."
                activation.kind == "hero" -> "PLACE THE HERO ALTAR TO USE THIS CONTRACT. IT IS CONSUMED WHEN PLACED."
                else -> "USE ONCE TO UNLOCK TRAINING. THE WRIT IS CONSUMED."
            }, style = MaterialTheme.typography.bodySmall)
        }
        Text("${(selected.kind ?: "").uppercase()} · WT ${selected.weight} · ${if (deed) "STABLE CORE NFT" else acquisitionLabel(selected)}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted)
        selected.modifiers.forEach { m -> Text(modifierLabel(m.stat, m.value), style = MaterialTheme.typography.bodySmall, color = if (m.value > 0) SurfaceInk.gold else SurfaceInk.danger) }
        if (compared != null) {
            val comparison = (selected.modifiers.map { it.stat } + compared.modifiers.map { it.stat }).distinct().mapNotNull { stat ->
                val next = selected.modifiers.firstOrNull { it.stat == stat }?.value ?: 0; val current = compared.modifiers.firstOrNull { it.stat == stat }?.value ?: 0
                if (next == current) null else stat to (next - current)
            }
            if (comparison.isNotEmpty()) { Text("VS ${compared.name}", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall)
                comparison.forEach { (stat, value) -> Text(modifierLabel(stat, value), style = MaterialTheme.typography.bodySmall, color = if (value > 0) SurfaceInk.gold else SurfaceInk.danger) } }
        }
        val slot = selected.slot; val activation = selected.activation
        if (selected.kind == "gear" && slot != null && (stored > 0 || currentSlotItem == selected.id))
            Button(onClick = { model.equip(selected.id) }, enabled = !busy && hero?.recruited == true, modifier = Modifier.fillMaxWidth()) { Text(if (currentSlotItem == selected.id) "UNEQUIP" else "EQUIP · ${slot.uppercase()}") }
        if (selected.kind == "consumable" && stored > 0 && activation?.active != true)
            // Recruitment consumes the contract only when its altar is placed: the build tray keeps the placement validation.
            Button(onClick = { if (activation?.kind == "hero") onPlaceAltar() else model.use(selected.id) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (activation?.kind == "hero") "USE · PLACE HERO ALTAR" else "USE") }
        if (sellable) OutlinedButton(onClick = { onSell(selected.id) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("SELL ON MARKET") }
        if (deed) OutlinedButton(onClick = onViewDeeds, modifier = Modifier.fillMaxWidth()) { Text("VIEW ON GLOBE") }
    } }
}

/** CODEX (web screens/codex.tsx): four tabs of reference entries; troop rows carry the player's real /army level. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable fun CodexScreen(model: RosterViewModel, onBack: () -> Unit) {
    val state by model.state.collectAsState()
    var tab by remember { mutableStateOf(CodexTab.TROOPS) }
    LaunchedEffect(Unit) { if (state.domain.army == null) model.loadArmy() }
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    // Second old-screen sweep (owner 2026-10-06): the Settings HELP / Supplies Codex door opens the designed page.
    DesignedPage("CODEX", onBack) {
        PlateTabs(CodexTab.entries.map { it to it.name }, tab) { tab = it }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val entries = CodexData.entries(state.catalogue, tab)
        if (entries.isEmpty()) Text("Codex entries need the verified game catalogue.", color = SurfaceInk.muted)
        entries.forEach { entry -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(62.dp, 74.dp), contentAlignment = Alignment.BottomCenter) {
                    val art = entry.troop?.let { gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait(state.catalogue, it, state.domain.army?.levels?.get(it)) }
                        ?: if (tab == CodexTab.ITEMS) when(entry.key) { "rally" -> "ui_skill_rally"; "warhorn", "swiftboots", "powdercharge" -> "ui_icon_${entry.key}"; else -> entry.key }
                        else "building-${entry.key}"
                    GameArt(art, Modifier.size(48.dp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(entry.name, color = SurfaceInk.goldHi, fontSize = 21.sp)
                    Text(entry.tag, fontSize = 14.sp, letterSpacing = 1.sp, color = SurfaceInk.gold)
                }
            }
            entry.troop?.let { troop -> CodexData.troopStats(state.catalogue, troop, state.domain.army?.levels?.get(troop))?.let { s ->
                FlowRow(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    listOf("LV" to s.level, "HP" to s.hp, "DMG" to s.dmg, "SPD" to s.speed, "RNG" to s.range, "MAX LV" to s.maxLevel).forEach { (label, value) ->
                        Row(Modifier.background(SurfaceInk.well).border(1.dp, SurfaceInk.rule).padding(horizontal = 6.dp, vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(label, fontSize = 14.sp, color = SurfaceInk.faint); Text(value.toString(), fontSize = 14.sp, color = SurfaceInk.text)
                        }
                    }
                } } }
            Text(entry.who, fontSize = 15.sp, lineHeight = 19.sp, color = SurfaceInk.muted)
            entry.strat?.let { Text(buildString { append("HOW TO USE: "); append(it) }, fontSize = 15.sp, lineHeight = 19.sp, color = SurfaceInk.faint) }
        } } }
        }
    }
}
