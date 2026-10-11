export { registerMailRoutes, type MailRouteDeps } from './routes';
export {
  adminKeepCampaignPolicyFromConfig, adminRewardMailContentHash, archiveMail,
  broadcastAdminInfoMail, claimMailReward, deliverAdminMail, deliverSystemMail,
  expireDueMailRewards, getMail, getMailStatus, listMail, mailDeliveryEnabled,
  markMailRead,
  type AdminKeepCampaignPolicy, type MailAttachmentInput, type MailClaimAuthority,
  type MailDeliveryInput,
} from './service';
