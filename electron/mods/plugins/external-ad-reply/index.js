// Plugin: External Ad Reply Injector
// Inject contextInfo.externalAdReply ke setiap pesan yang dikirim
// Hanya menyuntikkan field externalAdReply — tidak ada yang lain.
"use strict"

const DEFAULT_CONFIG = {
  title:                 "WaPlus",
  body:                  "Powered by WaPlus",
  thumbnailUrl:          "",
  sourceUrl:             "",
  mediaUrl:              "",
  mediaType:             1,
  renderLargerThumbnail: true,
  showAdAttribution:     true,
  containsAutoReply:     false,
}

let config = { ...DEFAULT_CONFIG }

// ─── Settings schema — dibaca UI untuk generate form otomatis ──
module.exports.settings = [
  {
    key:         "title",
    label:       "Title",
    description: "Judul yang muncul di banner ad reply",
    type:        "text",
    default:     DEFAULT_CONFIG.title,
  },
  {
    key:         "body",
    label:       "Body",
    description: "Subtitle / deskripsi di bawah title",
    type:        "text",
    default:     DEFAULT_CONFIG.body,
  },
  {
    key:         "thumbnailUrl",
    label:       "Thumbnail",
    description: "Gambar thumbnail banner (URL atau upload gambar)",
    type:        "image",
    default:     DEFAULT_CONFIG.thumbnailUrl,
  },
  {
    key:         "sourceUrl",
    label:       "Source URL",
    description: "URL yang dibuka saat banner di-tap",
    type:        "url",
    default:     DEFAULT_CONFIG.sourceUrl,
  },
  {
    key:         "mediaUrl",
    label:       "Media URL",
    description: "URL media yang dilampirkan ke ad reply",
    type:        "url",
    default:     DEFAULT_CONFIG.mediaUrl,
  },
  {
    key:         "mediaType",
    label:       "Media Type",
    description: "Tipe media thumbnail",
    type:        "select",
    options:     [{ value: 1, label: "Image" }, { value: 2, label: "Video" }],
    default:     DEFAULT_CONFIG.mediaType,
  },
  {
    key:         "renderLargerThumbnail",
    label:       "Render Larger Thumbnail",
    description: "Tampilkan thumbnail ukuran besar",
    type:        "boolean",
    default:     DEFAULT_CONFIG.renderLargerThumbnail,
  },
  {
    key:         "showAdAttribution",
    label:       "Show Ad Attribution",
    description: "Tampilkan label iklan pada banner",
    type:        "boolean",
    default:     DEFAULT_CONFIG.showAdAttribution,
  },
  {
    key:         "containsAutoReply",
    label:       "Contains Auto Reply",
    description: "Tandai sebagai pesan auto reply",
    type:        "boolean",
    default:     DEFAULT_CONFIG.containsAutoReply,
  },
]

module.exports.onLoad = async function(ctx) {
  const saved = ctx.storage.get("config")
  if (saved) config = { ...DEFAULT_CONFIG, ...saved }
  ctx.log(`External Ad Reply Injector loaded — title: "${config.title}"`)
}

module.exports.onUnload = async function(ctx) {
  ctx.log("External Ad Reply Injector unloaded")
}

// Hot-reload config saat disimpan dari UI
module.exports.onConfigChange = async function(newValues, ctx) {
  config = { ...DEFAULT_CONFIG, ...newValues }
  ctx.log(`Config updated — title: "${config.title}"`)
}

module.exports.onBeforeSend = async function(jid, payload, ctx) {
  const externalAdReply = {
    containsAutoReply:     config.containsAutoReply,
    mediaType:             Number(config.mediaType) || 1,
    renderLargerThumbnail: config.renderLargerThumbnail,
    showAdAttribution:     config.showAdAttribution,
    title:                 config.title,
    body:                  config.body,
  }

  if (config.mediaUrl)     externalAdReply.mediaUrl     = config.mediaUrl
  if (config.sourceUrl)    externalAdReply.sourceUrl    = config.sourceUrl
  if (config.thumbnailUrl) externalAdReply.thumbnailUrl = config.thumbnailUrl

  payload.contextInfo = {
    ...(payload.contextInfo || {}),
    externalAdReply,
  }

  ctx.log(`Injected externalAdReply → ${jid}`)
  return payload
}
