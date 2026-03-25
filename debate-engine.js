// Debate Engine — Round management, modes, history orchestrator
const { streamClaude, streamGemini } = require('./ai-clients');
const crypto = require('crypto');

// ===================================================================
//  Modes
// ===================================================================

const MODES = {
    debate: {
        name: 'Debate (토론)',
        description: 'Claude가 프로젝트 분석 → 두 AI가 토론합니다.',
        geminiSuffix: 'Claude가 분석한 프로젝트 코드가 위에 있습니다. 이를 기반으로 대안을 구체적인 코드로 제시하세요. 추상적 토론 금지.',
        claudeSuffix: '상대방의 의견과 다르다면 대안을 구체적인 코드로 제시하세요. 추상적 토론 금지.',
    },
    collab: {
        name: 'Collab (협업)',
        description: 'Claude가 프로젝트 분석 → Gemini가 디자인 → Claude가 구현',
        geminiSuffix: 'Claude가 분석한 프로젝트의 실제 코드가 위에 있습니다. 이 코드를 기반으로 디자인/CSS/UI를 수정하세요. 파일 경로와 전체 코드 블록을 포함하세요.',
        claudeSuffix: 'Gemini(디자이너)가 제안한 디자인을 프로젝트에 실제로 적용하세요. 파일 경로와 전체 코드를 제공하세요.',
    },
    review: {
        name: 'Review (리뷰)',
        description: 'Claude가 프로젝트 분석 → Gemini가 리뷰합니다.',
        geminiSuffix: 'Claude가 분석한 프로젝트 코드가 위에 있습니다. 이를 기반으로 문제점과 수정 코드를 제시하세요. 파일 경로와 전체 코드 블록을 포함하세요.',
        claudeSuffix: '상대방의 리뷰를 반영하여 수정된 코드를 직접 제공하세요.',
    },
    pipeline: {
        name: 'Pipeline (파이프라인)',
        description: 'Gemini가 기획/디자인 → Claude가 터미널에서 실행',
        geminiSuffix: '기획/설계에 집중하세요. 구체적인 구현 계획, UI 명세, 파일 구조, 컴포넌트별 상세 명세, CSS/디자인 토큰, 구현 순서를 제시하세요. Claude가 이 설계를 바탕으로 직접 코드를 작성합니다.',
        claudeSuffix: '',
    },
};

const SOLO_SUFFIX = '당신은 단독으로 응답합니다. 디자인과 개발 모든 측면을 종합적으로 다뤄주세요.';

// ===================================================================
//  Conversation History
// ===================================================================

class ConversationHistory {
    constructor() { this.messages = []; }
    add(role, content) { this.messages.push({ role, content }); }
    getAll() { return [...this.messages]; }
    clear() { this.messages = []; }
    get length() { return this.messages.length; }
}

// ===================================================================
//  DebateEngine
// ===================================================================

class DebateEngine {
    constructor() {
        this.history = new ConversationHistory();
        this.running = false;
        this.task = '';
        this.mode = 'collab';    // debate | collab | review
        this.aiMode = 'dual';    // dual | claude-solo | gemini-solo
        this.sessionId = '';
        this.round = 0;
        this.maxRounds = 2;
        this.geminiApiKey = '';
        this.projectContext = null;
        this.projectPath = null;
        this._activeHandles = [];  // for abort
    }

    get isRunning() { return this.running; }

    getHistory() { return this.history.getAll(); }
    getTask() { return this.task; }

    getState() {
        return {
            running: this.running,
            task: this.task,
            mode: this.mode,
            aiMode: this.aiMode,
            round: this.round,
            maxRounds: this.maxRounds,
            sessionId: this.sessionId,
            historyLength: this.history.length,
        };
    }

    stop() {
        this.running = false;
        for (const handle of this._activeHandles) {
            try { handle.abort(); } catch (_) {}
        }
        this._activeHandles = [];
    }

    /**
     * Start a new conversation.
     */
    async start(task, callbacks, opts) {
        if (this.running) return;

        this.task = task;
        this.mode = (opts && opts.mode) || 'collab';
        this.aiMode = (opts && opts.aiMode) || 'dual';
        this.maxRounds = (opts && opts.maxRounds) || 1;
        this.geminiApiKey = (opts && opts.geminiApiKey) || '';
        this.projectContext = (opts && opts.projectContext) || null;
        this.projectPath = (opts && opts.projectPath) || null;
        this.sessionId = crypto.randomUUID();
        this.history.clear();
        this.history.add('user', task);

        if (this.aiMode === 'pipeline') {
            await this._runPipeline(callbacks);
        } else {
            await this._runRounds(callbacks);
        }
    }

    /**
     * Continue conversation with a new user message.
     */
    async continue(userMessage, callbacks, opts) {
        // Force reset running state if stuck from previous round
        if (this.running) {
            this.running = false;
            this._activeHandles = [];
        }
        // Refresh project context if provided
        if (opts && opts.projectContext) {
            this.projectContext = opts.projectContext;
        }
        if (opts && opts.projectPath) {
            this.projectPath = opts.projectPath;
        }
        if (opts && opts.mode) {
            this.mode = opts.mode;
        }
        if (opts && opts.aiMode) {
            this.aiMode = opts.aiMode;
        }
        this.history.add('user', userMessage);
        await this._runRounds(callbacks);
    }

    /**
     * Pipeline mode: Gemini designs → onPipelineReady callback triggers Claude execution via TaskQueue.
     */
    async _runPipeline(callbacks) {
        this.running = true;
        this.round = 1;

        const modeConfig = MODES.pipeline;
        const projectContext = this.projectContext;

        if (!this.geminiApiKey) {
            callbacks.onError(new Error('Gemini API Key가 설정되지 않았습니다. Settings에서 설정해주세요.'), 'gemini');
            this.running = false;
            callbacks.onDebateComplete();
            return;
        }

        callbacks.onRoundStart(1, 1);
        callbacks.onStatusChange(`💭 Gemini 기획/설계 중... | Pipeline Mode`);

        // Step 1: Gemini designs
        await new Promise((resolve) => {
            const handle = streamGemini(
                this.geminiApiKey,
                this.history.getAll(),
                {
                    onToken: (token) => callbacks.onGeminiToken(token),
                    onComplete: (text) => {
                        this.history.add('gemini', text);
                        callbacks.onGeminiComplete(text);

                        // Step 2: Signal pipeline ready with the design output
                        if (callbacks.onPipelineReady) {
                            callbacks.onPipelineReady(text);
                        }
                        resolve();
                    },
                    onError: (err) => {
                        this.history.add('gemini', '[응답 실패]');
                        callbacks.onError(err, 'gemini');
                        resolve();
                    },
                },
                { systemPromptSuffix: modeConfig.geminiSuffix, projectContext, projectPath: this.projectPath }
            );
            this._activeHandles.push(handle);
        });

        this.running = false;
        this._activeHandles = [];
        callbacks.onDebateComplete();
    }

    /** Run a single Claude turn. */
    async _runClaude(callbacks, opts) {
        return new Promise((resolve) => {
            const handle = streamClaude(
                this.history.getAll(),
                {
                    onToken: (token) => callbacks.onClaudeToken(token),
                    onComplete: (text) => {
                        this.history.add('claude', text);
                        callbacks.onClaudeComplete(text);
                        resolve();
                    },
                    onError: (err) => {
                        this.history.add('claude', '[응답 실패]');
                        callbacks.onError(err, 'claude');
                        resolve();
                    },
                },
                { systemPromptSuffix: opts.suffix, projectContext: opts.projectContext, projectPath: opts.projectPath }
            );
            this._activeHandles.push(handle);
        });
    }

    /** Run a single Gemini turn. */
    async _runGemini(callbacks, opts) {
        return new Promise((resolve) => {
            const handle = streamGemini(
                this.geminiApiKey,
                this.history.getAll(),
                {
                    onToken: (token) => callbacks.onGeminiToken(token),
                    onComplete: (text) => {
                        this.history.add('gemini', text);
                        callbacks.onGeminiComplete(text);
                        resolve();
                    },
                    onError: (err) => {
                        this.history.add('gemini', '[응답 실패]');
                        callbacks.onError(err, 'gemini');
                        resolve();
                    },
                },
                { systemPromptSuffix: opts.suffix, projectContext: opts.projectContext, projectPath: opts.projectPath }
            );
            this._activeHandles.push(handle);
        });
    }

    /**
     * Core round execution loop.
     * claudeFirst mode: Claude → Gemini → Claude (Claude reads files first, Gemini designs, Claude implements)
     * default mode: Gemini → Claude
     */
    async _runRounds(callbacks) {
        this.running = true;
        this.round = 0;

        const isSolo = this.aiMode !== 'dual';
        const maxRounds = isSolo ? 1 : this.maxRounds;
        const modeConfig = MODES[this.mode] || MODES.collab;
        const projectContext = this.projectContext;
        const skipGemini = this.aiMode === 'claude-solo';
        const skipClaude = this.aiMode === 'gemini-solo';
        const isDual = !skipGemini && !skipClaude && !isSolo;

        for (let round = 1; round <= maxRounds; round++) {
            if (!this.running) break;

            this.round = round;
            callbacks.onRoundStart(round, maxRounds);

            if (isDual) {
                // === Dual 모드: Claude분석 → Gemini응답 → Claude구현 ===

                // Step 1: Claude — 프로젝트 파일 읽고 분석
                callbacks.onStatusChange(`💭 대화중이에요... | Claude 프로젝트 분석중 | Round ${round}/${maxRounds}`);
                await this._runClaude(callbacks, {
                    suffix: '프로젝트의 관련 파일을 직접 읽고 현재 코드 구조를 분석하세요. 분석 결과를 상세하게 공유하세요. Gemini(디자이너)가 이 분석을 보고 응답합니다.',
                    projectContext, projectPath: this.projectPath,
                });
                if (!this.running) break;

                // Step 2: Gemini — Claude의 분석을 보고 응답
                if (!this.geminiApiKey) {
                    callbacks.onError(new Error('Gemini API Key가 설정되지 않았습니다.'), 'gemini');
                    break;
                }
                callbacks.onStatusChange(`💭 대화중이에요... | Gemini 응답중 | Round ${round}/${maxRounds}`);
                await this._runGemini(callbacks, {
                    suffix: modeConfig.geminiSuffix,
                    projectContext, projectPath: this.projectPath,
                });
                if (!this.running) break;

                // Step 3: Claude — Gemini 결과를 받아 구현
                callbacks.onStatusChange(`💭 대화중이에요... | Claude 구현중 | Round ${round}/${maxRounds}`);
                await this._runClaude(callbacks, {
                    suffix: modeConfig.claudeSuffix,
                    projectContext, projectPath: this.projectPath,
                });
                if (!this.running) break;

            } else {
                // === Solo 모드 ===

                if (!skipGemini) {
                    if (!this.geminiApiKey) {
                        callbacks.onError(new Error('Gemini API Key가 설정되지 않았습니다.'), 'gemini');
                        break;
                    }
                    callbacks.onStatusChange(`💭 대화중이에요... | Gemini 응답중 | Round ${round}/${maxRounds}`);
                    await this._runGemini(callbacks, {
                        suffix: SOLO_SUFFIX,
                        projectContext, projectPath: this.projectPath,
                    });
                    if (!this.running) break;
                }

                if (!skipClaude) {
                    callbacks.onStatusChange(`💭 대화중이에요... | Claude 응답중 | Round ${round}/${maxRounds}`);
                    await this._runClaude(callbacks, {
                        suffix: SOLO_SUFFIX,
                        projectContext, projectPath: this.projectPath,
                    });
                    if (!this.running) break;
                }
            }
        }

        this.running = false;
        this._activeHandles = [];
        callbacks.onDebateComplete();
    }
}

module.exports = {
    DebateEngine,
    MODES,
    SOLO_SUFFIX
};
