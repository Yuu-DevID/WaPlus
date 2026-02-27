// src/store/chat.js
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v3 — AuroraChat Chat Store
//
// FIXES:
// [FIX-1] normalizeMsg() — SQLite 0/1 integers → proper types
// [FIX-2] normalizeQuotedSender() — strip @s.whatsapp.net from JIDs,
//         show display name instead of raw JID in reply preview
// [FIX-3] Chat isolation — loadMessages() cancels stale requests via seq
//         AND clears previous chat messages immediately on switch to prevent
//         stale messages from prior chat bleeding into new chat view
// [FIX-4] Auto-refresh — activeJid tracked in store, "db:chats:updated"
//         event triggers reload of active chat messages automatically
// [FIX-5] appendMessage dedup — also dedup by chat_jid to prevent
//         cross-chat contamination from IPC events
// ═══════════════════════════════════════════════════════════════════════════

import { create } from "zustand"

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

// [FIX-2] Resolve a quoted sender: raw JID → human-readable name
// DB stores quoted_sender as JID like "6285770017326@s.whatsapp.net"
// We want to show just the number or contact name, not the raw JID.
function resolveQuotedSender(sender, contacts) {
  if (!sender) return null
  // If it's already a name (no @), return as-is
  if (!sender.includes("@")) return sender
  // Strip @domain
  const number = sender.split("@")[0]
  // Try to find in contacts store
  if (contacts && contacts.length) {
    const c = contacts.find(c => c.jid === sender || c.number === number || (c.jid || "").startsWith(number))
    if (c) return c.name || c.push_name || `+${number}`
  }
  // Format number nicely: +628xxxx
  if (/^\d{6,}$/.test(number)) return `+${number}`
  return number
}

// [FIX-1] Normalize a DB row message — SQLite integers → JS types
function normalizeMsg(m, contacts) {
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
    quoted_sender: resolveQuotedSender(m.quoted_sender, contacts),
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

function normalizeMediaPath(p) {
  if (!p) return null
  if (p.startsWith("file://")) return p
  const forward = p.replace(/\\/g, "/")
  return `file://${forward.startsWith("/") ? "" : "/"}${forward}`
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
        const data        = result.data || []
        const allChats    = data.filter(c => !c.is_community)
        const groups      = allChats.filter(c => c.is_group)
        const communities = data.filter(c => c.is_community)
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
    const idx = s.chats.findIndex(c => c.jid === chat.jid)
    let newChats
    if (idx >= 0) {
      newChats = [...s.chats]
      newChats[idx] = { ...newChats[idx], ...chat }
    } else {
      newChats = [chat, ...s.chats]
    }
    newChats = newChats.sort(
      (a, b) => (b.pinned - a.pinned) || (b.last_msg_at - a.last_msg_at)
    )
    return { chats: newChats, groups: newChats.filter(c => c.is_group) }
  }),

  // ════════════════════════════════════════════════════════════
  // MESSAGE ACTIONS
  // ════════════════════════════════════════════════════════════

  // [FIX-4] Set active JID — called by ChatWindow on mount
  setActiveJid: (jid) => set({ activeJid: jid }),

  loadMessages: async (jid, limit = 50, offset = 0) => {
    if (!jid) return []

    // [FIX-3] Increment sequence — any prior in-flight request for this JID
    // will see seq mismatch and discard its result (prevents chat mismatch)
    const seq = (get()._seq[jid] || 0) + 1
    set(s => ({
      _seq:            { ...s._seq, [jid]: seq },
      messagesLoading: true,
      // [FIX-3] Clear immediately so stale messages don't show while loading
      messages:        { ...s.messages, [jid]: [] },
    }))

    try {
      const result = await window.api?.dbMessages?.({ jid, limit, offset })

      // [FIX-3] Stale — another loadMessages() was called for same JID
      if (get()._seq[jid] !== seq) {
        console.log(`[AuroraChat] loadMessages stale for ${jid}, discarding`)
        return []
      }

      if (result?.ok) {
        const contacts = get().contacts
        // Reverse: DB returns newest first, we want oldest first
        const msgs = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts))

        set(s => ({
          messages:        { ...s.messages, [jid]: msgs },
          messagesLoading: false,
        }))
        return msgs
      }
    } catch (err) {
      console.error("[AuroraChat] loadMessages error:", err)
    }

    if (get()._seq[jid] === seq) set({ messagesLoading: false })
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

      const msgs = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts))
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

  setMessages: (jid, msgs) => set(s => ({
    messages: { ...s.messages, [jid]: msgs }
  })),

  // [FIX-5] appendMessage — normalized + cross-chat dedup guard
  appendMessage: (jid, msg) => set((s) => {
    // Guard: don't append to wrong chat
    if (msg.chat_jid && msg.chat_jid !== jid) return s

    const existing = s.messages[jid] || []
    // Dedup by message ID
    if (existing.some(m => m.id === msg.id)) return s

    const contacts = s.contacts
    return {
      messages: {
        ...s.messages,
        [jid]: [...existing, normalizeMsg(msg, contacts)],
      }
    }
  }),

  setMessagesLoading: (v) => set({ messagesLoading: v }),

  // Update media_saved_path after download completes
  updateMessageMedia: ({ id, chat_jid, media_saved_path }) => set(s => {
    const msgs = s.messages[chat_jid]
    if (!msgs) return s
    const idx = msgs.findIndex(m => m.id === id)
    if (idx < 0) return s
    const updated = [...msgs]
    updated[idx] = { ...updated[idx], media_saved_path: normalizeMediaPath(media_saved_path) }
    return { messages: { ...s.messages, [chat_jid]: updated } }
  }),

  // ── Contact actions ─────────────────────────────────────────────────────
  setContacts: (contacts, total) => set({ contacts, contactsTotal: total }),
}))