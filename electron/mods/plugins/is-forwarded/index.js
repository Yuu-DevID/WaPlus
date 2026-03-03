// Plugin: Is Forwarded Injector
// Inject HANYA contextInfo.isForwarded ke setiap pesan yang dikirim
// Pisah dari newsletter-forward agar bisa dikontrol independen
"use strict"

const DEFAULT_CONFIG = {
  isForwarded: true,
}

let config = { ...DEFAULT_CONFIG }

// ─── Settings schema ────────────────────────────────────────
module.exports.settings = [
  {
    key:         "isForwarded",
    label:       "Is Forwarded",
    description: "Aktifkan untuk menampilkan badge \"Forwarded\" pada pesan",
    type:        "boolean",
    default:     DEFAULT_CONFIG.isForwarded,
  },
]

module.exports.onLoad = async function(ctx) {
  const saved = ctx.storage.get("config")
  if (saved) config = { ...DEFAULT_CONFIG, ...saved }
  ctx.log(`Is Forwarded Injector loaded — isForwarded: ${config.isForwarded}`)
}

module.exports.onUnload = async function(ctx) {
  ctx.log("Is Forwarded Injector unloaded")
}

module.exports.onConfigChange = async function(newValues, ctx) {
  config = { ...DEFAULT_CONFIG, ...newValues }
  ctx.log(`Config updated — isForwarded: ${config.isForwarded}`)
}

module.exports.onBeforeSend = async function(jid, payload, ctx) {
  payload.contextInfo = {
    ...(payload.contextInfo || {}),
    isForwarded: Boolean(config.isForwarded),
  }

  ctx.log(`Injected isForwarded: ${config.isForwarded} → ${jid}`)
  return payload
}
