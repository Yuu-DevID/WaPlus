import { useState, useRef, useCallback } from "react"
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

export default function MessageInput({ chatJid }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const ref = useRef(null)
  const { appendMessage } = useChatStore()
  const hasText = text.trim().length > 0

  const handleChange = (e) => {
    setText(e.target.value)
    const el = e.target
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 130) + "px"
  }

  const send = useCallback(async () => {
    const body = text.trim()
    if (!body || sending) return

    setText("")
    if (ref.current) ref.current.style.height = "42px"
    setSending(true)

    try {
      if (window.api?.sendMessage) {
        // sendMessage returns WAMessage dari Baileys
        // ID ada di result.key.id — ini SAMA dengan yang di-emit lewat messages:new
        const res = await window.api.sendMessage({ jid: chatJid, body })

        if (res?.ok) {
          // Baileys result bisa berupa WAMessage langsung atau { key, ... }
          const msgId = res.message?.key?.id   // WAMessage key.id
            ?? res.message?.id                  // shortcut dari main.js
            ?? `local-${Date.now()}`

          // Append dengan ID yang benar.
          // Saat messages:new datang dari client.js (emitOwnEvents:true),
          // appendMessage() di chat.js akan skip karena ID sudah ada (dedup).
          appendMessage(chatJid, {
            id: msgId,
            chat_jid: chatJid,
            body,
            msg_type: "conversation",
            timestamp: Math.floor(Date.now() / 1000),
            from_me: 1,
            status: 1,
          })
        }
        // Jika !res.ok → pesan gagal dikirim, jangan append

      } else {
        // Dev mode / no api
        appendMessage(chatJid, {
          id: `dev-${Date.now()}`,
          chat_jid: chatJid,
          body,
          msg_type: "conversation",
          timestamp: Math.floor(Date.now() / 1000),
          from_me: 1,
          status: 1,
        })
      }
    } catch(e) {
      console.error("Send error:", e)
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }, [text, chatJid, sending])

  return (
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
        placeholder="Ketik pesan..."
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
  )
}