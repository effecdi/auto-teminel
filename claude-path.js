// Locate the `claude` CLI binary.
//
// GUI-launched Electron apps (Finder/Dock) get a minimal PATH, and a login
// shell (`-l`) does not source ~/.zshrc / ~/.bashrc where nvm/volta/fnm are
// usually initialised. So a bare `claude` often ends in "command not found".
// Resolve an absolute path once (cached) and expose its directory so it can be
// prepended to PATH (npm-installed claude is `#!/usr/bin/env node`, so node
// from the same dir must be reachable too).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE_NAMES = IS_WIN ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];

let cached; // undefined = not resolved yet, null = not found
let userOverride = ''; // from settings ("Claude CLI Path")

function isExecutable(p) {
    try {
        const st = fs.statSync(p); // follows symlinks → broken links fail here
        if (!st.isFile()) return false;
        if (IS_WIN) return true;
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch (_) {
        return false;
    }
}

function listSubdirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(d => d.isDirectory() || d.isSymbolicLink())
            .map(d => path.join(dir, d.name));
    } catch (_) {
        return [];
    }
}

// Version dirs sorted newest-first (v22.1.0 before v18.20.0).
function sortVersionsDesc(dirs) {
    const key = s => path.basename(s).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    return dirs.sort((a, b) => {
        const ka = key(a), kb = key(b);
        for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
            const d = (kb[i] || 0) - (ka[i] || 0);
            if (d) return d;
        }
        return 0;
    });
}

function candidateDirs() {
    const home = os.homedir();
    const dirs = [
        path.join(home, '.claude', 'local'),
        path.join(home, '.claude', 'local', 'bin'),
        path.join(home, '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.asdf', 'shims'),
        path.join(home, 'Library', 'pnpm'),
        path.join(home, '.local', 'share', 'pnpm'),
        '/usr/bin',
        '/bin'
    ];
    if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
    const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
    for (const v of sortVersionsDesc(listSubdirs(path.join(nvmDir, 'versions', 'node')))) {
        dirs.push(path.join(v, 'bin'));
    }
    const fnmDirs = [
        path.join(home, '.fnm', 'node-versions'),
        path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
        path.join(home, '.local', 'share', 'fnm', 'node-versions')
    ];
    for (const fd of fnmDirs) {
        for (const v of sortVersionsDesc(listSubdirs(fd))) dirs.push(path.join(v, 'installation', 'bin'));
    }
    if (IS_WIN && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    return dirs;
}

function findInDirs(dirs) {
    for (const d of dirs) {
        if (!d) continue;
        for (const name of EXE_NAMES) {
            const p = path.join(d, name);
            if (isExecutable(p)) return p;
        }
    }
    return null;
}

// Ask the user's interactive login shell — picks up nvm/asdf/aliases set in rc files.
function findViaShell() {
    if (IS_WIN) return null;
    const shell = process.env.SHELL || '/bin/zsh';
    try {
        const out = execFileSync(shell, ['-ilc', 'command -v claude'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const line = out.split('\n').map(s => s.trim()).filter(s => s.startsWith('/')).pop();
        return line && isExecutable(line) ? line : null;
    } catch (_) {
        return null;
    }
}

/** @returns {string|null} absolute path to claude, or null if not found */
function resolveClaudePath() {
    if (userOverride && isExecutable(userOverride)) return userOverride;
    if (cached !== undefined) return cached;
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    cached = findInDirs(pathDirs) || findInDirs(candidateDirs()) || findViaShell();
    console.log(`[claude-path] resolved: ${cached || '(not found)'}`);
    return cached;
}

/** Set the user-configured path (settings); blank = auto-detect. Re-resolves next time. */
function setClaudePathOverride(p) {
    userOverride = (p || '').trim();
    cached = undefined;
}

/** Prepend the resolved claude's directory to env.PATH (mutates + returns env). */
function withClaudeOnPath(env) {
    const p = resolveClaudePath();
    if (!p) return env;
    const dir = path.dirname(p);
    const parts = (env.PATH || '').split(path.delimiter).filter(x => x && x !== dir);
    env.PATH = [dir, ...parts].join(path.delimiter);
    return env;
}

module.exports = { resolveClaudePath, setClaudePathOverride, withClaudeOnPath };
