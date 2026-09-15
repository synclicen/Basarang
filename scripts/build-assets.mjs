// build-assets.mjs — mengubah berkas di public/ menjadi src/assets.gen.js
// sehingga seluruh SPA ter-bundle dalam satu Worker (tanpa konfigurasi assets terpisah).
// Jalankan: node scripts/build-assets.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const FILES = [
  { route: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
  { route: '/app.js', file: 'app.js', type: 'application/javascript; charset=utf-8' },
  { route: '/align.js', file: 'align.js', type: 'application/javascript; charset=utf-8' },
  { route: '/prompter.js', file: 'prompter.js', type: 'application/javascript; charset=utf-8' },
  { route: '/favicon.svg', file: 'favicon.svg', type: 'image/svg+xml' },
];

const entries = FILES.map(({ route, file, type }) => {
  const body = readFileSync(join(pub, file), 'utf8');
  return `  ${JSON.stringify(route)}: { type: ${JSON.stringify(type)}, body: ${JSON.stringify(body)} },`;
}).join('\n');

const out = `// BERKAS DIHASILKAN OTOMATIS oleh scripts/build-assets.mjs — jangan sunting manual.
// Sumber: public/* — jalankan \`npm run build\` setelah mengubah berkas di public/.
export const ASSETS = {
${entries}
};
`;

writeFileSync(join(root, 'src', 'assets.gen.js'), out);
const total = FILES.reduce((n, f) => n + readFileSync(join(pub, f.file), 'utf8').length, 0);
console.log(`assets.gen.js ditulis (${FILES.length} berkas, ${total} karakter).`);
