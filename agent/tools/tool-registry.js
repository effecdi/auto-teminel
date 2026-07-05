// agent/tools/tool-registry.js
// Stage 3 — registers built-in (and later MCP) tools and dispatches calls.
//
// Each tool descriptor: { name, description, inputSchema (JSON Schema),
//   requiresApproval (bool), handler(input, ctx) -> Promise<any> }.
// ctx carries { projectPath, signal } and whatever the orchestrator injects.

class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }

    /** Register one tool descriptor. Later registration with same name overrides. */
    register(descriptor) {
        if (!descriptor || !descriptor.name || typeof descriptor.handler !== 'function') {
            throw new Error('tool descriptor requires { name, handler }');
        }
        this.tools.set(descriptor.name, {
            name: descriptor.name,
            description: descriptor.description || '',
            inputSchema: descriptor.inputSchema || { type: 'object', properties: {} },
            requiresApproval: !!descriptor.requiresApproval,
            handler: descriptor.handler,
        });
        return this;
    }

    /** Register many at once. */
    registerAll(descriptors) {
        for (const d of descriptors || []) this.register(d);
        return this;
    }

    has(name) { return this.tools.has(name); }
    get(name) { return this.tools.get(name) || null; }
    list() { return [...this.tools.values()]; }

    /** Remove a tool by name. Returns true if it existed. */
    unregister(name) { return this.tools.delete(name); }

    /** Remove every tool whose name starts with prefix (e.g. 'mcp__'). Returns count removed. */
    unregisterByPrefix(prefix) {
        let n = 0;
        for (const name of [...this.tools.keys()]) {
            if (name.startsWith(prefix)) { this.tools.delete(name); n++; }
        }
        return n;
    }

    /** Anthropic tool_use schema shape (name/description/input_schema). */
    toAnthropicTools() {
        return this.list().map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
        }));
    }

    /**
     * Execute a tool by name. Returns { ok, result } or { ok:false, error }.
     * Never throws — errors are captured so the agent loop can feed them back.
     */
    async dispatch(name, input, ctx = {}) {
        const tool = this.tools.get(name);
        if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
        try {
            const result = await tool.handler(input || {}, ctx);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }
}

module.exports = { ToolRegistry };
