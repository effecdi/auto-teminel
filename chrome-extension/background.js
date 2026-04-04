// ====================================================
// Auto-Teminel Browser Control — background.js (Service Worker)
// CDP via chrome.debugger + WebSocket client
// ====================================================

let attachedTabId = null;
let ws = null;
let wsUrl = 'ws://localhost:9999';
let _reconnectTimer = null;
let _reconnectDelay = 3000;
let _autoReconnect = true;

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
  // protocol 없으면 https:// 자동 추가
  if (url && !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('chrome://') && !url.startsWith('file://')) {
    url = 'https://' + url;
  }
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

async function clickXY(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function typeAtFocus(text) {
  await cdp('Input.insertText', { text });
}

async function doubleClickXY(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
}

async function rightClickXY(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
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
      case 'clickXY':
        await clickXY(cmd.x, cmd.y);
        res.success = true;
        break;
      case 'doubleClick_xy':
        await doubleClickXY(cmd.x, cmd.y);
        res.success = true;
        break;
      case 'rightClick_xy':
        await rightClickXY(cmd.x, cmd.y);
        res.success = true;
        break;
      case 'typeAtFocus':
        await typeAtFocus(cmd.text);
        res.success = true;
        break;
      // ---- GUI 심화 ----
      case 'hover':
        await hover(cmd.selector);
        res.success = true;
        break;
      case 'rightClick':
        await rightClick(cmd.selector);
        res.success = true;
        break;
      case 'doubleClick':
        await doubleClick(cmd.selector);
        res.success = true;
        break;
      case 'drag':
        await drag(cmd.from, cmd.to);
        res.success = true;
        break;
      case 'smoothMove':
        await smoothMove(cmd.x, cmd.y);
        res.success = true;
        break;
      case 'keyShortcut':
        await keyShortcut(cmd.combo);
        res.success = true;
        break;
      // ---- 요소 탐색 ----
      case 'findByText':
        res.results = await findByText(cmd.text);
        break;
      case 'listInteractive':
        res.results = await listInteractive();
        break;
      case 'findByRole':
        res.results = await findByRole(cmd.role);
        break;
      case 'highlight':
        res.result = await highlight(cmd.selector);
        break;
      // ---- 콘솔 ----
      case 'startConsoleCapture':
        await startConsoleCapture();
        res.success = true;
        break;
      case 'stopConsoleCapture':
        await stopConsoleCapture();
        res.success = true;
        break;
      // ---- 네트워크 ----
      case 'startNetworkCapture':
        await startNetworkCapture();
        res.success = true;
        break;
      case 'stopNetworkCapture':
        await stopNetworkCapture();
        res.success = true;
        break;
      case 'getResponseBody':
        res.body = await getResponseBody(cmd.requestId);
        break;
      // ---- 스토리지 ----
      case 'getCookies':
        res.cookies = await getCookies(cmd.url);
        break;
      case 'setCookie':
        await setCookie(cmd.name, cmd.value, cmd.domain, cmd.path);
        res.success = true;
        break;
      case 'getLocalStorage':
        res.data = await getLocalStorage();
        break;
      case 'setLocalStorage':
        await setLocalStorageItem(cmd.key, cmd.value);
        res.success = true;
        break;
      case 'removeLocalStorage':
        await removeLocalStorageItem(cmd.key);
        res.success = true;
        break;
      case 'getSessionStorage':
        res.data = await getSessionStorage();
        break;
      case 'clearLocalStorage':
        await clearLocalStorage();
        res.success = true;
        break;
      // ---- 성능 ----
      case 'getPerformanceMetrics':
        res.metrics = await getPerformanceMetrics();
        break;
      // ---- 풀페이지 스크린샷 ----
      case 'fullPageScreenshot':
        res.data = await fullPageScreenshot();
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
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  if (url) wsUrl = url;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    _reconnectDelay = 3000; // 성공 시 딜레이 리셋
    broadcast({ type: 'ws-status', connected: true });
    wsSend({ type: 'hello', agent: 'auto-teminel-extension', version: '1.0.0' });
  };

  ws.onclose = () => {
    broadcast({ type: 'ws-status', connected: false });
    ws = null;
    // 자동 재연결 (앱이 꺼져 있어도 주기적으로 재시도)
    if (_autoReconnect) {
      _reconnectTimer = setTimeout(() => connectWS(), _reconnectDelay);
      _reconnectDelay = Math.min(Math.round(_reconnectDelay * 1.5), 30000); // 최대 30초
    }
  };

  ws.onerror = () => {
    broadcast({ type: 'ws-status', connected: false, error: true });
    // onerror 후 onclose가 따라오므로 여기서 재연결 불필요
  };

  ws.onmessage = async (event) => {
    let cmd;
    try { cmd = JSON.parse(event.data); } catch { return; }
    const res = await handleCommand(cmd);
    wsSend(res);
  };
}

function disconnectWS() {
  _autoReconnect = false;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

// ====================== 시작 시 자동 연결 ======================
_autoReconnect = true;
connectWS();

// ====================== IPC (popup ↔ background) ======================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'connect-ws':
        _autoReconnect = true;
        _reconnectDelay = 3000;
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

// ====================== CDP Push 이벤트 → WS 포워딩 ======================

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  wsSend({ type: 'cdp-event', method, params });
});

// ====================== GUI 심화 ======================

async function getPos(selector) {
  const pos = await execute(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
  if (!pos) throw new Error(`Element not found: ${selector}`);
  return pos;
}

async function hover(selector) {
  const pos = await getPos(selector);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos });
}

async function rightClick(selector) {
  const pos = await getPos(selector);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'right', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'right', clickCount: 1 });
}

async function doubleClick(selector) {
  const pos = await getPos(selector);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 2 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 2 });
}

async function drag(fromSel, toSel) {
  const from = await getPos(fromSel);
  const to = await getPos(toSel);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
  // 부드러운 중간 경로 (5 steps)
  for (let i = 1; i <= 5; i++) {
    const x = from.x + (to.x - from.x) * (i / 5);
    const y = from.y + (to.y - from.y) * (i / 5);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
    await new Promise(r => setTimeout(r, 30));
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
}

async function smoothMove(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

async function keyShortcut(combo) {
  // combo: "ctrl+a", "cmd+shift+p", "F5" 등
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  let modifiers = 0;
  if (parts.includes('alt')) modifiers |= 1;
  if (parts.includes('ctrl') || parts.includes('control')) modifiers |= 2;
  if (parts.includes('meta') || parts.includes('cmd') || parts.includes('command')) modifiers |= 4;
  if (parts.includes('shift')) modifiers |= 8;
  const keyMap = { 'enter': 'Return', 'esc': 'Escape', 'escape': 'Escape', 'tab': 'Tab', 'backspace': 'BackSpace', 'delete': 'Delete', 'space': 'Space', 'up': 'ArrowUp', 'down': 'ArrowDown', 'left': 'ArrowLeft', 'right': 'ArrowRight' };
  const cdpKey = keyMap[key] || (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1));
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: cdpKey, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: cdpKey, modifiers });
}

// ====================== 요소 탐색 ======================

async function findByText(text) {
  return execute(`
    (function() {
      const q = ${JSON.stringify(text.toLowerCase())};
      const results = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim().toLowerCase().includes(q)) continue;
        const el = node.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        results.push({ tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 80), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
        if (results.length >= 20) break;
      }
      return results;
    })()
  `);
}

async function listInteractive() {
  return execute(`
    (function() {
      const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])';
      return Array.from(document.querySelectorAll(sel)).slice(0, 50).map(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text: (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 60), id: el.id || '', x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }).filter(Boolean);
    })()
  `);
}

async function findByRole(role) {
  return execute(`
    (function() {
      const implicit = ${JSON.stringify({ a: 'link', button: 'button', input: 'textbox', select: 'combobox', textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', form: 'form' })};
      const r = ${JSON.stringify(role.toLowerCase())};
      return Array.from(document.querySelectorAll('*')).filter(el => {
        const aria = el.getAttribute('role')?.toLowerCase();
        const imp = implicit[el.tagName.toLowerCase()];
        return aria === r || imp === r;
      }).slice(0, 30).map(el => {
        const rect = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60), x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2) };
      });
    })()
  `);
}

async function highlight(selector) {
  return execute(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Not found';
      const prev = el.style.outline;
      el.style.outline = '3px solid #ff5722';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { el.style.outline = prev; }, 2000);
      return el.tagName + ' ' + el.textContent.trim().slice(0, 50);
    })()
  `);
}

// ====================== 콘솔 캡처 ======================

async function startConsoleCapture() {
  await cdp('Runtime.enable');
  await cdp('Log.enable');
}

async function stopConsoleCapture() {
  await cdp('Runtime.disable');
  await cdp('Log.disable');
}

// ====================== 네트워크 캡처 ======================

async function startNetworkCapture() {
  await cdp('Network.enable');
}

async function stopNetworkCapture() {
  await cdp('Network.disable');
}

async function getResponseBody(requestId) {
  try {
    return await cdp('Network.getResponseBody', { requestId });
  } catch (e) {
    return { error: e.message };
  }
}

// ====================== 스토리지 ======================

async function getCookies(url) {
  const r = await cdp('Network.getCookies', url ? { urls: [url] } : {});
  return r.cookies;
}

async function setCookie(name, value, domain, path) {
  await cdp('Network.setCookie', { name, value, domain, path: path || '/' });
}

async function getLocalStorage() {
  const raw = await execute(`JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function setLocalStorageItem(key, value) {
  return execute(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); 'ok'`);
}

async function removeLocalStorageItem(key) {
  return execute(`localStorage.removeItem(${JSON.stringify(key)}); 'ok'`);
}

async function getSessionStorage() {
  const raw = await execute(`JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function clearLocalStorage() {
  return execute(`localStorage.clear(); 'ok'`);
}

// ====================== 성능 ======================

async function getPerformanceMetrics() {
  await cdp('Performance.enable');
  const r = await cdp('Performance.getMetrics');
  return r.metrics;
}

// ====================== 풀페이지 스크린샷 ======================

async function fullPageScreenshot() {
  const layout = await cdp('Page.getLayoutMetrics');
  const { width, height } = layout.contentSize;
  const w = Math.ceil(width);
  const h = Math.min(Math.ceil(height), 16000); // 16000px 제한
  await cdp('Emulation.setVisibleSize', { width: w, height: h });
  const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  // 뷰포트 복원
  await cdp('Emulation.setVisibleSize', { width: 1280, height: 800 });
  return r.data;
}
