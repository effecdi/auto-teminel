// imagegen/gemini-image-provider.js
// Stage 6 — image generation via the already-integrated @google/generative-ai
// SDK using responseModalities + inline image data.
//
// NOTE: the exact image-capable model name changes over time. It is configurable
// (store 'geminiImageModel'); the default below is a best guess and may need to
// be updated by the user if the API returns a model-not-found error. This module
// uses the correct mechanism (responseModalities:['Text','Image'] -> inlineData);
// only the model string is uncertain.

const fs = require('fs');

const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image-preview';

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * @param {string} apiKey Gemini API key
 * @param {string} prompt
 * @param {object} opts {model, outPath}  outPath = absolute file path WITHOUT extension
 * @returns {Promise<{path, mimeType}>}
 */
async function generateImageGemini(apiKey, prompt, opts = {}) {
    if (!apiKey) throw new Error('Gemini API 키가 없습니다 (settings: geminiApiKey)');
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: opts.model || DEFAULT_IMAGE_MODEL,
        generationConfig: { responseModalities: ['Text', 'Image'] },
    });

    const res = await model.generateContent(prompt);
    const cand = res && res.response && res.response.candidates && res.response.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    for (const p of parts) {
        const inline = p.inlineData || p.inline_data;
        if (inline && inline.data) {
            const mimeType = inline.mimeType || inline.mime_type || 'image/png';
            const ext = EXT_BY_MIME[mimeType] || 'png';
            const outPath = (opts.outPath || 'generated') + '.' + ext;
            fs.writeFileSync(outPath, Buffer.from(inline.data, 'base64'));
            return { path: outPath, mimeType };
        }
    }
    throw new Error('Gemini가 이미지를 반환하지 않음 — 모델명(geminiImageModel) 또는 권한 확인 필요');
}

module.exports = { generateImageGemini, DEFAULT_IMAGE_MODEL };
