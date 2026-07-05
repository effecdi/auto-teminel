// imagegen/image-router.js
// Stage 6 — routes image generation to the preferred backend with fallback.
//
//   imageBackend = 'chatgpt-web'  -> try ChatGPT web first, fall back to Gemini
//   imageBackend = 'gemini' (default) -> try Gemini first, fall back to ChatGPT web
//
// Primary/backup is per user setting so the free ChatGPT-web path can be chosen
// while Gemini remains a reliable fallback. Generated files land in the project
// dir (or temp) and the path is returned.

const os = require('os');
const path = require('path');
const { generateImageGemini } = require('./gemini-image-provider');
const { ChatGptWebDriver } = require('./chatgpt-web-driver');

class ImageRouter {
    constructor({ store, getMainWindow }) {
        this.store = store;
        this.getMainWindow = getMainWindow;
        this.chatgpt = null;
    }

    _driver() {
        if (!this.chatgpt) this.chatgpt = new ChatGptWebDriver(this.getMainWindow);
        return this.chatgpt;
    }

    async _runBackend(backend, prompt, baseNoExt) {
        if (backend === 'gemini') {
            const r = await generateImageGemini(
                this.store.get('geminiApiKey', ''),
                prompt,
                { model: this.store.get('geminiImageModel', '') || undefined, outPath: baseNoExt }
            );
            return { ...r, backend: 'gemini' };
        }
        const r = await this._driver().generate(prompt, baseNoExt);
        return { ...r, backend: 'chatgpt-web' };
    }

    /** @param {string} prompt @param {object} opts {projectPath, backend} */
    async generate(prompt, opts = {}) {
        if (!prompt || !prompt.trim()) throw new Error('이미지 프롬프트가 비어있음');
        const pref = opts.backend || this.store.get('imageBackend', 'gemini');
        const outDir = opts.projectPath || os.tmpdir();
        const baseNoExt = path.join(outDir, 'generated-' + Date.now());
        const order = pref === 'chatgpt-web' ? ['chatgpt-web', 'gemini'] : ['gemini', 'chatgpt-web'];

        const errors = [];
        for (const backend of order) {
            try {
                return await this._runBackend(backend, prompt, baseNoExt);
            } catch (e) {
                errors.push(`${backend}: ${e && e.message ? e.message : e}`);
            }
        }
        throw new Error('이미지 생성 실패 — ' + errors.join(' | '));
    }

    async chatgptLogin() { return this._driver().reveal(); }
    chatgptHide() { return this._driver().hide(); }
    async chatgptStatus() { return { loggedIn: await this._driver().isLoggedIn().catch(() => false) }; }
}

module.exports = { ImageRouter };
