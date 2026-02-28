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
// [FIX-OWN] If sender JID matches our own JID, return "__me__" sentinel
function resolveQuotedSender(sender, contacts, ownJid) {
  if (!sender) return null
  // [FIX-DB-SELF] __self__ sentinel = DB detected this quoted msg was from_me=1
  if (sender === "__self__") return "__me__"
  // If it's already a name (no @), return as-is
  if (!sender.includes("@")) return sender

  const atIdx  = sender.lastIndexOf("@")
  const user   = sender.slice(0, atIdx)
  const server = sender.slice(atIdx + 1)

  // [FIX-LID] @lid JIDs are opaque device identifiers — not meaningful to show
  // Try to resolve via contacts, otherwise show as unknown number
  const isLid = server === "lid"

  // [FIX-OWN] Check if this is our own JID — return sentinel "__me__" (not null)
  // null means "unresolved/unknown", "__me__" means definitively our own message
  if (ownJid) {
    const ownUser    = ownJid.split("@")[0].split(":")[0]
    const senderUser = user.split(":")[0]
    if (ownUser === senderUser) return "__me__"
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
    // reactions are merged in separately via loadReactions() / updateReactions()
    reactions: m.reactions || [],
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
  channels: [],
  channelsTotal: 0,

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
  _backfillDone: false,

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
        const allRaw      = Object.values(byJid)
        const channels    = allRaw.filter(c => (c.jid || "").endsWith("@newsletter"))
        const allChats    = allRaw
          .filter(c => !c.is_community && !(c.jid || "").endsWith("@newsletter"))
          .map(c => ({ ...c, from_me: c.from_me != null ? Number(c.from_me) : 0 }))
        const groups      = allChats.filter(c => c.is_group)
        const communities = allRaw.filter(c => c.is_community)

        set({
          chats:            allChats,
          chatsTotal:       result.total || allChats.length,
          groups,
          groupsTotal:      groups.length,
          communities,
          communitiesTotal: communities.length,
          channels,
          channelsTotal:    channels.length,
          chatsLoading:     false,
        })

        // [FIX-HISTORY-PREVIEW] Jika ada chat tanpa last_message preview
        // (last_msg null — umum untuk history sync chats), trigger DB backfill
        // yang mengisi last_message_body dari tabel messages, lalu reload.
        // [FIX-BACKFILL-SPAM] Hanya backfill SEKALI per session — mencegah loop:
        // loadChats → backfill → db:chats:updated → loadChats → backfill → ...
        const hasBlankPreviews = allChats.some(c => !c.last_msg)
        const alreadyBackfilled = get()._backfillDone
        if (hasBlankPreviews && !alreadyBackfilled) {
          set({ _backfillDone: true })
          window.api?.dbBackfillPreviews?.().then(() => {
            window.api?.dbChats?.({ limit: 100, offset: 0 }).then(r2 => {
              if (!r2?.ok) return
              const raw2 = r2.data || []
              const byJid2 = {}
              for (const c of raw2) {
                const jid2 = normalizeJid(c.jid)
                if (!jid2) continue
                const norm2 = { ...c, jid: jid2 }
                const prev2 = byJid2[jid2]
                if (!prev2 || (norm2.last_msg_at || 0) >= (prev2.last_msg_at || 0)) {
                  byJid2[jid2] = prev2 ? mergeChat(prev2, norm2) : norm2
                }
              }
              const all2 = Object.values(byJid2)
                .filter(c => !c.is_community)
                .map(c => ({ ...c, from_me: c.from_me != null ? Number(c.from_me) : 0 }))
              const grp2 = all2.filter(c => c.is_group)
              const comm2 = Object.values(byJid2).filter(c => c.is_community)
              set({
                chats: all2, chatsTotal: r2.total || all2.length,
                groups: grp2, groupsTotal: grp2.length,
                communities: comm2, communitiesTotal: comm2.length,
              })
            }).catch(() => {})
          }).catch(() => {})
        }
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

    // [FIX-3] Sequence counter — only the LATEST call for a given JID wins.
    // IMPORTANT: do NOT clear messages[cleanJid] here — keep showing old messages
    // while the new fetch is in-flight. This prevents blank flash on chat switch.
    const seq = (get()._seq[cleanJid] || 0) + 1
    set(s => ({
      _seq:            { ...s._seq, [cleanJid]: seq },
      messagesLoading: true,
      // [FIX-BLANK-FLASH] Tidak clear messages di sini — tampilkan pesan lama
      // selama fetch berjalan. Blank flash terjadi karena clear ke [] lalu tunggu IPC.
    }))

    try {
      const result = await window.api?.dbMessages?.({ jid: cleanJid, limit, offset })

      if (get()._seq[cleanJid] !== seq) {
        console.log(`[AuroraChat] loadMessages stale for ${cleanJid} (seq=${seq}, current=${get()._seq[cleanJid]}) — returning cached`)
        return get().messages[cleanJid] || []
      }

      if (result?.ok) {
        const contacts = get().contacts
        const ownJid = getOwnJid()
        const msgs = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts, ownJid))
        console.log(`[AuroraChat] loadMessages OK for ${cleanJid}: ${msgs.length} msgs (offset=${offset})`)

        set(s => ({
          messages:        { ...s.messages, [cleanJid]: msgs },
          messagesLoading: false,
        }))
        return msgs
      } else {
        console.error(`[AuroraChat] loadMessages FAILED for ${cleanJid}:`, result)
      }
    } catch (err) {
      console.error("[AuroraChat] loadMessages error:", err)
    }

    if (get()._seq[cleanJid] === seq) set({ messagesLoading: false })
    console.warn(`[AuroraChat] loadMessages returning cached for ${cleanJid}`)
    return get().messages[cleanJid] || []
  },

  // [FIX-4] Refresh active chat messages silently (no loading spinner)
  // Called when "db:chats:updated" fires and activeJid is set.
  // Kept intentionally simple — complex guards caused switch-back blank screen bugs.
  refreshActiveChat: async () => {
    const { activeJid, contacts } = get()
    if (!activeJid) return
    const cleanJid = normalizeJid(activeJid)
    if (!cleanJid) return

    try {
      const result = await window.api?.dbMessages?.({ jid: cleanJid, limit: 50, offset: 0 })
      if (!result?.ok) return

      // Guard: bail if user switched away while IPC was in-flight
      if (normalizeJid(get().activeJid) !== cleanJid) return

      const ownJid = getOwnJid()
      const msgs    = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts, ownJid))
      const existing = get().messages[cleanJid] || []

      // [FIX-PAGINATE] Jika user sudah scroll up dan load lebih dari 50 msgs,
      // jangan wipe scroll position — hanya append pesan baru di tail.
      if (existing.length > msgs.length) {
        const existingIds = new Set(existing.map(m => m.id))
        const newTail = msgs.filter(m => !existingIds.has(m.id))
        if (newTail.length > 0) {
          set(s => ({
            messages: { ...s.messages, [cleanJid]: [...(s.messages[cleanJid] || []), ...newTail] }
          }))
        }
        return
      }

      // Normal case: update hanya jika ada perubahan
      if (msgs.length > 0 && (
        msgs.length !== existing.length ||
        msgs[msgs.length - 1]?.id !== existing[existing.length - 1]?.id
      )) {
        set(s => ({
          messages: { ...s.messages, [cleanJid]: msgs },
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

  // [FIX-SCROLL] Prepend older messages saat user scroll ke atas (pagination)
  prependMessages: async (jid, limit = 30, offset = 0) => {
    if (!jid) return []
    const cleanJid = normalizeJid(jid)
    try {
      const result = await window.api?.dbMessages?.({ jid: cleanJid, limit, offset })
      if (!result?.ok) return []
      const contacts = useChatStore.getState().contacts
      const ownJid = getOwnJid()
      const older = (result.data || []).slice().reverse().map(m => normalizeMsg(m, contacts, ownJid))
      const existing = useChatStore.getState().messages[cleanJid] || []
      // Dedup by id
      const existingIds = new Set(existing.map(m => m.id))
      const newMsgs = older.filter(m => !existingIds.has(m.id))
      if (newMsgs.length > 0) {
        set(s => ({
          messages: { ...s.messages, [cleanJid]: [...newMsgs, ...(s.messages[cleanJid] || [])] }
        }))
      }
      return newMsgs
    } catch (err) {
      console.error("[AuroraChat] prependMessages error:", err)
      return []
    }
  },

  // [FIX-REACTIONS] Load semua reactions untuk chat dan merge ke message objects.
  // Dipanggil setelah loadMessages() — query terpisah agar tidak block tampilan pesan.
  loadReactions: async (jid) => {
    if (!jid || !window.api?.dbReactions) return
    const cleanJid = normalizeJid(jid)
    try {
      const result = await window.api.dbReactions({ jid: cleanJid })
      if (!result?.ok || !result.data?.length) return

      // Group by target message id: { [msgId]: [{text, sender_jid}] }
      const byTarget = {}
      for (const r of result.data) {
        if (!r.reaction_target_id || !r.text) continue
        if (!byTarget[r.reaction_target_id]) byTarget[r.reaction_target_id] = []
        // Deduplicate same sender (keep last)
        const existing = byTarget[r.reaction_target_id]
        const idx = existing.findIndex(x => x.sender === r.sender_jid)
        if (idx >= 0) existing.splice(idx, 1)
        existing.push({ text: r.text, sender: r.sender_jid })
      }

      set(s => {
        const msgs = s.messages[cleanJid]
        if (!msgs?.length) return s
        const updated = msgs.map(m => {
          const reactions = byTarget[m.id]
          if (!reactions) return m
          return { ...m, reactions }
        })
        return { messages: { ...s.messages, [cleanJid]: updated } }
      })
    } catch (err) {
      console.error("[AuroraChat] loadReactions error:", err)
    }
  },

  // [FIX-REACTIONS] Update reactions array pada pesan tertentu
  // Dipanggil saat messages:reaction IPC masuk
  updateReactions: (chatJid, targetMsgId, reactorJid, emoji) => set((s) => {
    const cleanJid = normalizeJid(chatJid)
    if (!cleanJid) return s
    const msgs = s.messages[cleanJid]
    if (!msgs) return s
    const idx = msgs.findIndex(m => m.id === targetMsgId)
    if (idx < 0) return s

    const updated = [...msgs]
    const msg = { ...updated[idx] }
    const reactions = [...(msg.reactions || [])]

    // Remove existing reaction dari sender yang sama
    const existingIdx = reactions.findIndex(r => r.sender === reactorJid)
    if (existingIdx >= 0) reactions.splice(existingIdx, 1)

    // Add new reaction (empty emoji = unreact)
    if (emoji) reactions.push({ text: emoji, sender: reactorJid })

    msg.reactions = reactions
    updated[idx] = msg
    return { messages: { ...s.messages, [cleanJid]: updated } }
  }),

  // ── Contact actions ─────────────────────────────────────────────────────
  setContacts: (contacts, total) => set({ contacts, contactsTotal: total }),
}))