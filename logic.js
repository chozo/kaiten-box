// 盤面の判定ロジック（ブラウザとNodeの両方で使う。DOMに依存しない）
(function (root) {
  const N = 6;
  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  // map の記号: # 壁 / H ハムスター / B 箱 / S スイッチ / * スイッチ上の箱 / . 空き
  // exit: 箱の外側のマス（例: {x:6,y:2} は右の壁の2段目の穴）
  function parseLevel(def) {
    const walls = new Set();
    const switches = [];
    const boxes = [];
    let hamster = null;
    def.map.forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c === '#') walls.add(key(x, y));
        if (c === 'H') hamster = { x, y };
        if (c === 'B' || c === '*') boxes.push({ x, y });
        if (c === 'S' || c === '*') switches.push({ x, y });
      });
    });
    return {
      name: def.name,
      walls,
      switches,
      exit: def.exit,
      start: { hamster, boxes, escaped: false },
    };
  }

  function key(x, y) {
    return x + ',' + y;
  }

  function inside(x, y) {
    return x >= 0 && y >= 0 && x < N && y < N;
  }

  function isOpen(level, state) {
    return level.switches.every((s) => state.boxes.some((b) => b.x === s.x && b.y === s.y));
  }

  // 重力を dir に切り替えたときの結果。
  // 戻り値: { state, moves: [{id, from, to, dist, escaped}], moved }
  // id は 'h'（ハムスター）または 'b0','b1'...（箱）
  function applyGravity(level, state, dir) {
    const d = DIRS[dir];
    const open = isOpen(level, state);
    const items = [{ id: 'h', x: state.hamster.x, y: state.hamster.y }];
    state.boxes.forEach((b, i) => items.push({ id: 'b' + i, x: b.x, y: b.y }));
    // 進行方向の先頭から順に動かす
    items.sort((a, b) => (b.x * d.x + b.y * d.y) - (a.x * d.x + a.y * d.y));
    const placed = new Set();
    const result = {};
    const moves = [];
    for (const it of items) {
      let x = it.x;
      let y = it.y;
      let escaped = false;
      for (;;) {
        const nx = x + d.x;
        const ny = y + d.y;
        if (it.id === 'h' && open && nx === level.exit.x && ny === level.exit.y) {
          x = nx;
          y = ny;
          escaped = true;
          break;
        }
        if (!inside(nx, ny) || level.walls.has(key(nx, ny)) || placed.has(key(nx, ny))) break;
        x = nx;
        y = ny;
      }
      if (!escaped) placed.add(key(x, y));
      const dist = Math.abs(x - it.x) + Math.abs(y - it.y);
      result[it.id] = { x, y };
      moves.push({ id: it.id, from: { x: it.x, y: it.y }, to: { x, y }, dist, escaped });
    }
    const next = {
      hamster: result.h,
      boxes: state.boxes.map((_, i) => result['b' + i]),
      escaped: moves.some((m) => m.escaped),
    };
    // この手で扉が開き、ハムスターが扉に押し付けられていれば、そのまま転がり出る
    const hm = moves.find((m) => m.id === 'h');
    if (!next.escaped && !open && isOpen(level, next) &&
        next.hamster.x + d.x === level.exit.x && next.hamster.y + d.y === level.exit.y) {
      hm.lateEscape = { x: level.exit.x, y: level.exit.y };
      next.hamster = { x: level.exit.x, y: level.exit.y };
      next.escaped = true;
    }
    return { state: next, moves, moved: moves.some((m) => m.dist > 0) };
  }

  function stateKey(state) {
    return state.hamster.x + ',' + state.hamster.y + '|' +
      state.boxes.map((b) => b.x + ',' + b.y).sort().join('|');
  }

  // 幅優先探索で最短手数を求める。解けなければ -1
  // bannedFirst: 最初の1手に使えない方向（開始時の無重力では「下」が選べない）
  function solve(level, from, bannedFirst) {
    const start = from || level.start;
    const seen = new Map([[stateKey(start), null]]);
    let frontier = [{ s: start, path: [] }];
    while (frontier.length) {
      const next = [];
      for (const { s, path } of frontier) {
        for (const dir of Object.keys(DIRS)) {
          if (path.length === 0 && dir === bannedFirst) continue;
          const r = applyGravity(level, s, dir);
          if (!r.moved) continue;
          if (r.state.escaped) return { length: path.length + 1, path: [...path, dir] };
          const k = stateKey(r.state);
          if (seen.has(k)) continue;
          seen.set(k, true);
          next.push({ s: r.state, path: [...path, dir] });
        }
      }
      frontier = next;
    }
    return { length: -1, path: null };
  }

  const api = { N, DIRS, parseLevel, applyGravity, isOpen, solve, stateKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HamLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
