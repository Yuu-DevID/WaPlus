import { create } from "zustand"

export const useChatStore = create((set, get) => ({
    // Chat list
    chats: [],
    chatsTotal: 0,
    chatsLoading: false,
    chatsPage: 0,

    // Groups list (subset of chats where is_group=1)
    groups: [],
    groupsTotal: 0,

    // Communities
    communities: [],
    communitiesTotal: 0,

    // Messages keyed by JID: { [jid]: Message[] }
    messages: {},
    messagesLoading: false,
    messagesPage: {},

    // Contacts
    contacts: [],
    contactsTotal: 0,

    // Progressive sync indicator: "idle" | "syncing" | "done"
    syncStatus: "idle",

    // ── Chat actions ────────────────────────────────
    setChats: (chats, total) => set({ chats, chatsTotal: total }),
    prependChats: (more) => set((s) => ({ chats: [...s.chats, ...more] })),
    setChatsLoading: (v) => set({ chatsLoading: v }),
    setSyncStatus: (v) => set({ syncStatus: v }),

    loadChats: async () => {
        set({ chatsLoading: true })
        try {
            // dbChats returns { ok, data, total }
            const result = await window.api?.dbChats?.({ limit: 100, offset: 0 })
            if (result?.ok) {
                const data = result.data || []
                const allChats = data.filter(c => !c.is_community)
                const groups = allChats.filter(c => c.is_group)
                const communities = data.filter(c => c.is_community)
                set({
                    chats: allChats,
                    chatsTotal: result.total || allChats.length,
                    groups,
                    groupsTotal: groups.length,
                    communities,
                    communitiesTotal: communities.length,
                    chatsLoading: false,
                })
            } else {
                set({ chatsLoading: false })
            }
        } catch (err) {
            console.error("Failed to load chats:", err)
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
            console.error("Failed to load contacts:", err)
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
        newChats = newChats.sort((a, b) => (b.pinned - a.pinned) || (b.last_msg_at - a.last_msg_at))
        const groups = newChats.filter(c => c.is_group)
        return { chats: newChats, groups }
    }),

    // ── Message actions ─────────────────────────────
    // _seq: counter per-JID untuk cancel request lama saat switch chat cepat
    _seq: {},

    loadMessages: async (jid, limit = 50, offset = 0) => {
        // Naikkan sequence untuk JID ini — request lama yang masih pending akan discard
        const seq = ((get()._seq[jid] || 0) + 1)
        set(s => ({ _seq: { ...s._seq, [jid]: seq }, messagesLoading: true }))

        try {
            const result = await window.api?.dbMessages?.({ jid, limit, offset })

            // Kalau sequence sudah berubah (user switch chat lagi), buang hasilnya
            if (get()._seq[jid] !== seq) return []

            if (result?.ok) {
                const msgs = (result.data || []).slice().reverse() // oldest first
                set((s) => ({
                    messages: { ...s.messages, [jid]: msgs },
                    messagesLoading: false,
                }))
                return msgs
            }
        } catch (err) {
            console.error("loadMessages error:", err)
        }

        // Hanya clear loading jika masih request yang sama
        if (get()._seq[jid] === seq) {
            set({ messagesLoading: false })
        }
        return []
    },

    setMessages: (jid, msgs) => set((s) => ({
        messages: { ...s.messages, [jid]: msgs }
    })),
    appendMessage: (jid, msg) => set((s) => {
        const existing = s.messages[jid] || []
        if (existing.some(m => m.id === msg.id)) return s
        return { messages: { ...s.messages, [jid]: [...existing, msg] } }
    }),
    setMessagesLoading: (v) => set({ messagesLoading: v }),

    // ── Contact actions ─────────────────────────────
    setContacts: (contacts, total) => set({ contacts, contactsTotal: total }),
}))