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
        description: 'Claude가 프로젝트 분석 → Gemini가 디자인 스펙 → Claude가 구현',
        geminiSuffix: `당신은 시니어 UI/UX 디자이너입니다. Claude가 분석한 프로젝트 구조와 현재 코드가 위에 있습니다.
당신의 역할은 코드를 작성하는 것이 아니라 완전한 디자인 스펙을 정의하는 것입니다.
아래 항목을 빠짐없이 명세하세요:

## 레이아웃 & 구조
- 전체 레이아웃 구조, 그리드 시스템, 반응형 브레이크포인트

## 컬러 시스템
- Primary / Secondary / Accent / Background / Surface / Border / Text 컬러값 (hex/rgba)
- 다크/라이트 토큰 전부

## 타이포그래피
- 폰트 패밀리, 각 텍스트 레벨별 size/weight/line-height/letter-spacing

## 간격 & 크기
- spacing 토큰 (4px 기반 등), padding/margin 기준, border-radius 값

## 컴포넌트 스펙
- Button (primary/secondary/ghost/danger): 모든 상태(default/hover/active/disabled/focus)
- Input / Textarea / Select / Checkbox / Radio / Toggle: 모든 상태
- Form 레이아웃, label 위치, error/success 상태, placeholder 스타일
- Card, Modal, Dropdown, Tooltip, Badge, Tag, Tab, Sidebar, Navbar

## 인터랙션 & 애니메이션
- transition duration/easing, hover 효과, focus ring, skeleton loading, 애니메이션 스펙

## 아이콘 & 이미지
- 아이콘 크기/스타일 기준, 이미지 비율/처리 방식

코드를 쓰지 마세요. 모든 값을 구체적인 수치와 hex 코드로 명세하세요. Claude가 이 스펙을 그대로 코드로 구현합니다.`,
        claudeSuffix: `Gemini(시니어 디자이너)가 위에서 완전한 디자인 스펙을 정의했습니다.
당신의 역할: 이 스펙을 프로젝트 소스코드에 100% 그대로 구현하세요.
- 스펙의 모든 값(컬러, 폰트, 간격, 컴포넌트 스타일)을 빠짐없이 적용
- 수정할 파일 경로와 전체 코드를 제공
- 임의로 디자인 결정 변경 금지 — Gemini 스펙이 최우선`,
    },
    review: {
        name: 'Review (리뷰)',
        description: 'Claude가 프로젝트 분석 → Gemini가 리뷰합니다.',
        geminiSuffix: 'Claude가 분석한 프로젝트 코드가 위에 있습니다. 이를 기반으로 문제점과 수정 코드를 제시하세요. 파일 경로와 전체 코드 블록을 포함하세요.',
        claudeSuffix: '상대방의 리뷰를 반영하여 수정된 코드를 직접 제공하세요.',
    },
    pipeline: {
        name: 'Pipeline (파이프라인)',
        description: 'Gemini가 디자인 스펙 정의 → Claude가 터미널에서 직접 구현',
        geminiSuffix: `당신은 시니어 UI/UX 디자이너입니다. 프로젝트의 현재 구조와 코드가 컨텍스트로 제공됩니다.
당신의 역할은 코드를 작성하는 것이 아니라 완전한 디자인 스펙을 정의하는 것입니다.
아래 항목을 빠짐없이 명세하세요:

## 레이아웃 & 구조
- 전체 레이아웃 구조, 그리드 시스템, 반응형 브레이크포인트

## 컬러 시스템
- Primary / Secondary / Accent / Background / Surface / Border / Text 컬러값 (hex/rgba)
- 다크/라이트 토큰 전부

## 타이포그래피
- 폰트 패밀리, 각 텍스트 레벨별 size/weight/line-height/letter-spacing

## 간격 & 크기
- spacing 토큰 (4px 기반 등), padding/margin 기준, border-radius 값

## 컴포넌트 스펙
- Button (primary/secondary/ghost/danger): 모든 상태(default/hover/active/disabled/focus)
- Input / Textarea / Select / Checkbox / Radio / Toggle: 모든 상태
- Form 레이아웃, label 위치, error/success 상태, placeholder 스타일
- Card, Modal, Dropdown, Tooltip, Badge, Tag, Tab, Sidebar, Navbar

## 인터랙션 & 애니메이션
- transition duration/easing, hover 효과, focus ring, skeleton loading, 애니메이션 스펙

## 아이콘 & 이미지
- 아이콘 크기/스타일 기준, 이미지 비율/처리 방식

코드를 쓰지 마세요. 모든 값을 구체적인 수치와 hex 코드로 명세하세요. Claude가 이 스펙을 터미널에서 직접 파일에 구현합니다.`,
        claudeSuffix: '',
    },
    learn: {
        name: 'Learn (학습)',
        description: 'Gemini가 코드 분석/교육 → Claude가 퀴즈/심화 학습',
        geminiSuffix: `당신은 시니어 코드 교육자(Tutor)입니다. 학생은 HTML/CSS 전문 웹 퍼블리셔이며 풀스택 개발자를 목표로 합니다.
당신의 역할:
1. 프로젝트 코드를 분석하고 **교육적 관점**에서 설명하세요.
2. 사용된 **디자인 패턴**, **아키텍처 패턴**을 식별하고 왜 그 패턴이 사용되었는지 설명하세요.
3. **보안 이슈**가 있으면 OWASP 기준으로 식별하고 안전한 코드와 비교하여 보여주세요.
4. **프레임워크/라이브러리 개념**을 초보자가 이해할 수 있게 설명하세요.
5. 코드를 섹션별로 나눠 분석하세요. 각 섹션마다:
   - 🏷️ **이름**: 이 코드 블록이 하는 일 (한 줄)
   - 📖 **설명**: 어떻게 동작하는지 (초보자 수준)
   - 🎯 **핵심 개념**: 여기서 배울 수 있는 프로그래밍 개념
   - ⚠️ **주의점**: 흔한 실수나 보안 이슈
   - 💡 **개선 제안**: 더 나은 방법이 있다면

마크다운 포맷을 적극 활용하세요. 코드 블록에는 반드시 언어를 명시하세요.
파일을 읽어서 분석하세요. readFile 도구를 활용하세요.`,
        claudeSuffix: `Gemini의 코드 분석 결과가 위에 있습니다. 당신은 퀴즈 마스터이자 심화 학습 가이드입니다.
당신의 역할:
1. Gemini의 분석에서 핵심 개념을 추출하여 **이해도 확인 퀴즈 3-5개**를 출제하세요.
2. 각 퀴즈는 아래 형식을 **정확히** 따르세요:
---QUIZ_START---
Q: [질문 텍스트]
TYPE: multiple_choice
OPTIONS: A) ... | B) ... | C) ... | D) ...
ANSWER: [A/B/C/D 중 하나]
EXPLANATION: [왜 이것이 정답인지 설명]
CONCEPT: [이 퀴즈가 테스트하는 개념 이름]
DIFFICULTY: [beginner/intermediate/advanced]
---QUIZ_END---
3. 퀴즈 후 **심화 학습 가이드**를 제공하세요:
   - 이 코드에서 더 배울 수 있는 주제 3가지
   - 각 주제별 추천 학습 키워드
   - 직접 실습해볼 수 있는 미니 과제 1개`,
    },
};

const SOLO_SUFFIX = '당신은 단독으로 응답합니다. 디자인과 개발 모든 측면을 종합적으로 다뤄주세요.';

const LEARN_SOLO_SUFFIX = `당신은 코드 교육자(Tutor)이자 퀴즈 마스터입니다. 학생은 HTML/CSS 전문 웹 퍼블리셔이며 풀스택 개발자를 목표로 합니다.

역할 1 — 코드 분석 (교육적):
- 코드를 섹션별로 분석: 🏷️이름, 📖설명, 🎯핵심개념, ⚠️주의점, 💡개선제안
- 디자인 패턴, 아키텍처 패턴 식별
- 보안 이슈 OWASP 기준 식별

역할 2 — 퀴즈 (분석 후 반드시 출제):
---QUIZ_START---
Q: [질문]
TYPE: multiple_choice
OPTIONS: A) ... | B) ... | C) ... | D) ...
ANSWER: [정답]
EXPLANATION: [설명]
CONCEPT: [개념명]
DIFFICULTY: [beginner/intermediate/advanced]
---QUIZ_END---

역할 3 — 심화 학습:
- 더 배울 주제 3가지 + 추천 키워드 + 미니 과제 1개`;

// ===================================================================
//  Conversation History
// ===================================================================

class ConversationHistory {
    constructor() {
        this.messages = [];
        this._maxMessages = 10; // 20→10: 토큰 절약 (코드가 포함된 긴 응답이 누적되면 토큰 폭증)
    }
    add(role, content) {
        // 긴 메시지 잘라내기 — 코드가 포함된 AI 응답이 5000자 초과 시 앞뒤만 보존
        const MAX_CONTENT_LEN = 5000;
        let trimmedContent = content;
        if (typeof content === 'string' && content.length > MAX_CONTENT_LEN) {
            const head = content.substring(0, 2000);
            const tail = content.substring(content.length - 2000);
            trimmedContent = `${head}\n\n[... 중간 ${content.length - 4000}자 생략 (토큰 절약) ...]\n\n${tail}`;
            console.log(`[ConversationHistory] Truncated ${role} message: ${content.length} → ${trimmedContent.length} chars`);
        }
        this.messages.push({ role, content: trimmedContent });
        // Trim if over limit: keep first user message + recent messages
        if (this.messages.length > this._maxMessages) {
            const first = this.messages[0]; // original task
            const recent = this.messages.slice(-(this._maxMessages - 1));
            this.messages = [first, ...recent];
            console.log(`[ConversationHistory] Trimmed to ${this.messages.length} messages`);
        }
    }
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
        this.attachedMediaFiles = [];
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

    /** Reset conversation history for a fresh start */
    resetHistory() {
        this.stop();
        this.history = new ConversationHistory();
        this.task = null;
        this.round = 0;
        this.sessionId = null;
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
        this.attachedMediaFiles = (opts && opts.attachedMediaFiles) || [];
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
        // Store media files for this turn (consumed once by first Gemini call)
        this.attachedMediaFiles = (opts && opts.attachedMediaFiles) || [];
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

        try {
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
                    { systemPromptSuffix: modeConfig.geminiSuffix, projectContext, projectPath: this.projectPath, attachedMediaFiles: this.attachedMediaFiles || [] }
                );
                // Consume media after first use
                this.attachedMediaFiles = [];
                this._activeHandles.push(handle);
            });
        } finally {
            this.running = false;
            this._activeHandles = [];
            callbacks.onDebateComplete();
        }
    }

    /** Run a single Claude turn (with 300s timeout protection). */
    async _runClaude(callbacks, opts) {
        const CLAUDE_TIMEOUT = 300000; // 5분 타임아웃
        return new Promise((resolve) => {
            let resolved = false;
            const safeResolve = () => { if (!resolved) { resolved = true; resolve(); } };

            const timer = setTimeout(() => {
                if (!resolved) {
                    this.history.add('claude', '[응답 타임아웃]');
                    callbacks.onError(new Error('Claude 응답 타임아웃 (300초)'), 'claude');
                    if (handle && handle.abort) handle.abort();
                    safeResolve();
                }
            }, CLAUDE_TIMEOUT);

            const handle = streamClaude(
                this.history.getAll(),
                {
                    onToken: (token) => callbacks.onClaudeToken(token),
                    onComplete: (text) => {
                        clearTimeout(timer);
                        this.history.add('claude', text);
                        callbacks.onClaudeComplete(text);
                        safeResolve();
                    },
                    onError: (err) => {
                        clearTimeout(timer);
                        this.history.add('claude', '[응답 실패]');
                        callbacks.onError(err, 'claude');
                        safeResolve();
                    },
                },
                { systemPromptSuffix: opts.suffix, projectContext: opts.projectContext, projectPath: opts.projectPath }
            );
            this._activeHandles.push(handle);
        });
    }

    /** Run a single Gemini turn (with 180s timeout protection). */
    async _runGemini(callbacks, opts) {
        const GEMINI_TIMEOUT = 180000; // 3분 타임아웃
        return new Promise((resolve) => {
            let resolved = false;
            const safeResolve = () => { if (!resolved) { resolved = true; resolve(); } };

            const timer = setTimeout(() => {
                if (!resolved) {
                    this.history.add('gemini', '[응답 타임아웃]');
                    callbacks.onError(new Error('Gemini 응답 타임아웃 (180초)'), 'gemini');
                    // abort the handle
                    if (handle && handle.abort) handle.abort();
                    safeResolve();
                }
            }, GEMINI_TIMEOUT);

            // Consume attached media files (one-shot: cleared after first use)
            const mediaFiles = opts.attachedMediaFiles || [];

            const handle = streamGemini(
                this.geminiApiKey,
                this.history.getAll(),
                {
                    onToken: (token) => callbacks.onGeminiToken(token),
                    onComplete: (text) => {
                        clearTimeout(timer);
                        this.history.add('gemini', text);
                        callbacks.onGeminiComplete(text);
                        safeResolve();
                    },
                    onError: (err) => {
                        clearTimeout(timer);
                        this.history.add('gemini', '[응답 실패]');
                        callbacks.onError(err, 'gemini');
                        safeResolve();
                    },
                },
                { systemPromptSuffix: opts.suffix, projectContext: opts.projectContext, projectPath: opts.projectPath, attachedMediaFiles: mediaFiles }
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

        // Media files are consumed on first Gemini call only
        let pendingMediaFiles = this.attachedMediaFiles || [];
        const consumeMedia = () => {
            const files = pendingMediaFiles;
            pendingMediaFiles = [];
            this.attachedMediaFiles = [];
            return files;
        };

        // When media files are attached, inject visual analysis instructions
        const hasMedia = pendingMediaFiles.length > 0;
        const MEDIA_GEMINI_SUFFIX = hasMedia
            ? '\n\n【첨부된 이미지/스크린샷 분석 필수】첨부된 이미지를 반드시 시각적으로 분석하세요. 현재 디자인의 레이아웃·색상·컴포넌트·문제점을 구체적으로 묘사하고, 개선된 CSS/코드를 파일 경로와 함께 제시하세요.'
            : '';
        const MEDIA_CLAUDE_STEP1_SUFFIX = hasMedia
            ? '사용자가 UI 스크린샷/동영상을 첨부했습니다. Gemini가 이미지를 직접 분석할 예정입니다. 먼저 UI 관련 코드 파일(CSS, HTML, renderer 등)을 읽고 구조를 파악하여 어떤 파일을 수정해야 할지 Gemini에게 알려주세요.'
            : '프로젝트의 관련 파일을 직접 읽고 현재 코드 구조를 분석하세요. 분석 결과를 상세하게 공유하세요. Gemini(디자이너)가 이 분석을 보고 응답합니다.';

        try {
            for (let round = 1; round <= maxRounds; round++) {
                if (!this.running) break;

                this.round = round;
                callbacks.onRoundStart(round, maxRounds);

                if (isDual) {
                    // === Dual 모드: Claude분석 → Gemini응답 → Claude구현 ===

                    // Step 1: Claude — 프로젝트 파일 읽고 분석
                    // Claude는 CLI로 파일을 직접 읽으므로 projectContext 불필요 (토큰 절약)
                    console.log(`[DebateEngine] Step 1/3: Claude 분석 시작 (Round ${round}/${maxRounds})`);
                    callbacks.onStatusChange(`💬 Claude 프로젝트 분석중... | Round ${round}/${maxRounds}`);
                    await this._runClaude(callbacks, {
                        suffix: MEDIA_CLAUDE_STEP1_SUFFIX,
                        projectContext: null, projectPath: this.projectPath,
                    });
                    console.log(`[DebateEngine] Step 1/3: Claude 분석 완료`);
                    if (!this.running) break;

                    // Step 2: Gemini — Claude의 분석을 보고 응답 (Gemini만 projectContext 필요)
                    if (!this.geminiApiKey) {
                        callbacks.onError(new Error('Gemini API Key가 설정되지 않았습니다.'), 'gemini');
                        break;
                    }
                    console.log(`[DebateEngine] Step 2/3: Gemini 응답 시작`);
                    callbacks.onStatusChange(`💬 Gemini 응답중... | Round ${round}/${maxRounds}`);
                    await this._runGemini(callbacks, {
                        suffix: modeConfig.geminiSuffix + MEDIA_GEMINI_SUFFIX,
                        projectContext, projectPath: this.projectPath,
                        attachedMediaFiles: consumeMedia(),
                    });
                    console.log(`[DebateEngine] Step 2/3: Gemini 응답 완료`);
                    if (!this.running) break;

                    // Step 3: Claude — Gemini 결과를 받아 구현
                    // Claude는 파일을 직접 읽으므로 projectContext 불필요 (토큰 절약)
                    console.log(`[DebateEngine] Step 3/3: Claude 구현 시작`);
                    callbacks.onStatusChange(`💬 Claude 구현중... | Round ${round}/${maxRounds}`);
                    await this._runClaude(callbacks, {
                        suffix: modeConfig.claudeSuffix,
                        projectContext: null, projectPath: this.projectPath,
                    });
                    console.log(`[DebateEngine] Step 3/3: Claude 구현 완료`);
                    if (!this.running) break;

                } else if (skipClaude) {
                    // === Gemini Solo 모드 (Claude 북엔드 포함) ===

                    if (!this.geminiApiKey) {
                        callbacks.onError(new Error('Gemini API Key가 설정되지 않았습니다.'), 'gemini');
                        break;
                    }

                    // Step 1: Claude 사전 분석 (Claude는 파일 직접 읽음 → projectContext 불필요)
                    console.log(`[DebateEngine] Gemini-Solo Step 1/3: Claude 사전 분석`);
                    callbacks.onStatusChange(`💬 Claude 프로젝트 분석중... | Gemini Solo`);
                    await this._runClaude(callbacks, {
                        suffix: hasMedia
                            ? '사용자가 UI 스크린샷/동영상을 첨부했습니다. Gemini가 이미지를 직접 분석할 예정입니다. UI 관련 코드 파일들을 읽고 구조를 파악하세요.'
                            : '프로젝트의 관련 파일을 직접 읽고 현재 코드 구조를 분석하세요. 분석 후 Gemini에게 넘깁니다.',
                        projectContext: null, projectPath: this.projectPath,
                    });
                    if (!this.running) break;

                    // Step 2: Gemini 메인 응답
                    console.log(`[DebateEngine] Gemini-Solo Step 2/3: Gemini 메인 응답`);
                    callbacks.onStatusChange(`💬 Gemini 응답중... | Gemini Solo`);
                    await this._runGemini(callbacks, {
                        suffix: (this.mode === 'learn' ? LEARN_SOLO_SUFFIX : SOLO_SUFFIX) + MEDIA_GEMINI_SUFFIX,
                        projectContext, projectPath: this.projectPath,
                        attachedMediaFiles: consumeMedia(),
                    });
                    if (!this.running) break;

                    // Step 3: Claude 최종 정리 (Claude는 파일 직접 읽음 → projectContext 불필요)
                    console.log(`[DebateEngine] Gemini-Solo Step 3/3: Claude 최종 정리`);
                    callbacks.onStatusChange(`💬 Claude 최종 정리중... | Gemini Solo`);
                    await this._runClaude(callbacks, {
                        suffix: 'Gemini 결과를 종합하여 최종 코드를 정리하고 구체적인 실행 가능한 코드를 제시하세요.',
                        projectContext: null, projectPath: this.projectPath,
                    });
                    if (!this.running) break;

                } else {
                    // === Claude Solo 모드 ===

                    callbacks.onStatusChange(`💬 Claude 응답중... | Round ${round}/${maxRounds}`);
                    await this._runClaude(callbacks, {
                        suffix: this.mode === 'learn' ? LEARN_SOLO_SUFFIX : SOLO_SUFFIX,
                        projectContext, projectPath: this.projectPath,
                    });
                    if (!this.running) break;
                }
            }
        } finally {
            this.running = false;
            this._activeHandles = [];
            callbacks.onDebateComplete();
        }
    }
}

module.exports = {
    DebateEngine,
    MODES,
    SOLO_SUFFIX,
    LEARN_SOLO_SUFFIX
};
