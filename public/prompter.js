// prompter.js — Mesin AI Teleprompter Basarang: Bagarak Saurang
// Mode Suara: Web Speech API (gratis, bawaan browser) — naskah mengikuti suara Anda.
// Mode Timer: gulir otomatis sesuai kecepatan baca (KPM).
// Ekstra: mirror (untuk hood teleprompter), rekam video, fullscreen, wake lock.
'use strict';

(() => {
  const A = () => window.BasarangAlign;

  const DEFAULTS = {
    mode: 'voice', // 'voice' | 'timer'
    lang: 'id-ID',
    wpm: 140,
    speed: 1, // pengganda kecepatan mode timer
    fontSize: 1, // pengganda
    lineHeight: 1.55,
    theme: 'gold', // 'gold' | 'contrast' | 'silver'
    mirrorX: false,
    mirrorY: false,
    guide: true,
  };
  const LANGS = [
    ['id-ID', 'Indonesia'],
    ['en-US', 'English (US)'],
    ['en-GB', 'English (UK)'],
    ['ar-SA', 'العربية'],
    ['ms-MY', 'Melayu'],
    ['jv-ID', 'Jawa'],
    ['su-ID', 'Sunda'],
    ['ja-JP', '日本語'],
    ['zh-CN', '中文'],
    ['ko-KR', '한국어'],
    ['hi-IN', 'हिन्दी'],
    ['th-TH', 'ไทย'],
    ['vi-VN', 'Tiếng Việt'],
    ['de-DE', 'Deutsch'],
    ['fr-FR', 'Français'],
    ['es-ES', 'Español'],
    ['tr-TR', 'Türkçe'],
  ];

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('basarang.prompter') || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem('basarang.prompter', JSON.stringify(s));
    } catch {
      /* abaikan */
    }
  }

  let active = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const ICON = {
    play: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    mic: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    auto: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 17.5 6.5"/><path d="M17.5 3 18.4 5.1 20.5 6 18.4 6.9 17.5 9 16.6 6.9 14.5 6 16.6 5.1Z" stroke-width="1.6"/><path d="M21.5 12.5v2.2M20.4 13.6h2.2" stroke-width="1.6"/></svg>',
    gear: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
    mirror: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M8 7 4 12l4 5M16 7l4 5-4 5"/></svg>',
    sync: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
    fontUp: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20 9 6l5 14M5.8 15.5h6.4M15 12h6M18 9v6"/></svg>',
    fontDown: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20 9 6l5 14M5.8 15.5h6.4M15 15h6M18 12v6"/></svg>',
    video: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
    full: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  };

  window.Prompter = {
    isActive: () => !!active,
    open(opts) {
      if (active) active.exit();
      active = createSession(opts);
      return active;
    },
    exit() {
      if (active) active.exit();
    },
  };

  function createSession({ script, projectName, onExit }) {
    const settings = loadSettings();
    const S = {
      script,
      projectName: projectName || '',
      settings,
      playing: false,
      mode: settings.mode,
      // posisi penyelarasan (indeks kata berikutnya)
      committedPos: 0,
      provisionalPos: 0,
      unmatchedRun: 0,
      recentSpoken: [],
      words: [], // [{raw, norm, el}]
      startedAt: null,
      elapsed: 0,
      exitRequested: false,
      timers: [],
      recognition: null,
      recActive: false,
      recFailCount: 0,
      manualScrollUntil: 0,
      animScroll: { raf: null, target: 0 },
      timerRaf: null,
      lastTick: 0,
      wakeLock: null,
      recorder: { stream: null, mediaRecorder: null, chunks: [], url: null },
      hudTimer: null,
    };

    // ---------- DOM ----------

    const root = document.createElement('div');
    root.className = 'prompter theme-' + settings.theme;
    root.innerHTML = `
      <div class="p-progress" id="p-progress"></div>
      <div class="p-scroll" id="p-scroll">
        <div class="p-guide" id="p-guide"><span class="line"></span><span class="tri-l"></span><span class="tri-r"></span></div>
        <div class="p-content" id="p-content"></div>
      </div>
      <div class="p-fade top"></div>
      <div class="p-fade bot"></div>
      <div class="p-hud-top">
        <button class="p-ctrl" id="p-exit" title="Keluar (Esc)">✕</button>
        <span class="p-title">${esc(script.title)}${projectName ? ' · ' + esc(projectName) : ''}</span>
        <span class="p-status" id="p-status"><span class="mic">${ICON.mic}</span><span id="p-status-txt">Siap</span></span>
        <span style="flex:1"></span>
        <button class="p-ctrl" id="p-rec" title="Rekam video (kamera)">${ICON.video}</button>
        <button class="p-ctrl" id="p-full" title="Layar penuh (F)">${ICON.full}</button>
        <button class="p-ctrl" id="p-set" title="Pengaturan (S)">${ICON.gear}</button>
      </div>
      <div class="p-hud-bot">
        <button class="p-ctrl" id="p-resync" title="Sinkron otomatis ulang dari kata terlihat (R)">${ICON.auto}</button>
        <button class="p-ctrl" id="p-font-down" title="Perkecil teks (-)">${ICON.fontDown}</button>
        <button class="p-play" id="p-play" title="Mulai / jeda (Spasi)">${ICON.play}</button>
        <button class="p-ctrl" id="p-font-up" title="Perbesar teks (+)">${ICON.fontUp}</button>
        <button class="p-ctrl" id="p-mirror" title="Cermin (M)">${ICON.mirror}</button>
        <span class="p-time" id="p-time">00:00</span>
        <span class="p-pct" id="p-pct">0%</span>
      </div>
      <div class="p-settings hidden" id="p-settings"></div>
      <div class="p-count hidden" id="p-count"></div>
      <video class="p-video hidden" id="p-video" autoplay playsinline muted></video>
      <div class="p-banner hidden" id="p-banner"></div>`;

    const $ = (id) => root.querySelector('#' + id);
    const elScroll = $('p-scroll');
    const elContent = $('p-content');
    const elProgress = $('p-progress');
    const elPlay = $('p-play');
    const elTime = $('p-time');
    const elPct = $('p-pct');
    const elStatus = $('p-status');
    const elStatusTxt = $('p-status-txt');
    const elGuide = $('p-guide');
    const elSettings = $('p-settings');
    const elCount = $('p-count');
    const elVideo = $('p-video');
    const elBanner = $('p-banner');

    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    // ---------- Render kata ----------

    function renderWords() {
      const paragraphs = String(script.content || '').split(/\n\s*\n/);
      elContent.innerHTML = '';
      const words = [];
      for (const para of paragraphs) {
        if (!para.trim()) continue;
        const p = document.createElement('p');
        p.className = 'p-para';
        const tokens = para.trim().split(/\s+/);
        tokens.forEach((tok, i) => {
          if (i > 0) p.appendChild(document.createTextNode(' '));
          const span = document.createElement('span');
          span.className = 'p-word';
          span.textContent = tok;
          p.appendChild(span);
          words.push({ raw: tok, norm: A().normalizeWord(tok), el: span });
        });
        elContent.appendChild(p);
      }
      S.words = words;
      S.norms = words.map((w) => w.norm); // cache — dihitung sekali, bukan tiap event suara
      // klik kata = lompat
      words.forEach((w, idx) => {
        w.el.addEventListener('click', () => {
          jumpTo(idx);
        });
      });
    }

    function applyTypography() {
      elContent.style.fontSize = `calc(clamp(26px, 5.4vw, 56px) * ${settings.fontSize})`;
      elContent.style.lineHeight = String(settings.lineHeight);
      elContent.classList.toggle('mirror-x', settings.mirrorX);
      elContent.classList.toggle('mirror-y', settings.mirrorY);
      root.className = 'prompter theme-' + settings.theme + (S.hudHidden ? ' p-hud-hidden' : '');
      elGuide.classList.toggle('hidden', !settings.guide);
      invalidateMetrics();
    }

    // ---------- Sorotan & progres ----------

    let curIdx = -1;
    function highlight(pos) {
      const prev = curIdx;
      curIdx = pos - 1;
      if (S.words[prev]) S.words[prev].el.classList.remove('cur');
      if (prev < 0) {
        for (let i = 0; i < pos; i++) S.words[i] && S.words[i].el.classList.add('done');
      } else if (pos > prev + 1) {
        for (let i = Math.max(0, prev + 1); i < pos; i++) S.words[i] && S.words[i].el.classList.add('done');
      } else if (pos <= prev + 1) {
        // mundur: bersihkan done dari pos..prev
        for (let i = Math.max(0, pos); i <= prev; i++) S.words[i] && S.words[i].el.classList.remove('done');
      }
      const cur = S.words[pos - 1] || S.words[0];
      if (cur) {
        cur.el.classList.add('cur');
        cur.el.classList.remove('done');
      }
      elPct.textContent = Math.round((pos / Math.max(1, S.words.length)) * 100) + '%';
      elProgress.style.width = Math.min(100, (pos / Math.max(1, S.words.length)) * 100) + '%';
    }

    function scrollToWord(pos, smooth = true) {
      const w = S.words[Math.max(0, Math.min(pos - 1, S.words.length - 1))];
      if (!w) return;
      const target = Math.max(0, w.el.offsetTop - elScroll.clientHeight * 0.42);
      animateScrollTo(target, smooth);
    }

    function animateScrollTo(target, smooth) {
      if (S.animScroll.raf) cancelAnimationFrame(S.animScroll.raf);
      if (!smooth) {
        elScroll.scrollTop = target;
        return;
      }
      const start = elScroll.scrollTop;
      const diff = target - start;
      if (Math.abs(diff) < 6) {
        elScroll.scrollTop = target;
        return;
      }
      const t0 = performance.now();
      const dur = Math.min(650, Math.max(160, Math.abs(diff) * 0.45));
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
        elScroll.scrollTop = start + diff * e;
        if (k < 1) S.animScroll.raf = requestAnimationFrame(step);
        else S.animScroll.raf = null;
      };
      S.animScroll.raf = requestAnimationFrame(step);
    }

    function jumpTo(idx) {
      S.committedPos = idx;
      S.provisionalPos = idx;
      S.unmatchedRun = 0;
      highlight(idx);
      scrollToWord(idx);
    }

    // ---------- Pengenalan suara (Web Speech API — gratis, bawaan browser) ----------

    function supportedVoice() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    function setStatus(txt, cls) {
      elStatus.className = 'p-status ' + (cls || '');
      elStatusTxt.textContent = txt;
    }

    function startVoice() {
      if (!supportedVoice()) {
        S.mode = 'timer';
        settings.mode = 'timer';
        banner('Pengenalan suara tidak tersedia di peramban ini — mode Timer otomatis aktif. Gunakan Chrome/Edge untuk mode Suara.', 6000);
        updateSettingsPanel();
        return;
      }
      if (S.recActive) return;
      try {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SR();
        rec.lang = settings.lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onresult = onSpeechResult;
        rec.onerror = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            banner('Akses mikrofon ditolak. Aktifkan izin mikrofon, atau gunakan mode Timer.', 6000);
            stopVoice();
            setPlaying(false);
          } else if (e.error === 'audio-capture') {
            banner('Mikrofon tidak terdeteksi. Mode Timer dapat digunakan.', 5000);
          }
          // 'no-speech' & 'aborted' wajar: onend akan restart
        };
        rec.onend = () => {
          S.recActive = false;
          if (S.playing && S.mode === 'voice' && !S.exitRequested && S.recFailCount < 6) {
            S.recFailCount++;
            S.timers.push(setTimeout(() => {
              try {
                if (S.playing && S.mode === 'voice') startVoice();
              } catch {
                /* abaikan */
              }
            }, 300));
          }
        };
        rec.start();
        S.recognition = rec;
        S.recActive = true;
        S.recFailCount = 0;
        setStatus('Mendengarkan…', 'listening');
      } catch (err) {
        // InvalidStateError bila sudah jalan — abaikan
      }
    }

    function stopVoice() {
      S.recActive = false;
      if (S.recognition) {
        try {
          S.recognition.onend = null;
          S.recognition.abort();
        } catch {
          /* abaikan */
        }
        S.recognition = null;
      }
      if (S.mode === 'voice') setStatus(S.playing ? 'Jeda' : 'Siap', '');
    }

    function onSpeechResult(event) {
      S.recFailCount = 0;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0] ? res[0].transcript : '';
        if (res.isFinal) {
          ingestSpoken(text, true);
        } else {
          interim += text + ' ';
        }
      }
      if (interim.trim()) {
        ingestSpoken(interim, false);
      } else if (S.provisionalPos !== S.committedPos) {
        S.provisionalPos = S.committedPos;
        highlight(S.provisionalPos);
        scrollToWord(S.provisionalPos);
      }
    }

    function ingestSpoken(text, isFinal) {
      const align = A();
      const spoken = align.normalizeAll(text);
      if (!spoken.length) return;
      if (isFinal) {
        S.recentSpoken.push(...spoken);
        if (S.recentSpoken.length > 24) S.recentSpoken = S.recentSpoken.slice(-24);
      }
      const r = align.alignSpoken(S.norms, spoken, S.committedPos);
      if (isFinal) {
        if (r.matched > 0) {
          S.committedPos = r.pos;
          S.unmatchedRun = 0;
        } else {
          S.unmatchedRun += r.unmatched;
        }
        // Resync otomatis setelah improvisasi panjang: cari ekor ucapan di seluruh naskah
        if (S.unmatchedRun >= 10 && S.recentSpoken.length >= 4) {
          const tail = S.recentSpoken.slice(-6);
          const found = align.resyncSearch(S.norms, tail, 0, S.norms.length - 1);
          if (found && found.score >= 3) {
            const r2 = align.alignSpoken(S.norms, tail, found.start);
            S.committedPos = r2.pos;
            S.unmatchedRun = 0;
          }
        }
        S.provisionalPos = S.committedPos;
      } else {
        S.provisionalPos = Math.max(S.provisionalPos, r.pos);
      }
      highlight(S.provisionalPos);
      if (Date.now() > S.manualScrollUntil) scrollToWord(S.provisionalPos);
    }

    // ---------- Mode timer ----------

    let cachedPxPerSec = null;
    function invalidateMetrics() {
      cachedPxPerSec = null;
    }
    function timerPxPerSec() {
      if (cachedPxPerSec != null) return cachedPxPerSec;
      const words = S.words.length || 1;
      const durSec = Math.max(8, (words / (settings.wpm || 140)) * 60);
      const dist = Math.max(1, elContent.offsetHeight - elScroll.clientHeight);
      cachedPxPerSec = dist / durSec;
      return cachedPxPerSec;
    }

    function timerTick(t) {
      if (!S.playing || S.mode !== 'timer') {
        S.timerRaf = null;
        return;
      }
      const dt = Math.min(0.25, (t - S.lastTick) / 1000 || 0.016);
      S.lastTick = t;
      elScroll.scrollTop += timerPxPerSec() * (settings.speed || 1) * dt;
      if (elScroll.scrollTop + elScroll.clientHeight >= elScroll.scrollHeight - 2) {
        // selesai
        setPlaying(false);
        elScroll.scrollTop = elScroll.scrollHeight;
        toastBanner('Naskah selesai. ✓');
      } else {
        updateTimerProgress();
        S.timerRaf = requestAnimationFrame(timerTick);
      }
    }

    function updateTimerProgress() {
      const max = Math.max(1, elScroll.scrollHeight - elScroll.clientHeight);
      const pct = Math.min(100, Math.round((elScroll.scrollTop / max) * 100));
      elPct.textContent = pct + '%';
      elProgress.style.width = pct + '%';
      const pos = Math.round((pct / 100) * S.words.length);
      if (pos !== curIdx + 1) highlight(pos);
    }

    // ---------- Play / pause & countdown ----------

    function setPlaying(p) {
      S.playing = p;
      elPlay.innerHTML = p ? ICON.pause : ICON.play;
      if (p) {
        if (!S.startedAt) S.startedAt = Date.now() - S.elapsed * 1000;
        if (S.mode === 'voice') {
          startVoice();
          // bila dukungan suara baru diketahui tidak ada, startVoice mengganti mode ke timer
        }
        if (S.mode === 'timer') {
          S.lastTick = performance.now();
          if (!S.timerRaf) S.timerRaf = requestAnimationFrame(timerTick);
        }
      } else {
        S.elapsed = S.startedAt ? (Date.now() - S.startedAt) / 1000 : 0;
        stopVoice();
        if (S.timerRaf) {
          cancelAnimationFrame(S.timerRaf);
          S.timerRaf = null;
        }
      }
    }

    function countdown(then) {
      elCount.classList.remove('hidden');
      let n = 3;
      const tick = () => {
        if (S.exitRequested) return;
        if (n <= 0) {
          elCount.innerHTML = '<span>Mulai</span>';
          S.timers.push(setTimeout(() => {
            elCount.classList.add('hidden');
            then();
          }, 500));
          return;
        }
        elCount.innerHTML = `<span>${n}</span>`;
        n--;
        S.timers.push(setTimeout(tick, 900));
      };
      tick();
    }

    function playOrPause() {
      if (S.playing) {
        setPlaying(false);
        return;
      }
      const begin = () => {
        setPlaying(true);
        scrollToWord(S.provisionalPos || 1);
      };
      if (!S.startedAt && !S.elapsed) countdown(begin);
      else begin();
    }

    // ---------- HUD ----------

    function hudWake() {
      S.hudHidden = false;
      root.classList.remove('p-hud-hidden');
      clearTimeout(S.hudTimer);
      S.hudTimer = setTimeout(() => {
        if (S.playing) {
          S.hudHidden = true;
          root.classList.add('p-hud-hidden');
          elSettings.classList.add('hidden');
        }
      }, 3200);
    }

    function banner(msg, ms = 4000) {
      elBanner.textContent = msg;
      elBanner.classList.remove('hidden');
      clearTimeout(S._bannerT);
      S._bannerT = setTimeout(() => elBanner.classList.add('hidden'), ms);
    }
    function toastBanner(msg) {
      banner(msg, 3000);
    }

    function updateTime() {
      const sec = Math.floor(S.startedAt ? (Date.now() - S.startedAt) / 1000 : S.elapsed);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      elTime.textContent = mm + ':' + ss;
    }

    // ---------- Rekam video (MediaRecorder — gratis, bawaan browser) ----------

    async function toggleRecord() {
      const btn = $('p-rec');
      if (S.recorder.mediaRecorder && S.recorder.mediaRecorder.state === 'recording') {
        S.recorder.mediaRecorder.stop();
        btn.classList.remove('on');
        setStatus(S.playing && S.mode === 'voice' ? 'Mendengarkan…' : 'Siap', S.playing && S.mode === 'voice' ? 'listening' : '');
        return;
      }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        banner('Perekaman video tidak didukung peramban ini.', 4000);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: true,
        });
        elVideo.srcObject = stream;
        elVideo.classList.remove('hidden');
        const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(
          (t) => MediaRecorder.isTypeSupported(t)
        );
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : undefined);
        S.recorder = { stream, mediaRecorder: mr, chunks: [], url: S.recorder.url };
        mr.ondataavailable = (e) => {
          if (e.data && e.data.size) S.recorder.chunks.push(e.data);
        };
        mr.onstop = () => {
          const blob = new Blob(S.recorder.chunks, { type: mr.mimeType || 'video/webm' });
          if (S.recorder.url) URL.revokeObjectURL(S.recorder.url);
          S.recorder.url = URL.createObjectURL(blob);
          stream.getTracks().forEach((t) => t.stop());
          elVideo.classList.add('hidden');
          elVideo.srcObject = null;
          const a = document.createElement('a');
          a.href = S.recorder.url;
          a.download = 'basarang-' + script.id + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.webm';
          a.click();
          banner('Rekaman selesai — berhasil diunduh (' + (blob.size / 1048576).toFixed(1) + ' MB).', 5000);
        };
        mr.start(1000);
        btn.classList.add('on');
        setStatus('Merekam…', 'rec');
        banner('Merekam video + suara. Klik tombol kamera lagi untuk berhenti & mengunduh.', 4000);
      } catch (err) {
        banner('Tidak dapat mengakses kamera/mikrofon: ' + (err && err.name === 'NotAllowedError' ? 'izin ditolak' : 'perangkat tidak tersedia'), 5000);
      }
    }

    // ---------- Panel pengaturan ----------

    function renderSettingsPanel() {
      const seg = (mode) =>
        `<div class="seg">
          <button type="button" data-mode="voice" class="${mode === 'voice' ? 'on' : ''}">${ICON.mic} Ikut Suara</button>
          <button type="button" data-mode="timer" class="${mode === 'timer' ? 'on' : ''}">${ICON.auto} Timer</button>
        </div>`;
      elSettings.innerHTML = `
        <h4>Pengaturan Teleprompter</h4>
        <div class="p-set-row"><span class="lbl">Mode gulir</span>${seg(S.mode)}</div>
        <div class="p-set-row"><span class="lbl">Bahasa suara</span>
          <select class="select" id="ps-lang" style="width:170px;min-height:34px">
            ${LANGS.map(([v, l]) => `<option value="${v}" ${settings.lang === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="p-set-row"><span class="lbl">Kecepatan baca</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-wpm" min="60" max="250" step="5" value="${settings.wpm}" title="${settings.wpm} KPM">
          <b id="ps-wpm-v" style="min-width:52px;font-size:var(--fs-xs)">${settings.wpm} KPM</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Pengganda gulir (timer)</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-speed" min="0.5" max="2" step="0.1" value="${settings.speed}">
          <b id="ps-speed-v" style="min-width:52px;font-size:var(--fs-xs)">×${settings.speed.toFixed(1)}</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Ukuran teks</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-font" min="0.7" max="1.6" step="0.05" value="${settings.fontSize}">
          <b id="ps-font-v" style="min-width:52px;font-size:var(--fs-xs)">×${settings.fontSize.toFixed(2)}</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Tinggi baris</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-lh" min="1.2" max="2" step="0.05" value="${settings.lineHeight}">
          <b id="ps-lh-v" style="min-width:52px;font-size:var(--fs-xs)">${settings.lineHeight.toFixed(2)}</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Tema</span>
          <select class="select" id="ps-theme" style="width:170px;min-height:34px">
            <option value="gold" ${settings.theme === 'gold' ? 'selected' : ''}>Emas Klasik</option>
            <option value="contrast" ${settings.theme === 'contrast' ? 'selected' : ''}>Kontras Tinggi</option>
            <option value="silver" ${settings.theme === 'silver' ? 'selected' : ''}>Perak Berpendar</option>
          </select>
        </div>
        <div class="p-set-row"><span class="lbl">Panduan baris</span>
          <button class="p-ctrl ${settings.guide ? 'on' : ''}" id="ps-guide" style="min-width:60px;height:34px">${settings.guide ? 'Aktif' : 'Mati'}</button>
        </div>
        <div class="p-set-row"><span class="lbl">Cermin horizontal (hood)</span>
          <button class="p-ctrl ${settings.mirrorX ? 'on' : ''}" id="ps-mx" style="min-width:60px;height:34px">${settings.mirrorX ? 'Aktif' : 'Mati'}</button>
        </div>
        <div class="p-set-row"><span class="lbl">Cermin vertikal</span>
          <button class="p-ctrl ${settings.mirrorY ? 'on' : ''}" id="ps-my" style="min-width:60px;height:34px">${settings.mirrorY ? 'Aktif' : 'Mati'}</button>
        </div>
        <p class="hint" style="margin:10px 0 0">Pintasan: Spasi mulai/jeda · +/- ukuran teks · M cermin · R sinkron ulang · S pengaturan · F layar penuh · Esc keluar · klik kata untuk melompat.</p>`;

      elSettings.querySelectorAll('[data-mode]').forEach((b) =>
        b.addEventListener('click', () => {
          S.mode = b.dataset.mode;
          settings.mode = S.mode;
          saveSettings(settings);
          updateSettingsPanel();
          if (S.playing) {
            setPlaying(false);
            setPlaying(true);
          }
        })
      );
      elSettings.querySelector('#ps-lang').addEventListener('change', (e) => {
        settings.lang = e.target.value;
        saveSettings(settings);
        if (S.recActive) {
          stopVoice();
          startVoice();
        }
      });
      const bindRange = (id, vid, key, fmt, after) => {
        const r = elSettings.querySelector('#' + id);
        const v = elSettings.querySelector('#' + vid);
        r.addEventListener('input', () => {
          settings[key] = Number(r.value);
          v.textContent = fmt(settings[key]);
          saveSettings(settings);
          if (after) after();
        });
      };
      bindRange('ps-wpm', 'ps-wpm-v', 'wpm', (x) => x + ' KPM', invalidateMetrics);
      bindRange('ps-speed', 'ps-speed-v', 'speed', (x) => '×' + x.toFixed(1));
      bindRange('ps-font', 'ps-font-v', 'fontSize', (x) => '×' + x.toFixed(2), applyTypography);
      bindRange('ps-lh', 'ps-lh-v', 'lineHeight', (x) => x.toFixed(2), applyTypography);
      elSettings.querySelector('#ps-theme').addEventListener('change', (e) => {
        settings.theme = e.target.value;
        saveSettings(settings);
        applyTypography();
      });
      const bindToggle = (id, key, after) => {
        const b = elSettings.querySelector('#' + id);
        b.addEventListener('click', () => {
          settings[key] = !settings[key];
          b.classList.toggle('on', settings[key]);
          b.textContent = settings[key] ? 'Aktif' : 'Mati';
          saveSettings(settings);
          if (after) after();
        });
      };
      bindToggle('ps-guide', 'guide', applyTypography);
      bindToggle('ps-mx', 'mirrorX', applyTypography);
      bindToggle('ps-my', 'mirrorY', applyTypography);
    }

    function updateSettingsPanel() {
      renderSettingsPanel();
      const wasHidden = elSettings.classList.contains('hidden');
      elSettings.classList.toggle('hidden', wasHidden);
    }

    // ---------- Kontrol ----------

    function toggleSettings() {
      elSettings.classList.toggle('hidden');
      renderSettingsPanel();
      hudWake();
    }

    function adjustFont(delta) {
      settings.fontSize = Math.min(1.6, Math.max(0.7, Math.round((settings.fontSize + delta) * 20) / 20));
      saveSettings(settings);
      applyTypography();
      hudWake();
    }

    function resyncFromView() {
      // Cari kata terdekat dengan garis panduan (42% tinggi)
      const ref = elScroll.scrollTop + elScroll.clientHeight * 0.42;
      let lo = 0;
      let hi = S.words.length - 1;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const y = S.words[mid].el.offsetTop;
        if (y <= ref) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      jumpTo(best + 1);
      toastBanner('Disinkronkan ke: "' + (S.words[best] ? S.words[best].raw : '') + '"');
    }

    function toggleFullscreen() {
      if (!document.fullscreenElement) {
        root.requestFullscreen && root.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen && document.exitFullscreen().catch(() => {});
      }
    }

    async function requestWakeLock() {
      try {
        if ('wakeLock' in navigator) {
          S.wakeLock = await navigator.wakeLock.request('screen');
          S.wakeLock.addEventListener('release', () => {
            S.wakeLock = null;
          });
        }
      } catch {
        /* abaikan */
      }
    }

    // ---------- Keyboard ----------

    const onKey = (e) => {
      if (S.exitRequested) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          playOrPause();
          break;
        case '+':
        case '=':
          e.preventDefault();
          adjustFont(0.05);
          break;
        case '-':
        case '_':
          e.preventDefault();
          adjustFont(-0.05);
          break;
        case 'm':
        case 'M':
          settings.mirrorX = !settings.mirrorX;
          saveSettings(settings);
          applyTypography();
          hudWake();
          break;
        case 'r':
        case 'R':
          resyncFromView();
          break;
        case 's':
        case 'S':
          toggleSettings();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'ArrowDown':
          e.preventDefault();
          elScroll.scrollTop += elScroll.clientHeight * 0.18;
          S.manualScrollUntil = Date.now() + 3500;
          break;
        case 'ArrowUp':
          e.preventDefault();
          elScroll.scrollTop -= elScroll.clientHeight * 0.18;
          S.manualScrollUntil = Date.now() + 3500;
          break;
        case 'Escape':
          exit();
          break;
        default:
          return;
      }
      hudWake();
    };

    // ---------- Keluar ----------

    function exit() {
      if (S.exitRequested) return;
      S.exitRequested = true;
      setPlaying(false);
      stopVoice();
      S.timers.forEach(clearTimeout);
      if (S.timerRaf) cancelAnimationFrame(S.timerRaf);
      if (S.animScroll.raf) cancelAnimationFrame(S.animScroll.raf);
      clearInterval(S._clock);
      clearTimeout(S.hudTimer);
      clearTimeout(S._bannerT);
      window.removeEventListener('resize', invalidateMetrics);
      document.removeEventListener('keydown', onKey);
      try {
        if (S.recorder.mediaRecorder && S.recorder.mediaRecorder.state === 'recording') S.recorder.mediaRecorder.stop();
        if (S.recorder.stream) S.recorder.stream.getTracks().forEach((t) => t.stop());
        if (S.recorder.url) setTimeout(() => URL.revokeObjectURL(S.recorder.url), 4000);
      } catch {
        /* abaikan */
      }
      try {
        if (S.wakeLock) S.wakeLock.release();
      } catch {
        /* abaikan */
      }
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      root.remove();
      document.body.style.overflow = '';
      if (active === S) active = null;
      if (onExit) onExit();
    }

    // ---------- Pasang event ----------

    $('p-exit').addEventListener('click', exit);
    elPlay.addEventListener('click', playOrPause);
    $('p-set').addEventListener('click', toggleSettings);
    $('p-full').addEventListener('click', toggleFullscreen);
    $('p-rec').addEventListener('click', toggleRecord);
    $('p-resync').addEventListener('click', resyncFromView);
    $('p-font-up').addEventListener('click', () => adjustFont(0.05));
    $('p-font-down').addEventListener('click', () => adjustFont(-0.05));
    $('p-mirror').addEventListener('click', () => {
      settings.mirrorX = !settings.mirrorX;
      saveSettings(settings);
      applyTypography();
      hudWake();
    });
    ['mousemove', 'pointerdown', 'touchstart', 'wheel'].forEach((ev) =>
      root.addEventListener(ev, () => hudWake(), { passive: true })
    );
    // Gulir manual menunda auto-follow sejenak
    const manualDelay = () => {
      S.manualScrollUntil = Date.now() + 3500;
    };
    elScroll.addEventListener('wheel', manualDelay, { passive: true });
    elScroll.addEventListener('touchmove', manualDelay, { passive: true });
    window.addEventListener('resize', invalidateMetrics);
    document.addEventListener('keydown', onKey);

    // ---------- Init ----------

    renderWords();
    renderSettingsPanel();
    applyTypography();
    highlight(0);
    requestWakeLock();
    if (!supportedVoice()) {
      S.mode = 'timer';
      settings.mode = 'timer';
      banner('Mode Suara memerlukan Chrome/Edge. Mode Timer aktif. (Firefox/Safari: gulir otomatis + kontrol manual)', 6500);
    }
    S._clock = setInterval(updateTime, 1000);
    hudWake();
    scrollToWord(1, false);

    return S;
  }
})();