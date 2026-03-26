// Computer Control Module — BrowserView + Gemini Computer Use API
// Manages embedded browser, screenshots, action execution, and agent loop

const { BrowserView, nativeImage } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

class ComputerControl {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.browserView = null;
        this.state = 'idle'; // idle | running | stopped
        this._aborted = false;
        this._loopCount = 0;
        this._maxLoops = 30;
        this._conversationHistory = [];
        this._viewBounds = { x: 0, y: 0, width: 1024, height: 768 };

        // Callbacks
        this.onUpdate = null;
        this.onActionLog = null;
        this.onScreenshot = null;
        this.onError = null;
        this.onVerifyComplete = null;
    }

    // ===================================================================
    //  BrowserView Management
    // ===================================================================

    createBrowserView() {
        if (this.browserView) return;
        this.browserView = new BrowserView({
            webPreferences: {
                sandbox: true,
                nodeIntegration: false,
                contextIsolation: true
            }
        });
        this.mainWindow.addBrowserView(this.browserView);
        this.browserView.setBounds(this._viewBounds);
        this.browserView.setAutoResize({ width: false, height: false });
        this._emitUpdate();
    }

    destroyBrowserView() {
        if (!this.browserView) return;
        try {
            this.mainWindow.removeBrowserView(this.browserView);
            this.browserView.webContents.destroy();
        } catch (_) {}
        this.browserView = null;
        this._emitUpdate();
    }

    setBounds(bounds) {
        this._viewBounds = bounds;
        if (this.browserView) {
            this.browserView.setBounds(bounds);
        }
    }

    navigate(url) {
        if (!this.browserView) return;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        this.browserView.webContents.loadURL(url);
        this._log('navigate', `Loading: ${url}`);
    }

    getCurrentUrl() {
        if (!this.browserView) return '';
        try { return this.browserView.webContents.getURL(); } catch (_) { return ''; }
    }

    // ===================================================================
    //  Screenshot Capture
    // ===================================================================

    async captureScreenshot() {
        if (!this.browserView) throw new Error('No BrowserView');
        const image = await this.browserView.webContents.capturePage();
        const size = image.getSize();

        // Resize to keep API payload reasonable (max 1568px longest side)
        const maxDim = 1568;
        let w = size.width;
        let h = size.height;
        if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        }

        const resized = image.resize({ width: w, height: h });
        const base64 = resized.toPNG().toString('base64');

        if (this.onScreenshot) {
            this.onScreenshot(base64, w, h);
        }

        return { base64, width: w, height: h };
    }

    // Convert Gemini normalized coordinates (0–999) to actual BrowserView coordinates
    _fromNormalized(nx, ny) {
        return {
            x: Math.round((nx / 1000) * this._viewBounds.width),
            y: Math.round((ny / 1000) * this._viewBounds.height)
        };
    }

    // ===================================================================
    //  Action Execution (Gemini Computer Use actions)
    // ===================================================================

    async executeAction(actionName, actionArgs) {
        if (!this.browserView) return;
        const wc = this.browserView.webContents;

        switch (actionName) {
            case 'click_at': {
                const { x, y } = this._fromNormalized(actionArgs.x, actionArgs.y);
                this._log('click', `Click (${actionArgs.x}, ${actionArgs.y})`);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                await this._wait(50);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                break;
            }
            case 'double_click_at': {
                const { x, y } = this._fromNormalized(actionArgs.x, actionArgs.y);
                this._log('double_click', `Double-click (${actionArgs.x}, ${actionArgs.y})`);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                await this._wait(30);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                await this._wait(30);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
                await this._wait(30);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
                break;
            }
            case 'right_click_at': {
                const { x, y } = this._fromNormalized(actionArgs.x, actionArgs.y);
                this._log('right_click', `Right-click (${actionArgs.x}, ${actionArgs.y})`);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
                await this._wait(50);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
                break;
            }
            case 'type_text_at': {
                const { x, y } = this._fromNormalized(actionArgs.x, actionArgs.y);
                const text = actionArgs.text || '';
                this._log('type', `Type at (${actionArgs.x},${actionArgs.y}): "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
                // Click to focus
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                await this._wait(50);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                await this._wait(100);
                // Clear if requested
                if (actionArgs.clear_before_typing) {
                    wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['meta'] });
                    await this._wait(30);
                    wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['meta'] });
                    await this._wait(30);
                    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
                    await this._wait(30);
                    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
                    await this._wait(50);
                }
                await wc.insertText(text);
                // Press Enter if requested
                if (actionArgs.press_enter) {
                    await this._wait(50);
                    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
                    await this._wait(30);
                    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
                }
                break;
            }
            case 'key_combination': {
                const keys = actionArgs.keys || [];
                this._log('key', `Keys: ${keys.join('+')}`);
                await this._sendKeyCombo(wc, keys.join('+'));
                break;
            }
            case 'scroll_at': {
                const { x, y } = this._fromNormalized(actionArgs.x, actionArgs.y);
                const direction = actionArgs.direction || 'down';
                const magnitude = actionArgs.magnitude || 3;
                const delta = magnitude * 100;
                let deltaX = 0, deltaY = 0;
                if (direction === 'up') deltaY = delta;
                else if (direction === 'down') deltaY = -delta;
                else if (direction === 'left') deltaX = delta;
                else if (direction === 'right') deltaX = -delta;
                this._log('scroll', `Scroll ${direction} at (${actionArgs.x},${actionArgs.y})`);
                wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
                break;
            }
            case 'scroll_document': {
                const dir = actionArgs.direction || 'down';
                const mag = actionArgs.magnitude || 3;
                const d = mag * 100;
                let dX = 0, dY = 0;
                if (dir === 'up') dY = d;
                else if (dir === 'down') dY = -d;
                else if (dir === 'left') dX = d;
                else if (dir === 'right') dX = -d;
                this._log('scroll', `Scroll document ${dir}`);
                const cx = Math.round(this._viewBounds.width / 2);
                const cy = Math.round(this._viewBounds.height / 2);
                wc.sendInputEvent({ type: 'mouseWheel', x: cx, y: cy, deltaX: dX, deltaY: dY });
                break;
            }
            case 'hover_at': {
                const { x, y } = this._fromNormalized(actionArgs.x, actionArgs.y);
                this._log('hover', `Hover (${actionArgs.x}, ${actionArgs.y})`);
                wc.sendInputEvent({ type: 'mouseMove', x, y });
                break;
            }
            case 'drag_and_drop': {
                const start = this._fromNormalized(actionArgs.x, actionArgs.y);
                const end = this._fromNormalized(actionArgs.dest_x, actionArgs.dest_y);
                this._log('drag', `Drag (${actionArgs.x},${actionArgs.y}) → (${actionArgs.dest_x},${actionArgs.dest_y})`);
                wc.sendInputEvent({ type: 'mouseDown', x: start.x, y: start.y, button: 'left', clickCount: 1 });
                await this._wait(100);
                const steps = 5;
                for (let i = 1; i <= steps; i++) {
                    const mx = start.x + (end.x - start.x) * (i / steps);
                    const my = start.y + (end.y - start.y) * (i / steps);
                    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(mx), y: Math.round(my) });
                    await this._wait(30);
                }
                wc.sendInputEvent({ type: 'mouseUp', x: end.x, y: end.y, button: 'left', clickCount: 1 });
                break;
            }
            case 'navigate': {
                const url = actionArgs.url || '';
                this._log('navigate', `Navigate: ${url}`);
                this.navigate(url);
                await this._wait(2000);
                break;
            }
            case 'go_back': {
                this._log('navigate', 'Go back');
                wc.goBack();
                await this._wait(1000);
                break;
            }
            case 'go_forward': {
                this._log('navigate', 'Go forward');
                wc.goForward();
                await this._wait(1000);
                break;
            }
            case 'wait_5_seconds': {
                this._log('wait', 'Waiting 5 seconds');
                await this._wait(5000);
                break;
            }
            case 'screenshot': {
                this._log('screenshot', 'Taking screenshot');
                break;
            }
            default:
                this._log('unknown', `Unknown action: ${actionName}`);
        }
    }

    async _sendKeyCombo(wc, keyCombo) {
        // Parse key combinations like "ctrl+a", "Return", "space"
        const keyMap = {
            'Return': 'Return', 'Enter': 'Return',
            'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace',
            'Delete': 'Delete', 'space': 'Space', 'Space': 'Space',
            'ArrowUp': 'Up', 'Up': 'Up',
            'ArrowDown': 'Down', 'Down': 'Down',
            'ArrowLeft': 'Left', 'Left': 'Left',
            'ArrowRight': 'Right', 'Right': 'Right',
            'Home': 'Home', 'End': 'End',
            'Page_Up': 'PageUp', 'PageUp': 'PageUp',
            'Page_Down': 'PageDown', 'PageDown': 'PageDown',
        };

        const parts = keyCombo.split('+').map(p => p.trim());
        const modifiers = [];
        let key = '';

        for (const part of parts) {
            const lower = part.toLowerCase();
            if (lower === 'ctrl' || lower === 'control') modifiers.push('control');
            else if (lower === 'alt' || lower === 'option') modifiers.push('alt');
            else if (lower === 'shift') modifiers.push('shift');
            else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') modifiers.push('meta');
            else key = keyMap[part] || part;
        }

        if (key) {
            wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
            await this._wait(30);
            wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
        }
    }

    // ===================================================================
    //  Gemini API Call
    // ===================================================================

    async callAPI(apiKey, model, contents) {
        const modelId = model || 'gemini-2.5-flash-preview-04-17';

        const body = JSON.stringify({
            contents,
            tools: [{
                computer_use: {
                    environment: 'ENVIRONMENT_BROWSER'
                }
            }],
            generationConfig: {
                maxOutputTokens: 8192
            }
        });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/${modelId}:generateContent`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode !== 200) {
                            reject(new Error(`Gemini API error ${res.statusCode}: ${parsed.error?.message || data}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse Gemini response: ${e.message}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    // ===================================================================
    //  Agent Loop
    // ===================================================================

    async startTask(userTask, startUrl, apiKey, model) {
        if (this.state === 'running') {
            this._emitError('Agent is already running');
            return;
        }

        this.state = 'running';
        this._aborted = false;
        this._loopCount = 0;
        this._conversationHistory = [];
        this._emitUpdate();

        try {
            // Navigate to start URL if provided
            if (startUrl) {
                this.navigate(startUrl);
                await this._wait(2000); // Wait for page load
            }

            // Initial screenshot
            const screenshot = await this.captureScreenshot();

            // Build initial message (Gemini format)
            this._conversationHistory = [{
                role: 'user',
                parts: [
                    { text: userTask },
                    { inlineData: { mimeType: 'image/png', data: screenshot.base64 } }
                ]
            }];

            // Agent loop
            while (this._loopCount < this._maxLoops && !this._aborted) {
                this._loopCount++;
                this._log('loop', `--- Loop ${this._loopCount}/${this._maxLoops} ---`);
                this._emitUpdate();

                // Call Gemini API
                const response = await this.callAPI(apiKey, model, this._conversationHistory);

                if (this._aborted) break;

                // Extract candidate
                const candidate = response.candidates?.[0];
                if (!candidate) {
                    this._log('error', 'No candidate in Gemini response');
                    break;
                }

                const content = candidate.content;
                const finishReason = candidate.finishReason;
                const parts = content?.parts || [];

                // Add model response to history
                this._conversationHistory.push({
                    role: 'model',
                    parts
                });

                // Log text parts
                for (const part of parts) {
                    if (part.text) {
                        this._log('think', part.text.substring(0, 200));
                    }
                }

                // Check for function calls
                const functionCalls = parts.filter(p => p.functionCall);
                if (functionCalls.length === 0) {
                    this._log('done', `Task completed (${finishReason || 'no actions'})`);
                    break;
                }

                // Execute each function call and collect results
                const responseParts = [];
                for (const fc of functionCalls) {
                    if (this._aborted) break;

                    const actionName = fc.functionCall.name;
                    const actionArgs = fc.functionCall.args || {};

                    // Execute the action
                    await this.executeAction(actionName, actionArgs);

                    // Wait for UI to settle
                    await this._wait(500);

                    if (this._aborted) break;

                    // Take screenshot after action
                    const newScreenshot = await this.captureScreenshot();

                    responseParts.push({
                        functionResponse: {
                            name: actionName,
                            response: {
                                output: 'Action executed successfully'
                            }
                        }
                    });
                    responseParts.push({
                        inlineData: {
                            mimeType: 'image/png',
                            data: newScreenshot.base64
                        }
                    });
                }

                if (this._aborted) break;

                // Add function results to conversation
                this._conversationHistory.push({
                    role: 'user',
                    parts: responseParts
                });
            }

        } catch (err) {
            this._emitError(err.message);
            this._log('error', err.message);
        }

        this.state = this._aborted ? 'stopped' : 'idle';
        this._emitUpdate();
        this._log('status', `Agent ${this._aborted ? 'stopped' : 'finished'} after ${this._loopCount} loops`);

        // Extract final summary from last model message and invoke verify callback
        if (this.onVerifyComplete && !this._aborted) {
            try {
                const lastModel = [...this._conversationHistory].reverse().find(m => m.role === 'model');
                if (lastModel) {
                    const textParts = (lastModel.parts || []).filter(p => p.text);
                    const summary = textParts.map(p => p.text).join('\n') || 'No summary available';
                    this.onVerifyComplete(summary);
                }
            } catch (_) {}
        }
    }

    stop() {
        this._aborted = true;
        this.state = 'stopped';
        this._emitUpdate();
    }

    getState() {
        return {
            state: this.state,
            loopCount: this._loopCount,
            maxLoops: this._maxLoops,
            currentUrl: this.getCurrentUrl()
        };
    }

    // ===================================================================
    //  Auto Detect Dev Server
    // ===================================================================

    static async autoDetectDevServer(projectPath) {
        const defaultPorts = [3000, 3001, 5173, 5174, 8080, 8000, 8888, 4200, 4000, 1234, 9000];
        const priorityPorts = [];

        // Try to extract port hints from package.json
        try {
            const pkgPath = path.join(projectPath, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const scripts = pkg.scripts || {};
                const devScripts = [scripts.dev, scripts.start, scripts.serve].filter(Boolean);
                for (const script of devScripts) {
                    // Match --port, -p, PORT= patterns
                    const portMatch = script.match(/(?:--port|--PORT|-p)\s+(\d+)/i) ||
                                      script.match(/PORT[=\s]+(\d+)/i);
                    if (portMatch) {
                        const p = parseInt(portMatch[1], 10);
                        if (p > 0 && p < 65536 && !priorityPorts.includes(p)) {
                            priorityPorts.push(p);
                        }
                    }
                }
            }
        } catch (_) {}

        // Merge: priority ports first, then defaults (no duplicates)
        const ports = [...priorityPorts, ...defaultPorts.filter(p => !priorityPorts.includes(p))];

        // Probe each port with HTTP GET (1s timeout)
        for (const port of ports) {
            try {
                const alive = await new Promise((resolve) => {
                    const req = http.get(`http://localhost:${port}`, { timeout: 1000 }, (res) => {
                        res.resume(); // drain
                        resolve(true);
                    });
                    req.on('error', () => resolve(false));
                    req.on('timeout', () => { req.destroy(); resolve(false); });
                });
                if (alive) return `http://localhost:${port}`;
            } catch (_) {}
        }
        return null;
    }

    // ===================================================================
    //  Auto Verify
    // ===================================================================

    async autoVerify(projectPath, apiKey, model) {
        this._log('status', 'Dev server 자동 탐지 중...');

        const url = await ComputerControl.autoDetectDevServer(projectPath);
        if (!url) {
            this._emitError('Dev server를 찾을 수 없습니다. 프로젝트의 dev server를 먼저 실행하세요.');
            return { success: false, error: 'Dev server를 찾을 수 없습니다' };
        }

        this._log('status', `Dev server 발견: ${url}`);

        const verifyPrompt = `이 웹 애플리케이션을 자율적으로 검증하세요:
1. 현재 페이지의 레이아웃, 디자인, UI 요소를 분석
2. 모든 버튼, 링크, 입력 필드를 클릭/테스트
3. 페이지 네비게이션 — 다른 페이지로 이동하며 확인
4. 반응형 확인 — 스크롤, 리사이즈
5. 에러 발견 시 상세히 기록
6. 최종 검증 결과를 한국어로 요약 (정상 항목, 문제 항목, 개선 제안)`;

        // Start the agent loop — runs in background
        this.startTask(verifyPrompt, url, apiKey, model);
        return { success: true, url };
    }

    // ===================================================================
    //  Helpers
    // ===================================================================

    _wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _log(type, message) {
        if (this.onActionLog) {
            this.onActionLog({ type, message, timestamp: Date.now() });
        }
    }

    _emitUpdate() {
        if (this.onUpdate) {
            this.onUpdate(this.getState());
        }
    }

    _emitError(message) {
        if (this.onError) {
            this.onError(message);
        }
    }
}

module.exports = ComputerControl;
