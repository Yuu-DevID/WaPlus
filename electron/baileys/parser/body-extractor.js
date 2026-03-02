"use strict"

const { getContentType } = require("wileys")

// ════════════════════════════════════════════════════════════
// BODY EXTRACTION
// ════════════════════════════════════════════════════════════

/**
 * extractBody — extract teks body dari semua tipe pesan.
 * Terinspirasi dari body parser di case.js + extractBody di client.js
 *
 * @param {object} message - raw WA message (sudah di-unwrap dari ephemeral jika ada)
 * @param {string} msgType - normalized msg type dari normalizeMsgType()
 * @returns {string}
 */
function extractBody(message, msgType) {
  if (!message) return ""

  // Unwrap wrapper layers
  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message

  switch (msgType) {
    // ── Text ──────────────────────────────────────────────
    case "conversation":
      return m.conversation || ""

    case "extendedTextMessage":
      return m.extendedTextMessage?.text || ""

    // ── Media dengan caption ───────────────────────────────
    case "imageMessage":
      return m.imageMessage?.caption || ""

    case "videoMessage":
      return m.videoMessage?.caption || ""

    case "documentMessage":
      return (
        m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        m.documentMessage?.caption ||
        m.documentMessage?.fileName ||
        ""
      )

    case "audioMessage":
      return m.audioMessage?.caption || ""

    case "stickerMessage":
      return ""

    // ── Location ───────────────────────────────────────────
    case "locationMessage":
      return m.locationMessage?.name
        || m.locationMessage?.address
        || `${m.locationMessage?.degreesLatitude ?? ""},${m.locationMessage?.degreesLongitude ?? ""}`

    case "liveLocationMessage":
      return m.liveLocationMessage?.caption
        || m.liveLocationMessage?.name
        || "Live Location"

    // ── Contact ────────────────────────────────────────────
    case "contactMessage":
      return m.contactMessage?.displayName || ""

    case "contactsArrayMessage": {
      const names = (m.contactsArrayMessage?.contacts || [])
        .map(c => c.displayName)
        .filter(Boolean)
      return names.join(", ")
    }

    // ── Poll ───────────────────────────────────────────────
    case "pollCreationMessage":
      return (
        m.pollCreationMessageV3?.name ||
        m.pollCreationMessageV2?.name ||
        m.pollCreationMessage?.name ||
        ""
      )

    case "pollUpdateMessage":
      return ""

    // ── Reaction ───────────────────────────────────────────
    case "reactionMessage":
      return m.reactionMessage?.text || ""

    // ── Group invite ───────────────────────────────────────
    case "groupInviteMessage":
      return m.groupInviteMessage?.groupName || m.groupInviteMessage?.caption || ""

    // ── Buttons (legacy) ──────────────────────────────────
    case "buttonsMessage":
      return m.buttonsMessage?.contentText || m.buttonsMessage?.text || ""

    case "buttonsResponseMessage":
      return (
        m.buttonsResponseMessage?.selectedButtonId ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        ""
      )

    // ── List (legacy) ──────────────────────────────────────
    case "listMessage":
      return m.listMessage?.description || m.listMessage?.title || ""

    case "listResponseMessage":
      return (
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.listResponseMessage?.title ||
        ""
      )

    // ── Template (legacy) ─────────────────────────────────
    case "templateMessage":
      return (
        m.templateMessage?.hydratedTemplate?.hydratedContentText ||
        m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
        ""
      )

    case "templateButtonReplyMessage":
      return (
        m.templateButtonReplyMessage?.selectedId ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        ""
      )

    // ── Interactive (new buttons/list) ─────────────────────
    case "interactiveMessage":
      return (
        m.interactiveMessage?.body?.text ||
        m.interactiveMessage?.header?.title ||
        ""
      )

    case "interactiveResponseMessage": {
      try {
        const params = JSON.parse(
          m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || "{}"
        )
        return params.id || params.title || ""
      } catch {
        return ""
      }
    }

    // ── Commerce ───────────────────────────────────────────
    case "orderMessage":
      return m.orderMessage?.message || `Order (${m.orderMessage?.itemCount ?? 0} items)`

    case "productMessage":
      return m.productMessage?.product?.title || "Produk"

    case "paymentMessage":
    case "requestPaymentMessage":
      return m.requestPaymentMessage?.noteMessage?.extendedTextMessage?.text
        || m.sendPaymentMessage?.noteMessage?.extendedTextMessage?.text
        || "Pembayaran"

    // ── ViewOnce ───────────────────────────────────────────
    case "viewOnceMessage":
    case "viewOnceMessageV2": {
      const inner = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      if (!inner) return ""
      const innerType = getContentType(inner)
      if (innerType === "imageMessage") return inner.imageMessage?.caption || ""
      if (innerType === "videoMessage") return inner.videoMessage?.caption || ""
      return ""
    }

    // ── Call log ───────────────────────────────────────────
    case "callLogMessage": {
      const cl = m.callLogMessage
      if (!cl) return "Panggilan"
      const kind = cl.isVideo ? "Video" : "Suara"
      const outcome = cl.callOutcome
      if (outcome === 2) return `Panggilan ${kind} Tak Terjawab`
      if (outcome === 4) return `Panggilan ${kind} Ditolak`
      if (cl.durationSecs) {
        const min = Math.floor(cl.durationSecs / 60)
        const sec = cl.durationSecs % 60
        const dur = min > 0 ? `${min}m ${sec}d` : `${sec}d`
        return `Panggilan ${kind} (${dur})`
      }
      return `Panggilan ${kind}`
    }

    // ── Scheduled call ─────────────────────────────────────
    case "scheduledCallCreationMessage": {
      const sc = m.scheduledCallCreationMessage
      if (!sc) return "Jadwal Panggilan"
      const title = sc.title ? `"${sc.title}" ` : ""
      return `Jadwal Panggilan ${title}dibuat`
    }

    case "scheduledCallEditMessage":
      return m.scheduledCallEditMessage?.title
        ? `Jadwal Panggilan "${m.scheduledCallEditMessage.title}" diubah`
        : "Jadwal Panggilan diubah"

    // ── Event ──────────────────────────────────────────────
    case "eventMessage": {
      const ev = m.eventMessage?.event || m.eventMessage
      if (!ev) return "Acara"
      const parts = [ev.name || "Acara"]
      if (ev.startTime) {
        const d = new Date(Number(ev.startTime) * 1000)
        parts.push(d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }))
      }
      if (ev.location?.name) parts.push(`📍 ${ev.location.name}`)
      return parts.join(" · ")
    }

    case "encEventUpdateMessage":
      return m.encEventUpdateMessage?.description || "Acara diperbarui"

    // ── Pin / Keep ─────────────────────────────────────────
    case "pinInChatMessage": {
      const pin = m.pinInChatMessage
      if (!pin) return "Pesan disematkan"
      return pin.type === 1 ? "Pesan disematkan" : "Pesan dilepas sematan"
    }

    case "keepInChatMessage": {
      const keep = m.keepInChatMessage
      if (!keep) return "Pesan disimpan"
      return keep.keepType === 1 ? "Pesan disimpan" : "Pesan tidak disimpan"
    }

    // ── Newsletter ─────────────────────────────────────────
    case "newsletterAdminInviteMessage":
      return m.newsletterAdminInviteMessage?.newsletterName || "Undangan Newsletter"

    // ── Album ──────────────────────────────────────────────
    case "albumMessage": {
      const album = m.albumMessage
      const imgCount = album?.expectedImageCount || 0
      const vidCount = album?.expectedVideoCount || 0
      const total = imgCount + vidCount
      if (total === 0) return "Album"
      return vidCount > 0 ? `Album (${total} media)` : `Album (${total} foto)`
    }

    // ── Encrypted comment ──────────────────────────────────
    case "encCommentMessage":
      return m.encCommentMessage?.text || "Komentar"

    // ── Status mention ─────────────────────────────────────
    case "statusMentionMessage": {
      const count = m.statusMentionMessage?.message?.length || 0
      return count > 0 ? "Menyebut status Anda" : "Status"
    }

    // ── Group mentioned ────────────────────────────────────
    case "groupMentionedMessage":
      return m.groupMentionedMessage?.text || "Grup disebutkan"

    // ── Business call ──────────────────────────────────────
    case "bcallMessage":
      return m.bcallMessage?.isVideo ? "Panggilan Video Bisnis" : "Panggilan Bisnis"

    // ── Placeholder ────────────────────────────────────────
    case "placeholderMessage":
      return m.placeholderMessage?.type != null
        ? "Pesan tidak didukung"
        : "Pesan tidak tersedia"

    // ── Bot invoke ─────────────────────────────────────────
    case "botInvokeMessage":
      return m.botInvokeMessage?.message?.conversation
        || m.botInvokeMessage?.message?.extendedTextMessage?.text
        || "Bot"

    // ── Encrypted reaction ─────────────────────────────────
    case "encReactionMessage":
      return m.encReactionMessage?.encPayload ? "Reaksi" : ""

    // ── Invoice / catalog ──────────────────────────────────
    case "invoiceMessage":
      return m.invoiceMessage?.title || m.invoiceMessage?.description || "Invoice"

    case "productCatalogMessage":
      return m.productCatalogMessage?.product?.title || m.productCatalogMessage?.product?.description || "Katalog Produk"

    // ── Payment invite ─────────────────────────────────────
    case "paymentInviteMessage":
      return m.paymentInviteMessage?.serviceType != null ? "Tautan Pembayaran" : "Undangan Pembayaran"

    // ── Native flow ────────────────────────────────────────
    case "nativeFlowMessage": {
      const nf = m.nativeFlowMessage || m.interactiveMessage?.nativeFlowMessage
      return nf?.name || nf?.buttonParamsJson ? "Formulir Interaktif" : ""
    }

    default:
      return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.caption ||
        ""
      )
  }
}

module.exports = { extractBody }
