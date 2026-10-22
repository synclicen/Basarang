/*
 * Basarang — jembatan SpeechRecognition WebView → Android SpeechRecognizer.
 * Disuntikkan MainActivity setelah halaman selesai dimuat (idempoten).
 *
 * WebView Android TIDAK menyediakan Web Speech API (window.SpeechRecognition),
 * padahal inti Basarang adalah "naskah mengikuti suara". Shim ini memasang
 * implementasi window.SpeechRecognition yang menyerahkan pekerjaan ke
 * SpeechRecognizer native Android lewat objek NativeSpeech (addJavascriptInterface),
 * dengan bentuk event yang sama persis seperti yang dibaca public/prompter.js:
 *
 *   rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
 *   rec.lang / rec.continuous / rec.interimResults / rec.maxAlternatives
 *   rec.onresult(event)  → event.resultIndex, event.results[i][0].transcript, results[i].isFinal
 *   rec.onerror(event)   → event.error ('not-allowed' | 'no-speech' | 'audio-capture' | ...)
 *   rec.onend()          → dipanggil saat sesi berakhir (prompter.js me-restart sendiri)
 *   rec.start() / rec.abort()
 *
 * Bila layanan pengenalan suara tidak tersedia di perangkat (mis. tanpa Google
 * app), shim tidak memasang apa pun → prompter.js otomatis jatuh ke mode Timer.
 */
(function () {
  if (window.__basarangShim) return;
  var NS = window.NativeSpeech;
  if (!NS) return;
  var ok = false;
  try { ok = NS.available(); } catch (e) { ok = false; }
  if (!ok) return;
  window.__basarangShim = true;

  function NSR() {
    this.lang = 'id-ID';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onspeechstart = null;
    this.onspeechend = null;
    this.onaudiostart = null;
    this.onaudioend = null;
    this.onnomatch = null;
  }
  NSR.prototype.start = function () {
    window.__nsInst = this;
    NS.start(this.lang || 'id-ID');
  };
  NSR.prototype.stop = function () { NS.stop(); };
  NSR.prototype.abort = function () { NS.stop(); };

  window.__basarangCb = function (msg) {
    var inst = window.__nsInst;
    if (!inst || !msg || typeof msg !== 'object') return;
    if (msg.type === 'result') {
      if (typeof inst.onresult !== 'function') return;
      var results = [{ isFinal: !!msg.isFinal, length: 1 }];
      results[0][0] = { transcript: String(msg.text == null ? '' : msg.text) };
      inst.onresult({ resultIndex: 0, results: results });
    } else if (msg.type === 'error') {
      if (typeof inst.onerror === 'function') inst.onerror({ error: msg.code || 'unknown' });
    } else if (msg.type === 'end') {
      if (typeof inst.onend === 'function') inst.onend();
    }
  };

  window.SpeechRecognition = NSR;
  window.webkitSpeechRecognition = NSR;

  // Layar tetap menyala hanya selama teleprompter terbuka (hemat baterai di
  // tampilan lain). Prompter dibuka/ditutup lewat hash routing SPA.
  function syncAwake() {
    var h = (window.location && window.location.hash) || '';
    try { NS.keepAwake(/^#\/prompter\//.test(h)); } catch (e) { /* abaikan */ }
  }
  window.addEventListener('hashchange', syncAwake);
  syncAwake();
})();
