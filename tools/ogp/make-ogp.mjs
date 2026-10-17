// SNS共有用の OGP 画像（1200×630）を public/ogp.png に作る。
//   npm run ogp
// 1. ゲームを縦長の画面で開き、確認用の入口（window.__game）で見栄えのよい場面まで進めて撮る
// 2. 同じページの上に 1200×630 の台紙を重ね、撮った画面・タイトル・遊び方・URL・ハムスターを並べて撮る
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, '../../public/ogp.png');

// 撮る場面: このステージを解答どおりに進め、MOVES 手目の回転が終わったところ
const STAGE = 2;
const MOVES = 3;
const URL_TEXT = 'game.chozo.net/kaiten-box';

const server = await serve(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('pageerror', e));
await page.goto(url);
await page.waitForFunction(() => window.__game);
await page.evaluate(() => {
  localStorage.clear();
  window.__game.manual(true);
});

// 1. ゲーム画面を撮る
await page.evaluate(({ stage, moves }) => {
  const g = window.__game;
  g.start(stage);
  g.step(1 / 60, 120); // 入場の演出を終わらせる
  for (let i = 0; i < moves; i++) {
    g.press(g.solution()[0]);
    g.step(1 / 60, 90);
  }
  g.step(1 / 60, 240); // ステージ名などの表示を消す
}, { stage: STAGE, moves: MOVES });
const shot = await page.locator('#app').screenshot({ type: 'png' });

// 2. 台紙に並べて撮る（ハムスターを描くため同じゲームを等倍で開き直す）
const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await card.goto(url);
await card.waitForFunction(() => window.__game);
await card.evaluate(({ img, urlText }) => {
  const style = document.createElement('style');
  style.textContent = `
    #ogp { position: fixed; inset: 0; width: 1200px; height: 630px; z-index: 9999; overflow: hidden;
      font-family: "Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif; color: #5a3416;
      background:
        radial-gradient(circle at 30% 45%, rgba(255,248,226,.97), rgba(255,248,226,0) 62%),
        repeating-linear-gradient(-45deg, #ecd3a4 0 22px, #e5c993 22px 24px); }
    #ogp .shot { position: absolute; left: 768px; top: 34px; width: 380px; border-radius: 22px;
      transform: rotate(4deg); transform-origin: 50% 0;
      box-shadow: 0 18px 40px rgba(90,55,20,.35), 0 0 0 6px #fff8ea, 0 0 0 10px #c98a4b; }
    #ogp .text { position: absolute; left: 64px; top: 0; bottom: 0; width: 660px;
      display: flex; flex-direction: column; justify-content: center; align-items: flex-start; }
    #ogp .ham { width: 220px; height: 220px; margin: 0 0 -26px 6px; }
    #ogp .logo { font-size: 104px; font-weight: 900; color: #ffb347; white-space: nowrap; line-height: 1.15;
      -webkit-text-stroke: 16px #5a3416; paint-order: stroke fill; text-shadow: 0 8px 0 #5a3416; }
    #ogp .lead { margin-top: 22px; font-size: 40px; font-weight: 800; line-height: 1.4; }
    #ogp .url { margin-top: 26px; padding: 10px 26px; border-radius: 16px; background: #fff8ea;
      border: 4px solid #c98a4b; font-size: 32px; font-weight: 700; font-family: "Hiragino Sans", sans-serif; }
  `;
  document.head.append(style);
  const root = document.createElement('div');
  root.id = 'ogp';
  root.innerHTML = `
    <img class="shot" src="${img}">
    <div class="text">
      <canvas class="ham" width="440" height="440"></canvas>
      <div class="logo">回転ボックス</div>
      <div class="lead">ボックスを回して、<br>ハムスターを外に出そう！</div>
      <div class="url">${urlText}</div>
    </div>`;
  document.body.append(root);
  const cv = root.querySelector('.ham');
  const c2 = cv.getContext('2d');
  const W = cv.width;
  const size = W * 0.66;
  c2.fillStyle = 'rgba(90,55,20,.18)';
  c2.beginPath();
  c2.ellipse(W / 2, W * 0.9, size * 0.36, size * 0.06, 0, 0, Math.PI * 2);
  c2.fill();
  window.__game.drawHamsterOn(c2, W / 2, W * 0.9 - size * 0.62, size, { angle: -0.12, clear: true });
}, { img: `data:image/png;base64,${shot.toString('base64')}`, urlText: URL_TEXT });
await card.waitForFunction(() => document.querySelector('#ogp .shot').complete);
await card.evaluate(() => document.fonts.ready);
await card.screenshot({ path: outFile, clip: { x: 0, y: 0, width: 1200, height: 630 } });

await browser.close();
server.close();
console.log('OGP画像:', outFile);
