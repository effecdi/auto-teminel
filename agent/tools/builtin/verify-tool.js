// agent/tools/builtin/verify-tool.js
// Stage 3 — built-in verification tool. Runs `node --check` on JS files to
// confirm syntax is valid after edits. This mirrors the project's own
// pre-release checklist (safe: no arbitrary execution), so it needs no approval.

const { execFile } = require('child_process');
const { safePath } = require('./fs-tools');

function nodeCheck(fullPath) {
    return new Promise((resolve) => {
        execFile(process.execPath, ['--check', fullPath], { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, error: (stderr || err.message || '').trim().slice(0, 2000) });
            else resolve({ ok: true });
        });
    });
}

const verifyTool = {
    name: 'verify_syntax',
    description: 'Run `node --check` on one or more JS files to confirm they parse without syntax errors. Use after editing .js files.',
    inputSchema: {
        type: 'object',
        properties: {
            paths: { type: 'array', items: { type: 'string' }, description: 'JS file paths relative to project root' },
        },
        required: ['paths'],
    },
    requiresApproval: false,
    handler: async (input, ctx) => {
        const paths = Array.isArray(input.paths) ? input.paths : [input.paths];
        const results = [];
        for (const p of paths) {
            let full;
            try { full = safePath(ctx.projectPath, p); } catch (e) { results.push({ path: p, ok: false, error: e.message }); continue; }
            const r = await nodeCheck(full);
            results.push({ path: p, ok: r.ok, error: r.error });
        }
        const allOk = results.every(r => r.ok);
        return { allOk, results };
    },
};

module.exports = { verifyTool };
