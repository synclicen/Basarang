// Uji kontrak: assets/speech_shim.js harus menghasilkan bentuk event Web Speech
// API yang persis dibaca public/prompter.js (onSpeechResult / onerror / onend).
// Dijalankan: node android/test-shim.mjs
import { readFileSync } from 'node:fs';

const shim = readFileSync(new URL('./assets/speech_shim.js', import.meta.url), 'utf8');

function makeWindow(available) {
  const calls = [];
  const w = {
    __calls: calls,
    location: { hash: '#/dashboard' },
    addEventListener: () => {},
  };
  w.NativeSpeech = {
    available: () => available,
    start: (lang) => calls.push(['start', lang]),
    stop: () => calls.push(['stop']),
    keepAwake: (on) => calls.push(['keepAwake', on]),
  };
  new Function('window', shim)(w);
  return w;
}

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'OK  ' : 'GAGAL') + ' - ' + msg);
  if (!cond) failed++;
};

// --- skenario 1: bridge tersedia ---
const w = makeWindow(true);
ok(typeof w.SpeechRecognition === 'function', 'window.SpeechRecognition terpasang saat bridge tersedia');
ok(typeof w.webkitSpeechRecognition === 'function', 'window.webkitSpeechRecognition terpasang');
ok(w.__calls.some((c) => c[0] === 'keepAwake' && c[1] === false), 'keepAwake(false) untuk hash non-prompter');

const rec = new w.SpeechRecognition();
rec.lang = 'id-ID';
rec.continuous = true;
rec.interimResults = true;
rec.maxAlternatives = 1;

let ev = null;
rec.onresult = (e) => { ev = e; };
rec.onerror = () => {};
rec.onend = () => {};
rec.start();
ok(w.__calls.some((c) => c[0] === 'start' && c[1] === 'id-ID'), 'start() meneruskan lang ke bridge');

// interim (isFinal=false)
w.__basarangCb({ type: 'result', text: 'assalamualaikum warahmatullahi', isFinal: false });
ok(ev && ev.resultIndex === 0, 'event.resultIndex === 0');
ok(ev && ev.results.length === 1, 'event.results.length === 1');
ok(ev && ev.results[0][0].transcript === 'assalamualaikum warahmatullahi', 'results[0][0].transcript terbaca');
ok(ev && ev.results[0].isFinal === false, 'results[0].isFinal === false untuk interim');

// final (isFinal=true) — persis pola prompter.js:
// for (i = event.resultIndex; i < event.results.length; i++) { res.isFinal ? ingest(true) : interim }
w.__basarangCb({ type: 'result', text: 'selamat pagi semuanya', isFinal: true });
ok(ev && ev.results[0].isFinal === true, 'results[0].isFinal === true untuk final');
ok(ev && ev.results[0][0].transcript === 'selamat pagi semuanya', 'teks final terbaca');

// error
let err = null;
rec.onerror = (e) => { err = e; };
w.__basarangCb({ type: 'error', code: 'not-allowed' });
ok(err && err.error === 'not-allowed', "event.error diteruskan ('not-allowed')");

// end
let ended = false;
rec.onend = () => { ended = true; };
w.__basarangCb({ type: 'end' });
ok(ended, 'onend terpanggil saat sesi berakhir');

// abort → stop bridge
rec.abort();
ok(w.__calls.some((c) => c[0] === 'stop'), 'abort() meneruskan stop ke bridge');

// instans baru (prompter restart koneksi tiap sesi)
const rec2 = new w.SpeechRecognition();
let ev2 = null;
rec2.onresult = (e) => { ev2 = e; };
rec2.start();
w.__basarangCb({ type: 'result', text: 'lanjut naskah', isFinal: true });
ok(ev2 && ev2.results[0][0].transcript === 'lanjut naskah', 'instans baru menerima hasil setelah restart');

// --- skenario 2: layanan pengenalan suara tidak tersedia ---
const w2 = makeWindow(false);
ok(!w2.SpeechRecognition && !w2.webkitSpeechRecognition,
   'shim TIDAK memasang SpeechRecognition saat layanan native absen (prompter jatuh ke mode Timer)');

// --- skenario 3: tanpa bridge sama sekali (mis. halaman dimuat di browser biasa) ---
const w3 = {};
new Function('window', shim)(w3);
ok(!w3.SpeechRecognition, 'shim diam saat window.NativeSpeech tidak ada');

if (failed) {
  console.error('\n' + failed + ' asersi GAGAL');
  process.exit(1);
}
console.log('\nSemua asersi kontrak shim LULUS');
