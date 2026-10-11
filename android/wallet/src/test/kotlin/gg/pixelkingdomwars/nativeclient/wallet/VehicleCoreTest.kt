package gg.pixelkingdomwars.nativeclient.wallet

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehicleCoreTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-client-current.json")).readText()).jsonObject
    private val rows = fixture.getValue("variants").jsonArray.map { it.jsonObject }
    private fun text(v: JsonObject, k: String) = v.getValue(k).jsonPrimitive.content
    private fun check(name: String) {
        val row = rows.single { text(it,"name") == name }
        val result = runCatching {
            val asset = row.getValue("assetDataHex").let { if (it == JsonNull) null else vehicleHex(it.jsonPrimitive.content,1,65536) }
            VehicleCore.eligible(asset,vehicleHex(text(row,"collectionDataHex"),1,65536),
                text(fixture,"wallet"),text(fixture.getValue("identity").jsonObject,"collection"))
        }
        when (text(row,"expected")) {
            "eligible" -> assertEquals(name,true,result.getOrThrow())
            "ineligible", "absent" -> assertEquals(name,false,result.getOrThrow())
            else -> assertTrue("Unsupported raw Core state must hold: $name",result.isFailure)
        }
    }
    @Test fun `plain uncompressed asset has the original owner and collection`() = check("plain")
    @Test fun `missing burned asset is never eligible`() = check("absent-asset")
    @Test fun `another NFT owner cannot approve the original burn`() = check("other-owner")
    @Test fun `collection permanent freeze is inherited`() = check("inherited-permanent-freeze")
    @Test fun `asset plugin overrides exactly the same inherited type`() = check("asset-overrides-same-inherited-freeze")
    @Test fun `different inherited freeze still prevents consent`() = check("different-inherited-freeze-remains")
    @Test fun `transient transfer delegate presence blocks even authority None`() = check("asset-transfer-delegate-none")
    @Test fun `collection transient transfer delegate also blocks`() = check("inherited-transfer-delegate-address")
    @Test fun `permanent transfer delegate is not the transient listing signal`() = check("permanent-transfer-is-not-transient-delegate")
    @Test fun `burn delegate does not replace original owner`() = check("burn-delegates-do-not-replace-owner")
    @Test fun `canonical empty registry remains supported`() = check("empty-registry")
    @Test fun `noncanonical boolean holds`() = check("noncanonical-freeze-bool")
    @Test fun `unknown plugin holds`() = check("unknown-registry-plugin")
    @Test fun `registry cannot relabel plugin bytes`() = check("registry-payload-mismatch")
    @Test fun `duplicate plugin types cannot shadow each other`() = check("duplicate-plugin-type")
    @Test fun `trailing account data holds`() = check("trailing-data")
    @Test fun `registry count is bounded before allocation`() = check("huge-registry-count")
    @Test fun `unexplained gaps cannot conceal plugins`() = check("plugin-offset-gap")
    @Test fun `known but unsupported blocker holds`() = check("known-unsupported-add-blocker")
    @Test fun `external adapters are never silently ignored`() = check("external-adapter-count")
    @Test fun `wrong plugin header is not an empty registry`() = check("wrong-header-key")
}
