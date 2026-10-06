// 告知動画の台本。上から順に実行する。
// wait（秒）と until:'idle'（動きが落ち着くまで）だけが時間を進め、ほかはその場で実行される。
// move: 'next' は最短解の次の1手（hold 秒だけプレビューを見せてから確定）、'wrong' はわざと外す1手。
export const URL_TEXT = 'kaiten-box.matsudam.workers.dev';
export const DURATION = 30;

export const steps = [
  // ---- 0〜2秒: つかみ（いきなりひっくり返して、中身が一斉に落ちる） ----
  { start: 2 },
  { zoom: 1.1, over: 2.0 },
  { wait: 0.15 },
  { cap: 'ひっくり返せ！', at: 'mid', dur: 1.4, size: 1.15 },
  { move: 'flip', hold: 0.25 },
  { wait: 0.55 },
  { fx: 'shake' },
  { cap: 'ドドドッ', at: 'low', dur: 0.9, size: 0.9, color: 'orange', tilt: -8 },
  { wait: 0.95 },

  // ---- 2〜6秒: タイトル ----
  { fx: 'flash' },
  { start: 0 },
  { zoom: 1, over: 0 },
  { title: true },
  { wait: 3.0 },
  { title: false },
  { wait: 0.2 },

  // ---- 6〜24秒: プレイ ----
  { cap: '押すと、止まる場所が見える', at: 'top', dur: 2.0, size: 0.6 },
  { move: 'next', hold: 0.7 },
  { until: 'idle' },
  { move: 'next', hold: 0.5 },
  { until: 'idle' },
  { cap: '積み木でスイッチON', at: 'top', dur: 1.4, size: 0.6 },
  { move: 'next', hold: 0.45 },
  { wait: 0.45 },
  { cap: '脱出！', at: 'mid', dur: 1.0, size: 1.2, color: 'orange' },
  { until: 'idle' },

  // 2面: 積み木を足場に
  { cap: '積み木を足場に', at: 'top', dur: 1.6, size: 0.6 },
  { move: 'next', hold: 0.35 },
  { until: 'idle' },
  { move: 'next', hold: 0.35 },
  { until: 'idle' },
  { move: 'next', hold: 0.35 },
  { wait: 0.4 },
  { cap: 'スルッ', at: 'low', dur: 0.8, size: 0.85, color: 'green', tilt: 6 },
  { until: 'idle' },

  // 3面: 惜しい失敗 → 戻す
  { move: 'wrong', hold: 0.2 },
  { until: 'idle' },
  { cap: 'おっと…', at: 'mid', dur: 0.9, size: 0.9, color: 'blue' },
  { wait: 0.7 },
  { undo: true },
  { cap: '何回でも戻せる', at: 'top', dur: 1.2, size: 0.6 },
  { wait: 0.3 },

  // 早送りで3〜5面
  { speed: 3 },
  { badge: '×3' },
  { solveUntil: 4, hold: 0 },
  { until: 'idle' },
  { badgeOff: true },
  { speed: 1 },

  // ---- 24〜27秒: クライマックス（5面の最後の1手 → ぜんぶ脱出） ----
  { cap: 'ラスト1手！', at: 'top', dur: 1.0, size: 0.75 },
  { move: 'next', hold: 0.6 },
  { wait: 0.5 },
  { cap: 'ぜんぶ脱出！', at: 'low', dur: 0.9, size: 0.95, color: 'orange' },
  { wait: 3.4 },

  // ---- 27〜30秒: エンドカード ----
  { end: true },
];
