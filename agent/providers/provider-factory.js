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
 * @param {string} [opts.anthropicApiKey]
 * @param {string} [opts.claudeApiModel]
 * @returns {import('./provider-interface').Provider}
 */
function createProvider(kind, opts = {}) {
    const claudeMode = opts.claudeMode || 'cli';

    if (kind === 'gemini') {
        return new GeminiProvider(opts.geminiApiKey);
    }

    // kind === 'claude' (default)
    if (claudeMode === 'api') {
        if (opts.anthropicApiKey) {
            // Lazy require: only load the Anthropic SDK when API mode is actually used.
            const { ClaudeApiProvider } = require('./claude-api-provider');
            return new ClaudeApiProvider(opts.anthropicApiKey, { model: opts.claudeApiModel });
        }
        // API mode requested but no key — fall back to the free CLI provider (no cost, no crash).
        console.warn('[provider-factory] claudeMode="api" but no anthropicApiKey set — falling back to free CLI provider.');
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
        anthropicApiKey: store.get('anthropicApiKey', ''),
        claudeApiModel: store.get('claudeApiModel', ''),
    });
}

module.exports = { createProvider, createFromStore };
