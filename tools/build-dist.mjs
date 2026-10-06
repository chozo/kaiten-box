// 公開に必要なファイルだけを dist/ にコピーする
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const files = ['index.html', 'style.css', 'game.js', 'logic.js', 'levels.js', 'favicon.svg'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log(`dist/ に ${files.length} ファイルを出力しました`);
