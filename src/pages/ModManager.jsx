// src/pages/ModManager.jsx
// ╔══════════════════════════════════════════════════════════════╗
// ║              WaPlus — Mod / Plugin Manager UI  v2           ║
// ╚══════════════════════════════════════════════════════════════╝
// NEW in v2:
// [N-1] Create Plugin: ID auto-generate dari nama (lowercase, slugified)
// [N-2] Create Plugin: Dropdown/checklist hooks yang mau di-include + deskripsi tiap hook
// [N-3] Settings Modal: Tombol + tambah custom field sendiri (key, label, type, default)
// [N-4] Plugin Card: Tombol hapus (trash) dengan confirm dialog Yes/No
// [N-5] Settings Modal: Lebih banyak tipe field (json, textarea, color, range)

import { useState, useEffect, useCallback } from "react"
import PluginDocs from "../components/PluginDocs"

const Icon = ({ d, size = 18, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    className={className}>
    <path d={d} />
  </svg>
)

const ICONS = {
  plug:     "M18 6L6 18M8 6l-2 2 5 5-1 1-5-5-2 2 7 7 2-2-1-1 5-5 1 1-2 2 7 7 2-2-5-5 2-2z",
  refresh:  "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  folder:   "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  plus:     "M12 5v14M5 12h14",
  x:        "M18 6L6 18M6 6l12 12",
  code:     "M16 18l6-6-6-6M8 6l-6 6 6 6",
  info:     "M12 8h.01M12 12v4m0 4a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  image:    "M21 15l-5-5L5 21M3 3h18v18H3zM8.5 8.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  zap:      "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  save:     "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8",
  trash:    "M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  check:    "M20 6L9 17l-5-5",
}

// ── Hook definitions with descriptions ─────────────────────
const HOOK_DEFS = [
  {
    id: "onLoad",
    label: "onLoad",
    emoji: "🚀",
    desc: "Dipanggil saat plugin diaktifkan / WaPlus start. Gunakan untuk init state, jadwal, atau koneksi.",
    color: "#3fb950",
  },
  {
    id: "onUnload",
    label: "onUnload",
    emoji: "🛑",
    desc: "Dipanggil saat plugin dinonaktifkan. Gunakan untuk cleanup interval, koneksi, atau resource.",
    color: "#f78166",
  },
  {
    id: "onMessage",
    label: "onMessage",
    emoji: "💬",
    desc: "Setiap pesan masuk/keluar. Bisa modifikasi atau blokir pesan dengan return false.",
    color: "#79c0ff",
  },
  {
    id: "onBeforeSend",
    label: "onBeforeSend",
    emoji: "📤",
    desc: "Sebelum pesan dikirim. Bisa tambah metadata, inject contextInfo, atau batalkan pengiriman.",
    color: "#ffa657",
  },
  {
    id: "onAfterSend",
    label: "onAfterSend",
    emoji: "✅",
    desc: "Setelah pesan terkirim sukses. Gunakan untuk logging, analytics, atau trigger aksi lanjutan.",
    color: "#56d364",
  },
  {
    id: "onConnect",
    label: "onConnect",
    emoji: "🔗",
    desc: "Saat WhatsApp berhasil terhubung. Terima info: { name, jid, phone }.",
    color: "#a5d6ff",
  },
  {
    id: "onDisconnect",
    label: "onDisconnect",
    emoji: "⚡",
    desc: "Saat koneksi WhatsApp terputus. Terima reason (string): logout, connection-closed, dll.",
    color: "#ffb74d",
  },
  {
    id: "onConfigChange",
    label: "onConfigChange",
    emoji: "⚙️",
    desc: "Saat settings plugin disimpan dari UI. Terima newValues (object) — semua nilai config terbaru.",
    color: "#d2a8ff",
  },
]

function PluginIcon({ hooks = [] }) {
  const hasMsg  = hooks.includes("onMessage")
  const hasConn = hooks.includes("onConnect")
  const hasSend = hooks.includes("onBeforeSend")
  return (
    <div className="plugin-icon">
      {hasMsg  && <span title="onMessage">💬</span>}
      {hasConn && <span title="onConnect">🔗</span>}
      {hasSend && <span title="onBeforeSend">📤</span>}
      {!hasMsg && !hasConn && !hasSend && <span>🧩</span>}
    </div>
  )
}

function Toggle({ enabled, onChange, disabled }) {
  return (
    <button
      className={`toggle ${enabled ? "toggle--on" : "toggle--off"} ${disabled ? "toggle--disabled" : ""}`}
      onClick={() => !disabled && onChange(!enabled)}
      title={enabled ? "Nonaktifkan" : "Aktifkan"}
    >
      <span className="toggle__thumb" />
    </button>
  )
}

// ── Settings Field ─────────────────────────────────────────
function SettingsField({ field, value, onChange, onRemove }) {
  const handleImage = async () => {
    const res = await window.api.modsPickImage()
    if (res.ok) onChange(res.dataUrl)
  }

  const isCustom = !!field._custom

  const removeBtn = isCustom && onRemove ? (
    <button onClick={onRemove} className="field-remove-btn" title="Hapus field ini">
      <Icon d={ICONS.trash} size={12} />
    </button>
  ) : null

  if (field.type === "boolean") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key}</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle enabled={!!value} onChange={onChange} />
            {removeBtn}
          </div>
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
      </div>
    )
  }

  if (field.type === "select") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key}</label>
          {removeBtn}
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
        <select className="mod-input" value={value ?? field.default}
          onChange={e => onChange(e.target.value)}>
          {(field.options || []).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === "image") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key}</label>
          {removeBtn}
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
        <div className="image-field">
          {value && (
            <div className="image-preview">
              <img src={value} alt="thumbnail" />
              <button className="image-clear" onClick={() => onChange("")}>✕</button>
            </div>
          )}
          <div className="image-actions">
            <button className="btn-secondary btn-sm" onClick={handleImage}>
              <Icon d={ICONS.image} size={14} /> Upload
            </button>
            <span className="image-or">atau</span>
            <input className="mod-input" style={{ flex: 1 }}
              placeholder="Paste URL..." value={value?.startsWith("data:") ? "" : (value || "")}
              onChange={e => onChange(e.target.value)} />
          </div>
        </div>
      </div>
    )
  }

  if (field.type === "number" || field.type === "range") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key}</label>
          {removeBtn}
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
        {field.type === "range" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input type="range" min={field.min ?? 0} max={field.max ?? 100} step={field.step ?? 1}
              value={value ?? field.default ?? 50}
              onChange={e => onChange(Number(e.target.value))}
              style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: "#e6edf3", minWidth: 32, textAlign: "right" }}>
              {value ?? field.default ?? 50}
            </span>
          </div>
        ) : (
          <input className="mod-input" type="number" min={field.min} max={field.max}
            value={value ?? field.default ?? ""}
            onChange={e => onChange(field.nullable && e.target.value === "" ? null : Number(e.target.value))} />
        )}
      </div>
    )
  }

  if (field.type === "textarea") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key}</label>
          {removeBtn}
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
        <textarea className="mod-input mod-textarea" rows={4}
          value={value ?? field.default ?? ""}
          placeholder={field.placeholder || ""}
          onChange={e => onChange(e.target.value)} />
      </div>
    )
  }

  if (field.type === "json") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key} <span className="hint">JSON</span></label>
          {removeBtn}
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
        <textarea className="mod-input mod-textarea mod-json" rows={5}
          value={typeof value === "object" ? JSON.stringify(value, null, 2) : (value ?? "")}
          placeholder='{"key": "value"}'
          onChange={e => {
            try { onChange(JSON.parse(e.target.value)) }
            catch { onChange(e.target.value) }
          }} />
      </div>
    )
  }

  if (field.type === "color") {
    return (
      <div className="settings-field">
        <div className="settings-field__head">
          <label className="settings-label">{field.label || field.key}</label>
          {removeBtn}
        </div>
        {field.description && <p className="settings-desc">{field.description}</p>}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="color" value={value || field.default || "#ffffff"}
            onChange={e => onChange(e.target.value)}
            style={{ width: 44, height: 36, borderRadius: 6, border: "1px solid #30363d", cursor: "pointer", background: "none" }} />
          <input className="mod-input" style={{ flex: 1 }}
            value={value || field.default || ""}
            onChange={e => onChange(e.target.value)}
            placeholder="#ffffff" />
        </div>
      </div>
    )
  }

  // text / url / password
  return (
    <div className="settings-field">
      <div className="settings-field__head">
        <label className="settings-label">{field.label || field.key}</label>
        {removeBtn}
      </div>
      {field.description && <p className="settings-desc">{field.description}</p>}
      <input className="mod-input"
        type={field.type === "url" ? "url" : field.type === "password" ? "password" : "text"}
        value={value ?? field.default ?? ""}
        placeholder={field.placeholder || ""}
        onChange={e => onChange(e.target.value)} />
    </div>
  )
}

// ── Add Custom Field Dialog ─────────────────────────────────
const CUSTOM_FIELD_TYPES = [
  { value: "text",     label: "Teks" },
  { value: "number",   label: "Angka" },
  { value: "boolean",  label: "Toggle (Ya/Tidak)" },
  { value: "textarea", label: "Teks Panjang" },
  { value: "url",      label: "URL" },
  { value: "password", label: "Password" },
  { value: "color",    label: "Warna" },
  { value: "range",    label: "Slider (Range)" },
  { value: "json",     label: "JSON Object" },
  { value: "image",    label: "Gambar" },
  { value: "select",   label: "Pilihan (Select)" },
]

function AddCustomFieldModal({ onClose, onAdd }) {
  const [key,     setKey]     = useState("")
  const [label,   setLabel]   = useState("")
  const [type,    setType]    = useState("text")
  const [defVal,  setDefVal]  = useState("")
  const [desc,    setDesc]    = useState("")
  const [options, setOptions] = useState("Opsi A, Opsi B")
  const [min,     setMin]     = useState(0)
  const [max,     setMax]     = useState(100)
  const [error,   setError]   = useState("")

  const slugify = (str) => str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")

  const handleLabelChange = (v) => {
    setLabel(v)
    if (!key) setKey(slugify(v))
  }

  const handle = () => {
    if (!key.trim() || !label.trim()) return setError("Key dan Label wajib diisi")
    const field = {
      key: slugify(key) || key,
      label,
      type,
      description: desc || undefined,
      _custom: true,
    }
    if (type === "number" || type === "range") {
      field.min = Number(min)
      field.max = Number(max)
      field.default = Number(defVal) || 0
    } else if (type === "boolean") {
      field.default = defVal === "true" || defVal === true
    } else if (type === "select") {
      field.options = options.split(",").map((s, i) => ({
        value: String(i), label: s.trim()
      }))
      field.default = "0"
    } else {
      field.default = defVal || undefined
    }
    onAdd(field)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal__header">
          <span style={{ fontSize: 16, fontWeight: 600 }}>➕ Tambah Custom Field</span>
          <button className="modal__close" onClick={onClose}><Icon d={ICONS.x} size={18} /></button>
        </div>
        <div className="modal__body">
          <div className="settings-field">
            <label className="settings-label">Tipe Field</label>
            <select className="mod-input" value={type} onChange={e => setType(e.target.value)}>
              {CUSTOM_FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">Label (tampil di UI)</label>
            <input className="mod-input" value={label} onChange={e => handleLabelChange(e.target.value)} placeholder="Nama Field" />
          </div>
          <div className="settings-field">
            <label className="settings-label">Key <span className="hint">(nama variabel di config)</span></label>
            <input className="mod-input" value={key} onChange={e => setKey(slugify(e.target.value))} placeholder="nama_field" />
          </div>
          <div className="settings-field">
            <label className="settings-label">Deskripsi <span className="hint">(opsional)</span></label>
            <input className="mod-input" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Jelaskan fungsi field ini..." />
          </div>
          {type === "select" && (
            <div className="settings-field">
              <label className="settings-label">Opsi <span className="hint">(pisah dengan koma)</span></label>
              <input className="mod-input" value={options} onChange={e => setOptions(e.target.value)} placeholder="Opsi A, Opsi B, Opsi C" />
            </div>
          )}
          {(type === "number" || type === "range") && (
            <div style={{ display: "flex", gap: 10 }}>
              <div className="settings-field" style={{ flex: 1 }}>
                <label className="settings-label">Min</label>
                <input className="mod-input" type="number" value={min} onChange={e => setMin(e.target.value)} />
              </div>
              <div className="settings-field" style={{ flex: 1 }}>
                <label className="settings-label">Max</label>
                <input className="mod-input" type="number" value={max} onChange={e => setMax(e.target.value)} />
              </div>
            </div>
          )}
          {type !== "image" && type !== "select" && (
            <div className="settings-field">
              <label className="settings-label">Default Value <span className="hint">(opsional)</span></label>
              <input className="mod-input" value={defVal}
                onChange={e => setDefVal(e.target.value)}
                placeholder={type === "boolean" ? "true / false" : "Nilai default..."} />
            </div>
          )}
          {error && <div className="modal__error">{error}</div>}
        </div>
        <div className="modal__footer">
          <button className="btn-secondary" onClick={onClose}>Batal</button>
          <button className="btn-primary" onClick={handle}>
            <Icon d={ICONS.plus} size={14} /> Tambah Field
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Plugin Settings Modal ────────────────────────────────────
function SettingsModal({ plugin, onClose, onSaved }) {
  const [tab,          setTab]         = useState("settings") // "settings" | "hooks"
  const [schema,       setSchema]      = useState([])
  const [values,       setValues]      = useState({})
  const [customFields, setCustomFields] = useState([])
  const [loading,      setLoading]     = useState(true)
  const [saving,       setSaving]      = useState(false)
  const [saved,        setSaved]       = useState(false)
  const [showAddField, setShowAddField] = useState(false)
  // Hooks tab state
  const [activeHooks,  setActiveHooks]  = useState([])
  const [hookSaving,   setHookSaving]   = useState(false)
  const [hookSaved,    setHookSaved]    = useState(false)

  useEffect(() => {
    window.api.modsGetConfig({ id: plugin.id }).then(res => {
      if (res.ok) {
        setSchema(res.data.schema)
        const cf = Array.isArray(res.data.values?._customFields) ? res.data.values._customFields : []
        setCustomFields(cf)
        const vals = { ...res.data.values }
        delete vals._customFields
        setValues(vals)
      }
      setLoading(false)
    })
    // Init active hooks from current plugin hooks (from exported functions)
    setActiveHooks(plugin.hooks || [])
  }, [plugin.id])

  const handleChange = (key, val) => {
    setValues(prev => ({ ...prev, [key]: val }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    const toSave = { ...values, _customFields: customFields }
    const res = await window.api.modsSaveConfig({ id: plugin.id, values: toSave })
    setSaving(false)
    if (res?.ok !== false) {
      setSaved(true)
      onSaved?.()
      setTimeout(() => setSaved(false), 2500)
    }
  }

  const addCustomField = (field) => {
    setCustomFields(prev => [...prev, field])
    setSaved(false)
  }

  const removeCustomField = (cfIdx) => {
    setCustomFields(prev => prev.filter((_, i) => i !== cfIdx))
    setSaved(false)
  }

  const toggleHook = (hookId) => {
    setActiveHooks(prev =>
      prev.includes(hookId) ? prev.filter(h => h !== hookId) : [...prev, hookId]
    )
    setHookSaved(false)
  }

  const handleSaveHooks = async () => {
    if (activeHooks.length === 0) return
    setHookSaving(true)
    const res = await window.api.modsUpdateHooks({ id: plugin.id, hooks: activeHooks })
    setHookSaving(false)
    if (res?.ok) {
      setHookSaved(true)
      onSaved?.()
      setTimeout(() => setHookSaved(false), 2500)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--settings">
        <div className="modal__header">
          <div className="modal__header-left">
            <span className="modal__emoji">⚙️</span>
            <div>
              <div className="modal__title">{plugin.name}</div>
              <div className="modal__subtitle">v{plugin.version} · by {plugin.author}</div>
            </div>
          </div>
          <button className="modal__close" onClick={onClose}><Icon d={ICONS.x} size={18} /></button>
        </div>

        {/* Tab switcher */}
        <div className="settings-tabs">
          <button
            className={"settings-tab" + (tab === "settings" ? " settings-tab--active" : "")}
            onClick={() => setTab("settings")}
          >
            <Icon d={ICONS.settings} size={13} /> Settings
          </button>
          <button
            className={"settings-tab" + (tab === "hooks" ? " settings-tab--active" : "")}
            onClick={() => setTab("hooks")}
          >
            ⚡ Hooks
          </button>
          <button
            className={"settings-tab" + (tab === "docs" ? " settings-tab--active" : "")}
            onClick={() => setTab("docs")}
            title="Plugin Context API Documentation"
          >
            📖 Docs
          </button>
        </div>

        <div className="modal__body">
          {loading ? (
            <div className="mod-loading">Memuat...</div>
          ) : tab === "docs" ? (
            /* ── Docs tab — Plugin Context API reference ── */
            <PluginDocs inline />
          ) : tab === "settings" ? (
            <>
              {schema.length === 0 && customFields.length === 0 && (
                <div className="mod-empty-settings">
                  <div style={{ fontSize: 32 }}>🔧</div>
                  <div>Plugin ini belum punya settings.</div>
                  <div style={{ fontSize: 12, color: "#6e7681" }}>Tambah custom field di bawah.</div>
                </div>
              )}
              {schema.map((field, idx) => (
                <SettingsField
                  key={field.key + "_schema_" + idx}
                  field={field}
                  value={values[field.key]}
                  onChange={val => handleChange(field.key, val)}
                />
              ))}
              {customFields.map((field, cfIdx) => (
                <SettingsField
                  key={field.key + "_custom_" + cfIdx}
                  field={field}
                  value={values[field.key]}
                  onChange={val => handleChange(field.key, val)}
                  onRemove={() => removeCustomField(cfIdx)}
                />
              ))}
              <button className="add-field-btn" onClick={() => setShowAddField(true)}>
                <Icon d={ICONS.plus} size={14} /> Tambah Custom Field
              </button>
            </>
          ) : (
            /* ── Hooks tab ── */
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p className="settings-desc" style={{ margin: 0 }}>
                Centang hook yang aktif. Klik <strong style={{ color: "#e6edf3" }}>Simpan Hooks</strong> untuk apply — 
                ini akan mengedit <code style={{ background: "#21262d", padding: "1px 5px", borderRadius: 4, color: "#d2a8ff", fontSize: 11 }}>index.js</code> plugin dan hot-reload otomatis.
                Kode hook yang sudah ada akan dipertahankan, hook baru mendapat template kosong.
              </p>
              <div className="hooks-grid">
                {HOOK_DEFS.map(hook => {
                  const active = activeHooks.includes(hook.id)
                  return (
                    <div
                      key={hook.id}
                      className={"hook-card" + (active ? " hook-card--active" : "")}
                      onClick={() => toggleHook(hook.id)}
                    >
                      <div className="hook-card__top">
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span>{hook.emoji}</span>
                          <code className="hook-card__name">{hook.id}</code>
                        </div>
                        <div className={"hook-card__check" + (active ? " hook-card__check--on" : "")}>
                          {active && <Icon d={ICONS.check} size={10} />}
                        </div>
                      </div>
                      <div className="hook-card__desc">{hook.desc}</div>
                    </div>
                  )
                })}
              </div>
              {activeHooks.length === 0 && (
                <div style={{ fontSize: 12, color: "#f78166", background: "#2a1a1a", padding: "8px 12px", borderRadius: 6 }}>
                  ⚠️ Minimal 1 hook harus aktif
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal__footer">
          <button className="btn-secondary" onClick={onClose}>Tutup</button>
          {tab === "docs" ? null : tab === "settings" ? (
            <button
              className={"btn-primary" + (saved ? " btn-saved" : "")}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Menyimpan..." : saved
                ? <><Icon d={ICONS.check} size={14} /> Tersimpan!</>
                : <><Icon d={ICONS.save} size={14} /> Simpan</>
              }
            </button>
          ) : (
            <button
              className={"btn-primary" + (hookSaved ? " btn-saved" : "")}
              onClick={handleSaveHooks}
              disabled={hookSaving || activeHooks.length === 0}
            >
              {hookSaving ? "Menyimpan..." : hookSaved
                ? <><Icon d={ICONS.check} size={14} /> Tersimpan!</>
                : <><Icon d={ICONS.save} size={14} /> Simpan Hooks</>
              }
            </button>
          )}
        </div>
      </div>

      {showAddField && (
        <AddCustomFieldModal
          onClose={() => setShowAddField(false)}
          onAdd={addCustomField}
        />
      )}
    </div>
  )
}

// ── Delete Confirm Modal ─────────────────────────────────────
function DeleteConfirmModal({ plugin, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false)

  const handle = async () => {
    setDeleting(true)
    await onConfirm(plugin.id)
    setDeleting(false)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal__header" style={{ borderColor: "#3a1a1a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🗑️</span>
            <div>
              <div className="modal__title" style={{ color: "#f78166" }}>Hapus Plugin</div>
              <div className="modal__subtitle">Tindakan ini tidak bisa dibatalkan</div>
            </div>
          </div>
          <button className="modal__close" onClick={onClose}><Icon d={ICONS.x} size={18} /></button>
        </div>
        <div className="modal__body">
          <div style={{
            background: "#2a1a1a", border: "1px solid #3a2020",
            borderRadius: 10, padding: "16px 18px",
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e6edf3", marginBottom: 8 }}>
              Hapus "{plugin.name}"?
            </div>
            <div style={{ fontSize: 13, color: "#8b949e", lineHeight: 1.6 }}>
              Folder plugin <code style={{ background: "#161b22", padding: "1px 5px", borderRadius: 4, color: "#d2a8ff", fontSize: 12 }}>
                electron/mods/plugins/{plugin.id}/
              </code> akan dihapus permanen beserta semua file di dalamnya.
            </div>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn-secondary" onClick={onClose} disabled={deleting}>
            Batal
          </button>
          <button
            onClick={handle}
            disabled={deleting}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 16px", background: "#da3633", color: "white",
              border: "none", borderRadius: 8, cursor: "pointer",
              fontSize: 13, fontWeight: 600, opacity: deleting ? 0.6 : 1,
            }}
          >
            <Icon d={ICONS.trash} size={14} />
            {deleting ? "Menghapus..." : "Ya, Hapus Plugin"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Plugin Card ───────────────────────────────────────────────
function PluginCard({ plugin, onToggle, onSettings, onSource, onOpenFolder, onDelete, selectable, selected, onSelect }) {
  const [loading, setLoading] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleToggle = async (enabled) => {
    setLoading(true)
    await onToggle(plugin.id, enabled)
    setLoading(false)
  }

  return (
    <>
      <div
        className={`plugin-card ${plugin.enabled ? "plugin-card--on" : "plugin-card--off"} ${plugin.error ? "plugin-card--error" : ""} ${selected ? "plugin-card--selected" : ""}`}
        onClick={selectable ? () => onSelect?.(plugin.id) : undefined}
        style={selectable ? { cursor: "pointer", userSelect: "none" } : {}}
      >
        {selectable && (
          <div className={`plugin-card__checkbox ${selected ? "plugin-card__checkbox--on" : ""}`}>
            {selected ? <Icon d={ICONS.check} size={11} /> : null}
          </div>
        )}
        <div className="plugin-card__header">
          <PluginIcon hooks={plugin.hooks} />
          <div className="plugin-card__info">
            <div className="plugin-card__name">{plugin.name}</div>
            <div className="plugin-card__meta">v{plugin.version} · by {plugin.author}</div>
          </div>
          {!selectable && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Toggle enabled={plugin.enabled} onChange={handleToggle} disabled={loading || !!plugin.error} />
              <button
                className="btn-trash"
                onClick={e => { e.stopPropagation(); setShowDeleteConfirm(true) }}
                title="Hapus plugin"
              >
                <Icon d={ICONS.trash} size={13} />
              </button>
            </div>
          )}
        </div>

        {plugin.description && (
          <div className="plugin-card__desc">{plugin.description}</div>
        )}

        {plugin.error && (
          <div className="plugin-card__error">
            <Icon d={ICONS.info} size={14} /> {plugin.error}
          </div>
        )}

        {plugin.hooks?.length > 0 && (
          <div className="plugin-card__hooks">
            {plugin.hooks.map(h => (
              <span key={h} className="hook-badge">{h}</span>
            ))}
          </div>
        )}

        {!selectable && (
          <div className="plugin-card__actions">
            <button className="btn-icon btn-settings" onClick={() => onSettings(plugin)} title="Konfigurasi">
              <Icon d={ICONS.settings} size={14} /> Settings
            </button>
            <button className="btn-icon" onClick={() => onSource(plugin.id)} title="Source code">
              <Icon d={ICONS.code} size={14} /> Source
            </button>
            <button className="btn-icon" onClick={() => onOpenFolder(plugin.id)} title="Buka folder">
              <Icon d={ICONS.folder} size={14} /> Folder
            </button>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <DeleteConfirmModal
          plugin={plugin}
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={onDelete}
        />
      )}
    </>
  )
}

// ── Create Plugin Modal ──────────────────────────────────────
function CreateModal({ onClose, onCreate }) {
  const [name,         setName]         = useState("")
  const [id,           setId]           = useState("")
  const [desc,         setDesc]         = useState("")
  const [selectedHooks, setSelectedHooks] = useState(["onLoad", "onUnload", "onMessage"])
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState("")

  // [N-1] Auto-generate ID dari nama
  const slugify = (str) => str.toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")

  const handleNameChange = (v) => {
    setName(v)
    setId(slugify(v))
  }

  const toggleHook = (hookId) => {
    setSelectedHooks(prev =>
      prev.includes(hookId)
        ? prev.filter(h => h !== hookId)
        : [...prev, hookId]
    )
  }

  const handle = async () => {
    if (!id.trim() || !name.trim()) return setError("ID dan nama wajib diisi")
    if (selectedHooks.length === 0) return setError("Pilih minimal 1 hook")
    setLoading(true)
    setError("")
    const res = await window.api.modsCreate({
      id: id.trim(), name: name.trim(),
      description: desc.trim(), hooks: selectedHooks,
    })
    setLoading(false)
    if (res.ok) { onCreate(); onClose() }
    else setError(res.error || "Gagal membuat plugin")
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal__header">
          <span style={{ fontSize: 15, fontWeight: 700 }}>🧩 Buat Plugin Baru</span>
          <button className="modal__close" onClick={onClose}><Icon d={ICONS.x} size={18} /></button>
        </div>

        <div className="modal__body">
          {/* Nama */}
          <div className="settings-field">
            <label className="settings-label">Nama Plugin</label>
            <input className="mod-input" value={name}
              onChange={e => handleNameChange(e.target.value)}
              placeholder="My Awesome Plugin" autoFocus />
          </div>

          {/* ID - [N-1] auto generated */}
          <div className="settings-field">
            <label className="settings-label">
              ID Plugin <span className="hint">(huruf kecil, auto dari nama)</span>
            </label>
            <div style={{ position: "relative" }}>
              <input className="mod-input" value={id}
                onChange={e => setId(slugify(e.target.value))}
                placeholder="my-awesome-plugin" />
              <span style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, color: "#6e7681", fontFamily: "monospace",
              }}>
                plugins/{id || "..."}
              </span>
            </div>
          </div>

          {/* Deskripsi */}
          <div className="settings-field">
            <label className="settings-label">Deskripsi <span className="hint">(opsional)</span></label>
            <textarea className="mod-input mod-textarea" value={desc}
              onChange={e => setDesc(e.target.value)}
              placeholder="Apa yang plugin ini lakukan..." rows={2} />
          </div>

          {/* [N-2] Hook selector */}
          <div className="settings-field">
            <label className="settings-label">Hook yang digunakan</label>
            <p className="settings-desc" style={{ marginBottom: 8 }}>
              Centang hook yang kamu butuhkan. Hanya hook yang dipilih yang akan ada di kode template.
            </p>
            <div className="hooks-grid">
              {HOOK_DEFS.map(hook => {
                const active = selectedHooks.includes(hook.id)
                return (
                  <div
                    key={hook.id}
                    className={`hook-card ${active ? "hook-card--active" : ""}`}
                    onClick={() => toggleHook(hook.id)}
                  >
                    <div className="hook-card__top">
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span>{hook.emoji}</span>
                        <code className="hook-card__name">{hook.id}</code>
                      </div>
                      <div className={`hook-card__check ${active ? "hook-card__check--on" : ""}`}>
                        {active && <Icon d={ICONS.check} size={10} />}
                      </div>
                    </div>
                    <div className="hook-card__desc">{hook.desc}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {error && <div className="modal__error">{error}</div>}
        </div>

        <div className="modal__footer">
          <button className="btn-secondary" onClick={onClose}>Batal</button>
          <button className="btn-primary" onClick={handle} disabled={loading}>
            {loading ? "Membuat..." : "✨ Buat Plugin"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Source Code Viewer ────────────────────────────────────────
function SourceModal({ pluginId, onClose }) {
  const [detail, setDetail]   = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.modsDetail({ id: pluginId }).then(res => {
      if (res.ok) setDetail(res.data)
      setLoading(false)
    })
  }, [pluginId])

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--wide">
        <div className="modal__header">
          <span>📄 {detail?.name || pluginId} — index.js</span>
          <button className="modal__close" onClick={onClose}><Icon d={ICONS.x} size={18} /></button>
        </div>
        <div className="modal__body">
          {loading
            ? <div className="mod-loading">Memuat source...</div>
            : <pre className="mod-source">{detail?.source || "// Tidak ada source"}</pre>
          }
        </div>
        <div className="modal__footer">
          <button className="btn-secondary" onClick={onClose}>Tutup</button>
          <button className="btn-icon-lg" onClick={() => window.api.modsOpenFolder({ id: pluginId })}>
            <Icon d={ICONS.folder} size={15} /> Buka Folder Plugin
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main ModManager Page ──────────────────────────────────────
export default function ModManagerPage({ onBack }) {
  const [plugins,      setPlugins]      = useState([])
  const [loading,      setLoading]      = useState(true)
  const [reloading,    setReloading]    = useState(false)
  const [showCreate,   setShowCreate]   = useState(false)
  const [viewSource,   setViewSource]   = useState(null)
  const [viewSettings, setViewSettings] = useState(null)
  const [toast,        setToast]        = useState(null)
  // Multi-select state
  const [selectMode,   setSelectMode]   = useState(false)
  const [selectedIds,  setSelectedIds]  = useState(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const showToast = (msg, type = "success") => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const loadPlugins = useCallback(async () => {
    const res = await window.api.modsList()
    if (res.ok) setPlugins(res.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadPlugins()
    const unsub = window.api.onModsUpdated?.((data) => {
      if (Array.isArray(data)) setPlugins(data)
    })
    return () => unsub?.()
  }, [loadPlugins])

  const handleToggle = async (id, enabled) => {
    const res = await window.api.modsToggle({ id, enabled })
    if (res.ok) {
      setPlugins(prev => prev.map(p => p.id === id ? { ...p, enabled } : p))
      showToast(`Plugin "${id}" ${enabled ? "diaktifkan" : "dinonaktifkan"}`)
    }
  }

  const handleDelete = async (id) => {
    const res = await window.api.modsDelete({ id })
    if (res.ok) {
      setPlugins(prev => prev.filter(p => p.id !== id))
      showToast(`Plugin "${id}" dihapus`)
    } else {
      showToast(res.error || "Gagal hapus plugin", "error")
    }
  }

  // ── Multi-select helpers ──────────────────────────────────
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(plugins.map(p => p.id)))
  }

  const deselectAll = () => setSelectedIds(new Set())

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    setBulkDeleting(true)
    const ids = Array.from(selectedIds)
    const res = await window.api.modsDeleteBulk({ ids })
    setBulkDeleting(false)
    if (res.ok) {
      setPlugins(prev => prev.filter(p => !ids.includes(p.id)))
      exitSelectMode()
      const failMsg = res.failedCount > 0 ? ` (${res.failedCount} gagal)` : ""
      showToast(`${ids.length - (res.failedCount || 0)} plugin dihapus${failMsg}`, res.failedCount > 0 ? "error" : "success")
    } else {
      showToast(res.error || "Gagal hapus plugin", "error")
      exitSelectMode()
    }
  }

  const handleReload = async () => {
    setReloading(true)
    const res = await window.api.modsReload()
    setReloading(false)
    if (res.ok) { await loadPlugins(); showToast(`${res.count} plugin dimuat ulang`) }
  }

  const enabledCount = plugins.filter(p => p.enabled).length
  const errorCount   = plugins.filter(p => p.error).length

  return (
    <div className="mod-manager">
      {/* Header */}
      <div className="mod-header">
        <div className="mod-header__left">
          {onBack && <button className="btn-icon" onClick={onBack}>← Kembali</button>}
          <div className="mod-header__title">
            <Icon d={ICONS.zap} size={22} className="mod-header__icon" />
            <span>Plugin Manager</span>
          </div>
          <div className="mod-header__stats">
            <span className="stat stat--green">{enabledCount} aktif</span>
            <span className="stat stat--gray">{plugins.length - enabledCount} nonaktif</span>
            {errorCount > 0 && <span className="stat stat--red">{errorCount} error</span>}
          </div>
        </div>
        <div className="mod-header__actions">
          {!selectMode ? (
            <>
              <button className="btn-secondary btn-sm" onClick={() => window.api.modsOpenFolder({})}>
                <Icon d={ICONS.folder} size={15} /> Buka Folder
              </button>
              <button className="btn-secondary btn-sm" onClick={handleReload} disabled={reloading}>
                <Icon d={ICONS.refresh} size={15} className={reloading ? "spin" : ""} />
                {reloading ? "Memuat..." : "Reload"}
              </button>
              {plugins.length > 0 && (
                <button className="btn-secondary btn-sm" onClick={() => setSelectMode(true)} title="Pilih beberapa plugin">
                  <Icon d={ICONS.check} size={15} /> Pilih
                </button>
              )}
              <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>
                <Icon d={ICONS.plus} size={15} /> Plugin Baru
              </button>
            </>
          ) : (
            /* ── Select mode toolbar ── */
            <div className="select-toolbar">
              <span className="select-count">
                {selectedIds.size} dipilih
              </span>
              <button className="btn-secondary btn-sm" onClick={selectedIds.size === plugins.length ? deselectAll : selectAll}>
                {selectedIds.size === plugins.length ? "Batal semua" : "Pilih semua"}
              </button>
              <button
                className="btn-bulk-delete"
                onClick={handleBulkDelete}
                disabled={selectedIds.size === 0 || bulkDeleting}
              >
                <Icon d={ICONS.trash} size={14} />
                {bulkDeleting ? "Menghapus..." : `Hapus ${selectedIds.size > 0 ? `(${selectedIds.size})` : ""}`}
              </button>
              <button className="btn-secondary btn-sm" onClick={exitSelectMode}>
                Batal
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Info banner */}
      <div className="mod-banner">
        <Icon d={ICONS.info} size={16} />
        <span>
          Plugin disimpan di <code>electron/mods/plugins/</code>.
          Klik <strong>Settings</strong> pada plugin untuk mengkonfigurasi.
        </span>
      </div>

      {/* Plugin grid */}
      <div className="mod-grid">
        {loading ? (
          <div className="mod-loading">Memuat plugin...</div>
        ) : plugins.length === 0 ? (
          <div className="mod-empty">
            <div className="mod-empty__icon">🧩</div>
            <div className="mod-empty__title">Belum ada plugin</div>
            <div className="mod-empty__sub">Klik "+ Plugin Baru" untuk mulai</div>
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              <Icon d={ICONS.plus} size={15} /> Buat Plugin Pertama
            </button>
          </div>
        ) : (
          plugins.map(plugin => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onToggle={handleToggle}
              onSettings={setViewSettings}
              onSource={setViewSource}
              onOpenFolder={id => window.api.modsOpenFolder({ id })}
              onDelete={handleDelete}
              selectable={selectMode}
              selected={selectedIds.has(plugin.id)}
              onSelect={toggleSelect}
            />
          ))
        )}
      </div>

      {/* Modals */}
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreate={loadPlugins} />}
      {viewSource && <SourceModal pluginId={viewSource} onClose={() => setViewSource(null)} />}
      {viewSettings && (
        <SettingsModal
          plugin={viewSettings}
          onClose={() => setViewSettings(null)}
          onSaved={() => showToast(`Settings "${viewSettings.name}" disimpan`)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`mod-toast mod-toast--${toast.type}`}>
          {toast.type === "success" ? "✓" : "✗"} {toast.msg}
        </div>
      )}

      <style>{`
        .mod-manager {
          display: flex; flex-direction: column; height: 100%;
          background: #0d1117; color: #e6edf3;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
        }
        .mod-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px; border-bottom: 1px solid #21262d;
          flex-shrink: 0; gap: 12px; flex-wrap: wrap;
        }
        .mod-header__left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .mod-header__title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; }
        .mod-header__icon { color: #f78166; }
        .mod-header__stats { display: flex; gap: 6px; }
        .stat { padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
        .stat--green { background: #1a3a2a; color: #3fb950; }
        .stat--gray  { background: #21262d; color: #8b949e; }
        .stat--red   { background: #3a1a1a; color: #f78166; }
        .mod-header__actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

        .mod-banner {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 20px; background: #161b22;
          border-bottom: 1px solid #21262d;
          font-size: 12.5px; color: #8b949e; flex-shrink: 0;
        }
        .mod-banner code { background: #21262d; padding: 1px 5px; border-radius: 4px; color: #d2a8ff; font-size: 11.5px; }
        .mod-banner strong { color: #e6edf3; }

        .mod-grid {
          flex: 1; overflow-y: auto; padding: 20px;
          display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 14px; align-content: start;
        }

        .mod-empty {
          grid-column: 1 / -1; text-align: center; padding: 60px 20px;
          display: flex; flex-direction: column; align-items: center; gap: 12px;
        }
        .mod-empty__icon { font-size: 48px; }
        .mod-empty__title { font-size: 18px; font-weight: 600; }
        .mod-empty__sub { font-size: 13px; color: #8b949e; }

        /* Plugin Card */
        .plugin-card {
          background: #161b22; border: 1px solid #21262d; border-radius: 12px;
          padding: 16px; display: flex; flex-direction: column; gap: 10px;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .plugin-card:hover { border-color: #30363d; box-shadow: 0 2px 12px rgba(0,0,0,0.3); }
        .plugin-card--on  { border-left: 3px solid #238636; }
        .plugin-card--off { border-left: 3px solid #30363d; opacity: 0.75; }
        .plugin-card--error { border-left: 3px solid #da3633; }
        .plugin-card__header { display: flex; align-items: flex-start; gap: 10px; }
        .plugin-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
        .plugin-card__info { flex: 1; min-width: 0; }
        .plugin-card__name { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .plugin-card__meta { font-size: 11.5px; color: #8b949e; margin-top: 2px; }
        .plugin-card__desc { font-size: 12.5px; color: #8b949e; line-height: 1.5; }
        .plugin-card__error {
          display: flex; align-items: flex-start; gap: 6px;
          font-size: 12px; color: #f78166; background: #2a1a1a;
          padding: 8px 10px; border-radius: 6px;
        }
        .plugin-card__hooks { display: flex; flex-wrap: wrap; gap: 5px; }
        .hook-badge {
          font-size: 10.5px; padding: 2px 7px; border-radius: 10px;
          background: #21262d; color: #79c0ff;
          font-family: "SF Mono", monospace;
        }
        .plugin-card__actions { display: flex; gap: 6px; flex-wrap: wrap; }

        /* Trash button on card */
        .btn-trash {
          display: flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; border-radius: 6px;
          background: transparent; border: 1px solid #30363d;
          color: #6e7681; cursor: pointer;
          transition: all 0.15s; flex-shrink: 0;
        }
        .btn-trash:hover { background: #2a1a1a; border-color: #da3633; color: #f78166; }

        /* Toggle */
        .toggle {
          width: 44px; height: 24px; border-radius: 12px; border: none;
          cursor: pointer; padding: 3px; display: flex; align-items: center;
          transition: background 0.2s; flex-shrink: 0;
        }
        .toggle--on  { background: #238636; justify-content: flex-end; }
        .toggle--off { background: #30363d; justify-content: flex-start; }
        .toggle--disabled { opacity: 0.5; cursor: not-allowed; }
        .toggle__thumb { width: 18px; height: 18px; border-radius: 50%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }

        /* Buttons */
        .btn-primary {
          display: flex; align-items: center; gap: 6px;
          padding: 8px 14px; background: #238636; color: white;
          border: none; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 500; transition: background 0.2s; white-space: nowrap;
        }
        .btn-primary:hover:not(:disabled) { background: #2ea043; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-saved { background: #1a5c3e !important; }

        .btn-secondary {
          display: flex; align-items: center; gap: 6px;
          padding: 7px 12px; background: #21262d; color: #e6edf3;
          border: 1px solid #30363d; border-radius: 8px; cursor: pointer;
          font-size: 13px; font-weight: 500; transition: background 0.2s; white-space: nowrap;
        }
        .btn-secondary:hover:not(:disabled) { background: #30363d; }
        .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-sm { padding: 5px 10px; font-size: 12px; }

        .btn-icon {
          display: flex; align-items: center; gap: 5px;
          padding: 5px 10px; background: transparent; color: #8b949e;
          border: 1px solid #30363d; border-radius: 6px; cursor: pointer;
          font-size: 12px; transition: all 0.15s; white-space: nowrap;
        }
        .btn-icon:hover { color: #e6edf3; border-color: #8b949e; background: #21262d; }
        .btn-settings:hover { color: #79c0ff; border-color: #79c0ff; }

        .btn-icon-lg {
          display: flex; align-items: center; gap: 6px;
          padding: 7px 14px; background: #21262d; color: #e6edf3;
          border: 1px solid #30363d; border-radius: 8px; cursor: pointer;
          font-size: 13px; transition: background 0.15s;
        }
        .btn-icon-lg:hover { background: #30363d; }

        /* Add custom field button */
        .add-field-btn {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 14px;
          background: transparent;
          border: 1.5px dashed #30363d;
          border-radius: 8px; color: #6e7681;
          cursor: pointer; font-size: 13px;
          transition: all 0.15s; width: 100%;
          justify-content: center;
        }
        .add-field-btn:hover { border-color: #58a6ff; color: #58a6ff; background: #0d2137; }

        /* Field remove button */
        .field-remove-btn {
          display: flex; align-items: center; justify-content: center;
          width: 22px; height: 22px; border-radius: 5px;
          background: transparent; border: 1px solid #30363d;
          color: #6e7681; cursor: pointer; transition: all 0.15s;
          flex-shrink: 0;
        }
        .field-remove-btn:hover { background: #2a1a1a; border-color: #da3633; color: #f78166; }

        /* Hooks grid for create modal */
        .hooks-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 8px;
        }
        .hook-card {
          background: #0d1117; border: 1.5px solid #21262d; border-radius: 10px;
          padding: 12px; cursor: pointer; transition: all 0.15s;
          display: flex; flex-direction: column; gap: 6px;
        }
        .hook-card:hover { border-color: #30363d; background: #161b22; }
        .hook-card--active { border-color: #238636; background: #0d2020; }
        .hook-card__top { display: flex; align-items: center; justify-content: space-between; }
        .hook-card__name { font-size: 12px; font-family: "SF Mono", monospace; color: #79c0ff; }
        .hook-card__desc { font-size: 11.5px; color: #6e7681; line-height: 1.5; }
        .hook-card__check {
          width: 18px; height: 18px; border-radius: 50%;
          border: 1.5px solid #30363d; display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; transition: all 0.15s;
        }
        .hook-card__check--on { background: #238636; border-color: #238636; color: white; }

        /* Modals */
        .modal-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.72);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000; padding: 20px;
        }
        .modal {
          background: #161b22; border: 1px solid #30363d; border-radius: 12px;
          width: 100%; max-width: 440px; max-height: 90vh;
          display: flex; flex-direction: column; overflow: hidden;
        }
        .modal--wide     { max-width: 760px; }
        .modal--settings { max-width: 520px; }
        .modal__header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px; border-bottom: 1px solid #21262d;
          flex-shrink: 0;
        }
        .modal__header-left { display: flex; align-items: center; gap: 12px; }
        .modal__emoji { font-size: 24px; }
        .modal__title { font-size: 15px; font-weight: 600; }
        .modal__subtitle { font-size: 12px; color: #8b949e; margin-top: 1px; }
        .modal__close {
          background: none; border: none; cursor: pointer; color: #8b949e;
          padding: 4px; display: flex; border-radius: 6px; transition: color 0.15s;
        }
        .modal__close:hover { color: #e6edf3; background: #21262d; }
        .modal__body {
          padding: 20px; overflow-y: auto; flex: 1;
          display: flex; flex-direction: column; gap: 16px;
        }
        .modal__footer {
          padding: 14px 20px; border-top: 1px solid #21262d;
          display: flex; justify-content: flex-end; gap: 8px; flex-shrink: 0;
        }
        .modal__error { color: #f78166; font-size: 12.5px; background: #2a1a1a; padding: 8px 12px; border-radius: 6px; }

        /* Settings fields */
        .settings-field { display: flex; flex-direction: column; gap: 6px; }
        .settings-field__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .settings-label { font-size: 13px; font-weight: 500; color: #e6edf3; }
        .settings-desc  { font-size: 12px; color: #8b949e; margin: 0; line-height: 1.5; }

        /* Image field */
        .image-field { display: flex; flex-direction: column; gap: 8px; }
        .image-preview { position: relative; display: inline-block; align-self: flex-start; }
        .image-preview img { width: 80px; height: 80px; object-fit: cover; border-radius: 8px; border: 1px solid #30363d; display: block; }
        .image-clear {
          position: absolute; top: -6px; right: -6px; width: 20px; height: 20px;
          border-radius: 50%; background: #da3633; color: white; border: none;
          cursor: pointer; font-size: 10px; display: flex; align-items: center; justify-content: center;
        }
        .image-actions { display: flex; align-items: center; gap: 8px; }
        .image-or { font-size: 12px; color: #8b949e; white-space: nowrap; }

        .mod-empty-settings {
          text-align: center; padding: 30px 0;
          display: flex; flex-direction: column; align-items: center; gap: 10px;
          color: #8b949e; font-size: 13.5px;
        }

        /* Form inputs */
        label { font-size: 12.5px; font-weight: 500; color: #8b949e; }
        .hint { font-weight: 400; color: #6e7681; }
        .mod-input {
          display: block; width: 100%; padding: 8px 12px;
          background: #0d1117; border: 1px solid #30363d;
          border-radius: 8px; color: #e6edf3; font-size: 13.5px;
          box-sizing: border-box; transition: border-color 0.15s; font-family: inherit;
        }
        .mod-input:focus { outline: none; border-color: #58a6ff; box-shadow: 0 0 0 3px rgba(88,166,255,0.1); }
        .mod-textarea { resize: vertical; }
        .mod-json { font-family: "SF Mono", Consolas, monospace; font-size: 12px; }

        .mod-source {
          background: #0d1117; border: 1px solid #21262d; border-radius: 8px;
          padding: 16px; font-family: "SF Mono", Consolas, monospace;
          font-size: 12px; line-height: 1.6; color: #e6edf3;
          overflow-x: auto; white-space: pre; flex: 1; min-height: 300px;
        }

        .mod-loading { text-align: center; padding: 40px; color: #8b949e; font-size: 13.5px; }

        .mod-toast {
          position: fixed; bottom: 24px; right: 24px;
          padding: 10px 18px; border-radius: 8px; font-size: 13.5px; font-weight: 500;
          box-shadow: 0 4px 20px rgba(0,0,0,0.4); z-index: 9999;
          animation: slideUp 0.2s ease;
        }
        .mod-toast--success { background: #238636; color: white; }
        .mod-toast--error   { background: #da3633; color: white; }

        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        /* ── Settings modal tabs ── */
        .settings-tabs {
          display: flex; gap: 2px;
          padding: 8px 16px; border-bottom: 1px solid #21262d;
          background: #0d1117; flex-shrink: 0;
        }
        .settings-tab {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 14px; border-radius: 6px; border: none;
          background: transparent; color: #8b949e; cursor: pointer;
          font-size: 13px; font-weight: 500; transition: all 0.15s;
        }
        .settings-tab:hover { color: #e6edf3; background: #21262d; }
        .settings-tab--active { background: #21262d; color: #e6edf3; }

        /* ── Multi-select ── */
        .select-toolbar {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        }
        .select-count {
          font-size: 13px; font-weight: 600; color: #58a6ff;
          padding: 4px 10px; background: #0d2137;
          border: 1px solid #1f4070; border-radius: 20px;
          white-space: nowrap;
        }
        .btn-bulk-delete {
          display: flex; align-items: center; gap: 6px;
          padding: 5px 12px; background: #2a1a1a;
          border: 1px solid #da3633; border-radius: 8px;
          color: #f78166; cursor: pointer; font-size: 12px; font-weight: 600;
          transition: all 0.15s; white-space: nowrap;
        }
        .btn-bulk-delete:hover:not(:disabled) { background: #3a1a1a; }
        .btn-bulk-delete:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Card selected state */
        .plugin-card--selected {
          border-color: #58a6ff !important;
          background: #0d2137 !important;
        }
        .plugin-card__checkbox {
          width: 20px; height: 20px; border-radius: 5px;
          border: 2px solid #30363d; background: #0d1117;
          display: flex; align-items: center; justify-content: center;
          margin-bottom: 6px; flex-shrink: 0; transition: all 0.15s;
          color: white;
        }
        .plugin-card__checkbox--on {
          background: #238636; border-color: #238636;
        }
      `}</style>
    </div>
  )
}