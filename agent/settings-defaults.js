// agent/settings-defaults.js
// Stage 0 — AI-era redesign (agentV2) baseline settings.
//
// These keys are initialized in electron-store ONLY if absent, so existing
// installs keep their current behavior. Nothing reads these yet in Stage 0;
// later stages (provider-factory, agent-ipc) will consume them.
//
// Cost safety: claudeMode defaults to 'cli' (uses the Claude subscription via
// the `claude` CLI — no per-token billing). 'api' mode is opt-in only.

const AGENT_V2_DEFAULTS = {
    // Master switch for the new agent UI/loop. Off = app behaves exactly as before.
    agentV2Enabled: false,
    // Claude backend: 'cli' (default, free via subscription) | 'api' (opt-in, per-token cost).
    claudeMode: 'cli',
};

/**
 * Initialize agentV2 default settings in the given electron-store instance.
 * Only sets a key if it is not already present, so user/existing values win.
 * Safe to call every startup. Returns the effective values.
 * @param {import('electron-store')} store
 */
function initAgentV2Defaults(store) {
    for (const [key, value] of Object.entries(AGENT_V2_DEFAULTS)) {
        if (store.get(key) === undefined) {
            store.set(key, value);
        }
    }
    return {
        agentV2Enabled: store.get('agentV2Enabled', AGENT_V2_DEFAULTS.agentV2Enabled),
        claudeMode: store.get('claudeMode', AGENT_V2_DEFAULTS.claudeMode),
    };
}

module.exports = { AGENT_V2_DEFAULTS, initAgentV2Defaults };
