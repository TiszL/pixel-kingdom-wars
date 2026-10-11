package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.migration.MigrationProtocol
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.*

/** Existing-clan purpose-5 registration uses the authentic registration original.
 * It never manufactures a funded creation envelope or a second SHARDS reservation. */
object MigrationTransaction {
 suspend fun prepare(migration:JsonObject,trust:CharterSigningTrust,actor:String,policy:CharterCryptoPolicy):PreparedCharter {
  val m=MigrationProtocol.migration(migration);require(m.charterText("actor")==actor)
  val signing=requireNotNull(m.charterOptional("signing"));require(signing.charterText("kind")=="creation"&&signing["original"]==m["original"])
  return CharterTransaction.prepare(signing,trust,actor,policy)
 }
 suspend fun verifyWire(migration:JsonObject,trust:CharterSigningTrust,wire:JsonObject,policy:CharterCryptoPolicy):JsonObject {
  val m=MigrationProtocol.migration(migration);prepare(m,trust,m.charterText("actor"),policy)
  return CharterTransaction.verifyWire(m.charterObject("signing"),trust,wire,policy)
 }
 fun toWire(prepared:PreparedCharter,signed:SignedCharter):JsonObject {
  require(prepared.kind=="creation");val checked=prepared.verifySignedBase64(signed.wire);require(checked==signed)
  val bytes=Base64.getDecoder().decode(checked.wire)
  return buildJsonObject{put("signedTransaction",checked.wire);put("signature",requireNotNull(checked.transactionSignature));put("wireSha256",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)});put("messageSha256",prepared.messageSha256)}
 }
}
