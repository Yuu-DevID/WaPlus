// Plugin: Interactive Button Injector
// Inject interactiveButtons (cta_url) ke setiap pesan yang dikirim
// Menggunakan format Baileys: { text, title, subtitle, footer, interactiveButtons }
"use strict"

const DEFAULT_CONFIG = {
  enabled:      true,
  displayText:  "Kunjungi",
  url:          "https://google.com",
  title:        "",
  subtitle:     "",
  footer:       "",
  injectMode:   "append", // append = tambah ke payload teks, replace = jadikan interactive message tersendiri
}

let config = { ...DEFAULT_CONFIG }

// ─── Settings schema ────────────────────────────────────────
module.exports.settings = [
  {
    key:         "enabled",
    label:       "Aktifkan",
    description: "Aktifkan injeksi button ke pesan",
    type:        "boolean",
    default:     DEFAULT_CONFIG.enabled,
  },
  {
    key:         "displayText",
    label:       "Teks Button",
    description: "Tulisan yang muncul pada button (display_text)",
    type:        "text",
    placeholder: "Kunjungi",
    default:     DEFAULT_CONFIG.displayText,
  },
  {
    key:         "url",
    label:       "URL Button",
    description: "Link yang dibuka saat button di-tap",
    type:        "url",
    placeholder: "https://google.com",
    default:     DEFAULT_CONFIG.url,
  },
  {
    key:         "title",
    label:       "Title (opsional)",
    description: "Judul di atas pesan interactive",
    type:        "text",
    placeholder: "Kosongkan jika tidak perlu",
    default:     DEFAULT_CONFIG.title,
  },
  {
    key:         "subtitle",
    label:       "Subtitle (opsional)",
    description: "Subtitle di bawah title",
    type:        "text",
    placeholder: "Kosongkan jika tidak perlu",
    default:     DEFAULT_CONFIG.subtitle,
  },
  {
    key:         "footer",
    label:       "Footer (opsional)",
    description: "Teks kecil di bawah button",
    type:        "text",
    placeholder: "Kosongkan jika tidak perlu",
    default:     DEFAULT_CONFIG.footer,
  },
]

module.exports.onLoad = async function(ctx) {
  const saved = ctx.storage.get("config")
  if (saved) config = { ...DEFAULT_CONFIG, ...saved }
  ctx.log(`Interactive Button Injector loaded — url: "${config.url}"`)
}

module.exports.onUnload = async function(ctx) {
  ctx.log("Interactive Button Injector unloaded")
}

module.exports.onConfigChange = async function(newValues, ctx) {
  config = { ...DEFAULT_CONFIG, ...newValues }
  ctx.log(`Config updated — url: "${config.url}"`)
}

module.exports.onBeforeSend = async function(jid, payload, ctx) {
  if (!config.enabled) return payload

  // Tambahkan interactiveButtons ke payload
  payload.interactiveButtons = [
    {
      name: "cta_url",
      buttonParamsJson: JSON.stringify({
        display_text: config.displayText || "Kunjungi",
        url:          config.url         || "https://google.com",
      }),
    },
  ]

  // Inject title/subtitle/footer jika diisi
  if (config.title)    payload.title    = config.title
  if (config.subtitle) payload.subtitle = config.subtitle
  if (config.footer)   payload.footer   = config.footer

  ctx.log(`Injected interactiveButton (cta_url) → ${jid}`)
  return payload
}
