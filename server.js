// 暗物质反应堆模拟器 - 多人联机服务器
// 支持内网穿透，无需外网IP即可开服

const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// 配置
const PORT = process.env.PORT || 8787;
const RELAY_SERVER = 'wss://relay.dmreactor.cn'; // 公共中继服务器（可替换）

// 房间管理
const rooms = new Map();

// 客户端管理
const clients = new Map();

// 创建 HTTP 服务器（用于健康检查和 NAT 打洞）
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  if (parsedUrl.pathname === '/ping') {
    // 心跳检测接口
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, clients: clients.size }));
  } else if (parsedUrl.pathname === '/info') {
    // 房间信息接口
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

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientId = generateId();
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

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(clientId, msg);
    } catch (e) {
      console.log(`[-] 消息解析失败:`, e.message);
    }
  });

  ws.on('close', () => {
    handleDisconnect(clientId);
  });

  ws.on('error', (err) => {
    console.log(`[-] 连接错误:`, err.message);
  });

  // 发送 welcome 确认
  ws.send(JSON.stringify({
    type: 'connected',
    id: clientId,
    timestamp: Date.now()
  }));
});

function handleMessage(clientId, msg) {
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
      handleMessageForward(clientId, msg);
      break;
    case 'snapshot':
      handleMessageForward(clientId, msg);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      client.lastPing = Date.now();
      break;
    case 'bye':
      handleDisconnect(clientId);
      break;
    default:
      // 转发所有其他消息
      handleMessageForward(clientId, msg);
  }
}

function handleCreateRoom(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;

  const roomName = msg.room || generateRoomCode();
  
  // 检查房间是否已存在
  if (rooms.has(roomName)) {
    ws.send(JSON.stringify({
      type: 'reject',
      room: roomName,
      why: '房间已存在'
    }));
    return;
  }

  // 创建房间
  rooms.set(roomName, {
    name: roomName,
    host: clientId,
    clients: new Map(),
    createdAt: Date.now()
  });

  // 加入房间
  const room = rooms.get(roomName);
  room.clients.set(clientId, true);
  client.room = roomName;
  client.slot = 0;
  client.name = msg.name || client.name;

  console.log(`[房间] ${roomName} 已创建，房主: ${client.name}`);

  // 发送成功确认
  ws.send(JSON.stringify({
    type: 'welcome',
    room: roomName,
    slot: 0,
    players: buildPlayerList(room)
  }));

  // 通知其他客户端
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
    ws.send(JSON.stringify({ type: 'reject', why: '房间号不能为空' }));
    return;
  }

  const room = rooms.get(roomName);
  if (!room) {
    ws.send(JSON.stringify({ type: 'reject', why: '房间不存在' }));
    return;
  }

  // 检查房间是否已满
  if (room.clients.size >= 4) {
    ws.send(JSON.stringify({ type: 'reject', why: '房间已满' }));
    return;
  }

  // 分配槽位
  const slot = assignSlot(room);
  if (slot === -1) {
    ws.send(JSON.stringify({ type: 'reject', why: '没有可用槽位' }));
    return;
  }

  // 加入房间
  room.clients.set(clientId, true);
  client.room = roomName;
  client.slot = slot;
  client.name = msg.name || client.name;

  console.log(`[房间] ${roomName} 加入: ${client.name} (槽位 ${slot + 1})`);

  // 发送成功确认
  ws.send(JSON.stringify({
    type: 'welcome',
    room: roomName,
    slot: slot,
    players: buildPlayerList(room)
  }));

  // 通知其他客户端
  broadcastToRoom(roomName, {
    type: 'player_joined',
    clientId: clientId,
    name: client.name,
    slot: slot
  }, clientId);
}

function handleHello(clientId, msg) {
  // 用于广播客户端发现
  const client = clients.get(clientId);
  if (!client) return;

  const roomName = msg.room;
  const room = rooms.get(roomName);

  if (!room) {
    ws.send(JSON.stringify({
      type: 'reject',
      why: '房间不存在或未创建'
    }));
    return;
  }

  // 自动加入（如果是客户端重试）
  if (room.clients.size < 4 && !room.clients.has(clientId)) {
    handleJoinRoom(clientId, { room: roomName, name: msg.name });
  }
}

function handleMessageForward(clientId, msg) {
  const client = clients.get(clientId);
  if (!client || !client.room) return;

  const room = rooms.get(client.room);
  if (!room) return;

  // 转发给房间内所有其他客户端
  broadcastToRoom(client.room, msg, clientId);
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  console.log(`[-] 客户端断开: ${client.name} (${clientId})`);

  // 从房间移除
  if (client.room && rooms.has(client.room)) {
    const room = rooms.get(client.room);
    room.clients.delete(clientId);

    // 如果房主离开，踢掉整个房间
    if (room.host === clientId) {
      console.log(`[房间] ${client.room} 房主离开，解散房间`);
      broadcastToRoom(client.room, {
        type: 'room_disbanded',
        reason: '房主离开'
      });
      rooms.delete(client.room);
    } else {
      // 通知其他客户端
      broadcastToRoom(client.room, {
        type: 'player_left',
        clientId: clientId,
        name: client.name
      });

      // 重新分配槽位
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
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
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
  // 重新分配槽位
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

// 启动服务器
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  暗物质反应堆模拟器 - 联机服务器`);
  console.log(`========================================`);
  console.log(`  监听端口: ${PORT}`);
  console.log(`  局域网地址: localhost:${PORT}`);
  console.log(`  公共中继: ${RELAY_SERVER}`);
  console.log(`\n  使用说明:`);
  console.log(`  1. 局域网联机: 其他设备访问 http://你的局域网IP:${PORT}`);
  console.log(`  2. 外网联机: 使用公共中继服务器或配置端口转发`);
  console.log(`========================================\n`);
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[关闭] 服务器正在停止...');
  wss.clients.forEach(client => {
    client.close();
  });
  server.close(() => {
    process.exit(0);
  });
});
