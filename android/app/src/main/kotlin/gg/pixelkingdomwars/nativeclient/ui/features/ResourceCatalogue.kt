package gg.pixelkingdomwars.nativeclient.ui.features

import java.math.BigDecimal
import java.math.BigInteger
import java.util.Collections

enum class ResourceUnit { BASE_UNITS, DECIMAL }
sealed interface ResourceAmount {
    data object Loading : ResourceAmount
    data object Absent : ResourceAmount
    data class Unavailable(val reason: String) : ResourceAmount
    data class Known(val value: String, val decimals: Int, val unit: ResourceUnit = ResourceUnit.BASE_UNITS) : ResourceAmount
}

enum class ResourceBalanceKind { SPENDABLE, CLAIMABLE, HELD, PROGRESSION }
enum class ResourceCoverage { COMPLETE, PARTIAL }
data class ResourceScope(val wallet: String? = null, val baseId: String? = null, val subject: String? = null)
data class ResourceRow(val id: String, val icon: String, val amount: ResourceAmount,
    val earnedAt: List<FeatureId>, val spentAt: List<FeatureId>,
    val kind: ResourceBalanceKind = ResourceBalanceKind.SPENDABLE, val scope: ResourceScope? = null,
    val coverage: ResourceCoverage = ResourceCoverage.COMPLETE)
enum class ResourceCostStatus { CHECKING, UNAVAILABLE, OK, SERVER_ZERO, SHORT }

/** Display comparison of already-authoritative quantities only; never spend admission or a quote request. */
data class ActionResourceCost(val resourceId: String, val required: ResourceAmount, val available: ResourceAmount) {
    val status: ResourceCostStatus get() {
        val price=required as? ResourceAmount.Known
        val needed=price?.baseUnits()
        if(required is ResourceAmount.Unavailable || price!=null && needed==null)return ResourceCostStatus.UNAVAILABLE
        if(needed==BigInteger.ZERO)return ResourceCostStatus.SERVER_ZERO
        if(required==ResourceAmount.Loading || available==ResourceAmount.Loading)return ResourceCostStatus.CHECKING
        val balance=available as? ResourceAmount.Known ?: return ResourceCostStatus.UNAVAILABLE
        val held=balance.baseUnits() ?: return ResourceCostStatus.UNAVAILABLE
        if(price==null || needed==null || price.decimals!=balance.decimals)return ResourceCostStatus.UNAVAILABLE
        return if(held<needed)ResourceCostStatus.SHORT else ResourceCostStatus.OK
    }
    val shortfallBaseUnits: String? get() {
        val price=required as? ResourceAmount.Known ?: return null
        val balance=available as? ResourceAmount.Known ?: return null
        if(price.decimals!=balance.decimals)return null
        val needed=price.baseUnits() ?: return null
        val held=balance.baseUnits() ?: return null
        return (needed-held).max(BigInteger.ZERO).toString()
    }
}
data class ActionResourceQuote(val featureId: FeatureId, val costs: List<ActionResourceCost>, val reference: String? = null)

private fun ResourceAmount.Known.baseUnits(): BigInteger? = runCatching {
    require(decimals in 0..255 && value.length in 1..256)
    when(unit) {
        ResourceUnit.BASE_UNITS -> { require(value.matches(Regex("0|[1-9][0-9]*")));value.toBigInteger() }
        ResourceUnit.DECIMAL -> {
            require(value.matches(Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")))
            val number=BigDecimal(value);require(number.scale()<=decimals)
            number.movePointRight(decimals).toBigIntegerExact()
        }
    }
}.getOrNull()

internal fun resourceAmountSnapshot(value: ResourceAmount): ResourceAmount =
    if(value is ResourceAmount.Known && value.baseUnits()==null)ResourceAmount.Unavailable("The current quantity is unavailable.") else value
internal fun <T> resourceList(values: Collection<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
internal fun ResourceRow.resourceSnapshot(): ResourceRow = copy(amount=resourceAmountSnapshot(amount),earnedAt=resourceList(earnedAt),spentAt=resourceList(spentAt))
internal fun ActionResourceQuote.resourceSnapshot(): ActionResourceQuote = copy(costs=resourceList(costs.map {
    it.copy(required=resourceAmountSnapshot(it.required),available=resourceAmountSnapshot(it.available))
}))
internal val retiredResourceAmount=ResourceAmount.Unavailable("Refresh the current account's resource state.")
