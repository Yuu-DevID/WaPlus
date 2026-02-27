// electron/baileys/database.js
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE — All bugs fixed
//
// CHANGELOG:
// [FIX-1]  DB_PATH hardcoded ke __dirname → pakai app.getPath('userData')
// [FIX-2]  insertMessage() tidak ada di database object → ditambahkan
// [FIX-3]  getMessages() → getMessagesByJid.all(jid, {limit,offset}) — named
//          params tapi statement pakai @limit/@offset → semua diubah ke positional
// [FIX-4]  getChats() sama masalah named vs positional → fix positional
// [FIX-5]  getContacts() sama → fix positional
// [FIX-6]  searchMessages() pakai {jid,query} object → fix positional
// [FIX-7]  searchContacts() pakai {query} object → fix positional 4-param
// [FIX-8]  saveContacts()/bulkUpsertContacts() panggil database.saveContact()
//          sebelum `database` selesai defined → ReferenceError → fix closure
// [FIX-9]  savePollVote() INSERT ke kolom salah (message_id/sender_jid/vote)
//          → sesuaikan ke schema (poll_message_id/voter_jid/selected_options)
// [FIX-10] startSync()/endSync() pakai updateSyncStatus.run({...}) dengan
//          null fields tidak aman → pisah jadi 2 statement dedicated
// [FIX-11] getMessagesFromDB() alias diperbaiki ikut positional params
// [FIX-12] `module.exports = database` tapi database tidak dideklarasi
//          sebagai variable — semua API tercampur di dalam `statements`
//          → pisah `statements` (SQLite) dari `database` (public API)
// [FIX-13] saveChat() INSERT OR REPLACE menghapus unread_count/pinned dll
//          → ganti ke UPSERT (INSERT ... ON CONFLICT DO UPDATE SET)
// [FIX-14] Performance pragmas tidak lengkap → tambah cache_size/temp_store/mmap
// [FIX-15] Tidak ada schema migration → kolom baru crash install lama
//          → tambah schema_version + auto-migration
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// [FIX-SPLIT-CHAT] Import single JID normalization gate
// All JIDs must pass through this before touching the DB
const { normalizeJid } = require('./messageParser');

// ════════════════════════════════════════════════════════════
// [FIX-1] DB PATH — persisten di production Electron build
// ════════════════════════════════════════════════════════════

function getDbPath() {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'aurora_chat.db');
    } catch {
        // Fallback dev/test
        const dir = path.resolve(__dirname, './database');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, 'aurora_chat.db');
    }
}

const DB_PATH = getDbPath();
const DB_DIR  = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// [FIX-14] Performance pragmas lengkap
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -32000');     // 32 MB cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');   // 256 MB mmap

// ════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════

db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        from_me INTEGER NOT NULL DEFAULT 0,
        participant TEXT,
        push_name TEXT,
        message_type TEXT NOT NULL DEFAULT 'conversation',
        body TEXT,
        message_json TEXT,

        -- Media metadata
        media_mimetype TEXT,
        media_file_name TEXT,
        media_file_length INTEGER,
        media_duration INTEGER,
        media_height INTEGER,
        media_width INTEGER,
        media_caption TEXT,
        media_key TEXT,
        media_direct_path TEXT,
        media_url TEXT,
        media_sha256 TEXT,
        media_enc_sha256 TEXT,
        media_saved_path TEXT,
        media_is_downloaded INTEGER NOT NULL DEFAULT 0,

        -- Extra media flags (v2)
        is_ptt INTEGER NOT NULL DEFAULT 0,
        is_gif INTEGER NOT NULL DEFAULT 0,
        is_view_once INTEGER NOT NULL DEFAULT 0,
        is_animated INTEGER NOT NULL DEFAULT 0,

        -- Context / Reply
        context_stanza_id TEXT,
        context_participant TEXT,
        context_quoted_message TEXT,
        context_mentioned_jids TEXT,
        context_is_forwarded INTEGER NOT NULL DEFAULT 0,
        context_forwarding_score INTEGER NOT NULL DEFAULT 0,

        -- Reaction
        reaction_text TEXT,
        reaction_target_id TEXT,
        reaction_target_remote_jid TEXT,
        reaction_target_from_me INTEGER,

        -- Poll
        poll_name TEXT,
        poll_options TEXT,
        poll_selectable_count INTEGER,
        poll_votes TEXT,

        -- Location
        location_lat REAL,
        location_lng REAL,
        location_name TEXT,
        location_address TEXT,
        location_accuracy INTEGER,

        -- Contact
        contact_vcard TEXT,
        contact_display_name TEXT,

        -- Group (legacy)
        group_subject TEXT,
        group_description TEXT,
        group_participants TEXT,

        -- Ephemeral
        ephemeral_expiration INTEGER,
        ephemeral_setting_timestamp INTEGER,

        -- Protocol
        protocol_type INTEGER,
        protocol_key_id TEXT,

        -- Status
        status INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        broadcast INTEGER NOT NULL DEFAULT 0,
        is_history_sync INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        sync_type TEXT,

        -- Timestamps
        message_timestamp INTEGER NOT NULL DEFAULT 0,
        edited_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_remote_jid     ON messages(remote_jid, message_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp      ON messages(message_timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_type           ON messages(message_type);
    CREATE INDEX IF NOT EXISTS idx_messages_history_sync   ON messages(is_history_sync);
    CREATE INDEX IF NOT EXISTS idx_messages_reaction_target ON messages(reaction_target_id);
    CREATE INDEX IF NOT EXISTS idx_messages_protocol       ON messages(protocol_type);
    CREATE INDEX IF NOT EXISTS idx_messages_media_pending  ON messages(media_is_downloaded) WHERE media_is_downloaded = 0;
    CREATE INDEX IF NOT EXISTS idx_messages_starred        ON messages(starred) WHERE starred = 1;

    CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        is_community INTEGER NOT NULL DEFAULT 0,
        community_jid TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_timestamp INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT,
        last_message_body TEXT,
        last_message_type TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        muted_until INTEGER NOT NULL DEFAULT 0,
        profile_pic_url TEXT,
        status TEXT,
        presence TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chats_order   ON chats(pinned DESC, last_message_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_group   ON chats(is_group);
    CREATE INDEX IF NOT EXISTS idx_chats_comm    ON chats(is_community);

    CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        push_name TEXT,
        short_name TEXT,
        number TEXT,
        status TEXT,
        profile_pic_url TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        is_user INTEGER NOT NULL DEFAULT 0,
        is_business INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

    CREATE TABLE IF NOT EXISTS media_downloads (
        message_id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL DEFAULT '',
        media_type TEXT NOT NULL DEFAULT '',
        original_url TEXT,
        local_path TEXT,
        file_size INTEGER,
        download_status TEXT NOT NULL DEFAULT 'pending',
        download_attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        downloaded_at DATETIME,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_dl_status ON media_downloads(download_status);

    -- [FIX-9] Kolom yang benar sesuai savePollVote()
    CREATE TABLE IF NOT EXISTS poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_message_id TEXT NOT NULL,
        voter_jid TEXT NOT NULL,
        selected_options TEXT,
        voted_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(poll_message_id, voter_jid),
        FOREIGN KEY (poll_message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_message_id TEXT NOT NULL,
        original_body TEXT,
        edited_body TEXT,
        edited_timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (original_message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_syncing INTEGER NOT NULL DEFAULT 0,
        sync_started_at DATETIME,
        sync_completed_at DATETIME,
        total_chats INTEGER NOT NULL DEFAULT 0,
        total_messages INTEGER NOT NULL DEFAULT 0,
        last_sync_timestamp INTEGER
    );
    INSERT OR IGNORE INTO sync_status (id) VALUES (1);

    -- [FIX-15] Schema versioning
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
    );
`);

// ════════════════════════════════════════════════════════════
// [FIX-15] AUTO MIGRATION
// ════════════════════════════════════════════════════════════

const DB_VERSION = 7;

function runMigrations() {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    const current = row?.v || 0;
    if (current >= DB_VERSION) return;

    console.log(`[AuroraDB] Migrating schema v${current} → v${DB_VERSION}`);

    const migrations = {
        1: () => { /* initial */ },
        2: () => {
            const cols = db.pragma('table_info(messages)').map(c => c.name);
            if (!cols.includes('is_ptt'))       db.exec('ALTER TABLE messages ADD COLUMN is_ptt INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_gif'))       db.exec('ALTER TABLE messages ADD COLUMN is_gif INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_view_once')) db.exec('ALTER TABLE messages ADD COLUMN is_view_once INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_animated'))  db.exec('ALTER TABLE messages ADD COLUMN is_animated INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_deleted'))   db.exec('ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('edited_at'))    db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');

            const chatCols = db.pragma('table_info(chats)').map(c => c.name);
            if (!chatCols.includes('community_jid'))      db.exec('ALTER TABLE chats ADD COLUMN community_jid TEXT');
            if (!chatCols.includes('last_message_type'))  db.exec('ALTER TABLE chats ADD COLUMN last_message_type TEXT');
            if (!chatCols.includes('muted_until'))        db.exec("ALTER TABLE chats ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0");
        },
        3: () => {
            const pvcols = db.pragma('table_info(poll_votes)').map(c => c.name);
            if (pvcols.includes('message_id') && !pvcols.includes('poll_message_id')) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS poll_votes_v3 (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        poll_message_id TEXT NOT NULL,
                        voter_jid TEXT NOT NULL,
                        selected_options TEXT,
                        voted_at INTEGER NOT NULL DEFAULT (unixepoch()),
                        UNIQUE(poll_message_id, voter_jid)
                    );
                    INSERT OR IGNORE INTO poll_votes_v3 (id, poll_message_id, voter_jid, selected_options, voted_at)
                        SELECT id,
                               COALESCE(poll_message_id, message_id),
                               COALESCE(voter_jid, sender_jid),
                               COALESCE(selected_options, vote),
                               COALESCE(voted_at, timestamp, unixepoch())
                        FROM poll_votes;
                    DROP TABLE poll_votes;
                    ALTER TABLE poll_votes_v3 RENAME TO poll_votes;
                `);
            }
        },

        // ── v4: FIX SPLIT-CHAT — normalize @c.us and :device JIDs in existing data ──
        4: () => {
            console.log('[AuroraDB] v4: Merging split-chat rows (@c.us → @s.whatsapp.net)...');

            // Helper: canonical form of a raw JID string (SQL-level)
            // We do this in JS because SQLite has no regex replace built in.

            // 1. Find all @c.us rows in messages and remap to @s.whatsapp.net
            const legacyMsgJids = db.prepare(`
                SELECT DISTINCT remote_jid FROM messages WHERE remote_jid LIKE '%@c.us'
            `).all().map(r => r.remote_jid);

            for (const oldJid of legacyMsgJids) {
                const newJid = oldJid.replace('@c.us', '@s.whatsapp.net');
                // Move messages to canonical JID
                db.prepare(`UPDATE messages SET remote_jid = ? WHERE remote_jid = ?`).run(newJid, oldJid);
                // Ensure the canonical chat row exists
                db.prepare(`
                    INSERT OR IGNORE INTO chats (jid, is_group, last_message_timestamp)
                    VALUES (?, 0, 0)
                `).run(newJid);
                // Merge old @c.us chat row data into canonical row (take the better values)
                db.prepare(`
                    UPDATE chats SET
                        name                   = COALESCE(name, (SELECT name FROM chats WHERE jid = ?)),
                        unread_count           = MAX(unread_count, (SELECT unread_count FROM chats WHERE jid = ?)),
                        last_message_timestamp = MAX(last_message_timestamp, (SELECT last_message_timestamp FROM chats WHERE jid = ?)),
                        last_message_id        = COALESCE(last_message_id, (SELECT last_message_id FROM chats WHERE jid = ?)),
                        last_message_body      = COALESCE(last_message_body, (SELECT last_message_body FROM chats WHERE jid = ?)),
                        pinned                 = MAX(pinned, (SELECT COALESCE(pinned,0) FROM chats WHERE jid = ?)),
                        profile_pic_url        = COALESCE(profile_pic_url, (SELECT profile_pic_url FROM chats WHERE jid = ?))
                    WHERE jid = ?
                `).run(oldJid, oldJid, oldJid, oldJid, oldJid, oldJid, oldJid, newJid);
                // Delete the old @c.us orphan row
                db.prepare(`DELETE FROM chats WHERE jid = ?`).run(oldJid);
            }

            // 2. Find all @c.us rows in contacts and remap
            const legacyContactJids = db.prepare(`
                SELECT DISTINCT jid FROM contacts WHERE jid LIKE '%@c.us'
            `).all().map(r => r.jid);

            for (const oldJid of legacyContactJids) {
                const newJid = oldJid.replace('@c.us', '@s.whatsapp.net');
                // Merge into canonical contact row
                db.prepare(`
                    INSERT INTO contacts (jid, name, push_name, short_name, number, profile_pic_url, is_user)
                    SELECT ?, name, push_name, short_name, number, profile_pic_url, is_user
                    FROM contacts WHERE jid = ?
                    ON CONFLICT(jid) DO UPDATE SET
                        name            = COALESCE(excluded.name, contacts.name),
                        push_name       = COALESCE(excluded.push_name, contacts.push_name),
                        profile_pic_url = COALESCE(excluded.profile_pic_url, contacts.profile_pic_url)
                `).run(newJid, oldJid);
                db.prepare(`DELETE FROM contacts WHERE jid = ?`).run(oldJid);
            }

            // 3. Strip :device suffix from JIDs in messages.participant
            // e.g. "6281234:5@s.whatsapp.net" → "6281234@s.whatsapp.net"
            // SQLite doesn't have regex, so we fetch and update in JS
            const deviceSuffixRows = db.prepare(`
                SELECT DISTINCT participant FROM messages
                WHERE participant LIKE '%:%@%'
            `).all();

            const stripDevice = db.prepare(`UPDATE messages SET participant = ? WHERE participant = ?`);
            for (const { participant } of deviceSuffixRows) {
                if (!participant) continue;
                const [user, server] = participant.split('@');
                const cleanUser = user.split(':')[0];
                const cleanJid = `${cleanUser}@${server}`;
                if (cleanJid !== participant) stripDevice.run(cleanJid, participant);
            }

            const affected = legacyMsgJids.length + legacyContactJids.length + deviceSuffixRows.length;
            console.log(`[AuroraDB] v4 complete: fixed ${affected} split-chat entries`);
        },

        // ── v5: FIX-DEDUP-NAME — Bersihkan chats.name untuk DM yang terisi push_name ──
        5: () => {
            console.log('[AuroraDB] v5: Cleaning DM chats.name push_name pollution...');

            // 1. Pindahkan chats.name DM ke contacts.push_name (jaga data tetap ada)
            //    Lalu null-kan chats.name untuk DM supaya getChats COALESCE jatuh ke
            //    contacts.name (phonebook) dengan benar.
            //
            // Hanya DM (bukan group, bukan community) yang terdampak.
            const dmChatsWithName = db.prepare(`
                SELECT jid, name FROM chats
                WHERE is_group = 0
                  AND is_community = 0
                  AND name IS NOT NULL
                  AND name != ''
            `).all();

            const upsertPN = db.prepare(`
                INSERT INTO contacts (jid, push_name, number, is_user, is_group)
                VALUES (?, ?, ?, 1, 0)
                ON CONFLICT(jid) DO UPDATE SET
                    push_name = CASE
                        WHEN contacts.push_name IS NULL THEN excluded.push_name
                        WHEN contacts.name IS NOT NULL THEN contacts.push_name
                        ELSE excluded.push_name
                    END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE excluded.push_name IS NOT NULL
            `);

            const nullifyDMName = db.prepare(`
                UPDATE chats SET name = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE jid = ? AND is_group = 0 AND is_community = 0
            `);

            db.transaction(() => {
                for (const { jid, name } of dmChatsWithName) {
                    const number = jid.split('@')[0] || null;
                    // Simpan ke contacts.push_name (fallback kalau tidak ada di phonebook)
                    upsertPN.run(jid, name, number);
                    // Null-kan chats.name supaya phonebook name bisa muncul
                    nullifyDMName.run(jid);
                }
            })();

            console.log(`[AuroraDB] v5 complete: cleaned ${dmChatsWithName.length} DM chat names`);

            // 2. One-time dedup: merge rows yang mungkin double karena push_name vs phonebook name
            //    Tidak ada dedup yang dibutuhkan di DB level karena PRIMARY KEY = jid sudah unique.
            //    Duplikasi visual sudah fixed dengan COALESCE fix di getChats.
        },

        // ── v6: FIX-PREVIEW — Backfill last_message_body/type from messages table ──
        // Fixes chats where saveChat() stored last_message_body: null during history sync.
        // Without this, chat list preview is blank until user sends/receives a new message.
        6: () => {
            console.log('[AuroraDB] v6: Backfilling chat last_message_body from messages table...');
            const result = db.prepare(`
                UPDATE chats
                SET
                    last_message_body = (
                        SELECT COALESCE(body, '[' || message_type || ']')
                        FROM messages
                        WHERE id = chats.last_message_id
                        LIMIT 1
                    ),
                    last_message_type = COALESCE(
                        last_message_type,
                        (SELECT message_type FROM messages WHERE id = chats.last_message_id LIMIT 1)
                    ),
                    updated_at = CURRENT_TIMESTAMP
                WHERE last_message_id IS NOT NULL
                  AND (last_message_body IS NULL OR last_message_body = '')
            `).run();
            console.log(`[AuroraDB] v6 complete: updated ${result.changes} chat preview rows`);
        },

        // v7: Fix broken media_saved_path from old normalizeMediaPath bug.
        // Old code encoded "D:\path" as "file:///D%3A/path" (colon encoded).
        // New code stores raw paths ("D:\path") and converts correctly in the renderer.
        // This migration strips the broken file:// prefix so raw paths are stored.
        7: () => {
            // Find all messages with a broken file:///X%3A/ path
            const broken = db.prepare(`
                SELECT id, media_saved_path FROM messages
                WHERE media_saved_path IS NOT NULL
                  AND (media_saved_path LIKE 'file:///%3A/%'
                    OR media_saved_path LIKE 'file:///%3a/%')
            `).all();
            const fix = db.prepare(`UPDATE messages SET media_saved_path = ? WHERE id = ?`);
            let fixed = 0;
            for (const row of broken) {
                try {
                    // Decode the broken URL back to a usable raw path
                    // e.g. "file:///D%3A/path/file.webp" → "D:/path/file.webp"
                    let raw = row.media_saved_path
                        .replace(/^file:\/\/\//i, '')   // strip file:///
                        .replace(/%3A/gi, ':')           // D%3A → D:
                        .replace(/%20/g, ' ')            // spaces
                        .replace(/%2F/gi, '/')           // slashes (shouldn't happen but be safe)
                    // Decode any remaining percent-encoding
                    try { raw = decodeURIComponent(raw) } catch (_) {}
                    fix.run(raw, row.id);
                    fixed++;
                } catch (_) {}
            }
            console.log(`[AuroraDB] v7 complete: fixed ${fixed} broken media paths`);
        },
    };

    db.transaction(() => {
        for (let v = current + 1; v <= DB_VERSION; v++) {
            try {
                if (migrations[v]) migrations[v]();
                db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v);
                console.log(`[AuroraDB] Migration v${v} ✓`);
            } catch (err) {
                console.error(`[AuroraDB] Migration v${v} FAILED:`, err.message);
                throw err;
            }
        }
    })();
}

runMigrations();

// ════════════════════════════════════════════════════════════
// PREPARED STATEMENTS
// [FIX-3,4,5,6,7] Semua diubah ke POSITIONAL params
// ════════════════════════════════════════════════════════════

const statements = {

    // ── Messages ─────────────────────────────────────────────────────────────
    insertMessage: db.prepare(`
        INSERT OR IGNORE INTO messages (
            id, remote_jid, from_me, participant, push_name, message_type, body,
            message_json, media_mimetype, media_file_name, media_file_length,
            media_duration, media_height, media_width, media_caption, media_key,
            media_direct_path, media_url, media_sha256, media_enc_sha256,
            is_ptt, is_gif, is_view_once, is_animated,
            context_stanza_id, context_participant, context_quoted_message,
            context_mentioned_jids, context_is_forwarded, context_forwarding_score,
            reaction_text, reaction_target_id, reaction_target_remote_jid, reaction_target_from_me,
            poll_name, poll_options, poll_selectable_count, poll_votes,
            location_lat, location_lng, location_name, location_address, location_accuracy,
            contact_vcard, contact_display_name,
            protocol_type, protocol_key_id,
            status, starred, broadcast, is_history_sync, sync_type,
            message_timestamp
        ) VALUES (
            @id, @remote_jid, @from_me, @participant, @push_name, @message_type, @body,
            @message_json, @media_mimetype, @media_file_name, @media_file_length,
            @media_duration, @media_height, @media_width, @media_caption, @media_key,
            @media_direct_path, @media_url, @media_sha256, @media_enc_sha256,
            @is_ptt, @is_gif, @is_view_once, @is_animated,
            @context_stanza_id, @context_participant, @context_quoted_message,
            @context_mentioned_jids, @context_is_forwarded, @context_forwarding_score,
            @reaction_text, @reaction_target_id, @reaction_target_remote_jid, @reaction_target_from_me,
            @poll_name, @poll_options, @poll_selectable_count, @poll_votes,
            @location_lat, @location_lng, @location_name, @location_address, @location_accuracy,
            @contact_vcard, @contact_display_name,
            @protocol_type, @protocol_key_id,
            @status, @starred, @broadcast, @is_history_sync, @sync_type,
            @message_timestamp
        )
    `),

    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),

    // [FIX-3] Ganti @limit/@offset → positional ? ?
    getMessagesByJid: db.prepare(`
        SELECT
            msg.id,
            msg.remote_jid              AS chat_jid,
            msg.from_me,
            msg.participant             AS sender_jid,
            -- [FIX-SENDER-NAME] For group msgs: prefer phonebook name > push_name
            -- For DM from_me=1: c is NULL (participant=NULL), so sender_name = push_name = ours
            -- For DM from_me=0: c.name = their phonebook name
            COALESCE(c.name, c.push_name, msg.push_name) AS sender_name,
            msg.message_type            AS msg_type,
            msg.body,
            msg.message_timestamp       AS timestamp,
            msg.status, msg.starred, msg.broadcast,
            msg.is_history_sync,
            msg.media_mimetype          AS mimetype,
            msg.media_duration          AS duration,
            msg.media_file_name         AS media_filename,
            msg.media_saved_path,
            msg.media_is_downloaded,
            msg.media_url,
            msg.is_ptt, msg.is_gif, msg.is_view_once, msg.is_animated,
            msg.poll_options,
            msg.poll_votes,
            msg.context_stanza_id       AS quoted_id,
            -- [FIX-QUOTED-SENDER] Return the raw JID — chat.js resolveQuotedSender handles display
            msg.context_participant     AS quoted_sender,
            msg.context_quoted_message  AS quoted_body,
            msg.context_mentioned_jids  AS mentioned_jids,
            msg.context_is_forwarded    AS is_forwarded,
            msg.context_forwarding_score AS forwarding_score,
            msg.location_lat, msg.location_lng, msg.location_name, msg.location_address,
            msg.reaction_text           AS reaction_emoji,
            msg.reaction_target_id,
            CASE WHEN msg.remote_jid LIKE '%@g.us' THEN 1 ELSE 0 END AS is_group
        FROM messages msg
        -- Sender contact join (group member or DM opponent)
        LEFT JOIN contacts c    ON c.jid = msg.participant
        -- [FIX-LID] Also try matching participant @lid via number
        LEFT JOIN contacts clid ON msg.participant LIKE '%@lid'
                                AND clid.jid = SUBSTR(msg.participant, 1, INSTR(msg.participant, '@') - 1) || '@s.whatsapp.net'
        WHERE msg.remote_jid = ? AND msg.is_deleted = 0
        ORDER BY msg.message_timestamp DESC
        LIMIT ? OFFSET ?
    `),

    // [FIX-6] Ganti named @jid/@query → positional ? ?
    searchMessages: db.prepare(`
        SELECT * FROM messages
        WHERE remote_jid = ? AND body LIKE ? AND is_deleted = 0
        ORDER BY message_timestamp DESC
        LIMIT 100
    `),

    searchMessagesGlobal: db.prepare(`
        SELECT
            id, remote_jid AS chat_jid, from_me, push_name AS sender_name,
            message_type AS msg_type, body, message_timestamp AS timestamp,
            status, is_history_sync,
            CASE WHEN remote_jid LIKE '%@g.us' THEN 1 ELSE 0 END AS is_group
        FROM messages
        WHERE body LIKE ? AND is_deleted = 0
        ORDER BY message_timestamp DESC
        LIMIT 100
    `),

    updateMessageStatus:  db.prepare('UPDATE messages SET status = ? WHERE id = ?'),
    updateMessageStarred: db.prepare('UPDATE messages SET starred = ? WHERE id = ?'),
    markMessageDeleted:   db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?'),

    updateMediaSavedPath: db.prepare(`
        UPDATE messages SET media_saved_path = ?, media_is_downloaded = 1 WHERE id = ?
    `),

    updatePollVotes: db.prepare('UPDATE messages SET poll_votes = ? WHERE id = ?'),

    // [FIX-PREVIEW] @msg_type was never passed from client.js handleMessage() → silent UPDATE fail
    // Fix: remove @msg_type from the statement used by handleMessage; keep full version for saveMessage
    updateChatLastMessage: db.prepare(`
        UPDATE chats SET
            last_message_timestamp = @timestamp,
            last_message_id        = @message_id,
            last_message_body      = @body
        WHERE jid = @jid
    `),

    updateChatLastMessageFull: db.prepare(`
        UPDATE chats SET
            last_message_timestamp = @timestamp,
            last_message_id        = @message_id,
            last_message_body      = @body,
            last_message_type      = @msg_type
        WHERE jid = @jid
    `),

    // [FIX-PUSHNAME] Upsert pushname into contacts from live messages
    upsertContactPushname: db.prepare(`
        INSERT INTO contacts (jid, push_name, number, is_user, is_group)
        VALUES (@jid, @push_name, @number, 1, 0)
        ON CONFLICT(jid) DO UPDATE SET
            -- [FIX-DEDUP] Only update push_name if:
            --   1. We have no push_name yet (first time seeing this contact), OR
            --   2. The new push_name is longer (prefer fuller names over abbreviations).
            -- Never touch contacts that already have a phone-book name — it takes priority
            -- in the getChats COALESCE anyway, so this only affects contacts.push_name display.
            push_name  = CASE
                WHEN contacts.push_name IS NULL THEN excluded.push_name
                WHEN LENGTH(excluded.push_name) > LENGTH(contacts.push_name) THEN excluded.push_name
                ELSE contacts.push_name
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE excluded.push_name IS NOT NULL AND excluded.push_name != ''
    `),

    // [FIX-PROFILE-PIC] Update profile_pic_url in chats and contacts
    updateChatProfilePic:    db.prepare('UPDATE chats    SET profile_pic_url = ? WHERE jid = ?'),
    updateContactProfilePic: db.prepare('UPDATE contacts SET profile_pic_url = ? WHERE jid = ?'),

    // ── Chats ─────────────────────────────────────────────────────────────────

    // [FIX-13] INSERT OR REPLACE → UPSERT untuk jaga unread_count/pinned/dll
    upsertChat: db.prepare(`
        INSERT INTO chats (
            jid, name, is_group, is_community, community_jid,
            unread_count, last_message_timestamp, last_message_id, last_message_body,
            pinned, archived, muted_until, profile_pic_url, status, presence
        ) VALUES (
            @jid, @name, @is_group, @is_community, @community_jid,
            @unread_count, @last_message_timestamp, @last_message_id, @last_message_body,
            @pinned, @archived, @muted_until, @profile_pic_url, @status, @presence
        )
        ON CONFLICT(jid) DO UPDATE SET
            -- [FIX-DEDUP-NAME] Only update name if:
            --   1. New value is not null (we have something to set)
            --   2. Current name is null (first time, safe to set)
            --   3. is_group = 1 (group subject always wins)
            -- For DM: if chats.name already null (correct state), keep it null.
            --         If incoming name is null (correct from our JS fix), keep existing.
            -- This prevents push_name from re-polluting chats.name on future upserts.
            name                   = CASE
                                        WHEN excluded.is_group = 1 THEN COALESCE(excluded.name, chats.name)
                                        ELSE NULL
                                     END,
            is_group               = excluded.is_group,
            is_community           = excluded.is_community,
            community_jid          = COALESCE(excluded.community_jid, chats.community_jid),
            unread_count           = CASE
                                        WHEN excluded.unread_count >= 0 THEN excluded.unread_count
                                        ELSE chats.unread_count
                                     END,
            last_message_timestamp = MAX(excluded.last_message_timestamp, chats.last_message_timestamp),
            last_message_id        = CASE
                                        WHEN excluded.last_message_timestamp > chats.last_message_timestamp
                                        THEN excluded.last_message_id
                                        ELSE chats.last_message_id
                                     END,
            -- [FIX-PREVIEW] NEVER overwrite with NULL — live messages always provide body.
            -- History sync passes null (body is in messages table, not chat row), so we
            -- keep whatever was there. backfillChatLastMessages() fills gaps after sync.
            last_message_body      = CASE
                                        WHEN excluded.last_message_body IS NOT NULL
                                         AND excluded.last_message_timestamp >= chats.last_message_timestamp
                                        THEN excluded.last_message_body
                                        ELSE chats.last_message_body
                                     END,
            pinned                 = COALESCE(excluded.pinned, chats.pinned),
            archived               = COALESCE(excluded.archived, chats.archived),
            muted_until            = COALESCE(excluded.muted_until, chats.muted_until),
            profile_pic_url        = COALESCE(excluded.profile_pic_url, chats.profile_pic_url),
            updated_at             = CURRENT_TIMESTAMP
    `),

    ensureChat: db.prepare(`
        INSERT OR IGNORE INTO chats (jid, is_group, last_message_timestamp)
        VALUES (?, ?, ?)
    `),

    // [FIX-NAME] COALESCE priority untuk DM vs Group:
    //
    // PROBLEM: Baileys set chats.name = push_name ("DCE") untuk DM saat history sync.
    //          contacts.name = phonebook name ("BAS"). COALESCE(c.name, ct.name) = "DCE" ← SALAH.
    //          Phonebook name harus menang atas push_name.
    //
    // FIX: Pakai CASE untuk pisah logika Group vs DM:
    //   GROUP: c.name selalu valid (group subject) → prioritas tertinggi
    //   DM:    ct.name (phonebook) > ct.push_name > c.name (push_name) > m.push_name
    //
    // Dengan ini:
    //   - Kontak tersimpan "BAS" tetap tampil "BAS" meskipun push_name WA = "DCE"
    //   - Kontak tidak tersimpan tetap tampil push_name-nya
    //   - Grup tetap tampil nama grup
    getChats: db.prepare(`
        SELECT
            c.jid,
            CASE
                WHEN c.is_group = 1
                    -- Group: group subject always wins
                    THEN COALESCE(c.name, ct.name, ct.push_name)
                WHEN c.jid LIKE '%@lid'
                    -- [FIX-LID] @lid DM: resolve via contacts number match
                    THEN COALESCE(
                        ctlid.name, ctlid.push_name,
                        ct.name, ct.push_name,
                        '+' || SUBSTR(c.jid, 1, INSTR(c.jid, '@') - 1)
                    )
                ELSE
                    -- DM: phonebook name beats push_name
                    COALESCE(ct.name, ct.push_name, ct.short_name, c.name, m.push_name, '+' || SUBSTR(c.jid, 1, INSTR(c.jid, '@') - 1))
            END AS name,
            c.is_group, c.is_community, c.unread_count, c.pinned, c.archived,
            c.muted_until,
            COALESCE(c.profile_pic_url, ct.profile_pic_url, ctlid.profile_pic_url) AS profile_pic_url,
            c.status, c.presence,
            c.last_message_timestamp    AS last_msg_at,
            -- [FIX-PREVIEW] Fallback: if chats.last_message_body is NULL (history sync gap),
            -- pull body directly from the last message row.
            COALESCE(c.last_message_body, m.body)   AS last_msg,
            c.last_message_id           AS last_msg_id,
            COALESCE(c.last_message_type, m.message_type) AS last_msg_type,
            -- [FIX-FROM-ME] from_me comes from the actual last message row.
            -- COALESCE with 0 so it's never NULL (NULL = unknown, treat as received).
            COALESCE(m.from_me, 0)      AS from_me,
            -- [FIX-SENDER-NAME] For group msgs: show sender name of last message
            CASE
                WHEN COALESCE(m.from_me, 0) = 1 THEN NULL
                WHEN c.is_group = 1 THEN COALESCE(msender.name, msender.push_name, m.push_name)
                ELSE NULL
            END AS last_sender_name
        FROM chats c
        LEFT JOIN contacts ct      ON ct.jid = c.jid
        -- [FIX-LID] For @lid chats, also match contact by numeric user part + @s.whatsapp.net
        LEFT JOIN contacts ctlid   ON c.jid LIKE '%@lid'
                                   AND ctlid.jid = SUBSTR(c.jid, 1, INSTR(c.jid, '@') - 1) || '@s.whatsapp.net'
        LEFT JOIN messages m       ON m.id   = c.last_message_id
        LEFT JOIN contacts msender ON msender.jid = m.participant
        WHERE
            -- [FIX-DEDUP-LID] Exclude @lid rows when @s.whatsapp.net row exists
            NOT (
                c.jid LIKE '%@lid'
                AND EXISTS (
                    SELECT 1 FROM chats c2
                    WHERE c2.jid = SUBSTR(c.jid, 1, INSTR(c.jid, '@') - 1) || '@s.whatsapp.net'
                )
            )
        ORDER BY c.pinned DESC, c.last_message_timestamp DESC
        LIMIT ? OFFSET ?
    `),

    getChatByJid:       db.prepare('SELECT * FROM chats WHERE jid = ?'),
    updateChatUnread:   db.prepare('UPDATE chats SET unread_count = ? WHERE jid = ?'),
    updateChatPinned:   db.prepare('UPDATE chats SET pinned = ? WHERE jid = ?'),
    updateChatArchived: db.prepare('UPDATE chats SET archived = ? WHERE jid = ?'),
    markChatRead:       db.prepare('UPDATE chats SET unread_count = 0 WHERE jid = ?'),

    // ── Contacts ──────────────────────────────────────────────────────────────
    insertContact: db.prepare(`
        INSERT INTO contacts (
            jid, name, push_name, short_name, number, status,
            profile_pic_url, is_group, is_user, is_business
        ) VALUES (
            @jid, @name, @push_name, @short_name, @number, @status,
            @profile_pic_url, @is_group, @is_user, @is_business
        )
        ON CONFLICT(jid) DO UPDATE SET
            name            = COALESCE(excluded.name, contacts.name),
            push_name       = COALESCE(excluded.push_name, contacts.push_name),
            short_name      = COALESCE(excluded.short_name, contacts.short_name),
            number          = COALESCE(excluded.number, contacts.number),
            profile_pic_url = COALESCE(excluded.profile_pic_url, contacts.profile_pic_url),
            updated_at      = CURRENT_TIMESTAMP
    `),

    // [FIX-5] Ganti @limit/@offset → positional ? ?
    getContacts: db.prepare('SELECT * FROM contacts ORDER BY COALESCE(name, push_name, jid) ASC LIMIT ? OFFSET ?'),

    // [FIX-7] Ganti @query → positional 4x ? untuk name/push_name/number/jid
    searchContacts: db.prepare(`
        SELECT * FROM contacts
        WHERE name LIKE ? OR push_name LIKE ? OR number LIKE ? OR jid LIKE ?
        ORDER BY COALESCE(name, push_name) ASC
        LIMIT 50
    `),

    getContactByJid: db.prepare('SELECT * FROM contacts WHERE jid = ?'),

    // ── Media downloads ───────────────────────────────────────────────────────
    insertMediaDownload: db.prepare(`
        INSERT OR IGNORE INTO media_downloads (message_id, remote_jid, media_type, original_url, download_status)
        VALUES (?, ?, ?, ?, 'pending')
    `),

    updateMediaDownload: db.prepare(`
        INSERT INTO media_downloads (message_id, remote_jid, media_type, local_path, file_size, download_status, error_message, downloaded_at)
        VALUES (@message_id, '', '', @local_path, @file_size, @download_status, @error_message, CURRENT_TIMESTAMP)
        ON CONFLICT(message_id) DO UPDATE SET
            local_path        = @local_path,
            file_size         = @file_size,
            download_status   = @download_status,
            download_attempts = download_attempts + 1,
            error_message     = @error_message,
            downloaded_at     = CURRENT_TIMESTAMP
    `),

    getPendingMediaDownloads: db.prepare(`
        SELECT * FROM media_downloads WHERE download_status = 'pending' ORDER BY download_attempts ASC LIMIT 10
    `),

    // [PREFETCH] Get messages with undownloaded media for a specific chat
    // Used by media:prefetch IPC to know what to download in background.
    // Orders by timestamp DESC so newest media (most likely to be viewed) downloads first.
    getMediaPendingForChatStmt: db.prepare(`
        SELECT
            m.id,
            m.remote_jid AS chat_jid,
            m.message_type,
            m.message_json,
            m.media_url,
            m.media_direct_path,
            m.media_key,
            m.media_mimetype
        FROM messages m
        WHERE m.remote_jid = ?
          AND m.media_is_downloaded = 0
          AND m.is_deleted = 0
          AND m.message_type IN (
              'imageMessage','videoMessage','audioMessage','pttMessage',
              'documentMessage','stickerMessage','viewOnceMessage','viewOnceMessageV2'
          )
          AND m.message_json IS NOT NULL
        ORDER BY m.message_timestamp DESC
        LIMIT ?
    `),

    // ── LID retroactive fix — pre-compiled for performance ───────────────────
    // These run inside resolveLidRows() transaction, once per lidMap entry.
    // Compiled once here so they're not re-prepared on every call.
    lidFixMessages:  db.prepare(`UPDATE messages SET remote_jid = ? WHERE remote_jid = ?`),
    lidFixParticipant: db.prepare(`UPDATE messages SET participant = ? WHERE participant = ?`),
    lidFixChats:     db.prepare(`UPDATE chats SET jid = ? WHERE jid = ?`),
    lidFixContacts:  db.prepare(`UPDATE contacts SET jid = ? WHERE jid = ?`),

    // ── Sync status ───────────────────────────────────────────────────────────
    // [FIX-10] Pisah jadi 2 statement dedicated
    startSyncStmt: db.prepare(`
        UPDATE sync_status SET
            is_syncing        = 1,
            sync_started_at   = CURRENT_TIMESTAMP,
            sync_completed_at = NULL,
            total_chats       = 0,
            total_messages    = 0
        WHERE id = 1
    `),
    endSyncStmt: db.prepare(`
        UPDATE sync_status SET
            is_syncing          = 0,
            sync_completed_at   = CURRENT_TIMESTAMP,
            total_chats         = ?,
            total_messages      = ?,
            last_sync_timestamp = unixepoch()
        WHERE id = 1
    `),
    getSyncStatus: db.prepare('SELECT * FROM sync_status WHERE id = 1'),

    // ── Stats ─────────────────────────────────────────────────────────────────
    getStats: db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM messages WHERE is_deleted = 0)                         AS total_messages,
            (SELECT COUNT(*) FROM chats WHERE is_community = 0)                          AS total_chats,
            (SELECT COUNT(*) FROM contacts)                                              AS total_contacts,
            (SELECT COUNT(*) FROM messages WHERE is_history_sync = 1)                   AS history_messages,
            (SELECT COUNT(*) FROM messages WHERE media_is_downloaded = 1)               AS downloaded_media,
            (SELECT COUNT(*) FROM media_downloads WHERE download_status = 'pending')     AS pending_downloads
    `),
};

// ════════════════════════════════════════════════════════════
// MESSAGE TYPE DETECTOR
// ════════════════════════════════════════════════════════════

function detectMessageType(message) {
    if (!message) return 'unknown';
    if (message.ephemeralMessage?.message) return detectMessageType(message.ephemeralMessage.message);
    if (message.viewOnceMessage)            return 'viewOnceMessage';
    if (message.viewOnceMessageV2)          return 'viewOnceMessageV2';
    if (message.editedMessage)              return 'extendedTextMessage';
    if (message.protocolMessage)            return 'protocol';
    if (message.audioMessage?.ptt)          return 'pttMessage';
    if (message.documentWithCaptionMessage?.message?.documentMessage) return 'documentMessage';

    const types = [
        'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
        'audioMessage', 'pttMessage', 'documentMessage', 'stickerMessage',
        'locationMessage', 'liveLocationMessage', 'contactMessage', 'contactsArrayMessage',
        'reactionMessage', 'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3',
        'pollUpdateMessage', 'groupInviteMessage', 'paymentMessage', 'orderMessage',
        'productMessage', 'eventMessage', 'callMessage', 'buttonsMessage',
        'buttonsResponseMessage', 'listMessage', 'listResponseMessage',
        'interactiveMessage', 'interactiveResponseMessage', 'carouselMessage',
        'albumMessage', 'pollResultMessage', 'sharePhoneNumberMessage',
        'requestPhoneNumberMessage', 'adminInviteMessage', 'paymentInviteMessage',
        'pinInChatMessage', 'keepInChatMessage', 'ptvMessage',
        'newsletterAdminInviteMessage', 'requestPaymentMessage', 'sendPaymentMessage',
    ];

    for (const type of types) {
        if (message[type]) return type;
    }
    return 'unknown';
}

// ════════════════════════════════════════════════════════════
// CONTENT EXTRACTOR
// ════════════════════════════════════════════════════════════

function extractContent(message, type) {
    const result = { body: '', media: null, context: null, reaction: null, poll: null, location: null, contact: null, protocol: null };
    if (!message) return result;

    // Unwrap wrappers
    let m = message;
    if (m.ephemeralMessage?.message)                           { m = m.ephemeralMessage.message; type = detectMessageType(m); }
    else if (m.viewOnceMessage?.message)                       { m = m.viewOnceMessage.message; type = detectMessageType(m); }
    else if (m.viewOnceMessageV2?.message)                     { m = m.viewOnceMessageV2.message; type = detectMessageType(m); }
    else if (m.editedMessage?.message)                         { m = m.editedMessage.message; type = detectMessageType(m); }
    else if (m.documentWithCaptionMessage?.message?.documentMessage) { m = m.documentWithCaptionMessage.message; type = 'documentMessage'; }

    switch (type) {
        case 'conversation':
            result.body = m.conversation || '';
            break;
        case 'extendedTextMessage':
        case 'extendedText':
            result.body    = m.extendedTextMessage?.text || '';
            result.context = extractContextInfo(m.extendedTextMessage?.contextInfo);
            break;
        case 'imageMessage':
        case 'image':
            result.body    = m.imageMessage?.caption || '';
            result.media   = extractMediaInfo(m.imageMessage, 'image');
            result.context = extractContextInfo(m.imageMessage?.contextInfo);
            break;
        case 'videoMessage':
        case 'video':
            result.body    = m.videoMessage?.caption || '';
            result.media   = extractMediaInfo(m.videoMessage, 'video');
            result.context = extractContextInfo(m.videoMessage?.contextInfo);
            break;
        case 'audioMessage':
        case 'audio':
        case 'pttMessage':
        case 'ptt':
            result.media   = extractMediaInfo(m.audioMessage, 'audio');
            result.context = extractContextInfo(m.audioMessage?.contextInfo);
            break;
        case 'documentMessage':
        case 'document':
            result.body    = m.documentMessage?.caption || m.documentMessage?.fileName || '';
            result.media   = extractMediaInfo(m.documentMessage, 'document');
            result.context = extractContextInfo(m.documentMessage?.contextInfo);
            break;
        case 'stickerMessage':
        case 'sticker':
            result.media = extractMediaInfo(m.stickerMessage, 'sticker');
            break;
        case 'locationMessage':
        case 'location':
            result.location = { lat: m.locationMessage?.degreesLatitude, lng: m.locationMessage?.degreesLongitude, name: m.locationMessage?.name, address: m.locationMessage?.address };
            result.body = m.locationMessage?.name || m.locationMessage?.address || '';
            break;
        case 'liveLocationMessage':
        case 'liveLocation':
            result.location = { lat: m.liveLocationMessage?.degreesLatitude, lng: m.liveLocationMessage?.degreesLongitude, accuracy: m.liveLocationMessage?.accuracyInMeters };
            result.body = m.liveLocationMessage?.caption || '';
            break;
        case 'contactMessage':
        case 'contact':
            result.contact = { displayName: m.contactMessage?.displayName, vcard: m.contactMessage?.vcard };
            result.body = m.contactMessage?.displayName || '';
            break;
        case 'contactsArrayMessage':
        case 'contactsArray':
            result.body = (m.contactsArrayMessage?.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
            break;
        case 'reactionMessage':
        case 'reaction':
            result.reaction = { text: m.reactionMessage?.text, targetId: m.reactionMessage?.key?.id, targetRemoteJid: m.reactionMessage?.key?.remoteJid, targetFromMe: m.reactionMessage?.key?.fromMe };
            result.body = m.reactionMessage?.text || '';
            break;
        case 'pollCreationMessage':
        case 'pollCreationMessageV2':
        case 'pollCreationMessageV3':
        case 'pollCreation': {
            const pm = m.pollCreationMessageV3 || m.pollCreationMessageV2 || m.pollCreationMessage;
            result.poll = { name: pm?.name, options: (pm?.options || []).map(o => o.optionName || o.name || ''), selectableCount: pm?.selectableOptionsCount };
            result.body = pm?.name || '';
            break;
        }
        case 'protocol':
            result.protocol = { type: m.protocolMessage?.type, keyId: m.protocolMessage?.key?.id };
            break;
        case 'groupInviteMessage':
        case 'groupInvite':
            result.body = m.groupInviteMessage?.groupName || m.groupInviteMessage?.caption || '';
            break;
        case 'paymentMessage':
        case 'requestPaymentMessage':
        case 'sendPaymentMessage':
        case 'payment':
            result.body = m.requestPaymentMessage?.noteMessage?.extendedTextMessage?.text || m.sendPaymentMessage?.noteMessage?.extendedTextMessage?.text || 'Pembayaran';
            break;
        case 'orderMessage':
        case 'order':
            result.body = m.orderMessage?.message || m.orderMessage?.orderTitle || 'Pesanan';
            break;
        case 'eventMessage':
        case 'event':
            result.body = m.eventMessage?.name || 'Acara';
            break;
        case 'buttonsMessage':
        case 'buttons':
            result.body = m.buttonsMessage?.contentText || m.buttonsMessage?.text || '';
            break;
        case 'listMessage':
        case 'list':
            result.body = m.listMessage?.description || m.listMessage?.title || '';
            break;
        case 'interactiveMessage':
            result.body = m.interactiveMessage?.body?.text || m.interactiveMessage?.header?.title || '';
            break;
        case 'interactiveResponseMessage':
            try {
                const p = JSON.parse(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}');
                result.body = p.id || p.title || '';
            } catch { result.body = ''; }
            break;
        case 'buttonsResponseMessage':
            result.body = m.buttonsResponseMessage?.selectedButtonId || m.buttonsResponseMessage?.selectedDisplayText || '';
            break;
        case 'listResponseMessage':
            result.body = m.listResponseMessage?.singleSelectReply?.selectedRowId || m.listResponseMessage?.title || '';
            break;
        case 'ptvMessage':
        case 'ptv':
            result.media = extractMediaInfo(m.ptvMessage, 'video');
            break;
        case 'newsletterAdminInviteMessage':
            result.body = m.newsletterAdminInviteMessage?.newsletterName || 'Undangan Newsletter';
            break;
    }

    return result;
}

function extractMediaInfo(mediaObj, type) {
    if (!mediaObj) return null;
    const toNum = v => {
        if (v == null) return null;
        if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
        const n = Number(v); return isNaN(n) ? null : n;
    };
    return {
        mimetype:   mediaObj.mimetype    || null,
        fileName:   mediaObj.fileName    || null,
        fileLength: toNum(mediaObj.fileLength),
        duration:   toNum(mediaObj.seconds) || toNum(mediaObj.duration),
        height:     toNum(mediaObj.height),
        width:      toNum(mediaObj.width),
        caption:    mediaObj.caption     || null,
        mediaKey:   mediaObj.mediaKey    || null,
        directPath: mediaObj.directPath  || null,
        url:        mediaObj.url         || null,
        sha256:     mediaObj.fileSha256  || null,
        encSha256:  mediaObj.fileEncSha256 || null,
        ptt:        mediaObj.ptt         || false,
        isAnimated: mediaObj.isAnimated  || false,
        gifPlayback: mediaObj.gifPlayback || false,
    };
}

function extractContextInfo(contextInfo) {
    if (!contextInfo) return null;
    return {
        stanzaId:       contextInfo.stanzaId    || null,
        participant:    contextInfo.participant  || null,
        quotedMessage:  contextInfo.quotedMessage  ? JSON.stringify(contextInfo.quotedMessage)  : null,
        mentionedJids:  contextInfo.mentionedJid?.length ? JSON.stringify(contextInfo.mentionedJid) : null,
        isForwarded:    contextInfo.isForwarded  || false,
        forwardingScore: contextInfo.forwardingScore || 0,
    };
}

// ════════════════════════════════════════════════════════════
// [FIX-12] DATABASE PUBLIC API — dipisah dari statements
// ════════════════════════════════════════════════════════════

const database = {

    // ── Init / Close ──────────────────────────────────────────────────────────
    init() {
        db.prepare('SELECT 1').get(); // verify open
        return this;
    },
    close() {
        try {
            if (db.open) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                db.close();
            }
        } catch (err) {
            console.error('[AuroraDB] close error:', err.message);
        }
    },

    // Expose statements untuk client.js yang akses langsung
    get statements() { return statements; },

    // ════════════════════════════════════════════════════════════
    // MESSAGES
    // ════════════════════════════════════════════════════════════

    /**
     * saveMessage — dipanggil dari client.js handleMessage() dengan raw WAMessage Baileys
     */
    saveMessage(msg, isHistorySync = false, syncType = null) {
        try {
            const type    = detectMessageType(msg.message);
            const content = extractContent(msg.message, type);

            const toNum = v => {
                if (v == null) return null;
                if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
                const n = Number(v); return isNaN(n) ? null : n;
            };
            const toStr = v => {
                if (v == null) return null;
                if (typeof v === 'string') return v;
                if (Buffer.isBuffer(v)) return v.toString('base64');
                if (typeof v === 'object') return JSON.stringify(v);
                return String(v);
            };
            const toBool  = v => (v ? 1 : 0);
            const toB64   = v => {
                if (!v) return null;
                if (typeof v === 'string') return v;
                try { return Buffer.from(v).toString('base64'); } catch { return null; }
            };

            const params = {
                id:           toStr(msg.key.id),
                // [FIX-SPLIT-CHAT] Normalize remote_jid — can be @c.us or have :device suffix
                remote_jid:   normalizeJid(toStr(msg.key.remoteJid)),
                from_me:      toBool(msg.key.fromMe),
                participant:  normalizeJid(toStr(msg.participant || (!msg.key.fromMe ? msg.key.remoteJid : null))),
                push_name:    toStr(msg.pushName),
                message_type: type,
                body:         toStr(content.body),
                message_json: JSON.stringify(msg.message),

                media_mimetype:    toStr(content.media?.mimetype),
                media_file_name:   toStr(content.media?.fileName),
                media_file_length: toNum(content.media?.fileLength),
                media_duration:    toNum(content.media?.duration),
                media_height:      toNum(content.media?.height),
                media_width:       toNum(content.media?.width),
                media_caption:     toStr(content.media?.caption),
                media_key:         toB64(content.media?.mediaKey),
                media_direct_path: toStr(content.media?.directPath),
                media_url:         toStr(content.media?.url),
                media_sha256:      toB64(content.media?.sha256),
                media_enc_sha256:  toB64(content.media?.encSha256),

                is_ptt:       toBool(content.media?.ptt || type === 'pttMessage'),
                is_gif:       toBool(content.media?.gifPlayback),
                is_view_once: toBool(type === 'viewOnceMessage' || type === 'viewOnceMessageV2'),
                is_animated:  toBool(content.media?.isAnimated),

                context_stanza_id:        toStr(content.context?.stanzaId),
                context_participant:      toStr(content.context?.participant),
                context_quoted_message:   toStr(content.context?.quotedMessage),
                context_mentioned_jids:   toStr(content.context?.mentionedJids),
                context_is_forwarded:     toBool(content.context?.isForwarded),
                context_forwarding_score: toNum(content.context?.forwardingScore) ?? 0,

                reaction_text:              toStr(content.reaction?.text),
                reaction_target_id:         toStr(content.reaction?.targetId),
                reaction_target_remote_jid: toStr(content.reaction?.targetRemoteJid),
                reaction_target_from_me:    toBool(content.reaction?.targetFromMe),

                poll_name:             toStr(content.poll?.name),
                poll_options:          content.poll?.options ? JSON.stringify(content.poll.options) : null,
                poll_selectable_count: toNum(content.poll?.selectableCount),
                poll_votes:            null,

                location_lat:      toNum(content.location?.lat),
                location_lng:      toNum(content.location?.lng),
                location_name:     toStr(content.location?.name),
                location_address:  toStr(content.location?.address),
                location_accuracy: toNum(content.location?.accuracy),

                contact_vcard:        toStr(content.contact?.vcard),
                contact_display_name: toStr(content.contact?.displayName),

                protocol_type:   toNum(content.protocol?.type),
                protocol_key_id: toStr(content.protocol?.keyId),

                status:          toNum(msg.status) ?? 0,
                starred:         toBool(msg.starred),
                broadcast:       toBool(msg.broadcast),
                is_history_sync: toBool(isHistorySync),
                sync_type:       toStr(syncType),
                message_timestamp: toNum(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000),
            };

            statements.insertMessage.run(params);

            // Ensure chat row exists (FK safety)
            const isGroup = (params.remote_jid || '').endsWith('@g.us');
            statements.ensureChat.run(params.remote_jid, isGroup ? 1 : 0, params.message_timestamp);

            // Update chat last message (only live messages)
            if (!isHistorySync) {
                statements.updateChatLastMessageFull.run({
                    jid:        params.remote_jid,
                    timestamp:  params.message_timestamp,
                    message_id: params.id,
                    body:       params.body || `[${type}]`,
                    msg_type:   type,
                });
            }

            return { success: true, id: params.id, type, hasMedia: !!content.media };
        } catch (err) {
            console.error('[AuroraDB] saveMessage error:', err.message);
            return { success: false, error: err.message };
        }
    },

    /**
     * [FIX-2] insertMessage — dipanggil dari client.patch.js (messageParser path)
     * Menerima objek parsed dari parseMessage()
     */
    insertMessage(parsed) {
        if (!parsed?.id) throw new Error('insertMessage: missing id');

        const toStr = v => {
            if (v == null) return null;
            if (typeof v === 'string') return v;
            try { return JSON.stringify(v); } catch { return null; }
        };

        // [FIX-SPLIT-CHAT] Normalize JIDs — parsed comes from messageParser which
        // already normalizes, but defend in depth here too (direct insertMessage callers)
        const chatJid   = normalizeJid(parsed.chat_jid);
        const senderJid = normalizeJid(parsed.sender_jid);

        if (!chatJid) throw new Error('insertMessage: invalid chat_jid');

        // Ensure chat row (FK safety)
        const isGroup = chatJid.endsWith('@g.us');
        statements.ensureChat.run(
            chatJid,
            parsed.is_group ?? (isGroup ? 1 : 0),
            parsed.timestamp || Math.floor(Date.now() / 1000)
        );

        statements.insertMessage.run({
            id:                       parsed.id,
            remote_jid:               chatJid,
            from_me:                  parsed.from_me ?? 0,
            participant:              senderJid || null,
            push_name:                parsed.pushname || parsed.sender_name || null,
            message_type:             parsed.msg_type || 'conversation',
            body:                     parsed.body || null,
            message_json:             parsed.raw_json || null,

            media_mimetype:           parsed.mimetype || null,
            media_file_name:          parsed.media_filename || null,
            media_file_length:        parsed.media_size || null,
            media_duration:           parsed.media_duration || parsed.duration || null,
            media_height:             parsed.media_height || null,
            media_width:              parsed.media_width || null,
            media_caption:            parsed.body || null,
            media_key:                null,
            media_direct_path:        null,
            media_url:                parsed.media_url || null,
            media_sha256:             null,
            media_enc_sha256:         null,

            is_ptt:                   parsed.is_ptt ?? 0,
            is_gif:                   parsed.is_gif ?? 0,
            is_view_once:             parsed.is_view_once ?? 0,
            is_animated:              parsed.is_animated ?? 0,

            context_stanza_id:        parsed.quoted_id || null,
            context_participant:      parsed.quoted_sender || null,
            context_quoted_message:   parsed.quoted_body || null,
            context_mentioned_jids:   toStr(parsed.mentioned_jids),
            context_is_forwarded:     parsed.is_forwarded ?? 0,
            context_forwarding_score: parsed.forwarding_score ?? 0,

            reaction_text:            parsed.reaction_emoji || null,
            reaction_target_id:       parsed.reaction_target_id || null,
            reaction_target_remote_jid: null,
            reaction_target_from_me:  null,

            poll_name:                parsed.body || null,
            poll_options:             toStr(parsed.poll_options),
            poll_selectable_count:    null,
            poll_votes:               null,

            location_lat:             parsed.location_lat || null,
            location_lng:             parsed.location_lng || null,
            location_name:            parsed.location_name || null,
            location_address:         parsed.location_address || null,
            location_accuracy:        null,

            contact_vcard:            toStr(parsed.contacts_json),
            contact_display_name:     null,

            protocol_type:            null,
            protocol_key_id:          null,

            status:                   parsed.status ?? 0,
            starred:                  parsed.starred ?? 0,
            broadcast:                0,
            is_history_sync:          parsed.is_history_sync ?? 0,
            sync_type:                null,
            message_timestamp:        parsed.timestamp || Math.floor(Date.now() / 1000),
        });
    },

    getMessageById:       id                => statements.getMessageById.get(id) || null,

    // [FIX-3] Positional params
    getMessages:          (jid, limit = 50, offset = 0) => statements.getMessagesByJid.all(normalizeJid(jid), limit, offset),
    getMessageCount:      jid               => (db.prepare('SELECT COUNT(*) as n FROM messages WHERE remote_jid = ? AND is_deleted = 0').get(normalizeJid(jid))?.n) || 0,

    // [FIX-6] Positional params
    searchMessages:       (jid, query)      => statements.searchMessages.all(normalizeJid(jid), `%${query}%`),
    searchMessagesGlobal: query             => statements.searchMessagesGlobal.all(`%${query}%`),

    updateMessageStatus(id, status) {
        if (!id) return;
        statements.updateMessageStatus.run(status, id);
    },

    updateMediaSavedPath(id, localPath) {
        if (!id || !localPath) return;
        statements.updateMediaSavedPath.run(localPath, id);
    },

    updateMediaDownload(messageId, localPath, fileSize, status, errorMessage = null) {
        if (!messageId) return;
        statements.updateMediaDownload.run({
            message_id:      messageId,
            local_path:      localPath || null,
            file_size:       fileSize  || null,
            download_status: status    || 'unknown',
            error_message:   errorMessage || null,
        });
        // Sync ke messages table jika berhasil
        if (status === 'downloaded' && localPath) {
            statements.updateMediaSavedPath.run(localPath, messageId);
        }
    },

    updatePollVotes(id, pollResultsJson) {
        if (!id) return;
        const val = typeof pollResultsJson === 'string' ? pollResultsJson : JSON.stringify(pollResultsJson);
        statements.updatePollVotes.run(val, id);
    },

    // [FIX-9] Kolom yang benar: poll_message_id / voter_jid / selected_options
    savePollVote(messageId, voterJid, vote) {
        try {
            const opts = Array.isArray(vote?.selectedOptions)
                ? JSON.stringify(vote.selectedOptions.map(o => Buffer.isBuffer(o) ? o.toString('hex') : String(o)))
                : JSON.stringify([]);
            db.prepare(`
                INSERT INTO poll_votes (poll_message_id, voter_jid, selected_options, voted_at)
                VALUES (?, ?, ?, unixepoch())
                ON CONFLICT(poll_message_id, voter_jid) DO UPDATE SET
                    selected_options = excluded.selected_options,
                    voted_at = excluded.voted_at
            `).run(messageId, voterJid, opts);
        } catch (err) { console.error('[AuroraDB] savePollVote:', err.message); }
    },

    saveMessageEdit(id, newBody, timestamp) {
        try {
            // Simpan histori edit
            db.prepare(`
                INSERT OR IGNORE INTO message_edits (original_message_id, original_body, edited_body, edited_timestamp)
                SELECT ?, body, ?, ?
                FROM messages WHERE id = ?
            `).run(id, newBody, timestamp ?? Math.floor(Date.now() / 1000), id);
            // Update body + edited_at di messages
            db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?')
                .run(newBody ?? null, timestamp ?? Math.floor(Date.now() / 1000), id);
        } catch (err) { console.error('[AuroraDB] saveMessageEdit:', err.message); }
    },

    updateMediaSavedPath(id, localPath) {
        if (!id || !localPath) return;
        statements.updateMediaSavedPath.run(localPath, id);
    },

    // ════════════════════════════════════════════════════════════
    // CHATS
    // ════════════════════════════════════════════════════════════

    // [FIX-13] UPSERT agar unread_count/pinned/dll tidak direset
    saveChat(chat) {
        if (!chat?.id) return { success: false };
        try {
            // [FIX-SPLIT-CHAT] Normalize JID — chat.id from Baileys can be @c.us (legacy)
            // or have :device suffix. Without normalization, same chat gets 2+ rows.
            const jid = normalizeJid(chat.id);
            if (!jid) return { success: false };

            const isGroup = jid.endsWith('@g.us') || jid.endsWith('@newsletter');

            // [FIX-DEDUP-NAME] Baileys DM chat.name = push_name (e.g. "DCE"), NOT phonebook name.
            // If we store it in chats.name, it wins over contacts.name ("BAS") in getChats COALESCE.
            // Fix: only store chats.name for GROUPS (where it = group subject, always valid).
            // For DM: store null → getChats COALESCE will fall through to contacts.name (phonebook).
            // Side effect: if contact is NOT in phonebook, push_name still shows via contacts.push_name
            // which is populated from contacts.set/upsert event.
            const chatName = isGroup ? (chat.name || chat.subject || null) : null;

            statements.upsertChat.run({
                jid,
                name:                   chatName,
                is_group:               isGroup ? 1 : 0,
                is_community:           jid.endsWith('@newsletter') || chat.isCommunity ? 1 : 0,
                community_jid:          chat.linkedParent ? normalizeJid(chat.linkedParent) : null,
                unread_count:           chat.unreadCount ?? 0,
                last_message_timestamp: chat.conversationTimestamp ? Number(chat.conversationTimestamp) : 0,
                last_message_id:        chat.lastMessageKey?.id || null,
                last_message_body:      null,
                pinned:                 chat.pinned ? 1 : 0,
                archived:               chat.archived ? 1 : 0,
                muted_until:            chat.muteEndTime ? Number(chat.muteEndTime) : 0,
                profile_pic_url:        chat.profilePicUrl || null,
                status:                 null,
                presence:               null,
            });

            // [FIX-DEDUP-NAME] For DM: push_name from chat.name → save to contacts.push_name,
            // NOT to chats.name. This way phonebook name still wins in getChats.
            if (!isGroup && chat.name) {
                const number = jid.split('@')[0] || null;
                statements.upsertContactPushname.run({
                    jid,
                    push_name: chat.name,
                    number,
                });
            }

            return { success: true };
        } catch (err) {
            console.error('[AuroraDB] saveChat:', err.message);
            return { success: false, error: err.message };
        }
    },

    upsertChat({ jid, name, isGroup, isCommunity, communityJid, lastMsgAt, unreadDelta }) {
        if (!jid) return;
        // [FIX-SPLIT-CHAT] Normalize jid — this method is called from various paths
        const cleanJid = normalizeJid(jid);
        if (!cleanJid) return;

        // [FIX-DEDUP-NAME] Same as saveChat: don't write push_name into chats.name for DM.
        // For groups, name = group subject (always valid).
        // For DM, name from Baileys is push_name — redirect it to contacts.push_name instead.
        const actualIsGroup = isGroup || cleanJid.endsWith('@g.us') || cleanJid.endsWith('@newsletter');
        const chatName = actualIsGroup ? (name || null) : null;

        statements.upsertChat.run({
            jid:                    cleanJid,
            name:                   chatName,
            is_group:               actualIsGroup ? 1 : 0,
            is_community:           isCommunity ? 1 : 0,
            community_jid:          communityJid ? normalizeJid(communityJid) : null,
            unread_count:           unreadDelta || 0,
            last_message_timestamp: lastMsgAt  || 0,
            last_message_id:        null,
            last_message_body:      null,
            pinned:                 0,
            archived:               0,
            muted_until:            0,
            profile_pic_url:        null,
            status:                 null,
            presence:               null,
        });

        // Redirect DM push_name to contacts table so getChats COALESCE works correctly
        if (!actualIsGroup && name) {
            try {
                statements.upsertContactPushname.run({
                    jid: cleanJid,
                    push_name: name,
                    number: cleanJid.split('@')[0] || null,
                });
            } catch (_) {}
        }
    },

    // [FIX-4] Positional params
    getChats:         (limit = 60, offset = 0)  => statements.getChats.all(limit, offset),
    getChatCount:     ()                         => (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_community = 0').get()?.n) || 0,
    getGroups:        (limit = 200, offset = 0)  => db.prepare(`SELECT c.jid, COALESCE(c.name, ct.name) AS name, c.is_group, c.is_community, c.unread_count, c.pinned, c.last_message_timestamp AS last_msg_at, c.last_message_body AS last_msg FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid WHERE c.is_group = 1 AND c.is_community = 0 ORDER BY c.last_message_timestamp DESC LIMIT ? OFFSET ?`).all(limit, offset),
    getGroupCount:    ()                         => (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_group = 1 AND is_community = 0').get()?.n) || 0,
    getCommunities:   (limit = 100, offset = 0)  => db.prepare(`SELECT jid, name, is_group, is_community, unread_count, pinned, last_message_timestamp AS last_msg_at, last_message_body AS last_msg FROM chats WHERE is_community = 1 ORDER BY last_message_timestamp DESC LIMIT ? OFFSET ?`).all(limit, offset),
    getCommunityCount:()                         => (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_community = 1').get()?.n) || 0,

    searchChats(query) {
        const q = `%${query}%`;
        return db.prepare(`
            SELECT
                c.jid,
                CASE
                    WHEN c.is_group = 1
                        THEN COALESCE(c.name, ct.name, ct.push_name)
                    ELSE
                        -- DM: phonebook (ct.name) wins over push_name (c.name)
                        COALESCE(ct.name, ct.push_name, ct.short_name, c.name, c.jid)
                END AS name,
                c.is_group, c.is_community, c.unread_count, c.pinned,
                c.last_message_timestamp AS last_msg_at
            FROM chats c
            LEFT JOIN contacts ct ON ct.jid = c.jid
            WHERE c.name LIKE ? OR ct.name LIKE ? OR ct.push_name LIKE ? OR c.jid LIKE ?
            ORDER BY c.last_message_timestamp DESC
            LIMIT 30
        `).all(q, q, q, q);
    },

    // [FIX-PREVIEW] Called once after history sync completes.
    // For all chats that have last_message_id but no last_message_body,
    // pull the body + type from the messages table.
    // Also fixes from_me by ensuring the message row exists for the JOIN.
    backfillChatLastMessages() {
        try {
            const count = db.prepare(`
                UPDATE chats
                SET
                    last_message_body = (
                        SELECT COALESCE(body, '[' || message_type || ']')
                        FROM messages
                        WHERE id = chats.last_message_id
                        LIMIT 1
                    ),
                    last_message_type = (
                        SELECT message_type FROM messages WHERE id = chats.last_message_id LIMIT 1
                    ),
                    updated_at = CURRENT_TIMESTAMP
                WHERE last_message_id IS NOT NULL
                  AND (last_message_body IS NULL OR last_message_body = '')
            `).run();
            console.log(`[AuroraDB] backfillChatLastMessages: ${count.changes} chats updated`);
        } catch (err) {
            console.error('[AuroraDB] backfillChatLastMessages error:', err.message);
        }
    },
    // Pulls all distinct (jid, push_name) from messages → upserts into contacts.
    // Covers DM contacts that never sent a live message and only exist in history.
    //
    // FIX-DEDUP: Use most recent push_name (highest message_timestamp), not random GROUP BY.
    // SQLite GROUP BY without ORDER BY is non-deterministic — could pick any push_name.
    backfillContactPushnames() {
        try {
            // Pick the push_name from the most recent message per sender JID.
            // CASE: only DM senders (not own messages, not raw group JIDs).
            const rows = db.prepare(`
                SELECT
                    CASE
                        WHEN from_me = 0 AND remote_jid NOT LIKE '%@g.us' THEN remote_jid
                        WHEN participant IS NOT NULL AND participant != '' THEN participant
                        ELSE NULL
                    END AS jid,
                    push_name,
                    MAX(message_timestamp) AS ts
                FROM messages
                WHERE push_name IS NOT NULL AND push_name != ''
                GROUP BY jid
                HAVING jid IS NOT NULL
                ORDER BY ts DESC
            `).all();

            const upsert = db.prepare(`
                INSERT INTO contacts (jid, push_name, number, is_user, is_group)
                VALUES (?, ?, ?, 1, 0)
                ON CONFLICT(jid) DO UPDATE SET
                    push_name  = CASE
                        WHEN contacts.name IS NOT NULL THEN contacts.push_name
                        ELSE COALESCE(excluded.push_name, contacts.push_name)
                    END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE contacts.push_name IS NULL AND excluded.push_name IS NOT NULL
            `);

            db.transaction((list) => {
                for (const row of list) {
                    if (!row.jid || !row.push_name) continue;
                    const jid = normalizeJid(row.jid);
                    if (!jid) continue;
                    upsert.run(jid, row.push_name, jid.split('@')[0] || null);
                }
            })(rows);

            console.log(`[AuroraDB] backfillContactPushnames: ${rows.length} rows processed`);
        } catch (err) {
            console.error('[AuroraDB] backfillContactPushnames error:', err.message);
        }
    },

    // [FIX-PUSHNAME] Save pushname from live messages into contacts table
    upsertContactPushname(senderJid, pushName) {
        if (!senderJid || !pushName) return;
        try {
            const jid    = normalizeJid(senderJid);
            const number = jid.split('@')[0] || null;
            statements.upsertContactPushname.run({ jid, push_name: pushName, number });
        } catch (err) { /* ignore */ }
    },

    // [FIX-PROFILE-PIC] Persist fetched profile pic URL so we don't fetch every time
    cacheProfilePic(jid, url) {
        if (!jid) return;
        const nJid = normalizeJid(jid); // [FIX-SPLIT-CHAT]
        try {
            statements.updateChatProfilePic.run(url || null, nJid);
            statements.updateContactProfilePic.run(url || null, nJid);
        } catch (err) { /* ignore */ }
    },

    // Get cached profile pic URL without making a network call
    getCachedProfilePic(jid) {
        if (!jid) return null;
        const nJid = normalizeJid(jid); // [FIX-SPLIT-CHAT]
        try {
            const row = db.prepare(
                'SELECT COALESCE(c.profile_pic_url, ct.profile_pic_url) AS url ' +
                'FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid ' +
                'WHERE c.jid = ?'
            ).get(nJid);
            return row?.url || null;
        } catch { return null; }
    },

    // [FIX-SPLIT-CHAT] All JID-keyed operations go through normalizeJid
    markChatRead:       jid     => { const n=normalizeJid(jid); return n && statements.markChatRead.run(n); },
    updateChatRead:     jid     => { const n=normalizeJid(jid); return n && statements.markChatRead.run(n); },
    pinChat:            (jid,v) => { const n=normalizeJid(jid); return n && statements.updateChatPinned.run(v ? 1 : 0, n); },
    updateChatPinned:   (jid,v) => { const n=normalizeJid(jid); return n && statements.updateChatPinned.run(v ? 1 : 0, n); },
    archiveChat:        (jid,v) => { const n=normalizeJid(jid); return n && statements.updateChatArchived.run(v ? 1 : 0, n); },
    updateChatArchived: (jid,v) => { const n=normalizeJid(jid); return n && statements.updateChatArchived.run(v ? 1 : 0, n); },
    updateChatUnread:   (jid,c) => { const n=normalizeJid(jid); return n && statements.updateChatUnread.run(c ?? 0, n); },

    // ════════════════════════════════════════════════════════════
    // CONTACTS
    // ════════════════════════════════════════════════════════════

    saveContact(contact) {
        if (!contact?.id) return { success: false };
        try {
            // [FIX-SPLIT-CHAT] Normalize contact JID — @c.us legacy format
            const jid = normalizeJid(contact.id);
            if (!jid) return { success: false };
            statements.insertContact.run({
                jid,
                name:            contact.name || contact.verifiedName || null,
                push_name:       contact.pushname || contact.notify || null,
                short_name:      contact.shortName || null,
                number:          contact.number || jid.split('@')[0] || null,
                status:          contact.status || null,
                profile_pic_url: contact.profilePicUrl || null,
                is_group:        contact.isGroup    ? 1 : 0,
                is_user:         contact.isUser     ? 1 : 0,
                is_business:     contact.isBusiness ? 1 : 0,
            });
            return { success: true };
        } catch (err) {
            console.error('[AuroraDB] saveContact:', err.message);
            return { success: false, error: err.message };
        }
    },

    // [FIX-8] Gunakan referensi internal yang aman — tidak bergantung pada
    // `database` object yang belum selesai didefinisikan saat module load
    saveContacts(contacts) {
        if (!Array.isArray(contacts)) return;
        const self = this;
        const run = db.transaction(list => { for (const c of list) self.saveContact(c); });
        try { run(contacts); } catch (err) { console.error('[AuroraDB] saveContacts:', err.message); }
    },

    bulkUpsertContacts(contacts) { this.saveContacts(contacts); },

    // [FIX-5] Positional params
    getContacts:      (limit = 100, offset = 0) => statements.getContacts.all(limit, offset),
    getContactCount:  ()                         => (db.prepare('SELECT COUNT(*) as n FROM contacts').get()?.n) || 0,

    // [FIX-7] Positional 4-param search
    searchContacts(query) {
        const q = `%${query}%`;
        return statements.searchContacts.all(q, q, q, q);
    },

    // ════════════════════════════════════════════════════════════
    // MEDIA QUEUE
    // ════════════════════════════════════════════════════════════

    queueMediaDownload(messageId, remoteJid, mediaType, url) {
        if (!messageId) return;
        try {
            statements.insertMediaDownload.run(messageId, remoteJid || '', mediaType || '', url || null);
        } catch (err) { /* ignore duplicate */ }
    },

    getPendingMediaDownloads: () => statements.getPendingMediaDownloads.all(),

    // [PREFETCH] Get pending media rows for a specific chat JID
    getMediaPendingForChat(jid, limit = 20) {
        if (!jid) return [];
        try {
            return statements.getMediaPendingForChatStmt.all(normalizeJid(jid), limit);
        } catch (err) {
            console.error('[AuroraDB] getMediaPendingForChat:', err.message);
            return [];
        }
    },

    // ════════════════════════════════════════════════════════════
    // [LID] Retroactively fix @lid JIDs that leaked into DB before
    // lidMap was populated. Scans messages + chats tables and replaces
    // any remote_jid / chat_jid ending in @lid with the resolved real JID.
    // Runs in a single fast SQLite transaction. Returns count of rows fixed.
    // ════════════════════════════════════════════════════════════
    resolveLidRows(lidMap) {
        if (!lidMap || lidMap.size === 0) return 0;
        let totalFixed = 0;
        const fixAll = db.transaction(() => {
            for (const [lidJid, realJid] of lidMap) {
                if (!lidJid || !realJid || lidJid === realJid) continue;
                totalFixed += statements.lidFixMessages.run(realJid, lidJid).changes;
                totalFixed += statements.lidFixParticipant.run(realJid, lidJid).changes;
                totalFixed += statements.lidFixChats.run(realJid, lidJid).changes;
                totalFixed += statements.lidFixContacts.run(realJid, lidJid).changes;
            }
        });
        try {
            fixAll();
        } catch (err) {
            console.error('[AuroraDB] resolveLidRows error:', err.message);
        }
        return totalFixed;
    },

    // ════════════════════════════════════════════════════════════
    // SYNC STATUS
    // [FIX-PREVIEW] Public method for updating chat last message — always uses full statement
    // so last_message_type is also updated (needed for chat list preview icons)
    updateChatLastMsg(jid, { timestamp, message_id, body, msg_type }) {
        if (!jid) return;
        try {
            statements.updateChatLastMessageFull.run({
                jid:        normalizeJid(jid),
                timestamp,
                message_id,
                body:       body || null,
                msg_type:   msg_type || null,
            });
        } catch (err) { console.error('[AuroraDB] updateChatLastMsg:', err.message); }
    },

    // [FIX-10] Statement terpisah, tidak pakai updateSyncStatus
    // ════════════════════════════════════════════════════════════

    startSync()                      { statements.startSyncStmt.run(); },
    endSync(totalChats = 0, totalMessages = 0) { statements.endSyncStmt.run(totalChats, totalMessages); },
    getSyncStatus()                  { return statements.getSyncStatus.get() || { status: 'idle', is_syncing: 0 }; },

    // ════════════════════════════════════════════════════════════
    // STATS
    // ════════════════════════════════════════════════════════════

    getStats() {
        const row = statements.getStats.get() || {};
        let dbSizeBytes = 0;
        try { dbSizeBytes = fs.statSync(DB_PATH).size; } catch (_) {}
        return {
            ...row,
            dbSizeBytes,
            dbSizeMB: (dbSizeBytes / 1024 / 1024).toFixed(2),
        };
    },

    // ════════════════════════════════════════════════════════════
    // [FIX-11] LEGACY ALIASES — backward compat
    // ════════════════════════════════════════════════════════════

    // Alias yang dulu ada di dalam `statements` tapi harusnya di `database`
    getMessagesFromDB:  (jid, limit, offset) => database.getMessages(jid, limit, offset),
    searchMessagesInDB: (jid, query)         => database.searchMessages(jid, query),
    getDBStats:         ()                   => database.getStats(),

    // ── [FIX-GROUP-NAME] Update group chat name/subject from groupMetadata ──
    // Called after connection:open to backfill group names that were missing.
    updateGroupSubject(jid, subject) {
        if (!jid || !subject) return
        try {
            db.prepare(`
                UPDATE chats SET name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE jid = ? AND is_group = 1
            `).run(subject, jid)
        } catch (_) {}
    },

    // ── [FIX-GROUP-NAME] Bulk: get all group JIDs that have no name ──────────
    getGroupsWithoutName() {
        try {
            return db.prepare(`
                SELECT jid FROM chats
                WHERE is_group = 1 AND is_community = 0
                AND (name IS NULL OR name = '' OR name GLOB '[0-9]*')
                LIMIT 50
            `).all().map(r => r.jid)
        } catch (_) { return [] }
    },
};

module.exports = database;