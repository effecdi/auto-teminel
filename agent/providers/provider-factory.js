// agent/providers/provider-factory.js
// Stage 1 — selects a provider instance from settings.
//
// Cost safety: for 'claude', DEFAULT is the CLI provider (subscription, free).
// 'api' mode is wired in Stage 2; until then a request for 'api' logs a warning
// and falls back to the free CLI provider so nothing breaks and no cost is
// silently incurred.

const { ClaudeCliProvider } = require('./claude-cli-provider');
const { GeminiProvider } = require('./gemini-provider');

/**
 * @param {'claude'|'gemini'} kind
 * @param {object} [opts]
 * @param {'cli'|'api'} [opts.claudeMode='cli']
 * @param {string} [opts.geminiApiKey]
 * @returns {import('./provider-interface').Provider}
 */
function createProvider(kind, opts = {}) {
    const claudeMode = opts.claudeMode || 'cli';

    if (kind === 'gemini') {
        return new GeminiProvider(opts.geminiApiKey);
    }

    // kind === 'claude' (default)
    if (claudeMode === 'api') {
        // Stage 2 replaces this branch with ClaudeApiProvider.
        console.warn('[provider-factory] claudeMode="api" not available until Stage 2 — falling back to free CLI provider.');
        return new ClaudeCliProvider();
    }
    return new ClaudeCliProvider();
}

/**
 * Convenience: build a provider reading config from an electron-store instance.
 * @param {import('electron-store')} store
 * @param {'claude'|'gemini'} kind
 */
function createFromStore(store, kind) {
    return createProvider(kind, {
        claudeMode: store.get('claudeMode', 'cli'),
        geminiApiKey: store.get('geminiApiKey', ''),
    });
}

module.exports = { createProvider, createFromStore };
