// 暗物质反应堆模拟器 - 纯TCP WebSocket服务器（无HTTP）
const net = require('net');
const crypto = require('crypto');

const PORT = 8787;
const HOST = '0.0.0.0';

// 房间管理
const rooms = new Map();
const clients = new Map();
let clientIdCounter = 0;

// 生成唯一客户端ID
function generateId() {
  return 'c' + (++clientIdCounter) + '_' + Date.now().toString(36);
}

// WebSocket帧解析
function parseFrame(data) {
  const frames = [];
  
  while (data.length >= 2) {
    const FIN = (data[0] >> 7) & 1;
    const RSV = (data[0] >> 4) & 7;
    const opcode = data[0] & 0xF;
    const MASK = (data[1] >> 7) & 1;
    const PAYLOAD_LEN = data[1] & 0x7F;
    
    if (RSV !== 0) {
      return frames; // 错误帧，停止解析
    }
    
    let byteOffset = 2;
    let payloadLen = PAYLOAD_LEN;
    
    if (PAYLOAD_LEN === 126) {
      if (data.length < 4) break;
      payloadLen = data.readUInt16BE(2);
      byteOffset = 4;
    } else if (PAYLOAD_LEN === 127) {
      if (data.length < 10) break;
      payloadLen = data.readUInt32BE(4);
      byteOffset = 10;
    }
    
    let mask = null;
    if (MASK) {
      if (data.length < byteOffset + 4) break;
      mask = data.slice(byteOffset, byteOffset + 4);
      byteOffset += 4;
    }
    
    if (data.length < byteOffset + payloadLen) break;
    
    const payload = data.slice(byteOffset, byteOffset + payloadLen);
    data = data.slice(byteOffset + payloadLen);
    
    if (MASK && payload.length > 0) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }
    
    frames.push({ FIN, RSV, opcode, MASK, payloadLen, payload });
  }
  
  return frames;
}

// 创建WebSocket帧（服务器→客户端，不需要mask）
function createFrame(text) {
  const encoded = Buffer.from(text);
  
  let header;
  if (encoded.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = encoded.length;
  } else if (encoded.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(encoded.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(encoded.length / 0x100000000), 2);
    header.writeUInt32BE(encoded.length % 0x100000000, 6);
  }
  
  return Buffer.concat([header, encoded]);
}

// 发送JSON消息
function sendJSON(ws, data) {
  if (!ws || !ws.ready) return;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  try {
    ws.socket.write(createFrame(text));
  } catch (e) {
    console.log('[-] 发送失败:', e.message);
  }
}

// 处理客户端连接
function handleClient(socket) {
  const clientId = generateId();
  let buffer = Buffer.alloc(0);
  
  console.log(`[连接] 新客户端: ${clientId}`);
  
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    
    // 检查是否是WebSocket升级请求
    if (!wsUpgrade[clientId] && buffer.length > 0) {
      const str = buffer.toString('utf8', 0, Math.min(200, buffer.length));
      if (str.includes('Upgrade: websocket')) {
        const keyMatch = str.match(/Sec-WebSocket-Key:\s*(.+)/i);
        if (keyMatch) {
          const key = keyMatch[1].trim();
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
          wsUpgrade[clientId] = true;
          clients.set(clientId, {
            socket: socket,
            clientId: clientId,
            room: null,
            slot: -1,
            name: '玩家' + clientId.slice(0, 4),
            ready: true
          });
          console.log(`[协议] ${clientId} WebSocket升级成功`);
        }
        return;
      }
    }
    
    // 解析WebSocket帧
    if (wsUpgrade[clientId]) {
      const frames = parseFrame(buffer);
      if (frames.length === 0) return;
      buffer = Buffer.alloc(0);
      
      for (const frame of frames) {
        if (frame.opcode === 1 || frame.opcode === 2) {
          try {
            const msg = JSON.parse(frame.payload.toString());
            processMessage(clientId, msg);
          } catch (e) {
            console.log('[-] 消息解析失败:', e.message);
          }
        }
      }
    }
  });
  
  socket.on('close', () => {
    console.log(`[断开] ${clientId}`);
    if (wsUpgrade[clientId]) {
      handleDisconnect(clientId);
    }
    if (clients.has(clientId)) {
      clients.delete(clientId);
    }
    wsUpgrade[clientId] = false;
  });
  
  socket.on('error', (err) => {
    console.log('[-] 连接错误:', err.message);
  });
}

const wsUpgrade = {};

// 处理消息
function processMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const roomName = msg.room;
  
  switch (msg.type) {
    case 'join':
      handleJoinRoom(clientId, msg);
      break;
    case 'hello':
      handleHello(clientId, msg);
      break;
    case 'action':
    case 'chat':
      forwardMessage(clientId, msg);
      break;
    case 'bye':
      handleDisconnect(clientId);
      break;
    default:
      console.log(`[消息] 未知类型: ${msg.type}`);
  }
}

function handleJoinRoom(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  
  const roomName = msg.room;
  if (!roomName) {
    sendJSON(client, { type: 'reject', why: '房间号不能为空' });
    return;
  }
  
  let room = rooms.get(roomName);
  if (!room) {
    // 创建房间
    room = {
      name: roomName,
      host: clientId,
      clients: new Map(),
      createdAt: Date.now()
    };
    rooms.set(roomName, room);
    console.log(`[房间] ${roomName} 已创建，房主: ${client.name}`);
  }
  
  if (room.clients.size >= 4) {
    sendJSON(client, { type: 'reject', why: '房间已满' });
    return;
  }
  
  const slot = assignSlot(room);
  if (slot === -1) {
    sendJSON(client, { type: 'reject', why: '没有可用槽位' });
    return;
  }
  
  room.clients.set(clientId, true);
  client.room = roomName;
  client.slot = slot;
  client.name = msg.name || client.name;
  
  console.log(`[房间] ${roomName} 加入: ${client.name} (槽位 ${slot + 1})`);
  
  sendJSON(client, {
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
  
  const roomName = client.room;
  if (!roomName) {
    // 还没创建房间，尝试加入
    handleJoinRoom(clientId, { room: msg.room, name: msg.name });
    return;
  }
  
  const room = rooms.get(roomName);
  if (!room) {
    sendJSON(client, { type: 'reject', why: '房间不存在' });
    return;
  }
  
  // 发送当前房间状态
  sendJSON(client, {
    type: 'welcome',
    room: roomName,
    slot: client.slot,
    players: buildPlayerList(room)
  });
}

function forwardMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const room = rooms.get(client.room);
  if (!room) return;
  
  // 转发给房间内所有其他客户端
  room.clients.forEach((_, peerId) => {
    if (peerId !== clientId) {
      const peer = clients.get(peerId);
      if (peer && peer.ready) {
        sendJSON(peer, msg);
      }
    }
  });
}

function broadcastToRoom(roomName, msg, excludeId) {
  const room = rooms.get(roomName);
  if (!room) return;
  
  room.clients.forEach((_, peerId) => {
    if (peerId !== excludeId) {
      const peer = clients.get(peerId);
      if (peer && peer.ready) {
        sendJSON(peer, msg);
      }
    }
  });
}

function assignSlot(room) {
  for (let i = 0; i < 4; i++) {
    if (!room.clients.has('s' + i)) {
      room.clients.set('s' + i, true);
      return i;
    }
  }
  return -1;
}

function buildPlayerList(room) {
  const players = {};
  const colors = ['#7c5cfc', '#34d399', '#f59e0b', '#ec4899'];
  
  room.clients.forEach((_, slotId) => {
    // 这里简化处理，实际需要存储玩家详细信息
  });
  
  return players;
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;
  
  const room = rooms.get(client.room);
  if (room) {
    room.clients.delete(clientId);
    
    // 如果房主断开，销毁房间
    if (room.host === clientId) {
      console.log(`[房间] ${room.name} 房主断开，销毁房间`);
      rooms.delete(room.name);
      
      // 通知其他玩家
      room.clients.forEach((_, peerId) => {
        const peer = clients.get(peerId);
        if (peer && peer.ready) {
          sendJSON(peer, { type: 'hostbye' });
        }
      });
    } else {
      console.log(`[房间] ${room.name} 玩家断开: ${client.name}`);
      
      // 通知其他玩家
      broadcastToRoom(room.name, {
        type: 'player_left',
        clientId: clientId,
        name: client.name
      }, clientId);
    }
    
    // 清理空房间
    if (room.clients.size === 0) {
      rooms.delete(room.name);
    }
  }
  
  client.room = null;
  client.slot = -1;
}

// 启动纯TCP服务器
const server = net.createServer(handleClient);

server.listen(PORT, HOST, () => {
  console.log('\n========================================');
  console.log('  暗物质反应堆模拟器 - 纯TCP服务器');
  console.log('========================================');
  console.log('  监听端口:', PORT);
  console.log('  监听地址:', HOST);
  console.log('  连接地址: ws://124.248.69.26:16738');
  console.log('  无HTTP服务，只处理WebSocket');
  console.log('========================================\n');
});

server.on('error', (err) => {
  console.log('[-] 服务器错误:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.log('  端口被占用，请先关闭其他服务器');
  }
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[关闭] 服务器正在停止...');
  server.close(() => {
    process.exit(0);
  });
});
