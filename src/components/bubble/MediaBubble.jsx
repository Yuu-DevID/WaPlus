// src/components/bubble/MediaBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Media-related bubbles: Image, Video, GIF, Sticker, ViewOnce, Album.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useEffect, useRef, memo } from "react"
import { useAppStore } from "../../store/app"
import { useMediaSrc, useIsDownloading, toBool, MediaLoadingSpinner, DownloadingPulse, MediaErrorPlaceholder, RichText, pathToFileUrl } from "./utils"
import { HiArrowDownTray, HiEye } from "./icons"

// ════════════════════════════════════════════════════════════
// MANUAL DOWNLOAD TRIGGER
// ════════════════════════════════════════════════════════════
async function _triggerManualDownload(msgId) {
  if (!window.api?.mediaTriggerDownload) return { ok: false, error: "API not available" }
  try {
    const res = await window.api.mediaTriggerDownload({ msgId })
    return res || { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ════════════════════════════════════════════════════════════
// CLICK-TO-DOWNLOAD PLACEHOLDER
// Shows blurred thumbnail + download button when autoDownload=false
// ════════════════════════════════════════════════════════════
export function ClickToDownloadPlaceholder({ msg, label, onDownloaded, showError }) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const thumb = msg?.media_thumbnail_b64 || null

  // [FIX-FROMME] Auto-trigger download for fromMe messages shown as placeholder
  // (happens when autoDownloadMedia=OFF but we are the sender)
  const isFromMe = msg?.from_me === 1 || msg?.from_me === true
  useEffect(() => {
    if (isFromMe && !pending && !failed && msg?.id && !msg?.media_is_downloaded) {
      setPending(true)
      _triggerManualDownload(msg.id).then(res => {
        if (res?.ok === false) { setPending(false); setFailed(true) }
      }).catch(() => { setPending(false) })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg?.id])

  const handleClick = async (e) => {
    e.stopPropagation()
    if (pending) return
    setFailed(false)
    setPending(true)
    const res = await _triggerManualDownload(msg.id)
    if (res?.ok === false) {
      setPending(false)
      setFailed(true)
    }
    // On success: media:updated IPC re-renders the bubble — no need to clear pending
    onDownloaded?.()
  }

  return (
    <div
      onClick={handleClick}
      style={{
        position: "relative", minHeight: 120, borderRadius: 8, overflow: "hidden",
        cursor: pending ? "wait" : "pointer",
        background: "rgba(0,0,0,0.25)",
        display: "flex", alignItems: "center", justifyContent: "center",
        userSelect: "none",
      }}
    >
      {thumb && (
        <img src={thumb} alt="" draggable={false} aria-hidden
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: "cover", filter: "blur(12px)", transform: "scale(1.1)",
            pointerEvents: "none" }} />
      )}
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }} />
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <div style={{
          width: 46, height: 46, borderRadius: "50%",
          background: failed ? "rgba(220,53,69,0.88)" : "rgba(37,211,102,0.88)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 2px 12px rgba(0,0,0,0.4)", transition: "transform 0.12s",
        }}>
          {pending
            ? <span className="spinner spinner-sm" style={{ borderTopColor: "#fff", borderColor: "rgba(255,255,255,.3)" }} />
            : failed
              ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="1" fill="white"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
              : <HiArrowDownTray size={20} color="#fff" />
          }
        </div>
        <span style={{ fontSize: 11, color: "#fff", fontWeight: 500, textShadow: "0 1px 4px rgba(0,0,0,.7)" }}>
          {pending ? "Mengunduh…" : failed ? "Gagal — Coba lagi" : (label || "Klik untuk unduh")}
        </span>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// IMAGE BUBBLE
// ════════════════════════════════════════════════════════════
export function ImageBubble({ msg, onMediaClick }) {
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const { openMedia, autoDownloadMedia } = useAppStore()
  const [loaded, setLoaded] = useState(false)
  const [imgErr, setImgErr] = useState(false)
  const isDownloading = useIsDownloading(msg.id)

  // [FIX-FROMME] fromMe messages should always try to render, not require manual click
  const isFromMe = msg.from_me === 1 || msg.from_me === true
  // [FIX-NEEDSDOWNLOAD] Only require manual action if: no auto-download AND no src AND
  // not yet downloaded AND not fromMe. If file is missing (src=null after fsExists check)
  // but media_is_downloaded=1, show loading state (re-download in progress).
  const needsManualDownload = !autoDownloadMedia && !src && !msg.media_is_downloaded && !isFromMe

  const handleClick = useCallback(() => {
    if (needsManualDownload || (!src && !thumbnailSrc)) return
    if (!src) return  // no file yet — wait for download
    if (onMediaClick) onMediaClick(msg, src, "image")
    else openMedia([{ src, type: "image", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename, thumbnailSrc }], 0)
  }, [src, thumbnailSrc, msg, onMediaClick, openMedia, needsManualDownload])

  // Reset loaded/err states when src changes
  useEffect(() => { setLoaded(false); setImgErr(false) }, [src])

  if (needsManualDownload) {
    return (
      <div style={{ borderRadius: 8, overflow: "hidden" }}>
        <ClickToDownloadPlaceholder msg={msg} label="Klik untuk unduh foto" />
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  // [FIX-THUMBNAIL-FALLBACK] When full image not yet downloaded (or file missing),
  // show blurred thumbnail + spinner. thumbnailSrc is always a data: URI from DB.
  if (!src || imgErr) {
    const showRetryBtn = imgErr  // image loaded but failed to decode
    return (
      <div style={{ lineHeight: 0, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.06)", minHeight: 120 }}>
        {thumbnailSrc ? (
          <div style={{ position: "relative", minHeight: 120 }}>
            {/* [FIX-THUMB] Use thumbnailSrc (data: URI from DB) as blurred background */}
            <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
              style={{ display: "block", maxWidth: "100%", maxHeight: 320, width: "100%",
                objectFit: "cover", filter: "blur(8px)", transform: "scale(1.05)",
                userSelect: "none", pointerEvents: "none" }} />
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {showRetryBtn
                ? <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <MediaErrorPlaceholder label="Gagal memuat foto" />
                  </div>
                : isDownloading ? <DownloadingPulse />
                : <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
              }
            </div>
          </div>
        ) : (
          <div style={{ minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {showRetryBtn
              ? <MediaErrorPlaceholder label="Gagal memuat foto" />
              : isDownloading ? <DownloadingPulse />
              : <MediaLoadingSpinner />
            }
          </div>
        )}
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  return (
    <>
      <div style={{ lineHeight: 0, borderRadius: msg.body ? "8px 8px 0 0" : 8, overflow: "hidden", position: "relative", minHeight: loaded ? undefined : 120 }}>
        {/* [FIX-THUMB] Blurred thumbnail during main image load */}
        {!loaded && thumbnailSrc && (
          <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
              objectFit: "cover", filter: "blur(8px)", transform: "scale(1.05)",
              userSelect: "none", pointerEvents: "none" }} />
        )}
        {!loaded && !thumbnailSrc && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.04)" }}>
            <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          </div>
        )}
        <img src={src}
          alt={msg.body || "Foto"}
          onLoad={() => { setLoaded(true); setImgErr(false) }}
          onError={() => { setImgErr(true); setErr(true) }}
          onClick={handleClick}
          draggable={false}
          style={{
            display: "block", maxWidth: "100%", maxHeight: 320, width: "100%",
            objectFit: "cover", cursor: "zoom-in",
            opacity: loaded ? 1 : 0, transition: "opacity 0.25s ease",
            verticalAlign: "bottom", userSelect: "none",
          }} />
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
  const { openMedia, autoDownloadMedia } = useAppStore()
  const isGif = toBool(msg.is_gif)
  const isDownloading = useIsDownloading(msg.id)
  const [thumbLoaded, setThumbLoaded] = useState(false)
  const [videoErr, setVideoErr] = useState(false)

  // [FIX-FROMME] fromMe messages should always try to render
  const isFromMe = msg.from_me === 1 || msg.from_me === true
  const needsManualDownload = !autoDownloadMedia && !src && !msg.media_is_downloaded && !isFromMe

  const handleClick = useCallback(() => {
    if (needsManualDownload || !src) return
    if (onMediaClick) onMediaClick(msg, src, "video")
    else openMedia([{ src, type: "video", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename, thumbnailSrc }], 0)
  }, [src, msg, onMediaClick, openMedia, needsManualDownload, thumbnailSrc])

  // Reset video error when src changes (new file downloaded)
  useEffect(() => { setVideoErr(false) }, [src])

  if (needsManualDownload) {
    return (
      <div className="media-video">
        <ClickToDownloadPlaceholder msg={msg} label={isGif ? "Klik untuk unduh GIF" : "Klik untuk unduh video"} />
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  // [FIX-LOADING] Show blurred thumbnail + spinner when media not yet ready
  if (!src || err || videoErr) {
    const showErr = err || videoErr
    return (
      <div className="media-video">
        <div className="media-video-thumb" style={{
          cursor: "default", minHeight: 120, position: "relative",
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 8, overflow: "hidden", borderRadius: 8,
        }}>
          {thumbnailSrc && !showErr && (
            <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                objectFit: "cover", filter: "blur(10px)", transform: "scale(1.08)",
                userSelect: "none", pointerEvents: "none" }} />
          )}
          {thumbnailSrc && !showErr && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)" }} />
          )}
          <div style={{ position: "relative", zIndex: 1 }}>
            {showErr
              ? <MediaErrorPlaceholder label={isGif ? "Gagal memuat GIF" : "Gagal memuat video"} />
              : isDownloading
                ? <DownloadingPulse label={isGif ? "Mengunduh GIF..." : "Mengunduh video..."} />
                : <MediaLoadingSpinner label={isGif ? "Memuat GIF..." : "Memuat video..."} />
            }
          </div>
        </div>
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  if (isGif) {
    return (
      <div className="media-img" style={{ position: "relative" }}>
        {/* [FIX-GIF] video/mp4 with autoPlay loop is the correct player for WA GIFs.
            onError: try remounting once then show error state. */}
        <video
          key={src}
          src={src}
          autoPlay loop muted playsInline
          onError={() => { setVideoErr(true); setErr(true) }}
          style={{
            display: "block",
            width: "100%",
            maxHeight: 280,
            borderRadius: msg.body ? "8px 8px 0 0" : 8,
            objectFit: "cover",
            background: "rgba(0,0,0,0.1)",
          }}
        />
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
// ALBUM BUBBLE
// ════════════════════════════════════════════════════════════
function albumPathToSrc(raw) {
  // [FIX-ALBUM-PATH] Reuse the shared pathToFileUrl helper (handles Windows paths,
  // already-encoded file:// URLs, Linux paths, etc.)
  if (!raw) return null
  return pathToFileUrl(raw)
}

export function AlbumBubble({ msgs, onMediaClick, openMedia }) {
  const { autoDownloadMedia } = useAppStore()
  const MAX_VISIBLE = 4
  const visible = msgs.slice(0, MAX_VISIBLE)
  const overflow = msgs.length - MAX_VISIBLE

  // [FIX-ALBUM-DL] States for per-item download in manual mode
  const [downloading, setDownloading] = useState({})
  const [failed, setFailed] = useState({})

  const anyDownloaded = msgs.some(m => m.media_saved_path || m.media_url)
  const allPending = !anyDownloaded && !autoDownloadMedia

  // Whole-album download placeholder when nothing downloaded + autoDownload OFF
  const handleAlbumDownload = async (e) => {
    e.stopPropagation()
    const ids = msgs.map(m => m.id)
    const newDl = {}; ids.forEach(id => { newDl[id] = true }); setDownloading(newDl)
    const results = await Promise.allSettled(ids.map(id => _triggerManualDownload(id)))
    const newFailed = {}
    results.forEach((r, i) => {
      if (r.status === "rejected" || r.value?.ok === false) newFailed[ids[i]] = true
    })
    setFailed(newFailed)
    setDownloading({})
  }

  const handleItemDownload = async (e, msgId) => {
    e.stopPropagation()
    setDownloading(d => ({ ...d, [msgId]: true }))
    setFailed(f => ({ ...f, [msgId]: false }))
    const res = await _triggerManualDownload(msgId)
    if (res?.ok === false) {
      setFailed(f => ({ ...f, [msgId]: true }))
      setDownloading(d => ({ ...d, [msgId]: false }))
    }
  }

  // Nothing downloaded + auto-download is OFF → show album download CTA
  if (allPending) {
    const totalSize = msgs.reduce((s, m) => s + (m.media_size || m.media_filesize || 0), 0)
    const sizeLabel = totalSize > 0
      ? (totalSize > 1024 * 1024 ? `${(totalSize / 1024 / 1024).toFixed(1)} MB` : `${Math.round(totalSize / 1024)} kB`)
      : null
    const isAllDl = Object.keys(downloading).length > 0
    const hasFailed = Object.keys(failed).length > 0
    return (
      <div
        onClick={handleAlbumDownload}
        style={{ position: "relative", width: "100%", minHeight: 160, background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: isAllDl ? "wait" : "pointer" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, position: "absolute", inset: 0, opacity: 0.12, filter: "blur(3px)", pointerEvents: "none" }}>
          {visible.map((_, i) => <div key={i} style={{ background: "rgba(255,255,255,0.1)" }} />)}
        </div>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: hasFailed ? "rgba(220,53,69,0.85)" : "rgba(37,211,102,0.85)", border: "2px solid rgba(255,255,255,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {isAllDl
              ? <span className="spinner spinner-sm" style={{ borderTopColor: "#fff", borderColor: "rgba(255,255,255,.3)", width: 24, height: 24 }} />
              : <HiArrowDownTray size={24} color="#fff" />
            }
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            {sizeLabel && <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>{sizeLabel}</span>}
            <span style={{ color: "rgba(255,255,255,0.85)", fontSize: 12 }}>
              {hasFailed ? "Beberapa gagal — coba lagi" : isAllDl ? "Mengunduh..." : `${msgs.length} foto/video`}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // Normal grid — some/all downloaded
  const handleClick = (msg, idx) => {
    const items = msgs.map(m => ({
      src: albumPathToSrc(m.media_saved_path) || m.media_url || null,
      type: m.msg_type === "videoMessage" ? "video" : "image",
      caption: m.body || "",
      msgId: m.id,
      filename: m.media_filename,
      thumbnailSrc: m.media_thumbnail_b64 || null,
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
        const isDl = downloading[msg.id]
        const isFail = failed[msg.id]
        const notDownloaded = !src && !autoDownloadMedia

        return (
          <div key={msg.id || idx} style={{
            position: "relative", lineHeight: 0, cursor: "pointer", overflow: "hidden",
            ...(msgs.length === 3 && idx === 2 ? { gridColumn: "1 / -1" } : {})
          }} onClick={() => notDownloaded ? null : handleClick(msg, idx)}>
            {src ? (
              isVideo ? (
                <video src={src + "#t=0.5"} preload="metadata" muted draggable={false} style={{ width: "100%", height: 140, objectFit: "cover", display: "block", pointerEvents: "none" }} />
              ) : (
                <img src={src} alt="" draggable={false} style={{ width: "100%", height: 140, objectFit: "cover", display: "block", userSelect: "none" }} />
              )
            ) : (
              // Not downloaded — show thumbnail or download button
              <div style={{ width: "100%", height: 140, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
                {msg.media_thumbnail_b64 && (
                  <img src={msg.media_thumbnail_b64} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(10px)", transform: "scale(1.1)", pointerEvents: "none" }} />
                )}
                <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} />
                <div
                  style={{ position: "relative", zIndex: 1, width: 34, height: 34, borderRadius: "50%", background: isFail ? "rgba(220,53,69,0.85)" : "rgba(37,211,102,0.85)", display: "flex", alignItems: "center", justifyContent: "center", cursor: isDl ? "wait" : "pointer" }}
                  onClick={e => !isDl && handleItemDownload(e, msg.id)}
                >
                  {isDl
                    ? <span className="spinner spinner-sm" style={{ borderTopColor: "#fff", borderColor: "rgba(255,255,255,.3)", width: 16, height: 16 }} />
                    : <HiArrowDownTray size={16} color="#fff" />
                  }
                </div>
              </div>
            )}
            {isVideo && src && !isLast && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "1.5px solid rgba(255,255,255,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="8,5 20,12 8,19" /></svg>
                </div>
              </div>
            )}
            {isLast && src && (
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
