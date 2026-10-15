#!/usr/bin/env node
// scripts/update-models.js
// Claude 모델 자동 업데이트 스크립트 (GitHub Actions cron에서 실행).
//
// 동작:
//   1. 공식 문서(platform.claude.com models overview, 인증 불필요)에서 모델 ID 수집
//      - ANTHROPIC_API_KEY가 설정돼 있으면 Models API(GET /v1/models)도 함께 사용
//   2. models.json과 비교해서 "신규 모델만 추가" — 기존 항목은 절대 삭제/제거하지 않음
//   3. 신규 모델이 추가되면 같은 패밀리의 더 낮은 버전은 current → legacy로 강등
//   4. 변경이 있으면 models.json 저장 + lastUpdated 갱신, exit 0 (변경 여부는 git diff로 판별)
//
// 안전장치:
//   - 문서의 retired/deprecated 섹션에 있는 ID는 추가하지 않음
//   - 파싱 결과가 비정상(수집된 ID 0개)이면 아무것도 바꾸지 않고 실패 처리
//   - 기존 항목의 value/label은 건드리지 않음 (tier 강등만)

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODELS_JSON = path.join(__dirname, '..', 'models.json');
const DOCS_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview.md';
const API_URL = 'https://api.anthropic.com/v1/models?limit=100';

function fetchUrl(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'user-agent': 'auto-teminel-model-updater', ...headers } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchUrl(new URL(res.headers.location, url).toString(), headers));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error(`timeout: ${url}`)));
    });
}

/** 문서 마크다운에서 모델 ID 수집. retired/deprecated 섹션은 제외. */
function parseDocs(markdown) {
    const ids = new Set();
    const excluded = new Set();
    let inExcludedSection = false;
    for (const line of markdown.split('\n')) {
        const heading = line.match(/^#{1,6}\s+(.*)/);
        if (heading) {
            inExcludedSection = /retired|deprecated|retirement|legacy/i.test(heading[1]);
            continue;
        }
        const matches = line.match(/claude-[a-z]+-[0-9][0-9a-z.-]*/g) || [];
        for (const id of matches) {
            // 끝에 붙은 구두점 제거
            const clean = id.replace(/[.,;:)\]]+$/, '');
            if (inExcludedSection) excluded.add(clean);
            else ids.add(clean);
        }
    }
    for (const id of excluded) ids.delete(id);
    return ids;
}

/** Models API 응답에서 모델 ID 수집 (키 있을 때만 사용). */
async function fetchApiIds(apiKey) {
    const body = await fetchUrl(API_URL, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    });
    const json = JSON.parse(body);
    const ids = new Set();
    for (const m of json.data || []) {
        if (m && typeof m.id === 'string' && m.id.startsWith('claude-')) ids.add(m.id);
    }
    return ids;
}

/** ID에서 패밀리/버전 추출. 예: claude-opus-5-5 → {family:'opus', version:[5,5]} */
function parseId(id) {
    const parts = id.replace(/^claude-/, '').split('-');
    // 날짜 스냅샷 suffix(8자리) 제거: claude-haiku-4-5-20251001
    if (/^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
    const family = parts.filter((p) => !/^\d/.test(p)).join('-');
    const version = parts.filter((p) => /^\d/.test(p)).map(Number);
    if (!family || !version.length) return null;
    return { family, version };
}

function compareVersions(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] || 0) - (b[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** 라벨 생성: claude-opus-5-6 → "Opus 5.6" */
function makeLabel(id) {
    const p = parseId(id);
    if (!p) return id;
    const name = p.family
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    return `${name} ${p.version.join('.')}`;
}

async function main() {
    const data = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'));
    const existing = new Set(data.models.map((m) => m.value));

    // 1. 모델 ID 수집
    let liveIds = new Set();
    try {
        const md = await fetchUrl(DOCS_URL);
        liveIds = parseDocs(md);
        console.log(`[docs] ${liveIds.size}개 모델 ID 수집`);
    } catch (e) {
        console.warn(`[docs] 수집 실패: ${e.message}`);
    }
    if (process.env.ANTHROPIC_API_KEY) {
        try {
            const apiIds = await fetchApiIds(process.env.ANTHROPIC_API_KEY);
            console.log(`[api] ${apiIds.size}개 모델 ID 수집`);
            for (const id of apiIds) liveIds.add(id);
        } catch (e) {
            console.warn(`[api] 수집 실패: ${e.message}`);
        }
    }
    if (liveIds.size === 0) {
        console.error('수집된 모델 ID가 0개 — 파싱 비정상으로 판단, 변경 없이 종료');
        process.exit(1);
    }

    // 2. 신규 모델만 추가 (기존 삭제 금지)
    const added = [];
    for (const id of liveIds) {
        if (existing.has(id)) continue;
        // 날짜 스냅샷이 이미 base ID로 존재하면 중복 추가 안 함 (반대도 동일)
        const base = id.replace(/-\d{8}$/, '');
        const hasVariant = data.models.some((m) => m.value.replace(/-\d{8}$/, '') === base);
        if (hasVariant) continue;
        if (!parseId(id)) continue;
        data.models.push({ value: id, label: makeLabel(id), tier: 'current' });
        added.push(id);
    }

    if (!added.length) {
        console.log('신규 모델 없음 — 변경 사항 없음');
        return;
    }

    // 3. 같은 패밀리 하위 버전 강등 (current → legacy, flagship은 유지)
    for (const id of added) {
        const np = parseId(id);
        for (const m of data.models) {
            if (m.value === id || m.tier !== 'current') continue;
            const mp = parseId(m.value);
            if (mp && mp.family === np.family && compareVersions(mp.version, np.version) < 0) {
                m.tier = 'legacy';
                console.log(`강등: ${m.value} → legacy`);
            }
        }
    }

    // 4. 신규 모델이 목록 상단(기존 current 앞)에 오도록 정렬: flagship → current(버전 내림차순) → legacy(원래 순서 유지)
    const tierOrder = { flagship: 0, current: 1, legacy: 2 };
    const origIndex = new Map(data.models.map((m, i) => [m.value, i]));
    data.models.sort((a, b) => {
        const t = (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9);
        if (t !== 0) return t;
        if (a.tier === 'current') {
            const pa = parseId(a.value);
            const pb = parseId(b.value);
            if (pa && pb) {
                const v = compareVersions(pb.version, pa.version);
                if (v !== 0) return v;
                // 같은 버전이면 패밀리 순서: opus > sonnet > haiku > 기타
                const famRank = { opus: 0, sonnet: 1, haiku: 2 };
                const f = (famRank[pa.family] ?? 9) - (famRank[pb.family] ?? 9);
                if (f !== 0) return f;
            }
        }
        return origIndex.get(a.value) - origIndex.get(b.value);
    });

    data.lastUpdated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(MODELS_JSON, JSON.stringify(data, null, 2) + '\n');
    console.log(`models.json 갱신 완료 — 추가된 모델: ${added.join(', ')}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
