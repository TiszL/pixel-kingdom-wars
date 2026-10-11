package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.MailMessage
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.JsonObject

/** Mail UUID identifies one immutable escrow. A terminal receipt survives later deed sales and never
 * infers delivery from inventory, a balance or elapsed expiry time. Another client's claim reports
 * its actual destination; it cannot be mistaken for delivery to this intent's selected deed. */
object MailClaimSpec : MoneyOpSpec<MailMessage> {
    override val kind = IntentKind.MAIL_CLAIM
    /** The key IS the mail id: a reward still `pending` on `/mail/{id}` proves the claim was not applied, and a new claim
     * reuses the same id, so closing can never pay twice (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun receiptRequest(intent: PendingIntent) = ReceiptRequest("/mail/${intent.idempotencyKey}", emptyMap())
    private fun decode(intent: PendingIntent, raw: JsonObject): MailMessage = MailMessage.from(raw).also { message ->
        require(intent.path == "/mail/${intent.idempotencyKey}/claim" && message.id == intent.idempotencyKey)
        require(message.kind == "reward")
        val frozen = MailMessage.from(requireNotNull(intent.quote))
        require(frozen.id == message.id && frozen.attachments == message.attachments && frozen.createdAt == message.createdAt)
        require(intent.baseId == intent.body.string("baseId") && (intent.baseId != null) == message.needsBase)
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<MailMessage> {
        val message = try { decode(intent, response) } catch (_: Exception) { throw ApiCompatibilityException("/mail/${intent.idempotencyKey}") }
        return if (message.rewardState == "pending") Receipt.Unknown else Receipt.Accepted(message, ReceiptDocument.fromReceiptRoute(response))
    }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): MailMessage = decode(intent, response).also {
        require(it.rewardState == "claimed" || it.rewardState == "expired")
    }
    override fun restore(intent: PendingIntent, document: JsonObject) = acknowledge(intent, ReceiptDocument.payload(document))
}
