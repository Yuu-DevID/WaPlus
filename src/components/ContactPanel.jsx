// Contact/info panel
export default function ContactPanel({ jid }) {
  if (!jid) return null
  return (
    <div style={{width:280,flexShrink:0,background:"var(--bg-sidebar)",borderLeft:"1px solid var(--border)",display:"flex",flexDirection:"column",alignItems:"center",padding:24}}>
      <div style={{fontSize:13,color:"var(--text-3)"}}>Info Kontak</div>
    </div>
  )
}
