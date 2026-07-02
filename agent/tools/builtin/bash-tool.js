// agent/tools/builtin/bash-tool.js
// Stage 3 — built-in bash tool for the agent loop. Runs in ctx.projectPath.
// Requires approval (arbitrary command execution). Honors ctx.signal for abort.

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT = 120000; // 2 min
const MAX_OUTPUT = 100 * 1024;  // 100KB cap on captured output

const bashTool = {
    name: 'run_bash',
    description: 'Run a shell command in the project directory. Requires approval. Returns stdout, stderr, and exit code.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to run' },
            timeout_ms: { type: 'number', description: 'Optional timeout in ms (default 120000)' },
        },
        required: ['command'],
    },
    requiresApproval: true,
    handler: (input, ctx) => {
        return new Promise((resolve) => {
            const cwd = ctx.projectPath || process.cwd();
            const timeout = Math.min(Math.max(input.timeout_ms || DEFAULT_TIMEOUT, 1000), 600000);
            let stdout = '';
            let stderr = '';
            let settled = false;

            const proc = spawn('bash', ['-lc', input.command], { cwd });

            const finish = (payload) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { proc.kill('SIGTERM'); } catch (_) {}
                resolve(payload);
            };

            const timer = setTimeout(() => {
                finish({ timedOut: true, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), exitCode: null });
            }, timeout);

            const onAbort = () => finish({ aborted: true, stdout: stdout.slice(0, MAX_OUTPUT), stderr, exitCode: null });
            if (ctx.signal) {
                if (ctx.signal.aborted) return onAbort();
                ctx.signal.addEventListener('abort', onAbort, { once: true });
            }

            proc.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
            proc.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
            proc.on('error', (err) => finish({ error: err.message, stdout, stderr, exitCode: null }));
            proc.on('close', (code) => finish({ stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), exitCode: code }));
        });
    },
};

module.exports = { bashTool };
