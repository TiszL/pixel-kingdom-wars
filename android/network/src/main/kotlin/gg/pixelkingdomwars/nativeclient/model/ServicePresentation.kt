package gg.pixelkingdomwars.nativeclient.model

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticBaseRead
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticVisualBuilding
import java.util.Collections
import kotlinx.serialization.json.*

/** Art permission is separate from construction and accepted obligations. */
data class PhaseEArtCapability(val version: Int, val enabled: Boolean) {
    companion object {
        fun from(value: JsonElement): PhaseEArtCapability {
            val raw = ServiceWire.objectOf(value, "version", "enabled")
            ServiceWire.version(raw)
            val enabled = raw["enabled"] as? JsonPrimitive
            require(enabled != null && !enabled.isString && enabled.booleanOrNull != null)
            return PhaseEArtCapability(1, enabled.boolean)
        }
        fun optional(value: JsonElement?): PhaseEArtCapability? = ServiceWire.optional(value, ::from)
    }
}

enum class StarterPresence { OCCUPIED, AWAY }
data class StarterPresentation(val family: String, val presence: StarterPresence)
data class BerthPresentation(val buildingId: String, val installation: StarterPresentation?)
data class BaseServicePresentation(val version: Int, val berths: List<BerthPresentation>) {
    companion object {
        /** Same strict version, sorted identity closure and private-field refusal as the shared contract. */
        fun from(value: JsonElement, buildings: JsonArray): BaseServicePresentation {
            val expected = ServiceWire.identities(buildings, setOf("berth"))
            val raw = ServiceWire.objectOf(value, "version", "berths")
            ServiceWire.version(raw)
            val rows = ServiceWire.rows(raw, "berths", expected)
            val berths = rows.mapIndexed { index, value ->
                val row = ServiceWire.objectOf(value, "buildingId", "installation")
                val id = ServiceWire.identity(row, expected[index].first)
                val installation = when (val value = row.getValue("installation")) {
                    JsonNull -> null
                    else -> {
                        val installed = ServiceWire.objectOf(value, "family", "presence")
                        require(ServiceWire.text(installed["family"]) == "starter")
                        val presence = when (ServiceWire.text(installed["presence"])) {
                            "occupied" -> StarterPresence.OCCUPIED
                            "away" -> StarterPresence.AWAY
                            else -> error("Unsupported starter presence")
                        }
                        StarterPresentation("starter", presence)
                    }
                }
                BerthPresentation(id, installation)
            }
            return BaseServicePresentation(1, Collections.unmodifiableList(berths))
        }
        fun optional(value: JsonElement?, owner: JsonObject?): BaseServicePresentation? = ServiceWire.optional(value) {
            from(it, requireNotNull(owner?.get("buildings") as? JsonArray))
        }
    }
}

enum class AdvancedPresence { OCCUPIED, AWAY, EXHAUSTED }
data class AdvancedInstallationPresentation(val family: String, val tier: Int, val presence: AdvancedPresence)
data class AdvancedBerthPresentation(val buildingId: String, val installation: AdvancedInstallationPresentation?)
/** Current or frozen advanced facts; each entry binds its own building closure.
 * Null installation says nothing about a starter. */
data class AdvancedServicePresentation(val version: Int, val berths: List<AdvancedBerthPresentation>) {
    companion object {
        /** Historical originals only: initial construction is never a frozen berth. */
        fun from(value: JsonElement, buildings: JsonArray): AdvancedServicePresentation = parse(value, buildings, current = false)

        private fun parse(value: JsonElement, buildings: JsonArray, current: Boolean): AdvancedServicePresentation {
            val expected = ServiceWire.identities(buildings, setOf("berth"))
            val owners = buildings.map { it.jsonObject }.filter { ServiceWire.text(it["type"]) == "berth" }
                .associateBy { ServiceWire.text(it["id"]) }
            val raw = ServiceWire.objectOf(value, "version", "berths")
            ServiceWire.version(raw)
            val installedFamilies = HashSet<String>()
            val berths = ServiceWire.rows(raw, "berths", expected).mapIndexed { index, value ->
                val row = ServiceWire.objectOf(value, "buildingId", "installation")
                val id = ServiceWire.identity(row, expected[index].first)
                val owner = owners.getValue(id)
                val underConstruction = owner["underConstruction"]?.let { flag ->
                    require(flag is JsonPrimitive && !flag.isString && flag.booleanOrNull != null) { "Invalid berth construction flag" }
                    flag.boolean
                } ?: false
                // Current initial-build sites stay in the identity closure, but
                // cannot claim an installation. Historical acceptance stays strict.
                require(!underConstruction || (current && row.getValue("installation") == JsonNull)) { "Berth is not completed" }
                val installation = when (val installed = row.getValue("installation")) {
                    JsonNull -> null
                    else -> {
                        val fields = ServiceWire.objectOf(installed, "family", "tier", "presence")
                        val family = ServiceWire.text(fields["family"])
                        require(family in setOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge") && installedFamilies.add(family))
                        // The four values are the version1 wire vocabulary, not an economic cap.
                        val tier = requireNotNull((fields["tier"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
                        require(tier in 1..4)
                        val level = requireNotNull((owner["level"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull)
                        require(level >= 1) { "Installed advanced fleet requires an original completed berth" }
                        val presence = when (ServiceWire.text(fields["presence"])) {
                            "occupied" -> AdvancedPresence.OCCUPIED
                            "away" -> AdvancedPresence.AWAY
                            "exhausted" -> AdvancedPresence.EXHAUSTED
                            else -> error("Unsupported advanced presence")
                        }
                        AdvancedInstallationPresentation(family, tier, presence)
                    }
                }
                AdvancedBerthPresentation(id, installation)
            }
            return AdvancedServicePresentation(1, Collections.unmodifiableList(berths))
        }
        fun optional(value: JsonElement?, snapshot: JsonObject?): AdvancedServicePresentation? = ServiceWire.optional(value) {
            from(it, requireNotNull(snapshot?.get("buildings") as? JsonArray))
        }
        fun optionalCurrent(value: JsonElement?, owner: JsonObject?): AdvancedServicePresentation? = ServiceWire.optional(value) {
            parse(it, requireNotNull(owner?.get("buildings") as? JsonArray), current = true)
        }
    }
}

enum class ServiceActivityState { IDLE, WORKING, READY }
data class ServiceActivity(val buildingId: String, val state: ServiceActivityState)
/** Idle means no authorized activity animation, not gameplay availability. */
data class BaseServiceActivity(val version: Int, val services: List<ServiceActivity>) {
    companion object {
        fun from(value: JsonElement, buildings: JsonArray): BaseServiceActivity {
            // Wire vocabulary only. Economic values and availability never live here.
            val expected = ServiceWire.identities(buildings, setOf("workshop", "lodge", "market", "harvester"))
            val raw = ServiceWire.objectOf(value, "version", "services")
            ServiceWire.version(raw)
            val rows = ServiceWire.rows(raw, "services", expected)
            val services = rows.mapIndexed { index, value ->
                val row = ServiceWire.objectOf(value, "buildingId", "state")
                val id = ServiceWire.identity(row, expected[index].first)
                val state = when (ServiceWire.text(row["state"])) {
                    "idle" -> ServiceActivityState.IDLE
                    "working" -> ServiceActivityState.WORKING
                    "ready" -> ServiceActivityState.READY
                    else -> error("Unsupported service activity")
                }
                require(state != ServiceActivityState.READY || expected[index].second == "workshop")
                require(expected[index].second != "market" || state == ServiceActivityState.IDLE)
                ServiceActivity(id, state)
            }
            return BaseServiceActivity(1, Collections.unmodifiableList(services))
        }
        fun optional(value: JsonElement?, owner: JsonObject?): BaseServiceActivity? = ServiceWire.optional(value) {
            from(it, requireNotNull(owner?.get("buildings") as? JsonArray))
        }
    }
}

/** Optional additive facts fail closed independently. Unknown metadata must not retain
 * an older positive permission through the app's same-base scene recovery path.
 *
 * [boundCosmetics] (renderer16 / C4): the server's current (`boundCosmetics`) or frozen
 * (`boundCosmeticVisual`) Awning projection, matched against the SAME building list.
 * Null = the field is absent (legacy original / older server): ordinary Market art.
 * An unparseable or mismatched projection is kept as `unavailable`: ordinary art, never
 * a claimed "off", and never a partial application. The completed-Market tier rule is
 * INJECTED by the app from the exported catalogue; this module owns no tier table. */
data class BaseServiceFacts(val phaseEArt: PhaseEArtCapability?, val presentation: BaseServicePresentation?, val activity: BaseServiceActivity?,
    val boundCosmetics: BoundCosmeticBaseRead? = null,
    val advancedPresentation: AdvancedServicePresentation? = null) {
    companion object {
        fun current(base: JsonObject, completedMarketOutput: ((Long) -> String)? = null) = BaseServiceFacts(
            PhaseEArtCapability.optional((base["features"] as? JsonObject)?.get("phaseEArt")),
            BaseServicePresentation.optional(base["servicePresentation"], base),
            BaseServiceActivity.optional(base["serviceActivity"], base),
            boundCosmetics(base["boundCosmetics"], base["buildings"], completedMarketOutput),
            AdvancedServicePresentation.optionalCurrent(base["advancedServicePresentation"], base))
        /** The envelope owns frozen berth facts. Never recover them from an inner snapshot,
         * current home, current activity, or a guessed default installation. The frozen
         * Awning projection likewise rides the envelope and is matched against the frozen
         * snapshot's (completed) rows, never today's preference. */
        fun frozen(envelope: JsonObject, snapshot: JsonObject?, completedMarketOutput: ((Long) -> String)? = null) = BaseServiceFacts(null,
            BaseServicePresentation.optional(envelope["servicePresentation"], snapshot), null,
            boundCosmetics(envelope["boundCosmeticVisual"], snapshot?.get("buildings"), completedMarketOutput),
            AdvancedServicePresentation.optional(envelope["advancedServicePresentation"], snapshot))
        private val unavailable = BoundCosmeticBaseRead("unavailable", null)
        internal fun boundCosmetics(value: JsonElement?, buildings: JsonElement?, completedMarketOutput: ((Long) -> String)?): BoundCosmeticBaseRead? {
            if (value == null) return null
            return try {
                val read = BoundCosmeticBaseRead.from(requireNotNull(value as? JsonObject))
                val rows = requireNotNull(buildings as? JsonArray).map { raw ->
                    val row = requireNotNull(raw as? JsonObject)
                    val level = requireNotNull(row["level"] as? JsonPrimitive).also { require(!it.isString) }.long
                    val construction = (row["underConstruction"] as? JsonPrimitive)?.let { require(!it.isString); it.boolean } ?: false
                    BoundCosmeticVisualBuilding(ServiceWire.text(row["id"]), ServiceWire.text(row["type"]), level, construction)
                }
                // The rule is consulted only for rows that name an Awning: a verified-empty
                // visual needs no tier rule, an Awning without one can never be admitted.
                read.match(rows) { level -> requireNotNull(completedMarketOutput) { "No completed-Market tier rule was injected" }(level) }
                read
            } catch (_: IllegalArgumentException) { unavailable } catch (_: IllegalStateException) { unavailable } catch (_: NoSuchElementException) { unavailable }
        }
    }
}

private object ServiceWire {
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    fun objectOf(value: JsonElement, vararg keys: String): JsonObject = requireNotNull(value as? JsonObject).also {
        require(it.keys == keys.toSet()) { "Unexpected service presentation fields" }
    }
    fun text(value: JsonElement?): String = requireNotNull((value as? JsonPrimitive)?.takeIf { it.isString }?.content)
    fun version(raw: JsonObject) { require(raw["version"] == JsonPrimitive(1)) { "Unsupported service presentation version" } }
    fun identities(buildings: JsonArray, types: Set<String>): List<Pair<String, String>> {
        val expected = buildings.map { value ->
            val row = requireNotNull(value as? JsonObject)
            text(row["id"]) to text(row["type"])
        }.filter { it.second in types }.sortedBy { it.first }
        require(expected.all { uuid.matches(it.first) } && expected.map { it.first }.distinct().size == expected.size)
        return expected
    }
    fun rows(raw: JsonObject, key: String, expected: List<Pair<String, String>>): JsonArray =
        requireNotNull(raw[key] as? JsonArray).also { require(it.size == expected.size) { "Service identity closure differs" } }
    fun identity(raw: JsonObject, expected: String): String = text(raw["buildingId"]).also { require(it == expected) { "Service identity differs" } }
    fun <T> optional(value: JsonElement?, parse: (JsonElement) -> T): T? {
        if (value == null || value == JsonNull) return null
        return try { parse(value) } catch (_: IllegalArgumentException) { null } catch (_: IllegalStateException) { null }
    }
}
