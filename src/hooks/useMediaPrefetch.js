// src/hooks/useMediaPrefetch.js
// ═══════════════════════════════════════════════════════════════════════════
// LIGHTSPEED MEDIA PREFETCH ENGINE
//
// Strategy:
//   1. When a ChatItem scrolls into view → queue that chat for background
//      media download (images, video, stickers, audio, docs)
//   2. When a chat is clicked → immediately fire prefetch (highest priority)
//   3. Global queue with concurrency limit — never hammers the main process
//   4. Dedup: never prefetch same JID twice per session
//   5. Rate-limit: scroll events coalesced with 300ms debounce per JID
//
// Architecture:
//   useMediaPrefetch()     → hook for ChatWindow (on-open instant prefetch)
//   useChatListPrefetch()  → hook for ChatList  (IntersectionObserver scroll)
//   prefetchChat(jid)      → standalone fire-and-forget call
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useCallback } from "react"

// ── Global prefetch state (shared across all hook instances) ─────────────────

// JIDs already prefetched this session — never re-request
const _prefetched = new Set()
// JIDs currently in-flight
const _inflight   = new Set()
// Pending queue (ordered by priority: click > scroll)
const _queue      = []
// Max concurrent IPC calls to main process
const MAX_CONCURRENT = 2
let   _running    = 0
// Scroll debounce timers per JID
const _debounce   = new Map()

// ── Queue processor ───────────────────────────────────────────────────────────

function _flush() {
  while (_running < MAX_CONCURRENT && _queue.length > 0) {
    const { jid, limit } = _queue.shift()
    if (_prefetched.has(jid) || _inflight.has(jid)) continue

    _inflight.add(jid)
    _running++

    window.api?.mediaPrefetch?.({ jid, limit })
      .then(() => {
        _prefetched.add(jid)
      })
      .catch(() => {
        // On error: allow retry next time (don't add to _prefetched)
      })
      .finally(() => {
        _inflight.delete(jid)
        _running--
        _flush() // process next in queue
      })
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * prefetchChat — fire-and-forget media prefetch for a chat JID.
 *
 * @param {string}  jid      - Chat JID to prefetch
 * @param {number}  limit    - Max messages to scan for pending media
 * @param {boolean} priority - If true, prepend to queue (click > scroll)
 */
export function prefetchChat(jid, limit = 20, priority = false) {
  if (!jid || !window.api?.mediaPrefetch) return
  if (_prefetched.has(jid) || _inflight.has(jid)) return

  // Dedup queue entries
  if (_queue.some(q => q.jid === jid)) return

  if (priority) {
    _queue.unshift({ jid, limit })
  } else {
    _queue.push({ jid, limit })
  }

  _flush()
}

/**
 * prefetchChatDebounced — scroll-safe prefetch: coalesces rapid scroll
 * events so a chat that flashes by doesn't trigger an IPC call.
 * Only fires if the JID stays visible for ≥300ms.
 *
 * @param {string} jid
 */
export function prefetchChatDebounced(jid, limit = 20) {
  if (!jid || _prefetched.has(jid) || _inflight.has(jid)) return

  // Clear existing debounce for this JID
  if (_debounce.has(jid)) {
    clearTimeout(_debounce.get(jid))
  }

  const timer = setTimeout(() => {
    _debounce.delete(jid)
    prefetchChat(jid, limit, false)
  }, 300)

  _debounce.set(jid, timer)
}

/**
 * cancelPrefetchDebounce — cancel a pending debounced prefetch.
 * Call when a ChatItem leaves the viewport before the timer fires.
 *
 * @param {string} jid
 */
export function cancelPrefetchDebounce(jid) {
  if (_debounce.has(jid)) {
    clearTimeout(_debounce.get(jid))
    _debounce.delete(jid)
  }
}

// ── Hook: useMediaPrefetch ────────────────────────────────────────────────────
// Use in ChatWindow — fires HIGH-PRIORITY prefetch when a chat is opened.
// This is the "click" path: user just opened a chat, prefetch its media NOW.

export function useMediaPrefetch(jid) {
  useEffect(() => {
    if (!jid) return
    // High priority: prepend to queue so it runs before any scroll-queued chats
    prefetchChat(jid, 30, true)
  }, [jid])
}

// ── Hook: useChatListPrefetch ─────────────────────────────────────────────────
// Returns a ref to attach to the scroll container.
// Uses a single shared IntersectionObserver for all ChatItems.
// Each observed element must have data-jid attribute.

export function useChatListPrefetch() {
  const observerRef = useRef(null)

  useEffect(() => {
    if (!window.api?.mediaPrefetch) return
    if (observerRef.current) return // already initialized

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const jid = entry.target.dataset?.jid
          if (!jid) continue

          if (entry.isIntersecting) {
            // Element entered viewport — debounce prefetch
            prefetchChatDebounced(jid, 20)
          } else {
            // Element left viewport before debounce fired — cancel
            cancelPrefetchDebounce(jid)
          }
        }
      },
      {
        // rootMargin: preload slightly outside the visible area
        // so media starts loading just before the user scrolls to it
        rootMargin: "200px 0px 200px 0px",
        threshold: 0,
      }
    )

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [])

  // Returns observe/unobserve functions for ChatItem to call
  const observe = useCallback((el) => {
    if (el && observerRef.current) observerRef.current.observe(el)
  }, [])

  const unobserve = useCallback((el) => {
    if (el && observerRef.current) observerRef.current.unobserve(el)
  }, [])

  return { observe, unobserve }
}
