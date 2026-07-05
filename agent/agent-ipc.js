// agent/agent-ipc.js
// Stage 3 — registers agentv2.* IPC handlers and wires the agent runtime.
//
// Routing:
//   claudeMode === 'api' AND anthropicApiKey set -> Orchestrator (our tool loop
//     + approvals + full context, per-token cost)
//   otherwise (default) -> cli-agent-bridge (Claude CLI's own loop, free)
//
// main.js calls: require('./agent/agent-ipc').register({ ipcMain, getMainWindow, store })

const { ToolRegistry } = require('./tools/tool-registry');
const { fsTools } = require('./tools/builtin/fs-tools');
const { bashTool } = require('./tools/builtin/bash-tool');
const { verifyTool } = require('./tools/builtin/verify-tool');
const { ApprovalBroker } = require('./approvals');
const { Orchestrator } = require('./orchestrator');
const { runCliAgent } = require('./cli-agent-bridge');
const { Conversation } = require('./conversation');
const { McpManager } = require('../mcp/mcp-manager');
const mcpConfig = require('../mcp/mcp-config');
const { ImageRouter } = require('../imagegen/image-router');

function buildRegistry() {
    return new ToolRegistry().registerAll([...fsTools, bashTool, verifyTool]);
}

function register({ ipcMain, getMainWindow, store }) {
    if (!ipcMain || !getMainWindow || !store) throw new Error('agent-ipc.register requires { ipcMain, getMainWindow, store }');

    const registry = buildRegistry();
    const runs = new Map(); // runId -> { controller, approvals }

    // Broadcast to ALL windows (old terminal panel + new agent workspace window).
    // Each renderer filters by runId, so multiple windows can coexist.
    const { BrowserWindow } = require('electron');
    const broadcast = (channel, msg) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) { try { w.webContents.send(channel, msg); } catch (_) {} }
        }
    };
    const sendToRenderer = (runId, event, payload) => broadcast('agentv2.event', { runId, event, payload });

    // Stage 4 — MCP: connect enabled servers, register their tools into `registry`.
    const broadcastMcp = (event, payload) => broadcast('agentv2.mcp', { event, payload });
    const mcp = new McpManager({ registry, store, emit: broadcastMcp });
    // Best-effort connect at startup (non-blocking).
    Promise.resolve().then(() => mcp.connectAll()).catch(e => console.error('[agentV2] MCP connectAll failed:', e));

    // Stage 6 — image generation: router + a generate_image agent tool.
    const imageRouter = new ImageRouter({ store, getMainWindow });
    registry.register({
        name: 'generate_image',
        description: 'Generate an image from a text prompt and save it into the project. Backend (ChatGPT web / Gemini) follows settings.',
        inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'What to draw' } }, required: ['prompt'] },
        requiresApproval: true,
        handler: async (input, ctx) => {
            const r = await imageRouter.generate(input.prompt, { projectPath: ctx.projectPath });
            return { path: r.path, backend: r.backend, mimeType: r.mimeType };
        },
    });

    // Scoped emitter that also cleans up on terminal events.
    const makeEmit = (runId) => (event, payload) => {
        sendToRenderer(runId, event, payload || {});
        const aborted = event === 'status' && payload && payload.phase === 'aborted';
        if (event === 'done' || event === 'error' || aborted) {
            const r = runs.get(runId);
            if (r) { try { r.approvals.rejectAllPending('run ended'); } catch (_) {} }
            runs.delete(runId);
        }
    };

    ipcMain.handle('agentv2.isEnabled', () => ({
        enabled: !!store.get('agentV2Enabled', false),
        claudeMode: store.get('claudeMode', 'cli'),
        hasAnthropicApiKey: !!store.get('anthropicApiKey', ''),
        autoApprove: !!store.get('agentV2AutoApprove', false),
    }));

    ipcMain.handle('agentv2.setEnabled', (e, on) => { store.set('agentV2Enabled', !!on); return { enabled: !!on }; });

    ipcMain.handle('agentv2.run', async (e, params) => {
        const { runId, projectPath, message, history, projectContext, systemPromptSuffix } = params || {};
        if (!runId || !message) return { started: false, error: 'runId와 message가 필요함' };
        if (runs.has(runId)) return { started: false, error: '이미 실행 중인 runId' };

        const emit = makeEmit(runId);
        const controller = new AbortController();
        const approvals = new ApprovalBroker(emit);
        approvals.setAutoApprove(!!store.get('agentV2AutoApprove', false));
        runs.set(runId, { controller, approvals });

        const conversation = Conversation.from(Array.isArray(history) ? history : []);
        conversation.addUser(message);

        const claudeMode = store.get('claudeMode', 'cli');
        const anthropicApiKey = store.get('anthropicApiKey', '');
        const task = { runId, conversation, projectPath, projectContext, systemPromptSuffix, signal: controller.signal };

        // Fire-and-forget: results stream to the renderer via emit.
        (async () => {
            try {
                if (claudeMode === 'api' && anthropicApiKey) {
                    // MCP tools are already registered into `registry` by the manager.
                    const orch = new Orchestrator({ registry, approvals, emit, apiKey: anthropicApiKey });
                    await orch.run({ ...task, model: store.get('claudeApiModel', '') || undefined });
                } else {
                    // CLI path: hand the enabled MCP servers to the Claude CLI via --mcp-config.
                    let mcpConfigFile = null, mcpServerNames = [];
                    try {
                        mcpConfigFile = mcpConfig.writeCliConfigFile(store);
                        mcpServerNames = mcpConfig.listEnabled(store).map(s => s.name);
                    } catch (_) {}
                    runCliAgent({ ...task, mcpConfigFile, mcpServerNames }, emit);
                }
            } catch (err) {
                emit('error', { message: err && err.message ? err.message : String(err) });
            }
        })();

        return { started: true, backend: (claudeMode === 'api' && anthropicApiKey) ? 'api' : 'cli' };
    });

    ipcMain.handle('agentv2.approve', (e, { runId, id, approved, reason }) => {
        const r = runs.get(runId);
        if (!r) return { ok: false };
        return { ok: r.approvals.resolve(id, approved, reason) };
    });

    ipcMain.handle('agentv2.abort', (e, { runId }) => {
        const r = runs.get(runId);
        if (!r) return { ok: false };
        try { r.controller.abort(); } catch (_) {}
        try { r.approvals.rejectAllPending('aborted'); } catch (_) {}
        return { ok: true };
    });

    ipcMain.handle('agentv2.setAutoApprove', (e, on) => { store.set('agentV2AutoApprove', !!on); return { autoApprove: !!on }; });
    ipcMain.handle('agentv2.listTools', () => registry.list().map(t => ({ name: t.name, description: t.description, requiresApproval: t.requiresApproval })));

    // ---- Stage 4: MCP server management ----
    ipcMain.handle('mcp.listServers', () => mcpConfig.list(store));
    ipcMain.handle('mcp.addServer', async (e, cfg) => {
        const entry = mcpConfig.add(store, cfg || {});
        const results = await mcp.connectAll(); // reconnect so new tools register
        return { entry, results };
    });
    ipcMain.handle('mcp.removeServer', async (e, id) => {
        mcpConfig.remove(store, id);
        const results = await mcp.connectAll();
        return { servers: mcpConfig.list(store), results };
    });
    ipcMain.handle('mcp.setEnabled', async (e, { id, enabled }) => {
        mcpConfig.setEnabled(store, id, enabled);
        const results = await mcp.connectAll();
        return { servers: mcpConfig.list(store), results };
    });
    ipcMain.handle('mcp.reconnect', async () => ({ results: await mcp.connectAll() }));
    ipcMain.handle('mcp.status', () => mcp.status());
    ipcMain.handle('mcp.testServer', async (e, cfg) => mcp.testServer(cfg || {}));

    // ---- Stage 6: image generation ----
    ipcMain.handle('imagegen.generate', async (e, { prompt, projectPath, backend }) => {
        try { return { ok: true, ...(await imageRouter.generate(prompt, { projectPath, backend })) }; }
        catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
    });
    ipcMain.handle('imagegen.chatgptLogin', async () => imageRouter.chatgptLogin());
    ipcMain.handle('imagegen.chatgptHide', () => imageRouter.chatgptHide());
    ipcMain.handle('imagegen.chatgptStatus', async () => imageRouter.chatgptStatus());

    return { registry, mcp, imageRouter };
}

module.exports = { register, buildRegistry };
