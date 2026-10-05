// agent/providers/claude-api-provider.js
// Stage 2 — OPTIONAL Claude backend via the Anthropic API (@anthropic-ai/sdk).
//
// COST WARNING: this path bills per token, separate from the Claude subscription
// the CLI uses. It is only selected when settings.claudeMode === 'api'. Default
// stays 'cli' (free). Advantages: vision (image input) + structured streaming.
//
// Model default: claude-opus-5-5 (current most capable). Opus (4.8+ / 5.x) rejects
// temperature/top_p/top_k and budget_tokens — we send none of them; adaptive
// thinking is on so the model self-moderates reasoning depth.

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.Anthropic || AnthropicSDK.default || AnthropicSDK;
const { CLAUDE_SYSTEM_PROMPT, buildProjectAwarePrompt } = require('../../ai-personas');
const { Provider, toHistory, normalizeCallbacks } = require('./provider-interface');

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_MAX_TOKENS = 16000;

/** Build the system prompt the same way ai-clients.buildClaudePrompt does. */
function buildSystemPrompt(options = {}) {
    let systemPrompt = CLAUDE_SYSTEM_PROMPT;
    if (options.projectContext) {
        systemPrompt = buildProjectAwarePrompt(systemPrompt, options.projectContext);
    }
    if (options.systemPromptSuffix) {
        systemPrompt += `\n\n## 현재 모드 지침\n${options.systemPromptSuffix}`;
    }
    return systemPrompt;
}

/**
 * Convert our conversation (roles user/claude/gemini) to Anthropic messages
 * (roles user/assistant). claude/gemini both map to assistant; gemini turns are
 * labelled so Claude can tell who said what. Consecutive same-role turns are
 * merged, and any leading assistant turns are dropped (API requires user first).
 */
function toAnthropicMessages(history) {
    const msgs = [];
    for (const m of history) {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const text = m.role === 'gemini' ? `[Gemini(시니어 디자이너)]: ${m.content}` : m.content;
        const last = msgs[msgs.length - 1];
        if (last && last.role === role && typeof last.content === 'string') {
            last.content += `\n\n${text}`;
        } else {
            msgs.push({ role, content: text });
        }
    }
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    return msgs;
}

/** Attach base64 images to the final user message (vision). images: [{mediaType, data}]. */
function attachImages(msgs, images) {
    if (!images || !images.length) return msgs;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return msgs;
    const blocks = [];
    for (const img of images) {
        if (!img || !img.data) continue;
        blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data },
        });
    }
    if (typeof last.content === 'string') blocks.push({ type: 'text', text: last.content });
    last.content = blocks;
    return msgs;
}

class ClaudeApiProvider extends Provider {
    /** @param {string} apiKey Anthropic API key. @param {object} [opts] {model} */
    constructor(apiKey, opts = {}) {
        super();
        this.apiKey = apiKey || '';
        this.model = opts.model || DEFAULT_MODEL;
    }

    get name() { return 'claude-api'; }
    supportsTools() { return true; }
    supportsVision() { return true; }

    stream(conversation, callbacks, options = {}) {
        const cb = normalizeCallbacks(callbacks);
        if (!this.apiKey) {
            cb.onError(new Error('Anthropic API 키가 설정되지 않았습니다 (settings: anthropicApiKey). API 모드를 쓰려면 키가 필요함'));
            return { abort() {} };
        }

        const client = new Anthropic({ apiKey: this.apiKey });
        const controller = new AbortController();
        let aborted = false;
        let fullText = '';

        const system = buildSystemPrompt(options);
        let messages = toAnthropicMessages(toHistory(conversation));
        messages = attachImages(messages, options.attachedImages);

        if (!messages.length) {
            cb.onError(new Error('대화 내용이 없습니다 (user 메시지 필요)'));
            return { abort() {} };
        }

        (async () => {
            try {
                const stream = client.messages.stream(
                    {
                        model: options.model || this.model,
                        max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
                        system,
                        messages,
                        thinking: { type: 'adaptive' },
                    },
                    { signal: controller.signal }
                );

                stream.on('text', (delta) => {
                    if (aborted) return;
                    fullText += delta;
                    cb.onToken(delta);
                });

                await stream.finalMessage();
                if (!aborted) cb.onComplete(fullText);
            } catch (err) {
                if (aborted) return;
                cb.onError(err instanceof Error ? err : new Error(String(err)));
            }
        })();

        return {
            abort() {
                aborted = true;
                try { controller.abort(); } catch (_) {}
            },
        };
    }
}

module.exports = { ClaudeApiProvider, toAnthropicMessages, buildSystemPrompt };
