# Auto-Teminel Browser Control Extension

CDP 기반 브라우저 자동화 Chrome 익스텐션

## 로드 방법

1. `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** ON
3. **압축 해제된 확장 프로그램 로드** 클릭
4. `chrome-extension/` 폴더 선택

## 지원 명령 (WebSocket)

외부 서버에서 `ws://localhost:9999` 로 연결하면 JSON 명령 전송 가능:

```json
{ "id": 1, "type": "attach" }              // 현재 탭에 CDP 연결
{ "id": 2, "type": "screenshot" }          // 스크린샷 (base64 PNG)
{ "id": 3, "type": "navigate", "url": "https://..." }
{ "id": 4, "type": "execute", "script": "document.title" }
{ "id": 5, "type": "click", "selector": "#btn" }
{ "id": 6, "type": "type", "selector": "input", "text": "hello" }
{ "id": 7, "type": "scroll", "x": 0, "y": 500 }
{ "id": 8, "type": "getHTML" }
{ "id": 9, "type": "getURL" }
{ "id": 10, "type": "waitSelector", "selector": ".loaded", "timeout": 10000 }
{ "id": 11, "type": "detach" }
```

## 테스트 서버

```bash
node chrome-extension/test-server.js
```

## auto-teminel 연동

`main.js`에서 WebSocket 서버(포트 9999)를 열고 익스텐션으로 명령 전달하면 됨.
