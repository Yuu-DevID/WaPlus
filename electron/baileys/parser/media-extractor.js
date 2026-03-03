"use strict"

const { getContentType } = require("wileys")

// ════════════════════════════════════════════════════════════
// MEDIA EXTRACTION
// ════════════════════════════════════════════════════════════

const MEDIA_TYPES = new Set([
  "imageMessage", "videoMessage", "audioMessage", "pttMessage",
  "documentMessage", "stickerMessage",
  "viewOnceMessage", "viewOnceMessageV2",
])

function hasMediaContent(msgType) {
  return MEDIA_TYPES.has(msgType)
}

/**
 * extractMediaInfo — extract info media: mimetype, fileSize, duration, url, dll.
 * Juga expose thumbnailDataUrl (data: URI) untuk instant preview di renderer.
 *
 * @param {object} message - raw WA message
 * @param {string} msgType - normalized msg type
 * @returns {object|null}
 */
function extractMediaInfo(message, msgType) {
  if (!message || !hasMediaContent(msgType)) return null

  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message

  let mediaObj = null
  let actualType = msgType

  switch (msgType) {
    case "imageMessage":
      mediaObj = m.imageMessage
      break
    case "videoMessage":
      mediaObj = m.videoMessage
      break
    case "audioMessage":
      mediaObj = m.audioMessage
      actualType = m.audioMessage?.ptt ? "pttMessage" : "audioMessage"
      break
    case "pttMessage":
      mediaObj = m.audioMessage || m.pttMessage
      actualType = "pttMessage"
      break
    case "documentMessage":
      mediaObj = m.documentWithCaptionMessage?.message?.documentMessage || m.documentMessage
      break
    case "stickerMessage":
      mediaObj = m.stickerMessage
      break
    case "viewOnceMessage": {
      const inner = m.viewOnceMessage?.message
      if (!inner) return null
      const t = getContentType(inner)
      mediaObj = inner[t]
      actualType = `viewOnce_${t}`
      break
    }
    case "viewOnceMessageV2": {
      const inner = m.viewOnceMessageV2?.message
      if (!inner) return null
      const t = getContentType(inner)
      mediaObj = inner[t]
      actualType = `viewOnce_${t}`
      break
    }
    default:
      return null
  }

  if (!mediaObj) return null

  // ── jpegThumbnail → base64 data URL ──────────────────────
  // Low-res JPEG preview embedded di setiap media message.
  // data: URI siap pakai untuk renderer tanpa tunggu download.
  let thumbnailDataUrl = null
  const rawThumb = mediaObj.jpegThumbnail
  if (rawThumb?.length > 0) {
    try {
      const buf = Buffer.isBuffer(rawThumb) ? rawThumb : Buffer.from(rawThumb)
      if (buf.length > 0) {
        // Detect WebP (RIFF header) vs JPEG
        const isWebp = buf[0] === 0x52 && buf[1] === 0x49
        const thumbMime = isWebp ? "image/webp" : "image/jpeg"
        thumbnailDataUrl = `data:${thumbMime};base64,${buf.toString("base64")}`
      }
    } catch (_) {}
  }

  return {
    actualType,
    mimetype:         mediaObj.mimetype    || null,
    fileSize:         mediaObj.fileLength  ? Number(mediaObj.fileLength) : null,
    duration:         mediaObj.seconds     || mediaObj.duration || null,
    fileName:         mediaObj.fileName    || null,
    width:            mediaObj.width       || null,
    height:           mediaObj.height      || null,
    url:              mediaObj.url         || null,
    // [FIX-MEDIA-CRYPTO] Store crypto fields needed for re-download when URL expires.
    // Baileys needs mediaKey + directPath (or url) + fileEncSha256 to reconstruct the download.
    mediaKey:         mediaObj.mediaKey    ? Buffer.from(mediaObj.mediaKey).toString("base64") : null,
    directPath:       mediaObj.directPath  || null,
    encSha256:        mediaObj.fileEncSha256 ? Buffer.from(mediaObj.fileEncSha256).toString("base64") : null,
    thumbnailDataUrl,
    isAnimated:       mediaObj.isAnimated  || false,
    isPtt:            actualType === "pttMessage",
    // [FIX-GIF] WA GIFs arrive as videoMessage with gifPlayback=true and mimetype=video/mp4.
    // gifAttribution (GIPHY/TENOR) is also a reliable GIF signal.
    // image/gif mimetype should never come from WA servers but handle it as a fallback
    // for locally-sourced files that bypass WA conversion.
    isGif:            msgType === "videoMessage" && (
                        mediaObj.gifPlayback === true ||
                        !!mediaObj.gifAttribution ||
                        mediaObj.mimetype === "image/gif"
                      ),
    isViewOnce:       msgType === "viewOnceMessage" || msgType === "viewOnceMessageV2",
  }
}

module.exports = { extractMediaInfo, hasMediaContent, MEDIA_TYPES }
