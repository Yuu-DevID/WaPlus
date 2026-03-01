// src/components/MediaViewer.jsx
// ═══════════════════════════════════════════════════════════════════════════
// AuroraChat — Media Viewer Dialog
// Full-featured media viewer for images, videos, and WhatsApp albums.
//
// FIXED: Hooks order violation - all hooks moved before conditional return
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { useAppStore } from "../store/app"

// ── Icons ─────────────────────────────────────────────────────────────────
function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
function ChevronLeft() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}
function ChevronRight() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ── Download helper ──────────────────────────────────────────────────────
function downloadMedia(item) {
  if (!item?.src) return
  if (window.api?.saveMedia) {
    window.api.saveMedia({ src: item.src, filename: item.filename || "media" })
    return
  }
  const a = document.createElement("a")
  a.href = item.src
  a.download = item.filename || (item.type === "video" ? "video.mp4" : "image.jpg")
  a.click()
}

// ════════════════════════════════════════════════════════════
// MAIN MEDIA VIEWER - FIXED HOOKS ORDER
// ════════════════════════════════════════════════════════════
export default function MediaViewer() {
  // ✅ 1. ALL HOOKS MUST BE HERE - before any conditional logic
  const { mediaViewer, closeMedia, openMedia } = useAppStore()
  const [currentZoom, setCurrentZoom] = useState(1)
  const [sliding, setSliding] = useState(false)

  // Extract values safely for use in callbacks
  const items = mediaViewer?.items || []
  const index = mediaViewer?.index || 0
  const current = items[index] || null
  const isAlbum = items.length > 1
  const canPrev = index > 0
  const canNext = index < items.length - 1

  // ✅ 2. ALL useCallback hooks - defined unconditionally
  const navigate = useCallback((dir) => {
    if (sliding) return
    const next = index + dir
    if (next < 0 || next >= items.length) return
    setSliding(true)
    setCurrentZoom(1)
    setTimeout(() => {
      openMedia(items, next)
      setSliding(false)
    }, 80)
  }, [sliding, index, items, openMedia])

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      closeMedia()
      return
    }
    if (e.key === "ArrowLeft") {
      navigate(-1)
      return
    }
    if (e.key === "ArrowRight") {
      navigate(1)
      return
    }
  }, [navigate, closeMedia])

  // ✅ 3. ALL useEffect hooks - defined unconditionally
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    if (!mediaViewer) {
      document.body.style.overflow = ""
      return
    }
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = "" }
  }, [mediaViewer])

  // ✅ 4. Reset zoom when media changes
  useEffect(() => {
    setCurrentZoom(1)
  }, [index])

  // ✅ 5. Conditional return - ONLY AFTER all hooks
  if (!mediaViewer) return null

  // ── Sub-components (defined inside but don't call hooks) ──
  const topBtnStyle = {
    background: "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "50%",
    width: 36, height: 36,
    color: "#fff",
    cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "background 0.15s, transform 0.1s",
    flexShrink: 0,
  }

  const navBtnStyle = {
    position: "absolute",
    top: "50%", transform: "translateY(-50%)",
    background: "rgba(0,0,0,0.45)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "50%",
    width: 48, height: 48,
    color: "#fff",
    cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "background 0.15s, transform 0.12s",
    zIndex: 10,
    backdropFilter: "blur(4px)",
  }

  const topBtn = (onClick, title, children) => (
    <button
      onClick={onClick}
      title={title}
      style={topBtnStyle}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.22)"}
      onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
    >
      {children}
    </button>
  )

  // ── Image Display Component ──
  function ImageDisplay({ src, caption }) {
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState(false)
    const [zoom, setZoom] = useState(1)
    const [pan, setPan] = useState({ x: 0, y: 0 })
    const imgRef = useRef(null)
    const dragging = useRef(false)
    const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 })

    const doZoom = useCallback((delta) => {
      setZoom(z => {
        const next = Math.min(5, Math.max(1, z + delta))
        if (next === 1) setPan({ x: 0, y: 0 })
        return next
      })
    }, [])

    const handleWheel = useCallback((e) => {
      e.preventDefault()
      doZoom(e.deltaY < 0 ? 0.3 : -0.3)
    }, [doZoom])

    const handleDoubleClick = useCallback(() => {
      setZoom(z => {
        const next = z === 1 ? 2.5 : 1
        if (next === 1) setPan({ x: 0, y: 0 })
        return next
      })
    }, [])

    const handleMouseDown = useCallback((e) => {
      if (zoom <= 1) return
      dragging.current = true
      dragStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
      e.preventDefault()
    }, [zoom, pan])

    const handleMouseMove = useCallback((e) => {
      if (!dragging.current) return
      setPan({
        x: dragStart.current.px + (e.clientX - dragStart.current.x),
        y: dragStart.current.py + (e.clientY - dragStart.current.y),
      })
    }, [])

    const handleMouseUp = useCallback(() => { dragging.current = false }, [])

    useEffect(() => {
      setLoaded(false)
      setError(false)
      setZoom(1)
      setPan({ x: 0, y: 0 })
    }, [src])

    if (error) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "rgba(255,255,255,0.5)" }}>
          <span style={{ fontSize: 48 }}>🖼️</span>
          <span style={{ fontSize: 13 }}>Gagal memuat gambar</span>
        </div>
      )
    }

    return (
      <div
        style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", overflow: "hidden" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {!loaded && (
          <div style={{ position: "absolute", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div className="spinner" style={{ width: 36, height: 36, borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Memuat...</span>
          </div>
        )}
        <img
          ref={imgRef}
          src={src}
          alt={caption || "Foto"}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          onDoubleClick={handleDoubleClick}
          draggable={false}
          style={{
            maxWidth: "88vw", maxHeight: "78vh",
            objectFit: "contain",
            transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
            transition: dragging.current ? "none" : "transform 0.2s ease",
            transformOrigin: "center center",
            cursor: zoom > 1 ? (dragging.current ? "grabbing" : "grab") : "zoom-in",
            opacity: loaded ? 1 : 0,
            userSelect: "none",
            borderRadius: 6,
          }}
        />
        {zoom > 1 && (
          <div style={{
            position: "absolute", bottom: 12, right: 12,
            background: "rgba(0,0,0,0.6)", borderRadius: 8, padding: "3px 8px",
            fontSize: 12, color: "rgba(255,255,255,0.7)", pointerEvents: "none",
          }}>
            {Math.round(zoom * 100)}%
          </div>
        )}
      </div>
    )
  }

  // ── Video Display Component ──
  function VideoDisplay({ src }) {
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)

    useEffect(() => { setReady(false); setError(false) }, [src])

    if (error) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "rgba(255,255,255,0.5)" }}>
          <span style={{ fontSize: 48 }}>🎬</span>
          <span style={{ fontSize: 13 }}>Gagal memuat video</span>
        </div>
      )
    }

    return (
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
        {!ready && (
          <div style={{ position: "absolute", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div className="spinner" style={{ width: 36, height: 36, borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Memuat video...</span>
          </div>
        )}
        <video
          src={src}
          controls
          autoPlay
          onCanPlay={() => setReady(true)}
          onError={() => setError(true)}
          style={{
            maxWidth: "88vw", maxHeight: "78vh",
            borderRadius: 8,
            outline: "none",
            opacity: ready ? 1 : 0,
            transition: "opacity 0.2s",
          }}
        />
      </div>
    )
  }

  // ── Thumbnail Strip ──
  function ThumbnailStrip() {
    const stripRef = useRef(null)

    useEffect(() => {
      const el = stripRef.current
      if (!el) return
      const thumb = el.children[index]
      if (thumb) thumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
    }, [index])

    return (
      <div
        ref={stripRef}
        style={{
          display: "flex", gap: 6, padding: "10px 16px",
          justifyContent: "center", overflowX: "auto",
          scrollbarWidth: "none",
          maxWidth: "100vw",
        }}
        className="thumb-strip"
      >
        {items.map((item, i) => (
          <div
            key={i}
            onClick={() => { setCurrentZoom(1); openMedia(items, i) }}
            style={{
              width: 52, height: 52, flexShrink: 0,
              borderRadius: 6, overflow: "hidden",
              cursor: "pointer",
              border: i === index ? "2.5px solid var(--green)" : "2.5px solid rgba(255,255,255,0.1)",
              transition: "border-color 0.15s, transform 0.1s",
              transform: i === index ? "scale(1.05)" : "scale(1)",
              background: "#1a1a1a",
            }}
          >
            {item.type === "image" ? (
              <img src={item.src} alt={`Slide ${i + 1}`}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#222" }}>
                <span style={{ fontSize: 20 }}>🎬</span>
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }

  // ── Render ──
  return createPortal(
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(8,8,8,0.97)",
        display: "flex", flexDirection: "column",
        animation: "mediaViewerIn 0.18s ease",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) closeMedia() }}
    >
      <style>{`
        @keyframes mediaViewerIn { from { opacity: 0 } to { opacity: 1 } }
        .thumb-strip::-webkit-scrollbar { display: none }
      `}</style>

      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px",
        background: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)",
        flexShrink: 0,
      }}>
        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: 500, minWidth: 60 }}>
          {isAlbum && `${index + 1} / ${items.length}`}
        </div>
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, letterSpacing: 0.5 }}>
          {current?.type === "video" ? "Video" : isAlbum ? "Album" : "Foto"}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {current?.type !== "video" && currentZoom > 1 && (
            topBtn(() => setCurrentZoom(1), "Reset zoom", <span style={{ fontSize: 12, fontWeight: 600 }}>1:1</span>)
          )}
          {current?.src && topBtn(() => downloadMedia(current), "Unduh media", <DownloadIcon />)}
          {topBtn(closeMedia, "Tutup (Esc)", <CloseIcon />)}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, overflow: "hidden" }}>
        {isAlbum && canPrev && (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(-1) }}
            style={{ ...navBtnStyle, left: 14 }}
          >
            <ChevronLeft />
          </button>
        )}

        <div style={{
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          opacity: sliding ? 0 : 1,
          transition: "opacity 0.08s",
        }}>
          {current?.type === "video" ? (
            <VideoDisplay src={current.src} />
          ) : current?.src ? (
            <ImageDisplay src={current.src} caption={current.caption} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "rgba(255,255,255,0.4)" }}>
              <div className="spinner" style={{ width: 36, height: 36, borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
              <span style={{ fontSize: 12 }}>Mengunduh media...</span>
            </div>
          )}
        </div>

        {isAlbum && canNext && (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(1) }}
            style={{ ...navBtnStyle, right: 14 }}
          >
            <ChevronRight />
          </button>
        )}
      </div>

      {/* Caption */}
      {current?.caption && (
        <div style={{
          padding: "10px 24px 4px",
          color: "rgba(255,255,255,0.75)",
          fontSize: 13, textAlign: "center", lineHeight: 1.5,
          textShadow: "0 1px 4px rgba(0,0,0,0.8)",
          flexShrink: 0,
        }}>
          {current.caption}
        </div>
      )}

      {/* Thumbnail strip */}
      {isAlbum && (
        <div style={{ flexShrink: 0, paddingBottom: 6 }}>
          <ThumbnailStrip />
        </div>
      )}

      {/* Keyboard hint */}
      <div style={{ textAlign: "center", padding: isAlbum ? "4px 0 8px" : "6px 0 10px", fontSize: 11, color: "rgba(255,255,255,0.2)", flexShrink: 0 }}>
        {isAlbum ? "← → untuk navigasi · Esc untuk tutup" : "Esc untuk tutup"}
      </div>
    </div>,
    document.body
  )
}