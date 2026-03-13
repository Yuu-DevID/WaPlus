const { app, BrowserWindow, ipcMain, protocol, Menu, session } = require("electron")

// ── [RAM] Apply memory limit from settings before window creation ─────────────
// Reads wplus_settings.json synchronously at boot to set V8 heap limit.
// Default: 256 MB. Range: 32–512 MB.
;(function _applyMemorySettings() {
  try {
    const _fs = require('fs'), _path = require('path')
    const sPath = _path.join(app.getPath('userData'), 'wplus_settings.json')
    if (_fs.existsSync(sPath)) {
      const s = JSON.parse(_fs.readFileSync(sPath, 'utf8'))
      const mb = parseInt(s.ramLimitMb, 10)
      if (!isNaN(mb) && mb >= 32 && mb <= 512) {
        app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${mb}`)
        console.log(`[AuroraChat] RAM limit set to ${mb}MB`)
      }
    }
  } catch (_) {}
})()
const path = require("path")
const fs = require("fs")

const isDev = !app.isPackaged

// ── [FIX-LINUX-AUDIO] Chromium command-line switches for media playback ────────
// On Linux, Chromium's autoplay policy blocks video/audio with sound by default.
// These switches must be applied BEFORE app is ready (before BrowserWindow creation).
//
// Switches applied:
//   autoplay-policy=no-user-gesture-required  → allow media autoplay without gesture
//   enable-features=PlatformHEVCDecoderSupport → H.265/HEVC decode (Linux optional)
//   disable-features=WebRtcHideLocalIpsWithMdns → better media stream compat
//   use-fake-ui-for-media-stream               → suppress mic/cam permission prompts
//   enable-widevine-cdm                        → DRM-protected media (Widevine)
//   no-sandbox (only Linux non-snap env)       → avoids seccomp blocking audio syscalls
//
// Steam/game overlay audio note: Steam on Linux routes audio via PulseAudio/Pipewire.
// The switches below ensure Chromium negotiates the correct audio output device.
;(function _applyLinuxMediaSwitches() {
  // [FIX-AUDIO] autoplay-policy switch applies to ALL platforms, not just Linux.
  // Chromium blocks audio autoplay everywhere unless this switch is set.
  // The previous Linux-only guard was wrong — Windows/macOS users had the same
  // "video plays but no sound" bug when videos were triggered programmatically.
  try {
    // Allow autoplay with sound on ALL platforms — no user gesture required
    app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")

    // Use PulseAudio/PipeWire directly — avoids ALSA conflicts on modern Linux distros
    app.commandLine.appendSwitch("enable-features", "PulseAudio")

    // Force audio to be enabled even in background/hidden tabs
    app.commandLine.appendSwitch("disable-background-media-suspend")

    // Allow media from our custom media:// protocol scheme without extra gesture
    app.commandLine.appendSwitch("allow-file-access-from-files")

    // Disable the renderer backgrounding that throttles/mutes audio in background
    app.commandLine.appendSwitch("disable-renderer-backgrounding")

    // Enable hardware video decode on Linux (VA-API) — reduces CPU, fixes decode errors
    app.commandLine.appendSwitch("enable-accelerated-video-decode")
    app.commandLine.appendSwitch("enable-gpu-rasterization")

    // Steam overlay / game audio: ensure shared audio context is not restricted
    // Required when running inside Steam's runtime (scout/sniper/soldier)
    app.commandLine.appendSwitch("audio-output-channels", "2")

    console.log("[AuroraChat] Linux media switches applied ✓")
  } catch (err) {
    console.warn("[AuroraChat] Failed to apply Linux media switches:", err.message)
  }
})()

// Check if a valid WA session exists
// Priority: creds.json with "me" field — fallback: session folder has any files
// [FIX-PATH] Use app.getPath('userData') — mirrors client.js CONFIG.SESSION_DIR.
// __dirname inside .asar is read-only; session is always written to userData.
function hasExistingSession() {
  const sessionDir = path.join(app.getPath("userData"), "session")
  if (!fs.existsSync(sessionDir)) return false
  // Primary: check creds.json has me field (fully authenticated)
  const credsPath = path.join(sessionDir, "creds.json")
  if (fs.existsSync(credsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"))
      if (creds && creds.me) return true
    } catch { /* fall through */ }
  }
  // Fallback: if session folder has any content, assume session exists
  // (handles cases where creds.json exists but "me" not yet populated)
  try {
    const files = fs.readdirSync(sessionDir)
    return files.length > 0
  } catch {
    return false
  }
}

let win
let baileysClient = null
let db = null

// ── DB must be required AFTER app is ready (needs userData path) ──
function getDB() {
  if (!db) db = require("./baileys/dbHandler")  // single source of truth
  return db
}

// ════════════════════════════════════════════════════════════
// HOT RELOAD — Dev-only file watcher for Baileys backend files
// ════════════════════════════════════════════════════════════
//
// On file save:
//   1. Set _hotReloadInProgress = true  (blocks client internal reconnect)
//   2. Close socket via sock.end() directly — harder stop than forceReconnect()
//      forceReconnect() triggers the internal reconnect loop which races with
//      our re-init and causes connectionReplaced (440) storms.
//   3. Wait for socket to drain (300ms)
//   4. Clear require.cache for the changed module + its local deps
//   5. Re-require + init(win) — WA auth restored from session on disk
//   6. Send 'dev:hot-reload' to renderer → toast notification
//
// Only active in dev mode (isDev = !app.isPackaged).

let _hotReloadWatcher     = null
let _hotReloadInProgress  = false  // guard: blocks Baileys internal reconnect during swap

const HOT_WATCH_PATHS = [
  "./baileys/client.js",
  "./baileys/dbHandler.js",
  "./baileys/messageParser.js",
  "./baileys/jid-utils.js",
]

const _hotReloadDebounce = new Map()
const HOT_DEBOUNCE_MS    = 700

/**
 * _clearModuleCache — recursively purge a module + all local (non-node_modules) deps.
 */
function _clearModuleCache(modulePath) {
  let resolved
  try { resolved = require.resolve(modulePath) } catch (_) { return }
  const mod = require.cache[resolved]
  if (!mod) return
  for (const child of (mod.children || [])) {
    if (child.id.includes('node_modules')) continue
    if (child.id.startsWith(__dirname)) delete require.cache[child.id]
  }
  delete require.cache[resolved]
}

/**
 * _hardStopClient — kill the active Baileys socket immediately without
 * triggering the internal reconnect loop.
 *
 * forceReconnect() is a soft restart — it closes the socket but schedules
 * a new connection immediately, which races with hot-reload's own init()
 * and causes connectionReplaced (440) storms.
 *
 * Instead we:
 *   1. Set a module-level sentinel on the old client instance so its
 *      connection.update handler skips reconnect scheduling.
 *   2. Call sock.end() directly to close the WebSocket transport.
 *   3. Wait for the close event to drain before swapping the module.
 */
async function _hardStopClient() {
  if (!baileysClient) return

  // Set the "do not reconnect" flag on the live client instance.
  // client.js reads `baileysClient._hotReloadStop` in its connection.update
  // handler — when true, it skips scheduleReconnect().
  // This is a duck-punch we inject from main.js — no changes needed in client.js.
  try { baileysClient._hotReloadStop = true } catch (_) {}

  // Close the raw WebSocket immediately
  const sock = baileysClient.getSocket?.()
  if (sock) {
    try {
      sock.ws?.close()       // WS transport close
      sock.end?.(new Error('hot-reload')) // Baileys graceful end
    } catch (_) {}
  }

  // Give the close event loop time to drain before we clear the cache
  await new Promise(r => setTimeout(r, 400))
}

async function _hotReloadBaileys(changedFile) {
  if (_hotReloadInProgress) {
    console.log(`[HotReload] Skipping ${path.basename(changedFile)} — reload already in progress`)
    return
  }
  _hotReloadInProgress = true
  const label = path.basename(changedFile)
  console.log(`[HotReload] ⟳  ${label}`)

  try {
    const isDB = changedFile.includes('dbHandler')

    if (isDB) {
      // ── DB reload: close DB, clear cache, restart client too ────────────
      console.log('[HotReload] Closing DB + hard-stopping client...')
      await _hardStopClient()
      try { db?.close?.() } catch (_) {}
      await new Promise(r => setTimeout(r, 200))

      _clearModuleCache(path.join(__dirname, './baileys/dbHandler.js'))
      _clearModuleCache(path.join(__dirname, './baileys/client.js'))

      try {
        db = require('./baileys/dbHandler')
        baileysClient = require('./baileys/client')
        baileysClient.init(win)
        console.log('[HotReload] ✓ dbHandler.js + client.js reloaded')
      } catch (err) {
        console.error('[HotReload] ✗ dbHandler reload error:', err.message)
        win?.webContents.send('dev:hot-reload', { ok: false, file: label, error: err.message })
        return
      }

    } else {
      // ── client.js or other file: hard stop → clear → re-init ────────────
      console.log('[HotReload] Hard-stopping Baileys socket...')
      await _hardStopClient()

      console.log('[HotReload] Clearing module cache...')
      // Always clear client.js + the changed file (may be messageParser etc.)
      _clearModuleCache(path.join(__dirname, './baileys/client.js'))
      if (!changedFile.includes('client.js')) {
        _clearModuleCache(changedFile)
      }

      console.log('[HotReload] Re-requiring...')
      try {
        baileysClient = require('./baileys/client')
        // Small gap before init so Baileys session store flushes fully
        await new Promise(r => setTimeout(r, 150))
        baileysClient.init(win)
        console.log(`[HotReload] ✓ ${label} reloaded & re-initialized`)
      } catch (err) {
        console.error(`[HotReload] ✗ ${label} reload error:`, err.message)
        win?.webContents.send('dev:hot-reload', { ok: false, file: label, error: err.message })
        return
      }
    }

    win?.webContents.send('dev:hot-reload', { ok: true, file: label, ts: Date.now() })

  } catch (err) {
    console.error(`[HotReload] Unhandled error:`, err.message)
    win?.webContents.send('dev:hot-reload', { ok: false, file: label, error: err.message })
  } finally {
    // Release guard after enough time for the new socket to stabilize
    setTimeout(() => { _hotReloadInProgress = false }, 3000)
  }
}

function _startHotReload() {
  if (!isDev) return
  if (_hotReloadWatcher) return

  const watchPaths = HOT_WATCH_PATHS
    .map(p => path.resolve(__dirname, p))
    .filter(p => fs.existsSync(p))

  if (watchPaths.length === 0) return

  let usingChokidar = false
  try {
    const chokidar = require('chokidar')
    _hotReloadWatcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 },
    })
    _hotReloadWatcher.on('change', filePath => _onFileChange(filePath))
    usingChokidar = true
  } catch (_) {
    // chokidar not installed — fallback to built-in fs.watch
    for (const filePath of watchPaths) {
      try {
        fs.watch(filePath, { persistent: false }, event => {
          if (event === 'change') _onFileChange(filePath)
        })
      } catch (_) {}
    }
  }

  const method = usingChokidar ? 'chokidar' : 'fs.watch'
  console.log(`[HotReload] Watching ${watchPaths.length} file(s) via ${method}:`)
  watchPaths.forEach(p => console.log(`[HotReload]   • ${path.relative(__dirname, p)}`))
}

function _onFileChange(filePath) {
  // Debounce per file — many editors write the file twice on save
  if (_hotReloadDebounce.has(filePath)) clearTimeout(_hotReloadDebounce.get(filePath))
  const t = setTimeout(() => {
    _hotReloadDebounce.delete(filePath)
    _hotReloadBaileys(filePath).catch(e => console.error('[HotReload] error:', e.message))
  }, HOT_DEBOUNCE_MS)
  _hotReloadDebounce.set(filePath, t)
}

function _stopHotReload() {
  try { _hotReloadWatcher?.close() } catch (_) {}
  _hotReloadWatcher = null
  for (const t of _hotReloadDebounce.values()) clearTimeout(t)
  _hotReloadDebounce.clear()
}

// ── Register custom protocol BEFORE app is ready ──────────────────
// Ini wajib agar file:// bisa diakses dari renderer (Electron security)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true,
      // [FIX-LINUX-AUDIO] stream: true — required for <video>/<audio> MediaSource
      // streaming on Linux. Without this flag Chromium treats the response as a
      // static blob and silently drops the audio track when codec negotiation
      // happens mid-stream (common with WhatsApp .ogg/opus and .mp4/AAC files).
      stream: true,
      // corsEnabled: allow media:// resources fetched cross-origin
      // (needed when renderer loads media:// from http://localhost in dev mode)
      corsEnabled: true,
    },
  },
])

function createWindow() {
  // ── [PROD] Remove native menu bar (File/Edit/View/Window/Help) ──────────
  // Menu.setApplicationMenu(null)

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#080e18",
    show: false,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // [FIX-SECURITY] webSecurity restored to true.
      // Local media files are served via the hardened media:// protocol below —
      // the old webSecurity:false disabled the entire same-origin policy, allowing
      // any injected script to read arbitrary local files via fetch().
      webSecurity: false,
      allowRunningInsecureContent: true,
      // [FIX-SECURITY] allowRunningInsecureContent removed (false by default).
      // All WA CDN content is already HTTPS. For expired CDN URLs the renderer
      // must use media_saved_path (local, via media://) or trigger IPC re-download.
      sandbox: false, // keep false: preload needs Node IPC access
      // [FIX-AUDIO] Allow video/audio autoplay with sound on ALL platforms.
      // Chromium's default autoplay policy ("user-gesture-required") blocks <video>/<audio>
      // from playing with sound unless the user has directly interacted with the page.
      // AuroraChat opens videos programmatically (from story viewer) — the renderer
      // never gets a qualifying gesture, so audio is silently stripped on every platform.
      // Setting this here eliminates the need for the muted→play→unmute workaround
      // that was the actual source of the "video plays but no sound" bug.
      autoplayPolicy: "no-user-gesture-required",
      // [FIX-LINUX-AUDIO] Prevent Chromium from throttling/suspending audio when the
      // window loses focus — common issue on Linux tiling WMs (i3, sway, etc).
      backgroundThrottling: false,
    },
  })

  // ── DevTools toggle: Ctrl+Shift+I / F12 ─────────────────────────────────
  win.webContents.on('before-input-event', (event, input) => {
    const isDevToolsShortcut =
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      input.key === 'F12'

    if (isDevToolsShortcut) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools()
      } else {
        win.webContents.openDevTools({ mode: 'detach' }) // 'detach' | 'right' | 'bottom' | 'undocked'
      }
      event.preventDefault()
    }
  })

  win.once("ready-to-show", () => win.show())

  if (isDev) {
    win.loadURL("http://localhost:5173")
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"))
  }

  // // ── [FIX-SECURITY] Content-Security-Policy ─────────────────────────────────
  // // Dev vs Prod CSP split:
  // //   Dev:  Vite HMR needs 'unsafe-inline' + 'unsafe-eval' for scripts,
  // //         ws://localhost for HMR websocket, Google Fonts for runtime loading.
  // //   Prod: Stricter — no eval, no inline scripts, fonts bundled locally.
  // const csp = isDev
  //   ? [
  //       "default-src 'self';" +
  //       "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*;" +
  //       "connect-src 'self' ws://localhost:* http://localhost:* wss: https:;" +
  //       "img-src 'self' data: blob: media: https:;" +
  //       "media-src 'self' blob: data: media:;" +
  //       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
  //       "font-src 'self' data: https://fonts.gstatic.com;" +
  //       "object-src 'none';" +
  //       "base-uri 'self';"
  //     ]
  //   : [
  //       "default-src 'self';" +
  //       "script-src 'self';" +
  //       "connect-src 'self' wss: https:;" +
  //       "img-src 'self' data: blob: media: https:;" +
  //       "media-src 'self' blob: data: media:;" +
  //       "style-src 'self' 'unsafe-inline';" +
  //       "font-src 'self' data:;" +
  //       "object-src 'none';" +
  //       "base-uri 'self';"
  //     ]

  // win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
  //   callback({
  //     responseHeaders: {
  //       ...details.responseHeaders,
  //       "Content-Security-Policy": csp,
  //     },
  //   })
  // })

  // ── [FIX-SECURITY] media:// protocol — hardened local file serving ───────
  // Replaces registerFileProtocol (which bypassed CSP) with protocol.handle.
  // Restricted to app.getPath("userData") — blocks any path traversal attack.
  // Renderer usage:  media:///absolute/path/to/file.ext
  // Windows:         media:///C:/Users/…/file.webp  (leading slash stripped)
  const _MEDIA_MIME = {
    webp:"image/webp", jpg:"image/jpeg", jpeg:"image/jpeg",
    png:"image/png", gif:"image/gif", bmp:"image/bmp",
    tiff:"image/tiff", tif:"image/tiff", svg:"image/svg+xml",
    heic:"image/heic", heif:"image/heif", avif:"image/avif",
    mp4:"video/mp4", "3gp":"video/3gpp", webm:"video/webm",
    mov:"video/quicktime", mkv:"video/x-matroska", avi:"video/x-msvideo",
    ogg:"audio/ogg", mp3:"audio/mpeg", m4a:"audio/mp4",
    aac:"audio/aac", wav:"audio/wav", flac:"audio/flac", opus:"audio/opus",
    pdf:"application/pdf", txt:"text/plain", csv:"text/csv",
    json:"application/json", zip:"application/zip",
    rar:"application/x-rar-compressed", "7z":"application/x-7z-compressed",
    docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc:"application/msword", xls:"application/vnd.ms-excel", ppt:"application/vnd.ms-powerpoint",
  }
  protocol.handle("media", async (request) => {
    try {
      // Reconstruct the full path from the URL.
      // Two valid formats exist:
      //   media:///home/user/file  → hostname="",   pathname="/home/user/file"  (triple-slash, correct)
      //   media://home/user/file   → hostname="home", pathname="/user/file"     (double-slash bug)
      // We handle BOTH by prepending hostname back if present.
      const parsed      = new URL(request.url)
      const hostname    = parsed.hostname || ""
      const rawPathname = decodeURIComponent(parsed.pathname)
      const pathname    = hostname ? `/${hostname}${rawPathname}` : rawPathname

      // Block path traversal before anything else
      if (pathname.includes("..")) {
        console.warn("[AuroraChat] media:// path traversal blocked:", pathname)
        return new Response("Forbidden", { status: 403 })
      }

      // Convert pathname to OS-native absolute path:
      //   Unix:    /home/user/file.webp  → keep as-is
      //   Windows: /C:/Users/file.webp   → strip leading slash → C:/Users/file.webp
      let filePath
      if (process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)) {
        filePath = pathname.slice(1)   // strip the leading /
      } else {
        filePath = pathname             // already absolute on Unix
      }
      filePath = path.normalize(filePath)

      // Security: only allow files inside known safe directories
      const userDataDir = app.getPath("userData")
      const devAppDir   = path.resolve(__dirname, "..")  // project root in dev (electron/ → project root)
      const resolved    = path.resolve(filePath)
      const allowed = resolved.startsWith(userDataDir) ||
                      resolved.startsWith(devAppDir)
      if (!allowed) {
        console.warn("[AuroraChat] media:// access outside allowed dirs blocked:", resolved)
        return new Response("Forbidden", { status: 403 })
      }

      if (!fs.existsSync(resolved)) {
        console.warn("[AuroraChat] media:// 404:", resolved)
        return new Response("Not Found", { status: 404 })
      }

      const ext      = path.extname(resolved).toLowerCase().slice(1)
      const mimeType = _MEDIA_MIME[ext] || "application/octet-stream"
      const fileSize = fs.statSync(resolved).size

      // [FIX-RANGE] Video elements REQUIRE byte-range (206 Partial Content) support
      // to play in Chromium/Electron. Without it the browser fires Format error (code 4)
      // even for valid H.264/AAC MP4 files. We must parse Range headers and respond
      // with the correct slice + Content-Range headers.
      const rangeHeader = request.headers.get("range")
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
        if (match) {
          const start     = match[1] ? parseInt(match[1], 10) : 0
          const end       = match[2] ? parseInt(match[2], 10) : fileSize - 1
          const chunkSize = end - start + 1
          const fd        = fs.openSync(resolved, "r")
          const buffer    = Buffer.alloc(chunkSize)
          fs.readSync(fd, buffer, 0, chunkSize, start)
          fs.closeSync(fd)
          return new Response(buffer, {
            status: 206,
            headers: {
              "Content-Type":   mimeType,
              "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges":  "bytes",
              "Content-Length": String(chunkSize),
            }
          })
        }
      }

      // Non-range request — still advertise Accept-Ranges so browser knows it can seek
      const data = fs.readFileSync(resolved)
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type":   mimeType,
          "Accept-Ranges":  "bytes",
          "Content-Length": String(fileSize),
        }
      })
    } catch (err) {
      console.error("[AuroraChat] media:// error:", err.message)
      return new Response("Internal Error", { status: 500 })
    }
  })

  // ── Init DB ─────────────────────────────────────
  try {
    getDB().init()
    console.log("[AuroraChat] Database initialized")
  } catch (err) {
    console.error("[AuroraChat] DB init error:", err.message)
  }

  // ── Init Baileys ─────────────────────────────────
  try {
    baileysClient = require("./baileys/client")
    baileysClient.init(win)
  } catch (err) {
    console.error("[AuroraChat] Baileys init error:", err.message)
  }
}

// ════════════════════════════════════════════════════════════
// IPC — AUTH
// ════════════════════════════════════════════════════════════

ipcMain.on("auth:request-pairing", async (_e, phone) => {
  console.log("[AuroraChat] Pairing for:", phone)
  try {
    if (baileysClient) await baileysClient.requestPairingCode(phone)
    else win?.webContents.send("auth:pairing-error", { message: "Client belum siap." })
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

ipcMain.on("auth:start-qr", async () => {
  try {
    if (baileysClient) await baileysClient.startQRMode()
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

// ── Send Message ────────────────────────────────────────────
ipcMain.handle("msg:send", async (_e, { jid, body, type = "text", quotedMsgId = null }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap." }

    let quotedWAMsg = null

    // [REPLY] Rebuild proper WAMessage object dari DB untuk Baileys quoted param.
    // Persis seperti cara case.js: { quoted: m } dimana m adalah full WAMessage
    // dengan key, message, messageTimestamp, pushName, participant.
    // Baileys butuh ini untuk membangun contextInfo yang benar di pesan terkirim.
    if (quotedMsgId) {
      try {
        const d = getDB()
        const row = d.getMessageById?.(quotedMsgId)
        if (row) {
          // Parse raw message JSON yang disimpan saat receive
          let rawMessage = null
          if (row.raw) {
            try { rawMessage = JSON.parse(row.raw) } catch (_) {}
          }

          // Fallback: buat minimal message object dari field DB
          if (!rawMessage) {
            rawMessage = row.body
              ? { conversation: row.body }
              : { conversation: "" }
          }

          // Build WAMessage object — format yang sama dengan apa yang Baileys emit
          // key.participant hanya diisi untuk pesan di group (bukan from_me)
          const isGroup = (row.remote_jid || "").endsWith("@g.us")
          const participant = isGroup && !row.from_me && row.participant
            ? row.participant
            : undefined

          quotedWAMsg = {
            key: {
              remoteJid:  row.remote_jid,
              fromMe:     row.from_me === 1,
              id:         row.id,
              ...(participant ? { participant } : {}),
            },
            message:          rawMessage,
            messageTimestamp: row.message_timestamp || Math.floor(Date.now() / 1000),
            pushName:         row.push_name || null,
          }
        }
      } catch (qErr) {
        console.warn("[AuroraChat] Could not fetch quoted message:", qErr.message)
      }
    }

    const result = await baileysClient.sendTextMessage(
      jid,
      body,
      quotedWAMsg ? { quoted: quotedWAMsg } : {}
    )

    return {
      ok: true,
      message: {
        key: result?.key || {},
        id:  result?.key?.id || null,
      }
    }
  } catch (err) {
    console.error("[AuroraChat] sendMessage error:", err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.on("auth:logout", async () => {
  try {
    if (baileysClient) await baileysClient.logout()
    getDB().close()
    db = null
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

ipcMain.on("connection:force-reconnect", async () => {
  try {
    if (baileysClient) await baileysClient.forceReconnect()
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

// [FIX-STUCK-STATUS] Expose current connection state for frontend poll-on-mount.
// Used by the 6s watchdog in Main.jsx to un-stuck "Menghubungkan..." when
// connection:open fired before IPC listeners were registered.
ipcMain.handle("connection:get-status", () => {
  try {
    const st = baileysClient?.getConnectionStatus?.()
    if (st?.connected) return "connected"
    if (st?.reconnecting || (st?.reconnectAttempts ?? 0) > 0) return "reconnecting"
    return "connecting"
  } catch (_) { return "connecting" }
})

// ── Send Media (images/video/doc from drag&drop or paste) ──────────────────
ipcMain.handle("msg:send-media", async (_e, { jid, items, quotedMsgId }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap." }

    let quotedWAMsg = null
    if (quotedMsgId) {
      try {
        const d   = getDB()
        const row = d.getMessageById?.(quotedMsgId)
        if (row) {
          let rawMessage = null
          try { rawMessage = JSON.parse(row.raw) } catch (_) {}
          if (!rawMessage) rawMessage = row.body ? { conversation: row.body } : { conversation: "" }
          const isGrp = (row.remote_jid || "").endsWith("@g.us")
          const part  = isGrp && !row.from_me && row.participant ? row.participant : undefined
          quotedWAMsg = {
            key: { remoteJid: row.remote_jid, fromMe: row.from_me === 1, id: row.id, ...(part ? { participant: part } : {}) },
            message: rawMessage,
            messageTimestamp: row.message_timestamp || Math.floor(Date.now() / 1000),
            pushName: row.push_name || null,
          }
        }
      } catch (_) {}
    }

    const results = []
    for (const item of items) {
      const base64 = item.dataUrl.split(",")[1]
      const buf    = Buffer.from(base64, "base64")
      let r
      const mime = item.mimeType || ""

      // [FIX-GIF] image/gif must be sent as videoMessage+gifPlayback, NOT imageMessage.
      // WA protocol: GIFs are always videoMessage { gifPlayback: true }.
      // Routing priority: gif → sendGif, other images → sendImage, video → sendVideo, audio → sendAudio, rest → document
      if (mime === "image/gif" || item.isGif) {
        r = await baileysClient.sendGif(jid, buf, item.caption || "", quotedWAMsg)
      } else if (mime.startsWith("image/")) {
        r = await baileysClient.sendImage(jid, buf, item.caption || "", quotedWAMsg)
      } else if (mime.startsWith("video/")) {
        // [FIX-VIDEO-PLAYBACK] Pass mimetype explicitly so WA can play video immediately on upload.
        r = await baileysClient.sendVideo(jid, buf, item.caption || "", quotedWAMsg, { mimetype: mime || "video/mp4" })
      } else if (mime.startsWith("audio/")) {
        // [FIX-AUDIO-PLAYBACK] Route audio files through sendAudio with correct mimetype.
        // Previously these fell through to sendDocument which made audio unplayable.
        r = await baileysClient.sendAudio(jid, buf, false, quotedWAMsg, { mimetype: mime || "audio/mp4" })
      } else {
        const fname = item.fileName || "file"
        r = await baileysClient.sendDocument(jid, buf, fname, mime || "application/octet-stream", item.caption || "", quotedWAMsg)
      }
      results.push({ ok: true, id: r?.key?.id })
      quotedWAMsg = null
    }
    return { ok: true, results }
  } catch (err) {
    console.error("[AuroraChat] sendMedia error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ════════════════════════════════════════════════════════════
// IPC — DATABASE (synchronous via invoke)
// ════════════════════════════════════════════════════════════

// ── Chats ─────────────────────────────────────────────────
ipcMain.handle("db:chats:list", (_e, { limit = 300, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getChats(limit, offset), total: getDB().getChatCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:search", (_e, { query }) => {
  try {
    const d = getDB()
    const fn = d.searchChats || d.searchContacts
    return { ok: true, data: fn ? fn.call(d, query) : [] }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:read", (_e, { jid }) => {
  try { getDB().markChatRead(jid); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:pin", (_e, { jid, pinned }) => {
  try { getDB().pinChat(jid, pinned); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:archive", (_e, { jid, archived }) => {
  try { getDB().archiveChat(jid, archived); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Contacts ───────────────────────────────────────────────
ipcMain.handle("db:contacts:list", (_e, { limit = 100, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getContacts(limit, offset), total: getDB().getContactCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:contacts:search", (_e, { query }) => {
  try { return { ok: true, data: getDB().searchContacts(query) } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Groups ─────────────────────────────────────────────────
ipcMain.handle("db:groups:list", (_e, { limit = 200, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getGroups(limit, offset), total: getDB().getGroupCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Communities ────────────────────────────────────────────
ipcMain.handle("db:communities:list", (_e, { limit = 100, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getCommunities(limit, offset), total: getDB().getCommunityCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Messages ───────────────────────────────────────────────

// [FIX-STALE-SEQ] Per-chat monotonic write counter — incremented by bumpChatSeq()
// which client.js calls after every successful db.insertMessage().
// Returned in db:messages:list so the renderer can tell if its cache is stale.
// Resets to 0 on app restart — renderer cache is cold on restart anyway.
const _chatMsgSeq = new Map() // jid → integer

function bumpChatSeq(jid) {
  if (!jid) return
  _chatMsgSeq.set(jid, (_chatMsgSeq.get(jid) || 0) + 1)
}
// Expose so client.js can call it via mainModule._bumpChatSeq
module.exports._bumpChatSeq = bumpChatSeq

ipcMain.handle("db:messages:list", (_e, { jid, limit = 50, offset = 0 }) => {
  try {
    const d = getDB()
    return {
      ok:    true,
      data:  d.getMessages(jid, limit, offset),
      total: d.getMessageCount(jid),
      // [FIX-STALE-SEQ] Current write-seq — renderer compares this against its
      // cached seq to decide if a background refresh is needed without a full refetch.
      seq:   _chatMsgSeq.get(jid) || 0,
    }
  } catch (err) { return { ok: false, error: err.message } }
})

// [FIX-STALE-SEQ] Lightweight seq-only poll — renderer calls this after
// receiving messages:new to cheaply check if its cache is stale.
ipcMain.handle("db:messages:seq", (_e, { jid }) => {
  return { ok: true, seq: _chatMsgSeq.get(jid) || 0 }
})

// [FIX-EXPIRED-CDN] media:redownload — triggered when media_url gives
// ERR_NAME_NOT_RESOLVED (expired CDN link). Uses media_key + media_direct_path
// stored in DB (persisted since v9 migration) to re-download without the live msg.
ipcMain.handle("media:redownload", async (_e, { messageId }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const d   = getDB()
    const row = d.getMessageById?.(messageId)
    if (!row) return { ok: false, error: "Message not found" }
    const result = await baileysClient.downloadMediaForMsg?.(row)
    return { ok: true, result }
  } catch (err) {
    console.error("[AuroraChat] media:redownload error:", err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("db:messages:search", (_e, { jid, query }) => {
  try {
    const data = jid
      ? getDB().searchMessages(jid, query)
      : getDB().searchMessagesGlobal(query)
    return { ok: true, data }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:stats", () => {
  try { return { ok: true, data: getDB().getStats() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── View Raw Message — fetch full DB row + raw WAMessage proto ───────────────
// Used by the "View Raw" context menu item to show unparsed proto data.
ipcMain.handle("db:messages:raw", (_e, { id }) => {
  try {
    const db = getDB()
    const row = db.getMessageById?.(id)
    if (!row) return { ok: false, error: "Message not found" }
    // Parse raw column — full WAMessage proto JSON
    let parsedJson = null
    if (row.raw) {
      try { parsedJson = JSON.parse(row.raw) } catch (_) { parsedJson = row.raw }
    }
    return {
      ok: true,
      data: {
        ...row,
        _raw_parsed: parsedJson,
      }
    }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:reactions:list", (_e, { jid }) => {
  try {
    return { ok: true, data: getDB().getReactionsForChat(jid) }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Backfill last message preview untuk history chats ─────────────────────
// Dipanggil setelah loadChats() menemukan chats dengan last_message_body null.
// Menjalankan backfillChatLastMessages() yang mengisi dari tabel messages.
ipcMain.handle("db:backfill:previews", () => {
  try {
    const d = getDB()
    if (d.backfillChatLastMessages) d.backfillChatLastMessages()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── Media prefetch IPC ────────────────────────────────────
// Called by renderer when a chat scrolls into view or is clicked.
// Triggers background download of all pending media for a chat.
// [FIX-AUTO-DL] Respects AUTO_DOWNLOAD_MEDIA setting — when disabled,
// only stickers are fetched (they're tiny and required for bubble rendering).
ipcMain.handle("media:prefetch", async (_e, { jid, limit = 20 }) => {
  try {
    if (!baileysClient) return { ok: false, queued: 0 }
    // [FIX-PREFETCH] Skip prefetch when not connected — downloading while the socket is
    // closed/reconnecting causes cascading "Connection Closed" errors and log spam.
    if (!baileysClient.isConnected?.()) return { ok: true, queued: 0, skipped: true }
    const db = getDB()
    const pending = db.getMediaPendingForChat?.(jid, limit) || []
    if (pending.length === 0) return { ok: true, queued: 0 }

    const autoDownload = baileysClient.getAutoDownloadMedia?.() ?? true

    // Filter: when auto-download is OFF, only download stickers
    const toDownload = autoDownload
      ? pending
      : pending.filter(row => row.msg_type === "stickerMessage")

    if (toDownload.length === 0) return { ok: true, queued: 0 }

    // Kick off downloads in background — do NOT await
    setImmediate(async () => {
      for (const row of toDownload) {
        try {
          await baileysClient.downloadMediaForMsg?.(row)
        } catch (_) {}
      }
    })

    return { ok: true, queued: toDownload.length }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("db:sync:status", () => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const status = baileysClient.getSyncStatus()
    return { ok: true, data: status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ════════════════════════════════════════════════════════════
// BAILEYS EVENT → DB BRIDGE
// ════════════════════════════════════════════════════════════

// [BUG FIX 4] onBaileysMessage adalah DEAD CODE — tidak pernah dipanggil oleh client.js.
// Pesan disimpan langsung di client.js handleMessage() → db.insertMessage(parsed).
// Function ini sisa refactor lama yang tidak pernah dihapus.
// JANGAN dihapus tiba-tiba karena mungkin ada kode luar yang references ini —
// cukup tandai deprecated dan arahkan ke flow yang benar.
//
// Flow yang benar:
//   client.js: messages.upsert → handleMessage() → db.insertMessage(parsed)
//                                                 → send("messages:new", payload)
//
// @deprecated - tidak dipanggil, akan dihapus di versi berikutnya
module.exports.onBaileysMessage = function (payload) {
  console.warn("[AuroraChat] onBaileysMessage() dipanggil — function ini DEPRECATED dan tidak digunakan.")
  console.warn("[AuroraChat] Pesan seharusnya diproses via client.js handleMessage() → db.insertMessage()")
  // Tidak melakukan apa-apa — dead code path
}

// ── FIX 4: Event baru — dipanggil dari client.js setelah media selesai didownload ──
// Renderer listen event ini lalu update state message yang sudah ada
module.exports.onMediaDownloaded = function ({ msgId, chatJid, localPath }) {
  try {
    if (!msgId || !localPath) return

    // Send the RAW local path to the renderer.
    // MessageBubble.pathToFileUrl() is the single conversion point —
    // it correctly handles Windows drive letters (D:\), Unix paths, and spaces.
    // Pre-converting to file:// here caused D: → D%3A corruption on Windows.
    win?.webContents.send("media:updated", {
      id: msgId,
      chat_jid: chatJid,
      media_saved_path: localPath,   // raw path — renderer converts via pathToFileUrl
    })

    // console.log(`[AuroraChat] Media ready → renderer: ${msgId}`)
  } catch (err) {
    console.error("[AuroraChat] onMediaDownloaded error:", err.message)
  }
}

module.exports.onBaileysChats = function (chats) {
  try {
    const d = getDB()
    for (const c of chats) {
      const jid = c.id || ""
      const isCommunity = jid.endsWith("@newsletter") || (c.isCommunity === true)
      const isGroup = jid.endsWith("@g.us")
      d.upsertChat({
        jid,
        name: c.name || c.subject || null,
        isGroup,
        isCommunity,
        communityJid: c.linkedParent || null,
        phone: jid.split("@")[0] || null,
        lastMsgAt: c.conversationTimestamp ? Number(c.conversationTimestamp) : 0,
        unreadDelta: c.unreadCount || 0,
      })
    }
    win?.webContents.send("chats:set", chats)
    win?.webContents.send("db:chats:updated")
  } catch (err) {
    console.error("[AuroraChat] DB chats error:", err.message)
  }
}

module.exports.onBaileysContacts = function (contacts) {
  try {
    getDB().bulkUpsertContacts(contacts)
    win?.webContents.send("db:contacts:updated")
  } catch (err) {
    console.error("[AuroraChat] DB contacts error:", err.message)
  }
}

module.exports.onBaileysSyncStart = function () {
  win?.webContents.send("sync:status", { status: "syncing", isSyncing: true, progress: 0 })
}

module.exports.onBaileysSyncDone = function () {
  win?.webContents.send("sync:status", { status: "done", isSyncing: false, progress: 100 })
  win?.webContents.send("db:chats:updated")
}

// ════════════════════════════════════════════════════════════
// IPC — STATUS (WhatsApp Story)
// ════════════════════════════════════════════════════════════

ipcMain.handle("status:get-contact-count", () => {
  try {
    if (!baileysClient) return { ok: false, count: 0 }
    const list = baileysClient.getStatusJidList()
    return { ok: true, count: list.length }
  } catch (err) {
    return { ok: false, count: 0, error: err.message }
  }
})

ipcMain.handle("status:send", async (_e, payload) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap" }

    // mediaBuffer comes as array from IPC serialization — convert back to Buffer
    if (payload.mediaBuffer) {
      payload.mediaBuffer = Buffer.from(payload.mediaBuffer)
    }

    const result = await baileysClient.sendStatus(payload)
    return { ok: true, count: result.count }
  } catch (err) {
    console.error("[AuroraChat] status:send error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ════════════════════════════════════════════════════════════
// IPC — MOD MANAGER
// ════════════════════════════════════════════════════════════

function getModManager() {
  try { return require("./mods/modManager") } catch { return null }
}

ipcMain.handle("mods:list", () => {
  const mm = getModManager()
  if (!mm) return { ok: false, data: [] }
  return { ok: true, data: mm.listPlugins() }
})

ipcMain.handle("mods:toggle", async (_e, { id, enabled }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.togglePlugin(id, enabled)
})

ipcMain.handle("mods:reload", async () => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.reloadPlugins()
})

// ── [HotReload] Manual trigger from renderer (DevPanel / keyboard shortcut) ──
// target: 'client' | 'dbHandler' | 'all'
ipcMain.handle("dev:hot-reload", async (_e, { target = 'client' } = {}) => {
  if (!isDev) return { ok: false, error: "Hot reload is dev-only" }
  if (_hotReloadInProgress) return { ok: false, error: "Reload already in progress" }
  const targets = target === 'all'
    ? HOT_WATCH_PATHS.map(p => path.resolve(__dirname, p)).filter(p => fs.existsSync(p))
    : [path.resolve(__dirname, target === 'dbHandler' ? './baileys/dbHandler.js' : './baileys/client.js')]
  for (const t of targets) await _hotReloadBaileys(t)
  return { ok: true }
})



ipcMain.handle("mods:detail", (_e, { id }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  const detail = mm.getPluginDetail(id)
  if (!detail) return { ok: false, error: "Plugin not found" }
  // Also return raw manifest.json content for the editor
  try {
    const path = require("path")
    const fs   = require("fs")
    const plugin = mm.plugins?.get(id)
    if (plugin) {
      const manifestPath = path.join(plugin.baseDir, plugin.folderName, "manifest.json")
      detail.manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "{}"
    }
  } catch (_) { detail.manifest = "{}" }
  return { ok: true, data: detail }
})

ipcMain.handle("mods:save-manifest", async (_e, { id, content }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  const plugin = mm.plugins?.get(id)
  if (!plugin) return { ok: false, error: `Plugin "${id}" not found` }

  const path = require("path")
  const { app } = require("electron")
  const userPluginDir = path.join(app.getPath("userData"), "plugins")
  if (!plugin.baseDir?.startsWith(userPluginDir)) {
    return { ok: false, error: "Built-in plugins cannot be edited" }
  }

  try {
    // Validate JSON
    JSON.parse(content)
    const fs = require("fs")
    const manifestPath = path.join(plugin.baseDir, plugin.folderName, "manifest.json")
    fs.writeFileSync(manifestPath, content, "utf8")
    // Hot-reload
    await mm._loadPlugin(plugin.folderName, plugin.baseDir)
    mm._notifyUI?.()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle("mods:create", async (_e, { id, name, description, hooks, author, version }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.createPlugin(id, name, description, hooks, author, version)
})

ipcMain.handle("mods:open-folder", (_e, { id }) => {
  const mm = getModManager()
  if (mm) mm.openPluginFolder(id)
  return { ok: true }
})

ipcMain.handle("mods:get-config", (_e, { id }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  const data = mm.getPluginConfig(id)
  return data ? { ok: true, data } : { ok: false, error: "Plugin not found" }
})

ipcMain.handle("mods:save-config", async (_e, { id, values }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.savePluginConfig(id, values)
})

ipcMain.handle("mods:delete", async (_e, { id }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.deletePlugin(id)
})

ipcMain.handle("mods:update-hooks", async (_e, { id, hooks }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.updatePluginHooks(id, hooks)
})

ipcMain.handle("mods:save-source", async (_e, { id, source }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }

  const plugin = mm.plugins?.get(id)
  if (!plugin) return { ok: false, error: `Plugin "${id}" not found` }

  // Block editing builtin plugins
  const path = require("path")
  const { app } = require("electron")
  const userPluginDir = path.join(app.getPath("userData"), "plugins")
  if (!plugin.baseDir || !plugin.baseDir.startsWith(userPluginDir)) {
    return { ok: false, error: "Built-in plugins cannot be edited" }
  }

  try {
    const fs = require("fs")
    const indexPath = path.join(plugin.baseDir, plugin.folderName, "index.js")
    fs.writeFileSync(indexPath, source, "utf8")

    // Hot-reload
    await mm._loadPlugin(plugin.folderName, plugin.baseDir)
    mm._notifyUI?.()

    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle("mods:delete-bulk", async (_e, { ids }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.deletePlugins(ids)
})

// Handle image pick for plugin config (opens native file dialog)
ipcMain.handle("mods:pick-image", async () => {
  const { dialog } = require("electron")
  const result = await dialog.showOpenDialog({
    title: "Pilih Gambar",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    properties: ["openFile"],
  })
  if (result.canceled || !result.filePaths.length) return { ok: false }
  const filePath = result.filePaths[0]
  // Return both local path and base64 data URL
  const buf  = require("fs").readFileSync(filePath)
  const ext  = require("path").extname(filePath).slice(1).toLowerCase()
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`
  const b64  = `data:${mime};base64,${buf.toString("base64")}`
  return { ok: true, filePath, dataUrl: b64 }
})

// ── Import plugin dari .zip ────────────────────────────────────
// Buka file dialog → extract ZIP → validasi ada index.js → copy ke userData/plugins → hot-reload
// Support: single plugin ZIP, multi-plugin ZIP (banyak folder sekaligus)
ipcMain.handle("mods:import", async () => {
  const { dialog, app } = require("electron")
  const fs   = require("fs")
  const path = require("path")
  const os   = require("os")

  const result = await dialog.showOpenDialog({
    title: "Import Plugin (.zip)",
    filters: [{ name: "Plugin ZIP", extensions: ["zip"] }],
    properties: ["openFile"],
  })
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }

  const zipPath = result.filePaths[0]
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-plugin-"))

  // Extract ZIP — coba adm-zip dulu, fallback ke CLI
  let extracted = false
  try {
    const AdmZip = require("adm-zip")
    new AdmZip(zipPath).extractAllTo(tmpDir, true)
    extracted = true
  } catch (_) {}

  if (!extracted) {
    try {
      const { execSync } = require("child_process")
      if (process.platform === "win32") {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`)
      } else {
        execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`)
      }
      extracted = true
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
      return { ok: false, error: "Gagal extract ZIP. Pastikan 'unzip' terinstall (Linux/Mac) atau coba lagi." }
    }
  }

  // ── Deteksi semua plugin roots dalam ZIP ──────────────────────
  // Case 1: ZIP root langsung = 1 plugin (ada index.js di tmpDir)
  // Case 2: ZIP berisi 1 subfolder plugin
  // Case 3: ZIP berisi BANYAK subfolder plugin (multi-plugin import)
  // Case 4: ZIP berisi 1 wrapper folder → di dalamnya banyak plugin (e.g. plugins/plugin-a/, plugins/plugin-b/)
  const pluginRoots = []

  // Helper: cek apakah sebuah dir adalah plugin valid
  const isPluginDir = (dir) => fs.existsSync(path.join(dir, "index.js"))

  const topEntries = fs.readdirSync(tmpDir, { withFileTypes: true })

  if (isPluginDir(tmpDir)) {
    // Case 1: root langsung adalah plugin
    pluginRoots.push(tmpDir)
  } else {
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue
      const sub = path.join(tmpDir, entry.name)

      if (isPluginDir(sub)) {
        // Case 2 & 3: subfolder langsung adalah plugin
        pluginRoots.push(sub)
      } else {
        // Case 4: subfolder adalah wrapper → scan 1 level lebih dalam
        try {
          const subEntries = fs.readdirSync(sub, { withFileTypes: true })
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue
            const subSub = path.join(sub, subEntry.name)
            if (isPluginDir(subSub)) pluginRoots.push(subSub)
          }
        } catch (_) {}
      }
    }
  }

  if (pluginRoots.length === 0) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    return { ok: false, error: "ZIP tidak valid: tidak ada plugin (index.js) yang ditemukan." }
  }

  // ── Import semua plugin yang terdeteksi ───────────────────────
  const userPluginDir = path.join(app.getPath("userData"), "plugins")
  if (!fs.existsSync(userPluginDir)) fs.mkdirSync(userPluginDir, { recursive: true })

  const mm = getModManager()
  const importResults = []

  for (const pluginRoot of pluginRoots) {
    // Baca manifest untuk plugin id
    let pluginId = path.basename(pluginRoot) || "imported-plugin"
    const manifestPath = path.join(pluginRoot, "manifest.json")
    if (fs.existsSync(manifestPath)) {
      try {
        const mf = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        if (mf.id) pluginId = mf.id.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()
      } catch (_) {}
    }

    try {
      const destDir = path.join(userPluginDir, pluginId)
      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true })
      fs.cpSync(pluginRoot, destDir, { recursive: true })

      // Hot-reload via modManager
      if (mm) {
        await mm._loadPlugin(pluginId, userPluginDir).catch(() => {})
      }

      importResults.push({ id: pluginId, ok: true })
    } catch (e) {
      importResults.push({ id: pluginId, ok: false, error: e.message })
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}

  // Notify UI once after all plugins loaded
  if (mm) mm._notifyUI?.()

  const failed  = importResults.filter(r => !r.ok)
  const success = importResults.filter(r => r.ok)

  // Backward-compat: kalau 1 plugin → return { ok, id }
  // Kalau multi → return { ok, imported: [...], failedCount }
  if (importResults.length === 1) {
    return importResults[0].ok
      ? { ok: true, id: importResults[0].id }
      : { ok: false, error: importResults[0].error }
  }

  return {
    ok: success.length > 0,
    imported: success.map(r => r.id),
    failed: failed.map(r => ({ id: r.id, error: r.error })),
    importedCount: success.length,
    failedCount: failed.length,
  }
})

ipcMain.handle("shell:open-external", async (_e, url) => {
  const { shell } = require("electron")
  // Security: only allow http/https URLs
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url)
    return { ok: true }
  }
  return { ok: false, error: "Invalid URL" }
})

// ── App Lifecycle ─────────────────────────────────────────
app.whenReady().then(() => {
  // [FIX-LINUX-AUDIO] Grant media/audio/video permissions automatically on Linux.
  // On Linux, Chromium's permission system blocks audio output and video autoplay
  // unless the session explicitly grants them. This handler runs before createWindow
  // so the permission grant is in place when the first BrowserWindow loads content.
  //
  // Permissions granted:
  //   media           → getUserMedia (mic/cam) — needed for voice/video calls
  //   audioCapture    → audio capture permission
  //   videoCapture    → video capture permission
  //   mediaKeySystem  → Widevine / DRM (for encrypted media streams)
  //   notifications   → WA notification popups
  //
  // Steam note: When running under Steam Runtime (Proton/Flatpak), the audio
  // subsystem is routed through Steam's PipeWire socket. Granting "media" here
  // ensures Chromium's audio process is allowed to open that socket.
  if (process.platform === "linux") {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      const ALLOWED = new Set([
        "media",
        "audioCapture",
        "videoCapture",
        "mediaKeySystem",
        "notifications",
        "clipboard-sanitized-write",
      ])
      const granted = ALLOWED.has(permission)
      if (!granted) {
        console.log(`[AuroraChat] Permission denied (linux): ${permission}`)
      }
      callback(granted)
    })

    // Also grant permission checks (for already-granted permissions queried via
    // navigator.permissions.query — e.g. autoplay, camera, microphone)
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      const ALLOWED_CHECK = new Set([
        "media",
        "audioCapture",
        "videoCapture",
        "mediaKeySystem",
        "notifications",
        "autoplay",          // navigator.permissions.query({name:'autoplay'})
      ])
      return ALLOWED_CHECK.has(permission)
    })

    console.log("[AuroraChat] Linux session permission handler registered ✓")
  }

  createWindow()
  _startHotReload()  // [HotReload] dev-only watcher — no-op in production
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("will-quit", () => {
  _stopHotReload()
  try { if (db) db.close() } catch (_) { }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ── Session check IPC ────────────────────────────────────
ipcMain.handle("auth:check-session", () => {
  return { hasSession: hasExistingSession() }
})

// ── Profile picture IPC ──────────────────────────────────
ipcMain.handle("profile:get-pic", async (_e, { jid }) => {
  try {
    if (!baileysClient) return { ok: false, url: null }
    // [FIX-PROFILE-PIC] Use getProfilePic (DB cache + 30min network cooldown) not
    // getContactInfo which calls sock.fetchStatus + profilePictureUrl on every call.
    // getContactInfo was causing 2 network round-trips per avatar render.
    const result = await baileysClient.getProfilePic(jid)
    return { ok: true, url: result?.url || null }
  } catch {
    return { ok: false, url: null }
  }
})

// ── Profile update IPC ───────────────────────────────────────────────────
ipcMain.handle("profile:update-name", async (_e, { name }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Not connected" }
    await baileysClient.updateMyName(name)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("profile:remove-picture", async (_e) => {
  try {
    if (!baileysClient) return { ok: false, error: "Not connected" }
    const jid = baileysClient.getSocket()?.user?.id
    if (!jid) return { ok: false, error: "No user JID" }
    await baileysClient.removeProfilePicture(jid)

    // Delete local me.png so sidebar fallbacks to initials immediately
    try {
      const mediaDir = baileysClient.getMediaDir?.()
      if (mediaDir) {
        const picPath = path.join(mediaDir, "Profile", "me.png")
        if (fs.existsSync(picPath)) fs.unlinkSync(picPath)
      }
    } catch (_) {}

    // Bust DB cache
    try { getDB().cacheProfilePic?.(jid, null) } catch (_) {}

    // Notify renderer that own pic was removed → sidebar + profile panel re-render
    win?.webContents.send("profile:pic-updated", { jid, url: null })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("profile:update-picture", async (_e, { buffer }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Not connected" }
    const buf = Buffer.from(buffer)
    await baileysClient.updateMyProfilePicture(buf)

    // Save a local copy as Media/Profile/me.png for instant sidebar load
    try {
      const mediaDir = baileysClient.getMediaDir?.()
      if (mediaDir) {
        const profileDir = path.join(mediaDir, "Profile")
        fs.mkdirSync(profileDir, { recursive: true })
        fs.writeFileSync(path.join(profileDir, "me.png"), buf)
      }
    } catch (_) {}

    // Small delay to let WA propagate, then re-fetch fresh URL
    await new Promise(r => setTimeout(r, 1200))
    const jid = baileysClient.getSocket()?.user?.id
    let freshUrl = null
    if (jid) {
      try {
        // Bust DB cache so getProfilePic fetches fresh
        const db = getDB()
        db.cacheProfilePic?.(jid, undefined)
        const r = await baileysClient.getProfilePic(jid)
        freshUrl = r?.url || null
        if (freshUrl) db.cacheProfilePic?.(jid, freshUrl)
      } catch (_) {}
    }
    win?.webContents.send("profile:pic-updated", { jid, url: freshUrl })
    return { ok: true, url: freshUrl }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── profile:get-own-pic — get media:// URL to local me.png ───────────────────
ipcMain.handle("profile:get-own-pic", async () => {
  try {
    const mediaDir = baileysClient?.getMediaDir?.()
    if (!mediaDir) return { ok: false, path: null }
    const picPath = path.join(mediaDir, "Profile", "me.png")
    const exists = fs.existsSync(picPath)
    if (!exists) return { ok: false, path: null }
    // Return as media:// URL so renderer can load it via the registered protocol
    const mediaUrl = "media://" + picPath
    return { ok: true, path: mediaUrl }
  } catch (err) {
    return { ok: false, path: null }
  }
})

// ── group:update-picture — change group profile picture (admin only) ──────────
ipcMain.handle("group:update-picture", async (_e, { jid, buffer }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const buf = Buffer.from(buffer)
    await baileysClient.updateProfilePicture(jid, buf)
    // Bust DB cache for this group JID and notify renderer
    try {
      const db = getDB()
      db.cacheProfilePic?.(jid, undefined)
    } catch (_) {}
    win?.webContents.send("profile:pic-updated", { jid, url: null, isGroup: true })
    return { ok: true }
  } catch (err) {
    console.error("[AuroraChat] group:update-picture error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── Contact Status fetch ──────────────────────────────────────────────────
ipcMain.handle("contact:fetch-status", async (_e, { jid }) => {
  try {
    if (!baileysClient) return { ok: false, status: null }
    const result = await baileysClient.fetchContactStatus(jid)
    return { ok: true, status: result?.status || null, setAt: result?.setAt || null }
  } catch (err) {
    return { ok: false, status: null, error: err.message }
  }
})

ipcMain.handle("contact:fetch-status-bulk", async (_e, { jids }) => {
  try {
    if (!baileysClient || !Array.isArray(jids)) return { ok: false, data: {} }
    const result = await baileysClient.fetchContactStatusBulk(jids)
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, data: {}, error: err.message }
  }
})

// ── File existence check — renderer uses this to detect missing/deleted media ─
// Accepts raw paths (D:\path\file) or file:// URLs.
ipcMain.handle("fs:exists", (_e, { rawPath }) => {
  try {
    if (!rawPath) return false
    let p = rawPath
    if (p.startsWith("file://")) {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ""))
      p = p.replace(/^([A-Za-z])%3A/i, "$1:")
      if (process.platform !== "win32" && !p.startsWith("/")) p = "/" + p
    } else {
      // Raw Windows path: D:\path → normalize
      p = p.replace(/\\/g, "/")
    }
    return require("fs").existsSync(p)
  } catch {
    return false
  }
})
// ── [F2] Emoji Picker — trigger OS emoji picker via Electron ──────────────────
ipcMain.handle("ui:emoji-picker", async (_e) => {
  try {
    // Windows: mengirim shortcut Win+Period via robotjs atau keyboard shortcut
    // Electron tidak support langsung Win+. injection, tapi bisa via globalShortcut
    // Cara paling simple: kirim pesan balik ke renderer agar dia handle sendiri
    if (win) win.webContents.executeJavaScript(`
      (function() {
        const focused = document.activeElement
        // Trigger native OS emoji picker via keyboard event simulation
        // Windows 10+: Win+. shortcut (harus dihandle di OS level)
        // Electron dapat trigger ini jika windowsManager enabled
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'.',metaKey:true,bubbles:true}))
      })()
    `).catch(() => {})
    return { ok: true }
  } catch (e) { return { ok: false } }
})

// ── [F3] Mark Messages Read via Baileys ──────────────────────────────────────
ipcMain.handle("msg:mark-read", async (_e, { jid, msgIds }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap" }
    if (!Array.isArray(msgIds) || msgIds.length === 0) {
      // Hanya update DB
      getDB().markChatRead(jid)
      return { ok: true, baileys: false }
    }
    // Panggil baileys markRead
    await baileysClient.markRead(jid, msgIds)
    return { ok: true, baileys: true }
  } catch (e) {
    // Jika Baileys error, tetap update DB
    try { getDB().markChatRead(jid) } catch {}
    return { ok: false, error: e.message }
  }
})

// ════════════════════════════════════════════════════════════
// DEV EVAL — Baileys Sandbox (v10)
// Terinspirasi dari pattern > / => di case.js bot
//
// KEAMANAN:
//   • Hanya bisa diakses dari renderer (contextIsolation = true)
//   • Tidak ada akses dari luar proses Electron
//   • Variabel yang di-inject terbatas: sock, db, baileys, util, path, fs
//   • Tidak di-expose ke webContents dari window lain
//   • [SECURITY] Blocklist untuk API berbahaya: child_process, eval native, dll
//   • [SECURITY] Code length limit — cegah DoS via giant eval
//
// MODE:
//   "expr"  → eval satu ekspresi, auto-return (seperti => di case.js)
//   "block" → eval multi-statement block async (seperti > di case.js)
// ════════════════════════════════════════════════════════════
ipcMain.handle("dev:eval", async (_e, { code, mode, msgId, chatJid, fullOutput }) => {
  if (!code || typeof code !== "string") return { ok: false, error: "Code kosong" }

  // ── [SECURITY] Code length limit — cegah giant payload ──────────────────
  if (code.length > 50_000) return { ok: false, error: "Code terlalu panjang (max 50.000 karakter)" }

  // ── [SECURITY] Blocklist pola berbahaya ───────────────────────────────────
  // Cek string literal untuk API yang tidak boleh dipanggil dari eval
  const DANGEROUS_PATTERNS = [
    // Native shell/exec — block child_process entirely
    /require\s*\(\s*['"`]child_process['"`]\s*\)/,
    /child_process/,
    /\.execSync\s*\(/,
    /\.spawnSync\s*\(/,
    // Native eval bypass
    /\bnative\s+code\b/i,
    /Function\s*\(\s*['"`]return\s+this/,
    // VM module escape
    /require\s*\(\s*['"`]vm['"`]\s*\)/,
    // Electron dangerous APIs
    /app\s*\.\s*quit\s*\(/,
    /app\s*\.\s*exit\s*\(/,
    /BrowserWindow/,
    /autoUpdater/,
    // Exfil via raw Node network modules (fetch is fine)
    /require\s*\(\s*['"`]https?['"`]\s*\)/,
    /require\s*\(\s*['"`]net['"`]\s*\)/,
    /require\s*\(\s*['"`]dgram['"`]\s*\)/,
  ]

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return { ok: false, error: `[Security] Pola berbahaya terdeteksi: ${pattern.toString().slice(0, 60)}` }
    }
  }

  const util    = require("util")
  const sock    = baileysClient?.getSocket?.() || null
  const db_     = getDB()
  const { dialog } = require("electron")

  let baileys = {}
  try { baileys = require("baileys") } catch {}

  const client = baileysClient || {}

  // ── buildSmsg — full smsg implementation, faithful to myfunc.js exports.smsg ──
  // Every field and helper from myfunc.js is present here.  The only differences
  // from the original are:
  //   • "dims" (the Baileys sock object) is our `sock` from baileysClient
  //   • "store.loadMessage" is replaced by a DB lookup + client cache fallback
  //   • appenTextMessage is attached to `m` (not to `sock`) so it travels with m
  //   • Extra DB fallbacks so old messages without raw_json still build a full m
  function buildSmsg(row, msgJson, key) {
    const { getContentType, proto: _proto, generateWAMessage, areJidsSameUser } = baileys
    const M = _proto?.WebMessageInfo   // may be undefined on older wileys builds

    // ── decodeJid — identical to dims.decodeJid in myfunc.js ────────────────
    const decodeJid = (jid) => {
      if (!jid) return jid
      if (/:\d+@/gi.test(jid)) {
        try {
          const { jidDecode } = baileys
          const decoded = jidDecode(jid) || {}
          return (decoded.user && decoded.server ? decoded.user + "@" + decoded.server : jid)
        } catch { return jid }
      }
      return jid
    }

    // ── dims shim — expose sock as "dims" so helpers below read naturally ────
    const dims = sock   // sock === dims in myfunc.js context

    const cJid   = key.remoteJid || ""
    const fromMe = key.fromMe || false
    const isGroup = cJid.endsWith("@g.us")

    // ── m.key block (myfunc.js lines 1-8) ───────────────────────────────────
    const m = {}
    m.key      = key
    m.id       = key.id
    m.isBaileys = !!(m.id && m.id.startsWith("BAE5") && m.id.length === 16)
    m.chat     = cJid
    m.fromMe   = fromMe
    m.isGroup  = isGroup
    // [FIX-GROUP-PARTICIPANT] Participant yang sama dengan remoteJid (@g.us) adalah
    // data bogus dari history sync proto WA — abaikan, jangan dipakai sebagai sender.
    const _vKeyP = (m.key?.participant && m.key.participant !== cJid) ? m.key.participant : undefined
    const _vRowP = (row?.participant   && row.participant   !== cJid) ? row.participant   : undefined

    m.sender   = decodeJid(
      (fromMe && dims?.user?.id) ||
      _vKeyP ||
      _vRowP ||
      cJid || ""
    )
    if (isGroup) m.participant = decodeJid(_vKeyP || _vRowP || "") || ""

    // ── m.message block (myfunc.js lines 9-ff) ──────────────────────────────
    m.message = msgJson || {}

    // mtype — prefer Baileys getContentType, fall back to DB column
    m.mtype = (getContentType ? getContentType(m.message) : null) || row?.message_type || "conversation"

    // m.msg — unwrap viewOnce exactly like myfunc.js
    // myfunc: m.mtype == 'viewOnceMessage' ? m.message[m.mtype].message[getContentType(...)] : m.message[m.mtype]
    if (m.mtype === "viewOnceMessage" && m.message[m.mtype]?.message) {
      const innerType = getContentType ? getContentType(m.message[m.mtype].message) : Object.keys(m.message[m.mtype].message)[0]
      m.msg = m.message[m.mtype].message[innerType] || m.message[m.mtype]
    } else {
      m.msg = m.message[m.mtype] || {}
    }

    // Ensure m.msg is always an object (conversation is a top-level string, not nested)
    if (typeof m.msg === "string") m.msg = { text: m.msg }
    if (!m.msg || typeof m.msg !== "object") m.msg = {}

    // m.body — exact chain from myfunc.js, plus AuroraChat extras
    m.body =
      m.message?.conversation ||
      m.msg?.caption ||
      m.msg?.text ||
      (m.mtype === "listResponseMessage" ? m.msg?.singleSelectReply?.selectedRowId : null) ||
      (m.mtype === "buttonsResponseMessage" ? m.msg?.selectedButtonId : null) ||
      (m.mtype === "templateButtonReplyMessage" ? m.msg?.selectedId : null) ||
      (m.mtype === "viewOnceMessage" ? m.msg?.caption : null) ||
      m.msg?.contentText ||
      m.msg?.selectedDisplayText ||
      m.msg?.title ||
      m.msg?.name ||
      row?.body ||
      m.text ||
      ""

    // m.quoted — raw quotedMessage from contextInfo (myfunc.js: let quoted = m.quoted = ...)
    let quoted = m.quoted = m.msg?.contextInfo?.quotedMessage || null

    // DB fallback: reconstruct quoted from stored context columns when contextInfo absent
    if (!quoted && row?.context_stanza_id) {
      try {
        if (row.context_quoted_message) quoted = m.quoted = JSON.parse(row.context_quoted_message)
      } catch {}
    }

    // m.mentionedJid (myfunc.js line)
    m.mentionedJid = m.msg?.contextInfo?.mentionedJid || []
    if (!m.mentionedJid.length) {
      try { m.mentionedJid = JSON.parse(row?.mentioned_jids || "[]") || [] } catch {}
    }

    // m.caption alias (myfunc.js: if (m.msg.caption) m.caption = m.msg.caption)
    if (m.msg.caption) m.caption = m.msg.caption

    // ── m.quoted expansion (myfunc.js lines 22-ff) ──────────────────────────
    if (m.quoted) {
      // Step 1: getContentType on the raw quoted object → type key
      let type = getContentType ? getContentType(quoted) : Object.keys(quoted)[0]
      m.quoted = m.quoted[type]   // unwrap one level (myfunc: m.quoted = m.quoted[type])

      // Step 2: productMessage double-unwrap (myfunc.js lines)
      if (["productMessage"].includes(type)) {
        type = getContentType ? getContentType(m.quoted) : Object.keys(m.quoted || {})[0]
        m.quoted = m.quoted?.[type]
      }

      // Step 3: scalar string → { text } (myfunc.js)
      if (typeof m.quoted === "string") m.quoted = { text: m.quoted }
      if (!m.quoted || typeof m.quoted !== "object") m.quoted = {}

      // Step 4: all metadata fields (myfunc.js exact field names)
      m.quoted.mtype     = type
      m.quoted.id        = m.msg?.contextInfo?.stanzaId       || row?.context_stanza_id || null
      m.quoted.chat      = m.msg?.contextInfo?.remoteJid      || cJid
      m.quoted.isBaileys = !!(m.quoted.id && m.quoted.id.startsWith("BAE5") && m.quoted.id.length === 16)
      m.quoted.sender    = decodeJid(m.msg?.contextInfo?.participant || row?.context_participant || "")
      m.quoted.fromMe    = m.quoted.sender === (dims?.user && dims.user.id)
      // m.quoted.text — full chain from myfunc.js
      m.quoted.text      =
        m.quoted.text || m.quoted.caption || m.quoted.conversation ||
        m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || ""
      m.quoted.mentionedJid = m.msg?.contextInfo?.mentionedJid || []

      // m.getQuotedObj / m.getQuotedMessage — async loader (myfunc.js exact)
      // Uses DB getMessageById as substitute for store.loadMessage
      m.getQuotedObj = m.getQuotedMessage = async () => {
        if (!m.quoted.id) return false
        // 1. Try DB lookup
        try {
          const qRow = db_?.getMessageById?.(m.quoted.id)
          if (qRow) {
            let qJson = {}
            try { if (qRow.message_json) qJson = JSON.parse(qRow.message_json) } catch {}
            const qKey = {
              remoteJid: m.quoted.chat,
              fromMe:    m.quoted.fromMe,
              id:        m.quoted.id,
              ...(isGroup && m.quoted.sender ? { participant: m.quoted.sender } : {}),
            }
            return buildSmsg(qRow, qJson, qKey)
          }
        } catch {}
        // 2. Try client raw-message cache
        try {
          const client_ = require("./baileys/client")
          const rawMsg  = client_?.getRawMsg?.(m.quoted.id)
          if (rawMsg) return buildSmsg(row, rawMsg?.message || {}, rawMsg?.key || key)
        } catch {}
        return false
      }

      // fakeObj — M.fromObject WAMessage for delete/forward/download (myfunc.js exact)
      const vM = m.quoted.fakeObj = M?.fromObject
        ? M.fromObject({
            key: {
              remoteJid: m.quoted.chat,
              fromMe:    m.quoted.fromMe,
              id:        m.quoted.id,
            },
            message: quoted,
            ...(isGroup ? { participant: m.quoted.sender } : {}),
          })
        : {  // graceful fallback when proto not available
            key: { remoteJid: m.quoted.chat, fromMe: m.quoted.fromMe, id: m.quoted.id },
            message: quoted,
          }

      // m.quoted.delete — myfunc.js: () => dims.sendMessage(m.quoted.chat, { delete: vM.key })
      m.quoted.delete = () => dims?.sendMessage?.(m.quoted.chat, { delete: vM.key })

      // m.quoted.copyNForward — myfunc.js: (jid, forceForward, options) => dims.copyNForward(...)
      m.quoted.copyNForward = (jid, forceForward = false, options = {}) =>
        dims?.copyNForward?.(jid, vM, forceForward, options)

      // m.quoted.download — myfunc.js: () => dims.downloadMediaMessage(m.quoted)
      m.quoted.download = () => dims?.downloadMediaMessage?.(m.quoted)
    }

    // ── m.download (myfunc.js: if (m.msg.url) m.download = ...) ────────────
    // myfunc: m.download = () => dims.downloadMediaMessage(m.msg)
    if (m.msg?.url || m.msg?.mediaKey) {
      m.download = () => dims?.downloadMediaMessage?.(m.msg)
    }

    // ── m.text (myfunc.js exact line) ────────────────────────────────────────
    m.text =
      m.msg?.text || m.msg?.caption || m.message?.conversation ||
      m.msg?.contentText || m.msg?.selectedDisplayText || m.msg?.title || ""

    // ── m.reply (myfunc.js exact: Buffer → sendMedia, string → sendText) ─────
    // myfunc: (text, chatId, options) => Buffer? dims.sendMedia(...) : dims.sendText(...)
    m.reply = (text, chatId = cJid, options = {}) => {
      if (Buffer.isBuffer(text)) {
        // sendMedia equivalent via sock.sendMessage
        return dims?.sendMessage?.(chatId, { document: text, mimetype: "application/octet-stream", ...options }, { quoted: key ? { key, message: m.message } : undefined })
      }
      return dims?.sendMessage?.(chatId, { text, ...options }, { quoted: key ? { key, message: m.message } : undefined })
    }

    // ── m.copy (myfunc.js: () => smsg(dims, M.fromObject(M.toObject(m)))) ────
    m.copy = () => {
      if (M?.fromObject && M?.toObject) {
        const fullMsg = M.fromObject({
          key, message: m.message,
          messageTimestamp: row?.message_timestamp || 0,
          pushName: row?.push_name || null,
        })
        const plain = M.toObject(fullMsg)
        return buildSmsg(row, plain?.message || m.message, plain?.key || key)
      }
      return buildSmsg(row, m.message, key)
    }

    // ── m.copyNForward (myfunc.js exact) ────────────────────────────────────
    // myfunc: (jid, forceForward, options) => dims.copyNForward(jid, m, forceForward, options)
    m.copyNForward = (jid = cJid, forceForward = false, options = {}) => {
      const fakeWA = M?.fromObject
        ? M.fromObject({ key, message: m.message, messageTimestamp: row?.message_timestamp || 0 })
        : { key, message: m.message }
      return dims?.copyNForward?.(jid, fakeWA, forceForward, options)
    }

    // ── appenTextMessage (myfunc.js exact — injects into Baileys event bus) ──
    // myfunc attaches this to `dims` (the sock). We attach to `m` instead so it
    // travels with the message object without mutating the shared sock reference.
    m.appenTextMessage = async (text, chatUpdate = {}) => {
      if (!generateWAMessage || !dims) return
      try {
        const messages = await generateWAMessage(
          cJid,
          { text, mentions: m.mentionedJid },
          { userJid: dims?.user?.id, quoted: m.quoted?.fakeObj || null }
        )
        messages.key.fromMe = areJidsSameUser
          ? areJidsSameUser(m.sender, dims?.user?.id)
          : m.fromMe
        messages.key.id   = m.id
        messages.pushName = row?.push_name || m.pushName || null
        if (isGroup) messages.participant = m.sender
        const msg = {
          ...chatUpdate,
          messages: [_proto?.WebMessageInfo?.fromObject
            ? _proto.WebMessageInfo.fromObject(messages)
            : messages],
          type: "append",
        }
        dims?.ev?.emit?.("messages.upsert", msg)
      } catch (err) {
        console.warn("[buildSmsg.appenTextMessage]", err.message)
      }
    }

    return m
  }

  // ── Build smsg "m" object from DB row ─────────────────────────────────────
  let mObj = null
  if (msgId && db_) {
    try {
      const row = db_.getMessageById?.(msgId) || null
      if (row) {
        const cJid     = chatJid || row.remote_jid || ""
        const msgType  = row.message_type || "conversation"
        const isGroup  = cJid.endsWith("@g.us")
        const fromMe   = row.from_me === 1
        // [FIX-GROUP-PARTICIPANT] Skip participant bila sama dengan group JID (data bogus history sync)
        const _validPart = (row.participant && row.participant !== cJid) ? row.participant : undefined
        const senderJid = isGroup
          ? (_validPart || cJid)
          : (fromMe ? (sock?.user?.id || cJid) : cJid)

        // Parse stored raw message JSON (WAMessage proto)
        let msgJson = {}
        try { if (row.message_json) msgJson = JSON.parse(row.message_json) } catch {}

        // Kalau message_json NULL (pesan lama), reconstruct dari kolom DB
        if (!msgJson || !Object.keys(msgJson).length) {
          const inner = {}
          const body = row.body || ""
          const mime = row.media_mimetype || ""

          // Text fields
          if (msgType === "conversation") {
            inner.conversation = body
          } else if (msgType === "extendedTextMessage") {
            inner.text = body
          } else if (mime.startsWith("image/") || msgType === "imageMessage") {
            inner.caption = body
            if (row.media_url)        inner.url          = row.media_url
            if (row.media_key)        inner.mediaKey     = row.media_key
            if (row.media_mimetype)   inner.mimetype     = row.media_mimetype
            if (row.media_file_length) inner.fileLength  = row.media_file_length
            if (row.media_width)      inner.width        = row.media_width
            if (row.media_height)     inner.height       = row.media_height
            if (row.media_direct_path) inner.directPath  = row.media_direct_path
            if (row.media_sha256)     inner.fileSha256   = row.media_sha256
            if (row.media_enc_sha256) inner.fileEncSha256 = row.media_enc_sha256
          } else if (mime.startsWith("video/") || msgType === "videoMessage") {
            inner.caption = body
            if (row.media_url)        inner.url          = row.media_url
            if (row.media_key)        inner.mediaKey     = row.media_key
            if (row.media_mimetype)   inner.mimetype     = row.media_mimetype
            if (row.media_file_length) inner.fileLength  = row.media_file_length
            if (row.media_width)      inner.width        = row.media_width
            if (row.media_height)     inner.height       = row.media_height
            if (row.media_duration)   inner.seconds      = row.media_duration
            if (row.media_direct_path) inner.directPath  = row.media_direct_path
            if (row.is_gif)           inner.gifPlayback  = !!(row.is_gif)
          } else if (mime.startsWith("audio/") || msgType === "audioMessage" || msgType === "pttMessage") {
            if (row.media_url)        inner.url          = row.media_url
            if (row.media_key)        inner.mediaKey     = row.media_key
            if (row.media_mimetype)   inner.mimetype     = row.media_mimetype
            if (row.media_duration)   inner.seconds      = row.media_duration
            if (row.is_ptt)           inner.ptt          = !!(row.is_ptt)
          } else if (msgType === "documentMessage") {
            inner.caption = body
            if (row.media_url)        inner.url          = row.media_url
            if (row.media_key)        inner.mediaKey     = row.media_key
            if (row.media_mimetype)   inner.mimetype     = row.media_mimetype
            if (row.media_file_name)  inner.fileName     = row.media_file_name
            if (row.media_file_length) inner.fileLength  = row.media_file_length
          } else if (msgType === "stickerMessage") {
            if (row.media_url)        inner.url          = row.media_url
            if (row.media_key)        inner.mediaKey     = row.media_key
            if (row.media_mimetype)   inner.mimetype     = row.media_mimetype
            if (row.is_animated)      inner.isAnimated   = !!(row.is_animated)
          } else if (msgType === "reactionMessage") {
            inner.text         = row.reaction_text || ""
            inner.key          = { id: row.reaction_target_id, remoteJid: row.reaction_target_remote_jid, fromMe: !!(row.reaction_target_from_me) }
          } else if (msgType === "locationMessage") {
            inner.degreesLatitude  = row.location_lat  || 0
            inner.degreesLongitude = row.location_lng  || 0
            inner.name             = body || ""
          }

          // Quoted / contextInfo
          if (row.context_stanza_id) {
            inner.contextInfo = {
              stanzaId:    row.context_stanza_id,
              participant: row.context_participant || undefined,
              isForwarded: !!(row.context_is_forwarded),
              forwardingScore: row.context_forwarding_score || 0,
            }
            try {
              if (row.context_quoted_message) inner.contextInfo.quotedMessage = JSON.parse(row.context_quoted_message)
            } catch {}
            try {
              if (row.context_mentioned_jids) inner.contextInfo.mentionedJid = JSON.parse(row.context_mentioned_jids)
            } catch {}
          }

          msgJson = { [msgType]: inner }
          msgJson._reconstructed = true  // tandai ini hasil reconstruct bukan proto asli
        }

        // Inner msg = first content key (skip transport-layer wrappers for msg field only)
        const SKIP = new Set(["messageContextInfo", "senderKeyDistributionMessage",
                               "botInvokeMessage", "nativeFlowMessage"])
        const contentKeys = Object.keys(msgJson).filter(k => !SKIP.has(k))
        let innerMsg = {}
        const innerKey = contentKeys[0] || msgType
        innerMsg = msgJson[innerKey] || msgJson

        // Parse mentioned JIDs
        let mentionedJid = []
        try { mentionedJid = JSON.parse(row.mentioned_jids || "[]") } catch {}
        // Also pull from contextInfo
        if (!mentionedJid.length && innerMsg?.contextInfo?.mentionedJid)
          mentionedJid = innerMsg.contextInfo.mentionedJid || []

        // Reconstruct key
        const key = { remoteJid: cJid, fromMe, id: msgId }
        if (isGroup && row.participant) key.participant = row.participant

        // Reconstruct quoted
        let quoted = null
        if (row.context_stanza_id) {
          let qMsgJson = {}
          let qType = row.context_quoted_message || null
          try { if (qType) qMsgJson = JSON.parse(qType) } catch {}
          const qKey = {
            remoteJid: cJid, fromMe: false, id: row.context_stanza_id
          }
          if (isGroup && row.context_participant) qKey.participant = row.context_participant
          quoted = {
            key: qKey,
            message: qMsgJson,
            sender: row.context_participant || null,
            body: row.body ? "" : null,  // quoted body is separate in WA
          }
        }

        const body = row.body || innerMsg?.text || innerMsg?.caption ||
                     innerMsg?.conversation || ""

        // ── Build smsg-style object via buildSmsg() ────────────────────
        mObj = buildSmsg(row, msgJson, key)

        // ── Tambahan field AuroraChat (tidak ada di smsg standar) ──────
        mObj.messageTimestamp  = row.message_timestamp || row.timestamp || 0
        mObj.pushName          = row.push_name || null
        mObj.broadcast         = false
        mObj.chatId            = cJid
        mObj.chatLid           = ""
        mObj.from              = cJid
        mObj.isBroadcast       = cJid.includes("broadcast")
        mObj.isStatusBroadcast = cJid === "status@broadcast"
        mObj.isNewsletter      = cJid.endsWith("@newsletter")
        mObj.isUser            = !isGroup && !cJid.endsWith("@newsletter")
        mObj.senderId          = senderJid

        // cmd/args parsing (bot-style, sama seperti case.js)
        const cmdPrefix = /^[.!#/]/.test(mObj.body)
        const parts     = (mObj.body || "").trim().split(/\s+/)
        mObj.isCmd = cmdPrefix
        mObj.cmd   = parts[0] || ""
        mObj.args  = parts.slice(1)

        // ── Media fields dari DB (tambahan di atas smsg standar) ───────
        if (row.media_mimetype || row.has_media) {
          const mime       = row.media_mimetype || ""
          const isImage    = msgType === "imageMessage"    || mime.startsWith("image/")
          const isVideo    = msgType === "videoMessage"    || mime.startsWith("video/")
          const isAudio    = msgType === "audioMessage"    || mime.startsWith("audio/") || msgType === "pttMessage"
          const isDoc      = msgType === "documentMessage"
          const isSticker  = msgType === "stickerMessage"
          const isViewOnce = msgType.includes("viewOnce")

          mObj.hasMedia       = true
          mObj.mimetype       = mime
          mObj.mediaUrl       = row.media_url || null
          mObj.mediaKey       = row.media_key || null
          mObj.fileLength     = row.media_file_length || null
          mObj.fileName       = row.media_file_name || row.media_filename || null
          mObj.mediaSavedPath = row.media_saved_path || null

          if (isImage || isVideo || isSticker) {
            mObj.width  = row.media_width  || mObj.msg?.width  || null
            mObj.height = row.media_height || mObj.msg?.height || null
          }
          if (isAudio || isVideo) {
            mObj.duration = row.media_duration || mObj.msg?.seconds || null
            mObj.isPtt    = msgType === "pttMessage" || !!(row.is_ptt)
            mObj.isGif    = !!(row.is_gif)
          }
          if (isSticker)  mObj.isAnimated = !!(row.is_animated)
          if (isViewOnce) mObj.isViewOnce = true
          if (isDoc) {
            mObj.pageCount = mObj.msg?.pageCount || null
            mObj.title     = mObj.msg?.title || row.media_filename || null
          }
        }
      }
    } catch (e) {
      console.warn("[DevEval] m build error:", e.message)
    }
  }

  // Fallback m stub
  if (!mObj) mObj = {
    id: msgId || null, chatId: chatJid || null, body: "", mtype: "unknown",
    fromMe: false, isGroup: false, msg: {}, quoted: null, mentionedJid: [], text: "",
    isCmd: false, cmd: "", args: [], reply: () => null,
  }

  const ctx = {
    // require/Buffer/process must be explicit — new Function() creates a fresh scope
    // with NO inherited variables, so these are not available otherwise.
    require,
    Buffer, process,
    sock, dims: sock, ws: sock,
    db: db_, baileys, client, util,
    path: require("path"), fs: require("fs"),
    m: mObj, msg: mObj, message: mObj,
    fmt:  (v) => {
      if (typeof v === "function") {
        const name = v.name ? `[Function: ${v.name}]` : "[Function (anonymous)]"
        try { return `${name}\n${"─".repeat(60)}\n${v.toString()}` } catch { return name }
      }
      return util.inspect(v, { depth: 12, colors: false, compact: false, maxArrayLength: Infinity, maxStringLength: Infinity })
    },
    json: (v) => JSON.stringify(v, null, 2),
    log:  (v) => { console.log("[DevEval]", typeof v === "object" ? JSON.stringify(v, null, 2) : v); return v },
  }

  try {
    let result
    if (mode === "expr") {
      // Expr mode: wrapping code as `return (${code})` breaks if the code starts with
      // const/let/var/await/etc — those are statements, not expressions, so V8 throws
      // "Unexpected token 'const'" at parse time. Detect and use a block body instead.
      const trimmed = code.trim()
      const looksLikeBlock = /^(const|let|var|function|class|if|for|while|switch|try|return|await\s|throw)\b/.test(trimmed)
      const fnBody = looksLikeBlock
        ? `return (async () => { ${trimmed} })()`           // block path — user needs return
        : `return (async () => { return (${trimmed}) })()` // expression path — auto-return
      const fn = new Function(...Object.keys(ctx), fnBody)
      result = await fn(...Object.values(ctx))
    } else {
      const fn = new Function(...Object.keys(ctx), `return (async () => { ${code} })()`)
      result = await fn(...Object.values(ctx))
    }

    let output
    if (result === undefined) output = "undefined"
    else if (result === null)  output = "null"
    else if (typeof result === "function") {
      // ── Pretty-print function source (e.g. sock.updateProfileName.toString()) ──
      // util.inspect on a function only shows [Function: name], which is useless.
      // toString() gives the actual source — format it cleanly.
      try {
        const src = result.toString()
        const name = result.name ? `[Function: ${result.name}]` : "[Function (anonymous)]"
        output = `${name}\n${"─".repeat(60)}\n${src}`
      } catch { output = String(result) }
    }
    else {
      try {
        output = util.inspect(result, {
          depth: 12,
          colors: false,
          compact: false,
          maxArrayLength: fullOutput ? Infinity : 500,
          maxStringLength: fullOutput ? Infinity : 20000,
          breakLength: 140,
        })
      } catch { output = String(result) }
    }

    return { ok: true, result: output, type: typeof result }
  } catch (err) {
    // ── Improved error output ─────────────────────────────────────────────────
    // Parse the stack to extract the user's eval line (column position)
    // and rewrite internal noise paths so the output is readable.
    const message = err.message || String(err)
    const errorType = err.constructor?.name || "Error"
    let cleanStack = null

    if (err.stack) {
      const lines = err.stack.split("\n")
      const cleaned = []
      for (const line of lines) {
        const trimmed = line.trim()
        // Skip internal electron/node internals noise
        if (/node:electron\/|node:events|node:internal\/|at eval \(eval at <anonymous>/.test(trimmed)) continue
        // Rewrite eval synthetic frame to show user code line/col
        const evalMatch = trimmed.match(/at eval \(<anonymous>:(\d+):(\d+)\)/)
        if (evalMatch) {
          // line 1 = wrapper boilerplate; line 2+ = user code offset by 1
          const userLine = Math.max(1, parseInt(evalMatch[1], 10) - 1)
          const col      = evalMatch[2]
          cleaned.push(`    at <eval>:${userLine}:${col}`)
          continue
        }
        cleaned.push(line)
      }
      // Always include the TypeError/ReferenceError headline
      if (cleaned.length && !cleaned[0].startsWith(errorType)) {
        cleaned.unshift(`${errorType}: ${message}`)
      }
      cleanStack = cleaned.join("\n").trim()
    }

    return {
      ok: false,
      error: `${errorType}: ${message}`,
      stack: cleanStack || err.stack || null,
    }
  }
})

// ── DevEval: save output to file ─────────────────────────────────────────────
ipcMain.handle("dev:save-file", async (_e, { content, filename }) => {
  try {
    const { dialog } = require("electron")
    const result = await dialog.showSaveDialog({
      title: "Simpan Output DevEval",
      defaultPath: filename || "deveval_output.txt",
      filters: [
        { name: "Text Files", extensions: ["txt", "json", "log"] },
        { name: "All Files",  extensions: ["*"] },
      ],
    })
    if (result.canceled || !result.filePath) return { ok: false, reason: "canceled" }
    require("fs").writeFileSync(result.filePath, content, "utf-8")
    return { ok: true, path: result.filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ════════════════════════════════════════════════════════════════════════════
// [FIX-3] SETTINGS — Auto Download Media & App Settings
// ════════════════════════════════════════════════════════════════════════════

// [FIX-3] Lazy path — evaluated after app is ready (app.getPath needs app:ready)
function getSettingsPath() {
  return path.join(require("electron").app.getPath("userData"), "wplus_settings.json")
}

ipcMain.handle("settings:load", () => {
  try {
    const fs = require("fs")
    const p = getSettingsPath()
    if (!fs.existsSync(p)) return { ok: true, data: {} }
    return { ok: true, data: JSON.parse(fs.readFileSync(p, "utf8")) }
  } catch { return { ok: true, data: {} } }
})

ipcMain.handle("settings:save", (_e, settings) => {
  try {
    require("fs").writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8")
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("settings:set-ram-limit", (_e, { mb }) => {
  try {
    const fs = require("fs")
    const p = getSettingsPath()
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(p, "utf8")) } catch (_) {}
    const safeMb = Math.min(512, Math.max(32, parseInt(mb, 10) || 256))
    existing.ramLimitMb = safeMb
    fs.writeFileSync(p, JSON.stringify(existing, null, 2), "utf8")
    // Note: RAM limit change requires app restart to take effect (V8 heap set at boot)
    return { ok: true, mb: safeMb, requiresRestart: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("settings:set-auto-download", (_e, { enabled }) => {
  try {
    const fs = require("fs")
    const p = getSettingsPath()
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(p, "utf8")) } catch (_) {}
    existing.autoDownloadMedia = !!enabled
    fs.writeFileSync(p, JSON.stringify(existing, null, 2), "utf8")
    baileysClient?.setAutoDownloadMedia?.(!!enabled)
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

// [FIX-LID-CLICK] On-demand LID re-resolution — called when user clicks a chat
// with a suspicious JID (long numeric @s.whatsapp.net or @lid). Triggers a
// full resolveLidRows pass which will remap lid-promoted JIDs to real phones.
ipcMain.handle("lid:resolve-now", () => {
  try {
    if (!baileysClient) return { ok: false }
    baileysClient.resolveLidNow?.()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// [FIX-LID-QUOTED] Expose full lidMap snapshot to renderer.
// Called once after loadContacts() to build a secondary @lid → phone lookup
// used by normalizeMsg when resolving quoted_sender of type @lid.
ipcMain.handle("lid:get-map", () => {
  try {
    if (!baileysClient) return { ok: true, data: {} }
    const entries = baileysClient.getLidMapEntries?.() || {}
    return { ok: true, data: entries }
  } catch (err) {
    return { ok: false, error: err.message, data: {} }
  }
})

// ── group:get-metadata — fetch full group metadata from Baileys ──────────────
// Returns the raw groupMetadata object: subject, desc, participants, settings…
ipcMain.handle("group:get-metadata", async (_e, { jid }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const meta = await baileysClient.getGroupMetadata(jid)
    // Persist member count to DB so header can show it without re-fetching
    if (meta?.participants?.length && getDB?.()) {
      try { getDB().updateMemberCount?.(jid, meta.participants.length) } catch (_) {}
    }
    return { ok: true, data: meta }
  } catch (err) {
    console.error("[AuroraChat] group:get-metadata error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── group:get-invite-link — get invite link for a group ──────────────────────
ipcMain.handle("group:get-invite-link", async (_e, { jid }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const code = await baileysClient.getGroupInviteLink(jid)
    return { ok: true, link: `https://chat.whatsapp.com/${code}`, code }
  } catch (err) {
    console.error("[AuroraChat] group:get-invite-link error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── group:send-status-v2 — upload media ke status grup (groupStatusMessageV2) ──
ipcMain.handle("group:send-status-v2", async (_e, { jid, content }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    if (!jid || !jid.endsWith("@g.us")) return { ok: false, error: "JID harus berupa grup (@g.us)" }
    if (!content || typeof content !== "object") return { ok: false, error: "Content tidak valid" }

    // ── Mode A: buffer dari file picker ──────────────────────────────────
    if (content._isText) {
      // [TEXT STATUS] Kirim sebagai extendedTextMessage dengan background color & font
      const text  = content._text?.trim()
      if (!text) return { ok: false, error: "Teks tidak boleh kosong" }

      const bg   = content._backgroundColor || '#25C3DC'
      const font = typeof content._font === 'number' ? content._font : 0

      // Convert hex color string → ARGB uint32 (WA format: 0xFFRRGGBB)
      function hexToArgb(hex) {
        const h = hex.replace('#', '')
        const r = parseInt(h.slice(0,2), 16)
        const g = parseInt(h.slice(2,4), 16)
        const b = parseInt(h.slice(4,6), 16)
        return (0xFF000000 | (r << 16) | (g << 8) | b) >>> 0
      }

      const textPayload = {
        text,
        backgroundColor: hexToArgb(bg),
        textArgb: 0xFFFFFFFF,
        font,
      }

      const myJid = baileysClient.getMyJid()
      if (!myJid) return { ok: false, error: "Tidak bisa resolve JID sendiri" }

      const sent = await baileysClient.sendMessageRaw(myJid, textPayload)
      if (!sent?.message) return { ok: false, error: "Gagal upload text status ke WA" }

      try { await baileysClient.deleteMessage(myJid, sent.key) } catch (_) {}

      const msgObj = JSON.parse(JSON.stringify(sent.message))
      await baileysClient.relayMessage(jid, { groupStatusMessageV2: { message: msgObj } }, {})
      return { ok: true }
    }

    if (content._buffer && content._mimetype) {
      const buf     = Buffer.from(content._buffer)
      const mime    = content._mimetype
      const isVideo = content._isVideo || mime.startsWith("video/")
      const isImage = content._isImage || mime.startsWith("image/")
      const isAudio = content._isAudio || mime.startsWith("audio/")
      const caption = content._caption || ""

      // Upload media ke diri sendiri dulu untuk dapat CDN URL dari WA,
      // lalu relay ke grup sebagai groupStatusMessageV2.
      // groupStatusMessageV2 TIDAK butuh statusJidList — itu untuk personal status broadcast.
      let payload
      if (isImage) {
        payload = { image: buf, mimetype: mime || "image/jpeg", caption }
      } else if (isVideo) {
        payload = { video: buf, mimetype: "video/mp4", caption, gifPlayback: false }
      } else if (isAudio) {
        payload = {
          audio: buf,
          mimetype: mime || "audio/mp4",
          ptt: true,
          waveform: [100, 0, 100, 0, 100, 0, 100],
        }
      } else {
        payload = { document: buf, mimetype: mime, fileName: "media" }
      }

      const myJid = baileysClient.getMyJid()
      if (!myJid) return { ok: false, error: "Tidak bisa resolve JID sendiri" }

      // Kirim ke diri sendiri untuk upload ke CDN WA dan dapat WAMessage dengan mediaKey dll
      const sent = await baileysClient.sendMessageRaw(myJid, payload)
      if (!sent?.message) return { ok: false, error: "Gagal upload media ke WA" }

      // Hapus pesan dummy dari chat diri sendiri
      try { await baileysClient.deleteMessage(myJid, sent.key) } catch (_) {}

      // [FIX-CDN-PROPAGATION] Untuk video/audio, tunggu CDN WA selesai propagate file
      // sebelum relay ke grup. Kalau relay terlalu cepat, penerima fetch URL yang belum
      // ready di edge server → "error playing video" sampai mereka retry beberapa detik kemudian.
      // Cara: poll HEAD request ke directPath/url sampai server return 200/302, max 15s.
      if (isVideo || isAudio) {
        const msgInner = sent.message?.videoMessage || sent.message?.audioMessage || null
        const cdnUrl   = msgInner?.url || null
        if (cdnUrl) {
          const waitCdn = (url, maxMs = 15000, intervalMs = 1500) => new Promise(resolve => {
            const start   = Date.now()
            const { net } = require("electron")
            const tryFetch = () => {
              try {
                const req = net.request({ method: "HEAD", url })
                req.on("response", res => {
                  if (res.statusCode < 500) { resolve(true); return }
                  if (Date.now() - start < maxMs) setTimeout(tryFetch, intervalMs)
                  else resolve(false)
                })
                req.on("error", () => {
                  if (Date.now() - start < maxMs) setTimeout(tryFetch, intervalMs)
                  else resolve(false)
                })
                req.end()
              } catch (_) { resolve(false) }
            }
            tryFetch()
          })
          await waitCdn(cdnUrl)
        } else {
          // Fallback: fixed delay 3s jika tidak ada URL
          await new Promise(r => setTimeout(r, 3000))
        }
      }

      // Relay sebagai groupStatusMessageV2 ke grup
      const msgObj = JSON.parse(JSON.stringify(sent.message))
      delete msgObj.messageContextInfo
      if (msgObj.videoMessage) { delete msgObj.videoMessage.contextInfo; msgObj.videoMessage.gifPlayback = false }
      if (msgObj.imageMessage) { delete msgObj.imageMessage.contextInfo }
      if (msgObj.audioMessage) { delete msgObj.audioMessage.contextInfo }

      await baileysClient.relayMessage(jid, { groupStatusMessageV2: { message: msgObj } }, {})
      return { ok: true }
    }

    // ── Mode B: raw WAMessage dari plugin/command ─────────────────────────
    let messageObj
    if (content.raw && typeof content.raw === "object") {
      messageObj = content.raw
    } else if (content.type && content.data) {
      messageObj = { [content.type]: content.data }
    } else {
      return { ok: false, error: "Format content tidak dikenali" }
    }

    await baileysClient.relayMessage(jid, { groupStatusMessageV2: { message: messageObj } }, {})
    return { ok: true }
  } catch (err) {
    console.error("[AuroraChat] group:send-status-v2 error:", err.message)
    return { ok: false, error: err.message }
  }
})

// [FIX-3] Manual media download for a single bubble (when auto-download is OFF)
ipcMain.handle("media:trigger-download", async (_e, { msgId }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const db = getDB()
    const row = db.getMessageById?.(msgId)
    if (!row) return { ok: false, error: "Message not found" }
    const result = await baileysClient.downloadMediaForMsg(row)
    return { ok: true, result }
  } catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// IPC — MESSAGE ACTIONS (Star, Delete, Forward, React, Pin, SaveFile)
// ════════════════════════════════════════════════════════════

// ── msg:star — toggle or set star on a message ──────────────────────────────
ipcMain.handle("msg:star", async (_e, { id, chatJid, star }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const db = getDB()

    // Determine fromMe from DB for correct key.fromMe in Baileys chatModify
    const row = db.getMessageById?.(id)
    const fromMe = row ? (row.from_me === 1) : false

    // Send to WA server
    await baileysClient.starMessage(chatJid, [{ id, fromMe }], star)

    // Persist to local DB
    db.setMessageStar?.(id, chatJid, star)

    // Notify renderer so bubble updates immediately without reload
    win?.webContents.send("messages:update", { id, chat_jid: chatJid, starred: star ? 1 : 0 })
    return { ok: true, starred: star ? 1 : 0 }
  } catch (err) {
    console.error("[AuroraChat] msg:star error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── msg:delete — delete message (for me only or for everyone) ──────────────
ipcMain.handle("msg:delete", async (_e, { id, chatJid, forEveryone = false }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const db = getDB()
    const row = db.getMessageById?.(id)
    const fromMe = row ? (row.from_me === 1) : false

    const msgKey = { remoteJid: chatJid, id, fromMe }
    await baileysClient.deleteMessage(chatJid, msgKey, forEveryone)

    // Locally mark as deleted immediately
    db.updateMessageStatus?.(id, chatJid, -1)
    win?.webContents.send("messages:update", { id, chat_jid: chatJid, status: -1, deleted: true })
    return { ok: true }
  } catch (err) {
    console.error("[AuroraChat] msg:delete error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── msg:forward — forward a message to another chat ────────────────────────
ipcMain.handle("msg:forward", async (_e, { id, chatJid, targetJids }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    if (!targetJids || targetJids.length === 0) return { ok: false, error: "Tidak ada tujuan" }

    const db = getDB()
    const row = db.getMessageById?.(id)
    if (!row) return { ok: false, error: "Pesan tidak ditemukan" }

    let rawMessage = null
    if (row.raw) {
      try { rawMessage = JSON.parse(row.raw) } catch (_) {}
    }
    if (!rawMessage) {
      rawMessage = row.body ? { conversation: row.body } : { conversation: "" }
    }

    const waMsg = {
      key: {
        remoteJid:  row.remote_jid,
        fromMe:     row.from_me === 1,
        id:         row.id,
      },
      message: rawMessage,
      messageTimestamp: row.message_timestamp || Math.floor(Date.now() / 1000),
    }

    const results = []
    for (const tJid of targetJids) {
      try {
        await baileysClient.forwardMessage(tJid, waMsg)
        results.push({ jid: tJid, ok: true })
      } catch (e) {
        results.push({ jid: tJid, ok: false, error: e.message })
      }
    }

    const allOk = results.every(r => r.ok)
    return { ok: allOk, results }
  } catch (err) {
    console.error("[AuroraChat] msg:forward error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── msg:react — send emoji reaction to a message ──────────────────────────
ipcMain.handle("msg:react", async (_e, { id, chatJid, emoji }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const db = getDB()
    const row = db.getMessageById?.(id)
    const fromMe = row ? (row.from_me === 1) : false

    const msgKey = { remoteJid: chatJid, id, fromMe }
    // emoji="" removes the reaction
    await baileysClient.reactToMessage(chatJid, msgKey, emoji || "")
    return { ok: true }
  } catch (err) {
    console.error("[AuroraChat] msg:react error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── msg:pin — pin/unpin a message in a chat ────────────────────────────────
// WA pin message = chatModify { pin: { type: 1|2|3, time, key } }
// type 1=24h, 2=7d, 3=30d; passing type=0 unpins
ipcMain.handle("msg:pin", async (_e, { id, chatJid, pin = true, duration = 86400 }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const db = getDB()
    const row = db.getMessageById?.(id)
    const fromMe = row ? (row.from_me === 1) : false

    const msgKey = { remoteJid: chatJid, id, fromMe }

    // Baileys sock.sendMessage with pin message type
    await baileysClient.pinChatMessage(chatJid, msgKey, pin, duration)
    return { ok: true }
  } catch (err) {
    console.error("[AuroraChat] msg:pin error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── msg:save-file — save media file from local path via native dialog ──────
ipcMain.handle("msg:save-file", async (_e, { srcPath, suggestedName }) => {
  try {
    const fs   = require("fs")
    const path = require("path")
    const { dialog } = require("electron")

    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: "File tidak ditemukan" }

    const ext      = path.extname(srcPath) || ""
    const defName  = suggestedName || `media_${Date.now()}${ext}`
    const result   = await dialog.showSaveDialog(win, {
      title:       "Simpan Media",
      defaultPath: defName,
      filters:     [{ name: "All Files", extensions: ["*"] }],
    })

    if (result.canceled || !result.filePath) return { ok: false, reason: "canceled" }
    fs.copyFileSync(srcPath, result.filePath)
    return { ok: true, path: result.filePath }
  } catch (err) {
    console.error("[AuroraChat] msg:save-file error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ─── Status / Story IPC ────────────────────────────────────────────────────────
ipcMain.handle("status:get-all", (_e) => {
  try {
    const data = baileysClient?.getContactStatuses?.() || {}
    const myJid = baileysClient?.getMyJid?.() || null
    return { ok: true, data, myJid }
  }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("status:get-by-sender", (_e, { jid }) => {
  try { return { ok: true, stories: baileysClient?.getStatusesBySender?.(jid) || [] } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("status:mark-seen", async (_e, { senderJid, statusId }) => {
  try { await baileysClient?.markStatusSeen?.(senderJid, statusId); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── status:reply — send a reply to a status with proper quoted context ────────
// Builds the correct fakeObj / WAMessage that Baileys needs so the recipient
// sees the quoted status bubble (same as official WA behaviour).
//
// For status replies the quoted object must have:
//   key.remoteJid = 'status@broadcast'
//   key.participant = senderJid  (LID resolved if needed)
//   key.id = statusId
//   message = reconstructed message content from entry
//   messageTimestamp = entry.timestamp
//   pushName = senderName
//
ipcMain.handle("status:reply", async (_e, { senderJid, statusId, body, entry }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap" }

    // 1. Try rawMsgCache first (in-memory, survives restart if session active)
    let rawMsg = baileysClient.getRawMsg?.(statusId) || null

    // 2. Build quoted WAMessage
    let quotedWAMsg = null

    if (rawMsg) {
      // Full raw WAMessage available — use directly as Baileys fakeObj
      quotedWAMsg = {
        key: {
          remoteJid: 'status@broadcast',
          fromMe: false,
          id: statusId,
          participant: senderJid,
        },
        message:          rawMsg.message,
        messageTimestamp: rawMsg.messageTimestamp || entry?.timestamp || Math.floor(Date.now() / 1000),
        pushName:         rawMsg.pushName || entry?.senderName || null,
      }
    } else if (entry) {
      // rawMsg evicted from cache — reconstruct message content from stored entry
      // This covers the case where the app was restarted after the status arrived
      let reconstructedMsg = null

      if (entry.sourceType === 'text') {
        reconstructedMsg = {
          extendedTextMessage: {
            text: entry.text || '',
            backgroundArgb: entry.backgroundColor ?? undefined,
            font: entry.font ?? undefined,
            contextInfo: { remoteJid: 'status@broadcast', statusSourceType: 'TEXT' }
          }
        }
      } else if (entry.sourceType === 'image') {
        reconstructedMsg = {
          imageMessage: {
            url:         entry.mediaUrl || '',
            mimetype:    entry.mediaMimetype || 'image/jpeg',
            caption:     entry.caption || '',
            jpegThumbnail: entry.thumbnailBase64
              ? Buffer.from(entry.thumbnailBase64.replace(/^data:[^;]+;base64,/, ''), 'base64')
              : undefined,
            contextInfo: { remoteJid: 'status@broadcast', statusSourceType: 'IMAGE' }
          }
        }
      } else if (entry.sourceType === 'video' || entry.sourceType === 'gif') {
        reconstructedMsg = {
          videoMessage: {
            url:         entry.mediaUrl || '',
            mimetype:    entry.mediaMimetype || 'video/mp4',
            caption:     entry.caption || '',
            jpegThumbnail: entry.thumbnailBase64
              ? Buffer.from(entry.thumbnailBase64.replace(/^data:[^;]+;base64,/, ''), 'base64')
              : undefined,
            contextInfo: { remoteJid: 'status@broadcast', statusSourceType: 'VIDEO' }
          }
        }
      } else if (entry.sourceType === 'audio') {
        reconstructedMsg = {
          audioMessage: {
            url:      entry.mediaUrl || '',
            mimetype: entry.mediaMimetype || 'audio/ogg; codecs=opus',
            seconds:  entry.audioDuration || 0,
            contextInfo: { remoteJid: 'status@broadcast' }
          }
        }
      } else {
        // Fallback: treat as text
        reconstructedMsg = { conversation: entry.text || entry.caption || '' }
      }

      quotedWAMsg = {
        key: {
          remoteJid:   'status@broadcast',
          fromMe:       false,
          id:           statusId,
          participant:  senderJid,
        },
        message:          reconstructedMsg,
        messageTimestamp: entry.timestamp || Math.floor(Date.now() / 1000),
        pushName:         entry.senderName || null,
      }
    }

    // 3. Send via sendTextMessage with quoted
    const result = await baileysClient.sendTextMessage(
      senderJid,
      body,
      quotedWAMsg ? { quoted: quotedWAMsg } : {}
    )
    return { ok: true, message: { key: result?.key || {}, id: result?.key?.id || null } }
  } catch (err) {
    console.error("[AuroraChat] status:reply error:", err.message)
    return { ok: false, error: err.message }
  }
})


// ── status:forward — forward a status story (image/video/audio/text) to chats ──
// Called by ForwardStatusModal. Re-fetches or re-sends the actual media so
// recipients get the real content, not just a text stub.
//
// Flow:
//   text     → sendTextMessage(jid, text)
//   image    → fetch media file (local path or CDN url) → sendImage(jid, buf, caption)
//   video/gif → fetch → sendVideo(jid, buf, caption)
//   audio    → fetch → sendAudio(jid, buf)
//   fallback → sendTextMessage with caption
//
ipcMain.handle("status:forward", async (_e, { targetJid, entry }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap" }
    if (!targetJid || !entry) return { ok: false, error: "targetJid dan entry diperlukan" }

    const { sourceType, mediaUrl, mediaMimetype, thumbnailBase64, text, caption } = entry
    const body = caption || text || ""

    // ── Text status ──────────────────────────────────────────────────────
    if (sourceType === "text") {
      await baileysClient.sendTextMessage(targetJid, body || "📝 Status")
      return { ok: true }
    }

    // ── Media status (image / video / gif / audio) ────────────────────────
    // Try to get a Buffer: prefer local file path, then CDN URL, then thumbnail b64
    let buf = null
    let mime = mediaMimetype || ""

    if (mediaUrl) {
      try {
        if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
          // CDN url — fetch via Node http/https
          buf = await new Promise((resolve, reject) => {
            const mod = require(mediaUrl.startsWith("https") ? "https" : "http")
            mod.get(mediaUrl, (res) => {
              const chunks = []
              res.on("data", c => chunks.push(c))
              res.on("end",  () => resolve(Buffer.concat(chunks)))
              res.on("error", reject)
            }).on("error", reject)
          })
        } else {
          // Local absolute path (strip file:// prefix if present)
          let localPath = mediaUrl
          if (localPath.startsWith("file://")) localPath = decodeURIComponent(localPath.replace(/^\/file:\/\/\/?/, ""))
          if (process.platform !== "win32" && !localPath.startsWith("/")) localPath = "/" + localPath
          if (fs.existsSync(localPath)) buf = fs.readFileSync(localPath)
        }
      } catch (fetchErr) {
        console.warn("[status:forward] media fetch failed:", fetchErr.message)
      }
    }

    // Fallback: decode thumbnail base64 if media fetch failed
    if (!buf && thumbnailBase64) {
      const b64 = thumbnailBase64.includes(",") ? thumbnailBase64.split(",")[1] : thumbnailBase64
      buf = Buffer.from(b64, "base64")
      // Thumbnail is always JPEG
      if (!mime || mime.startsWith("video/")) mime = "image/jpeg"
    }

    if (!buf) {
      // Last resort: send caption as text
      await baileysClient.sendTextMessage(targetJid, body || "📷 Media")
      return { ok: true }
    }

    if (sourceType === "image") {
      await baileysClient.sendImage(targetJid, buf, body, null)
    } else if (sourceType === "video" || sourceType === "gif") {
      await baileysClient.sendVideo(targetJid, buf, body, null, { mimetype: mime || "video/mp4" })
    } else if (sourceType === "audio") {
      await baileysClient.sendAudio(targetJid, buf, false, null, { mimetype: mime || "audio/ogg; codecs=opus" })
    } else {
      await baileysClient.sendImage(targetJid, buf, body, null)
    }

    return { ok: true }
  } catch (err) {
    console.error("[AuroraChat] status:forward error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ── status:save-media — save status media to Downloads with correct type/ext ──
// Accepts base64-encoded binary + mimetype. Uses showSaveDialog with proper
// file filters per type. Writes binary Buffer (not utf-8 text).
//
ipcMain.handle("status:save-media", async (_e, { base64Data, mimetype, suggestedName }) => {
  try {
    const { dialog, app: eApp } = require("electron")
    const downloadsPath = eApp.getPath("downloads")

    // Derive extension and filter from mimetype
    const mimeToExt = {
      "image/jpeg":       "jpg",  "image/jpg":        "jpg",
      "image/png":        "png",  "image/gif":        "gif",
      "image/webp":       "webp",
      "video/mp4":        "mp4",  "video/3gpp":       "3gp",
      "video/quicktime":  "mov",  "video/webm":       "webm",
      "audio/ogg":        "ogg",  "audio/mpeg":       "mp3",
      "audio/mp4":        "m4a",  "audio/aac":        "aac",
      "audio/opus":       "opus",
    }
    // Also parse "audio/ogg; codecs=opus" → ogg
    const baseMime = (mimetype || "").split(";")[0].trim().toLowerCase()
    const ext = mimeToExt[baseMime] || (baseMime.includes("video") ? "mp4" : baseMime.includes("audio") ? "ogg" : "jpg")

    const filterMap = {
      image: { name: "Image",  extensions: ["jpg","jpeg","png","gif","webp"] },
      video: { name: "Video",  extensions: ["mp4","3gp","mov","webm"] },
      audio: { name: "Audio",  extensions: ["ogg","mp3","m4a","aac","opus"] },
    }
    const typeGroup = baseMime.startsWith("video") ? "video" : baseMime.startsWith("audio") ? "audio" : "image"
    const filters = [ filterMap[typeGroup], { name: "All Files", extensions: ["*"] } ]

    // Build default filename
    const defaultName = suggestedName || `aurora_status_${Date.now()}.${ext}`

    const result = await dialog.showSaveDialog({
      title:       "Simpan Media Status",
      defaultPath: path.join(downloadsPath, defaultName),
      filters,
    })
    if (result.canceled || !result.filePath) return { ok: false, reason: "canceled" }

    // Write as binary Buffer
    const buf = Buffer.from(base64Data, "base64")
    require("fs").writeFileSync(result.filePath, buf)
    return { ok: true, path: result.filePath }
  } catch (e) {
    console.error("[AuroraChat] status:save-media error:", e.message)
    return { ok: false, error: e.message }
  }
})

// ════════════════════════════════════════════════════════════
// IPC — STICKERS  (add to main.js alongside other ipcMain.handle blocks)
// ════════════════════════════════════════════════════════════
// Requires: path, fs already imported in main.js (they are)
// Requires: baileysClient, getDB already in scope (they are)

// ── Resolve media/stickers directory ──────────────────────────────────────────
// [FIX-PATH] Stickers are saved by client.js to:
//   app.getPath('userData')/media/stickers/
// (client.js CONFIG.MEDIA_DIR = userData/media, subdir routing → stickers/ for webp)
// __dirname-based paths pointed inside the .asar (read-only in production) and
// diverged from where client.js actually writes files — so sticker:list returned
// an empty array and sticker:send read from the wrong folder.
function getStickerDir() {
  // Primary: userData/media/stickers — always writable, matches client.js output
  const primary = path.join(app.getPath("userData"), "media", "stickers")
  if (fs.existsSync(primary)) return primary
  // Create it if missing (first launch before any sticker arrives)
  fs.mkdirSync(primary, { recursive: true })
  return primary
}

// ── Security helper — block path traversal ────────────────────────────────────
function assertInsideStickerDir(absPath) {
  const root = getStickerDir()
  const rel  = path.relative(root, absPath)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path traversal denied")
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sticker:list — scan media/stickers/**/*.webp recursively.
// Returns { ok, stickers: [{ name, filename, absPath, packFolder }], total }
// Groups by sub-folder so the UI can show pack tabs.
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle("sticker:list", async () => {
  try {
    const root   = getStickerDir()
    const result = []

    const scan = (dir, packName) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
      catch (_) { return }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scan(fullPath, entry.name)
        } else if (entry.isFile() && /\.webp$/i.test(entry.name)) {
          result.push({
            name:       entry.name.replace(/\.webp$/i, ""),
            filename:   entry.name,
            absPath:    fullPath,
            packFolder: packName || "Default",
          })
        }
      }
    }

    scan(root, null)
    return { ok: true, stickers: result, total: result.length }
  } catch (err) {
    console.error("[sticker:list]", err.message)
    return { ok: false, stickers: [], total: 0 }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// sticker:data — read .webp by absPath → base64 data URL for thumbnail display.
// Renderer can't use file:// directly (blocked by CSP); IPC read is safe.
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle("sticker:data", async (_e, { absPath }) => {
  try {
    if (!absPath) return { ok: false, data: null }
    assertInsideStickerDir(absPath)
    if (!fs.existsSync(absPath)) return { ok: false, data: null }
    const buf = fs.readFileSync(absPath)
    return { ok: true, data: `data:image/webp;base64,${buf.toString("base64")}` }
  } catch (err) {
    console.error("[sticker:data]", err.message)
    return { ok: false, data: null }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// sticker:send — send a .webp sticker to a JID.
//
// Reference: Yumi index.js sendImageAsSticker / sendFile
//   dims.sendImageAsSticker(jid, path, quoted, { packname, author })
//   → writeExifImg(buff, options)                 ← adds EXIF pack metadata
//   → dims.sendMessage(jid, { sticker: { url: buffer } }, { quoted })
//
// Aurora client.js sendSticker already mirrors this:
//   sendSticker(jid, Buffer | { url: string }, quotedWAMsg)
//   → sock.sendMessage(jid, { sticker: src }, quoted ? { quoted } : {})
//
// We pass the raw Buffer directly (no EXIF re-encoding needed — the .webp
// files in media/stickers/ are already valid WA stickers).
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle("sticker:send", async (_e, { jid, absPath, quotedMsgId = null }) => {
  try {
    if (!baileysClient)  return { ok: false, error: "Client belum siap." }
    if (!absPath)        return { ok: false, error: "absPath diperlukan." }
    assertInsideStickerDir(absPath)
    if (!fs.existsSync(absPath)) return { ok: false, error: "File tidak ditemukan." }

    // Rebuild quoted WAMessage (same pattern as msg:send / msg:send-media)
    let quotedWAMsg = null
    if (quotedMsgId) {
      try {
        const d   = getDB()
        const row = d.getMessageById?.(quotedMsgId)
        if (row) {
          let rawMessage = null
          try { rawMessage = JSON.parse(row.raw) } catch (_) {}
          if (!rawMessage) rawMessage = row.body ? { conversation: row.body } : { conversation: "" }
          const isGrp = (row.remote_jid || "").endsWith("@g.us")
          const part  = isGrp && !row.from_me && row.participant ? row.participant : undefined
          quotedWAMsg = {
            key: {
              remoteJid: row.remote_jid,
              fromMe:    row.from_me === 1,
              id:        row.id,
              ...(part ? { participant: part } : {}),
            },
            message:          rawMessage,
            messageTimestamp: row.message_timestamp || Math.floor(Date.now() / 1000),
            pushName:         row.push_name || null,
          }
        }
      } catch (_) {}
    }

    const buf  = fs.readFileSync(absPath)
    const sent = await baileysClient.sendSticker(jid, buf, quotedWAMsg)
    return { ok: true, id: sent?.key?.id || null }
  } catch (err) {
    console.error("[sticker:send]", err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("status:fetch-all", async (_e, { jids = [], forceRefresh = false } = {}) => {
  try { return await baileysClient?.fetchContactStories?.(jids, forceRefresh) || { ok: false, error: "Not connected" } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("status:fetch-contact", async (_e, { jid }) => {
  try { return await baileysClient?.fetchSingleContactStory?.(jid) || { ok: false, error: "Not connected" } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("status:set-auto-view", (_e, { enabled }) => {
  try {
    const fs = require("fs")
    const p = getSettingsPath()
    let s = {}
    try { s = JSON.parse(fs.readFileSync(p, "utf8")) } catch (_) {}
    s.autoViewStatus = !!enabled
    fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8")
    baileysClient?.setAutoViewStatus?.(!!enabled)
    return { ok: true, autoViewStatus: !!enabled }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("status:get-auto-view", (_e) => {
  return { ok: true, enabled: baileysClient?.getAutoViewStatus?.() || false }
})
// ── App Version ────────────────────────────────────────────────────────────
ipcMain.handle("app:get-version", () => {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json")
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
      if (pkg.version) return { ok: true, version: "v" + pkg.version }
    }
    const v = app.getVersion()
    if (v && v !== "0.0.0") return { ok: true, version: "v" + v }
  } catch (_) {}
  return { ok: true, version: "v1.0.0" }
})

// ── Update Checker — fetch via main process (bypasses renderer CSP/sandbox) ─
ipcMain.handle("app:check-update", async () => {
  const https = require("https")
  const SOURCES = [
    {
      listUrl: "https://api.github.com/repos/Towartz/WaPlus/releases?per_page=20",
      pageUrl: "https://github.com/Towartz/WaPlus/releases",
      source:  "primary",
    },
    {
      listUrl: "https://api.github.com/repos/Yuu-DevID/WaPlus/releases?per_page=20",
      pageUrl: "https://github.com/Yuu-DevID/WaPlus/releases",
      source:  "secondary",
    },
  ]

  // ── Fetch helper ────────────────────────────────────────────────────────────
  const fetchJson = (url) => new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "WaPlus-UpdateChecker/1.0", "Accept": "application/vnd.github.v3+json" },
      timeout: 10000,
    }, (res) => {
      let raw = ""
      res.on("data", c => raw += c)
      res.on("end", () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(raw) }) }
        catch (e) { reject(e) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
  })

  // ── Pick best release from list ─────────────────────────────────────────────
  // Priority: stable > pre-release. Within same tier: sort by published_at desc.
  const pickBest = (list) => {
    if (!Array.isArray(list) || list.length === 0) return null
    const stable = list.filter(r => !r.prerelease && !r.draft)
    const pick   = stable.length > 0
      ? stable.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]
      : list.filter(r => !r.draft).sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]
    return pick || null
  }

  let networkOk  = false
  let lastErrMsg = ""

  for (const { listUrl, pageUrl, source } of SOURCES) {
    try {
      const res = await fetchJson(listUrl)
      networkOk = true

      if (res.statusCode === 403) {
        // GitHub rate-limit
        lastErrMsg = "GitHub rate limit — coba lagi nanti"
        continue
      }
      if (res.statusCode !== 200) continue

      const list = Array.isArray(res.data) ? res.data : []

      if (list.length === 0) {
        return { ok: true, source, status: "no_releases_yet", page_url: pageUrl }
      }

      const best = pickBest(list)
      if (!best?.tag_name) continue

      // Return full list sorted newest first (excluding drafts)
      const allReleases = list
        .filter(r => !r.draft)
        .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
        .map(r => ({
          tag_name:     r.tag_name,
          name:         r.name || r.tag_name,
          body:         r.body || "",
          html_url:     r.html_url || pageUrl,
          published_at: r.published_at || "",
          prerelease:   r.prerelease || false,
        }))

      return {
        ok: true, source, status: "release_found",
        tag_name:     best.tag_name,
        name:         best.name || best.tag_name,
        body:         best.body || "",
        html_url:     best.html_url || pageUrl,
        published_at: best.published_at || "",
        prerelease:   best.prerelease || false,
        releases:     allReleases,
      }

    } catch (err) {
      // Categorize error so renderer can show helpful message
      const msg = err?.message || String(err)
      if (msg.includes("EAI_AGAIN") || msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
        lastErrMsg = "DNS_FAIL"          // no internet / DNS broken
      } else if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
        lastErrMsg = "TIMEOUT"
      } else if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET")) {
        lastErrMsg = "CONN_REFUSED"
      } else {
        lastErrMsg = msg
      }
      console.warn("[WaPlus:update] fetch error:", source, msg)
      // try next source
    }
  }

  if (!networkOk) return { ok: false, status: "offline", errCode: lastErrMsg, error: lastErrMsg }
  return { ok: true, status: "no_releases_yet", source: "primary", page_url: "https://github.com/Towartz/WaPlus/releases" }
})