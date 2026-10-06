// 回転ボックス — 描画・演出・入力
(() => {
  'use strict';

  // ---- 調整値 ----
  const CONFIG = {
    rotIn: 0.24, // 箱を回して重力方向を下に向ける時間（秒）
    downHop: 0.14, // 回さずに重力をかけるとき（最初の▼）の小さな跳ね
    undoTurn: 0.2, // 戻すときに箱の向きを戻す時間
    gravity: 64, // 落下の加速度（マス/秒^2）
    squashDecay: 13,
    squashFreq: 34,
    partyAt: 0.9, // 最後の面を脱出してから、お祝いが始まるまで
    clearHold: 1.0, // 脱出してから箱が退場し始めるまで
    slideOut: 0.38, // 箱が左へ退場する時間
    slideIn: 0.6, // 次の箱が右から入ってくる時間
    swipeMin: 22, // スワイプとみなす最小距離（px）
    maxDpr: 2,
  };

  const L = window.HamLogic;
  const DEFS = window.LEVEL_DEFS;
  const DIR_V = L.DIRS;
  // ハムスターの足が重力方向を向く角度（盤面座標・時計回りが正）
  const GRAV_ANGLE = { down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2 };
  // 画面上の方向に倒すときの箱の回転量（▼は回さない）
  const SCREEN_DELTA = { down: 0, left: -Math.PI / 2, right: Math.PI / 2, up: Math.PI };
  // 方向を angle だけ回した方向（90度単位）
  function rotDir(dir, angle) {
    const v = DIR_V[dir];
    const c = Math.round(Math.cos(angle));
    const s = Math.round(Math.sin(angle));
    const x = v.x * c - v.y * s;
    const y = v.x * s + v.y * c;
    return Object.keys(DIR_V).find((k) => DIR_V[k].x === x && DIR_V[k].y === y);
  }

  const levels = DEFS.map((def) => {
    const lv = L.parseLevel(def);
    lv.par = L.solve(lv, null, 'down').length; // ▼はないので、最初の1手に「下」は使えない
    return lv;
  });

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const cv = $('cv');
  let ctx = cv.getContext('2d'); // お祝いの演出では一時的に fx に切り替える
  const fxCanvas = $('fx');
  const fx = fxCanvas.getContext('2d'); // 紙吹雪・花火・フラッシュ（カードの手前）
  const fxBackCanvas = $('fx-back');
  const fxb = fxBackCanvas.getContext('2d'); // 光の筋・ハムスター（カードの後ろ）
  const app = $('app');
  const wrap = $('stage-wrap');
  const ui = {
    hud: $('hud'),
    stage: $('hud-stage'),
    moves: $('hud-moves'),
    par: $('hud-par'),
    stageName: $('stage-name'),
    undo: $('btn-undo'),
    reset: $('btn-reset'),
    title: $('title'),
    result: $('result'),
    toast: $('toast'),
  };

  // ---- ゲーム状態 ----
  const game = {
    screen: 'title', // title | play | result
    stageIdx: 0,
    level: null,
    state: null,
    gravity: null, // null は無重力（開始直後）
    moves: 0,
    history: [], // 戻すための履歴（何回でも戻せる）
    best: {}, // ステージごとの最少手数（このブラウザに保存）
    anim: null,
    bump: null,
    queued: null,
    preview: null, // { dir, result }
    pendingClear: false,
    clearing: null,
    enter: null, // 次の箱が入ってくる演出
    party: null, // 全クリアのお祝い
    clock: 0,
    boxAngle: 0, // 描画中の箱の角度
    restAngle: 0, // 落ち着いたときの箱の角度（回したまま残る）
    angleTween: null,
    jolt: { x: 0, y: 0 },
    doorAmt: 0, // 0 閉 → 1 開
    doorTarget: 0,
    vis: {}, // 表示用の位置・傾き・つぶれ
    particles: [],
    floaters: [],
  };
  let manual = false;

  // ---- 自己ベストの保存 ----
  const BEST_KEY = 'hako-hamster-best-v2'; // ステージを作り直したら番号を上げる
  function loadBest() {
    try {
      return JSON.parse(localStorage.getItem(BEST_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveBest() {
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(game.best));
    } catch {
      // 保存できない環境では記録を残さないだけ
    }
  }
  game.best = loadBest();

  // ---- 途中のステージの保存（つづきから） ----
  const PROGRESS_KEY = 'hako-hamster-progress';
  function loadProgress() {
    try {
      const v = Number(localStorage.getItem(PROGRESS_KEY));
      return Number.isInteger(v) && v > 0 && v < levels.length ? v : null;
    } catch {
      return null;
    }
  }
  function saveProgress(i) {
    try {
      if (i == null || i <= 0) localStorage.removeItem(PROGRESS_KEY);
      else localStorage.setItem(PROGRESS_KEY, String(i));
    } catch {
      // 保存できない環境では「つづきから」が出ないだけ
    }
  }

  // ---- 音（Web Audio で合成） ----
  const sfx = (() => {
    let ac = null;
    let master = null;
    let noiseBuf = null;
    // 書き出し時は、記録した時刻を tBase に入れて鳴らし直す
    let tBase = 0;
    let rec = null; // 撮影中の記録 { clock, events }
    const now = () => ac.currentTime + tBase;
    function makeNoise(ctx) {
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return b;
    }
    function ensure() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.7;
        master.connect(ac.destination);
        noiseBuf = makeNoise(ac);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function tone(type, f0, f1, dur, gain, delay = 0) {
      if (!ac) return;
      const t = now() + delay;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    function noise(dur, f0, f1, q, gain, delay = 0) {
      if (!ac) return;
      const t = now() + delay;
      const s = ac.createBufferSource();
      s.buffer = noiseBuf;
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(master);
      s.start(t, Math.random() * 0.5);
      s.stop(t + dur + 0.02);
    }
    const sounds = {
      whoosh(up) {
        noise(0.26, up ? 1500 : 380, up ? 380 : 1500, 1.2, 0.09);
      },
      // 落下距離が長いほど低く重い音。chain は同じ手の中で何番目の着地か
      land(kind, dist, chain) {
        const step = 1 + chain * 0.07;
        const k = Math.min(1, 0.45 + dist * 0.12);
        if (kind === 'h') {
          const f = (980 - dist * 70) * step;
          tone('sine', f, f * 0.62, 0.11, 0.16 * k);
          tone('sine', 150 - dist * 8, 70, 0.12, 0.22 * k);
        } else {
          const f = (330 - dist * 28) * step;
          tone('triangle', f, f * 0.7, 0.13, 0.32 * k);
          noise(0.06, 2400, 900, 1.5, 0.16 * k);
          tone('sine', 110 - dist * 6, 50, 0.15, 0.3 * k);
        }
      },
      bump() {
        tone('sine', 140, 80, 0.1, 0.18);
      },
      click() {
        tone('square', 1900, 1500, 0.03, 0.05);
        tone('sine', 880, 1320, 0.12, 0.12, 0.02);
      },
      door(open) {
        tone('sawtooth', open ? 180 : 360, open ? 380 : 170, 0.22, 0.05);
        if (open) [660, 990].forEach((f, i) => tone('triangle', f, f, 0.12, 0.08, 0.12 + i * 0.07));
      },
      clear() {
        [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f * 1.01, 0.2, 0.16, i * 0.08));
        tone('sine', 1568, 1568, 0.35, 0.08, 0.34);
      },
      undo() {
        noise(0.18, 1400, 500, 1.2, 0.07);
      },
      start() {
        tone('triangle', 660, 990, 0.15, 0.12);
      },
      fanfare() {
        const seq = [523, 659, 784, 1047];
        seq.forEach((f, i) => tone('triangle', f, f, 0.16, 0.16, i * 0.1));
        [523, 659, 784, 1047, 1319].forEach((f) => tone('triangle', f, f * 1.005, 1.1, 0.07, 0.42));
        [262, 392].forEach((f) => tone('sine', f, f, 1.0, 0.12, 0.42));
        noise(0.5, 3000, 6000, 0.6, 0.05, 0.42);
      },
      pop() {
        noise(0.35, 1400, 200, 0.8, 0.12);
        tone('sine', 90, 40, 0.25, 0.18);
        noise(0.6, 5000, 3000, 2, 0.03, 0.12);
      },
      star(i) {
        const f = 880 * Math.pow(2, (i * 2) / 12);
        tone('triangle', f, f * 1.5, 0.12, 0.13);
        tone('sine', f * 2, f * 2, 0.25, 0.05, 0.05);
      },
      row() {
        tone('sine', 520, 520, 0.06, 0.06);
      },
      chime() {
        [1047, 1319, 1568, 2093].forEach((f, i) => tone('triangle', f, f, 0.5, 0.09, i * 0.06));
      },
      slide() {
        noise(0.34, 1800, 500, 0.9, 0.08);
      },
      thud() {
        tone('sine', 120, 55, 0.18, 0.3);
        noise(0.08, 900, 400, 1.2, 0.12);
      },
    };

    // 撮影用のBGM（軽いキック・ハイハット・ベース・きらきら）
    function beat(from, to, bpm) {
      const spb = 60 / bpm;
      const bass = [131, 131, 98, 110, 87, 87, 98, 98];
      const arp = [523, 659, 784, 659, 587, 698, 880, 698];
      let k = 0;
      for (let t = from; t < to; t += spb / 2, k++) {
        tBase = t;
        if (k % 2 === 0) tone('sine', 140, 45, 0.18, 0.22);
        else noise(0.05, 7000, 6000, 1.5, 0.025);
        if (k % 2 === 0) {
          const f = bass[Math.floor(k / 4) % bass.length];
          tone('triangle', f, f, spb * 0.9, 0.08);
        }
        const a = arp[k % arp.length];
        tone('triangle', a * 2, a * 2, 0.12, 0.022);
      }
      tBase = 0;
    }

    const api = {
      ensure,
      // 撮影中は鳴らさずに、動画の時刻つきで記録する
      record(clock) {
        rec = clock ? { clock, events: [] } : null;
      },
      takeRecording() {
        return rec ? rec.events.slice() : [];
      },
      // 記録した効果音（と BGM）を OfflineAudioContext で書き出し、16bit WAV（base64）で返す
      async renderOffline(events, duration, opt = {}) {
        const sr = 44100;
        const off = new OfflineAudioContext(2, Math.ceil(sr * duration), sr);
        const keep = { ac, master, noiseBuf };
        ac = off;
        master = off.createGain();
        master.gain.value = 0.7;
        master.connect(off.destination);
        noiseBuf = makeNoise(off);
        for (const ev of events) {
          tBase = ev.t;
          sounds[ev.name](...ev.args);
        }
        tBase = 0;
        if (opt.beat) beat(opt.beat.from, opt.beat.to, opt.beat.bpm);
        const buf = await off.startRendering();
        ({ ac, master, noiseBuf } = keep);
        const n = buf.length;
        const out = new DataView(new ArrayBuffer(44 + n * 4));
        const str = (o, t) => [...t].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
        str(0, 'RIFF');
        out.setUint32(4, 36 + n * 4, true);
        str(8, 'WAVEfmt ');
        out.setUint32(16, 16, true);
        out.setUint16(20, 1, true);
        out.setUint16(22, 2, true);
        out.setUint32(24, sr, true);
        out.setUint32(28, sr * 4, true);
        out.setUint16(32, 4, true);
        out.setUint16(34, 16, true);
        str(36, 'data');
        out.setUint32(40, n * 4, true);
        const L0 = buf.getChannelData(0);
        const R0 = buf.getChannelData(1);
        for (let i = 0; i < n; i++) {
          out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L0[i])) * 32767, true);
          out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R0[i])) * 32767, true);
        }
        let bin = '';
        const bytes = new Uint8Array(out.buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      },
    };
    for (const name of Object.keys(sounds)) {
      api[name] = (...args) => {
        if (rec) {
          rec.events.push({ name, args, t: rec.clock() });
          return;
        }
        sounds[name](...args);
      };
    }
    return api;
  })();

  // ---- 補助 ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOutBack = (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
  function ids(state) {
    return ['h', ...state.boxes.map((_, i) => 'b' + i)];
  }
  function posOf(state, id) {
    return id === 'h' ? state.hamster : state.boxes[+id.slice(1)];
  }
  function onSwitch(level, p) {
    return level.switches.some((s) => s.x === p.x && s.y === p.y);
  }

  function syncVis() {
    game.vis = {};
    for (const id of ids(game.state)) {
      const p = posOf(game.state, id);
      game.vis[id] = {
        x: p.x,
        y: p.y,
        angle: game.gravity ? GRAV_ANGLE[game.gravity] : 0,
        sq: null,
        alpha: 1,
        falling: false,
        dizzy: 0,
      };
    }
  }

  function toast(text, mid) {
    ui.toast.textContent = text;
    ui.toast.classList.toggle('mid', !!mid);
    ui.toast.classList.remove('show');
    void ui.toast.offsetWidth;
    ui.toast.classList.add('show');
  }

  // ---- 進行 ----
  // 1面から、または「つづきから」で途中の面から始める（ステージ選択はなし）
  function startGame(i = 0) {
    stopParty();
    sfx.ensure();
    sfx.start();
    game.screen = 'play';
    ui.title.hidden = true;
    ui.result.hidden = true;
    loadStage(i);
  }

  function showTitle() {
    stopParty();
    game.screen = 'title';
    game.preview = null;
    setHeld(null);
    renderTitle();
    ui.result.hidden = true;
    ui.title.hidden = false;
  }

  function renderTitle() {
    const p = loadProgress();
    const cont = $('btn-continue');
    const start = $('btn-start');
    cont.hidden = p == null;
    if (p != null) cont.innerHTML = `つづきから<small>ステージ ${p + 1} から</small>`;
    start.textContent = p == null ? 'はじめる' : 'はじめから';
    start.classList.toggle('alt', p != null);
  }

  function loadStage(i) {
    saveProgress(i);
    game.stageIdx = i;
    game.level = levels[i];
    game.state = cloneState(game.level.start);
    game.gravity = null;
    game.moves = 0;
    game.history = [];
    game.anim = null;
    game.bump = null;
    game.queued = null;
    game.preview = null;
    game.pendingClear = false;
    game.clearing = null;
    game.enter = null;
    game.boxAngle = 0;
    game.restAngle = 0;
    game.angleTween = null;
    game.doorAmt = game.doorTarget = L.isOpen(game.level, game.state) ? 1 : 0;
    game.particles = [];
    syncVis();
    updateHud(true);
  }

  function cloneState(s) {
    return { hamster: { ...s.hamster }, boxes: s.boxes.map((b) => ({ ...b })), escaped: s.escaped };
  }

  function canAct() {
    return game.screen === 'play' && !game.pendingClear && !game.clearing && !game.enter;
  }

  // 次の手を受け付けられるか（落下が終わって正立に戻る途中なら受け付ける）
  function animBusy() {
    const a = game.anim;
    return a && a.t < a.fallEnd;
  }

  // 画面上の方向 → 盤面の方向（箱は回ったままなので、見えている向きで操作する）
  const toGrid = (sdir) => rotDir(sdir, -game.restAngle);
  const toScreen = (gdir) => rotDir(gdir, game.restAngle);
  function commitScreen(sdir) {
    commit(toGrid(sdir));
  }

  // dir は盤面の方向
  function commit(dir) {
    if (!canAct()) return;
    if (animBusy()) {
      game.queued = dir;
      return;
    }
    const r = L.applyGravity(game.level, game.state, dir);
    if (!r.moved) {
      game.bump = { dir: toScreen(dir), t: 0 };
      sfx.bump();
      return;
    }
    game.history.push({ state: game.state, gravity: game.gravity, moves: game.moves, restAngle: game.restAngle });
    const delta = SCREEN_DELTA[toScreen(dir)];
    game.state = r.state;
    game.gravity = dir;
    game.moves++;
    if (r.state.escaped) game.pendingClear = true;
    const R1 = delta === 0 ? CONFIG.downHop : CONFIG.rotIn;
    let chainOrder = 0;
    const moves = r.moves.map((m) => ({
      ...m,
      landT: Math.sqrt((2 * m.dist) / CONFIG.gravity),
      landed: m.dist === 0,
    }));
    const landMax = Math.max(...moves.filter((m) => !m.escaped).map((m) => m.landT));
    for (const m of moves) if (m.lateEscape) m.escapeAt = landMax + 0.28; // 扉が開くのを待ってから出る
    const fallDur = Math.max(
      landMax,
      ...moves.map((m) => (m.escaped ? m.landT + 0.45 : m.lateEscape ? m.escapeAt + 0.6 : 0)),
    );
    game.anim = {
      dir,
      t: 0,
      R1,
      delta,
      startAngle: game.boxAngle,
      target: game.restAngle + delta,
      doorAt: R1 + landMax,
      fallEnd: R1 + fallDur,
      end: R1 + fallDur,
      moves,
      chain: () => chainOrder++,
    };
    game.restAngle = game.anim.target;
    game.angleTween = null;
    for (const id of Object.keys(game.vis)) game.vis[id].sq = null;
    game.preview = null;
    if (delta !== 0) sfx.whoosh(Math.abs(delta) > 2);
    updateHud();
  }

  function undo() {
    if (!canAct() || !game.history.length) return;
    const h = game.history.pop();
    game.state = h.state;
    game.gravity = h.gravity;
    game.moves = h.moves;
    game.anim = null;
    game.queued = null;
    // 箱の向きも短く回して戻す
    game.angleTween = { from: game.boxAngle, to: h.restAngle, t: 0 };
    game.restAngle = h.restAngle;
    game.doorTarget = L.isOpen(game.level, game.state) ? 1 : 0;
    syncVis();
    for (const v of Object.values(game.vis)) v.sq = { t0: game.clock, k: 0.5 };
    sfx.undo();
    updateHud();
  }

  function reset() {
    if (!canAct()) return;
    loadStage(game.stageIdx);
    sfx.undo();
    updateHud();
  }

  function stageCleared() {
    const lv = game.level;
    const i = game.stageIdx;
    const shortest = game.moves <= lv.par;
    if (game.best[i] == null || game.moves < game.best[i]) {
      game.best[i] = game.moves;
      saveBest();
    }
    // 次の面を保存しておく（クリア演出の途中で閉じても進んだ扱い）。最後の面なら消す
    saveProgress(i + 1 < levels.length ? i + 1 : null);
    game.clearing = { t: 0 };
    sfx.clear();
    toast(shortest ? `脱出！ ${game.moves}手で最短クリア★` : `脱出！ ${game.moves}手（最短は${lv.par}手）`, true);
    spawnConfetti();
    updateHud();
  }

  // 最終ステージを抜けたときの画面。各ステージの自己ベストを並べる
  function showAllClear() {
    game.screen = 'result';
    game.preview = null;
    const stars = levels.map((lv, i) => game.best[i] != null && game.best[i] <= lv.par);
    $('res-title').innerHTML = [...'ぜんぶ脱出！'].map((ch, i) => `<span style="--i:${i}">${ch}</span>`).join('');
    $('res-list').innerHTML = levels
      .map((lv, i) => {
        const b = game.best[i];
        const mark = stars[i] ? `<span class="star" style="--i:${i}">★ 最短</span>` : `最短 ${lv.par}手`;
        return `<li style="--i:${i}"><span>ステージ${i + 1}　ベスト ${b == null ? '―' : b + '手'}</span>${mark}</li>`;
      })
      .join('');
    const n = stars.filter(Boolean).length;
    const summary = $('res-summary');
    summary.textContent = n === levels.length ? `★ ${n}/${levels.length} ぜんぶ最短！` : `最短クリア ★ ${n}/${levels.length}`;
    const summaryAt = 1.1 + levels.length * 0.28 + 0.2;
    summary.style.setProperty('--d', summaryAt + 's');
    ui.result.classList.add('party');
    ui.toast.classList.remove('show');
    ui.result.hidden = false;
    startParty(stars, summaryAt);
  }

  // ---- 全クリアのお祝い（紙吹雪・花火・跳ねるハムスター） ----
  const PARTY_COLORS = ['#f2944f', '#3fae5a', '#f7d046', '#7fb2e5', '#f7a8a8', '#e2533a', '#b48be0'];
  function startParty(stars, summaryAt) {
    const P = { t: 0, stars, summaryAt, played: 0, summaryPlayed: false, nextFw: 0.25, confetti: [], sparks: [] };
    game.party = P;
    const w = fxW;
    const h = fxH;
    // 左右の下から紙吹雪の大砲
    for (const side of [0, 1]) {
      for (let i = 0; i < 70; i++) {
        const a = (side ? -Math.PI * 0.62 : -Math.PI * 0.38) + (Math.random() - 0.5) * 0.5;
        const sp = h * (0.9 + Math.random() * 0.8);
        P.confetti.push(makeConfetti(side ? w + 10 : -10, h * 0.85, Math.cos(a) * sp, Math.sin(a) * sp));
      }
    }
    sfx.fanfare();
  }
  function makeConfetti(x, y, vx, vy) {
    return {
      x, y, vx, vy,
      w: 6 + Math.random() * 6,
      h: 9 + Math.random() * 8,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 10,
      flip: Math.random() * 6,
      vf: 6 + Math.random() * 8,
      sway: Math.random() * 6,
      color: PARTY_COLORS[(Math.random() * PARTY_COLORS.length) | 0],
    };
  }
  function updateParty(dt) {
    const P = game.party;
    if (!P) return;
    P.t += dt;
    const w = fxW;
    const h = fxH;
    // 上から降り続ける紙吹雪
    if (P.t < 7 && P.confetti.length < 160) {
      for (let i = 0; i < 3; i++) P.confetti.push(makeConfetti(Math.random() * w, -20, (Math.random() - 0.5) * 40, 60 + Math.random() * 90));
    }
    for (const c of P.confetti) {
      c.vy += 420 * dt;
      c.vx *= Math.exp(-dt * 1.8);
      c.vy = Math.min(c.vy, 170);
      c.x += (c.vx + Math.sin(P.t * 3 + c.sway) * 30) * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
      c.flip += c.vf * dt;
    }
    P.confetti = P.confetti.filter((c) => c.y < h + 30);
    // 花火
    if (P.t >= P.nextFw && P.t < 8) {
      P.nextFw = P.t + 0.3 + Math.random() * 0.45;
      const x = w * (0.12 + Math.random() * 0.76);
      const y = h * (0.08 + Math.random() * 0.3);
      const col = PARTY_COLORS[(Math.random() * PARTY_COLORS.length) | 0];
      const n = 46;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.1;
        const sp = w * (0.28 + Math.random() * 0.12);
        P.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.9 + Math.random() * 0.4, max: 1.3, color: Math.random() < 0.2 ? '#fff6c8' : col });
      }
      sfx.pop();
    }
    for (const p of P.sparks) {
      p.life -= dt;
      p.vx *= Math.exp(-dt * 2.6);
      p.vy *= Math.exp(-dt * 2.6);
      p.vy += 90 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    P.sparks = P.sparks.filter((p) => p.life > 0);
    // 行ごとの★の音と、最後のまとめ
    while (P.played < P.stars.length && P.t >= 1.25 + P.played * 0.28) {
      if (P.stars[P.played]) sfx.star(P.played);
      else sfx.row();
      P.played++;
    }
    if (!P.summaryPlayed && P.t >= P.summaryAt) {
      P.summaryPlayed = true;
      sfx.chime();
    }
  }
  function stopParty() {
    game.party = null;
    ui.result.classList.remove('party');
    for (const g of [fx, fxb]) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    }
  }
  function drawParty() {
    const P = game.party;
    if (!P) return;
    const w = fxW;
    const h = fxH;
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.clearRect(0, 0, w, h);
    fxb.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxb.clearRect(0, 0, w, h);
    // 回る光の筋とハムスター（カードの上の空き）
    const hx = w / 2;
    const hy = h * 0.2;
    const appear = clamp((P.t - 0.15) / 0.5, 0, 1);
    fxb.save();
    fxb.translate(hx, hy);
    fxb.rotate(P.t * 0.35);
    fxb.globalAlpha = 0.35 * appear;
    for (let i = 0; i < 14; i++) {
      fxb.rotate((Math.PI * 2) / 14);
      fxb.beginPath();
      fxb.moveTo(0, 0);
      fxb.lineTo(-w * 0.07, -w * 0.75);
      fxb.lineTo(w * 0.07, -w * 0.75);
      fxb.closePath();
      fxb.fillStyle = i % 2 ? '#fff3c4' : '#ffd77a';
      fxb.fill();
    }
    fxb.restore();
    // ハムスターがぴょんぴょん跳ねる
    const u = w * 0.3;
    const ph = (P.t * 2.2) % 1;
    const jump = Math.sin(ph * Math.PI);
    const land = ph < 0.12 ? 1 - ph / 0.12 : 0;
    const hamY = hy + u * 0.25 - jump * u * 0.45;
    const sc = easeOutBack(appear);
    if (sc > 0.01) {
      const keep = ctx;
      ctx = fxb;
      fxb.save();
      fxb.translate(hx, hamY);
      fxb.scale(sc, sc);
      fxb.translate(-hx, -hamY);
      drawHamster(hx, hamY, u, Math.sin(P.t * 5) * 0.12, 1 + land * 0.25, 1 - land * 0.25 + jump * 0.08, { clear: true });
      fxb.restore();
      ctx = keep;
      // まわりで回るキラキラ
      fxb.save();
      fxb.globalAlpha = appear;
      fxb.fillStyle = '#fff6b0';
      fxb.font = `${u * 0.22}px sans-serif`;
      fxb.textAlign = 'center';
      fxb.textBaseline = 'middle';
      for (let k = 0; k < 5; k++) {
        const a = P.t * 1.6 + (k * Math.PI * 2) / 5;
        const r = u * (0.75 + 0.08 * Math.sin(P.t * 4 + k));
        fxb.fillText('✦', hx + Math.cos(a) * r, hy + u * 0.1 + Math.sin(a) * r * 0.6);
      }
      fxb.restore();
    }
    // 花火
    fx.globalCompositeOperation = 'lighter';
    for (const p of P.sparks) {
      fx.globalAlpha = clamp(p.life / (p.max * 0.6), 0, 1);
      fx.fillStyle = p.color;
      fx.beginPath();
      fx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      fx.fill();
    }
    fx.globalCompositeOperation = 'source-over';
    // 紙吹雪（ひらひら裏返る）
    for (const c of P.confetti) {
      fx.save();
      fx.globalAlpha = 1;
      fx.translate(c.x, c.y);
      fx.rotate(c.rot);
      fx.scale(1, Math.cos(c.flip));
      fx.fillStyle = c.color;
      fx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      fx.restore();
    }
    // 最初の白いフラッシュ
    if (P.t < 0.45) {
      fx.globalAlpha = 1 - P.t / 0.45;
      fx.fillStyle = '#fffaf0';
      fx.fillRect(0, 0, w, h);
      fx.globalAlpha = 1;
    }
  }

  // ---- 更新 ----
  function update(dt) {
    game.clock += dt;

    if (game.screen === 'play' && game.clearing) {
      const cl = game.clearing;
      const last = game.stageIdx + 1 >= levels.length;
      const prevT = cl.t;
      cl.t += dt;
      if (last) {
        if (cl.t >= CONFIG.partyAt && game.screen === 'play') showAllClear();
      } else {
        if (prevT < CONFIG.clearHold && cl.t >= CONFIG.clearHold) sfx.slide();
        if (cl.t >= CONFIG.clearHold + CONFIG.slideOut) {
          loadStage(game.stageIdx + 1);
          game.enter = { t: 0, landed: false };
        }
      }
    }
    if (game.enter) {
      const en = game.enter;
      en.t += dt;
      if (!en.landed && en.t >= CONFIG.slideIn * 0.55) {
        en.landed = true;
        sfx.thud();
      }
      if (en.t >= CONFIG.slideIn) {
        game.enter = null;
        if (heldDir) setPreview(heldDir);
      }
    }

    updateAnim(dt);
    updateParty(dt);
    if (game.angleTween && !game.anim) {
      const tw = game.angleTween;
      tw.t += dt;
      const p = clamp(tw.t / CONFIG.undoTurn, 0, 1);
      game.boxAngle = lerp(tw.from, tw.to, easeInOut(p));
      if (p >= 1) game.angleTween = null;
    }

    if (game.bump) {
      game.bump.t += dt;
      if (game.bump.t > 0.22) game.bump = null;
    }
    // 扉
    const prevDoor = game.doorAmt;
    game.doorAmt += clamp(game.doorTarget - game.doorAmt, -dt * 4, dt * 4);
    if (prevDoor === 0 && game.doorAmt > 0) sfx.door(true);
    if (prevDoor === 1 && game.doorAmt < 1) sfx.door(false);
    // 揺れ
    game.jolt.x *= Math.exp(-dt * 18);
    game.jolt.y *= Math.exp(-dt * 18);
    // 粒
    for (const p of game.particles) {
      p.life -= dt;
      p.vx += p.gx * dt;
      p.vy += p.gy * dt;
      p.vx *= Math.exp(-dt * 1.5);
      p.vy *= Math.exp(-dt * 1.5);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    game.particles = game.particles.filter((p) => p.life > 0);
    for (const v of Object.values(game.vis)) if (v.dizzy > 0) v.dizzy -= dt;

    updateHud();
  }

  function updateAnim(dt) {
    const a = game.anim;
    if (!a) return;
    a.t += dt;
    const d = DIR_V[a.dir];
    // 箱の回転
    game.boxAngle = a.t < a.R1 ? lerp(a.startAngle, a.target, easeInOut(a.t / a.R1)) : a.target;
    // ハムスターは画面に対して立ったまま（箱が回るあいだも頭が上）
    game.vis.h.angle = -game.boxAngle;

    const tf = a.t - a.R1;
    let anyLandedNow = false;
    for (const m of a.moves) {
      const v = game.vis[m.id];
      if (tf <= 0) {
        v.falling = m.dist > 0;
        continue;
      }
      const s = Math.min(m.dist, 0.5 * CONFIG.gravity * tf * tf);
      v.x = m.from.x + d.x * s;
      v.y = m.from.y + d.y * s;
      v.falling = !m.landed;
      if (m.escaped && tf >= m.landT) {
        // 穴の外へ抜けていく
        const over = tf - m.landT;
        v.x = m.to.x + d.x * over * 6;
        v.y = m.to.y + d.y * over * 6;
        v.alpha = clamp(1 - over / 0.4, 0, 1);
      }
      if (!m.landed && tf >= m.landT) {
        m.landed = true;
        v.falling = false;
        if (m.escaped) {
          stageCleared();
          continue;
        }
        v.x = m.to.x;
        v.y = m.to.y;
        const k = Math.min(1, 0.35 + m.dist * 0.16);
        v.sq = { t0: game.clock, k };
        if (m.id === 'h' && m.dist >= 4) v.dizzy = 1.1;
        spawnChips(m.to, d, m.dist);
        sfx.land(m.id === 'h' ? 'h' : 'b', m.dist, a.chain());
        if (m.id !== 'h' && onSwitch(game.level, m.to)) sfx.click();
        game.jolt.x += d.x * (0.04 + m.dist * 0.02);
        game.jolt.y += d.y * (0.04 + m.dist * 0.02);
        anyLandedNow = true;
      }
      if (m.lateEscape && m.landed && tf >= m.escapeAt) {
        // 開いた扉から転がり出る
        const over = tf - m.escapeAt;
        v.x = m.to.x + d.x * over * 6;
        v.y = m.to.y + d.y * over * 6;
        v.falling = true;
        v.alpha = clamp(1 - (over - 0.17) / 0.4, 0, 1);
        if (!m.cleared && over >= 1 / 6) {
          m.cleared = true;
          stageCleared();
        }
      }
    }
    if (a.t >= a.doorAt && !a.doorChecked) {
      a.doorChecked = true;
      game.doorTarget = L.isOpen(game.level, game.state) ? 1 : 0;
    }
    if (a.t >= a.fallEnd && !a.queueChecked) {
      a.queueChecked = true;
      if (game.queued && canAct()) {
        const q = game.queued;
        game.queued = null;
        commit(q);
        return;
      }
    }
    if (a.t >= a.end) {
      game.anim = null;
      game.boxAngle = a.target;
      for (const id of Object.keys(game.vis)) {
        const p = posOf(game.state, id);
        if (id === 'h' && game.state.escaped) continue;
        game.vis[id].x = p.x;
        game.vis[id].y = p.y;
      }
      if (game.queued && canAct()) {
        const q = game.queued;
        game.queued = null;
        commit(q);
      } else if (heldDir) {
        setPreview(heldDir);
      }
    }
    return anyLandedNow;
  }

  function spawnChips(cell, d, dist) {
    const n = 5 + dist * 3;
    const px = -d.y;
    const py = d.x;
    const cx = cell.x + d.x * 0.5;
    const cy = cell.y + d.y * 0.5;
    const colors = ['#f3dfb0', '#e3c07e', '#cfa25d', '#fff3d6'];
    for (let i = 0; i < n; i++) {
      const side = (Math.random() * 2 - 1);
      const sp = 1.5 + Math.random() * (1.5 + dist * 0.6);
      game.particles.push({
        x: cx + px * side * 0.4,
        y: cy + py * side * 0.4,
        vx: -d.x * sp * (0.6 + Math.random()) + px * side * sp * 1.2,
        vy: -d.y * sp * (0.6 + Math.random()) + py * side * sp * 1.2,
        gx: d.x * 16,
        gy: d.y * 16,
        rot: Math.random() * 6,
        vr: (Math.random() * 2 - 1) * 14,
        w: 0.07 + Math.random() * 0.07,
        h: 0.03 + Math.random() * 0.03,
        life: 0.45 + Math.random() * 0.35,
        max: 0.8,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  function spawnConfetti() {
    const ex = game.level.exit;
    const colors = ['#f2944f', '#3fae5a', '#f7d046', '#7fb2e5', '#f7a8a8'];
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 5;
      game.particles.push({
        x: clamp(ex.x, -0.3, 5.3),
        y: clamp(ex.y, -0.3, 5.3),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 2,
        gx: 0,
        gy: 7,
        rot: Math.random() * 6,
        vr: (Math.random() * 2 - 1) * 10,
        w: 0.12,
        h: 0.07,
        life: 0.9 + Math.random() * 0.5,
        max: 1.4,
        color: colors[i % colors.length],
      });
    }
  }

  // ---- プレビュー ----
  // sdir は画面上の方向
  function setPreview(sdir) {
    if (!sdir || !canAct() || game.anim) {
      game.preview = null;
      return;
    }
    const dir = toGrid(sdir);
    game.preview = { sdir, dir, result: L.applyGravity(game.level, game.state, dir) };
  }

  // ---- HUD ----
  const hudCache = {};
  function setText(el, key, v) {
    if (hudCache[key] !== v) {
      hudCache[key] = v;
      el.textContent = v;
    }
  }
  function updateHud() {
    setText(ui.stage, 'stage', `${game.stageIdx + 1}/${levels.length}`);
    setText(ui.moves, 'moves', String(game.moves));
    setText(ui.par, 'par', game.level ? game.level.par + '手' : '');
    setText(ui.stageName, 'name', game.level ? `「${game.level.name}」` : '');
    ui.hud.classList.toggle('best', !!game.level && game.moves > 0 && game.moves <= game.level.par);
    ui.undo.disabled = !game.history.length || !canAct();
  }

  // ---- 描画 ----
  let W = 0;
  let H = 0;
  let dpr = 1;
  let fxW = 0;
  let fxH = 0;
  function resize() {
    dpr = Math.min(CONFIG.maxDpr, window.devicePixelRatio || 1);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    fxW = app.clientWidth;
    fxH = app.clientHeight;
    for (const el of [fxCanvas, fxBackCanvas]) {
      el.width = Math.round(fxW * dpr);
      el.height = Math.round(fxH * dpr);
    }
  }

  const WALL_T = 0.46; // 段ボールの壁の厚み（マス単位）

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!game.level) return;
    const span = 6 + WALL_T * 2;
    const fit = Math.min(W, H) * 0.94;
    const c = fit / span;
    const a = game.boxAngle;
    const rotScale = 1 / (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)));
    let hop = 0;
    if (game.anim && game.anim.delta === 0 && game.anim.t < game.anim.R1) {
      hop = -Math.sin((Math.PI * game.anim.t) / game.anim.R1) * c * 0.3;
    }
    let bx = 0;
    let by = 0;
    if (game.bump) {
      const d = DIR_V[game.bump.dir];
      const k = Math.sin((game.bump.t / 0.22) * Math.PI * 3) * (1 - game.bump.t / 0.22) * c * 0.08;
      bx = d.x * k;
      by = d.y * k;
    }
    // 面のつなぎ: 箱が左へ退場 → 次の箱が右から弾んで入る
    let slideX = 0;
    let tilt = 0;
    const cl = game.clearing;
    if (cl && game.stageIdx + 1 < levels.length && cl.t > CONFIG.clearHold) {
      const p = clamp((cl.t - CONFIG.clearHold) / CONFIG.slideOut, 0, 1);
      slideX = -p * p * W * 1.15;
      tilt = -p * 0.3;
    } else if (game.enter) {
      const p = clamp(game.enter.t / CONFIG.slideIn, 0, 1);
      slideX = (1 - easeOutBack(p)) * W * 1.15;
      tilt = (1 - p) * (1 - p) * 0.25;
    }
    const cx = W / 2 + bx + slideX;
    const cy = H / 2 + hop + by;

    // 床の影
    ctx.save();
    ctx.fillStyle = 'rgba(58,38,20,.22)';
    ctx.beginPath();
    ctx.ellipse(W / 2 + slideX, H / 2 + fit * 0.5 * rotScale + 4, fit * 0.42 * rotScale, fit * 0.04, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(cx + game.jolt.x * c, cy + game.jolt.y * c);
    ctx.rotate(a + tilt);
    ctx.scale(rotScale, rotScale);
    const shadeAngle = a + tilt;

    drawBoxBack(c);
    drawInteriorShade(c, shadeAngle);
    drawSwitches(c);
    drawDropShadows(c, shadeAngle);
    drawWalls(c);
    if (game.preview) drawPreview(c, game.preview);
    const escaping = game.pendingClear || !!game.clearing;
    drawObjects(c, escaping ? (id) => id !== 'h' : null);
    drawBoxFront(c);
    drawFrameShade(c, shadeAngle);
    if (escaping) drawObjects(c, (id) => id === 'h');
    drawParticles(c);
    ctx.restore();

    drawGravityIndicator(c, fit);
    drawParty();
  }

  // 盤面座標 (x,y) のマス中心 → 描画座標
  const gx = (x, c) => (x - 2.5) * c;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBoxBack(c) {
    const o = (3 + WALL_T) * c;
    const i = 3 * c;
    // 外枠（段ボール）
    roundRect(-o, -o, o * 2, o * 2, c * 0.18);
    const g = ctx.createLinearGradient(-o, -o, o, o);
    g.addColorStop(0, '#d9a465');
    g.addColorStop(1, '#b77f43');
    ctx.fillStyle = g;
    ctx.fill();
    // 内側（奥の面）
    ctx.fillStyle = '#e9c891';
    ctx.fillRect(-i, -i, i * 2, i * 2);
    // 奥の面の段ボールの筋
    ctx.strokeStyle = 'rgba(160,110,50,.10)';
    ctx.lineWidth = c * 0.03;
    for (let k = -i + c * 0.25; k < i; k += c * 0.25) {
      ctx.beginPath();
      ctx.moveTo(k, -i);
      ctx.lineTo(k, i);
      ctx.stroke();
    }
    // 判子「ハムスター在中」
    ctx.save();
    ctx.rotate(-0.12);
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = '#a2312a';
    ctx.fillStyle = '#a2312a';
    ctx.lineWidth = c * 0.05;
    roundRect(-c * 1.5, -c * 0.42, c * 3, c * 0.84, c * 0.12);
    ctx.stroke();
    ctx.font = `bold ${c * 0.42}px "Hiragino Maru Gothic ProN", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ハムスター在中', 0, c * 0.03);
    ctx.restore();
    // マス目
    ctx.fillStyle = 'rgba(120,80,30,.13)';
    for (let y = 0; y <= 6; y++) {
      for (let x = 0; x <= 6; x++) {
        ctx.beginPath();
        ctx.arc((x - 3) * c, (y - 3) * c, c * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 画面のベクトル (sx, sy) を、角度 angle だけ回った箱の中の座標に直す
  function screenToLocal(sx, sy, angle) {
    const cs = Math.cos(-angle);
    const sn = Math.sin(-angle);
    return { x: sx * cs - sy * sn, y: sx * sn + sy * cs };
  }

  // 光は画面の上から。上の壁が奥の面に落とす影と、下側の照り返し
  function drawInteriorShade(c, angle) {
    const i = 3 * c;
    const up = screenToLocal(0, -1, angle);
    const side = screenToLocal(1, 0, angle);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-i, -i, i * 2, i * 2);
    ctx.clip();
    const R = i * 1.42; // 回っても内側全体を覆う長さ
    const g = ctx.createLinearGradient(up.x * R, up.y * R, -up.x * R, -up.y * R);
    g.addColorStop(0, 'rgba(70,38,12,.55)');
    g.addColorStop(0.2, 'rgba(70,38,12,.22)');
    g.addColorStop(0.36, 'rgba(70,38,12,0)');
    g.addColorStop(0.8, 'rgba(255,244,214,0)');
    g.addColorStop(1, 'rgba(255,244,214,.28)');
    ctx.fillStyle = g;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    // 左右の壁ぎわもうっすら暗く
    const g2 = ctx.createLinearGradient(-side.x * R, -side.y * R, side.x * R, side.y * R);
    g2.addColorStop(0, 'rgba(70,38,12,.22)');
    g2.addColorStop(0.16, 'rgba(70,38,12,0)');
    g2.addColorStop(0.84, 'rgba(70,38,12,0)');
    g2.addColorStop(1, 'rgba(70,38,12,.22)');
    ctx.fillStyle = g2;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
  }

  // 壁・積み木・ハムスターが奥の面に落とす影（いつも画面の右下へ）
  function drawDropShadows(c, angle) {
    const off = screenToLocal(c * 0.06, c * 0.11, angle);
    const i = 3 * c;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-i, -i, i * 2, i * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(70,38,12,.24)';
    for (const k of game.level.walls) {
      const [wx, wy] = k.split(',').map(Number);
      roundRect(gx(wx, c) - c / 2 + off.x + c * 0.03, gx(wy, c) - c / 2 + off.y + c * 0.03, c * 0.94, c * 0.94, c * 0.1);
      ctx.fill();
    }
    for (const [id, v] of Object.entries(game.vis)) {
      if (v.alpha < 1) continue;
      const x = gx(v.x, c) + off.x;
      const y = gx(v.y, c) + off.y;
      ctx.beginPath();
      if (id === 'h') ctx.ellipse(x, y + c * 0.06, c * 0.38, c * 0.34, 0, 0, Math.PI * 2);
      else roundRect(x - c * 0.45, y - c * 0.45, c * 0.9, c * 0.9, c * 0.12);
      ctx.fill();
    }
    ctx.restore();
  }

  // 外枠のツヤ：画面の上側が明るく、下側が暗い
  function drawFrameShade(c, angle) {
    const o = (3 + WALL_T) * c;
    const i = 3 * c;
    const up = screenToLocal(0, -1, angle);
    ctx.save();
    ctx.beginPath();
    roundRect(-o, -o, o * 2, o * 2, c * 0.18);
    ctx.rect(-i, -i, i * 2, i * 2);
    const R = o * 1.42;
    const g = ctx.createLinearGradient(up.x * R, up.y * R, -up.x * R, -up.y * R);
    g.addColorStop(0, 'rgba(255,246,222,.38)');
    g.addColorStop(0.45, 'rgba(255,246,222,0)');
    g.addColorStop(0.6, 'rgba(60,30,8,0)');
    g.addColorStop(1, 'rgba(60,30,8,.3)');
    ctx.fillStyle = g;
    ctx.fill('evenodd');
    ctx.restore();
  }

  function exitGeom(c) {
    const e = game.level.exit;
    const i = 3 * c;
    const o = (3 + WALL_T) * c;
    const half = c * 0.42;
    if (e.x < 0) return { x: -o, y: gx(e.y, c) - half, w: o - i, h: half * 2, side: 'left' };
    if (e.x > 5) return { x: i, y: gx(e.y, c) - half, w: o - i, h: half * 2, side: 'right' };
    if (e.y < 0) return { x: gx(e.x, c) - half, y: -o, w: half * 2, h: o - i, side: 'up' };
    return { x: gx(e.x, c) - half, y: i, w: half * 2, h: o - i, side: 'down' };
  }

  function drawBoxFront(c) {
    const o = (3 + WALL_T) * c;
    const i = 3 * c;
    // 縁のハイライトと切り口
    ctx.strokeStyle = 'rgba(255,240,210,.55)';
    ctx.lineWidth = c * 0.05;
    roundRect(-o + c * 0.06, -o + c * 0.06, o * 2 - c * 0.12, o * 2 - c * 0.12, c * 0.14);
    ctx.stroke();
    ctx.strokeStyle = '#8e5a2b';
    ctx.lineWidth = c * 0.06;
    ctx.strokeRect(-i, -i, i * 2, i * 2);
    // 切り口の波（段ボールの断面）
    ctx.save();
    ctx.strokeStyle = 'rgba(142,90,43,.45)';
    ctx.lineWidth = c * 0.025;
    const wave = (x0, y0, x1, y1) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.floor(len / (c * 0.12));
      ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const off = (k % 2 ? 1 : -1) * c * 0.04;
        const px = lerp(x0, x1, t) + (y1 !== y0 ? off : 0);
        const py = lerp(y0, y1, t) + (x1 !== x0 ? off : 0);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    const m = (o + i) / 2;
    wave(-i, -m, i, -m);
    wave(-i, m, i, m);
    wave(-m, -i, -m, i);
    wave(m, -i, m, i);
    ctx.restore();

    // 出口の穴と扉
    const eg = exitGeom(c);
    ctx.fillStyle = '#3a2614';
    roundRect(eg.x, eg.y, eg.w, eg.h, c * 0.08);
    ctx.fill();
    const amt = game.doorAmt;
    ctx.save();
    // 扉は穴の内側の辺を軸に外へ倒れる
    const horiz = eg.side === 'left' || eg.side === 'right';
    if (horiz) {
      const sx = 1 - amt * 0.92;
      ctx.translate(eg.side === 'right' ? eg.x + eg.w : eg.x, 0);
      ctx.scale(sx, 1);
      ctx.translate(-(eg.side === 'right' ? eg.x + eg.w : eg.x), 0);
    } else {
      const sy = 1 - amt * 0.92;
      ctx.translate(0, eg.side === 'down' ? eg.y + eg.h : eg.y);
      ctx.scale(1, sy);
      ctx.translate(0, -(eg.side === 'down' ? eg.y + eg.h : eg.y));
    }
    // 閉じた扉は赤（しま模様）
    ctx.fillStyle = '#d8573a';
    roundRect(eg.x + c * 0.03, eg.y + c * 0.03, eg.w - c * 0.06, eg.h - c * 0.06, c * 0.06);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,240,220,.7)';
    ctx.lineWidth = c * 0.06;
    for (let k = -2; k <= 4; k++) {
      ctx.beginPath();
      ctx.moveTo(eg.x + k * c * 0.2, eg.y);
      ctx.lineTo(eg.x + k * c * 0.2 + c * 0.6, eg.y + c * 0.6 + eg.h);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#7a2c18';
    ctx.lineWidth = c * 0.04;
    roundRect(eg.x + c * 0.03, eg.y + c * 0.03, eg.w - c * 0.06, eg.h - c * 0.06, c * 0.06);
    ctx.stroke();
    ctx.restore();
    // 穴の縁取り
    ctx.strokeStyle = amt > 0.5 ? '#7be08e' : '#f2944f';
    ctx.lineWidth = c * 0.06;
    roundRect(eg.x, eg.y, eg.w, eg.h, c * 0.08);
    ctx.stroke();
    // 出口ラベルとランプ
    const lampN = game.level.switches.length;
    const pressed = game.level.switches.filter((s) => game.state.boxes.some((b) => b.x === s.x && b.y === s.y)).length;
    const lx = eg.x + eg.w / 2;
    const ly = eg.y + eg.h / 2;
    // ランプは穴の横（壁の上）に、壁に沿って並べる
    for (let k = 0; k < lampN; k++) {
      const off = c * 0.62 + k * c * 0.26;
      const px = horiz ? lx : lx - off;
      const py = horiz ? ly - off : ly;
      const lit = k < pressed;
      if (lit) {
        ctx.fillStyle = 'rgba(94,224,122,.35)';
        ctx.beginPath();
        ctx.arc(px, py, c * 0.17, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(px, py, c * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = lit ? '#5ee07a' : '#5a3a1c';
      ctx.fill();
    }
    // 「でぐち」の札（穴の横、壁の上）
    ctx.save();
    ctx.translate(horiz ? lx : lx + c * 0.95, horiz ? ly + c * 0.95 : ly);
    ctx.rotate(-game.boxAngle); // 箱が回っても読める向きに
    ctx.fillStyle = amt > 0.5 ? '#2f8a45' : '#7a2c18';
    ctx.font = `bold ${c * 0.24}px "Hiragino Maru Gothic ProN", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 壁が画面上で縦なら縦書きにして、壁の幅に収める
    const quarter = ((Math.round(game.boxAngle / (Math.PI / 2)) % 2) + 2) % 2;
    if (horiz !== (quarter === 1)) {
      [...'でぐち'].forEach((ch, k) => ctx.fillText(ch, 0, (k - 1) * c * 0.25));
    } else {
      ctx.fillText('でぐち', 0, 0);
    }
    ctx.restore();
    // 開いたら外向きの矢印
    if (amt > 0.5) {
      const outv = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[eg.side];
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(Math.atan2(outv[1], outv[0]));
      ctx.strokeStyle = '#fff4b0';
      ctx.lineWidth = c * 0.07;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let k = 0; k < 2; k++) {
        const ph = (game.clock * 1.6 + k / 2) % 1;
        ctx.globalAlpha = (amt - 0.5) * 2 * Math.sin(ph * Math.PI);
        const px = -c * 0.25 + ph * c * 0.35;
        ctx.beginPath();
        ctx.moveTo(px - c * 0.1, -c * 0.16);
        ctx.lineTo(px + c * 0.06, 0);
        ctx.lineTo(px - c * 0.1, c * 0.16);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawSwitches(c) {
    for (const s of game.level.switches) {
      const x = gx(s.x, c);
      const y = gx(s.y, c);
      const on = Object.entries(game.vis).some(
        ([id, v]) => id !== 'h' && Math.abs(v.x - s.x) < 0.08 && Math.abs(v.y - s.y) < 0.08 && !v.falling,
      );
      if (on) {
        const gl = ctx.createRadialGradient(x, y, 0, x, y, c * 0.85);
        gl.addColorStop(0, 'rgba(120,255,140,.55)');
        gl.addColorStop(1, 'rgba(120,255,140,0)');
        ctx.fillStyle = gl;
        ctx.fillRect(x - c, y - c, c * 2, c * 2);
      }
      ctx.fillStyle = '#2f6e3d';
      ctx.beginPath();
      ctx.arc(x, y, c * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = on ? '#6ff08a' : '#3fae5a';
      ctx.beginPath();
      ctx.arc(x, y, c * 0.27, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = c * 0.035;
      ctx.beginPath();
      ctx.arc(x, y, c * 0.18, Math.PI * 1.1, Math.PI * 1.6);
      ctx.stroke();
    }
  }

  function drawWalls(c) {
    for (const k of game.level.walls) {
      const [wx, wy] = k.split(',').map(Number);
      const x = gx(wx, c) - c / 2;
      const y = gx(wy, c) - c / 2;
      const p = c * 0.03;
      roundRect(x + p, y + p, c - p * 2, c - p * 2, c * 0.1);
      const g = ctx.createLinearGradient(x, y, x, y + c);
      g.addColorStop(0, '#b47a3f');
      g.addColorStop(1, '#965f2c');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#6e4220';
      ctx.lineWidth = c * 0.04;
      ctx.stroke();
      // 断面の波
      ctx.strokeStyle = 'rgba(255,225,170,.35)';
      ctx.lineWidth = c * 0.03;
      for (const yy of [0.33, 0.66]) {
        ctx.beginPath();
        for (let t = 0; t <= 8; t++) {
          const px = x + c * 0.12 + (c * 0.76 * t) / 8;
          const py = y + c * yy + (t % 2 ? -1 : 1) * c * 0.04;
          if (t === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  }

  function drawPreview(c, pv) {
    const r = pv.result;
    const pulse = 0.55 + 0.25 * Math.sin(game.clock * 8);
    if (!r.moved) {
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = 'rgba(74,47,23,.75)';
      ctx.font = `bold ${c * 0.42}px "Hiragino Maru Gothic ProN", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.rotate(-game.boxAngle); // 画面に対して正立
      ctx.fillText('うごかない', 0, -(3 + WALL_T / 2) * c);
      ctx.restore();
      return;
    }
    const d = DIR_V[pv.dir];
    for (const m of r.moves) {
      if (m.dist === 0) continue;
      const x0 = gx(m.from.x, c);
      const y0 = gx(m.from.y, c);
      const x1 = gx(m.to.x, c);
      const y1 = gx(m.to.y, c);
      // 軌跡
      ctx.save();
      ctx.strokeStyle = m.id === 'h' ? 'rgba(226,115,58,.7)' : 'rgba(110,66,32,.55)';
      ctx.lineWidth = c * 0.07;
      ctx.lineCap = 'round';
      ctx.setLineDash([c * 0.05, c * 0.16]);
      ctx.lineDashOffset = -game.clock * c * 1.2;
      ctx.beginPath();
      ctx.moveTo(x0 + d.x * c * 0.35, y0 + d.y * c * 0.35);
      ctx.lineTo(x1 - d.x * c * 0.35, y1 - d.y * c * 0.35);
      ctx.stroke();
      ctx.restore();
      // 止まる場所のゴースト
      ctx.save();
      ctx.globalAlpha = pulse * (m.escaped ? 0.8 : 0.55);
      if (m.id === 'h') {
        drawHamster(x1, y1, c, GRAV_ANGLE[pv.dir], 1, 1, { ghost: true });
      } else {
        drawBlock(x1, y1, c, +m.id.slice(1), 1, 1, true);
      }
      ctx.restore();
    }
    // 扉が開くなら知らせる
    const opens = !L.isOpen(game.level, game.state) && L.isOpen(game.level, r.state);
    const esc = r.state.escaped;
    if (opens || esc) {
      const eg = exitGeom(c);
      ctx.save();
      ctx.globalAlpha = pulse + 0.2;
      ctx.fillStyle = esc ? '#e2733a' : '#2f8a45';
      ctx.font = `bold ${c * 0.36}px "Hiragino Maru Gothic ProN", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = esc ? '脱出！' : 'ひらく！';
      const lx = eg.x + eg.w / 2;
      const ly = eg.y + eg.h / 2;
      const inward = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] }[eg.side];
      ctx.lineWidth = c * 0.1;
      ctx.strokeStyle = '#fff8ea';
      ctx.translate(lx + inward[0] * c * 0.95, ly + inward[1] * c * 0.95);
      ctx.rotate(-game.boxAngle);
      ctx.strokeText(label, 0, 0);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  // つぶれ量（着地で縦に縮み、ばねのように戻る）
  function squashOf(v) {
    if (!v.sq) return v.falling ? -0.12 : 0;
    const e = game.clock - v.sq.t0;
    if (e > 0.6) return 0;
    return v.sq.k * Math.exp(-e * CONFIG.squashDecay) * Math.cos(e * CONFIG.squashFreq);
  }

  function drawObjects(c, filter) {
    const g = game.anim ? game.anim.dir : game.gravity;
    const d = g ? DIR_V[g] : { x: 0, y: 1 };
    // 箱を先、ハムスターを後
    for (const id of Object.keys(game.vis).sort((a, b) => (a === 'h') - (b === 'h'))) {
      if (filter && !filter(id)) continue;
      const v = game.vis[id];
      if (v.alpha <= 0) continue;
      let x = gx(v.x, c);
      let y = gx(v.y, c);
      if (!game.gravity && !game.anim) {
        // 無重力でふわふわ
        const ph = id === 'h' ? 0 : 1.7 + +id.slice(1);
        x += Math.cos(game.clock * 1.6 + ph) * c * 0.03;
        y += Math.sin(game.clock * 2.1 + ph) * c * 0.05;
      }
      const s = squashOf(v);
      // 重力の軸方向に縮む: along = 1 - s*0.35, 直交 = 1 + s*0.28
      const along = 1 - s * 0.35;
      const across = 1 + s * 0.28;
      ctx.save();
      ctx.globalAlpha = v.alpha;
      if (id === 'h') {
        const idle = !game.anim && !v.falling && !game.clearing && !game.pendingClear;
        drawHamster(x, y, c, v.angle, across, along, {
          falling: v.falling,
          dizzy: v.dizzy > 0,
          floating: !game.gravity && !game.anim,
          clear: !!game.clearing || game.pendingClear,
          idle,
          // プレビュー中は転がる方向を見る（落ち着いているときハムスターは画面に正立）
          look: idle && game.preview ? DIR_V[game.preview.sdir] : null,
        });
      } else {
        // 箱は回転させず、重力の軸に合わせて伸縮（接地面を基準に）
        const sx = d.x !== 0 ? along : across;
        const sy = d.y !== 0 ? along : across;
        const ax = x + d.x * c * 0.45;
        const ay = y + d.y * c * 0.45;
        ctx.translate(ax, ay);
        ctx.scale(sx, sy);
        ctx.translate(-ax, -ay);
        drawBlock(x, y, c, +id.slice(1), 1, 1, false);
      }
      ctx.restore();
    }
  }

  const BLOCK_COLORS = [
    { face: '#f6d39a', side: '#d99a4e', mark: '#e2533a', sym: '★' },
    { face: '#f3d7a6', side: '#cf9550', mark: '#3c7fd0', sym: '●' },
    { face: '#f4dcae', side: '#d2a05c', mark: '#2f9a4c', sym: '▲' },
  ];
  function drawBlock(x, y, c, idx, sx, sy, ghost) {
    const col = BLOCK_COLORS[idx % BLOCK_COLORS.length];
    const s = c * 0.9;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    roundRect(-s / 2, -s / 2, s, s, c * 0.12);
    ctx.fillStyle = col.side;
    ctx.fill();
    roundRect(-s / 2 + c * 0.07, -s / 2 + c * 0.05, s - c * 0.14, s - c * 0.15, c * 0.09);
    ctx.fillStyle = col.face;
    ctx.fill();
    if (!ghost) {
      ctx.strokeStyle = 'rgba(160,100,40,.25)';
      ctx.lineWidth = c * 0.025;
      for (const yy of [-0.18, 0.02, 0.2]) {
        ctx.beginPath();
        ctx.moveTo(-s / 2 + c * 0.12, yy * c);
        ctx.quadraticCurveTo(0, yy * c + c * 0.05, s / 2 - c * 0.12, yy * c - c * 0.02);
        ctx.stroke();
      }
    }
    ctx.fillStyle = col.mark;
    ctx.font = `bold ${c * 0.46}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(col.sym, 0, -c * 0.01);
    roundRect(-s / 2, -s / 2, s, s, c * 0.12);
    ctx.strokeStyle = ghost ? 'rgba(110,66,32,.9)' : '#8e5a2b';
    ctx.lineWidth = c * 0.045;
    if (ghost) ctx.setLineDash([c * 0.1, c * 0.07]);
    ctx.stroke();
    ctx.restore();
  }

  function drawHamster(x, y, c, angle, sx, sy, st) {
    const u = c * 0.92;
    const t = game.clock;
    const idle = st.idle && !st.ghost;
    const look = st.look || { x: 0, y: 0 };
    // 呼吸とプレビュー方向への前のめり
    const breath = idle ? Math.sin(t * 3.2) : 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // 足元（+y）を基準に伸縮
    ctx.translate(0, u * 0.45);
    ctx.rotate(look.x * 0.14);
    ctx.scale(sx * (1 - breath * 0.012), sy * (1 + breath * 0.025));
    ctx.translate(0, -u * 0.45);
    // まばたき（ときどき2回）と鼻のぴくぴく
    const blink = idle && ((t % 3.7) < 0.12 || ((t + 1.4) % 7.9) < 0.12 || ((t + 1.2) % 7.9) < 0.1);
    const sniff = idle && (t % 2.9) < 0.6;
    const fur = '#f0a35c';
    const belly = '#fff1dc';
    const pink = '#f6a2a2';
    const line = '#7a4a22';
    ctx.lineWidth = u * 0.04;
    ctx.strokeStyle = line;
    // 耳
    const flap = st.falling ? Math.sin(t * 40) * 0.35 : st.floating ? Math.sin(t * 3) * 0.12 : sniff ? Math.sin(t * 30) * 0.05 : 0;
    for (const sgn of [-1, 1]) {
      ctx.save();
      ctx.translate(sgn * u * 0.25, -u * 0.22);
      ctx.rotate(sgn * (0.25 + flap));
      ctx.beginPath();
      ctx.ellipse(0, -u * 0.04, u * 0.11, u * 0.12, 0, 0, Math.PI * 2);
      ctx.fillStyle = fur;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, -u * 0.04, u * 0.06, u * 0.07, 0, 0, Math.PI * 2);
      ctx.fillStyle = pink;
      ctx.fill();
      ctx.restore();
    }
    // 腕（落下中・無重力はバンザイ）
    const up = st.falling || st.floating || st.clear;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      if (up) ctx.ellipse(sgn * u * 0.4, -u * 0.06 + (st.clear ? Math.sin(t * 14) * u * 0.04 : 0), u * 0.07, u * 0.11, sgn * 0.6, 0, Math.PI * 2);
      else ctx.ellipse(sgn * u * 0.17, u * 0.24, u * 0.07, u * 0.06, 0, 0, Math.PI * 2);
      ctx.fillStyle = up ? fur : pink;
      ctx.fill();
      ctx.stroke();
    }
    // 体
    ctx.beginPath();
    ctx.ellipse(0, u * 0.08, u * 0.42, u * 0.37, 0, 0, Math.PI * 2);
    ctx.fillStyle = fur;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, u * 0.2, u * 0.27, u * 0.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = belly;
    ctx.fill();
    // 足
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(sgn * u * 0.17, u * 0.43, u * 0.08, u * 0.045, 0, 0, Math.PI * 2);
      ctx.fillStyle = pink;
      ctx.fill();
    }
    if (!up) {
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(sgn * u * 0.15, u * 0.2, u * 0.06, u * 0.05, 0, 0, Math.PI * 2);
        ctx.fillStyle = pink;
        ctx.fill();
      }
    }
    // 頬
    ctx.globalAlpha *= 0.55;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(sgn * u * 0.25, u * 0.05, u * 0.07, u * 0.045, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#f27e7e';
      ctx.fill();
    }
    ctx.globalAlpha /= 0.55;
    // 目
    for (const sgn of [-1, 1]) {
      const ex = sgn * u * 0.13;
      const ey = -u * 0.04;
      if (st.dizzy) {
        ctx.beginPath();
        for (let k = 0; k < 14; k++) {
          const r = u * 0.005 * k;
          const a = k * 0.9 + t * 10;
          const px = ex + Math.cos(a) * r;
          const py = ey + Math.sin(a) * r;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.lineWidth = u * 0.025;
        ctx.strokeStyle = '#2b1a0c';
        ctx.stroke();
      } else if (st.clear) {
        ctx.beginPath();
        ctx.arc(ex, ey + u * 0.02, u * 0.05, Math.PI * 1.1, Math.PI * 1.9);
        ctx.lineWidth = u * 0.03;
        ctx.strokeStyle = '#2b1a0c';
        ctx.stroke();
      } else if (blink) {
        ctx.beginPath();
        ctx.moveTo(ex - u * 0.045, ey + u * 0.005);
        ctx.quadraticCurveTo(ex, ey + u * 0.03, ex + u * 0.045, ey + u * 0.005);
        ctx.lineWidth = u * 0.025;
        ctx.strokeStyle = '#2b1a0c';
        ctx.stroke();
      } else {
        const big = st.falling ? 1.25 : 1;
        const lx = ex + look.x * u * 0.028;
        const ly = ey + look.y * u * 0.022;
        ctx.beginPath();
        ctx.arc(lx, ly, u * 0.048 * big, 0, Math.PI * 2);
        ctx.fillStyle = '#2b1a0c';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(lx + u * 0.016, ly - u * 0.018, u * 0.016 * big, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
    }
    // 鼻と口
    const nose = sniff ? Math.sin(t * 38) * u * 0.008 : 0;
    ctx.beginPath();
    ctx.ellipse(0, u * 0.04 + nose, u * 0.035, u * 0.025 + Math.abs(nose) * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e46a7a';
    ctx.fill();
    ctx.lineWidth = u * 0.022;
    ctx.strokeStyle = line;
    ctx.beginPath();
    if (st.falling || st.dizzy) {
      ctx.ellipse(0, u * 0.11, u * 0.035, u * 0.045, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#9c3a3a';
      ctx.fill();
    } else {
      ctx.arc(-u * 0.03, u * 0.08, u * 0.03, 0, Math.PI);
      ctx.moveTo(u * 0.06, u * 0.08);
      ctx.arc(u * 0.03, u * 0.08, u * 0.03, 0, Math.PI);
      ctx.stroke();
    }
    // 目が回る星
    if (st.dizzy) {
      ctx.fillStyle = '#f7d046';
      ctx.font = `${u * 0.2}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let k = 0; k < 3; k++) {
        const a = t * 6 + (k * Math.PI * 2) / 3;
        ctx.fillText('★', Math.cos(a) * u * 0.32, -u * 0.48 + Math.sin(a) * u * 0.08);
      }
    }
    ctx.restore();
  }

  function drawParticles(c) {
    for (const p of game.particles) {
      ctx.save();
      ctx.globalAlpha = clamp(p.life / (p.max * 0.5), 0, 1);
      ctx.translate(gx(p.x, c), gx(p.y, c));
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect((-p.w * c) / 2, (-p.h * c) / 2, p.w * c, p.h * c);
      ctx.restore();
    }
  }

  // 箱の外に重力の向きを示す矢印
  function drawGravityIndicator(c, fit) {
    // 画面上の向き。落ち着いているときの重力は、いつも画面の下
    const dir = game.preview ? game.preview.sdir : game.anim ? null : game.gravity ? 'down' : null;
    if (!dir || game.screen !== 'play') return;
    const d = DIR_V[dir];
    const preview = !!game.preview;
    const half = fit / 2;
    const ang = Math.atan2(d.y, d.x);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(ang - Math.PI / 2); // +y を重力方向に
    const baseY = Math.min(half + c * 0.06, (d.x !== 0 ? W : H) / 2 - c * 0.28);
    ctx.globalAlpha = preview ? 1 : 0.7;
    for (let k = 0; k < 3; k++) {
      const ph = ((game.clock * 1.8 + k / 3) % 1);
      const yy = baseY - c * 0.25 + ph * c * 0.3;
      ctx.globalAlpha = (preview ? 1 : 0.65) * Math.sin(ph * Math.PI);
      ctx.beginPath();
      for (const sx of [-2.2, 0, 2.2]) {
        ctx.moveTo(sx * c - c * 0.32, yy - c * 0.12);
        ctx.lineTo(sx * c, yy + c * 0.1);
        ctx.lineTo(sx * c + c * 0.32, yy - c * 0.12);
      }
      ctx.strokeStyle = preview ? '#e2733a' : '#8e5a2b';
      ctx.lineWidth = c * 0.09;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 入力 ----
  let heldDir = null;
  const padButtons = [...document.querySelectorAll('#pad .dir')];
  function setHeld(dir) {
    heldDir = dir;
    padButtons.forEach((b) => b.classList.toggle('held', b.dataset.dir === dir));
    setPreview(dir);
  }

  padButtons.forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sfx.ensure();
      btn.setPointerCapture(e.pointerId);
      setHeld(btn.dataset.dir);
    });
    btn.addEventListener('pointerup', (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const dir = heldDir;
      setHeld(null);
      if (dir && el && el.closest('.dir') === btn) commitScreen(dir);
    });
    btn.addEventListener('pointercancel', () => setHeld(null));
  });

  // スワイプ
  let swipe = null;
  wrap.addEventListener('pointerdown', (e) => {
    sfx.ensure();
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, dir: null };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!swipe || swipe.id !== e.pointerId) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    let dir = null;
    if (Math.hypot(dx, dy) >= CONFIG.swipeMin) {
      // 下向きのスワイプは使わない（重力はいつも画面の下）
      dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy < 0 ? 'up' : null;
    }
    if (dir !== swipe.dir) {
      swipe.dir = dir;
      setHeld(dir);
    }
  });
  const endSwipe = (commitIt) => (e) => {
    if (!swipe || swipe.id !== e.pointerId) return;
    const dir = swipe.dir;
    swipe = null;
    setHeld(null);
    if (commitIt && dir) commitScreen(dir);
  };
  wrap.addEventListener('pointerup', endSwipe(true));
  wrap.addEventListener('pointercancel', endSwipe(false));

  const KEYS = {
    ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', a: 'left', d: 'right', W: 'up', A: 'left', D: 'right',
  };
  window.addEventListener('keydown', (e) => {
    if (game.screen !== 'play') {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        startGame(game.screen === 'title' ? loadProgress() || 0 : 0);
      }
      return;
    }
    const dir = KEYS[e.key];
    if (dir) {
      e.preventDefault();
      if (!e.repeat) {
        sfx.ensure();
        setHeld(dir);
      }
      return;
    }
    if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') undo();
    if (e.key === 'r' || e.key === 'R') reset();
  });
  window.addEventListener('keyup', (e) => {
    const dir = KEYS[e.key];
    if (dir && heldDir === dir) {
      setHeld(null);
      commitScreen(dir);
    }
  });
  window.addEventListener('blur', () => setHeld(null));

  ui.undo.addEventListener('click', undo);
  ui.reset.addEventListener('click', reset);
  $('btn-continue').addEventListener('click', () => startGame(loadProgress() || 0));
  $('btn-start').addEventListener('click', () => startGame(0));
  $('btn-retry').addEventListener('click', () => startGame(0));
  $('btn-home').addEventListener('click', showTitle);


  // ---- ループ ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!manual) update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(wrap);
  resize();
  // タイトルの後ろにステージ1を見せておく
  game.level = levels[0];
  game.state = cloneState(game.level.start);
  syncVis();
  updateHud();
  renderTitle();
  requestAnimationFrame(frame);

  // ---- 確認用の入口 ----
  window.__game = {
    config: CONFIG,
    levels,
    get snapshot() {
      return {
        screen: game.screen,
        stage: game.stageIdx,
        moves: game.moves,
        gravity: game.gravity,
        state: cloneState(game.state),
        open: L.isOpen(game.level, game.state),
        animating: !!game.anim,
        entering: !!game.enter,
        canAct: canAct(),
        clearing: !!game.clearing || game.pendingClear,
        canUndo: game.history.length > 0,
        best: { ...game.best },
        preview: game.preview ? game.preview.sdir : null,
        previewGrid: game.preview ? game.preview.dir : null,
        boxAngle: game.boxAngle,
        restAngle: game.restAngle,
      };
    },
    start: (i) => startGame(i),
    title: showTitle,
    press: commit, // 盤面の方向
    screenDir: (g) => toScreen(g), // 盤面の方向 → 今の画面上の方向
    sfx,
    pressScreen: commitScreen, // 画面上の方向
    hold: (dir) => setHeld(dir),
    release: () => setHeld(null),
    undo,
    reset,
    manual(on) {
      manual = !!on;
    },
    step(dt, n = 1) {
      for (let i = 0; i < n; i++) update(dt);
      draw();
    },
    solution() {
      return L.solve(game.level, game.state, game.gravity ? null : 'down').path;
    },
  };
})();
