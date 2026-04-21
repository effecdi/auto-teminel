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

// Per-project taskInput draft storage
const taskInputDrafts = new Map();

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

// Computer Control state
let ccMode = false;                  // true = CC visible, false = Terminal visible
function getCcId() { return currentProject ? currentProject.id : 'main'; }
const ccStateMap = new Map();        // projectId → { url, task, logsHTML, screenshotSrc, screenshotVisible }

// Browser Control state (Chrome Extension)
let browserMode = false;             // true = Browser panel visible
let bcExtConnected = false;          // 익스텐션 연결 여부
const bcStateMap = new Map();        // projectId → { screenshotSrc, url, log[] }
let bcConsoleCaptured = false;       // 콘솔 캡처 중
let bcNetworkCaptured = false;       // 네트워크 캡처 중
let bcCurrentMode = 'click';         // 현재 직접 제어 모드
let bcAutoRefresh = true;            // 액션 후 자동 스크린샷

// AI Chat state
let aiChatMode = false;              // true = AI Chat visible, false = Terminal visible
let aiChatMessages = new Map();      // projectId -> [{role, content, timestamp}]
let aiChatStreaming = null;          // { role, div, projectId } — currently streaming message
// Background streaming buffer — accumulates tokens when user is viewing a different project
// Key: projectId, Value: { role, text, finalized: bool }
const aiBgStreamBuffer = new Map();
// Track which AI is currently speaking (for center indicator)
let aiSpeakingNow = null;            // null | 'claude' | 'gemini'
let aiChatStarted = new Map();       // projectId -> boolean (has conversation started)
const aiChatActiveMap = new Map();   // projectId -> null | 'claude' | 'gemini' (AI chat in progress)
const aiChatDrafts = new Map();      // projectId -> string (per-project textarea draft)
let _aiTabRenderTimer = null;        // debounce for tab badge updates

// AI Recommendation Buttons
const AI_RECOMMENDATION_BUTTONS = [
    '이어서 더 자세히 설명해줘',
    '코드로 구현해줘',
    '코드 리뷰 해줘',
    '버그 있는지 확인해줘',
    '성능 개선 방법은?',
    '테스트 코드 작성해줘',
];

const LEARN_RECOMMENDATION_BUTTONS = [
    '이 코드의 디자인 패턴을 분석해줘',
    '보안 취약점을 찾아줘',
    '이 컴포넌트의 동작 원리를 설명해줘',
    '더 어려운 퀴즈를 내줘',
    'TypeScript로 리팩토링하면 어떻게 되는지 보여줘',
    '이 코드의 성능 개선 포인트를 알려줘',
];

// Learn Mode — Skill Profile
const SKILL_CATEGORIES = [
    { id: 'html', name: 'HTML' },
    { id: 'css', name: 'CSS' },
    { id: 'javascript', name: 'JavaScript' },
    { id: 'react', name: 'React' },
    { id: 'typescript', name: 'TypeScript' },
    { id: 'nextjs', name: 'Next.js' },
    { id: 'vue', name: 'Vue' },
    { id: 'flutter', name: 'Flutter' },
    { id: 'react-native', name: 'React Native' },
    { id: 'nodejs', name: 'Node.js' },
    { id: 'csharp', name: 'C#' },
    { id: 'python', name: 'Python' },
    { id: 'git', name: 'Git' },
    { id: 'security', name: '보안' },
];
const SKILL_LEVELS = ['모름', '입문', '기초', '중급', '고급'];

// Learn Mode — Quiz state
const _parsedQuizzes = new Map(); // quizId → quiz data
const MASTERY_LEVELS = {
    0: { name: '미학습', color: '#555', icon: '⬜' },
    1: { name: '입문', color: '#f85149', icon: '🟥' },
    2: { name: '기초', color: '#d29922', icon: '🟧' },
    3: { name: '이해', color: '#58a6ff', icon: '🟦' },
    4: { name: '숙련', color: '#3fb950', icon: '🟩' },
    5: { name: '마스터', color: '#b392f0', icon: '🟪' },
};

// Education Sidebar state
const eduMessages = new Map();       // projectId → [{role, content, timestamp}]
let eduStreaming = null;             // { role, div, projectId, fullText }
let eduDiffCache = null;             // cached git diff text
let eduCurrentTab = true;            // true when Learn tab is active (default tab)

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
            renderPromptHistory();
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

        // Load AI Chat defaults from settings
        try {
            const aiSettings = await ipcRenderer.invoke('ai.getSettings');
            if (aiSettings) {
                const debateModeEl = document.getElementById('aiDebateMode');
                const aiModeEl = document.getElementById('aiAiMode');
                if (debateModeEl && aiSettings.aiDefaultMode) debateModeEl.value = aiSettings.aiDefaultMode;
                if (aiModeEl && aiSettings.aiDefaultAiMode) aiModeEl.value = aiSettings.aiDefaultAiMode;
                // Learn mode progress panel visibility
                if (debateModeEl) {
                    debateModeEl.addEventListener('change', () => {
                        renderLearnProgressPanel();
                        if (debateModeEl.value === 'learn') {
                            checkLearnModeReady();
                        }
                    });
                    renderLearnProgressPanel();
                }
            }
        } catch (_) {}

        // Display current app version in sidebar footer
        try {
            const appVersion = await ipcRenderer.invoke('updater.getVersion');
            const versionText = document.getElementById('app-version-text');
            if (versionText && appVersion) versionText.textContent = `v${appVersion}`;
        } catch (_) {}

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
        fontFamily: "'Roboto Mono', 'Monaco', 'Menlo', 'Consolas', 'Liberation Mono', monospace",
        fontSize: fontSize,
        theme: {
            background: '#101010',
            foreground: '#e0e0e0',
            cursor: '#00e676',
            cursorAccent: '#101010',
            selectionBackground: 'rgba(0, 230, 118, 0.3)',
            black: '#545454',
            red: '#ff5252',
            green: '#00e676',
            yellow: '#ffd740',
            blue: '#448aff',
            magenta: '#e040fb',
            cyan: '#18ffff',
            white: '#bdbdbd',
            brightBlack: '#757575',
            brightRed: '#ff8a80',
            brightGreen: '#69f0ae',
            brightYellow: '#ffe57f',
            brightBlue: '#82b1ff',
            brightMagenta: '#ea80fc',
            brightCyan: '#84ffff',
            brightWhite: '#fafafa'
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

const _spawningProjects = new Set(); // Guard against concurrent spawn calls

async function ensurePtyRunning(project) {
    const entry = termPool.get(project.id);
    if (entry && entry.isAlive) {
        console.log(`PTY already alive for ${project.name}`);
        return;
    }

    // Prevent double-spawn if selectProject is called rapidly
    if (_spawningProjects.has(project.id)) {
        console.log(`PTY spawn already in progress for ${project.name}`);
        return;
    }
    _spawningProjects.add(project.id);

    updateStatus('running', 'Starting...');
    document.getElementById('terminalStatus').textContent = 'Starting...';

    const cols = entry ? entry.term.cols : 120;
    const rows = entry ? entry.term.rows : 30;

    // Include selected model in spawn args
    const selectedModel = localStorage.getItem(`model_${project.id}`) || 'claude-sonnet-4-6';

    const result = await ipcRenderer.invoke('terminal.spawn', {
        projectId: project.id,
        projectPath: project.path,
        claudeArgs: project.claudeArgs || '',
        claudeModel: selectedModel,
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

    _spawningProjects.delete(project.id);
}

// ===================================================================
//  Project Selection
// ===================================================================

async function selectProject(projectId) {
    const previousProject = currentProject;
    currentProject = projects.find(p => p.id === projectId);
    if (!currentProject) return;

    console.log('Project selected:', currentProject.name);

    // Persist last selected project
    ipcRenderer.invoke('session.setLastSelectedProject', projectId);

    // Browser Control: save/restore per-project state on project switch
    if (browserMode && previousProject && previousProject.id !== projectId) {
        bcSaveState(previousProject.id);
        bcRestoreState(projectId);
    }

    // Computer Control: save previous project state and switch to new project instance
    if (ccMode && previousProject && previousProject.id !== projectId) {
        // Save previous CC UI state
        ccSaveState(previousProject.id);
        // Hide previous BrowserView
        ipcRenderer.invoke('computerControl.setBounds', { id: previousProject.id, bounds: { x: 0, y: 0, width: 0, height: 0 } });
        // Create/reuse CC instance for new project
        ipcRenderer.invoke('computerControl.create', { id: getCcId() }).then(() => {
            ccRestoreState(getCcId());
            setTimeout(() => ccUpdateBrowserBounds(), 100);
        });
    }

    // Save/restore taskInput draft per project
    const taskTextarea = document.getElementById('taskInput');
    if (taskTextarea && previousProject) {
        const draft = taskTextarea.value;
        if (draft.trim()) {
            taskInputDrafts.set(previousProject.id, draft);
        } else {
            taskInputDrafts.delete(previousProject.id);
        }
    }
    if (taskTextarea) {
        const savedDraft = taskInputDrafts.get(projectId) || '';
        taskTextarea.value = savedDraft;
        taskTextarea.style.height = 'auto';
        if (savedDraft) {
            taskTextarea.style.height = taskTextarea.scrollHeight + 'px';
        }
        taskTextarea.placeholder = `[${currentProject.name}] 작업 요청... (Enter to send)`;
    }

    // Restore model selector for this project
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) {
        const savedModel = localStorage.getItem(`model_${projectId}`) || 'claude-sonnet-4-6';
        modelSelect.value = savedModel;
    }

    // Clean up AI chat state when switching projects
    if (aiChatStreaming) {
        // Finalize any in-progress streaming for previous project
        finalizeStreamMessage(aiChatStreaming.text);
    }
    // Save current project's draft before switching
    const aiTextarea = document.getElementById('aiChatTextarea');
    if (aiTextarea && previousProject) {
        const draft = aiTextarea.value.trim();
        if (draft) {
            aiChatDrafts.set(previousProject.id, aiTextarea.value);
        } else {
            aiChatDrafts.delete(previousProject.id);
        }
    }
    // Restore new project's draft (or clear)
    if (aiTextarea) {
        const savedDraft = aiChatDrafts.get(projectId) || '';
        aiTextarea.value = savedDraft;
        aiTextarea.style.height = 'auto';
        if (savedDraft) {
            // Auto-expand textarea for restored draft
            aiTextarea.style.height = aiTextarea.scrollHeight + 'px';
        }
    }
    // Update input area project label
    updateAiInputProjectLabel();
    // Re-render AI chat messages for new project
    if (aiChatMode) {
        hideAiStatusBar();
        hideAiSpeakingIndicator();
        aiSpeakingNow = null;
    }

    renderProjects();
    renderProjectInfo();
    updateInfoPanel(currentProject);
    updateAiChatHeader();

    // Re-render AI chat if in chat mode
    if (aiChatMode) {
        renderAiChatMessages();
        // Restore speaking indicator if AI is still active for this project
        const activeWho = aiChatActiveMap.get(projectId);
        if (activeWho) {
            aiSpeakingNow = activeWho;
            showAiSpeakingIndicator(activeWho);
        }
    }

    const entry = await getOrCreateTerminal(currentProject);
    showTerminal(projectId);
    renderImagePreviewBar();
    updateSendStopButton();

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
            icon.style.cssText = 'width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);border:1px solid var(--border-primary,#444444);border-radius:6px;font-size:20px;';
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
    let _lastPasteTime = 0;
    document.addEventListener('paste', async (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;

        // 500ms 내 연속 paste 차단 (복사복사복사... 방지)
        const now = Date.now();
        if (now - _lastPasteTime < 500) return;
        _lastPasteTime = now;

        // Check for image in clipboard
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

        // Check for files
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

        // Text paste — forward to the active textarea
        const text = (e.clipboardData && e.clipboardData.getData('text')) || clipboard.readText();
        if (text) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const textarea = aiChatMode
                ? document.getElementById('aiChatTextarea')
                : document.getElementById('taskInput');
            if (textarea) {
                textarea.focus();
                // Insert at cursor position (or append)
                const start = textarea.selectionStart || 0;
                const end = textarea.selectionEnd || 0;
                const before = textarea.value.substring(0, start);
                const after = textarea.value.substring(end);
                textarea.value = before + text + after;
                textarea.selectionStart = textarea.selectionEnd = start + text.length;
                // Trigger height auto-resize
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
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

        const aiChatWho = aiChatActiveMap.get(project.id);
        const aiChatBadge = aiChatWho
            ? `<span class="ai-chat-badge">AI Chat · ${aiChatWho === 'claude' ? 'Claude' : 'Gemini'}</span>`
            : '';

        if (isWorking) {
            item.classList.add('working');
        }
        if (aiChatWho) {
            item.classList.add('ai-chatting');
        }

        item.innerHTML = `
            <div class="project-item-header">
                <div class="project-item-name">${runningDot} ${escapeHtml(project.name)}</div>
                ${workingBadge}
                ${aiChatBadge}
                ${gitBadge}
            </div>
            ${project.description ? `<div class="project-item-desc">${escapeHtml(project.description)}</div>` : ''}
            <div class="project-item-path">${escapeHtml(project.path)}</div>
            <div class="project-item-actions">
                <button onclick="event.stopPropagation(); duplicateProject('${project.id}')" title="Duplicate project">📋</button>
                <button onclick="event.stopPropagation(); editProject('${project.id}')" title="Edit project">✏️</button>
                <button onclick="event.stopPropagation(); deleteProject('${project.id}')" title="Delete project">🗑️</button>
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

// Update sidebar project item AI chat state without full re-render
function updateProjectAiChatBadge(projectId, who) {
    const item = document.getElementById(`project-item-${projectId}`);
    if (!item) return;

    if (who) {
        if (!item.classList.contains('ai-chatting')) {
            item.classList.add('ai-chatting');
        }
        // Add or update AI chat badge
        const header = item.querySelector('.project-item-header');
        if (header) {
            let badge = header.querySelector('.ai-chat-badge');
            const label = who === 'claude' ? 'AI Chat · Claude' : 'AI Chat · Gemini';
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ai-chat-badge';
                // Insert after working-badge if present, otherwise after project-item-name
                const workingBadge = header.querySelector('.working-badge');
                const nameEl = header.querySelector('.project-item-name');
                const insertAfter = workingBadge || nameEl;
                if (insertAfter && insertAfter.nextSibling) {
                    header.insertBefore(badge, insertAfter.nextSibling);
                } else {
                    header.appendChild(badge);
                }
            }
            badge.textContent = label;
        }
    } else {
        item.classList.remove('ai-chatting');
        const badge = item.querySelector('.ai-chat-badge');
        if (badge) badge.remove();
    }
    // Debounced update of AI Chat project tabs (avoid per-token re-render)
    if (aiChatMode) {
        clearTimeout(_aiTabRenderTimer);
        _aiTabRenderTimer = setTimeout(() => renderAiChatProjectTabs(), 500);
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

let _duplicateSourceId = null;
let _duplicateParentDir = null;

async function duplicateProject(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    const parentDir = await ipcRenderer.invoke('select-folder');
    if (!parentDir) return;

    _duplicateSourceId = projectId;
    _duplicateParentDir = parentDir;

    const defaultName = path.basename(project.path) + '-copy';
    document.getElementById('dupFolderName').value = defaultName;
    document.getElementById('dupParentPath').textContent = parentDir;
    showModal('duplicateModal');
}

async function executeDuplicate() {
    const folderName = document.getElementById('dupFolderName').value.trim();
    if (!folderName) { showToast('Folder name is required', 'error'); return; }
    if (!_duplicateSourceId || !_duplicateParentDir) return;

    const destPath = path.join(_duplicateParentDir, folderName);
    closeModal('duplicateModal');
    showToast('Copying project files...', 'info');

    const result = await ipcRenderer.invoke('duplicate-project', {
        sourceProjectId: _duplicateSourceId,
        destPath
    });

    _duplicateSourceId = null;
    _duplicateParentDir = null;

    if (result.success) {
        await loadProjects();
        showToast(`Project duplicated → ${folderName}`, 'success');
        selectProject(result.project.id);
    } else {
        showToast('Duplicate failed: ' + result.error, 'error');
    }
}

async function editProject(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    document.getElementById('editProjectName').value = project.name || '';
    document.getElementById('editProjectDesc').value = project.description || '';
    document.getElementById('editProjectClaudeArgs').value = project.claudeArgs || '';
    document.getElementById('editProjectModal').dataset.projectId = projectId;
    showModal('editProjectModal');
}

async function saveEditProject() {
    const modal = document.getElementById('editProjectModal');
    const projectId = modal.dataset.projectId;
    const name = document.getElementById('editProjectName').value.trim();
    if (!name) {
        showToast('Project name is required', 'error');
        return;
    }

    const updates = {
        name,
        description: document.getElementById('editProjectDesc').value.trim(),
        claudeArgs: document.getElementById('editProjectClaudeArgs').value.trim()
    };

    const result = await ipcRenderer.invoke('update-project', { projectId, updates });
    if (result.success) {
        await loadProjects();
        if (currentProject && currentProject.id === projectId) {
            currentProject = projects.find(p => p.id === projectId);
            renderProjectInfo();
            updateInfoPanel(currentProject);
        }
        closeModal('editProjectModal');
        showToast('Project updated', 'success');
    } else {
        showToast('Failed to update: ' + result.error, 'error');
    }
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

    // Clean up all per-project state maps to prevent memory leaks
    aiChatMessages.delete(projectId);
    aiChatStarted.delete(projectId);
    attachedImagesMap.delete(projectId);
    idleState.delete(projectId);
    ccStateMap.delete(projectId);
    ipcRenderer.invoke('computerControl.destroy', { id: projectId });

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
        ipcRenderer.invoke('healthCheck.getSettings'),
        ipcRenderer.invoke('ai.getSettings')
    ]).then(([s, af, ar, hc, ai]) => {
        document.getElementById('defaultClaudeArgs').value = s.defaultClaudeArgs || '';
        document.getElementById('shellPath').value = s.shellPath || '';
        document.getElementById('termFontSize').value = s.fontSize || 14;
        document.getElementById('computerUseModel').value = s.computerUseModel || 'gemini-2.5-computer-use-preview-10-2025';
        document.getElementById('autoFixCooldown').value = af.cooldown || 30;
        document.getElementById('autoFixTemplateText').value = af.template || 'CRITICAL ERROR DETECTED: [{label}] {error}\nFix the root cause completely.';
        document.getElementById('autoFixMaxRetries').value = af.maxRetries || 3;
        document.getElementById('autoRestartMaxRetriesInput').value = ar.maxRetries || 3;
        document.getElementById('autoRestartRateWindow').value = ar.rateWindow || 5;
        document.getElementById('healthCheckEnabled').checked = hc.enabled;
        document.getElementById('healthCheckInterval').value = hc.intervalHours || 24;
        document.getElementById('healthCheckAutoFix').checked = hc.autoFixOnError !== false;
        // AI Chat settings
        document.getElementById('geminiApiKey').value = ai.geminiApiKey || '';
        document.getElementById('aiDefaultMode').value = ai.aiDefaultMode || 'collab';
        document.getElementById('aiDefaultAiMode').value = ai.aiDefaultAiMode || 'dual';
        document.getElementById('aiMaxRounds').value = ai.aiMaxRounds || 1;
        document.getElementById('aiIncludeSource').checked = ai.aiIncludeSource || false;
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

    // Computer Control settings
    const computerUseModel = document.getElementById('computerUseModel').value;

    await ipcRenderer.invoke('save-settings', { defaultClaudeArgs, shellPath, fontSize, computerUseModel });
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

    // AI Chat settings
    const geminiApiKey = document.getElementById('geminiApiKey').value.trim();
    const aiDefaultMode = document.getElementById('aiDefaultMode').value;
    const aiDefaultAiMode = document.getElementById('aiDefaultAiMode').value;
    const aiMaxRounds = parseInt(document.getElementById('aiMaxRounds').value, 10) || 1;
    const aiIncludeSource = document.getElementById('aiIncludeSource').checked;
    await ipcRenderer.invoke('ai.setSettings', {
        geminiApiKey,
        aiDefaultMode,
        aiDefaultAiMode,
        aiMaxRounds,
        aiIncludeSource
    });

    // Apply AI defaults to current selects
    const debateModeEl = document.getElementById('aiDebateMode');
    const aiModeEl = document.getElementById('aiAiMode');
    if (debateModeEl) debateModeEl.value = aiDefaultMode;
    if (aiModeEl) aiModeEl.value = aiDefaultAiMode;

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
    if (tab) {
        tab.classList.add('active');
        tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
    if (content) content.classList.add('active');

    // Learn tab — expand/collapse info-panel
    const infoPanel = document.querySelector('.info-panel');
    if (tabName === 'learn') {
        eduCurrentTab = true;
        if (infoPanel) infoPanel.classList.add('edu-expanded');
        eduFetchDiff();
    } else {
        eduCurrentTab = false;
        if (infoPanel) infoPanel.classList.remove('edu-expanded');
    }
}

function scrollAutoTabs(delta) {
    const el = document.getElementById('autoTabsScroll');
    if (el) el.scrollLeft += delta;
}

// ===================================================================
//  Education Sidebar (Learn Panel)
// ===================================================================

async function eduFetchDiff() {
    if (!currentProject || !currentProject.path) {
        eduDiffCache = null;
        eduRenderDiffPreview('프로젝트 경로 없음');
        return;
    }
    try {
        const result = await ipcRenderer.invoke('edu.getDiff', { projectPath: currentProject.path });
        if (result.success && result.diff) {
            eduDiffCache = result.diff;
            const lineCount = result.diff.split('\n').length;
            const countEl = document.getElementById('eduDiffCount');
            if (countEl) countEl.textContent = `(${lineCount}줄)`;
            eduRenderDiffPreview(result.diff);
        } else {
            eduDiffCache = null;
            const countEl = document.getElementById('eduDiffCount');
            if (countEl) countEl.textContent = '(없음)';
            eduRenderDiffPreview(result.error || '변경사항 없음');
        }
    } catch (err) {
        eduDiffCache = null;
        eduRenderDiffPreview('diff 조회 실패: ' + err.message);
    }
}

function eduRenderDiffPreview(text) {
    const preview = document.getElementById('eduDiffPreview');
    if (!preview) return;
    if (!text || text === '변경사항 없음' || text.startsWith('diff 조회 실패') || text === '프로젝트 경로 없음') {
        preview.innerHTML = `<span style="color:var(--text-muted);font-style:italic;">${text}</span>`;
        return;
    }
    // Syntax highlight diff
    const lines = text.split('\n').map(line => {
        const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${escaped}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${escaped}</span>`;
        if (line.startsWith('@@')) return `<span class="diff-hunk">${escaped}</span>`;
        return escaped;
    });
    preview.innerHTML = lines.join('\n');
}

function toggleEduDiff() {
    const section = document.getElementById('eduDiffSection');
    const preview = document.getElementById('eduDiffPreview');
    if (!section || !preview) return;
    const isExpanded = section.classList.contains('expanded');
    if (isExpanded) {
        section.classList.remove('expanded');
        preview.style.display = 'none';
    } else {
        section.classList.add('expanded');
        preview.style.display = 'block';
        eduFetchDiff(); // refresh diff
    }
}

function eduQuickAsk(text) {
    const input = document.getElementById('eduInput');
    if (input) input.value = text;
    eduSendMessage();
}

async function eduSendMessage() {
    const input = document.getElementById('eduInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    if (!currentProject) return;

    const projectId = currentProject.id;

    // 스킬 프로필 확인 — 없으면 모달 표시
    const profile = getSkillProfile();
    if (!profile) {
        showSkillProfileModal();
        return;
    }

    // 메시지 추가 (user)
    if (!eduMessages.has(projectId)) eduMessages.set(projectId, []);
    const msgs = eduMessages.get(projectId);
    msgs.push({ role: 'user', content: text, timestamp: Date.now() });

    input.value = '';
    input.style.height = 'auto';

    eduRenderMessages();

    // 히스토리 준비 (최근 4쌍)
    const historyForApi = [];
    const allMsgs = msgs.filter(m => m.role === 'user' || m.role === 'ai');
    const recent = allMsgs.length > 8 ? allMsgs.slice(-8) : allMsgs;
    for (const m of recent.slice(0, -1)) {
        historyForApi.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }

    const skillProfileText = buildSkillProfileText();

    try {
        await ipcRenderer.invoke('edu.ask', {
            projectId,
            question: text,
            skillProfile: skillProfileText,
            diffContext: eduDiffCache || '',
            history: historyForApi,
        });
    } catch (err) {
        msgs.push({ role: 'error', content: err.message, timestamp: Date.now() });
        eduRenderMessages();
    }
}

function eduRenderMessages() {
    const container = document.getElementById('eduMessages');
    if (!container || !currentProject) return;

    const msgs = eduMessages.get(currentProject.id) || [];
    if (msgs.length === 0) {
        container.innerHTML = `
            <div class="edu-welcome">
                <div class="edu-welcome-icon">📚</div>
                <div class="edu-welcome-title">코드 학습 패널</div>
                <div class="edu-welcome-desc">바이브코딩으로 작성된 코드가 궁금하면<br>아래에서 질문해보세요!</div>
            </div>`;
        return;
    }

    let html = '';
    for (const msg of msgs) {
        if (msg.role === 'user') {
            const escaped = msg.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += `<div class="edu-msg user">${escaped}</div>`;
        } else if (msg.role === 'ai') {
            let rendered = eduFormatMarkdown(msg.content);
            rendered = parseQuizBlocks(rendered);
            html += `<div class="edu-msg ai">${rendered}</div>`;
        } else if (msg.role === 'error') {
            html += `<div class="edu-msg error">⚠ ${msg.content}</div>`;
        }
    }

    // 스트리밍 중이면 추가
    if (eduStreaming && eduStreaming.projectId === currentProject.id) {
        let streamContent = eduStreaming.fullText || '';
        if (streamContent) {
            let rendered = eduFormatMarkdown(streamContent);
            html += `<div class="edu-msg ai">${rendered}<span class="edu-typing-dots"></span></div>`;
        } else {
            html += `<div class="edu-msg ai"><span class="edu-typing-dots"></span></div>`;
        }
    }

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function eduFormatMarkdown(text) {
    // 간단한 마크다운 변환
    let html = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks (```...```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<strong style="font-size:13px;display:block;margin:8px 0 4px;">$1</strong>');
    html = html.replace(/^## (.+)$/gm, '<strong style="font-size:14px;display:block;margin:10px 0 4px;">$1</strong>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
}

// IPC listeners for education streaming
ipcRenderer.on('edu.token', (event, { projectId, token }) => {
    if (!eduStreaming || eduStreaming.projectId !== projectId) {
        eduStreaming = { projectId, fullText: '', role: 'ai' };
    }
    eduStreaming.fullText += token;

    if (eduCurrentTab && currentProject && currentProject.id === projectId) {
        eduRenderMessages();
    }
});

ipcRenderer.on('edu.complete', (event, { projectId, content }) => {
    if (!eduMessages.has(projectId)) eduMessages.set(projectId, []);
    const msgs = eduMessages.get(projectId);
    msgs.push({ role: 'ai', content: content, timestamp: Date.now() });
    eduStreaming = null;

    if (eduCurrentTab && currentProject && currentProject.id === projectId) {
        eduRenderMessages();
    }
});

ipcRenderer.on('edu.error', (event, { projectId, message }) => {
    if (!eduMessages.has(projectId)) eduMessages.set(projectId, []);
    const msgs = eduMessages.get(projectId);
    msgs.push({ role: 'error', content: message, timestamp: Date.now() });
    eduStreaming = null;

    if (eduCurrentTab && currentProject && currentProject.id === projectId) {
        eduRenderMessages();
    }
});

// ===================================================================
//  MCP Manager
// ===================================================================

async function renderMcpPanel() {
    const list = document.getElementById('mcpList');
    if (!list) return;
    list.innerHTML = '<div class="history-empty">불러오는 중...</div>';

    let servers = [];
    try {
        servers = await ipcRenderer.invoke('mcp.list');
    } catch (e) {
        list.innerHTML = `<div class="history-empty" style="color:#f56565">로드 실패: ${e.message}</div>`;
        return;
    }

    if (!servers || servers.length === 0) {
        list.innerHTML = '<div class="history-empty">~/.claude.json 에 등록된 MCP 서버가 없습니다</div>';
        return;
    }

    list.innerHTML = '';

    for (const srv of servers) {
        const item = document.createElement('div');
        item.style.cssText = 'padding:10px 12px; border-bottom:1px solid var(--border); display:flex; flex-direction:column; gap:6px;';

        const statusColor = {
            'connected': '#00e676',
            'needs-auth': '#ffd740',
            'token-expired': '#ff5252',
            'stdio': '#4fc3f7',
            'unknown': '#9e9e9e'
        }[srv.status] || '#9e9e9e';

        const statusLabel = {
            'connected': '✓ 연결됨',
            'needs-auth': '⚠ 인증 필요',
            'token-expired': '✗ 토큰 만료',
            'stdio': '● stdio',
            'unknown': '? 알 수 없음'
        }[srv.status] || srv.status;

        let actionsHtml = '';
        if (srv.status === 'needs-auth' || srv.status === 'token-expired') {
            actionsHtml = `<button onclick="mcpAuthenticate('${escapeHtml(srv.name)}', '${escapeHtml(srv.url || '')}')"
                style="background:#1976d2; color:#fff; border:none; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:11px;">
                🔑 인증하기</button>`;
        } else if (srv.status === 'connected') {
            actionsHtml = `<button onclick="mcpRevoke('${escapeHtml(srv.name)}', '${escapeHtml(srv.url || '')}')"
                style="background:transparent; color:#f56565; border:1px solid #f56565; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:11px;">
                연결 해제</button>`;
        }

        item.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between;">
                <span style="font-size:13px; font-weight:600; color:var(--text-primary);">${escapeHtml(srv.name)}</span>
                <span style="font-size:11px; color:${statusColor}; font-weight:600;">${statusLabel}</span>
            </div>
            ${srv.url ? `<div style="font-size:10px; color:var(--text-muted); word-break:break-all;">${escapeHtml(srv.url)}</div>` : ''}
            ${actionsHtml ? `<div style="margin-top:2px;">${actionsHtml}</div>` : ''}
        `;
        list.appendChild(item);
    }
}

async function mcpAuthenticate(serverName, serverUrl) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '인증 중... (브라우저에서 승인하세요)';
    try {
        const result = await ipcRenderer.invoke('mcp.authenticate', { serverName, serverUrl });
        if (result.success) {
            showToast(`${serverName} 인증 완료!`, 'success');
            renderMcpPanel();
        } else {
            showToast(`인증 실패: ${result.error}`, 'error');
            btn.disabled = false;
            btn.textContent = '🔑 인증하기';
        }
    } catch (e) {
        showToast(`오류: ${e.message}`, 'error');
        btn.disabled = false;
        btn.textContent = '🔑 인증하기';
    }
}

async function mcpRevoke(serverName, serverUrl) {
    if (!confirm(`${serverName} 인증을 해제하시겠습니까?`)) return;
    try {
        await ipcRenderer.invoke('mcp.revoke', { serverName, serverUrl });
        showToast(`${serverName} 연결 해제됨`, 'info');
        renderMcpPanel();
    } catch (e) {
        showToast(`오류: ${e.message}`, 'error');
    }
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
//  Pipeline — Codex-style AI Orchestration (Timeline + Unified Send)
// ===================================================================

// Timeline streaming state
let timelineStreaming = null; // { type, entryDiv, bodyDiv, text }

/**
 * Send task directly to Claude terminal via task queue.
 */
async function sendUnifiedTask(text) {
    if (!text) return;
    if (!currentProject) {
        showToast('Select a project first', 'error');
        return;
    }

    const projectId = currentProject.id;

    // Ensure PTY is running
    const entry = termPool.get(projectId);
    if (!entry || !entry.isAlive) {
        showToast('Starting terminal...', 'info');
        await getOrCreateTerminal(currentProject);
        await ensurePtyRunning(currentProject);
    }

    // Send directly to task queue
    try {
        const result = await ipcRenderer.invoke('pipeline.submit', {
            projectId,
            text,
            routeMode: 'claude-solo'
        });
        if (result && result.error === 'duplicate') {
            showToast('동일한 태스크가 이미 대기 중입니다', 'warning');
            return false; // 중복으로 거부됨
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
    return true;
}

function expandTimelinePanel() {
    const panel = document.getElementById('timeline-panel');
    const btn = document.getElementById('timelineToggleBtn');
    if (panel) {
        panel.classList.remove('collapsed');
        if (btn) btn.textContent = '▼';
    }
}

function stopPipeline() {
    if (!currentProject) return;
    ipcRenderer.invoke('ai.stop', { projectId: currentProject.id });
    const stopBtn = document.getElementById('pipelineStopBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    if (timelineStreaming) finalizeTimelineStreaming();
    appendTimelineEntry('route-info', '⏹ Pipeline stopped');
}

function toggleTimeline() {
    const panel = document.getElementById('timeline-panel');
    const btn = document.getElementById('timelineToggleBtn');
    if (!panel) return;

    if (panel.classList.contains('collapsed')) {
        panel.classList.remove('collapsed');
        if (btn) btn.textContent = '▼';
    } else {
        panel.classList.add('collapsed');
        if (btn) btn.textContent = '▶';
    }
}

function clearTimeline() {
    const entries = document.getElementById('timelineEntries');
    if (entries) entries.innerHTML = '';
    timelineStreaming = null;
    _lastTimelineRoute = '';
    _lastUserEntryDiv = null;

    // Collapse the panel after clearing
    const panel = document.getElementById('timeline-panel');
    const btn = document.getElementById('timelineToggleBtn');
    if (panel) panel.classList.add('collapsed');
    if (btn) btn.textContent = '▶';

    const stopBtn = document.getElementById('pipelineStopBtn');
    if (stopBtn) stopBtn.style.display = 'none';
}

// Track last route to avoid repetitive route-info entries
let _lastTimelineRoute = '';
let _lastUserEntryDiv = null;

/**
 * Append an entry to the timeline panel.
 * @param {string} type - 'user' | 'gemini-design' | 'claude-execution' | 'route-info' | 'error'
 * @param {string} content - Text content
 */
function appendTimelineEntry(type, content) {
    const entries = document.getElementById('timelineEntries');
    if (!entries) return;

    // route-info: merge into the last user entry as a badge instead of separate line
    if (type === 'route-info') {
        if (_lastUserEntryDiv) {
            let badge = _lastUserEntryDiv.querySelector('.timeline-route-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'timeline-route-badge';
                _lastUserEntryDiv.appendChild(badge);
            }
            badge.textContent = content;
        }
        _lastTimelineRoute = content;
        return;
    }

    const div = document.createElement('div');
    div.className = `timeline-entry ${type}`;

    const labels = {
        'user': 'Task',
        'gemini-design': 'Gemini (설계)',
        'claude-execution': 'Claude (실행)',
        'error': 'Error'
    };

    const label = document.createElement('div');
    label.className = 'timeline-entry-label';
    label.textContent = labels[type] || type;
    div.appendChild(label);

    const body = document.createElement('div');
    body.className = 'timeline-entry-body';

    if (type === 'error') {
        body.textContent = content;
    } else if (type === 'user') {
        body.textContent = content;
    } else {
        body.innerHTML = renderAiMarkdown(content);
    }

    div.appendChild(body);
    entries.appendChild(div);
    entries.scrollTop = entries.scrollHeight;

    if (type === 'user') {
        _lastUserEntryDiv = div;
    }

    return div;
}

function startTimelineStreaming(type) {
    const entries = document.getElementById('timelineEntries');
    if (!entries) return;

    const div = document.createElement('div');
    div.className = `timeline-entry ${type} streaming`;

    const labels = {
        'gemini-design': 'Gemini (설계)',
        'claude-execution': 'Claude (실행)',
    };

    const label = document.createElement('div');
    label.className = 'timeline-entry-label';
    label.textContent = labels[type] || type;
    div.appendChild(label);

    const body = document.createElement('div');
    body.className = 'timeline-entry-body';
    div.appendChild(body);

    entries.appendChild(div);
    entries.scrollTop = entries.scrollHeight;

    timelineStreaming = { type, entryDiv: div, bodyDiv: body, text: '' };
}

function appendTimelineStreamToken(token) {
    if (!timelineStreaming) return;
    timelineStreaming.text += token;

    if (!timelineStreaming._renderPending) {
        timelineStreaming._renderPending = true;
        requestAnimationFrame(() => {
            if (timelineStreaming) {
                timelineStreaming.bodyDiv.innerHTML = renderAiMarkdown(timelineStreaming.text);
                timelineStreaming._renderPending = false;
                const entries = document.getElementById('timelineEntries');
                if (entries) entries.scrollTop = entries.scrollHeight;
            }
        });
    }
}

function finalizeTimelineStreaming() {
    if (!timelineStreaming) return;

    const { entryDiv, bodyDiv, text } = timelineStreaming;
    entryDiv.classList.remove('streaming');
    bodyDiv.innerHTML = renderAiMarkdown(text);
    timelineStreaming = null;

    const entries = document.getElementById('timelineEntries');
    if (entries) entries.scrollTop = entries.scrollHeight;
}

// --- Pipeline IPC Listeners (simplified — routing removed) ---

ipcRenderer.on('pipeline.error', (event, { projectId, message, source }) => {
    if (!currentProject || currentProject.id !== projectId) return;
    showToast(`[${source || 'Error'}] ${message}`, 'error');
});

// ===================================================================
//  AI Chat — Dual AI (Claude + Gemini) chat integration
// ===================================================================

/**
 * Toggle between Terminal+Timeline view and AI Chat bubble view.
 */
function toggleAiChat() {
    // If CC is active, close it first
    if (ccMode) toggleComputerControl();
    aiChatMode = !aiChatMode;

    const terminalContainer = document.getElementById('terminal-container');
    const timelinePanel = document.getElementById('timeline-panel');
    const aiChatContainer = document.getElementById('ai-chat-container');
    const terminalOnlyBtns = document.getElementById('terminalOnlyBtns');
    const aiChatBtn = document.querySelector('.toolbar-btn[onclick="toggleAiChat()"]');

    const toolbarSep = document.getElementById('terminalToolbarSep');

    const contentHeader = document.querySelector('.content-header');

    if (aiChatMode) {
        // Show AI Chat, hide Terminal + header
        if (terminalContainer) terminalContainer.style.display = 'none';
        if (timelinePanel) timelinePanel.style.display = 'none';
        if (aiChatContainer) aiChatContainer.style.display = 'grid';
        if (terminalOnlyBtns) terminalOnlyBtns.style.display = 'none';
        if (toolbarSep) toolbarSep.style.display = 'none';
        if (aiChatBtn) aiChatBtn.classList.add('active');
        if (contentHeader) contentHeader.style.display = 'none';

        // Hide terminal-specific UI elements
        const promptArea = document.querySelector('.prompt-area');
        if (promptArea) promptArea.style.display = 'none';
        const queueBar = document.getElementById('queueProgressBar');
        if (queueBar) queueBar.dataset.hiddenByChat = queueBar.style.display !== 'none' ? '1' : '';
        if (queueBar) queueBar.style.display = 'none';
        const imgBar = document.getElementById('imagePreviewBar');
        if (imgBar) imgBar.dataset.hiddenByChat = imgBar.style.display !== 'none' ? '1' : '';
        if (imgBar) imgBar.style.display = 'none';

        // Update AI chat header with current project info
        updateAiChatHeader();

        // Render messages for current project
        renderAiChatMessages();

        // Focus AI textarea
        setTimeout(() => {
            const aiTextarea = document.getElementById('aiChatTextarea');
            if (aiTextarea) aiTextarea.focus();
        }, 100);
    } else {
        // Show Terminal + header, hide AI Chat
        if (terminalContainer) terminalContainer.style.display = '';
        if (aiChatContainer) aiChatContainer.style.display = 'none';
        if (terminalOnlyBtns) terminalOnlyBtns.style.display = '';
        if (toolbarSep) toolbarSep.style.display = '';
        if (aiChatBtn) aiChatBtn.classList.remove('active');
        if (contentHeader) contentHeader.style.display = '';
        hideAiSpeakingIndicator();

        // Show terminal-specific UI elements
        const promptArea = document.querySelector('.prompt-area');
        if (promptArea) promptArea.style.display = '';
        const queueBar = document.getElementById('queueProgressBar');
        if (queueBar && queueBar.dataset.hiddenByChat === '1') queueBar.style.display = '';
        const imgBar = document.getElementById('imagePreviewBar');
        if (imgBar && imgBar.dataset.hiddenByChat === '1') imgBar.style.display = '';

        // Re-fit terminal
        if (currentProject) {
            const entry = termPool.get(currentProject.id);
            if (entry) requestAnimationFrame(() => fitEntry(entry));
        }
    }
}

// Media file extensions that should be uploaded to Gemini File API
const MEDIA_UPLOAD_EXTS = /\.(mp4|mov|avi|mkv|webm|png|jpg|jpeg|gif|webp|bmp)$/i;

async function sendAiMessage() {
    // Use AI chat textarea if available, fallback to task input
    const textarea = document.getElementById('aiChatTextarea') || document.getElementById('taskInput');
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;

    if (!currentProject) {
        showToast('Select a project first', 'error');
        return;
    }

    textarea.value = '';
    textarea.style.height = 'auto';

    // Clear draft for this project (message sent)
    if (currentProject) aiChatDrafts.delete(currentProject.id);

    // Remove recommendation buttons when sending new message
    removeRecommendationButtons();

    const projectId = currentProject.id;

    // Check for attached media files that need Gemini File API upload
    const attachedFiles = getAttachedImages();
    const mediaFilesToUpload = attachedFiles.filter(f => MEDIA_UPLOAD_EXTS.test(f));
    const nonMediaFiles = attachedFiles.filter(f => !MEDIA_UPLOAD_EXTS.test(f));

    // Build display text with file info
    let displayText = text;
    if (attachedFiles.length > 0) {
        const fileNames = attachedFiles.map(f => f.split('/').pop()).join(', ');
        displayText = `📎 ${fileNames}\n\n${text}`;
    }

    // Add user message to local state
    if (!aiChatMessages.has(projectId)) aiChatMessages.set(projectId, []);
    aiChatMessages.get(projectId).push({ role: 'user', content: displayText, timestamp: Date.now() });
    appendAiMessage('user', displayText);

    // Show status bar
    showAiStatusBar('AI가 응답을 준비하고 있습니다...', '');

    // Show stop button, hide send button
    const stopBtn = document.getElementById('aiChatStopBtn');
    const sendBtn = document.getElementById('aiChatSendBtn');
    if (stopBtn) stopBtn.style.display = '';
    if (sendBtn) sendBtn.style.display = 'none';

    // Disable textarea and change placeholder during AI response
    textarea.disabled = true;
    textarea.placeholder = 'AI가 대화 중입니다...';

    // Get mode settings from selects
    const debateMode = document.getElementById('aiDebateMode').value;
    const aiMode = document.getElementById('aiAiMode').value;
    const operationType = document.getElementById('aiOperationType').value;

    // Learn mode: ensure skill profile exists
    if (debateMode === 'learn' && !getSkillProfile()) {
        showSkillProfileModal(() => sendAiMessage());
        textarea.value = text; // restore text
        return;
    }

    const hasStarted = aiChatStarted.get(projectId);

    // Upload media files to Gemini File API
    let attachedMediaFiles = [];
    if (mediaFilesToUpload.length > 0) {
        showAiStatusBar('미디어 파일 업로드 중...', `0/${mediaFilesToUpload.length}`);
        for (let i = 0; i < mediaFilesToUpload.length; i++) {
            const filePath = mediaFilesToUpload[i];
            const fileName = filePath.split('/').pop();
            showAiStatusBar(`업로드 중: ${fileName}`, `${i + 1}/${mediaFilesToUpload.length}`);
            try {
                const result = await ipcRenderer.invoke('ai.uploadMediaFile', { filePath });
                if (result.success) {
                    attachedMediaFiles.push({
                        fileUri: result.fileUri,
                        mimeType: result.mimeType,
                        fileName: result.fileName,
                    });
                } else {
                    showToast(`업로드 실패: ${fileName} — ${result.error}`, 'error');
                }
            } catch (uploadErr) {
                showToast(`업로드 에러: ${fileName} — ${uploadErr.message}`, 'error');
            }
        }
        if (attachedMediaFiles.length > 0) {
            showAiStatusBar(`${attachedMediaFiles.length}개 파일 업로드 완료! AI 분석 시작...`, '');
        }
    }

    // Clear attached files
    if (attachedFiles.length > 0) {
        clearAttachedImages();
    }

    // Build message text — include non-media file paths as text (legacy behavior)
    let messageText = text;
    if (nonMediaFiles.length > 0) {
        const pathsList = nonMediaFiles.map(f => `"${f}"`).join(' ');
        messageText = `[Attached files: ${pathsList}]\n\n${text}`;
    }
    if (attachedMediaFiles.length > 0) {
        const mediaNames = attachedMediaFiles.map(f => f.fileName).join(', ');
        messageText = `[첨부된 미디어: ${mediaNames}]\n\n${messageText}`;
    }

    // Learn mode: prepend skill profile to message
    if (debateMode === 'learn') {
        const skillText = buildSkillProfileText();
        if (skillText) {
            messageText = skillText + messageText;
        }
    }

    try {
        if (!hasStarted) {
            // First message — start new conversation
            await ipcRenderer.invoke('ai.start', {
                projectId,
                task: messageText,
                mode: debateMode,
                aiMode: aiMode,
                operationType: operationType || undefined,
                projectPath: currentProject.path,
                projectName: currentProject.name,
                attachedMediaFiles,
            });
            // Only mark as started AFTER successful invoke
            aiChatStarted.set(projectId, true);
        } else {
            // Continue existing conversation — pass project context every time
            await ipcRenderer.invoke('ai.continue', {
                projectId,
                message: messageText,
                mode: debateMode,
                aiMode: aiMode,
                operationType: operationType || undefined,
                projectPath: currentProject.path,
                projectName: currentProject.name,
                attachedMediaFiles,
            });
        }
    } catch (err) {
        // Reset started state if first message failed
        if (!hasStarted) {
            aiChatStarted.delete(projectId);
        }
        appendAiMessage('error', `Error: ${err.message}`);
        hideAiStatusBar();
    }
}

/** Handle send from AI Chat input area */
function handleAiSend() {
    sendAiMessage();
}

/** Show AI status bar */
function showAiStatusBar(text, roundText) {
    const bar = document.getElementById('aiChatStatusBar');
    const textEl = document.getElementById('aiStatusText');
    const roundEl = document.getElementById('aiStatusRound');
    if (bar) bar.style.display = '';
    if (textEl) textEl.textContent = text;
    if (roundEl) roundEl.textContent = roundText || '';
}

/** Hide AI status bar */
function hideAiStatusBar() {
    const bar = document.getElementById('aiChatStatusBar');
    if (bar) bar.style.display = 'none';
    // Restore send/stop buttons
    const stopBtn = document.getElementById('aiChatStopBtn');
    const sendBtn = document.getElementById('aiChatSendBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    if (sendBtn) sendBtn.style.display = '';

    // Re-enable textarea and restore placeholder
    const textarea = document.getElementById('aiChatTextarea');
    if (textarea) {
        textarea.disabled = false;
        textarea.placeholder = '메시지를 입력하세요...';
    }
}

/** Show inline speaking indicator (replaces old center overlay) */
function showAiSpeakingIndicator(who) {
    if (!aiChatMode) return;
    const overlay = document.getElementById('aiSpeakingOverlay');
    const dot = document.getElementById('aiSpeakingDot');
    const name = document.getElementById('aiSpeakingName');
    if (!overlay) return;

    const aiName = who === 'gemini' ? 'Gemini' : 'Claude';
    if (dot) dot.className = `ai-speaking-inline-dot ${who}`;
    if (name) { name.textContent = aiName; name.className = `ai-speaking-inline-name ${who}`; }
    overlay.style.display = '';

    // Update status bar with specific AI name
    const statusText = document.getElementById('aiStatusText');
    if (statusText && !statusText.textContent.includes('터미널')) {
        const debateMode = document.getElementById('aiDebateMode');
        const modeLabel = debateMode ? debateMode.options[debateMode.selectedIndex].text : '';
        statusText.textContent = `${aiName}가 생각하는 중... | ${modeLabel}`;
    }
}

/** Hide the speaking indicator */
function hideAiSpeakingIndicator() {
    const overlay = document.getElementById('aiSpeakingOverlay');
    if (overlay) overlay.style.display = 'none';
}

/** Update AI chat header with current project info */
function updateAiChatHeader() {
    const nameEl = document.getElementById('aiChatProjectName');
    if (nameEl && currentProject) {
        nameEl.textContent = currentProject.name || 'Project';
    }
    updateAiInputProjectLabel();
    renderAiChatProjectTabs();
}

/** Update the project label shown in the AI Chat input area */
function updateAiInputProjectLabel() {
    const label = document.getElementById('aiInputProjectLabel');
    const textarea = document.getElementById('aiChatTextarea');
    if (label && currentProject) {
        label.textContent = currentProject.name || 'Project';
        label.style.display = '';
    } else if (label) {
        label.style.display = 'none';
    }
    if (textarea && currentProject) {
        textarea.placeholder = `${currentProject.name}에 메시지 입력...`;
    }
}

/** Render project tabs in AI Chat — each project gets its own tab */
function renderAiChatProjectTabs() {
    const container = document.getElementById('aiChatProjectTabs');
    if (!container) return;
    container.innerHTML = '';

    if (!projects || projects.length === 0) return;

    for (const proj of projects) {
        const tab = document.createElement('button');
        tab.className = 'ai-chat-project-tab';
        if (currentProject && proj.id === currentProject.id) {
            tab.classList.add('active');
        }

        // Badge: active AI / draft / messages
        const hasActive = aiChatActiveMap.get(proj.id);
        const hasDraft = aiChatDrafts.has(proj.id);
        const hasMessages = aiChatMessages.has(proj.id) && aiChatMessages.get(proj.id).length > 0;

        let badgeHTML = '';
        if (hasActive) {
            badgeHTML = '<span class="ai-chat-tab-badge has-active"></span>';
        } else if (hasDraft) {
            badgeHTML = '<span class="ai-chat-tab-badge has-draft"></span>';
        } else if (hasMessages) {
            badgeHTML = '<span class="ai-chat-tab-badge"></span>';
        }

        tab.innerHTML = `${badgeHTML}<span>${proj.name}</span>`;
        tab.title = proj.path || proj.name;
        tab.addEventListener('click', () => switchAiChatProject(proj.id));
        container.appendChild(tab);
    }
}

/** Switch AI Chat to a specific project (via tab click) */
function switchAiChatProject(projectId) {
    if (currentProject && currentProject.id === projectId) return;
    // This triggers selectProject which handles draft save/restore, re-render, etc.
    selectProject(projectId);
}

/** Set AI mode via tab buttons */
function setAiModeTab(mode) {
    // Update hidden select
    const select = document.getElementById('aiAiMode');
    if (select) select.value = mode;

    // Update tab styling
    const tabs = document.querySelectorAll('.ai-mode-tab');
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === mode);
    });
}

function stopAiChat() {
    if (!currentProject) return;
    ipcRenderer.invoke('ai.stop', { projectId: currentProject.id });
}

/** Reset AI Chat — start a new conversation for current project */
function resetAiChat() {
    if (!currentProject) return;
    const projectId = currentProject.id;

    // Stop any in-progress streaming
    if (aiChatStreaming && aiChatStreaming.projectId === projectId) {
        ipcRenderer.invoke('ai.stop', { projectId });
        aiChatStreaming = null;
    }

    // Clear messages for this project
    aiChatMessages.delete(projectId);
    aiChatStarted.delete(projectId);
    aiBgStreamBuffer.delete(projectId);
    aiChatActiveMap.delete(projectId);

    // Reset conversation in backend
    ipcRenderer.invoke('ai.reset', { projectId }).catch(() => {});

    // Hide indicators
    hideAiSpeakingIndicator();
    hideAiStatusBar();

    // Re-render (will show placeholder)
    renderAiChatMessages();

    // Focus textarea
    const textarea = document.getElementById('aiChatTextarea');
    if (textarea) textarea.focus();
}

function renderAiChatMessages() {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    container.innerHTML = '';

    if (!currentProject) {
        container.innerHTML = '<div class="ai-chat-placeholder"><div class="placeholder-icon">🤖</div><h2>AI Chat</h2><p>프로젝트를 먼저 선택하세요</p></div>';
        return;
    }

    const messages = aiChatMessages.get(currentProject.id);
    if (!messages || messages.length === 0) {
        container.innerHTML = '<div class="ai-chat-placeholder"><div class="placeholder-icon">🤖</div><h2>AI Chat</h2><p>Claude + Gemini 듀얼 AI 채팅</p><div class="placeholder-hint">아래에 메시지를 입력하세요</div></div>';
        return;
    }

    // Apply history collapse if many messages
    const shouldCollapseHistory = messages.length > 5;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const div = appendAiMessageDom(container, msg.role, msg.content, msg.timestamp);
        if (shouldCollapseHistory && i < messages.length - 4) {
            div.classList.add('ai-msg-history-hidden');
            div.style.display = 'none';
        }
    }

    // Add "이전 대화 보기" button if messages are collapsed
    if (shouldCollapseHistory) {
        const collapseBtn = document.createElement('div');
        collapseBtn.className = 'ai-history-collapse';
        const hiddenCount = messages.length - 4;
        collapseBtn.innerHTML = `<button class="ai-history-toggle-btn" onclick="toggleAiHistoryCollapse(this)">▼ 이전 대화 보기 (${hiddenCount}개)</button>`;
        container.insertBefore(collapseBtn, container.firstChild);
    }

    // Add recommendation buttons if last message is from AI
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && (lastMsg.role === 'gemini' || lastMsg.role === 'claude')) {
        container.appendChild(createRecommendationButtons());
    }

    container.scrollTop = container.scrollHeight;
}

function toggleAiHistoryCollapse(btn) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const hiddenMsgs = container.querySelectorAll('.ai-msg-history-hidden');
    const isHidden = hiddenMsgs.length > 0 && hiddenMsgs[0].style.display === 'none';

    hiddenMsgs.forEach(el => {
        el.style.display = isHidden ? '' : 'none';
    });
    btn.textContent = isHidden
        ? `▲ 이전 대화 접기 (${hiddenMsgs.length}개)`
        : `▼ 이전 대화 보기 (${hiddenMsgs.length}개)`;
}

function applyMessageCollapse(div, body, content) {
    if (!content || content.length < 500) return;
    body.classList.add('ai-msg-collapsed');
    const expandBtn = document.createElement('button');
    expandBtn.className = 'ai-msg-expand-btn';
    expandBtn.textContent = '더 보기 ▼';
    expandBtn.addEventListener('click', () => {
        const isCollapsed = body.classList.contains('ai-msg-collapsed');
        body.classList.toggle('ai-msg-collapsed');
        expandBtn.textContent = isCollapsed ? '접기 ▲' : '더 보기 ▼';
    });
    div.appendChild(expandBtn);
}

function appendAiMessage(role, content) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;

    // Remove placeholder if present
    const placeholder = container.querySelector('.ai-chat-placeholder');
    if (placeholder) placeholder.remove();

    appendAiMessageDom(container, role, content);
    container.scrollTop = container.scrollHeight;
}

function appendAiMessageDom(container, role, content, timestamp) {
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role}`;

    const timeStr = _formatMsgTime(timestamp);

    if (role === 'gemini' || role === 'claude') {
        // Header with avatar, name, role badge, timestamp, copy button
        const header = document.createElement('div');
        header.className = 'ai-msg-header';

        const avatar = document.createElement('span');
        avatar.className = 'ai-msg-avatar';
        avatar.textContent = role === 'gemini' ? '💎' : '🤖';
        header.appendChild(avatar);

        const name = document.createElement('span');
        name.className = 'ai-msg-name';
        name.textContent = role === 'gemini' ? 'Gemini' : 'Claude';
        header.appendChild(name);

        const roleBadge = document.createElement('span');
        roleBadge.className = 'ai-msg-role';
        roleBadge.textContent = role === 'gemini' ? 'Designer' : 'Developer';
        header.appendChild(roleBadge);

        if (timeStr) {
            const timeEl = document.createElement('span');
            timeEl.className = 'ai-msg-time';
            timeEl.textContent = timeStr;
            header.appendChild(timeEl);
        }

        // Copy button for AI messages
        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-msg-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => _copyMessageText(content, copyBtn));
        header.appendChild(copyBtn);

        div.appendChild(header);

        // Bubble with content
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble ai-msg-body';
        bubble.innerHTML = renderAiMarkdown(content);
        div.appendChild(bubble);

        // Apply collapse for long messages
        applyMessageCollapse(div, bubble, content);
    } else if (role === 'user') {
        const body = document.createElement('div');
        body.className = 'ai-msg-body';
        body.innerHTML = renderAiMarkdown(content);
        div.appendChild(body);

        // User message actions (copy + time)
        const actions = document.createElement('div');
        actions.className = 'ai-msg-user-actions';
        if (timeStr) {
            const timeEl = document.createElement('span');
            timeEl.className = 'ai-msg-time';
            timeEl.style.opacity = '1';
            timeEl.textContent = timeStr;
            actions.appendChild(timeEl);
        }
        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-msg-user-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => _copyMessageText(content, copyBtn));
        actions.appendChild(copyBtn);
        div.appendChild(actions);
    } else {
        // error, system
        const body = document.createElement('div');
        body.className = 'ai-msg-body';
        if (role === 'error') {
            body.textContent = content;
        } else {
            body.innerHTML = renderAiMarkdown(content);
        }
        div.appendChild(body);
    }

    container.appendChild(div);
    return div;
}

/** Format message timestamp */
function _formatMsgTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
}

/** Copy message text to clipboard */
function _copyMessageText(text, btn) {
    if (clipboard) {
        clipboard.writeText(text);
    } else {
        navigator.clipboard.writeText(text);
    }
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
}

function startStreamingMessage(role) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return null;

    // Remove placeholder if present
    const placeholder = container.querySelector('.ai-chat-placeholder');
    if (placeholder) placeholder.remove();

    // Remove status indicator
    const statusEl = document.getElementById('aiChatStatus');
    if (statusEl) statusEl.remove();

    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role} ai-msg-streaming`;

    // Header with avatar, name, role badge, typing indicator
    const header = document.createElement('div');
    header.className = 'ai-msg-header';

    const avatar = document.createElement('span');
    avatar.className = 'ai-msg-avatar';
    avatar.textContent = role === 'gemini' ? '💎' : '🤖';
    header.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'ai-msg-name';
    name.textContent = role === 'gemini' ? 'Gemini' : 'Claude';
    header.appendChild(name);

    const roleBadge = document.createElement('span');
    roleBadge.className = 'ai-msg-role';
    roleBadge.textContent = role === 'gemini' ? 'Designer' : 'Developer';
    header.appendChild(roleBadge);

    const typingInd = document.createElement('span');
    typingInd.className = 'ai-msg-typing-indicator';
    typingInd.innerHTML = '<span class="typing-dot"></span> typing';
    header.appendChild(typingInd);

    div.appendChild(header);

    // Bubble for content
    const body = document.createElement('div');
    body.className = 'ai-msg-bubble ai-msg-body';

    // Add ● ● ● typing dots inside bubble (removed when first token arrives)
    const dotsBubble = document.createElement('div');
    dotsBubble.className = 'ai-typing-dots-bubble';
    dotsBubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    body.appendChild(dotsBubble);

    div.appendChild(body);

    container.appendChild(div);

    aiChatStreaming = { role, div, body, text: '', projectId: currentProject ? currentProject.id : null, _dotsShown: true };
    container.scrollTop = container.scrollHeight;
    return div;
}

/** Check if user is near bottom of chat (within 80px) */
function _isNearBottom(container) {
    if (!container) return true;
    return (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
}

function appendStreamToken(token) {
    if (!aiChatStreaming) return;
    aiChatStreaming.text += token;

    // Remove typing dots bubble on first token
    if (aiChatStreaming._dotsShown) {
        const dots = aiChatStreaming.body.querySelector('.ai-typing-dots-bubble');
        if (dots) dots.remove();
        aiChatStreaming._dotsShown = false;
    }

    // Render markdown periodically (throttle for performance)
    if (!aiChatStreaming._renderPending) {
        aiChatStreaming._renderPending = true;
        requestAnimationFrame(() => {
            if (aiChatStreaming) {
                const container = document.getElementById('aiChatMessages');
                const shouldScroll = _isNearBottom(container);
                aiChatStreaming.body.innerHTML = renderAiMarkdown(aiChatStreaming.text);
                aiChatStreaming._renderPending = false;
                if (container && shouldScroll) container.scrollTop = container.scrollHeight;
            }
        });
    }
}

function createRecommendationButtons() {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-recommendations';

    const debateMode = document.getElementById('aiDebateMode');
    const isLearn = debateMode && debateMode.value === 'learn';
    const buttons = isLearn ? LEARN_RECOMMENDATION_BUTTONS : AI_RECOMMENDATION_BUTTONS;

    for (const label of buttons) {
        const btn = document.createElement('button');
        btn.className = 'ai-rec-btn';
        btn.textContent = label;
        btn.addEventListener('click', () => {
            const textarea = document.getElementById('aiChatTextarea') || document.getElementById('taskInput');
            if (textarea) {
                textarea.value = label;
                sendAiMessage();
            }
        });
        wrapper.appendChild(btn);
    }
    return wrapper;
}

function removeRecommendationButtons() {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const existing = container.querySelectorAll('.ai-recommendations');
    existing.forEach(el => el.remove());
}

function finalizeStreamMessage(fullText) {
    if (!aiChatStreaming) return;

    const { role, div, body, projectId: streamProjectId } = aiChatStreaming;
    div.classList.remove('ai-msg-streaming');
    body.innerHTML = renderAiMarkdown(fullText);

    // Remove typing indicator
    const typingInd = div.querySelector('.ai-msg-typing-indicator');
    if (typingInd) typingInd.remove();

    // Apply collapse for long messages
    applyMessageCollapse(div, body, fullText);

    aiChatStreaming = null;

    // Save to local message store — use original projectId from when streaming started
    const targetProjectId = streamProjectId || (currentProject ? currentProject.id : null);
    if (targetProjectId) {
        if (!aiChatMessages.has(targetProjectId)) aiChatMessages.set(targetProjectId, []);
        aiChatMessages.get(targetProjectId).push({ role, content: fullText, timestamp: Date.now() });
    }

    const container = document.getElementById('aiChatMessages');
    if (container) {
        // Remove old recommendation buttons and add new ones after AI response
        removeRecommendationButtons();
        if (role === 'gemini' || role === 'claude') {
            container.appendChild(createRecommendationButtons());
        }
        container.scrollTop = container.scrollHeight;
    }
}

/**
 * Markdown renderer for AI messages.
 * Supports: code blocks (with language label + copy button), inline code,
 * bold, italic, strikethrough, headers, unordered/ordered lists,
 * links, blockquotes, tables, horizontal rules.
 */
function renderAiMarkdown(text) {
    if (!text) return '';

    // Escape HTML first
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const langLabel = lang ? `<span class="code-lang-label">${lang}</span>` : '';
        const copyBtn = `<button class="code-copy-btn" onclick="copyCodeBlock(this)" title="Copy code">Copy</button>`;
        return `<div class="code-block-wrapper">${langLabel}${copyBtn}<pre><code>${code.trim()}</code></pre></div>`;
    });

    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Tables: | head | head |\n|---|---|\n| cell | cell |
    html = html.replace(/((?:^\|.+\|$\n?){2,})/gm, (tableBlock) => {
        const rows = tableBlock.trim().split('\n').filter(r => r.trim());
        if (rows.length < 2) return tableBlock;
        // Check if second row is separator
        const isSep = /^\|[\s\-:|]+\|$/.test(rows[1]);
        let tableHtml = '<table class="ai-table">';
        const startData = isSep ? 2 : 0;
        if (isSep && rows[0]) {
            const cells = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
            tableHtml += '<thead><tr>' + cells.map(c => `<th>${c.trim()}</th>`).join('') + '</tr></thead>';
        }
        tableHtml += '<tbody>';
        for (let i = startData; i < rows.length; i++) {
            const cells = rows[i].split('|').filter((_, ci, a) => ci > 0 && ci < a.length - 1);
            tableHtml += '<tr>' + cells.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
        }
        tableHtml += '</tbody></table>';
        return tableHtml;
    });

    // Bold: **...**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic: *...*
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // Strikethrough: ~~...~~
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // Headers: # ## ### ####
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule: ---
    html = html.replace(/^---$/gm, '<hr>');

    // Blockquotes: > text
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Ordered lists: 1. item
    html = html.replace(/^(\d+)\. (.+)$/gm, '<oli>$2</oli>');
    html = html.replace(/(<oli>.*?<\/oli>\n?)+/g, (match) => {
        return '<ol>' + match.replace(/<\/?oli>/g, (tag) => tag.replace('oli', 'li')) + '</ol>';
    });

    // Unordered lists: - item or * item
    html = html.replace(/^[\-\*] (.+)$/gm, '<uli>$1</uli>');
    html = html.replace(/(<uli>.*?<\/uli>\n?)+/g, (match) => {
        return '<ul>' + match.replace(/<\/?uli>/g, (tag) => tag.replace('uli', 'li')) + '</ul>';
    });

    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="ai-link" onclick="event.preventDefault(); require(\'electron\').shell.openExternal(\'$2\')">$1</a>');

    // Paragraphs (double newline)
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs and fix nesting
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>(<(?:h[1234]|pre|ul|ol|blockquote|table|div|hr)[\s>])/g, '$1');
    html = html.replace(/(<\/(?:h[1234]|pre|ul|ol|blockquote|table|div|hr)>)<\/p>/g, '$1');

    // Learn Mode — Parse quiz blocks
    html = parseQuizBlocks(html);

    return html;
}

/** Parse ---QUIZ_START--- / ---QUIZ_END--- blocks into interactive quiz cards */
function parseQuizBlocks(html) {
    const quizRegex = /---QUIZ_START---([\s\S]*?)---QUIZ_END---/g;
    let match;
    let result = html;

    while ((match = quizRegex.exec(html)) !== null) {
        const block = match[1].trim();
        const quiz = parseQuizData(block);
        if (!quiz) continue;

        const quizId = `quiz_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        quiz.id = quizId;
        _parsedQuizzes.set(quizId, quiz);

        const diffClass = quiz.difficulty || 'beginner';
        const diffLabel = { beginner: '초급', intermediate: '중급', advanced: '고급' }[diffClass] || diffClass;

        let optionsHtml = '';
        if (quiz.options && quiz.options.length > 0) {
            optionsHtml = quiz.options.map(opt => {
                const optLetter = opt.charAt(0);
                return `<button class="quiz-option" data-option="${optLetter}" onclick="handleQuizAnswer('${quizId}','${optLetter}')">${opt}</button>`;
            }).join('');
        }

        const cardHtml = `<div class="learn-quiz-card" data-quiz-id="${quizId}" data-concept="${quiz.concept || ''}">
            <div class="quiz-header">
                <span class="quiz-badge">🧠 Quiz</span>
                <span class="quiz-difficulty ${diffClass}">${diffLabel}</span>
                <span class="quiz-concept">${quiz.concept || ''}</span>
            </div>
            <div class="quiz-question">${quiz.question || ''}</div>
            <div class="quiz-options">${optionsHtml}</div>
            <div class="quiz-result">
                <div class="quiz-result-icon"></div>
                <div class="quiz-explanation">${quiz.explanation || ''}</div>
            </div>
        </div>`;

        result = result.replace(match[0], cardHtml);
    }

    return result;
}

/** Parse individual quiz data from text block */
function parseQuizData(block) {
    try {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        const data = {};
        for (const line of lines) {
            if (line.startsWith('Q:')) data.question = line.slice(2).trim();
            else if (line.startsWith('TYPE:')) data.type = line.slice(5).trim();
            else if (line.startsWith('OPTIONS:')) {
                data.options = line.slice(8).trim().split('|').map(o => o.trim());
            }
            else if (line.startsWith('ANSWER:')) data.answer = line.slice(7).trim().charAt(0);
            else if (line.startsWith('EXPLANATION:')) data.explanation = line.slice(12).trim();
            else if (line.startsWith('CONCEPT:')) data.concept = line.slice(8).trim();
            else if (line.startsWith('DIFFICULTY:')) data.difficulty = line.slice(11).trim().toLowerCase();
        }
        if (!data.question) return null;
        return data;
    } catch (e) {
        console.warn('[Learn] Failed to parse quiz block:', e);
        return null;
    }
}

/** Handle quiz answer click */
function handleQuizAnswer(quizId, selectedOption) {
    const quiz = _parsedQuizzes.get(quizId);
    if (!quiz || quiz.userAnswer) return; // already answered

    quiz.userAnswer = selectedOption;
    const isCorrect = selectedOption === quiz.answer;
    quiz.isCorrect = isCorrect;

    const card = document.querySelector(`[data-quiz-id="${quizId}"]`);
    if (!card) return;

    // Disable all options and mark correct/incorrect
    card.querySelectorAll('.quiz-option').forEach(btn => {
        btn.classList.add('disabled');
        if (btn.dataset.option === quiz.answer) btn.classList.add('correct');
        if (btn.dataset.option === selectedOption && !isCorrect) btn.classList.add('incorrect');
    });

    // Show result
    const resultDiv = card.querySelector('.quiz-result');
    resultDiv.classList.add('show');
    const iconDiv = resultDiv.querySelector('.quiz-result-icon');
    iconDiv.textContent = isCorrect ? '✅ 정답!' : `❌ 오답 — 정답: ${quiz.answer}`;
    iconDiv.className = `quiz-result-icon ${isCorrect ? 'correct' : 'incorrect'}`;

    // Update progress
    updateLearnProgress(quiz.concept, isCorrect, quiz.difficulty);
    renderLearnProgressPanel();
}

/** Get learning progress from localStorage */
function getLearnProgress() {
    try {
        const raw = localStorage.getItem('learnProgress');
        return raw ? JSON.parse(raw) : { concepts: {}, stats: { totalQuizzes: 0, correctAnswers: 0, streak: 0 } };
    } catch { return { concepts: {}, stats: { totalQuizzes: 0, correctAnswers: 0, streak: 0 } }; }
}

/** Update learning progress */
function updateLearnProgress(concept, isCorrect, difficulty) {
    if (!concept) return;
    const progress = getLearnProgress();

    if (!progress.concepts[concept]) {
        progress.concepts[concept] = { level: 0, correct: 0, total: 0, consecutive: 0, lastSeen: Date.now() };
    }

    const c = progress.concepts[concept];
    c.total++;
    c.lastSeen = Date.now();

    if (isCorrect) {
        c.correct++;
        c.consecutive++;
        // Level up: 3 consecutive correct at current level or above
        if (c.consecutive >= 3 && c.level < 5) {
            c.level++;
            c.consecutive = 0;
        }
    } else {
        c.consecutive = 0;
        // No level down — just reset consecutive
    }

    progress.stats.totalQuizzes++;
    if (isCorrect) {
        progress.stats.correctAnswers++;
        progress.stats.streak++;
    } else {
        progress.stats.streak = 0;
    }

    localStorage.setItem('learnProgress', JSON.stringify(progress));
}

/** Render learn progress panel */
function renderLearnProgressPanel() {
    const panel = document.getElementById('learnProgressPanel');
    if (!panel) return;

    const debateMode = document.getElementById('aiDebateMode');
    const isLearnMode = debateMode && debateMode.value === 'learn';

    if (!isLearnMode) {
        panel.style.display = 'none';
        return;
    }

    const progress = getLearnProgress();
    const conceptKeys = Object.keys(progress.concepts);

    if (conceptKeys.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';

    // Summary
    const s = progress.stats;
    const pct = s.totalQuizzes > 0 ? Math.round(s.correctAnswers / s.totalQuizzes * 100) : 0;
    const summary = document.getElementById('learnStatsSummary');
    if (summary) {
        summary.textContent = `정답률 ${pct}% | ${s.totalQuizzes}문제 | 🔥 ${s.streak}연속`;
    }

    // Concept grid
    const grid = document.getElementById('learnConceptsGrid');
    if (grid) {
        grid.innerHTML = conceptKeys.map(key => {
            const c = progress.concepts[key];
            const ml = MASTERY_LEVELS[c.level] || MASTERY_LEVELS[0];
            const pctBar = Math.min(100, (c.level / 5) * 100);
            return `<div class="learn-concept-card">
                <div class="concept-level-bar" style="--level-pct:${pctBar}%;--level-color:${ml.color}">
                    <div class="concept-level-fill"></div>
                </div>
                <div class="concept-name">${key}</div>
                <div class="concept-stats">${ml.icon} ${ml.name} | ${c.correct}/${c.total}</div>
            </div>`;
        }).join('');
    }
}

/** Toggle learn progress panel expand/collapse */
function toggleLearnProgress() {
    const panel = document.getElementById('learnProgressPanel');
    if (panel) panel.classList.toggle('expanded');
}

/** Get saved skill profile from localStorage */
function getSkillProfile() {
    try {
        const raw = localStorage.getItem('learnSkillProfile');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

/** Save skill profile to localStorage */
function saveSkillProfile(profile) {
    localStorage.setItem('learnSkillProfile', JSON.stringify(profile));
}

/** Build skill profile text for AI prompt */
function buildSkillProfileText() {
    const profile = getSkillProfile();
    if (!profile) return '';
    const lines = SKILL_CATEGORIES.map(cat => {
        const level = profile[cat.id] !== undefined ? SKILL_LEVELS[profile[cat.id]] : '모름';
        return `${cat.name}: ${level}`;
    });
    return `[학생 스킬 프로필]\n${lines.join(', ')}\n\n위 수준에 맞춰서 설명해주세요. 잘 모르는 기술은 기초부터, 아는 기술은 심화 위주로.\n\n`;
}

/** Show skill profile modal */
function showSkillProfileModal(onSave) {
    const existing = document.querySelector('.skill-profile-overlay');
    if (existing) existing.remove();

    const profile = getSkillProfile() || {};
    const overlay = document.createElement('div');
    overlay.className = 'skill-profile-overlay';

    const itemsHtml = SKILL_CATEGORIES.map(cat => {
        const currentLevel = profile[cat.id] !== undefined ? profile[cat.id] : -1;
        const btns = SKILL_LEVELS.map((name, idx) =>
            `<button class="sp-level-btn ${idx === currentLevel ? 'active' : ''}" data-skill="${cat.id}" data-level="${idx}" onclick="selectSkillLevel(this)">${name}</button>`
        ).join('');
        return `<div class="sp-item"><div class="sp-item-label">${cat.name}</div><div class="sp-levels">${btns}</div></div>`;
    }).join('');

    overlay.innerHTML = `
        <div class="skill-profile-modal">
            <h2>📋 내 개발 스킬 프로필</h2>
            <div class="sp-desc">각 기술별 현재 수준을 선택해주세요. AI가 니 레벨에 맞춰서 코드를 분석하고 설명해줌.</div>
            <div class="sp-grid">${itemsHtml}</div>
            <button class="sp-save-btn" onclick="saveSkillProfileFromModal()">저장하고 학습 시작</button>
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    overlay._onSave = onSave;
}

/** Handle skill level button click in modal */
function selectSkillLevel(btn) {
    const siblings = btn.closest('.sp-levels').querySelectorAll('.sp-level-btn');
    siblings.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

/** Save skill profile from modal and close */
function saveSkillProfileFromModal() {
    const overlay = document.querySelector('.skill-profile-overlay');
    if (!overlay) return;

    const profile = {};
    overlay.querySelectorAll('.sp-level-btn.active').forEach(btn => {
        profile[btn.dataset.skill] = parseInt(btn.dataset.level);
    });

    // Default unset skills to 0 (모름)
    SKILL_CATEGORIES.forEach(cat => {
        if (profile[cat.id] === undefined) profile[cat.id] = 0;
    });

    saveSkillProfile(profile);
    overlay.remove();

    if (overlay._onSave) overlay._onSave(profile);
}

/** Check if skill profile exists when entering learn mode */
function checkLearnModeReady(callback) {
    const profile = getSkillProfile();
    if (!profile) {
        showSkillProfileModal(() => { if (callback) callback(); });
    } else {
        if (callback) callback();
    }
}

/** Copy code block content to clipboard */
function copyCodeBlock(btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) return;
    const code = wrapper.querySelector('code');
    if (!code) return;
    const text = code.textContent;
    if (clipboard) {
        clipboard.writeText(text);
    } else {
        navigator.clipboard.writeText(text);
    }
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
}

// --- AI Chat IPC Listeners ---
// These listeners feed into EITHER the bubble chat (when aiChatMode) or the timeline (when not).

// Helper: check if this projectId is the currently viewed project
function _isActiveProject(projectId) {
    return currentProject && currentProject.id === projectId;
}

// Helper: accumulate token to background buffer for a non-active project
function _bgBufferToken(projectId, role, token) {
    if (!aiBgStreamBuffer.has(projectId)) {
        aiBgStreamBuffer.set(projectId, { role, text: '' });
    }
    const buf = aiBgStreamBuffer.get(projectId);
    if (buf.role !== role) {
        // Role changed (e.g. Claude → Gemini) — save previous buffer as message
        _bgBufferFinalize(projectId, buf.text);
        aiBgStreamBuffer.set(projectId, { role, text: token });
    } else {
        buf.text += token;
    }
}

// Helper: finalize background buffer → save to aiChatMessages
function _bgBufferFinalize(projectId, fullText) {
    const buf = aiBgStreamBuffer.get(projectId);
    if (!buf) return;
    const text = fullText || buf.text;
    if (text) {
        if (!aiChatMessages.has(projectId)) aiChatMessages.set(projectId, []);
        aiChatMessages.get(projectId).push({ role: buf.role, content: text, timestamp: Date.now() });
    }
    aiBgStreamBuffer.delete(projectId);
}

ipcRenderer.on('ai.geminiToken', (event, { projectId, token }) => {
    aiChatActiveMap.set(projectId, 'gemini');
    updateProjectAiChatBadge(projectId, 'gemini');
    if (_isActiveProject(projectId)) {
        aiSpeakingNow = 'gemini';
        showAiSpeakingIndicator('gemini');
        if (aiChatMode) {
            if (!aiChatStreaming || aiChatStreaming.role !== 'gemini') {
                startStreamingMessage('gemini');
            }
            appendStreamToken(token);
        } else {
            if (!timelineStreaming || timelineStreaming.type !== 'gemini-design') {
                startTimelineStreaming('gemini-design');
            }
            appendTimelineStreamToken(token);
        }
    } else {
        // Background project — buffer the token
        _bgBufferToken(projectId, 'gemini', token);
    }
});

ipcRenderer.on('ai.claudeToken', (event, { projectId, token }) => {
    aiChatActiveMap.set(projectId, 'claude');
    updateProjectAiChatBadge(projectId, 'claude');
    if (_isActiveProject(projectId)) {
        aiSpeakingNow = 'claude';
        showAiSpeakingIndicator('claude');
        if (aiChatMode) {
            if (!aiChatStreaming || aiChatStreaming.role !== 'claude') {
                startStreamingMessage('claude');
            }
            appendStreamToken(token);
        } else {
            if (!timelineStreaming || timelineStreaming.type !== 'claude-execution') {
                startTimelineStreaming('claude-execution');
            }
            appendTimelineStreamToken(token);
        }
    } else {
        _bgBufferToken(projectId, 'claude', token);
    }
});

ipcRenderer.on('ai.geminiComplete', (event, { projectId, text }) => {
    aiChatActiveMap.set(projectId, null);
    updateProjectAiChatBadge(projectId, null);
    if (_isActiveProject(projectId)) {
        aiSpeakingNow = null;
        hideAiSpeakingIndicator();
        if (aiChatMode) {
            finalizeStreamMessage(text);
        } else {
            if (timelineStreaming && timelineStreaming.type === 'gemini-design') {
                finalizeTimelineStreaming();
            }
        }
    } else {
        // Background: finalize buffer with full text
        if (aiBgStreamBuffer.has(projectId)) {
            const buf = aiBgStreamBuffer.get(projectId);
            buf.text = text || buf.text; // prefer full text from complete event
        } else {
            aiBgStreamBuffer.set(projectId, { role: 'gemini', text: text || '' });
        }
        _bgBufferFinalize(projectId, text);
    }
});

ipcRenderer.on('ai.claudeComplete', (event, { projectId, text }) => {
    aiChatActiveMap.set(projectId, null);
    updateProjectAiChatBadge(projectId, null);
    if (_isActiveProject(projectId)) {
        aiSpeakingNow = null;
        hideAiSpeakingIndicator();
        if (aiChatMode) {
            finalizeStreamMessage(text);
        } else {
            if (timelineStreaming && timelineStreaming.type === 'claude-execution') {
                finalizeTimelineStreaming();
            }
        }
    } else {
        if (aiBgStreamBuffer.has(projectId)) {
            const buf = aiBgStreamBuffer.get(projectId);
            buf.text = text || buf.text;
        } else {
            aiBgStreamBuffer.set(projectId, { role: 'claude', text: text || '' });
        }
        _bgBufferFinalize(projectId, text);
    }
});

ipcRenderer.on('ai.roundStart', (event, { projectId, round, maxRounds }) => {
    if (!_isActiveProject(projectId)) return; // round start only matters for UI

    if (aiChatMode) {
        if (maxRounds > 1) {
            appendAiMessage('system', `--- Round ${round}/${maxRounds} ---`);
        }
        // Show stop button, hide send button
        const stopBtn = document.getElementById('aiChatStopBtn');
        const sendBtn = document.getElementById('aiChatSendBtn');
        if (stopBtn) stopBtn.style.display = '';
        if (sendBtn) sendBtn.style.display = 'none';

        // Update status bar
        const debateMode = document.getElementById('aiDebateMode');
        const modeLabel = debateMode ? debateMode.options[debateMode.selectedIndex].text : '';
        showAiStatusBar(`AI가 생각하는 중... | ${modeLabel}`, `Round ${round}/${maxRounds}`);
    }
});

ipcRenderer.on('ai.debateComplete', (event, { projectId }) => {
    aiChatActiveMap.set(projectId, null);
    updateProjectAiChatBadge(projectId, null);
    // Always handle completion — flush background buffer if needed
    if (aiBgStreamBuffer.has(projectId)) {
        _bgBufferFinalize(projectId);
    }

    if (_isActiveProject(projectId)) {
        aiSpeakingNow = null;
        hideAiSpeakingIndicator();
        if (aiChatMode) {
            if (aiChatStreaming) {
                finalizeStreamMessage(aiChatStreaming.text);
            }
            hideAiStatusBar();
            const statusEl = document.getElementById('aiChatStatus');
            if (statusEl) statusEl.remove();
        } else {
            if (timelineStreaming) {
                finalizeTimelineStreaming();
            }
        }
    }
    // Refresh project tabs (badge update)
    if (aiChatMode) renderAiChatProjectTabs();
});

ipcRenderer.on('ai.executionQueued', (event, { projectId, mode }) => {
    if (_isActiveProject(projectId)) {
        if (aiChatMode) {
            appendAiMessage('system', `${mode || '협업'} 완료 → 터미널에서 코드 적용 시작!`);
            showAiStatusBar('터미널에서 코드 적용 중...', '');
        }
    } else {
        // Save as system message for background project
        if (!aiChatMessages.has(projectId)) aiChatMessages.set(projectId, []);
        aiChatMessages.get(projectId).push({ role: 'system', content: `${mode || '협업'} 완료 → 터미널에서 코드 적용 시작!`, timestamp: Date.now() });
    }
});

// 터미널 자동 연결 등 상태 업데이트
ipcRenderer.on('ai.statusUpdate', (event, { projectId, message }) => {
    if (!currentProject || currentProject.id !== projectId) return;
    if (aiChatMode) {
        appendAiMessage('system', message);
    }
});

// 터미널 idle 통합 핸들러 (AI Chat 알림 + idle state + dashboard)
ipcRenderer.on('terminal.idle', (event, { projectId }) => {
    // 1) Idle state & working indicator (for all projects)
    idleState.set(projectId, true);
    updateProjectWorkingState(projectId, false);
    renderDashboard();

    // 2) AI Chat notification (only for current project in AI chat mode)
    if (currentProject && currentProject.id === projectId && aiChatMode) {
        const statusText = document.getElementById('aiStatusText');
        if (statusText && statusText.textContent.includes('터미널')) {
            appendAiMessage('system', '터미널 실행 완료 — 코드가 프로젝트에 적용되었습니다.');
            setTimeout(() => hideAiStatusBar(), 3000);
        }
    }
});

ipcRenderer.on('ai.error', (event, { projectId, message, source }) => {
    aiChatActiveMap.set(projectId, null);
    updateProjectAiChatBadge(projectId, null);
    if (_isActiveProject(projectId)) {
        aiSpeakingNow = null;
        hideAiSpeakingIndicator();
        if (aiChatMode) {
            if (aiChatStreaming) finalizeStreamMessage(aiChatStreaming.text);
            appendAiMessage('error', `[${source || 'AI'}] ${message}`);
            hideAiStatusBar();
        } else {
            if (timelineStreaming) finalizeTimelineStreaming();
            appendTimelineEntry('error', `[${source || 'AI'}] ${message}`);
        }
    } else {
        // Save error to background project messages
        if (aiBgStreamBuffer.has(projectId)) _bgBufferFinalize(projectId);
        if (!aiChatMessages.has(projectId)) aiChatMessages.set(projectId, []);
        aiChatMessages.get(projectId).push({ role: 'error', content: `[${source || 'AI'}] ${message}`, timestamp: Date.now() });
    }
});

ipcRenderer.on('ai.statusChange', (event, { projectId, status }) => {
    if (!_isActiveProject(projectId)) return;
    if (aiChatMode) {
        // Empty status means clear/hide the status bar
        if (!status) {
            hideAiStatusBar();
            return;
        }
        // Update status bar text
        const textEl = document.getElementById('aiStatusText');
        if (textEl) textEl.textContent = status;
        const bar = document.getElementById('aiChatStatusBar');
        if (bar) bar.style.display = '';

        // Show stop button while AI is active
        const stopBtn = document.getElementById('aiChatStopBtn');
        const sendBtn = document.getElementById('aiChatSendBtn');
        if (stopBtn) stopBtn.style.display = '';
        if (sendBtn) sendBtn.style.display = 'none';
    }
});

// Media upload progress from main process
ipcRenderer.on('ai.mediaUploadProgress', (event, { filePath, status, message }) => {
    if (aiChatMode) {
        const fileName = filePath ? filePath.split('/').pop() : '';
        const statusText = `📤 ${message || status}`;
        showAiStatusBar(statusText, fileName);
    }
});

// ===================================================================
//  Task Queue — unified queue-based auto-execution
// ===================================================================

function setupTaskInputShortcut() {
    const textarea = document.getElementById('taskInput');
    if (!textarea) return;
    console.log('[Setup] taskInput found, attaching listeners');

    let _sendHandledByKeydown = false; // keydown에서 처리했으면 input 이벤트에서 중복 전송 방지

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && e.keyCode !== 229 && !e.isComposing) {
            e.preventDefault();
            _sendHandledByKeydown = true;
            if (aiChatMode) {
                sendAiMessage();
            } else {
                sendTask();
            }
        }
        // Escape key → interrupt running task
        if (e.key === 'Escape' && !aiChatMode) {
            const hasRunning = currentProject && taskQueue.some(t => t.status === 'running' && t.projectId === currentProject.id);
            if (hasRunning) {
                e.preventDefault();
                interruptCurrentTask();
            }
        }
    });

    textarea.addEventListener('input', (e) => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';

        if (e.inputType === 'insertLineBreak') {
            textarea.value = textarea.value.replace(/\n+$/, '');
            // keydown에서 이미 전송 처리된 경우 중복 전송 방지
            if (_sendHandledByKeydown) {
                _sendHandledByKeydown = false;
                return;
            }
            if (aiChatMode) {
                sendAiMessage();
            } else {
                sendTask();
            }
        } else {
            _sendHandledByKeydown = false;
        }
    });

    textarea.addEventListener('focus', () => console.log('[textarea] focused'));
    textarea.addEventListener('blur', () => console.log('[textarea] blurred'));

    // Setup AI Chat textarea
    const aiTextarea = document.getElementById('aiChatTextarea');
    if (aiTextarea) {
        aiTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && e.keyCode !== 229) {
                e.preventDefault();
                sendAiMessage();
            }
        });
        aiTextarea.addEventListener('input', (e) => {
            aiTextarea.style.height = 'auto';
            aiTextarea.style.height = Math.min(aiTextarea.scrollHeight, 120) + 'px';
            if (e.inputType === 'insertLineBreak') {
                aiTextarea.value = aiTextarea.value.replace(/\n+$/, '');
                sendAiMessage();
            }
        });
    }
}

/** Wrapper for send button — routes to AI chat or task based on mode. */
function handleSend() {
    if (aiChatMode) {
        sendAiMessage();
    } else {
        sendTask();
    }
}

/** Unified send — ALL input goes through pipeline routing. */
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
    // Clear draft for this project after sending
    taskInputDrafts.delete(targetProject.id);

    // ALL input goes through unified pipeline (중복이면 false 반환)
    const accepted = await sendUnifiedTask(fullText);
    if (accepted === false) {
        renderDashboard();
        return; // 중복 거부 — history/activity 기록 생략
    }

    // Save to prompt history
    promptHistory.unshift({ text, timestamp: Date.now(), project: targetProject.name });
    if (promptHistory.length > MAX_HISTORY) promptHistory.length = MAX_HISTORY;
    renderPromptHistory();
    if (historySaveTimer) clearTimeout(historySaveTimer);
    historySaveTimer = setTimeout(() => {
        ipcRenderer.invoke('session.savePromptHistory', promptHistory);
    }, 1000);
    ipcRenderer.invoke('session.saveLastPrompt', { projectId: targetProject.id, prompt: text });

    addActivity('task', `Task: ${text.substring(0, 80)}${text.length > 80 ? '…' : ''}`, targetProject.name);

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

/** Interrupt the currently running task for the active project. */
async function interruptCurrentTask() {
    if (!currentProject) return;

    const runningTask = taskQueue.find(t => t.status === 'running' && t.projectId === currentProject.id);
    if (!runningTask) {
        showToast('No running task to stop', 'info');
        return;
    }

    const result = await ipcRenderer.invoke('terminal.interrupt', currentProject.id);
    if (result.success) {
        showToast('Task interrupted — Claude CLI will return to prompt', 'info');
    } else {
        showToast('Failed to interrupt: ' + (result.error || 'unknown'), 'error');
    }
}

/** Update Send/Stop button state based on queue. */
function updateSendStopButton() {
    const sendBtn = document.getElementById('taskSendBtn');
    if (!sendBtn) return;

    // AI chat mode uses its own send logic, don't override
    if (aiChatMode) {
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('task-stop-mode');
        sendBtn.onclick = handleSend;
        return;
    }

    const hasRunning = currentProject && taskQueue.some(t => t.status === 'running' && t.projectId === currentProject.id);

    if (hasRunning) {
        sendBtn.textContent = 'Stop';
        sendBtn.classList.add('task-stop-mode');
        sendBtn.onclick = interruptCurrentTask;
    } else {
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('task-stop-mode');
        sendBtn.onclick = handleSend;
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

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _buildTaskItem(task) {
    const item = document.createElement('div');
    item.className = `task-item task-${task.status}`;
    item.dataset.taskId = task.id;

    const time = new Date(task.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const displayText = task.text.length > 150 ? task.text.substring(0, 150) + '…' : task.text;

    const deleteBtn = task.status !== 'running'
        ? `<button class="task-delete-btn" onclick="event.stopPropagation(); removeTask(${task.id})" title="Remove from queue">✕</button>`
        : '';

    item.innerHTML = `
        <div class="task-item-header">
            <span class="task-status-dot ${task.status}"></span>
            <span class="task-item-status ${task.status}">${task.status}</span>
            <div class="task-action-btns">
                <button class="task-action-btn task-refill-btn" data-task-id="${task.id}" title="프롬프트에 다시 입력">↩</button>
                <button class="task-action-btn task-copy-btn" data-task-id="${task.id}" title="복사">복사</button>
                ${deleteBtn}
            </div>
        </div>
        <div class="task-item-text">${escapeHtml(displayText)}</div>
        <div class="task-item-meta">
            <span class="history-project">${escapeHtml(task.project)}</span>
            <span class="task-item-time">${timeStr}</span>
        </div>
    `;

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

    return item;
}

function renderTaskList() {
    const list = document.getElementById('tasksList');
    if (!list) return;

    if (taskQueue.length === 0) {
        list.innerHTML = '<div class="history-empty">Add tasks to the queue — they will run sequentially</div>';
        return;
    }

    // DOM diffing: reuse existing items to avoid CSS animation resets (prevents flickering)
    // IMPORTANT: only select DIRECT children of the list — not nested buttons which also have data-task-id
    const existingMap = new Map();
    Array.from(list.children).forEach(el => {
        if (el.dataset && el.dataset.taskId) {
            existingMap.set(parseInt(el.dataset.taskId), el);
        }
    });

    // Remove items that no longer exist in queue
    existingMap.forEach((el, id) => {
        if (!taskQueue.find(t => t.id === id)) el.remove();
    });

    // Update existing items (status only) or add new items
    taskQueue.forEach((task, index) => {
        const existing = existingMap.get(task.id);
        if (existing) {
            // Only update status-related parts — preserves CSS animation state
            const prevStatus = existing.dataset.prevStatus;
            if (prevStatus !== task.status) {
                existing.className = `task-item task-${task.status}`;
                existing.dataset.prevStatus = task.status;
                const dot = existing.querySelector('.task-status-dot');
                if (dot) dot.className = `task-status-dot ${task.status}`;
                const statusEl = existing.querySelector('.task-item-status');
                if (statusEl) { statusEl.className = `task-item-status ${task.status}`; statusEl.textContent = task.status; }
                // Show/hide delete button based on status
                const actionBtns = existing.querySelector('.task-action-btns');
                if (actionBtns) {
                    let delBtn = actionBtns.querySelector('.task-delete-btn');
                    if (task.status !== 'running' && !delBtn) {
                        delBtn = document.createElement('button');
                        delBtn.className = 'task-delete-btn';
                        delBtn.title = 'Remove from queue';
                        delBtn.textContent = '✕';
                        delBtn.onclick = (e) => { e.stopPropagation(); removeTask(task.id); };
                        actionBtns.appendChild(delBtn);
                    } else if (task.status === 'running' && delBtn) {
                        delBtn.remove();
                    }
                }
            }
            // Ensure correct DOM order
            if (list.children[index] !== existing) list.appendChild(existing);
        } else {
            const item = _buildTaskItem(task);
            item.dataset.prevStatus = task.status;
            list.appendChild(item);
        }
    });
}

// ===================================================================
//  Idle Detection → Queue Advancement
//  (consolidated — single handler for terminal.idle)
// ===================================================================

// NOTE: terminal.idle handler is registered once at line ~2967 (AI chat section)
// to avoid duplicate registrations. See the handler there for the combined logic.

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
    updateSendStopButton();
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
//  Auto-Updater UI
// ===================================================================

let updateState = 'idle'; // idle | available | downloading | downloaded
let _pendingUpdateVersion = null; // "다음에하기" 선택 시 저장

function showUpdateBanner(releaseNotes) {
    const banner = document.getElementById('update-banner');
    if (!banner) return;

    // Release notes
    const notesSection = document.getElementById('update-notes-section');
    const notesList = document.getElementById('update-notes-list');
    if (releaseNotes && notesSection && notesList) {
        // Parse release notes — support markdown bullet points or plain text
        let html = '';
        const lines = (typeof releaseNotes === 'string' ? releaseNotes : '').split('\n').filter(l => l.trim());
        if (lines.length > 0) {
            html = '<ul style="margin:0; padding-left: 16px; list-style: none;">';
            for (const line of lines.slice(0, 6)) {
                const text = line.replace(/^[\-\*]\s*/, '').trim();
                if (text) html += `<li style="margin-bottom: 4px;">  ${text}</li>`;
            }
            html += '</ul>';
        }
        if (html) {
            notesList.innerHTML = html;
            notesSection.style.display = '';
        } else {
            notesSection.style.display = 'none';
        }
    }

    banner.style.display = '';
}

function dismissUpdateBanner() {
    const banner = document.getElementById('update-banner');
    if (banner) banner.style.display = 'none';
    // "다음에하기" — 사이드바에 업데이트 버튼 표시
    if (_pendingUpdateVersion) {
        showSidebarUpdateButton(_pendingUpdateVersion);
    }
}

function showSidebarUpdateButton(version) {
    const footer = document.getElementById('app-version-footer');
    if (!footer) return;
    // 이미 있으면 제거하지 않고 업데이트
    let btn = document.getElementById('sidebar-update-btn');
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'sidebar-update-btn';
        btn.style.cssText = 'margin-top:6px;padding:6px 10px;background:linear-gradient(135deg,#238636,#2ea043);color:#fff;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;text-align:center;transition:filter 0.2s;';
        btn.onmouseenter = () => { btn.style.filter = 'brightness(1.15)'; };
        btn.onmouseleave = () => { btn.style.filter = ''; };
        btn.onclick = () => {
            // 업데이트 시작
            updateState = 'downloading';
            ipcRenderer.invoke('updater.download');
            btn.textContent = '다운로드 중...';
            btn.style.opacity = '0.7';
            btn.style.cursor = 'default';
            btn.onclick = null;
            // 배너도 표시
            const progressBar = document.getElementById('update-progress-bar');
            if (progressBar) progressBar.style.display = '';
            const actionBtn = document.getElementById('update-action-btn');
            if (actionBtn) { actionBtn.textContent = '다운로드 중...'; actionBtn.disabled = true; actionBtn.style.opacity = '0.7'; }
            showUpdateBanner();
        };
        footer.appendChild(btn);
    }
    btn.textContent = `v${version} 업데이트`;
}

function hideSidebarUpdateButton() {
    const btn = document.getElementById('sidebar-update-btn');
    if (btn) btn.remove();
}

function onUpdateAction() {
    if (updateState === 'available') {
        // Manual retry download
        updateState = 'downloading';
        ipcRenderer.invoke('updater.download');
        const actionBtn = document.getElementById('update-action-btn');
        const progressBar = document.getElementById('update-progress-bar');
        if (actionBtn) { actionBtn.textContent = '다운로드 중...'; actionBtn.disabled = true; actionBtn.style.opacity = '0.7'; }
        if (progressBar) progressBar.style.display = '';
    } else if (updateState === 'downloaded') {
        const actionBtn = document.getElementById('update-action-btn');
        if (actionBtn) { actionBtn.textContent = '재시작 중...'; actionBtn.disabled = true; }
        ipcRenderer.invoke('updater.install');
    }
}

// Manual update check (triggered by clicking version in sidebar)
async function checkForUpdate() {
    const statusEl = document.getElementById('app-version-status');
    if (statusEl) { statusEl.textContent = '확인중...'; statusEl.style.color = '#8b949e'; statusEl.style.display = ''; }
    try {
        await ipcRenderer.invoke('updater.check');
    } catch (_) {
        if (statusEl) { statusEl.textContent = '확인 실패'; statusEl.style.color = '#f85149'; }
        setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3000);
    }
}

ipcRenderer.on('updater.available', (event, { version, releaseNotes }) => {
    updateState = 'available';
    _pendingUpdateVersion = version;
    const badge = document.getElementById('update-version-badge');
    if (badge) badge.textContent = `v${version}`;
    // 버튼: "업데이트" (활성 상태) — 사용자가 직접 클릭
    const actionBtn = document.getElementById('update-action-btn');
    if (actionBtn) { actionBtn.textContent = '업데이트'; actionBtn.disabled = false; actionBtn.style.opacity = '1'; }
    // 진행바는 숨김 (아직 다운로드 시작 안 함)
    const progressBar = document.getElementById('update-progress-bar');
    if (progressBar) progressBar.style.display = 'none';
    showUpdateBanner(releaseNotes);
    // Update sidebar version status
    const statusEl = document.getElementById('app-version-status');
    if (statusEl) { statusEl.textContent = '● 업데이트 가능'; statusEl.style.color = '#f0883e'; statusEl.style.display = ''; }
    showToast(`새 버전 v${version} 이 있습니다.`, 'info');
});

ipcRenderer.on('updater.not-available', () => {
    // Show "최신 버전" briefly in sidebar
    const statusEl = document.getElementById('app-version-status');
    if (statusEl) { statusEl.textContent = '● 최신'; statusEl.style.color = '#3fb950'; statusEl.style.display = ''; }
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
});

let _updateDownloadedReceived = false;

function _forceDownloadedState() {
    updateState = 'downloaded';
    const actionBtn = document.getElementById('update-action-btn');
    const progressBar = document.getElementById('update-progress-bar');
    if (actionBtn) { actionBtn.textContent = '지금 재시작하여 설치'; actionBtn.disabled = false; actionBtn.style.opacity = '1'; }
    if (progressBar) progressBar.style.display = 'none';
    const statusEl = document.getElementById('app-version-status');
    if (statusEl) { statusEl.textContent = '● 재시작 필요'; statusEl.style.color = '#58a6ff'; statusEl.style.display = ''; }
    // 사이드바 업데이트 버튼 제거 (배너에서 직접 설치 가능)
    hideSidebarUpdateButton();
    showToast('다운로드 완료! 재시작하면 설치됩니다.', 'success');
}

ipcRenderer.on('updater.progress', (event, { percent, transferred, total }) => {
    const fill = document.getElementById('update-progress-fill');
    const text = document.getElementById('update-progress-text');
    if (fill) fill.style.width = `${Math.round(percent)}%`;
    if (text) {
        const mb = (n) => (n / 1024 / 1024).toFixed(1);
        text.textContent = `${mb(transferred)} / ${mb(total)} MB  (${Math.round(percent)}%)`;
    }

    // When progress hits 100%, force downloaded state after 2s if update-downloaded event never fires
    if (percent >= 99.9 && !_updateDownloadedReceived) {
        console.log(`[Updater] Progress 100% reached. _updateDownloadedReceived=${_updateDownloadedReceived}, updateState=${updateState}`);
        clearTimeout(window._updaterFallbackTimer);
        window._updaterFallbackTimer = setTimeout(() => {
            if (!_updateDownloadedReceived && updateState !== 'downloaded') {
                console.log('[Updater] Forcing downloaded state (update-downloaded event missing after 2s)');
                _forceDownloadedState();
            }
        }, 2000);
    }
});

ipcRenderer.on('updater.downloaded', (event, { version }) => {
    _updateDownloadedReceived = true;
    clearTimeout(window._updaterFallbackTimer);
    console.log(`[Updater] update-downloaded received: v${version}`);
    _forceDownloadedState();
    showUpdateBanner();
});

ipcRenderer.on('updater.error', (event, { message }) => {
    if (updateState === 'downloading' || updateState === 'available') {
        const actionBtn = document.getElementById('update-action-btn');
        if (actionBtn) { actionBtn.textContent = '업데이트 실패 — 재시도'; actionBtn.disabled = false; actionBtn.style.opacity = '1'; }
        // Allow manual retry
        updateState = 'available';
    } else {
        updateState = 'idle';
    }
    // Only show error toast for non-dev-mode errors
    if (message && !message.includes('ERR_UPDATER_INVALID_UPDATE_FEED') && !message.includes('dev-app-update')) {
        showToast(`업데이트 오류: ${message}`, 'error');
    }
    const statusEl = document.getElementById('app-version-status');
    if (statusEl) { statusEl.style.display = 'none'; }
});

ipcRenderer.on('updater.autoRestart', (event, { seconds }) => {
    // 자동 재시작 비활성화됨 — 무시 (사용자가 직접 설치)
});

ipcRenderer.on('updater.installFailed', (event, { message }) => {
    updateState = 'downloaded'; // still downloaded, just can't auto-install
    const actionBtn = document.getElementById('update-action-btn');
    if (actionBtn) { actionBtn.textContent = '수동 재시작 필요'; actionBtn.disabled = false; actionBtn.style.opacity = '1'; }
    const statusEl = document.getElementById('app-version-status');
    if (statusEl) { statusEl.textContent = '● 수동 재시작 필요'; statusEl.style.color = '#f85149'; statusEl.style.display = ''; }
    showToast(message, 'error');
});

// ===================================================================
//  Computer Control
// ===================================================================

function ccClearLog() {
    const logEntries = document.getElementById('ccLogEntries');
    if (logEntries) logEntries.innerHTML = '<div class="cc-log-empty">Actions will appear here...</div>';
}

function ccSaveState(projectId) {
    if (!projectId) return;
    const urlInput = document.getElementById('ccUrlInput');
    const taskInput = document.getElementById('ccTaskInput');
    const logEntries = document.getElementById('ccLogEntries');
    const screenshot = document.getElementById('ccScreenshot');
    ccStateMap.set(projectId, {
        url: urlInput ? urlInput.value : '',
        task: taskInput ? taskInput.value : '',
        logsHTML: logEntries ? logEntries.innerHTML : '',
        screenshotSrc: screenshot ? screenshot.src : '',
        screenshotVisible: screenshot ? screenshot.style.display === 'block' : false
    });
}

function ccRestoreState(projectId) {
    const state = projectId ? ccStateMap.get(projectId) : null;
    const urlInput = document.getElementById('ccUrlInput');
    const taskInput = document.getElementById('ccTaskInput');
    const logEntries = document.getElementById('ccLogEntries');
    const screenshot = document.getElementById('ccScreenshot');
    const placeholder = document.getElementById('ccBrowserPlaceholder');
    if (urlInput) urlInput.value = state ? state.url : '';
    if (taskInput) taskInput.value = state ? state.task : '';
    if (logEntries) logEntries.innerHTML = state ? state.logsHTML : '<div class="cc-log-empty">No actions yet</div>';
    if (screenshot) {
        screenshot.src = state && state.screenshotSrc ? state.screenshotSrc : '';
        screenshot.style.display = state && state.screenshotVisible ? 'block' : 'none';
    }
    if (placeholder) placeholder.style.display = state && state.screenshotVisible ? 'none' : '';
}

function toggleComputerControl() {
    // If AI chat is active, close it first
    if (aiChatMode) toggleAiChat();

    // Guard: need a project selected to enter CC mode
    if (!ccMode && !currentProject) {
        showToast('프로젝트를 먼저 선택하세요', 'error');
        return;
    }

    ccMode = !ccMode;

    const terminalContainer = document.getElementById('terminal-container');
    const ccContainer = document.getElementById('cc-container');
    const aiChatContainer = document.getElementById('ai-chat-container');
    const terminalOnlyBtns = document.getElementById('terminalOnlyBtns');
    const toolbarSep = document.getElementById('terminalToolbarSep');
    const contentHeader = document.querySelector('.content-header');
    const ccBtn = document.getElementById('ccToggleBtn');
    const promptArea = document.querySelector('.prompt-area');

    if (ccMode) {
        // Show CC, hide Terminal
        if (terminalContainer) terminalContainer.style.display = 'none';
        if (aiChatContainer) aiChatContainer.style.display = 'none';
        if (ccContainer) ccContainer.style.display = 'flex';
        if (terminalOnlyBtns) terminalOnlyBtns.style.display = 'none';
        if (toolbarSep) toolbarSep.style.display = 'none';
        if (ccBtn) ccBtn.classList.add('active');
        if (contentHeader) contentHeader.style.display = 'none';
        if (promptArea) promptArea.style.display = 'none';

        // Hide other UI elements
        const queueBar = document.getElementById('queueProgressBar');
        if (queueBar) { queueBar.dataset.hiddenByCC = queueBar.style.display !== 'none' ? '1' : ''; queueBar.style.display = 'none'; }
        const imgBar = document.getElementById('imagePreviewBar');
        if (imgBar) { imgBar.dataset.hiddenByCC = imgBar.style.display !== 'none' ? '1' : ''; imgBar.style.display = 'none'; }

        // Create BrowserView + restore state for this project
        ipcRenderer.invoke('computerControl.create', { id: getCcId() }).then(() => {
            ccRestoreState(getCcId());
            // Set bounds after a small delay for layout to settle
            setTimeout(() => ccUpdateBrowserBounds(), 100);
        });
    } else {
        // Save current CC state before closing
        ccSaveState(getCcId());
        // Hide CC, show Terminal
        if (ccContainer) ccContainer.style.display = 'none';
        if (terminalContainer) terminalContainer.style.display = '';
        if (terminalOnlyBtns) terminalOnlyBtns.style.display = '';
        if (toolbarSep) toolbarSep.style.display = '';
        if (ccBtn) ccBtn.classList.remove('active');
        if (contentHeader) contentHeader.style.display = '';
        if (promptArea) promptArea.style.display = '';

        const queueBar = document.getElementById('queueProgressBar');
        if (queueBar && queueBar.dataset.hiddenByCC === '1') queueBar.style.display = '';
        const imgBar = document.getElementById('imagePreviewBar');
        if (imgBar && imgBar.dataset.hiddenByCC === '1') imgBar.style.display = '';

        // Hide BrowserView (set bounds to 0)
        ipcRenderer.invoke('computerControl.setBounds', { id: getCcId(), bounds: { x: 0, y: 0, width: 0, height: 0 } });

        // Re-fit terminal
        if (currentProject) {
            const entry = termPool.get(currentProject.id);
            if (entry) requestAnimationFrame(() => fitEntry(entry));
        }
    }
}

function ccUpdateBrowserBounds() {
    const placeholder = document.getElementById('ccBrowserPlaceholder');
    if (!placeholder) return;
    const panel = placeholder.closest('.cc-browser-panel');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    // BrowserView bounds are relative to the window
    ipcRenderer.invoke('computerControl.setBounds', {
        id: getCcId(),
        bounds: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        }
    });
}

function ccNavigate() {
    const urlInput = document.getElementById('ccUrlInput');
    if (!urlInput) return;
    const url = urlInput.value.trim();
    if (!url) return;
    ipcRenderer.invoke('computerControl.navigate', { id: getCcId(), url });
    // Hide placeholder, show screenshot area
    const placeholder = document.getElementById('ccBrowserPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
}

async function ccStartTask() {
    const taskInput = document.getElementById('ccTaskInput');
    const urlInput = document.getElementById('ccUrlInput');
    if (!taskInput) return;
    const task = taskInput.value.trim();
    if (!task) { showToast('작업 지시를 입력하세요', 'error'); return; }
    const startUrl = urlInput ? urlInput.value.trim() : '';

    const result = await ipcRenderer.invoke('computerControl.startTask', { id: getCcId(), task, startUrl });
    if (!result.success) {
        showToast(result.error, 'error');
        return;
    }
    // Update UI
    document.getElementById('ccStartBtn').style.display = 'none';
    document.getElementById('ccStopBtn').style.display = '';
    // Clear log
    const logEntries = document.getElementById('ccLogEntries');
    if (logEntries) logEntries.innerHTML = '';
}

function ccStopTask() {
    ipcRenderer.invoke('computerControl.stop', { id: getCcId() });
}

async function ccAutoVerify() {
    if (!currentProject) { showToast('프로젝트를 선택하세요', 'error'); return; }

    // Switch to CC mode if not already — wait for CC to initialize
    if (!ccMode) {
        toggleComputerControl();
        await new Promise(r => setTimeout(r, 400));
    }

    const verifyBtn = document.getElementById('ccVerifyBtn');
    if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.textContent = '🔍 탐지 중...';
    }

    // Clear log
    const logEntries = document.getElementById('ccLogEntries');
    if (logEntries) logEntries.innerHTML = '';

    const result = await ipcRenderer.invoke('computerControl.autoVerify', {
        id: getCcId(),
        projectId: currentProject.id
    });

    if (!result.success) {
        showToast(result.error, 'error');
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.textContent = '🔍 자동 검증';
        }
        return;
    }

    // Update URL input with detected URL
    const urlInput = document.getElementById('ccUrlInput');
    if (urlInput) urlInput.value = result.url;

    // Hide placeholder
    const placeholder = document.getElementById('ccBrowserPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    // Update buttons
    document.getElementById('ccStartBtn').style.display = 'none';
    document.getElementById('ccStopBtn').style.display = '';
    if (verifyBtn) {
        verifyBtn.style.display = 'none';
    }

    // Update browser bounds
    setTimeout(() => ccUpdateBrowserBounds(), 200);
}

// IPC listeners for Computer Control
ipcRenderer.on('computerControl.updated', (event, data) => {
    // Only update UI if this is the current project's CC instance
    if (data.id !== getCcId()) return;

    const statusDot = document.getElementById('ccStatusDot');
    const statusText = document.getElementById('ccStatusText');
    const loopCount = document.getElementById('ccLoopCount');
    const startBtn = document.getElementById('ccStartBtn');
    const stopBtn = document.getElementById('ccStopBtn');

    if (statusDot) {
        statusDot.className = 'cc-status-dot';
        if (data.state === 'running') statusDot.classList.add('running');
        else if (data.state === 'stopped') statusDot.classList.add('stopped');
        else statusDot.classList.add('idle');
    }
    if (statusText) {
        statusText.textContent = data.state === 'running' ? 'Running...' : data.state === 'stopped' ? 'Stopped' : 'Idle';
    }
    if (loopCount && data.state === 'running') {
        loopCount.textContent = `Loop ${data.loopCount}/${data.maxLoops}`;
    } else if (loopCount) {
        loopCount.textContent = data.loopCount > 0 ? `${data.loopCount} loops completed` : '';
    }
    const verifyBtn = document.getElementById('ccVerifyBtn');
    if (startBtn && stopBtn) {
        if (data.state === 'running') {
            startBtn.style.display = 'none';
            stopBtn.style.display = '';
            if (verifyBtn) verifyBtn.style.display = 'none';
        } else {
            startBtn.style.display = '';
            stopBtn.style.display = 'none';
            if (verifyBtn) {
                verifyBtn.style.display = '';
                verifyBtn.disabled = false;
                verifyBtn.textContent = '🔍 자동 검증';
            }
        }
    }
});

ipcRenderer.on('computerControl.screenshot', (event, data) => {
    if (data.id !== getCcId()) {
        // Buffer screenshot for background project
        const st = ccStateMap.get(data.id) || {};
        st.screenshotSrc = 'data:image/png;base64,' + data.base64;
        st.screenshotVisible = true;
        ccStateMap.set(data.id, st);
        return;
    }
    const img = document.getElementById('ccScreenshot');
    const placeholder = document.getElementById('ccBrowserPlaceholder');
    if (img) {
        img.src = 'data:image/png;base64,' + data.base64;
        img.style.display = 'block';
    }
    if (placeholder) placeholder.style.display = 'none';
});

ipcRenderer.on('computerControl.actionLog', (event, data) => {
    if (data.id !== getCcId()) {
        // Buffer action log for background project
        const st = ccStateMap.get(data.id) || {};
        const time = new Date(data.timestamp);
        const timeStr = time.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const logLine = `<div class="cc-log-entry type-${data.type}"><span class="cc-log-time">${timeStr}</span>${escapeHtml(data.message)}</div>`;
        st.logsHTML = (st.logsHTML || '') + logLine;
        ccStateMap.set(data.id, st);
        return;
    }
    const logEntries = document.getElementById('ccLogEntries');
    if (!logEntries) return;
    // Remove empty placeholder
    const empty = logEntries.querySelector('.cc-log-empty');
    if (empty) empty.remove();

    const entry = document.createElement('div');
    entry.className = `cc-log-entry type-${data.type}`;
    const time = new Date(data.timestamp);
    const timeStr = time.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="cc-log-time">${timeStr}</span>${escapeHtml(data.message)}`;
    logEntries.appendChild(entry);
    logEntries.scrollTop = logEntries.scrollHeight;
});

ipcRenderer.on('computerControl.error', (event, data) => {
    showToast(`CC Error: ${data.message}`, 'error');
});

ipcRenderer.on('computerControl.verifyResult', (event, data) => {
    // Only handle for current project
    if (data.id !== getCcId()) return;

    // Restore verify button
    const verifyBtn = document.getElementById('ccVerifyBtn');
    if (verifyBtn) {
        verifyBtn.style.display = '';
        verifyBtn.disabled = false;
        verifyBtn.textContent = '🔍 자동 검증';
    }

    // Add summary to action log
    const logEntries = document.getElementById('ccLogEntries');
    if (logEntries && data.summary) {
        const entry = document.createElement('div');
        entry.className = 'cc-log-entry type-verify-result';
        entry.innerHTML = `<div style="color:var(--accent-purple); font-weight:600; margin-bottom:4px;">📋 검증 결과 요약</div><div style="white-space:pre-wrap; font-size:12px; line-height:1.5;">${escapeHtml(data.summary)}</div>`;
        logEntries.appendChild(entry);
        logEntries.scrollTop = logEntries.scrollHeight;
    }

    showToast('자동 검증 완료', 'success');
});

// Update CC browser bounds on window resize
window.addEventListener('resize', () => {
    if (ccMode) {
        ccUpdateBrowserBounds();
    }
});

// ===================================================================
//  Browser Control (Chrome Extension)
// ===================================================================

function bcLog(msg, type = 'info') {
    const log = document.getElementById('bcLog');
    if (!log) return;
    const entry = document.createElement('div');
    entry.className = `bc-log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    // 최대 100개 유지
    while (log.children.length > 100) log.removeChild(log.firstChild);
}

function bcUpdateStatus(connected) {
    bcExtConnected = connected;
    const dot = document.getElementById('bcStatusDot');
    const text = document.getElementById('bcStatusText');
    if (dot) dot.className = 'bc-status-dot' + (connected ? ' on' : '');
    if (text) text.textContent = connected ? 'Extension connected' : 'Extension disconnected';
}

function bcSaveState(projectId) {
    const img = document.getElementById('bcScreenshotImg');
    const urlInput = document.getElementById('bcUrlInput');
    const log = document.getElementById('bcLog');
    bcStateMap.set(projectId, {
        screenshotSrc: img?.src || '',
        screenshotVisible: img?.style.display !== 'none',
        url: urlInput?.value || '',
        logHTML: log?.innerHTML || '',
    });
}

function bcRestoreState(projectId) {
    const state = bcStateMap.get(projectId) || {};
    const img = document.getElementById('bcScreenshotImg');
    const placeholder = document.getElementById('bcPlaceholder');
    const urlInput = document.getElementById('bcUrlInput');
    const log = document.getElementById('bcLog');
    if (img) {
        if (state.screenshotSrc && state.screenshotVisible) {
            img.src = state.screenshotSrc;
            img.style.display = '';
            if (placeholder) placeholder.style.display = 'none';
        } else {
            img.src = '';
            img.style.display = 'none';
            if (placeholder) placeholder.style.display = '';
        }
    }
    if (urlInput) urlInput.value = state.url || '';
    if (log) log.innerHTML = state.logHTML || '';
}

function toggleBrowserControl() {
    if (aiChatMode) toggleAiChat();
    if (ccMode) toggleComputerControl();

    browserMode = !browserMode;

    const terminalContainer = document.getElementById('terminal-container');
    const browserContainer = document.getElementById('browser-container');
    const terminalOnlyBtns = document.getElementById('terminalOnlyBtns');
    const toolbarSep = document.getElementById('terminalToolbarSep');
    const contentHeader = document.querySelector('.content-header');
    const bcBtn = document.getElementById('bcToggleBtn');
    const promptArea = document.querySelector('.prompt-area');
    const timelinePanel = document.getElementById('timeline-panel');

    if (browserMode) {
        if (terminalContainer) terminalContainer.style.display = 'none';
        if (timelinePanel) timelinePanel.style.display = 'none';
        if (browserContainer) browserContainer.style.display = 'flex';
        if (terminalOnlyBtns) terminalOnlyBtns.style.display = 'none';
        if (toolbarSep) toolbarSep.style.display = 'none';
        if (contentHeader) contentHeader.style.display = 'none';
        if (bcBtn) bcBtn.classList.add('active');
        if (promptArea) promptArea.style.display = 'none';

        const queueBar = document.getElementById('queueProgressBar');
        if (queueBar) { queueBar.dataset.hiddenByBC = queueBar.style.display !== 'none' ? '1' : ''; queueBar.style.display = 'none'; }

        // 연결 상태 동기화
        ipcRenderer.invoke('browser.isConnected').then(connected => bcUpdateStatus(connected));

        // 자동갱신 배지 초기화
        const autoBadge = document.getElementById('bcAutoBadge');
        const autoBtn = document.getElementById('bcAutoRefreshBtn');
        if (autoBadge) autoBadge.classList.toggle('on', bcAutoRefresh);
        if (autoBtn) autoBtn.classList.toggle('active', bcAutoRefresh);

        // 프로젝트별 상태 복원
        if (currentProject) bcRestoreState(currentProject.id);

        // JS input Ctrl+Enter 바인딩
        const jsInput = document.getElementById('bcJsInput');
        if (jsInput && !jsInput._bcBound) {
            jsInput._bcBound = true;
            jsInput.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') bcExecute();
            });
        }

        // 스크린샷 직접 클릭 바인딩
        const ssImg = document.getElementById('bcScreenshotImg');
        if (ssImg && !ssImg._bcClickBound) {
            ssImg._bcClickBound = true;
            ssImg.classList.add('interactive');

            // 클릭 → 브라우저 제어
            ssImg.addEventListener('click', async (e) => {
                if (!bcExtConnected) { showToast('Extension not connected', 'error'); return; }
                const rect = ssImg.getBoundingClientRect();
                const scaleX = (ssImg.naturalWidth || rect.width) / rect.width;
                const scaleY = (ssImg.naturalHeight || rect.height) / rect.height;
                const x = Math.round((e.clientX - rect.left) * scaleX);
                const y = Math.round((e.clientY - rect.top) * scaleY);

                // 클릭 피드백 애니메이션
                bcShowClickFlash(e.clientX - rect.left, e.clientY - rect.top);

                if (bcCurrentMode === 'type') {
                    // 입력 모드: 먼저 그 위치 클릭 후 입력 오버레이 표시
                    await bcSend('clickXY', { x, y });
                    bcShowTypeOverlay();
                } else if (bcCurrentMode === 'dblclick') {
                    await bcSend('doubleClick_xy', { x, y });
                    bcLog(`✌️ 더블클릭 (${x}, ${y})`, 'ok');
                } else if (bcCurrentMode === 'rightclick') {
                    await ipcRenderer.invoke('browser.send', { type: 'rightClick_xy', x, y });
                    bcLog(`👆 우클릭 (${x}, ${y})`, 'ok');
                } else {
                    // 기본: 클릭
                    await bcSend('clickXY', { x, y });
                    bcLog(`🖱️ 클릭 (${x}, ${y})`, 'ok');
                }

                // 자동 갱신
                if (bcAutoRefresh) setTimeout(() => bcScreenshot(), 600);
            });

            // 마우스 이동 → 좌표 표시
            ssImg.addEventListener('mousemove', (e) => {
                const rect = ssImg.getBoundingClientRect();
                const scaleX = (ssImg.naturalWidth || rect.width) / rect.width;
                const scaleY = (ssImg.naturalHeight || rect.height) / rect.height;
                const x = Math.round((e.clientX - rect.left) * scaleX);
                const y = Math.round((e.clientY - rect.top) * scaleY);
                const tip = document.getElementById('bcCoordTip');
                const disp = document.getElementById('bcCoordDisplay');
                if (tip) {
                    tip.style.display = 'block';
                    tip.style.left = (e.clientX - rect.left + 10) + 'px';
                    tip.style.top = (e.clientY - rect.top - 24) + 'px';
                    tip.textContent = `${x}, ${y}`;
                }
                if (disp) disp.textContent = `${x}, ${y}`;
            });

            ssImg.addEventListener('mouseleave', () => {
                const tip = document.getElementById('bcCoordTip');
                if (tip) tip.style.display = 'none';
                const disp = document.getElementById('bcCoordDisplay');
                if (disp) disp.textContent = '';
            });

            // 스크롤 → 브라우저 스크롤
            ssImg.addEventListener('wheel', async (e) => {
                e.preventDefault();
                if (!bcExtConnected) return;
                await ipcRenderer.invoke('browser.send', { type: 'scroll', x: 0, y: Math.round(e.deltaY) });
                if (bcAutoRefresh) setTimeout(() => bcScreenshot(), 400);
            }, { passive: false });
        }
    } else {
        if (browserContainer) browserContainer.style.display = 'none';
        if (terminalContainer) terminalContainer.style.display = '';
        if (terminalOnlyBtns) terminalOnlyBtns.style.display = '';
        if (toolbarSep) toolbarSep.style.display = '';
        if (contentHeader) contentHeader.style.display = '';
        if (bcBtn) bcBtn.classList.remove('active');
        if (promptArea) promptArea.style.display = '';

        const queueBar = document.getElementById('queueProgressBar');
        if (queueBar && queueBar.dataset.hiddenByBC === '1') queueBar.style.display = '';

        // 현재 프로젝트 상태 저장
        if (currentProject) bcSaveState(currentProject.id);
    }
}

async function bcSend(type, params = {}) {
    if (!bcExtConnected) { showToast('Extension not connected', 'error'); return null; }
    const result = await ipcRenderer.invoke('browser.send', { type, ...params });
    if (result?.error) {
        bcLog(`❌ ${type}: ${result.error}`, 'err');
        showToast(result.error, 'error');
    }
    return result;
}

// ===================================================================
//  직접 제어 — 모드 / 스크롤 / 입력 오버레이
// ===================================================================

function bcSetMode(mode) {
    bcCurrentMode = mode;
    const modes = ['click', 'dblclick', 'rightclick', 'type'];
    const ids = { click: 'bcModeClick', dblclick: 'bcModeDbl', rightclick: 'bcModeRight', type: 'bcModeType' };
    modes.forEach(m => {
        const btn = document.getElementById(ids[m]);
        if (btn) btn.classList.toggle('active', m === mode);
    });
    const img = document.getElementById('bcScreenshotImg');
    if (img) {
        img.className = 'interactive';
        if (mode === 'type') img.classList.add('mode-type');
        else if (mode === 'scroll') img.classList.add('mode-scroll');
    }
    if (mode !== 'type') bcHideTypeOverlay();
}

function bcToggleAutoRefresh() {
    bcAutoRefresh = !bcAutoRefresh;
    const btn = document.getElementById('bcAutoRefreshBtn');
    const badge = document.getElementById('bcAutoBadge');
    if (btn) btn.classList.toggle('active', bcAutoRefresh);
    if (badge) badge.classList.toggle('on', bcAutoRefresh);
    bcLog(bcAutoRefresh ? '🔄 자동 갱신 켜짐' : '자동 갱신 꺼짐', 'info');
}

function bcShowClickFlash(localX, localY) {
    const area = document.getElementById('bcScreenshotArea');
    if (!area) return;
    const flash = document.createElement('div');
    flash.className = 'bc-click-flash';
    flash.style.left = localX + 'px';
    flash.style.top = localY + 'px';
    area.appendChild(flash);
    setTimeout(() => flash.remove(), 450);
}

function bcShowTypeOverlay() {
    const overlay = document.getElementById('bcTypeOverlay');
    if (overlay) {
        overlay.classList.add('show');
        const input = document.getElementById('bcTypeOverlayInput');
        if (input) { input.value = ''; input.focus(); }
    }
}

function bcHideTypeOverlay() {
    const overlay = document.getElementById('bcTypeOverlay');
    if (overlay) overlay.classList.remove('show');
}

async function bcSendTypeOverlay() {
    const input = document.getElementById('bcTypeOverlayInput');
    const text = input?.value || '';
    if (!text) return;
    bcLog(`⌨️ 입력: "${text}"`, 'info');
    const r = await bcSend('typeAtFocus', { text });
    if (r && !r.error) {
        bcLog('✓ 입력 완료', 'ok');
        if (input) input.value = '';
        bcHideTypeOverlay();
        if (bcAutoRefresh) setTimeout(() => bcScreenshot(), 500);
    }
}

async function bcScrollPage(delta) {
    if (!bcExtConnected) { showToast('Extension not connected', 'error'); return; }
    await ipcRenderer.invoke('browser.send', { type: 'scroll', x: 0, y: delta });
    bcLog(`↕ 스크롤 ${delta > 0 ? '▼' : '▲'} ${Math.abs(delta)}px`, 'info');
    if (bcAutoRefresh) setTimeout(() => bcScreenshot(), 400);
}

async function bcAttach() {
    bcLog('Attaching debugger to active tab...', 'info');
    const r = await bcSend('attach');
    if (r && !r.error) {
        bcLog(`✓ Attached (tabId: ${r.tabId})`, 'ok');
        showToast('Debugger attached', 'success');
    }
}

async function bcScreenshot() {
    const r = await bcSend('screenshot');
    if (!r || r.error) return;
    const img = document.getElementById('bcScreenshotImg');
    const placeholder = document.getElementById('bcPlaceholder');
    if (img) {
        img.src = 'data:image/png;base64,' + r.data;
        img.style.display = '';
        if (placeholder) placeholder.style.display = 'none';
        bcLog('📸 Screenshot captured', 'ok');
    }
}

async function bcNavigate() {
    const url = document.getElementById('bcUrlInput')?.value?.trim();
    if (!url) return;
    bcLog(`→ Navigate: ${url}`, 'info');
    const r = await bcSend('navigate', { url });
    if (r && !r.error) {
        bcLog('✓ Navigated', 'ok');
        // 자동 스크린샷
        setTimeout(() => bcScreenshot(), 1200);
    }
}

async function bcExecute() {
    const script = document.getElementById('bcJsInput')?.value?.trim();
    if (!script) return;
    bcLog(`> ${script.slice(0, 60)}`, 'info');
    const r = await bcSend('execute', { script });
    if (!r || r.error) return;
    const resultEl = document.getElementById('bcJsResult');
    if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.textContent = JSON.stringify(r.result, null, 2);
    }
    bcLog(`✓ ${JSON.stringify(r.result).slice(0, 80)}`, 'ok');
}

async function bcClick() {
    const selector = document.getElementById('bcSelectorInput')?.value?.trim();
    if (!selector) return;
    bcLog(`Click: ${selector}`, 'info');
    const r = await bcSend('click', { selector });
    if (r && !r.error) bcLog('✓ Clicked', 'ok');
}

async function bcType() {
    const selector = document.getElementById('bcSelectorInput')?.value?.trim();
    const text = document.getElementById('bcTypeInput')?.value || '';
    if (!selector) return;
    bcLog(`Type "${text}" → ${selector}`, 'info');
    const r = await bcSend('type', { selector, text });
    if (r && !r.error) bcLog('✓ Typed', 'ok');
}

// IPC: 익스텐션 연결/해제 실시간 수신
ipcRenderer.on('browser.extConnected', (event, connected) => {
    bcUpdateStatus(connected);
    if (browserMode) bcLog(connected ? '✓ Extension connected' : '⚠ Extension disconnected', connected ? 'ok' : 'err');
});

// IPC: CDP push 이벤트 (콘솔/네트워크 스트리밍)
ipcRenderer.on('browser.response', (event, msg) => {
    if (msg?.type !== 'cdp-event') return; // 명령 응답은 무시
    const method = msg.method;
    const params = msg.params || {};

    // 콘솔 캡처
    if (method === 'Runtime.consoleAPICalled' || method === 'Log.entryAdded') {
        const el = document.getElementById('bcConsoleLog');
        if (!el) return;
        el.style.display = 'block';
        let text, level;
        if (method === 'Runtime.consoleAPICalled') {
            level = params.type || 'log';
            const args = (params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description || JSON.stringify(a)).join(' ');
            text = `[${level}] ${args}`;
        } else {
            const e = params.entry || {};
            level = e.level || 'log';
            text = `[${level}] ${e.text || ''}`;
        }
        const div = document.createElement('div');
        div.style.cssText = `padding:1px 0; border-bottom:1px solid #1a1a1a; color:${level==='error'?'#e05555':level==='warn'?'#ffcc44':'#9ccc65'};`;
        div.textContent = `${new Date().toLocaleTimeString()} ${text}`;
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
        while (el.children.length > 200) el.removeChild(el.firstChild);
        return;
    }

    // 네트워크 캡처
    if (method === 'Network.requestWillBeSent') {
        const el = document.getElementById('bcNetLog');
        if (!el) return;
        el.style.display = 'block';
        const req = params.request || {};
        const div = document.createElement('div');
        div.dataset.reqId = params.requestId;
        div.style.cssText = 'padding:2px 0; border-bottom:1px solid #1a1a1a; color:#5ab4f7; cursor:pointer;';
        div.title = req.url;
        div.textContent = `→ ${req.method} ${req.url?.slice(0, 80)}`;
        div.onclick = () => bcShowNetDetails(div);
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
        while (el.children.length > 300) el.removeChild(el.firstChild);
        return;
    }
    if (method === 'Network.responseReceived') {
        const el = document.getElementById('bcNetLog');
        if (!el) return;
        const resp = params.response || {};
        const status = resp.status;
        // 기존 요청 행 업데이트
        const existing = el.querySelector(`[data-req-id="${params.requestId}"]`);
        if (existing) {
            existing.dataset.respStatus = status;
            existing.dataset.mimeType = resp.mimeType || '';
            existing.style.color = status >= 400 ? '#e05555' : status >= 300 ? '#ffcc44' : '#4caf81';
            existing.textContent = `${status} ${resp.mimeType?.split(';')[0] || ''} ${existing.title?.slice(0, 70)}`;
        }
        return;
    }
});

// ===================================================================
//  Browser Control — GUI 심화
// ===================================================================

async function bcHover() {
    const selector = document.getElementById('bcSelectorInput')?.value?.trim();
    if (!selector) return;
    bcLog(`Hover: ${selector}`, 'info');
    const r = await bcSend('hover', { selector });
    if (r && !r.error) bcLog('✓ Hovered', 'ok');
}

async function bcRightClick() {
    const selector = document.getElementById('bcSelectorInput')?.value?.trim();
    if (!selector) return;
    bcLog(`RightClick: ${selector}`, 'info');
    const r = await bcSend('rightClick', { selector });
    if (r && !r.error) bcLog('✓ Right-clicked', 'ok');
}

async function bcDoubleClick() {
    const selector = document.getElementById('bcSelectorInput')?.value?.trim();
    if (!selector) return;
    bcLog(`DoubleClick: ${selector}`, 'info');
    const r = await bcSend('doubleClick', { selector });
    if (r && !r.error) bcLog('✓ Double-clicked', 'ok');
}

async function bcDrag() {
    const from = document.getElementById('bcDragFrom')?.value?.trim();
    const to = document.getElementById('bcDragTo')?.value?.trim();
    if (!from || !to) return;
    bcLog(`Drag: ${from} → ${to}`, 'info');
    const r = await bcSend('drag', { from, to });
    if (r && !r.error) bcLog('✓ Dragged', 'ok');
}

async function bcHighlight() {
    const selector = document.getElementById('bcHighlightSel')?.value?.trim();
    if (!selector) return;
    bcLog(`Highlight: ${selector}`, 'info');
    const r = await bcSend('highlight', { selector });
    if (r && !r.error) bcLog(`✓ ${r.result}`, 'ok');
}

async function bcKeyShortcut() {
    const combo = document.getElementById('bcKeyCombo')?.value?.trim();
    if (!combo) return;
    bcLog(`Key: ${combo}`, 'info');
    const r = await bcSend('keyShortcut', { combo });
    if (r && !r.error) bcLog('✓ Key sent', 'ok');
}

// ===================================================================
//  Browser Control — 요소 탐색
// ===================================================================

function bcShowFindResult(results) {
    const el = document.getElementById('bcFindResult');
    if (!el) return;
    if (!results || results.length === 0) {
        el.style.display = 'block';
        el.textContent = '(결과 없음)';
        return;
    }
    el.style.display = 'block';
    el.innerHTML = results.map((r, i) =>
        `<div style="padding:2px 0; border-bottom:1px solid #1a1a1a; cursor:pointer;" onclick="bcLog('${i+1}. <${r.tag}> ${(r.text||'').replace(/'/g,'\u2019').slice(0,40)}','info')">${i+1}. &lt;${r.tag}&gt; ${(r.text||'(no text)').slice(0,50)} <span style="color:#555;">(${r.x},${r.y})</span></div>`
    ).join('');
}

async function bcFindByText() {
    const text = document.getElementById('bcFindText')?.value?.trim();
    if (!text) return;
    bcLog(`FindByText: "${text}"`, 'info');
    const r = await bcSend('findByText', { text });
    if (!r || r.error) return;
    bcLog(`✓ ${r.results?.length || 0}개 발견`, 'ok');
    bcShowFindResult(r.results);
}

async function bcFindByRole() {
    const role = document.getElementById('bcFindRole')?.value?.trim();
    if (!role) return;
    bcLog(`FindByRole: "${role}"`, 'info');
    const r = await bcSend('findByRole', { role });
    if (!r || r.error) return;
    bcLog(`✓ ${r.results?.length || 0}개 발견`, 'ok');
    bcShowFindResult(r.results);
}

async function bcListInteractive() {
    bcLog('Listing interactive elements...', 'info');
    const r = await bcSend('listInteractive');
    if (!r || r.error) return;
    bcLog(`✓ ${r.results?.length || 0}개`, 'ok');
    bcShowFindResult(r.results);
}

// ===================================================================
//  Browser Control — 콘솔
// ===================================================================

async function bcToggleConsole() {
    if (!bcConsoleCaptured) {
        const r = await bcSend('startConsoleCapture');
        if (!r || r.error) return;
        bcConsoleCaptured = true;
        const indicator = document.getElementById('bcConsoleIndicator');
        const status = document.getElementById('bcConsoleStatus');
        const btn = document.getElementById('bcConsoleToggleBtn');
        if (indicator) indicator.classList.add('on');
        if (status) status.textContent = '캡처 중...';
        if (btn) btn.textContent = '중지';
        bcLog('✓ Console capture started', 'ok');
    } else {
        const r = await bcSend('stopConsoleCapture');
        bcConsoleCaptured = false;
        const indicator = document.getElementById('bcConsoleIndicator');
        const status = document.getElementById('bcConsoleStatus');
        const btn = document.getElementById('bcConsoleToggleBtn');
        if (indicator) indicator.classList.remove('on');
        if (status) status.textContent = '중지됨';
        if (btn) btn.textContent = '시작';
        bcLog('Console capture stopped', 'info');
    }
}

// ===================================================================
//  Browser Control — 네트워크
// ===================================================================

async function bcToggleNetwork() {
    if (!bcNetworkCaptured) {
        const r = await bcSend('startNetworkCapture');
        if (!r || r.error) return;
        bcNetworkCaptured = true;
        const indicator = document.getElementById('bcNetIndicator');
        const status = document.getElementById('bcNetStatus');
        const btn = document.getElementById('bcNetToggleBtn');
        if (indicator) indicator.classList.add('on');
        if (status) status.textContent = '캡처 중...';
        if (btn) btn.textContent = '중지';
        const log = document.getElementById('bcNetLog');
        if (log) log.style.display = 'block';
        bcLog('✓ Network capture started', 'ok');
    } else {
        await bcSend('stopNetworkCapture');
        bcNetworkCaptured = false;
        const indicator = document.getElementById('bcNetIndicator');
        const status = document.getElementById('bcNetStatus');
        const btn = document.getElementById('bcNetToggleBtn');
        if (indicator) indicator.classList.remove('on');
        if (status) status.textContent = '중지됨';
        if (btn) btn.textContent = '시작';
        bcLog('Network capture stopped', 'info');
    }
}

function bcClearNetwork() {
    const el = document.getElementById('bcNetLog');
    if (el) el.innerHTML = '';
}

async function bcShowNetDetails(div) {
    const reqId = div.dataset.reqId;
    if (!reqId) return;
    const r = await bcSend('getResponseBody', { requestId: reqId });
    if (!r || r.error) return;
    const body = r.body;
    const text = body?.body ? (body.base64Encoded ? atob(body.body).slice(0, 500) : body.body.slice(0, 500)) : '(no body)';
    bcLog(`Body[${reqId.slice(-6)}]: ${text}`, 'info');
}

// ===================================================================
//  Browser Control — 스토리지
// ===================================================================

function bcShowStorage(data) {
    const el = document.getElementById('bcStorageResult');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = JSON.stringify(data, null, 2);
}

async function bcGetLocalStorage() {
    bcLog('Getting localStorage...', 'info');
    const r = await bcSend('getLocalStorage');
    if (!r || r.error) return;
    bcLog(`✓ ${Object.keys(r.data || {}).length}개 항목`, 'ok');
    bcShowStorage(r.data);
}

async function bcGetSessionStorage() {
    bcLog('Getting sessionStorage...', 'info');
    const r = await bcSend('getSessionStorage');
    if (!r || r.error) return;
    bcLog(`✓ ${Object.keys(r.data || {}).length}개 항목`, 'ok');
    bcShowStorage(r.data);
}

async function bcGetCookies() {
    bcLog('Getting cookies...', 'info');
    const r = await bcSend('getCookies');
    if (!r || r.error) return;
    bcLog(`✓ ${r.cookies?.length || 0}개 쿠키`, 'ok');
    bcShowStorage(r.cookies);
}

async function bcSetLocalStorage() {
    const key = document.getElementById('bcStorageKey')?.value?.trim();
    const val = document.getElementById('bcStorageVal')?.value || '';
    if (!key) return;
    bcLog(`Set localStorage[${key}] = ${val}`, 'info');
    const r = await bcSend('setLocalStorage', { key, value: val });
    if (r && !r.error) bcLog('✓ Set', 'ok');
}

async function bcRemoveLocalStorage() {
    const key = document.getElementById('bcStorageKey')?.value?.trim();
    if (!key) return;
    bcLog(`Remove localStorage[${key}]`, 'info');
    const r = await bcSend('removeLocalStorage', { key });
    if (r && !r.error) bcLog('✓ Removed', 'ok');
}

// ===================================================================
//  Browser Control — 성능 + 풀페이지 스크린샷
// ===================================================================

async function bcGetPerf() {
    bcLog('Getting performance metrics...', 'info');
    const r = await bcSend('getPerformanceMetrics');
    if (!r || r.error) return;
    const el = document.getElementById('bcPerfResult');
    if (el) {
        el.style.display = 'block';
        const metrics = (r.metrics || []).filter(m => ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','JSHeapUsedSize','JSHeapTotalSize','Documents','Frames','LayoutCount','RecalcStyleCount'].includes(m.name));
        el.textContent = metrics.map(m => `${m.name}: ${typeof m.value === 'number' && m.value > 1000 ? (m.value/1024/1024).toFixed(2)+'MB' : m.value}`).join('\n');
    }
    bcLog(`✓ ${r.metrics?.length || 0}개 메트릭`, 'ok');
}

async function bcFullPage() {
    bcLog('Capturing full page...', 'info');
    const r = await bcSend('fullPageScreenshot');
    if (!r || r.error) return;
    const img = document.getElementById('bcScreenshotImg');
    const placeholder = document.getElementById('bcPlaceholder');
    if (img) {
        img.src = 'data:image/png;base64,' + r.data;
        img.style.display = '';
        if (placeholder) placeholder.style.display = 'none';
        bcLog('✓ Full page screenshot captured', 'ok');
    }
}

// ===================================================================
//  Browser AI Agent — Gemini Vision
// ===================================================================

let bcAiRunning = false;

function bcAiAddStep(icon, text, cls = '', thumbBase64 = null) {
    const container = document.getElementById('bcAiSteps');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `bc-ai-step ${cls}`;
    div.innerHTML = `<span class="bc-ai-step-icon">${icon}</span><span class="bc-ai-step-text">${text.replace(/</g,'&lt;')}</span>`;
    if (thumbBase64) {
        const img = document.createElement('img');
        img.className = 'bc-ai-thumb';
        img.src = 'data:image/png;base64,' + thumbBase64;
        img.onclick = () => {
            const bcImg = document.getElementById('bcScreenshotImg');
            const ph = document.getElementById('bcPlaceholder');
            if (bcImg) { bcImg.src = img.src; bcImg.style.display = ''; if (ph) ph.style.display = 'none'; }
        };
        div.appendChild(img);
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function bcAiSetRunning(running) {
    bcAiRunning = running;
    const btn = document.getElementById('bcAiRunBtn');
    if (btn) {
        btn.textContent = running ? '⏹ 중지' : '▶ 시작';
        btn.classList.toggle('running', running);
    }
}

async function bcAiToggle() {
    if (bcAiRunning) {
        ipcRenderer.send('browser.aiAgent.stop');
        bcAiSetRunning(false);
        return;
    }
    if (!bcExtConnected) { showToast('Extension not connected', 'error'); return; }
    const goal = document.getElementById('bcAiGoal')?.value?.trim();
    if (!goal) { showToast('목표를 입력하세요', 'error'); return; }
    const maxSteps = parseInt(document.getElementById('bcAiMaxSteps')?.value || '10');

    // 스텝 초기화
    const stepsEl = document.getElementById('bcAiSteps');
    if (stepsEl) stepsEl.innerHTML = '';
    document.getElementById('bcAiStepCounter').textContent = '';

    bcAiSetRunning(true);
    const result = await ipcRenderer.invoke('browser.aiAgent.start', { goal, maxSteps });
    if (result?.error) {
        bcAiAddStep('❌', result.error, 'err');
        showToast(result.error, 'error');
    }
    bcAiSetRunning(false);
}

ipcRenderer.on('browser.aiStep', (event, step) => {
    const counter = document.getElementById('bcAiStepCounter');
    switch (step.type) {
        case 'start':
            bcAiAddStep('🎯', `목표: ${step.goal}`, 'ok');
            break;
        case 'screenshot':
            if (counter) counter.textContent = `Step ${step.step}`;
            bcAiAddStep('📸', `Step ${step.step} — 화면 캡처 중...`, 'thinking');
            break;
        case 'thinking':
            bcAiAddStep('🧠', `Gemini 분석 중...`, 'thinking');
            break;
        case 'action': {
            const a = step.action;
            const actionDesc = {
                click: `클릭 (${a.x}, ${a.y})`,
                type: `입력: "${a.text}"`,
                navigate: `이동: ${a.text}`,
                scroll: `스크롤 ${a.direction} ${a.amount || 300}px`,
                wait: `대기 중...`,
            }[a.action] || a.action;
            bcAiAddStep('⚡', `${actionDesc} — ${a.reason || ''}`, '', step.screenshot);
            // 스크린샷도 메인 뷰에 반영
            const bcImg = document.getElementById('bcScreenshotImg');
            const ph = document.getElementById('bcPlaceholder');
            if (bcImg && step.screenshot) { bcImg.src = 'data:image/png;base64,' + step.screenshot; bcImg.style.display = ''; if (ph) ph.style.display = 'none'; }
            break;
        }
        case 'done':
            bcAiAddStep('✅', `완료 (${step.step} steps) — ${step.reason || ''}`, 'done');
            if (counter) counter.textContent = `✓ ${step.step} steps`;
            bcAiSetRunning(false);
            showToast('AI 작업 완료', 'success');
            break;
        case 'stopped':
            bcAiAddStep('⏹', '사용자에 의해 중지됨', '');
            bcAiSetRunning(false);
            break;
        case 'maxSteps':
            bcAiAddStep('⚠', `최대 스텝 도달 (${step.step})`, 'err');
            bcAiSetRunning(false);
            break;
        case 'error':
            bcAiAddStep('❌', step.msg, 'err');
            bcAiSetRunning(false);
            showToast(step.msg, 'error');
            break;
    }
});

// ===================================================================
//  Model Selector
// ===================================================================

document.addEventListener('DOMContentLoaded', () => {
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) {
        modelSelect.addEventListener('change', async () => {
            const model = modelSelect.value;
            if (currentProject) {
                localStorage.setItem(`model_${currentProject.id}`, model);
                const modelName = modelSelect.options[modelSelect.selectedIndex].text;
                showToast(`Model: ${modelName}`, 'info');
                // Restart PTY with new model
                await restartTerminal();
            }
        });
    }
});

// ===================================================================
//  Boot
// ===================================================================

window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, starting init...');
    init();
});
