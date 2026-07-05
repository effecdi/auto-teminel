// imagegen/chatgpt-web-driver.js
// Stage 6 — EXPERIMENTAL image generation by automating the user's logged-in
// ChatGPT web session (no OpenAI API key; uses their subscription).
//
// HONESTY: this path is inherently fragile and UNVERIFIED without GUI testing.
// It depends on ChatGPT's DOM structure (selectors below) which OpenAI changes
// frequently, and on bot-detection not blocking automation. Selectors are
// centralized so they can be updated. Use imagegen.chatgptLogin first to sign in
// (the session persists via the 'persist:chatgpt-web' partition).

const fs = require('fs');
const path = require('path');

const CHATGPT_URL = 'https://chatgpt.com/';
// Centralized selectors — update these if ChatGPT changes its DOM.
const SEL = {
    composer: '#prompt-textarea',
    sendButton: 'button[data-testid="send-button"]',
    // Generated images usually render as <img> under oaiusercontent / blob in the last turn.
    assistantImg: 'img[src*="oaiusercontent"], img[src*="blob:"], main img[alt]',
};

class ChatGptWebDriver {
    constructor(getMainWindow) {
        this.getMainWindow = getMainWindow;
        this.view = null;
        this._loaded = false;
    }

    _ensureView() {
        if (this.view) return this.view;
        const { BrowserView } = require('electron');
        this.view = new BrowserView({ webPreferences: { partition: 'persist:chatgpt-web', contextIsolation: true } });
        return this.view;
    }

    async _load() {
        const view = this._ensureView();
        await view.webContents.loadURL(CHATGPT_URL);
        this._loaded = true;
    }

    /** Show the browser view so the user can log in / observe. */
    async reveal() {
        const win = this.getMainWindow();
        if (!win) throw new Error('main window 없음');
        const view = this._ensureView();
        if (!this._loaded) await this._load();
        win.addBrowserView(view);
        const b = win.getContentBounds();
        view.setBounds({ x: Math.floor(b.width * 0.25), y: 40, width: Math.floor(b.width * 0.7), height: b.height - 80 });
        return { revealed: true };
    }

    hide() {
        const win = this.getMainWindow();
        if (win && this.view) { try { win.removeBrowserView(this.view); } catch (_) {} }
        return { hidden: true };
    }

    async isLoggedIn() {
        if (!this._loaded) await this._load();
        try {
            return await this.view.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(SEL.composer)})`);
        } catch (_) { return false; }
    }

    /**
     * Generate an image via the web UI. Best-effort.
     * @returns {Promise<{path, mimeType}>}
     */
    async generate(prompt, outPathNoExt) {
        if (!this._loaded) await this._load();
        const wc = this.view.webContents;

        const loggedIn = await this.isLoggedIn();
        if (!loggedIn) throw new Error('ChatGPT 로그인 안 됨 — imagegen.chatgptLogin으로 먼저 로그인하세요');

        // Type the prompt into the composer and submit.
        const injected = await wc.executeJavaScript(`(async () => {
            const box = document.querySelector(${JSON.stringify(SEL.composer)});
            if (!box) return { ok:false, reason:'composer-not-found' };
            box.focus();
            // contenteditable composer: set text then dispatch input
            box.innerHTML = '';
            document.execCommand && document.execCommand('insertText', false, ${JSON.stringify('이미지를 생성해줘: ' + prompt)});
            box.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const btn = document.querySelector(${JSON.stringify(SEL.sendButton)});
            if (btn) { btn.click(); return { ok:true }; }
            // fallback: Enter key
            box.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
            return { ok:true, viaEnter:true };
        })()`);
        if (!injected || !injected.ok) throw new Error('프롬프트 입력 실패: ' + (injected && injected.reason || 'unknown'));

        // Poll for a generated image (up to ~150s).
        const deadline = Date.now() + 150000;
        let dataUrl = null;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 3000));
            dataUrl = await wc.executeJavaScript(`(async () => {
                const imgs = [...document.querySelectorAll(${JSON.stringify(SEL.assistantImg)})];
                const img = imgs[imgs.length - 1];
                if (!img || !img.src) return null;
                try {
                    const res = await fetch(img.src);
                    const blob = await res.blob();
                    if (!blob.type.startsWith('image/')) return null;
                    return await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(blob); });
                } catch (e) { return null; }
            })()`).catch(() => null);
            if (dataUrl && dataUrl.startsWith('data:image/')) break;
        }
        if (!dataUrl) throw new Error('이미지 생성 결과를 찾지 못함 (시간초과 또는 셀렉터 불일치)');

        const m = /^data:(image\/\w+);base64,(.*)$/.exec(dataUrl);
        if (!m) throw new Error('이미지 데이터 파싱 실패');
        const mimeType = m[1];
        const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
        const outPath = outPathNoExt + '.' + ext;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, Buffer.from(m[2], 'base64'));
        return { path: outPath, mimeType };
    }
}

module.exports = { ChatGptWebDriver, SEL, CHATGPT_URL };
