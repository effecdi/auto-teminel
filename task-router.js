// Task Router — classify user input and route to appropriate AI/mode
// Supports: claude-solo (terminal execution), gemini-solo (design/plan), pipeline (gemini→claude)

const ROUTE_MODES = {
    CLAUDE_SOLO: 'claude-solo',
    GEMINI_SOLO: 'gemini-solo',
    PIPELINE: 'pipeline'
};

// Keyword dictionaries for classification
const CLAUDE_KEYWORDS = [
    // Dev/backend
    'bug', 'error', 'fix', '수정', '버그', '에러', '오류',
    'api', 'db', 'database', '데이터베이스', 'server', '서버',
    'backend', '백엔드', 'endpoint', 'route', 'middleware',
    // Security
    'security', '보안', 'vulnerability', '취약점', 'auth', '인증',
    'xss', 'csrf', 'injection', 'sanitize',
    // DevOps
    'deploy', '배포', 'docker', 'ci/cd', 'build', '빌드',
    'test', '테스트', 'lint', 'migration',
    // Refactoring
    'refactor', '리팩토링', 'optimize', '최적화', 'performance', '성능',
    // File operations
    'install', '설치', 'config', '설정', 'env', 'package',
    // Code execution
    'run', '실행', 'execute', 'script', 'command', '명령',
    'compile', 'debug', '디버그',
];

const GEMINI_KEYWORDS = [
    // Design
    'design', '디자인', 'ui', 'ux', 'css', 'style', '스타일',
    'layout', '레이아웃', 'color', '색상', '컬러', 'font', '폰트',
    'wireframe', '와이어프레임', 'mockup', '목업',
    'responsive', '반응형', 'animation', '애니메이션',
    'theme', '테마', 'icon', '아이콘', 'typography',
    // Planning
    '기획', 'plan', 'planning', '설계', 'spec', '명세',
    'requirement', '요구사항', 'proposal', '제안',
    'architecture', '아키텍처', 'structure', '구조',
];

const PIPELINE_KEYWORDS = [
    // Complex tasks needing both design + implementation
    '페이지', 'page', '만들어', '만들기', 'create', 'build',
    '새로운', 'new', '추가', 'add', '기능', 'feature',
    '전체', 'full', 'complete', '완성',
    '컴포넌트', 'component', '화면', 'screen', 'view',
    '대시보드', 'dashboard', 'landing', '랜딩',
    '개편', 'redesign', '리뉴얼', 'renewal',
    '프로젝트', 'project', 'app', '앱', 'application',
];

/**
 * Classify a task into the appropriate route mode.
 * @param {string} text - User input text
 * @returns {{ mode: string, confidence: number, reason: string }}
 */
function classifyTask(text) {
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/);

    let claudeScore = 0;
    let geminiScore = 0;
    let pipelineScore = 0;

    // Score each keyword category
    for (const kw of CLAUDE_KEYWORDS) {
        if (lower.includes(kw)) claudeScore += 1;
    }
    for (const kw of GEMINI_KEYWORDS) {
        if (lower.includes(kw)) geminiScore += 1;
    }
    for (const kw of PIPELINE_KEYWORDS) {
        if (lower.includes(kw)) pipelineScore += 1;
    }

    const total = claudeScore + geminiScore + pipelineScore;

    // If no keywords matched, default to claude-solo (most common use case)
    if (total === 0) {
        return {
            mode: ROUTE_MODES.CLAUDE_SOLO,
            confidence: 0.5,
            reason: '키워드 미감지 → Claude 기본'
        };
    }

    // Pipeline: both gemini + pipeline keywords together → needs design + execution
    if (pipelineScore > 0 && geminiScore > 0) {
        return {
            mode: ROUTE_MODES.PIPELINE,
            confidence: Math.min(0.9, (pipelineScore + geminiScore) / total),
            reason: '설계+구현 복합 작업'
        };
    }

    // Pure design/planning → gemini-solo (only if no claude keywords dominate)
    if (geminiScore > claudeScore && geminiScore > pipelineScore) {
        const confidence = geminiScore / total;
        if (confidence >= 0.5) {
            return {
                mode: ROUTE_MODES.GEMINI_SOLO,
                confidence,
                reason: '디자인/기획 중심'
            };
        }
    }

    // Dev/backend keywords present → claude-solo
    // Even if pipeline keywords also match, prefer claude if claude score is equal or higher
    if (claudeScore > 0 && claudeScore >= pipelineScore) {
        return {
            mode: ROUTE_MODES.CLAUDE_SOLO,
            confidence: Math.min(0.95, claudeScore / total),
            reason: '개발/실행 중심'
        };
    }

    // Pipeline keywords dominant (no claude keywords)
    if (pipelineScore > claudeScore && pipelineScore >= geminiScore) {
        return {
            mode: ROUTE_MODES.PIPELINE,
            confidence: Math.min(0.8, pipelineScore / total),
            reason: '새 기능/페이지 생성'
        };
    }

    // Mixed signals → pipeline (uses both AIs for safety)
    if (geminiScore > 0 && claudeScore > 0) {
        return {
            mode: ROUTE_MODES.PIPELINE,
            confidence: 0.6,
            reason: '설계+개발 혼합'
        };
    }

    // Fallback: if only pipeline keywords → pipeline
    if (pipelineScore > 0) {
        return {
            mode: ROUTE_MODES.PIPELINE,
            confidence: 0.5,
            reason: '분류 불확실 → 파이프라인'
        };
    }

    return {
        mode: ROUTE_MODES.CLAUDE_SOLO,
        confidence: 0.5,
        reason: '기본값 → Claude'
    };
}

/**
 * Build an execution prompt for Claude from Gemini's design output.
 * @param {string} originalTask - The user's original request
 * @param {string} geminiDesign - Gemini's design/planning output
 * @returns {string} - Prompt for Claude CLI terminal execution
 */
function buildExecutionPrompt(originalTask, geminiDesign) {
    return `다음은 사용자의 요청과 Gemini(디자이너)가 작성한 기획/설계입니다.
이 설계를 바탕으로 실제 코드를 구현하세요.

## 사용자 원본 요청
${originalTask}

## Gemini 설계/기획
${geminiDesign}

## 실행 지시사항
1. 위 설계를 기반으로 모든 파일을 생성/수정하세요.
2. 파일 경로, 디렉토리 구조를 설계에 맞게 구성하세요.
3. CSS/스타일은 설계에 명시된 대로 구현하세요.
4. 구현 후 빌드/문법 에러가 없는지 확인하세요.
5. 설계에서 명시하지 않은 세부사항은 best practice에 따라 구현하세요.`;
}

module.exports = {
    classifyTask,
    buildExecutionPrompt,
    ROUTE_MODES
};
