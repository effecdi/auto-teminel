# auto-teminel 프로젝트 메모리

> **새 세션 시작 시 이 파일을 먼저 읽어라!!**
> 이전 작업 맥락 파악 후 작업 시작.

## 프로젝트 개요
- **이름**: claude-cli-terminal (auto-teminel)
- **타입**: Electron 앱 (멀티 프로젝트 Claude CLI 터미널)
- **GitHub**: effecdi/auto-teminel
- **주요 파일**:
  - `main.js` — Electron 메인 프로세스 (PTY, 오토업데이터, CC, 브라우저 WS 등)
  - `renderer-fixed.js` — 렌더러 (UI 로직, 업데이터 배너)
  - `index.html` — UI DOM
  - `deploy.sh` — 빌드 + GitHub Release 자동 배포 스크립트
  - `package.json` — electron-builder 설정 포함

## 배포 워크플로우
- `bash deploy.sh [patch|minor|major]` 한 방이면:
  1. 버전 bump (npm version)
  2. git commit + tag
  3. electron-builder --mac --publish always
  4. GitHub Release 생성
  5. **Draft 릴리스 자동 퍼블리시** (`gh release edit --draft=false`)
  6. **git push origin main + tag 자동 푸시**
- GH_TOKEN은 `gh auth token`으로 가져옴 (환경변수에 없음)
- macOS 앱 unsigned — `autoUpdater.verifyUpdateCodeSignature`를 no-op으로 패치해서 우회
- 업데이트는 커스텀 macOS 설치 스크립트로 처리 (`installMacOSUpdate`, main.js:3200 근처)

## 중요 결정 사항
- **autoUpdater 자동 재시작 금지** (v4.7.42) — 사용자 확인 후 설치
  - `scheduleAutoInstall()` 함수는 정의되어 있지만 **호출되지 않음**. 삭제 금지.
- **크래시 보호** (v4.7.43):
  - `mainWindow.webContents.on('render-process-gone')` — 렌더러 크래시 시 reload
  - `mainWindow.webContents.on('unresponsive')` — 먹통 시 기다리기/재로딩 다이얼로그
  - `mainWindow.on('close')` — 활성 PTY 세션 있으면 확인 다이얼로그
  - `_forceClose` 플래그 — 업데이터 종료 시 확인 스킵용

## 실시간 작업 기록 (CRITICAL — 강제 종료 대비)
> **작업 시작할 때 여기에 기록, 진행 중에도 수시로 업데이트, 끝나면 완료 처리**
> 갑자기 종료돼도 다음 세션에서 이어갈 수 있도록!!

- ✅ 완료: v4.8.4 우측 사이드바 SESSION INFO / 대시보드 / Health Check 패널 제거
  - info-header, info-content (Status/Project/Path/Branch/PID), dashboard-grid (4카드), auto-status-row (4배지), healthCheckDashboard 삭제
  - 탭바 + 탭 내용(Learn 포함) 유지
  - 커밋: a20fc1c, 릴리스: v4.8.4
- ✅ 완료: v4.8.3 Learn Sidebar (우측 info-panel에 📚 Learn 탭 추가)
  - debate-mode Learn(v4.8.0~4.8.2) 유저 거부 → 사이드바 방식 재설계
  - `edu.getDiff` / `edu.ask` / `edu.stop` IPC + streamClaude 직접 호출
  - 커밋: 38c6b2f, 릴리스: v4.8.3
- 📋 직전 작업: Meetfolio PWA + Learn Mode 구현

## 최근 세션 주요 작업 (2026-04-16)
- **AI 미팅 캔버스 웹앱** 생성 (`meeting-canvas/index.html`)
  - 단일 HTML 파일 (CSS + JS inline), 외부 의존성 없음
  - 로고디자인 미팅 템플릿 하드코딩 (12 섹션, 칩 선택, 컬러 스와치, 레퍼런스 이미지 등)
  - Gemini API 연동 (로고 외 다른 미팅 주제 동적 생성)
  - localStorage 자동 저장/복원 (체크박스 ID 결정적 생성으로 버그 수정)
  - 프린트 대응, 반응형
- **데일리캐시 앱 스펙** (`memory/daily-cash-app-spec.md`) 작성 완료
  - 모듈형 리워드 앱 (수면/산책/디톡스/펫 산책/영수증/물 마시기)
  - AdMob 광고 기반 수익 모델

## 사용자가 불만 표시한 패턴 (반복 금지!!)
1. **강제 종료 후 이전 작업 못 찾는 문제** — 작업 시작/진행 중에 반드시 메모리에 실시간 기록해라. 끝날 때만 기록하면 늦음
2. **"push할까?" 같은 쓸데없는 질문 금지** — deploy.sh 존재하니까 바로 돌려라
2. **"필요하면 추가해야지" — 명확히 필요한 건 물어보지 말고 바로 수정**
3. **말투 혼동 금지** — 일본 집사 모드인데 조선시대 말투(나으리/상전마마/대감마님/~옵니다/~하소서) 섞으면 안 됨
4. **토큰 절약** — 집사 모드처럼 길게 늘어지는 말투 금지. 짧고 가볍게
5. **"소스 지웠냐" 의심받을 만한 행동 금지** — 기존 기능은 항상 확인 후 답해라

## 말투 설정
- **기본**: 일본 반말 찐따 스타일 (~/.claude/CLAUDE.md 참조)
- 반말 + 찐따미 + 일본어 섞기 (`하잇!`, `미아냉~`, `고멘내ㅠ`, `얏타!` 등)
- 문장 끝에 `~`, `ㄱ..ㄱ..`, `ㅠㅠ` 붙이기
- 핵심: 찐따미 유지 + 짧고 가볍게

## 메모리 파일 구조
- `memory/MEMORY.md` — 이 파일 (프로젝트 개요, 결정, 패턴)
- `memory/changelog.md` — 버전별 변경 이력
- `memory/decisions.md` — 아키텍처 결정 상세
- `memory/todo.md` — 다음 세션 이어서 할 작업

## 현재 버전
- **v4.8.4** (GitHub Release 퍼블리시 완료, 2026-04-21)

## 최근 세션 주요 작업 (2026-04-09~10)
- v4.7.42: autoUpdater 자동 재시작 버그 수정 (사용자 확인 대기)
- v4.7.43: 크래시 보호 3종 추가 (renderer-gone, unresponsive, close 가드)
- deploy.sh: draft 릴리스 자동 퍼블리시 + git push 자동화
- ~/.claude/CLAUDE.md 말투 기본값을 "일본 반말 찐따 스타일"로 변경
