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

function buildRegistry() {
    return new ToolRegistry().registerAll([...fsTools, bashTool, verifyTool]);
}

function register({ ipcMain, getMainWindow, store }) {
    if (!ipcMain || !getMainWindow || !store) throw new Error('agent-ipc.register requires { ipcMain, getMainWindow, store }');

    const registry = buildRegistry();
    const runs = new Map(); // runId -> { controller, approvals }

    const sendToRenderer = (runId, event, payload) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('agentv2.event', { runId, event, payload });
        }
    };

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
                    const orch = new Orchestrator({ registry, approvals, emit, apiKey: anthropicApiKey });
                    await orch.run({ ...task, model: store.get('claudeApiModel', '') || undefined });
                } else {
                    runCliAgent(task, emit);
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

    return { registry };
}

module.exports = { register, buildRegistry };
