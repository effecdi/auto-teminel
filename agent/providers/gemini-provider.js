// agent/providers/gemini-provider.js
// Stage 1 — Gemini backend. Wraps ai-clients.streamGemini (already-integrated
// @google/generative-ai SDK). Passes fullContext:true for the whole history.

const { streamGemini } = require('../../ai-clients');
const { Provider, toHistory, normalizeCallbacks } = require('./provider-interface');

class GeminiProvider extends Provider {
    /** @param {string} apiKey Gemini API key (from electron-store 'geminiApiKey') */
    constructor(apiKey) {
        super();
        this.apiKey = apiKey || '';
    }

    get name() { return 'gemini'; }
    supportsTools() { return true; }   // hand-coded file tools (readFile/writeFile/listFiles)
    supportsVision() { return true; }  // accepts attachedMediaFiles (image/video)

    stream(conversation, callbacks, options = {}) {
        const history = toHistory(conversation);
        const cb = normalizeCallbacks(callbacks);
        if (!this.apiKey) {
            cb.onError(new Error('Gemini API 키가 설정되지 않았습니다 (settings: geminiApiKey)'));
            return { abort() {} };
        }
        return streamGemini(this.apiKey, history, cb, { ...options, fullContext: true });
    }
}

module.exports = { GeminiProvider };
