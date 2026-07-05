// mcp/mcp-client.js
// Stage 4 — thin wrapper over the MCP SDK Client for one server.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { createTransport } = require('./transports');

class McpClient {
    constructor(cfg) {
        this.cfg = cfg;
        this.client = null;
        this.tools = [];
        this.connected = false;
    }

    /** Connect + capability handshake + list tools. Returns the tool list. */
    async connect() {
        const transport = createTransport(this.cfg);
        this.client = new Client({ name: 'auto-teminel', version: '1.0.0' });
        await this.client.connect(transport);
        const res = await this.client.listTools();
        this.tools = (res && res.tools) || [];
        this.connected = true;
        return this.tools;
    }

    /** Call a tool by its bare (un-namespaced) name. Returns normalized text + raw. */
    async callTool(name, args) {
        const res = await this.client.callTool({ name, arguments: args || {} });
        // res.content is an array of content blocks; extract text for the agent.
        let text = '';
        if (Array.isArray(res.content)) {
            for (const block of res.content) {
                if (block.type === 'text' && block.text) text += block.text;
            }
        }
        return { text: text || JSON.stringify(res).slice(0, 20000), isError: !!res.isError, raw: res };
    }

    async close() {
        try { if (this.client) await this.client.close(); } catch (_) {}
        this.connected = false;
    }
}

module.exports = { McpClient };
