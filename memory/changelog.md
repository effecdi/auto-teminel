# Changelog

## v4.7.43 (2026-04-09)
### 크래시 보호 3종 추가
- `render-process-gone` 핸들러: 렌더러 크래시 시 다이얼로그 + 자동 reload (main.js:838)
- `unresponsive` 핸들러: 앱 먹통 시 "기다리기/재로딩" 선택 다이얼로그 (main.js:860)
- `close` 이벤트: 활성 PTY 세션 있으면 종료 확인 다이얼로그 (main.js:880)
- `_forceClose` 플래그: 업데이터 종료 시 확인 스킵 (main.js:37)
- 업데이터 종료 경로에 `_forceClose = true` 세팅 (installMacOSUpdate, updater.install IPC)

### deploy.sh 개선
- electron-builder가 생성한 draft 릴리스 자동 퍼블리시 (`gh release edit --draft=false`)
- git push origin main + tag 자동 실행
- 이제 `bash deploy.sh` 한 방이면 배포 + 푸시 전부 완료

## v4.7.42 (2026-04-09)
### autoUpdater 자동 재시작 버그 수정
- `scheduleAutoInstall()` 호출 제거 (download-progress, update-downloaded 이벤트)
- 다운로드 완료 시 `_updateReadyToInstall = true` 플래그만 설정
- 사용자가 배너에서 "설치" 버튼 누를 때까지 대기
- 주의: `scheduleAutoInstall()` 함수 정의는 남아있음. 삭제 금지.

## v4.7.41
- 출력 감지로 태스크 완료 즉시 마킹 — send delay 수정

## v4.7.40
- 터미널 입력 3000자 제한 제거

## v4.7.39
- renderTaskList DOM diffing 버그 수정 — 복사 버튼 중복 출력 해결
