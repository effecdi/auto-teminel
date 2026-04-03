// ====================================================
// test-server.js — WebSocket 테스트 서버 (Node.js)
// 실행: node test-server.js
// 익스텐션이 ws://localhost:9999 로 연결해옴
// ====================================================

const { WebSocketServer } = require('ws');

const PORT = 9999;
const wss = new WebSocketServer({ port: PORT });

console.log(`WS 서버 시작: ws://localhost:${PORT}`);
console.log('익스텐션 팝업에서 "연결" 버튼 클릭하세요\n');

wss.on('connection', (socket) => {
  console.log('✅ 익스텐션 연결됨');

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log('← 받음:', JSON.stringify(msg).slice(0, 120));

    // hello 메시지 확인
    if (msg.type === 'hello') {
      console.log('  에이전트:', msg.agent, 'v' + msg.version);
      return;
    }

    // 스크린샷이면 파일로 저장
    if (msg.type === 'screenshot' && msg.data) {
      const fs = require('fs');
      const path = `screenshot-${Date.now()}.png`;
      fs.writeFileSync(path, Buffer.from(msg.data, 'base64'));
      console.log('  📸 저장됨:', path);
      return;
    }

    console.log('  결과:', JSON.stringify(msg).slice(0, 200));
  });

  socket.on('close', () => console.log('❌ 연결 끊김'));

  // 예시: 연결 직후 명령 보내기
  setTimeout(() => {
    console.log('→ attach 명령 전송');
    socket.send(JSON.stringify({ id: 1, type: 'attach' }));
  }, 500);

  setTimeout(() => {
    console.log('→ screenshot 명령 전송');
    socket.send(JSON.stringify({ id: 2, type: 'screenshot' }));
  }, 1500);

  setTimeout(() => {
    console.log('→ getURL 명령 전송');
    socket.send(JSON.stringify({ id: 3, type: 'getURL' }));
  }, 2500);
});
