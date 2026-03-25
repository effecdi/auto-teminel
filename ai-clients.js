// AI Clients — Claude CLI spawn + Gemini SDK streaming
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { CLAUDE_SYSTEM_PROMPT, GEMINI_SYSTEM_PROMPT, buildProjectAwarePrompt } = require('./ai-personas');

// ===================================================================
//  Claude Client — uses `claude -p --output-format stream-json`
// ===================================================================

function buildClaudePrompt(messages, options) {
    let systemPrompt = CLAUDE_SYSTEM_PROMPT;

    if (options && options.projectContext) {
        systemPrompt = buildProjectAwarePrompt(systemPrompt, options.projectContext);
    }
    if (options && options.systemPromptSuffix) {
        systemPrompt += `\n\n## 현재 모드 지침\n${options.systemPromptSuffix}`;
    }

    const parts = [`[시스템 프롬프트]\n${systemPrompt}\n`];

    const recent = messages.length > 4 ? messages.slice(-4) : messages;
    if (messages.length > 4) {
        parts.push('[... 이전 대화 생략 ...]\n');
    }

    for (const msg of recent) {
        const label =
            msg.role === 'user' ? '[사용자]' :
            msg.role === 'gemini' ? '[Gemini(디자이너)]' :
            '[Claude(개발자)]';
        parts.push(`${label}: ${msg.content}`);
    }

    parts.push('\n위 대화를 바탕으로 Claude(개발자)로서 답변해주세요. 구체적인 코드와 실행 가능한 솔루션을 제시하세요.');
    return parts.join('\n\n');
}

/**
 * Stream Claude response using CLI.
 * Returns an object with { abort() } for cancellation.
 */
function streamClaude(history, callbacks, options) {
    const prompt = buildClaudePrompt(history, options);

    // Build PATH with common binary locations
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    const extraPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.claude', 'local', 'bin'),
        '/usr/bin', '/bin'
    ];
    const pathSet = new Set((cleanEnv.PATH || '').split(':'));
    for (const p of extraPaths) pathSet.add(p);
    cleanEnv.PATH = [...pathSet].join(':');

    const proc = spawn('claude', ['-p', '--output-format', 'stream-json'], {
        env: {
            ...cleanEnv,
            ANTHROPIC_API_KEY: '',
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let fullText = '';
    let errorText = '';
    let buffer = '';
    let aborted = false;

    proc.stdout.on('data', (data) => {
        if (aborted) return;
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const event = JSON.parse(trimmed);

                if (event.type === 'content_block_delta' && event.delta) {
                    const text = event.delta.text;
                    if (text) {
                        fullText += text;
                        callbacks.onToken(text);
                    }
                } else if (event.type === 'result' && event.result) {
                    if (!fullText && typeof event.result === 'string') {
                        fullText = event.result;
                        callbacks.onToken(fullText);
                    }
                } else if (event.type === 'message' && event.message && event.message.content) {
                    if (!fullText) {
                        for (const block of event.message.content) {
                            if (block.type === 'text' && block.text) {
                                fullText += block.text;
                                callbacks.onToken(block.text);
                            }
                        }
                    }
                }
            } catch (_) {
                if (trimmed && !trimmed.startsWith('{')) {
                    fullText += trimmed;
                    callbacks.onToken(trimmed);
                }
            }
        }
    });

    proc.stderr.on('data', (data) => {
        errorText += data.toString();
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('close', (code) => {
        if (aborted) return;

        // Flush remaining buffer
        if (buffer.trim()) {
            try {
                const event = JSON.parse(buffer.trim());
                if (event.type === 'content_block_delta' && event.delta && event.delta.text) {
                    fullText += event.delta.text;
                    callbacks.onToken(event.delta.text);
                }
            } catch (_) {
                if (!buffer.trim().startsWith('{')) {
                    fullText += buffer.trim();
                    callbacks.onToken(buffer.trim());
                }
            }
        }

        if (fullText) {
            callbacks.onComplete(fullText);
        } else {
            callbacks.onError(new Error(errorText || `claude CLI exited with code ${code}`));
        }
    });

    proc.on('error', (err) => {
        if (!aborted) callbacks.onError(err);
    });

    return {
        abort() {
            aborted = true;
            try { proc.kill('SIGTERM'); } catch (_) {}
        }
    };
}

// ===================================================================
//  Gemini Client — uses @google/generative-ai SDK
// ===================================================================

let genAI = null;

function getGeminiClient(apiKey) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (!genAI || genAI._apiKey !== apiKey) {
        genAI = new GoogleGenerativeAI(apiKey);
        genAI._apiKey = apiKey; // track for key changes
    }
    return genAI;
}

function toGeminiHistory(messages) {
    const mapped = [];

    for (const msg of messages) {
        const role = msg.role === 'gemini' ? 'model' : 'user';
        const last = mapped[mapped.length - 1];

        if (last && last.role === role) {
            const prevText = last.parts.map(p => p.text || '').join('');
            const label = msg.role === 'claude' ? '[Claude(개발자)]' : '[사용자]';
            last.parts = [{ text: `${prevText}\n\n${label}: ${msg.content}` }];
        } else {
            const label =
                msg.role === 'user' ? '[사용자]' :
                msg.role === 'claude' ? '[Claude(개발자)]' : '';
            mapped.push({
                role,
                parts: [{ text: label ? `${label}: ${msg.content}` : msg.content }]
            });
        }
    }

    return mapped;
}

/**
 * Stream Gemini response.
 * Returns an object with { abort() } for cancellation.
 */
function streamGemini(apiKey, history, callbacks, options) {
    let aborted = false;
    let abortController = null;

    const run = async () => {
        try {
            const client = getGeminiClient(apiKey);

            let systemPrompt = GEMINI_SYSTEM_PROMPT;
            if (options && options.projectContext) {
                systemPrompt = buildProjectAwarePrompt(systemPrompt, options.projectContext);
            }
            if (options && options.systemPromptSuffix) {
                systemPrompt += `\n\n## 현재 모드 지침\n${options.systemPromptSuffix}`;
            }

            const model = client.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: systemPrompt,
            });

            const recent = history.length > 6 ? history.slice(-6) : history;
            const geminiHistory = toGeminiHistory(recent);

            const lastMsg = geminiHistory.pop();
            if (!lastMsg || lastMsg.role !== 'user') {
                throw new Error('Last message must be user role for Gemini');
            }

            const chat = model.startChat({ history: geminiHistory });
            const result = await chat.sendMessageStream(lastMsg.parts);

            let fullText = '';
            for await (const chunk of result.stream) {
                if (aborted) break;
                const text = chunk.text();
                if (text) {
                    fullText += text;
                    callbacks.onToken(text);
                }
            }

            if (!aborted) {
                callbacks.onComplete(fullText);
            }
        } catch (err) {
            if (!aborted) {
                callbacks.onError(err instanceof Error ? err : new Error(String(err)));
            }
        }
    };

    run();

    return {
        abort() {
            aborted = true;
        }
    };
}

module.exports = {
    streamClaude,
    streamGemini
};
