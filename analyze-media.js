#!/usr/bin/env node
/**
 * analyze-media.js — Gemini File API를 사용한 미디어 분석 CLI 도구
 *
 * 사용법:
 *   node analyze-media.js <파일경로> [프롬프트]
 *
 * 예시:
 *   node analyze-media.js ./video.mp4 "이 영상의 내용을 요약해줘"
 *   node analyze-media.js ./screenshot.png "이 화면에서 버그를 찾아줘"
 */

const fs = require('fs');
const path = require('path');

const MEDIA_MIME_TYPES = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};

const CONFIG_PATH = path.join(
    process.env.HOME || process.env.USERPROFILE,
    'Library/Application Support/claude-cli-terminal/config.json'
);

function getApiKey() {
    // 1. 환경변수 우선
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;

    // 2. electron-store config에서 읽기
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (config.geminiApiKey) return config.geminiApiKey;
    } catch (e) {
        // config 파일 없음
    }

    return null;
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MEDIA_MIME_TYPES[ext] || null;
}

async function analyzeMedia(filePath, prompt) {
    // 1. API Key 확인
    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('ERROR: Gemini API Key가 없습니다.');
        console.error('  - 환경변수: GEMINI_API_KEY=<key> node analyze-media.js ...');
        console.error(`  - 또는 Auto-Teminel 앱에서 설정 (${CONFIG_PATH})`);
        process.exit(1);
    }

    // 2. 파일 확인
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
        console.error(`ERROR: 파일을 찾을 수 없습니다: ${absPath}`);
        process.exit(1);
    }

    const mimeType = getMimeType(absPath);
    if (!mimeType) {
        console.error(`ERROR: 지원하지 않는 파일 형식입니다: ${path.extname(absPath)}`);
        console.error('지원 형식: ' + Object.keys(MEDIA_MIME_TYPES).join(', '));
        process.exit(1);
    }

    const stat = fs.statSync(absPath);
    if (stat.size > 2 * 1024 * 1024 * 1024) {
        console.error('ERROR: 파일 크기가 2GB를 초과합니다.');
        process.exit(1);
    }

    const isVideo = mimeType.startsWith('video/');
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.error(`파일: ${path.basename(absPath)} (${sizeMB}MB, ${mimeType})`);

    // 3. Gemini File API로 업로드
    const { GoogleAIFileManager } = require('@google/generative-ai/server');
    const { GoogleGenerativeAI } = require('@google/generative-ai');

    const fileManager = new GoogleAIFileManager(apiKey);

    console.error('업로드 중...');
    const uploadResult = await fileManager.uploadFile(absPath, {
        mimeType,
        displayName: path.basename(absPath),
    });
    let file = uploadResult.file;
    console.error(`업로드 완료: ${file.name} (state: ${file.state})`);

    // 4. 동영상은 ACTIVE 상태까지 폴링
    if (isVideo && file.state === 'PROCESSING') {
        console.error('동영상 처리 중... (최대 2분)');
        const MAX_POLL = 60;
        for (let i = 0; i < MAX_POLL; i++) {
            await new Promise(r => setTimeout(r, 2000));
            file = await fileManager.getFile(file.name);
            process.stderr.write(`  처리 중... (${i * 2}s, state: ${file.state})\r`);

            if (file.state === 'ACTIVE') {
                console.error('\n동영상 처리 완료!');
                break;
            }
            if (file.state === 'FAILED') {
                console.error('\nERROR: 동영상 처리 실패');
                process.exit(1);
            }
        }
        if (file.state !== 'ACTIVE') {
            console.error('\nERROR: 동영상 처리 타임아웃 (2분 초과)');
            process.exit(1);
        }
    }

    // 5. Gemini에 분석 요청
    console.error('Gemini 분석 중...');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent([
        {
            fileData: {
                fileUri: file.uri,
                mimeType: file.mimeType || mimeType,
            },
        },
        { text: prompt },
    ]);

    const response = result.response;
    const text = response.text();

    // 분석 결과를 stdout으로 출력 (파이프 가능)
    console.log(text);
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('사용법: node analyze-media.js <파일경로> [프롬프트]');
    console.error('  예시: node analyze-media.js video.mp4 "이 영상을 요약해줘"');
    process.exit(1);
}

const filePath = args[0];
const prompt = args.slice(1).join(' ') || '이 미디어의 내용을 자세히 분석하고 설명해주세요.';

analyzeMedia(filePath, prompt).catch(err => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
});
