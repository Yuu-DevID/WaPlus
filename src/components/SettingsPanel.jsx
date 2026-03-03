// src/components/SettingsPanel.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Settings panel — accessible from Sidebar settings button.
// Features: Auto Download Media toggle, RAM limit slider (32–512MB).
// Persists to electron userData/wplus_settings.json via IPC.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback } from "react"
import { useAppStore } from "../store/app"

// ── Toggle Switch ─────────────────────────────────────────────────────────
function Toggle({ enabled, onChange, label, description }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 0", borderBottom: "1px solid var(--border)",
    }}>
      <div style={{ flex: 1, marginRight: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>{description}</div>
        )}
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        style={{
          flexShrink: 0,
          width: 40, height: 22, borderRadius: 11,
          background: enabled ? "var(--green)" : "rgba(255,255,255,0.15)",
          border: "none", cursor: "pointer",
          position: "relative", transition: "background 0.2s",
          outline: "none",
        }}
      >
        <div style={{
          position: "absolute", top: 3,
          left: enabled ? 21 : 3,
          width: 16, height: 16, borderRadius: "50%",
          background: "#fff",
          transition: "left 0.18s",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        }} />
      </button>
    </div>
  )
}

// ── Section Header ─────────────────────────────────────────────────────────
function SectionHeader({ label }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: "var(--green)",
      textTransform: "uppercase", letterSpacing: 0.8,
      marginTop: 16, marginBottom: 6,
    }}>
      {label}
    </div>
  )
}

// ── RAM Slider ─────────────────────────────────────────────────────────────
const RAM_STEPS = [32, 64, 128, 256, 384, 512]

function RamSlider({ value, onChange }) {
  const idx = RAM_STEPS.indexOf(value) !== -1 ? RAM_STEPS.indexOf(value) : 3
  const [localIdx, setLocalIdx] = useState(idx)
  const [showRestart, setShowRestart] = useState(false)

  const handleChange = useCallback((e) => {
    const i = parseInt(e.target.value, 10)
    setLocalIdx(i)
    onChange(RAM_STEPS[i])
    setShowRestart(RAM_STEPS[i] !== value)
  }, [onChange, value])

  const mb = RAM_STEPS[localIdx]
  const pct = (localIdx / (RAM_STEPS.length - 1)) * 100

  // Color: green for low, yellow for mid, orange for high
  const trackColor = mb <= 128
    ? "var(--green)"
    : mb <= 256
      ? "#f0b429"
      : "#f97316"

  return (
    <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>
            Batas Penggunaan RAM
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
            Kurangi untuk hemat memori, naikkan jika sering lag
          </div>
        </div>
        <div style={{
          fontSize: 13, fontWeight: 700, color: trackColor,
          background: "rgba(255,255,255,0.06)", borderRadius: 6,
          padding: "2px 10px", minWidth: 58, textAlign: "center",
        }}>
          {mb} MB
        </div>
      </div>

      {/* Slider */}
      <div style={{ position: "relative", height: 28, display: "flex", alignItems: "center" }}>
        <div style={{
          position: "absolute", left: 0, right: 0, height: 4,
          borderRadius: 2, background: "rgba(255,255,255,0.12)", overflow: "hidden",
        }}>
          <div style={{
            height: "100%", width: `${pct}%`,
            background: trackColor, borderRadius: 2,
            transition: "width 0.1s, background 0.2s",
          }} />
        </div>
        <input
          type="range"
          min={0} max={RAM_STEPS.length - 1}
          value={localIdx}
          onChange={handleChange}
          style={{
            position: "relative", width: "100%", height: 28,
            WebkitAppearance: "none", background: "transparent", cursor: "pointer",
            outline: "none", zIndex: 1,
          }}
        />
      </div>

      {/* Step labels */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        marginTop: 2, paddingX: 2,
      }}>
        {RAM_STEPS.map((s) => (
          <span key={s} style={{
            fontSize: 9, color: s === mb ? trackColor : "var(--text-3)",
            fontWeight: s === mb ? 700 : 400, transition: "color 0.15s",
          }}>
            {s}
          </span>
        ))}
      </div>

      {/* Restart notice */}
      {showRestart && (
        <div style={{
          marginTop: 8, padding: "6px 10px", borderRadius: 7,
          background: "rgba(249,115,22,0.12)", border: "1px solid rgba(249,115,22,0.25)",
          fontSize: 11, color: "#f97316", display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>⚠</span>
          <span>Perlu restart aplikasi untuk efek berlaku</span>
        </div>
      )}

      <style>{`
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px; height: 16px; border-radius: 50%;
          background: ${trackColor}; border: 2px solid rgba(255,255,255,0.3);
          box-shadow: 0 1px 6px rgba(0,0,0,0.4);
          cursor: pointer; transition: background 0.2s;
        }
        input[type=range]::-webkit-slider-thumb:hover {
          transform: scale(1.15);
        }
      `}</style>
    </div>
  )
}

// ── Main Settings Panel ────────────────────────────────────────────────────
export default function SettingsPanel({ onClose }) {
  const { autoDownloadMedia, setAutoDownloadMedia, ramLimitMb, setRamLimitMb } = useAppStore()

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9998,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.() }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div style={{
        width: 400, borderRadius: 14,
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        overflow: "hidden",
        maxHeight: "85vh", display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 0 1 21.64 12a10 10 0 0 1-2.57 7.07m-2.12-14.14A7 7 0 0 1 19 12a7 7 0 0 1-2.05 4.95M7.05 7.05A7 7 0 0 0 5 12a7 7 0 0 0 2.05 4.95M4.93 4.93A10 10 0 0 0 2.36 12a10 10 0 0 0 2.57 7.07"/>
            </svg>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-1)" }}>Pengaturan</div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: 8,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-3)", cursor: "pointer", fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >✕</button>
        </div>

        {/* Scrollable Body */}
        <div style={{ padding: "4px 20px 20px", overflowY: "auto" }}>

          {/* ── Section: Media ──────────────────────────────────────── */}
          <SectionHeader label="Media" />

          <Toggle
            enabled={autoDownloadMedia}
            onChange={setAutoDownloadMedia}
            label="Unduh Media Otomatis"
            description="Jika dimatikan, foto & video harus diklik manual untuk diunduh"
          />

          {!autoDownloadMedia && (
            <div style={{
              marginTop: 8, marginBottom: 2, padding: "7px 12px", borderRadius: 8,
              background: "rgba(37,211,102,0.07)", border: "1px solid rgba(37,211,102,0.18)",
              fontSize: 11, color: "var(--text-3)", lineHeight: 1.5,
            }}>
              💡 Klik pada gambar/video di gelembung pesan untuk mengunduh secara manual.
            </div>
          )}

          {/* ── Section: Performa ───────────────────────────────────── */}
          <SectionHeader label="Performa" />

          <RamSlider
            value={ramLimitMb || 256}
            onChange={setRamLimitMb}
          />

          {/* RAM usage tips */}
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 8,
            background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)",
            fontSize: 11, color: "var(--text-3)", lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, color: "var(--text-2)", marginBottom: 3 }}>Tips Performa:</div>
            <div>• <strong>32–128 MB</strong>: Hemat RAM, cocok PC lama</div>
            <div>• <strong>256 MB</strong>: Default, seimbang untuk kebanyakan PC</div>
            <div>• <strong>384–512 MB</strong>: Lebih lancar untuk chat ramai & banyak media</div>
          </div>

        </div>
      </div>
    </div>
  )
}
