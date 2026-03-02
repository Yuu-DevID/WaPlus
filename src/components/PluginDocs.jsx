// src/components/PluginDocs.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Plugin Context API Documentation Panel
// Muncul sebagai panel "?/Docs" di dalam ModManager.
//
// Menjelaskan semua yang tersedia di `ctx` object yang di-inject ke setiap plugin:
//   - Properties: ctx.sock, ctx.pluginId
//   - Methods: ctx.sendText, ctx.sendImage, ctx.sendVideo, ctx.sendAudio
//   - DB access: ctx.getDB()
//   - UI bridge: ctx.sendToUI()
//   - Logging: ctx.log, ctx.logE, ctx.logW
//   - Storage: ctx.storage.*
//   - Baileys: ctx.baileys
//   - require: ctx.require() (sandboxed)
//   - Hook signatures & return value semantics
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from "react"

// ── Syntax highlight helper (no deps) ─────────────────────────────────────
function Code({ children, lang = "js" }) {
  return (
    <pre style={{
      background: "rgba(0,0,0,0.35)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 8,
      padding: "10px 14px",
      fontSize: 12,
      lineHeight: 1.7,
      overflowX: "auto",
      margin: "6px 0 0",
      color: "#e2e8f0",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    }}>
      <code>{children}</code>
    </pre>
  )
}

function Badge({ color = "#3fb950", children }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 7px",
      borderRadius: 4,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: 0.4,
      background: color + "22",
      border: `1px solid ${color}55`,
      color,
    }}>
      {children}
    </span>
  )
}

function Section({ title, icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 10,
      overflow: "hidden",
      marginBottom: 8,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", background: "rgba(255,255,255,0.03)",
          border: "none", cursor: "pointer", textAlign: "left",
          color: "var(--text-1)",
        }}
      >
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{title}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0deg)", flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div style={{ padding: "4px 14px 14px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {children}
        </div>
      )}
    </div>
  )
}

function ApiRow({ name, type, desc, example, returns }) {
  return (
    <div style={{
      padding: "10px 0",
      borderBottom: "1px solid rgba(255,255,255,0.05)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
        <code style={{ color: "#79c0ff", fontSize: 12.5, fontWeight: 700, fontFamily: "monospace" }}>{name}</code>
        {type && <Badge color="#a78bfa">{type}</Badge>}
        {returns && <Badge color="#3fb950">→ {returns}</Badge>}
      </div>
      <p style={{ margin: "3px 0", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>{desc}</p>
      {example && <Code>{example}</Code>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK SIGNATURES DATA
// ─────────────────────────────────────────────────────────────────────────────
const HOOK_DOCS = [
  {
    id: "onLoad",
    emoji: "🚀",
    color: "#3fb950",
    sig: "async onLoad(ctx)",
    desc: "Dipanggil sekali saat plugin diaktifkan atau WaPlus startup. Gunakan untuk inisialisasi state, interval/timer, atau membaca config awal dari ctx.storage.",
    example: `async onLoad(ctx) {
  ctx.log("Plugin loaded!")
  const cfg = await ctx.storage.get("config") || {}
  ctx.log("Config saat ini:", JSON.stringify(cfg))
}`,
    note: null,
  },
  {
    id: "onUnload",
    emoji: "🛑",
    color: "#f85149",
    sig: "async onUnload(ctx)",
    desc: "Dipanggil saat plugin dinonaktifkan atau WaPlus shutdown. Gunakan untuk bersihkan timer, koneksi, atau resource.",
    example: `async onUnload(ctx) {
  ctx.log("Cleanup...")
  // clearInterval(myTimer) jika kamu set interval di onLoad
}`,
    note: null,
  },
  {
    id: "onMessage",
    emoji: "💬",
    color: "#58a6ff",
    sig: "async onMessage(parsed, rawMsg, ctx)",
    desc: "Dipanggil setiap pesan masuk/keluar. Return false untuk blokir pesan dari di-save ke DB. Return object untuk modifikasi parsed sebelum disimpan.",
    example: `async onMessage(parsed, rawMsg, ctx) {
  // parsed: {
  //   id, chat_jid, sender_jid, sender_name,
  //   body, msg_type, from_me, timestamp,
  //   has_media, quoted_id, is_group, ...
  // }
  // rawMsg: Baileys WAMessage proto object mentah

  if (!parsed.from_me && parsed.body?.includes("halo")) {
    ctx.log("Ada yang bilang halo dari", parsed.sender_jid)
    // return false   → pesan tidak disimpan ke DB
    // return {...parsed, body: "MODIFIED"} → modifikasi sebelum save
  }
}`,
    note: "⚠️ Hati-hati dengan return false — pesan tidak akan muncul di UI sama sekali.",
  },
  {
    id: "onBeforeSend",
    emoji: "📤",
    color: "#f0883e",
    sig: "async onBeforeSend(jid, payload, ctx)",
    desc: "Dipanggil sebelum pesan dikirim via ctx.sendText / ctx.sendImage / sock.sendMessage. Return false untuk batalkan pengiriman. Return modified payload untuk injeksi konten.",
    example: `async onBeforeSend(jid, payload, ctx) {
  // payload: Baileys message content object
  // contoh: { text: "halo" } atau { image: {...}, caption: "..." }

  // Injeksi footer ke semua pesan teks
  if (payload.text) {
    return { ...payload, text: payload.text + "\\n\\n_Sent via WaPlus_" }
  }
  return payload  // ← wajib return payload (atau modifikasi-nya)
  // return false  → batalkan pengiriman
}`,
    note: "⚠️ Pesan yang dikirim lewat ctx.sendText TIDAK melewati onBeforeSend plugin lain. Hanya berlaku untuk pesan dari MessageInput / user manual.",
  },
  {
    id: "onAfterSend",
    emoji: "✅",
    color: "#3fb950",
    sig: "async onAfterSend(jid, payload, sentMsg, ctx)",
    desc: "Dipanggil setelah pesan berhasil terkirim. sentMsg adalah response dari Baileys sendMessage (berisi key.id, dll).",
    example: `async onAfterSend(jid, payload, sentMsg, ctx) {
  ctx.log("Pesan terkirim ke", jid, "ID:", sentMsg?.key?.id)
}`,
    note: null,
  },
  {
    id: "onConnect",
    emoji: "🟢",
    color: "#3fb950",
    sig: "async onConnect(info, ctx)",
    desc: "Dipanggil saat WhatsApp berhasil terhubung / reconnect.",
    example: `async onConnect(info, ctx) {
  // info: { name, jid, phone, platform, ... }
  ctx.log("Connected sebagai", info.name, "-", info.jid)
}`,
    note: null,
  },
  {
    id: "onDisconnect",
    emoji: "🔴",
    color: "#f85149",
    sig: "async onDisconnect(reason, ctx)",
    desc: "Dipanggil saat koneksi WhatsApp terputus.",
    example: `async onDisconnect(reason, ctx) {
  ctx.log("Disconnected, reason:", reason)
}`,
    note: null,
  },
  {
    id: "onConfigChange",
    emoji: "⚙️",
    color: "#a78bfa",
    sig: "async onConfigChange(newValues, ctx)",
    desc: "Dipanggil ketika user menyimpan settings plugin di ModManager. newValues berisi semua field settings saat ini.",
    example: `async onConfigChange(newValues, ctx) {
  ctx.log("Config baru:", JSON.stringify(newValues))
  // Biasanya simpan ke storage supaya onLoad bisa baca
  await ctx.storage.set("config", newValues)
}`,
    note: null,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DOCS COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

// ── Internal: scrollable docs content sections ──────────────────────────────
function DocsScrollBody({ q }) {
  return (
    <>
        {/* ── ctx PROPERTIES ────────────────────────────────────────── */}
          {(!q || "sock socket baileys pluginid".includes(q)) && (
            <Section title="Properties" icon="🔌" defaultOpen={!q}>
              <ApiRow name="ctx.sock" type="property" returns="BaileysSocket | null"
                desc="Full Baileys WebSocket instance. Sama persis dengan sock yang digunakan di client.js. Semua Baileys API tersedia."
                example={`// Kirim pesan raw
await ctx.sock.sendMessage("628xxx@s.whatsapp.net", { text: "halo" })

// Cek status koneksi
const state = ctx.sock.ws?.readyState  // 1 = OPEN

// Subscribe ke events (jarang diperlukan, gunakan hook onMessage)
ctx.sock.ev.on("messages.upsert", ({ messages }) => {
  for (const msg of messages) ctx.log(msg.key.id)
})`}
              />
              <ApiRow name="ctx.pluginId" type="property" returns="string"
                desc="ID unik plugin ini (misal: 'auto-reply', 'my-custom-plugin'). Digunakan untuk namespacing storage dan logging."
                example={`ctx.log("Plugin ID:", ctx.pluginId) // → [Plugin:auto-reply] Plugin ID: auto-reply`}
              />
              <ApiRow name="ctx.baileys" type="property" returns="BaileysModule"
                desc="Export langsung dari modul 'wileys' (Baileys fork). Berguna untuk akses ke constants, proto helpers, dll."
                example={`const { proto, jidDecode, areJidsSameUser } = ctx.baileys
const decoded = jidDecode("628xxx@s.whatsapp.net")
ctx.log(decoded.user, decoded.server)`}
              />
            </Section>
          )}

          {/* ── SEND HELPERS ─────────────────────────────────────────── */}
          {(!q || "send text image video audio kirim".includes(q)) && (
            <Section title="Send Helpers" icon="📨" defaultOpen={!q}>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 8, padding: "6px 10px", background: "rgba(37,211,102,0.06)", borderRadius: 6, borderLeft: "3px solid rgba(37,211,102,0.4)" }}>
                ⚠️ Pesan yang dikirim via helpers ini <strong>tidak melewati onBeforeSend</strong> plugin lain.
                Jika kamu butuh hook chain penuh, pakai <code style={{ color: "#79c0ff" }}>ctx.sock.sendMessage()</code> langsung.
              </div>
              <ApiRow name="ctx.sendText(jid, text)" type="method" returns="Promise"
                desc="Kirim pesan teks ke JID. Shortcut untuk sock.sendMessage(jid, { text })."
                example={`await ctx.sendText("628xxx@s.whatsapp.net", "Halo dari plugin!")`}
              />
              <ApiRow name="ctx.sendImage(jid, img, caption?)" type="method" returns="Promise"
                desc="Kirim gambar. img bisa berupa string URL/path atau Buffer. caption opsional."
                example={`// Dari URL
await ctx.sendImage("628xxx@s.whatsapp.net", "https://example.com/img.jpg", "Caption")

// Dari file path (pakai ctx.require untuk fs)
const fs = ctx.require("fs")
const buf = fs.readFileSync("/path/to/img.jpg")
await ctx.sendImage("628xxx@s.whatsapp.net", buf, "Foto")`}
              />
              <ApiRow name="ctx.sendVideo(jid, vid, caption?)" type="method" returns="Promise"
                desc="Kirim video. vid bisa string URL/path atau Buffer."
                example={`await ctx.sendVideo("628xxx@s.whatsapp.net", "https://example.com/video.mp4", "Video")`}
              />
              <ApiRow name="ctx.sendAudio(jid, aud, ptt?)" type="method" returns="Promise"
                desc="Kirim audio. Set ptt=true untuk kirim sebagai Voice Note (PTT). Default ptt=false."
                example={`// Kirim sebagai audio biasa
await ctx.sendAudio("628xxx@s.whatsapp.net", audioBuffer)

// Kirim sebagai voice note
await ctx.sendAudio("628xxx@s.whatsapp.net", ogg_buffer, true)`}
              />
            </Section>
          )}

          {/* ── DATABASE ─────────────────────────────────────────────── */}
          {(!q || "db database sqlite getdb".includes(q)) && (
            <Section title="Database Access" icon="🗄️">
              <ApiRow name="ctx.getDB()" type="method" returns="DatabaseModule | null"
                desc="Mengambil instance database module (better-sqlite3 via wrapper). Semua query methods tersedia. Returns null jika database tidak tersedia."
                example={`const db = ctx.getDB()
if (!db) return ctx.logE("DB tidak tersedia")

// Query messages
const msgs = db.getMessages("628xxx@s.whatsapp.net", { limit: 10 })

// Query kontak
const contact = db.getContact("628xxx@s.whatsapp.net")

// Custom query (gunakan dengan hati-hati!)
const raw = db.db.prepare("SELECT * FROM messages WHERE body LIKE ?").all("%keyword%")`}
              />
            </Section>
          )}

          {/* ── UI BRIDGE ─────────────────────────────────────────────── */}
          {(!q || "ui renderer sendtoui ipc".includes(q)) && (
            <Section title="UI / Renderer Bridge" icon="🖥️">
              <ApiRow name="ctx.sendToUI(channel, data)" type="method" returns="void"
                desc="Kirim pesan ke renderer (React UI) via Electron IPC. Di renderer, gunakan window.api.on(channel, handler) untuk menerima."
                example={`// Di plugin (main process)
ctx.sendToUI("plugin:notification", {
  type: "success",
  message: "Auto-reply terkirim ke 628xxx",
  timestamp: Date.now(),
})

// Di renderer React
useEffect(() => {
  const unsub = window.api.on("plugin:notification", (data) => {
    console.log("Notif dari plugin:", data)
  })
  return () => unsub()
}, [])`}
              />
            </Section>
          )}

          {/* ── LOGGING ──────────────────────────────────────────────── */}
          {(!q || "log logging debug error warn".includes(q)) && (
            <Section title="Logging" icon="📝">
              <ApiRow name="ctx.log(...args)" type="method"
                desc='Log info ke console. Otomatis di-prefix dengan "[Plugin:pluginId]".'
                example={`ctx.log("Pesan diproses:", parsed.body) // → [Plugin:auto-reply] Pesan diproses: halo`}
              />
              <ApiRow name="ctx.logE(...args)" type="method"
                desc='Log error ke console. Prefix "[Plugin:pluginId][ERR]".'
                example={`ctx.logE("Gagal kirim:", err.message) // → [Plugin:auto-reply][ERR] Gagal kirim: ...`}
              />
              <ApiRow name="ctx.logW(...args)" type="method"
                desc='Log warning ke console. Prefix "[Plugin:pluginId][WARN]".'
                example={`ctx.logW("Koneksi lambat, retry ke-", retryCount)`}
              />
            </Section>
          )}

          {/* ── STORAGE ──────────────────────────────────────────────── */}
          {(!q || "storage persist save data".includes(q)) && (
            <Section title="Per-Plugin Storage" icon="💾">
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 8, padding: "6px 10px", background: "rgba(88,166,255,0.06)", borderRadius: 6, borderLeft: "3px solid rgba(88,166,255,0.4)" }}>
                Data disimpan ke <code style={{ color: "#79c0ff" }}>electron/mods/plugins/[pluginId]/data.json</code>. Persistent antar restart.
              </div>
              <ApiRow name="ctx.storage.get(key)" type="async method" returns="Promise<any>"
                desc="Baca nilai dari storage plugin. Returns undefined jika key tidak ada."
                example={`const config = await ctx.storage.get("config")
const counter = (await ctx.storage.get("counter")) || 0`}
              />
              <ApiRow name="ctx.storage.set(key, value)" type="async method" returns="Promise<void>"
                desc="Simpan nilai ke storage. value bisa berupa string, number, object, array."
                example={`await ctx.storage.set("config", { keyword: "halo", reply: "Halo juga!" })
await ctx.storage.set("counter", counter + 1)`}
              />
              <ApiRow name="ctx.storage.delete(key)" type="async method" returns="Promise<void>"
                desc="Hapus satu key dari storage."
                example={`await ctx.storage.delete("old_cache")`}
              />
              <ApiRow name="ctx.storage.getAll()" type="async method" returns="Promise<object>"
                desc="Ambil semua data storage plugin sebagai satu object."
                example={`const all = await ctx.storage.getAll()
ctx.log("Semua data:", JSON.stringify(all))`}
              />
              <ApiRow name="ctx.storage.clear()" type="async method" returns="Promise<void>"
                desc="Hapus semua data storage plugin (reset ke {})."
                example={`await ctx.storage.clear()
ctx.log("Storage direset")`}
              />
            </Section>
          )}

          {/* ── REQUIRE SANDBOX ──────────────────────────────────────── */}
          {(!q || "require sandbox module fs path crypto".includes(q)) && (
            <Section title="Sandboxed require()" icon="📦">
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 8, padding: "6px 10px", background: "rgba(240,136,62,0.08)", borderRadius: 6, borderLeft: "3px solid rgba(240,136,62,0.4)" }}>
                🔒 <strong>Security:</strong> ctx.require() hanya mengizinkan modul Node.js built-in yang aman.
                Modul berbahaya seperti <code style={{ color: "#f85149" }}>child_process</code>, <code style={{ color: "#f85149" }}>http</code>, <code style={{ color: "#f85149" }}>net</code> diblokir.
              </div>
              <ApiRow name="ctx.require(moduleName)" type="method" returns="NodeModule"
                desc="Akses Node.js built-in module. Modul yang diizinkan: path, fs, crypto, os, url, util, events, stream, buffer, querystring."
                example={`const path   = ctx.require("path")
const fs     = ctx.require("fs")
const crypto = ctx.require("crypto")

// Contoh: baca file dari folder plugin sendiri
const pluginDir = path.join(process.cwd(), "electron/mods/plugins", ctx.pluginId)
const data = fs.readFileSync(path.join(pluginDir, "replies.json"), "utf8")
const replies = JSON.parse(data)

// Contoh: hash teks
const hash = crypto.createHash("sha256").update("test").digest("hex")`}
              />
            </Section>
          )}

          {/* ── HOOK SIGNATURES ──────────────────────────────────────── */}
          {(!q || "hook signature onload onmessage onbeforesend onaftersend onconnect ondisconnect onconfigchange".includes(q)) && (
            <Section title="Hook Signatures & Return Values" icon="🪝" defaultOpen={false}>
              {HOOK_DOCS.filter(h => !q || h.id.toLowerCase().includes(q) || h.desc.toLowerCase().includes(q)).map(h => (
                <div key={h.id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16 }}>{h.emoji}</span>
                    <code style={{ color: h.color, fontSize: 13, fontWeight: 700, fontFamily: "monospace" }}>{h.sig}</code>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>{h.desc}</p>
                  {h.note && (
                    <div style={{ fontSize: 11.5, color: "#f0883e", padding: "4px 10px", background: "rgba(240,136,62,0.08)", borderRadius: 6, borderLeft: "3px solid rgba(240,136,62,0.4)", margin: "4px 0" }}>
                      {h.note}
                    </div>
                  )}
                  <Code>{h.example}</Code>
                </div>
              ))}
            </Section>
          )}

          {/* ── FULL EXAMPLE PLUGIN ──────────────────────────────────── */}
          {(!q || "example contoh plugin template".includes(q)) && (
            <Section title="Contoh Plugin Lengkap" icon="💡">
              <p style={{ fontSize: 12.5, color: "var(--text-2)", margin: "4px 0 8px" }}>
                Plugin auto-reply sederhana yang merespons kata kunci tertentu:
              </p>
              <Code>{`// electron/mods/plugins/my-bot/index.js
// manifest.json: { "id": "my-bot", "hooks": ["onLoad","onMessage","onConfigChange"] }

const DEFAULT_CFG = { keyword: "ping", reply: "pong!" }

module.exports = {
  async onLoad(ctx) {
    const cfg = await ctx.storage.get("config") || DEFAULT_CFG
    ctx.log("Ready! Keyword:", cfg.keyword)
  },

  async onMessage(parsed, rawMsg, ctx) {
    // Hanya proses pesan masuk (bukan dari diri sendiri)
    if (parsed.from_me) return

    const cfg = await ctx.storage.get("config") || DEFAULT_CFG

    if (parsed.body?.toLowerCase() === cfg.keyword.toLowerCase()) {
      await ctx.sendText(parsed.chat_jid, cfg.reply)
      ctx.log("Auto-replied ke", parsed.sender_jid)
    }
  },

  async onConfigChange(newValues, ctx) {
    await ctx.storage.set("config", newValues)
    ctx.log("Config updated:", newValues.keyword, "→", newValues.reply)
  },
}`}</Code>
            </Section>
          )}


    </>
  )
}

// Inline mode: muncul langsung sebagai konten tab di SettingsModal
// Modal mode (onClose prop): muncul sebagai overlay terpisah (deprecated, tetap didukung)
export default function PluginDocs({ onClose, inline = false }) {
  const [search, setSearch] = useState("")

  const q = search.toLowerCase()

  // Inline mode — langsung render sebagai panel di dalam SettingsModal (tanpa overlay)
  if (inline || !onClose) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0, minHeight: 0 }}>
        {/* Search bar */}
        <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cari API, hook, method..."
            style={{
              flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 7, padding: "6px 10px", fontSize: 12.5, color: "var(--text-1)",
              outline: "none",
            }}
          />
          <div style={{ fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>ctx API v10</div>
        </div>
        <DocsScrollBody q={q} />
      </div>
    )
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9998,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }} onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={{
        width: "100%", maxWidth: 740, maxHeight: "90vh",
        background: "var(--bg-2, #1a1f2e)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 14, overflow: "hidden",
        display: "flex", flexDirection: "column",
        boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
      }}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{
          padding: "14px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8,
            background: "rgba(37,211,102,0.12)",
            border: "1px solid rgba(37,211,102,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 17,
          }}>📚</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)" }}>Plugin Context API</div>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>
              Semua yang tersedia di objek <code style={{ color: "#79c0ff" }}>ctx</code> dalam setiap hook plugin
            </div>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cari API..."
            style={{
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 7, padding: "5px 10px", fontSize: 12.5, color: "var(--text-1)",
              width: 160, outline: "none",
            }}
          />
          <button onClick={onClose} style={{
            background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 7, width: 30, height: 30, cursor: "pointer", color: "var(--text-2)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>

          {/* ── ctx PROPERTIES ────────────────────────────────────────── */}
          {(!q || "sock socket baileys pluginid".includes(q)) && (
            <Section title="Properties" icon="🔌" defaultOpen={!q}>
              <ApiRow name="ctx.sock" type="property" returns="BaileysSocket | null"
                desc="Full Baileys WebSocket instance. Sama persis dengan sock yang digunakan di client.js. Semua Baileys API tersedia."
                example={`// Kirim pesan raw
await ctx.sock.sendMessage("628xxx@s.whatsapp.net", { text: "halo" })

// Cek status koneksi
const state = ctx.sock.ws?.readyState  // 1 = OPEN

// Subscribe ke events (jarang diperlukan, gunakan hook onMessage)
ctx.sock.ev.on("messages.upsert", ({ messages }) => {
  for (const msg of messages) ctx.log(msg.key.id)
})`}
              />
              <ApiRow name="ctx.pluginId" type="property" returns="string"
                desc="ID unik plugin ini (misal: 'auto-reply', 'my-custom-plugin'). Digunakan untuk namespacing storage dan logging."
                example={`ctx.log("Plugin ID:", ctx.pluginId) // → [Plugin:auto-reply] Plugin ID: auto-reply`}
              />
              <ApiRow name="ctx.baileys" type="property" returns="BaileysModule"
                desc="Export langsung dari modul 'wileys' (Baileys fork). Berguna untuk akses ke constants, proto helpers, dll."
                example={`const { proto, jidDecode, areJidsSameUser } = ctx.baileys
const decoded = jidDecode("628xxx@s.whatsapp.net")
ctx.log(decoded.user, decoded.server)`}
              />
            </Section>
          )}

          {/* ── SEND HELPERS ─────────────────────────────────────────── */}
          {(!q || "send text image video audio kirim".includes(q)) && (
            <Section title="Send Helpers" icon="📨" defaultOpen={!q}>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 8, padding: "6px 10px", background: "rgba(37,211,102,0.06)", borderRadius: 6, borderLeft: "3px solid rgba(37,211,102,0.4)" }}>
                ⚠️ Pesan yang dikirim via helpers ini <strong>tidak melewati onBeforeSend</strong> plugin lain.
                Jika kamu butuh hook chain penuh, pakai <code style={{ color: "#79c0ff" }}>ctx.sock.sendMessage()</code> langsung.
              </div>
              <ApiRow name="ctx.sendText(jid, text)" type="method" returns="Promise"
                desc="Kirim pesan teks ke JID. Shortcut untuk sock.sendMessage(jid, { text })."
                example={`await ctx.sendText("628xxx@s.whatsapp.net", "Halo dari plugin!")`}
              />
              <ApiRow name="ctx.sendImage(jid, img, caption?)" type="method" returns="Promise"
                desc="Kirim gambar. img bisa berupa string URL/path atau Buffer. caption opsional."
                example={`// Dari URL
await ctx.sendImage("628xxx@s.whatsapp.net", "https://example.com/img.jpg", "Caption")

// Dari file path (pakai ctx.require untuk fs)
const fs = ctx.require("fs")
const buf = fs.readFileSync("/path/to/img.jpg")
await ctx.sendImage("628xxx@s.whatsapp.net", buf, "Foto")`}
              />
              <ApiRow name="ctx.sendVideo(jid, vid, caption?)" type="method" returns="Promise"
                desc="Kirim video. vid bisa string URL/path atau Buffer."
                example={`await ctx.sendVideo("628xxx@s.whatsapp.net", "https://example.com/video.mp4", "Video")`}
              />
              <ApiRow name="ctx.sendAudio(jid, aud, ptt?)" type="method" returns="Promise"
                desc="Kirim audio. Set ptt=true untuk kirim sebagai Voice Note (PTT). Default ptt=false."
                example={`// Kirim sebagai audio biasa
await ctx.sendAudio("628xxx@s.whatsapp.net", audioBuffer)

// Kirim sebagai voice note
await ctx.sendAudio("628xxx@s.whatsapp.net", ogg_buffer, true)`}
              />
            </Section>
          )}

          {/* ── DATABASE ─────────────────────────────────────────────── */}
          {(!q || "db database sqlite getdb".includes(q)) && (
            <Section title="Database Access" icon="🗄️">
              <ApiRow name="ctx.getDB()" type="method" returns="DatabaseModule | null"
                desc="Mengambil instance database module (better-sqlite3 via wrapper). Semua query methods tersedia. Returns null jika database tidak tersedia."
                example={`const db = ctx.getDB()
if (!db) return ctx.logE("DB tidak tersedia")

// Query messages
const msgs = db.getMessages("628xxx@s.whatsapp.net", { limit: 10 })

// Query kontak
const contact = db.getContact("628xxx@s.whatsapp.net")

// Custom query (gunakan dengan hati-hati!)
const raw = db.db.prepare("SELECT * FROM messages WHERE body LIKE ?").all("%keyword%")`}
              />
            </Section>
          )}

          {/* ── UI BRIDGE ─────────────────────────────────────────────── */}
          {(!q || "ui renderer sendtoui ipc".includes(q)) && (
            <Section title="UI / Renderer Bridge" icon="🖥️">
              <ApiRow name="ctx.sendToUI(channel, data)" type="method" returns="void"
                desc="Kirim pesan ke renderer (React UI) via Electron IPC. Di renderer, gunakan window.api.on(channel, handler) untuk menerima."
                example={`// Di plugin (main process)
ctx.sendToUI("plugin:notification", {
  type: "success",
  message: "Auto-reply terkirim ke 628xxx",
  timestamp: Date.now(),
})

// Di renderer React
useEffect(() => {
  const unsub = window.api.on("plugin:notification", (data) => {
    console.log("Notif dari plugin:", data)
  })
  return () => unsub()
}, [])`}
              />
            </Section>
          )}

          {/* ── LOGGING ──────────────────────────────────────────────── */}
          {(!q || "log logging debug error warn".includes(q)) && (
            <Section title="Logging" icon="📝">
              <ApiRow name="ctx.log(...args)" type="method"
                desc='Log info ke console. Otomatis di-prefix dengan "[Plugin:pluginId]".'
                example={`ctx.log("Pesan diproses:", parsed.body) // → [Plugin:auto-reply] Pesan diproses: halo`}
              />
              <ApiRow name="ctx.logE(...args)" type="method"
                desc='Log error ke console. Prefix "[Plugin:pluginId][ERR]".'
                example={`ctx.logE("Gagal kirim:", err.message) // → [Plugin:auto-reply][ERR] Gagal kirim: ...`}
              />
              <ApiRow name="ctx.logW(...args)" type="method"
                desc='Log warning ke console. Prefix "[Plugin:pluginId][WARN]".'
                example={`ctx.logW("Koneksi lambat, retry ke-", retryCount)`}
              />
            </Section>
          )}

          {/* ── STORAGE ──────────────────────────────────────────────── */}
          {(!q || "storage persist save data".includes(q)) && (
            <Section title="Per-Plugin Storage" icon="💾">
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 8, padding: "6px 10px", background: "rgba(88,166,255,0.06)", borderRadius: 6, borderLeft: "3px solid rgba(88,166,255,0.4)" }}>
                Data disimpan ke <code style={{ color: "#79c0ff" }}>electron/mods/plugins/[pluginId]/data.json</code>. Persistent antar restart.
              </div>
              <ApiRow name="ctx.storage.get(key)" type="async method" returns="Promise<any>"
                desc="Baca nilai dari storage plugin. Returns undefined jika key tidak ada."
                example={`const config = await ctx.storage.get("config")
const counter = (await ctx.storage.get("counter")) || 0`}
              />
              <ApiRow name="ctx.storage.set(key, value)" type="async method" returns="Promise<void>"
                desc="Simpan nilai ke storage. value bisa berupa string, number, object, array."
                example={`await ctx.storage.set("config", { keyword: "halo", reply: "Halo juga!" })
await ctx.storage.set("counter", counter + 1)`}
              />
              <ApiRow name="ctx.storage.delete(key)" type="async method" returns="Promise<void>"
                desc="Hapus satu key dari storage."
                example={`await ctx.storage.delete("old_cache")`}
              />
              <ApiRow name="ctx.storage.getAll()" type="async method" returns="Promise<object>"
                desc="Ambil semua data storage plugin sebagai satu object."
                example={`const all = await ctx.storage.getAll()
ctx.log("Semua data:", JSON.stringify(all))`}
              />
              <ApiRow name="ctx.storage.clear()" type="async method" returns="Promise<void>"
                desc="Hapus semua data storage plugin (reset ke {})."
                example={`await ctx.storage.clear()
ctx.log("Storage direset")`}
              />
            </Section>
          )}

          {/* ── REQUIRE SANDBOX ──────────────────────────────────────── */}
          {(!q || "require sandbox module fs path crypto".includes(q)) && (
            <Section title="Sandboxed require()" icon="📦">
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 8, padding: "6px 10px", background: "rgba(240,136,62,0.08)", borderRadius: 6, borderLeft: "3px solid rgba(240,136,62,0.4)" }}>
                🔒 <strong>Security:</strong> ctx.require() hanya mengizinkan modul Node.js built-in yang aman.
                Modul berbahaya seperti <code style={{ color: "#f85149" }}>child_process</code>, <code style={{ color: "#f85149" }}>http</code>, <code style={{ color: "#f85149" }}>net</code> diblokir.
              </div>
              <ApiRow name="ctx.require(moduleName)" type="method" returns="NodeModule"
                desc="Akses Node.js built-in module. Modul yang diizinkan: path, fs, crypto, os, url, util, events, stream, buffer, querystring."
                example={`const path   = ctx.require("path")
const fs     = ctx.require("fs")
const crypto = ctx.require("crypto")

// Contoh: baca file dari folder plugin sendiri
const pluginDir = path.join(process.cwd(), "electron/mods/plugins", ctx.pluginId)
const data = fs.readFileSync(path.join(pluginDir, "replies.json"), "utf8")
const replies = JSON.parse(data)

// Contoh: hash teks
const hash = crypto.createHash("sha256").update("test").digest("hex")`}
              />
            </Section>
          )}

          {/* ── HOOK SIGNATURES ──────────────────────────────────────── */}
          {(!q || "hook signature onload onmessage onbeforesend onaftersend onconnect ondisconnect onconfigchange".includes(q)) && (
            <Section title="Hook Signatures & Return Values" icon="🪝" defaultOpen={false}>
              {HOOK_DOCS.filter(h => !q || h.id.toLowerCase().includes(q) || h.desc.toLowerCase().includes(q)).map(h => (
                <div key={h.id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16 }}>{h.emoji}</span>
                    <code style={{ color: h.color, fontSize: 13, fontWeight: 700, fontFamily: "monospace" }}>{h.sig}</code>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>{h.desc}</p>
                  {h.note && (
                    <div style={{ fontSize: 11.5, color: "#f0883e", padding: "4px 10px", background: "rgba(240,136,62,0.08)", borderRadius: 6, borderLeft: "3px solid rgba(240,136,62,0.4)", margin: "4px 0" }}>
                      {h.note}
                    </div>
                  )}
                  <Code>{h.example}</Code>
                </div>
              ))}
            </Section>
          )}

          {/* ── FULL EXAMPLE PLUGIN ──────────────────────────────────── */}
          {(!q || "example contoh plugin template".includes(q)) && (
            <Section title="Contoh Plugin Lengkap" icon="💡">
              <p style={{ fontSize: 12.5, color: "var(--text-2)", margin: "4px 0 8px" }}>
                Plugin auto-reply sederhana yang merespons kata kunci tertentu:
              </p>
              <Code>{`// electron/mods/plugins/my-bot/index.js
// manifest.json: { "id": "my-bot", "hooks": ["onLoad","onMessage","onConfigChange"] }

const DEFAULT_CFG = { keyword: "ping", reply: "pong!" }

module.exports = {
  async onLoad(ctx) {
    const cfg = await ctx.storage.get("config") || DEFAULT_CFG
    ctx.log("Ready! Keyword:", cfg.keyword)
  },

  async onMessage(parsed, rawMsg, ctx) {
    // Hanya proses pesan masuk (bukan dari diri sendiri)
    if (parsed.from_me) return

    const cfg = await ctx.storage.get("config") || DEFAULT_CFG

    if (parsed.body?.toLowerCase() === cfg.keyword.toLowerCase()) {
      await ctx.sendText(parsed.chat_jid, cfg.reply)
      ctx.log("Auto-replied ke", parsed.sender_jid)
    }
  },

  async onConfigChange(newValues, ctx) {
    await ctx.storage.set("config", newValues)
    ctx.log("Config updated:", newValues.keyword, "→", newValues.reply)
  },
}`}</Code>
            </Section>
          )}

        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div style={{
          padding: "10px 18px",
          borderTop: "1px solid rgba(255,255,255,0.07)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 11, color: "var(--text-3)",
        }}>
          <span>WaPlus Plugin API Docs — ctx v10</span>
          <span style={{ display: "flex", gap: 12 }}>
            <span><Badge color="#3fb950">async</Badge> = bisa await</span>
            <span><Badge color="#a78bfa">property</Badge> = langsung akses</span>
            <span><Badge color="#58a6ff">method</Badge> = perlu dipanggil</span>
          </span>
        </div>
      </div>
    </div>
  )
}