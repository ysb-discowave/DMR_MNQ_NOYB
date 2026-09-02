# -*- coding: utf-8 -*-
import io, sys, re

P = r'C:\Users\Yang Sibo\Downloads\sounds等2项文件\index.html'
s = io.open(P, encoding='utf-8').read()
orig = s

def ins(sig, add):
    """在唯一出现的 sig 后面插入 add"""
    global s
    n = s.count(sig)
    if n != 1:
        print('!! MATCH COUNT %d for: %s' % (n, sig[:80]))
        sys.exit(1)
    s = s.replace(sig, sig + '\n' + add)

# ---------- 1. clickUnitRod ----------
ins('function clickUnitRod(ui, idx, ev) {',
    "  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }\n"
    "  var _mod = { shiftKey: !!(ev && ev.shiftKey), ctrlKey: !!(ev && ev.ctrlKey), metaKey: !!(ev && ev.metaKey) };\n"
    "  if (!MP.exec('clickUnitRod', [ui, idx, _mod])) return;")

# ---------- 2. onUnitLever ----------
ins('function onUnitLever(ui, v, finalFlag) {',
    "  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }\n"
    "  if (!MP.exec('onUnitLever', [ui, parseFloat(v), finalFlag])) return;")

# ---------- 3. groupAllRods ----------
ins('function groupAllRods(ui, pct, az5) {',
    "  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }\n"
    "  if (!MP.exec('groupAllRods', [ui, pct, az5])) return;")

# ---------- 4. scramUnit ----------
ins('function scramUnit(ui, reason) {',
    "  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }\n"
    "  if (!MP.exec('scramUnit', [ui, reason])) return;")

# ---------- 5. startupUnit ----------
ins('function startupUnit(ui) {',
    "  if (!MP.canUnit(ui)) { MP.toast('该机组由其他操作员负责', 'bad'); return; }\n"
    "  if (!MP.exec('startupUnit', [ui])) return;")

# ---------- 6. checkAndGlobalScram（全局急停，所有玩家可用）----------
ins('function checkAndGlobalScram() {',
    "  if (!MP.exec('checkAndGlobalScram', [])) return;")

# ---------- 7. DM 汽轮机 ----------
ins('function dmTurbineRollUp() {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('dmTurbineRollUp', [])) return;")
ins('function dmTurbineSync() {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('dmTurbineSync', [])) return;")
ins('function dmRaiseLoad() {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('dmRaiseLoad', [])) return;")
ins('function dmLowerLoad() {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('dmLowerLoad', [])) return;")
ins('function setDmLoad(v) {',
    "  if (!MP.canDM()) return;\n"
    "  if (!MP.exec('setDmLoad', [parseFloat(v)])) return;")
ins('function dmTurbineTrip(reason) {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('dmTurbineTrip', [reason])) return;")
ins('function dmTurbineReset() {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('dmTurbineReset', [])) return;")

# ---------- 8. changeUnitMode（被拒时回滚下拉框）----------
ins('function changeUnitMode(ui) {',
    "  var _mpSel = document.getElementById('u' + ui + 'mode');\n"
    "  if (!MP.canUnit(ui)) { if (_mpSel) _mpSel.value = (RBMK_UNITS[ui].mode === 'AUTO' ? 'auto' : 'manual');\n"
    "    MP.toast('该机组由其他操作员负责', 'bad'); return; }\n"
    "  if (!MP.exec('changeUnitMode', [ui])) return;")

# ---------- 9. changeDmMasterMode ----------
ins('function changeDmMasterMode() {',
    "  var _mpSel2 = document.getElementById('dmMasterMode');\n"
    "  if (!MP.canDM()) { if (_mpSel2) _mpSel2.value = (DM._masterMode === 'cascade' ? 'cascade' : 'independent');\n"
    "    MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('changeDmMasterMode', [])) return;")

# ---------- 10. toggleFuelCell ----------
ins('function toggleFuelCell(idx) {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('toggleFuelCell', [idx])) return;")

# ---------- 11. toggleDmPump ----------
ins('function toggleDmPump(kind, idx) {',
    "  if (!MP.canDM()) { MP.toast('你当前无法操作共享设备', 'bad'); return; }\n"
    "  if (!MP.exec('toggleDmPump', [kind, idx])) return;")

# ---------- 12. simStep：客户端只渲染 / 房主计分广播 ----------
ins('function simStep() {\n  var now = performance.now();',
    "  if (MP.active && !MP.host) {\n"
    "    renderUI();\n"
    "    updateDmPumpSpeeds();\n"
    "    requestAnimationFrame(simStep);\n"
    "    return;\n"
    "  }\n"
    "  var now = performance.now();")

old_tail = ("  // 9. UI渲染\n"
            "  renderUI();\n"
            "  updateDmPumpSpeeds();\n"
            "  requestAnimationFrame(simStep);\n"
            "}")
new_tail = ("  // 9. UI渲染\n"
            "  renderUI();\n"
            "  updateDmPumpSpeeds();\n"
            "  if (MP.active && MP.host) { MP.tickScore(dt); MP.broadcast(); }\n"
            "  requestAnimationFrame(simStep);\n"
            "}")
if s.count(old_tail) != 1:
    print('!! simStep tail match count =', s.count(old_tail))
    sys.exit(1)
s = s.replace(old_tail, new_tail)

# ---------- 13. 广播时顺便节流刷新排名面板 ----------
ins("  snap.pl = MP.packScores();\n  MP.send({ type: 'snapshot', snap: snap });",
    "  var _pn = Date.now();\n"
    "  if (_pn - (MP._panelAt || 0) > 500) { MP._panelAt = _pn; MP.renderPanel(); }")

# ---------- 14. 客户端收到分数后节流刷新面板 ----------
ins("""        MP.players[k].energy = s.pl[k][0]; MP.players[k].scrams = s.pl[k][1]; MP.players[k].melts = s.pl[k][2];
      }
    }
  }""",
    """        MP.players[k].energy = s.pl[k][0]; MP.players[k].scrams = s.pl[k][1]; MP.players[k].melts = s.pl[k][2];
      }
    }
    var _cn = Date.now();
    if (_cn - (MP._panelAt || 0) > 500) { MP._panelAt = _cn; MP.renderPanel(); }
  }""")

# ---------- 15. 初始化 ----------
init_sig = "  SIM.running = false;\n})();"
if s.count(init_sig) != 1:
    print('!! init anchor count =', s.count(init_sig))
    sys.exit(1)
s = s.replace(init_sig, init_sig + "\n\n// === 多人联机初始化 ===\nMP.ensureUI();\nMP.installHooks();")

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('OK, patched. delta =', len(s) - len(orig))
