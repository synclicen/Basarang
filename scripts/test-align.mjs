// test-align.mjs — unit test algoritma penyelarasan ucapan ↔ naskah
// align.js adalah skrip klasik bergaya UMD (kompatibel <script> browser);
// dimuat di sini persis seperti konteks browser: dievaluasi dengan module/exports.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/align.js', import.meta.url), 'utf8');
const module_ = { exports: {} };
new Function('module', 'exports', 'self', src)(module_, module_.exports, undefined);
const align = module_.exports;

let passed = 0;
let failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + '\n    harapan: ' + b + '\n    hasil  : ' + a);
  }
}

const script = `Assalamu'alaikum warahmatullahi wabarakatuh.
Bapak dan Ibu yang saya hormati.

Pada kesempatan yang berbahagia ini, izinkan saya menyampaikan sambutan singkat
mengenai transformasi digital di lingkungan kampus kita tercinta.
Terima kasih atas perhatian Bapak dan Ibu sekalian.`;

const norms = align.normalizeAll(script);

console.log('— Normalisasi —');
eq('jumlah kata > 30', norms.length > 30, true);
eq('tanda baca dibuang', norms.includes('assalamualaikum'), true);
eq('huruf besar dinormalkan', norms.includes('bapak'), true);
eq('kata kosong tersaring', norms.every((w) => w.length > 0), true);

console.log('— Kesetaraan fuzzy —');
eq('sama persis', align.fuzzyEq('kampus', 'kampus'), true);
eq('salah 1 huruf (kata panjang)', align.fuzzyEq('transformasi', 'transformosi'), true);
eq('kata pendek harus persis', align.fuzzyEq('dan', 'tan'), false);
eq('beda 2 huruf ditolak', align.fuzzyEq('kesempatan', 'kesempetin'), false);
eq('substitusi tunggal panjang beda', align.fuzzyEq('mengenai', 'mengenakan'), false);
eq('jarak 1 diterima', align.fuzzyEq('mengenai', 'mengenahi'), true);

console.log('— Penyelarasan berurutan —');
{
  const spoken = align.normalizeAll("Assalamu'alaikum warahmatullahi wabarakatuh");
  const r = align.alignSpoken(norms, spoken, 0);
  eq('3 kata pertama → pos 3', r.pos, 3);
  eq('semua cocok', r.matched, 3);
}

console.log('— Improvisasi / kata tak dikenal tidak menggeser —');
{
  // pengguna menyisipkan kata di luar naskah di tengah kalimat
  // mulai dari kata 'yang' (indeks 6) sebelum 'Pada' (indeks 9)
  const spoken = align.normalizeAll('yakni pada kesempatan yang mmm berbahagia ini');
  const r = align.alignSpoken(norms, spoken, 6);
  eq('kata asing (yakni, mmm) dilewati — 5 kata naskah cocok', r.matched, 5);
  eq('posisi berakhir setelah kata \'ini\' (indeks 13)', r.pos, 14);
}

console.log('— Lompat maju (pengguna melewati kalimat) —');
{
  // lompatan jauh (27 kata) di luar jendela lookahead 16 default —
  // ditangkap resyncSearch (jalur yang dipakai teleprompter saat improvisasi panjang)
  const spoken = align.normalizeAll('terima kasih atas perhatian');
  const r16 = align.alignSpoken(norms, spoken, 0);
  eq('lookahead 16 tidak melompat (aman dari salah lompat)', r16.pos, 0);
  const found = align.resyncSearch(norms, spoken, 0, norms.length - 1);
  eq('resync menemukan segmen', found && found.score >= 3, true);
  const r2 = align.alignSpoken(norms, spoken, found.start);
  eq('setelah resync posisi tepat setelah \'perhatian\'', norms[r2.pos - 1], 'perhatian');
  // lompatan dalam jangkauan lookahead langsung tertangkap
  const near = align.alignSpoken(norms, spoken, 20, { lookahead: 40 });
  eq('lookahead lebar mengejar lompatan', norms[near.pos - 1], 'perhatian');
}

console.log('— Mundur / resync —');
{
  const tail = align.normalizeAll('sambutan singkat mengenai transformasi');
  const found = align.resyncSearch(norms, tail, 0, norms.length - 1);
  eq('skor tinggi', found && found.score >= 3, true);
  const r = align.alignSpoken(norms, tail, found.start);
  eq('posisi akhir setelah ekor (transformasi, indeks 20)', r.pos, 21);
}

console.log('— Simulasi aliran ASR (interim → final, typo ringan) —');
{
  let pos = 0;
  const events = [
    ['assalamualaikum warahmatullahi', false],
    ['assalamualaikum warahmatullahi wabarakatuh', false],
    ['assalamualaikum warahmatullahi wabarakatuh', true],
    ['bapak dan ibu yang saya', false],
    ['bapak dan ibu yang saya hormati', true],
    ['pada kesempatan yang berbahagia ini izinkan saya menyampaikan', true],
    ['sambutn singkat mengenai transformasi digital', true], // 'sambutn' typo
  ];
  let committed = 0;
  for (const [text, isFinal] of events) {
    const spoken = align.normalizeAll(text);
    const r = align.alignSpoken(norms, spoken, committed);
    if (isFinal) committed = r.pos;
  }
  eq('akhir aliran = setelah kata digital', norms[committed - 1], 'digital');
}

console.log('— Kasus tepi —');
{
  const r = align.alignSpoken([], ['apapun'], 0);
  eq('naskah kosong aman', r.pos, 0);
  const r2 = align.alignSpoken(['a', 'b'], [], 0);
  eq('ucapan kosong aman', r2.pos, 0);
  const r3 = align.alignSpoken(norms, ['xyzzy'], 999);
  eq('startPos di luar jangkauan diklem', r3.pos <= norms.length, true);
  const found = align.resyncSearch([], ['a'], 0, 0);
  eq('resync naskah kosong → null', found, null);
}

console.log('');
console.log(`Hasil: ${passed} lulus, ${failed} gagal`);
if (failed > 0) process.exit(1);
