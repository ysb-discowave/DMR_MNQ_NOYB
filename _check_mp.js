
/* ============================================================
   暗物质反应堆模拟器 · 核心引擎
   4 × RBMK-1000 + 暗物质湮灭核心 + 汽轮机
   ============================================================ */

// === 全局仿真 ===
var SIM = { time: 0, speed: 1, running: true };
var lastTick = performance.now();

// ============================================================
// 多人联机模块 MP
// 架构：房主权威(Authoritative Host)
//   · 房主跑真实物理，每 100ms 广播一次状态快照
//   · 客户端不跑物理，只发送"操作意图"，收快照后渲染
//   · 4 个 RBMK 机组分给 4 名玩家；DM 核心/汽轮机/泵为共享设备
// ============================================================
var MP = {
  active: false,   // 是否处于联机状态
  host: false,     // 是否房主
  myId: null,
  name: '',
  room: '',
  slot: -1,        // 我负责的机组下标，-1 = 观众
  mode: 'bc',      // bc = 本机多窗口，ws = 服务器
  wsUrl: '',
  players: {},     // id -> {id,name,slot,color,energy,scrams,melts,host,seen}
  chat: [],
  _events: [],     // 待广播的音效/特效/日志事件
  _snapAt: 0,
  _hb: null,
  _hello: null,
  _hostId: null,
  _hostSeen: 0,
};
var MP_COLORS = ['#7c5cfc', '#34d399', '#f59e0b', '#ec4899', '#4a8cff', '#36d6e7'];
var MP_SLOTS = [null, null, null, null];

function _mpId() { return Math.random().toString(36).slice(2, 10); }
function _mpCode() {
  var s = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', r = '';
  for (var i = 0; i < 4; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}
function _mpR(v, d) { var m = Math.pow(10, d || 1); return Math.round(((v === undefined || v === null || !isFinite(v)) ? 0 : v) * m) / m; }

// ================= 传输层 =================
var MP_NET = {
  bc: null, ws: null, onmsg: null,
  start: function(mode, room, url) {
    this.stop();
    var self = this;
    if (mode === 'bc') {
      this.bc = new BroadcastChannel('dmreactor_' + room);
      this.bc.onmessage = function(e) { if (self.onmsg) self.onmsg(e.data); };
    } else {
      try {
        this.ws = new WebSocket(url);
        this.ws.onmessage = function(e) { try { if (self.onmsg) self.onmsg(JSON.parse(e.data)); } catch (err) {} };
        this.ws.onclose = function() { if (self.onmsg) self.onmsg({ __close: true }); };
        this.ws.onerror = function() {};
      } catch (e) { MP.toast('无法连接服务器', 'bad'); }
    }
  },
  send: function(m) {
    if (this.bc) { try { this.bc.postMessage(m); } catch (e) {} }
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(m)); } catch (e) {} }
  },
  stop: function() {
    if (this.bc) { try { this.bc.close(); } catch (e) {} this.bc = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
  }
};
MP_NET.onmsg = function(m) {
  if (!m) return;
  if (m.__close) { if (MP.active) MP.toast('连接已断开', 'bad'); return; }
  if (m.room !== MP.room || m.from === MP.myId) return;
  if (m.to !== 'all' && m.to !== MP.myId) return;
  MP.onMessage(m);
};
MP.send = function(p, to) {
  p.room = MP.room; p.from = MP.myId; p.to = to || 'all';
  MP_NET.send(p);
};

// ================= 房间管理 =================
MP.freeSlot = function() {
  for (var i = 0; i < 4; i++) if (!MP_SLOTS[i] || !MP.players[MP_SLOTS[i]]) return i;
  return -1;
};
MP.hostRoom = function(name, room, mode, wsUrl) {
  MP.name = name; MP.room = room; MP.mode = mode; MP.wsUrl = wsUrl || '';
  MP.myId = _mpId(); MP.host = true; MP.active = true; MP.slot = 0;
  MP._hostId = MP.myId; MP.players = {}; MP.chat = []; MP._events = [];
  MP_SLOTS = [MP.myId, null, null, null];
  MP.players[MP.myId] = { id: MP.myId, name: name, slot: 0, color: MP_COLORS[0], energy: 0, scrams: 0, melts: 0, host: true, seen: Date.now() };
  MP_NET.start(mode, room, MP.wsUrl);
  MP.sysChat('房间 ' + room + ' 已创建，你负责 RBMK-1');
  MP.updateBadge(); MP.renderPanel(); MP.refreshLocks(); MP.startBeat();
};
MP.joinRoom = function(name, room, mode, wsUrl) {
  MP.name = name; MP.room = room; MP.mode = mode; MP.wsUrl = wsUrl || '';
  MP.myId = _mpId(); MP.host = false; MP.active = true; MP.slot = -1;
  MP.players = {}; MP.chat = []; MP._events = []; MP._hostSeen = 0;
  MP_NET.start(mode, room, MP.wsUrl);
  MP.sysChat('正在加入房间 ' + room + ' ...');
  MP.updateBadge(); MP.renderPanel(); MP.refreshLocks();
  var tries = 0;
  if (MP._hello) clearInterval(MP._hello);
  MP._hello = setInterval(function() {
    if (MP.slot >= 0) { clearInterval(MP._hello); MP._hello = null; return; }
    if (++tries > 12) {
      clearInterval(MP._hello); MP._hello = null;
      MP.toast('未找到房间 ' + room + '（房主需先创建）', 'bad');
      MP.leave(); return;
    }
    MP.send({ type: 'hello', name: name });
  }, 1500);
  MP.send({ type: 'hello', name: name });
  MP.startBeat();
};
MP.leave = function() {
  if (MP.active) { try { MP.send({ type: 'bye' }); } catch (e) {} }
  if (MP._hello) { clearInterval(MP._hello); MP._hello = null; }
  if (MP._hb) { clearInterval(MP._hb); MP._hb = null; }
  MP_NET.stop();
  MP.active = false; MP.host = false; MP.slot = -1; MP.players = {}; MP.chat = []; MP._events = [];
  MP_SLOTS = [null, null, null, null]; MP._hostId = null;
  MP.refreshLocks(); MP.updateBadge(); MP.renderPanel();
};
MP.dropPlayer = function(id) {
  var p = MP.players[id]; if (!p) return;
  for (var i = 0; i < 4; i++) if (MP_SLOTS[i] === id) MP_SLOTS[i] = null;
  delete MP.players[id];
  MP.sysChat('◀ ' + p.name + ' 离开了房间', true);
  MP.send({ type: 'players', players: MP.players });
  MP.renderPanel();
};

// ================= 消息处理 =================
MP.onMessage = function(m) {
  if (MP.host) return MP.hostMessage(m);
  var t = m.type;
  if (m.from === MP._hostId) MP._hostSeen = Date.now();
  if (t === 'welcome') {
    MP.slot = m.slot;
    MP.players = m.players || {};
    for (var k in MP.players) if (MP.players[k].host) MP._hostId = k;
    MP.applySnapshot(m.snap);
    MP.sysChat('已加入！你负责 RBMK-' + (MP.slot + 1));
    MP.updateBadge(); MP.renderPanel(); MP.refreshLocks();
  } else if (t === 'reject') {
    MP.toast('加入失败：' + (m.why || '房间已满'), 'bad');
    if (MP._hello) { clearInterval(MP._hello); MP._hello = null; }
    MP.leave();
  } else if (t === 'players') {
    MP.players = m.players || {};
    for (var k2 in MP.players) if (MP.players[k2].host) MP._hostId = k2;
    MP.renderPanel(); MP.refreshLocks();
  } else if (t === 'snapshot') {
    MP._hostSeen = Date.now();
    MP.applySnapshot(m.snap);
  } else if (t === 'chat') {
    MP.pushChat(MP.players[m.from] || { name: '?', color: '#888' }, m.text);
  } else if (t === 'sys') {
    MP.pushChat(null, m.text, true);
  } else if (t === 'hostbye') {
    MP.toast('房主已关闭房间', 'bad'); MP.leave();
  }
};
MP.hostMessage = function(m) {
  var t = m.type, from = m.from;
  if (t === 'hello') {
    if (MP.players[from]) {
      MP.players[from].seen = Date.now();
      MP.send({ type: 'welcome', slot: MP.players[from].slot, players: MP.players, snap: MP.snapshot() }, from);
      MP.send({ type: 'players', players: MP.players });
      return;
    }
    var slot = MP.freeSlot();
    if (slot < 0) { MP.send({ type: 'reject', why: '房间已满（4人）' }, from); return; }
    MP_SLOTS[slot] = from;
    MP.players[from] = {
      id: from, name: m.name || ('玩家' + (slot + 1)), slot: slot,
      color: MP_COLORS[slot % MP_COLORS.length],
      energy: 0, scrams: 0, melts: 0, host: false, seen: Date.now()
    };
    MP.send({ type: 'welcome', slot: slot, players: MP.players, snap: MP.snapshot() }, from);
    var p = MP.players[from];
    // 同步该机组当前的控制棒选择/拉杆显示到新玩家界面
    MP.sysChat('▶ ' + p.name + ' 加入，负责 RBMK-' + (slot + 1), true);
    MP.send({ type: 'players', players: MP.players });
    MP.renderPanel();
    return;
  }
  if (t === 'action') {
    if (MP.players[from]) { MP.players[from].seen = Date.now(); MP.runAction(from, m.fn, m.args); }
    return;
  }
  if (t === 'chat') {
    if (MP.players[from]) { MP.players[from].seen = Date.now(); MP.pushChat(MP.players[from], m.text); MP.send({ type: 'chat', from: from, text: m.text }); }
    return;
  }
  if (t === 'ping') { if (MP.players[from]) MP.players[from].seen = Date.now(); return; }
  if (t === 'bye') { MP.dropPlayer(from); return; }
};

// ================= 操作通道 =================
var MP_UNIT_FN = { clickUnitRod: 1, onUnitLever: 1, groupAllRods: 1, scramUnit: 1, startupUnit: 1, changeUnitMode: 1 };
var MP_ACTIONS = {
  clickUnitRod: function(ui, idx, mod) { window.clickUnitRod(ui, idx, mod || {}); },
  onUnitLever: function(ui, v, f) { window.onUnitLever(ui, v, f); },
  groupAllRods: function(ui, pct, az5) { window.groupAllRods(ui, pct, az5); },
  scramUnit: function(ui, r) { window.scramUnit(ui, r); },
  startupUnit: function(ui) { window.startupUnit(ui); },
  changeUnitMode: function(ui) { window.changeUnitMode(ui); },
  toggleDmPump: function(kind, idx) { window.toggleDmPump(kind, idx); },
  setDmLoad: function(v) { window.setDmLoad(v); },
  dmTurbineRollUp: function() { window.dmTurbineRollUp(); },
  dmTurbineSync: function() { window.dmTurbineSync(); },
  dmRaiseLoad: function() { window.dmRaiseLoad(); },
  dmLowerLoad: function() { window.dmLowerLoad(); },
  dmTurbineTrip: function(r) { window.dmTurbineTrip(r); },
  dmTurbineReset: function() { window.dmTurbineReset(); },
  toggleFuelCell: function(i) { window.toggleFuelCell(i); },
  changeDmMasterMode: function() { window.changeDmMasterMode(); },
  checkAndGlobalScram: function() { window.checkAndGlobalScram(); }
};
MP.exec = function(fn, args) {
  if (!MP.active) return true;   // 单人：本地直接执行
  if (MP.host) return true;      // 房主：本地执行，下一帧广播
  MP.send({ type: 'action', fn: fn, args: args });
  return false;                  // 客户端：只发意图，不本地执行
};
MP.runAction = function(fromId, fn, args) {
  var p = MP.players[fromId]; if (!p) return;
  if (!MP.checkPerm(p, fn, args)) {
    MP.send({ type: 'sys', text: '⛔ 该设备由其他操作员负责' }, fromId);
    return;
  }
  var f = MP_ACTIONS[fn];
  if (!f) return;
  try { f.apply(null, args || []); } catch (e) {}
};
MP.checkPerm = function(p, fn, args) {
  if (!MP_UNIT_FN[fn]) return p.slot >= 0;      // 共享设备：已分配机组者可操作
  var ui = (args && typeof args[0] === 'number') ? args[0] : -1;
  if (p.slot === ui) return true;
  var owner = MP_SLOTS[ui];                      // 无人认领的机组谁都能动
  return !owner || !MP.players[owner];
};
MP.canUnit = function(ui) {
  if (!MP.active) return true;
  if (MP.slot === ui) return true;
  var owner = MP_SLOTS[ui];
  return !owner || !MP.players[owner];
};
MP.canDM = function() {
  if (!MP.active) return true;
  return MP.slot >= 0;
};

// ================= 快照 =================
MP.snapshot = function() {
  var us = [];
  for (var i = 0; i < 4; i++) {
    var un = RBMK_UNITS[i], R = un.REACTOR, rods = [];
    for (var j = 0; j < un.RODS.length; j++) {
      var r = un.RODS[j];
      rods.push([_mpR(r.position, 1), _mpR(r.targetPos, 1), r.jammed ? 1 : 0, r.moving ? 1 : 0]);
    }
    us.push({
      s: un.scrammed ? 1 : 0, st: _mpR(un.scramTimer, 1), md: un.mode, as: _mpR(un.AUTO.setpoint, 0),
      p: _mpR(R.thermalPower, 2), f: _mpR(R.neutronFlux, 4), rh: _mpR(R.rho, 5),
      T: _mpR(R.avgFuelTemp, 1), Pk: _mpR(R.peakFuelTemp, 1), x: _mpR(R.Xe135, 5), i: _mpR(R.I135, 4),
      v: _mpR(R.voidFraction, 4), m: R.coreMelted ? 1 : 0,
      ci: _mpR(R.coreInletT, 1), co: _mpR(R.coreOutletT, 1), R: rods
    });
  }
  var dmc = [], dfw = [];
  for (var a = 0; a < DM.DMC.length; a++) dmc.push([DM.DMC[a].running ? 1 : 0, DM.DMC[a].trip ? 1 : 0, _mpR(DM.DMC[a].speed, 1), _mpR(DM.DMC[a].targetSpeed, 1)]);
  for (var b = 0; b < DM.DFW.length; b++) dfw.push([DM.DFW[b].running ? 1 : 0, DM.DFW[b].trip ? 1 : 0, _mpR(DM.DFW[b].speed, 1), _mpR(DM.DFW[b].targetSpeed, 1)]);
  var T = DM.TURBINE, fc = [];
  for (var c = 0; c < DM.fuelCells.length; c++) fc.push([DM.fuelCells[c].locked ? 1 : 0, DM.fuelCells[c].popped ? 1 : 0]);
  return {
    t: _mpR(SIM.time, 1), sp: SIM.speed, u: us,
    d: {
      tp: _mpR(DM.thermalPower, 2), ct: _mpR(DM.coreTemp, 1), pd: _mpR(DM.plasmaDensity, 3),
      ae: _mpR(DM.annihilationEta, 2), tn: _mpR(DM.totalNeutronInput, 3), sd: DM.shutdown ? 1 : 0,
      sp: _mpR(DM.sg_pressure, 2), st: _mpR(DM.sg_temp, 1),
      ms: [_mpR(DM.mainSteam.pressure, 2), _mpR(DM.mainSteam.temp, 1)],
      rem: _mpR(DM._removable || 0, 1), net: _mpR(DM._netHeat || 0, 1),
      mm: DM._masterMode, tgt: _mpR(DM._targetDmSetpoint || 0, 0),
      ph: DM._scramPhase, mplay: DM.meltdownPlaying ? 1 : 0, mact: DM._meltdownActive ? 1 : 0,
      mstop: DM._meltdownStopped ? 1 : 0, p2: DM._p2ShutdownActive ? 1 : 0,
      dmc: dmc, dfw: dfw, fc: fc,
      tb: [T.running ? 1 : 0, T.tripped ? 1 : 0, _mpR(T.rpm, 0), T.targetRpm, T.generatorOnline ? 1 : 0,
           _mpR(T.genPower, 1), T.genLoadSet, _mpR(T.govValveOpen, 1), T.tripValveOpen ? 1 : 0, T.resetNeeded ? 1 : 0]
    }
  };
};
MP.applySnapshot = function(s) {
  if (!s) return;
  SIM.time = s.t; SIM.speed = s.sp;
  if (s.u) {
    for (var i = 0; i < 4; i++) {
      var src = s.u[i], un = RBMK_UNITS[i], R = un.REACTOR;
      if (!src) continue;
      un.scrammed = !!src.s; un.scramTimer = src.st;
      if (src.md) un.mode = src.md;
      if (src.as !== undefined) un.AUTO.setpoint = src.as;
      R.thermalPower = src.p; R.neutronFlux = src.f; R.rho = src.rh;
      R.avgFuelTemp = src.T; R.peakFuelTemp = src.Pk; R.Xe135 = src.x; R.I135 = src.i;
      R.voidFraction = src.v; R.coreMelted = !!src.m; R.coreInletT = src.ci; R.coreOutletT = src.co;
      if (src.R) {
        for (var j = 0; j < un.RODS.length; j++) {
          var rr = src.R[j]; if (!rr) continue;
          un.RODS[j].position = rr[0]; un.RODS[j].targetPos = rr[1];
          un.RODS[j].jammed = !!rr[2]; un.RODS[j].moving = !!rr[3];
        }
      }
    }
  }
  var d = s.d;
  if (d) {
    DM.thermalPower = d.tp; DM.coreTemp = d.ct; DM.plasmaDensity = d.pd;
    DM.annihilationEta = d.ae; DM.totalNeutronInput = d.tn; DM.shutdown = !!d.sd;
    DM.sg_pressure = d.sp; DM.sg_temp = d.st;
    if (d.ms) { DM.mainSteam.pressure = d.ms[0]; DM.mainSteam.temp = d.ms[1]; }
    DM._removable = d.rem; DM._netHeat = d.net;
    if (d.mm) DM._masterMode = d.mm;
    DM._targetDmSetpoint = d.tgt;
    DM._scramPhase = d.ph; DM.meltdownPlaying = !!d.mplay;
    DM._meltdownActive = !!d.mact; DM._meltdownStopped = !!d.mstop;
    DM._p2ShutdownActive = !!d.p2;
    if (d.dmc) for (var a = 0; a < DM.DMC.length && a < d.dmc.length; a++) {
      DM.DMC[a].running = !!d.dmc[a][0]; DM.DMC[a].trip = !!d.dmc[a][1];
      DM.DMC[a].speed = d.dmc[a][2]; DM.DMC[a].targetSpeed = d.dmc[a][3];
    }
    if (d.dfw) for (var b = 0; b < DM.DFW.length && b < d.dfw.length; b++) {
      DM.DFW[b].running = !!d.dfw[b][0]; DM.DFW[b].trip = !!d.dfw[b][1];
      DM.DFW[b].speed = d.dfw[b][2]; DM.DFW[b].targetSpeed = d.dfw[b][3];
    }
    if (d.tb) {
      var T = DM.TURBINE, t = d.tb;
      T.running = !!t[0]; T.tripped = !!t[1]; T.rpm = t[2]; T.targetRpm = t[3];
      T.generatorOnline = !!t[4]; T.genPower = t[5]; T.genLoadSet = t[6];
      T.govValveOpen = t[7]; T.tripValveOpen = !!t[8]; T.resetNeeded = !!t[9];
    }
    if (d.fc) for (var c = 0; c < DM.fuelCells.length && c < d.fc.length; c++) {
      DM.fuelCells[c].locked = !!d.fc[c][0]; DM.fuelCells[c].popped = !!d.fc[c][1];
    }
  }
  if (s.pl) {
    for (var k in s.pl) {
      if (MP.players[k]) {
        MP.players[k].energy = s.pl[k][0]; MP.players[k].scrams = s.pl[k][1]; MP.players[k].melts = s.pl[k][2];
      }
    }
    var _cn = Date.now();
    if (_cn - (MP._panelAt || 0) > 500) { MP._panelAt = _cn; MP.renderPanel(); }
  }
  if (s.ev && s.ev.length) MP.applyEvents(s.ev);
};
MP.packScores = function() {
  var o = {};
  for (var k in MP.players) o[k] = [_mpR(MP.players[k].energy, 2), MP.players[k].scrams, MP.players[k].melts];
  return o;
};
MP.score = function(p) { return (p.energy || 0) - (p.scrams || 0) * 50 - (p.melts || 0) * 500; };

// ================= 事件（音效/特效/日志同步）=================
MP.emit = function(e) { if (MP.active && MP.host) MP._events.push(e); };
MP.applyEvents = function(list) {
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    try {
      if (e.k === 'sfx') SOUND.play(e.n);
      else if (e.k === 'log') logMsg(e.l, e.t);
      else if (e.k === 'fire') { if (e.on) startMeltdownFire(); else stopMeltdownFire(); }
      else if (e.k === 'boom') triggerExplosionFlash();
      else if (e.k === 'p2') { if (e.on) triggerP2ShutdownWindow(); else updateFuelCellStatus(); }
    } catch (err) {}
  }
};
MP.broadcast = function() {
  var now = Date.now();
  if (now - MP._snapAt < 100) return;
  MP._snapAt = now;
  var snap = MP.snapshot();
  var evs = MP._events; MP._events = [];
  snap.ev = evs.slice(0, 80);
  snap.pl = MP.packScores();
  MP.send({ type: 'snapshot', snap: snap });
  var _pn = Date.now();
  if (_pn - (MP._panelAt || 0) > 500) { MP._panelAt = _pn; MP.renderPanel(); }
};
MP.tickScore = function(dt) {
  if (!MP.active || !MP.host) return;
  var hours = dt / 3600;
  for (var s = 0; s < 4; s++) {
    var pid = MP_SLOTS[s];
    if (pid && MP.players[pid]) MP.players[pid].energy += RBMK_UNITS[s].REACTOR.thermalPower * hours;
  }
};
MP.assignMeltBlame = function() {
  var best = -1, bestT = -1;
  for (var s = 0; s < 4; s++) {
    var T = RBMK_UNITS[s].REACTOR.avgFuelTemp;
    if (!RBMK_UNITS[s].scrammed && T > bestT) { bestT = T; best = s; }
  }
  var pid = best >= 0 ? MP_SLOTS[best] : null;
  if (pid && MP.players[pid]) {
    MP.players[pid].melts++;
    MP.sysChat('☢ ' + MP.players[pid].name + ' 的 RBMK-' + (best + 1) + ' 引发核心熔毁 (-500分)', true);
  }
};
MP.startBeat = function() {
  if (MP._hb) clearInterval(MP._hb);
  MP._hb = setInterval(function() {
    if (!MP.active) return;
    if (MP.host) {
      var now = Date.now(), changed = false;
      for (var k in MP.players) {
        if (MP.players[k].host) continue;
        if (now - (MP.players[k].seen || 0) > 15000) { MP.dropPlayer(k); changed = true; }
      }
      MP.send({ type: 'players', players: MP.players });
      if (changed) MP.renderPanel();
    } else {
      MP.send({ type: 'ping' });
      if (MP._hostSeen && Date.now() - MP._hostSeen > 15000) {
        MP.toast('房主已失联，已退出房间', 'bad'); MP.leave();
      }
    }
  }, 2000);
};
// 安装钩子：房主把音效/日志/特效变化记录成事件广播给客户端
MP.installHooks = function() {
  var _play = SOUND.play;
  SOUND.play = function(n) {
    try { _play.call(SOUND, n); } catch (e) {}
    if (MP.active && MP.host) MP._events.push({ k: 'sfx', n: n });
  };
  var _log = window.logMsg;
  window.logMsg = function(l, t) {
    try { _log(l, t); } catch (e) {}
    if (MP.active && MP.host) MP._events.push({ k: 'log', l: l, t: t });
  };
  var _fireOn = window.startMeltdownFire, _fireOff = window.stopMeltdownFire;
  window.startMeltdownFire = function() {
    try { _fireOn(); } catch (e) {}
    if (MP.active && MP.host) { MP.assignMeltBlame(); MP._events.push({ k: 'fire', on: true }); }
  };
  window.stopMeltdownFire = function() {
    try { _fireOff(); } catch (e) {}
    if (MP.active && MP.host) MP._events.push({ k: 'fire', on: false });
  };
  var _boom = window.triggerExplosionFlash;
  window.triggerExplosionFlash = function() {
    try { _boom(); } catch (e) {}
    if (MP.active && MP.host) MP._events.push({ k: 'boom' });
  };
  var _p2 = window.triggerP2ShutdownWindow;
  window.triggerP2ShutdownWindow = function() {
    try { _p2(); } catch (e) {}
    if (MP.active && MP.host) MP._events.push({ k: 'p2', on: true });
  };
  var _sc = window.scramUnit;
  window.scramUnit = function(ui, reason) {
    var was = RBMK_UNITS[ui] ? RBMK_UNITS[ui].scrammed : false;
    try { _sc(ui, reason); } catch (e) {}
    if (MP.active && MP.host && !was && RBMK_UNITS[ui] && RBMK_UNITS[ui].scrammed) {
      var pid = MP_SLOTS[ui];
      if (pid && MP.players[pid]) {
        MP.players[pid].scrams++;
        MP.sysChat('⚠ ' + MP.players[pid].name + ' 的 RBMK-' + (ui + 1) + ' 紧急停堆 (-50分)', true);
      }
    }
  };
};

// ================= 多人 UI =================
function _mpEsc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
MP.toast = function(text, kind) {
  var box = document.getElementById('mpToastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mpToastBox';
    box.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);z-index:1000001;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;';
    document.body.appendChild(box);
  }
  var el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;background:'
    + (kind === 'bad' ? 'rgba(239,68,68,0.94)' : 'rgba(52,211,153,0.94)')
    + ';box-shadow:0 4px 16px rgba(0,0,0,0.55);max-width:70vw;text-align:center;';
  box.appendChild(el);
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 2800);
};
MP.pushChat = function(p, text, sys) {
  MP.chat.push({ name: p ? p.name : '', color: p ? p.color : '#888', text: text, sys: !!sys });
  if (MP.chat.length > 150) MP.chat.shift();
  MP.renderChat();
};
MP.sysChat = function(text, broadcast) {
  MP.pushChat(null, text, true);
  if (broadcast && MP.host) MP.send({ type: 'sys', text: text });
};
MP.chatSend = function() {
  var inp = document.getElementById('mpChatInput');
  if (!inp || !MP.active) return;
  var v = (inp.value || '').trim();
  if (!v) return;
  inp.value = '';
  if (v.length > 200) v = v.slice(0, 200);
  if (MP.host) { MP.pushChat(MP.players[MP.myId], v); MP.send({ type: 'chat', from: MP.myId, text: v }); }
  else MP.send({ type: 'chat', text: v });
};
MP.renderChat = function() {
  var box = document.getElementById('mpChat');
  if (!box) return;
  var html = '';
  for (var i = 0; i < MP.chat.length; i++) {
    var m = MP.chat[i];
    if (m.sys) html += '<div class="mp-msg sys">' + _mpEsc(m.text) + '</div>';
    else html += '<div class="mp-msg"><span class="n" style="color:' + _mpEsc(m.color) + '">' + _mpEsc(m.name) + '：</span>' + _mpEsc(m.text) + '</div>';
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
};
MP.renderPanel = function() {
  var p = document.getElementById('mpPanel');
  if (!p) return;
  if (!MP.active) { p.style.display = 'none'; return; }
  if (MP._open) p.style.display = 'flex';
  var ri = document.getElementById('mpRoomInfo');
  if (ri) ri.textContent = MP.room + ' · ' + (MP.mode === 'bc' ? '本机多窗口' : '服务器');
  var arr = [];
  for (var k in MP.players) arr.push(MP.players[k]);
  arr.sort(function(a, b) { return MP.score(b) - MP.score(a); });
  var html = '';
  for (var i = 0; i < arr.length; i++) {
    var pl = arr[i], me = pl.id === MP.myId;
    var sc = MP.score(pl);
    html += '<div class="mp-prow' + (me ? ' me' : '') + '">'
      + '<span class="mp-pdot" style="background:' + _mpEsc(pl.color) + '"></span>'
      + '<span class="mp-pname" style="color:' + (me ? _mpEsc(pl.color) : 'var(--text-primary)') + '">'
      + (pl.host ? '★ ' : '') + _mpEsc(pl.name) + (me ? ' (我)' : '') + '</span>'
      + '<span class="mp-punit">RBMK-' + (pl.slot + 1) + '</span>'
      + '<span class="mp-punit">' + _mpR(pl.energy, 1) + 'MWh</span>'
      + '<span class="mp-punit" style="color:var(--accent-amber)">停' + (pl.scrams || 0) + '</span>'
      + '<span class="mp-pscore" style="color:' + (sc >= 0 ? 'var(--accent-green)' : 'var(--accent-red)') + '">' + Math.round(sc) + '</span>'
      + '</div>';
  }
  if (!arr.length) html = '<div class="mp-prow"><span class="mp-punit">暂无玩家</span></div>';
  var lst = document.getElementById('mpPlayers');
  if (lst) lst.innerHTML = html;
  var mine = document.getElementById('mpMine');
  if (mine) mine.textContent = MP.slot >= 0 ? ('我：' + MP.name + ' · 操作 RBMK-' + (MP.slot + 1)) : ('我：' + MP.name + '（观众，无法操作设备）');
};
MP.updateBadge = function() {
  var b = document.getElementById('mpBadge');
  if (!b) return;
  if (MP.active) {
    b.textContent = '👥 ' + MP.room + (MP.host ? ' ·房主' : '');
    b.style.background = MP.host ? 'rgba(124,92,252,0.28)' : 'rgba(52,211,153,0.22)';
    b.style.borderColor = MP.host ? 'var(--accent-purple)' : 'var(--accent-green)';
    b.style.color = '#fff';
  } else {
    b.textContent = '👥 多人联机';
    b.style.background = 'rgba(255,255,255,0.06)';
    b.style.borderColor = 'var(--border)';
    b.style.color = 'var(--text-secondary)';
  }
};
MP.togglePanel = function() {
  if (!MP.active) { MP.openDialog(); return; }
  MP._open = !MP._open;
  var p = document.getElementById('mpPanel');
  if (p) p.style.display = MP._open ? 'flex' : 'none';
  if (MP._open) MP.renderPanel();
};
MP.refreshLocks = function() {
  for (var ui = 0; ui < 4; ui++) {
    var card = document.getElementById('unit-' + ui);
    if (!card) continue;
    card.classList.toggle('unit-locked', !MP.canUnit(ui));
    var tag = document.getElementById('mpTag' + ui);
    if (!tag) {
      var hdr = card.querySelector('.card-header');
      if (hdr) {
        tag = document.createElement('span');
        tag.id = 'mpTag' + ui;
        tag.style.cssText = 'margin-left:6px;font-size:10px;padding:1px 6px;border-radius:6px;font-weight:700;white-space:nowrap;';
        hdr.appendChild(tag);
      }
    }
    if (!tag) continue;
    if (!MP.active) { tag.style.display = 'none'; continue; }
    var ownerId = MP_SLOTS[ui], p = ownerId ? MP.players[ownerId] : null;
    tag.style.display = '';
    if (p) {
      tag.textContent = (p.id === MP.myId ? '● 我操作' : _mpEsc(p.name));
      tag.style.background = p.color + '2e';
      tag.style.color = p.color;
      tag.style.border = '1px solid ' + p.color + '77';
    } else {
      tag.textContent = '空闲·可接管';
      tag.style.background = 'rgba(255,255,255,0.06)';
      tag.style.color = 'var(--text-muted)';
      tag.style.border = '1px solid var(--border)';
    }
  }
  var can = MP.canDM();
  var dmStateEl = document.getElementById('dmState');
  var dmCard2 = (dmStateEl && dmStateEl.closest) ? dmStateEl.closest('.card') : null;
  if (dmCard2) dmCard2.classList.toggle('dm-locked', !can);
  var ids = ['dmPumpList', 'dmFwpList', 'fuelBtn0', 'fuelBtn1', 'fuelBtn2', 'dmMasterMode', 'dmLoadSlider'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) { el.style.pointerEvents = can ? '' : 'none'; el.style.opacity = can ? '' : '0.4'; }
  }
  var tbs = document.querySelectorAll('[onclick^="dmTurbine"]');
  for (var q = 0; q < tbs.length; q++) {
    tbs[q].style.pointerEvents = can ? '' : 'none';
    tbs[q].style.opacity = can ? '' : '0.4';
  }
};
MP.openDialog = function() {
  var old = document.getElementById('mpDlg');
  if (old) { old.parentNode.removeChild(old); }
  var d = document.createElement('div');
  d.id = 'mpDlg';
  d.innerHTML = '<div class="mp-dlg">'
    + '<div class="mp-dlg-h">多人联机</div>'
    + '<div class="mp-fld"><label>你的昵称</label><input id="mpName" maxlength="12" placeholder="操作员姓名"></div>'
    + '<div class="mp-fld"><label>房间号</label><input id="mpRoom" maxlength="8" style="text-transform:uppercase"></div>'
    + '<div class="mp-fld"><label>连接方式</label>'
    + '<select id="mpMode"><option value="bc">本机多窗口（同一台电脑开多个标签页）</option>'
    + '<option value="ws">服务器（跨设备 / 局域网）</option></select></div>'
    + '<div class="mp-fld" id="mpWsWrap" style="display:none"><label>服务器地址</label>'
    + '<input id="mpWs" placeholder="ws://192.168.1.10:8787" value="ws://127.0.0.1:8787"></div>'
    + '<div class="mp-tip">本机多窗口：同一台电脑多开几个本页面即可联机。<br>'
    + '服务器：需先在房主电脑运行 server.js，其他人填房主的局域网 IP。<br>'
    + '规则：4 台机组各归一名玩家，DM 核心/汽轮机/冷却泵为共享设备。<br>'
    + '计分：发电量(MWh) − 停堆×50 − 熔毁×500</div>'
    + '<div class="mp-dlg-b">'
    + '<button class="mp-b mp-b-ghost" id="mpCancel">取消</button>'
    + '<button class="mp-b" id="mpJoin">加入房间</button>'
    + '<button class="mp-b mp-b-pri" id="mpCreate">创建房间</button>'
    + '</div></div>';
  document.body.appendChild(d);
  document.getElementById('mpRoom').value = _mpCode();
  var sel = document.getElementById('mpMode');
  sel.addEventListener('change', function() {
    document.getElementById('mpWsWrap').style.display = sel.value === 'ws' ? '' : 'none';
  });
  document.getElementById('mpCancel').addEventListener('click', function() {
    if (d.parentNode) d.parentNode.removeChild(d);
  });
  d.addEventListener('click', function(e) { if (e.target === d) d.parentNode.removeChild(d); });
  document.getElementById('mpCreate').addEventListener('click', function() {
    var n = (document.getElementById('mpName').value || '').trim() || '操作员';
    var r = (document.getElementById('mpRoom').value || '').trim().toUpperCase() || _mpCode();
    var m = sel.value;
    var u = document.getElementById('mpWs').value.trim();
    if (d.parentNode) d.parentNode.removeChild(d);
    MP._open = true;
    MP.hostRoom(n, r, m, u);
    MP.toast('房间 ' + r + ' 已创建');
  });
  document.getElementById('mpJoin').addEventListener('click', function() {
    var n = (document.getElementById('mpName').value || '').trim() || '操作员';
    var r = (document.getElementById('mpRoom').value || '').trim().toUpperCase();
    var m = sel.value;
    var u = document.getElementById('mpWs').value.trim();
    if (!r) { MP.toast('请输入房间号', 'bad'); return; }
    if (d.parentNode) d.parentNode.removeChild(d);
    MP._open = true;
    MP.joinRoom(n, r, m, u);
  });
  setTimeout(function() { var el = document.getElementById('mpName'); if (el) el.focus(); }, 50);
};
MP.ensureUI = function() {
  if (document.getElementById('mpStyle')) return;
  var st = document.createElement('style');
  st.id = 'mpStyle';
  st.textContent = ''
    + '#mpBadge{padding:5px 12px;font-size:12px;font-weight:700;border-radius:6px;border:1px solid var(--border);cursor:pointer;transition:all .2s;font-family:inherit;}'
    + '#mpBadge:hover{filter:brightness(1.3);}'
    + '#mpPanel{position:fixed;right:16px;top:66px;width:352px;max-height:calc(100vh - 88px);background:var(--bg-card);'
    + 'border:1px solid var(--border-active);border-radius:var(--radius-lg);box-shadow:0 12px 40px rgba(0,0,0,.6);'
    + 'z-index:1000000;display:none;flex-direction:column;overflow:hidden;}'
    + '.mp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);background:rgba(124,92,252,.08);}'
    + '.mp-head b{font-size:13px;flex:1;}'
    + '.mp-x{cursor:pointer;color:var(--text-secondary);font-size:16px;line-height:1;padding:0 4px;}'
    + '.mp-x:hover{color:var(--accent-red);}'
    + '.mp-sec{font-size:10px;color:var(--text-muted);font-weight:800;letter-spacing:1px;padding:8px 12px 3px;}'
    + '#mpPlayers{max-height:190px;overflow-y:auto;padding:2px 6px 6px;}'
    + '.mp-prow{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:6px;}'
    + '.mp-prow.me{background:rgba(124,92,252,.14);}'
    + '.mp-pdot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}'
    + '.mp-pname{font-size:12px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '.mp-punit{font-size:10px;color:var(--text-secondary);font-family:ui-monospace,monospace;white-space:nowrap;}'
    + '.mp-pscore{font-size:12px;font-weight:800;font-family:ui-monospace,monospace;min-width:44px;text-align:right;}'
    + '#mpChat{overflow-y:auto;padding:4px 10px;font-size:12px;line-height:1.55;min-height:96px;max-height:210px;'
    + 'background:rgba(0,0,0,.25);border-top:1px solid var(--border);}'
    + '.mp-msg{margin-bottom:4px;word-break:break-word;}'
    + '.mp-msg .n{font-weight:700;}'
    + '.mp-msg.sys{color:var(--text-muted);}'
    + '.mp-input-row{display:flex;gap:6px;padding:8px;border-top:1px solid var(--border);}'
    + '.mp-input-row input{flex:1;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;'
    + 'padding:6px 9px;color:var(--text-primary);font-size:12px;font-family:inherit;outline:none;}'
    + '.mp-input-row input:focus{border-color:var(--accent-purple);}'
    + '.mp-foot{padding:8px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;}'
    + '.mp-foot span{font-size:11px;color:var(--text-secondary);flex:1;}'
    + '#mpDlg{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.78);z-index:1000002;'
    + 'display:flex;align-items:center;justify-content:center;}'
    + '.mp-dlg{width:420px;max-width:92vw;background:var(--bg-card);border:1px solid var(--border-active);'
    + 'border-radius:var(--radius-lg);box-shadow:0 20px 60px rgba(0,0,0,.7);overflow:hidden;}'
    + '.mp-dlg-h{padding:14px 18px;font-size:16px;font-weight:800;border-bottom:1px solid var(--border);'
    + 'background:linear-gradient(135deg,rgba(124,92,252,.2),rgba(74,140,255,.12));}'
    + '.mp-fld{padding:10px 18px 0;}'
    + '.mp-fld label{display:block;font-size:11px;color:var(--text-secondary);font-weight:700;margin-bottom:4px;}'
    + '.mp-fld input,.mp-fld select{width:100%;background:var(--bg-primary);border:1px solid var(--border);'
    + 'border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px;font-family:inherit;outline:none;}'
    + '.mp-fld input:focus,.mp-fld select:focus{border-color:var(--accent-purple);}'
    + '.mp-tip{margin:12px 18px 0;padding:9px 11px;background:rgba(0,0,0,.3);border-radius:6px;'
    + 'font-size:11px;color:var(--text-muted);line-height:1.65;}'
    + '.mp-dlg-b{display:flex;gap:8px;justify-content:flex-end;padding:14px 18px;}'
    + '.mp-b{padding:8px 16px;font-size:13px;font-weight:700;border-radius:6px;cursor:pointer;font-family:inherit;'
    + 'border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text-primary);transition:all .2s;}'
    + '.mp-b:hover{filter:brightness(1.25);}'
    + '.mp-b-pri{background:var(--accent-purple);border-color:var(--accent-purple);color:#fff;}'
    + '.mp-b-ghost{background:transparent;color:var(--text-secondary);}'
    + '.unit-locked .ctrl-row,.unit-locked .rod-grid,.unit-locked .lever-row,.unit-locked .group-btns'
    + '{opacity:.32;pointer-events:none;filter:grayscale(.75);}'
    + '.unit-locked{border-style:dashed !important;}'
    + '.dm-locked .pump-list,.dm-locked .group-btns,.dm-locked .lever-row,.dm-locked select,.dm-locked input[type=range]'
    + '{opacity:.32;pointer-events:none;filter:grayscale(.75);}'
    + '';
  document.head.appendChild(st);

  var p = document.createElement('div');
  p.id = 'mpPanel';
  p.innerHTML = '<div class="mp-head"><b>多人联机</b>'
    + '<span style="font-size:11px;color:var(--text-secondary);" id="mpRoomInfo"></span>'
    + '<span class="mp-x" id="mpClose">✕</span></div>'
    + '<div class="mp-sec">操作员排名</div>'
    + '<div id="mpPlayers"></div>'
    + '<div class="mp-sec">聊天</div>'
    + '<div id="mpChat"></div>'
    + '<div class="mp-input-row"><input id="mpChatInput" maxlength="200" placeholder="输入消息后回车发送">'
    + '<button class="mp-b" id="mpSend">发送</button></div>'
    + '<div class="mp-foot"><span id="mpMine"></span>'
    + '<button class="mp-b" id="mpLeave" style="border-color:var(--accent-red);color:var(--accent-red);">离开房间</button></div>';
  document.body.appendChild(p);
  document.getElementById('mpClose').addEventListener('click', function() {
    MP._open = false; p.style.display = 'none';
  });
  document.getElementById('mpLeave').addEventListener('click', function() {
    MP.leave(); MP.toast('已离开房间');
  });
  var send = function() { MP.chatSend(); };
  document.getElementById('mpSend').addEventListener('click', send);
  document.getElementById('mpChatInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });

  var hr = document.querySelector('.header-right');
  if (hr) {
    var b = document.createElement('button');
    b.id = 'mpBadge';
    b.addEventListener('click', function() { MP.togglePanel(); });
    hr.appendChild(b);
    MP.updateBadge();
  }
};

// === 音效系统 ===
var SOUND = {
  enabled: true,
  _cache: {},
  load: function(name, src) {
    if (!src || !SOUND.enabled) return;
    if (SOUND._cache[name]) return;
    try { var a = new Audio(src); a.preload = 'auto'; a.volume = 0.6; SOUND._cache[name] = a; } catch(e) {}
  },
  play: function(name) {
    if (!SOUND.enabled || !SOUND._cache[name]) return;
    var a = SOUND._cache[name]; a.currentTime = 0; a.volume = 0.6;
    try { a.play().catch(function(){}); } catch(e) {}
  },
  stop: function(name) {
    if (SOUND._cache[name]) { SOUND._cache[name].pause(); SOUND._cache[name].currentTime = 0; }
  }
};
SOUND.load('scram_alert', 'sounds/scram_alert.ogg');
SOUND.load('alarm', 'sounds/alarm.wav');
SOUND.load('shutdown', 'sounds/shutdown.mp3');
SOUND.load('explosion', 'sounds/explosion.ogg');
SOUND.load('collision', 'sounds/collision.ogg');
SOUND.load('machine_loop', 'sounds/machine_loop.ogg');
SOUND.load('power_off', 'sounds/power_off.ogg');
SOUND.load('resonance', 'sounds/resonance.ogg');
SOUND.load('startup_sfx', 'sounds/startup.mp3');
SOUND.load('intro', 'sounds/intro.ogg');
SOUND.load('elevator', 'sounds/电梯.mp3');
// === 分P融毁音乐 ===
SOUND.load('P1融毁', 'sounds/P1融毁.ogg');
SOUND.load('p1代码检测', 'sounds/p1代码检测.ogg');
SOUND.load('P1成功音乐', 'sounds/P1成功音乐.ogg');
SOUND.load('P2融毁', 'sounds/P2融毁.ogg');

// === 燃料电池控制 ===
function toggleFuelCell(idx) {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('toggleFuelCell', [idx])) return;
  // 只在P2融毁或停机时允许操作
  if (DM._scramPhase !== 'p2_melting' && DM._scramPhase !== 'shutdown_window') {
    return;
  }

  var fc = DM.fuelCells[idx];
  fc.locked = !fc.locked;
  fc.popped = !fc.locked;

  // 更新按钮状态
  var btn = document.getElementById('fuelBtn' + idx);
  var status = document.getElementById('fuelStatus' + idx);
  if (fc.locked) {
    btn.className = 'pump-btn';
    btn.style.background = 'rgba(34,197,94,0.8)';
    status.textContent = '锁定';
    status.style.color = '#22c55e';
  } else {
    btn.className = 'pump-btn off';
    btn.style.background = 'rgba(234,179,8,0.8)';
    status.textContent = '弹出';
    status.style.color = '#eab308';
  }

  // 如果在P2停机窗口内，检查是否全部弹出
  if (DM._p2ShutdownActive) {
    // 如果还未开始倒计时，点击任意一个按钮后开始3秒倒计时
    if (!DM._p2CountdownStarted) {
      DM._p2CountdownStarted = true;
      DM._p2CountdownRemaining = 3.0;
      startP2Countdown();
    }
    // 只有在倒计时结束后才检查是否全部弹出
    if (!DM._p2CountdownStarted || DM._p2CountdownRemaining > 0) return;
    checkP2ShutdownSuccess();
  }
}

function startP2Countdown() {
  var timerEl = document.getElementById('p2ShutdownTimer');
  
  DM._p2CountdownInterval = setInterval(function() {
    DM._p2CountdownRemaining -= 0.1;
    if (timerEl) {
      if (DM._p2CountdownRemaining > 0) {
        timerEl.textContent = DM._p2CountdownRemaining.toFixed(1) + 's';
      } else {
        timerEl.textContent = '0.0s';
      }
    }

    if (DM._p2CountdownRemaining <= 0) {
      clearInterval(DM._p2CountdownInterval);
      // 3秒倒计时结束，检查是否全部弹出
      checkP2ShutdownSuccess();
    }
  }, 100);
}

function updateFuelCellStatus() {
  var allLocked = DM.fuelCells.every(function(fc) { return fc.locked; });
  var lockedCount = DM.fuelCells.filter(function(fc) { return fc.locked; }).length;
  var statusEl = document.getElementById('fuelCellsStatus');
  if (statusEl) {
    if (allLocked) {
      statusEl.textContent = '全部锁定';
      statusEl.className = 'badge badge-power';
    } else if (lockedCount > 0) {
      statusEl.textContent = lockedCount + '/3 锁定';
      statusEl.className = 'badge badge-warning';
    } else {
      statusEl.textContent = '全部弹出';
      statusEl.className = 'badge badge-shutdown';
    }
  }
}

// === P2停机窗口 ===
function triggerP2ShutdownWindow() {
  if (DM._p2ShutdownActive) return;
  DM._p2ShutdownActive = true;
  DM._scramPhase = 'shutdown_window';
  DM._p2CountdownStarted = false;
  DM._p2CountdownRemaining = 0;

  // 启用燃料电池按钮
  for (var i = 0; i < 3; i++) {
    var btn = document.getElementById('fuelBtn' + i);
    var status = document.getElementById('fuelStatus' + i);
    if (btn) {
      btn.style.background = '';
      btn.style.cursor = 'pointer';
    }
    if (DM.fuelCells[i].locked) {
      status.textContent = '锁定';
      status.style.color = '#22c55e';
    } else {
      status.textContent = '弹出';
      status.style.color = '';
    }
  }

  // 弹出警示弹窗
  var warning = document.createElement('div');
  warning.id = 'p2-shutdown-warning';
  warning.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(220,38,38,0.95);color:white;padding:30px 50px;border-radius:12px;z-index:10000;text-align:center;font-size:18px;font-weight:bold;box-shadow:0 0 40px rgba(220,38,38,0.8);animation:pulse 0.5s infinite alternate;';
  warning.innerHTML = '<div style="font-size:28px;margin-bottom:10px;">⚠ 紧急停机窗口 ⚠</div><div style="font-size:14px;margin-bottom:15px;">弹出3个燃料电池！点击任意一个后开始3秒计时</div><div style="font-size:20px;" id="p2ShutdownTimer">等待中...</div>';
  document.body.appendChild(warning);

  // 添加脉冲动画
  if (!document.getElementById('p2ShutdownStyle')) {
    var style = document.createElement('style');
    style.id = 'p2ShutdownStyle';
    style.textContent = '@keyframes pulse { from { transform: translate(-50%,-50%) scale(1); } to { transform: translate(-50%,-50%) scale(1.05); } }';
    document.head.appendChild(style);
  }
}

function checkP2ShutdownSuccess() {
  if (!DM._p2ShutdownActive) return;

  // 只有在倒计时结束后才检查
  if (DM._p2CountdownStarted && DM._p2CountdownRemaining > 0) return;

  // 检查是否所有燃料电池都已弹出
  var allPopped = DM.fuelCells.every(function(fc) { return !fc.locked; });
  if (allPopped) {
    // 成功
    if (DM._p2CountdownInterval) clearInterval(DM._p2CountdownInterval);
    DM._p2ShutdownActive = false;
    DM._p2CountdownStarted = false;
    var warning = document.getElementById('p2-shutdown-warning');
    if (warning) {
      warning.innerHTML = '<div style="font-size:28px;margin-bottom:10px;">✅ P2停机成功！</div><div style="font-size:14px;">反应堆正在安全停堆...</div>';
      warning.style.background = 'rgba(34,197,94,0.95)';
      setTimeout(function() {
        if (warning && warning.parentNode) warning.parentNode.removeChild(warning);
      }, 2000);
    }
    handleP2ShutdownSuccess();
    // 禁用燃料电池按钮
    for (var i = 0; i < 3; i++) {
      var btn = document.getElementById('fuelBtn' + i);
      var status = document.getElementById('fuelStatus' + i);
      if (btn) {
        btn.style.background = 'rgba(107,114,128,0.5)';
        btn.style.cursor = 'not-allowed';
      }
      if (status) {
        status.textContent = '锁定(禁用)';
        status.style.color = 'var(--text-muted)';
      }
    }
  } else {
    // 失败 - 3秒后未全部弹出，等待P2音乐播完后爆炸
    if (DM._p2CountdownInterval) clearInterval(DM._p2CountdownInterval);
    DM._p2ShutdownActive = false;
    DM._p2CountdownStarted = false;
    DM._p2ShutdownFailed = true; // 标记P2停机失败
    var warning = document.getElementById('p2-shutdown-warning');
    if (warning) {
      warning.innerHTML = '<div style="font-size:28px;margin-bottom:10px;">❌ P2停机失败！</div><div style="font-size:14px;">未能在规定时间内弹出所有燃料电池！</div>';
      warning.style.background = 'rgba(220,38,38,0.95)';
    }
    logMsg('ALRM', '❌ P2停机窗口关闭！未能在规定时间内弹出燃料电池！等待P2音乐播放完毕...');

    // 禁用燃料电池按钮
    for (var i = 0; i < 3; i++) {
      var btn = document.getElementById('fuelBtn' + i);
      var status = document.getElementById('fuelStatus' + i);
      if (btn) {
        btn.style.background = 'rgba(107,114,128,0.5)';
        btn.style.cursor = 'not-allowed';
      }
      if (status) {
        status.textContent = '锁定(禁用)';
        status.style.color = 'var(--text-muted)';
      }
    }
  }
}

function handleP2ShutdownSuccess() {
  logMsg('SCRM', '✅ P2紧急停机成功！反应堆安全停堆！');
  SOUND.stop('P2融毁');
  SOUND.stop('p1代码检测');
  
  // 如果P1成功音乐正在播放,则不要重复播放
  var p1Music = SOUND._cache['P1成功音乐'];
  if (p1Music && !p1Music.paused) {
    logMsg('INFO', 'P1成功音乐已在播放中，跳过重复播放');
  } else {
    SOUND.play('P1成功音乐');
  }

  // 停止融毁效果
  DM._meltdownActive = false;
  DM._meltdownStopped = true;
  DM.meltdownPlaying = false;
  document.body.classList.remove('meltdown');
  stopMeltdownFire();

  // 停止所有反应堆功率
  for (var ui = 0; ui < 4; ui++) {
    var u = RBMK_UNITS[ui];
    u.scrammed = true;
    u.scramTimer = 0;
    for (var i = 0; i < u.RODS.length; i++) {
      if (!u.RODS[i].jammed) { u.RODS[i].targetPos = 100; u.RODS[i].moving = true; }
    }
  }

  // 标记汽轮机需要复位
  DM.TURBINE.resetNeeded = true;
  logMsg('INFO', '⚠ 汽轮机已脱扣，请点击"脱扣复位"按钮重新启动');

  // 播放成功后刷新页面
  if (SOUND._cache['P1成功音乐']) {
    SOUND._cache['P1成功音乐'].onended = function() {
      logMsg('INFO', '✅ 停机完成！可以手动复位汽轮机后重新启动');
    };
  }
}

// === 融毁着火特效（Canvas粒子火焰） ===
var _fire = { particles: [], canvas: null, ctx: null, running: false, frameId: null };
function _initFireCanvas() {
  if (_fire.canvas) return;
  _fire.canvas = document.createElement('canvas');
  _fire.canvas.id = 'fire-overlay';
  document.body.appendChild(_fire.canvas);
  _fire.ctx = _fire.canvas.getContext('2d');
  _fire.canvas.width = window.innerWidth;
  _fire.canvas.height = window.innerHeight;
}
function _fireParticle() {
  var w = window.innerWidth, h = window.innerHeight;
  return {
    x: Math.random() * w, y: h - 20 - Math.random() * h * 0.15,
    vx: (Math.random() - 0.5) * 1.5, vy: -(1.5 + Math.random() * 3),
    size: 4 + Math.random() * 12, life: 1,
    decay: 0.003 + Math.random() * 0.012,
    hue: 15 + Math.random() * 30, sat: 100, lit: 35 + Math.random() * 35,
  };
}
function _updateFire() {
  if (!_fire.running || !_fire.ctx) return;
  var w = window.innerWidth, h = window.innerHeight;
  _fire.ctx.clearRect(0, 0, w, h);
  for (var i = _fire.particles.length - 1; i >= 0; i--) {
    var p = _fire.particles[i];
    p.x += p.vx + (Math.random() - 0.5) * 0.5;
    p.y += p.vy; p.vy -= 0.015;
    p.life -= p.decay; p.size *= 0.997;
    if (p.life <= 0 || p.y < -30) { _fire.particles[i] = _fireParticle(); continue; }
    _fire.ctx.beginPath();
    var g = _fire.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
    g.addColorStop(0, 'hsla(' + p.hue + ',' + p.sat + '%,' + Math.min(98, p.lit + 25) + '%,' + p.life + ')');
    g.addColorStop(0.4, 'hsla(' + (p.hue - 8) + ',' + p.sat + '%,' + p.lit + '%,' + p.life * 0.7 + ')');
    g.addColorStop(1, 'hsla(' + (p.hue - 20) + ',' + p.sat + '%,' + (p.lit - 25) + '%,0)');
    _fire.ctx.fillStyle = g;
    _fire.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    _fire.ctx.fill();
  }
  // 烟雾粒子
  if (Math.random() < 0.3) {
    _fire.particles.push({
      x: Math.random() * w, y: h - 10,
      vx: (Math.random() - 0.5) * 0.8, vy: -(0.3 + Math.random() * 0.5),
      size: 15 + Math.random() * 25, life: 1,
      decay: 0.002 + Math.random() * 0.005,
      hue: 0, sat: 0, lit: 25 + Math.random() * 15,
    });
  }
  _fire.frameId = requestAnimationFrame(_updateFire);
}
function startMeltdownFire() {
  if (_fire.running) return;
  _fire.running = true;
  _initFireCanvas();
  _fire.canvas.style.display = 'block';
  _fire.particles = [];
  for (var i = 0; i < 100; i++) _fire.particles.push(_fireParticle());
  _updateFire();
}
function stopMeltdownFire() {
  _fire.running = false;
  if (_fire.frameId) { cancelAnimationFrame(_fire.frameId); _fire.frameId = null; }
  _fire.particles = [];
  if (_fire.canvas) { _fire.ctx && _fire.ctx.clearRect(0, 0, _fire.canvas.width, _fire.canvas.height); _fire.canvas.style.display = 'none'; }
}

// === 爆炸特效（含黑洞） ===
var explosionOverlay = null;
var _bh = { canvas: null, ctx: null, frameId: null, time: 0, running: false };
function _initBlackHoleCanvas() {
  if (_bh.canvas) return;
  _bh.canvas = document.createElement('canvas');
  _bh.canvas.id = 'blackhole-canvas';
  document.body.appendChild(_bh.canvas);
  _bh.ctx = _bh.canvas.getContext('2d');
  _bh.canvas.width = window.innerWidth;
  _bh.canvas.height = window.innerHeight;
}
function _drawBlackHole(t) {
  var w = _bh.canvas.width, h = _bh.canvas.height;
  var cx = w / 2, cy = h / 2;
  var maxR = Math.sqrt(cx * cx + cy * cy);
  var ctx = _bh.ctx;
  ctx.clearRect(0, 0, w, h);
  // 黑洞半径随时间增长
  var bhRadius = 20 + t * 80;
  var eventHorizonR = Math.min(maxR * 0.35, bhRadius);
  // 吸积盘 — 旋转螺旋
  for (var ring = 0; ring < 6; ring++) {
    var rBase = eventHorizonR * (1.5 + ring * 0.6);
    var rotOff = ring * 0.8 + t * 2;
    var alpha = Math.max(0, 0.3 - ring * 0.04);
    ctx.beginPath();
    for (var a = 0; a < Math.PI * 2; a += 0.05) {
      var spiralR = rBase + Math.sin(a * 3 + rotOff) * rBase * 0.15;
      var x = cx + Math.cos(a) * spiralR;
      var y = cy + Math.sin(a) * spiralR;
      if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    var hue = 20 + ring * 15;
    ctx.fillStyle = 'hsla(' + hue + ', 100%, ' + (50 - ring * 5) + '%, ' + alpha + ')';
    ctx.fill();
  }
  // 引力透镜 — 扭曲环
  for (var l = 0; l < 3; l++) {
    var lr = eventHorizonR * (1.2 + l * 0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, lr, 0, Math.PI * 2);
    ctx.strokeStyle = 'hsla(240, 80%, ' + (70 - l * 15) + '%, ' + (0.15 - l * 0.04) + ')';
    ctx.lineWidth = 2 + l * 1.5;
    ctx.stroke();
  }
  // 事件视界 — 纯黑中心
  var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, eventHorizonR);
  grad.addColorStop(0, '#000');
  grad.addColorStop(0.6, '#000');
  grad.addColorStop(0.85, '#1a0a2e');
  grad.addColorStop(1, 'rgba(30,0,60,0.6)');
  ctx.beginPath();
  ctx.arc(cx, cy, eventHorizonR, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  // 霍金辐射 — 中心微光
  var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, eventHorizonR * 0.3);
  glow.addColorStop(0, 'rgba(200,180,255,0.08)');
  glow.addColorStop(1, 'rgba(200,180,255,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, eventHorizonR * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  // 被吸入粒子
  for (var p = 0; p < 40; p++) {
    var angle = (p / 40) * Math.PI * 2 + t * 0.5;
    var dist = eventHorizonR * (1.2 + Math.sin(p * 1.7 + t * 2) * 0.3);
    var px = cx + Math.cos(angle) * dist;
    var py = cy + Math.sin(angle) * dist;
    ctx.beginPath();
    ctx.arc(px, py, 1 + Math.sin(p + t * 3) * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'hsla(' + (40 + p * 2) + ', 100%, 70%, ' + (0.6 - dist / maxR * 0.5) + ')';
    ctx.fill();
  }
}
function _animateBlackHole() {
  if (!_bh.running) return;
  _bh.time += 0.016;
  _drawBlackHole(_bh.time);
  _bh.frameId = requestAnimationFrame(_animateBlackHole);
}
function triggerExplosionFlash() {
  // 极剧烈震动
  document.body.style.animation = 'meltdownShake 0.04s infinite';
  // 爆炸遮罩
  if (!explosionOverlay) {
    explosionOverlay = document.createElement('div');
    explosionOverlay.id = 'explosion-overlay';
    document.body.appendChild(explosionOverlay);
  }
  explosionOverlay.style.opacity = '1';
  explosionOverlay.style.background = 'radial-gradient(circle, rgba(255,255,200,0.95), rgba(255,150,50,0.85), rgba(200,50,0,0.7))';
  explosionOverlay.style.transition = 'opacity 0.5s';
  // 0.5秒后：白闪消退，黑洞登场
  setTimeout(function() {
    explosionOverlay.style.background = '#ff4400';
    explosionOverlay.style.opacity = '0.7';
    // 启动黑洞Canvas
    _initBlackHoleCanvas();
    _bh.canvas.style.display = 'block';
    _bh.time = 0;
    _bh.running = true;
    _animateBlackHole();
  }, 500);
  // 1.5秒后：黑洞吞噬一切，遮罩渐黑
  setTimeout(function() {
    explosionOverlay.style.background = '#000';
    explosionOverlay.style.opacity = '0.6';
  }, 1500);
  // 2.5秒后：全黑
  setTimeout(function() {
    _bh.running = false;
    if (_bh.frameId) { cancelAnimationFrame(_bh.frameId); _bh.frameId = null; }
    if (_bh.canvas) _bh.canvas.style.display = 'none';
    explosionOverlay.style.background = '#000';
    explosionOverlay.style.opacity = '1';
  }, 2500);
  // 3秒后刷新页面
  setTimeout(function() { location.reload(); }, 3000);
}

// === 日志 ===
function padZ(n) { return (n < 10 ? '0' : '') + n; }
function logMsg(level, text) {
  var log = document.getElementById('alarmLog');
  if (!log) return;
  var t = new Date();
  var hh = padZ(t.getHours()), mm = padZ(t.getMinutes()), ss = padZ(t.getSeconds());
  var entry = document.createElement('div');
  entry.className = 'alarm-entry';
  entry.innerHTML = '<span class="time">' + hh + ':' + mm + ':' + ss + '</span>' +
    '<span class="lvl ' + level + '">' + level + '</span>' +
    '<span>' + text + '</span>';
  log.prepend(entry);
  while (log.children.length > 100) log.removeChild(log.lastChild);
}

// === RBMK 机组工厂 ===
function makeRBMKUnit(id, name) {
  var u = {};
  u.id = id; u.name = name;
  u.scrammed = false; u.scramTimer = 0; u.mode = 'MAN';
  u.REACTOR = {
    thermalPower: 0.0001, neutronFlux: 0,
    rho: -0.05, rho_rods: -0.08, rho_fuel: 0, rho_void: 0, rho_xe: 0, rho_coolant: 0,
    Xe135: 0, I135: 0, avgFuelTemp: 20, peakFuelTemp: 20,
    voidFraction: 0, coreMelted: false, coreInletT: 20, coreOutletT: 20,
  };
  u.RODS = [];
  for (var i = 0; i < 64; i++) {
    var row = Math.floor(i / 8), col = i % 8;
    var isAZ = (row === 4 || col === 4);
    var type = isAZ ? 'AZ' : 'M';
    u.RODS.push({
      id: i+1, row: row, col: col, group: type,
      position: type === 'AZ' ? 0 : 100, targetPos: type === 'AZ' ? 0 : 100,
      moving: false, jammed: false, selected: false,
    });
  }
  u.AUTO = { integral: 0, prevErr: 0, setpoint: 2000 };
  u._pumpMode = 'auto';
  return u;
}

var RBMK_UNITS = [
  makeRBMKUnit(0, 'RBMK-1'),
  makeRBMKUnit(1, 'RBMK-2'),
  makeRBMKUnit(2, 'RBMK-3'),
  makeRBMKUnit(3, 'RBMK-4'),
];
var UNIT_SELECTED = [new Set(), new Set(), new Set(), new Set()];
var UNIT_ANCHOR = [-1, -1, -1, -1];

// === DM 核心 ===
var DM = {
  thermalPower: 0, coreTemp: 20, plasmaDensity: 0,
  annihilationEta: 0, totalNeutronInput: 0, neutronByUnit: [0,0,0,0],
  shutdown: false, _aboveTh: false, _masterMode: 'independent', _dmInt: 0,
  CONV: 1, NEUTRON_THRESHOLD: 50,
  sg_pressure: 0, sg_temp: 20,
  mainSteam: { pressure: 0, temp: 20 },
  DMC: [], DFW: [],
  TURBINE: {
    running: false, tripped: false, rpm: 0, targetRpm: 0,
    generatorOnline: false, genPower: 0, genLoadSet: 0,
    govValveOpen: 0, tripValveOpen: false,
    resetNeeded: false,
  },
  meltdownPlaying: false,
  _meltdownTimer: 0,
  _meltdownActive: false,
  _meltdownStopped: false,
  // === 分P融毁状态 ===
  _scramPhase: 'idle', // idle, detecting, result
  _scramResult: null,  // true=success, false=failure
  _scramCooldown: false, // 防止重复按急停
  // === 燃料电池状态 ===
  fuelCells: [
    { locked: false, popped: false, timer: null },
    { locked: false, popped: false, timer: null },
    { locked: false, popped: false, timer: null },
  ],
  _p2ShutdownActive: false, // P2停机窗口是否激活
  _p2ShutdownTimer: null,   // P2停机倒计时
  _p2CountdownStarted: false, // P2倒计时是否已开始
  _p2CountdownRemaining: 0,   // P2倒计时剩余时间
  _p2CountdownInterval: null, // P2倒计时interval
  _p2ShutdownFailed: false,   // P2停机是否失败
};
(function initDmPumps() {
  for (var i = 0; i < 6; i++) DM.DMC.push({ id:'DMC-'+(i+1), running:false, trip:false, speed:0, targetSpeed:0 });
  for (var j = 0; j < 3; j++) DM.DFW.push({ id:'DFW-'+(j+1), running:false, trip:false, speed:0, targetSpeed:0 });
})();

// === UI 初始化 ===
function initAllUI() {
  for (var ui = 0; ui < 4; ui++) initUnitUI(ui);
  renderDmPumps();
  // 初始化燃料电池状态（默认锁定并禁用）
  for (var i = 0; i < 3; i++) {
    DM.fuelCells[i].locked = true;
    DM.fuelCells[i].popped = false;
    var btn = document.getElementById('fuelBtn' + i);
    var status = document.getElementById('fuelStatus' + i);
    if (btn) {
      btn.className = 'pump-btn';
      btn.style.background = 'rgba(107,114,128,0.5)';
      btn.style.cursor = 'not-allowed';
    }
    if (status) {
      status.textContent = '锁定(禁用)';
      status.style.color = 'var(--text-muted)';
    }
  }
  logMsg('INFO', '界面已初始化，泵控制已加载');
  logMsg('INFO', '⚡ 燃料电池已默认锁定并禁用，P2融毁时才可操作');
}

function initUnitUI(ui) {
  var unit = RBMK_UNITS[ui];
  var grid = document.getElementById('u' + ui + 'rodgrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (var i = 0; i < unit.RODS.length; i++) {
    (function(idx) {
      var rod = unit.RODS[idx];
      var cell = document.createElement('div');
      cell.className = 'rod-cell';
      cell.dataset.idx = idx;
      cell.textContent = rod.group === 'AZ' ? 'Z' : '';
      cell.title = '#' + (idx+1) + ' ' + rod.group;
      cell.addEventListener('click', function(ev) { clickUnitRod(ui, idx, ev); });
      grid.appendChild(cell);
    })(i);
  }
  updateUnitLeverDisplay(ui);
}

function renderDmPumps() {
  try {
    // Update DMC pump buttons
    for (var i = 0; i < DM.DMC.length; i++) {
      var p = DM.DMC[i];
      var on = p.running && !p.trip;
      var btn = document.querySelector('#dmPumpList .pump-row:nth-child(' + (i+1) + ') .pump-btn');
      if (btn) {
        btn.className = 'pump-btn ' + (on ? 'on' : 'off');
        btn.textContent = on ? '▶' : '■';
      }
      var spd = document.getElementById('dmc' + i + 'speed');
      if (spd) spd.textContent = sf(p.speed,0) + '%';
    }
    // Update DFW pump buttons
    for (var j = 0; j < DM.DFW.length; j++) {
      var p2 = DM.DFW[j];
      var on2 = p2.running && !p2.trip;
      var btn2 = document.querySelector('#dmFwpList .pump-row:nth-child(' + (j+1) + ') .pump-btn');
      if (btn2) {
        btn2.className = 'pump-btn ' + (on2 ? 'on' : 'off');
        btn2.textContent = on2 ? '▶' : '■';
      }
      var spd2 = document.getElementById('dfw' + j + 'speed');
      if (spd2) spd2.textContent = sf(p2.speed,0) + '%';
    }
  } catch(e) { logMsg('ERR', 'renderDmPumps: ' + e.message); }
}

function toggleDmPump(kind, idx) {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('toggleDmPump', [kind, idx])) return;
  var arr = kind === 'DMC' ? DM.DMC : DM.DFW;
  var p = arr[idx]; if (!p) return;
  if (p.running && !p.trip) {
    p.running = false; p.targetSpeed = 0;
  } else {
    p.running = true; p.trip = false; p.targetSpeed = 100;
  }
  renderDmPumps();
  logMsg('PUMP', p.id + ' ' + (p.running ? '▶启动' : '■停止') + ' (目标转速 ' + p.targetSpeed + '%)');
}

// === 控制棒交互 ===
function clickUnitRod(ui, idx, ev) {
  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }
  var _mod = { shiftKey: !!(ev && ev.shiftKey), ctrlKey: !!(ev && ev.ctrlKey), metaKey: !!(ev && ev.metaKey) };
  if (!MP.exec('clickUnitRod', [ui, idx, _mod])) return;
  var u = RBMK_UNITS[ui];
  var rod = u.RODS[idx]; if (!rod) return;
  var sel = UNIT_SELECTED[ui];
  if (ev.shiftKey && UNIT_ANCHOR[ui] >= 0) {
    var a = Math.min(UNIT_ANCHOR[ui], idx), b = Math.max(UNIT_ANCHOR[ui], idx);
    for (var i = a; i <= b; i++) sel.add(i);
  } else if (ev.ctrlKey || ev.metaKey) {
    if (sel.has(idx)) sel.delete(idx); else sel.add(idx);
    UNIT_ANCHOR[ui] = idx;
  } else {
    sel.clear(); sel.add(idx);
    UNIT_ANCHOR[ui] = idx;
  }
  var grid = document.getElementById('u' + ui + 'rodgrid');
  if (grid) {
    var cells = grid.children;
    for (var k = 0; k < cells.length; k++) {
      cells[k].classList.toggle('selected', sel.has(parseInt(cells[k].dataset.idx)));
    }
  }
  updateUnitLeverDisplay(ui);
}

function updateUnitLeverDisplay(ui) {
  var sel = UNIT_SELECTED[ui];
  var txt = document.getElementById('u' + ui + 'leverTxt');
  if (!txt) return;
  if (sel.size === 0) { txt.textContent = '—'; return; }
  var u = RBMK_UNITS[ui];
  var sum = 0, n = 0;
  sel.forEach(function(i) { sum += u.RODS[i].position; n++; });
  var avg = n ? sum / n : 0;
  txt.textContent = sf(avg,0) + '%';
  var lv = document.getElementById('u' + ui + 'lever');
  if (lv) lv.value = Math.round(avg);
}

function onUnitLever(ui, v, finalFlag) {
  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }
  if (!MP.exec('onUnitLever', [ui, parseFloat(v), finalFlag])) return;
  if (DM._meltdownActive) return;
  var u = RBMK_UNITS[ui];
  if (u.scrammed) return;
  var target = parseFloat(v);
  var sel = UNIT_SELECTED[ui];
  var lvTxt = document.getElementById('u' + ui + 'leverTxt');
  if (lvTxt) lvTxt.textContent = sf(target,0) + '%';
  if (!finalFlag) return;
  var moved = 0;
  var applySet = (sel && sel.size > 0) ? sel : null;
  for (var i = 0; i < u.RODS.length; i++) {
    if (u.RODS[i].group === 'AZ') continue;
    if (applySet && !applySet.has(i)) continue;
    if (u.RODS[i].jammed) continue;
    u.RODS[i].targetPos = Math.max(0, Math.min(100, target));
    u.RODS[i].moving = true; moved++;
  }
  if (moved > 0) logMsg('INFO', u.name + ' 拉杆 → ' + sf(target,0) + '% (' + moved + '根)');
}

function groupAllRods(ui, pct, az5) {
  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }
  if (!MP.exec('groupAllRods', [ui, pct, az5])) return;
  if (DM._meltdownActive) return;
  var u = RBMK_UNITS[ui];
  if (az5 || pct < 0) {
    if (!u.REACTOR.coreMelted && u.REACTOR.thermalPower <= 2560) {
      logMsg('WARN', u.name + ' AZ-5仅限功率>80%FP或融毁时使用');
      return;
    }
    if (u.REACTOR.coreMelted) {
      var success = Math.random() < 0.5;
      if (success) {
        logMsg('SCRM', '☢ ' + u.name + ' AZ-5紧急停堆成功！');
        u.REACTOR.coreMelted = false; u.scrammed = true; u.scramTimer = 0;
        for (var i = 0; i < u.RODS.length; i++) { if (!u.RODS[i].jammed) { u.RODS[i].targetPos = 100; u.RODS[i].moving = true; } }
        SOUND.play('scram_alert'); SOUND.stop('meltdown');
      } else {
        logMsg('ALRM', '❌ ' + u.name + ' AZ-5停堆失败！');
        SOUND.play('alarm');
      }
      return;
    }
    for (var i = 0; i < u.RODS.length; i++) {
      if (u.RODS[i].jammed) continue;
      u.RODS[i].targetPos = 100; u.RODS[i].moving = true;
    }
    logMsg('SCRM', u.name + ' AZ-5紧急插入');
    return;
  }
  var cnt = 0;
  for (var j = 0; j < u.RODS.length; j++) {
    if (u.RODS[j].group === 'AZ' || u.RODS[j].jammed) continue;
    u.RODS[j].targetPos = Math.max(0, Math.min(100, pct));
    u.RODS[j].moving = true; cnt++;
  }
  logMsg('INFO', u.name + ' 组操作 → ' + pct + '% (' + cnt + '根)');
}

// === SCRAM / 启动 ===
function scramUnit(ui, reason) {
  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }
  if (!MP.exec('scramUnit', [ui, reason])) return;
  var u = RBMK_UNITS[ui];
  if (u.scrammed) return;
  u.scrammed = true; u.scramTimer = 0;
  for (var i = 0; i < u.RODS.length; i++) {
    if (!u.RODS[i].jammed) { u.RODS[i].targetPos = 100; u.RODS[i].moving = true; }
  }
  logMsg('SCRM', '☢ ' + u.name + ' SCRAM! 原因: ' + reason);
  SOUND.play('scram_alert');
}

function startupUnit(ui) {
  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }
  if (!MP.exec('startupUnit', [ui])) return;
  var u = RBMK_UNITS[ui];
  u.scrammed = false;
  u._pumpMode = 'auto';
  // AZ棒缓慢抽出
  for (var k = 0; k < u.RODS.length; k++) {
    if (u.RODS[k].group === 'AZ') { u.RODS[k].targetPos = 0; u.RODS[k].moving = true; }
  }
  logMsg('INFO', '▶ ' + u.name + ' 启动序列开始 (AZ棒抽出中)');
  SOUND.play('startup_sfx');
}

function checkAndGlobalScram() {
  if (!MP.exec('checkAndGlobalScram', [])) return;
  // 仅在融毁进行中且处于melting阶段时才可用
  if (!DM._meltdownActive || DM._scramPhase !== 'melting') {
    logMsg('INFO', '❌ 当前无法使用急停（请等待融毁阶段）');
    return;
  }
  // 冷却保护
  if (DM._scramCooldown) { logMsg('INFO', '❌ 急停按钮已锁定'); return; }

  DM._scramPhase = 'detecting';
  DM._scramCooldown = true;
  var btn = document.getElementById('globalScramBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; btn.textContent = '检测中...'; }

  // 停止融毁音乐，播放检测音乐
  SOUND.stop('P1融毁');
  logMsg('SCRM', '☢ 紧急停堆请求已接收！进入代码检测阶段...');
  SOUND.play('p1代码检测');

  // 检测音乐播放完后揭晓结果并插入所有控制棒
  if (SOUND._cache['p1代码检测']) {
    SOUND._cache['p1代码检测'].onended = function() {
      // 随机判定停机结果 (60%成功, 40%失败)
      DM._scramResult = Math.random() < 0.6;

      if (DM._scramResult) {
        // === 停机成功 ===
        logMsg('SCRM', '✅ 停机成功！反应堆安全停堆！');
        SOUND.stop('p1代码检测');
        SOUND.play('P1成功音乐');

        // 插入所有控制棒
        for (var ui = 0; ui < 4; ui++) {
          var u = RBMK_UNITS[ui];
          for (var i = 0; i < u.RODS.length; i++) {
            if (!u.RODS[i].jammed) { u.RODS[i].targetPos = 100; u.RODS[i].moving = true; }
          }
        }

        // 停止融毁效果
        DM._meltdownActive = false;
        DM._meltdownStopped = true;
        DM.meltdownPlaying = false;
        document.body.classList.remove('meltdown');
        stopMeltdownFire();

        // 安全停堆：所有控制棒插入，功率下降
        for (var ui2 = 0; ui2 < 4; ui2++) {
          var u2 = RBMK_UNITS[ui2];
          u2.scrammed = true; u2.scramTimer = 0;
        }
        DM.shutdown = true;
        // 标记汽轮机需要复位
        DM.TURBINE.resetNeeded = true;
        logMsg('INFO', '⚠ 汽轮机已脱扣，请点击"脱扣复位"按钮重新启动');
        SOUND.stop('machine_loop');

        // 成功音乐播完后提示
        if (SOUND._cache['P1成功音乐']) {
          SOUND._cache['P1成功音乐'].onended = function() {
            logMsg('INFO', '✅ 停机完成！可以手动复位汽轮机后重新启动');
          };
        }
      } else {
        // === 停机失败 ===
        logMsg('ALRM', '❌ 停机失败！控制棒卡住！反应堆将熔毁！');
        SOUND.stop('p1代码检测');
        
        // 等待5秒后播放P2融毁音乐
        logMsg('ALRM', '⏱ 5秒后进入P2融毁阶段...');
        setTimeout(function() {
          SOUND.play('P2融毁');
          DM._scramPhase = 'p2_waiting';
          
          // P2融毁音乐播完后触发P2停机窗口
          if (SOUND._cache['P2融毁']) {
            SOUND._cache['P2融毁'].onended = function() {
              // 100%概率触发P2停机窗口
              logMsg('ALRM', '⚠ P2紧急停机窗口已开启！快速弹出3个燃料电池！');
              triggerP2ShutdownWindow();
            };
          }
        }, 5000);
      }
    };
  }
}

// === DM 汽轮机 ===
function dmTurbineRollUp() {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('dmTurbineRollUp', [])) return;
  if (DM.TURBINE.tripped) { logMsg('WARN', '汽轮机脱扣状态'); return; }
  if (DM.TURBINE.rpm > 500) { logMsg('WARN', '已在冲转'); return; }
  if (DM.mainSteam.pressure < 2.0) { logMsg('WARN', '主蒸汽压力不足 <2.0MPa'); return; }
  DM.TURBINE.running = true; DM.TURBINE.tripValveOpen = true;
  DM.TURBINE.govValveOpen = 10; DM.TURBINE.targetRpm = 3000;
  logMsg('DM', '汽轮机冲转开始 目标3000rpm');
}
function dmTurbineSync() {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('dmTurbineSync', [])) return;
  if (DM._meltdownActive) return;
  if (DM.TURBINE.rpm < 2980 || DM.TURBINE.rpm > 3020) { logMsg('WARN', '转速不在同步范围 2980-3020'); return; }
  if (DM.TURBINE.generatorOnline) return;
  DM.TURBINE.generatorOnline = true;
  logMsg('DM', '✓ 发电机并网');
}
function dmRaiseLoad() {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('dmRaiseLoad', [])) return;
  if (!DM.TURBINE.generatorOnline) return;
  DM.TURBINE.genLoadSet = Math.min(110, DM.TURBINE.genLoadSet + 5);
  document.getElementById('dmLoadSlider').value = DM.TURBINE.genLoadSet;
  document.getElementById('dmLoadSetTxt').textContent = DM.TURBINE.genLoadSet + '%';
}
function dmLowerLoad() {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('dmLowerLoad', [])) return;
  DM.TURBINE.genLoadSet = Math.max(0, DM.TURBINE.genLoadSet - 5);
  document.getElementById('dmLoadSlider').value = DM.TURBINE.genLoadSet;
  document.getElementById('dmLoadSetTxt').textContent = DM.TURBINE.genLoadSet + '%';
}
function setDmLoad(v) {
  if (!MP.canDM()) return;
  if (!MP.exec('setDmLoad', [parseFloat(v)])) return;
  if (!DM.TURBINE.generatorOnline) { document.getElementById('dmLoadSlider').value = 0; return; }
  DM.TURBINE.genLoadSet = parseInt(v);
  document.getElementById('dmLoadSetTxt').textContent = v + '%';
}
function dmTurbineTrip(reason) {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('dmTurbineTrip', [reason])) return;
  DM.TURBINE.tripped = true; DM.TURBINE.running = false;
  DM.TURBINE.tripValveOpen = false; DM.TURBINE.govValveOpen = 0;
  DM.TURBINE.targetRpm = 0; DM.TURBINE.generatorOnline = false;
  DM.TURBINE.genLoadSet = 0; DM.TURBINE.genPower = 0;
  DM.TURBINE.resetNeeded = true;
  document.getElementById('dmLoadSlider').value = 0;
  document.getElementById('dmLoadSetTxt').textContent = '0%';
  logMsg('ALRM', '⚠ 汽轮机脱扣！原因: ' + reason);
  SOUND.play('alarm');
}

function dmTurbineReset() {
  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('dmTurbineReset', [])) return;
  if (!DM.TURBINE.resetNeeded) {
    logMsg('INFO', '汽轮机无需复位');
    return;
  }
  DM.TURBINE.tripped = false;
  DM.TURBINE.running = false;
  DM.TURBINE.tripValveOpen = false;
  DM.TURBINE.govValveOpen = 0;
  DM.TURBINE.targetRpm = 0;
  DM.TURBINE.generatorOnline = false;
  DM.TURBINE.genLoadSet = 0;
  DM.TURBINE.genPower = 0;
  DM.TURBINE.resetNeeded = false;
  DM.TURBINE.rpm = 0;
  document.getElementById('dmLoadSlider').value = 0;
  document.getElementById('dmLoadSetTxt').textContent = '0%';
  logMsg('INFO', '✓ 汽轮机脱扣复位成功，可重新冲转');
}

// === 模式切换 ===
function changeUnitMode(ui) {
  var _mpSel = document.getElementById('u' + ui + 'mode');
  if (!MP.canUnit(ui)) { if (_mpSel) _mpSel.value = (RBMK_UNITS[ui].mode === 'AUTO' ? 'auto' : 'manual');
    MP.toast('该机组由其他操作员负责', 'bad'); return; }
  if (!MP.exec('changeUnitMode', [ui])) return;
  if (DM._meltdownActive) return;
  var sel = document.getElementById('u' + ui + 'mode');
  var inp = document.getElementById('u' + ui + 'setp');
  var v = sel ? sel.value : 'manual';
  var m = v === 'auto' ? 'AUTO' : 'MAN';
  RBMK_UNITS[ui].mode = m;
  RBMK_UNITS[ui].AUTO.integral = 0;
  if (inp && v === 'auto') {
    var sp = parseFloat(inp.value);
    if (!isNaN(sp)) RBMK_UNITS[ui].AUTO.setpoint = Math.max(0, Math.min(3200, sp));
  }
  logMsg('INFO', RBMK_UNITS[ui].name + ' 模式切换: ' + m);
}
function changeDmMasterMode() {
  var _mpSel2 = document.getElementById('dmMasterMode');
  if (!MP.canDM()) { if (_mpSel2) _mpSel2.value = (DM._masterMode === 'cascade' ? 'cascade' : 'independent');
    MP.toast('你当前无法操作共享设备', 'bad'); return; }
  if (!MP.exec('changeDmMasterMode', [])) return;
  if (DM._meltdownActive) return;
  var sel = document.getElementById('dmMasterMode');
  var inp = document.getElementById('dmTargetPw');
  var v = sel ? sel.value : 'independent';
  DM._masterMode = v; DM._dmInt = 0;
  if (inp && v === 'dm_pid') {
    var tp = parseFloat(inp.value);
    if (!isNaN(tp)) DM._targetDmSetpoint = Math.max(0, Math.min(16000, tp));
  }
  logMsg('DM', '主控模式: ' + v);
}

// === 仿真核心 ===
function simStep() {
  if (MP.active && !MP.host) {
    renderUI();
    updateDmPumpSpeeds();
    requestAnimationFrame(simStep);
    return;
  }
  var now = performance.now();
  var dtWall = Math.min(50, now - lastTick);
  lastTick = now;
  if (!SIM.running) { requestAnimationFrame(simStep); return; }
  var dt = (dtWall / 1000) * SIM.speed;
  SIM.time += dt;

  // 1. RBMK物理
  var totalRBMKPower = 0;
  for (var ui = 0; ui < 4; ui++) {
    stepRBMK(ui, dt);
    totalRBMKPower += RBMK_UNITS[ui].REACTOR.thermalPower;
  }

  // 2. DM主控联动
  stepDmMaster(dt);

  // 3. RBMK → DM 中子注入（简化版：RBMK功率达20000MW时提供中子）
  var totalRBMKForDM = 0;
  for (var ui = 0; ui < 4; ui++) {
    var r = RBMK_UNITS[ui].REACTOR;
    // 每台RBMK功率≥20000MW时提供+100°C/min的DM升温
    var contribution = !RBMK_UNITS[ui].scrammed && !DM.shutdown ? (r.thermalPower / 20000) * 100 : 0;
    DM.neutronByUnit[ui] = Math.min(100, contribution);
    totalRBMKForDM += contribution;
  }
  DM.totalNeutronInput = Math.min(400, totalRBMKForDM);

  // 4. DM核心物理（简化：升温直接由RBMK功率决定）
  var DM_HEAT_CAP = 50000;
  // 检查燃料电池锁定状态
  var fuelCellsLocked = DM.fuelCells.every(function(fc) { return fc.locked; });
  var dmFlow = 0;
  for (var pi = 0; pi < DM.DMC.length; pi++) dmFlow += DM.DMC[pi].speed;
  var dmFlowRatio = Math.min(1.5, dmFlow / (DM.DMC.length * 100));
  var dTforCool = Math.max(0, DM.coreTemp - 40);
  DM._removable = (dmFlowRatio * 600000) * dTforCool / 300;
  // 净升温 = RBMK贡献的升温 - 泵冷却
  var heatingRate = fuelCellsLocked ? DM.totalNeutronInput : 0; // 燃料电池未全部锁定时不发热
  DM._netHeat = heatingRate * DM_HEAT_CAP / 60 - DM._removable; // 转换为功率单位
  DM.thermalPower = Math.max(0, fuelCellsLocked ? DM.totalNeutronInput * 50 : 0); // DM功率与升温速率成正比
  DM.annihilationEta = Math.min(100, DM.totalNeutronInput / 4); // 湮灭效率与中子输入成正比
  DM.coreTemp += (heatingRate / 60) * dt - (DM._removable / DM_HEAT_CAP) * dt;
  DM.coreTemp = Math.max(20, DM.coreTemp);
  // 融毁状态：温度不受控暴涨500°C/min
  if (DM._meltdownActive) DM.coreTemp += (500 / 60) * dt;
  var targetRho = Math.min(1.5, DM.totalNeutronInput * 0.22);
  DM.plasmaDensity += (targetRho - DM.plasmaDensity) * Math.min(1, dt/3.5);

  if (!DM._aboveTh && fuelCellsLocked && DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD && !DM.shutdown) {
    logMsg('DM', '✦ 暗物质核心点火成功！Σn = ' + sf(DM.totalNeutronInput,2));
    SOUND.play('resonance');
    SOUND.play('machine_loop');
  }
  // 停止机器循环音效
  if (DM.shutdown) SOUND.stop('machine_loop');
  DM._aboveTh = DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD;

  // 5. DM二回路 — 蒸汽压力由核心温度直接决定 + 泵冷却贡献
  var removed2 = DM._removable || 0;
  var tempBasedPress = Math.max(0, (DM.coreTemp - 40) / 30) * 2; // 40°C→0MPa, 100°C→4MPa, 190°C→10MPa
  var pumpBasedPress = removed2 / 800;
  var sgTargetPress = Math.min(17, tempBasedPress + pumpBasedPress);
  DM.sg_pressure += (sgTargetPress - DM.sg_pressure) * Math.min(1, dt/8);
  DM.sg_temp = 220 + DM.sg_pressure * 21;
  DM.mainSteam.pressure += (DM.sg_pressure - DM.mainSteam.pressure) * Math.min(1, dt/4);
  DM.mainSteam.temp += (DM.sg_temp - DM.mainSteam.temp) * Math.min(1, dt/6);
  if (DM.TURBINE.govValveOpen > 0) DM.mainSteam.pressure *= (1 - DM.TURBINE.govValveOpen/100 * 0.004);
  DM.mainSteam.pressure = Math.max(0.05, DM.mainSteam.pressure);

  // 6. DM泵动态
  for (var i = 0; i < DM.DMC.length; i++) {
    var p = DM.DMC[i];
    if (p.running && !p.trip) p.speed += (p.targetSpeed - p.speed) * Math.min(1, dt/3.5);
    else p.speed += (0 - p.speed) * Math.min(1, dt/8);
    if (p.trip && p.speed < 1) p.trip = false;
  }
  for (var j = 0; j < DM.DFW.length; j++) {
    var p2 = DM.DFW[j];
    if (p2.running && !p2.trip) p2.speed += (p2.targetSpeed - p2.speed) * Math.min(1, dt/3.5);
    else p2.speed += (0 - p2.speed) * Math.min(1, dt/8);
  }

  // 7. DM汽轮机
  if (DM.TURBINE.tripValveOpen) {
    var steamAvail = Math.max(0, Math.min(1, (DM.mainSteam.pressure - 0.5) / 6.0));
    var gov = DM.TURBINE.govValveOpen / 100;
    var steamIn = steamAvail * gov;
    var loadTorque = DM.TURBINE.generatorOnline ? (DM.TURBINE.genLoadSet/100) : 0.002;
    var accel = (steamIn * 1.04 - loadTorque) * 150;
    DM.TURBINE.rpm += accel * dt;
    DM.TURBINE.rpm -= DM.TURBINE.rpm * 0.0002 * dt;
    if (DM.TURBINE.generatorOnline) DM.TURBINE.rpm += (3000 - DM.TURBINE.rpm) * Math.min(1, dt/0.4);
    if (DM.TURBINE.rpm > 3300 && !DM.TURBINE.tripped) dmTurbineTrip('超速 ' + sf(DM.TURBINE.rpm,0) + 'rpm');
    if (!DM.TURBINE.generatorOnline && DM.TURBINE.targetRpm > 0) {
      var rpmErr = DM.TURBINE.targetRpm - DM.TURBINE.rpm;
      var newGov = 10 + Math.max(0, rpmErr/3000)*35 + (Math.abs(rpmErr)>60?7:0);
      DM.TURBINE.govValveOpen += (Math.min(42, newGov) - DM.TURBINE.govValveOpen) * Math.min(1, dt/2.5);
    }
    if (DM.TURBINE.generatorOnline) {
      var tg = 6 + DM.TURBINE.genLoadSet * 0.88;
      DM.TURBINE.govValveOpen += (tg - DM.TURBINE.govValveOpen) * Math.min(1, dt/5);
    }
  } else {
    DM.TURBINE.rpm += (0 - DM.TURBINE.rpm) * Math.min(1, dt/25);
    DM.TURBINE.govValveOpen += (0 - DM.TURBINE.govValveOpen) * Math.min(1, dt/1.5);
  }
  DM.TURBINE.rpm = Math.max(0, DM.TURBINE.rpm);
  if (DM.TURBINE.generatorOnline) {
    var thr = Math.min(1, DM.thermalPower/11000, DM.TURBINE.govValveOpen/90);
    var tgt = 4000 * (DM.TURBINE.genLoadSet/100) * thr;
    DM.TURBINE.genPower += (tgt - DM.TURBINE.genPower) * Math.min(1, dt/8);
  } else {
    DM.TURBINE.genPower += (0 - DM.TURBINE.genPower) * Math.min(1, dt/4);
  }

  // 8. 保护与融毁 — 1000°C触发P1融毁音乐
  if (!DM._meltdownStopped && !DM._meltdownActive && DM.coreTemp > 1000 && DM._scramPhase === 'idle') {
    DM._meltdownActive = true;
    DM.meltdownPlaying = true;
    DM._scramPhase = 'melting'; // 融毁阶段，可以按急停
    document.body.classList.add('meltdown');
    startMeltdownFire();
    SOUND.stop('machine_loop');
    SOUND.play('P1融毁');
    // 设置P1融毁音乐结束事件 — 播完未急停则直接爆炸
    if (SOUND._cache['P1融毁']) {
      SOUND._cache['P1融毁'].onended = function() {
        if (DM._scramPhase === 'melting' && !DM._meltdownStopped) {
          // 用户未在音乐期间按急停，等待5秒后播放P2融毁音乐
          DM._scramPhase = 'p2_waiting';
          logMsg('ALRM', '⚠️ 紧急停堆未响应！5秒后进入P2融毁阶段...');
          setTimeout(function() {
            if (DM._scramPhase === 'p2_waiting' && !DM._meltdownStopped) {
              DM._scramPhase = 'p2_melting';
              DM.meltdownPlaying = true;
              logMsg('ALRM', '☢☢☢ P2融毁阶段启动！暗物质反应堆即将爆炸！');
              SOUND.play('P2融毁');
              // P2融毁阶段100%触发P2停机窗口
              logMsg('ALRM', '🔧 检测到P2停机窗口！快速弹出3个燃料电池！');
              triggerP2ShutdownWindow();
              // P2融毁音乐播完则爆炸
              if (SOUND._cache['P2融毁']) {
                SOUND._cache['P2融毁'].onended = function() {
                  if (DM._scramPhase === 'p2_melting' && !DM._meltdownStopped) {
                    DM._meltdownActive = false;
                    DM._meltdownStopped = true;
                    DM._scramPhase = 'idle';
                    DM.meltdownPlaying = false;
                    logMsg('ALRM', '💥 暗物质反应堆爆炸！');
                    SOUND.play('explosion');
                    SOUND.play('collision');
                    DM.thermalPower = 99999; DM.coreTemp = 9999;
                    document.body.classList.remove('meltdown');
                    stopMeltdownFire();
                    triggerExplosionFlash();
                  }
                };
              }
            }
          }, 5000);
        }
      };
    }
    logMsg('ALRM', '☢☢☢ 暗物质核心超温(>1000°C)！请立即按下紧急停堆！');
  }
  // 温度降至安全范围后清除融毁状态（仅当已通过急停停机成功时）
  if (DM.coreTemp < 500 && DM._meltdownStopped && DM._scramPhase === 'idle') {
    DM._meltdownStopped = false;
    DM._meltdownActive = false;
    DM.meltdownPlaying = false;
    DM._scramCooldown = false;
    document.body.classList.remove('meltdown');
    stopMeltdownFire();
  }

  // 9. UI渲染
  renderUI();
  updateDmPumpSpeeds();
  if (MP.active && MP.host) { MP.tickScore(dt); MP.broadcast(); }
  requestAnimationFrame(simStep);
}

// === RBMK 单步物理 ===
function stepRBMK(ui, dt) {
  var u = RBMK_UNITS[ui];
  var R = u.REACTOR;
  if (u.scrammed) u.scramTimer += dt;

  // 控制棒运动
  for (var i = 0; i < u.RODS.length; i++) {
    var rod = u.RODS[i];
    if (rod.jammed) { rod.moving = false; continue; }
    if (!rod.moving && Math.abs(rod.position - rod.targetPos) < 0.1) continue;
    var rate = rod.group === 'AZ' ? 45 : 10;
    if (u.scrammed) rate = rod.group === 'AZ' ? 80 : 35;
    var diff = rod.targetPos - rod.position;
    var step = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    rod.position += step;
    if (Math.abs(rod.position - rod.targetPos) < 0.1) { rod.position = rod.targetPos; rod.moving = false; }
  }

  var avgIns = 0, nonAz = 0, azSum = 0, azCnt = 0;
  for (var i = 0; i < u.RODS.length; i++) {
    var rod = u.RODS[i];
    if (rod.group !== 'AZ') { avgIns += rod.position; nonAz++; }
    else { azSum += rod.position; azCnt++; }
  }
  avgIns = nonAz ? avgIns / nonAz : 100;
  var azPosNorm = azCnt ? (azSum / azCnt) / 100 : 1;
  R.rho_rods = +0.046 - (avgIns / 100) * 0.080 - azPosNorm * 0.024;

  // 自动泵流量（泵与机组状态联动）
  // 冷却计算：停堆后维持冷却流量，温度可降至室温
  var pumpSpeed = 100; // 持续冷却，不依赖scram状态
  var totalFlow = 16000 * (pumpSpeed / 100);
  var flowRatio = totalFlow / 16000;

  var Tref = 265;
  var pRatio = Math.max(0, R.thermalPower / 3200);
  R.rho_fuel = -0.00012 * (R.avgFuelTemp - Tref);
  R.rho_coolant = 3e-5 * (R.avgFuelTemp - 200);
  var XeProd = 2.0e-5 * pRatio;
  var XeDecay = 2.1e-5 * R.Xe135;
  var XeBurn = 1.5e-4 * R.Xe135 * (0.05 + pRatio*0.95);
  R.Xe135 += (XeProd - XeDecay - XeBurn) * dt;
  R.Xe135 = Math.max(0, Math.min(0.03, R.Xe135));
  R.rho_xe = -R.Xe135;
  var alphaVoid = 0.0025 + 0.01 * pRatio;
  if (R.voidFraction > 40) alphaVoid *= 1.6;
  R.rho_void = alphaVoid * R.voidFraction;
  R.rho = R.rho_rods + R.rho_fuel + R.rho_void + R.rho_xe + R.rho_coolant;

  if (u.scrammed) {
    // 停堆后：按衰变热衰减，绕过反应性反馈（避免空泡正反馈导致功率反弹）
    var decayHeat = 0.06 * 3200 * Math.exp(-u.scramTimer/300);
    R.thermalPower += (decayHeat - R.thermalPower) * Math.min(1, dt/2);
    R.thermalPower = Math.max(1e-7, Math.min(R.thermalPower, decayHeat + 5));
  } else if (R.thermalPower < 0.05 && R.rho < -0.002) {
    R.thermalPower += (0.0001 - R.thermalPower) * Math.min(1, dt/10);
  } else {
    var gamma = 60;
    var rate = R.rho * gamma;
    rate = Math.max(-0.8, Math.min(0.8, rate));
    var factor = Math.exp(rate * dt);
    factor = Math.max(0.70, Math.min(1.3, factor));
    R.thermalPower *= factor;
    R.thermalPower = Math.max(1e-7, R.thermalPower);
    if (R.peakFuelTemp > 2200) R.thermalPower *= Math.max(0.5, 1 - dt*0.2);
  }
  R.neutronFlux = R.thermalPower * 0.05;

  var HEAT_CAP = 25000;
  var coldLegT = Math.max(20, 220 + 25 * pRatio);
  var massKgS = totalFlow / 3.6;
  var cpEff = 4.5 + R.voidFraction * 0.05;
  var dT1 = Math.max(0, R.avgFuelTemp - coldLegT);
  var removable = massKgS * cpEff * dT1 / 1000;
  if (flowRatio < 0.3 && dT1 > 50) removable *= 0.4;
  removable = Math.min(removable, R.thermalPower + 800);
  R.avgFuelTemp += ((R.thermalPower - removable) / HEAT_CAP) * dt;
  R.peakFuelTemp = Math.max(coldLegT+1, R.avgFuelTemp * (1.38 + 0.18 * pRatio) - coldLegT * (0.38 + 0.18 * pRatio));

  var priPress = 6.4 + flowRatio * 0.65;
  var satT = 252 + priPress * 4.75;
  var subCool = satT - (R.avgFuelTemp + (R.avgFuelTemp - coldLegT)*0.6);
  var voidTarget = 0;
  if (subCool < 5) voidTarget = Math.max(0, -subCool * 2.2) + pRatio * 28 - flowRatio * 30;
  voidTarget = Math.max(0, Math.min(98, voidTarget));
  R.voidFraction += (voidTarget - R.voidFraction) * Math.min(1, voidTarget > R.voidFraction ? dt/1.2 : dt/4.5);

  if (R.thermalPower > 2e4) R.thermalPower = 2e4;
  if (!isFinite(R.rho)) R.rho = R.scrammed ? -0.05 : 0;
}

// === DM 主控联动 ===
function stepDmMaster(dt) {
  if (DM._masterMode === 'dm_pid') {
    var target = DM._targetDmSetpoint || 6000;
    var err = target - DM.thermalPower;
    DM._dmInt = (DM._dmInt || 0) + err * dt * 0.00002;
    DM._dmInt = Math.max(-0.5, Math.min(0.5, DM._dmInt));
    var out = 0.5 + err * 0.00008 + DM._dmInt;
    out = Math.max(0.1, Math.min(1.0, out));
    for (var ui = 0; ui < 4; ui++) {
      RBMK_UNITS[ui].AUTO.setpoint = 3200 * out;
      RBMK_UNITS[ui].mode = 'AUTO';
    }
  } else if (DM._masterMode === 'equal') {
    for (var uj = 0; uj < 4; uj++) {
      RBMK_UNITS[uj].AUTO.setpoint = 3200 * 0.7;
      RBMK_UNITS[uj].mode = 'AUTO';
    }
  }
  // RBMK AUTO PID
  for (var uk = 0; uk < 4; uk++) {
    var uu = RBMK_UNITS[uk];
    if (uu.mode !== 'AUTO' || uu.scrammed) continue;
    var sp = typeof uu.AUTO.setpoint === 'number' ? uu.AUTO.setpoint : 2000;
    var pw = Math.max(0.01, uu.REACTOR.thermalPower);
    var err = sp - pw;
    var relErr = err / Math.max(50, sp);
    relErr = Math.max(-1.0, Math.min(1.0, relErr));
    uu.AUTO.integral += relErr * dt * 2.5;
    uu.AUTO.integral = Math.max(-1.0, Math.min(1.0, uu.AUTO.integral));
    var out = relErr * 1.2 + uu.AUTO.integral;
    out = Math.max(-1.8, Math.min(1.8, out));
    var posRateOfChange = -out * 6.0;
    var deltaPos = posRateOfChange * dt;
    deltaPos = Math.max(-8, Math.min(8, deltaPos));
    if (Math.abs(deltaPos) < 0.05) continue;
    for (var ri = 0; ri < uu.RODS.length; ri++) {
      var r = uu.RODS[ri];
      if (r.group === 'AZ' || r.jammed) continue;
      var nt = r.targetPos + deltaPos;
      nt = Math.max(0, Math.min(100, nt));
      if (Math.abs(nt - r.targetPos) >= 0.2) { r.targetPos = nt; r.moving = true; }
    }
  }
}

// === 渲染 UI ===
function renderUI() {
  // === 更新急停按钮状态文本 ===
  var gBtn = document.getElementById('globalScramBtn');
  if (gBtn && !gBtn.disabled) {
    if (DM._scramPhase === 'melting') {
      gBtn.textContent = '☢ 紧急停堆 (点击!)';
      gBtn.style.background = 'rgba(239,68,68,0.8)';
    } else if (DM._scramPhase === 'p2_waiting') {
      gBtn.textContent = 'P2融毁倒计时...';
      gBtn.style.background = 'rgba(220,38,38,0.6)';
    } else if (DM._scramPhase === 'p2_melting') {
      gBtn.textContent = 'P2融毁中...';
      gBtn.style.background = 'rgba(185,28,28,0.8)';
    } else {
      gBtn.textContent = '全局紧急停堆';
      gBtn.style.background = '';
    }
  }

  var totalRBMKPwr = 0;
  var readyCount = 0;
  for (var ui = 0; ui < 4; ui++) {
    var u = RBMK_UNITS[ui];
    var R = u.REACTOR;
    totalRBMKPwr += R.thermalPower;
    if (!u.scrammed && R.thermalPower > 200) readyCount++;

    setTxt('u'+ui+'pw', sf(R.thermalPower,1));
    setTxt('u'+ui+'flux', sf(R.neutronFlux*20,1));
    setTxt('u'+ui+'rho', sf(R.rho*1000,2));
    setTxt('u'+ui+'T', sf(R.avgFuelTemp,0));
    setTxt('u'+ui+'port', sf(R.thermalPower,0) + ' MW');

    var badge = document.getElementById('u'+ui+'state');
    if (badge) {
      if (u.scrammed) { badge.textContent = 'SCRAM'; badge.className = 'badge badge-scram'; }
      else if (R.thermalPower > 100) { badge.textContent = 'POWER'; badge.className = 'badge badge-power'; }
      else if (R.thermalPower > 1) { badge.textContent = 'CRITICAL'; badge.className = 'badge badge-critical'; }
      else { badge.textContent = 'SHUTDOWN'; badge.className = 'badge badge-shutdown'; }
    }

    var card = document.getElementById('unit-'+ui);
    if (card) {
      card.style.borderColor = u.scrammed ? 'var(--accent-red)' : (R.peakFuelTemp > 900 ? 'var(--accent-amber)' : 'var(--border)');
    }

    // Rod grid colors
    var grid = document.getElementById('u' + ui + 'rodgrid');
    if (grid) {
      var cells = grid.children;
      for (var ci = 0; ci < cells.length; ci++) {
        var idx = parseInt(cells[ci].dataset.idx);
        var rod = u.RODS[idx]; if (!rod) continue;
        var pct = rod.position / 100;
        var isSel = UNIT_SELECTED[ui].has(idx);
        cells[ci].classList.toggle('selected', isSel);
        cells[ci].classList.toggle('jammed', rod.jammed);
        if (rod.jammed) continue;
        if (rod.group === 'AZ') {
          cells[ci].style.background = 'rgb(' + Math.round(40+pct*210) + ',' + Math.round(220-Math.floor(pct*180)) + ',60)';
        } else {
          cells[ci].style.background = 'rgb(' + Math.round(30+Math.floor((1-pct)*200)) + ',' + Math.round(100+Math.floor(pct*70)) + ',' + Math.round(210-Math.floor(pct*150)) + ')';
        }
        cells[ci].style.color = pct > 0.5 ? '#fff' : '#111';
      }
    }

    // Lever text sync
    var lvTxt = document.getElementById('u'+ui+'leverTxt');
    if (lvTxt && UNIT_SELECTED[ui].size === 0) {
      // show average of all non-AZ rods
      var sum = 0, cnt = 0;
      for (var ri = 0; ri < u.RODS.length; ri++) {
        if (u.RODS[ri].group !== 'AZ') { sum += u.RODS[ri].position; cnt++; }
      }
      lvTxt.textContent = (cnt ? sf(sum/cnt,0) : '0') + '%';
    }
  }

  setTxt('rbmkStatus', 'RBMK ' + readyCount + '/4');
  setTxt('totalPower', sf(totalRBMKPwr + DM.thermalPower, 0));

  // DM Core
  var dmBall = document.getElementById('dmBall');
  if (dmBall) {
    var active = DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD && !DM.shutdown;
    dmBall.classList.toggle('active', active);
  }
  var dmInner = document.getElementById('dmInner');
  if (dmInner) {
    var scale = 1 + Math.min(2.2, DM.plasmaDensity * 1.9 + DM.annihilationEta*0.016);
    dmInner.style.transform = 'scale(' + sf(scale,2) + ')';
    dmInner.style.opacity = sf(0.35 + Math.min(0.9, DM.annihilationEta*0.011), 2);
    dmInner.style.background = DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD && !DM.shutdown
      ? 'radial-gradient(circle, rgba(255,255,255,0.97) 0%, rgba(124,92,252,0.82) 32%, rgba(70,20,180,0.38) 68%, transparent 100%)'
      : 'radial-gradient(circle, rgba(64,128,255,0.55) 0%, rgba(48,16,96,0.38) 60%, transparent 100%)';
    dmInner.style.boxShadow = DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD && !DM.shutdown
      ? '0 0 40px 12px var(--glow-purple), inset 0 0 30px rgba(255,255,255,0.7)'
      : '0 0 14px 3px rgba(64,128,255,0.25)';
  }
  setTxt('dmDensity', 'ρ ' + sf(DM.plasmaDensity,2));

  setTxt('dmPw', sf(DM.thermalPower,1));
  setTxt('dmN', sf(DM.totalNeutronInput,2));
  setTxt('dmEta', sf(DM.annihilationEta,1));
  setTxt('dmT', sf(DM.coreTemp,0));
  setTxt('dmCool', sf(DM._removable,0));
  setTxt('dmNet', sf(DM._netHeat,0));

  var dmState = document.getElementById('dmState');
  if (dmState) {
    if (DM.shutdown) { dmState.textContent = 'SHUTDOWN'; dmState.className = 'badge badge-shutdown'; }
    else if (DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD) { dmState.textContent = '✦ IGNITED'; dmState.className = 'badge badge-ignited'; }
    else { dmState.textContent = 'STANDBY'; dmState.className = 'badge badge-standby'; }
  }

  var dmDot = document.getElementById('dmStatusDot');
  var dmTxt = document.getElementById('dmStatusText');
  if (dmDot && dmTxt) {
    if (DM.shutdown) { dmDot.className = 'dot dot-red'; dmTxt.textContent = 'DM停堆'; }
    else if (DM.totalNeutronInput >= DM.NEUTRON_THRESHOLD) { dmDot.className = 'dot dot-purple'; dmTxt.textContent = 'DM点火'; }
    else { dmDot.className = 'dot dot-amber'; dmTxt.textContent = 'DM待机'; }
  }

  setTxt('dmRpm', sf(DM.TURBINE.rpm,0));
  setTxt('dmLoad', DM.TURBINE.genLoadSet);
  setTxt('dmMsP', sf(DM.mainSteam.pressure,2));
  setTxt('dmMsT', sf(DM.mainSteam.temp,0));

  var genStatusEl = document.getElementById('dmGenStatus');
  if (genStatusEl) {
    if (DM.TURBINE.tripped) { genStatusEl.textContent = 'TRIPPED'; genStatusEl.className = 'badge badge-scram'; }
    else if (DM.TURBINE.generatorOnline) { genStatusEl.textContent = 'ONLINE ' + sf(DM.TURBINE.genPower,0) + 'MWe'; genStatusEl.className = 'badge badge-power'; }
    else if (DM.TURBINE.rpm > 1000) { genStatusEl.textContent = 'ROLLING ' + sf(DM.TURBINE.rpm,0) + 'rpm'; genStatusEl.className = 'badge badge-critical'; }
    else { genStatusEl.textContent = 'SHUTDOWN'; genStatusEl.className = 'badge badge-shutdown'; }
  }

  var stages = ['dmHp','dmIp','dmLp1','dmLp2','dmGenIcon'];
  stages.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.classList.toggle('running', DM.TURBINE.rpm > 1000);
    }
  });
}

function updateDmPumpSpeeds() {
  // Update DM pump speed text using IDs
  for (var i = 0; i < DM.DMC.length; i++) {
    var p = DM.DMC[i];
    var el = document.getElementById('dmc' + i + 'speed');
    if (el) el.textContent = sf(p.speed,0) + '%';
  }
  for (var j = 0; j < DM.DFW.length; j++) {
    var p2 = DM.DFW[j];
    var el2 = document.getElementById('dfw' + j + 'speed');
    if (el2) el2.textContent = sf(p2.speed,0) + '%';
  }
}

function setTxt(id, v) {
  var el = document.getElementById(id); if (el) el.textContent = v;
}
function sf(v, d) { return (v != null && isFinite(v)) ? v.toFixed(d) : '0'; }

// === 启动（直接启动，不依赖load事件） ===
SIM.running = true; SIM.speed = 1;
// === 开场画面覆盖层 ===
(function() {
  var overlay = document.createElement('div');
  overlay.id = 'intro-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:9999;display:flex;align-items:center;justify-content:center;';
  
  // PLAY 按钮
  var playBtn = document.createElement('div');
  playBtn.id = 'intro-play-btn';
  playBtn.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;';
  playBtn.innerHTML = '<button onclick="startIntro()" style="padding:16px 48px;font-size:24px;font-weight:bold;background:var(--accent-purple);color:#fff;border:none;border-radius:var(--radius-lg);cursor:pointer;box-shadow:0 0 30px var(--glow-purple);transition:all 0.3s;">▶ PLAY</button>';
  
  // 加载画面（只有文字，无进度条）
  var loading = document.createElement('div');
  loading.id = 'intro-loading';
  loading.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;display:none;text-align:center;';
  loading.innerHTML = '<div style="font-size:24px;font-weight:bold;color:#fff;margin-bottom:10px;">加载中...</div>'
    + '<div style="font-size:14px;color:rgba(255,255,255,0.6);">正在启动反应堆系统</div>';

  // 加载指示器：右下角旋转的空心正方形（外框约1cm=38px，边框12px，中间空心14px≈3.7mm）
  var loadSpinner = document.createElement('div');
  loadSpinner.id = 'load-spinner';
  loadSpinner.style.cssText = 'position:fixed;bottom:40px;right:40px;width:38px;height:38px;'
    + 'box-sizing:border-box;border:12px solid #ffffff;background:transparent;z-index:10003;display:none;'
    + 'animation:spin-square 3s linear infinite;';
  var spinStyle = document.createElement('style');
  spinStyle.textContent = '@keyframes spin-square{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}';
  document.head.appendChild(spinStyle);

  // 宣传片页面 = intro.mp4 视频 + intro.ogg 做 BGM
  var promoScreen = document.createElement('div');
  promoScreen.id = 'promo-screen';
  promoScreen.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10001;display:none;background:#000;overflow:hidden;';
  // SKIP 按钮作为宣传片内部元素，保证浮在视频上层、能被点到
  promoScreen.innerHTML = '<video id="promo-video" src="sounds/intro.mp4" preload="auto" playsinline '
    + 'style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;"></video>'
    + '<div id="promo-skip-btn" style="position:absolute;bottom:30px;right:30px;z-index:10;display:none;">'
    + '<button onclick="skipPromo()" style="padding:10px 24px;font-size:14px;background:rgba(0,0,0,0.5);color:#fff;'
    + 'border:1px solid rgba(255,255,255,0.5);border-radius:var(--radius);cursor:pointer;transition:all 0.3s;">SKIP</button>'
    + '</div>';

  overlay.appendChild(playBtn);
  overlay.appendChild(loading);
  document.body.appendChild(overlay);
  document.body.appendChild(promoScreen);
  document.body.appendChild(loadSpinner);

  var _enteredSim = false;
  function enterSim() {
    if (_enteredSim) return;
    _enteredSim = true;
    var pv = document.getElementById('promo-video');
    if (pv) { try { pv.pause(); } catch(e) {} }
    loading.style.display = 'none';
    loadSpinner.style.display = 'none';
    promoScreen.style.display = 'none';
    var sb = document.getElementById('promo-skip-btn');
    if (sb) sb.style.display = 'none';
    overlay.style.display = 'none';
    SOUND.stop('intro');
    SOUND.stop('elevator');
    SIM.running = true; SIM.speed = 1;
    lastTick = performance.now();
    requestAnimationFrame(simStep);
  }

  // 宣传片：intro.mp4 视频 + intro.ogg 做 BGM，播完才进模拟器
  function startPromoScreen() {
    promoScreen.style.display = 'block';
    promoScreen.style.opacity = '1';
    var sb = document.getElementById('promo-skip-btn');
    if (sb) sb.style.display = 'block';

    var video = document.getElementById('promo-video');
    var introAudio = SOUND._cache['intro'];
    var fadedOut = false;

    function fadeOut() {
      if (fadedOut) return;
      fadedOut = true;
      promoScreen.style.transition = 'opacity 0.8s';
      promoScreen.style.opacity = '0';
      setTimeout(enterSim, 800);
    }

    // BGM：intro 音乐
    SOUND.play('intro');

    // 视频：静音循环播放，直到 intro 音乐播完（视频比音乐短也不会中断）
    if (video) {
      video.muted = true;
      video.loop = true;
      video.currentTime = 0;
      var vp = video.play();
      if (vp && vp.catch) vp.catch(function(){});
    }

    // 只有 intro 音乐播完才结束宣传片
    if (introAudio) {
      introAudio.addEventListener('ended', fadeOut, { once: true });
      function scheduleByDuration() {
        var d = introAudio.duration;
        if (isFinite(d) && d > 0) setTimeout(fadeOut, d * 1000);
        else setTimeout(fadeOut, 60000);
      }
      if (introAudio.readyState >= 1) scheduleByDuration();
      else introAudio.addEventListener('loadedmetadata', scheduleByDuration, { once: true });
    } else {
      setTimeout(fadeOut, 60000);
    }
  }

  window.startIntro = function() {
    playBtn.style.display = 'none';
    loading.style.display = 'block';
    loadSpinner.style.display = 'block';

    var elevatorAudio = SOUND._cache['elevator'];
    SOUND.play('elevator');

    var promoStarted = false;
    function goPromo() {
      if (promoStarted) return;
      promoStarted = true;
      loading.style.display = 'none';
      loadSpinner.style.display = 'none';
      SOUND.stop('elevator');
      startPromoScreen();
    }

    if (elevatorAudio) {
      elevatorAudio.addEventListener('ended', goPromo, { once: true });
      // 兜底：电梯音 60 秒内没结束也强制进宣传片
      setTimeout(goPromo, 60000);
    } else {
      setTimeout(goPromo, 3000);
    }
  };

  // 手动跳过宣传片
  window.skipPromo = function() {
    enterSim();
  };

  SIM.running = false;
})();

// === 多人联机初始化 ===
MP.ensureUI();
MP.installHooks();

try { initAllUI(); } catch(e) { console.error('initAllUI:', e); }
lastTick = performance.now();
requestAnimationFrame(simStep);
logMsg('DM', '⚛ 暗物质反应堆模拟器已就绪');
logMsg('INFO', '操作提示: 提控制棒 → 功率上升 → DM核心点火 → 冲转并网');
