package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceAmount
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceBalanceKind
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceCoverage
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceRow
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceScope
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupLayout
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceRowUi
import java.util.Collections

/** Presentation metadata supplied by the existing catalogue/presentation owners, never a balance source. */
internal data class ResourceDrawerEntry(
    val id: String,
    val name: String,
    val icon: String,
    val purpose: String,
    val earnedAt: String,
    val goIcon: String? = null,
    val divine: Boolean = false,
    val actionLabel: String? = null,
    val action: FeatureId? = null,
)

/** Ordered presentation sections: EVERY DAY, HARVESTERS, WORKSHOP, LODGE when supplied by their owners. */
internal data class ResourceDrawerSection(
    val id: String,
    val title: String,
    val icon: String,
    val note: String,
    val layout: ResourceGroupLayout,
    val entries: List<ResourceDrawerEntry>,
    val go: FeatureId? = null,
)

/**
 * Passive mapping of the live resource registry getter, using B's exact ResourceRow contract and
 * M's existing decimal formatter. No repository, quote, callback, timer or currency conversion.
 *
 * The host must sample live producer predicates on each projection, supply owner-admitted metadata
 * and expected scopes, and discard this display on session/base/lifecycle invalidation. Matching
 * wallet/base strings here rejects contradictions; it does not establish A→B→A generation freshness.
 * This output is never spend admission. The existing dispatcher rechecks every GO destination.
 *
 * Only a unique COMPLETE SPENDABLE observation at the exact expected scope provides its amount.
 * Other kinds and partial results are not summed. A missing amount stays unknown, observed absence
 * remains distinct, and only exact known zero receives the empty tint. KEEP is wallet-only and is
 * visible only after the owner observes wallet linkage. No custodial KEEP fallback or SOL row.
 *
 * Sections and entries are presentation only; they do not register new resources/routes. Their
 * caller controls ordering and availability. The sole unambiguous earned-at destination comes
 * from the admitted ResourceRow. An optional named action or group GO must also be present in
 * the resource owner's navigation metadata; the presentation catalogue cannot invent a route.
 */
internal fun resourceDrawerUi(
    rows: List<ResourceRow>,
    account: AccountState,
    expectedScopes: Map<String, ResourceScope>,
    sections: List<ResourceDrawerSection>,
    focusRowId: String?,
    walletLinked: Boolean = false,
): ResourceDrawerUi {
    require(sections.map { it.id }.distinct().size == sections.size) { "Duplicate drawer section" }
    val entries = sections.flatMap { it.entries }
    require(entries.map { it.id }.distinct().size == entries.size) { "Duplicate drawer resource" }
    require(sections.all { it.id.isNotBlank() && it.title.isNotBlank() }) { "Missing drawer section metadata" }
    require(entries.all { it.id.isNotBlank() && it.name.isNotBlank() && it.icon.isNotBlank() }) {
        "Missing admitted resource presentation metadata"
    }
    val wallet = account.wallet?.takeIf { account.phase == AccountPhase.SIGNED_IN && it.isNotBlank() }
    val base = account.selectedBaseId?.takeIf { it.isNotBlank() }

    fun admitted(id: String): ResourceRow? {
        val scope = expectedScopes[id] ?: return null
        if (wallet == null || scope.wallet != wallet) return null
        if (scope.baseId != null && scope.baseId != base) return null
        if ((id == "shards" || id == "gems") && (base == null || scope.baseId != base)) return null
        if (id == "keep" && scope.baseId != null) return null
        return rows.singleOrNull {
            it.id == id && it.kind == ResourceBalanceKind.SPENDABLE && it.scope == scope
        }?.takeIf { it.coverage == ResourceCoverage.COMPLETE }
    }

    val groups = sections.mapNotNull { section ->
        val visible = section.entries.filter {
            !it.id.equals("sol", ignoreCase = true) && (it.id != "keep" || wallet != null && walletLinked)
        }.map { entry ->
            val observation = admitted(entry.id)
            val amount = observation?.amount ?: ResourceAmount.Unavailable("Refresh the current resource scope.")
            val decimal = hudAmountText(amount)
            val text = if (decimal == "…" || decimal == "—") decimal else exactAmount(decimal, decimals = 0)
            val action = entry.action?.takeIf {
                !entry.actionLabel.isNullOrBlank() && observation != null &&
                    (it in observation.earnedAt || it in observation.spentAt)
            }
            ResourceRowUi(
                id = entry.id,
                icon = observation?.icon?.takeIf { it.isNotBlank() } ?: entry.icon,
                name = entry.name,
                value = text,
                purpose = entry.purpose,
                earnedAt = entry.earnedAt,
                earnedAtFeature = observation?.earnedAt?.distinct()?.singleOrNull(),
                goIcon = entry.goIcon,
                empty = amount is ResourceAmount.Known && decimal == "0",
                divine = entry.divine,
                action = action,
                actionLabel = entry.actionLabel?.takeIf { action != null },
            )
        }
        if (visible.isEmpty()) null else ResourceGroupUi(
            section.id, section.icon, section.title, section.note,
            go = section.go?.takeIf { destination ->
                visible.any { row -> admitted(row.id)?.earnedAt?.contains(destination) == true }
            },
            rows = drawerSnapshot(visible), layout = section.layout,
        )
    }
    val ids = groups.flatMap { it.rows }.map { it.id }.toSet()
    return ResourceDrawerUi(groups = drawerSnapshot(groups), focusRowId = focusRowId?.takeIf { it in ids })
}

private fun <T> drawerSnapshot(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
