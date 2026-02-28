// src/pages/StatusUploader.jsx
// Upload WhatsApp Status (Story) langsung dari WaPlus
// Support: teks, gambar, video, audio
"use strict"

import { useState, useRef, useCallback } from "react"

// ─── Colors & fonts sama persis seperti referensi ─────────────
const STORY_COLORS = [
  '#7ACAA7','#6E257E','#5796FF','#7E90A4','#736769',
  '#57C9FF','#25C3DC','#FF7B6C','#55C265','#FF898B',
  '#8C6991','#C69FCC','#B8B226','#EFB32F','#AD8774',
  '#792139','#C1A03F','#8FA842','#A52C71','#8394CA','#243640',
]

const FONT_NAMES = {
  0: "Sans", 1: "Serif", 2: "Norican Script",
  6: "Besley", 7: "Damion", 8: "Exo 2",
  9: "Pacifico", 10: "ReemKufi",
}

// ─── Helpers ──────────────────────────────────────────────────
function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(new Uint8Array(reader.result))
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function formatSize(bytes) {
  if (bytes < 1024)       return `${bytes} B`
  if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`
  return `${(bytes/(1024*1024)).toFixed(1)} MB`
}

// ─── Tab Button ───────────────────────────────────────────────
function TabBtn({ active, onClick, icon, label }) {
  return (
    <button className={`tab-btn ${active ? "tab-btn--active" : ""}`} onClick={onClick}>
      <span className="tab-btn__icon">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

// ─── Color Picker ─────────────────────────────────────────────
function ColorPicker({ value, onChange }) {
  return (
    <div className="color-picker">
      {STORY_COLORS.map(c => (
        <button
          key={c}
          className={`color-swatch ${value === c ? "color-swatch--active" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          title={c}
        />
      ))}
      <button
        className={`color-swatch color-swatch--random ${value === "random" ? "color-swatch--active" : ""}`}
        onClick={() => onChange("random")}
        title="Acak setiap upload"
      >🎲</button>
    </div>
  )
}

// ─── Preview ──────────────────────────────────────────────────
function StatusPreview({ type, text, previewUrl, bgColor, font }) {
  const bg = bgColor === "random"
    ? STORY_COLORS[Math.floor(Math.random() * STORY_COLORS.length)]
    : (bgColor || "#243640")

  if (type === "image" && previewUrl) {
    return (
      <div className="preview preview--media">
        <img src={previewUrl} alt="preview" className="preview__img" />
      </div>
    )
  }
  if (type === "video" && previewUrl) {
    return (
      <div className="preview preview--media">
        <video src={previewUrl} className="preview__img" controls muted />
      </div>
    )
  }
  if (type === "audio" && previewUrl) {
    return (
      <div className="preview preview--audio" style={{ background: bg }}>
        <div className="preview__waveform">
          {[100,20,80,40,100,60,100,30,70,50,90,20,100,40,80].map((h,i) => (
            <span key={i} className="wave-bar" style={{ height: `${h*0.4}px` }} />
          ))}
        </div>
        <audio src={previewUrl} controls className="preview__audio" />
      </div>
    )
  }
  if (type === "text" && text) {
    return (
      <div className="preview preview--text" style={{ background: bg }}>
        <p className="preview__text" style={{ fontFamily: FONT_NAMES[font] || "sans-serif" }}>
          {text}
        </p>
      </div>
    )
  }
  return (
    <div className="preview preview--empty">
      <div className="preview__placeholder">
        <span style={{fontSize:36}}>👁️</span>
        <span>Preview akan muncul di sini</span>
      </div>
    </div>
  )
}

// ─── Drop Zone ────────────────────────────────────────────────
function DropZone({ accept, onFile, icon, hint }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef()

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }, [onFile])

  return (
    <div
      className={`drop-zone ${dragging ? "drop-zone--over" : ""}`}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current.click()}
    >
      <input ref={inputRef} type="file" accept={accept} style={{display:"none"}}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
      <span style={{fontSize:32}}>{icon}</span>
      <span className="drop-zone__hint">{hint}</span>
      <span className="drop-zone__sub">atau klik untuk pilih file</span>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────
export default function StatusUploader() {
  const [tab,        setTab]        = useState("text")    // text | image | video | audio
  const [text,       setText]       = useState("")
  const [caption,    setCaption]    = useState("")
  const [bgColor,    setBgColor]    = useState("random")
  const [font,       setFont]       = useState(0)
  const [file,       setFile]       = useState(null)      // { name, size, type, buffer, previewUrl }
  const [sending,    setSending]    = useState(false)
  const [result,     setResult]     = useState(null)      // { ok, count, error }
  const [contactCnt, setContactCnt] = useState(null)

  // Load contact count on mount
  useState(() => {
    window.api?.statusGetContactCount?.().then(res => {
      if (res?.ok) setContactCnt(res.count)
    })
  }, [])

  const handleFile = useCallback(async (f) => {
    const buffer    = await readFileAsBuffer(f)
    const previewUrl = await readFileAsDataUrl(f)
    setFile({ name: f.name, size: f.size, mimetype: f.type, buffer, previewUrl })
    setResult(null)
  }, [])

  const clearFile = () => { setFile(null); setResult(null) }

  const handleSend = async () => {
    setSending(true)
    setResult(null)

    try {
      let payload

      if (tab === "text") {
        if (!text.trim()) { setResult({ ok: false, error: "Teks tidak boleh kosong" }); setSending(false); return }
        payload = { type: "text", text: text.trim() }

      } else if (tab === "image" || tab === "video") {
        if (!file) { setResult({ ok: false, error: "Pilih file dulu" }); setSending(false); return }
        payload = { type: tab, mediaBuffer: Array.from(file.buffer), mimetype: file.mimetype, caption }

      } else if (tab === "audio") {
        if (!file) { setResult({ ok: false, error: "Pilih file audio dulu" }); setSending(false); return }
        payload = { type: "audio", mediaBuffer: Array.from(file.buffer), mimetype: file.mimetype }
      }

      const res = await window.api.statusSend(payload)
      setResult(res)
      if (res.ok) {
        // Reset form
        setText("")
        setCaption("")
        clearFile()
      }
    } catch (e) {
      setResult({ ok: false, error: e.message })
    }

    setSending(false)
  }

  const previewUrl = file?.previewUrl || null

  return (
    <div className="status-page">

      {/* Header */}
      <div className="status-header">
        <div className="status-header__left">
          <div className="status-header__title">
            <span className="status-header__emoji">📡</span>
            <span>Upload Status</span>
          </div>
          {contactCnt !== null && (
            <div className="status-header__badge">
              👥 {contactCnt} kontak akan menerima
            </div>
          )}
        </div>
      </div>

      <div className="status-body">

        {/* Left: Form */}
        <div className="status-form">

          {/* Type tabs */}
          <div className="tabs">
            <TabBtn active={tab==="text"}  onClick={() => { setTab("text");  clearFile() }} icon="✏️" label="Teks" />
            <TabBtn active={tab==="image"} onClick={() => { setTab("image"); clearFile() }} icon="🖼️" label="Gambar" />
            <TabBtn active={tab==="video"} onClick={() => { setTab("video"); clearFile() }} icon="🎬" label="Video" />
            <TabBtn active={tab==="audio"} onClick={() => { setTab("audio"); clearFile() }} icon="🎵" label="Audio" />
          </div>

          {/* ── TEXT ── */}
          {tab === "text" && (
            <div className="form-section">
              <label className="form-label">Teks Status</label>
              <textarea
                className="status-textarea"
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Ketik status kamu di sini..."
                maxLength={700}
                rows={5}
              />
              <div className="char-count">{text.length}/700</div>

              <label className="form-label">Warna Background</label>
              <ColorPicker value={bgColor} onChange={setBgColor} />

              <label className="form-label">Font</label>
              <div className="font-picker">
                {Object.entries(FONT_NAMES).map(([id, name]) => (
                  <button
                    key={id}
                    className={`font-btn ${font === Number(id) ? "font-btn--active" : ""}`}
                    style={{ fontFamily: name }}
                    onClick={() => setFont(Number(id))}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── IMAGE ── */}
          {tab === "image" && (
            <div className="form-section">
              {!file ? (
                <DropZone
                  accept="image/*"
                  onFile={handleFile}
                  icon="🖼️"
                  hint="Drag & drop gambar (JPG, PNG, WEBP)"
                />
              ) : (
                <div className="file-info">
                  <div className="file-info__name">📎 {file.name}</div>
                  <div className="file-info__size">{formatSize(file.size)}</div>
                  <button className="file-clear" onClick={clearFile}>✕ Ganti</button>
                </div>
              )}
              <label className="form-label" style={{marginTop:12}}>Caption (opsional)</label>
              <input
                className="status-input"
                value={caption}
                onChange={e => setCaption(e.target.value)}
                placeholder="Tulis caption..."
              />
            </div>
          )}

          {/* ── VIDEO ── */}
          {tab === "video" && (
            <div className="form-section">
              {!file ? (
                <DropZone
                  accept="video/*"
                  onFile={handleFile}
                  icon="🎬"
                  hint="Drag & drop video (MP4, maksimal 30 detik)"
                />
              ) : (
                <div className="file-info">
                  <div className="file-info__name">📎 {file.name}</div>
                  <div className="file-info__size">{formatSize(file.size)}</div>
                  <button className="file-clear" onClick={clearFile}>✕ Ganti</button>
                </div>
              )}
              <label className="form-label" style={{marginTop:12}}>Caption (opsional)</label>
              <input
                className="status-input"
                value={caption}
                onChange={e => setCaption(e.target.value)}
                placeholder="Tulis caption..."
              />
            </div>
          )}

          {/* ── AUDIO ── */}
          {tab === "audio" && (
            <div className="form-section">
              {!file ? (
                <DropZone
                  accept="audio/*"
                  onFile={handleFile}
                  icon="🎵"
                  hint="Drag & drop audio (MP3, OGG, M4A)"
                />
              ) : (
                <div className="file-info">
                  <div className="file-info__name">📎 {file.name}</div>
                  <div className="file-info__size">{formatSize(file.size)}</div>
                  <button className="file-clear" onClick={clearFile}>✕ Ganti</button>
                </div>
              )}
              <label className="form-label" style={{marginTop:12}}>Warna Background</label>
              <ColorPicker value={bgColor} onChange={setBgColor} />
            </div>
          )}

          {/* Result */}
          {result && (
            <div className={`result-banner ${result.ok ? "result-banner--ok" : "result-banner--err"}`}>
              {result.ok
                ? `✅ Status berhasil dikirim ke ${result.count} kontak!`
                : `❌ Gagal: ${result.error}`
              }
            </div>
          )}

          {/* Send button */}
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={sending}
          >
            {sending
              ? <><span className="spinner-sm"/>  Mengirim...</>
              : <><span>📡</span> Upload Status</>
            }
          </button>

        </div>

        {/* Right: Preview */}
        <div className="status-preview-col">
          <div className="preview-label">Preview</div>
          <div className="phone-frame">
            <div className="phone-notch"/>
            <div className="phone-screen">
              <StatusPreview
                type={tab}
                text={text}
                previewUrl={previewUrl}
                bgColor={bgColor}
                font={font}
              />
            </div>
          </div>
        </div>

      </div>

      <style>{`
        .status-page {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: #0d1117;
          color: #e6edf3;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
        }

        /* Header */
        .status-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 24px;
          border-bottom: 1px solid #21262d;
          flex-shrink: 0;
        }
        .status-header__left { display: flex; align-items: center; gap: 14px; }
        .status-header__title {
          display: flex; align-items: center; gap: 10px;
          font-size: 18px; font-weight: 700;
        }
        .status-header__emoji { font-size: 22px; }
        .status-header__badge {
          padding: 4px 12px;
          background: #1a3a2a;
          color: #3fb950;
          border-radius: 20px;
          font-size: 12.5px;
          font-weight: 600;
        }

        /* Body */
        .status-body {
          display: flex;
          flex: 1;
          overflow: hidden;
          gap: 0;
        }

        /* Form column */
        .status-form {
          flex: 1;
          padding: 24px;
          padding-bottom: 32px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-width: 0;
          border-right: 1px solid #21262d;
        }

        /* Tabs */
        .tabs {
          display: flex;
          gap: 6px;
          background: #161b22;
          padding: 6px;
          border-radius: 10px;
          border: 1px solid #21262d;
        }
        .tab-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 8px 10px;
          border: none;
          border-radius: 7px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          background: transparent;
          color: #8b949e;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .tab-btn:hover { background: #21262d; color: #e6edf3; }
        .tab-btn--active { background: #238636; color: white; }
        .tab-btn__icon { font-size: 15px; }

        .form-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .form-label {
          font-size: 12.5px;
          font-weight: 600;
          color: #8b949e;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .status-textarea {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 10px;
          color: #e6edf3;
          font-size: 14px;
          padding: 12px 14px;
          resize: vertical;
          font-family: inherit;
          transition: border-color 0.15s;
          line-height: 1.6;
        }
        .status-textarea:focus { outline: none; border-color: #58a6ff; }

        .status-input {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 8px;
          color: #e6edf3;
          font-size: 13.5px;
          padding: 9px 12px;
          font-family: inherit;
          transition: border-color 0.15s;
        }
        .status-input:focus { outline: none; border-color: #58a6ff; }

        .char-count { font-size: 11px; color: #6e7681; text-align: right; }

        /* Color picker */
        .color-picker {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
        }
        .color-swatch {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: 2px solid transparent;
          cursor: pointer;
          transition: transform 0.15s, border-color 0.15s;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .color-swatch:hover { transform: scale(1.15); }
        .color-swatch--active { border-color: white; transform: scale(1.15); }
        .color-swatch--random { background: #21262d; }

        /* Font picker */
        .font-picker {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .font-btn {
          padding: 5px 12px;
          border-radius: 7px;
          border: 1px solid #30363d;
          background: #161b22;
          color: #8b949e;
          cursor: pointer;
          font-size: 13px;
          transition: all 0.15s;
        }
        .font-btn:hover { border-color: #8b949e; color: #e6edf3; }
        .font-btn--active { border-color: #58a6ff; color: #58a6ff; background: #0d2137; }

        /* Drop zone */
        .drop-zone {
          border: 2px dashed #30363d;
          border-radius: 12px;
          padding: 36px 20px;
          text-align: center;
          cursor: pointer;
          transition: all 0.15s;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          color: #8b949e;
        }
        .drop-zone:hover, .drop-zone--over {
          border-color: #58a6ff;
          background: #0d2137;
          color: #e6edf3;
        }
        .drop-zone__hint { font-size: 13.5px; font-weight: 500; }
        .drop-zone__sub  { font-size: 12px; }

        /* File info */
        .file-info {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 8px;
        }
        .file-info__name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-info__size { font-size: 12px; color: #8b949e; white-space: nowrap; }
        .file-clear {
          padding: 3px 8px;
          background: #2a1a1a;
          border: 1px solid #da3633;
          border-radius: 5px;
          color: #f78166;
          cursor: pointer;
          font-size: 11.5px;
          white-space: nowrap;
          transition: background 0.15s;
        }
        .file-clear:hover { background: #3a1a1a; }

        /* Result banner */
        .result-banner {
          padding: 12px 16px;
          border-radius: 10px;
          font-size: 13.5px;
          font-weight: 500;
          line-height: 1.5;
        }
        .result-banner--ok  { background: #1a3a2a; color: #3fb950; border: 1px solid #238636; }
        .result-banner--err { background: #2a1a1a; color: #f78166; border: 1px solid #da3633; }

        /* Send button */
        .send-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 14px 24px;
          background: linear-gradient(135deg, #238636, #2ea043);
          color: white;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          font-size: 15px;
          font-weight: 600;
          transition: all 0.2s;
          margin-top: 8px;
          letter-spacing: 0.2px;
          flex-shrink: 0;
          min-height: 50px;
          white-space: nowrap;
        }
        .send-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #2ea043, #3fb950);
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(46,160,67,0.35);
        }
        .send-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

        .spinner-sm {
          display: inline-block;
          width: 16px; height: 16px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Preview column */
        .status-preview-col {
          width: 300px;
          flex-shrink: 0;
          padding: 24px 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 14px;
          overflow-y: auto;
          background: #0d1117;
        }
        .preview-label {
          font-size: 12px;
          font-weight: 600;
          color: #6e7681;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          align-self: flex-start;
        }

        /* Phone frame */
        .phone-frame {
          width: 220px;
          height: 420px;
          border-radius: 30px;
          border: 3px solid #30363d;
          background: #161b22;
          overflow: hidden;
          position: relative;
          flex-shrink: 0;
          box-shadow: 0 12px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
        }
        .phone-notch {
          position: absolute;
          top: 8px;
          left: 50%;
          transform: translateX(-50%);
          width: 60px;
          height: 12px;
          background: #0d1117;
          border-radius: 10px;
          z-index: 10;
        }
        .phone-screen {
          width: 100%;
          height: 100%;
          overflow: hidden;
          display: flex;
        }

        /* Preview states */
        .preview {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .preview--empty {
          background: #161b22;
          flex-direction: column;
          gap: 8px;
        }
        .preview__placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          color: #30363d;
          font-size: 11px;
          text-align: center;
          padding: 16px;
        }
        .preview--media { background: #000; padding: 0; }
        .preview__img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .preview--text {
          flex-direction: column;
          padding: 20px;
        }
        .preview__text {
          color: white;
          font-size: 14px;
          text-align: center;
          word-break: break-word;
          margin: 0;
          line-height: 1.5;
          text-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .preview--audio {
          flex-direction: column;
          gap: 16px;
        }
        .preview__waveform {
          display: flex;
          align-items: center;
          gap: 3px;
          height: 50px;
        }
        .wave-bar {
          display: inline-block;
          width: 4px;
          background: rgba(255,255,255,0.8);
          border-radius: 2px;
          min-height: 4px;
        }
        .preview__audio {
          width: 90%;
          height: 28px;
        }
      `}</style>
    </div>
  )
}
