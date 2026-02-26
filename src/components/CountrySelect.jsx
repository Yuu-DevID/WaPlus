import { useState, useRef, useEffect } from "react"
import { useAuthStore } from "../store/auth"
import COUNTRIES from "../data/countries"

export default function CountrySelect() {
  const { country, setCountry } = useAuthStore()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const filtered = COUNTRIES.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.dial.includes(search)
  )

  const select = (c) => { setCountry(c); setOpen(false); setSearch("") }

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className="country-btn" onClick={() => setOpen(!open)}>
        {country.flag
          ? <img className="country-flag" src={`https://flagcdn.com/24x18/${country.iso.toLowerCase()}.png`} alt={country.name} />
          : <span>{country.flag || "🌍"}</span>
        }
        <span>{country.dial}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="country-dropdown">
          <input
            className="country-search"
            placeholder="Cari negara atau kode..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          <div className="country-list">
            {filtered.map(c => (
              <div key={c.code} className="country-item" onClick={() => select(c)}>
                <img
                  className="country-flag"
                  src={`https://flagcdn.com/24x18/${c.iso.toLowerCase()}.png`}
                  alt={c.name}
                  onError={e => e.target.style.display = "none"}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ fontSize: 12, color: "var(--green)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{c.dial}</span>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: "20px 12px", color: "var(--text-3)", fontSize: 12 }}>Tidak ditemukan</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
