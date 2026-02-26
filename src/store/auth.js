import { create } from "zustand"

export const useAuthStore = create((set) => ({
  // ── State ─────────────────────────────────────────
  step: 1,          // 1=input, 2=pairing/qr, 3=connected
  mode: "pairing",  // "pairing" | "qr"
  phone: "",
  country: { name: "Indonesia", dial: "+62", iso: "ID", flag: "https://flagcdn.com/w40/id.png" },
  pairingCode: "",
  receivedCode: "",
  qrData: null,     // QR string from baileys
  loading: false,
  error: null,
  connectedUser: null, // { name, jid, phone }

  // ── Actions ───────────────────────────────────────
  setStep: (step) => set({ step }),
  setMode: (mode) => set({ mode }),
  setPhone: (phone) => set({ phone }),
  setCountry: (country) => set({ country }),
  setPairingCode: (code) => set({ pairingCode: code }),
  setReceivedCode: (code) => set({ receivedCode: code }),
  setQRData: (qr) => set({ qrData: qr }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setConnectedUser: (user) => set({ connectedUser: user }),

  reset: () => set({
    step: 1,
    phone: "",
    pairingCode: "",
    receivedCode: "",
    qrData: null,
    loading: false,
    error: null,
    connectedUser: null,
  }),
}))