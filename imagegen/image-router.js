// imagegen/image-router.js
// Stage 6 target — image generation router.
//
// Stage 0 placeholder: establishes the /imagegen folder. Real logic lands in
// Stage 6:
//   primary  → chatgpt-web-driver.js  (drives the user's logged-in ChatGPT web
//              session via the existing BrowserView / chrome-extension bridge;
//              no OpenAI API key, uses the subscription = free)
//   backup   → gemini-image-provider.js (Gemini image gen via the already
//              integrated @google/generative-ai SDK)

const IMAGEGEN_STAGE = 0; // bumped to 6 when implemented

/** @returns {{ready: boolean, primary: string, backup: string}} */
function status() {
    return { ready: false, primary: 'chatgpt-web', backup: 'gemini' };
}

module.exports = { IMAGEGEN_STAGE, status };
