// electron/mods/modManager.js
// ╔══════════════════════════════════════════════════════════════╗
// ║              WaPlus — Mod / Plugin Manager                   ║
// ║                                                              ║
// ║  Sistem plugin yang memungkinkan script custom untuk:        ║
// ║    • Intercept / transform message object (onMessage)        ║
// ║    • Hook sebelum pesan dikirim (onBeforeSend)               ║
// ║    • Hook setelah pesan dikirim (onAfterSend)                ║
// ║    • React ke events koneksi (onConnect / onDisconnect)      ║
// ║    • Custom command (!cmd) via onCommand                     ║
// ║                                                              ║
// ║  Struktur folder plugin:                                     ║
// ║    electron/mods/plugins/<nama-plugin>/                      ║
// ║      index.js        ← entry point                          ║
// ║      manifest.json   ← metadata plugin                      ║
// ╚══════════════════════════════════════════════════════════════╝

"use strict"

const path = require("path")
const fs   = require("fs")
const EventEmitter = require("events")

const PLUGINS_DIR = path.resolve(__dirname, "./plugins")
const STATE_FILE  = path.resolve(__dirname, "./mods_state.json")

// ─── Ensure plugins dir exists ────────────────────────────────
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true })

// ─── Persistent state (enabled/disabled per plugin) ───────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  } catch (_) {}
  return {}
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8") } catch (_) {}
}

// ════════════════════════════════════════════════════════════════
// MOD MANAGER CLASS
// ════════════════════════════════════════════════════════════════

class ModManager extends EventEmitter {
  constructor() {
    super()
    this.plugins   = new Map()   // id → { manifest, module, enabled, error }
    this._state    = loadState() // persisted enabled/disabled map
    this._sock     = null        // WhatsApp socket reference
    this._win      = null        // Electron window reference
    this._log      = (...a) => console.log("[ModManager]", ...a)
    this._logE     = (...a) => console.error("[ModManager][ERR]", ...a)
  }

  // ── Init: scan & load all plugins ─────────────────────────
  async init(win) {
    this._win = win
    this._log("Initializing plugin system...")
    await this._scanPlugins()
    this._log(`Loaded ${this.plugins.size} plugin(s)`)
    this._notifyUI()
  }

  // ── Set socket reference (called after WA connects) ────────
  setSocket(sock) {
    this._sock = sock
  }

  // ─── SCAN & LOAD ALL PLUGINS ───────────────────────────────
  async _scanPlugins() {
    this.plugins.clear()

    if (!fs.existsSync(PLUGINS_DIR)) return

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await this._loadPlugin(entry.name).catch(err => {
        this._logE(`Failed to load plugin "${entry.name}":`, err.message)
      })
    }
  }

  async _loadPlugin(folderName) {
    const pluginDir    = path.join(PLUGINS_DIR, folderName)
    const manifestPath = path.join(pluginDir, "manifest.json")
    const indexPath    = path.join(pluginDir, "index.js")

    // Validate
    if (!fs.existsSync(indexPath)) {
      this._logE(`Plugin "${folderName}" has no index.js — skipped`)
      return
    }

    // Load manifest (optional but recommended)
    let manifest = {
      id:          folderName,
      name:        folderName,
      version:     "1.0.0",
      description: "",
      author:      "Unknown",
    }
    if (fs.existsSync(manifestPath)) {
      try { Object.assign(manifest, JSON.parse(fs.readFileSync(manifestPath, "utf8"))) }
      catch (e) { this._logE(`Bad manifest for "${folderName}":`, e.message) }
    }

    // Force id to match folder name for consistency
    manifest.id = folderName

    // Load module
    let mod = null
    let loadError = null
    try {
      // Clear cache so hot-reload works
      const fullPath = require.resolve(indexPath)
      delete require.cache[fullPath]
      mod = require(indexPath)
    } catch (err) {
      loadError = err.message
      this._logE(`Error loading "${folderName}":`, err.message)
    }

    // Determine enabled state — default true for new plugins
    const enabled = this._state[manifest.id] !== undefined
      ? this._state[manifest.id]
      : true

    this.plugins.set(manifest.id, {
      manifest,
      module:  mod,
      enabled,
      error:   loadError,
      folderName,
    })

    if (!loadError) {
      this._log(`  ✓ "${manifest.name}" v${manifest.version} [${enabled ? "ON" : "OFF"}]`)
      // Call onLoad lifecycle hook
      if (enabled && mod?.onLoad) {
        try { await mod.onLoad(this._createContext(manifest.id)) } catch (e) {
          this._logE(`onLoad error in "${manifest.id}":`, e.message)
        }
      }
    }
  }

  // ─── PLUGIN CONTEXT ───────────────────────────────────────
  // Setiap plugin mendapat context object dengan utils yang berguna
  _createContext(pluginId) {
    return {
      pluginId,

      // ── Full Baileys socket — sama persis dengan `dims` / `sock` ──
      // Semua method Baileys tersedia:
      //   ctx.sock.sendMessage(jid, payload, opts)
      //   ctx.sock.groupMetadata(jid)
      //   ctx.sock.sendPresenceUpdate("composing", jid)
      //   ctx.sock.ev.on("messages.upsert", handler)
      //   ... dll
      get sock() { return this._manager?._sock ?? null },

      // ── Shortcut helpers (opsional, tetap ada) ────────────────
      sendText:  (jid, text)      => this._sock?.sendMessage(jid, { text }),
      sendImage: (jid, img, cap)  => this._sock?.sendMessage(jid, { image: typeof img === "string" ? { url: img } : img, caption: cap || "" }),

      // ── DB ────────────────────────────────────────────────────
      getDB: () => {
        try { return require("../baileys/database") } catch { return null }
      },

      // ── Renderer ──────────────────────────────────────────────
      sendToUI: (channel, data) => {
        this._win?.webContents?.send(channel, data)
      },

      // ── Log ───────────────────────────────────────────────────
      log:  (...args) => console.log(`[Plugin:${pluginId}]`, ...args),
      logE: (...args) => console.error(`[Plugin:${pluginId}][ERR]`, ...args),

      // ── Storage per-plugin ────────────────────────────────────
      storage: {
        get:    (key)        => this._pluginStorageGet(pluginId, key),
        set:    (key, value) => this._pluginStorageSet(pluginId, key, value),
        getAll: ()           => this._pluginStorageGetAll(pluginId),
      },

      // referensi ke manager agar getter sock bisa akses _sock
      _manager: this,
    }
  }

  // ─── PLUGIN STORAGE ───────────────────────────────────────
  _pluginStoragePath(pluginId) {
    return path.join(PLUGINS_DIR, pluginId, "data.json")
  }

  _pluginStorageGetAll(pluginId) {
    try {
      const p = this._pluginStoragePath(pluginId)
      if (!fs.existsSync(p)) return {}
      return JSON.parse(fs.readFileSync(p, "utf8"))
    } catch { return {} }
  }

  _pluginStorageGet(pluginId, key) {
    return this._pluginStorageGetAll(pluginId)[key]
  }

  _pluginStorageSet(pluginId, key, value) {
    const all = this._pluginStorageGetAll(pluginId)
    all[key] = value
    try {
      fs.writeFileSync(this._pluginStoragePath(pluginId), JSON.stringify(all, null, 2))
    } catch (e) {
      this._logE(`Storage write error for "${pluginId}":`, e.message)
    }
  }

  // ════════════════════════════════════════════════════════════
  // HOOKS — dipanggil dari client.js
  // ════════════════════════════════════════════════════════════

  // Dipanggil setiap ada pesan masuk/keluar (setelah parsing, sebelum disimpan ke DB)
  // Plugin bisa: modify `parsed`, return false untuk skip DB insert, dsb
  async runOnMessage(parsed, rawMsg) {
    for (const [id, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.module?.onMessage) continue
      try {
        const ctx    = this._createContext(id)
        const result = await plugin.module.onMessage(parsed, rawMsg, ctx)
        // If plugin returns false → block message from being processed further
        if (result === false) return false
        // If plugin returns a modified object → use it
        if (result && typeof result === "object") Object.assign(parsed, result)
      } catch (e) {
        this._logE(`onMessage error in "${id}":`, e.message)
      }
    }
    return parsed
  }

  // Dipanggil sebelum pesan dikirim via sendTextMessage, dll
  // Plugin bisa modify payload atau return false untuk batalkan pengiriman
  async runOnBeforeSend(jid, payload) {
    for (const [id, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.module?.onBeforeSend) continue
      try {
        const ctx    = this._createContext(id)
        const result = await plugin.module.onBeforeSend(jid, payload, ctx)
        if (result === false) return false
        if (result && typeof result === "object") Object.assign(payload, result)
      } catch (e) {
        this._logE(`onBeforeSend error in "${id}":`, e.message)
      }
    }
    return payload
  }

  // Dipanggil setelah pesan berhasil dikirim
  async runOnAfterSend(jid, payload, sentMsg) {
    for (const [id, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.module?.onAfterSend) continue
      try {
        const ctx = this._createContext(id)
        await plugin.module.onAfterSend(jid, payload, sentMsg, ctx)
      } catch (e) {
        this._logE(`onAfterSend error in "${id}":`, e.message)
      }
    }
  }

  // Dipanggil saat WA connect
  async runOnConnect(info) {
    for (const [id, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.module?.onConnect) continue
      try {
        await plugin.module.onConnect(info, this._createContext(id))
      } catch (e) {
        this._logE(`onConnect error in "${id}":`, e.message)
      }
    }
  }

  // Dipanggil saat WA disconnect
  async runOnDisconnect(reason) {
    for (const [id, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.module?.onDisconnect) continue
      try {
        await plugin.module.onDisconnect(reason, this._createContext(id))
      } catch (e) {
        this._logE(`onDisconnect error in "${id}":`, e.message)
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // MANAGEMENT API — dipanggil dari IPC handlers
  // ════════════════════════════════════════════════════════════

  // List semua plugin dengan info mereka
  listPlugins() {
    const result = []
    for (const [id, plugin] of this.plugins) {
      result.push({
        id,
        name:        plugin.manifest.name,
        version:     plugin.manifest.version,
        description: plugin.manifest.description,
        author:      plugin.manifest.author,
        enabled:     plugin.enabled,
        error:       plugin.error,
        hooks:       plugin.module ? Object.keys(plugin.module).filter(k => k.startsWith("on")) : [],
      })
    }
    return result
  }

  // Toggle plugin on/off
  async togglePlugin(pluginId, enabled) {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found` }

    const wasEnabled = plugin.enabled
    plugin.enabled   = enabled
    this._state[pluginId] = enabled
    saveState(this._state)

    // Lifecycle hooks
    if (enabled && !wasEnabled && plugin.module?.onLoad) {
      try { await plugin.module.onLoad(this._createContext(pluginId)) } catch (_) {}
    }
    if (!enabled && wasEnabled && plugin.module?.onUnload) {
      try { await plugin.module.onUnload(this._createContext(pluginId)) } catch (_) {}
    }

    this._log(`Plugin "${pluginId}" → ${enabled ? "ENABLED" : "DISABLED"}`)
    this._notifyUI()
    return { ok: true }
  }

  // Reload semua plugin (hot-reload)
  async reloadPlugins() {
    this._log("Reloading all plugins...")
    // Call onUnload for all enabled plugins
    for (const [id, plugin] of this.plugins) {
      if (plugin.enabled && plugin.module?.onUnload) {
        try { await plugin.module.onUnload(this._createContext(id)) } catch (_) {}
      }
    }
    await this._scanPlugins()
    this._log(`Reloaded ${this.plugins.size} plugin(s)`)
    this._notifyUI()
    return { ok: true, count: this.plugins.size }
  }

  // Get plugin detail (untuk UI)
  getPluginDetail(pluginId) {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return null

    // Try to read source code for display
    let source = ""
    try {
      source = fs.readFileSync(path.join(PLUGINS_DIR, plugin.folderName, "index.js"), "utf8")
    } catch (_) {}

    return {
      ...this.listPlugins().find(p => p.id === pluginId),
      source,
      storagePath: this._pluginStoragePath(pluginId),
    }
  }

  // Get plugin config (schema + current values)
  getPluginConfig(pluginId) {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return null

    // Plugin must export `settings` array to have config UI
    const schema = plugin.module?.settings || []
    const saved  = this._pluginStorageGet(pluginId, "config") || {}

    // Merge defaults from schema with saved values
    const values = {}
    for (const field of schema) {
      values[field.key] = saved[field.key] !== undefined
        ? saved[field.key]
        : field.default
    }

    // Restore custom fields added via UI — stored as _customFields in saved config
    const customFields = Array.isArray(saved._customFields) ? saved._customFields : []
    // Also restore their saved values
    for (const field of customFields) {
      if (field.key && saved[field.key] !== undefined) {
        values[field.key] = saved[field.key]
      } else if (field.key && field.default !== undefined) {
        values[field.key] = field.default
      }
    }
    // Keep _customFields in values so UI can restore it
    values._customFields = customFields

    return { schema, values }
  }

  // Save plugin config and hot-reload it
  async savePluginConfig(pluginId, values) {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return { ok: false, error: "Plugin not found" }

    this._pluginStorageSet(pluginId, "config", values)

    // Notify plugin of config change via onConfigChange hook
    if (plugin.enabled && plugin.module?.onConfigChange) {
      try {
        await plugin.module.onConfigChange(values, this._createContext(pluginId))
      } catch (e) {
        this._logE(`onConfigChange error in "${pluginId}":`, e.message)
      }
    }

    this._log(`Config saved for "${pluginId}"`)
    return { ok: true }
  }

  // Open plugin folder in file explorer (via shell)
  openPluginFolder(pluginId) {
    const { shell } = require("electron")
    const pluginDir = pluginId
      ? path.join(PLUGINS_DIR, pluginId)
      : PLUGINS_DIR
    if (fs.existsSync(pluginDir)) shell.openPath(pluginDir)
  }

  // Create new plugin from template
  async createPlugin(id, name, description, hooks = null) {
    const slug    = id.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()
    const dir     = path.join(PLUGINS_DIR, slug)

    if (fs.existsSync(dir)) return { ok: false, error: `Plugin "${slug}" already exists` }
    fs.mkdirSync(dir, { recursive: true })

    // index.js template — only include selected hooks
    const ALL_HOOKS = ["onLoad","onUnload","onMessage","onBeforeSend","onAfterSend","onConnect","onDisconnect","onConfigChange"]
    const selectedHooks = (hooks && hooks.length > 0) ? hooks : ALL_HOOKS

    // manifest.json (written AFTER selectedHooks is defined)
    const manifest = { id: slug, name, version: "1.0.0", description, author: "You", hooks: selectedHooks }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
    const hookBodies = {
      onLoad:         `  async onLoad(ctx) {
    ctx.log("Plugin loaded!")
  }`,
      onUnload:       `  async onUnload(ctx) {
    ctx.log("Plugin unloaded.")
  }`,
      onMessage:      `  async onMessage(parsed, rawMsg, ctx) {
    // parsed: { id, chat_jid, sender_jid, body, msg_type, from_me, timestamp }
    // return false → blokir, return {...} → modifikasi
    if (!parsed.from_me) {
      ctx.log(\`Message: \${parsed.body}\`)
    }
  }`,
      onBeforeSend:   `  async onBeforeSend(jid, payload, ctx) {
    // return false → batalkan, return modifiedPayload → modifikasi
    return payload
  }`,
      onAfterSend:    `  async onAfterSend(jid, payload, sentMsg, ctx) {
    // Pesan terkirim
  }`,
      onConnect:      `  async onConnect(info, ctx) {
    // info: { name, jid, phone }
    ctx.log("WhatsApp connected:", info.name)
  }`,
      onDisconnect:   `  async onDisconnect(reason, ctx) {
    ctx.log("WhatsApp disconnected:", reason)
  }`,
      onConfigChange: `  async onConfigChange(newValues, ctx) {
    // Dipanggil saat settings plugin berubah
    ctx.log("Config updated:", JSON.stringify(newValues))
  }`,
    }
    const hookCode = selectedHooks.map(h => hookBodies[h] || "").filter(Boolean).join(",\n\n")
    const template = `// Plugin: ${name}
// ${description}
//
// ctx berisi: sendText, sendImage, getDB, log, logE, storage, sendToUI

"use strict"

module.exports = {
${hookCode},
}
`
    fs.writeFileSync(path.join(dir, "index.js"), template)

    // Load the new plugin
    await this._loadPlugin(slug)
    this._notifyUI()
    return { ok: true, id: slug }
  }

  // ─── Update hooks in an existing plugin ─────────────────
  // Adds missing hook stubs and removes unwanted ones from index.js
  async updatePluginHooks(pluginId, enabledHooks) {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return { ok: false, error: "Plugin not found" }

    const indexPath = path.join(PLUGINS_DIR, plugin.folderName, "index.js")
    if (!fs.existsSync(indexPath)) return { ok: false, error: "index.js not found" }

    let source = fs.readFileSync(indexPath, "utf8")

    const HOOK_TEMPLATES = {
      onLoad:         `  async onLoad(ctx) {
    ctx.log("Plugin loaded!")
  }`,
      onUnload:       `  async onUnload(ctx) {
    ctx.log("Plugin unloaded.")
  }`,
      onMessage:      `  async onMessage(parsed, rawMsg, ctx) {
    // parsed: { id, chat_jid, sender_jid, body, msg_type, from_me, timestamp }
    // return false → blokir, return {...} → modifikasi
    if (!parsed.from_me) {
      ctx.log(\`Message: \${parsed.body}\`)
    }
  }`,
      onBeforeSend:   `  async onBeforeSend(jid, payload, ctx) {
    // return false → batalkan, return modifiedPayload → modifikasi
    return payload
  }`,
      onAfterSend:    `  async onAfterSend(jid, payload, sentMsg, ctx) {
    // Pesan terkirim
  }`,
      onConnect:      `  async onConnect(info, ctx) {
    // info: { name, jid, phone }
    ctx.log("WhatsApp connected:", info.name)
  }`,
      onDisconnect:   `  async onDisconnect(reason, ctx) {
    ctx.log("WhatsApp disconnected:", reason)
  }`,
      onConfigChange: `  async onConfigChange(newValues, ctx) {
    // Dipanggil saat settings plugin berubah
    ctx.log("Config updated:", JSON.stringify(newValues))
  }`,
    }

    const ALL_HOOKS = Object.keys(HOOK_TEMPLATES)

    // Parse which hooks currently exist in module.exports = { ... }
    // We'll do a full rebuild of module.exports keeping user code for enabled hooks
    // Strategy: extract each hook body, rebuild module.exports with only enabledHooks

    // Extract individual hook bodies from source using regex
    const extractedBodies = {}
    for (const hook of ALL_HOOKS) {
      // Match: async hookName(... ) { ... } inside module.exports
      const re = new RegExp(
        `(async\s+${hook}\s*\([^)]*\)\s*\{)([\s\S]*?)(^  \})`,
        "m"
      )
      const m = source.match(re)
      if (m) {
        extractedBodies[hook] = m[1] + m[2] + m[3]
      }
    }

    // Build new module.exports block
    const hookParts = enabledHooks.map(h => {
      // Use existing body if available, else use template
      return extractedBodies[h] || HOOK_TEMPLATES[h]
    }).filter(Boolean)

    // Replace module.exports = { ... } block entirely
    const newExports = 'module.exports = {\n' + hookParts.join(',\n\n') + ',\n}'

    if (source.includes("module.exports = {")) {
      const exportsStart = source.indexOf("module.exports = {")
      let depth = 0, i = exportsStart
      while (i < source.length) {
        if (source[i] === "{") depth++
        else if (source[i] === "}") { depth--; if (depth === 0) break }
        i++
      }
      source = source.slice(0, exportsStart) + newExports + source.slice(i + 1)
    } else {
      source += "\n" + newExports + "\n"
    }

    fs.writeFileSync(indexPath, source, "utf8")

    // Update manifest hooks list
    const manifestPath = path.join(PLUGINS_DIR, plugin.folderName, "manifest.json")
    try {
      const mf = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      mf.hooks = enabledHooks
      fs.writeFileSync(manifestPath, JSON.stringify(mf, null, 2))
    } catch (_) {}

    // Hot-reload the plugin
    await this._loadPlugin(plugin.folderName)
    this._notifyUI()
    return { ok: true }
  }

  // ─── Delete a single plugin ──────────────────────────────
  async deletePlugin(id) {
    const plugin = this.plugins.get(id)
    if (!plugin) {
      const dir = path.join(PLUGINS_DIR, id)
      if (!fs.existsSync(dir)) return { ok: false, error: `Plugin "${id}" not found` }
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {
        return { ok: false, error: `Gagal hapus folder: ${e.message}` }
      }
      this._notifyUI()
      return { ok: true }
    }

    // Unload first if enabled — safe call, won't throw
    if (plugin.enabled && typeof plugin.module?.onUnload === "function") {
      try { await plugin.module.onUnload(this._createContext(id)) } catch (_) {}
    }

    // Remove from in-memory map BEFORE deleting folder
    this.plugins.delete(id)

    // Delete folder from disk
    const dir = path.join(PLUGINS_DIR, id)
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        return { ok: false, error: `Gagal hapus folder: ${e.message}` }
      }
    }

    this._notifyUI()
    return { ok: true }
  }

  // ─── Bulk delete plugins ──────────────────────────────────
  async deletePlugins(ids) {
    const results = []
    for (const id of ids) {
      const res = await this.deletePlugin(id)
      results.push({ id, ...res })
    }
    this._notifyUI()
    const failed = results.filter(r => !r.ok)
    return { ok: true, results, failedCount: failed.length }
  }

  // ─── Notify UI that plugin list changed ───────────────────
  _notifyUI() {
    try {
      this._win?.webContents?.send("mods:updated", this.listPlugins())
    } catch (_) {}
  }
}

// ─── Singleton ─────────────────────────────────────────────
const modManager = new ModManager()
module.exports = modManager
