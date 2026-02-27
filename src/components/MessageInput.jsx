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

// ─── Reply preview bar ────────────────────────────────────────────────────────────────────────────────
function ReplyPreviewBar({ replyTo, onCancel, chatName }) {
  if (!replyTo) return null

  const isMe = replyTo.from_me === 1 || replyTo.from_me === true
  // [FIX-OWN] For own messages: always "Kamu"
  // For others in DM: use chatName (the contact's display name from header)
  // For others in group: use sender_name (group member name)
  const isGroup = replyTo.is_group === 1 || replyTo.is_group === true
  const senderName = isMe
    ? "Kamu"
    : (isGroup
        ? (replyTo.sender_name || chatName || "Anggota")
        : (chatName || replyTo.sender_name || "Mereka"))

  const getPreviewText = () => {
    const t = replyTo.msg_type
    if (t === "imageMessage")  return "\u{1F4F7} Foto"
    if (t === "videoMessage")  return "\u{1F3AC} Video"
    if (t === "audioMessage" || t === "pttMessage") return "\u{1F3B5} Audio"
    if (t === "stickerMessage") return "\u{1F3AD} Stiker"
    if (t === "documentMessage") return "\u{1F4C4} " + (replyTo.media_filename || "Dokumen")
    return replyTo.body || "Pesan"
  }

  return (
    <div className="reply-preview-bar">
      <span className="reply-preview-icon">\u21A9</span>
      <div className="reply-preview-content">
        <div className="reply-preview-name">{senderName}</div>
        <div className="reply-preview-text">{getPreviewText()}</div>
      </div>
      <button className="reply-preview-close" onClick={onCancel} title="Batalkan balasan">\u00D7</button>
    </div>
  )
}

export default function MessageInput({ chatJid, chatName, replyTo, onCancelReply }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const ref = useRef(null)
  const { appendMessage } = useChatStore()
  const hasText = text.trim().length > 0

  useEffect(() => {
    if (replyTo) ref.current?.focus()
  }, [replyTo])

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && replyTo) onCancelReply?.()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [replyTo, onCancelReply])

  const handleChange = (e) => {
    setText(e.target.value)
    const el = e.target
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 130) + "px"
  }

  const send = useCallback(async () => {
    const body = text.trim()
    if (!body || sending) return

    const quotedMsg = replyTo || null

    setText("")
    if (ref.current) ref.current.style.height = "42px"
    setSending(true)
    onCancelReply?.()

    try {
      if (window.api?.sendMessage) {
        const res = await window.api.sendMessage({
          jid: chatJid,
          body,
          quotedMsgId: quotedMsg?.id || null,
        })

        if (res?.ok) {
          const msgId = res.message?.key?.id
            ?? res.message?.id
            ?? "local-" + Date.now()

          appendMessage(chatJid, {
            id: msgId,
            chat_jid: chatJid,
            body,
            msg_type: "conversation",
            timestamp: Math.floor(Date.now() / 1000),
            from_me: 1,
            status: 1,
            quoted_id:     quotedMsg?.id || null,
            quoted_body:   quotedMsg?.body || null,
            quoted_sender: quotedMsg?.sender_name || quotedMsg?.sender_jid || null,
            quoted_type:   quotedMsg?.msg_type || null,
            quoted_has_media: quotedMsg?.has_media || 0,
          })
        }
      } else {
        appendMessage(chatJid, {
          id: "dev-" + Date.now(),
          chat_jid: chatJid,
          body,
          msg_type: "conversation",
          timestamp: Math.floor(Date.now() / 1000),
          from_me: 1,
          status: 1,
          quoted_id:     quotedMsg?.id || null,
          quoted_body:   quotedMsg?.body || null,
          quoted_sender: quotedMsg?.sender_name || quotedMsg?.sender_jid || null,
          quoted_type:   quotedMsg?.msg_type || null,
          quoted_has_media: quotedMsg?.has_media || 0,
        })
      }
    } catch(e) {
      console.error("Send error:", e)
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }, [text, chatJid, sending, replyTo, onCancelReply])

  return (
    <div className="input-area-wrap">
      <ReplyPreviewBar replyTo={replyTo} onCancel={onCancelReply} chatName={chatName} />
      <div className="input-area">
        <button className="input-action-btn" title="Emoji"><EmojiIcon/></button>
        <button className="input-action-btn" title="Lampiran"><AttachIcon/></button>
        <textarea
          ref={ref}
          className="msg-textarea"
          rows={1}
          value={text}
          onChange={handleChange}
          onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()} }}
          placeholder={replyTo ? "Ketik balasan..." : "Ketik pesan..."}
          disabled={sending}
        />
        {hasText ? (
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
