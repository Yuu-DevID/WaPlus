import { useEffect, useState } from "react"
import { useAuthStore } from "./store/auth"
import Auth from "./pages/Auth"
import Main from "./pages/Main"

export default function App() {
  const { step, setConnectedUser, setStep } = useAuthStore()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const init = async () => {
      try {
        if (window.api?.checkSession) {
          const res = await window.api.checkSession()
          if (res?.hasSession) setStep(3)
        }
      } catch(e) { console.error("Session check failed:", e) }
      finally { setChecked(true) }
    }
    init()
  }, [])

  useEffect(() => {
    if (!window.api) { setChecked(true); return }
    window.api.onConnected?.((data) => { setConnectedUser(data); setStep(3) })
    window.api.onLoggedOut?.(() => setStep(1))
  }, [])

  if (!checked) return (
    <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg-base)",gap:12}}>
      <span className="spinner spinner-green spinner-lg"/>
      <span style={{fontSize:14,color:"var(--text-3)"}}>Memuat...</span>
    </div>
  )

  return step === 3 ? <Main/> : <Auth/>
}
