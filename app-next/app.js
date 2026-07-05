// app-next/app.js — modern AI agent workspace renderer.
// Reuses the existing engine over IPC: agentv2.*, mcp.*, imagegen.*, ai.*.
(function () {
    'use strict';
    const { ipcRenderer } = require('electron');

    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

    // ---- session model ----
    let sessions = [];
    let activeId = null;
    let seq = 0;

    function activeSession() { return sessions.find(s => s.id === activeId) || null; }

    function newSession() {
        const id = 'sess_' + (++seq);
        const container = el('div', 'messages-inner');
        const s = { id, title: '새 대화', cwd: $('cwdInput').value.trim(), history: [], container, runId: null, bubble: null, toolNodes: new Map() };
        sessions.unshift(s);
        renderSessionList();
        switchSession(id);
        return s;
    }

    function switchSession(id) {
        activeId = id;
        renderSessionList();
        const s = activeSession();
        const wrap = $('messages');
        wrap.innerHTML = '';
        if (s && s.container.childElementCount) wrap.appendChild(s.container);
        else showEmpty(wrap);
        refreshRail();
        // reflect run state in composer buttons
        const running = !!(s && s.runId);
        $('runBtn').classList.toggle('hidden', running);
        $('stopBtn').classList.toggle('hidden', !running);
        wrap.scrollTop = wrap.scrollHeight;
    }

    function showEmpty(wrap) {
        wrap.innerHTML = '';
        const e = el('div', 'empty-state');
        e.appendChild(el('div', 'empty-logo', '⚡'));
        e.appendChild(el('div', 'empty-title', '무엇을 도와줄까?'));
        e.appendChild(el('div', 'empty-sub', '코드 읽기·수정·실행, 검증, 이미지 생성까지 — 에이전트가 도구를 써서 처리함'));
        wrap.appendChild(e);
    }

    function renderSessionList() {
        const list = $('sessionList');
        list.innerHTML = '';
        for (const s of sessions) {
            const item = el('div', 'session-item' + (s.id === activeId ? ' active' : ''), s.title);
            item.addEventListener('click', () => switchSession(s.id));
            list.appendChild(item);
        }
    }

    function mountActive() {
        const s = activeSession();
        const wrap = $('messages');
        if (s.container.parentNode !== wrap) { wrap.innerHTML = ''; wrap.appendChild(s.container); }
    }

    function addBlock(s, node) {
        s.container.appendChild(node);
        if (s.id === activeId) { mountActive(); $('messages').scrollTop = $('messages').scrollHeight; }
        return node;
    }

    function addMessage(s, role, text) {
        const msg = el('div', 'msg ' + role);
        msg.appendChild(el('div', 'msg-avatar', role === 'user' ? '🧑' : '🤖'));
        const body = el('div', 'msg-body');
        body.appendChild(el('div', 'msg-role', role === 'user' ? '나' : '에이전트'));
        const textEl = el('div', 'msg-text', text || '');
        body.appendChild(textEl);
        msg.appendChild(body);
        addBlock(s, msg);
        return textEl;
    }

    // ---- run ----
    function run() {
        let s = activeSession();
        if (!s) s = newSession();
        if (s.runId) return;
        const message = $('input').value.trim();
        if (!message) return;
        if (s.title === '새 대화') { s.title = message.slice(0, 28); renderSessionList(); }
        s.cwd = $('cwdInput').value.trim();
        addMessage(s, 'user', message);
        s.history.push({ role: 'user', content: message });
        $('input').value = ''; $('input').style.height = 'auto';
        s.bubble = null;
        s.runId = 'run_' + Date.now() + '_' + (++seq);
        $('runBtn').classList.add('hidden'); $('stopBtn').classList.remove('hidden');

        ipcRenderer.invoke('agentv2.run', { runId: s.runId, projectPath: s.cwd || undefined, message, history: s.history.slice(0, -1) })
            .then(res => { if (!res || !res.started) { addBlock(s, el('div', 'status-line', '⚠️ 실행 실패: ' + ((res && res.error) || '알 수 없음'))); endRun(s); } else { setBackend(res.backend); } })
            .catch(e => { addBlock(s, el('div', 'status-line', '⚠️ ' + e.message)); endRun(s); });
    }

    function endRun(s) {
        s.runId = null; s.bubble = null;
        if (s.id === activeId) { $('runBtn').classList.remove('hidden'); $('stopBtn').classList.add('hidden'); }
    }

    function stop() { const s = activeSession(); if (s && s.runId) ipcRenderer.invoke('agentv2.abort', { runId: s.runId }); }

    function setBackend(b) { $('backendChip').textContent = b === 'api' ? 'API (유료)' : 'CLI (무료)'; }

    // ---- rail (tool timeline) ----
    function refreshRail() {
        const s = activeSession();
        const list = $('toolList'); list.innerHTML = '';
        const tools = (s && s._railTools) || [];
        $('toolCount').textContent = tools.length;
        for (const t of tools) list.appendChild(el('div', 'rail-tool ' + (t.state || ''), t.label));
    }
    function railAdd(s, id, label) {
        if (!s._railTools) s._railTools = [];
        const t = { id, label, state: 'run' }; s._railTools.push(t);
        if (s.id === activeId) refreshRail();
        return t;
    }
    function railUpdate(s, id, state) {
        const t = (s._railTools || []).find(x => x.id === id); if (t) t.state = state;
        if (s.id === activeId) refreshRail();
    }

    // ---- event routing ----
    ipcRenderer.on('agentv2.event', (_e, msg) => {
        if (!msg) return;
        const s = sessions.find(x => x.runId === msg.runId);
        if (!s) return;
        handle(s, msg.event, msg.payload || {});
    });

    function handle(s, event, data) {
        switch (event) {
            case 'token':
                if (!s.bubble) s.bubble = addMessage(s, 'agent', '');
                s.bubble.textContent += data.text;
                if (s.id === activeId) $('messages').scrollTop = $('messages').scrollHeight;
                break;
            case 'toolUse': {
                s.bubble = null;
                const step = el('div', 'tool-step');
                const head = el('div', 'tool-step-head');
                head.appendChild(el('span', '', '🔧 ' + data.name));
                const st = el('span', 'tool-step-status', '…'); head.appendChild(st);
                step.appendChild(head);
                const body = el('div', 'tool-step-body', JSON.stringify(data.input).slice(0, 500));
                step.appendChild(body);
                step._status = st;
                if (data.id) s.toolNodes.set(data.id, step);
                addBlock(s, step);
                railAdd(s, data.id, data.name);
                break;
            }
            case 'toolResult': {
                const step = data.id && s.toolNodes.get(data.id);
                if (step) { step.classList.add(data.ok ? 'ok' : 'err'); step._status.textContent = data.ok ? '✅' : '❌'; if (!data.ok && data.error) step.querySelector('.tool-step-body').textContent += '\n' + data.error; }
                railUpdate(s, data.id, data.ok ? 'ok' : 'err');
                break;
            }
            case 'approvalRequest': renderApproval(s, data); break;
            case 'approvalAuto': addBlock(s, el('div', 'status-line', '⚡ 자동 승인: ' + data.toolName)); break;
            case 'done':
                if (s.bubble) s.history.push({ role: 'claude', content: s.bubble.textContent });
                addBlock(s, el('div', 'status-line', '— 완료 —')); endRun(s); break;
            case 'error': addBlock(s, el('div', 'status-line', '⚠️ ' + (data.message || '오류'))); endRun(s); break;
            case 'status': if (data.phase === 'aborted') { addBlock(s, el('div', 'status-line', '— 중지됨 —')); endRun(s); } break;
        }
    }

    function renderApproval(s, data) {
        const box = el('div', 'approval');
        box.appendChild(el('div', 'approval-title', '승인 필요 · ' + data.toolName));
        const i = data.input || {}, t = data.toolName;
        if (t === 'run_bash') box.appendChild(el('div', 'approval-cmd', '$ ' + (i.command || '')));
        else if (t === 'write_file') { box.appendChild(el('div', 'approval-path', '✏️ 새 파일: ' + (i.path || ''))); box.appendChild(el('pre', 'approval-pre', (i.content || '').slice(0, 1500))); }
        else if (t === 'edit_file') { box.appendChild(el('div', 'approval-path', '✏️ 수정: ' + (i.path || ''))); const pre = el('pre', 'approval-pre'); pre.appendChild(el('div', 'diff-old', '- ' + (i.old_string || '').slice(0, 700))); pre.appendChild(el('div', 'diff-new', '+ ' + (i.new_string || '').slice(0, 700))); box.appendChild(pre); }
        else box.appendChild(el('pre', 'approval-pre', JSON.stringify(i, null, 2).slice(0, 1000)));
        const btns = el('div', 'approval-btns');
        const yes = el('button', 'btn-yes', '승인'), no = el('button', 'btn-no', '거부');
        const decide = (ok) => { ipcRenderer.invoke('agentv2.approve', { runId: s.runId, id: data.id, approved: ok }); yes.disabled = no.disabled = true; box.appendChild(el('div', 'status-line', ok ? '→ 승인함' : '→ 거부함')); };
        yes.onclick = () => decide(true); no.onclick = () => decide(false);
        btns.appendChild(yes); btns.appendChild(no); box.appendChild(btns);
        addBlock(s, box);
    }

    // ---- modals ----
    function openModal(build) { const m = $('modal'); m.innerHTML = ''; build(m); $('overlay').classList.remove('hidden'); }
    function closeModal() { $('overlay').classList.add('hidden'); }
    $('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeModal(); });

    async function openSettings() {
        const s = await ipcRenderer.invoke('ai.getSettings').catch(() => ({}));
        const en = await ipcRenderer.invoke('agentv2.isEnabled').catch(() => ({}));
        openModal((m) => {
            m.appendChild(el('h2', '', '⚙️ 설정'));
            const mk = (labelText, node) => { const r = el('div', 'row'); r.appendChild(el('label', '', labelText)); r.appendChild(node); m.appendChild(r); return node; };
            const modeSel = el('select'); [['cli', 'CLI (무료·구독)'], ['api', 'API (유료·토큰당)']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (s.claudeMode === v) o.selected = true; modeSel.appendChild(o); }); mk('Claude 백엔드', modeSel);
            const keyIn = el('input'); keyIn.type = 'password'; keyIn.placeholder = s.hasAnthropicApiKey ? '설정됨 — 변경 시 새 키' : 'sk-ant-...'; mk('Anthropic API 키', keyIn);
            const modelIn = el('input'); modelIn.value = s.claudeApiModel || ''; modelIn.placeholder = 'claude-opus-4-8'; mk('API 모델', modelIn);
            const imgSel = el('select'); [['gemini', 'Gemini (API)'], ['chatgpt-web', 'ChatGPT 웹 (무료·실험적)']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (s.imageBackend === v) o.selected = true; imgSel.appendChild(o); }); mk('이미지 백엔드', imgSel);
            const gimIn = el('input'); gimIn.value = s.geminiImageModel || ''; gimIn.placeholder = 'gemini-2.5-flash-image-preview'; mk('Gemini 이미지 모델', gimIn);
            const chk = el('div', 'check-row'); const box = el('input'); box.type = 'checkbox'; box.checked = !!en.autoApprove; chk.appendChild(box); chk.appendChild(el('span', '', '도구 자동 승인 (위험)')); m.appendChild(chk);
            const btns = el('div', 'modal-btns');
            const save = el('button', 'modal-save', '저장'); const close = el('button', 'modal-close', '닫기');
            save.onclick = async () => {
                const patch = { claudeMode: modeSel.value, claudeApiModel: modelIn.value.trim(), imageBackend: imgSel.value, geminiImageModel: gimIn.value.trim() };
                if (keyIn.value.trim()) patch.anthropicApiKey = keyIn.value.trim();
                await ipcRenderer.invoke('ai.setSettings', patch);
                await ipcRenderer.invoke('agentv2.setAutoApprove', box.checked);
                refreshBackend(); closeModal();
            };
            close.onclick = closeModal; btns.appendChild(close); btns.appendChild(save); m.appendChild(btns);
        });
    }

    async function openMcp() {
        const servers = await ipcRenderer.invoke('mcp.listServers').catch(() => []);
        const status = await ipcRenderer.invoke('mcp.status').catch(() => []);
        const byId = {}; status.forEach(x => byId[x.id] = x);
        openModal((m) => {
            m.appendChild(el('h2', '', '🔌 MCP 서버'));
            if (!servers.length) m.appendChild(el('div', 'status-line', '등록된 서버 없음'));
            for (const sv of servers) {
                const st = byId[sv.id];
                const row = el('div', 'mcp-item');
                row.appendChild(el('span', 'mcp-dot ' + (st ? 'on' : 'off'), st ? '●' : '○'));
                row.appendChild(el('span', 'mcp-name', sv.name + (st ? ` · ${st.toolCount}도구` : '')));
                const tg = el('button', 'mini-btn', sv.enabled === false ? '켜기' : '끄기'); tg.onclick = async () => { await ipcRenderer.invoke('mcp.setEnabled', { id: sv.id, enabled: sv.enabled === false }); openMcp(); };
                const rm = el('button', 'mini-btn danger', '삭제'); rm.onclick = async () => { await ipcRenderer.invoke('mcp.removeServer', sv.id); openMcp(); };
                row.appendChild(tg); row.appendChild(rm); m.appendChild(row);
            }
            const mk = (ph) => { const i = el('input'); i.placeholder = ph; const r = el('div', 'row'); r.appendChild(i); m.appendChild(r); return i; };
            const nameI = mk('이름'); const typeS = el('select'); ['stdio', 'sse', 'http'].forEach(t => { const o = el('option', '', t); o.value = t; typeS.appendChild(o); }); const tr = el('div', 'row'); tr.appendChild(typeS); m.appendChild(tr);
            const cmdI = mk('stdio: command (npx) / sse·http: url'); const argI = mk('args (공백 구분, stdio만)');
            const btns = el('div', 'modal-btns');
            const add = el('button', 'modal-save', '＋ 추가'); const close = el('button', 'modal-close', '닫기');
            add.onclick = async () => { const type = typeS.value; const cfg = { name: nameI.value.trim(), type }; if (type === 'stdio') { cfg.command = cmdI.value.trim(); cfg.args = argI.value.trim() ? argI.value.trim().split(/\s+/) : []; } else cfg.url = cmdI.value.trim(); if (!cfg.name || (type === 'stdio' ? !cfg.command : !cfg.url)) return; await ipcRenderer.invoke('mcp.addServer', cfg); openMcp(); };
            close.onclick = closeModal; btns.appendChild(close); btns.appendChild(add); m.appendChild(btns);
        });
    }

    async function openImage() {
        const s = await ipcRenderer.invoke('ai.getSettings').catch(() => ({}));
        openModal((m) => {
            m.appendChild(el('h2', '', '🎨 이미지 생성'));
            m.appendChild(el('div', 'status-line', '백엔드: ' + (s.imageBackend === 'chatgpt-web' ? 'ChatGPT 웹(무료·실험적)' : 'Gemini(API)') + ' · ⚙️에서 변경'));
            const login = el('div', 'modal-btns'); const lg = el('button', 'mini-btn', 'ChatGPT 로그인 창'); lg.onclick = () => ipcRenderer.invoke('imagegen.chatgptLogin'); const hd = el('button', 'mini-btn', '창 닫기'); hd.onclick = () => ipcRenderer.invoke('imagegen.chatgptHide'); login.appendChild(lg); login.appendChild(hd); m.appendChild(login);
            const pr = el('textarea'); pr.placeholder = '생성할 이미지 설명...'; pr.rows = 3; const r = el('div', 'row'); r.appendChild(pr); m.appendChild(r);
            const result = el('div'); m.appendChild(result);
            const btns = el('div', 'modal-btns'); const gen = el('button', 'modal-save', '생성'); const close = el('button', 'modal-close', '닫기');
            gen.onclick = async () => { const prompt = pr.value.trim(); if (!prompt) return; result.textContent = '생성 중...'; const res = await ipcRenderer.invoke('imagegen.generate', { prompt, projectPath: $('cwdInput').value.trim() || undefined }); if (res && res.ok) { result.innerHTML = ''; result.appendChild(el('div', 'status-line', '✅ ' + res.backend + ' → ' + res.path)); const img = document.createElement('img'); img.className = 'img-preview'; img.src = 'file://' + res.path; result.appendChild(img); } else result.textContent = '❌ ' + ((res && res.error) || '실패'); };
            close.onclick = closeModal; btns.appendChild(close); btns.appendChild(gen); m.appendChild(btns);
        });
    }

    async function refreshBackend() {
        try { const s = await ipcRenderer.invoke('agentv2.isEnabled'); setBackend(s.claudeMode === 'api' && s.hasAnthropicApiKey ? 'api' : 'cli'); } catch (_) {}
    }

    // ---- wire ----
    $('newChatBtn').onclick = () => newSession();
    $('runBtn').onclick = run;
    $('stopBtn').onclick = stop;
    $('setBtn').onclick = openSettings;
    $('mcpBtn').onclick = openMcp;
    $('imgBtn').onclick = openImage;
    const input = $('input');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; });
    input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

    refreshBackend();
    newSession();
})();
