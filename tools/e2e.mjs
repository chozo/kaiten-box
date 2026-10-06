// ブラウザでの通し確認（インストール済み Chrome をヘッドレスで使う）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { serve } from './serve.mjs';

// E2E_URL を指定すると公開URLを確認する（例: E2E_URL=https://game.chozo.net/kaiten-box/ npm run e2e）
const server = process.env.E2E_URL ? null : await serve(0);
const url = process.env.E2E_URL || `http://localhost:${server.address().port}/`;
const outDir = new URL('../.e2e/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

async function open(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => window.__game.manual(true));
  return { page, errors };
}
const snap = (page) => page.evaluate(() => window.__game.snapshot);
const step = (page, sec) => page.evaluate((s) => window.__game.step(1 / 60, Math.round(s * 60)), sec);

{
  const { page, errors } = await open(390, 844);
  await page.screenshot({ path: new URL('title.png', outDir).pathname });
  await page.click('#btn-start');
  let s = await snap(page);
  check(s.screen === 'play' && s.stage === 0 && s.gravity === null, '開始すると1面・無重力');

  // プレビュー
  await page.evaluate(() => window.__game.hold('left'));
  await step(page, 0.3);
  s = await snap(page);
  check(s.preview === 'left' && s.moves === 0, '押している間はプレビューだけで手数は増えない');
  await page.screenshot({ path: new URL('preview.png', outDir).pathname });
  await page.evaluate(() => window.__game.release());

  // 回転の途中を撮る
  await page.evaluate(() => window.__game.press('left'));
  await step(page, 0.14);
  await page.screenshot({ path: new URL('rotating.png', outDir).pathname });
  await step(page, 1.2);
  s = await snap(page);
  check(s.moves === 1 && s.gravity === 'left' && !s.animating, '1手進み、重力が左になる');

  // 箱は回したまま。操作は画面の向き
  check(Math.abs(s.boxAngle + Math.PI / 2) < 1e-6, `左に倒したあと箱は -90° のまま（実際 ${(s.boxAngle * 180 / Math.PI).toFixed(1)}°）`);
  await page.evaluate(() => window.__game.hold('left'));
  s = await snap(page);
  check(s.preview === 'left' && s.previewGrid === 'up', `回った箱で画面の◀は盤面の「上」への重力になる（実際 ${s.previewGrid}）`);
  await page.evaluate(() => window.__game.release());
  check(await page.$('[data-dir="down"]') === null, '▼ボタンがない');

  // 戻す（何回でも）
  await page.evaluate(() => window.__game.press('up'));
  await step(page, 1.3);
  await page.evaluate(() => window.__game.undo());
  await page.evaluate(() => window.__game.undo());
  s = await snap(page);
  check(s.moves === 0 && s.gravity === null && !s.canUndo, '2手進めて2回戻すと開始状態に戻る');

  // 3面を解答どおりに解く
  const N = await page.evaluate(() => window.__game.levels.length);
  check(N === 5, `ステージは5面（実際 ${N}）`);
  for (let st = 0; st < N; st++) {
    const path = await page.evaluate(() => window.__game.solution());
    for (const [i, d] of path.entries()) {
      await page.evaluate((dir) => window.__game.press(dir), d);
      await step(page, i === path.length - 1 ? 0.5 : 1.3);
      if (st === 4 && i === 4) await page.screenshot({ path: new URL('stage5-mid.png', outDir).pathname });
    }
    if (st === 0) {
      await page.screenshot({ path: new URL('clear.png', outDir).pathname });
      await step(page, 1.0);
      await page.screenshot({ path: new URL('slide-out.png', outDir).pathname });
      await step(page, 0.55);
      await page.screenshot({ path: new URL('slide-in.png', outDir).pathname });
      await step(page, 1.5);
    } else {
      await step(page, 3);
    }
    s = await snap(page);
    if (st < N - 1) check(s.stage === st + 1 && s.screen === 'play', `${st + 1}面を最短手数で脱出し、次の面へ`);
  }
  s = await snap(page);
  check(s.screen === 'result' && Object.keys(s.best).length === N, `全面クリアで「ぜんぶ脱出！」画面・自己ベストが${N}面分残る`);
  check(await page.evaluate(() => document.getElementById('result').classList.contains('party')), '全クリアでお祝いの演出が始まる');
  await page.waitForTimeout(400);
  await page.screenshot({ path: new URL('party-early.png', outDir).pathname });
  await page.waitForTimeout(3200);
  await step(page, 1.2);
  await page.screenshot({ path: new URL('result.png', outDir).pathname });

  // 時間切れがない
  await page.click('#btn-retry');
  await step(page, 200);
  s = await snap(page);
  check(s.screen === 'play' && s.stage === 0, '200秒放置しても終わらない');

  // つづきから: 1面を抜けて2面の途中で閉じる → タイトルに「つづきから（ステージ2）」
  await page.evaluate(() => {
    const g = window.__game;
    for (const d of g.solution()) {
      g.press(d);
      g.step(1 / 60, 90);
    }
    g.step(1 / 60, 200);
  });
  s = await snap(page);
  check(s.stage === 1, '1面を抜けて2面へ');
  await page.reload();
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => window.__game.manual(true));
  const cont = await page.$eval('#btn-continue', (b) => ({ hidden: b.hidden, text: b.textContent }));
  const startText = await page.$eval('#btn-start', (b) => b.textContent);
  check(!cont.hidden && cont.text.includes('ステージ 2') && startText === 'はじめから', `タイトルに「つづきから（ステージ2）」と「はじめから」 ${cont.text}/${startText}`);
  await page.screenshot({ path: new URL('continue.png', outDir).pathname });
  await page.click('#btn-continue');
  s = await snap(page);
  check(s.screen === 'play' && s.stage === 1, '「つづきから」で2面から再開');
  await page.evaluate(() => window.__game.title());
  await page.click('#btn-start');
  s = await snap(page);
  check(s.stage === 0, '「はじめから」で1面から');
  // 最後まで抜けると「つづきから」は消える
  await page.evaluate(() => {
    const g = window.__game;
    for (let k = 0; k < g.levels.length; k++) {
      for (const d of g.solution()) {
        g.press(d);
        g.step(1 / 60, 90);
      }
      g.step(1 / 60, 200);
    }
  });
  s = await snap(page);
  check(s.screen === 'result', '全面クリア');
  await page.reload();
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => window.__game.manual(true));

  // ステージ選択はなく、全クリア後に再読み込みして「はじめる」でも1面から
  check(await page.$eval('#btn-continue', (b) => b.hidden) && (await page.$eval('#btn-start', (b) => b.textContent)) === 'はじめる', '全クリア後は「つづきから」が出ない');
  check(await page.$('.stage-btn') === null && await page.$('#hud-menu') === null, 'ステージ選択のUIがない');
  await page.reload();
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => window.__game.manual(true));
  s = await snap(page);
  check(Object.keys(s.best).length === N, '再読み込みしても自己ベストが残る');
  await page.click('#btn-start');
  s = await snap(page);
  check(s.screen === 'play' && s.stage === 0, '「はじめる」は1面から');
  check(errors.length === 0, 'コンソールエラーなし ' + errors.join(' | '));
  await page.close();
}

// 画面サイズ
for (const [w, h, name] of [[360, 640, 'small'], [1280, 800, 'pc']]) {
  const { page } = await open(w, h);
  await page.click('#btn-start');
  await step(page, 1.5);
  const ok = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect();
    const pad = document.getElementById('controls').getBoundingClientRect();
    return pad.bottom <= app.bottom + 1 && app.bottom <= window.innerHeight + 1 && app.right <= window.innerWidth + 1;
  });
  check(ok, `${w}×${h} で操作ボタンまで画面内に収まる`);
  await page.screenshot({ path: new URL(`${name}.png`, outDir).pathname });
  await page.close();
}

await browser.close();
server?.close();
console.log(failed ? `失敗 ${failed}件` : 'すべて成功');
process.exit(failed ? 1 : 0);
