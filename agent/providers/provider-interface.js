// agent/providers/provider-interface.js
// Stage 1 — single abstraction over all model backends (Claude CLI / Claude API / Gemini).
//
// Design note: the existing app is callback-based (onToken/onComplete/onError,
// returning { abort() }). Stage 1 keeps that shape so providers drop straight
// into the current wiring with zero risk. Stage 3's orchestrator will adapt
// these callbacks into its async event loop.
//
// Contract every provider implements:
//   get name(): string
//   supportsTools(): boolean       // can run tool-use / has its own tool loop
//   supportsVision(): boolean      // can accept image/video input
//   stream(conversation, callbacks, options): { abort(): void }
//     conversation: agent/conversation.js Conversation OR a plain messages array
//     callbacks: { onToken(text), onComplete(fullText), onError(err) }
//     options: { projectPath?, projectContext?, systemPromptSuffix?, attachedMediaFiles? }

class Provider {
    get name() { return 'abstract'; }
    supportsTools() { return false; }
    supportsVision() { return false; }

    // eslint-disable-next-line no-unused-vars
    stream(conversation, callbacks, options) {
        throw new Error(`Provider "${this.name}" must implement stream()`);
    }
}

/** Coerce a Conversation or plain array into the messages array providers expect. */
function toHistory(conversation) {
    if (conversation && typeof conversation.getMessages === 'function') {
        return conversation.getMessages();
    }
    return Array.isArray(conversation) ? conversation : [];
}

/** Validate callbacks object, filling no-op defaults so providers never crash on missing handlers. */
function normalizeCallbacks(callbacks) {
    const cb = callbacks || {};
    return {
        onToken: typeof cb.onToken === 'function' ? cb.onToken : () => {},
        onComplete: typeof cb.onComplete === 'function' ? cb.onComplete : () => {},
        onError: typeof cb.onError === 'function' ? cb.onError : () => {},
    };
}

module.exports = { Provider, toHistory, normalizeCallbacks };
