# Claude CLI Terminal

**멀티 프로젝트 Claude CLI 터미널** — 시스템에 설치된 `claude` 명령어를 Electron 터미널 에뮬레이터로 구동합니다.

## 사전 요구 사항

- **Node.js** 18+
- **Claude CLI** 가 시스템에 설치되어 있어야 합니다:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **C++ 빌드 도구** (`node-pty` 네이티브 모듈 빌드에 필요)
  - macOS: `xcode-select --install`
  - Ubuntu/Debian: `sudo apt install build-essential python3`
  - Windows: `npm install -g windows-build-tools`

## Quick Start

```bash
# 의존성 설치 (node-pty 네이티브 빌드 포함)
npm install

# 실행
npm start

# 개발 모드 (DevTools 포함)
npm run dev
```

> `npm install` 시 `postinstall` 스크립트가 `electron-rebuild`로 `node-pty`를 자동 빌드합니다.
> 빌드 실패 시 `npm run rebuild`를 수동 실행하세요.

## 사용법

### 1. 프로젝트 추가

1. 좌측 패널의 **+** 버튼 클릭
2. 프로젝트 이름 입력
3. **Select Folder**로 프로젝트 경로 선택
4. (선택) Claude CLI 추가 인자 입력 (예: `--auto-approve`)
5. **Add** 클릭

### 2. 터미널 사용

- 좌측에서 프로젝트를 클릭하면 해당 디렉토리에서 셸이 열리고 `claude` 명령이 자동 실행됩니다.
- 터미널은 완전한 PTY이므로 모든 키 입력이 그대로 전달됩니다.
- 우측 패널의 **Quick Commands**로 자주 쓰는 명령을 빠르게 실행할 수 있습니다.

### 3. 터미널 제어

| 버튼 | 기능 |
|------|------|
| 🔄 Restart | 현재 PTY를 종료하고 같은 프로젝트로 재시작 |
| ⏹ Kill | PTY 프로세스 강제 종료 |
| 🧹 Clear | 터미널 화면 클리어 |

### 4. 설정 (⚙️)

- **Default Claude CLI Args**: 모든 새 세션에 적용되는 기본 인자
- **Shell Path**: 사용할 셸 경로 (비워두면 시스템 기본값)
- **Font Size**: 터미널 폰트 크기

## 아키텍처

```
┌──────────────────────────────────────────────────┐
│                  Electron App                     │
│                                                   │
│  ┌─────────────┐    IPC     ┌──────────────────┐ │
│  │  renderer    │ ◄────────► │    main.js       │ │
│  │  (xterm.js)  │           │    (node-pty)     │ │
│  └─────────────┘            └──────────────────┘ │
│        │                           │              │
│        │  terminal.keystroke →     │              │
│        │  ← terminal.incomingData  │              │
│        │  terminal.resize →        │              │
│        │  ← terminal.exit          │              │
│        │                           │              │
│        ▼                           ▼              │
│   [xterm UI]                [PTY → bash → claude] │
└──────────────────────────────────────────────────┘
```

## IPC 채널

| 채널 | 방향 | 설명 |
|------|------|------|
| `terminal.spawn` | Renderer → Main | PTY 생성 (프로젝트 경로, cols/rows 전달) |
| `terminal.keystroke` | Renderer → Main | 사용자 키 입력을 PTY에 전달 |
| `terminal.resize` | Renderer → Main | 터미널 크기 변경 |
| `terminal.kill` | Renderer → Main | PTY 프로세스 종료 |
| `terminal.incomingData` | Main → Renderer | PTY 출력을 xterm에 전달 |
| `terminal.exit` | Main → Renderer | PTY 프로세스 종료 알림 |

## 파일 구조

```
├── main.js              # Electron 메인 프로세스 (node-pty 관리)
├── renderer-fixed.js    # 렌더러 (xterm.js 초기화 + IPC)
├── index.html           # 인터페이스 (터미널 컨테이너)
├── styles.css           # 스타일링
├── package.json         # 의존성 + 빌드 설정
└── README.md
```

## 트러블슈팅

### `node-pty` 빌드 실패
```bash
# electron-rebuild로 재빌드
npm run rebuild

# 또는 직접 실행
npx electron-rebuild -f -w node-pty
```

### `claude` 명령을 찾을 수 없음
```bash
# claude CLI 설치 확인
which claude        # macOS/Linux
where claude        # Windows

# 설치
npm install -g @anthropic-ai/claude-code
```

### 터미널이 깨져 보일 때
설정(⚙️)에서 Font Size를 조정하거나 🔄 Restart를 눌러보세요.

## 빌드

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```
