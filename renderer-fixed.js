// Claude CLI Terminal - Renderer (v5 - Automation)
const { ipcRenderer, clipboard, nativeImage } = require('electron');
const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ===================================================================
//  State
// ===================================================================

let currentProject = null;
let projects = [];

const termPool = new Map();

let promptHistory = [];
const MAX_HISTORY = 200;

const attachedImagesMap = new Map();

// Automation state
let templates = [];
let schedules = [];
let errorLog = [];
let editingTemplateId = null;
let editingScheduleId = null;

// Activity log + Dashboard
let activityLog = [];
const MAX_ACTIVITY = 300;
let dashboardStats = { errors: 0, build: 'No check', security: 'No check', health: 'No check', lastCheckTime: null };

// Unified Task Queue System — state is managed in main process via IPC
let taskQueue = [];       // local mirror of main-process state (read-only)
let queueRunning = false; // local mirror
let queuePaused = false;  // local mirror

// Idle tracking per project
const idleState = new Map(); // projectId -> boolean (true = idle)

// Auto-Fix state
let autoFixEnabled = true;

// Auto-Approve state
let autoApproveEnabled = true;

// Auto-Restart state
let autoRestartEnabled = true;

// Auto-Verify state (default OFF — can interrupt user tasks)
let autoVerifyEnabled = false;

// Auto-Restart resend prompt state
let autoRestartResendPrompt = true;

// Session persistence - debounce timer for saving history
let historySaveTimer = null;

// Health Check state
let healthCheckRunning = false;
let healthCheckResults = [];
let healthCheckHistory = [];
let healthCheckChecks = [];

function getAttachedImages() {
    if (!currentProject) return [];
    return attachedImagesMap.get(currentProject.id) || [];
}

function setAttachedImages(images) {
    if (!currentProject) return;
    attachedImagesMap.set(currentProject.id, images);
}

console.log('=== Renderer Script Loaded ===');

// ===================================================================
//  Sound Notification
// ===================================================================

let _audioCtx = null;
function playNotificationSound() {
    try {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = _audioCtx;

        // Two-tone chime: "띠링"
        const now = ctx.currentTime;

        // First tone (high)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1200, now);
        gain1.gain.setValueAtTime(0.3, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc1.connect(gain1).connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.15);

        // Second tone (higher, slightly delayed)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1600, now + 0.12);
        gain2.gain.setValueAtTime(0.01, now);
        gain2.gain.setValueAtTime(0.3, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc2.connect(gain2).connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.35);
    } catch (_) {}
}

// ===================================================================
//  Toast Notification System
// ===================================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, 3200);
}

// ===================================================================
//  Initialization
// ===================================================================

async function init() {
    console.log('=== INIT START ===');
    try {
        // Load saved prompt history
        const savedHistory = await ipcRenderer.invoke('session.getPromptHistory');
        if (savedHistory && savedHistory.length > 0) {
            promptHistory = savedHistory;
        }

        await loadProjects();

        // Restore last selected project, fallback to first
        const lastProjectId = await ipcRenderer.invoke('session.getLastSelectedProject');
        if (lastProjectId && projects.find(p => p.id === lastProjectId)) {
            await selectProject(lastProjectId);
        } else if (projects.length > 0) {
            await selectProject(projects[0].id);
        }

        // Restore previously active session projects (spawn PTYs in background)
        const activeSessionIds = await ipcRenderer.invoke('session.getActiveSessionProjects');
        if (activeSessionIds && activeSessionIds.length > 0) {
            const selectedId = currentProject ? currentProject.id : null;
            for (const activeId of activeSessionIds) {
                if (activeId === selectedId) continue; // Already spawned above
                const project = projects.find(p => p.id === activeId);
                if (project) {
                    console.log(`Restoring active session for: ${project.name}`);
                    await getOrCreateTerminal(project);
                    await ensurePtyRunning(project);
                }
            }
            renderProjects(); // Update sidebar to show running indicators
        }

        window.addEventListener('resize', () => {
            if (currentProject) {
                const entry = termPool.get(currentProject.id);
                if (entry) fitEntry(entry);
            }
        });

        setupImageDragDrop();
        setupClipboardPaste();
        setupEscapeClear();

        // Load automation state + dashboard
        await loadAutomationDefaults();
        await loadTemplates();
        await loadSchedules();
        await loadHealthCheckState();
        renderDashboard();
        renderSecurityChecks();
        setupTaskInputShortcut();

        console.log('=== INIT COMPLETE ===');
    } catch (error) {
        console.error('=== INIT ERROR ===', error);
        updateStatus('error', 'Init Error');
    }
}

// ===================================================================
//  Escape Key — Clear Input Line
// ===================================================================

function setupEscapeClear() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Don't intercept if a modal is open or in an input field
            const activeModal = document.querySelector('.modal.show');
            if (activeModal) return;
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

            e.preventDefault();
            clearInputLine();

            // Flash border feedback
            const container = document.getElementById('terminal-container');
            if (container) {
                container.classList.add('flash');
                setTimeout(() => container.classList.remove('flash'), 200);
            }
        }
    });
}

// ===================================================================
//  Terminal Pool Management
// ===================================================================

async function getOrCreateTerminal(project) {
    const id = project.id;

    if (termPool.has(id)) {
        return termPool.get(id);
    }

    const settings = await ipcRenderer.invoke('get-settings');
    const fontSize = settings.fontSize || 14;

    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = `term-${id}`;
    wrapper.style.display = 'none';
    document.getElementById('terminal-container').appendChild(wrapper);

    const term = new Terminal({
        fontFamily: "'Monaco', 'Menlo', 'Consolas', 'Liberation Mono', 'Courier New', monospace",
        fontSize: fontSize,
        theme: {
            background: '#0d1117',
            foreground: '#c9d1d9',
            cursor: '#58a6ff',
            cursorAccent: '#0d1117',
            selectionBackground: '#264f78',
            black: '#484f58',
            red: '#ff7b72',
            green: '#3fb950',
            yellow: '#d29922',
            blue: '#58a6ff',
            magenta: '#bc8cff',
            cyan: '#39c5cf',
            white: '#b1bac4',
            brightBlack: '#6e7681',
            brightRed: '#ffa198',
            brightGreen: '#56d364',
            brightYellow: '#e3b341',
            brightBlue: '#79c0ff',
            brightMagenta: '#d2a8ff',
            brightCyan: '#56d4dd',
            brightWhite: '#f0f6fc'
        },
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 10000,
        allowProposedApi: true,
        allowTransparency: false
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(wrapper);

    const entry = {
        term,
        fitAddon,
        wrapperEl: wrapper,
        inputBuffer: '',
        isAlive: false
    };

    // Terminal is read-only — block all user keyboard input.
    // Only programmatic sends (queue system, auto-fix, etc.) go through.
    term.onData((data) => {
        // Silently ignore user keystrokes
    });

    termPool.set(id, entry);
    return entry;
}

function showTerminal(projectId) {
    const placeholder = document.getElementById('terminalPlaceholder');

    for (const [id, entry] of termPool) {
        if (id === projectId) {
            entry.wrapperEl.style.display = 'block';
        } else {
            entry.wrapperEl.style.display = 'none';
        }
    }

    if (termPool.has(projectId)) {
        if (placeholder) placeholder.style.display = 'none';
    } else {
        if (placeholder) placeholder.style.display = 'flex';
    }
}

function fitEntry(entry) {
    if (entry && entry.fitAddon && entry.term) {
        try {
            entry.fitAddon.fit();
            for (const [id, e] of termPool) {
                if (e === entry) {
                    ipcRenderer.send('terminal.resize', {
                        projectId: id,
                        cols: entry.term.cols,
                        rows: entry.term.rows
                    });
                    break;
                }
            }
        } catch (_) {}
    }
}

function clearTerminal() {
    if (!currentProject) return;
    const entry = termPool.get(currentProject.id);
    if (entry) entry.term.clear();
}

function clearInputLine() {
    // No-op: terminal is read-only
}

// ===================================================================
//  IPC: Terminal data from main process
// ===================================================================

ipcRenderer.on('terminal.incomingData', (event, { projectId, data }) => {
    const entry = termPool.get(projectId);
    if (entry) {
        entry.term.write(data);
    }
    // Only mark as working if there is an active running task for THIS project.
    // This prevents other projects from flickering working/idle on stray terminal output.
    const hasRunningTask = taskQueue.some(t => t.status === 'running' && t.projectId === projectId);
    if (hasRunningTask) {
        if (!idleState.has(projectId) || idleState.get(projectId)) {
            idleState.set(projectId, false);
            updateProjectWorkingState(projectId, true);
        }
    }
});

ipcRenderer.on('terminal.exit', (event, { projectId, exitCode, signal }) => {
    console.log(`Terminal exited for ${projectId}: code=${exitCode}`);
    const entry = termPool.get(projectId);
    if (entry) {
        entry.isAlive = false;
        entry.term.write('\r\n\x1b[90m--- Process exited ---\x1b[0m\r\n');
    }

    // Clear working state on exit
    idleState.set(projectId, true);
    updateProjectWorkingState(projectId, false);

    if (currentProject && currentProject.id === projectId) {
        updateStatus('disconnected', 'Process Exited');
        document.getElementById('terminalStatus').textContent = `Exited (code ${exitCode})`;
    }

    renderDashboard(); // PTY 종료 시 대시보드 갱신 (배지 inactive 반영)
});

// (Idle detection moved to bottom — integrated with Tasks)

// (Error detection moved to bottom — integrated with Activity log)

// (Schedule notification moved to bottom — integrated with Activity log)

// (Auto-fix notifications moved to bottom — integrated with Activity log)

// ===================================================================
//  Spawn PTY for Project
// ===================================================================

async function ensurePtyRunning(project) {
    const entry = termPool.get(project.id);
    if (entry && entry.isAlive) {
        console.log(`PTY already alive for ${project.name}`);
        return;
    }

    updateStatus('running', 'Starting...');
    document.getElementById('terminalStatus').textContent = 'Starting...';

    const cols = entry ? entry.term.cols : 120;
    const rows = entry ? entry.term.rows : 30;

    const result = await ipcRenderer.invoke('terminal.spawn', {
        projectId: project.id,
        projectPath: project.path,
        claudeArgs: project.claudeArgs || '',
        cols,
        rows
    });

    if (result.success) {
        if (entry) entry.isAlive = true;
        updateStatus('ready', 'Claude CLI Running');
        document.getElementById('terminalStatus').textContent = 'Running';
        document.getElementById('infoPid').textContent = result.pid || '—';

        if (result.alreadyRunning) {
            console.log('PTY was already running on backend');
        }
    } else {
        if (entry) {
            entry.isAlive = false;
            entry.term.write(`\x1b[31mError: ${result.error}\x1b[0m\r\n`);
            entry.term.write(`\r\nPossible causes:\r\n`);
            entry.term.write(`  1. Project path does not exist: ${project.path}\r\n`);
            entry.term.write(`  2. 'claude' is not installed or not in PATH\r\n`);
            entry.term.write(`     Install: curl -fsSL https://claude.ai/install.sh | bash\r\n`);
            entry.term.write(`  3. Shell binary not found (check Settings > Shell Path)\r\n`);
        }
        updateStatus('error', 'Spawn Failed');
        document.getElementById('terminalStatus').textContent = 'Error';
    }
}

// ===================================================================
//  Project Selection
// ===================================================================

async function selectProject(projectId) {
    currentProject = projects.find(p => p.id === projectId);
    if (!currentProject) return;

    console.log('Project selected:', currentProject.name);

    // Persist last selected project
    ipcRenderer.invoke('session.setLastSelectedProject', projectId);

    renderProjects();
    renderProjectInfo();
    updateInfoPanel(currentProject);

    const entry = await getOrCreateTerminal(currentProject);
    showTerminal(projectId);
    renderImagePreviewBar();

    requestAnimationFrame(() => {
        fitEntry(entry);
        entry.term.focus();
    });

    await ensurePtyRunning(currentProject);

    if (entry.isAlive) {
        updateStatus('ready', 'Claude CLI Running');
        document.getElementById('terminalStatus').textContent = 'Running';
        // Terminal is up — kick the queue in case tasks are waiting
        setTimeout(() => ipcRenderer.invoke('queue.kick'), 500);
    }
}

function updateInfoPanel(project) {
    document.getElementById('infoProject').textContent = project.name;
    document.getElementById('infoPath').textContent = project.path;
    document.getElementById('infoBranch').textContent = project.branch || '—';
    document.getElementById('infoPid').textContent = '—';
}

// ===================================================================
//  Terminal Control Buttons
// ===================================================================

async function restartTerminal() {
    if (!currentProject) return;
    const id = currentProject.id;

    await ipcRenderer.invoke('terminal.kill', id);

    const entry = termPool.get(id);
    if (entry) {
        entry.term.clear();
        entry.term.reset();
        entry.isAlive = false;
    }

    await ensurePtyRunning(currentProject);

    if (entry) {
        requestAnimationFrame(() => {
            fitEntry(entry);
            entry.term.focus();
        });
        // Terminal restarted — kick the queue
        if (entry.isAlive) setTimeout(() => ipcRenderer.invoke('queue.kick'), 500);
    }
}

async function killTerminal() {
    if (!currentProject) return;
    const id = currentProject.id;

    await ipcRenderer.invoke('terminal.kill', id);

    const entry = termPool.get(id);
    if (entry) {
        entry.isAlive = false;
        entry.term.write('\r\n\x1b[33m--- Terminal killed ---\x1b[0m\r\n');
    }

    updateStatus('disconnected', 'Killed');
    document.getElementById('terminalStatus').textContent = 'Killed';
}

// ===================================================================
//  Image Attachment Queue
// ===================================================================

function addAttachedImage(filePath) {
    if (!currentProject) return;
    const images = getAttachedImages();
    if (images.includes(filePath)) return;
    images.push(filePath);
    setAttachedImages(images);
    renderImagePreviewBar();
}

function removeAttachedImage(index) {
    if (!currentProject) return;
    const images = getAttachedImages();
    images.splice(index, 1);
    setAttachedImages(images);
    renderImagePreviewBar();
}

function clearAttachedImages() {
    if (!currentProject) return;
    setAttachedImages([]);
    renderImagePreviewBar();
}

function renderImagePreviewBar() {
    const bar = document.getElementById('imagePreviewBar');
    const scroll = document.getElementById('imagePreviewScroll');
    if (!bar || !scroll) return;

    const attachedImages = getAttachedImages();
    if (attachedImages.length === 0) {
        bar.style.display = 'none';
        scroll.innerHTML = '';
        return;
    }

    bar.style.display = 'flex';
    scroll.innerHTML = '';

    const imageExts = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
    const videoExts = /\.(mp4|mov|avi|mkv|webm)$/i;
    const audioExts = /\.(mp3|wav|ogg|flac|aac|m4a)$/i;

    attachedImages.forEach((filePath, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'image-thumb';
        thumb.title = filePath;
        const fileName = path.basename(filePath);

        if (imageExts.test(fileName)) {
            const img = document.createElement('img');
            img.src = 'file://' + filePath;
            img.alt = fileName;
            img.onerror = () => { img.style.display = 'none'; };
            thumb.appendChild(img);
        } else {
            const icon = document.createElement('div');
            icon.style.cssText = 'width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#0d1117);border:1px solid var(--border-primary,#30363d);border-radius:6px;font-size:20px;';
            if (videoExts.test(fileName)) icon.textContent = '🎬';
            else if (audioExts.test(fileName)) icon.textContent = '🎵';
            else icon.textContent = '📄';
            thumb.appendChild(icon);
        }

        const name = document.createElement('span');
        name.className = 'image-thumb-name';
        name.textContent = fileName;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'image-thumb-remove';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            removeAttachedImage(idx);
        };

        thumb.appendChild(name);
        thumb.appendChild(removeBtn);
        scroll.appendChild(thumb);
    });
}

async function insertAllImagePaths() {
    const targetProject = currentProject;
    if (!targetProject) return;
    const images = getAttachedImages();
    if (images.length === 0) return;
    const entry = termPool.get(targetProject.id);
    if (!entry || !entry.isAlive) return;

    // Enqueue image paths as a task via IPC
    const pathsText = images.join(' ');
    await ipcRenderer.invoke('queue.enqueue', {
        projectId: targetProject.id,
        projectName: targetProject.name,
        text: pathsText
    });
    clearAttachedImages();
    showToast('Image paths queued', 'info');
}

async function selectImageFile() {
    const filePaths = await ipcRenderer.invoke('select-image-file');
    if (!filePaths || filePaths.length === 0) return;
    filePaths.forEach(fp => addAttachedImage(fp));
}

// ===================================================================
//  Image Drag & Drop
// ===================================================================

function setupImageDragDrop() {
    const container = document.getElementById('terminal-container');
    let dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.innerHTML = '<div class="drop-overlay-content">Drop files to attach</div>';
    container.appendChild(dropOverlay);

    let dragCounter = 0;

    container.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        const hasFiles = Array.from(e.dataTransfer.items).some(item => item.kind === 'file');
        if (hasFiles) {
            dropOverlay.classList.add('visible');
        }
    });

    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    container.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropOverlay.classList.remove('visible');
        }
    });

    container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        dropOverlay.classList.remove('visible');

        const files = Array.from(e.dataTransfer.files);
        // Accept all media types: images, video, audio, docs
        const mediaExtensions = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|avi|mkv|webm|mp3|wav|ogg|flac|aac|m4a|pdf|csv|txt|json|xml)$/i;
        const mediaFiles = files.filter(f => mediaExtensions.test(f.name));
        // If no extension match, still allow all dropped files
        const toAttach = mediaFiles.length > 0 ? mediaFiles : files;

        toAttach.forEach(file => {
            addAttachedImage(file.path);
        });
    });
}

// ===================================================================
//  Clipboard Paste
// ===================================================================

function setupClipboardPaste() {
    document.addEventListener('paste', async (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;

        const img = clipboard.readImage();
        if (!img.isEmpty()) {
            e.preventDefault();
            e.stopImmediatePropagation();

            const dataURL = img.toDataURL();
            const savedPath = await ipcRenderer.invoke('save-clipboard-image', dataURL);
            if (savedPath) {
                addAttachedImage(savedPath);
            }
            return;
        }

        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
            const pastedFiles = Array.from(e.clipboardData.files);
            if (pastedFiles.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pastedFiles.forEach(file => {
                    addAttachedImage(file.path);
                });
                return;
            }
        }
    }, true);
}

// ===================================================================
//  Prompt History
// ===================================================================

function handleKeystrokeForHistory(entry, data) {
    for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        const code = data.charCodeAt(i);

        if (ch === '\r' || ch === '\n') {
            flushInputBuffer(entry);
            continue;
        }
        if (ch === '\x7f' || ch === '\b') {
            entry.inputBuffer = entry.inputBuffer.slice(0, -1);
            continue;
        }
        if (ch === '\x1b') {
            if (i + 1 < data.length && data[i + 1] === '[') {
                i += 2;
                while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++;
            } else {
                i++;
            }
            continue;
        }
        if (code < 0x20) continue;

        entry.inputBuffer += ch;
    }
}

function flushInputBuffer(entry) {
    const text = entry.inputBuffer.trim();
    entry.inputBuffer = '';
    if (!text) return;

    const projectName = currentProject ? currentProject.name : '—';

    promptHistory.unshift({
        text,
        timestamp: Date.now(),
        project: projectName
    });

    if (promptHistory.length > MAX_HISTORY) {
        promptHistory.length = MAX_HISTORY;
    }

    renderPromptHistory();

    // Debounce save history to persistent storage (1 second)
    if (historySaveTimer) clearTimeout(historySaveTimer);
    historySaveTimer = setTimeout(() => {
        ipcRenderer.invoke('session.savePromptHistory', promptHistory);
    }, 1000);

    // Save last prompt per project
    if (currentProject) {
        ipcRenderer.invoke('session.saveLastPrompt', {
            projectId: currentProject.id,
            prompt: text
        });
    }
}

function renderPromptHistory() {
    const list = document.getElementById('prompt-history-list');
    if (!list) return;

    if (promptHistory.length === 0) {
        list.innerHTML = '<div class="history-empty">No prompts yet</div>';
        return;
    }

    list.innerHTML = '';
    promptHistory.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'history-item';

        const time = new Date(entry.timestamp);
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const displayText = entry.text.length > 120 ? entry.text.substring(0, 120) + '…' : entry.text;

        item.innerHTML = `
            <div class="history-item-text">${escapeHtml(displayText)}</div>
            <div class="history-item-meta">
                <span class="history-project">${escapeHtml(entry.project)}</span>
                <span class="history-time">${timeStr}</span>
            </div>
        `;

        item.title = 'Click to enqueue';
        item.onclick = async () => {
            if (currentProject) {
                const e = termPool.get(currentProject.id);
                if (e && e.isAlive) {
                    await ipcRenderer.invoke('queue.enqueue', {
                        projectId: currentProject.id,
                        projectName: currentProject.name,
                        text: entry.text
                    });
                    showToast('Task queued from history', 'info');
                }
            }
        };
        list.appendChild(item);
    });
}

function clearHistory() {
    promptHistory = [];
    renderPromptHistory();
    ipcRenderer.invoke('session.savePromptHistory', []);
}

// ===================================================================
//  Status
// ===================================================================

function updateStatus(status, text) {
    const indicator = document.getElementById('statusIndicator');
    if (!indicator) return;
    const dot = indicator.querySelector('.status-dot');
    const statusText = indicator.querySelector('.status-text');
    if (dot) dot.className = 'status-dot ' + status;
    if (statusText) statusText.textContent = text;
}

// ===================================================================
//  Project Management
// ===================================================================

async function loadProjects() {
    projects = await ipcRenderer.invoke('get-projects');
    renderProjects();
}

function renderProjects() {
    const list = document.getElementById('projectsList');
    list.innerHTML = '';

    if (projects.length === 0) {
        list.innerHTML = '<div class="empty-state">Click + to add a project</div>';
        return;
    }

    projects.forEach(project => {
        const item = document.createElement('div');
        item.className = 'project-item';
        item.id = `project-item-${project.id}`;
        if (currentProject && currentProject.id === project.id) {
            item.classList.add('active');
        }

        const gitBadge = project.hasGit ? '<span class="git-badge">Git</span>' : '';

        const poolEntry = termPool.get(project.id);
        const isAlive = poolEntry && poolEntry.isAlive;
        // Only show "working" when there is an actual running task for this project
        const hasRunningTask = taskQueue.some(t => t.status === 'running' && t.projectId === project.id);
        const isWorking = isAlive && hasRunningTask;
        const runningDot = isAlive
            ? '<span class="running-dot" title="CLI running">●</span>'
            : '';
        const workingBadge = isWorking
            ? '<span class="working-badge" title="Working...">WORKING</span>'
            : '';

        if (isWorking) {
            item.classList.add('working');
        }

        item.innerHTML = `
            <div class="project-item-header">
                <div class="project-item-name">${runningDot} ${escapeHtml(project.name)}</div>
                ${workingBadge}
                ${gitBadge}
            </div>
            ${project.description ? `<div class="project-item-desc">${escapeHtml(project.description)}</div>` : ''}
            <div class="project-item-path">${escapeHtml(project.path)}</div>
            <div class="project-item-actions">
                <button onclick="event.stopPropagation(); deleteProject('${project.id}')">🗑️</button>
            </div>
        `;

        item.onclick = () => selectProject(project.id);
        list.appendChild(item);
    });
}

// Update sidebar project item working state without full re-render
function updateProjectWorkingState(projectId, isWorking) {
    const item = document.getElementById(`project-item-${projectId}`);
    if (!item) return;

    if (isWorking) {
        if (!item.classList.contains('working')) {
            item.classList.add('working');
            // Add working badge if not present
            const header = item.querySelector('.project-item-header');
            if (header && !header.querySelector('.working-badge')) {
                const badge = document.createElement('span');
                badge.className = 'working-badge';
                badge.title = 'Working...';
                badge.textContent = 'Working';
                // Insert after project-item-name
                const nameEl = header.querySelector('.project-item-name');
                if (nameEl && nameEl.nextSibling) {
                    header.insertBefore(badge, nameEl.nextSibling);
                } else {
                    header.appendChild(badge);
                }
            }
        }
    } else {
        item.classList.remove('working');
        const badge = item.querySelector('.working-badge');
        if (badge) badge.remove();
    }
}

function renderProjectInfo() {
    const info = document.getElementById('currentProjectInfo');
    if (!currentProject) {
        info.innerHTML = '<span class="project-name">Select a project</span>';
        return;
    }
    const gitInfo = currentProject.hasGit
        ? `<span class="git-info">⎇ ${currentProject.branch || 'main'}</span>`
        : '<span class="git-info" style="color:#666;">No Git</span>';

    info.innerHTML = `
        <div>
            <div class="project-name">${escapeHtml(currentProject.name)} ${gitInfo}</div>
            <div class="project-path">${escapeHtml(currentProject.path)}</div>
        </div>
    `;
}

async function deleteProject(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    if (!window.confirm(`Delete project "${project.name}"?\n\n(Removes from list only, not from disk.)`)) return;

    await ipcRenderer.invoke('delete-project', projectId);

    const entry = termPool.get(projectId);
    if (entry) {
        entry.term.dispose();
        entry.wrapperEl.remove();
        termPool.delete(projectId);
    }

    if (currentProject && currentProject.id === projectId) {
        currentProject = null;
        renderProjectInfo();
        const placeholder = document.getElementById('terminalPlaceholder');
        if (placeholder) placeholder.style.display = 'flex';
        updateStatus('disconnected', 'No Project');
    }

    await loadProjects();

    if (!currentProject && projects.length > 0) {
        selectProject(projects[0].id);
    }
}

// ===================================================================
//  Modals
// ===================================================================

function addProject() { showModal('addProjectModal'); }

function openSettings() {
    Promise.all([
        ipcRenderer.invoke('get-settings'),
        ipcRenderer.invoke('autoFix.getSettings'),
        ipcRenderer.invoke('autoRestart.getSettings'),
        ipcRenderer.invoke('healthCheck.getSettings')
    ]).then(([s, af, ar, hc]) => {
        document.getElementById('defaultClaudeArgs').value = s.defaultClaudeArgs || '';
        document.getElementById('shellPath').value = s.shellPath || '';
        document.getElementById('termFontSize').value = s.fontSize || 14;
        document.getElementById('autoFixCooldown').value = af.cooldown || 30;
        document.getElementById('autoFixTemplateText').value = af.template || 'CRITICAL ERROR DETECTED: [{label}] {error}\nFix the root cause completely.';
        document.getElementById('autoFixMaxRetries').value = af.maxRetries || 3;
        document.getElementById('autoRestartMaxRetriesInput').value = ar.maxRetries || 3;
        document.getElementById('autoRestartRateWindow').value = ar.rateWindow || 5;
        document.getElementById('healthCheckEnabled').checked = hc.enabled;
        document.getElementById('healthCheckInterval').value = hc.intervalHours || 24;
        document.getElementById('healthCheckAutoFix').checked = hc.autoFixOnError !== false;
        showModal('settingsModal');
    });
}

function showModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

async function selectProjectFolder() {
    const p = await ipcRenderer.invoke('select-folder');
    if (p) document.getElementById('projectPath').value = p;
}

async function saveProject() {
    const name = document.getElementById('projectName').value.trim();
    const projectPath = document.getElementById('projectPath').value.trim();
    const description = document.getElementById('projectDesc').value.trim();
    const claudeArgs = document.getElementById('projectClaudeArgs').value.trim();

    if (!name || !projectPath) { alert('Please enter a name and select a folder.'); return; }

    const result = await ipcRenderer.invoke('add-project', { name, path: projectPath, description, claudeArgs });

    if (result.success) {
        closeModal('addProjectModal');
        document.getElementById('projectName').value = '';
        document.getElementById('projectPath').value = '';
        document.getElementById('projectDesc').value = '';
        document.getElementById('projectClaudeArgs').value = '';
        await loadProjects();
        selectProject(result.project.id);
    } else {
        alert('Failed: ' + result.error);
    }
}

async function saveSettings() {
    const defaultClaudeArgs = document.getElementById('defaultClaudeArgs').value.trim();
    const shellPath = document.getElementById('shellPath').value.trim();
    const fontSize = parseInt(document.getElementById('termFontSize').value, 10) || 14;

    // Auto-Fix settings
    const autoFixCooldown = parseInt(document.getElementById('autoFixCooldown').value, 10) || 30;
    const autoFixTemplateText = document.getElementById('autoFixTemplateText').value.trim() || 'CRITICAL ERROR DETECTED: [{label}] {error}\nFix the root cause completely.';
    const autoFixMaxRetries = parseInt(document.getElementById('autoFixMaxRetries').value, 10) || 3;

    // Auto-Restart settings
    const arMaxRetries = parseInt(document.getElementById('autoRestartMaxRetriesInput').value, 10) || 3;
    const arRateWindow = parseInt(document.getElementById('autoRestartRateWindow').value, 10) || 5;

    await ipcRenderer.invoke('save-settings', { defaultClaudeArgs, shellPath, fontSize });
    await ipcRenderer.invoke('autoFix.setSettings', {
        cooldown: autoFixCooldown,
        template: autoFixTemplateText,
        maxRetries: autoFixMaxRetries
    });
    await ipcRenderer.invoke('autoRestart.setSettings', {
        maxRetries: arMaxRetries,
        rateWindow: arRateWindow
    });

    // Health Check settings
    const hcEnabled = document.getElementById('healthCheckEnabled').checked;
    const hcInterval = parseInt(document.getElementById('healthCheckInterval').value, 10) || 24;
    const hcAutoFix = document.getElementById('healthCheckAutoFix').checked;
    await ipcRenderer.invoke('healthCheck.setSettings', {
        enabled: hcEnabled,
        intervalHours: hcInterval,
        autoFixOnError: hcAutoFix
    });

    closeModal('settingsModal');

    for (const [, entry] of termPool) {
        entry.term.options.fontSize = fontSize;
    }

    if (currentProject) {
        const entry = termPool.get(currentProject.id);
        if (entry) fitEntry(entry);
    }
}

// ===================================================================
//  Automation Tab Switching
// ===================================================================

function switchAutoTab(tabName) {
    document.querySelectorAll('.auto-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auto-tab-content').forEach(c => c.classList.remove('active'));

    const tab = document.querySelector(`.auto-tab[data-tab="${tabName}"]`);
    const content = document.getElementById(`tab-${tabName}`);
    if (tab) tab.classList.add('active');
    if (content) content.classList.add('active');
}

// ===================================================================
//  Templates — CRUD
// ===================================================================

async function loadTemplates() {
    templates = await ipcRenderer.invoke('templates.get');
    renderTemplates();
}

function renderTemplates() {
    const list = document.getElementById('templatesList');
    if (!list) return;

    if (templates.length === 0) {
        list.innerHTML = '<div class="history-empty">No templates yet</div>';
        return;
    }

    list.innerHTML = '';
    templates.forEach(tmpl => {
        const item = document.createElement('div');
        item.className = 'template-item';
        const catClass = tmpl.category || 'general';
        const displayText = tmpl.text.length > 60 ? tmpl.text.substring(0, 60) + '…' : tmpl.text;

        item.innerHTML = `
            <div class="template-item-header">
                <span class="template-item-name">${escapeHtml(tmpl.name)}<span class="template-category-badge ${catClass}">${catClass}</span></span>
                <div class="template-item-actions">
                    <button onclick="event.stopPropagation(); editTemplate('${tmpl.id}')" title="Edit">✏️</button>
                    <button onclick="event.stopPropagation(); deleteTemplate('${tmpl.id}')" title="Delete">🗑️</button>
                </div>
            </div>
            <div class="template-item-text">${escapeHtml(displayText)}</div>
        `;

        item.onclick = () => executeTemplate(tmpl);
        item.title = 'Click to execute';
        list.appendChild(item);
    });
}

function showTemplateModal(tmpl) {
    editingTemplateId = tmpl ? tmpl.id : null;
    document.getElementById('templateModalTitle').textContent = tmpl ? 'Edit Template' : 'New Template';
    document.getElementById('tmplName').value = tmpl ? tmpl.name : '';
    document.getElementById('tmplCategory').value = tmpl ? (tmpl.category || 'general') : 'general';
    document.getElementById('tmplText').value = tmpl ? tmpl.text : '';
    showModal('templateModal');
}

async function saveTemplate() {
    const name = document.getElementById('tmplName').value.trim();
    const category = document.getElementById('tmplCategory').value;
    const text = document.getElementById('tmplText').value.trim();

    if (!name || !text) { alert('Name and prompt text are required.'); return; }

    const template = {
        id: editingTemplateId || '',
        name,
        category,
        text
    };

    await ipcRenderer.invoke('templates.save', template);
    closeModal('templateModal');
    await loadTemplates();
    showToast(`Template "${name}" saved`, 'success');
}

function editTemplate(id) {
    const tmpl = templates.find(t => t.id === id);
    if (tmpl) showTemplateModal(tmpl);
}

async function deleteTemplate(id) {
    if (!confirm('Delete this template?')) return;
    await ipcRenderer.invoke('templates.delete', id);
    await loadTemplates();
    showToast('Template deleted', 'info');
}

async function executeTemplate(tmpl) {
    const targetProject = currentProject;
    if (!targetProject) {
        showToast('Select a project first', 'error');
        return;
    }
    const entry = termPool.get(targetProject.id);
    if (!entry || !entry.isAlive) {
        showToast('Terminal not running', 'error');
        return;
    }

    // Enqueue the template as a task via IPC
    await ipcRenderer.invoke('queue.enqueue', {
        projectId: targetProject.id,
        projectName: targetProject.name,
        text: tmpl.text
    });

    addActivity('task', `Template queued: "${tmpl.name}"`, targetProject.name);
    showToast(`Template "${tmpl.name}" queued`, 'success');
}

// ===================================================================
//  (Batch system removed — replaced by unified Task Queue below)
// ===================================================================

// ===================================================================
//  Send to All Projects
// ===================================================================

function sendToAllProjects() {
    showModal('sendAllModal');
}

async function executeSendToAll() {
    const text = document.getElementById('sendAllText').value.trim();
    if (!text) { alert('Enter a command.'); return; }

    const result = await ipcRenderer.invoke('terminal.sendToAll', { text });
    closeModal('sendAllModal');
    document.getElementById('sendAllText').value = '';
    showToast(`Command sent to ${result.sent} project(s)`, 'success');
}

// ===================================================================
//  Schedules — CRUD
// ===================================================================

async function loadSchedules() {
    schedules = await ipcRenderer.invoke('schedules.get');
    renderSchedules();
}

function renderSchedules() {
    const list = document.getElementById('scheduleList');
    if (!list) return;

    if (schedules.length === 0) {
        list.innerHTML = '<div class="history-empty">No schedules yet</div>';
        return;
    }

    list.innerHTML = '';
    schedules.forEach(sched => {
        const item = document.createElement('div');
        item.className = 'schedule-item';
        const statusText = sched.enabled ? 'Active' : 'Disabled';
        const statusColor = sched.enabled ? '#48bb78' : '#5a6d8a';
        const displayCmd = sched.command.length > 50 ? sched.command.substring(0, 50) + '…' : sched.command;

        item.innerHTML = `
            <div class="schedule-item-header">
                <span class="schedule-item-name">${escapeHtml(sched.name)}</span>
                <span class="schedule-item-meta" style="color:${statusColor}">${statusText} · ${sched.intervalMinutes || 60}min</span>
            </div>
            <div class="schedule-item-command">${escapeHtml(displayCmd)}</div>
            <div class="schedule-item-actions">
                <button onclick="toggleSchedule('${sched.id}')">${sched.enabled ? '⏸ Disable' : '▶ Enable'}</button>
                <button onclick="editSchedule('${sched.id}')">✏️ Edit</button>
                <button onclick="deleteSchedule('${sched.id}')">🗑️</button>
            </div>
        `;

        list.appendChild(item);
    });
}

function showScheduleModal(sched) {
    editingScheduleId = sched ? sched.id : null;
    document.getElementById('scheduleModalTitle').textContent = sched ? 'Edit Schedule' : 'New Schedule';
    document.getElementById('schedName').value = sched ? sched.name : '';
    document.getElementById('schedCommand').value = sched ? sched.command : '';
    document.getElementById('schedInterval').value = sched ? (sched.intervalMinutes || 60) : 60;
    document.getElementById('schedEnabled').checked = sched ? sched.enabled : true;
    showModal('scheduleModal');
}

async function saveSchedule() {
    const name = document.getElementById('schedName').value.trim();
    const command = document.getElementById('schedCommand').value.trim();
    const intervalMinutes = parseInt(document.getElementById('schedInterval').value, 10) || 60;
    const enabled = document.getElementById('schedEnabled').checked;

    if (!name || !command) { alert('Name and command are required.'); return; }

    if (!currentProject) { alert('Select a project first.'); return; }

    const schedule = {
        id: editingScheduleId || '',
        name,
        command,
        intervalMinutes,
        enabled,
        projectId: currentProject.id
    };

    await ipcRenderer.invoke('schedules.save', schedule);
    closeModal('scheduleModal');
    await loadSchedules();
    showToast(`Schedule "${name}" saved`, 'success');
}

function editSchedule(id) {
    const sched = schedules.find(s => s.id === id);
    if (sched) showScheduleModal(sched);
}

async function toggleSchedule(id) {
    const sched = schedules.find(s => s.id === id);
    if (!sched) return;
    sched.enabled = !sched.enabled;
    await ipcRenderer.invoke('schedules.save', sched);
    await loadSchedules();
    showToast(`Schedule "${sched.name}" ${sched.enabled ? 'enabled' : 'disabled'}`, 'info');
}

async function deleteSchedule(id) {
    if (!confirm('Delete this schedule?')) return;
    await ipcRenderer.invoke('schedules.delete', id);
    await loadSchedules();
    showToast('Schedule deleted', 'info');
}

// ===================================================================
//  Error Detection
// ===================================================================

async function loadErrorDetectionState() {
    const enabled = await ipcRenderer.invoke('errorDetection.getEnabled');
    const toggle = document.getElementById('errorDetectionToggle');
    if (toggle) toggle.checked = enabled;

    // Load auto-fix state
    const afSettings = await ipcRenderer.invoke('autoFix.getSettings');
    autoFixEnabled = afSettings.enabled;
    const afToggle = document.getElementById('autoFixToggle');
    if (afToggle) afToggle.checked = autoFixEnabled;
}

async function toggleErrorDetection(enabled) {
    await ipcRenderer.invoke('errorDetection.setEnabled', enabled);
    showToast(`Error detection ${enabled ? 'enabled' : 'disabled'}`, 'info');
}

async function toggleAutoFix(enabled) {
    autoFixEnabled = enabled;
    await ipcRenderer.invoke('autoFix.setEnabled', enabled);
    showToast(`Auto-fix ${enabled ? 'enabled' : 'disabled'}`, 'info');
}

function renderErrorLog() {
    const list = document.getElementById('errorLogList');
    if (!list) return;

    if (errorLog.length === 0) {
        list.innerHTML = '<div class="history-empty">No errors detected</div>';
        return;
    }

    list.innerHTML = '';
    errorLog.forEach(err => {
        const item = document.createElement('div');
        item.className = 'error-log-item';

        const time = new Date(err.timestamp);
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const autoFixBadge = err.autoFixed
            ? '<span class="auto-fix-badge fixed">Auto-fixed</span>'
            : '';

        item.innerHTML = `
            <div class="error-log-label">${escapeHtml(err.label)} — ${escapeHtml(err.projectName)} ${autoFixBadge}</div>
            <div class="error-log-line">${escapeHtml(err.line)}</div>
            <div class="error-log-time">${timeStr}</div>
        `;

        list.appendChild(item);
    });
}

function clearErrorLog() {
    errorLog = [];
    renderErrorLog();
    showToast('Error log cleared', 'info');
}

// ===================================================================
//  Auto-Restart
// ===================================================================

async function loadAutoRestartState() {
    const settings = await ipcRenderer.invoke('autoRestart.getSettings');
    autoRestartEnabled = settings.enabled;

    const arToggle = document.getElementById('autoRestartToggle');
    if (arToggle) arToggle.checked = autoRestartEnabled;
    const arResend = document.getElementById('autoRestartResendToggle');
    if (arResend) arResend.checked = settings.resendPrompt;
}

async function toggleAutoRestart(enabled) {
    autoRestartEnabled = enabled;
    await ipcRenderer.invoke('autoRestart.setSettings', { enabled });
    showToast(`Auto-restart ${enabled ? 'enabled' : 'disabled'}`, 'info');
}

async function toggleAutoRestartResend(enabled) {
    await ipcRenderer.invoke('autoRestart.setSettings', { resendPrompt: enabled });
    showToast(`Prompt re-send ${enabled ? 'enabled' : 'disabled'}`, 'info');
}

// ===================================================================
//  Auto-Approve — plan prompt auto-response
// ===================================================================

async function loadAutoApproveState() {
    const settings = await ipcRenderer.invoke('autoApprove.getSettings');
    autoApproveEnabled = settings.enabled;
    const toggle = document.getElementById('autoApproveToggle');
    if (toggle) toggle.checked = autoApproveEnabled;
}

async function toggleAutoApprove(enabled) {
    autoApproveEnabled = enabled;
    await ipcRenderer.invoke('autoApprove.setSettings', { enabled });
    showToast(`Auto-approve ${enabled ? 'enabled' : 'disabled'}`, 'info');
}

// (Auto-approve notification moved to bottom — integrated with Activity log)

// (Auto-restart notifications moved to bottom — integrated with Activity log)

// (All auto-restart handlers moved to bottom — integrated with Activity log)

// ===================================================================
//  Health Check
// ===================================================================

async function loadHealthCheckState() {
    const settings = await ipcRenderer.invoke('healthCheck.getSettings');
    healthCheckChecks = settings.checks || [];
    healthCheckHistory = await ipcRenderer.invoke('healthCheck.getHistory');

    const status = await ipcRenderer.invoke('healthCheck.isRunning');
    healthCheckRunning = status.running;

    renderHealthCheckDashboard();
    renderHealthCheckChecks();
}

async function runHealthCheckNow(projectId) {
    if (healthCheckRunning) {
        showToast('Health check already running', 'error');
        return;
    }
    if (queueRunning) {
        showToast('Cannot run health check while queue is running', 'error');
        return;
    }

    const opts = projectId ? { projectId } : {};
    const result = await ipcRenderer.invoke('healthCheck.run', opts);
    if (result.success) {
        healthCheckRunning = true;
        renderHealthCheckDashboard();
        showToast(`Health check started: ${result.totalSteps} steps`, 'info');
    } else {
        showToast(`Health check failed: ${result.error}`, 'error');
    }
}

async function stopHealthCheckNow() {
    await ipcRenderer.invoke('healthCheck.stop');
    healthCheckRunning = false;
    renderHealthCheckDashboard();
    showToast('Health check stopped', 'info');
}

async function clearHealthCheckHistory() {
    if (!confirm('Clear all health check history?')) return;
    await ipcRenderer.invoke('healthCheck.clearHistory');
    healthCheckHistory = [];
    renderHealthCheckDashboard();
    showToast('Health check history cleared', 'info');
}

async function toggleHealthCheck(checkId, enabled) {
    const check = healthCheckChecks.find(c => c.id === checkId);
    if (check) {
        check.enabled = enabled;
        await ipcRenderer.invoke('healthCheck.setChecks', healthCheckChecks);
        renderHealthCheckChecks();
    }
}

function renderHealthCheckDashboard() {
    const dashboard = document.getElementById('healthCheckDashboard');
    if (!dashboard) return;

    // Running status
    const statusEl = document.getElementById('healthCheckStatus');
    if (statusEl) {
        if (healthCheckRunning) {
            statusEl.innerHTML = '<span class="hc-status-badge running">Running...</span>';
        } else {
            const lastRun = healthCheckHistory.length > 0 ? healthCheckHistory[0] : null;
            if (lastRun) {
                const time = new Date(lastRun.timestamp);
                const timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const s = lastRun.summary;
                const statusClass = s.failed > 0 || s.errors > 0 ? 'fail' : 'pass';
                statusEl.innerHTML = `
                    <span class="hc-status-badge ${statusClass}">${s.passed} Pass / ${s.failed} Fail / ${s.errors} Error</span>
                    <span class="hc-last-run">Last: ${timeStr}</span>
                `;
            } else {
                statusEl.innerHTML = '<span class="hc-status-badge idle">No runs yet</span>';
            }
        }
    }

    // Run/Stop buttons
    const runBtn = document.getElementById('healthCheckRunBtn');
    const stopBtn = document.getElementById('healthCheckStopBtn');
    if (runBtn) runBtn.style.display = healthCheckRunning ? 'none' : '';
    if (stopBtn) stopBtn.style.display = healthCheckRunning ? '' : 'none';

    // Results list
    renderHealthCheckResults();
}

function renderHealthCheckResults() {
    const list = document.getElementById('healthCheckResultsList');
    if (!list) return;

    if (healthCheckHistory.length === 0) {
        list.innerHTML = '<div class="history-empty">No health check results yet. Click "Run Now" to start.</div>';
        return;
    }

    list.innerHTML = '';

    // Show latest run results
    const latestRun = healthCheckHistory[0];
    if (!latestRun || !latestRun.results) return;

    // Group by project
    const byProject = {};
    latestRun.results.forEach(r => {
        if (!byProject[r.projectName]) byProject[r.projectName] = [];
        byProject[r.projectName].push(r);
    });

    Object.keys(byProject).forEach(projectName => {
        const projectHeader = document.createElement('div');
        projectHeader.className = 'hc-project-header';
        const projectResults = byProject[projectName];
        const projectPassed = projectResults.filter(r => r.status === 'pass').length;
        const projectFailed = projectResults.filter(r => r.status !== 'pass').length;
        const projectStatusClass = projectFailed > 0 ? 'fail' : 'pass';

        projectHeader.innerHTML = `
            <span class="hc-project-name">${escapeHtml(projectName)}</span>
            <span class="hc-project-summary ${projectStatusClass}">${projectPassed}/${projectResults.length} passed</span>
        `;
        list.appendChild(projectHeader);

        projectResults.forEach(r => {
            const item = document.createElement('div');
            item.className = `hc-result-item ${r.status}`;

            const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✕' : '⚠';
            const durationStr = r.duration ? `${Math.round(r.duration / 1000)}s` : '—';

            item.innerHTML = `
                <span class="hc-result-icon ${r.status}">${icon}</span>
                <div class="hc-result-info">
                    <span class="hc-result-name">${escapeHtml(r.checkName)}</span>
                    <span class="hc-result-msg">${escapeHtml(r.message || '')}</span>
                </div>
                <span class="hc-result-duration">${durationStr}</span>
            `;
            list.appendChild(item);
        });
    });

    // History summary (older runs)
    if (healthCheckHistory.length > 1) {
        const historyHeader = document.createElement('div');
        historyHeader.className = 'hc-history-header';
        historyHeader.textContent = 'Previous Runs';
        list.appendChild(historyHeader);

        healthCheckHistory.slice(1, 10).forEach(run => {
            const item = document.createElement('div');
            item.className = 'hc-history-item';
            const time = new Date(run.timestamp);
            const timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const s = run.summary;
            const statusClass = s.failed > 0 || s.errors > 0 ? 'fail' : 'pass';

            item.innerHTML = `
                <span class="hc-history-time">${timeStr}</span>
                <span class="hc-status-badge small ${statusClass}">${s.passed}P / ${s.failed}F / ${s.totalErrors}E</span>
            `;
            list.appendChild(item);
        });
    }
}

function renderHealthCheckChecks() {
    const list = document.getElementById('healthCheckChecksList');
    if (!list) return;

    list.innerHTML = '';
    healthCheckChecks.forEach(check => {
        const item = document.createElement('div');
        item.className = 'hc-check-item';

        item.innerHTML = `
            <label class="toggle-label">
                <input type="checkbox" ${check.enabled ? 'checked' : ''}
                    onchange="toggleHealthCheck('${check.id}', this.checked)">
                <span class="hc-check-name">${escapeHtml(check.name)}</span>
            </label>
            <div class="hc-check-desc">${escapeHtml(check.description)}</div>
        `;
        list.appendChild(item);
    });
}

// (Health check handlers moved to bottom — integrated with Activity log + Dashboard)

// ===================================================================
//  Security Checks
// ===================================================================

const defaultSecurityChecks = [
    {
        id: 'vuln-scan',
        name: 'Vulnerability Scan',
        description: 'Run a vulnerability check on the project codebase',
        command: 'Review this project for common security vulnerabilities (XSS, SQL injection, command injection, insecure dependencies). List any issues found with file paths and line numbers.'
    },
    {
        id: 'dep-audit',
        name: 'Dependency Audit',
        description: 'Check for outdated or vulnerable npm dependencies',
        command: 'Run npm audit and analyze the results. List any high or critical vulnerabilities in dependencies and suggest fixes.'
    },
    {
        id: 'secret-scan',
        name: 'Secret Scanner',
        description: 'Scan for exposed secrets, API keys, and credentials',
        command: 'Scan all files in this project for exposed secrets, API keys, passwords, tokens, and credentials. Check .env files, config files, and source code. Report any findings.'
    }
];

function renderSecurityChecks() {
    const list = document.getElementById('securityList');
    if (!list) return;

    list.innerHTML = '';
    defaultSecurityChecks.forEach(check => {
        const item = document.createElement('div');
        item.className = 'security-item';

        item.innerHTML = `
            <div class="security-item-header">
                <span class="security-item-name">${escapeHtml(check.name)}</span>
            </div>
            <div class="security-item-desc">${escapeHtml(check.description)}</div>
            <div class="security-item-controls">
                <button onclick="runSecurityCheck('${check.id}')">▶ Run Now</button>
            </div>
        `;

        list.appendChild(item);
    });
}

async function runSecurityCheck(checkId) {
    const check = defaultSecurityChecks.find(c => c.id === checkId);
    if (!check) return;

    const targetProject = currentProject;
    if (!targetProject) {
        showToast('Select a project first', 'error');
        return;
    }
    const entry = termPool.get(targetProject.id);
    if (!entry || !entry.isAlive) {
        showToast('Terminal not running', 'error');
        return;
    }

    // Enqueue security check as a task via IPC
    await ipcRenderer.invoke('queue.enqueue', {
        projectId: targetProject.id,
        projectName: targetProject.name,
        text: check.command
    });

    addActivity('task', `Security check queued: "${check.name}"`, targetProject.name);
    showToast(`Security check "${check.name}" queued`, 'info');
}

// ===================================================================
//  Utilities
// ===================================================================

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===================================================================
//  Dashboard — Live Metrics
// ===================================================================

function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function renderDashboard() {
    const hasChecked = dashboardStats.lastCheckTime !== null;
    const timeAgo = hasChecked ? formatTimeAgo(dashboardStats.lastCheckTime) : null;

    // --- 현재 프로젝트의 PTY/큐 상태 체크 ---
    let ptyAlive = false;
    let hasRunning = false;
    let hasPending = false;
    let totalTasks = taskQueue.length;
    let doneTasks = 0;

    if (currentProject) {
        const entry = termPool.get(currentProject.id);
        ptyAlive = !!(entry && entry.isAlive);
        hasRunning = taskQueue.some(t => t.status === 'running' && t.projectId === currentProject.id);
        hasPending = taskQueue.some(t => t.status === 'pending' && t.projectId === currentProject.id);
        doneTasks = taskQueue.filter(t => t.status === 'done').length;
    }

    // Terminal Status — PTY 상태에 따라 정확히 표시
    const termStatusEl = document.getElementById('terminalStatus');
    if (termStatusEl && currentProject) {
        if (!ptyAlive) {
            termStatusEl.textContent = 'Disconnected';
        } else if (hasRunning) {
            termStatusEl.textContent = 'Working...';
        } else if (hasPending) {
            termStatusEl.textContent = 'Queued';
        } else if (queuePaused) {
            termStatusEl.textContent = 'Paused';
        } else {
            termStatusEl.textContent = 'Ready';
        }
    }

    // Error count
    const errEl = document.getElementById('dashErrorCount');
    const errCard = document.getElementById('dashCardErrors');
    const errSub = document.getElementById('dashErrorSub');
    if (errEl) errEl.textContent = dashboardStats.errors;
    if (errCard) {
        errCard.classList.remove('unchecked');
        errCard.classList.toggle('error', dashboardStats.errors > 0);
        errCard.classList.toggle('success', dashboardStats.errors === 0);
    }
    if (errSub) errSub.textContent = dashboardStats.errors === 0 ? 'no issues' : `${dashboardStats.errors} detected`;

    // Build
    const buildEl = document.getElementById('dashBuildStatus');
    const buildCard = document.getElementById('dashCardBuild');
    const buildSub = document.getElementById('dashBuildSub');
    if (buildEl) buildEl.textContent = dashboardStats.build;
    if (buildCard) {
        buildCard.classList.toggle('success', dashboardStats.build === 'Pass');
        buildCard.classList.toggle('error', dashboardStats.build === 'Fail');
        buildCard.classList.toggle('unchecked', !hasChecked);
    }
    if (buildSub) buildSub.textContent = hasChecked ? timeAgo : 'run health check';

    // Security
    const secEl = document.getElementById('dashSecurityScore');
    const secCard = document.getElementById('dashCardSecurity');
    const secSub = document.getElementById('dashSecuritySub');
    if (secEl) secEl.textContent = dashboardStats.security;
    if (secCard) {
        secCard.classList.toggle('success', dashboardStats.security === 'OK');
        secCard.classList.toggle('error', dashboardStats.security === 'Issues');
        secCard.classList.toggle('unchecked', !hasChecked);
    }
    if (secSub) secSub.textContent = hasChecked ? timeAgo : 'run health check';

    // Health
    const hpEl = document.getElementById('dashHealthStatus');
    const hpCard = document.getElementById('dashCardHealth');
    const hpSub = document.getElementById('dashHealthSub');
    if (hpEl) hpEl.textContent = dashboardStats.health;
    if (hpCard) {
        hpCard.classList.toggle('success', dashboardStats.health === 'Pass');
        hpCard.classList.toggle('error', dashboardStats.health === 'Fail');
        hpCard.classList.toggle('unchecked', !hasChecked);
    }
    if (hpSub) hpSub.textContent = hasChecked ? timeAgo : 'click to run';

    // Automation badges — 현재 PTY 상태에 따라 활성/비활성 구분
    updateBadge('badgeAutoFix', autoFixEnabled, ptyAlive);
    updateBadge('badgeAutoApprove', autoApproveEnabled, ptyAlive);
    updateBadge('badgeAutoRestart', autoRestartEnabled, ptyAlive);
    updateBadge('badgeAutoVerify', autoVerifyEnabled, ptyAlive);
}

function updateBadge(id, enabled, ptyAlive) {
    const el = document.getElementById(id);
    if (!el) return;
    // 3가지 상태 구분: on(활성), off(비활성), inactive(설정은 ON이지만 PTY 없음)
    const isActive = enabled && (ptyAlive !== false); // ptyAlive 미전달 시 기존 동작 유지
    el.classList.toggle('on', isActive);
    el.classList.toggle('off', !enabled);
    el.classList.toggle('inactive', enabled && ptyAlive === false);
}

async function toggleBadge(feature) {
    if (feature === 'autoFix') {
        autoFixEnabled = !autoFixEnabled;
        await ipcRenderer.invoke('autoFix.setEnabled', autoFixEnabled);
        addActivity('info', `Auto-fix ${autoFixEnabled ? 'enabled' : 'disabled'}`);
    } else if (feature === 'autoApprove') {
        autoApproveEnabled = !autoApproveEnabled;
        await ipcRenderer.invoke('autoApprove.setSettings', { enabled: autoApproveEnabled });
        addActivity('info', `Auto-approve ${autoApproveEnabled ? 'enabled' : 'disabled'}`);
    } else if (feature === 'autoRestart') {
        autoRestartEnabled = !autoRestartEnabled;
        await ipcRenderer.invoke('autoRestart.setSettings', { enabled: autoRestartEnabled });
        addActivity('info', `Auto-restart ${autoRestartEnabled ? 'enabled' : 'disabled'}`);
    } else if (feature === 'autoVerify') {
        autoVerifyEnabled = !autoVerifyEnabled;
        await ipcRenderer.invoke('autoVerify.setEnabled', autoVerifyEnabled);
        addActivity('info', `Auto-verify ${autoVerifyEnabled ? 'enabled' : 'disabled'}`);
    }
    renderDashboard();
}

// ===================================================================
//  Automation Defaults — all ON by default
// ===================================================================

async function loadAutomationDefaults() {
    // Error detection always on
    const errEnabled = await ipcRenderer.invoke('errorDetection.getEnabled');
    if (!errEnabled) await ipcRenderer.invoke('errorDetection.setEnabled', true);

    // Auto-fix — load from store, default ON
    const afSettings = await ipcRenderer.invoke('autoFix.getSettings');
    autoFixEnabled = afSettings.enabled;

    // Auto-approve — load from store, default ON
    const apSettings = await ipcRenderer.invoke('autoApprove.getSettings');
    autoApproveEnabled = apSettings.enabled;

    // Auto-restart — load from store, default ON
    const arSettings = await ipcRenderer.invoke('autoRestart.getSettings');
    autoRestartEnabled = arSettings.enabled;
    autoRestartResendPrompt = arSettings.resendPrompt;

    // Auto-verify — load from store, default ON
    const avSettings = await ipcRenderer.invoke('autoVerify.getSettings');
    autoVerifyEnabled = avSettings.enabled;

    // Force all ON on very first run (migrate old settings)
    if (!localStorage.getItem('automationV2Initialized')) {
        autoFixEnabled = true;
        autoApproveEnabled = true;
        autoRestartEnabled = true;
        autoVerifyEnabled = false;
        await ipcRenderer.invoke('autoFix.setEnabled', true);
        await ipcRenderer.invoke('autoApprove.setSettings', { enabled: true });
        await ipcRenderer.invoke('autoRestart.setSettings', { enabled: true, resendPrompt: true });
        await ipcRenderer.invoke('autoVerify.setEnabled', true);
        localStorage.setItem('automationV2Initialized', '1');
    }

    // Load health check history for dashboard
    const hcHistory = await ipcRenderer.invoke('healthCheck.getHistory');
    if (hcHistory && hcHistory.length > 0) {
        const last = hcHistory[0];
        const s = last.summary;
        dashboardStats.health = s.failed > 0 ? 'Fail' : 'Pass';
        dashboardStats.lastCheckTime = last.timestamp || null;
        // Extract build/security from individual results
        if (last.results) {
            const buildResult = last.results.find(r => r.checkId === 'build-check');
            if (buildResult) dashboardStats.build = buildResult.status === 'pass' ? 'Pass' : 'Fail';
            const secResult = last.results.find(r => r.checkId === 'security-audit');
            if (secResult) dashboardStats.security = secResult.status === 'pass' ? 'OK' : 'Issues';
        }
    }

    renderDashboard();
}

// ===================================================================
//  Activity Log — unified automation feed
// ===================================================================

function addActivity(type, message, detail) {
    activityLog.unshift({
        type,       // 'error', 'fix', 'approve', 'health', 'task', 'restart', 'verify', 'info'
        message,
        detail: detail || null,
        timestamp: Date.now()
    });
    if (activityLog.length > MAX_ACTIVITY) activityLog.length = MAX_ACTIVITY;
    renderActivityLog();

    // Update error count for dashboard
    if (type === 'error') {
        dashboardStats.errors++;
        renderDashboard();
    }

    // Flash Activity tab if not active
    const actTab = document.querySelector('.auto-tab[data-tab="activity"]');
    if (actTab && !actTab.classList.contains('active')) {
        actTab.style.color = type === 'error' ? '#f56565' : '#4fc3f7';
        setTimeout(() => { actTab.style.color = ''; }, 2000);
    }
}

function renderActivityLog() {
    const list = document.getElementById('activityList');
    if (!list) return;

    if (activityLog.length === 0) {
        list.innerHTML = '<div class="history-empty">Automation activity will appear here</div>';
        return;
    }

    // Update summary
    const summary = document.getElementById('activitySummary');
    if (summary) {
        const errCount = activityLog.filter(a => a.type === 'error').length;
        const fixCount = activityLog.filter(a => a.type === 'fix').length;
        const verifyCount = activityLog.filter(a => a.type === 'verify').length;
        summary.textContent = `${activityLog.length} events · ${errCount} errors · ${fixCount} fixes · ${verifyCount} verifies`;
    }

    list.innerHTML = '';
    activityLog.forEach(entry => {
        const item = document.createElement('div');
        item.className = `activity-item type-${entry.type}`;

        const time = new Date(entry.timestamp);
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        item.innerHTML = `
            <div class="activity-item-header">
                <span class="activity-type-badge ${entry.type}">${entry.type}</span>
                <span class="activity-item-time">${timeStr}</span>
            </div>
            <div class="activity-item-msg">${escapeHtml(entry.message)}</div>
            ${entry.detail ? `<div class="activity-item-detail">${escapeHtml(entry.detail)}</div>` : ''}
        `;

        list.appendChild(item);
    });
}

function clearActivity() {
    activityLog = [];
    dashboardStats.errors = 0;
    renderActivityLog();
    renderDashboard();
}

// ===================================================================
//  Task Queue — unified queue-based auto-execution
// ===================================================================

function setupTaskInputShortcut() {
    const textarea = document.getElementById('taskInput');
    if (!textarea) return;

    // --- IME 상태 명확 구분 ---
    let _isComposing = false;          // IME 조합 중 여부 (compositionstart/end으로 추적)
    let _enterDuringCompose = false;   // 조합 중 Enter 눌렀는지 여부
    let _composeResetTimer = null;     // 안전 타이머: 지속 활성화 방지

    textarea.addEventListener('compositionstart', () => {
        _isComposing = true;
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (_isComposing || e.isComposing) {
                // 한글 IME 조합 중 Enter → preventDefault 호출하지 않음 (조합 텍스트 커밋 보장)
                _enterDuringCompose = true;
                // 안전장치: 500ms 내에 compositionend가 안 오면 자동 리셋
                if (_composeResetTimer) clearTimeout(_composeResetTimer);
                _composeResetTimer = setTimeout(() => {
                    if (_enterDuringCompose) {
                        _enterDuringCompose = false;
                        _isComposing = false;
                        // Enter로 삽입된 줄바꿈 제거 후 전송
                        textarea.value = textarea.value.replace(/\n+$/, '');
                        sendTask();
                    }
                }, 500);
                return;
            }
            // 조합 중이 아닐 때만 기본동작(줄바꿈) 방지
            e.preventDefault();
            sendTask();
        }
    });

    textarea.addEventListener('compositionend', () => {
        _isComposing = false;
        if (_enterDuringCompose) {
            _enterDuringCompose = false;
            if (_composeResetTimer) { clearTimeout(_composeResetTimer); _composeResetTimer = null; }
            // textarea.value 확정 대기 후 줄바꿈 제거 및 전송
            setTimeout(() => {
                textarea.value = textarea.value.replace(/\n+$/, '');
                sendTask();
            }, 30);
        }
    });

    // blur 시 모든 IME 상태 초기화 (탭 전환 등으로 stuck 방지)
    textarea.addEventListener('blur', () => {
        _isComposing = false;
        _enterDuringCompose = false;
        if (_composeResetTimer) { clearTimeout(_composeResetTimer); _composeResetTimer = null; }
    });

    // Auto-resize textarea as user types
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    });
}

/** Add a task to the queue via IPC to main process. */
async function sendTask() {
    const textarea = document.getElementById('taskInput');
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;

    const targetProject = currentProject;
    if (!targetProject) {
        showToast('Select a project first', 'error');
        return;
    }

    // If files are attached, prepend their paths to the prompt
    const attachedFiles = getAttachedImages();
    let fullText = text;
    if (attachedFiles.length > 0) {
        const pathsList = attachedFiles.map(f => `"${f}"`).join(' ');
        fullText = `[Attached files: ${pathsList}]\n\n${text}`;
        clearAttachedImages();
    }

    textarea.value = '';
    textarea.style.height = 'auto';

    addActivity('task', `Task queued: ${text.substring(0, 80)}${text.length > 80 ? '…' : ''}`, targetProject.name);

    // Ensure PTY is running for the target project
    const entry = termPool.get(targetProject.id);
    if (!entry || !entry.isAlive) {
        showToast('Starting terminal...', 'info');
        await getOrCreateTerminal(targetProject);
        await ensurePtyRunning(targetProject);
    }

    // Enqueue via main process — state update arrives via 'queue.updated' IPC
    await ipcRenderer.invoke('queue.enqueue', {
        projectId: targetProject.id,
        projectName: targetProject.name,
        text: fullText
    });

    // 대시보드 상태 즉시 반영
    renderDashboard();
}

// processQueue() is now handled in main process via TaskQueue.
// The renderer receives state updates via 'queue.updated' IPC.

/** Remove a pending task from the queue via IPC. */
function removeTask(taskId) {
    ipcRenderer.invoke('queue.remove', { taskId }).then(removed => {
        if (!removed) showToast('Can only remove pending tasks', 'error');
    });
}

/** Clear all completed tasks via IPC. */
function clearDoneTasks() {
    ipcRenderer.invoke('queue.clearDone');
}

/** Clear entire queue via IPC. */
function clearAllTasks() {
    ipcRenderer.invoke('queue.clear').then(() => {
        showToast('Queue cleared', 'info');
    });
}

/** Pause / Resume the queue via IPC. */
function toggleQueuePause() {
    if (queuePaused) {
        ipcRenderer.invoke('queue.resume').then(() => {
            showToast('Queue resumed', 'info');
        });
    } else {
        ipcRenderer.invoke('queue.pause').then(() => {
            showToast('Queue paused', 'info');
        });
    }
}

/** Update progress bar UI. */
function updateQueueProgress() {
    const total = taskQueue.length;
    const done = taskQueue.filter(t => t.status === 'done').length;
    const pending = taskQueue.filter(t => t.status === 'pending').length;
    const runningTask = taskQueue.find(t => t.status === 'running');

    const label = document.getElementById('queueLabel');
    const status = document.getElementById('queueStatus');
    const fill = document.getElementById('queueProgressFill');
    const bar = document.getElementById('queueProgressBar');

    // PTY 상태 체크 — pending 태스크가 있는데 PTY가 없으면 표시
    let ptyMissing = false;
    if (pending > 0 && currentProject) {
        const entry = termPool.get(currentProject.id);
        ptyMissing = !entry || !entry.isAlive;
    }

    if (bar) {
        bar.style.display = total > 0 ? 'flex' : 'none';
    }
    if (label) label.textContent = `Queue: ${done}/${total}`;
    if (status) {
        if (queuePaused) status.textContent = 'Paused';
        else if (runningTask) status.textContent = 'Running...';
        else if (pending > 0 && ptyMissing) status.textContent = 'Waiting (starting...)';
        else if (pending > 0) status.textContent = 'Waiting';
        else if (total > 0 && done === total) status.textContent = 'Complete';
        else status.textContent = 'Idle';
    }
    if (fill) fill.style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
}

function renderTaskList() {
    const list = document.getElementById('tasksList');
    if (!list) return;

    if (taskQueue.length === 0) {
        list.innerHTML = '<div class="history-empty">Add tasks to the queue — they will run sequentially</div>';
        return;
    }

    list.innerHTML = '';
    taskQueue.forEach(task => {
        const item = document.createElement('div');
        item.className = `task-item task-${task.status}`;

        const time = new Date(task.timestamp);
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const displayText = task.text.length > 150 ? task.text.substring(0, 150) + '…' : task.text;

        const deleteBtn = task.status === 'pending'
            ? `<button class="task-delete-btn" onclick="event.stopPropagation(); removeTask(${task.id})" title="Remove from queue">✕</button>`
            : '';

        item.innerHTML = `
            <div class="task-item-header">
                <span class="task-status-dot ${task.status}"></span>
                <span class="task-item-status ${task.status}">${task.status}</span>
                <div class="task-action-btns">
                    <button class="task-action-btn task-refill-btn" data-task-id="${task.id}" title="프롬프트에 다시 입력">↩</button>
                    <button class="task-action-btn task-copy-btn" data-task-id="${task.id}" title="복사">⧉</button>
                    ${deleteBtn}
                </div>
            </div>
            <div class="task-item-text">${escapeHtml(displayText)}</div>
            <div class="task-item-meta">
                <span class="history-project">${escapeHtml(task.project)}</span>
                <span class="task-item-time">${timeStr}</span>
            </div>
        `;

        // 재입력 버튼: 프롬프트 textarea에 텍스트 복원
        const refillBtn = item.querySelector('.task-refill-btn');
        if (refillBtn) {
            refillBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const textarea = document.getElementById('taskInput');
                if (textarea) {
                    textarea.value = task.text;
                    textarea.style.height = 'auto';
                    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
                    textarea.focus();
                    showToast('Prompt restored', 'info');
                }
            });
        }

        // 복사 버튼: 클립보드에 텍스트 복사
        const copyBtn = item.querySelector('.task-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(task.text).then(() => {
                    showToast('Copied to clipboard', 'info');
                }).catch(() => {
                    const tmp = document.createElement('textarea');
                    tmp.value = task.text;
                    document.body.appendChild(tmp);
                    tmp.select();
                    document.execCommand('copy');
                    document.body.removeChild(tmp);
                    showToast('Copied to clipboard', 'info');
                });
            });
        }

        list.appendChild(item);
    });
}

// ===================================================================
//  Idle Detection → Queue Advancement
// ===================================================================

ipcRenderer.on('terminal.idle', (event, { projectId }) => {
    idleState.set(projectId, true);
    updateProjectWorkingState(projectId, false);
    renderDashboard(); // idle 전환 시 대시보드 갱신
    // Queue advancement is handled in main process via taskQueue.markIdle()
    // UI will update when 'queue.updated' IPC arrives
});

// Receive queue state updates from main process (TaskQueue.onUpdate)
ipcRenderer.on('queue.updated', (event, state) => {
    const prevRunningIds = new Set(taskQueue.filter(t => t.status === 'running').map(t => t.id));
    taskQueue = state.tasks || [];
    queuePaused = state.paused;
    queueRunning = state.running;

    // Check if any task just completed
    const newDoneIds = taskQueue.filter(t => t.status === 'done').map(t => t.id);
    const justCompleted = newDoneIds.some(id => prevRunningIds.has(id));
    if (justCompleted) {
        playNotificationSound();
    }

    // Check if all tasks completed
    if (taskQueue.length > 0 && taskQueue.every(t => t.status === 'done') && !queueRunning) {
        showToast('All tasks completed', 'success');
    }

    // Update pause button text
    const btn = document.getElementById('queuePauseBtn');
    if (btn) {
        btn.textContent = queuePaused ? '▶ Resume' : '⏸ Pause';
    }

    // Update working state for projects with running tasks
    for (const task of taskQueue) {
        if (task.status === 'running') {
            idleState.set(task.projectId, false);
            updateProjectWorkingState(task.projectId, true);
        }
    }

    renderTaskList();
    updateQueueProgress();
    renderDashboard(); // 큐 상태 변경 시 대시보드도 갱신
});

// Queue restored from previous session (crash/sudden exit recovery)
ipcRenderer.on('queue.restored', (event, { count }) => {
    showToast(`이전 세션에서 ${count}개 작업 복구됨 — 자동 재실행 대기 중`, 'info');
});

// ===================================================================
//  IPC → Activity Log Integration
// ===================================================================

// Errors → activity
ipcRenderer.on('terminal.outputMatch', (event, { projectId, label, pattern, line, timestamp }) => {
    const project = projects.find(p => p.id === projectId);
    const projectName = project ? project.name : projectId;
    addActivity('error', `${label} — ${projectName}`, line.substring(0, 200));
});

// Auto-fix → activity
ipcRenderer.on('autoFix.queued', (event, { projectId, label }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('fix', `Auto-fix queued: ${label} (${project ? project.name : projectId})`);
});
ipcRenderer.on('autoFix.triggered', (event, { projectId, label, line, timestamp }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('fix', `Auto-fix applied: ${label} (${project ? project.name : projectId})`, line.substring(0, 100));
});
ipcRenderer.on('autoFix.maxRetriesReached', (event, { projectId }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('error', `Auto-fix stopped: max retries (${project ? project.name : projectId})`);
});

// Auto-verify → activity
ipcRenderer.on('autoVerify.triggered', (event, { projectId, type, context, timestamp }) => {
    const project = projects.find(p => p.id === projectId);
    const typeLabel = type === 'fix' ? 'Fix verification' : 'Task verification';
    addActivity('verify', `${typeLabel} running (${project ? project.name : projectId})`, context);
});

// Auto-approve → activity
ipcRenderer.on('autoApprove.triggered', (event, { projectId, mode, timestamp }) => {
    const project = projects.find(p => p.id === projectId);
    const modeLabel = mode === 'clear_context' ? 'Yes, clear context' : 'Yes';
    addActivity('approve', `Auto-approved: "${modeLabel}" (${project ? project.name : projectId})`);
});

// Auto-restart → activity
ipcRenderer.on('autoRestart.restarting', (event, { projectId }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('restart', `Restarting: ${project ? project.name : projectId}`);
});
ipcRenderer.on('autoRestart.spawned', (event, { projectId, pid }) => {
    const project = projects.find(p => p.id === projectId);
    const entry = termPool.get(projectId);
    if (entry) {
        entry.isAlive = true;
        entry.term.write(`\r\n\x1b[32m--- Auto-restarted (PID: ${pid}) ---\x1b[0m\r\n`);
    }
    if (currentProject && currentProject.id === projectId) {
        updateStatus('ready', 'Claude CLI Running');
        document.getElementById('terminalStatus').textContent = 'Running';
        document.getElementById('infoPid').textContent = pid || '—';
    }
    renderProjects();
    addActivity('restart', `Restarted: ${project ? project.name : projectId} (PID: ${pid})`);
    // Terminal is back — kick the queue
    setTimeout(() => ipcRenderer.invoke('queue.kick'), 1000);
});
ipcRenderer.on('autoRestart.failed', (event, { projectId, error }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('error', `Restart failed: ${project ? project.name : projectId} — ${error}`);
});
ipcRenderer.on('autoRestart.maxRetriesReached', (event, { projectId }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('error', `Restart stopped: max retries (${project ? project.name : projectId})`);
});
ipcRenderer.on('autoRestart.promptResent', (event, { projectId, prompt }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('task', `Prompt re-sent: ${prompt.substring(0, 60)}… (${project ? project.name : projectId})`);
});

// Health check → activity + dashboard + progress bar
ipcRenderer.on('healthCheck.started', (event, { totalSteps, projects: pNames }) => {
    addActivity('health', `Health check started: ${totalSteps} checks across ${pNames.length} project(s)`);
    // Reset progress bar
    const fill = document.getElementById('hcProgressFill');
    const label = document.getElementById('hcProgressLabel');
    if (fill) fill.style.width = '0%';
    if (label) label.textContent = `0/${totalSteps} checks...`;
});
ipcRenderer.on('healthCheck.stepStarted', (event, { stepIndex, totalSteps, projectName, checkName }) => {
    const fill = document.getElementById('hcProgressFill');
    const label = document.getElementById('hcProgressLabel');
    if (fill) fill.style.width = `${(stepIndex / totalSteps) * 100}%`;
    if (label) label.textContent = `${stepIndex + 1}/${totalSteps}: ${checkName} — ${projectName}`;
});
ipcRenderer.on('healthCheck.stepCompleted', (event, data) => {
    const { projectName, checkName, status, errorsFound, stepIndex, totalSteps } = data;
    addActivity('health', `${checkName}: ${status.toUpperCase()} (${projectName})${errorsFound > 0 ? ` — ${errorsFound} issues` : ''}`);
    // Update progress bar
    const fill = document.getElementById('hcProgressFill');
    const label = document.getElementById('hcProgressLabel');
    const completedIdx = (stepIndex !== undefined ? stepIndex + 1 : 0);
    const total = totalSteps || 1;
    if (fill) fill.style.width = `${(completedIdx / total) * 100}%`;
    if (label) label.textContent = `${completedIdx}/${total} completed`;
});
ipcRenderer.on('healthCheck.completed', (event, { summary, results }) => {
    healthCheckRunning = false;
    // Update progress bar to 100%
    const fill = document.getElementById('hcProgressFill');
    const label = document.getElementById('hcProgressLabel');
    if (fill) fill.style.width = '100%';
    if (label) label.textContent = `Done: ${summary.passed} pass, ${summary.failed} fail`;
    // Reload history for results display
    ipcRenderer.invoke('healthCheck.getHistory').then(h => {
        healthCheckHistory = h;
        renderHealthCheckDashboard();
    });
    dashboardStats.health = summary.failed > 0 ? 'Fail' : 'Pass';
    dashboardStats.lastCheckTime = Date.now();
    // Extract build/security from results
    if (results) {
        const buildResult = results.find(r => r.checkId === 'build-check');
        if (buildResult) dashboardStats.build = buildResult.status === 'pass' ? 'Pass' : 'Fail';
        const secResult = results.find(r => r.checkId === 'security-audit');
        if (secResult) dashboardStats.security = secResult.status === 'pass' ? 'OK' : 'Issues';
    }
    renderDashboard();
    addActivity('health', `Health check done: ${summary.passed} pass, ${summary.failed} fail, ${summary.totalErrors} issues`);
});

// Schedule → activity
ipcRenderer.on('schedule.executed', (event, { scheduleName, projectId, timestamp }) => {
    const project = projects.find(p => p.id === projectId);
    addActivity('info', `Schedule "${scheduleName}" executed (${project ? project.name : projectId})`);
});

// ===================================================================
//  Boot
// ===================================================================

window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, starting init...');
    init();
});
