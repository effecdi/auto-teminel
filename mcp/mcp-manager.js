// mcp/mcp-manager.js
// Stage 4 — MCP client lifecycle manager.
//
// Connects one client per enabled server, performs the capability handshake,
// and registers each server's tools into the shared agent tool-registry under
// the namespaced name mcp__<server>__<tool>. MCP tools require approval (they
// can do anything). Re-connecting cleanly unregisters stale mcp__ tools first.

const { McpClient } = require('./mcp-client');
const mcpConfig = require('./mcp-config');

class McpManager {
    /** @param {object} deps {registry, store, emit?} */
    constructor({ registry, store, emit }) {
        this.registry = registry;
        this.store = store;
        this.emit = typeof emit === 'function' ? emit : () => {};
        this.clients = new Map(); // serverId -> { client, cfg, tools }
    }

    /** Connect all enabled servers (best-effort). Returns per-server results. */
    async connectAll() {
        await this.disconnectAll();
        const results = [];
        for (const cfg of mcpConfig.listEnabled(this.store)) {
            try {
                const client = new McpClient(cfg);
                const tools = await client.connect();
                this.clients.set(cfg.id, { client, cfg, tools });
                this._registerTools(cfg, client, tools);
                results.push({ id: cfg.id, name: cfg.name, ok: true, toolCount: tools.length });
                this.emit('mcpConnected', { id: cfg.id, name: cfg.name, toolCount: tools.length });
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                results.push({ id: cfg.id, name: cfg.name, ok: false, error: msg });
                this.emit('mcpError', { id: cfg.id, name: cfg.name, error: msg });
            }
        }
        return results;
    }

    _registerTools(cfg, client, tools) {
        for (const t of tools) {
            const name = `mcp__${cfg.name}__${t.name}`;
            this.registry.register({
                name,
                description: `[MCP:${cfg.name}] ${t.description || t.name}`,
                inputSchema: t.inputSchema || { type: 'object', properties: {} },
                requiresApproval: true,
                handler: async (input) => {
                    const out = await client.callTool(t.name, input);
                    if (out.isError) throw new Error(out.text || 'MCP tool error');
                    return out.text;
                },
            });
        }
    }

    /** Close all clients and remove their tools from the registry. */
    async disconnectAll() {
        for (const { client } of this.clients.values()) {
            try { await client.close(); } catch (_) {}
        }
        this.clients.clear();
        if (this.registry) this.registry.unregisterByPrefix('mcp__');
    }

    /** Connect a single server config immediately (test/preview). Does not persist. */
    async testServer(cfg) {
        const client = new McpClient(cfg);
        try {
            const tools = await client.connect();
            const names = tools.map(t => t.name);
            await client.close();
            return { ok: true, toolCount: tools.length, tools: names };
        } catch (err) {
            try { await client.close(); } catch (_) {}
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }

    status() {
        return [...this.clients.values()].map(({ cfg, tools }) => ({
            id: cfg.id, name: cfg.name, type: cfg.type, toolCount: tools.length,
            tools: tools.map(t => t.name),
        }));
    }
}

module.exports = { McpManager };
