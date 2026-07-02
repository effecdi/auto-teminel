// agent/providers/claude-cli-provider.js
// Stage 1 — DEFAULT Claude backend. Wraps ai-clients.streamClaude (spawns the
// `claude` CLI, which uses the user's subscription = NO per-token cost).
//
// Difference vs the classic path: passes fullContext:true so the ENTIRE
// conversation is sent (no 3-message truncation). Existing callers of
// streamClaude are unaffected — fullContext defaults off there.

const { streamClaude } = require('../../ai-clients');
const { Provider, toHistory, normalizeCallbacks } = require('./provider-interface');

class ClaudeCliProvider extends Provider {
    get name() { return 'claude-cli'; }
    // The Claude Code CLI runs its own agent loop with its own tools (Read/Edit/Bash...).
    supportsTools() { return true; }
    // CLI path does not accept image input in this integration.
    supportsVision() { return false; }

    stream(conversation, callbacks, options = {}) {
        const history = toHistory(conversation);
        const cb = normalizeCallbacks(callbacks);
        return streamClaude(history, cb, { ...options, fullContext: true });
    }
}

module.exports = { ClaudeCliProvider };
