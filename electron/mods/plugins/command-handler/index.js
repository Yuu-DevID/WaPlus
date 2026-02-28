// Plugin: Command Handler
// Menangani perintah custom via prefix !
"use strict"

const startTime = Date.now()

const commands = {
  // !ping → Pong
  ping: async (args, parsed, ctx) => {
    await ctx.sendText(parsed.chat_jid, "🏓 Pong!")
  },

  // !uptime → Berapa lama app sudah berjalan
  uptime: async (args, parsed, ctx) => {
    const ms   = Date.now() - startTime
    const secs = Math.floor(ms / 1000)
    const mins = Math.floor(secs / 60)
    const hrs  = Math.floor(mins / 60)
    await ctx.sendText(parsed.chat_jid,
      `⏱ Uptime: ${hrs}h ${mins % 60}m ${secs % 60}s`
    )
  },

  // !info → Info tentang app
  info: async (args, parsed, ctx) => {
    await ctx.sendText(parsed.chat_jid,
      `ℹ️ *WaPlus* — WhatsApp Desktop Custom\n` +
      `📦 Plugin System aktif\n` +
      `👤 Chat: ${parsed.chat_jid}`
    )
  },

  // !echo <teks> → Echo balik teks
  echo: async (args, parsed, ctx) => {
    if (!args.length) return ctx.sendText(parsed.chat_jid, "Usage: !echo <teks>")
    await ctx.sendText(parsed.chat_jid, args.join(" "))
  },

  // !help → List semua command
  help: async (args, parsed, ctx) => {
    const list = Object.keys(commands).map(cmd => `• !${cmd}`).join("\n")
    await ctx.sendText(parsed.chat_jid, `🤖 *Commands tersedia:*\n${list}`)
  },
}

module.exports = {
  async onLoad(ctx) {
    ctx.log(`Command Handler ready — ${Object.keys(commands).length} command(s)`)
  },

  async onMessage(parsed, rawMsg, ctx) {
    if (parsed.from_me) return
    if (!parsed.body)   return

    const PREFIX = "!"
    if (!parsed.body.startsWith(PREFIX)) return

    const parts   = parsed.body.slice(PREFIX.length).trim().split(/\s+/)
    const cmdName = parts[0].toLowerCase()
    const args    = parts.slice(1)

    if (!commands[cmdName]) return

    ctx.log(`Command: !${cmdName} [${args.join(", ")}] from ${parsed.sender_jid}`)
    try {
      await commands[cmdName](args, parsed, ctx)
    } catch (e) {
      ctx.logE(`Command !${cmdName} error:`, e.message)
      await ctx.sendText(parsed.chat_jid, `❌ Error: ${e.message}`)
    }

    // Return false agar pesan command tidak diproses lebih lanjut oleh plugin lain
    // (hapus baris ini jika ingin plugin lain juga bisa lihat pesan command)
    // return false
  },
}
