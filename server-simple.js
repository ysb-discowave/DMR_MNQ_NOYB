// 暗物质反应堆模拟器 - 简易 WebSocket 服务器（纯 Node.js，无外部依赖）

const http = require('http');
const crypto = require('crypto');
const url = require('url');

// 配置
const PORT = process.env.PORT || 8787;

// 房间管理
const rooms = new Map();

// 客户端管理
const clients = new Map();

// WebSocket 升级处理
function handleUpgrade(req, socket, head) {
  const headers = req.headers;
  const key = headers['sec-websocket-key'];
  
  if (!key) {
    socket.destroy();
    return;
  }
  
  const hash = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB5DC8500B')
    .digest('base64');
  
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + hash,
    '',
    ''
  ].join('\r\n');
  
  socket.write(response);
  
  const ws = {
    socket: socket,
    data: Buffer.alloc(0),
    mask: null,
    frame: null,
    clientId: null,
    ready: true
  };
  
  socket.on('data', (chunk) => {
    ws.data = Buffer.concat([ws.data, chunk]);
    
    while (ws.data.length >= 2) {
      if (!ws.frame || ws.frame.length === undefined) {
        if (ws.data.length < 2) break;
        
        const FIN = (ws.data[0] >> 7) & 1;
        const RSV = (ws.data[0] >> 4) & 7;
        const opcode = ws.data[0] & 0xF;
        const MASK = (ws.data[1] >> 7) & 1;
        const PAYLOAD_LEN = ws.data[1] & 0x7F;
        
        if (RSV !== 0) {
          socket.destroy();
          return;
        }
        
        let byteOffset = 2;
        let payloadLen = PAYLOAD_LEN;
        
        if (PAYLOAD_LEN === 126) {
          if (ws.data.length < 4) break;
          payloadLen = ws.data.readUInt16BE(2);
          byteOffset = 4;
        } else if (PAYLOAD_LEN === 127) {
          if (ws.data.length < 10) break;
          payloadLen = ws.data.readUInt32BE(4);
          byteOffset = 10;
        }
        
        let mask = null;
        if (MASK) {
          if (ws.data.length < byteOffset + 4) break;
          mask = ws.data.slice(byteOffset, byteOffset + 4);
          byteOffset += 4;
        }
        
        if (ws.data.length < byteOffset + payloadLen) break;
        
        const payload = ws.data.slice(byteOffset, byteOffset + payloadLen);
        ws.data = ws.data.slice(byteOffset + payloadLen);
        
        if (MASK) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }
        
        handleMessage(ws, payload, opcode);
      }
    }
  });
  
  socket.on('close', () => {
    ws.ready = false;
    if (ws.clientId) handleDisconnect(ws.clientId);
  });
  
  return ws;
}

function handleMessage(ws, payload, opcode) {
  if (opcode === 1 || opcode === 2) {
    try {
      const msg = JSON.parse(payload.toString());
      processMessage(ws.clientId, msg);
    } catch (e) {
      console.log('[-] 消息解析失败:', e.message);
    }
  }
}

function sendWS(ws, data) {
  if (!ws || !ws.ready) return;
  
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const encoded = Buffer.from(text);
  
  let header = Buffer.alloc(2);
  header[0] = 0x81; // FIN + text opcode
  header[1] = encoded.length < 126 ? encoded.length : 126;
  
  let fullFrame;
  if (encoded.length < 126) {
    fullFrame = Buffer.concat([header, encoded]);
  } else {
    const extHeader = Buffer.alloc(4);
    extHeader[0] = 0x81;
    extHeader[1] = 126;
    extHeader.writeUInt16BE(encoded.length, 2);
    fullFrame = Buffer.concat([Buffer.from([extHeader[0], extHeader[1]]), encoded]);
  }
  
  try {
    ws.socket.write(fullFrame);
  } catch (e) {
    console.log('[-] 发送失败:', e.message);
  }
}

function processMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const { type } = msg;
  
  switch (type) {
    case 'create':
      handleCreateRoom(clientId, msg);
      break;
    case 'join':
      handleJoinRoom(clientId, msg);
      break;
    case 'hello':
      handleHello(clientId, msg);
      break;
    case 'message':
    case 'snapshot':
      handleMessageForward(clientId, msg);
      break;
    case 'ping':
      sendWS(client, { type: 'pong', timestamp: Date.now() });
      if (client) client.lastPing = Date.now();
      break;
    case 'bye':
      handleDisconnect(clientId);
      break;
    default:
      handleMessageForward(clientId, msg);
  }
}

function handleCreateRoom(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const roomName = msg.room || generateRoomCode();
  
  if (rooms.has(roomName)) {
    sendWS(client, {
      type: 'reject',
      room: roomName,
      why: '房间已存在'
    });
    return;
  }
  
  rooms.set(roomName, {
    name: roomName,
    host: clientId,
    clients: new Map(),
    createdAt: Date.now()
  });
  
  const room = rooms.get(roomName);
  room.clients.set(clientId, true);
  client.room = roomName;
  client.slot = 0;
  client.name = msg.name || client.name;
  
  console.log(`[房间] ${roomName} 已创建，房主: ${client.name}`);
  
  sendWS(client, {
    type: 'welcome',
    room: roomName,
    slot: 0,
    players: buildPlayerList(room)
  });
  
  broadcastToRoom(roomName, {
    type: 'player_joined',
    clientId: clientId,
    name: client.name,
    slot: 0
  }, clientId);
}

function handleJoinRoom(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const roomName = msg.room;
  if (!roomName) {
    sendWS(client, { type: 'reject', why: '房间号不能为空' });
    return;
  }
  
  const room = rooms.get(roomName);
  if (!room) {
    sendWS(client, { type: 'reject', why: '房间不存在' });
    return;
  }
  
  if (room.clients.size >= 4) {
    sendWS(client, { type: 'reject', why: '房间已满' });
    return;
  }
  
  const slot = assignSlot(room);
  if (slot === -1) {
    sendWS(client, { type: 'reject', why: '没有可用槽位' });
    return;
  }
  
  room.clients.set(clientId, true);
  client.room = roomName;
  client.slot = slot;
  client.name = msg.name || client.name;
  
  console.log(`[房间] ${roomName} 加入: ${client.name} (槽位 ${slot + 1})`);
  
  sendWS(client, {
    type: 'welcome',
    room: roomName,
    slot: slot,
    players: buildPlayerList(room)
  });
  
  broadcastToRoom(roomName, {
    type: 'player_joined',
    clientId: clientId,
    name: client.name,
    slot: slot
  }, clientId);
}

function handleHello(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const roomName = msg.room;
  const room = rooms.get(roomName);
  
  if (!room) {
    sendWS(client, { type: 'reject', why: '房间不存在或未创建' });
    return;
  }
  
  if (room.clients.size < 4 && !room.clients.has(clientId)) {
    handleJoinRoom(clientId, { room: roomName, name: msg.name });
  }
}

function handleMessageForward(clientId, msg) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const room = rooms.get(client.room);
  if (!room) return;
  
  broadcastToRoom(client.room, msg, clientId);
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  
  console.log(`[-] 客户端断开: ${client.name} (${clientId})`);
  
  if (client.room && rooms.has(client.room)) {
    const room = rooms.get(client.room);
    room.clients.delete(clientId);
    
    if (room.host === clientId) {
      console.log(`[房间] ${client.room} 房主离开，解散房间`);
      broadcastToRoom(client.room, {
        type: 'room_disbanded',
        reason: '房主离开'
      });
      rooms.delete(client.room);
    } else {
      broadcastToRoom(client.room, {
        type: 'player_left',
        clientId: clientId,
        name: client.name
      });
      reassignSlots(room);
    }
  }
  
  clients.delete(clientId);
}

function broadcastToRoom(roomName, msg, excludeId) {
  const room = rooms.get(roomName);
  if (!room) return;
  
  const data = JSON.stringify(msg);
  
  for (const [clientId] of room.clients) {
    if (clientId === excludeId) continue;
    
    const client = clients.get(clientId);
    if (client) {
      sendWS(client, data);
    }
  }
}

function buildPlayerList(room) {
  const players = {};
  for (const [clientId] of room.clients) {
    const client = clients.get(clientId);
    if (client) {
      players[clientId] = {
        id: clientId,
        name: client.name,
        slot: client.slot,
        host: clientId === room.host,
        connectedAt: client.connectedAt
      };
    }
  }
  return players;
}

function assignSlot(room) {
  const assigned = new Set();
  for (const [clientId] of room.clients) {
    const client = clients.get(clientId);
    if (client && client.slot >= 0) {
      assigned.add(client.slot);
    }
  }
  
  for (let i = 0; i < 4; i++) {
    if (!assigned.has(i)) return i;
  }
  return -1;
}

function reassignSlots(room) {
  let slot = 0;
  for (const [clientId] of room.clients) {
    const client = clients.get(clientId);
    if (client) {
      client.slot = slot;
      slot++;
    }
  }
}

function generateId() {
  return 'client_' + Math.random().toString(36).substr(2, 9);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  if (parsedUrl.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, clients: clients.size }));
  } else if (parsedUrl.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const roomList = [];
    for (const [room, data] of rooms) {
      roomList.push({ room, players: Object.keys(data.clients).length, maxPlayers: 4 });
    }
    res.end(JSON.stringify({ rooms: roomList }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket 升级
server.on('upgrade', (req, socket, head) => {
  const ws = handleUpgrade(req, socket, head);
  if (ws) {
    const clientId = generateId();
    ws.clientId = clientId;
    
    clients.set(clientId, {
      ws: ws,
      id: clientId,
      room: null,
      name: 'Unknown',
      slot: -1,
      connectedAt: Date.now(),
      lastPing: Date.now()
    });
    
    console.log(`[+] 客户端连接: ${clientId}`);
    
    sendWS(ws, JSON.stringify({
      type: 'connected',
      id: clientId,
      timestamp: Date.now()
    }));
  }
});

// 启动服务器 - 监听所有网卡 (0.0.0.0)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  暗物质反应堆模拟器 - 联机服务器`);
  console.log(`========================================`);
  console.log(`  监听端口: ${PORT}`);
  console.log(`  本地地址:   localhost:${PORT}`);
  console.log(`  局域网地址: 192.168.1.229:${PORT}`);
  console.log(`  纯 Node.js，无需安装依赖`);
  console.log(`========================================\n`);
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[关闭] 服务器正在停止...');
  server.close(() => {
    process.exit(0);
  });
});
