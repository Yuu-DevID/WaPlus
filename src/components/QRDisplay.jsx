import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"

export default function QRDisplay({ data, loading }) {
  const canvasRef = useRef(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!data || !canvasRef.current) return
    setErr(false)
    QRCode.toCanvas(canvasRef.current, data, {
      width: 220, margin: 2,
      color: { dark: "#000000", light: "#FFFFFF" },
      errorCorrectionLevel: "M",
    }).catch(() => setErr(true))
  }, [data])

  if (loading || !data) return (
    <div className="qr-wrap">
      <div className="qr-placeholder">
        <span className="spinner spinner-lg spinner-green"/>
        <span style={{fontSize:12,color:"var(--text-3)"}}>Memuat QR Code...</span>
      </div>
    </div>
  )

  if (err) return (
    <div className="qr-wrap">
      <div className="qr-placeholder" style={{borderColor:"rgba(248,113,113,.3)"}}>
        <span style={{fontSize:28}}>⚠️</span>
        <span style={{fontSize:12,color:"var(--text-danger)",textAlign:"center",padding:"0 12px"}}>Gagal merender QR. Coba refresh.</span>
      </div>
    </div>
  )

  return (
    <div className="qr-wrap">
      <div style={{position:"relative",display:"inline-flex"}}>
        <span className="qr-corner qr-tl"/>
        <span className="qr-corner qr-tr"/>
        <span className="qr-corner qr-bl"/>
        <span className="qr-corner qr-br"/>
        <div className="qr-box">
          <canvas ref={canvasRef}/>
        </div>
      </div>
      <div style={{textAlign:"center"}}>
        <p style={{fontSize:12,color:"var(--text-2)"}}>
          Buka <b style={{color:"var(--green)"}}>WhatsApp</b> → Setelan → Perangkat Tertaut
        </p>
        <p style={{fontSize:11,color:"var(--text-3)",marginTop:4}}>
          Ketuk <b style={{color:"var(--green)"}}>Tautkan Perangkat</b> lalu scan QR di atas
        </p>
      </div>
    </div>
  )
}
