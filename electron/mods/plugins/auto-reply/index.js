// Plugin: Auto Reply
// Balas pesan otomatis berdasarkan keyword yang dikonfigurasi
"use strict"

// Default rules jika storage kosong
const DEFAULT_RULES = [
  { keyword: "halo",    reply: "Halo! Ada yang bisa saya bantu? 👋",         exact: false },
  { keyword: "ping",    reply: "Pong! 🏓",                                    exact: true  },
  { keyword: "info",    reply: "Ini adalah WaPlus — WhatsApp Desktop custom", exact: true  },
]

let rules = []

module.exports = {
  async onLoad(ctx) {
    rules = ctx.storage.get("rules") || DEFAULT_RULES
    ctx.log(`Auto Reply loaded — ${rules.length} rule(s) aktif`)
  },

  async onUnload(ctx) {
    ctx.log("Auto Reply unloaded")
  },

  async onMessage(parsed, rawMsg, ctx) {
    // Hanya balas pesan yang bukan dari saya dan punya body
    if (parsed.from_me)  return
    if (!parsed.body)    return

    const body = parsed.body.toLowerCase().trim()

    for (const rule of rules) {
      const keyword = rule.keyword.toLowerCase()
      const match   = rule.exact
        ? body === keyword
        : body.includes(keyword)

      if (match) {
        ctx.log(`Keyword matched: "${rule.keyword}" → sending reply`)
        // Kirim balasan ke chat yang sama
        await ctx.sendText(parsed.chat_jid, rule.reply)
        return // Hanya apply rule pertama yang match
      }
    }
  },
}
