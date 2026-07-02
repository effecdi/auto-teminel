// agent/orchestrator.js
// Stage 3 — agentic loop for the API path (opt-in, claudeMode='api').
//
// Owns the loop: call Claude with tools -> receive tool_use -> gate through the
// approval broker -> dispatch via the tool registry -> feed results back ->
// repeat with the FULL conversation context (no truncation). This is the
// "plan -> execute -> verify -> self-correct" surface for the API backend.
//
// The free CLI default uses cli-agent-bridge.js instead (Claude Code's own loop).

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.Anthropic || AnthropicSDK.default || AnthropicSDK;
const { buildSystemPrompt, toAnthropicMessages } = require('./providers/claude-api-provider');
const { toHistory } = require('./providers/provider-interface');

const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_ITERATIONS = 25; // runaway backstop

class Orchestrator {
    /**
     * @param {object} deps
     * @param {import('./tools/tool-registry').ToolRegistry} deps.registry
     * @param {import('./approvals').ApprovalBroker} deps.approvals
     * @param {(event:string, payload:object)=>void} deps.emit  scoped emitter (runId already bound)
     * @param {string} deps.apiKey
     */
    constructor({ registry, approvals, emit, apiKey }) {
        this.registry = registry;
        this.approvals = approvals;
        this.emit = typeof emit === 'function' ? emit : () => {};
        this.client = new Anthropic({ apiKey });
    }

    /**
     * Run one agent task to completion (or abort).
     * @param {object} task {runId, conversation, projectPath, projectContext, systemPromptSuffix, model, signal}
     */
    async run(task) {
        const { runId, conversation, projectPath, projectContext, systemPromptSuffix, model, signal } = task;
        const system = buildSystemPrompt({ projectContext, systemPromptSuffix });
        const messages = toAnthropicMessages(toHistory(conversation));
        const tools = this.registry.toAnthropicTools();
        const ctx = { projectPath, signal };

        if (!messages.length) { this.emit('error', { message: '대화 내용이 없습니다' }); return; }

        this.emit('status', { phase: 'started' });

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            if (signal && signal.aborted) { this.emit('status', { phase: 'aborted' }); return; }

            let finalMessage;
            try {
                const stream = this.client.messages.stream(
                    { model: model || DEFAULT_MODEL, max_tokens: 16000, system, messages, tools, thinking: { type: 'adaptive' } },
                    { signal }
                );
                stream.on('text', (delta) => this.emit('token', { text: delta }));
                finalMessage = await stream.finalMessage();
            } catch (err) {
                if (signal && signal.aborted) { this.emit('status', { phase: 'aborted' }); return; }
                this.emit('error', { message: err && err.message ? err.message : String(err) });
                return;
            }

            // Record the assistant turn (full content — preserves tool_use blocks).
            messages.push({ role: 'assistant', content: finalMessage.content });

            if (finalMessage.stop_reason !== 'tool_use') {
                this.emit('done', { stopReason: finalMessage.stop_reason });
                return;
            }

            const toolUses = finalMessage.content.filter(b => b.type === 'tool_use');
            const toolResults = [];
            for (const tu of toolUses) {
                if (signal && signal.aborted) { this.emit('status', { phase: 'aborted' }); return; }
                this.emit('toolUse', { id: tu.id, name: tu.name, input: tu.input });

                const descriptor = this.registry.get(tu.name);
                if (descriptor && descriptor.requiresApproval) {
                    const decision = await this.approvals.request({ runId, toolName: tu.name, input: tu.input });
                    if (!decision.approved) {
                        const msg = `사용자가 거부함${decision.reason ? ': ' + decision.reason : ''}`;
                        this.emit('toolResult', { id: tu.id, ok: false, error: msg });
                        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true });
                        continue;
                    }
                }

                const out = await this.registry.dispatch(tu.name, tu.input, ctx);
                if (out.ok) {
                    this.emit('toolResult', { id: tu.id, ok: true, result: out.result });
                    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out.result).slice(0, 20000) });
                } else {
                    this.emit('toolResult', { id: tu.id, ok: false, error: out.error });
                    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out.error, is_error: true });
                }
            }

            messages.push({ role: 'user', content: toolResults });
        }

        this.emit('error', { message: `최대 반복(${MAX_ITERATIONS}) 도달 — 루프 중단` });
    }
}

module.exports = { Orchestrator, MAX_ITERATIONS };
