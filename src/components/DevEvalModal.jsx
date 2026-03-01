// DevEvalModal.jsx — WaPlus DevEval Sandbox v4
// Features: output search (Ctrl+F, ↑↓ navigate), line numbers, exec time,
//   pin/compare output, smsg "m" object, Full View, Save, Templates, history
import { useState, useRef, useEffect, useCallback, memo, useMemo } from "react"

// ─── Syntax colorizer ─────────────────────────────────────────────────────────
function colorize(text) {
  if (!text) return ""
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, '<span class="devc-string">$1</span>')
    .replace(/\b(-?\d+\.?\d*(?:e[+-]?\d+)?)\b/g, '<span class="devc-number">$1</span>')
    .replace(/\b(true|false|null|undefined|NaN|Infinity)\b/g, '<span class="devc-keyword">$1</span>')
    .replace(/([a-zA-Z_$][\w$]*)(\s*:)/g, '<span class="devc-key">$1</span>$2')
    .replace(/(\[Function(?:: [^\]]+)?\])/g, '<span class="devc-fn">$1</span>')
    .replace(/(\[(?:Array|Object|Map|Set|Buffer|Error)[^\]]*\])/g, '<span class="devc-type">$1</span>')
}

// ─── Highlight search matches in colorized html ───────────────────────────────
function highlightSearch(html, query, currentIdx) {
  if (!query) return html
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  let idx = 0
  return html.replace(
    new RegExp(`(?![^<]*>)(${escaped})`, "gi"),
    (match) => {
      const cls = idx === currentIdx ? "devc-search-current" : "devc-search-match"
      idx++
      return `<mark class="${cls}">${match}</mark>`
    }
  )
}

// ─── Count plain-text matches (strip tags first) ─────────────────────────────
function countMatches(text, query) {
  if (!query || !text) return 0
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return (text.match(new RegExp(escaped, "gi")) || []).length
}

const E = "expr"
const B = "block"

// ─── Templates ────────────────────────────────────────────────────────────────
const TEMPLATES = [
  // msg
  { cat: "msg", label: "m (smsg)",              mode: E, code: `m` },
  { cat: "msg", label: "m keys",                mode: E, code: `Object.keys(m)` },
  { cat: "msg", label: "m.message (raw proto)", mode: E, code: `m.message` },
  { cat: "msg", label: "m.msg (inner content)", mode: E, code: `m.msg` },
  { cat: "msg", label: "m.quoted",              mode: E, code: `m.quoted` },
  { cat: "msg", label: "m.mentionedJid",        mode: E, code: `m.mentionedJid` },
  { cat: "msg", label: "m.mtype",               mode: E, code: `m.mtype` },
  { cat: "msg", label: "m body & sender",       mode: E, code: `({ body: m.body, sender: m.senderId, pushName: m.pushName, isGroup: m.isGroup })` },
  { cat: "msg", label: "m media info",          mode: E, code: `({ hasMedia: m.hasMedia, mimetype: m.mimetype, fileName: m.fileName, savedPath: m.mediaSavedPath })` },
  // sock
  { cat: "sock", label: "sock.user",             mode: E, code: `sock.user` },
  { cat: "sock", label: "Reflect.ownKeys(sock)", mode: E, code: `Reflect.ownKeys(sock)` },
  { cat: "sock", label: "sock functions",        mode: E, code: `Reflect.ownKeys(sock).filter(k => typeof sock[k] === 'function')` },
  { cat: "sock", label: "sock objects",          mode: E, code: `Reflect.ownKeys(sock).filter(k => sock[k] !== null && typeof sock[k] === 'object' && !Array.isArray(sock[k]))` },
  { cat: "sock", label: "sock key map",          mode: E, code: `Reflect.ownKeys(sock).map(k => ({ key: k, type: typeof sock[k], value: typeof sock[k] !== 'object' && typeof sock[k] !== 'function' ? sock[k] : '[complex]' }))` },
  { cat: "sock", label: "sock ev events",        mode: E, code: `Reflect.ownKeys(sock?.ev || {})` },
  { cat: "sock", label: "sock authState",        mode: E, code: `fmt(sock?.authState)` },
  { cat: "sock", label: "group metadata",        mode: B, code: `const meta = await sock.groupMetadata(m.chatId)\nreturn json(meta)` },
  { cat: "sock", label: "group participants",    mode: B, code: `const meta = await sock.groupMetadata(m.chatId)\nreturn meta.participants.map(p => ({ jid: p.id, admin: p.admin }))` },
  { cat: "sock", label: "send text",             mode: B, code: `await sock.sendMessage(m.chatId, { text: 'test dari DevEval 🚀' })` },
  { cat: "sock", label: "send reply",            mode: B, code: `await sock.sendMessage(m.chatId, { text: 'reply test' }, { quoted: m })` },
  // db
  { cat: "db", label: "db chats",              mode: E, code: `db.getChats(20, 0)` },
  { cat: "db", label: "db messages",           mode: E, code: `db.getMessages(m.chatId, 10, 0)` },
  { cat: "db", label: "db contacts",           mode: E, code: `db.getContacts(20, 0)` },
  { cat: "db", label: "db message by id",      mode: E, code: `db.getMessageById?.(m.id)` },
  { cat: "db", label: "db contact by jid",     mode: E, code: `db.getContact?.(m.senderId)` },
  { cat: "db", label: "db search messages",    mode: E, code: `db.searchMessagesGlobal?.('halo') || []` },
  { cat: "db", label: "db pending downloads",  mode: E, code: `db.getPendingMediaDownloads?.()` },
  // baileys
  { cat: "baileys", label: "baileys export keys",       mode: E, code: `Object.keys(baileys)` },
  { cat: "baileys", label: "Reflect.ownKeys(baileys)",  mode: E, code: `Reflect.ownKeys(baileys)` },
  { cat: "baileys", label: "jidNormalizedUser",         mode: E, code: `baileys.jidNormalizedUser(m.senderId)` },
  { cat: "baileys", label: "getContentType",            mode: E, code: `baileys.getContentType(m.message)` },
  { cat: "baileys", label: "jidDecode",                 mode: E, code: `baileys.jidDecode(m.chatId)` },
  { cat: "baileys", label: "isJidGroup",                mode: E, code: `baileys.isJidGroup(m.chatId)` },
  { cat: "baileys", label: "downloadMediaMessage",      mode: B, code: `const buf = await baileys.downloadMediaMessage(\n  { message: m.message, key: m.key },\n  'buffer', {}\n)\nreturn fmt({ size: buf.length, type: typeof buf })` },
  // misc
  { cat: "misc", label: "process.versions",     mode: E, code: `process.versions` },
  { cat: "misc", label: "process.env keys",     mode: E, code: `Object.keys(process.env)` },
  { cat: "misc", label: "fs.readdirSync cwd",   mode: E, code: `fs.readdirSync(process.cwd())` },
  { cat: "misc", label: "fs.readdirSync app",   mode: B, code: `const p = path.join(process.cwd())\nreturn fs.readdirSync(p)` },
  { cat: "misc", label: "require wileys keys",  mode: B, code: `const w = require('wileys')\nreturn Object.keys(w)` },
  { cat: "misc", label: "client functions",     mode: E, code: `Object.keys(client).filter(k => typeof client[k] === 'function')` },
]

const CATS = ["msg", "sock", "db", "baileys", "misc"]

// ─── Context pills ────────────────────────────────────────────────────────────
const PILLS = [
  { t: "m",        d: "smsg message obj (like bot handler)" },
  { t: "sock",     d: "Baileys WASocket" },
  { t: "db",       d: "SQLite database helper" },
  { t: "baileys",  d: "wileys/baileys exports" },
  { t: "client",   d: "WaPlus client functions" },
  { t: "util",     d: "Node.js util" },
  { t: "fs",       d: "Node.js fs" },
  { t: "path",     d: "Node.js path" },
  { t: "fmt(v)",   d: "util.inspect — full depth" },
  { t: "json(v)",  d: "JSON.stringify pretty" },
  { t: "log(v)",   d: "console.log + return v" },
]

const HIST_KEY = "__wpe_hist_v4__"
const loadHist = () => { try { return JSON.parse(sessionStorage.getItem(HIST_KEY) || "[]") } catch { return [] } }
const saveHist = h => { try { sessionStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-100))) } catch {} }

// ─── Main ─────────────────────────────────────────────────────────────────────
const DevEvalModal = memo(function DevEvalModal({ msg, onClose }) {
  const [mode,        setMode]        = useState(E)
  const [code,        setCode]        = useState("m")
  const [running,     setRunning]     = useState(false)
  const [result,      setResult]      = useState(null)
  const [execMs,      setExecMs]      = useState(null)
  const [hist,        setHist]        = useState(loadHist)
  const [hIdx,        setHIdx]        = useState(-1)
  const [copied,      setCopied]      = useState(false)
  const [saved,       setSaved]       = useState(false)
  const [fullView,    setFullView]    = useState(false)
  const [tab,         setTab]         = useState("msg")
  const [showTpl,     setShowTpl]     = useState(false)
  const [showLines,   setShowLines]   = useState(true)
  // ── Search state ────────────────────────────────────────────────────────────
  const [showSearch,  setShowSearch]  = useState(false)
  const [searchQ,     setSearchQ]     = useState("")
  const [searchIdx,   setSearchIdx]   = useState(0)
  // ── Pinned output ───────────────────────────────────────────────────────────
  const [pinned,      setPinned]      = useState(null)
  // ── Pretty JSON ─────────────────────────────────────────────────────────────
  const [prettyJson,  setPrettyJson]  = useState(false)

  const edRef      = useRef(null)
  const outRef     = useRef(null)
  const searchRef  = useRef(null)

  useEffect(() => { setTimeout(() => edRef.current?.focus(), 80) }, [])

  // Global keydown — Escape closes search first, then modal
  useEffect(() => {
    const fn = e => {
      if (e.key === "Escape" && !running) {
        if (showSearch) { setShowSearch(false); setSearchQ(""); edRef.current?.focus() }
        else onClose()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && result !== null) {
        e.preventDefault()
        setShowSearch(v => { if (!v) setTimeout(() => searchRef.current?.focus(), 60); return !v })
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "l") {
        e.preventDefault()
        setCode(""); setResult(null); setExecMs(null); edRef.current?.focus()
      }
    }
    document.addEventListener("keydown", fn)
    return () => document.removeEventListener("keydown", fn)
  }, [onClose, running, showSearch, result])

  // Reset search & full view on new result
  useEffect(() => {
    setFullView(false)
    setSearchIdx(0)
    setPrettyJson(false)
    if (outRef.current) outRef.current.scrollTop = 0
  }, [result])

  // Auto-scroll to current match
  useEffect(() => {
    if (!showSearch || !searchQ) return
    const el = outRef.current?.querySelector(".devc-search-current")
    el?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [searchIdx, showSearch, searchQ])

  const run = useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed || running) return
    setRunning(true); setResult(null); setExecMs(null)
    const newH = [trimmed, ...hist.filter(h => h !== trimmed)]
    setHist(newH); saveHist(newH); setHIdx(-1)
    const t0 = performance.now()
    try {
      if (!window.api?.devEval) {
        setResult({ ok: false, error: "window.api.devEval not available — update preload.js" })
        return
      }
      const res = await window.api.devEval({
        code: trimmed, mode,
        msgId:   msg?.id       || null,
        chatJid: msg?.chat_jid || null,
        fullOutput: true,
      })
      setResult(res)
    } catch (e) { setResult({ ok: false, error: e.message || String(e) }) }
    finally { setExecMs(Math.round(performance.now() - t0)); setRunning(false) }
  }, [code, mode, running, hist, msg])

  const onKeyDown = useCallback(e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); return }
    if (e.altKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault()
        const n = Math.min(hIdx + 1, hist.length - 1); setHIdx(n); setCode(hist[n] || "")
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        if (hIdx <= 0) { setHIdx(-1); setCode("") }
        else { const p = hIdx - 1; setHIdx(p); setCode(hist[p]) }
      }
    }
    if (e.key === "Tab") {
      e.preventDefault()
      const el = e.target, s = el.selectionStart, en = el.selectionEnd
      setCode(c => c.slice(0, s) + "  " + c.slice(en))
      setTimeout(() => el.setSelectionRange(s + 2, s + 2), 0)
    }
  }, [run, code, hist, hIdx])

  const onSearchKeyDown = useCallback(e => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault()
      setSearchIdx(i => (i + 1) % Math.max(1, matchCount))
    } else if (e.key === "ArrowUp" || (e.shiftKey && e.key === "Enter")) {
      e.preventDefault()
      setSearchIdx(i => (i - 1 + Math.max(1, matchCount)) % Math.max(1, matchCount))
    }
  }, [])

  const insertAt = useCallback(text => {
    const el = edRef.current
    if (!el) { setCode(c => c + text); return }
    const s = el.selectionStart, en = el.selectionEnd
    setCode(c => c.slice(0, s) + text + c.slice(en))
    setTimeout(() => { el.focus(); el.setSelectionRange(s + text.length, s + text.length) }, 0)
  }, [])

  const applyTpl = useCallback(tpl => {
    setCode(tpl.code); if (tpl.mode) setMode(tpl.mode); setResult(null); setExecMs(null); setShowTpl(false)
    setTimeout(() => edRef.current?.focus(), 50)
  }, [])

  const outText = result
    ? (result.ok ? result.result : (result.error + (result.stack ? "\n\nStack:\n" + result.stack : "")))
    : null

  // Detect apakah output bisa di-pretty-print sebagai JSON
  const isJsonOutput = useMemo(() => {
    if (!outText) return false
    const t = outText.trim()
    if (!(t.startsWith("{") || t.startsWith("[") || t.startsWith("'"))) return false
    // Coba parse — util.inspect output pakai single quote, coba JSON juga
    try { JSON.parse(t); return true } catch {}
    // util.inspect format: coba konversi single → double quote sederhana
    try {
      const j = t
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
      JSON.parse(j); return true
    } catch {}
    return false
  }, [outText])

  // Versi pretty — kalau prettyJson aktif, coba format ulang
  const prettyOutText = useMemo(() => {
    if (!prettyJson || !outText) return outText
    const t = outText.trim()
    // Try direct JSON parse dulu
    try {
      return JSON.stringify(JSON.parse(t), null, 2)
    } catch {}
    // util.inspect format — replace biar parseable
    try {
      // Ganti single quote string, undefined, trailing comma
      let s = t
        .replace(/undefined/g, 'null')
        .replace(/\[Function[^\]]*\]/g, '"[Function]"')
        .replace(/\[Circular\]/g, '"[Circular]"')
        .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
        .replace(/'/g, '"')
        .replace(/,(\s*[}\]])/g, '$1')
      return JSON.stringify(JSON.parse(s), null, 2)
    } catch {}
    return outText  // fallback ke original kalau gagal
  }, [prettyJson, outText])

  const TRUNC = 30000
  const activeText = prettyJson ? (prettyOutText || outText) : outText
  const isBig = activeText && activeText.length > TRUNC && !fullView
  const display = isBig
    ? activeText.slice(0, TRUNC) + `\n\n... ▲ TRUNCATED — click "Full View" to show all ${activeText.length.toLocaleString()} chars`
    : activeText

  // Match count on plain text
  const matchCount = useMemo(() => countMatches(display, searchQ), [display, searchQ])

  // Reset searchIdx when query/display changes
  useEffect(() => { setSearchIdx(0) }, [searchQ, display])

  // Build colorized + search-highlighted html
  const outputHtml = useMemo(() => {
    const base = colorize(display || "")
    return showSearch && searchQ ? highlightSearch(base, searchQ, searchIdx) : base
  }, [display, showSearch, searchQ, searchIdx])

  // Build line-numbered html
  const outputWithLines = useMemo(() => {
    if (!showLines || !display) return outputHtml
    const lines = outputHtml.split("\n")
    const pad = String(lines.length).length
    return lines.map((l, i) => {
      const n = String(i + 1).padStart(pad, " ")
      return `<span class="devc-ln">${n}</span>${l}`
    }).join("\n")
  }, [outputHtml, showLines, display])

  const copyOut = useCallback(() => {
    if (!outText) return
    const toCopy = prettyJson ? (prettyOutText || outText) : outText
    navigator.clipboard?.writeText(toCopy).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }, [outText, prettyJson, prettyOutText])

  const saveOut = useCallback(async () => {
    if (!outText) return
    const isJson = outText.trim().startsWith("{") || outText.trim().startsWith("[")
    const filename = `deveval_${msg?.id?.slice(0, 8) || Date.now()}.${isJson ? "json" : "txt"}`
    try {
      if (window.api?.saveFile) {
        const r = await window.api.saveFile({ content: outText, filename })
        if (r?.ok) { setSaved(true); setTimeout(() => setSaved(false), 2500) }
      } else {
        const blob = new Blob([outText], { type: "text/plain" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a"); a.href = url; a.download = filename; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
        setSaved(true); setTimeout(() => setSaved(false), 2000)
      }
    } catch {}
  }, [outText, msg])

  // ── SVGs ────────────────────────────────────────────────────────────────────
  const IconCode     = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
  const IconCheck    = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
  const IconCopy     = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
  const IconSave     = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
  const IconExpand   = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
  const IconCollapse = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="21" y2="3"/><line x1="3" y1="21" x2="14" y2="10"/></svg>
  const IconGrid     = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
  const IconPlay     = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
  const IconTrash    = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
  const IconSearch   = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
  const IconPin      = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
  const IconLines    = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
  const IconJson     = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7c0-1.1.9-2 2-2h1a2 2 0 0 1 2 2v1a2 2 0 0 0 2 2 2 2 0 0 0-2 2v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2"/><path d="M20 7c0-1.1-.9-2-2-2h-1a2 2 0 0 0-2 2v1a2 2 0 0 1-2 2 2 2 0 0 1 2 2v1a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2"/></svg>

  return (
    <div className="deveval-backdrop" onClick={e => e.target === e.currentTarget && !running && onClose()} role="dialog" aria-modal="true">
      <div className="deveval-modal" style={{ maxWidth: 900, width: "96vw" }}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="deveval-header">
          <div className="deveval-header-left">
            <div className="deveval-icon"><IconCode /></div>
            <div>
              <div className="deveval-title">Dev Eval</div>
              <div className="deveval-subtitle">
                <span style={{ color: "var(--green)", fontFamily: "monospace", fontSize: 10 }}>{msg?.msg_type || "–"}</span>
                &nbsp;·&nbsp;{(msg?.chat_jid || "–").slice(0, 30)}
                &nbsp;·&nbsp;<span style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.5 }}>{(msg?.id || "–").slice(0, 14)}</span>
              </div>
            </div>
          </div>
          <div className="deveval-header-right">
            <button className={`deveval-mode-btn${showTpl ? " active" : ""}`} onClick={() => setShowTpl(v => !v)} title="Templates">
              <IconGrid />&nbsp;Templates
            </button>
            <div className="deveval-mode-toggle">
              <button className={`deveval-mode-btn${mode === E ? " active" : ""}`} onClick={() => { setMode(E); setResult(null) }}>{"=>"}&nbsp;Expr</button>
              <button className={`deveval-mode-btn${mode === B ? " active" : ""}`} onClick={() => { setMode(B); setResult(null) }}>{"{}"}&nbsp;Block</button>
            </div>
            <button className="deveval-close" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Template Panel ───────────────────────────────────────────── */}
        {showTpl && (
          <div style={{ borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,.25)", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {CATS.map(c => (
                <button key={c} className={`deveval-mode-btn${tab === c ? " active" : ""}`} style={{ fontSize: 11, padding: "2px 9px" }} onClick={() => setTab(c)}>{c}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {TEMPLATES.filter(t => t.cat === tab).map(tpl => (
                <button key={tpl.label} className="deveval-ctx-pill"
                  title={tpl.code.length > 80 ? tpl.code.slice(0, 80) + "…" : tpl.code}
                  onClick={() => applyTpl(tpl)}
                  style={{ fontSize: 11 }}>
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Context pills ───────────────────────────────────────────── */}
        <div className="deveval-ctx-bar" style={{ flexWrap: "wrap", gap: "4px 3px" }}>
          <span className="deveval-ctx-label">ctx:</span>
          {PILLS.map(p => (
            <button key={p.t} className="deveval-ctx-pill" title={p.d} onClick={() => insertAt(p.t)}>{p.t}</button>
          ))}
          {hIdx >= 0 && <span className="deveval-hist-indicator">↑ history {hIdx + 1}/{hist.length}</span>}
        </div>

        {/* ── Editor ──────────────────────────────────────────────────── */}
        <div className="deveval-editor-wrap">
          <div className="deveval-gutter" aria-hidden="true">
            {(code || " ").split("\n").map((_, i) => <div key={i} className="deveval-line-num">{i + 1}</div>)}
          </div>
          <textarea
            ref={edRef}
            className="deveval-editor"
            value={code}
            onChange={e => { setCode(e.target.value); setHIdx(-1) }}
            onKeyDown={onKeyDown}
            placeholder={mode === E
              ? "m                    // smsg-style object\nReflect.ownKeys(sock) // all socket keys\ndb.getChats(10, 0)    // db access"
              : "const meta = await sock.groupMetadata(m.chatId)\nreturn json(meta)"}
            spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
            style={{ minHeight: 90 }}
          />
        </div>

        {/* ── Action bar ──────────────────────────────────────────────── */}
        <div className="deveval-action-bar">
          <div className="deveval-shortcuts">
            <span><kbd>Ctrl+Enter</kbd> Run</span>
            <span><kbd>Ctrl+L</kbd> Clear</span>
            <span><kbd>Alt+↑↓</kbd> History</span>
            <span><kbd>Ctrl+F</kbd> Search</span>
            <span><kbd>Tab</kbd> Indent</span>
            <span><kbd>Esc</kbd> Close</span>
          </div>
          <div className="deveval-action-btns">
            <button className="deveval-btn ghost" disabled={running} onClick={() => { setCode(""); setResult(null); setExecMs(null); edRef.current?.focus() }}>
              <IconTrash />&nbsp;Clear
            </button>
            <button className={`deveval-btn run${running ? " loading" : ""}`} onClick={run} disabled={running || !code.trim()}>
              {running ? <><span className="deveval-spinner" />Running…</> : <><IconPlay />&nbsp;Run</>}
            </button>
          </div>
        </div>

        {/* ── Output ──────────────────────────────────────────────────── */}
        {result !== null && (
          <div className={`deveval-output${result.ok ? "" : " error"}`}>
            <div className="deveval-output-header">
              <div className="deveval-output-status">
                {result.ok
                  ? <><IconCheck /><span style={{ color: "var(--green)" }}>OK</span>{result.type && <span className="deveval-output-type">: {result.type}</span>}</>
                  : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span style={{ color: "#ef4444" }}>Error</span></>
                }
                <span className="deveval-output-len">
                  {outText?.length?.toLocaleString()} chars
                  {isBig && <span style={{ color: "#f59e0b", marginLeft: 6, fontSize: 10 }}>showing {TRUNC.toLocaleString()}</span>}
                  {execMs !== null && <span style={{ color: "var(--muted, #666)", marginLeft: 8, fontSize: 10 }}>⏱ {execMs}ms</span>}
                </span>
              </div>

              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                {/* Pretty JSON */}
                {outText && (
                  <button
                    className={`deveval-copy-btn${prettyJson ? " copied" : ""}`}
                    onClick={() => setPrettyJson(v => !v)}
                    title={prettyJson ? "Tampilkan output original" : "Format sebagai JSON (pretty print)"}
                    style={{ color: prettyJson ? "var(--green)" : isJsonOutput ? undefined : "rgba(255,255,255,0.3)" }}>
                    <IconJson />&nbsp;JSON
                  </button>
                )}
                {/* Search toggle */}
                <button
                  className={`deveval-copy-btn${showSearch ? " copied" : ""}`}
                  onClick={() => { setShowSearch(v => { if (!v) setTimeout(() => searchRef.current?.focus(), 60); return !v }) }}
                  title="Search in output (Ctrl+F)">
                  <IconSearch />&nbsp;Search
                </button>
                {/* Line numbers toggle */}
                <button
                  className={`deveval-copy-btn${showLines ? " copied" : ""}`}
                  onClick={() => setShowLines(v => !v)}
                  title="Toggle line numbers">
                  <IconLines />&nbsp;Lines
                </button>
                {/* Pin output */}
                <button
                  className={`deveval-copy-btn${pinned ? " copied" : ""}`}
                  onClick={() => setPinned(p => p ? null : outText)}
                  title={pinned ? "Unpin" : "Pin this output to compare"}>
                  <IconPin />&nbsp;{pinned ? "Unpin" : "Pin"}
                </button>
                {/* Full view */}
                {outText && outText.length > TRUNC && (
                  <button className="deveval-copy-btn" onClick={() => setFullView(v => !v)}
                    style={{ color: fullView ? "var(--green)" : undefined }}
                    title={fullView ? "Collapse output" : "Show full output — no truncation"}>
                    {fullView ? <><IconCollapse />&nbsp;Collapse</> : <><IconExpand />&nbsp;Full View</>}
                  </button>
                )}
                {/* Save */}
                <button className={`deveval-copy-btn${saved ? " copied" : ""}`} onClick={saveOut} title="Save output to file">
                  {saved ? <><IconCheck />&nbsp;Saved</> : <><IconSave />&nbsp;Save</>}
                </button>
                {/* Copy */}
                <button className={`deveval-copy-btn${copied ? " copied" : ""}`} onClick={copyOut} title="Copy output">
                  {copied ? <><IconCheck />&nbsp;Copied</> : <><IconCopy />&nbsp;Copy</>}
                </button>
              </div>
            </div>

            {/* ── Search bar ────────────────────────────────────────── */}
            {showSearch && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 10px", borderBottom: "1px solid var(--border)",
                background: "rgba(0,0,0,.2)"
              }}>
                <IconSearch />
                <input
                  ref={searchRef}
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Search in output…"
                  spellCheck={false}
                  style={{
                    flex: 1, background: "transparent", border: "none", outline: "none",
                    color: "inherit", fontSize: 12, fontFamily: "monospace"
                  }}
                />
                {searchQ && (
                  <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>
                    {matchCount === 0 ? "no match" : `${searchIdx + 1} / ${matchCount}`}
                  </span>
                )}
                <button
                  className="deveval-copy-btn"
                  onClick={() => setSearchIdx(i => (i - 1 + Math.max(1, matchCount)) % Math.max(1, matchCount))}
                  title="Previous match (↑ / Shift+Enter)"
                  disabled={matchCount === 0}
                  style={{ padding: "2px 6px" }}>↑</button>
                <button
                  className="deveval-copy-btn"
                  onClick={() => setSearchIdx(i => (i + 1) % Math.max(1, matchCount))}
                  title="Next match (↓ / Enter)"
                  disabled={matchCount === 0}
                  style={{ padding: "2px 6px" }}>↓</button>
                <button
                  className="deveval-copy-btn"
                  onClick={() => { setShowSearch(false); setSearchQ(""); edRef.current?.focus() }}
                  title="Close search (Esc)"
                  style={{ padding: "2px 6px" }}>✕</button>
              </div>
            )}

            {/* ── Main output ───────────────────────────────────────── */}
            <div ref={outRef} className="deveval-output-wrap"
              style={{ maxHeight: fullView ? "70vh" : "42vh", overflowY: "auto" }}>
              <pre className={`deveval-output-pre${showLines ? " has-lines" : ""}`}
                dangerouslySetInnerHTML={{ __html: outputWithLines }} />
            </div>

            {/* ── Pinned compare panel ──────────────────────────────── */}
            {pinned && pinned !== outText && (
              <div style={{ borderTop: "1px solid var(--border)" }}>
                <div style={{
                  padding: "4px 10px", fontSize: 10, opacity: 0.5,
                  display: "flex", justifyContent: "space-between"
                }}>
                  <span>📌 Pinned output</span>
                  <button className="deveval-copy-btn" style={{ fontSize: 10 }} onClick={() => setPinned(null)}>clear pin</button>
                </div>
                <div style={{ maxHeight: "20vh", overflowY: "auto" }}>
                  <pre className={`deveval-output-pre${showLines ? " has-lines" : ""}`}
                    style={{ opacity: 0.6 }}
                    dangerouslySetInnerHTML={{ __html: colorize(pinned || "") }} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Inline CSS for new features ─────────────────────────────────── */}
        <style>{`
          .devc-search-match { background: rgba(250,200,0,.35); border-radius: 2px; }
          .devc-search-current { background: rgba(250,200,0,.85); color: #000 !important; border-radius: 2px; }
          .devc-ln {
            display: inline-block;
            min-width: 3ch;
            margin-right: 12px;
            color: rgba(255,255,255,.2);
            user-select: none;
            text-align: right;
            font-size: 0.9em;
          }
          .deveval-output-pre.has-lines { padding-left: 6px; }
        `}</style>
      </div>
    </div>
  )
})

export default DevEvalModal