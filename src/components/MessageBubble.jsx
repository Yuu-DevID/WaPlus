import { format } from "date-fns"
import { useState } from "react"

// ─── Helper: resolve media src ───────────────────────────────────────────────
// DB menyimpan media_saved_path (absolute local path) dan media_url (remote).
// Electron butuh prefix "file://" untuk local path.
function getMediaSrc(msg) {
  if (msg.media_saved_path) {
    const p = msg.media_saved_path.replace(/\\/g, "/")
    return p.startsWith("file://") ? p : `file://${p}`
  }
  if (msg.media_url) return msg.media_url
  return null
}

// ─── Tick indicators ─────────────────────────────────────────────────────────
function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span style={{fontSize:10,color:"var(--text-3)"}}>⏱</span>
  if (s === 1) return <span className="tick-sent">✓</span>
  if (s === 2) return <span className="tick-sent">✓✓</span>
  return <span className="tick-read">✓✓</span>
}

function BubbleTime({ ts }) {
  if (!ts) return null
  return <span className="bubble-time">{format(new Date(ts*1000),"HH:mm")}</span>
}

function QuotedMsg({ body, sender }) {
  if (!body && !sender) return null
  return (
    <div className="quoted">
      {sender && <div className="quoted-sender">{sender}</div>}
      <div className="quoted-text">{body||"Pesan"}</div>
    </div>
  )
}

function ReactionOverlay({ reactions }) {
  if (!reactions?.length) return null
  const grouped = {}
  for (const r of reactions) grouped[r.text] = (grouped[r.text]||0)+1
  return (
    <div className="reaction-row">
      {Object.entries(grouped).map(([e,n])=>(
        <div key={e} className="reaction-chip">
          <span>{e}</span>
          {n>1 && <span className="reaction-chip-count">{n}</span>}
        </div>
      ))}
    </div>
  )
}

function AudioBubble({ isPtt, duration }) {
  const [playing, setPlaying] = useState(false)
  const fmt = s => s ? `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}` : "0:00"
  return (
    <div className="media-audio">
      <button className="audio-play-btn" onClick={()=>setPlaying(!playing)}>
        {playing ? "⏸" : "▶"}
      </button>
      <div className="audio-track">
        <div className="audio-bar">
          <div className="audio-fill" style={{width:playing?"35%":"0%",transition:"width .3s"}}/>
        </div>
        <div className="audio-meta">
          <span className="audio-label">{isPtt?"Pesan Suara":"Audio"}</span>
          <span className="audio-dur">{fmt(duration)}</span>
        </div>
      </div>
    </div>
  )
}

const DOC_ICONS = { PDF:"📕",DOCX:"📘",DOC:"📘",XLSX:"📗",XLS:"📗",ZIP:"🗜️",RAR:"🗜️",TXT:"📃",APK:"📱",MP4:"🎬",PNG:"🖼️",JPG:"🖼️" }
function DocBubble({ body, mimetype }) {
  const ext = mimetype ? mimetype.split("/")[1]?.split(";")[0]?.toUpperCase() : "FILE"
  return (
    <div className="media-doc">
      <div className="doc-icon">{DOC_ICONS[ext]||"📄"}</div>
      <div style={{minWidth:0,flex:1}}>
        <div className="doc-name">{body||"Dokumen"}</div>
        <div className="doc-ext">{ext||"FILE"}</div>
      </div>
    </div>
  )
}

function PollBubble({ body, pollOptions }) {
  const opts = pollOptions||[]
  const total = opts.reduce((s,o)=>s+(o.votes||0),0)
  return (
    <div className="poll-wrap">
      <div className="poll-header">
        <span style={{fontSize:20}}>📊</span>
        <div>
          <div className="poll-title">{body||"Polling"}</div>
          <div className="poll-sub">Pilih salah satu opsi</div>
        </div>
      </div>
      {opts.length>0 ? opts.map((o,i)=>{
        const pct = total>0 ? Math.round((o.votes||0)/total*100) : 0
        return (
          <div key={i} className="poll-option">
            <div className="poll-option-top">
              <span className="poll-option-name">{o.name||o}</span>
              <span className="poll-option-pct">{pct}%</span>
            </div>
            <div className="poll-bar"><div className="poll-bar-fill" style={{width:`${pct}%`}}/></div>
          </div>
        )
      }) : <div className="poll-sub">Buka di HP untuk melihat opsi</div>}
      {total>0 && <div className="poll-total">{total} suara</div>}
    </div>
  )
}

function ViewOnceBubble({ mediaType }) {
  return (
    <div className="viewonce-wrap">
      <div className="viewonce-eye">👁</div>
      <div className="viewonce-title">{mediaType==="video"?"Video":"Foto"} sekali lihat</div>
      <div className="viewonce-sub">Buka di WhatsApp HP untuk melihat</div>
    </div>
  )
}

// ─── Image bubble: render dari local path atau URL ────────────────────────────
function ImageBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [err, setErr] = useState(false)

  if (!src || err) {
    return (
      <div className="media-img">
        <div className="media-img-thumb" style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,minHeight:80}}>
          <span style={{fontSize:38}}>🖼️</span>
          <span style={{fontSize:10,color:"var(--text-3)"}}>Foto</span>
        </div>
        {msg.body && <div className="media-caption">{msg.body}</div>}
      </div>
    )
  }
  return (
    <div className="media-img">
      <img
        src={src}
        alt={msg.body || "Foto"}
        onError={() => setErr(true)}
        style={{maxWidth:"100%",maxHeight:300,borderRadius:8,display:"block",objectFit:"cover",cursor:"pointer"}}
      />
      {msg.body && <div className="media-caption">{msg.body}</div>}
    </div>
  )
}

// ─── Video bubble: render video player jika tersedia ─────────────────────────
function VideoBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [err, setErr] = useState(false)

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb">
          <div className="play-btn">▶️</div>
          <span style={{fontSize:12,color:"var(--text-3)"}}>{msg.body||"Video"}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="media-video">
      <video
        src={src}
        controls
        preload="metadata"
        onError={() => setErr(true)}
        style={{maxWidth:"100%",maxHeight:280,borderRadius:8,display:"block"}}
      />
      {msg.body && <div className="media-caption">{msg.body}</div>}
    </div>
  )
}

// ─── Sticker bubble: render WebP dari local path atau URL ────────────────────
function StickerBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [err, setErr] = useState(false)

  if (!src || err) {
    // Fallback ke emoji jika file belum didownload
    return <div style={{fontSize:72,padding:4,lineHeight:1}}>🎭</div>
  }
  return (
    <img
      src={src}
      alt="Stiker"
      onError={() => setErr(true)}
      style={{
        width: 150,
        height: 150,
        objectFit: "contain",
        display: "block",
        // WebP animated stickers butuh ini
        imageRendering: "auto",
      }}
    />
  )
}

// ─── Main content renderer ────────────────────────────────────────────────────
function renderContent(msg) {
  const t = msg.msg_type || "conversation"

  if (t==="viewOnceMessage"||t==="viewOnceMessageV2") return <ViewOnceBubble mediaType="image"/>

  switch(t) {
    case "imageMessage":
      return <ImageBubble msg={msg}/>

    case "videoMessage":
      return <VideoBubble msg={msg}/>

    case "audioMessage":
      return <AudioBubble isPtt={false} duration={msg.duration}/>

    case "pttMessage":
      return <AudioBubble isPtt duration={msg.duration}/>

    case "documentMessage":
      return <DocBubble body={msg.body} mimetype={msg.mimetype}/>

    case "stickerMessage":
      return <StickerBubble msg={msg}/>

    case "locationMessage":
    case "liveLocationMessage": return (
      <div className="media-location">
        <div className="location-map">🗺️</div>
        <div className="location-label">{msg.body||"Lokasi"}</div>
      </div>
    )
    case "pollCreationMessage": return <PollBubble body={msg.body} pollOptions={msg.poll_options}/>
    case "contactMessage":
    case "contactsArrayMessage": return (
      <div className="contact-msg">
        <div className="contact-icon">👤</div>
        <div><div className="contact-name">{msg.body||"Kontak"}</div><div className="contact-sub">Kontak WhatsApp</div></div>
      </div>
    )
    case "groupInviteMessage": return (
      <div className="invite-msg">
        <div className="invite-icon">👥</div>
        <div><div className="invite-title">Undangan Grup</div><div className="invite-sub">{msg.body||"Bergabung ke grup"}</div></div>
      </div>
    )
    case "reactionMessage": return <div style={{fontSize:32,padding:"2px 4px",lineHeight:1}}>{msg.body||"❤️"}</div>
    case "extendedTextMessage":
    case "conversation":
      return <div className="bubble-text">{msg.body || ""}</div>

    case "protocol":
    case "unknown":
    case "ephemeral":
      return null

    default:
      if (msg.body) return <div className="bubble-text">{msg.body}</div>
      const UNSUPPORTED_LABELS = {
        call: "📞 Panggilan", payment: "💳 Pembayaran", order: "🛒 Pesanan",
        product: "🛍 Produk", event: "📅 Acara", buttons: "🔘 Tombol",
        list: "📋 Daftar", interactive: "💬 Interaktif",
      }
      const label = UNSUPPORTED_LABELS[t] || `📎 ${t}`
      return <div className="bubble-unsupported">{label}</div>
  }
}

export default function MessageBubble({ msg }) {
  const isMe = msg.from_me === 1
  const t = msg.msg_type || "conversation"
  const isReaction = t==="reactionMessage"
  const isSticker  = t==="stickerMessage"
  const isMedia    = !["conversation","extendedTextMessage",""].includes(t) && !isReaction && !isSticker
  const hasNoPad   = isMedia && !["pollCreationMessage","locationMessage","contactMessage","groupInviteMessage","audioMessage","pttMessage","documentMessage"].includes(t)

  const bubbleClass = "bubble" + (isMe?" me":"") + (isReaction||isSticker?" sticker":"") + (hasNoPad?" no-pad":"")

  const content = renderContent(msg)
  if (content === null) return null

  return (
    <div className={"msg-row"+(isMe?" me":" them")}>
      {!isMe && msg.is_group && msg.sender_name && (
        <div className="msg-sender-name">{msg.sender_name}</div>
      )}
      <div className={"msg-inner"+(isMe?" me":"")}>
        {!isMe && msg.is_group && (
          <div className="msg-mini-avatar" style={{background:"#1565c0",flexShrink:0}}>
            {(msg.sender_name||"?")[0].toUpperCase()}
          </div>
        )}
        <div className="bubble-wrap">
          <div className={bubbleClass}>
            {msg.quoted_id && <QuotedMsg body={msg.quoted_body} sender={msg.quoted_sender}/>}
            {content}
            {!isReaction && !isSticker && (
              <div className={"bubble-footer"+(isMe?" me":"")}>
                <BubbleTime ts={msg.timestamp}/>
                {isMe && <Ticks status={msg.status}/>}
              </div>
            )}
          </div>
          {msg.reactions && <ReactionOverlay reactions={msg.reactions}/>}
        </div>
      </div>
    </div>
  )
}