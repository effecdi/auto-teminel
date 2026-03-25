// Computer Control Module — BrowserView + Anthropic Computer Use API
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
        this._scaleFactor = 1;
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

        // API limit: max 1568px on the longest side, ~1.15M total pixels
        const maxDim = 1568;
        let w = size.width;
        let h = size.height;
        if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        }
        // Track scale factor for coordinate conversion
        this._scaleFactor = size.width / w;

        const resized = image.resize({ width: w, height: h });
        const base64 = resized.toPNG().toString('base64');

        if (this.onScreenshot) {
            this.onScreenshot(base64, w, h);
        }

        return { base64, width: w, height: h };
    }

    // Convert API coordinates (screenshot space) to actual BrowserView coordinates
    _toRealCoords(x, y) {
        return {
            x: Math.round(x * this._scaleFactor),
            y: Math.round(y * this._scaleFactor)
        };
    }

    // ===================================================================
    //  Action Execution (sendInputEvent based)
    // ===================================================================

    async executeAction(action) {
        if (!this.browserView) return;
        const wc = this.browserView.webContents;
        const type = action.type || action.action;

        switch (type) {
            case 'left_click':
            case 'click': {
                const { x, y } = this._toRealCoords(action.coordinate[0], action.coordinate[1]);
                this._log('click', `Click (${action.coordinate[0]}, ${action.coordinate[1]})`);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                await this._wait(50);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                break;
            }
            case 'right_click': {
                const { x, y } = this._toRealCoords(action.coordinate[0], action.coordinate[1]);
                this._log('right_click', `Right-click (${action.coordinate[0]}, ${action.coordinate[1]})`);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
                await this._wait(50);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
                break;
            }
            case 'double_click': {
                const { x, y } = this._toRealCoords(action.coordinate[0], action.coordinate[1]);
                this._log('double_click', `Double-click (${action.coordinate[0]}, ${action.coordinate[1]})`);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                await this._wait(30);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                await this._wait(30);
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
                await this._wait(30);
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
                break;
            }
            case 'type': {
                const text = action.text || '';
                this._log('type', `Typing: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
                await wc.insertText(text);
                break;
            }
            case 'key': {
                const keyCombo = action.key || action.text || '';
                this._log('key', `Key: ${keyCombo}`);
                await this._sendKeyCombo(wc, keyCombo);
                break;
            }
            case 'scroll': {
                const { x, y } = this._toRealCoords(action.coordinate[0], action.coordinate[1]);
                const deltaX = action.delta ? action.delta[0] : 0;
                const deltaY = action.delta ? action.delta[1] : 0;
                this._log('scroll', `Scroll (${deltaX}, ${deltaY}) at (${action.coordinate[0]}, ${action.coordinate[1]})`);
                wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
                break;
            }
            case 'mouse_move': {
                const { x, y } = this._toRealCoords(action.coordinate[0], action.coordinate[1]);
                this._log('mouse_move', `Move to (${action.coordinate[0]}, ${action.coordinate[1]})`);
                wc.sendInputEvent({ type: 'mouseMove', x, y });
                break;
            }
            case 'left_click_drag': {
                const startCoord = this._toRealCoords(action.startCoordinate[0], action.startCoordinate[1]);
                const endCoord = this._toRealCoords(action.coordinate[0], action.coordinate[1]);
                this._log('drag', `Drag from (${action.startCoordinate[0]},${action.startCoordinate[1]}) to (${action.coordinate[0]},${action.coordinate[1]})`);
                wc.sendInputEvent({ type: 'mouseDown', x: startCoord.x, y: startCoord.y, button: 'left', clickCount: 1 });
                await this._wait(100);
                // Move in steps
                const steps = 5;
                for (let i = 1; i <= steps; i++) {
                    const mx = startCoord.x + (endCoord.x - startCoord.x) * (i / steps);
                    const my = startCoord.y + (endCoord.y - startCoord.y) * (i / steps);
                    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(mx), y: Math.round(my) });
                    await this._wait(30);
                }
                wc.sendInputEvent({ type: 'mouseUp', x: endCoord.x, y: endCoord.y, button: 'left', clickCount: 1 });
                break;
            }
            case 'wait': {
                const ms = (action.duration || 2) * 1000;
                this._log('wait', `Waiting ${ms}ms`);
                await this._wait(ms);
                break;
            }
            case 'screenshot': {
                this._log('screenshot', 'Taking screenshot');
                break;
            }
            default:
                this._log('unknown', `Unknown action: ${type}`);
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
    //  Anthropic API Call
    // ===================================================================

    async callAPI(apiKey, model, messages, screenshotData) {
        // Determine tool version and beta header based on model
        let toolVersion, betaHeader;
        if (model && model.includes('opus')) {
            toolVersion = 'computer_20251124';
            betaHeader = 'computer-use-2025-11-24';
        } else {
            toolVersion = 'computer_20250124';
            betaHeader = 'computer-use-2025-01-24';
        }

        const tools = [{
            type: toolVersion,
            name: 'computer',
            display_width_px: screenshotData.width,
            display_height_px: screenshotData.height,
            display_number: 1
        }];

        const body = JSON.stringify({
            model: model || 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            tools,
            messages
        });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': betaHeader
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode !== 200) {
                            reject(new Error(`API error ${res.statusCode}: ${parsed.error?.message || data}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse API response: ${e.message}`));
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

            // Build initial message
            this._conversationHistory = [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: userTask
                    },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: screenshot.base64
                        }
                    }
                ]
            }];

            // Agent loop
            while (this._loopCount < this._maxLoops && !this._aborted) {
                this._loopCount++;
                this._log('loop', `--- Loop ${this._loopCount}/${this._maxLoops} ---`);
                this._emitUpdate();

                // Call API
                const response = await this.callAPI(apiKey, model, this._conversationHistory, screenshot);

                if (this._aborted) break;

                // Extract content blocks
                const content = response.content || [];
                const stopReason = response.stop_reason;

                // Add assistant response to history
                this._conversationHistory.push({
                    role: 'assistant',
                    content
                });

                // Log text blocks
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        this._log('think', block.text.substring(0, 200));
                    }
                }

                // If stop reason is 'end_turn' (no tool use), we're done
                if (stopReason === 'end_turn') {
                    this._log('done', 'Task completed (end_turn)');
                    break;
                }

                // Process tool_use blocks
                const toolUseBlocks = content.filter(b => b.type === 'tool_use');
                if (toolUseBlocks.length === 0) {
                    this._log('done', 'No tool use blocks — task complete');
                    break;
                }

                const toolResults = [];
                for (const toolBlock of toolUseBlocks) {
                    if (this._aborted) break;

                    const action = toolBlock.input;

                    // Execute the action
                    await this.executeAction(action);

                    // Wait for UI to settle
                    await this._wait(500);

                    if (this._aborted) break;

                    // Take screenshot after action
                    const newScreenshot = await this.captureScreenshot();

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolBlock.id,
                        content: [{
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: newScreenshot.base64
                            }
                        }]
                    });
                }

                if (this._aborted) break;

                // Add tool results to conversation
                this._conversationHistory.push({
                    role: 'user',
                    content: toolResults
                });
            }

        } catch (err) {
            this._emitError(err.message);
            this._log('error', err.message);
        }

        this.state = this._aborted ? 'stopped' : 'idle';
        this._emitUpdate();
        this._log('status', `Agent ${this._aborted ? 'stopped' : 'finished'} after ${this._loopCount} loops`);

        // Extract final summary from last assistant message and invoke verify callback
        if (this.onVerifyComplete && !this._aborted) {
            try {
                const lastAssistant = [...this._conversationHistory].reverse().find(m => m.role === 'assistant');
                if (lastAssistant) {
                    const textBlocks = (lastAssistant.content || []).filter(b => b.type === 'text' && b.text);
                    const summary = textBlocks.map(b => b.text).join('\n') || 'No summary available';
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
