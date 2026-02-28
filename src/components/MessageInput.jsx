// src/components/MessageInput.jsx
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v2 — AuroraChat Message Input
// [F-1] Reply preview — fixed unicode ↩ × (no more \u21A9 \u00D7)
// [F-2] Drag & Drop file/image → album preview
// [F-3] Paste image (screenshot) → preview + caption
// [F-4] Album mode — stack multiple, each with own caption
// [F-5] Send media via IPC sendMedia
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useRef, useCallback, useEffect } from "react"
import { useChatStore } from "../store/chat"

const EmojiIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/>
    <line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
  </svg>
)
const AttachIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
  </svg>
)
const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
)
const SendIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
  </svg>
)

// ─── Reply Preview Bar ─────────────────────────────────────────────────────────
function ReplyPreviewBar({ replyTo, onCancel, chatName }) {
  if (!replyTo) return null
  const isMe    = replyTo.from_me === 1 || replyTo.from_me === true
  const isGroup = replyTo.is_group === 1 || replyTo.is_group === true
  const senderName = isMe
    ? "Kamu"
    : isGroup
      ? (replyTo.sender_name || chatName || "Anggota")
      : (chatName || replyTo.sender_name || "Mereka")

  const getPreviewText = () => {
    const t = replyTo.msg_type
    if (t === "imageMessage")  return "\uD83D\uDCF7 Foto"
    if (t === "videoMessage")  return "\uD83C\uDFAC Video"
    if (t === "audioMessage" || t === "pttMessage") return "\uD83C\uDFB5 Audio"
    if (t === "stickerMessage") return "\uD83C\uDFAD Stiker"
    if (t === "documentMessage") return "\uD83D\uDCC4 " + (replyTo.media_filename || "Dokumen")
    return replyTo.body || "Pesan"
  }

  return (
    <div className="reply-preview-bar">
      <span className="reply-preview-icon">&#8617;</span>
      <div className="reply-preview-content">
        <div className="reply-preview-name">{senderName}</div>
        <div className="reply-preview-text">{getPreviewText()}</div>
      </div>
      <button className="reply-preview-close" onClick={onCancel} title="Batalkan balasan">&#215;</button>
    </div>
  )
}

// ─── Media Preview Card ───────────────────────────────────────────────────────
function MediaPreviewCard({ item, index, total, onRemove, onCaptionChange }) {
  const isImage = item.mimeType?.startsWith("image/")
  const isVideo = item.mimeType?.startsWith("video/")
  return (
    <div style={{
      position: "relative", display: "flex", flexDirection: "column", gap: 6,
      background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: 8,
      border: "1px solid rgba(255,255,255,0.1)", minWidth: 140, maxWidth: 180, flexShrink: 0,
    }}>
      <div style={{ position: "relative", lineHeight: 0 }}>
        {isImage ? (
          <img src={item.dataUrl} alt="preview"
            style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 7, display: "block" }} />
        ) : (
          <div style={{
            width: "100%", height: 110, borderRadius: 7,
            background: "#1a1a2a", display: "flex", alignItems: "center",
            justifyContent: "center", flexDirection: "column", gap: 4,
          }}>
            <span style={{ fontSize: 28 }}>{isVideo ? "🎬" : "📄"}</span>
            <span style={{ fontSize: 10, color: "var(--text-3)", textOverflow: "ellipsis",
              overflow: "hidden", whiteSpace: "nowrap", maxWidth: "90%", padding: "0 4px" }}>
              {item.fileName || "File"}
            </span>
          </div>
        )}
        <button onClick={() => onRemove(index)} style={{
          position: "absolute", top: 4, right: 4, width: 20, height: 20,
          borderRadius: "50%", background: "rgba(0,0,0,0.75)", border: "none",
          color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700, lineHeight: 1,
        }} title="Hapus">&#215;</button>
        {total > 1 && (
          <div style={{
            position: "absolute", top: 4, left: 4, background: "rgba(0,180,90,0.85)",
            color: "#fff", borderRadius: 8, fontSize: 10, fontWeight: 700, padding: "1px 6px",
          }}>{index + 1}/{total}</div>
        )}
      </div>
      <input type="text" value={item.caption || ""} onChange={e => onCaptionChange(index, e.target.value)}
        placeholder="Keterangan..." style={{
          background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6, color: "var(--text-1)", fontSize: 11.5, padding: "4px 8px",
          outline: "none", width: "100%", boxSizing: "border-box",
        }} />
    </div>
  )
}

// ─── Album Strip ──────────────────────────────────────────────────────────────
function MediaPreviewStrip({ items, onRemove, onCaptionChange, onAddMore }) {
  if (!items.length) return null
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 14px 8px", background: "var(--bg-2)" }}>
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, alignItems: "flex-start" }}>
        {items.map((item, i) => (
          <MediaPreviewCard key={i} item={item} index={i} total={items.length}
            onRemove={onRemove} onCaptionChange={onCaptionChange} />
        ))}
        <button onClick={onAddMore} style={{
          minWidth: 60, height: 110, borderRadius: 10,
          border: "2px dashed rgba(255,255,255,0.2)", background: "transparent",
          color: "var(--text-3)", cursor: "pointer", display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 4, flexShrink: 0, fontSize: 11,
        }} title="Tambah file">
          <span style={{ fontSize: 20 }}>+</span>
          <span>Tambah</span>
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
        {items.length > 1 ? `${items.length} file (album)` : "1 file"}
        {" "}&#8212; keterangan per gambar opsional
      </div>
    </div>
  )
}

// ─── Drag Overlay ─────────────────────────────────────────────────────────────
function DragOverlay() {
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 50,
      background: "rgba(0,180,90,0.15)", border: "2px dashed var(--green)",
      borderRadius: 12, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 6, pointerEvents: "none",
    }}>
      <span style={{ fontSize: 32 }}>&#128206;</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--green)" }}>Lepas untuk lampirkan</span>
    </div>
  )
}

// ─── File → MediaItem ─────────────────────────────────────────────────────────
function fileToMediaItem(file) {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = e => resolve({
      dataUrl: e.target.result,
      mimeType: file.type || "application/octet-stream",
      fileName: file.name,
      caption: "",
    })
    reader.readAsDataURL(file)
  })
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════
export default function MessageInput({ chatJid, chatName, replyTo, onCancelReply }) {
  const [text, setText]             = useState("")
  const [sending, setSending]       = useState(false)
  const [mediaItems, setMediaItems] = useState([])
  const [isDragOver, setIsDragOver] = useState(false)

  const ref     = useRef(null)
  const fileRef = useRef(null)
  const wrapRef = useRef(null)
  const { appendMessage } = useChatStore()
  const hasText  = text.trim().length > 0
  const hasMedia = mediaItems.length > 0
  const canSend  = (hasText || hasMedia) && !sending

  useEffect(() => { if (replyTo) ref.current?.focus() }, [replyTo])

  useEffect(() => {
    const handler = e => {
      if (e.key === "Escape") {
        if (hasMedia) { setMediaItems([]); return }
        if (replyTo) onCancelReply?.()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [replyTo, onCancelReply, hasMedia])

  const handleChange = e => {
    setText(e.target.value)
    const el = e.target; el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 130) + "px"
  }

  // ── Add files ─────────────────────────────────────────────────────────────
  const addFiles = useCallback(async files => {
    const arr = Array.from(files)
    if (!arr.length) return
    const items = await Promise.all(arr.map(fileToMediaItem))
    setMediaItems(prev => [...prev, ...items])
  }, [])

  // ── Paste image [F-3] ─────────────────────────────────────────────────────
  useEffect(() => {
    const handlePaste = async e => {
      const items = e.clipboardData?.items
      if (!items) return
      const files = []
      for (const item of items) {
        if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f) }
      }
      if (files.length) { e.preventDefault(); await addFiles(files) }
    }
    window.addEventListener("paste", handlePaste)
    return () => window.removeEventListener("paste", handlePaste)
  }, [addFiles])

  // ── Drag & Drop [F-2] ─────────────────────────────────────────────────────
  const onDragOver  = useCallback(e => { e.preventDefault(); setIsDragOver(true) }, [])
  const onDragLeave = useCallback(e => {
    if (!wrapRef.current?.contains(e.relatedTarget)) setIsDragOver(false)
  }, [])
  const onDrop = useCallback(async e => {
    e.preventDefault(); setIsDragOver(false)
    if (e.dataTransfer.files.length) await addFiles(e.dataTransfer.files)
  }, [addFiles])

  const removeMedia     = useCallback(i => setMediaItems(p => p.filter((_, idx) => idx !== i)), [])
  const updateCaption   = useCallback((i, cap) => setMediaItems(p => p.map((m, idx) => idx === i ? { ...m, caption: cap } : m)), [])
  const openFilePicker  = useCallback(() => fileRef.current?.click(), [])

  // ── Send text ─────────────────────────────────────────────────────────────
  const sendText = useCallback(async () => {
    const body = text.trim()
    if (!body || sending) return
    const quotedMsg = replyTo || null
    setText(""); if (ref.current) ref.current.style.height = "42px"
    setSending(true); onCancelReply?.()
    try {
      if (window.api?.sendMessage) {
        const res = await window.api.sendMessage({ jid: chatJid, body, quotedMsgId: quotedMsg?.id || null })
        if (res?.ok) {
          const msgId = res.message?.key?.id ?? res.message?.id ?? "local-" + Date.now()
          appendMessage(chatJid, {
            id: msgId, chat_jid: chatJid, body, msg_type: "conversation",
            timestamp: Math.floor(Date.now() / 1000), from_me: 1, status: 1,
            quoted_id: quotedMsg?.id || null, quoted_body: quotedMsg?.body || null,
            quoted_sender: quotedMsg?.sender_name || quotedMsg?.sender_jid || null,
            quoted_type: quotedMsg?.msg_type || null, quoted_has_media: quotedMsg?.has_media || 0,
          })
        }
      } else {
        appendMessage(chatJid, {
          id: "dev-" + Date.now(), chat_jid: chatJid, body, msg_type: "conversation",
          timestamp: Math.floor(Date.now() / 1000), from_me: 1, status: 1,
        })
      }
    } catch(e) { console.error("Send error:", e) }
    finally { setSending(false); ref.current?.focus() }
  }, [text, chatJid, sending, replyTo, onCancelReply, appendMessage])

  // ── Send media [F-5] ──────────────────────────────────────────────────────
  const sendMedia = useCallback(async () => {
    if (!mediaItems.length || sending) return
    const quotedMsg = replyTo || null
    setSending(true); onCancelReply?.()
    try {
      if (window.api?.sendMedia) {
        await window.api.sendMedia({
          jid: chatJid,
          items: mediaItems,
          quotedMsgId: quotedMsg?.id || null,
        })
      }
      setMediaItems([])
      // also send text caption if typed in the main textarea
      if (text.trim() && window.api?.sendMessage) {
        await window.api.sendMessage({ jid: chatJid, body: text.trim() })
        setText(""); if (ref.current) ref.current.style.height = "42px"
      }
    } catch(e) { console.error("Send media error:", e) }
    finally { setSending(false); ref.current?.focus() }
  }, [mediaItems, chatJid, sending, replyTo, onCancelReply, text])

  const send = useCallback(() => {
    if (hasMedia) return sendMedia()
    if (hasText)  return sendText()
  }, [hasMedia, hasText, sendMedia, sendText])

  return (
    <div ref={wrapRef} className="input-area-wrap" style={{ position: "relative" }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>

      {isDragOver && <DragOverlay />}

      <ReplyPreviewBar replyTo={replyTo} onCancel={onCancelReply} chatName={chatName} />

      {hasMedia && (
        <MediaPreviewStrip
          items={mediaItems} onRemove={removeMedia}
          onCaptionChange={updateCaption} onAddMore={openFilePicker}
        />
      )}

      <div className="input-area">
        <button className="input-action-btn" title="Emoji"><EmojiIcon/></button>
        <button className="input-action-btn" title="Lampiran / drag & drop / paste gambar" onClick={openFilePicker}>
          <AttachIcon/>
        </button>
        <input ref={fileRef} type="file" multiple
          accept="image/*,video/*,application/pdf,application/zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          style={{ display: "none" }}
          onChange={async e => { if (e.target.files?.length) await addFiles(e.target.files); e.target.value = "" }}
        />
        <textarea ref={ref} className="msg-textarea" rows={1} value={text}
          onChange={handleChange}
          onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()} }}
          placeholder={replyTo ? "Ketik balasan..." : hasMedia ? "Keterangan tambahan (opsional)..." : "Ketik pesan..."}
          disabled={sending}
        />
        {canSend ? (
          <button className="send-btn" onClick={send} disabled={sending} title="Kirim">
            {sending ? <span className="spinner spinner-black spinner-sm"/> : <SendIcon/>}
          </button>
        ) : (
          <button className="input-action-btn" title="Rekam Suara"><MicIcon/></button>
        )}
      </div>
    </div>
  )
}
