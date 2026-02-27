// src/store/chat.js
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v4 — AuroraChat Chat Store
// ═══════════════════════════════════════════════════════════════════════════

import { create } from "zustand"
import { useAuthStore } from "./auth"

// Helper: get own JID from auth store without subscribing
function getOwnJid() {
  try { return useAuthStore.getState().connectedUser?.jid || null } catch { return null }
}

// ════════════════════════════════════════════════════════════
// [FIX-DEDUP] Smart chat merge — prevents undefined/null from
// overwriting existing values when IPC payload has partial fields.
//
// Problem: { ...existingChat, ...{ name: undefined, last_msg: 'hi' } }
//           → name gets wiped to undefined even though existing had 'Budi'
//
// Rule: incoming value wins ONLY if it is not undefined.
//       'name' and 'profile_pic_url' are additionally protected:
//       they are NEVER overwritten by null — only a real string value wins.
// ════════════════════════════════════════════════════════════
function mergeChat(existing, incoming) {
  const PROTECT_FROM_NULL = new Set(['name', 'profile_pic_url'])
  const result = { ...existing }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue                          // never overwrite with undefined
    if (v === null && PROTECT_FROM_NULL.has(k)) continue  // protect name from null wipe
    result[k] = v
  }
  return result
}
// Mirrors the server-side normalizeJid in messageParser.js.
// Prevents store key mismatches when JIDs arrive from different
// IPC events in different formats (@c.us, :device suffix, etc.)
// ════════════════════════════════════════════════════════════
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return ""
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid
  let user   = jid.slice(0, atIdx)
  let server = jid.slice(atIdx + 1)
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)
  if (server === "c.us") server = "s.whatsapp.net"
  return `${user}@${server}`
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

// [FIX-2] Resolve a quoted sender: raw JID → human-readable name
// DB stores quoted_sender as JID like "6285770017326@s.whatsapp.net"
// We want to show just the number or contact name, not the raw JID.
// [FIX-LID] @lid JIDs must be resolved — they look like "175784908046590@lid"
// [FIX-OWN] If sender JID matches our own JID, return null (caller shows "Kamu")
function resolveQuotedSender(sender, contacts, ownJid) {
  if (!sender) return null
  // If it's already a name (no @), return as-is
  if (!sender.includes("@")) return sender

  const atIdx  = sender.lastIndexOf("@")
  const user   = sender.slice(0, atIdx)
  const server = sender.slice(atIdx + 1)

  // [FIX-LID] @lid JIDs are opaque device identifiers — not meaningful to show
  // Try to resolve via contacts, otherwise show as unknown number
  const isLid = server === "lid"

  // [FIX-OWN] Check if this is our own JID
  if (ownJid) {
    const ownUser = ownJid.split("@")[0].split(":")[0]
    const senderUser = user.split(":")[0]
    if (ownUser === senderUser) return null // caller renders "Kamu"
  }

  // Try to find in contacts store — also try to match @lid via number
  if (contacts && contacts.length) {
    const cleanUser = user.split(":")[0]
    const c = contacts.find(c => {
      if (!c.jid) return false
      const cUser = c.jid.split("@")[0].split(":")[0]
      return cUser === cleanUser || c.number === cleanUser
    })
    if (c) return c.name || c.push_name || `+${cleanUser}`
  }

  // @lid with no contact match — show as unknown
  if (isLid) return null

  // Format number nicely: +628xxxx
  const cleanUser = user.split(":")[0]
  if (/^\d{6,}$/.test(cleanUser)) return `+${cleanUser}`
  return cleanUser
}
// [FIX-1] Normalize a DB row message — SQLite integers → JS types
function normalizeMsg(m, contacts, ownJid) {
  if (!m) return m
  return {
    ...m,
    from_me:          m.from_me         != null ? Number(m.from_me)         : 0,
    is_group:         m.is_group        != null ? Number(m.is_group)        : 0,
    is_forwarded:     m.is_forwarded    != null ? Number(m.is_forwarded)    : 0,
    is_ptt:           m.is_ptt          != null ? Number(m.is_ptt)          : 0,
    is_gif:           m.is_gif          != null ? Number(m.is_gif)          : 0,
    is_view_once:     m.is_view_once    != null ? Number(m.is_view_once)    : 0,
    is_animated:      m.is_animated     != null ? Number(m.is_animated)     : 0,
    has_media:        m.has_media       != null ? Number(m.has_media)       : 0,
    starred:          m.starred         != null ? Number(m.starred)         : 0,
    quoted_has_media: m.quoted_has_media!= null ? Number(m.quoted_has_media): 0,
    // Normalize media path
    media_saved_path: normalizeMediaPath(m.media_saved_path),
    // [FIX-2] Resolve quoted sender JID → display name
    // [FIX-OWN] Pass ownJid so we can detect "Kamu" (own message quoted)
    quoted_sender: resolveQuotedSender(m.quoted_sender, contacts, ownJid),
    // Parse JSON fields that may be strings from DB
    poll_options:   parseJson(m.poll_options, null),
    contacts_json:  parseJson(m.contacts_json, null),
    mentioned_jids: parseJson(m.mentioned_jids, []),
  }
}

function parseJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v !== "string") return v  // already parsed
  try { return JSON.parse(v) } catch { return fallback }
}

// ── normalizeMediaPath ────────────────────────────────────────────────────────
// IMPORTANT: Store raw paths as-is from SQLite. Do NOT convert to file:// here.
// Conversion to file:// URL happens exactly once in MessageBubble.pathToFileUrl()
// which correctly handles Windows drive letters, Unix paths, and already-encoded URLs.
// Pre-converting here caused D: → D%3A corruption on Windows.
function normalizeMediaPath(p) {
  if (!p) return null
  return p  // pass through raw — MessageBubble.pathToFileUrl handles conversion
}

// ════════════════════════════════════════════════════════════
// STORE
// ════════════════════════════════════════════════════════════

export const useChatStore = create((set, get) => ({
  // ── Chat list ───────────────────────────────────────────────────────────
  chats: [],
  chatsTotal: 0,
  chatsLoading: false,

  groups: [],
  groupsTotal: 0,

  communities: [],
  communitiesTotal: 0,

  // ── Messages ─────────────────────────────────────────────────────────────
  // Keyed by JID — only loaded chats are kept in memory
  messages: {},
  messagesLoading: false,

  // [FIX-3] Sequence counter per JID — cancel stale requests
  _seq: {},

  // [FIX-4] Active JID tracked here for auto-refresh
  activeJid: null,

  // ── Contacts ─────────────────────────────────────────────────────────────
  contacts: [],
  contactsTotal: 0,

  // ── Sync ─────────────────────────────────────────────────────────────────
  syncStatus: "idle",

  // ════════════════════════════════════════════════════════════
  // CHAT ACTIONS
  // ════════════════════════════════════════════════════════════

  setChats:        (chats, total) => set({ chats, chatsTotal: total }),
  setChatsLoading: (v)            => set({ chatsLoading: v }),
  setSyncStatus:   (v)            => set({ syncStatus: v }),

  loadChats: async () => {
    set({ chatsLoading: true })
    try {
      const result = await window.api?.dbChats?.({ limit: 100, offset: 0 })
      if (result?.ok) {
        const raw = result.data || []

        // [FIX-DEDUP] Deduplicate by jid before storing.
        // The DB query should never return duplicates (jid is PRIMARY KEY),
        // but defend against any gap in the migration window or future schema changes.
        // When duplicate jids appear, keep the one with the most recent timestamp.
        const byJid = {}
        for (const c of raw) {
          let jid = normalizeJid(c.jid)
          // [FIX-LID] Jika JID masih @lid, strip ke format angka saja agar
          // tidak double dengan entry @s.whatsapp.net dari kontak yang sama.
          // Kita TIDAK bisa resolve @lid di sini tanpa lidMap, jadi kita
          // simpan apa adanya tapi pastikan tidak ada duplikat string berbeda.
          if (!jid) continue
          const norm = { ...c, jid }
          const prev = byJid[jid]
          if (!prev || (norm.last_msg_at || 0) >= (prev.last_msg_at || 0)) {
            byJid[jid] = prev ? mergeChat(prev, norm) : norm
          }
        }
        const allChats    = Object.values(byJid)
          .filter(c => !c.is_community)
          .map(c => ({ ...c, from_me: c.from_me != null ? Number(c.from_me) : 0 }))
        const groups      = allChats.filter(c => c.is_group)
        const communities = Object.values(byJid).filter(c => c.is_community)

        set({
          chats:            allChats,
          chatsTotal:       result.total || allChats.length,
          groups,
          groupsTotal:      groups.length,
          communities,
          communitiesTotal: communities.length,
          chatsLoading:     false,
        })
      } else {
        set({ chatsLoading: false })
      }
    } catch (err) {
      console.error("[AuroraChat] loadChats error:", err)
      set({ chatsLoading: false })
    }
  },

  loadContacts: async () => {
    try {
      const result = await window.api?.dbContacts?.({ limit: 500, offset: 0 })
      if (result?.ok) {
        set({ contacts: result.data || [], contactsTotal: result.total || 0 })
      }
    } catch (err) {
      console.error("[AuroraChat] loadContacts error:", err)
    }
  },

  upsertChat: (chat) => set((s) => {
    // [FIX-SPLIT-CHAT] Normalize JID before any store operation
    const normalJid = normalizeJid(chat.jid)
    if (!normalJid) return s
    const normalizedChat = { ...chat, jid: normalJid }

    const idx = s.chats.findIndex(c => c.jid === normalJid)
    let newChats
    if (idx >= 0) {
      newChats = [...s.chats]
      // [FIX-DEDUP] Use mergeChat — never let undefined/null wipe existing name or pic.
      // Raw spread ({ ...old, ...new }) would set name=undefined if IPC payload
      // omits the name field, erasing the contact name from the chat list.
      newChats[idx] = mergeChat(newChats[idx], normalizedChat)
    } else {
      newChats = [normalizedChat, ...s.chats]
    }
    // [FIX-SORT] Pinned always first, then by timestamp (check both field names)
    const getTs = c => c.last_msg_at || c.last_message_timestamp || 0
    newChats = newChats.sort(
      (a, b) => (b.pinned - a.pinned) || (getTs(b) - getTs(a))
    )
    return { chats: newChats, groups: newChats.filter(c => c.is_group) }
  }),

  // ════════════════════════════════════════════════════════════
  // MESSAGE ACTIONS
  // ════════════════════════════════════════════════════════════

  // [FIX-4] Set active JID — called by ChatWindow on mount
  setActiveJid: (jid) => set({ activeJid: normalizeJid(jid) }),

  loadMessages: async (jid, limit = 50, offset = 0) => {
    if (!jid) return []
    // [FIX-SPLIT-CHAT] Normalize before using as store key and IPC arg
    const cleanJid = normalizeJid(jid)

    // [FIX-3] Increment sequence — any prior in-flight request for this JID
    // will see seq mismatch and discard its result (prevents chat mismatch)
    const seq = (get()._seq[cleanJid] || 0) + 1
    set(s => ({
      _seq:            { ...s._seq, [cleanJid]: seq },
      messagesLoading: true,
      messages:        { ...s.messages, [cleanJid]: [] },
    }))

    try {
      const result = await window.api?.dbMessages?.({ jid: cleanJid, limit, offset })

      if (get()._seq[cleanJid] !== seq) {
        console.log(`[AuroraChat] loadMessages stale for ${cleanJid}, discarding`)
        return []
      }

      if (result?.ok) {
        const contacts = get().contacts
        const ownJid = getOwnJid()
        const msgs = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts, ownJid))

        set(s => ({
          messages:        { ...s.messages, [cleanJid]: msgs },
          messagesLoading: false,
        }))
        return msgs
      }
    } catch (err) {
      console.error("[AuroraChat] loadMessages error:", err)
    }

    if (get()._seq[cleanJid] === seq) set({ messagesLoading: false })
    return []
  },

  // [FIX-4] Refresh active chat messages silently (no loading spinner)
  // Called when "db:chats:updated" fires and activeJid is set
  refreshActiveChat: async () => {
    const { activeJid, _seq, contacts } = get()
    if (!activeJid) return

    try {
      const result = await window.api?.dbMessages?.({ jid: activeJid, limit: 50, offset: 0 })
      if (!result?.ok) return

      // Check we're still on the same chat
      if (get().activeJid !== activeJid) return

      const ownJid = getOwnJid()
        const msgs = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts, ownJid))
      const existing = get().messages[activeJid] || []

      // Smart merge: only update if we got MORE messages or content changed
      if (msgs.length > existing.length || (msgs.length > 0 && msgs[msgs.length - 1]?.id !== existing[existing.length - 1]?.id)) {
        set(s => ({
          messages: { ...s.messages, [activeJid]: msgs },
        }))
      }
    } catch (err) {
      console.error("[AuroraChat] refreshActiveChat error:", err)
    }
  },

  setMessages: (jid, msgs) => set(s => {
    const cleanJid = normalizeJid(jid)
    if (!cleanJid) return s
    return { messages: { ...s.messages, [cleanJid]: msgs } }
  }),

  // [FIX-5] appendMessage — normalized + cross-chat dedup guard
  appendMessage: (jid, msg) => set((s) => {
    // [FIX-SPLIT-CHAT] Normalize store key — IPC may deliver different JID forms
    const cleanJid = normalizeJid(jid)
    if (!cleanJid) return s

    // Guard: don't append to wrong chat
    if (msg.chat_jid && normalizeJid(msg.chat_jid) !== cleanJid) return s

    const existing = s.messages[cleanJid] || []
    // Dedup by message ID
    if (existing.some(m => m.id === msg.id)) return s

    const contacts = s.contacts
    return {
      messages: {
        ...s.messages,
        [cleanJid]: [...existing, normalizeMsg(msg, contacts, getOwnJid())],
      }
    }
  }),

  setMessagesLoading: (v) => set({ messagesLoading: v }),

  // Update media_saved_path after download completes
  updateMessageMedia: ({ id, chat_jid, media_saved_path }) => set(s => {
    const cleanJid = normalizeJid(chat_jid)
    if (!cleanJid) return s
    const msgs = s.messages[cleanJid]
    if (!msgs) return s
    const idx = msgs.findIndex(m => m.id === id)
    if (idx < 0) return s
    const updated = [...msgs]
    updated[idx] = { ...updated[idx], media_saved_path: normalizeMediaPath(media_saved_path) }
    return { messages: { ...s.messages, [cleanJid]: updated } }
  }),

  // ── Contact actions ─────────────────────────────────────────────────────
  setContacts: (contacts, total) => set({ contacts, contactsTotal: total }),
}))