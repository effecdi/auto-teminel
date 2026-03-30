// Project Context — Tech stack detection + source code reading
const fs = require('fs');
const path = require('path');

// ===================================================================
//  Operation Types & Configs
// ===================================================================

const OPERATIONS = [
    { type: 'development',     icon: '💻', label: '개발',         systemPromptPrefix: '이 프로젝트에 새로운 기능을 개발합니다. 프로젝트 구조를 분석하고, 파일 경로와 함께 완성된 코드를 직접 작성하세요.' },
    { type: 'management',      icon: '📋', label: '관리',         systemPromptPrefix: '이 프로젝트의 의존성, 설정, 환경을 점검합니다. 문제 발견 시 수정된 설정 파일 코드를 직접 제공하세요.' },
    { type: 'modification',    icon: '🔧', label: '수정',         systemPromptPrefix: '이 프로젝트의 버그를 수정합니다. 문제 원인을 짧게 설명하고, 수정된 코드를 파일 경로와 함께 즉시 제공하세요.' },
    { type: 'verification',    icon: '✅', label: '검증',         systemPromptPrefix: '이 프로젝트의 코드를 리뷰합니다. 발견된 문제마다 파일:라인 위치와 수정 코드를 제공하세요.' },
    { type: 'enhancement',     icon: '🚀', label: '고도화',       systemPromptPrefix: '이 프로젝트를 리팩토링합니다. 최적화된 코드를 파일 경로와 함께 직접 작성하세요.' },
    { type: 'redevelopment',   icon: '🏗️', label: '재개발',       systemPromptPrefix: '이 프로젝트의 아키텍처를 재설계합니다. 새 구조의 파일 레이아웃과 핵심 코드를 직접 작성하세요.' },
    { type: 'design-change',   icon: '🎨', label: '디자인변경',   systemPromptPrefix: '이 프로젝트의 UI/UX를 개편합니다. 수정할 컴포넌트의 JSX/CSS 코드를 파일 경로와 함께 직접 작성하세요.' },
    { type: 'security-audit',  icon: '🔒', label: '보안검증',     systemPromptPrefix: '이 프로젝트의 보안 취약점을 점검합니다. OWASP Top 10 기반으로 발견된 취약점마다 수정 코드를 제공하세요.' },
    { type: 'security-stack',  icon: '🛡️', label: '보안스택검증', systemPromptPrefix: '이 프로젝트의 의존성 보안을 검증합니다. 취약한 패키지를 식별하고 대체 방안 코드를 직접 제공하세요.' },
    { type: 'automation',      icon: '⚙️', label: '자동화',       systemPromptPrefix: '이 프로젝트의 자동화를 구축합니다. GitHub Actions, Dockerfile, 테스트 설정 등의 파일을 직접 작성하세요.' },
];

function getOperationConfig(type) {
    return OPERATIONS.find(op => op.type === type) || OPERATIONS[0];
}

function getOperationsList() {
    return OPERATIONS.map(op => ({ type: op.type, icon: op.icon, label: op.label }));
}

// ===================================================================
//  Tech Stack Detection
// ===================================================================

function detectTechStack(projectPath) {
    const stack = [];
    const exists = (file) => fs.existsSync(path.join(projectPath, file));

    if (exists('package.json')) {
        stack.push('Node.js');
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (allDeps['react']) stack.push('React');
            if (allDeps['next']) stack.push('Next.js');
            if (allDeps['vue']) stack.push('Vue');
            if (allDeps['@angular/core']) stack.push('Angular');
            if (allDeps['svelte']) stack.push('Svelte');
            if (allDeps['express']) stack.push('Express');
            if (allDeps['typescript']) stack.push('TypeScript');
            if (allDeps['tailwindcss']) stack.push('Tailwind CSS');
            if (allDeps['electron']) stack.push('Electron');
        } catch (_) {}
    }

    if (exists('requirements.txt') || exists('pyproject.toml')) stack.push('Python');
    if (exists('go.mod')) stack.push('Go');
    if (exists('Cargo.toml')) stack.push('Rust');
    if (exists('pom.xml') || exists('build.gradle')) stack.push('Java');
    if (exists('Dockerfile') || exists('docker-compose.yml')) stack.push('Docker');

    return [...new Set(stack)];
}

// ===================================================================
//  Directory Tree
// ===================================================================

function readTree(dir, depth, prefix) {
    prefix = prefix || '';
    if (depth <= 0) return [];

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }

    const lines = [];
    const filtered = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist');

    for (const entry of filtered) {
        const isDir = entry.isDirectory();
        lines.push(`${prefix}${isDir ? '📁 ' : '📄 '}${entry.name}`);
        if (isDir) {
            lines.push(...readTree(path.join(dir, entry.name), depth - 1, prefix + '  '));
        }
    }
    return lines;
}

// ===================================================================
//  Source File Reading
// ===================================================================

const SOURCE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
    '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.toml',
    '.py', '.go', '.rs', '.java',
    '.html', '.md',
]);

const SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', '.next', '.git', '.cache',
    '__pycache__', '.venv', 'venv', 'coverage', '.turbo',
]);

const MAX_FILE_SIZE = 80 * 1024;
const MAX_TOTAL_CONTEXT = 300 * 1024;

function collectSourceFiles(dir, depth) {
    depth = depth === undefined ? 4 : depth;
    if (depth <= 0) return [];

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }

    const files = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            files.push(...collectSourceFiles(fullPath, depth - 1));
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (SOURCE_EXTS.has(ext)) files.push(fullPath);
        }
    }
    return files;
}

function readSourceFiles(projectPath) {
    const allFiles = collectSourceFiles(projectPath);

    function priority(filePath) {
        const rel = path.relative(projectPath, filePath).toLowerCase();
        if (rel === 'package.json' || rel === 'tsconfig.json') return 0;
        if (rel.includes('tailwind') || rel.includes('vite.config') || rel.includes('next.config')) return 1;
        if (rel.includes('/pages/') || rel.includes('/app/') || rel.includes('/routes/')) return 2;
        if (rel.includes('layout') || rel.includes('index.css') || rel.includes('globals')) return 3;
        if (rel.includes('/components/')) return 4;
        if (rel.includes('/hooks/') || rel.includes('/lib/') || rel.includes('/utils/')) return 5;
        if (rel.includes('/api/') || rel.includes('server')) return 6;
        return 7;
    }

    allFiles.sort((a, b) => {
        const pa = priority(a);
        const pb = priority(b);
        if (pa !== pb) return pa - pb;
        return a.localeCompare(b);
    });

    const parts = [];
    let totalSize = 0;

    for (const filePath of allFiles) {
        if (totalSize >= MAX_TOTAL_CONTEXT) break;
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            const relPath = path.relative(projectPath, filePath);
            parts.push(`### 파일: ${relPath}`);
            parts.push('```');
            parts.push(content.trim());
            parts.push('```');
            parts.push('');
            totalSize += stat.size;
        } catch (_) {}
    }

    return parts.join('\n');
}

function readReadme(projectPath) {
    for (const name of ['README.md', 'readme.md', 'README.txt']) {
        const filepath = path.join(projectPath, name);
        if (fs.existsSync(filepath)) {
            const content = fs.readFileSync(filepath, 'utf-8');
            return content.split('\n').slice(0, 20).join('\n'); // 50→20줄: 토큰 절약
        }
    }
    return null;
}

// ===================================================================
//  Build Full Project Context
// ===================================================================

/**
 * Build project context.
 * @param {string} projectPath
 * @param {string} projectName
 * @param {string} operationType
 * @param {object} opts - { includeSource: boolean } — default false (light mode, saves tokens)
 */
function buildProjectContext(projectPath, projectName, operationType, opts) {
    const includeSource = opts && opts.includeSource;
    const opConfig = getOperationConfig(operationType);
    const techStack = detectTechStack(projectPath);
    const tree = readTree(projectPath, 2); // depth 2 for lighter output
    const readme = readReadme(projectPath);

    const parts = [
        `## 프로젝트 정보`,
        `- 이름: ${projectName}`,
        `- 경로: ${projectPath}`,
        `- 기술 스택: ${techStack.join(', ') || '감지 안됨'}`,
        '',
        `## 현재 작업: ${opConfig.icon} ${opConfig.label}`,
        opConfig.systemPromptPrefix,
        '',
    ];

    if (tree.length > 0) {
        parts.push('## 프로젝트 구조');
        parts.push('```');
        parts.push(...tree.slice(0, 50)); // 80→50: 토큰 절약
        parts.push('```');
        parts.push('');
    }

    if (readme) {
        parts.push('## README (요약)');
        parts.push(readme.split('\n').slice(0, 20).join('\n'));
        parts.push('');
    }

    if (includeSource) {
        parts.push(`**중요: 아래에 이 프로젝트의 실제 소스 코드가 포함되어 있습니다. 반드시 기존 코드를 기반으로 수정/개선하세요.**`);
        parts.push('');
        const sourceContext = readSourceFiles(projectPath);
        if (sourceContext) {
            parts.push('## 소스 코드');
            parts.push(sourceContext);
        }
    }

    return parts.join('\n');
}

/**
 * Build full context with source code (heavy mode).
 */
function buildProjectContextFull(projectPath, projectName, operationType) {
    return buildProjectContext(projectPath, projectName, operationType, { includeSource: true });
}

module.exports = {
    detectTechStack,
    buildProjectContext,
    buildProjectContextFull,
    getOperationConfig,
    getOperationsList,
    OPERATIONS
};
