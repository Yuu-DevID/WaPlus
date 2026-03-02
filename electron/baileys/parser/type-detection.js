"use strict"

const { getContentType } = require("wileys")

// ════════════════════════════════════════════════════════════
// TYPE DETECTION
// ════════════════════════════════════════════════════════════

/**
 * getRealContentType — unwrap semua layer wrapper (ephemeral, viewOnce, dll)
 * dan return tipe konten asli.
 */
function getRealContentType(message) {
  if (!message) return null

  if (message.ephemeralMessage?.message)
    return getRealContentType(message.ephemeralMessage.message)

  if (message.viewOnceMessage?.message) {
    const inner = message.viewOnceMessage.message
    const t = getContentType(inner)
    return t ? `viewOnceMessage:${t}` : "viewOnceMessage"
  }

  if (message.viewOnceMessageV2?.message) {
    const inner = message.viewOnceMessageV2.message
    const t = getContentType(inner)
    return t ? `viewOnceMessageV2:${t}` : "viewOnceMessageV2"
  }

  if (message.documentWithCaptionMessage?.message?.documentMessage)
    return "documentMessage"

  if (message.highlyStructuredMessage) return "templateMessage"
  if (message.interactiveResponseMessage) return "interactiveResponseMessage"

  return getContentType(message) || null
}

// Alias map: raw proto type → canonical DB type
const TYPE_ALIASES = {
  conversation:                      "conversation",
  extendedTextMessage:               "extendedTextMessage",
  imageMessage:                      "imageMessage",
  videoMessage:                      "videoMessage",
  audioMessage:                      "audioMessage",
  pttMessage:                        "pttMessage",
  documentMessage:                   "documentMessage",
  documentWithCaptionMessage:        "documentMessage",
  stickerMessage:                    "stickerMessage",
  locationMessage:                   "locationMessage",
  liveLocationMessage:               "liveLocationMessage",
  contactMessage:                    "contactMessage",
  contactsArrayMessage:              "contactsArrayMessage",
  pollCreationMessage:               "pollCreationMessage",
  pollCreationMessageV2:             "pollCreationMessage",
  pollCreationMessageV3:             "pollCreationMessage",
  pollUpdateMessage:                 "pollUpdateMessage",
  reactionMessage:                   "reactionMessage",
  groupInviteMessage:                "groupInviteMessage",
  buttonsMessage:                    "buttonsMessage",
  buttonsResponseMessage:            "buttonsResponseMessage",
  listMessage:                       "listMessage",
  listResponseMessage:               "listResponseMessage",
  templateMessage:                   "templateMessage",
  templateButtonReplyMessage:        "templateButtonReplyMessage",
  interactiveMessage:                "interactiveMessage",
  interactiveResponseMessage:        "interactiveResponseMessage",
  orderMessage:                      "orderMessage",
  productMessage:                    "productMessage",
  paymentMessage:                    "paymentMessage",
  requestPaymentMessage:             "requestPaymentMessage",
  sendPaymentMessage:                "sendPaymentMessage",
  declinePaymentRequestMessage:      "paymentMessage",
  cancelPaymentRequestMessage:       "paymentMessage",
  callLogMessage:                    "callLogMessage",
  scheduledCallCreationMessage:      "scheduledCallCreationMessage",
  scheduledCallEditMessage:          "scheduledCallEditMessage",
  eventMessage:                      "eventMessage",
  keepInChatMessage:                 "keepInChatMessage",
  pinInChatMessage:                  "pinInChatMessage",
  newsletterAdminInviteMessage:      "newsletterAdminInviteMessage",
  protocolMessage:                   "protocol",
  messageContextInfo:                "messageContextInfo",
  ephemeralMessage:                  "ephemeral",
  viewOnceMessage:                   "viewOnceMessage",
  viewOnceMessageV2:                 "viewOnceMessageV2",
  albumMessage:                      "albumMessage",
  encCommentMessage:                 "encCommentMessage",
  statusMentionMessage:              "statusMentionMessage",
  groupMentionedMessage:             "groupMentionedMessage",
  bcallMessage:                      "bcallMessage",
  placeholderMessage:                "placeholderMessage",
  encEventUpdateMessage:             "encEventUpdateMessage",
  botInvokeMessage:                  "botInvokeMessage",
  encReactionMessage:                "encReactionMessage",
  messageHistoryBundle:              "messageHistoryBundle",
  invoiceMessage:                    "invoiceMessage",
  productCatalogMessage:             "productCatalogMessage",
  paymentInviteMessage:              "paymentInviteMessage",
  callToAction:                      "callToAction",
  nativeFlowMessage:                 "nativeFlowMessage",
}

/**
 * normalizeMsgType — normalize raw proto type ke canonical type yang disimpan di DB.
 */
function normalizeMsgType(rawType) {
  if (!rawType) return "unknown"

  if (rawType.startsWith("viewOnceMessage:"))  return "viewOnceMessage"
  if (rawType.startsWith("viewOnceMessageV2:")) return "viewOnceMessageV2"

  return TYPE_ALIASES[rawType] || rawType
}

module.exports = { getRealContentType, normalizeMsgType, TYPE_ALIASES }
