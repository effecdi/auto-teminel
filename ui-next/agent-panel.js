// ui-next/agent-panel.js
// Stage 3 — new agent UI (renderer side). Self-contained: injects a small
// launcher button + a slide-over panel. Talks to main only via agentv2.* IPC.
// Classic app layout is untouched (this only adds a floating launcher).

(function () {
    'use strict';
    let ipcRenderer;
    try { ipcRenderer = require('electron').ipcRenderer; } catch (_) { return; }

    let panelEl, logEl, inputEl, cwdEl, runBtn, stopBtn, backendEl, mcpEl, settingsEl;
    let currentRunId = null;
    let currentBubble = null;           // streaming assistant text bubble
    const history = [];                 // accumulated {role, content} for this panel session
    const toolNodes = new Map();        // tool_use id -> DOM node

    const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

    function detectCwd() {
        try { if (typeof currentProject !== 'undefined' && currentProject) return currentProject.path || currentProject.projectPath || currentProject.dir || ''; } catch (_) {}
        return '';
    }

    function build() {
        const launcher = el('button', 'agentv2-launcher', '⚡ Agent');
        launcher.title = 'AI 에이전트 (beta)';
        launcher.addEventListener('click', () => togglePanel());
        document.body.appendChild(launcher);

        panelEl = el('div', 'agentv2-panel agentv2-closed');

        const header = el('div', 'agentv2-header');
        header.appendChild(el('span', 'agentv2-title', '⚡ AI 에이전트'));
        backendEl = el('span', 'agentv2-backend', '');
        header.appendChild(backendEl);
        const setBtn = el('button', 'agentv2-mcp-btn', '⚙️');
        setBtn.title = '설정';
        setBtn.addEventListener('click', toggleSettings);
        header.appendChild(setBtn);
        const mcpBtn = el('button', 'agentv2-mcp-btn', '🔌 MCP');
        mcpBtn.title = 'MCP 서버 관리';
        mcpBtn.addEventListener('click', toggleMcp);
        header.appendChild(mcpBtn);
        const closeBtn = el('button', 'agentv2-close', '✕');
        closeBtn.addEventListener('click', () => togglePanel(false));
        header.appendChild(closeBtn);
        panelEl.appendChild(header);

        settingsEl = el('div', 'agentv2-settings agentv2-hidden');
        panelEl.appendChild(settingsEl);
        mcpEl = el('div', 'agentv2-mcp agentv2-hidden');
        panelEl.appendChild(mcpEl);

        logEl = el('div', 'agentv2-log');
        panelEl.appendChild(logEl);

        const cwdRow = el('div', 'agentv2-cwd-row');
        cwdRow.appendChild(el('label', 'agentv2-cwd-label', '작업 폴더'));
        cwdEl = el('input', 'agentv2-cwd');
        cwdEl.placeholder = '/path/to/project (비우면 앱 기본 경로)';
        cwdEl.value = detectCwd();
        cwdRow.appendChild(cwdEl);
        panelEl.appendChild(cwdRow);

        const inputRow = el('div', 'agentv2-input-row');
        inputEl = el('textarea', 'agentv2-input');
        inputEl.placeholder = '무엇을 해줄까? (Cmd/Ctrl+Enter로 실행)';
        inputEl.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); startRun(); } });
        inputRow.appendChild(inputEl);
        panelEl.appendChild(inputRow);

        const btnRow = el('div', 'agentv2-btn-row');
        runBtn = el('button', 'agentv2-run', '실행');
        runBtn.addEventListener('click', startRun);
        stopBtn = el('button', 'agentv2-stop agentv2-hidden', '중지');
        stopBtn.addEventListener('click', abortRun);
        btnRow.appendChild(runBtn);
        btnRow.appendChild(stopBtn);
        panelEl.appendChild(btnRow);

        document.body.appendChild(panelEl);
    }

    function togglePanel(force) {
        const show = force != null ? force : panelEl.classList.contains('agentv2-closed');
        panelEl.classList.toggle('agentv2-closed', !show);
        if (show) refreshBackend();
    }

    async function refreshBackend() {
        try {
            const s = await ipcRenderer.invoke('agentv2.isEnabled');
            const mode = s.claudeMode === 'api' && s.hasAnthropicApiKey ? 'API (유료)' : 'CLI (무료)';
            backendEl.textContent = mode;
        } catch (_) { backendEl.textContent = ''; }
    }

    function toggleSettings() {
        const show = settingsEl.classList.contains('agentv2-hidden');
        settingsEl.classList.toggle('agentv2-hidden', !show);
        mcpEl.classList.add('agentv2-hidden');
        if (show) renderSettings();
    }

    async function renderSettings() {
        settingsEl.innerHTML = '';
        settingsEl.appendChild(el('div', 'agentv2-mcp-title', '설정'));
        let s = {};
        try { s = await ipcRenderer.invoke('ai.getSettings'); } catch (_) {}
        let auto = false;
        try { const en = await ipcRenderer.invoke('agentv2.isEnabled'); auto = !!en.autoApprove; } catch (_) {}

        // Claude backend mode
        const modeRow = el('div', 'agentv2-set-row');
        modeRow.appendChild(el('label', 'agentv2-set-label', 'Claude 백엔드'));
        const modeSel = el('select', 'agentv2-mcp-in');
        [['cli', 'CLI (무료 · 구독)'], ['api', 'API (유료 · 토큰당)']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (s.claudeMode === v) o.selected = true; modeSel.appendChild(o); });
        modeRow.appendChild(modeSel);
        settingsEl.appendChild(modeRow);

        // Anthropic API key
        const keyRow = el('div', 'agentv2-set-row');
        keyRow.appendChild(el('label', 'agentv2-set-label', 'Anthropic API 키' + (s.hasAnthropicApiKey ? ' (설정됨)' : '')));
        const keyIn = el('input', 'agentv2-mcp-in'); keyIn.type = 'password'; keyIn.placeholder = s.hasAnthropicApiKey ? '변경하려면 새 키 입력' : 'sk-ant-...';
        keyRow.appendChild(keyIn);
        settingsEl.appendChild(keyRow);

        // API model
        const modelRow = el('div', 'agentv2-set-row');
        modelRow.appendChild(el('label', 'agentv2-set-label', 'API 모델 (비우면 opus-4-8)'));
        const modelIn = el('input', 'agentv2-mcp-in'); modelIn.value = s.claudeApiModel || ''; modelIn.placeholder = 'claude-opus-4-8';
        modelRow.appendChild(modelIn);
        settingsEl.appendChild(modelRow);

        // Auto-approve
        const autoRow = el('div', 'agentv2-set-check');
        const autoBox = el('input'); autoBox.type = 'checkbox'; autoBox.checked = auto; autoBox.id = 'agentv2-auto';
        const autoLbl = el('label', 'agentv2-set-label', ' 도구 자동 승인 (위험: 확인 없이 실행)'); autoLbl.htmlFor = 'agentv2-auto';
        autoRow.appendChild(autoBox); autoRow.appendChild(autoLbl);
        settingsEl.appendChild(autoRow);

        const saveB = el('button', 'agentv2-mcp-add', '저장');
        saveB.addEventListener('click', async () => {
            const patch = { claudeMode: modeSel.value, claudeApiModel: modelIn.value.trim() };
            if (keyIn.value.trim()) patch.anthropicApiKey = keyIn.value.trim();
            try {
                await ipcRenderer.invoke('ai.setSettings', patch);
                await ipcRenderer.invoke('agentv2.setAutoApprove', autoBox.checked);
                addLine('status', '설정 저장됨');
                refreshBackend();
                toggleSettings();
            } catch (e) { addLine('error', '설정 저장 실패: ' + e.message); }
        });
        settingsEl.appendChild(saveB);
    }

    function toggleMcp() {
        const show = mcpEl.classList.contains('agentv2-hidden');
        mcpEl.classList.toggle('agentv2-hidden', !show);
        settingsEl.classList.add('agentv2-hidden');
        if (show) renderMcp();
    }

    async function renderMcp() {
        mcpEl.innerHTML = '';
        mcpEl.appendChild(el('div', 'agentv2-mcp-title', 'MCP 서버'));
        let servers = [];
        try { servers = await ipcRenderer.invoke('mcp.listServers'); } catch (_) {}
        let status = [];
        try { status = await ipcRenderer.invoke('mcp.status'); } catch (_) {}
        const statusById = {}; status.forEach(s => { statusById[s.id] = s; });

        if (!servers.length) mcpEl.appendChild(el('div', 'agentv2-mcp-empty', '등록된 서버 없음'));
        for (const s of servers) {
            const row = el('div', 'agentv2-mcp-row');
            const st = statusById[s.id];
            const dot = el('span', 'agentv2-mcp-dot ' + (st ? 'on' : 'off'), st ? '●' : '○');
            row.appendChild(dot);
            row.appendChild(el('span', 'agentv2-mcp-name', s.name + (st ? ` (${st.toolCount} 도구)` : '')));
            const en = el('button', 'agentv2-mcp-toggle', s.enabled === false ? '켜기' : '끄기');
            en.addEventListener('click', async () => { await ipcRenderer.invoke('mcp.setEnabled', { id: s.id, enabled: s.enabled === false }); renderMcp(); });
            const rm = el('button', 'agentv2-mcp-rm', '삭제');
            rm.addEventListener('click', async () => { await ipcRenderer.invoke('mcp.removeServer', s.id); renderMcp(); });
            row.appendChild(en); row.appendChild(rm);
            mcpEl.appendChild(row);
        }

        // Add form
        const form = el('div', 'agentv2-mcp-form');
        const nameI = el('input', 'agentv2-mcp-in'); nameI.placeholder = '이름';
        const typeS = el('select', 'agentv2-mcp-in');
        ['stdio', 'sse', 'http'].forEach(t => { const o = el('option', '', t); o.value = t; typeS.appendChild(o); });
        const cmdI = el('input', 'agentv2-mcp-in'); cmdI.placeholder = 'stdio: command (예: npx) / sse·http: url';
        const argI = el('input', 'agentv2-mcp-in'); argI.placeholder = 'args (공백 구분, stdio만)';
        const addB = el('button', 'agentv2-mcp-add', '＋ 서버 추가');
        addB.addEventListener('click', async () => {
            const type = typeS.value;
            const cfg = { name: nameI.value.trim(), type };
            if (type === 'stdio') { cfg.command = cmdI.value.trim(); cfg.args = argI.value.trim() ? argI.value.trim().split(/\s+/) : []; }
            else { cfg.url = cmdI.value.trim(); }
            if (!cfg.name || (type === 'stdio' ? !cfg.command : !cfg.url)) { addLine('error', 'MCP: 이름과 command/url 필요'); return; }
            const res = await ipcRenderer.invoke('mcp.addServer', cfg);
            const r = (res.results || []).find(x => x.name === cfg.name || x.id === (res.entry && res.entry.id));
            addLine('status', 'MCP 추가: ' + cfg.name + (r ? (r.ok ? ` ✅ ${r.toolCount}도구` : ` ❌ ${r.error}`) : ''));
            nameI.value = cmdI.value = argI.value = '';
            renderMcp();
        });
        form.appendChild(nameI); form.appendChild(typeS); form.appendChild(cmdI); form.appendChild(argI); form.appendChild(addB);
        mcpEl.appendChild(form);
    }

    function addLine(cls, text) { const n = el('div', 'agentv2-line ' + cls, text); logEl.appendChild(n); logEl.scrollTop = logEl.scrollHeight; return n; }

    function startRun() {
        if (currentRunId) return;
        const message = (inputEl.value || '').trim();
        if (!message) return;
        addLine('user', '🧑 ' + message);
        inputEl.value = '';
        currentBubble = null;
        currentRunId = 'run_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        runBtn.classList.add('agentv2-hidden'); stopBtn.classList.remove('agentv2-hidden');

        ipcRenderer.invoke('agentv2.run', {
            runId: currentRunId,
            projectPath: (cwdEl.value || '').trim() || undefined,
            message,
            history: history.slice(),
        }).then((res) => {
            if (!res || !res.started) { addLine('error', '⚠️ 실행 실패: ' + ((res && res.error) || '알 수 없음')); endRun(); }
            else { backendEl.textContent = res.backend === 'api' ? 'API (유료)' : 'CLI (무료)'; }
        }).catch((e) => { addLine('error', '⚠️ ' + e.message); endRun(); });

        history.push({ role: 'user', content: message });
    }

    function abortRun() { if (currentRunId) ipcRenderer.invoke('agentv2.abort', { runId: currentRunId }); }

    function endRun() {
        currentRunId = null; currentBubble = null;
        runBtn.classList.remove('agentv2-hidden'); stopBtn.classList.add('agentv2-hidden');
    }

    function handleEvent(payload, event, data) {
        switch (event) {
            case 'token': {
                if (!currentBubble) currentBubble = addLine('assistant', '🤖 ');
                currentBubble.textContent += data.text;
                logEl.scrollTop = logEl.scrollHeight;
                break;
            }
            case 'toolUse': {
                const node = addLine('tool', '🔧 ' + data.name + ' ' + JSON.stringify(data.input).slice(0, 200));
                if (data.id) toolNodes.set(data.id, node);
                break;
            }
            case 'toolResult': {
                const node = data.id && toolNodes.get(data.id);
                const status = data.ok ? '✅' : '❌';
                const detail = data.ok ? '' : ' — ' + (data.error || '');
                if (node) node.textContent += '  ' + status + detail;
                else addLine('tool', status + ' 결과' + detail);
                break;
            }
            case 'approvalRequest': {
                renderApproval(data);
                break;
            }
            case 'approvalAuto': {
                addLine('tool', '⚡ 자동 승인: ' + data.toolName);
                break;
            }
            case 'done': {
                if (currentBubble) history.push({ role: 'claude', content: currentBubble.textContent.replace(/^🤖 /, '') });
                addLine('status', '— 완료 —');
                endRun();
                break;
            }
            case 'error': {
                addLine('error', '⚠️ ' + (data.message || '오류'));
                endRun();
                break;
            }
            case 'status': {
                if (data.phase === 'aborted') { addLine('status', '— 중지됨 —'); endRun(); }
                break;
            }
        }
    }

    function renderApprovalBody(box, data) {
        const t = data.toolName, i = data.input || {};
        if (t === 'run_bash') {
            box.appendChild(el('div', 'agentv2-approval-cmd', '$ ' + (i.command || '')));
            return;
        }
        if (t === 'write_file') {
            box.appendChild(el('div', 'agentv2-approval-path', '✏️ 새 파일: ' + (i.path || '')));
            box.appendChild(el('pre', 'agentv2-approval-input', (i.content || '').slice(0, 1500)));
            return;
        }
        if (t === 'edit_file') {
            box.appendChild(el('div', 'agentv2-approval-path', '✏️ 수정: ' + (i.path || '')));
            const diff = el('pre', 'agentv2-approval-input');
            diff.appendChild(el('div', 'agentv2-diff-old', '- ' + (i.old_string || '').slice(0, 700)));
            diff.appendChild(el('div', 'agentv2-diff-new', '+ ' + (i.new_string || '').slice(0, 700)));
            box.appendChild(diff);
            return;
        }
        box.appendChild(el('pre', 'agentv2-approval-input', JSON.stringify(i, null, 2).slice(0, 1000)));
    }

    function renderApproval(data) {
        const box = el('div', 'agentv2-approval');
        box.appendChild(el('div', 'agentv2-approval-title', '승인 필요: ' + data.toolName));
        renderApprovalBody(box, data);
        const row = el('div', 'agentv2-approval-btns');
        const yes = el('button', 'agentv2-approve-yes', '승인');
        const no = el('button', 'agentv2-approve-no', '거부');
        const decide = (approved) => { ipcRenderer.invoke('agentv2.approve', { runId: currentRunId, id: data.id, approved }); box.classList.add('resolved'); yes.disabled = no.disabled = true; box.appendChild(el('span', 'agentv2-approval-done', approved ? ' → 승인함' : ' → 거부함')); };
        yes.addEventListener('click', () => decide(true));
        no.addEventListener('click', () => decide(false));
        row.appendChild(yes); row.appendChild(no); box.appendChild(row);
        logEl.appendChild(box); logEl.scrollTop = logEl.scrollHeight;
    }

    ipcRenderer.on('agentv2.event', (_e, msg) => {
        if (!msg || msg.runId !== currentRunId) return;
        handleEvent(msg, msg.event, msg.payload || {});
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
    else build();
})();
