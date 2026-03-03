// Plugin: Forwarded Score Injector
// Inject HANYA contextInfo.forwardingScore ke setiap pesan yang dikirim
// Pisah dari newsletter-forward agar bisa dikontrol independen
"use strict"

const DEFAULT_CONFIG = {
  forwardingScore: 999,
}

let config = { ...DEFAULT_CONFIG }

// ─── Settings schema ────────────────────────────────────────
module.exports.settings = [
  {
    key:         "forwardingScore",
    label:       "Forwarding Score",
    description: "Angka berapa kali pesan diteruskan (misal: 999 = banyak forward)",
    type:        "number",
    min:         0,
    max:         9999,
    default:     DEFAULT_CONFIG.forwardingScore,
  },
]

module.exports.onLoad = async function(ctx) {
  const saved = ctx.storage.get("config")
  if (saved) config = { ...DEFAULT_CONFIG, ...saved }
  ctx.log(`Forwarded Score Injector loaded — score: ${config.forwardingScore}`)
}

module.exports.onUnload = async function(ctx) {
  ctx.log("Forwarded Score Injector unloaded")
}

module.exports.onConfigChange = async function(newValues, ctx) {
  config = { ...DEFAULT_CONFIG, ...newValues }
  ctx.log(`Config updated — forwardingScore: ${config.forwardingScore}`)
}

module.exports.onBeforeSend = async function(jid, payload, ctx) {
  payload.contextInfo = {
    ...(payload.contextInfo || {}),
    forwardingScore: Number(config.forwardingScore) || 0,
  }

  ctx.log(`Injected forwardingScore: ${config.forwardingScore} → ${jid}`)
  return payload
}
