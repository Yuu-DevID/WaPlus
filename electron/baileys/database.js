// electron/baileys/database.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.resolve(__dirname, './database');
const DB_PATH = path.join(DB_DIR, 'aurora_chat.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ════════════════════════════════════════════════════════════
// TABLES
// ════════════════════════════════════════════════════════════

db.exec(`
    -- Messages table with support for ALL WhatsApp message types
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        participant TEXT,
        push_name TEXT,
        
        -- Message type detection
        message_type TEXT NOT NULL,
        
        -- Basic content (text, caption, etc)
        body TEXT,
        
        -- Full message JSON for complex types
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
        media_is_downloaded INTEGER DEFAULT 0,
        
        -- Context info (reply, mentions, forwarding)
        context_stanza_id TEXT,
        context_participant TEXT,
        context_quoted_message TEXT,
        context_mentioned_jids TEXT, -- JSON array
        context_is_forwarded INTEGER,
        context_forwarding_score INTEGER,
        
        -- Reaction specific
        reaction_text TEXT,
        reaction_target_id TEXT,
        reaction_target_remote_jid TEXT,
        reaction_target_from_me INTEGER,
        
        -- Poll specific
        poll_name TEXT,
        poll_options TEXT, -- JSON array
        poll_selectable_count INTEGER,
        poll_votes TEXT, -- JSON array of votes
        
        -- Location specific
        location_lat REAL,
        location_lng REAL,
        location_name TEXT,
        location_address TEXT,
        location_accuracy INTEGER,
        
        -- Contact specific
        contact_vcard TEXT,
        contact_display_name TEXT,
        
        -- Group specific
        group_subject TEXT,
        group_description TEXT,
        group_participants TEXT, -- JSON array
        
        -- Ephemeral
        ephemeral_expiration INTEGER,
        ephemeral_setting_timestamp INTEGER,
        
        -- Protocol messages (delete, etc)
        protocol_type INTEGER,
        protocol_key_id TEXT,
        
        -- Status
        status INTEGER DEFAULT 0,
        starred INTEGER DEFAULT 0,
        broadcast INTEGER DEFAULT 0,
        
        -- Sync info
        is_history_sync INTEGER DEFAULT 0,
        sync_type TEXT,
        
        -- Timestamps
        message_timestamp INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_remote_jid ON messages(remote_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(message_timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);
    CREATE INDEX IF NOT EXISTS idx_messages_history_sync ON messages(is_history_sync);
    CREATE INDEX IF NOT EXISTS idx_messages_reaction_target ON messages(reaction_target_id);
    CREATE INDEX IF NOT EXISTS idx_messages_protocol ON messages(protocol_type);

    -- Chats table
    CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        is_community INTEGER DEFAULT 0,
        unread_count INTEGER DEFAULT 0,
        last_message_timestamp INTEGER,
        last_message_id TEXT,
        last_message_body TEXT,
        pinned INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        muted_until INTEGER,
        profile_pic_url TEXT,
        status TEXT,
        presence TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chats_timestamp ON chats(last_message_timestamp);
    CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(pinned);

    -- Contacts table
    CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        push_name TEXT,
        short_name TEXT,
        number TEXT,
        status TEXT,
        profile_pic_url TEXT,
        is_group INTEGER DEFAULT 0,
        is_user INTEGER DEFAULT 0,
        is_business INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Media downloads tracking
    CREATE TABLE IF NOT EXISTS media_downloads (
        message_id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        media_type TEXT NOT NULL,
        original_url TEXT,
        local_path TEXT,
        file_size INTEGER,
        download_status TEXT DEFAULT 'pending', -- pending, downloaded, failed, expired
        download_attempts INTEGER DEFAULT 0,
        error_message TEXT,
        downloaded_at DATETIME,
        FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    -- Poll votes tracking
    CREATE TABLE IF NOT EXISTS poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_message_id TEXT NOT NULL,
        voter_jid TEXT NOT NULL,
        selected_options TEXT, -- JSON array of option names
        timestamp INTEGER,
        FOREIGN KEY (poll_message_id) REFERENCES messages(id)
    );

    -- Message edits tracking
    CREATE TABLE IF NOT EXISTS message_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_message_id TEXT NOT NULL,
        edited_body TEXT,
        edited_timestamp INTEGER,
        FOREIGN KEY (original_message_id) REFERENCES messages(id)
    );

    -- Sync status tracking
    CREATE TABLE IF NOT EXISTS sync_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_syncing INTEGER DEFAULT 0,
        sync_started_at DATETIME,
        sync_completed_at DATETIME,
        total_chats INTEGER DEFAULT 0,
        total_messages INTEGER DEFAULT 0,
        last_sync_timestamp INTEGER
    );

    INSERT OR IGNORE INTO sync_status (id) VALUES (1);
`);

// ════════════════════════════════════════════════════════════
// PREPARED STATEMENTS
// ════════════════════════════════════════════════════════════

const statements = {
    // Messages
    insertMessage: db.prepare(`
        INSERT OR REPLACE INTO messages (
            id, remote_jid, from_me, participant, push_name, message_type, body,
            message_json, media_mimetype, media_file_name, media_file_length,
            media_duration, media_height, media_width, media_caption, media_key,
            media_direct_path, media_url, media_sha256, media_enc_sha256,
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
    getMessagesByJid: db.prepare(`
        SELECT
            msg.id,
            msg.remote_jid              AS chat_jid,
            msg.from_me,
            msg.participant             AS sender_jid,
            COALESCE(msg.push_name, c.name, c.push_name) AS sender_name,
            msg.message_type            AS msg_type,
            msg.body,
            msg.message_timestamp       AS timestamp,
            msg.status, msg.starred, msg.broadcast,
            msg.is_history_sync,
            msg.media_mimetype          AS mimetype,
            msg.media_duration          AS duration,
            msg.media_saved_path,
            msg.media_is_downloaded,
            msg.media_url,
            msg.poll_options,
            msg.poll_votes,
            msg.context_stanza_id       AS quoted_id,
            msg.context_participant     AS quoted_sender,
            msg.context_quoted_message  AS quoted_body,
            msg.location_lat, msg.location_lng, msg.location_name, msg.location_address,
            msg.reaction_text, msg.reaction_target_id,
            CASE WHEN msg.remote_jid LIKE '%@g.us' THEN 1 ELSE 0 END AS is_group
        FROM messages msg
        LEFT JOIN contacts c ON c.jid = msg.participant
        WHERE msg.remote_jid = ?
        ORDER BY msg.message_timestamp DESC
        LIMIT @limit OFFSET @offset
    `),
    searchMessages: db.prepare(`
        SELECT * FROM messages 
        WHERE remote_jid = @jid AND body LIKE @query 
        ORDER BY message_timestamp DESC 
        LIMIT 100
    `),
    updateMessageStatus: db.prepare('UPDATE messages SET status = ? WHERE id = ?'),
    updateMessageStarred: db.prepare('UPDATE messages SET starred = ? WHERE id = ?'),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
    getLastMessageByJid: db.prepare(`
        SELECT * FROM messages 
        WHERE remote_jid = ? 
        ORDER BY message_timestamp DESC 
        LIMIT 1
    `),

    // Chats
    insertChat: db.prepare(`
        INSERT OR REPLACE INTO chats (
            jid, name, is_group, is_community, unread_count,
            last_message_timestamp, last_message_id, last_message_body,
            pinned, archived, muted_until, profile_pic_url, status, presence
        ) VALUES (
            @jid, @name, @is_group, @is_community, @unread_count,
            @last_message_timestamp, @last_message_id, @last_message_body,
            @pinned, @archived, @muted_until, @profile_pic_url, @status, @presence
        )
    `),
    getChats: db.prepare(`
        SELECT
            c.jid,
            COALESCE(c.name, ct.name, ct.push_name, ct.short_name) AS name,
            c.is_group, c.is_community, c.unread_count, c.pinned, c.archived,
            c.muted_until,
            COALESCE(c.profile_pic_url, ct.profile_pic_url) AS profile_pic_url,
            c.status, c.presence,
            c.last_message_timestamp    AS last_msg_at,
            c.last_message_body         AS last_msg,
            c.last_message_id           AS last_msg_id,
            m.message_type              AS last_msg_type,
            COALESCE(m.push_name, msender.name, msender.push_name) AS last_sender_name,
            m.from_me                   AS from_me
        FROM chats c
        LEFT JOIN contacts ct ON ct.jid = c.jid
        LEFT JOIN messages m ON m.id = c.last_message_id
        LEFT JOIN contacts msender ON msender.jid = m.participant
        ORDER BY c.pinned DESC, c.last_message_timestamp DESC
        LIMIT @limit OFFSET @offset
    `),
    getChatByJid: db.prepare('SELECT * FROM chats WHERE jid = ?'),
    updateChatUnread: db.prepare('UPDATE chats SET unread_count = ? WHERE jid = ?'),
    updateChatPinned: db.prepare('UPDATE chats SET pinned = ? WHERE jid = ?'),
    updateChatArchived: db.prepare('UPDATE chats SET archived = ? WHERE jid = ?'),
    updateChatLastMessage: db.prepare(`
        UPDATE chats SET 
            last_message_timestamp = @timestamp,
            last_message_id = @message_id,
            last_message_body = @body
        WHERE jid = @jid
    `),

    // Contacts
    insertContact: db.prepare(`
        INSERT OR REPLACE INTO contacts (
            jid, name, push_name, short_name, number, status,
            profile_pic_url, is_group, is_user, is_business
        ) VALUES (
            @jid, @name, @push_name, @short_name, @number, @status,
            @profile_pic_url, @is_group, @is_user, @is_business
        )
    `),
    getContacts: db.prepare('SELECT * FROM contacts ORDER BY name LIMIT @limit OFFSET @offset'),
    searchContacts: db.prepare(`
        SELECT * FROM contacts 
        WHERE name LIKE @query OR push_name LIKE @query OR number LIKE @query
        LIMIT 50
    `),
    getContactByJid: db.prepare('SELECT * FROM contacts WHERE jid = ?'),

    // Media downloads
    insertMediaDownload: db.prepare(`
        INSERT OR REPLACE INTO media_downloads (
            message_id, remote_jid, media_type, original_url, download_status
        ) VALUES (@message_id, @remote_jid, @media_type, @original_url, @download_status)
    `),
    updateMediaDownload: db.prepare(`
        UPDATE media_downloads SET
            local_path = @local_path,
            file_size = @file_size,
            download_status = @download_status,
            download_attempts = download_attempts + 1,
            error_message = @error_message,
            downloaded_at = CURRENT_TIMESTAMP
        WHERE message_id = @message_id
    `),
    getPendingMediaDownloads: db.prepare(`
        SELECT * FROM media_downloads 
        WHERE download_status = 'pending' 
        ORDER BY download_attempts ASC 
        LIMIT 10
    `),

    // Sync status
    updateSyncStatus: db.prepare(`
        UPDATE sync_status SET
            is_syncing = @is_syncing,
            sync_started_at = @sync_started_at,
            sync_completed_at = @sync_completed_at,
            total_chats = @total_chats,
            total_messages = @total_messages,
            last_sync_timestamp = @last_sync_timestamp
        WHERE id = 1
    `),
    getSyncStatus: db.prepare('SELECT * FROM sync_status WHERE id = 1'),

    // Stats
    getStats: db.prepare(`
        SELECT 
            (SELECT COUNT(*) FROM messages) as total_messages,
            (SELECT COUNT(*) FROM chats) as total_chats,
            (SELECT COUNT(*) FROM contacts) as total_contacts,
            (SELECT COUNT(*) FROM messages WHERE is_history_sync = 1) as history_messages,
            (SELECT COUNT(*) FROM messages WHERE media_is_downloaded = 1) as downloaded_media,
            (SELECT COUNT(*) FROM media_downloads WHERE download_status = 'pending') as pending_downloads
    `)
};

// ════════════════════════════════════════════════════════════
// MESSAGE TYPE DETECTOR
// ════════════════════════════════════════════════════════════

function detectMessageType(message) {
    if (!message) return 'unknown';

    // Ephemeral wrapper — unwrap to inner type
    if (message.ephemeralMessage?.message) {
        return detectMessageType(message.ephemeralMessage.message);
    }

    // View once wrapper
    if (message.viewOnceMessage) return 'viewOnceMessage';
    if (message.viewOnceMessageV2) return 'viewOnceMessageV2';

    // Edited message — treat as text
    if (message.editedMessage) return 'extendedTextMessage';

    // Protocol messages (delete, etc)
    if (message.protocolMessage) {
        return 'protocol';
    }

    // Direct message types
    const types = [
        'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
        'audioMessage', 'pttMessage', 'documentMessage', 'stickerMessage', 'locationMessage',
        'liveLocationMessage', 'contactMessage', 'contactsArrayMessage',
        'reactionMessage', 'pollCreationMessage', 'pollUpdateMessage',
        'groupInviteMessage', 'paymentMessage', 'orderMessage', 'productMessage',
        'eventMessage', 'callMessage', 'buttonsMessage', 'buttonsResponseMessage',
        'listMessage', 'listResponseMessage', 'interactiveMessage', 'carouselMessage',
        'albumMessage', 'pollResultMessage', 'sharePhoneNumberMessage',
        'requestPhoneNumberMessage', 'adminInviteMessage', 'paymentInviteMessage',
        'pinInChatMessage', 'keepInChatMessage', 'ptvMessage'
    ];

    // PTT (voice note) — Baileys uses audioMessage with ptt=true
    if (message.audioMessage?.ptt) return 'pttMessage';

    for (const type of types) {
        if (message[type]) return type;  // return full type e.g. "imageMessage"
    }

    return 'unknown';
}

// ════════════════════════════════════════════════════════════
// CONTENT EXTRACTOR
// ════════════════════════════════════════════════════════════

function extractContent(message, type) {
    const result = {
        body: '',
        media: null,
        context: null,
        reaction: null,
        poll: null,
        location: null,
        contact: null,
        protocol: null
    };

    // ── Unwrap message wrappers ──────────────────────────────────────────────
    let actualMessage = message;

    if (message.ephemeralMessage?.message) {
        actualMessage = message.ephemeralMessage.message;
        type = detectMessageType(actualMessage);
    } else if (message.viewOnceMessage?.message) {
        actualMessage = message.viewOnceMessage.message;
        type = detectMessageType(actualMessage);
    } else if (message.viewOnceMessageV2?.message) {
        actualMessage = message.viewOnceMessageV2.message;
        type = detectMessageType(actualMessage);
    } else if (message.editedMessage?.message) {
        actualMessage = message.editedMessage.message;
        type = detectMessageType(actualMessage);
    }

    const msg = actualMessage;

    // ── Normalize type ───────────────────────────────────────────────────────
    // detectMessageType() returns FULL Baileys type names e.g. "extendedTextMessage"
    // but the old switch used SHORT names e.g. "extendedText". Normalize to
    // full names so both old DB rows (short) and new rows (full) work correctly.
    // We just add all full-name cases alongside the short ones in the switch below.

    switch (type) {
        case 'conversation':
            result.body = msg.conversation || '';
            break;

        // ── THE BUG: was only 'extendedText', but detectMessageType returns 'extendedTextMessage'
        case 'extendedTextMessage':
        case 'extendedText':
            result.body = msg.extendedTextMessage?.text || '';
            result.context = extractContextInfo(msg.extendedTextMessage?.contextInfo);
            break;

        case 'imageMessage':
        case 'image':
            result.body = msg.imageMessage?.caption || '';
            result.media = extractMediaInfo(msg.imageMessage, 'image');
            result.context = extractContextInfo(msg.imageMessage?.contextInfo);
            break;

        case 'videoMessage':
        case 'video':
            result.body = msg.videoMessage?.caption || '';
            result.media = extractMediaInfo(msg.videoMessage, 'video');
            result.context = extractContextInfo(msg.videoMessage?.contextInfo);
            break;

        case 'audioMessage':
        case 'audio':
            result.media = extractMediaInfo(msg.audioMessage, 'audio');
            break;

        case 'pttMessage':
        case 'ptt':
            result.media = extractMediaInfo(msg.audioMessage, 'audio');
            break;

        case 'documentMessage':
        case 'document':
            result.body = msg.documentMessage?.fileName || msg.documentMessage?.caption || '';
            result.media = extractMediaInfo(msg.documentMessage, 'document');
            result.context = extractContextInfo(msg.documentMessage?.contextInfo);
            break;

        case 'stickerMessage':
        case 'sticker':
            result.media = extractMediaInfo(msg.stickerMessage, 'sticker');
            break;

        case 'locationMessage':
        case 'location':
            result.location = {
                lat: msg.locationMessage?.degreesLatitude,
                lng: msg.locationMessage?.degreesLongitude,
                name: msg.locationMessage?.name,
                address: msg.locationMessage?.address
            };
            result.body = msg.locationMessage?.name || msg.locationMessage?.address || '';
            break;

        case 'liveLocationMessage':
        case 'liveLocation':
            result.location = {
                lat: msg.liveLocationMessage?.degreesLatitude,
                lng: msg.liveLocationMessage?.degreesLongitude,
                accuracy: msg.liveLocationMessage?.accuracyInMeters,
            };
            result.body = msg.liveLocationMessage?.caption || '';
            break;

        case 'contactMessage':
        case 'contact':
            result.contact = {
                displayName: msg.contactMessage?.displayName,
                vcard: msg.contactMessage?.vcard
            };
            result.body = msg.contactMessage?.displayName || '';
            break;

        case 'contactsArrayMessage':
        case 'contactsArray':
            result.body = (msg.contactsArrayMessage?.contacts || [])
                .map(c => c.displayName).filter(Boolean).join(', ');
            break;

        case 'reactionMessage':
        case 'reaction':
            result.reaction = {
                text: msg.reactionMessage?.text,
                targetId: msg.reactionMessage?.key?.id,
                targetRemoteJid: msg.reactionMessage?.key?.remoteJid,
                targetFromMe: msg.reactionMessage?.key?.fromMe
            };
            result.body = msg.reactionMessage?.text || '';
            break;

        case 'pollCreationMessage':
        case 'pollCreation':
            result.poll = {
                name: msg.pollCreationMessage?.name,
                options: msg.pollCreationMessage?.options?.map(o => o.optionName) || [],
                selectableCount: msg.pollCreationMessage?.selectableOptionsCount
            };
            result.body = msg.pollCreationMessage?.name || '';
            break;

        case 'protocol':
            result.protocol = {
                type: msg.protocolMessage?.type,
                keyId: msg.protocolMessage?.key?.id
            };
            break;

        case 'groupInviteMessage':
        case 'groupInvite':
            result.body = msg.groupInviteMessage?.groupName || msg.groupInviteMessage?.caption || '';
            break;

        case 'payment':
        case 'paymentMessage':
            result.body = `Pembayaran: ${msg.paymentMessage?.amount || ''} ${msg.paymentMessage?.currency || ''}`.trim();
            break;

        case 'order':
        case 'orderMessage':
            result.body = msg.orderMessage?.orderTitle || 'Pesanan';
            break;

        case 'event':
        case 'eventMessage':
            result.body = msg.eventMessage?.name || 'Acara';
            break;

        case 'buttons':
        case 'buttonsMessage':
            result.body = msg.buttonsMessage?.contentText || msg.buttonsMessage?.text || '';
            break;

        case 'list':
        case 'listMessage':
            result.body = msg.listMessage?.description || msg.listMessage?.title || '';
            break;

        case 'ptv':
        case 'ptvMessage':
            result.media = extractMediaInfo(msg.ptvMessage, 'video');
            break;
    }

    return result;
}

function extractMediaInfo(mediaObj, type) {
    if (!mediaObj) return null;

    return {
        mimetype: mediaObj.mimetype,
        fileName: mediaObj.fileName,
        fileLength: mediaObj.fileLength,
        duration: mediaObj.seconds,
        height: mediaObj.height,
        width: mediaObj.width,
        caption: mediaObj.caption,
        mediaKey: mediaObj.mediaKey,
        directPath: mediaObj.directPath,
        url: mediaObj.url,
        sha256: mediaObj.fileSha256,
        encSha256: mediaObj.fileEncSha256,
        ptt: mediaObj.ptt // For audio
    };
}

function extractContextInfo(contextInfo) {
    if (!contextInfo) return null;

    return {
        stanzaId: contextInfo.stanzaId,
        participant: contextInfo.participant,
        quotedMessage: contextInfo.quotedMessage ? JSON.stringify(contextInfo.quotedMessage) : null,
        mentionedJids: contextInfo.mentionedJid ? JSON.stringify(contextInfo.mentionedJid) : null,
        isForwarded: contextInfo.isForwarded,
        forwardingScore: contextInfo.forwardingScore
    };
}

// ════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ════════════════════════════════════════════════════════════

const database = {
    // Messages
    saveMessage: (msg, isHistorySync = false, syncType = null) => {
        try {
            const type = detectMessageType(msg.message);
            const content = extractContent(msg.message, type);

            // Sanitize helpers — Baileys uses protobufjs Long objects for numeric fields
            const toNum = (v) => {
                if (v == null) return null;
                if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
                const n = Number(v); return isNaN(n) ? null : n;
            };
            const toStr = (v) => {
                if (v == null) return null;
                if (typeof v === 'string') return v;
                if (typeof v === 'object') return JSON.stringify(v);
                return String(v);
            };
            const toBool = (v) => (v ? 1 : 0);

            const params = {
                id: toStr(msg.key.id),
                remote_jid: toStr(msg.key.remoteJid),
                from_me: toBool(msg.key.fromMe),
                participant: toStr(msg.participant),
                push_name: toStr(msg.pushName),
                message_type: toStr(type),
                body: toStr(content.body),
                message_json: JSON.stringify(msg.message),

                // Media — fileLength/duration/height/width are Long in Baileys
                media_mimetype: toStr(content.media?.mimetype),
                media_file_name: toStr(content.media?.fileName),
                media_file_length: toNum(content.media?.fileLength),
                media_duration: toNum(content.media?.duration),
                media_height: toNum(content.media?.height),
                media_width: toNum(content.media?.width),
                media_caption: toStr(content.media?.caption),
                media_key: content.media?.mediaKey ? Buffer.from(content.media.mediaKey).toString('base64') : null,
                media_direct_path: toStr(content.media?.directPath),
                media_url: toStr(content.media?.url),
                media_sha256: content.media?.sha256 ? Buffer.from(content.media.sha256).toString('base64') : null,
                media_enc_sha256: content.media?.encSha256 ? Buffer.from(content.media.encSha256).toString('base64') : null,

                // Context
                context_stanza_id: toStr(content.context?.stanzaId),
                context_participant: toStr(content.context?.participant),
                context_quoted_message: toStr(content.context?.quotedMessage),
                context_mentioned_jids: toStr(content.context?.mentionedJids),
                context_is_forwarded: toBool(content.context?.isForwarded),
                context_forwarding_score: toNum(content.context?.forwardingScore) ?? 0,

                // Reaction
                reaction_text: toStr(content.reaction?.text),
                reaction_target_id: toStr(content.reaction?.targetId),
                reaction_target_remote_jid: toStr(content.reaction?.targetRemoteJid),
                reaction_target_from_me: toBool(content.reaction?.targetFromMe),

                // Poll
                poll_name: toStr(content.poll?.name),
                poll_options: content.poll?.options ? JSON.stringify(content.poll.options) : null,
                poll_selectable_count: toNum(content.poll?.selectableCount),
                poll_votes: null,

                // Location
                location_lat: toNum(content.location?.lat),
                location_lng: toNum(content.location?.lng),
                location_name: toStr(content.location?.name),
                location_address: toStr(content.location?.address),
                location_accuracy: toNum(content.location?.accuracy),

                // Contact
                contact_vcard: toStr(content.contact?.vcard),
                contact_display_name: toStr(content.contact?.displayName),

                // Protocol
                protocol_type: toNum(content.protocol?.type),
                protocol_key_id: toStr(content.protocol?.keyId),

                // Status
                status: toNum(msg.status) ?? 0,
                starred: toBool(msg.starred),
                broadcast: toBool(msg.broadcast),

                // Sync
                is_history_sync: toBool(isHistorySync),
                sync_type: toStr(syncType),

                // messageTimestamp is a Long object in Baileys!
                message_timestamp: toNum(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000)
            };

            statements.insertMessage.run(params);

            // Update chat last message
            if (!isHistorySync) {
                statements.updateChatLastMessage.run({
                    jid: msg.key.remoteJid,
                    timestamp: params.message_timestamp,
                    message_id: msg.key.id,
                    body: params.body || `[${type}]`
                });
            }

            return { success: true, type, hasMedia: !!content.media };
        } catch (error) {
            console.error('Error saving message:', error);
            return { success: false, error: error.message };
        }
    },

    getMessages: (jid, limit = 50, offset = 0) => {
        return statements.getMessagesByJid.all(jid, { limit, offset });
    },

    searchMessages: (jid, query) => {
        return statements.searchMessages.all({ jid, query: `%${query}%` });
    },

    updateMessageStatus: (id, status) => {
        statements.updateMessageStatus.run(status, id);
    },

    // Chats
    saveChat: (chat) => {
        try {
            statements.insertChat.run({
                jid: chat.id,
                name: chat.name || chat.subject || null,
                is_group: chat.isGroup ? 1 : 0,
                is_community: chat.isCommunity ? 1 : 0,
                unread_count: chat.unreadCount || 0,
                last_message_timestamp: chat.lastMessageTimestamp || null,
                last_message_id: chat.lastMessageKey?.id || null,
                last_message_body: null, // Will be updated when message saved
                pinned: chat.pinned ? 1 : 0,
                archived: chat.archived ? 1 : 0,
                muted_until: chat.muteEndTime || null,
                profile_pic_url: chat.profilePicUrl || null,
                status: chat.status || null,
                presence: chat.presence || null
            });
            return { success: true };
        } catch (error) {
            console.error('Error saving chat:', error);
            return { success: false, error: error.message };
        }
    },

    getChats: (limit = 50, offset = 0) => {
        return statements.getChats.all({ limit, offset });
    },

    updateChatRead: (jid) => {
        statements.updateChatUnread.run(0, jid);
    },

    updateChatPinned: (jid, pinned) => {
        statements.updateChatPinned.run(pinned ? 1 : 0, jid);
    },

    updateChatArchived: (jid, archived) => {
        statements.updateChatArchived.run(archived ? 1 : 0, jid);
    },

    // Aliases used by main.js IPC handlers
    markChatRead: (jid) => {
        statements.updateChatUnread.run(0, jid);
    },
    pinChat: (jid, pinned) => {
        statements.updateChatPinned.run(pinned ? 1 : 0, jid);
    },
    archiveChat: (jid, archived) => {
        statements.updateChatArchived.run(archived ? 1 : 0, jid);
    },

    // ── updateChatUnread — called from client.js chats.update event ──
    updateChatUnread: (jid, count) => {
        statements.updateChatUnread.run(count ?? 0, jid);
    },

    // ── getMessageById — called from getMessage() and media download ──
    getMessageById: (id) => {
        return statements.getMessageById.get(id) || null;
    },

    // ── saveMessageEdit — called from messages.update edited messages ──
    saveMessageEdit: (id, newBody, timestamp) => {
        try {
            db.prepare('UPDATE messages SET body = ?, message_timestamp = ? WHERE id = ?')
                .run(newBody ?? null, timestamp ?? Date.now(), id);
        } catch (err) { console.error('[DB] saveMessageEdit:', err.message); }
    },

    // ── savePollVote — called from messages.update poll votes ──
    savePollVote: (messageId, senderJid, vote) => {
        try {
            db.prepare(`
                INSERT OR REPLACE INTO poll_votes (message_id, sender_jid, vote, voted_at)
                VALUES (?, ?, ?, ?)
            `).run(messageId, senderJid, JSON.stringify(vote), Math.floor(Date.now() / 1000));
        } catch (err) { console.error('[DB] savePollVote:', err.message); }
    },

    // ── updatePollVotes — update poll_votes JSON on message row ──
    updatePollVotes: (id, pollResultsJson) => {
        try {
            db.prepare('UPDATE messages SET poll_votes = ? WHERE id = ?')
                .run(pollResultsJson, id);
        } catch (err) { console.error('[DB] updatePollVotes:', err.message); }
    },

    // ── updateMediaSavedPath — replaces inline new Database() in client.js ──
    updateMediaSavedPath: (id, localPath) => {
        try {
            db.prepare('UPDATE messages SET media_saved_path = ?, media_is_downloaded = 1 WHERE id = ?')
                .run(localPath, id);
        } catch (err) { console.error('[DB] updateMediaSavedPath:', err.message); }
    },

    // ── Aliases for main.js IPC bridge ──
    getMessagesFromDB: (jid, limit = 50, offset = 0) => {
        return statements.getMessagesByJid.all(jid, { limit, offset });
    },
    searchMessagesInDB: (jid, query) => {
        return statements.searchMessages.all({ jid, query: `%${query}%` });
    },
    getDBStats: () => {
        return statements.getStats.get();
    },

    // Contacts
    saveContact: (contact) => {
        try {
            statements.insertContact.run({
                jid: contact.id,
                name: contact.name || null,
                push_name: contact.pushname || null,
                short_name: contact.shortName || null,
                number: contact.number || contact.id.split('@')[0],
                status: contact.status || null,
                profile_pic_url: contact.profilePicUrl || null,
                is_group: contact.isGroup ? 1 : 0,
                is_user: contact.isUser ? 1 : 0,
                is_business: contact.isBusiness ? 1 : 0
            });
            return { success: true };
        } catch (error) {
            console.error('Error saving contact:', error);
            return { success: false, error: error.message };
        }
    },

    saveContacts: (contacts) => {
        const insert = db.transaction((contacts) => {
            for (const contact of contacts) {
                database.saveContact(contact);
            }
        });
        insert(contacts);
    },

    getContacts: (limit = 100, offset = 0) => {
        return statements.getContacts.all({ limit, offset });
    },

    searchContacts: (query) => {
        return statements.searchContacts.all({ query: `%${query}%` });
    },

    // Media
    queueMediaDownload: (messageId, remoteJid, mediaType, url) => {
        try {
            statements.insertMediaDownload.run({
                message_id: messageId,
                remote_jid: remoteJid,
                media_type: mediaType,
                original_url: url,
                download_status: 'pending'
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    updateMediaDownload: (messageId, localPath, fileSize, status, errorMessage = null) => {
        statements.updateMediaDownload.run({
            message_id: messageId,
            local_path: localPath,
            file_size: fileSize,
            download_status: status,
            error_message: errorMessage
        });
    },

    getPendingMediaDownloads: () => {
        return statements.getPendingMediaDownloads.all();
    },

    // Sync status
    startSync: () => {
        statements.updateSyncStatus.run({
            is_syncing: 1,
            sync_started_at: new Date().toISOString(),
            sync_completed_at: null,
            total_chats: 0,
            total_messages: 0,
            last_sync_timestamp: null
        });
    },

    endSync: (totalChats, totalMessages) => {
        statements.updateSyncStatus.run({
            is_syncing: 0,
            sync_started_at: null,
            sync_completed_at: new Date().toISOString(),
            total_chats: totalChats,
            total_messages: totalMessages,
            last_sync_timestamp: Math.floor(Date.now() / 1000)
        });
    },

    getSyncStatus: () => {
        return statements.getSyncStatus.get();
    },

    // Stats
    getStats: () => {
        return statements.getStats.get();
    },

    // ── Count helpers (called by main.js IPC handlers) ────────────────
    getChatCount: () => {
        return (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_community = 0').get()?.n) || 0;
    },
    getGroupCount: () => {
        return (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_group = 1').get()?.n) || 0;
    },
    getCommunityCount: () => {
        return (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_community = 1').get()?.n) || 0;
    },
    getContactCount: () => {
        return (db.prepare('SELECT COUNT(*) as n FROM contacts').get()?.n) || 0;
    },
    getMessageCount: (jid) => {
        return (db.prepare('SELECT COUNT(*) as n FROM messages WHERE remote_jid = ?').get(jid)?.n) || 0;
    },

    // Global message search (across all chats)
searchMessagesGlobal: (query) => {
    // Gunakan template literal yang benar untuk LIKE operator
    const searchPattern = `%${query}%`;
    return db.prepare(`
        SELECT
            id, remote_jid AS chat_jid, from_me, push_name AS sender_name,
            message_type AS msg_type, body, message_timestamp AS timestamp,
            status, is_history_sync,
            CASE WHEN remote_jid LIKE '%@g.us' THEN 1 ELSE 0 END AS is_group
        FROM messages
        WHERE body LIKE ?
        ORDER BY message_timestamp DESC
        LIMIT 100
    `).all(searchPattern); // Masukkan variabel ke sini
},

// Bulk upsert contacts (optimized with transaction)
bulkUpsertContacts: (contacts) => {
    // Pastikan 'database.saveContact' sudah terdefinisi atau ganti ke db.prepare langsung
    const insertAction = db.transaction((list) => {
        for (const contact of list) {
            // Asumsi: database.saveContact adalah fungsi lain yang melakukan INSERT/REPLACE
            database.saveContact(contact);
        }
    });

    try { 
        insertAction(contacts); 
    } catch (err) { 
        console.error('[DB] bulkUpsertContacts error:', err.message); 
    }
},

// Groups subset
getGroups: (limit = 200, offset = 0) => {
    return db.prepare(`
        SELECT
            c.jid, c.name, c.is_group, c.is_community, c.unread_count, c.pinned,
            c.last_message_timestamp AS last_msg_at,
            c.last_message_body      AS last_msg
        FROM chats c
        WHERE c.is_group = 1
        ORDER BY c.last_message_timestamp DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
},

// Communities subset
getCommunities: (limit = 100, offset = 0) => {
    return db.prepare(`
        SELECT jid, name, is_group, is_community, unread_count, pinned,
               last_message_timestamp AS last_msg_at,
               last_message_body      AS last_msg
        FROM chats
        WHERE is_community = 1
        ORDER BY last_message_timestamp DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
},

    // init() — called by main.js after require(). DB is already open (better-sqlite3
    // opens synchronously), so this just validates the connection is alive.
    init: () => {
        // Verify DB is open by running a trivial query
        db.prepare('SELECT 1').get();
    },

    // Close connection
    close: () => {
        db.close();
    }
// Tidak perlu kurung kurawal tutup tambahan di sini jika ini akhir dari object
};

module.exports = database;