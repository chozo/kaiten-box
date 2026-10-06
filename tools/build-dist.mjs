// 公開に必要なファイルだけを dist/kaiten-box/ にコピーする（公開URLの /kaiten-box/ に合わせる）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'kaiten-box');
const files = ['index.html', 'style.css', 'game.js', 'logic.js', 'levels.js', 'favicon.svg'];
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log(`dist/kaiten-box/ に ${files.length} ファイルを出力しました`);
