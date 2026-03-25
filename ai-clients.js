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
            msg.role === 'gemini' ? '[Gemini(시니어 디자이너)]' :
            '[Claude(시니어 풀스텍 개발자)]';
        parts.push(`${label}: ${msg.content}`);
    }

    parts.push('\n위 대화를 바탕으로 Claude(시니어 풀스텍 개발자)로서 답변해주세요. 구체적인 코드와 실행 가능한 솔루션을 제시하세요.');
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

    // Set cwd to project path so Claude CLI has actual file access
    const cwd = (options && options.projectPath) || process.cwd();

    const args = ['-p', '--output-format', 'stream-json', '--verbose',
        '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(find:*)',
    ];

    const proc = spawn('claude', args, {
        cwd,
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

    // Inactivity timeout: if no data for 120s, kill the process
    const INACTIVITY_TIMEOUT = 120000;
    let inactivityTimer = setTimeout(() => {
        if (!aborted) {
            aborted = true;
            try { proc.kill('SIGTERM'); } catch (_) {}
            callbacks.onError(new Error('Claude 응답 타임아웃 (120초 동안 응답 없음)'));
        }
    }, INACTIVITY_TIMEOUT);

    const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
            if (!aborted) {
                aborted = true;
                try { proc.kill('SIGTERM'); } catch (_) {}
                if (fullText) {
                    callbacks.onComplete(fullText);
                } else {
                    callbacks.onError(new Error('Claude 응답 타임아웃 (120초 동안 응답 없음)'));
                }
            }
        }, INACTIVITY_TIMEOUT);
    };

    proc.stdout.on('data', (data) => {
        if (aborted) return;
        resetInactivityTimer();
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
        resetInactivityTimer();
        errorText += data.toString();
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('close', (code) => {
        clearTimeout(inactivityTimer);
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
        clearTimeout(inactivityTimer);
        if (!aborted) callbacks.onError(err);
    });

    return {
        abort() {
            clearTimeout(inactivityTimer);
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
            // Same role consecutive — merge into one
            const prevText = last.parts.map(p => p.text || '').join('');
            const label = msg.role === 'claude' ? '[Claude(시니어 풀스텍 개발자)]' : '[사용자]';
            last.parts = [{ text: `${prevText}\n\n${label}: ${msg.content}` }];
        } else {
            const label =
                msg.role === 'user' ? '[사용자]' :
                msg.role === 'claude' ? '[Claude(시니어 풀스텍 개발자)]' : '';
            mapped.push({
                role,
                parts: [{ text: label ? `${label}: ${msg.content}` : msg.content }]
            });
        }
    }

    // Gemini requires: starts with 'user', alternating user/model
    // Drop leading 'model' messages
    while (mapped.length > 0 && mapped[0].role !== 'user') {
        mapped.shift();
    }

    // Ensure strict alternation — merge consecutive same-role entries
    const fixed = [];
    for (const entry of mapped) {
        const prev = fixed[fixed.length - 1];
        if (prev && prev.role === entry.role) {
            const prevText = prev.parts.map(p => p.text || '').join('');
            const curText = entry.parts.map(p => p.text || '').join('');
            prev.parts = [{ text: `${prevText}\n\n${curText}` }];
        } else {
            fixed.push({ role: entry.role, parts: [...entry.parts] });
        }
    }

    return fixed;
}

// ===================================================================
//  Gemini File Tools — function calling for real file access
// ===================================================================

const GEMINI_FILE_TOOLS = [{
    functionDeclarations: [
        {
            name: 'readFile',
            description: 'Read a file from the project. Returns file content as text.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'File path relative to project root (e.g. "src/App.tsx", "package.json")' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'writeFile',
            description: 'Write/overwrite a file in the project. Creates parent directories if needed.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'File path relative to project root' },
                    content: { type: 'string', description: 'Full file content to write' }
                },
                required: ['filePath', 'content']
            }
        },
        {
            name: 'listFiles',
            description: 'List files and directories in a project directory.',
            parameters: {
                type: 'object',
                properties: {
                    dirPath: { type: 'string', description: 'Directory path relative to project root. Use "." for project root.' }
                },
                required: ['dirPath']
            }
        },
    ]
}];

const GEMINI_LIST_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'coverage']);

function executeGeminiTool(name, args, projectPath) {
    const fs = require('fs');
    const safePath = (rel) => {
        const resolved = path.resolve(projectPath, rel);
        // Prevent path traversal outside project
        if (!resolved.startsWith(path.resolve(projectPath))) {
            return null;
        }
        return resolved;
    };

    try {
        if (name === 'readFile') {
            const fullPath = safePath(args.filePath);
            if (!fullPath) return { error: 'Path traversal not allowed' };
            if (!fs.existsSync(fullPath)) return { error: `File not found: ${args.filePath}` };
            const stat = fs.statSync(fullPath);
            if (stat.size > 100 * 1024) return { error: `File too large: ${(stat.size / 1024).toFixed(0)}KB (max 100KB)` };
            return { content: fs.readFileSync(fullPath, 'utf-8') };
        }

        if (name === 'writeFile') {
            const fullPath = safePath(args.filePath);
            if (!fullPath) return { error: 'Path traversal not allowed' };
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, args.content, 'utf-8');
            return { success: true, message: `Written: ${args.filePath} (${args.content.length} chars)` };
        }

        if (name === 'listFiles') {
            const fullPath = safePath(args.dirPath);
            if (!fullPath) return { error: 'Path traversal not allowed' };
            if (!fs.existsSync(fullPath)) return { error: `Directory not found: ${args.dirPath}` };
            const entries = fs.readdirSync(fullPath, { withFileTypes: true });
            const items = entries
                .filter(e => !GEMINI_LIST_SKIP.has(e.name) && !e.name.startsWith('.'))
                .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
                .slice(0, 100);
            return { files: items.join('\n') };
        }

        return { error: `Unknown tool: ${name}` };
    } catch (err) {
        return { error: err.message };
    }
}

/**
 * Stream Gemini response with file tool support.
 * Returns an object with { abort() } for cancellation.
 */
function streamGemini(apiKey, history, callbacks, options) {
    let aborted = false;

    // Inactivity timeout for Gemini streaming
    const INACTIVITY_TIMEOUT = 90000; // 90 seconds
    let inactivityTimer = null;

    const clearInactivity = () => { if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; } };
    const resetInactivity = (fullTextRef) => {
        clearInactivity();
        inactivityTimer = setTimeout(() => {
            if (!aborted) {
                aborted = true;
                if (fullTextRef.text) {
                    callbacks.onComplete(fullTextRef.text);
                } else {
                    callbacks.onError(new Error('Gemini 응답 타임아웃 (90초 동안 응답 없음)'));
                }
            }
        }, INACTIVITY_TIMEOUT);
    };

    const run = async () => {
        const fullTextRef = { text: '' };
        try {
            const client = getGeminiClient(apiKey);
            const projectPath = (options && options.projectPath) || null;

            let systemPrompt = GEMINI_SYSTEM_PROMPT;
            if (options && options.projectContext) {
                systemPrompt = buildProjectAwarePrompt(systemPrompt, options.projectContext);
            }
            if (options && options.systemPromptSuffix) {
                systemPrompt += `\n\n## 현재 모드 지침\n${options.systemPromptSuffix}`;
            }

            // Enable file tools only when projectPath is available
            const modelConfig = {
                model: 'gemini-2.5-flash',
                systemInstruction: systemPrompt,
            };
            if (projectPath) {
                modelConfig.tools = GEMINI_FILE_TOOLS;
                systemPrompt += `\n\n## 파일 접근\n프로젝트 경로: ${projectPath}\nreadFile, writeFile, listFiles 도구를 사용해서 프로젝트 파일을 직접 읽고 수정할 수 있습니다. 필요하면 적극적으로 사용하세요.`;
                modelConfig.systemInstruction = systemPrompt;
            }

            const model = client.getGenerativeModel(modelConfig);

            const recent = history.length > 6 ? history.slice(-6) : history;
            const geminiHistory = toGeminiHistory(recent);

            const lastMsg = geminiHistory.pop();
            if (!lastMsg || lastMsg.role !== 'user') {
                throw new Error('Last message must be user role for Gemini');
            }

            const chat = model.startChat({ history: geminiHistory });

            let currentParts = lastMsg.parts;

            // Start inactivity timer
            resetInactivity(fullTextRef);

            // Loop to handle function calls
            const MAX_TOOL_ROUNDS = 10;
            for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) {
                if (aborted) break;

                const result = await chat.sendMessageStream(currentParts);
                resetInactivity(fullTextRef);

                let functionCalls = [];
                for await (const chunk of result.stream) {
                    if (aborted) break;
                    resetInactivity(fullTextRef);
                    // Check for function calls
                    const candidates = chunk.candidates || [];
                    for (const candidate of candidates) {
                        const parts = (candidate.content && candidate.content.parts) || [];
                        for (const part of parts) {
                            if (part.functionCall) {
                                functionCalls.push(part.functionCall);
                            }
                        }
                    }
                    // Stream text
                    try {
                        const text = chunk.text();
                        if (text) {
                            fullTextRef.text += text;
                            callbacks.onToken(text);
                        }
                    } catch (_) {}
                }

                // If no function calls or no projectPath, we're done
                if (functionCalls.length === 0 || !projectPath) break;

                // Execute function calls and send results back
                const functionResponses = [];
                for (const fc of functionCalls) {
                    const toolResult = executeGeminiTool(fc.name, fc.args, projectPath);
                    // Notify UI about tool usage
                    const action = fc.name === 'writeFile' ? `✏️ ${fc.args.filePath}` :
                                   fc.name === 'readFile' ? `📖 ${fc.args.filePath}` :
                                   `📂 ${fc.args.dirPath}`;
                    callbacks.onToken(`\n\`[Tool: ${action}]\`\n`);
                    fullTextRef.text += `\n[Tool: ${action}]\n`;

                    functionResponses.push({
                        functionResponse: {
                            name: fc.name,
                            response: toolResult,
                        }
                    });
                }

                // Send tool results back to Gemini for next round
                currentParts = functionResponses;
            }

            clearInactivity();
            if (!aborted) {
                callbacks.onComplete(fullTextRef.text);
            }
        } catch (err) {
            clearInactivity();
            if (!aborted) {
                callbacks.onError(err instanceof Error ? err : new Error(String(err)));
            }
        }
    };

    run();

    return {
        abort() {
            clearInactivity();
            aborted = true;
        }
    };
}

module.exports = {
    streamClaude,
    streamGemini
};
