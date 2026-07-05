// mcp/mcp-config.js
// Stage 4 — single source of MCP server configuration.
//
// Stored in electron-store under 'mcpServers' as an array of:
//   { id, name, type: 'stdio'|'sse'|'http', command?, args?, env?, url?, enabled }
//
// Also serializes the enabled set into the JSON format the Claude CLI expects
// (--mcp-config), so both the API-path registry and the CLI path share one config.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'mcpServers';

function slugify(name) {
    return String(name || 'server').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

function list(store) {
    const arr = store.get(KEY, []);
    return Array.isArray(arr) ? arr : [];
}

function listEnabled(store) {
    return list(store).filter(s => s.enabled !== false);
}

function add(store, cfg) {
    const servers = list(store);
    const name = cfg.name || cfg.command || cfg.url || 'server';
    const id = cfg.id || `mcp_${slugify(name)}_${servers.length + 1}`;
    const entry = {
        id,
        name: slugify(name),
        type: cfg.type,
        command: cfg.command || undefined,
        args: Array.isArray(cfg.args) ? cfg.args : undefined,
        env: cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined,
        url: cfg.url || undefined,
        enabled: cfg.enabled !== false,
    };
    servers.push(entry);
    store.set(KEY, servers);
    return entry;
}

function remove(store, id) {
    const servers = list(store).filter(s => s.id !== id);
    store.set(KEY, servers);
    return servers;
}

function setEnabled(store, id, enabled) {
    const servers = list(store).map(s => (s.id === id ? { ...s, enabled: !!enabled } : s));
    store.set(KEY, servers);
    return servers;
}

/** Build the Claude CLI --mcp-config JSON object from enabled servers. */
function toCliConfig(store) {
    const mcpServers = {};
    for (const s of listEnabled(store)) {
        if (s.type === 'stdio') {
            mcpServers[s.name] = { command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}) };
        } else if (s.type === 'sse' || s.type === 'http') {
            mcpServers[s.name] = { type: s.type, url: s.url };
        }
    }
    return { mcpServers };
}

/** Write the CLI config to a temp file and return its path (or null if no servers). */
function writeCliConfigFile(store) {
    const cfg = toCliConfig(store);
    if (!Object.keys(cfg.mcpServers).length) return null;
    const file = path.join(os.tmpdir(), `auto-teminel-mcp-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg), 'utf-8');
    return file;
}

module.exports = { list, listEnabled, add, remove, setEnabled, toCliConfig, writeCliConfigFile, slugify, KEY };
