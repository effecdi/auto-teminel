// agent/tools/builtin/fs-tools.js
// Stage 3 — built-in filesystem tools for the agent loop.
// All paths are confined to ctx.projectPath (no traversal outside).

const fs = require('fs');
const path = require('path');

const LIST_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'coverage']);

function safePath(projectPath, rel) {
    if (!projectPath) throw new Error('projectPath 미설정 — 파일 도구를 쓸 수 없음');
    const base = path.resolve(projectPath);
    const resolved = path.resolve(base, rel || '.');
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new Error(`경로가 프로젝트 밖을 가리킴: ${rel}`);
    }
    return resolved;
}

const readFile = {
    name: 'read_file',
    description: 'Read a text file from the project. Returns its content.',
    inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to project root' } },
        required: ['path'],
    },
    requiresApproval: false,
    handler: (input, ctx) => {
        const full = safePath(ctx.projectPath, input.path);
        if (!fs.existsSync(full)) throw new Error(`파일 없음: ${input.path}`);
        const stat = fs.statSync(full);
        if (stat.size > 200 * 1024) throw new Error(`파일 너무 큼: ${(stat.size / 1024).toFixed(0)}KB (최대 200KB)`);
        return { content: fs.readFileSync(full, 'utf-8') };
    },
};

const writeFile = {
    name: 'write_file',
    description: 'Create or overwrite a file in the project. Requires approval.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path relative to project root' },
            content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
    },
    requiresApproval: true,
    handler: (input, ctx) => {
        const full = safePath(ctx.projectPath, input.path);
        const dir = path.dirname(full);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(full, input.content, 'utf-8');
        return { success: true, path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
    },
};

const editFile = {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string. Requires approval. Fails if old_string is not unique.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: 'Exact text to replace (must be unique)' },
            new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
    },
    requiresApproval: true,
    handler: (input, ctx) => {
        const full = safePath(ctx.projectPath, input.path);
        if (!fs.existsSync(full)) throw new Error(`파일 없음: ${input.path}`);
        const orig = fs.readFileSync(full, 'utf-8');
        const idx = orig.indexOf(input.old_string);
        if (idx === -1) throw new Error('old_string을 파일에서 찾을 수 없음');
        if (orig.indexOf(input.old_string, idx + 1) !== -1) throw new Error('old_string이 여러 번 나타남 — 더 구체적으로');
        const updated = orig.slice(0, idx) + input.new_string + orig.slice(idx + input.old_string.length);
        fs.writeFileSync(full, updated, 'utf-8');
        return { success: true, path: input.path };
    },
};

const listFiles = {
    name: 'list_files',
    description: 'List files and directories in a project directory (skips node_modules, .git, etc.).',
    inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to project root. Use "." for root.' } },
        required: ['path'],
    },
    requiresApproval: false,
    handler: (input, ctx) => {
        const full = safePath(ctx.projectPath, input.path);
        if (!fs.existsSync(full)) throw new Error(`디렉터리 없음: ${input.path}`);
        const entries = fs.readdirSync(full, { withFileTypes: true });
        const items = entries
            .filter(e => !LIST_SKIP.has(e.name))
            .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
            .slice(0, 200);
        return { entries: items };
    },
};

module.exports = { fsTools: [readFile, writeFile, editFile, listFiles], safePath };
