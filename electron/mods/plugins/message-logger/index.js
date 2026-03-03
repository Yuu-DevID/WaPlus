// Plugin: Message Logger
// Log semua pesan masuk ke file log
"use strict"

const fs   = require("fs")
const path = require("path")

let logPath = null
let logStream = null
let msgCount = 0

module.exports = {
  async onLoad(ctx) {
    const logDir = path.join(__dirname, "logs")
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

    const date = new Date().toISOString().slice(0, 10)
    logPath   = path.join(logDir, `messages_${date}.log`)
    logStream = fs.createWriteStream(logPath, { flags: "a" })
    msgCount  = 0

    ctx.log(`Message Logger ready → ${logPath}`)
  },

  async onUnload(ctx) {
    if (logStream) {
      logStream.end()
      logStream = null
    }
    ctx.log(`Message Logger stopped — logged ${msgCount} messages`)
  },

  async onMessage(parsed, rawMsg, ctx) {
    if (!logStream) return

    const ts      = new Date(parsed.timestamp * 1000).toISOString()
    const dir     = parsed.from_me ? "OUT" : "IN "
    const sender  = parsed.from_me ? "Me" : (parsed.pushname || parsed.sender_jid)
    const chat    = parsed.chat_jid
    const body    = parsed.body || `[${parsed.msg_type}]`

    const line = `[${ts}] [${dir}] [${chat}] ${sender}: ${body}\n`
    logStream.write(line)
    msgCount++
  },

  async onConnect(info, ctx) {
    if (logStream) {
      const ts = new Date().toISOString()
      logStream.write(`\n[${ts}] === CONNECTED as ${info.name} (${info.phone}) ===\n`)
    }
  },

  async onDisconnect(reason, ctx) {
    if (logStream) {
      const ts = new Date().toISOString()
      logStream.write(`[${ts}] === DISCONNECTED: ${reason} ===\n`)
    }
  },
}
