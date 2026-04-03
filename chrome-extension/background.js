// ====================================================
// Auto-Teminel Browser Control — background.js (Service Worker)
// CDP via chrome.debugger + WebSocket client
// ====================================================

let attachedTabId = null;
let ws = null;
let wsUrl = 'ws://localhost:9999';

// ---- keepalive (service worker가 suspend되지 않도록) ----
const keepAlive = () => setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
keepAlive();

// ====================== CDP ======================

async function attachDebugger(tabId) {
  if (attachedTabId === tabId) return; // 이미 붙어있음
  if (attachedTabId != null) {
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (_) {}
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabId = tabId;
  broadcast({ type: 'debugger-status', attached: true, tabId });
}

async function detachDebugger() {
  if (attachedTabId == null) return;
  try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (_) {}
  attachedTabId = null;
  broadcast({ type: 'debugger-status', attached: false });
}

async function cdp(method, params = {}) {
  if (attachedTabId == null) throw new Error('Debugger not attached');
  return chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params);
}

// 현재 활성 탭에 자동 attach
async function attachActive() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  await attachDebugger(tab.id);
  return tab.id;
}

// ====================== 명령 실행 ======================

async function screenshot() {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  return r.data; // base64 PNG
}

async function navigate(url) {
  await cdp('Page.navigate', { url });
  // 로드 완료 대기
  await new Promise(res => setTimeout(res, 1000));
}

async function execute(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function clickSelector(selector) {
  const pos = await execute(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
  if (!pos) throw new Error(`Element not found: ${selector}`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 1 });
}

async function typeText(selector, text) {
  await clickSelector(selector);
  await cdp('Input.insertText', { text });
}

async function scrollPage(x, y) {
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 400, y: 300,
    deltaX: x || 0, deltaY: y || 0,
  });
}

async function getHTML() {
  return execute('document.documentElement.outerHTML');
}

async function getURL() {
  return execute('location.href');
}

async function waitSelector(selector, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await execute(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timeout waiting for: ${selector}`);
}

// ====================== 명령 라우터 ======================

async function handleCommand(cmd) {
  const res = { id: cmd.id, type: cmd.type };
  try {
    switch (cmd.type) {
      case 'attach':
        res.tabId = await attachActive();
        res.success = true;
        break;
      case 'detach':
        await detachDebugger();
        res.success = true;
        break;
      case 'screenshot':
        res.data = await screenshot();
        break;
      case 'navigate':
        await navigate(cmd.url);
        res.success = true;
        break;
      case 'execute':
        res.result = await execute(cmd.script);
        break;
      case 'click':
        await clickSelector(cmd.selector);
        res.success = true;
        break;
      case 'type':
        await typeText(cmd.selector, cmd.text);
        res.success = true;
        break;
      case 'scroll':
        await scrollPage(cmd.x, cmd.y);
        res.success = true;
        break;
      case 'getHTML':
        res.html = await getHTML();
        break;
      case 'getURL':
        res.url = await getURL();
        break;
      case 'waitSelector':
        res.success = await waitSelector(cmd.selector, cmd.timeout);
        break;
      case 'status':
        res.attached = attachedTabId != null;
        res.tabId = attachedTabId;
        res.wsConnected = ws?.readyState === WebSocket.OPEN;
        break;
      default:
        res.error = `Unknown command: ${cmd.type}`;
    }
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

// ====================== WebSocket ======================

function broadcast(msg) {
  // popup에 전달
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function wsSend(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function connectWS(url) {
  if (ws) { try { ws.close(); } catch (_) {} }
  wsUrl = url || wsUrl;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    broadcast({ type: 'ws-status', connected: true });
    wsSend({ type: 'hello', agent: 'auto-teminel-extension', version: '1.0.0' });
  };

  ws.onclose = () => {
    broadcast({ type: 'ws-status', connected: false });
    ws = null;
  };

  ws.onerror = () => {
    broadcast({ type: 'ws-status', connected: false, error: true });
  };

  ws.onmessage = async (event) => {
    let cmd;
    try { cmd = JSON.parse(event.data); } catch { return; }
    const res = await handleCommand(cmd);
    wsSend(res);
  };
}

function disconnectWS() {
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

// ====================== IPC (popup ↔ background) ======================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'connect-ws':
        connectWS(msg.url);
        sendResponse({ ok: true });
        break;
      case 'disconnect-ws':
        disconnectWS();
        sendResponse({ ok: true });
        break;
      case 'get-status':
        sendResponse({
          ok: true,
          attached: attachedTabId != null,
          tabId: attachedTabId,
          wsConnected: ws?.readyState === WebSocket.OPEN,
          wsUrl,
        });
        break;
      default:
        // 나머지는 handleCommand로 위임
        const res = await handleCommand(msg);
        sendResponse(res);
    }
  })().catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // async sendResponse
});

// 탭 닫히면 detach
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) attachedTabId = null;
});
