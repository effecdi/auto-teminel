// Claude CLI Terminal - Electron Main Process (v5 - Automation)
require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog, nativeImage, Menu, shell } = require('electron');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const Store = require('electron-store');
const pty = require('node-pty');
const TaskQueue = require('./task-queue');
const ComputerControl = require('./computer-control');
const { startRemoteServer, stopRemoteServer, broadcastOutput, broadcastEvent, broadcastQueueUpdate } = require('./remote-server');
const { WebSocketServer } = require('ws');
const { DebateEngine, MODES } = require('./debate-engine');
const { buildProjectContext, getOperationsList } = require('./project-context');
const { classifyTask, buildExecutionPrompt, ROUTE_MODES } = require('./task-router');
const { autoUpdater } = require('electron-updater');

// Prevent EPIPE crashes when stdout/stderr pipes are closed during shutdown
process.stdout?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Catch unhandled rejections and exceptions to prevent app crash
process.on('unhandledRejection', (reason, promise) => {
    try { console.error('[Main] Unhandled Rejection:', reason); } catch (_) {}
});
process.on('uncaughtException', (err) => {
    try { console.error('[Main] Uncaught Exception:', err); } catch (_) {}
    // Don't exit — let Electron handle graceful recovery
});

const store = new Store();
let mainWindow;

// Computer Control instances — one per session (keyed by arbitrary id)
const computerControls = new Map();

// Track temp files for cleanup
const tempImageFiles = [];

// ===================================================================
//  PTY Pool — one PTY per project, keyed by projectId
//  Each entry: { process, disposables[], autoRunTimer, alive, manualKill, projectPath, claudeArgs }
// ===================================================================
const ptyPool = new Map();

// ===================================================================
//  Task Queue — shared between renderer (IPC) and remote API
// ===================================================================
const taskQueue = new TaskQueue({
    writeToPty: (projectId, text) => {
        const entry = ptyPool.get(projectId);
        if (!entry || !entry.alive || !entry.process) return;
        // 빈 텍스트가 PTY에 전달되면 Enter만 전송되어 CLI 종료 가능 — 차단
        if (!text || !text.trim()) {
            console.log(`[writeToPty] BLOCKED empty text for project ${projectId}`);
            return;
        }
        const PASTE_START = '\x1b[200~';
        const PASTE_END   = '\x1b[201~';
        entry.process.write(PASTE_START + text + PASTE_END);
        // Give TUI time to process paste before sending Enter.
        // Increased base from 300ms to 500ms to prevent premature Enter on slower systems.
        const baseDelay = 500;
        const extraDelay = Math.min(text.length * 0.5, 500);
        const delay = Math.round(baseDelay + extraDelay);
        setTimeout(() => {
            if (entry.alive && entry.process) {
                entry.process.write('\r');
            }
        }, delay);
    },
    ptyPool,
    onUpdate: (state) => {
        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('queue.updated', state);
        }
        // Notify WebSocket clients
        broadcastQueueUpdate(state);
    }
});

// ===================================================================
//  Task Queue Persistence — save/restore pending tasks across restarts
// ===================================================================
const TASK_PERSIST_KEY = 'pendingTaskQueue';
const TASK_PERSIST_INTERVAL = 10000; // Save every 10 seconds

function safelog(...args) {
    try { console.log(...args); } catch (_) {}
}

function persistTaskQueue() {
    try {
        const pending = taskQueue.getPendingTasks();
        if (pending.length > 0) {
            store.set(TASK_PERSIST_KEY, pending);
            safelog(`[Main] Persisted ${pending.length} pending task(s)`);
        } else {
            store.delete(TASK_PERSIST_KEY);
        }
    } catch (e) {
        try { console.error('[Main] Failed to persist task queue:', e.message); } catch (_) {}
    }
}

function restoreTaskQueue() {
    try {
        const saved = store.get(TASK_PERSIST_KEY);
        if (saved && Array.isArray(saved) && saved.length > 0) {
            taskQueue.restore(saved);
            store.delete(TASK_PERSIST_KEY);
            console.log(`[Main] Restored ${saved.length} task(s) from previous session`);
            // Notify renderer about restored tasks
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('queue.restored', { count: saved.length });
            }
        }
    } catch (e) {
        console.error('[Main] Failed to restore task queue:', e.message);
    }
}

// Periodic save — protects against sudden crashes (kill -9, power loss, etc.)
let taskPersistTimer = null;
function startTaskPersistTimer() {
    if (taskPersistTimer) return;
    taskPersistTimer = setInterval(() => {
        persistTaskQueue();
    }, TASK_PERSIST_INTERVAL);
}

// ===================================================================
//  Auto-Restart — respawn PTY on abnormal exit
// ===================================================================
let autoRestartEnabled = true;
let autoRestartResendPrompt = true;
let autoRestartMaxRetries = 3;
let autoRestartRateWindow = 300000; // 5 minutes in ms
const autoRestartRetryCount = new Map(); // projectId -> { count, firstTime }

// ===================================================================
//  Auto-Approve — auto-respond to Claude CLI plan prompts
// ===================================================================
let autoApproveEnabled = true;
let autoApproveMode = 'clear_context'; // 'yes' | 'clear_context'
const AUTO_APPROVE_COOLDOWN = 3000; // 3s between auto-approves per project
const AUTO_APPROVE_BUFFER_SIZE = 800;
const autoApproveLastSent = new Map();    // projectId -> timestamp
const autoApproveOutputBuffer = new Map(); // projectId -> last N chars (stripped)

const autoApprovePatterns = [
    'Would you like to proceed',
    'Do you want to proceed',
    'want to execute',
    'ready to execute',
    'Do you approve',
    'Yes, and',
    'clear context',
    'Run /compact',        // Context limit: "Context low · Run /compact to compact & continue"
    'Please run /login',   // Auth error: "API Error: 401 ... Please run /login"
    'Skip interview and plan immediately',  // Claude CLI /init interview — auto-skip
    'Type something'                        // Claude CLI /init interview multi-select with Next
];

function checkAutoApprove(projectId, rawData) {
    if (!autoApproveEnabled) return;

    // Accumulate stripped output into a rolling buffer per project
    const clean = stripAnsi(rawData);
    let buf = (autoApproveOutputBuffer.get(projectId) || '') + clean;
    if (buf.length > AUTO_APPROVE_BUFFER_SIZE) {
        buf = buf.slice(-AUTO_APPROVE_BUFFER_SIZE);
    }
    autoApproveOutputBuffer.set(projectId, buf);

    // DEBUG: log chunks that look like prompts
    const lowerClean = clean.toLowerCase();
    if (lowerClean.includes('proceed') || lowerClean.includes('approve') || lowerClean.includes('yes') || lowerClean.includes('context')) {
        console.log(`[AutoApprove DEBUG] chunk: ${JSON.stringify(clean.substring(0, 300))}`);
        console.log(`[AutoApprove DEBUG] buffer tail: ${JSON.stringify(buf.slice(-400))}`);
    }

    for (const pattern of autoApprovePatterns) {
        if (buf.includes(pattern)) {
            // Cooldown — prevent double-trigger on the same prompt
            const lastSent = autoApproveLastSent.get(projectId) || 0;
            if (Date.now() - lastSent < AUTO_APPROVE_COOLDOWN) return;

            autoApproveLastSent.set(projectId, Date.now());
            // Clear buffer so the same prompt doesn't re-trigger
            autoApproveOutputBuffer.set(projectId, '');

            const entry = ptyPool.get(projectId);
            if (!entry || !entry.alive || !entry.process) return;

            console.log(`[Main] Auto-approve triggered for ${projectId} (mode: ${autoApproveMode})`);

            // Delay to let the prompt fully render
            setTimeout(() => {
                const e = ptyPool.get(projectId);
                if (!e || !e.alive || !e.process) return;

                console.log(`[AutoApprove] Sending response (mode: ${autoApproveMode})`);

                if (buf.includes('Skip interview and plan immediately') || buf.includes('Type something')) {
                    // Claude CLI /init interview detected — block task dispatch during interview
                    e.claudeReady = false;
                    console.log('[AutoApprove] Interview detected, claudeReady=false to block dispatch');

                    const isSkipScreen = buf.includes('Skip interview and plan immediately');
                    const downs = isSkipScreen ? 12 : 10;
                    const label = isSkipScreen ? 'Skip interview' : 'Next';

                    console.log(`[AutoApprove] Interview: navigating to "${label}" (${downs} Down arrows)`);
                    const DOWN = '\x1b[B';
                    for (let i = 0; i < downs; i++) {
                        setTimeout(() => {
                            if (e.alive && e.process) e.process.write(DOWN);
                        }, i * 60);
                    }
                    setTimeout(() => {
                        if (e.alive && e.process) {
                            e.process.write('\r');
                            console.log(`[AutoApprove] Sent: Enter on ${label}`);
                        }
                    }, downs * 60 + 300);

                    // After interview navigation, check if interview is done
                    // If buffer no longer has interview patterns → mark ready
                    setTimeout(() => {
                        const ent = ptyPool.get(projectId);
                        if (!ent || !ent.alive) return;
                        const curBuf = autoApproveOutputBuffer.get(projectId) || '';
                        const stillInInterview = curBuf.includes('Type something') ||
                                                 curBuf.includes('Skip interview');
                        if (!stillInInterview) {
                            ent.claudeReady = true;
                            console.log(`[AutoApprove] Interview done, claudeReady=true for ${projectId}`);
                            taskQueue.process();
                        } else {
                            console.log(`[AutoApprove] Still in interview for ${projectId}, waiting...`);
                            // Auto-approve will re-trigger on next interview screen
                        }
                    }, 5000);
                } else if (buf.includes('Run /compact')) {
                    // Context limit warning — send /compact command
                    console.log('[AutoApprove] Context low detected, sending /compact');
                    writeToPty(e, '/compact');
                } else if (buf.includes('Please run /login')) {
                    // Authentication error — send /login command
                    console.log('[AutoApprove] Auth error detected, sending /login');
                    writeToPty(e, '/login');
                } else if (autoApproveMode === 'clear_context') {
                    // "Would you like to proceed?" interactive menu
                    // In current Claude Code, "Yes, clear context..." is option 1 (default ❯)
                    // Just press Enter to select it — do NOT press Down
                    e.process.write('\r');
                    console.log('[AutoApprove] Sent: Enter (clear_context is default option 1)');
                    // Fallback: if prompt didn't advance after 1.5s, retry
                    setTimeout(() => {
                        if (!e.alive || !e.process) return;
                        const curBuf = autoApproveOutputBuffer.get(projectId) || '';
                        for (const pat of autoApprovePatterns) {
                            if (curBuf.includes(pat)) {
                                console.log('[AutoApprove] Still on prompt, retrying Enter');
                                e.process.write('\r');
                                break;
                            }
                        }
                    }, 1500);
                } else {
                    // Just Enter → select first option "Yes"
                    e.process.write('\r');
                }

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('autoApprove.triggered', {
                        projectId,
                        mode: autoApproveMode,
                        timestamp: Date.now()
                    });
                }
            }, 800);

            break;
        }
    }
}

// ===================================================================
//  Idle Detection — per-project output buffering
//  Each entry: { timer, lastOutput }
// ===================================================================
const idleTimers = new Map();
const IDLE_TIMEOUT = 5000; // 5 seconds of no output = idle (Claude CLI needs thinking time)
const HEALTH_CHECK_IDLE_TIMEOUT = 8000; // 8 seconds for health check (Claude CLI has longer pauses)
const HEALTH_CHECK_STEP_TIMEOUT = 120000; // 2 minutes max per health check step

// ===================================================================
//  Error Detection — watch PTY output for error patterns
// ===================================================================
const defaultErrorPatterns = [
    { pattern: 'SyntaxError:', label: 'SyntaxError' },
    { pattern: 'TypeError:', label: 'TypeError' },
    { pattern: 'ReferenceError:', label: 'ReferenceError' },
    { pattern: 'RangeError:', label: 'RangeError' },
    { pattern: 'npm ERR!', label: 'npm Error' },
    { pattern: 'fatal:', label: 'Fatal Error' },
    { pattern: 'panic:', label: 'Panic' },
    { pattern: 'Traceback \\(most recent', label: 'Python Traceback' },
    { pattern: 'Unhandled.*Exception', label: 'Exception' },
    { pattern: 'segmentation fault', label: 'Segfault' },
    { pattern: '-?\\w+:\\s+\\S+:\\s+command not found', label: 'Command Not Found' },
    { pattern: 'Error:\\s*(ENOENT|EACCES|EPERM):', label: 'File System Error' },
    { pattern: 'BUILD FAILED', label: 'Build Failed' },
    { pattern: 'FAIL\\s+src/', label: 'Test Failure' }
];

// Migrate old saved patterns that used bare error names (without colon)
// This prevents false positives from casual mentions like "No SyntaxError found"
const bareErrorMigrations = {
    'SyntaxError': 'SyntaxError:', 'TypeError': 'TypeError:',
    'ReferenceError': 'ReferenceError:', 'RangeError': 'RangeError:',
    'command not found': '-?\\w+:\\s+\\S+:\\s+command not found',
    '\\w+:\\s+.*command not found': '-?\\w+:\\s+\\S+:\\s+command not found',
    'ENOENT|EACCES|EPERM': 'Error:\\s*(ENOENT|EACCES|EPERM):',
    'Error:\\s*(ENOENT|EACCES|EPERM)': 'Error:\\s*(ENOENT|EACCES|EPERM):'
};
(function migrateErrorPatterns() {
    const saved = store.get('errorPatterns');
    if (!saved) return;
    let changed = false;
    for (const entry of saved) {
        if (bareErrorMigrations[entry.pattern]) {
            entry.pattern = bareErrorMigrations[entry.pattern];
            changed = true;
        }
    }
    if (changed) store.set('errorPatterns', saved);
})();

// Lines containing these strings are ignored (CLI noise, not real errors)
const errorIgnorePatterns = [
    'Auto-update',
    'Auto-update failed',
    'claude doctor',
    'npm i -g',
    'update available',
    'Downloading',
    'Installing',
    'Try claude doctor',
    '@anthropic-ai/claude',
    '\u2717',  // ✗ symbol used by Claude CLI status messages
    // False-positive suppression: verification/report output mentioning errors negatively
    'no syntax error',
    'no logic issue',
    'no type error',
    'no errors',
    'no issues',
    'No problems found',
    'No issues found',
    'no remaining error',
    'syntax errors found',
    'All checks pass',
    'Code is clean',
    'code is correct',
    'properly balanced',
    'All defined',
    'null-guarded',
    '0 errors',
    'zero errors',
    'PASS',
    'passed',
    // Spaceless variants (PTY can strip spaces from Claude CLI output)
    'nosyntaxerror',
    'nologicissue',
    'notypeerror',
    'nomissingimport',
    'codeisclean',
    'noerrors',
    'noissues',
    // Claude CLI tool-use output markers (diffs, file edits, tool results)
    '\u23FA',   // ⏺ — tool use header
    '\u23BF',   // ⎿ — tool output continuation
    'Update(',  // Update(filename) diff header
    'Read(',    // Read(filename) tool
    'Write(',   // Write(filename) tool
    'Added\x20',    // "Added N lines..." (with trailing space to avoid false match)
    'removed lines',
    'lines changed'
];

// Additional regex-based false-positive check for verification output
// Matches common verification summary patterns even with mangled spacing
const verificationOutputRegex = /no\s*syntax\s*error|no\s*logic\s*issue|no\s*type\s*error|no\s*missing\s*import|code\s*is\s*clean|no\s*errors|no\s*issues|all\s*checks?\s*pass/i;

let errorDetectionEnabled = true;

// ===================================================================
//  Auto-Fix — automatically send fix prompts to Claude CLI on error
// ===================================================================
let autoFixEnabled = true;
const AUTO_FIX_MAX_RETRIES = 5;
const AUTO_FIX_RETRY_WINDOW = 180000; // 3 minutes
let autoFixCooldown = 15; // seconds (faster response)
let autoFixTemplate = 'CRITICAL ERROR DETECTED: [{label}] {error}\n\nYou MUST:\n1. Analyze the root cause of this error — do NOT guess, read the actual code.\n2. Fix the error completely — not just the symptom but the underlying cause.\n3. Check for related errors in the same file and nearby files.\n4. After fixing, re-read the modified files to verify no new syntax/logic errors were introduced.\n5. If the fix requires changes to multiple files, fix ALL of them.\nDo NOT skip any step. Fix it properly.';
const autoFixLastSent = new Map();   // projectId -> timestamp
const autoFixRetryCount = new Map(); // projectId -> { count, firstTime }
const pendingAutoFix = new Map();    // projectId -> { label, line }

// ===================================================================
//  Auto-Verify — verify fixes and task outputs automatically
// ===================================================================
let autoVerifyEnabled = true;
const pendingAutoVerify = new Map(); // projectId -> { type: 'fix'|'task', context }
let _downloadedUpdateFile = null; // macOS custom installer: path to downloaded zip
const autoVerifyLastSent = new Map(); // projectId -> timestamp
const AUTO_VERIFY_COOLDOWN = 10000; // 10s between verifications

// ===================================================================
//  Schedule System
// ===================================================================
const activeSchedules = new Map(); // scheduleId -> intervalId

/**
 * Write a prompt to the PTY using bracketed paste + Enter.
 * Claude CLI's TUI (ink-based) uses bracketed paste mode, so raw text input
 * can cause duplicate characters. Wrapping in paste brackets fixes this.
 * Enter is sent separately after a delay so the TUI processes the text first.
 */
function writeToPty(entry, text) {
    if (!entry || !entry.alive || !entry.process) return;
    const PASTE_START = '\x1b[200~';
    const PASTE_END   = '\x1b[201~';
    entry.process.write(PASTE_START + text + PASTE_END);
    // Give TUI enough time to process pasted text before sending Enter.
    // Base 500ms + proportional to text length (max +500ms for very long texts).
    const baseDelay = 500;
    const extraDelay = Math.min(text.length * 0.5, 500);
    const delay = Math.round(baseDelay + extraDelay);
    setTimeout(() => {
        if (!entry.alive || !entry.process) return;
        entry.process.write('\r');
    }, delay);
}

function stripAnsi(str) {
    return str
        .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (including ?2026h style)
        .replace(/\x1b\][^\x07]*\x07/g, '')           // OSC sequences
        .replace(/\x1b[()][0-9A-B]/g, '')             // charset sequences
        .replace(/\x1b[\x20-\x2F]*[\x40-\x7E]/g, '') // other escape sequences
        .replace(/[\x00-\x08\x0e-\x1f]/g, '');        // remaining control chars
}

// Words that negate an error when they appear near the error keyword on the same line
const negationPrefixes = /\b(no|zero|0|without|free of|absence of|isn'?t|aren'?t|wasn'?t|weren'?t|not? a|not? any|no remaining|fix(ed|ing)?|resolved|cleared|passed|pass |verified|check for|checking|looking for|scan for|detect|watch)\b/i;

// Lines starting with these prefixes are ALWAYS real errors — skip negation check
const hardErrorPrefixes = /^\s*(fatal:|error:|panic:|FATAL|ERROR|PANIC|npm ERR!|Traceback|Segmentation fault|SyntaxError:|TypeError:|ReferenceError:|RangeError:|URIError:|EvalError:|UnhandledPromiseRejection|Unhandled)/i;

// Per-project suppression: suppress error detection while auto-fix/verify is running,
// and also after seeing a Claude CLI tool-use marker in the output.
const errorSuppressUntil = new Map(); // projectId -> timestamp
const errorSuppressAutoAction = new Set(); // projectIds currently running auto-fix/verify
const ERROR_SUPPRESS_MS = 5000; // keep suppressing for 5s after last output from Claude
const cliToolMarkerRegex = /\u23FA|\u23BF|Update\(|Read\(|Write\(|Edit\(|Bash\(|Search\(|Glob\(|Grep\(/;
const lastOutputTime = new Map(); // projectId -> timestamp of last PTY data event

function checkErrorPatterns(projectId, rawData) {
    if (!errorDetectionEnabled) return;
    // Completely suppress during auto-fix/verify — all output is from the fix action
    if (errorSuppressAutoAction.has(projectId)) return;

    const clean = stripAnsi(rawData);

    // Track every data event — used to detect "Claude is actively outputting"
    const now = Date.now();
    const lastTime = lastOutputTime.get(projectId) || 0;
    lastOutputTime.set(projectId, now);

    // If this chunk contains a Claude CLI tool marker, start suppression window
    if (cliToolMarkerRegex.test(clean)) {
        errorSuppressUntil.set(projectId, now + ERROR_SUPPRESS_MS);
        return;
    }
    // If we're inside a suppression window, skip detection.
    // Also extend the window whenever data is still flowing rapidly (within 2s gaps),
    // because Claude's output arrives in many chunks over seconds.
    const suppressEnd = errorSuppressUntil.get(projectId);
    if (suppressEnd && now < suppressEnd) {
        // Data is still flowing while suppressed — extend the window
        errorSuppressUntil.set(projectId, now + ERROR_SUPPRESS_MS);
        return;
    }

    // Even outside a marker-triggered window: if data has been flowing rapidly
    // (last chunk was < 5s ago), this is likely part of Claude's continuous output
    // (reading files, diffs, code review, etc.). Skip entirely.
    if (now - lastTime < 5000) {
        return;
    }

    // Skip if the chunk matches any ignore pattern (CLI noise / verification output)
    const lowerClean = clean.toLowerCase();
    for (const ig of errorIgnorePatterns) {
        if (lowerClean.includes(ig.toLowerCase())) return;
    }
    // Also skip if the chunk matches verification output regex (handles mangled spacing)
    if (verificationOutputRegex.test(lowerClean)) return;

    const patterns = store.get('errorPatterns', defaultErrorPatterns);

    const lines = clean.split('\n');

    for (const { pattern, label } of patterns) {
        try {
            const regex = new RegExp(pattern, 'i');

            // Find the first line that contains the error keyword
            const matchLine = lines.find(l => regex.test(l));
            if (!matchLine) continue;
            const trimmed = matchLine.trim();

            // Skip very short or empty matches
            if (trimmed.length < 5) continue;

            // PTY-mangled prose filter: real error lines always have normal word spacing.
            // Mangled CLI output fuses words together with no spaces between them.
            // If a line longer than 20 chars has fewer than 5% spaces, it is mangled prose.
            if (trimmed.length > 20) {
                const spaceCount = (trimmed.match(/ /g) || []).length;
                if (spaceCount / trimmed.length < 0.05) continue;
            }

            // The error keyword must appear at a real word boundary on this line —
            // preceded by line start, whitespace, or prompt chars.
            const boundaryRegex = new RegExp('(?:^|[\\s>$#%])' + pattern, 'i');
            if (!boundaryRegex.test(trimmed)) continue;

            // Skip lines that look like source code, regex definitions, diff output,
            // or references to our own source files (self-triggering prevention)
            if (/^\s*(const|let|var|function|if|else|return|\/\/|\/\*|\*|['"`{}\]])/.test(trimmed) ||
                /[=:]\s*\/.*\/(i|g|m|ig|im|gi|gim)?;?\s*$/.test(trimmed) ||
                /new RegExp\(/.test(trimmed) ||
                /^\s*\d+\s*[+\-│]/.test(trimmed) ||
                /main\.js|renderer-fixed\.js|renderer\.js/.test(trimmed) ||
                /label.*['"].*Error/i.test(trimmed) ||
                /pattern.*['"].*error/i.test(trimmed)) continue;

            // Skip if the matched line itself contains a CLI tool marker
            if (cliToolMarkerRegex.test(trimmed)) {
                errorSuppressUntil.set(projectId, Date.now() + ERROR_SUPPRESS_MS);
                continue;
            }

            // Skip if the line mentions the keyword in a negation context
            // e.g. "No syntax errors", "check for TypeError", "0 errors"
            // But NEVER skip lines that start with hard-error prefixes (see hardErrorPrefixes).
            if (!hardErrorPrefixes.test(trimmed) && negationPrefixes.test(trimmed)) continue;

            {
                const matchedLine = trimmed.substring(0, 200);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal.outputMatch', {
                        projectId,
                        label,
                        pattern,
                        line: matchedLine,
                        timestamp: Date.now()
                    });
                }
                // During health check: count errors but only trigger auto-fix if healthCheckAutoFix is enabled
                if (healthCheckRunning && isHealthCheckProject(projectId)) {
                    onErrorForHealthCheck();
                    const hcSettings = getHealthCheckSettings();
                    if (hcSettings.autoFixOnError) {
                        triggerAutoFix(projectId, label, matchedLine);
                    }
                } else {
                    triggerAutoFix(projectId, label, matchedLine);
                }
            }
            break;
        } catch (_) {}
    }
}

// ===================================================================
//  Auto-Fix: trigger and process
// ===================================================================

function triggerAutoFix(projectId, label, line) {
    if (!autoFixEnabled) return;

    // Cooldown check
    const lastSent = autoFixLastSent.get(projectId) || 0;
    const cooldownMs = autoFixCooldown * 1000;
    if (Date.now() - lastSent < cooldownMs) return;

    // Retry limit check (within window)
    const retryInfo = autoFixRetryCount.get(projectId);
    if (retryInfo) {
        if (Date.now() - retryInfo.firstTime > AUTO_FIX_RETRY_WINDOW) {
            autoFixRetryCount.set(projectId, { count: 1, firstTime: Date.now() });
        } else if (retryInfo.count >= AUTO_FIX_MAX_RETRIES) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('autoFix.maxRetriesReached', { projectId });
            }
            return;
        } else {
            retryInfo.count++;
        }
    } else {
        autoFixRetryCount.set(projectId, { count: 1, firstTime: Date.now() });
    }

    // Queue only — never send immediately. Renderer will signal when queue is clear.
    pendingAutoFix.set(projectId, { label, line });

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('autoFix.queued', { projectId, label, line });
    }
}

function processPendingAutoFix(projectId) {
    const pending = pendingAutoFix.get(projectId);
    if (!pending) return;
    if (!autoFixEnabled) {
        pendingAutoFix.delete(projectId);
        return;
    }

    const entry = ptyPool.get(projectId);
    if (!entry || !entry.alive || !entry.process) {
        pendingAutoFix.delete(projectId);
        return;
    }

    // Suppress error detection while auto-fix runs (cleared on next idle)
    errorSuppressAutoAction.add(projectId);

    // Build prompt from template
    const prompt = autoFixTemplate
        .replace(/\{error\}/g, pending.line)
        .replace(/\{label\}/g, pending.label);

    writeToPty(entry, prompt);

    autoFixLastSent.set(projectId, Date.now());
    pendingAutoFix.delete(projectId);

    // Queue auto-verify after fix completes
    if (autoVerifyEnabled) {
        pendingAutoVerify.set(projectId, {
            type: 'fix',
            context: `Verify fix for: [${pending.label}] ${pending.line.substring(0, 100)}`
        });
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('autoFix.triggered', {
            projectId,
            label: pending.label,
            line: pending.line,
            timestamp: Date.now()
        });
    }

    console.log(`[Main] Auto-fix sent for project ${projectId}: ${pending.label}`);
}

// ===================================================================
//  Auto-Verify: process pending verifications on idle
// ===================================================================

function processPendingAutoVerify(projectId) {
    const pending = pendingAutoVerify.get(projectId);
    if (!pending) return;
    if (!autoVerifyEnabled) {
        pendingAutoVerify.delete(projectId);
        return;
    }

    // Cooldown check
    const lastSent = autoVerifyLastSent.get(projectId) || 0;
    if (Date.now() - lastSent < AUTO_VERIFY_COOLDOWN) return;

    const entry = ptyPool.get(projectId);
    if (!entry || !entry.alive || !entry.process) {
        pendingAutoVerify.delete(projectId);
        return;
    }

    let verifyPrompt;
    if (pending.type === 'fix') {
        verifyPrompt = `IMPORTANT: You MUST thoroughly verify the fix you just applied. Do ALL of the following steps:
1. Re-read every file you modified and check for syntax errors, typos, unclosed brackets, missing semicolons.
2. Run the build command (npm run build, tsc --noEmit, etc.) and check for compile errors.
3. Run tests if available (npm test, jest, pytest, etc.) and check for failures.
4. Verify the original error is actually resolved — don't just assume it's fixed.
5. Check for any NEW errors or regressions introduced by the fix.
6. If ANY issues remain, fix them immediately. Do NOT skip this step.
Report what you verified and the results.`;
    } else if (pending.type === 'task') {
        verifyPrompt = `IMPORTANT: You MUST thoroughly verify the changes you just made. Do ALL of the following steps:
1. Re-read every file you modified — check for syntax errors, logic bugs, missing imports, undefined variables, type errors.
2. Cross-reference: ensure all function calls match their definitions (correct argument count, types, return values).
3. Check HTML/CSS if modified — verify all IDs referenced in JS actually exist in HTML, no duplicate IDs, all onclick handlers point to defined functions.
4. Run the build command (npm run build, tsc, etc.) and fix any compile errors.
5. Run tests if available and fix any failures.
6. Look for edge cases: null/undefined access, off-by-one errors, missing error handling at boundaries.
7. If you find ANY problems, fix them immediately — do NOT just report them.
Be thorough. Do not give a shallow "looks good" response.`;
    } else {
        pendingAutoVerify.delete(projectId);
        return;
    }

    // Suppress error detection while auto-verify runs (cleared on next idle)
    errorSuppressAutoAction.add(projectId);

    writeToPty(entry, verifyPrompt);

    autoVerifyLastSent.set(projectId, Date.now());
    pendingAutoVerify.delete(projectId);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('autoVerify.triggered', {
            projectId,
            type: pending.type,
            context: pending.context || '',
            timestamp: Date.now()
        });
    }

    console.log(`[Main] Auto-verify sent for project ${projectId}: ${pending.type}`);
}

// Shared idle-processing logic used by both normal idle and grace-period retry.
function _processIdleForProject(projectId) {
    errorSuppressAutoAction.delete(projectId);
    const entry = ptyPool.get(projectId);
    // Restore claudeReady since idle means Claude CLI returned to prompt
    if (entry && entry.alive) {
        entry.claudeReady = true;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal.idle', { projectId });
    }
    taskQueue.markIdle(projectId);
    broadcastEvent('terminal.idle', projectId);
    if (!taskQueue.hasWork(projectId)) {
        if (pendingAutoFix.has(projectId)) {
            processPendingAutoFix(projectId);
        } else {
            processPendingAutoVerify(projectId);
        }
    }
}

function resetIdleTimer(projectId) {
    const existing = idleTimers.get(projectId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
        // Clear auto-action suppression — CLI response is done, safe to detect errors again
        errorSuppressAutoAction.delete(projectId);

        // Grace period: ignore idle if dispatch happened less than 8s ago AND claudeReady is still false.
        // If claudeReady=true, Claude already showed its prompt — safe to mark idle immediately.
        const entry = ptyPool.get(projectId);
        const DISPATCH_GRACE_PERIOD = 8000; // 8 seconds (was increased to 20s in v4.7.16 but that caused 25s stuck bug)
        if (entry && entry._lastDispatchTime && !entry.claudeReady &&
                (Date.now() - entry._lastDispatchTime < DISPATCH_GRACE_PERIOD)) {
            console.log(`[Idle] Grace period active for ${projectId} (${Math.round((Date.now() - entry._lastDispatchTime) / 1000)}s < 8s, claudeReady=false) — rescheduling`);
            // Re-schedule to fire after grace period ends.
            // IMPORTANT: directly call _processIdleForProject (not resetIdleTimer) to avoid extra 5s wait.
            const retryAfter = DISPATCH_GRACE_PERIOD - (Date.now() - entry._lastDispatchTime) + 500;
            idleTimers.set(projectId, {
                timer: setTimeout(() => {
                    idleTimers.delete(projectId);
                    _processIdleForProject(projectId);
                }, retryAfter),
                lastOutput: Date.now()
            });
            return; // Don't mark idle yet, wait for real output
        }

        _processIdleForProject(projectId);
    }, IDLE_TIMEOUT);

    idleTimers.set(projectId, { timer, lastOutput: Date.now() });

    // Health check uses a separate, longer idle timer
    if (healthCheckRunning && isHealthCheckProject(projectId)) {
        if (healthCheckIdleTimer) clearTimeout(healthCheckIdleTimer);
        healthCheckIdleTimer = setTimeout(() => {
            healthCheckIdleTimer = null;
            onHealthCheckIdle(projectId);
        }, HEALTH_CHECK_IDLE_TIMEOUT);
    }
}

// Check if projectId matches the current health check step's project
function isHealthCheckProject(projectId) {
    if (healthCheckCurrentIdx < 0 || healthCheckCurrentIdx >= healthCheckQueue.length) return false;
    return healthCheckQueue[healthCheckCurrentIdx].projectId === projectId;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1200,
        minHeight: 700,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#0d1117',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        // Save active session projects before destroying
        const activeProjectIds = [];
        for (const [projectId, entry] of ptyPool) {
            if (entry.alive) activeProjectIds.push(projectId);
        }
        store.set('activeSessionProjects', activeProjectIds);

        // Persist pending/running tasks so they survive restarts
        persistTaskQueue();

        // Cleanup Computer Control instances
        for (const [, cc] of computerControls) { cc.stop(); cc.destroyBrowserView(); }
        computerControls.clear();

        stopRemoteServer();
        destroyAllPty();
        clearAllSchedules();
        if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
        if (healthCheckStepTimeoutTimer) { clearTimeout(healthCheckStepTimeoutTimer); healthCheckStepTimeoutTimer = null; }
        if (healthCheckIdleTimer) { clearTimeout(healthCheckIdleTimer); healthCheckIdleTimer = null; }
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // macOS에서 Cmd+C/V/X/A 등 기본 단축키가 textarea/input에서 동작하려면
    // Edit 메뉴가 반드시 있어야 함
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    createWindow();
    startBrowserWsServer();

    // ===================================================================
    //  Auto-Updater (electron-updater)
    // ===================================================================
    autoUpdater.autoDownload = false;          // 사용자 확인 후 다운로드
    autoUpdater.autoInstallOnAppQuit = false;   // 사용자 확인 후 설치
    // Skip code signing verification — app is unsigned
    if (process.platform === 'darwin') {
        autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
    }
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'effecdi',
        repo: 'auto-teminel',
    });
    safelog(`[Updater] Current version: ${app.getVersion()}, feed: github/effecdi/auto-teminel`);

    autoUpdater.on('checking-for-update', () => {
        safelog('[Updater] Checking for update...');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.checking');
        }
    });

    autoUpdater.on('update-available', (info) => {
        safelog(`[Updater] Update available: v${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.available', {
                version: info.version,
                releaseNotes: info.releaseNotes,
                releaseDate: info.releaseDate
            });
        }
    });

    autoUpdater.on('update-not-available', (info) => {
        safelog('[Updater] No update available.');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.not-available', {
                version: info.version
            });
        }
    });

    let _autoInstallTimer = null;
    let _updateReadyToInstall = false;

    const scheduleAutoInstall = (reason) => {
        if (_autoInstallTimer) return; // already scheduled
        _updateReadyToInstall = true;
        safelog(`[Updater] Auto-install scheduled (${reason}). Restarting in 5s...`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.autoRestart', { seconds: 5 });
        }
        _autoInstallTimer = setTimeout(() => {
            safelog('[Updater] Auto-installing now...');
            try {
                autoUpdater.quitAndInstall(false, true);
            } catch (err) {
                safelog('[Updater] quitAndInstall threw:', err.message);
            }
            // quitAndInstall can silently fail on macOS (unsigned app).
            // If still alive after 2s, force restart — autoInstallOnAppQuit will apply the update.
            setTimeout(() => {
                safelog('[Updater] App still alive after quitAndInstall. Force relaunch via app.exit(0)...');
                app.relaunch();
                app.exit(0);
            }, 2000);
        }, 5000);
    };

    autoUpdater.on('download-progress', (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.progress', {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total
            });
        }
        // Fallback: if progress hits 100% but update-downloaded never fires
        // (자동 설치 비활성화 — renderer에서 수동 설치 유도)
        if (progress.percent >= 99.9 && !_updateReadyToInstall) {
            _updateReadyToInstall = true;
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        _downloadedUpdateFile = info.downloadedFile || null;
        safelog(`[Updater] Update downloaded: v${info.version}` + (_downloadedUpdateFile ? `, file: ${_downloadedUpdateFile}` : ''));
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.downloaded', {
                version: info.version
            });
        }
        // 자동 재시작 비활성화 — renderer에서 사용자가 직접 설치
        _updateReadyToInstall = true;
    });

    autoUpdater.on('error', (err) => {
        safelog('[Updater] Error:', err.message, err.stack || '');
        // macOS unsigned app: Squirrel.Mac code signature check is expected to fail.
        // Custom installer handles the actual installation — suppress this from UI.
        if (process.platform === 'darwin' && err.message && err.message.includes('Could not get code signature')) {
            safelog('[Updater] Suppressing code signature error (unsigned app — custom installer active)');
            return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater.error', {
                message: err.message
            });
        }
    });

    // Check for updates after a short delay, then periodically every 10 minutes
    const doUpdateCheck = () => {
        autoUpdater.checkForUpdates().catch(err => {
            safelog('[Updater] Check failed:', err.message);
        });
    };
    setTimeout(doUpdateCheck, 3000);
    setInterval(doUpdateCheck, 10 * 60 * 1000);
});

app.on('window-all-closed', () => {
    persistTaskQueue();
    if (taskPersistTimer) { clearInterval(taskPersistTimer); taskPersistTimer = null; }
    stopRemoteServer();
    destroyAllPty();
    clearAllSchedules();
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
    if (healthCheckStepTimeoutTimer) { clearTimeout(healthCheckStepTimeoutTimer); healthCheckStepTimeoutTimer = null; }
    if (healthCheckIdleTimer) { clearTimeout(healthCheckIdleTimer); healthCheckIdleTimer = null; }
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
    // Persist pending/running tasks so they survive restarts
    persistTaskQueue();

    for (const tmpPath of tempImageFiles) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    tempImageFiles.length = 0;
});

// ===================================================================
//  PTY Lifecycle Helpers
// ===================================================================

function getShell() {
    const customShell = store.get('shellPath', '');
    if (customShell && fs.existsSync(customShell)) {
        return customShell;
    }
    if (process.platform === 'win32') {
        return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
}

function destroyPty(projectId) {
    const entry = ptyPool.get(projectId);
    if (!entry) return;

    // Mark as manual kill so auto-restart doesn't trigger
    entry.manualKill = true;

    if (entry.autoRunTimer) {
        clearTimeout(entry.autoRunTimer);
    }

    for (const d of entry.disposables) {
        try { d.dispose(); } catch (_) {}
    }

    if (entry.process) {
        try {
            entry.process.kill();
            console.log(`[Main] PTY killed for project: ${projectId}`);
        } catch (e) {
            console.log(`[Main] PTY kill error for ${projectId}:`, e.message);
        }
    }

    // Clean up idle timer
    const idle = idleTimers.get(projectId);
    if (idle) {
        clearTimeout(idle.timer);
        idleTimers.delete(projectId);
    }

    ptyPool.delete(projectId);
}

function destroyAllPty() {
    for (const projectId of ptyPool.keys()) {
        destroyPty(projectId);
    }
}

// ===================================================================
//  IPC: terminal.spawn  +  shared spawnPtyForProject
// ===================================================================

/**
 * Shared PTY spawn — used by both `terminal.spawn` IPC and auto-restart.
 * Returns { success, pid, alreadyRunning } or { success: false, error }.
 */
function spawnPtyForProject(projectId, projectPath, claudeArgs, cols, rows, claudeModel) {
    try {
        const existing = ptyPool.get(projectId);
        if (existing && existing.alive) {
            console.log(`[Main] PTY already alive for project ${projectId}, PID: ${existing.process.pid}`);
            // Ensure claudeReady is set for already-running PTYs
            if (!existing.claudeReady) existing.claudeReady = true;
            return { success: true, pid: existing.process.pid, alreadyRunning: true };
        }

        if (existing) {
            destroyPty(projectId);
        }

        // Validate project path exists before spawning
        let safeCwd = projectPath;
        if (!projectPath || !fs.existsSync(projectPath)) {
            console.warn(`[Main] Project path does not exist: ${projectPath}, falling back to home dir`);
            safeCwd = os.homedir();
        } else {
            try {
                const stat = fs.statSync(projectPath);
                if (!stat.isDirectory()) {
                    console.warn(`[Main] Project path is not a directory: ${projectPath}, falling back to home dir`);
                    safeCwd = os.homedir();
                }
            } catch (_) {
                safeCwd = os.homedir();
            }
        }

        const shell = getShell();
        const shellArgs = process.platform === 'win32' ? [] : ['-l'];

        // Validate shell binary exists
        if (!fs.existsSync(shell)) {
            return { success: false, error: `Shell not found: ${shell}. Check settings or set SHELL env variable.` };
        }

        console.log(`[Main] Spawning PTY for project ${projectId}: shell=${shell}, cwd=${safeCwd}`);

        const cleanEnv = { ...process.env };
        delete cleanEnv.CLAUDECODE;

        // Ensure PATH includes common locations where 'claude' CLI may be installed
        // (Electron GUI apps on macOS often have a minimal PATH)
        const extraPaths = [
            '/usr/local/bin',
            '/opt/homebrew/bin',
            path.join(os.homedir(), '.local', 'bin'),
            path.join(os.homedir(), '.claude', 'local', 'bin'),
            path.join(os.homedir(), '.nvm', 'versions', 'node', 'current', 'bin'),
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ];
        const currentPath = cleanEnv.PATH || '';
        const pathSet = new Set(currentPath.split(':'));
        for (const p of extraPaths) {
            pathSet.add(p);
        }
        cleanEnv.PATH = [...pathSet].join(':');

        const proc = pty.spawn(shell, shellArgs, {
            name: 'xterm-256color',
            cols: cols || 120,
            rows: rows || 30,
            cwd: safeCwd,
            env: {
                ...cleanEnv,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor'
            }
        });

        const pid = proc.pid;
        const disposables = [];

        const entry = {
            process: proc,
            disposables: disposables,
            autoRunTimer: null,
            alive: true,
            claudeReady: false,
            manualKill: false,
            projectPath: projectPath,
            claudeArgs: claudeArgs || '',
            claudeModel: claudeModel || ''
        };

        // PTY output → renderer + idle detection + error detection
        const onDataDisposable = proc.onData((data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal.incomingData', { projectId, data });
            }
            resetIdleTimer(projectId);
            checkErrorPatterns(projectId, data);
            checkAutoApprove(projectId, data);
            // Broadcast to remote WS clients
            broadcastOutput(projectId, data);

            // Output-based claudeReady detection:
            // When Claude CLI shows its prompt (❯) and we're NOT in an interview, mark ready
            if (!entry.claudeReady && entry.alive) {
                // Suppress detection for 1.1s after dispatch to prevent paste-echo false positives.
                // Echo appears within ~100ms. Enter is sent at 500-1000ms. 1100ms covers Enter + 100ms buffer.
                // (was 1500ms in v4.7.16, but combined with 20s grace period it caused up to 25s stuck)
                const dispatchAge = entry._lastDispatchTime ? Date.now() - entry._lastDispatchTime : Infinity;
                if (dispatchAge < 1100) {
                    // Too soon after dispatch — skip to avoid false positive from input echo
                } else {
                    const clean = stripAnsi(data);
                    const buf = autoApproveOutputBuffer.get(projectId) || '';
                    const hasInterviewPatterns = buf.includes('Type something') ||
                                                  buf.includes('Skip interview') ||
                                                  buf.includes('[ ]') ||
                                                  buf.includes('[✔]');
                    // Claude CLI prompt indicators
                    const hasReadyIndicator = clean.includes('❯') || clean.includes('How can I help') ||
                                               clean.includes('cwd:') || buf.includes('How can I help') ||
                                               clean.includes('Welcome back') || buf.includes('Welcome back') ||
                                               clean.includes('Tips for getting started') ||
                                               clean.includes('Claude Code v');
                    if (hasReadyIndicator && !hasInterviewPatterns) {
                        entry.claudeReady = true;
                        if (entry._readyFallback) {
                            clearTimeout(entry._readyFallback);
                            entry._readyFallback = null;
                        }
                        console.log(`[Main] Claude CLI ready (output-detected) for ${projectId}`);
                        taskQueue.process();
                    }
                }
            }
        });
        disposables.push(onDataDisposable);

        entry._spawnTime = Date.now();
        const onExitDisposable = proc.onExit(({ exitCode, signal }) => {
            console.log(`[Main] PTY exited for project ${projectId}: code=${exitCode}, signal=${signal}`);
            const wasManualKill = entry.manualKill;
            const uptime = Date.now() - (entry._spawnTime || 0);
            entry.alive = false;
            entry.process = null;

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal.exit', { projectId, exitCode, signal });
            }
            // Broadcast to remote WS clients
            broadcastEvent('terminal.exit', projectId, { exitCode, signal });

            // Auto-restart on abnormal exit (skip if uptime < 5s to prevent crash loops)
            if (exitCode !== 0 && !wasManualKill && autoRestartEnabled) {
                if (uptime < 5000) {
                    console.log(`[Main] PTY crashed too quickly (${uptime}ms) for ${projectId} — skipping auto-restart to prevent loop`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('autoRestart.maxRetriesReached', { projectId });
                    }
                } else {
                    attemptAutoRestart(projectId, entry.projectPath, entry.claudeArgs, cols, rows, entry.claudeModel);
                }
            }
        });
        disposables.push(onExitDisposable);

        ptyPool.set(projectId, entry);

        const defaultArgs = store.get('defaultClaudeArgs', '');
        const finalArgs = (claudeArgs || defaultArgs || '').trim();
        const modelFlag = claudeModel ? `--model ${claudeModel}` : '';
        const claudeCmd = `claude ${modelFlag} ${finalArgs}`.replace(/\s+/g, ' ').trim();

        entry.autoRunTimer = setTimeout(() => {
            entry.autoRunTimer = null;
            if (entry.alive && entry.process) {
                console.log(`[Main] Auto-executing for ${projectId}: ${claudeCmd}`);
                entry.process.write(claudeCmd + '\r');
                // claudeReady will be set by output-based detection (see below)
                // Fallback timer: if detection doesn't trigger within 10s, force ready
                entry._readyFallback = setTimeout(() => {
                    if (!entry.claudeReady && entry.alive) {
                        entry.claudeReady = true;
                        console.log(`[Main] Claude CLI ready (fallback timer) for ${projectId}`);
                        taskQueue.process();
                    }
                }, 10000);
            }
        }, 600);

        console.log(`[Main] PTY spawned for project ${projectId}, PID: ${pid}`);
        return { success: true, pid, alreadyRunning: false };

    } catch (error) {
        console.error('[Main] PTY spawn failed:', error);
        return { success: false, error: error.message };
    }
}

ipcMain.handle('terminal.spawn', (event, { projectId, projectPath, claudeArgs, claudeModel, cols, rows }) => {
    return spawnPtyForProject(projectId, projectPath, claudeArgs, cols, rows, claudeModel);
});

// ===================================================================
//  Auto-Restart Logic
// ===================================================================

function attemptAutoRestart(projectId, projectPath, claudeArgs, cols, rows, claudeModel) {
    // Rate-limit check
    const retryInfo = autoRestartRetryCount.get(projectId);
    if (retryInfo) {
        if (Date.now() - retryInfo.firstTime > autoRestartRateWindow) {
            // Window expired, reset
            autoRestartRetryCount.set(projectId, { count: 1, firstTime: Date.now() });
        } else if (retryInfo.count >= autoRestartMaxRetries) {
            console.log(`[Main] Auto-restart max retries reached for ${projectId}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('autoRestart.maxRetriesReached', { projectId });
            }
            return;
        } else {
            retryInfo.count++;
        }
    } else {
        autoRestartRetryCount.set(projectId, { count: 1, firstTime: Date.now() });
    }

    console.log(`[Main] Auto-restarting PTY for project ${projectId} in 2s...`);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('autoRestart.restarting', { projectId });
    }

    setTimeout(() => {
        // Double-check: hasn't been manually restarted in the meantime
        const current = ptyPool.get(projectId);
        if (current && current.alive) {
            console.log(`[Main] Auto-restart skipped — PTY already alive for ${projectId}`);
            return;
        }

        const result = spawnPtyForProject(projectId, projectPath, claudeArgs, cols, rows, claudeModel);

        if (result.success) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('autoRestart.spawned', { projectId, pid: result.pid });
            }

            // Optionally resend last prompt
            if (autoRestartResendPrompt) {
                const lastPrompts = store.get('lastPromptPerProject', {});
                const lastPrompt = lastPrompts[projectId];
                if (lastPrompt) {
                    setTimeout(() => {
                        const entry = ptyPool.get(projectId);
                        if (entry && entry.alive && entry.process) {
                            writeToPty(entry, lastPrompt);
                            console.log(`[Main] Auto-restart resent prompt for ${projectId}: ${lastPrompt.substring(0, 60)}`);
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('autoRestart.promptResent', { projectId, prompt: lastPrompt });
                            }
                        }
                    }, 3000); // Wait 3s for claude CLI to start
                }
            }
        } else {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('autoRestart.failed', { projectId, error: result.error });
            }
        }
    }, 2000); // 2s delay before restart
}

// ===================================================================
//  Health Check System — Daily automated validation for all projects
// ===================================================================

const defaultHealthChecks = [
    {
        id: 'code-review',
        name: 'Code Review',
        description: 'Comprehensive code quality analysis',
        prompt: 'Review the entire codebase for code quality issues, anti-patterns, unused variables, dead code, and potential bugs. Provide a summary with severity levels (critical/warning/info) and file locations.',
        enabled: true
    },
    {
        id: 'build-check',
        name: 'Build & Compile',
        description: 'Verify the project builds without errors',
        prompt: 'Check if this project can build/compile successfully. Run the appropriate build command (npm run build, tsc, etc.) and report any build errors or warnings with file paths and line numbers.',
        enabled: true
    },
    {
        id: 'test-run',
        name: 'Test Execution',
        description: 'Run all tests and report results',
        prompt: 'Run all tests in this project (npm test, jest, pytest, etc.) and report the results. List any failing tests with their error messages and file locations.',
        enabled: true
    },
    {
        id: 'error-scan',
        name: 'Error Pattern Scan',
        description: 'Scan for common error patterns and runtime issues',
        prompt: 'Scan the codebase for common error patterns: unhandled promises, memory leaks, race conditions, null/undefined access, improper error handling, and missing try-catch blocks. Report findings with file paths.',
        enabled: true
    },
    {
        id: 'security-audit',
        name: 'Security Audit',
        description: 'Check for vulnerabilities and security issues',
        prompt: 'Perform a security audit: check for XSS, SQL injection, command injection, exposed secrets/API keys, insecure dependencies, CSRF vulnerabilities, and insecure configurations. Report all findings with severity.',
        enabled: true
    },
    {
        id: 'dep-audit',
        name: 'Dependency Audit',
        description: 'Check for outdated or vulnerable dependencies',
        prompt: 'Audit all dependencies: run npm audit (or equivalent), check for outdated packages, identify deprecated dependencies, and find packages with known vulnerabilities. Suggest updates.',
        enabled: false
    },
    {
        id: 'type-check',
        name: 'Type Safety',
        description: 'TypeScript/type checking validation',
        prompt: 'Run TypeScript type checking (tsc --noEmit) or equivalent type validation. Report all type errors, missing type definitions, and any usage. List errors with file paths and line numbers.',
        enabled: false
    }
];

// Health Check State
let healthCheckTimer = null;
let healthCheckRunning = false;
let healthCheckQueue = [];     // [{ projectId, projectName, checkId, checkName, prompt }]
let healthCheckCurrentIdx = -1;
let healthCheckResults = [];   // [{ projectId, projectName, checkId, checkName, status, timestamp, errorsFound, duration }]
let healthCheckRunId = null;
let healthCheckStepStartTime = 0;
let healthCheckErrorsInStep = 0;  // count errors detected during current step
let healthCheckStepTimeoutTimer = null; // timeout timer per step
let healthCheckIdleTimer = null;        // dedicated idle timer for health check (longer than normal)

// Track errors specifically during health check
let healthCheckCaptureErrors = false;

function getHealthCheckSettings() {
    return {
        enabled: store.get('healthCheckEnabled', false),
        intervalHours: store.get('healthCheckIntervalHours', 24),
        autoFixOnError: store.get('healthCheckAutoFix', true),
        checks: store.get('healthCheckChecks', defaultHealthChecks),
        lastRun: store.get('healthCheckLastRun', null),
        projectScope: store.get('healthCheckProjectScope', 'all') // 'all' or 'selected'
    };
}

function startHealthCheckScheduler() {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }

    const settings = getHealthCheckSettings();
    if (!settings.enabled) return;

    const intervalMs = settings.intervalHours * 60 * 60 * 1000;

    // Check if we should run immediately (missed run)
    if (settings.lastRun) {
        const elapsed = Date.now() - new Date(settings.lastRun).getTime();
        if (elapsed >= intervalMs) {
            console.log('[Main] Health check overdue, running now...');
            setTimeout(async () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try {
                        const batchRunning = await mainWindow.webContents.executeJavaScript('typeof batchRunning !== "undefined" && batchRunning');
                        if (batchRunning) {
                            console.log('[Main] Overdue health check skipped: batch is running');
                            return;
                        }
                    } catch (_) {}
                }
                runHealthCheck();
            }, 5000);
        }
    }

    healthCheckTimer = setInterval(async () => {
        console.log('[Main] Scheduled health check triggered');
        // Check if renderer has a batch running before starting
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                const batchRunning = await mainWindow.webContents.executeJavaScript('typeof batchRunning !== "undefined" && batchRunning');
                if (batchRunning) {
                    console.log('[Main] Scheduled health check skipped: batch is running');
                    return;
                }
            } catch (_) {}
        }
        runHealthCheck();
    }, intervalMs);

    console.log(`[Main] Health check scheduler started: every ${settings.intervalHours}h`);
}

function runHealthCheck(specificProjectId) {
    if (healthCheckRunning) {
        console.log('[Main] Health check already running');
        return { success: false, error: 'Already running' };
    }

    // Notify renderer to check batch status is done via IPC sync check
    // (Batch runs in renderer so main process can't check directly;
    //  the renderer-side guard handles this for manual triggers)

    const projects = store.get('projects', []);
    if (projects.length === 0) {
        return { success: false, error: 'No projects' };
    }

    const settings = getHealthCheckSettings();
    const enabledChecks = settings.checks.filter(c => c.enabled);
    if (enabledChecks.length === 0) {
        return { success: false, error: 'No checks enabled' };
    }

    // Build queue: for each project × each enabled check
    healthCheckQueue = [];
    const targetProjects = specificProjectId
        ? projects.filter(p => p.id === specificProjectId)
        : projects;

    for (const project of targetProjects) {
        for (const check of enabledChecks) {
            healthCheckQueue.push({
                projectId: project.id,
                projectName: project.name,
                projectPath: project.path,
                claudeArgs: project.claudeArgs || '',
                checkId: check.id,
                checkName: check.name,
                prompt: check.prompt
            });
        }
    }

    healthCheckRunning = true;
    healthCheckCurrentIdx = -1;
    healthCheckResults = [];
    healthCheckRunId = Date.now().toString();

    console.log(`[Main] Health check started: ${healthCheckQueue.length} steps across ${targetProjects.length} project(s)`);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('healthCheck.started', {
            runId: healthCheckRunId,
            totalSteps: healthCheckQueue.length,
            projects: targetProjects.map(p => p.name)
        });
    }

    // Start first step
    processNextHealthCheckStep();
    return { success: true, totalSteps: healthCheckQueue.length };
}

function processNextHealthCheckStep() {
    if (!healthCheckRunning) return;

    healthCheckCurrentIdx++;

    if (healthCheckCurrentIdx >= healthCheckQueue.length) {
        finishHealthCheck();
        return;
    }

    const step = healthCheckQueue[healthCheckCurrentIdx];
    healthCheckStepStartTime = Date.now();
    healthCheckErrorsInStep = 0;

    console.log(`[Main] Health check step ${healthCheckCurrentIdx + 1}/${healthCheckQueue.length}: ${step.checkName} on ${step.projectName}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('healthCheck.stepStarted', {
            runId: healthCheckRunId,
            stepIndex: healthCheckCurrentIdx,
            totalSteps: healthCheckQueue.length,
            projectName: step.projectName,
            checkName: step.checkName
        });
    }

    // Ensure PTY is running for this project
    const entry = ptyPool.get(step.projectId);
    if (!entry || !entry.alive) {
        // Need to spawn PTY first
        const result = spawnPtyForProject(step.projectId, step.projectPath, step.claudeArgs, 120, 30);
        if (!result.success) {
            // Record as error and skip
            healthCheckResults.push({
                projectId: step.projectId,
                projectName: step.projectName,
                checkId: step.checkId,
                checkName: step.checkName,
                status: 'error',
                timestamp: Date.now(),
                errorsFound: 0,
                duration: 0,
                message: 'Failed to spawn PTY: ' + result.error
            });

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('healthCheck.stepCompleted', {
                    runId: healthCheckRunId,
                    stepIndex: healthCheckCurrentIdx,
                    status: 'error',
                    message: 'PTY spawn failed'
                });
            }

            // Move to next step after delay
            setTimeout(() => processNextHealthCheckStep(), 1000);
            return;
        }

        // Wait for claude CLI to start (600ms auto-run + startup time), then send check
        setTimeout(() => sendHealthCheckPrompt(step), 8000);
    } else {
        // PTY already running, send check prompt
        sendHealthCheckPrompt(step);
    }
}

function sendHealthCheckPrompt(step) {
    const entry = ptyPool.get(step.projectId);
    if (!entry || !entry.alive || !entry.process) {
        healthCheckResults.push({
            projectId: step.projectId,
            projectName: step.projectName,
            checkId: step.checkId,
            checkName: step.checkName,
            status: 'error',
            timestamp: Date.now(),
            errorsFound: 0,
            duration: Date.now() - healthCheckStepStartTime,
            message: 'PTY not available'
        });
        setTimeout(() => processNextHealthCheckStep(), 1000);
        return;
    }

    // Enable error capture for this step
    healthCheckCaptureErrors = true;
    healthCheckErrorsInStep = 0;

    // Set step timeout (auto-skip if step takes too long)
    if (healthCheckStepTimeoutTimer) clearTimeout(healthCheckStepTimeoutTimer);
    healthCheckStepTimeoutTimer = setTimeout(() => {
        healthCheckStepTimeoutTimer = null;
        if (!healthCheckRunning) return; // Health check was stopped before timeout fired
        console.log(`[Main] Health check step timed out: ${step.checkName} on ${step.projectName}`);

        healthCheckCaptureErrors = false;
        if (healthCheckIdleTimer) { clearTimeout(healthCheckIdleTimer); healthCheckIdleTimer = null; }

        healthCheckResults.push({
            projectId: step.projectId,
            projectName: step.projectName,
            checkId: step.checkId,
            checkName: step.checkName,
            status: 'error',
            timestamp: Date.now(),
            errorsFound: healthCheckErrorsInStep,
            duration: Date.now() - healthCheckStepStartTime,
            message: 'Step timed out after ' + Math.round(HEALTH_CHECK_STEP_TIMEOUT / 1000) + 's'
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('healthCheck.stepCompleted', {
                runId: healthCheckRunId,
                stepIndex: healthCheckCurrentIdx,
                totalSteps: healthCheckQueue.length,
                projectName: step.projectName,
                checkName: step.checkName,
                status: 'error',
                errorsFound: healthCheckErrorsInStep,
                duration: Date.now() - healthCheckStepStartTime
            });
        }

        setTimeout(() => processNextHealthCheckStep(), 2000);
    }, HEALTH_CHECK_STEP_TIMEOUT);

    // Send the check prompt via bracketed paste to avoid TUI character duplication
    writeToPty(entry, step.prompt);
}

// Called when terminal goes idle during health check
function onHealthCheckIdle(projectId) {
    if (!healthCheckRunning) return;
    if (healthCheckCurrentIdx < 0 || healthCheckCurrentIdx >= healthCheckQueue.length) return;

    const step = healthCheckQueue[healthCheckCurrentIdx];
    if (step.projectId !== projectId) return;

    // Clear step timeout since step completed normally
    if (healthCheckStepTimeoutTimer) { clearTimeout(healthCheckStepTimeoutTimer); healthCheckStepTimeoutTimer = null; }
    if (healthCheckIdleTimer) { clearTimeout(healthCheckIdleTimer); healthCheckIdleTimer = null; }

    // Step completed
    healthCheckCaptureErrors = false;
    const duration = Date.now() - healthCheckStepStartTime;
    const status = healthCheckErrorsInStep > 0 ? 'fail' : 'pass';

    healthCheckResults.push({
        projectId: step.projectId,
        projectName: step.projectName,
        checkId: step.checkId,
        checkName: step.checkName,
        status: status,
        timestamp: Date.now(),
        errorsFound: healthCheckErrorsInStep,
        duration: duration,
        message: status === 'pass' ? 'No issues found' : `${healthCheckErrorsInStep} issue(s) detected`
    });

    console.log(`[Main] Health check step done: ${step.checkName} on ${step.projectName} = ${status} (${healthCheckErrorsInStep} errors, ${Math.round(duration / 1000)}s)`);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('healthCheck.stepCompleted', {
            runId: healthCheckRunId,
            stepIndex: healthCheckCurrentIdx,
            totalSteps: healthCheckQueue.length,
            projectName: step.projectName,
            checkName: step.checkName,
            status: status,
            errorsFound: healthCheckErrorsInStep,
            duration: duration
        });
    }

    // Move to next step after a short delay
    setTimeout(() => processNextHealthCheckStep(), 2000);
}

function finishHealthCheck() {
    healthCheckRunning = false;
    healthCheckCaptureErrors = false;
    if (healthCheckStepTimeoutTimer) { clearTimeout(healthCheckStepTimeoutTimer); healthCheckStepTimeoutTimer = null; }
    if (healthCheckIdleTimer) { clearTimeout(healthCheckIdleTimer); healthCheckIdleTimer = null; }

    // Clear stale auto-fix entries queued during health check to avoid obsolete fix prompts
    for (const step of healthCheckQueue) {
        pendingAutoFix.delete(step.projectId);
    }

    const totalErrors = healthCheckResults.reduce((sum, r) => sum + r.errorsFound, 0);
    const passed = healthCheckResults.filter(r => r.status === 'pass').length;
    const failed = healthCheckResults.filter(r => r.status === 'fail').length;
    const errors = healthCheckResults.filter(r => r.status === 'error').length;

    // Save results
    const history = store.get('healthCheckHistory', []);
    const runSummary = {
        runId: healthCheckRunId,
        timestamp: Date.now(),
        results: healthCheckResults,
        summary: { total: healthCheckResults.length, passed, failed, errors, totalErrors }
    };
    history.unshift(runSummary);
    if (history.length > 30) history.length = 30; // Keep last 30 runs
    store.set('healthCheckHistory', history);
    store.set('healthCheckLastRun', new Date().toISOString());

    console.log(`[Main] Health check completed: ${passed} passed, ${failed} failed, ${errors} errors, ${totalErrors} total issues`);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('healthCheck.completed', {
            runId: healthCheckRunId,
            summary: runSummary.summary,
            results: healthCheckResults
        });
    }
}

function stopHealthCheck() {
    if (!healthCheckRunning) return;
    healthCheckRunning = false;
    healthCheckCaptureErrors = false;
    if (healthCheckStepTimeoutTimer) { clearTimeout(healthCheckStepTimeoutTimer); healthCheckStepTimeoutTimer = null; }
    if (healthCheckIdleTimer) { clearTimeout(healthCheckIdleTimer); healthCheckIdleTimer = null; }

    // Clear stale auto-fix entries queued during health check
    for (const step of healthCheckQueue) {
        pendingAutoFix.delete(step.projectId);
    }

    console.log('[Main] Health check stopped manually');

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('healthCheck.stopped', { runId: healthCheckRunId });
    }
}

// onIdleForHealthCheck is no longer needed — health check uses its own dedicated timer
// (see resetIdleTimer's HEALTH_CHECK_IDLE_TIMEOUT branch)

// Hook into error detection for health check counting
function onErrorForHealthCheck() {
    if (healthCheckCaptureErrors) {
        healthCheckErrorsInStep++;
    }
}

// ===================================================================
//  Health Check IPC Handlers
// ===================================================================

ipcMain.handle('healthCheck.getSettings', () => {
    return getHealthCheckSettings();
});

ipcMain.handle('healthCheck.setSettings', (event, settings) => {
    if (settings.enabled !== undefined) store.set('healthCheckEnabled', settings.enabled);
    if (settings.intervalHours !== undefined) store.set('healthCheckIntervalHours', settings.intervalHours);
    if (settings.autoFixOnError !== undefined) store.set('healthCheckAutoFix', settings.autoFixOnError);
    if (settings.checks !== undefined) store.set('healthCheckChecks', settings.checks);
    if (settings.projectScope !== undefined) store.set('healthCheckProjectScope', settings.projectScope);

    // Restart scheduler
    startHealthCheckScheduler();
    return { success: true };
});

ipcMain.handle('healthCheck.run', (event, { projectId } = {}) => {
    return runHealthCheck(projectId);
});

ipcMain.handle('healthCheck.stop', () => {
    stopHealthCheck();
    return { success: true };
});

ipcMain.handle('healthCheck.getHistory', () => {
    return store.get('healthCheckHistory', []);
});

ipcMain.handle('healthCheck.clearHistory', () => {
    store.set('healthCheckHistory', []);
    return { success: true };
});

ipcMain.handle('healthCheck.getChecks', () => {
    return store.get('healthCheckChecks', defaultHealthChecks);
});

ipcMain.handle('healthCheck.setChecks', (event, checks) => {
    store.set('healthCheckChecks', checks);
    return { success: true };
});

ipcMain.handle('healthCheck.isRunning', () => {
    return {
        running: healthCheckRunning,
        currentStep: healthCheckCurrentIdx,
        totalSteps: healthCheckQueue.length,
        currentCheck: healthCheckCurrentIdx >= 0 && healthCheckCurrentIdx < healthCheckQueue.length
            ? healthCheckQueue[healthCheckCurrentIdx]
            : null
    };
});

// ===================================================================
//  IPC: terminal.keystroke
// ===================================================================

ipcMain.on('terminal.keystroke', (event, { projectId, data }) => {
    const entry = ptyPool.get(projectId);
    if (entry && entry.alive && entry.process) {
        entry.process.write(data);
    }
});

// ===================================================================
//  IPC: terminal.resize
// ===================================================================

ipcMain.on('terminal.resize', (event, { projectId, cols, rows }) => {
    const entry = ptyPool.get(projectId);
    if (entry && entry.alive && entry.process) {
        try {
            entry.process.resize(cols, rows);
        } catch (e) {}
    }
});

// ===================================================================
//  IPC: terminal.kill / terminal.killAll
// ===================================================================

ipcMain.handle('terminal.kill', (event, projectId) => {
    destroyPty(projectId);
    return { success: true };
});

ipcMain.handle('terminal.killAll', () => {
    destroyAllPty();
    return { success: true };
});

// ===================================================================
//  IPC: terminal.interrupt — send Ctrl+C to stop running task gracefully
// ===================================================================

ipcMain.handle('terminal.interrupt', (event, projectId) => {
    const entry = ptyPool.get(projectId);
    if (!entry || !entry.alive || !entry.process) {
        return { success: false, error: 'PTY not running' };
    }

    // Interrupt running task in queue
    const interruptedText = taskQueue.interrupt(projectId);

    // Send Escape first (exits any sub-prompt), then Ctrl+C to interrupt
    try {
        entry.process.write('\x1b');  // Escape
        setTimeout(() => {
            try {
                entry.process.write('\x03');  // Ctrl+C
            } catch (e) {
                console.error('[Interrupt] Ctrl+C failed:', e.message);
            }
        }, 100);
    } catch (e) {
        console.error('[Interrupt] Escape failed:', e.message);
    }

    // Reset claudeReady — will be re-detected when Claude CLI shows prompt again
    entry.claudeReady = false;

    console.log(`[Interrupt] Sent Ctrl+C to project ${projectId}, interrupted task: ${interruptedText ? interruptedText.substring(0, 60) : 'none'}`);
    return { success: true, interruptedText };
});

// ===================================================================
//  IPC: automation.sendPrompt — send text to a project's PTY
// ===================================================================

ipcMain.handle('automation.sendPrompt', (event, { projectId, text }) => {
    const entry = ptyPool.get(projectId);
    if (!entry || !entry.alive || !entry.process) {
        return { success: false, error: 'PTY not running' };
    }
    writeToPty(entry, text);
    return { success: true };
});

// ===================================================================
//  IPC: terminal.sendToAll — send command to ALL alive PTYs
// ===================================================================

ipcMain.handle('terminal.sendToAll', (event, { text }) => {
    let sent = 0;
    for (const [projectId, entry] of ptyPool) {
        if (entry.alive && entry.process) {
            writeToPty(entry, text);
            sent++;
        }
    }
    return { success: true, sent };
});

// ===================================================================
//  Settings
// ===================================================================

ipcMain.handle('save-settings', (event, settings) => {
    if (settings.defaultClaudeArgs !== undefined) store.set('defaultClaudeArgs', settings.defaultClaudeArgs);
    if (settings.shellPath !== undefined)         store.set('shellPath', settings.shellPath);
    if (settings.fontSize !== undefined)           store.set('fontSize', settings.fontSize);
    if (settings.computerUseModel !== undefined)   store.set('computerUseModel', settings.computerUseModel);
    return { success: true };
});

ipcMain.handle('get-settings', () => ({
    defaultClaudeArgs: store.get('defaultClaudeArgs', ''),
    shellPath: store.get('shellPath', ''),
    fontSize: store.get('fontSize', 14),
    computerUseModel: store.get('computerUseModel', 'gemini-2.5-computer-use-preview-10-2025')
}));

// ===================================================================
//  Computer Control IPC Handlers
// ===================================================================

ipcMain.handle('computerControl.create', (event, { id }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'No window' };
    if (computerControls.has(id)) {
        safelog(`[CC] Reusing existing instance: ${id}`);
        return { success: true };
    }
    safelog(`[CC] Creating new instance: ${id}`);

    const cc = new ComputerControl(mainWindow);
    cc.onUpdate = (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('computerControl.updated', { id, ...state });
        }
    };
    cc.onScreenshot = (base64, width, height) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('computerControl.screenshot', { id, base64, width, height });
        }
    };
    cc.onActionLog = (entry) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('computerControl.actionLog', { id, ...entry });
        }
    };
    cc.onError = (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('computerControl.error', { id, message });
        }
    };

    cc.createBrowserView();
    computerControls.set(id, cc);
    return { success: true };
});

ipcMain.handle('computerControl.destroy', (event, { id }) => {
    const cc = computerControls.get(id);
    if (cc) {
        cc.stop();
        cc.destroyBrowserView();
        computerControls.delete(id);
    }
    return { success: true };
});

ipcMain.handle('computerControl.navigate', (event, { id, url }) => {
    const cc = computerControls.get(id);
    if (!cc) return { success: false, error: 'No instance' };
    cc.navigate(url);
    return { success: true };
});

ipcMain.handle('computerControl.setBounds', (event, { id, bounds }) => {
    const cc = computerControls.get(id);
    if (!cc) return { success: false, error: 'No instance' };
    cc.setBounds(bounds);
    return { success: true };
});

ipcMain.handle('computerControl.startTask', async (event, { id, task, startUrl }) => {
    const cc = computerControls.get(id);
    if (!cc) return { success: false, error: 'No instance' };
    const apiKey = store.get('geminiApiKey', '');
    if (!apiKey) return { success: false, error: 'Gemini API key not set. Configure in Settings.' };
    const model = store.get('computerUseModel', 'gemini-2.5-computer-use-preview-10-2025');
    // Run asynchronously — don't await (loop runs in background)
    cc.startTask(task, startUrl, apiKey, model);
    return { success: true };
});

ipcMain.handle('computerControl.stop', (event, { id }) => {
    const cc = computerControls.get(id);
    if (cc) cc.stop();
    return { success: true };
});

ipcMain.handle('computerControl.getState', (event, { id }) => {
    const cc = computerControls.get(id);
    if (!cc) return { state: 'idle', loopCount: 0, maxLoops: 30, currentUrl: '' };
    return cc.getState();
});

ipcMain.handle('computerControl.autoVerify', async (event, { id, projectId }) => {
    // Ensure CC instance exists
    if (!computerControls.has(id) && mainWindow && !mainWindow.isDestroyed()) {
        const cc = new ComputerControl(mainWindow);
        cc.onUpdate = (state) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('computerControl.updated', { id, ...state });
            }
        };
        cc.onScreenshot = (base64, width, height) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('computerControl.screenshot', { id, base64, width, height });
            }
        };
        cc.onActionLog = (entry) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('computerControl.actionLog', { id, ...entry });
            }
        };
        cc.onError = (message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('computerControl.error', { id, message });
            }
        };
        computerControls.set(id, cc);
        cc.createBrowserView();
    }

    const cc = computerControls.get(id);
    if (!cc) return { success: false, error: 'No instance' };

    // Find project path
    const projects = store.get('projects', []);
    const project = projects.find(p => p.id === projectId);
    if (!project) return { success: false, error: 'Project not found' };

    const apiKey = store.get('geminiApiKey', '');
    if (!apiKey) return { success: false, error: 'Gemini API key not set. Configure in Settings.' };
    const model = store.get('computerUseModel', 'gemini-2.5-computer-use-preview-10-2025');

    // Set up verify complete callback
    cc.onVerifyComplete = (summary) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('computerControl.verifyResult', { id, summary });
        }
    };

    // Run autoVerify (non-blocking — startTask runs in background)
    const result = await cc.autoVerify(project.path, apiKey, model);
    return result;
});

// ===================================================================
//  Project Management
// ===================================================================

ipcMain.handle('add-project', async (event, projectData) => {
    try {
        const projects = store.get('projects', []);
        let gitInfo = { hasGit: false, remote: null, branch: null };
        try {
            if (fs.existsSync(path.join(projectData.path, '.git'))) {
                gitInfo.hasGit = true;
                try { gitInfo.remote = execSync('git remote get-url origin', { cwd: projectData.path, encoding: 'utf-8' }).trim(); } catch (_) {}
                try { gitInfo.branch = execSync('git branch --show-current', { cwd: projectData.path, encoding: 'utf-8' }).trim() || 'main'; } catch (_) { gitInfo.branch = 'main'; }
            }
        } catch (_) {}

        const newProject = {
            id: Date.now().toString(),
            name: projectData.name,
            path: projectData.path,
            description: projectData.description,
            claudeArgs: projectData.claudeArgs || '',
            ...gitInfo,
            createdAt: new Date().toISOString()
        };
        projects.push(newProject);
        store.set('projects', projects);
        return { success: true, project: newProject };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-projects', () => store.get('projects', []));

ipcMain.handle('update-project', (event, { projectId, updates }) => {
    const projects = store.get('projects', []);
    const idx = projects.findIndex(p => p.id === projectId);
    if (idx === -1) return { success: false, error: 'Project not found' };
    const allowed = ['name', 'description', 'claudeArgs'];
    for (const key of allowed) {
        if (updates[key] !== undefined) projects[idx][key] = updates[key];
    }
    store.set('projects', projects);
    return { success: true, project: projects[idx] };
});

ipcMain.handle('delete-project', (event, projectId) => {
    destroyPty(projectId);
    const projects = store.get('projects', []);
    store.set('projects', projects.filter(p => p.id !== projectId));

    // Clean up session data for deleted project
    const lastPrompts = store.get('lastPromptPerProject', {});
    delete lastPrompts[projectId];
    store.set('lastPromptPerProject', lastPrompts);

    return { success: true };
});

// ===================================================================
//  Project Duplicate — copy project folder to new location
// ===================================================================

ipcMain.handle('duplicate-project', async (event, { sourceProjectId, destPath }) => {
    try {
        const projects = store.get('projects', []);
        const source = projects.find(p => p.id === sourceProjectId);
        if (!source) return { success: false, error: 'Source project not found' };

        const sourcePath = source.path;
        if (!fs.existsSync(sourcePath)) return { success: false, error: 'Source folder does not exist' };
        if (fs.existsSync(destPath)) return { success: false, error: 'Destination folder already exists' };

        // Notify renderer: copy started
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('duplicate.progress', { status: 'copying' });
        }

        // Copy directory recursively, skipping node_modules / .git / heavy cache dirs
        const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.turbo', '.output']);

        function copyDirSync(src, dest) {
            fs.mkdirSync(dest, { recursive: true });
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (const entry of entries) {
                const srcChild = path.join(src, entry.name);
                const destChild = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) continue;
                    copyDirSync(srcChild, destChild);
                } else {
                    fs.copyFileSync(srcChild, destChild);
                }
            }
        }

        copyDirSync(sourcePath, destPath);

        // Register as new project
        let gitInfo = { hasGit: false, remote: null, branch: null };
        // .git was skipped, so init a fresh one if original had git
        if (source.hasGit) {
            try {
                execSync('git init', { cwd: destPath, encoding: 'utf-8' });
                gitInfo.hasGit = true;
                gitInfo.branch = 'main';
            } catch (_) {}
        }

        const folderName = path.basename(destPath);
        const newProject = {
            id: Date.now().toString(),
            name: folderName,
            path: destPath,
            description: source.description || '',
            claudeArgs: source.claudeArgs || '',
            ...gitInfo,
            createdAt: new Date().toISOString()
        };
        projects.push(newProject);
        store.set('projects', projects);

        return { success: true, project: newProject };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ===================================================================
//  Folder Picker
// ===================================================================

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
    return null;
});

// ===================================================================
//  Image File Picker
// ===================================================================

ipcMain.handle('select-image-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Media Files', extensions: [
                'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
                'mp4', 'mov', 'avi', 'mkv', 'webm',
                'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
                'pdf', 'csv', 'txt', 'json', 'xml'
            ]},
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    if (!result.canceled && result.filePaths.length > 0) return result.filePaths;
    return null;
});

// ===================================================================
//  Clipboard Image → Temp File
// ===================================================================

ipcMain.handle('save-clipboard-image', async (event, dataURL) => {
    try {
        const matches = dataURL.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return null;

        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const tmpPath = path.join(os.tmpdir(), `claude-paste-${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, buffer);
        tempImageFiles.push(tmpPath);
        return tmpPath;
    } catch (err) {
        console.error('[Main] save-clipboard-image error:', err);
        return null;
    }
});

// ===================================================================
//  Media File Upload to Gemini File API
// ===================================================================

const MEDIA_MIME_TYPES = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MEDIA_MIME_TYPES[ext] || null;
}

ipcMain.handle('ai.uploadMediaFile', async (event, { filePath }) => {
    try {
        const geminiApiKey = store.get('geminiApiKey', '');
        if (!geminiApiKey) {
            return { success: false, error: 'Gemini API Key가 설정되지 않았습니다.' };
        }

        const mimeType = getMimeType(filePath);
        if (!mimeType) {
            return { success: false, error: `지원하지 않는 파일 형식: ${path.extname(filePath)}` };
        }

        // Check file exists and size
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `파일을 찾을 수 없습니다: ${filePath}` };
        }
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024 * 1024) {
            return { success: false, error: '파일 크기가 2GB를 초과합니다.' };
        }

        console.log(`[MediaUpload] Uploading ${filePath} (${mimeType}, ${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

        // Notify renderer about upload start
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai.mediaUploadProgress', {
                filePath,
                status: 'uploading',
                message: `파일 업로드 중... (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
            });
        }

        const { GoogleAIFileManager } = require('@google/generative-ai/server');
        const fileManager = new GoogleAIFileManager(geminiApiKey);

        const uploadResult = await fileManager.uploadFile(filePath, {
            mimeType,
            displayName: path.basename(filePath),
        });

        console.log(`[MediaUpload] Upload complete: ${uploadResult.file.name}, state: ${uploadResult.file.state}`);

        // Poll for ACTIVE state (video processing can take time)
        let file = uploadResult.file;
        const isVideo = mimeType.startsWith('video/');
        if (isVideo && file.state === 'PROCESSING') {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.mediaUploadProgress', {
                    filePath,
                    status: 'processing',
                    message: '동영상 처리 중... (최대 2분 소요)',
                });
            }

            const MAX_POLL = 60; // max 60 polls * 2s = 120s
            for (let i = 0; i < MAX_POLL; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const result = await fileManager.getFile(file.name);
                file = result;
                console.log(`[MediaUpload] Poll ${i + 1}: state=${file.state}`);

                if (file.state === 'ACTIVE') break;
                if (file.state === 'FAILED') {
                    return { success: false, error: '동영상 처리 실패 (Gemini File API)' };
                }
            }

            if (file.state !== 'ACTIVE') {
                return { success: false, error: '동영상 처리 타임아웃 (2분 초과)' };
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai.mediaUploadProgress', {
                filePath,
                status: 'complete',
                message: '업로드 완료!',
            });
        }

        console.log(`[MediaUpload] Ready: uri=${file.uri}, mimeType=${mimeType}`);
        return {
            success: true,
            fileUri: file.uri,
            mimeType,
            fileName: path.basename(filePath),
        };
    } catch (err) {
        console.error('[MediaUpload] Error:', err.message || err);
        return { success: false, error: `업로드 실패: ${err.message}` };
    }
});

// ===================================================================
//  Templates CRUD (electron-store)
// ===================================================================

ipcMain.handle('templates.get', () => {
    return store.get('templates', []);
});

ipcMain.handle('templates.save', (event, template) => {
    const templates = store.get('templates', []);
    const idx = templates.findIndex(t => t.id === template.id);
    if (idx >= 0) {
        templates[idx] = template;
    } else {
        template.id = Date.now().toString();
        templates.push(template);
    }
    store.set('templates', templates);
    return { success: true, template };
});

ipcMain.handle('templates.delete', (event, templateId) => {
    const templates = store.get('templates', []);
    store.set('templates', templates.filter(t => t.id !== templateId));
    return { success: true };
});

// ===================================================================
//  Schedules CRUD (electron-store + timers)
// ===================================================================

function clearAllSchedules() {
    for (const [id, intervalId] of activeSchedules) {
        clearInterval(intervalId);
    }
    activeSchedules.clear();
}

function startSchedule(schedule) {
    if (activeSchedules.has(schedule.id)) {
        clearInterval(activeSchedules.get(schedule.id));
    }

    if (!schedule.enabled) return;

    const intervalMs = (schedule.intervalMinutes || 60) * 60 * 1000;

    const intervalId = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        // Execute: send template text to project PTY via bracketed paste
        const entry = ptyPool.get(schedule.projectId);
        if (entry && entry.alive && entry.process) {
            writeToPty(entry, schedule.command);
            mainWindow.webContents.send('schedule.executed', {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                projectId: schedule.projectId,
                timestamp: Date.now()
            });
        }
    }, intervalMs);

    activeSchedules.set(schedule.id, intervalId);
}

function loadAndStartSchedules() {
    const schedules = store.get('schedules', []);
    for (const s of schedules) {
        if (s.enabled) startSchedule(s);
    }
}

ipcMain.handle('schedules.get', () => {
    return store.get('schedules', []);
});

ipcMain.handle('schedules.save', (event, schedule) => {
    const schedules = store.get('schedules', []);
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx >= 0) {
        schedules[idx] = schedule;
    } else {
        schedule.id = Date.now().toString();
        schedules.push(schedule);
    }
    store.set('schedules', schedules);

    // Restart schedule timer
    if (schedule.enabled) {
        startSchedule(schedule);
    } else if (activeSchedules.has(schedule.id)) {
        clearInterval(activeSchedules.get(schedule.id));
        activeSchedules.delete(schedule.id);
    }

    return { success: true, schedule };
});

ipcMain.handle('schedules.delete', (event, scheduleId) => {
    const schedules = store.get('schedules', []);
    store.set('schedules', schedules.filter(s => s.id !== scheduleId));
    if (activeSchedules.has(scheduleId)) {
        clearInterval(activeSchedules.get(scheduleId));
        activeSchedules.delete(scheduleId);
    }
    return { success: true };
});

// ===================================================================
//  Error Detection Settings
// ===================================================================

ipcMain.handle('errorDetection.getEnabled', () => {
    return store.get('errorDetectionEnabled', true);
});

ipcMain.handle('errorDetection.setEnabled', (event, enabled) => {
    errorDetectionEnabled = enabled;
    store.set('errorDetectionEnabled', enabled);
    return { success: true };
});

ipcMain.handle('errorDetection.getPatterns', () => {
    return store.get('errorPatterns', defaultErrorPatterns);
});

ipcMain.handle('errorDetection.setPatterns', (event, patterns) => {
    store.set('errorPatterns', patterns);
    return { success: true };
});

// ===================================================================
//  Auto-Fix Settings
// ===================================================================

ipcMain.handle('autoFix.getSettings', () => {
    return {
        enabled: store.get('autoFixEnabled', true),
        cooldown: store.get('autoFixCooldown', 15),
        template: store.get('autoFixTemplate', 'CRITICAL ERROR DETECTED: [{label}] {error}\n\nYou MUST:\n1. Analyze the root cause of this error — do NOT guess, read the actual code.\n2. Fix the error completely — not just the symptom but the underlying cause.\n3. Check for related errors in the same file and nearby files.\n4. After fixing, re-read the modified files to verify no new syntax/logic errors were introduced.\n5. If the fix requires changes to multiple files, fix ALL of them.\nDo NOT skip any step. Fix it properly.'),
        maxRetries: store.get('autoFixMaxRetries', 5)
    };
});

ipcMain.handle('autoFix.setSettings', (event, settings) => {
    if (settings.enabled !== undefined) {
        autoFixEnabled = settings.enabled;
        store.set('autoFixEnabled', settings.enabled);
    }
    if (settings.cooldown !== undefined) {
        autoFixCooldown = settings.cooldown;
        store.set('autoFixCooldown', settings.cooldown);
    }
    if (settings.template !== undefined) {
        autoFixTemplate = settings.template;
        store.set('autoFixTemplate', settings.template);
    }
    if (settings.maxRetries !== undefined) {
        store.set('autoFixMaxRetries', settings.maxRetries);
    }
    return { success: true };
});

ipcMain.handle('autoFix.setEnabled', (event, enabled) => {
    autoFixEnabled = enabled;
    store.set('autoFixEnabled', enabled);
    if (!enabled) {
        // Clear all pending fixes when disabled
        pendingAutoFix.clear();
    }
    return { success: true };
});

ipcMain.handle('autoFix.resetRetries', (event, projectId) => {
    autoFixRetryCount.delete(projectId);
    return { success: true };
});

// ===================================================================
//  Session Persistence
// ===================================================================

ipcMain.handle('session.savePromptHistory', (event, history) => {
    store.set('promptHistory', history);
    return { success: true };
});

ipcMain.handle('session.getPromptHistory', () => {
    return store.get('promptHistory', []);
});

ipcMain.handle('session.setLastSelectedProject', (event, projectId) => {
    store.set('lastSelectedProject', projectId);
    return { success: true };
});

ipcMain.handle('session.getLastSelectedProject', () => {
    return store.get('lastSelectedProject', null);
});

ipcMain.handle('session.saveLastPrompt', (event, { projectId, prompt }) => {
    const lastPrompts = store.get('lastPromptPerProject', {});
    lastPrompts[projectId] = prompt;
    store.set('lastPromptPerProject', lastPrompts);
    return { success: true };
});

ipcMain.handle('session.getLastPrompts', () => {
    return store.get('lastPromptPerProject', {});
});

ipcMain.handle('session.getActiveSessionProjects', () => {
    return store.get('activeSessionProjects', []);
});

// ===================================================================
//  Auto-Restart Settings
// ===================================================================

ipcMain.handle('autoRestart.getSettings', () => {
    return {
        enabled: store.get('autoRestartEnabled', true),
        resendPrompt: store.get('autoRestartResendPrompt', true),
        maxRetries: store.get('autoRestartMaxRetries', 3),
        rateWindow: store.get('autoRestartRateWindow', 5) // in minutes
    };
});

ipcMain.handle('autoRestart.setSettings', (event, settings) => {
    if (settings.enabled !== undefined) {
        autoRestartEnabled = settings.enabled;
        store.set('autoRestartEnabled', settings.enabled);
    }
    if (settings.resendPrompt !== undefined) {
        autoRestartResendPrompt = settings.resendPrompt;
        store.set('autoRestartResendPrompt', settings.resendPrompt);
    }
    if (settings.maxRetries !== undefined) {
        autoRestartMaxRetries = settings.maxRetries;
        store.set('autoRestartMaxRetries', settings.maxRetries);
    }
    if (settings.rateWindow !== undefined) {
        autoRestartRateWindow = settings.rateWindow * 60000; // convert minutes to ms
        store.set('autoRestartRateWindow', settings.rateWindow);
    }
    return { success: true };
});

ipcMain.handle('autoRestart.resetRetries', (event, projectId) => {
    if (projectId) {
        autoRestartRetryCount.delete(projectId);
    } else {
        autoRestartRetryCount.clear();
    }
    return { success: true };
});

// ===================================================================
//  Auto-Approve Settings
// ===================================================================

ipcMain.handle('autoApprove.getSettings', () => {
    return {
        enabled: store.get('autoApproveEnabled', true),
        mode: store.get('autoApproveMode', 'clear_context')
    };
});

ipcMain.handle('autoApprove.setSettings', (event, settings) => {
    if (settings.enabled !== undefined) {
        autoApproveEnabled = settings.enabled;
        store.set('autoApproveEnabled', settings.enabled);
    }
    if (settings.mode !== undefined) {
        autoApproveMode = settings.mode;
        store.set('autoApproveMode', settings.mode);
    }
    return { success: true };
});

// ===================================================================
//  Auto-Verify Settings
// ===================================================================

ipcMain.handle('autoVerify.getSettings', () => {
    return { enabled: store.get('autoVerifyEnabled', true) };
});

ipcMain.handle('autoVerify.setEnabled', (event, enabled) => {
    autoVerifyEnabled = enabled;
    store.set('autoVerifyEnabled', enabled);
    if (!enabled) pendingAutoVerify.clear();
    return { success: true };
});

// Queue a verification from renderer (after task completion)
ipcMain.on('autoVerify.queueTaskVerify', (event, { projectId }) => {
    if (!autoVerifyEnabled) return;
    pendingAutoVerify.set(projectId, {
        type: 'task',
        context: 'Post-task verification'
    });
    console.log(`[Main] Auto-verify queued for task completion on ${projectId}`);
});

// Renderer signals that the task queue is completely empty and idle.
// Only NOW is it safe to run auto-fix/verify without interrupting user work.
ipcMain.on('queue.allClear', (event, { projectId }) => {
    if (pendingAutoFix.has(projectId)) {
        processPendingAutoFix(projectId);
    } else {
        processPendingAutoVerify(projectId);
    }
});

// ===================================================================
//  IPC: Task Queue — delegated from renderer to main-process TaskQueue
// ===================================================================

ipcMain.handle('queue.enqueue', (event, { projectId, projectName, text }) => {
    const task = taskQueue.enqueue(projectId, projectName, text);
    return task;
});

ipcMain.handle('queue.getState', () => {
    return taskQueue.getState();
});

ipcMain.handle('queue.remove', (event, { taskId }) => {
    return taskQueue.remove(taskId);
});

ipcMain.handle('queue.pause', () => {
    taskQueue.pause();
    return { paused: true };
});

ipcMain.handle('queue.resume', () => {
    taskQueue.resume();
    return { paused: false };
});

ipcMain.handle('queue.clearDone', () => {
    taskQueue.clearDone();
    return { success: true };
});

ipcMain.handle('queue.clear', () => {
    taskQueue.clearAll();
    return { success: true };
});

ipcMain.handle('queue.kick', () => {
    taskQueue.process();
    return { success: true };
});

// ===================================================================
//  AI Chat — Dual AI (Claude + Gemini) debate/collab engine
// ===================================================================

const debateEngines = new Map(); // projectId -> DebateEngine

function getOrCreateEngine(projectId) {
    if (!debateEngines.has(projectId)) {
        debateEngines.set(projectId, new DebateEngine());
    }
    return debateEngines.get(projectId);
}

function makeDebateCallbacks(projectId, opts) {
    const { autoExecute, mode } = opts || {};

    return {
        onGeminiToken: (token) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.geminiToken', { projectId, token });
            }
        },
        onGeminiComplete: (text) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.geminiComplete', { projectId, text });
            }
        },
        onClaudeToken: (token) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.claudeToken', { projectId, token });
            }
        },
        onClaudeComplete: (text) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.claudeComplete', { projectId, text });
            }
        },
        onRoundStart: (round, maxRounds) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.roundStart', { projectId, round, maxRounds });
            }
        },
        onDebateComplete: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.debateComplete', { projectId });
            }

            // Auto-execute: collab/debate/review 완료 후 대화 결과를 터미널에서 실행
            if (autoExecute) {
                const engine = debateEngines.get(projectId);
                if (!engine) return;

                const history = engine.getHistory();
                const originalTask = engine.getTask();

                // AI 응답만 추출
                const aiResponses = history
                    .filter(m => m.role !== 'user')
                    .map(m => {
                        const label = m.role === 'gemini' ? 'Gemini(시니어 디자이너)' : 'Claude(시니어 풀스텍 개발자)';
                        return `[${label}]:\n${m.content}`;
                    })
                    .join('\n\n---\n\n');

                if (!aiResponses.trim()) return;

                const modeLabel = mode === 'debate' ? '토론' : mode === 'review' ? '리뷰' : '협업';
                const executionPrompt = `다음은 사용자의 요청에 대해 AI들이 ${modeLabel} 모드로 논의한 결과입니다.
이 대화에서 합의/제안된 코드를 실제 프로젝트에 적용하세요.

## 사용자 원본 요청
${originalTask}

## AI ${modeLabel} 결과
${aiResponses}

## 실행 지시사항
1. 위 대화에서 제안/합의된 코드 변경사항을 실제 파일에 적용하세요.
2. 파일 경로가 명시된 경우 해당 경로에 생성/수정하세요.
3. CSS/스타일, 로직, 구조 변경사항을 모두 반영하세요.
4. 구현 후 빌드/문법 에러가 없는지 확인하세요.
5. 명시되지 않은 세부사항은 best practice에 따라 구현하세요.`;

                const projects = store.get('projects', []);
                const project = projects.find(p => p.id === projectId);
                const projectName = project ? project.name : projectId;
                const projectPath = project ? project.path : null;

                // PTY가 없으면 자동으로 스폰
                const ptyEntry = ptyPool.get(projectId);
                if ((!ptyEntry || !ptyEntry.alive) && projectPath) {
                    console.log(`[AI] No PTY for ${projectId}, auto-spawning for execution...`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('ai.statusUpdate', { projectId, message: '🔧 터미널 자동 연결 중...' });
                    }
                    spawnPtyForProject(projectId, projectPath, [], 120, 30);
                }

                taskQueue.enqueue(projectId, projectName, executionPrompt);

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('ai.executionQueued', { projectId, mode: modeLabel });
                }

                console.log(`[AI] ${modeLabel} complete → execution queued for ${projectId}`);
            }
        },
        onError: (error, source) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.error', { projectId, message: error.message, source });
                // Clear stuck status bar on error
                mainWindow.webContents.send('ai.statusChange', { projectId, status: '' });
            }
        },
        onStatusChange: (status) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.statusChange', { projectId, status });
            }
        },
    };
}

ipcMain.handle('ai.start', async (event, { projectId, task, mode, aiMode, operationType, projectPath, projectName, attachedMediaFiles }) => {
    const engine = getOrCreateEngine(projectId);
    if (engine.isRunning) return { success: false, error: 'Already running' };

    const geminiApiKey = store.get('geminiApiKey', '');
    const maxRounds = store.get('aiMaxRounds', 1);
    const includeSource = store.get('aiIncludeSource', false); // 기본 false — 소스 포함 시 300KB→~100K 토큰 낭비

    // projectPath가 없으면 store에서 프로젝트 경로 자동 탐색
    let effectivePath = projectPath;
    let effectiveName = projectName || projectId;
    if (!effectivePath) {
        const projects = store.get('projects', []);
        const proj = projects.find(p => p.id === projectId);
        if (proj && proj.path) {
            effectivePath = proj.path;
            effectiveName = proj.name || projectId;
        }
    }

    let projectContext = null;
    const effectiveOp = operationType || 'development';
    if (effectivePath) {
        try {
            projectContext = buildProjectContext(effectivePath, effectiveName, effectiveOp, { includeSource });
            console.log(`[AI] Project context built: ${effectivePath} (${effectiveOp}, includeSource=${includeSource})`);
        } catch (e) {
            console.error('[AI] Failed to build project context:', e.message);
        }
    } else {
        console.warn('[AI] No project path found — AI will respond without project context');
    }

    const effectiveMode = mode || 'collab';
    const callbacks = makeDebateCallbacks(projectId, {
        autoExecute: true,
        mode: effectiveMode,
    });
    engine.start(task, callbacks, {
        mode: effectiveMode,
        aiMode: aiMode || 'dual',
        maxRounds,
        geminiApiKey,
        projectContext,
        projectPath: effectivePath,
        attachedMediaFiles: attachedMediaFiles || [],
    }).catch(err => {
        safelog('[AI] start error:', err.message);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai.error', { projectId, message: err.message, source: 'start' });
        }
    });

    return { success: true, sessionId: engine.sessionId };
});

ipcMain.handle('ai.continue', async (event, { projectId, message, mode, aiMode, operationType, projectPath, projectName, attachedMediaFiles }) => {
    const engine = getOrCreateEngine(projectId);

    // If engine is still marked running from previous round, force-reset
    if (engine.isRunning) {
        engine.stop();
    }

    // Reuse existing project context from engine (built at ai.start)
    // Only rebuild if operationType changed or context doesn't exist
    const includeSource = store.get('aiIncludeSource', false); // 기본 false — 토큰 절약
    let effectivePath = projectPath;
    let effectiveName = projectName || projectId;
    if (!effectivePath) {
        const projects = store.get('projects', []);
        const proj = projects.find(p => p.id === projectId);
        if (proj && proj.path) {
            effectivePath = proj.path;
            effectiveName = proj.name || projectId;
        }
    }

    const effectiveOp = operationType || engine.mode || 'development';
    let projectContext = engine.projectContext; // reuse cached
    if (!projectContext && effectivePath) {
        // Only build if not cached yet
        try {
            projectContext = buildProjectContext(effectivePath, effectiveName, effectiveOp, { includeSource });
            console.log(`[AI] Project context built (first time) for continue: ${effectivePath}`);
        } catch (e) {
            console.error('[AI] Failed to build project context:', e.message);
        }
    } else if (projectContext) {
        console.log(`[AI] Reusing cached project context for continue (saves ~3K-10K tokens)`);
    }

    const effectiveMode = mode || engine.mode;
    const callbacks = makeDebateCallbacks(projectId, {
        autoExecute: true,
        mode: effectiveMode,
    });
    // Do not await — let it run in background, IPC events will stream results
    engine.continue(message, callbacks, {
        projectContext,
        projectPath: effectivePath,
        mode: effectiveMode,
        aiMode: aiMode || engine.aiMode,
        attachedMediaFiles: attachedMediaFiles || [],
    }).catch(err => {
        safelog('[AI] continue error:', err.message);
        // Send error to renderer so user can see it
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai.error', { projectId, message: err.message, source: 'continue' });
        }
    });
    return { success: true };
});

ipcMain.handle('ai.stop', (event, { projectId }) => {
    const engine = debateEngines.get(projectId);
    if (engine) engine.stop();
    return { success: true };
});

ipcMain.handle('ai.reset', (event, { projectId }) => {
    const engine = debateEngines.get(projectId);
    if (engine) {
        engine.stop();
        engine.resetHistory();
    }
    return { success: true };
});

ipcMain.handle('ai.getState', (event, { projectId }) => {
    const engine = debateEngines.get(projectId);
    if (!engine) return { running: false, historyLength: 0 };
    return engine.getState();
});

ipcMain.handle('ai.getHistory', (event, { projectId }) => {
    const engine = debateEngines.get(projectId);
    if (!engine) return [];
    return engine.getHistory();
});

ipcMain.handle('ai.getModes', () => {
    const modes = {};
    for (const [key, val] of Object.entries(MODES)) {
        modes[key] = { name: val.name, description: val.description };
    }
    return modes;
});

ipcMain.handle('ai.getOperations', () => {
    return getOperationsList();
});

ipcMain.handle('ai.getSettings', () => {
    return {
        geminiApiKey: store.get('geminiApiKey', ''),
        aiDefaultMode: store.get('aiDefaultMode', 'collab'),
        aiDefaultAiMode: store.get('aiDefaultAiMode', 'dual'),
        aiMaxRounds: store.get('aiMaxRounds', 1),
        aiIncludeSource: store.get('aiIncludeSource', false),
    };
});

ipcMain.handle('ai.setSettings', (event, settings) => {
    if (settings.geminiApiKey !== undefined) store.set('geminiApiKey', settings.geminiApiKey);
    if (settings.aiDefaultMode !== undefined) store.set('aiDefaultMode', settings.aiDefaultMode);
    if (settings.aiDefaultAiMode !== undefined) store.set('aiDefaultAiMode', settings.aiDefaultAiMode);
    if (settings.aiMaxRounds !== undefined) store.set('aiMaxRounds', settings.aiMaxRounds);
    if (settings.aiIncludeSource !== undefined) store.set('aiIncludeSource', settings.aiIncludeSource);
    return { success: true };
});

// ===================================================================
//  Pipeline — Codex-style AI Orchestration (Gemini design → Claude execute)
// ===================================================================

function makePipelineCallbacks(projectId) {
    return {
        onGeminiToken: (token) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pipeline.geminiToken', { projectId, token });
            }
        },
        onGeminiComplete: (text) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pipeline.geminiComplete', { projectId, text });
            }
        },
        onClaudeToken: () => {},
        onClaudeComplete: () => {},
        onPipelineReady: (geminiDesign) => {
            // Gemini design complete → build execution prompt → enqueue to TaskQueue
            const engine = debateEngines.get(projectId);
            const originalTask = engine ? engine.getTask() : '';
            const executionPrompt = buildExecutionPrompt(originalTask, geminiDesign);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pipeline.executionStarted', { projectId });
            }

            // Find project name for the task queue
            const projects = store.get('projects', []);
            const project = projects.find(p => p.id === projectId);
            const projectName = project ? project.name : projectId;

            taskQueue.enqueue(projectId, projectName, executionPrompt);
            console.log(`[Pipeline] Gemini design complete → Claude execution queued for ${projectId}`);
        },
        onRoundStart: (round, maxRounds) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.roundStart', { projectId, round, maxRounds });
            }
        },
        onDebateComplete: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.debateComplete', { projectId });
            }
        },
        onError: (error, source) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pipeline.error', { projectId, message: error.message, source });
            }
        },
        onStatusChange: (status) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ai.statusChange', { projectId, status });
            }
        },
    };
}

ipcMain.handle('pipeline.submit', async (event, { projectId, text, routeMode }) => {
    // 빈 텍스트 전송 방지
    if (!text || !text.trim()) {
        console.log(`[pipeline.submit] REJECTED empty text for project ${projectId}`);
        return { success: false, error: 'empty text' };
    }

    // Always use queue to prevent race conditions with concurrent submissions.
    // The queue handles sequencing properly: one task at a time per project,
    // and dispatches immediately if claudeReady=true and no running tasks.
    const projects = store.get('projects', []);
    const project = projects.find(p => p.id === projectId);
    const projectName = project ? project.name : projectId;
    const task = taskQueue.enqueue(projectId, projectName, text);
    if (!task) {
        if (taskQueue._lastEnqueueError === 'duplicate') {
            return { success: false, error: 'duplicate' };
        }
        return { success: false, error: 'empty text' };
    }
    return { success: true, mode: 'queued' };
});

// ===================================================================
//  macOS Custom Installer (bypass Squirrel.Mac for unsigned apps)
// ===================================================================
function installMacOSUpdate(zipPath) {
    try {
        const exePath = app.getPath('exe');
        // exe: /Applications/Claude CLI Terminal.app/Contents/MacOS/Claude CLI Terminal
        const appBundlePath = exePath.replace(/\/Contents\/MacOS\/.*$/, '');
        if (!appBundlePath.endsWith('.app')) {
            safelog('[Updater] Cannot determine .app path from exe:', exePath);
            return false;
        }
        const appDir = path.dirname(appBundlePath);
        const os = require('os');
        const tempDir = path.join(os.tmpdir(), `auto-teminel-update-${Date.now()}`);
        const scriptPath = path.join(os.tmpdir(), `auto-teminel-install-${Date.now()}.sh`);

        const script = `#!/bin/bash
sleep 2
mkdir -p "${tempDir}"
cd "${tempDir}"
unzip -o "${zipPath}" > /dev/null 2>&1
NEW_APP=$(find "${tempDir}" -maxdepth 2 -name "*.app" | head -1)
if [ -z "$NEW_APP" ]; then
    rm -rf "${tempDir}"
    exit 1
fi
rm -rf "${appBundlePath}"
cp -R "$NEW_APP" "${appDir}/"
sleep 0.5
open "${appBundlePath}"
rm -rf "${tempDir}"
rm -f "${scriptPath}"
`;
        require('fs').writeFileSync(scriptPath, script, { mode: 0o755 });
        const { spawn } = require('child_process');
        const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
        child.unref();
        safelog(`[Updater] Custom installer started: ${zipPath} → ${appBundlePath}`);
        setTimeout(() => app.quit(), 400);
        return true;
    } catch (err) {
        safelog('[Updater] Custom installer error:', err.message);
        return false;
    }
}

// ===================================================================
//  Auto-Updater IPC handlers
// ===================================================================
ipcMain.handle('updater.check', () => {
    return autoUpdater.checkForUpdates().catch(err => ({ error: err.message }));
});

ipcMain.handle('updater.download', () => {
    return autoUpdater.downloadUpdate().catch(err => ({ error: err.message }));
});

ipcMain.handle('updater.install', () => {
    safelog('[Updater] quitAndInstall requested');
    // macOS: use custom installer to bypass Squirrel.Mac code signature requirement
    if (process.platform === 'darwin') {
        let zipPath = _downloadedUpdateFile;
        // Fallback: search electron-updater cache if _downloadedUpdateFile was lost (e.g. after restart)
        if (!zipPath) {
            const cacheDirs = [
                path.join(app.getPath('cache'), 'Claude CLI Terminal', 'pending', 'update.zip'),
                path.join(app.getPath('userData'), 'pending', 'update.zip'),
            ];
            for (const p of cacheDirs) {
                if (require('fs').existsSync(p)) {
                    zipPath = p;
                    safelog('[Updater] Found cached update ZIP at:', zipPath);
                    break;
                }
            }
        }
        if (zipPath) {
            safelog('[Updater] Using custom macOS installer (unsigned app)');
            if (installMacOSUpdate(zipPath)) return;
        }
        safelog('[Updater] No cached update ZIP found, falling through to quitAndInstall');
    }
    try {
        autoUpdater.quitAndInstall(false, true);
    } catch (err) {
        safelog('[Updater] quitAndInstall threw:', err.message);
    }
    // Fallback: if quitAndInstall silently fails, force restart after 2s
    setTimeout(() => {
        safelog('[Updater] Force relaunch via app.exit(0)...');
        app.relaunch();
        app.exit(0);
    }, 2000);
});

ipcMain.handle('updater.getVersion', () => {
    return app.getVersion();
});

// Load schedules on startup (after a short delay to let window load)
app.whenReady().then(() => {
    setTimeout(() => {
        errorDetectionEnabled = store.get('errorDetectionEnabled', true);
        autoFixEnabled = store.get('autoFixEnabled', true);
        autoFixCooldown = store.get('autoFixCooldown', 15);
        autoFixTemplate = store.get('autoFixTemplate', 'CRITICAL ERROR DETECTED: [{label}] {error}\n\nYou MUST:\n1. Analyze the root cause of this error — do NOT guess, read the actual code.\n2. Fix the error completely — not just the symptom but the underlying cause.\n3. Check for related errors in the same file and nearby files.\n4. After fixing, re-read the modified files to verify no new syntax/logic errors were introduced.\n5. If the fix requires changes to multiple files, fix ALL of them.\nDo NOT skip any step. Fix it properly.');
        autoRestartEnabled = store.get('autoRestartEnabled', true);
        autoRestartResendPrompt = store.get('autoRestartResendPrompt', true);
        autoVerifyEnabled = store.get('autoVerifyEnabled', true);
        autoRestartMaxRetries = store.get('autoRestartMaxRetries', 3);
        autoRestartRateWindow = store.get('autoRestartRateWindow', 5) * 60000;
        autoApproveEnabled = store.get('autoApproveEnabled', true);
        autoApproveMode = store.get('autoApproveMode', 'clear_context');
        // Ensure auto-approve is ON by default on first run
        if (!store.has('autoApproveEnabled')) {
            store.set('autoApproveEnabled', true);
            autoApproveEnabled = true;
        }
        console.log(`[Main] Auto-approve loaded: enabled=${autoApproveEnabled}, mode=${autoApproveMode}`);
        loadAndStartSchedules();
        startHealthCheckScheduler();

        // Restore pending tasks from previous session (crash/sudden exit recovery)
        restoreTaskQueue();
        startTaskPersistTimer();

        // Start Remote Control API server
        const remoteApiKey = process.env.REMOTE_API_KEY;
        const remotePort = parseInt(process.env.REMOTE_PORT, 10) || 3100;
        if (remoteApiKey) {
            startRemoteServer({
                apiKey: remoteApiKey,
                port: remotePort,
                ptyPool,
                taskQueue,
                store,
                spawnPtyForProject,
                destroyPty
            });
        } else {
            console.log('[Main] REMOTE_API_KEY not set — remote server disabled.');
        }
    }, 2000);
});

// ===================================================================
//  MCP Manager — IPC Handlers
// ===================================================================

function computeMcpOAuthKey(serverName, serverConfig) {
    const data = JSON.stringify({ type: serverConfig.type, url: serverConfig.url, headers: serverConfig.headers || {} });
    const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    return `${serverName}|${hash}`;
}

function readClaudeJson() {
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch (e) { return {}; }
}

function writeClaudeJson(data) {
    fs.writeFileSync(path.join(os.homedir(), '.claude.json'), JSON.stringify(data, null, 2));
}

function findAvailablePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => { const port = srv.address().port; srv.close(() => resolve(port)); });
        srv.on('error', reject);
    });
}

ipcMain.handle('mcp.list', async () => {
    const claudeJson = readClaudeJson();
    const needsAuthPath = path.join(os.homedir(), '.claude', 'mcp-needs-auth-cache.json');
    let needsAuth = {};
    try { needsAuth = JSON.parse(fs.readFileSync(needsAuthPath, 'utf8')); } catch (e) {}

    const userServers = claudeJson.mcpServers || {};
    const mcpOAuth = claudeJson.mcpOAuth || {};

    return Object.entries(userServers).map(([name, config]) => {
        let status = 'unknown';
        if (config.type === 'http') {
            const key = computeMcpOAuthKey(name, config);
            const token = mcpOAuth[key];
            if (token && token.accessToken && token.expiresAt > Date.now()) {
                status = 'connected';
            } else if (token && token.refreshToken) {
                status = 'token-expired';
            } else {
                status = 'needs-auth';
            }
        } else {
            status = 'stdio';
        }
        return { name, type: config.type, url: config.url, status };
    });
});

ipcMain.handle('mcp.authenticate', async (event, { serverName, serverUrl }) => {
    try {
        // 1. Fetch OAuth authorization server metadata
        const wwwAuthRes = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {} }) });
        if (wwwAuthRes.status !== 401) return { success: false, error: 'Server did not return 401' };

        const wwwAuth = wwwAuthRes.headers.get('www-authenticate') || '';
        const authServerUriMatch = wwwAuth.match(/authorization_uri="([^"]+)"/);
        if (!authServerUriMatch) return { success: false, error: 'No authorization_uri in WWW-Authenticate' };

        const metaRes = await fetch(authServerUriMatch[1]);
        const metadata = await metaRes.json();

        // 2. Find available port for callback
        const port = await findAvailablePort();
        const redirectUri = `http://localhost:${port}/callback`;

        // 3. Register dynamic client (RFC 7591)
        const regRes = await fetch(metadata.registration_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_name: `Claude Code (${serverName})`,
                redirect_uris: [redirectUri],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none'
            })
        });
        if (!regRes.ok) return { success: false, error: `Client registration failed: ${regRes.status}` };
        const clientInfo = await regRes.json();

        // 4. Generate PKCE + state
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        const state = crypto.randomBytes(16).toString('base64url');

        // 5. Start local callback server
        const result = await new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                try {
                    const url = new URL(`http://localhost${req.url}`);
                    const code = url.searchParams.get('code');
                    const returnedState = url.searchParams.get('state');
                    const error = url.searchParams.get('error');

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end(`<h1>Authentication Error</h1><p>${error}</p><p>You can close this window.</p>`);
                        server.close();
                        resolve({ success: false, error });
                        return;
                    }

                    if (returnedState !== state) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end('<h1>State mismatch — possible CSRF attack</h1>');
                        server.close();
                        resolve({ success: false, error: 'State mismatch' });
                        return;
                    }

                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<h1 style="font-family:sans-serif;color:#00c853;padding:40px">✓ Figma authenticated successfully!<br><small style="color:#666;font-size:14px">You can close this window.</small></h1>');
                    server.close();

                    // 6. Exchange code for token
                    const tokenRes = await fetch(metadata.token_endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            grant_type: 'authorization_code',
                            code,
                            redirect_uri: redirectUri,
                            client_id: clientInfo.client_id,
                            code_verifier: codeVerifier
                        }).toString()
                    });
                    const tokenData = await tokenRes.json();
                    if (!tokenData.access_token) {
                        resolve({ success: false, error: tokenData.error || 'No access_token in response' });
                        return;
                    }

                    // 7. Store token in ~/.claude.json mcpOAuth
                    const claudeJson = readClaudeJson();
                    const serverConfig = { type: 'http', url: serverUrl, headers: {} };
                    const key = computeMcpOAuthKey(serverName, serverConfig);
                    if (!claudeJson.mcpOAuth) claudeJson.mcpOAuth = {};
                    claudeJson.mcpOAuth[key] = {
                        serverName,
                        serverUrl,
                        clientId: clientInfo.client_id,
                        clientSecret: clientInfo.client_secret || '',
                        accessToken: tokenData.access_token,
                        refreshToken: tokenData.refresh_token || '',
                        expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
                        scope: tokenData.scope || 'mcp:connect'
                    };
                    writeClaudeJson(claudeJson);

                    // 8. Remove from needs-auth cache
                    try {
                        const cachePath = path.join(os.homedir(), '.claude', 'mcp-needs-auth-cache.json');
                        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                        delete cache[serverName];
                        fs.writeFileSync(cachePath, JSON.stringify(cache));
                    } catch (_) {}

                    resolve({ success: true });
                } catch (err) {
                    server.close();
                    resolve({ success: false, error: err.message });
                }
            });

            server.listen(port, () => {
                // 5. Open browser to auth URL
                const authUrl = new URL(metadata.authorization_endpoint);
                authUrl.searchParams.set('response_type', 'code');
                authUrl.searchParams.set('client_id', clientInfo.client_id);
                authUrl.searchParams.set('redirect_uri', redirectUri);
                authUrl.searchParams.set('state', state);
                authUrl.searchParams.set('code_challenge', codeChallenge);
                authUrl.searchParams.set('code_challenge_method', 'S256');
                authUrl.searchParams.set('scope', 'mcp:connect');
                shell.openExternal(authUrl.toString());
            });

            // 10 minute timeout
            setTimeout(() => { server.close(); resolve({ success: false, error: 'Timeout' }); }, 600000);
        });

        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp.revoke', async (event, { serverName, serverUrl }) => {
    try {
        const claudeJson = readClaudeJson();
        const serverConfig = { type: 'http', url: serverUrl, headers: {} };
        const key = computeMcpOAuthKey(serverName, serverConfig);
        if (claudeJson.mcpOAuth && claudeJson.mcpOAuth[key]) {
            delete claudeJson.mcpOAuth[key];
            writeClaudeJson(claudeJson);
        }
        // Add back to needs-auth cache
        try {
            const cachePath = path.join(os.homedir(), '.claude', 'mcp-needs-auth-cache.json');
            let cache = {};
            try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) {}
            cache[serverName] = { timestamp: Date.now() };
            fs.writeFileSync(cachePath, JSON.stringify(cache));
        } catch (_) {}
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ====================================================================
//  Browser Control — WebSocket Server (Chrome Extension 연동)
// ====================================================================
let browserWsServer = null;
let browserExtSocket = null;           // 연결된 익스텐션 소켓 (1개)
let browserCmdCallbacks = new Map();   // cmdId → resolve
let browserCmdSeq = 0;

function startBrowserWsServer(port = 9999) {
    try {
        browserWsServer = new WebSocketServer({ port });
        console.log(`[Browser WS] 서버 시작 ws://localhost:${port}`);
    } catch (e) {
        console.error('[Browser WS] 서버 시작 실패:', e.message);
        return;
    }

    browserWsServer.on('connection', (socket) => {
        console.log('[Browser WS] 익스텐션 연결됨');
        browserExtSocket = socket;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser.extConnected', true);
        }

        socket.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'hello') return; // handshake 무시

            // 대기 중인 콜백 resolve
            const cb = browserCmdCallbacks.get(msg.id);
            if (cb) { browserCmdCallbacks.delete(msg.id); cb(msg); }

            // 렌더러에 브로드캐스트 (screenshot 등 실시간 업데이트)
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('browser.response', msg);
            }
        });

        socket.on('close', () => {
            console.log('[Browser WS] 익스텐션 연결 끊김');
            browserExtSocket = null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('browser.extConnected', false);
            }
        });

        socket.on('error', (e) => console.error('[Browser WS] 소켓 에러:', e.message));
    });
}

// 렌더러 → 익스텐션으로 명령 전송 (응답 대기)
ipcMain.handle('browser.send', async (event, { type, ...params }) => {
    if (!browserExtSocket || browserExtSocket.readyState !== 1 /* OPEN */) {
        return { error: 'Extension not connected' };
    }
    const id = ++browserCmdSeq;
    return new Promise((resolve) => {
        browserCmdCallbacks.set(id, resolve);
        browserExtSocket.send(JSON.stringify({ id, type, ...params }));
        // 30s 타임아웃 (스크린샷 등 느릴 수 있음)
        setTimeout(() => {
            if (browserCmdCallbacks.has(id)) {
                browserCmdCallbacks.delete(id);
                resolve({ error: 'Timeout' });
            }
        }, 30000);
    });
});

ipcMain.handle('browser.isConnected', () => {
    return browserExtSocket?.readyState === 1;
});
