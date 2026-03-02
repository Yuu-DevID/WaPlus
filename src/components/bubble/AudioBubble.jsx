// src/components/bubble/AudioBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Audio/PTT player bubble dengan animated waveform.
// Handles: audioMessage, pttMessage (voice note)
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { useMediaSrc, fmtTime, SPEED_STEPS } from "./utils"
import { HiMicrophone, HiMusicalNote, HiExclamationTriangle, PlayIcon, PauseIcon } from "./icons"

// ── Shared audio registry — ensures only one audio plays at a time ──────────
const _audioRegistry = { current: null }
const _waveformCache = new Map()

/** Generate deterministic waveform heights from msgId (seeded LCG) */
function seedWaveform(id, bars = 40) {
  if (_waveformCache.has(id)) return _waveformCache.get(id)
  const str = id || "x"
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  const heights = []
  for (let i = 0; i < bars; i++) {
    h = (Math.imul(1664525, h) + 1013904223) | 0
    const pos = i / bars
    const envelope = 1 - Math.pow((pos - 0.5) * 2, 4)
    const raw = (h >>> 0) / 0xFFFFFFFF
    heights.push(0.12 + raw * 0.88 * envelope)
  }
  _waveformCache.set(id, heights)
  return heights
}

export default function AudioBubble({ msg }) {
  const { src } = useMediaSrc(msg)
  const isPtt = !!(msg.is_ptt === 1 || msg.is_ptt === true || msg.msg_type === "pttMessage")
  const msgId = msg.id || msg.message_id || ""
  const waveform = useMemo(() => seedWaveform(msgId), [msgId])

  const audioRef = useRef(null)
  const [playing, setPlaying]     = useState(false)
  const [progress, setProgress]   = useState(0)
  const [elapsed, setElapsed]     = useState(0)
  const [duration, setDuration]   = useState(msg.media_duration || msg.duration || 0)
  const [speedIdx, setSpeedIdx]   = useState(0)
  const [loadState, setLoadState] = useState("idle")
  const scrubRef = useRef(null)
  const rafRef   = useRef(null)
  const speed = SPEED_STEPS[speedIdx]

  useEffect(() => {
    if (!src) return
    const audio = new Audio()
    audio.preload = "metadata"
    audio.src = src
    audioRef.current = audio
    setLoadState("loading")

    const onMeta  = () => { setDuration(audio.duration); setLoadState("ready") }
    const onError = () => setLoadState("error")
    const onEnded = () => {
      setPlaying(false); setProgress(0); setElapsed(0)
      audio.currentTime = 0
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    audio.addEventListener("loadedmetadata", onMeta)
    audio.addEventListener("error", onError)
    audio.addEventListener("ended", onEnded)

    return () => {
      if (_audioRegistry.current === audio) _audioRegistry.current = null
      audio.pause()
      audio.removeEventListener("loadedmetadata", onMeta)
      audio.removeEventListener("error", onError)
      audio.removeEventListener("ended", onEnded)
      audio.src = ""
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [src])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  const startRaf = useCallback(() => {
    const tick = () => {
      const a = audioRef.current
      if (!a) return
      setProgress(a.currentTime / (a.duration || 1))
      setElapsed(a.currentTime)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || loadState === "error") return
    // Stop any other playing audio
    if (_audioRegistry.current && _audioRegistry.current !== audio) {
      _audioRegistry.current.pause()
      _audioRegistry.current._setPlaying?.(false)
      _audioRegistry.current._stopRaf?.()
    }
    _audioRegistry.current = audio
    audio._setPlaying = setPlaying
    audio._stopRaf = stopRaf

    if (playing) {
      audio.pause(); stopRaf(); setPlaying(false)
    } else {
      audio.playbackRate = speed
      audio.play()
        .then(() => { setPlaying(true); startRaf() })
        .catch(() => setLoadState("error"))
    }
  }, [playing, loadState, speed, startRaf, stopRaf])

  const handleScrub = useCallback(e => {
    const audio = audioRef.current
    if (!audio?.duration) return
    const bar = scrubRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = frac * audio.duration
    setProgress(frac)
    setElapsed(audio.currentTime)
  }, [])

  const cycleSpeed = useCallback(e => {
    e.stopPropagation()
    setSpeedIdx(i => (i + 1) % SPEED_STEPS.length)
  }, [])

  const isLoading = !src || loadState === "loading" || loadState === "idle"
  const isError   = loadState === "error"
  const displayDur = duration ? fmtTime(playing ? elapsed : duration) : fmtTime(elapsed || 0)

  return (
    <div className={`audio-player${playing ? " audio-playing" : ""}${isError ? " audio-error" : ""}`}>
      <button className="audio-btn-play" onClick={togglePlay} disabled={isError}
        aria-label={playing ? "Jeda" : "Putar"}
        title={isLoading ? "Mengunduh..." : isError ? "Gagal memuat audio" : playing ? "Jeda" : "Putar"}>
        {isLoading ? <div className="audio-spinner" /> : isError ? <HiExclamationTriangle size={14} /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <div className="audio-track-area">
        <div ref={scrubRef} className="audio-waveform" onClick={handleScrub}
          role="slider" aria-label="Posisi audio"
          aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          {waveform.map((h, i) => {
            const barProgress = i / waveform.length
            const filled  = barProgress <= progress
            const isActive = Math.abs(barProgress - progress) < 0.04
            return (
              <div key={i} className="audio-bar-seg" style={{
                height: `${Math.round(h * 100)}%`,
                background: filled ? (isActive ? "var(--green)" : "var(--green-dim)") : "rgba(255,255,255,0.12)",
                transform: isActive && playing ? "scaleY(1.3)" : "scaleY(1)",
              }} />
            )
          })}
        </div>

        <div className="audio-info-row">
          <span className="audio-type-badge">
            {isPtt ? <HiMicrophone size={13} /> : <HiMusicalNote size={13} />}
            <span>{isPtt ? "Pesan Suara" : "Audio"}</span>
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="audio-time">{displayDur}</span>
            {!isLoading && !isError && (
              <button className="audio-speed-btn" onClick={cycleSpeed}
                title="Ubah kecepatan" aria-label={`Kecepatan ${speed}x`}>
                {speed}×
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}