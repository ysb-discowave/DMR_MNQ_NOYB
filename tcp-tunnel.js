// 简易 TCP 穿透服务 - 使用本地 HTTP 服务暴露 WebSocket
const http = require('http');
const url = require('url');

const PORT = 8787;
const WS_PORT = 8788;

console.log(`\n========================================`);
console.log(`  TCP 穿透服务已启动`);
console.log(`  局域网地址: ws://192.168.1.229:${WS_PORT}`);
console.log(`  本地测试:   ws://127.0.0.1:${WS_PORT}`);
console.log(`========================================\n`);

// 启动 relay 服务器
require('./server-simple.js');

// 启动 HTTP 健康检查
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: WS_PORT }));
  } else if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <h2>TCP 穿透服务运行中</h2>
      <p>WebSocket 端口: <strong>${WS_PORT}</strong></p>
      <p>局域网地址: <code>ws://192.168.1.229:${WS_PORT}</code></p>
      <p>请在防火墙中放行 TCP 端口 <strong>${WS_PORT}</strong></p>
    `);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HTTP 健康检查: http://127.0.0.1:${PORT}\n`);
});
