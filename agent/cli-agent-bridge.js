// agent/cli-agent-bridge.js
// Stage 3 — free default path (claudeMode='cli').
//
// Runs the Claude Code CLI's OWN agent loop with the FULL conversation and
// --output-format stream-json, then parses the event feed to surface text +
// tool_use + tool_result as structured steps to the UI. We do NOT reimplement
// the loop (the CLI owns it) — we make its actions auditable in the new panel.
//
// Note: in -p mode the CLI runs its allowed tools autonomously (its own
// permission model), so there is no per-tool approval round-trip here; the
// approval broker is used by the API-path orchestrator instead.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { CLAUDE_SYSTEM_PROMPT, buildProjectAwarePrompt } = require('../ai-personas');
const { toHistory } = require('./providers/provider-interface');

const INACTIVITY_TIMEOUT = 180000; // 3 min

function buildFullPrompt(conversation, options = {}) {
    let systemPrompt = CLAUDE_SYSTEM_PROMPT;
    if (options.projectContext) systemPrompt = buildProjectAwarePrompt(systemPrompt, options.projectContext);
    if (options.systemPromptSuffix) systemPrompt += `\n\n## 현재 모드 지침\n${options.systemPromptSuffix}`;

    const parts = [`[시스템 프롬프트]\n${systemPrompt}\n`];
    for (const msg of toHistory(conversation)) { // FULL context, no truncation
        const label = msg.role === 'user' ? '[사용자]' : msg.role === 'gemini' ? '[Gemini]' : '[Claude]';
        parts.push(`${label}: ${msg.content}`);
    }
    parts.push('\n위 대화를 바탕으로 Claude로서 답변하고 필요한 작업을 수행하세요.');
    return parts.join('\n\n');
}

function buildEnvAndPath() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    env.ANTHROPIC_API_KEY = ''; // CLI uses the subscription, not an API key
    const extra = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.claude', 'local', 'bin'), '/usr/bin', '/bin'];
    const set = new Set((env.PATH || '').split(':'));
    for (const p of extra) set.add(p);
    env.PATH = [...set].join(':');
    // Force UTF-8 locale (GUI apps inherit no LANG → Mac Roman mojibake on multibyte).
    const utf8 = /UTF-?8$/i.test(env.LANG || '') ? env.LANG : 'en_US.UTF-8';
    env.LANG = utf8; env.LC_ALL = utf8; env.LC_CTYPE = utf8;
    return env;
}

/**
 * Run the CLI agent, streaming structured steps via `emit`.
 * @param {object} task {conversation, projectPath, projectContext, systemPromptSuffix, signal}
 * @param {(event:string, payload:object)=>void} emit  scoped emitter (runId bound)
 */
function runCliAgent(task, emit) {
    const { conversation, projectPath, projectContext, systemPromptSuffix, signal, mcpConfigFile, mcpServerNames } = task;
    const prompt = buildFullPrompt(conversation, { projectContext, systemPromptSuffix });
    const cwd = projectPath || process.cwd();

    const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write',
        'Bash(npm:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(find:*)',
        'Bash(git:*)', 'Bash(mkdir:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(npx:*)',
    ];
    // Stage 4: allow tools from each enabled MCP server (mcp__<server>).
    for (const n of (mcpServerNames || [])) allowed.push(`mcp__${n}`);

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', ...allowed];
    if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);

    emit('status', { phase: 'started', backend: 'cli' });

    const proc = spawn('claude', args, { cwd, env: buildEnvAndPath(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let fullText = '';
    let stderr = '';
    let done = false;

    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill('SIGTERM'); } catch (_) {} fn(); };
    let timer = setTimeout(() => finish(() => emit('error', { message: 'CLI 응답 타임아웃(180초)' })), INACTIVITY_TIMEOUT);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => finish(() => emit('error', { message: 'CLI 응답 타임아웃(180초)' })), INACTIVITY_TIMEOUT); };

    if (signal) {
        if (signal.aborted) return finish(() => emit('status', { phase: 'aborted' }));
        signal.addEventListener('abort', () => finish(() => emit('status', { phase: 'aborted' })), { once: true });
    }

    const handleEvent = (event) => {
        if (event.type === 'content_block_delta' && event.delta && event.delta.text) {
            fullText += event.delta.text; emit('token', { text: event.delta.text });
        } else if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
                if (block.type === 'text' && block.text && !fullText.includes(block.text)) {
                    fullText += block.text; emit('token', { text: block.text });
                } else if (block.type === 'tool_use') {
                    emit('toolUse', { id: block.id, name: block.name, input: block.input });
                }
            }
        } else if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
                if (block.type === 'tool_result') {
                    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                    emit('toolResult', { id: block.tool_use_id, ok: !block.is_error, result: (content || '').slice(0, 20000) });
                }
            }
        }
    };

    proc.stdout.on('data', (data) => {
        bump();
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try { handleEvent(JSON.parse(t)); } catch (_) { /* non-JSON line */ }
        }
    });
    proc.stderr.on('data', (d) => { bump(); stderr += d.toString(); });
    proc.on('error', (err) => finish(() => emit('error', { message: err.message })));
    proc.on('close', (code) => finish(() => {
        if (code === 0 || fullText) emit('done', { stopReason: 'end_turn' });
        else emit('error', { message: stderr.slice(0, 500) || `claude CLI exited ${code}` });
    }));

    proc.stdin.write(prompt);
    proc.stdin.end();

    return { abort() { finish(() => emit('status', { phase: 'aborted' })); } };
}

module.exports = { runCliAgent, buildFullPrompt };
