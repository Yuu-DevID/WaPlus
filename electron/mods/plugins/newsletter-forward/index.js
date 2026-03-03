// Plugin: Newsletter Forward Injector
// Inject contextInfo.forwardedNewsletterMessageInfo ke setiap pesan yang dikirim
"use strict"

const DEFAULT_CONFIG = {
  newsletterJid:   "",
  newsletterName:  "Hai saya menggunakan WhatsApp!",
  serverMessageId: null,
  forwardingScore: 999,
  isForwarded:     true,
}

let config = { ...DEFAULT_CONFIG }

module.exports.settings = [
  {
    key:         "newsletterJid",
    label:       "Newsletter JID",
    description: "JID channel/newsletter. Format: 120363xxxxxxxxxx@newsletter",
    type:        "text",
    placeholder: "120363xxxxxxxxxx@newsletter",
    default:     DEFAULT_CONFIG.newsletterJid,
  },
  {
    key:         "newsletterName",
    label:       "Newsletter Name",
    description: "Nama channel yang ditampilkan",
    type:        "text",
    default:     DEFAULT_CONFIG.newsletterName,
  },
  {
    key:         "serverMessageId",
    label:       "Server Message ID",
    description: "ID pesan server (opsional, bisa dikosongkan)",
    type:        "number",
    nullable:    true,
    default:     DEFAULT_CONFIG.serverMessageId,
  },
  {
    key:         "forwardingScore",
    label:       "Forwarding Score",
    description: "Angka berapa kali pesan diteruskan",
    type:        "number",
    min:         0,
    max:         9999,
    default:     DEFAULT_CONFIG.forwardingScore,
  },
  {
    key:         "isForwarded",
    label:       "Is Forwarded",
    description: "Tampilkan badge \"Forwarded\" pada pesan",
    type:        "boolean",
    default:     DEFAULT_CONFIG.isForwarded,
  },
]

module.exports.onLoad = async function(ctx) {
  const saved = ctx.storage.get("config")
  if (saved) config = { ...DEFAULT_CONFIG, ...saved }
  ctx.log(`Newsletter Forward Injector loaded — jid: "${config.newsletterJid || '(belum diset)'}"`)
}

module.exports.onUnload = async function(ctx) {
  ctx.log("Newsletter Forward Injector unloaded")
}

module.exports.onConfigChange = async function(newValues, ctx) {
  config = { ...DEFAULT_CONFIG, ...newValues }
  ctx.log(`Config updated — newsletterJid: "${config.newsletterJid}"`)
}

module.exports.onBeforeSend = async function(jid, payload, ctx) {
  payload.contextInfo = {
    ...(payload.contextInfo || {}),
    forwardedNewsletterMessageInfo: {
      newsletterJid:   config.newsletterJid  || undefined,
      newsletterName:  config.newsletterName || undefined,
      serverMessageId: config.serverMessageId ?? null,
    },
    forwardingScore: Number(config.forwardingScore) || 0,
    isForwarded:     config.isForwarded,
  }

  ctx.log(`Injected forwardedNewsletterMessageInfo → ${jid}`)
  return payload
}
