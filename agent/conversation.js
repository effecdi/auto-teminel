// agent/conversation.js
// Stage 1 — full-context conversation store.
//
// Supersedes the legacy prompt truncation in ai-clients.js (last 3-4 messages).
// This holds the COMPLETE message history; providers decide how much to send,
// but the new agentV2 path passes it all through (fullContext:true).
//
// Message shape (kept compatible with ai-clients.js / debate-engine.js roles):
//   { role: 'user' | 'claude' | 'gemini', content: string, ts: number, meta?: object }

const VALID_ROLES = new Set(['user', 'claude', 'gemini']);

function normalizeMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const role = VALID_ROLES.has(m.role) ? m.role : 'user';
    const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    const ts = typeof m.ts === 'number' ? m.ts : Date.now();
    const out = { role, content, ts };
    if (m.meta && typeof m.meta === 'object') out.meta = m.meta;
    return out;
}

class Conversation {
    /** @param {Array} [messages] existing messages to seed from (e.g. restored from electron-store) */
    constructor(messages = []) {
        this.messages = Array.isArray(messages)
            ? messages.map(normalizeMessage).filter(Boolean)
            : [];
    }

    /** Append a message. Returns the normalized message. */
    add(role, content, meta) {
        const msg = normalizeMessage({ role, content, meta });
        this.messages.push(msg);
        return msg;
    }

    addUser(content, meta) { return this.add('user', content, meta); }
    addClaude(content, meta) { return this.add('claude', content, meta); }
    addGemini(content, meta) { return this.add('gemini', content, meta); }

    /** Full history — NO truncation. This is the whole point of the redesign. */
    getMessages() { return this.messages; }

    /** Plain array copy suitable for persistence / passing to providers. */
    toArray() { return this.messages.map(m => ({ ...m })); }

    get length() { return this.messages.length; }

    /** Last message, or null. */
    last() { return this.messages.length ? this.messages[this.messages.length - 1] : null; }

    clear() { this.messages = []; }

    /** Build from a plain array (e.g. restored persisted history). */
    static from(arr) { return new Conversation(arr); }
}

module.exports = { Conversation, normalizeMessage, VALID_ROLES };
