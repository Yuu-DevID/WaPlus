import { useEffect, useCallback } from "react"
import { useAuthStore } from "../store/auth"
import CountrySelect from "../components/CountrySelect"
import QRDisplay from "../components/QRDisplay"

function StepDots({ step }) {
  const steps = ["Nomor WA", "Verifikasi", "Terhubung"]
  return (
    <div className="step-row">
      {steps.map((label, i) => {
        const n = i + 1
        const done = step > n
        const active = step === n
        return (
          <div key={n} style={{ display: "flex", alignItems: "center" }}>
            <div className="step-dot-wrap">
              <div className={"step-dot" + (done ? " done" : active ? " active" : "")}>
                {done ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg> : n}
              </div>
              <span className={"step-label" + (step >= n ? " active" : "")}>{label}</span>
            </div>
            {i < steps.length - 1 && <div className={"step-connector" + (step > n ? " done" : "")} />}
          </div>
        )
      })}
    </div>
  )
}

export default function Auth() {
  const {
    step, mode, phone, country, receivedCode, qrData,
    setPhone, setMode, setReceivedCode, setQRData, setStep,
    loading, setLoading, error, setError, setConnectedUser, reset,
  } = useAuthStore()

  useEffect(() => {
    if (!window.api) return

    const handlePairingCode = (data) => {
      setLoading(false)
      setReceivedCode(data.code || "")
      setStep(2)
    }

    const handlePairingError = (err) => {
      setLoading(false)
      setError(err.message || "Gagal pairing code")
    }

    const handleQR = (qr) => {
      setLoading(false)
      setStep(2)
      setQRData(qr)
    }

    const handleConnected = (data) => {
      setLoading(false)
      setConnectedUser(data)
      setStep(3)
    }

    window.api.onPairingCode(handlePairingCode)
    window.api.onPairingError(handlePairingError)
    window.api.onQR(handleQR)
    window.api.onConnected(handleConnected)

    // ✅ Cleanup (WAJIB di Electron)
    return () => {
      window.api.removePairingCode?.(handlePairingCode)
      window.api.removePairingError?.(handlePairingError)
      window.api.removeQR?.(handleQR)
      window.api.removeConnected?.(handleConnected)
    }

  }, [])

  const requestPairing = useCallback(() => {
    if (!phone || phone.length < 6) { setError("Nomor minimal 6 digit"); return }
    setLoading(true); setError(null)
    let clean = phone.replace(/\D/g, "")
    if (clean.startsWith("0")) clean = clean.slice(1)
    const full = country.dial.replace("+", "") + clean
    if (window.api) window.api.requestPairing(full)
    else setTimeout(() => { setLoading(false); setReceivedCode("A4B7-2X9K"); setStep(2) }, 2500)
  }, [phone, country])

  const startQR = useCallback(() => {
    setMode("qr"); setLoading(true); setError(null); setQRData(null)
    if (window.api) window.api.startQRMode()
    else setTimeout(() => { setLoading(false); setQRData("fake-qr"); setStep(2) }, 1800)
  }, [])

  return (
    <div className="auth-root">
      {/* Left brand panel */}
      <div className="auth-brand anim-fade-in">
        <div className="brand-logo anim-float">
          <svg viewBox="0 0 48 48" fill="none" width="52" height="52">
            <path d="M24 4C13.0 4 4 13.0 4 24c0 3.5.95 6.8 2.6 9.65L4 44l10.6-2.55A19.93 19.93 0 0024 44c11.0 0 20-9.0 20-20S35.0 4 24 4z" fill="white" fillOpacity=".92" />
            <circle cx="17" cy="24" r="2.2" fill="#25d366" />
            <circle cx="24" cy="24" r="2.2" fill="#25d366" />
            <circle cx="31" cy="24" r="2.2" fill="#25d366" />
          </svg>
        </div>
        <h1 className="brand-title">Aurora<span>Chat</span></h1>
        <p className="brand-sub">WhatsApp Desktop yang lebih ringan, cepat, dan elegan</p>
        {[
          ["⚡", "Lebih cepat dari WA Desktop resmi"],
          ["🔒", "Enkripsi end-to-end terjaga penuh"],
          ["🎨", "Tampilan modern & dark mode indah"],
          ["💾", "Riwayat chat tersimpan secara lokal"],
        ].map(([icon, text]) => (
          <div key={text} className="brand-feature">
            <div className="brand-feature-icon">{icon}</div>
            <span className="brand-feature-text">{text}</span>
          </div>
        ))}
        <div className="brand-footer">Berbasis Baileys — Open Source WhatsApp API</div>
      </div>

      {/* Right form panel */}
      <div className="auth-form-panel">
        <div className="auth-card anim-scale-in">
          <StepDots step={step} />

          {/* STEP 1 */}
          {step === 1 && (
            <div className="anim-fade-up">
              <div className="mode-tabs">
                {[
                  { id: "pairing", label: "📱 Nomor HP", action: () => { setMode("pairing"); setError(null) } },
                  { id: "qr", label: "⬛ QR Code", action: () => { setMode("qr"); setError(null); startQR() } },
                ].map(t => (
                  <button key={t.id} className={"mode-tab" + (mode === t.id ? " active" : "")} onClick={t.action}>
                    {t.label}
                  </button>
                ))}
              </div>

              {mode === "pairing" && (
                <div className="anim-fade-up">
                  <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 6, letterSpacing: "-.5px" }}>Masukkan Nomor WA</h2>
                  <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 20, lineHeight: 1.6 }}>Nomor kamu akan menerima pairing code untuk verifikasi perangkat</p>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <CountrySelect />
                    <input
                      type="tel"
                      className="auth-input"
                      value={phone}
                      onChange={e => { setPhone(e.target.value.replace(/\D/g, "")); if (error) setError(null) }}
                      onKeyDown={e => e.key === "Enter" && phone.length >= 6 && requestPairing()}
                      placeholder="8xx xxxx xxxx"
                      autoFocus
                    />
                  </div>
                  <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 18, paddingLeft: 2 }}>
                    Tanpa awalan 0 — {country.dial} {phone || "···· ···· ···"}
                  </p>
                  {error && <div className="auth-error"><span>{error}</span></div>}
                  <button className="btn-primary" onClick={requestPairing} disabled={loading || phone.length < 6}>
                    {loading ? <><span className="spinner spinner-black spinner-sm" />Memproses...</> : <>📲 Minta Pairing Code</>}
                  </button>
                </div>
              )}

              {mode === "qr" && (
                <div className="anim-fade-up">
                  <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 6, letterSpacing: "-.5px" }}>Scan QR Code</h2>
                  <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 18, lineHeight: 1.6 }}>Buka WhatsApp di HP → Perangkat Tertaut → Scan QR ini</p>
                  <QRDisplay data={qrData} loading={loading} />
                  {error && <div className="auth-error" style={{ marginTop: 14 }}><span>{error}</span></div>}
                </div>
              )}
            </div>
          )}

          {/* STEP 2 — pairing */}
          {step === 2 && mode === "pairing" && (
            <div className="anim-fade-up">
              <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 6, letterSpacing: "-.5px" }}>Kode Pairing</h2>
              <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 20, lineHeight: 1.6 }}>
                Buka <b style={{ color: "var(--green)" }}>WhatsApp</b> → Setelan → Perangkat Tertaut → Tautkan Perangkat → masukkan kode:
              </p>
              {receivedCode && (
                <>
                  <p style={{ fontSize: 11, color: "var(--text-3)", textAlign: "center", marginBottom: 6 }}>Kode Pairing kamu</p>
                  <div className="pair-chars">
                    {receivedCode.split("").map((c, i) => <div key={i} className="pair-char">{c}</div>)}
                  </div>
                  <p style={{ fontSize: 11, color: "var(--text-3)", textAlign: "center", marginTop: 6, marginBottom: 16 }}>Kode berlaku beberapa menit</p>
                </>
              )}
              <div className="wait-box">
                <span className="spinner spinner-green spinner-sm" />
                <span>Menunggu verifikasi dari HP...</span>
              </div>
              {error && <div className="auth-error"><span>{error}</span></div>}
              <button className="btn-ghost" onClick={() => reset()}>← Kembali</button>
            </div>
          )}

          {/* STEP 2 — QR */}
          {step === 2 && mode === "qr" && (
            <div className="anim-fade-up">
              <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text-1)", marginBottom: 6, letterSpacing: "-.5px" }}>Scan QR Code</h2>
              <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 16, lineHeight: 1.6 }}>Scan dengan <b style={{ color: "var(--green)" }}>WhatsApp</b> di HP kamu</p>
              <QRDisplay data={qrData} loading={loading} />
              {error && <div className="auth-error" style={{ marginTop: 14 }}><span>{error}</span></div>}
              <div style={{ marginTop: 16 }}>
                <button className="btn-ghost" onClick={() => { reset(); setMode("pairing") }}>📱 Pakai Pairing Code</button>
              </div>
            </div>
          )}

          {/* STEP 3 — success */}
          {step === 3 && (
            <div className="anim-fade-up" style={{ textAlign: "center", padding: "8px 0" }}>
              <div className="success-icon anim-bounce-in">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: "var(--green)", marginBottom: 8, letterSpacing: "-.5px" }}>Terhubung! 🎉</h2>
              <p style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 20 }}>WhatsApp berhasil terhubung ke AuroraChat</p>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span className="spinner spinner-green spinner-sm" />
                <span style={{ fontSize: 12, color: "var(--text-3)" }}>Memuat percakapan...</span>
              </div>
            </div>
          )}

          <div style={{ borderTop: "1px solid var(--border)", marginTop: 24, paddingTop: 16, textAlign: "center" }}>
            <p style={{ fontSize: 11, color: "var(--text-3)" }}>
              Berbasis <a href="https://github.com/WhiskeySockets/Baileys" target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)" }}>Baileys</a> — Bukan produk resmi WhatsApp Inc.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
