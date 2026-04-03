// ====================================================
// popup.js — popup UI 로직
// ====================================================

const $ = id => document.getElementById(id);

const badgeDebugger = $('badge-debugger');
const badgeWS = $('badge-ws');

function setDebuggerBadge(on) {
  badgeDebugger.className = 'badge' + (on ? ' on' : '');
  badgeDebugger.textContent = (on ? '● ' : '○ ') + 'Debugger';
}
function setWSBadge(on, err) {
  badgeWS.className = 'badge' + (on ? ' on' : err ? ' err' : '');
  badgeWS.textContent = (on ? '● ' : '○ ') + 'WS';
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2500);
}

async function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

// 초기 상태 동기화
async function syncStatus() {
  const s = await send({ type: 'get-status' });
  if (s) {
    setDebuggerBadge(s.attached);
    setWSBadge(s.wsConnected);
    if (s.wsUrl) $('ws-url').value = s.wsUrl;
  }
}
syncStatus();

// background에서 오는 실시간 상태 업데이트
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'debugger-status') setDebuggerBadge(msg.attached);
  if (msg.type === 'ws-status') setWSBadge(msg.connected, msg.error);
});

// ---- WebSocket ----
$('btn-ws-connect').addEventListener('click', async () => {
  const url = $('ws-url').value.trim();
  if (!url) return toast('URL을 입력하세요', true);
  const r = await send({ type: 'connect-ws', url });
  if (r?.ok) toast('연결 시도 중...');
  else toast(r?.error || '실패', true);
});

// ---- Attach / Detach ----
$('btn-attach').addEventListener('click', async () => {
  const r = await send({ type: 'attach' });
  if (r?.error) toast(r.error, true);
  else { toast('Debugger attached ✓'); setDebuggerBadge(true); }
});

$('btn-detach').addEventListener('click', async () => {
  const r = await send({ type: 'detach' });
  if (r?.error) toast(r.error, true);
  else { toast('Detached'); setDebuggerBadge(false); }
});

// ---- 스크린샷 ----
$('btn-screenshot').addEventListener('click', async () => {
  $('btn-screenshot').textContent = '캡처 중...';
  const r = await send({ type: 'screenshot' });
  $('btn-screenshot').textContent = '캡처';
  if (r?.error) return toast(r.error, true);
  const img = $('screenshot-img');
  img.src = 'data:image/png;base64,' + r.data;
  $('screenshot-wrap').style.display = 'block';
  toast('스크린샷 완료');
});

// ---- 네비게이션 ----
$('btn-navigate').addEventListener('click', async () => {
  const url = $('nav-url').value.trim();
  if (!url) return toast('URL 입력', true);
  const r = await send({ type: 'navigate', url });
  if (r?.error) toast(r.error, true);
  else toast('이동 완료');
});

// ---- JS 실행 ----
$('btn-execute').addEventListener('click', async () => {
  const script = $('js-input').value.trim();
  if (!script) return;
  const r = await send({ type: 'execute', script });
  const pre = $('js-result');
  pre.style.display = 'block';
  if (r?.error) {
    pre.style.color = '#e05555';
    pre.textContent = '❌ ' + r.error;
    toast(r.error, true);
  } else {
    pre.style.color = '#9ccc65';
    pre.textContent = JSON.stringify(r.result, null, 2);
    toast('실행 완료');
  }
});

// Enter → 실행 (Ctrl+Enter)
$('js-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('btn-execute').click();
});

// ---- 클릭 ----
$('btn-click').addEventListener('click', async () => {
  const sel = $('click-selector').value.trim();
  if (!sel) return toast('selector 입력', true);
  const r = await send({ type: 'click', selector: sel });
  if (r?.error) toast(r.error, true);
  else toast('클릭 완료');
});

// ---- 타입 ----
$('btn-type').addEventListener('click', async () => {
  const sel = $('click-selector').value.trim();
  const text = $('type-text').value;
  if (!sel) return toast('selector 입력', true);
  const r = await send({ type: 'type', selector: sel, text });
  if (r?.error) toast(r.error, true);
  else toast('입력 완료');
});
