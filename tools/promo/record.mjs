// 告知動画の撮影と書き出し。
//   npm run promo                    … 全コマを撮影して ../video/kaiten-box-promo.mp4 と表紙を作る
//   PROMO_EVERY=15 npm run promo     … 15コマおきの静止画だけ撮り、一覧画像（../video/work/sheet.jpg）で構成を確認
//   PROMO_ENCODE_ONLY=1 npm run promo … 撮り直さず、../video/work/ の素材から書き出しだけやり直す
import { chromium } from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.mjs';
import { steps, DURATION, URL_TEXT } from './scenario.js';

const FPS = 30;
const SLUG = 'kaiten-box';
const here = path.dirname(fileURLToPath(import.meta.url));
const videoDir = path.resolve(here, '../../../video');
const work = path.join(videoDir, 'work');
const framesDir = path.join(work, 'frames');
const EVERY = Number(process.env.PROMO_EVERY) || 0;
const ENCODE_ONLY = !!process.env.PROMO_ENCODE_ONLY;
const ff = (args) => execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

if (!ENCODE_ONLY) await capture();
if (EVERY) {
  ff(['-framerate', '1', '-pattern_type', 'glob', '-i', path.join(framesDir, '*.jpg'), '-vf', 'scale=216:-1,tile=10x6:padding=4:color=white', '-frames:v', '1', path.join(work, 'sheet.jpg')]);
  console.log('一覧画像:', path.join(work, 'sheet.jpg'));
} else {
  encode();
}

async function capture() {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const server = await serve(0);
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('pageerror', e));
  await page.goto(url);
  await page.waitForFunction(() => window.__game);
  // 台本の中だけ: 全面を最短でクリア済みにして、お祝いで ★5/5 を出す。途中の記録は消す
  await page.evaluate(() => {
    const best = {};
    window.__game.levels.forEach((lv, i) => (best[i] = lv.par));
    localStorage.setItem('hako-hamster-best-v2', JSON.stringify(best));
    localStorage.removeItem('hako-hamster-progress');
  });
  await page.reload();
  await page.waitForFunction(() => window.__game);
  await page.addStyleTag({ path: path.join(here, 'promo.css') });
  await page.evaluate(installPromo, { urlText: URL_TEXT });

  const snap = () => page.evaluate(() => window.__game.snapshot);
  const idle = (s) => s.screen === 'play' && !s.animating && !s.entering && !s.clearing && s.canAct;
  let i = 0;
  let speed = 1;
  const total = Math.round(DURATION * FPS);
  for (let f = 0; f < total; f++) {
    const vt = f / FPS;
    // 台本を進める（wait / until / move の確定待ちで止まる）
    while (i < steps.length) {
      const st = steps[i];
      if (st.wait != null) {
        st._until ??= vt + st.wait;
        if (vt < st._until) break;
      } else if (st.until === 'idle') {
        if (!idle(await snap())) break;
      } else if (st.move) {
        if (!st._phase) {
          if (!idle(await snap())) break;
          st._g = await page.evaluate((kind) => {
            const g = window.__game;
            const sol = g.solution();
            if (kind === 'next') return sol[0];
            if (kind === 'flip') return ['up', 'down', 'left', 'right'].find((d) => g.screenDir(d) === 'up');
            return ['right', 'left', 'up'].find((d) => d !== sol[0] && g.screenDir(d) !== 'down');
          }, st.move);
          await page.evaluate((g) => window.__promo.hold(window.__game.screenDir(g)), st._g);
          st._phase = 1;
          st._t = vt + (st.hold || 0);
        }
        if (vt < st._t) break;
        await page.evaluate((g) => {
          window.__promo.hold(null);
          window.__game.press(g);
        }, st._g);
      } else if (st.solveUntil != null) {
        const s = await snap();
        if (!idle(s)) break;
        const sol = await page.evaluate(() => window.__game.solution());
        if (s.stage === st.solveUntil && sol.length === 1) {
          i++;
          continue;
        }
        await page.evaluate((g) => window.__game.press(g), sol[0]);
        break;
      } else if (st.speed != null) {
        speed = st.speed;
      } else {
        await page.evaluate((x) => window.__promo.act(x), st);
      }
      i++;
    }
    await page.evaluate(({ vt, dt }) => window.__promo.tick(vt, dt), { vt, dt: speed / FPS });
    if (!EVERY || f % EVERY === 0) {
      await page.screenshot({ path: path.join(framesDir, String(f).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92 });
    }
    if (f % 90 === 0) process.stdout.write(`\r撮影 ${f}/${total}  台本 ${i}/${steps.length}   `);
  }
  console.log(`\r撮影 ${total}/${total}  台本 ${i}/${steps.length}`);
  if (i < steps.length) console.warn('⚠ 台本が最後まで進みませんでした。待ち時間を見直してください');

  if (!EVERY) {
    const events = await page.evaluate(() => window.__game.sfx.takeRecording());
    console.log(`効果音 ${events.length} 回を書き出し中…`);
    const b64 = await page.evaluate(
      ({ events, d }) => window.__game.sfx.renderOffline(events, d, { beat: { from: 2.0, to: d, bpm: 120 } }),
      { events, d: DURATION },
    );
    fs.writeFileSync(path.join(work, 'audio.wav'), Buffer.from(b64, 'base64'));
  }
  await browser.close();
  server.close();
}

function encode() {
  const out = path.join(videoDir, `${SLUG}-promo.mp4`);
  const cover = path.join(videoDir, `${SLUG}-promo-cover.jpg`);
  ff([
    '-framerate', String(FPS), '-i', path.join(framesDir, '%05d.jpg'),
    '-i', path.join(work, 'audio.wav'),
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-af', 'volume=12dB,acompressor=threshold=-28dB:ratio=6:attack=1:release=120,alimiter=limit=0.35:attack=1:release=50,loudnorm=I=-14:TP=-2:LRA=11,aresample=44100,aformat=channel_layouts=stereo',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart', '-shortest', out,
  ]);
  const last = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort().pop();
  fs.copyFileSync(path.join(framesDir, last), cover);
  console.log('書き出し:', out);
  console.log('表紙:', cover);
}

// ---- ページ内: 撮影用の重ね表示と、動画の時刻でゲーム・CSSアニメを進める ----
function installPromo({ urlText }) {
  const g = window.__game;
  g.manual(true);
  let vtNow = 0;
  g.sfx.record(() => vtNow);
  const layer = document.createElement('div');
  layer.id = 'promo-layer';
  layer.innerHTML = `
    <div id="promo-title"><div class="ham">🐹</div><div class="logo">${[...'回転ボックス'].map((c) => `<span>${c}</span>`).join('')}</div><div class="sub">ボックスを回して<br>ハムスターを外に出そう！</div></div>
    <div id="promo-badge"></div>
    <div id="promo-tap">👆</div>
    <div id="promo-end"><div class="ham">🐹</div><div class="logo">回転ボックス</div><div class="play">ブラウザで今すぐ遊べる</div><div class="url">${urlText}</div><div class="note">無料・インストール不要</div></div>
    <div id="promo-flash"></div>`;
  document.body.appendChild(layer);
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const easeOutBack = (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const S = { caps: [], flash: -9, shake: -9, zoom: { from: 1, to: 1, t0: 0, over: 0 }, title: null, end: null, badge: null, tap: null };
  const Y = { top: 168, mid: 330, low: 470 };

  window.__promo = {
    hold(dir) {
      S.tap = dir;
      g.hold(dir);
    },
    act(st) {
      const t = vtNow;
      if (st.start != null) g.start(st.start);
      if (st.zoom != null) S.zoom = { from: currentZoom(t), to: st.zoom, t0: t, over: st.over || 0.001 };
      if (st.cap) {
        const el = document.createElement('div');
        el.className = 'pcap ' + (st.color || '');
        el.textContent = st.cap;
        el.style.fontSize = 54 * (st.size || 1) + 'px';
        el.style.top = Y[st.at || 'mid'] + 'px';
        layer.insertBefore(el, $('promo-flash'));
        S.caps.push({ el, t0: t, dur: st.dur || 1.2, tilt: st.tilt || 0 });
      }
      if (st.fx === 'flash') S.flash = t;
      if (st.fx === 'shake') S.shake = t;
      if (st.title === true) S.title = { t0: t, t1: Infinity };
      if (st.title === false && S.title) S.title.t1 = t;
      if (st.undo) g.undo();
      if (st.badge) {
        $('promo-badge').textContent = st.badge;
        S.badge = t;
      }
      if (st.badgeOff) S.badge = null;
      if (st.end) S.end = t;
    },
    tick(vt, dt) {
      vtNow = vt;
      g.step(dt);
      // CSSアニメーションを動画の時刻で進める
      for (const a of document.getAnimations()) {
        if (a.__t0 == null) {
          a.__t0 = vt;
          a.pause();
        }
        a.currentTime = (vt - a.__t0) * 1000;
      }
      // ズームと揺れ
      const z = currentZoom(vt);
      const se = vt - S.shake;
      const sk = se < 0.4 ? (1 - se / 0.4) * 9 : 0;
      app.style.transform = `translate(${Math.sin(vt * 90) * sk}px, ${Math.cos(vt * 77) * sk}px) scale(${z})`;
      // 字幕: 弾んで出て、少し縮んで消える
      for (const c of S.caps) {
        const e = vt - c.t0;
        const pin = clamp(e / 0.25, 0, 1);
        const pout = clamp((e - c.dur + 0.2) / 0.2, 0, 1);
        const s = easeOutBack(pin) * (1 - pout * 0.3);
        c.el.style.opacity = e < 0 || pout >= 1 ? 0 : 1 - pout;
        c.el.style.transform = `translate(-50%, -50%) rotate(${c.tilt}deg) scale(${Math.max(0, s)})`;
      }
      // フラッシュ
      $('promo-flash').style.opacity = clamp(1 - (vt - S.flash) / 0.35, 0, 1);
      // 早送りバッジ
      const b = $('promo-badge');
      b.style.opacity = S.badge == null ? 0 : 1;
      b.style.transform = S.badge == null ? '' : `scale(${1 + 0.08 * Math.sin(vt * 12)})`;
      // ボタンを押す指
      const tap = $('promo-tap');
      const btn = S.tap && document.querySelector(`#pad [data-dir="${S.tap}"]`);
      if (btn) {
        const r = btn.getBoundingClientRect();
        tap.style.left = r.left + r.width / 2 + 'px';
        tap.style.top = r.top + r.height / 2 + 'px';
        tap.style.opacity = 1;
      } else {
        tap.style.opacity = 0;
      }
      // タイトル
      const tt = $('promo-title');
      if (S.title) {
        const e = vt - S.title.t0;
        const out = clamp((vt - S.title.t1) / 0.25, 0, 1);
        tt.style.opacity = clamp(e / 0.15, 0, 1) * (1 - out);
        tt.querySelectorAll('.logo span').forEach((sp, k) => {
          const p = clamp((e - 0.1 - k * 0.08) / 0.4, 0, 1);
          const wave = e > 1.2 ? Math.sin((e - 1.2) * 5 - k * 0.7) * 5 : 0;
          sp.style.transform = `translateY(${(1 - easeOutBack(p)) * -80 + wave}px) scale(${0.4 + 0.6 * easeOutBack(p)})`;
          sp.style.opacity = p > 0 ? 1 : 0;
        });
        const ham = tt.querySelector('.ham');
        ham.style.transform = `translateY(${-Math.abs(Math.sin(e * 5)) * 18}px) rotate(${Math.sin(e * 5) * 8}deg)`;
        tt.querySelector('.sub').style.opacity = clamp((e - 0.8) / 0.3, 0, 1);
      }
      // エンドカード
      const en = $('promo-end');
      if (S.end != null) {
        const e = vt - S.end;
        en.style.opacity = clamp(e / 0.25, 0, 1);
        en.querySelector('.logo').style.transform = `scale(${easeOutBack(clamp(e / 0.45, 0, 1))})`;
        en.querySelector('.play').style.transform = `scale(${(1 + 0.05 * Math.sin(e * 7)) * easeOutBack(clamp((e - 0.3) / 0.4, 0, 1))})`;
        en.querySelector('.ham').style.transform = `translateY(${-Math.abs(Math.sin(e * 4.5)) * 22}px)`;
      }
    },
  };
  function currentZoom(t) {
    const zz = S.zoom;
    const p = clamp((t - zz.t0) / zz.over, 0, 1);
    return zz.from + (zz.to - zz.from) * p;
  }
}
