// src/components/bubble/MediaBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Media-related bubbles: Image, Video, GIF, Sticker, ViewOnce, Album.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, memo } from "react"
import { useAppStore } from "../../store/app"
import { useMediaSrc, useIsDownloading, toBool, MediaLoadingSpinner, DownloadingPulse, MediaErrorPlaceholder, RichText } from "./utils"
import { HiArrowDownTray, HiEye } from "./icons"

// ════════════════════════════════════════════════════════════
// IMAGE BUBBLE
// ════════════════════════════════════════════════════════════
export function ImageBubble({ msg, onMediaClick }) {
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const [loaded, setLoaded] = useState(false)
  const isDownloading = useIsDownloading(msg.id)

  const handleClick = useCallback(() => {
    if (!src) return
    if (onMediaClick) onMediaClick(msg, src, "image")
    else openMedia([{ src, type: "image", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [src, msg, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div style={{ lineHeight: 0, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.06)", minHeight: 120 }}>
        {err ? <MediaErrorPlaceholder /> : thumbnailSrc ? (
          <div style={{ position: "relative", minHeight: 120 }}>
            <img src={thumbnailSrc} alt="" draggable={false}
              style={{ display: "block", maxWidth: "100%", maxHeight: 320, width: "100%", objectFit: "cover", filter: "blur(8px)", transform: "scale(1.05)", userSelect: "none" }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {isDownloading ? <DownloadingPulse /> : <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />}
            </div>
          </div>
        ) : (
          <div style={{ minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {isDownloading ? <DownloadingPulse /> : <MediaLoadingSpinner />}
          </div>
        )}
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  return (
    <>
      <div style={{ lineHeight: 0, borderRadius: msg.body ? "8px 8px 0 0" : 8, overflow: "hidden", position: "relative" }}>
        {!loaded && thumbnailSrc && (
          <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(8px)", transform: "scale(1.05)", userSelect: "none", pointerEvents: "none" }} />
        )}
        {!loaded && !thumbnailSrc && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.04)", minHeight: 80 }}>
            <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          </div>
        )}
        <img src={src} alt={msg.body || "Foto"} onLoad={() => setLoaded(true)} onError={() => setErr(true)}
          onClick={handleClick} draggable={false}
          style={{ display: "block", maxWidth: "100%", maxHeight: 320, width: "100%", objectFit: "cover", cursor: "zoom-in", opacity: loaded ? 1 : 0, transition: "opacity 0.2s", verticalAlign: "bottom", userSelect: "none" }} />
      </div>
      {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
    </>
  )
}

// ════════════════════════════════════════════════════════════
// VIDEO BUBBLE
// ════════════════════════════════════════════════════════════
export function VideoBubble({ msg, onMediaClick }) {
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const isGif = toBool(msg.is_gif)
  const isDownloading = useIsDownloading(msg.id)
  const [thumbLoaded, setThumbLoaded] = useState(false)

  const handleClick = useCallback(() => {
    if (!src || isGif) return
    if (onMediaClick) onMediaClick(msg, src, "video")
    else openMedia([{ src, type: "video", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [src, msg, isGif, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb" style={{ cursor: "default", minHeight: 120, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, overflow: "hidden", borderRadius: 8 }}>
          {thumbnailSrc && !err && (
            <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(10px)", transform: "scale(1.08)", userSelect: "none", pointerEvents: "none" }} />
          )}
          <div style={{ position: "relative", zIndex: 1 }}>
            {err ? <MediaErrorPlaceholder label={isGif ? "Gagal memuat GIF" : "Gagal memuat video"} />
              : isDownloading ? <DownloadingPulse label={isGif ? "Mengunduh GIF..." : "Mengunduh video..."} />
              : <MediaLoadingSpinner label={isGif ? "Mengunduh GIF..." : "Mengunduh video..."} />}
          </div>
        </div>
      </div>
    )
  }

  if (isGif) {
    return (
      <div className="media-img">
        <video src={src} autoPlay loop muted playsInline onError={() => setErr(true)} style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }} />
        <div className="gif-badge">GIF</div>
        {msg.body && <div className="media-caption"><RichText text={msg.body} /></div>}
      </div>
    )
  }

  return (
    <div className="media-video" onClick={handleClick} style={{ cursor: "pointer", position: "relative", borderRadius: 8, overflow: "hidden" }} title="Klik untuk putar">
      <video src={src + "#t=0.5"} preload="metadata" muted onLoadedData={() => setThumbLoaded(true)} onError={() => setErr(true)}
        style={{ maxWidth: "100%", maxHeight: 280, display: "block", borderRadius: 8, width: "100%" }} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.25)", borderRadius: 8 }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.4)"}
        onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.25)"}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "2px solid rgba(255,255,255,0.4)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="8,5 20,12 8,19" /></svg>
        </div>
      </div>
      {msg.body && <div className="media-caption" onClick={e => e.stopPropagation()}><RichText text={msg.body} /></div>}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// STICKER BUBBLE
// ════════════════════════════════════════════════════════════
export function StickerBubble({ msg }) {
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const [imgFailed, setImgFailed] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const isDownloading = useIsDownloading(msg.id)
  const stickerStyle = { width: 150, height: 150, objectFit: "contain", display: "block", borderRadius: 4 }

  if (!src && !thumbnailSrc) {
    return (
      <div style={{ width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12 }}>
        {isDownloading ? <DownloadingPulse label="Mengunduh stiker..." /> : <MediaLoadingSpinner label="Mengunduh stiker..." />}
      </div>
    )
  }

  if (!src && thumbnailSrc) {
    return <img src={thumbnailSrc} alt="Stiker" style={{ ...stickerStyle, filter: "blur(2px)" }} />
  }

  if (imgFailed && videoFailed) {
    return (
      <div style={{ width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12 }}>
        <MediaErrorPlaceholder label="Gagal memuat stiker" />
      </div>
    )
  }

  if (imgFailed) return <video src={src} autoPlay loop muted playsInline onError={() => setVideoFailed(true)} style={stickerStyle} />
  return <img src={src} alt="Stiker" onError={() => setImgFailed(true)} style={stickerStyle} />
}

// ════════════════════════════════════════════════════════════
// VIEW ONCE BUBBLE
// ════════════════════════════════════════════════════════════
export function ViewOnceBubble({ msg }) {
  const isVideo = msg.mimetype?.startsWith("video")
  return (
    <div className="viewonce-wrap">
      <div className="viewonce-eye" style={{ color: "var(--text-2)" }}><HiEye size={24} /></div>
      <div className="viewonce-title">{isVideo ? "Video" : "Foto"} sekali lihat</div>
      <div className="viewonce-sub">Buka di WhatsApp HP untuk melihat</div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// ALBUM BUBBLE — WhatsApp-style 2-column grid for multiple media
// ════════════════════════════════════════════════════════════
function albumPathToSrc(raw) {
  if (!raw) return null
  if (raw.startsWith("file://")) return raw
  let p = raw.replace(/\\/g, "/")
  if (/^[A-Za-z]:\//.test(p)) return `file://${p.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
  const w = p.startsWith("/") ? p : `/${p}`
  return `file://${w.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
}

export function AlbumBubble({ msgs, onMediaClick, openMedia }) {
  const MAX_VISIBLE = 4
  const visible = msgs.slice(0, MAX_VISIBLE)
  const overflow = msgs.length - MAX_VISIBLE

  const anyDownloaded = msgs.some(m => m.media_saved_path || m.media_url)
  if (!anyDownloaded) {
    const totalSize = msgs.reduce((s, m) => s + (m.media_filesize || 0), 0)
    const sizeLabel = totalSize > 0
      ? (totalSize > 1024 * 1024 ? `${(totalSize / 1024 / 1024).toFixed(1)} MB` : `${Math.round(totalSize / 1024)} kB`)
      : null
    return (
      <div style={{ position: "relative", width: "100%", minHeight: 160, background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, position: "absolute", inset: 0, opacity: 0.15, filter: "blur(3px)", pointerEvents: "none" }}>
          {visible.map((_, i) => <div key={i} style={{ background: "rgba(255,255,255,0.1)" }} />)}
        </div>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "2px solid rgba(255,255,255,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <HiArrowDownTray size={24} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            {sizeLabel && <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>{sizeLabel}</span>}
            <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 12 }}>{msgs.length} foto</span>
          </div>
        </div>
      </div>
    )
  }

  const handleClick = (msg, idx) => {
    const items = msgs.map(m => ({
      src: albumPathToSrc(m.media_saved_path) || m.media_url,
      type: m.msg_type === "videoMessage" ? "video" : "image",
      caption: m.body || "",
      msgId: m.id,
      filename: m.media_filename,
    }))
    if (onMediaClick) onMediaClick(msg, items[idx]?.src, items[idx]?.type)
    else openMedia?.(items, idx)
  }

  return (
    <div className="album-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, borderRadius: 8, overflow: "hidden", position: "relative" }}>
      {visible.map((msg, idx) => {
        const src = albumPathToSrc(msg.media_saved_path) || msg.media_url
        const isVideo = msg.msg_type === "videoMessage"
        const isLast = idx === MAX_VISIBLE - 1 && overflow > 0
        return (
          <div key={msg.id || idx} style={{
            position: "relative", lineHeight: 0, cursor: "pointer", overflow: "hidden",
            ...(msgs.length === 3 && idx === 2 ? { gridColumn: "1 / -1" } : {})
          }} onClick={() => handleClick(msg, idx)}>
            {src ? (
              isVideo ? (
                <video src={src + "#t=0.5"} preload="metadata" muted draggable={false} style={{ width: "100%", height: 140, objectFit: "cover", display: "block", pointerEvents: "none" }} />
              ) : (
                <img src={src} alt="" draggable={false} style={{ width: "100%", height: 140, objectFit: "cover", display: "block", userSelect: "none" }} />
              )
            ) : (
              <div style={{ width: "100%", height: 140, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 24, height: 24, border: "2px solid rgba(37,211,102,.4)", borderTopColor: "var(--green)", borderRadius: "50%", animation: "spin-progress 1s linear infinite" }} />
              </div>
            )}
            {isVideo && !isLast && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "1.5px solid rgba(255,255,255,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="8,5 20,12 8,19" /></svg>
                </div>
              </div>
            )}
            {isLast && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: "#fff", fontSize: 26, fontWeight: 700 }}>+{overflow + 1}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}