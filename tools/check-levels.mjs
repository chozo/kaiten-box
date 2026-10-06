// 全ステージが解けるか、基準手数、行き詰まり（そこから解けない状態）の割合を表示する
import vm from 'node:vm';
import fs from 'node:fs';
const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['../logic.js', '../levels.js']) vm.runInContext(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), sandbox);
const L = sandbox.HamLogic;
let ok = true;
for (const [i, def] of sandbox.window.LEVEL_DEFS.entries()) {
  const lv = L.parseLevel(def);
  const r = L.solve(lv, null, 'down'); // 最初の1手に「下」は使えない（▼ボタンなし）
  const seen = new Map([[L.stateKey(lv.start), lv.start]]);
  const q = [lv.start];
  while (q.length) {
    const st = q.shift();
    for (const d of Object.keys(L.DIRS)) {
      const n = L.applyGravity(lv, st, d);
      if (!n.moved || n.state.escaped) continue;
      const k = L.stateKey(n.state);
      if (!seen.has(k)) { seen.set(k, n.state); q.push(n.state); }
    }
  }
  let dead = 0;
  for (const st of seen.values()) if (L.solve(lv, st, st === lv.start ? 'down' : null).length < 0) dead++;
  console.log(`ステージ${i + 1}「${def.name}」 最短${r.length}手 解答: ${r.path ? r.path.join(' ') : 'なし'} / 到達状態${seen.size} 行き詰まり${dead}`);
  if (r.length < 1) ok = false;
}
process.exit(ok ? 0 : 1);
