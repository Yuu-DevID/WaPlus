// Plugin: Business Message Injector
// Inject contextInfo.businessMessageForwardInfo ke setiap pesan yang dikirim
"use strict"

const DEFAULT_CONFIG = {
  businessOwnerJid: "",
}

let config = { ...DEFAULT_CONFIG }

module.exports.settings = [
  {
    key:         "businessOwnerJid",
    label:       "Business Owner JID",
    description: "JID akun bisnis pemilik forward. Format: 628xxxxxxxxxx@s.whatsapp.net",
    type:        "text",
    placeholder: "628xxxxxxxxxx@s.whatsapp.net",
    default:     DEFAULT_CONFIG.businessOwnerJid,
  },
]

module.exports.onLoad = async function(ctx) {
  const saved = ctx.storage.get("config")
  if (saved) config = { ...DEFAULT_CONFIG, ...saved }
  ctx.log(`Business Message Injector loaded — jid: "${config.businessOwnerJid || '(belum diset)'}"`)
}

module.exports.onUnload = async function(ctx) {
  ctx.log("Business Message Injector unloaded")
}

module.exports.onConfigChange = async function(newValues, ctx) {
  config = { ...DEFAULT_CONFIG, ...newValues }
  ctx.log(`Config updated — businessOwnerJid: "${config.businessOwnerJid}"`)
}

module.exports.onBeforeSend = async function(jid, payload, ctx) {
  payload.contextInfo = {
    ...(payload.contextInfo || {}),
    businessMessageForwardInfo: {
      businessOwnerJid: config.businessOwnerJid || undefined,
    },
  }

  ctx.log(`Injected businessMessageForwardInfo → ${jid}`)
  return payload
}
