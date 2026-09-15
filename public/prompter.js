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
    voiceLead: 1, // antisipasi blok mode suara: berapa kata blok emas mendahului suara (0-3) — kompensasi latensi pengenalan suara
    fontSize: 1, // pengganda
    lineHeight: 1.55,
    theme: 'gold', // 'gold' | 'contrast' | 'silver'
    mirrorX: false,
    mirrorY: false,
    guide: true,
    wordBlock: true, // blok kata emas pada kata aktif — bisa disembunyikan bila mengganggu pembacaan
    align: 'left', // rata teks naskah: 'left' | 'center' | 'right' | 'justify'
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
    gauge: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17a8 8 0 0 1 16 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/></svg>',
    block: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4.5h8"/><rect x="5" y="9" width="14" height="7" rx="2.5"/></svg>',
    restart: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h14"/><path d="M12 20.5V9.5"/><path d="M8.5 12.5 12 9l3.5 3.5"/></svg>',
    alignLeft: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 10h12M3 14h18M3 18h12"/></svg>',
    alignCenter: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M6 10h12M3 14h18M6 18h12"/></svg>',
    alignRight: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M9 10h12M3 14h18M9 18h12"/></svg>',
    alignJustify: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 10h18M3 14h18M3 18h18"/></svg>',
  };

  // Rata teks naskah — urutan siklus tombol HUD, label, dan ikon tiap nilai.
  const ALIGN_ORDER = ['left', 'center', 'right', 'justify'];
  const ALIGN_LABELS = { left: 'Rata kiri', center: 'Rata tengah', right: 'Rata kanan', justify: 'Rata kiri-kanan' };
  const ALIGN_ICONS = { left: ICON.alignLeft, center: ICON.alignCenter, right: ICON.alignRight, justify: ICON.alignJustify };

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
      videoMode: 'live', // 'live' (kamera langsung) | 'replay' (putar hasil rekaman)
      hudTimer: null,
    };

    // ---------- DOM ----------

    const root = document.createElement('div');
    root.className = 'prompter theme-' + settings.theme;
    root.innerHTML = `
      <div class="p-progress" id="p-progress"></div>
      <div class="p-scroll" id="p-scroll">
        <div class="p-content" id="p-content"></div>
      </div>
      <div class="p-guide" id="p-guide"><span class="line"></span><span class="tri-l"></span><span class="tri-r"></span></div>
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
        <button class="p-ctrl" id="p-restart" title="Ulang dari awal — berhenti & kembali ke kata pertama (Home)">${ICON.restart}</button>
        <button class="p-ctrl" id="p-resync" title="Sinkron otomatis ulang dari kata terlihat (R)">${ICON.auto}</button>
        <button class="p-ctrl" id="p-font-down" title="Perkecil teks (-)">${ICON.fontDown}</button>
        <button class="p-play" id="p-play" title="Mulai / jeda (Spasi)">${ICON.play}</button>
        <button class="p-ctrl" id="p-font-up" title="Perbesar teks (+)">${ICON.fontUp}</button>
        <button class="p-ctrl" id="p-mirror" title="Cermin (M)">${ICON.mirror}</button>
        <button class="p-ctrl ${settings.wordBlock ? 'on' : ''}" id="p-wordblock" title="Blok kata emas — tampil/sembunyi (B)">${ICON.block}</button>
        <button class="p-ctrl" id="p-align" title="${ALIGN_LABELS[settings.align] || ALIGN_LABELS.left} — klik untuk ganti rata teks (A)">${ALIGN_ICONS[settings.align] || ALIGN_ICONS.left}</button>
        <div class="seg p-mode" id="p-mode" role="group" aria-label="Mode gulir">
          <button type="button" data-mode="voice" class="${S.mode === 'voice' ? 'on' : ''}" title="Ikut Suara — naskah mengikuti ucapan (T)">${ICON.mic}<span class="txt">Suara</span></button>
          <button type="button" data-mode="timer" class="${S.mode === 'timer' ? 'on' : ''}" title="Timer — gulir otomatis sesuai kecepatan baca (T)">${ICON.auto}<span class="txt">Timer</span></button>
        </div>
        <div class="p-speed" id="p-speed-box">
          ${ICON.gauge}<input type="range" id="p-speed" min="0" max="3" step="1" value="1" aria-label="Kecepatan / antisipasi blok"><b class="p-speed-v" id="p-speed-v">+1</b>
        </div>
        <span class="p-time" id="p-time">00:00</span>
        <span class="p-pct" id="p-pct">0%</span>
      </div>
      <div class="p-settings hidden" id="p-settings"></div>
      <div class="p-count hidden" id="p-count"></div>
      <div class="p-video-box hidden" id="p-video-box">
        <video id="p-video" autoplay playsinline muted></video>
        <span class="p-video-dot hidden" id="p-video-dot"></span>
        <button type="button" class="p-video-play hidden" id="p-video-play" title="Putar ulang hasil rekaman terakhir">${ICON.play} Hasil</button>
        <button type="button" class="p-video-off" id="p-video-off" title="Matikan kamera">✕</button>
      </div>
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
    const elSpeedBox = $('p-speed-box');
    const elSpeed = $('p-speed');
    const elSpeedV = $('p-speed-v');
    const elSettings = $('p-settings');
    const elCount = $('p-count');
    const elVideo = $('p-video');
    const elVideoBox = $('p-video-box');
    const elVideoDot = $('p-video-dot');
    const elVideoPlay = $('p-video-play');
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
      elContent.style.textAlign = settings.align || 'left';
      elContent.classList.toggle('mirror-x', settings.mirrorX);
      elContent.classList.toggle('mirror-y', settings.mirrorY);
      root.className = 'prompter theme-' + settings.theme + (S.hudHidden ? ' p-hud-hidden' : '') + (settings.wordBlock === false ? ' no-wordblock' : '');
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
      // Mode suara: animasi lebih ringkas agar blok terasa seketika —
      // latensi pengenalan suara sudah cukup besar, jangan tambah jeda visual lagi.
      const dur = S.mode === 'voice'
        ? Math.min(340, Math.max(100, Math.abs(diff) * 0.25))
        : Math.min(650, Math.max(160, Math.abs(diff) * 0.45));
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
        elScroll.scrollTop = start + diff * e;
        if (k < 1) S.animScroll.raf = requestAnimationFrame(step);
        else S.animScroll.raf = null;
      };
      S.animScroll.raf = requestAnimationFrame(step);
    }

    // Posisi tampilan mode suara: blok emas mendahului N kata (default +1) untuk
    // mengompensasi latensi pengenalan suara — HANYA tampilan; status penyelarasan
    // (committedPos) tetap murni sehingga akurasi pencocokan tidak terganggu.
    function displayPos(pos) {
      const lead = S.mode === 'voice' ? (settings.voiceLead || 0) : 0;
      return Math.max(0, Math.min(pos + lead, S.words.length));
    }

    // Slider HUD bawah — maknanya mengikuti mode aktif:
    // Ikut Suara: antisipasi blok kata (0–3 kata ke depan);
    // Timer: kecepatan gulir otomatis (KPM).
    function applySpeedControl() {
      if (S.mode === 'voice') {
        elSpeedBox.title = 'Antisipasi blok kata — blok emas mendahului suara N kata (0–3). Naikkan bila blok terasa telat, turunkan bila mendahului.';
        elSpeed.min = '0'; elSpeed.max = '3'; elSpeed.step = '1';
        elSpeed.value = String(settings.voiceLead || 0);
        elSpeedV.textContent = '+' + (settings.voiceLead || 0);
      } else {
        elSpeedBox.title = 'Kecepatan gulir otomatis — kata per menit (60–250)';
        elSpeed.min = '60'; elSpeed.max = '250'; elSpeed.step = '5';
        elSpeed.value = String(settings.wpm || 140);
        elSpeedV.textContent = String(settings.wpm || 140);
      }
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
        applySpeedControl();
        syncModeButtons(); // tombol HUD bawah ikut mode aktif
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
        const disp = displayPos(S.provisionalPos);
        highlight(disp);
        scrollToWord(disp);
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
      const disp = displayPos(S.provisionalPos);
      highlight(disp);
      if (Date.now() > S.manualScrollUntil) scrollToWord(disp);
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

    // ---------- Kamera & rekaman video (MediaRecorder — gratis, bawaan browser) ----------
    // Footage TETAP TAMPIL dimanapun: sekali kamera dinyalakan, pratinjau hidup terus
    // di atas semua lapisan (HUD, panel pengaturan, hitung mundur) — melewati ganti
    // mode, ulang dari awal, maupun setelah rekaman berhenti (take ulang tanpa minta
    // izin ulang). Hasil rekaman bisa diputar ulang lewat tombol "Hasil".

    function playVideoEl() {
      try {
        const p = elVideo.play();
        if (p && p.catch) p.catch(() => {});
      } catch { /* abaikan */ }
    }

    // 'live' → kamera langsung; 'replay' → putar blob hasil rekaman terakhir (bersuara).
    function setVideoMode(mode) {
      if (mode === 'replay') {
        if (!S.recorder.url) return;
        S.videoMode = 'replay';
        elVideo.srcObject = null;
        elVideo.src = S.recorder.url;
        elVideo.loop = true;
        elVideo.muted = false; // dengarkan suara hasil rekaman
        playVideoEl();
        elVideoPlay.innerHTML = ICON.video + ' Langsung';
        elVideoPlay.title = 'Kembali ke kamera langsung';
      } else {
        S.videoMode = 'live';
        try { elVideo.pause(); } catch { /* abaikan */ }
        elVideo.loop = false;
        elVideo.removeAttribute('src');
        elVideo.muted = true;
        if (S.recorder.stream && S.recorder.stream.active) elVideo.srcObject = S.recorder.stream;
        playVideoEl();
        elVideoPlay.innerHTML = ICON.play + ' Hasil';
        elVideoPlay.title = 'Putar ulang hasil rekaman terakhir';
      }
    }

    function attachCamera(stream) {
      S.recorder.stream = stream;
      elVideoBox.classList.remove('hidden');
      setVideoMode('live');
    }

    function stopCamera() {
      const mr = S.recorder.mediaRecorder;
      if (mr && mr.state === 'recording') mr.stop(); // hasil take tetap terunduh via onstop
      if (S.recorder.stream) S.recorder.stream.getTracks().forEach((t) => t.stop());
      S.recorder.stream = null;
      S.recorder.mediaRecorder = null;
      S.videoMode = 'live';
      try { elVideo.pause(); } catch { /* abaikan */ }
      elVideo.srcObject = null;
      elVideo.removeAttribute('src');
      elVideo.muted = true;
      elVideoBox.classList.add('hidden');
      elVideoDot.classList.add('hidden');
      elVideoPlay.classList.add('hidden');
      $('p-rec').classList.remove('on');
      setStatus(S.playing && S.mode === 'voice' ? 'Mendengarkan…' : 'Siap', S.playing && S.mode === 'voice' ? 'listening' : '');
      hudWake();
    }

    function startRecording(stream) {
      if (S.videoMode === 'replay') setVideoMode('live'); // pastikan kamera langsung tampil
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(
        (t) => MediaRecorder.isTypeSupported(t)
      );
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : undefined);
      S.recorder.mediaRecorder = mr;
      S.recorder.chunks = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size) S.recorder.chunks.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(S.recorder.chunks, { type: mr.mimeType || 'video/webm' });
        if (S.recorder.url) URL.revokeObjectURL(S.recorder.url);
        S.recorder.url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = S.recorder.url;
        a.download = 'basarang-' + script.id + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.webm';
        a.click();
        elVideoDot.classList.add('hidden');
        $('p-rec').classList.remove('on');
        // Kamera TIDAK dimatikan di sini — footage tetap tampil untuk take berikutnya.
        if (S.recorder.stream && S.recorder.stream.active) {
          elVideoPlay.classList.remove('hidden');
          setStatus(S.playing && S.mode === 'voice' ? 'Mendengarkan…' : 'Siap', S.playing && S.mode === 'voice' ? 'listening' : '');
          banner('Rekaman selesai — berhasil diunduh (' + (blob.size / 1048576).toFixed(1) + ' MB). Kamera tetap tampil: klik kamera untuk rekam lagi, tombol "Hasil" untuk menonton.', 6000);
        } else {
          banner('Rekaman selesai — berhasil diunduh (' + (blob.size / 1048576).toFixed(1) + ' MB).', 5000);
        }
      };
      mr.start(1000);
      $('p-rec').classList.add('on');
      elVideoDot.classList.remove('hidden');
      elVideoPlay.classList.add('hidden'); // saat merekam, tombol putar disembunyikan
      setStatus('Merekam…', 'rec');
      banner('Merekam video + suara. Klik tombol kamera lagi untuk berhenti & mengunduh.', 4000);
    }

    async function toggleRecord() {
      if (S.recorder.mediaRecorder && S.recorder.mediaRecorder.state === 'recording') {
        S.recorder.mediaRecorder.stop();
        return; // onstop menangani unduhan — kamera tetap hidup
      }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        banner('Perekaman video tidak didukung peramban ini.', 4000);
        return;
      }
      // Kamera sudah hidup → langsung rekam ulang (tanpa minta izin lagi)
      if (S.recorder.stream && S.recorder.stream.active) {
        startRecording(S.recorder.stream);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: true,
        });
        attachCamera(stream);
        // Kamera dicabut sistem (mis. perangkat lepas) → matikan pratinjau dengan rapi
        stream.getTracks().forEach((t) => t.addEventListener('ended', () => {
          if (S.recorder.stream === stream) stopCamera();
        }));
        startRecording(stream);
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
        <div class="p-set-row"><span class="lbl">Antisipasi blok (suara)</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-lead" min="0" max="3" step="1" value="${settings.voiceLead}">
          <b id="ps-lead-v" style="min-width:52px;font-size:var(--fs-xs)">+${settings.voiceLead} kata</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Ukuran teks</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-font" min="0.7" max="1.6" step="0.05" value="${settings.fontSize}">
          <b id="ps-font-v" style="min-width:52px;font-size:var(--fs-xs)">×${settings.fontSize.toFixed(2)}</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Tinggi baris</span>
          <span class="row" style="gap:8px"><input type="range" id="ps-lh" min="1.2" max="2" step="0.05" value="${settings.lineHeight}">
          <b id="ps-lh-v" style="min-width:52px;font-size:var(--fs-xs)">${settings.lineHeight.toFixed(2)}</b></span>
        </div>
        <div class="p-set-row"><span class="lbl">Rata teks</span>
          <div class="seg" id="ps-align">
            <button type="button" data-align="left" class="${(settings.align || 'left') === 'left' ? 'on' : ''}" title="Rata kiri">${ICON.alignLeft}<span class="txt">Kiri</span></button>
            <button type="button" data-align="center" class="${settings.align === 'center' ? 'on' : ''}" title="Rata tengah">${ICON.alignCenter}<span class="txt">Tengah</span></button>
            <button type="button" data-align="right" class="${settings.align === 'right' ? 'on' : ''}" title="Rata kanan">${ICON.alignRight}<span class="txt">Kanan</span></button>
            <button type="button" data-align="justify" class="${settings.align === 'justify' ? 'on' : ''}" title="Rata kiri-kanan">${ICON.alignJustify}<span class="txt">Kiri-kanan</span></button>
          </div>
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
        <div class="p-set-row"><span class="lbl">Blok kata emas</span>
          <button class="p-ctrl ${settings.wordBlock ? 'on' : ''}" id="ps-wordblock" style="min-width:60px;height:34px">${settings.wordBlock ? 'Aktif' : 'Mati'}</button>
        </div>
        <div class="p-set-row"><span class="lbl">Cermin horizontal (hood)</span>
          <button class="p-ctrl ${settings.mirrorX ? 'on' : ''}" id="ps-mx" style="min-width:60px;height:34px">${settings.mirrorX ? 'Aktif' : 'Mati'}</button>
        </div>
        <div class="p-set-row"><span class="lbl">Cermin vertikal</span>
          <button class="p-ctrl ${settings.mirrorY ? 'on' : ''}" id="ps-my" style="min-width:60px;height:34px">${settings.mirrorY ? 'Aktif' : 'Mati'}</button>
        </div>
        <p class="hint" style="margin:10px 0 0">Pintasan: Spasi mulai/jeda · +/- ukuran teks · M cermin · B blok kata · T ganti mode gulir · A rata teks · R sinkron ulang · Home ulang dari awal · S pengaturan · F layar penuh · Esc keluar · klik kata untuk melompat.</p>`;

      elSettings.querySelectorAll('[data-mode]').forEach((b) =>
        b.addEventListener('click', () => { setMode(b.dataset.mode); })
      );
      elSettings.querySelectorAll('[data-align]').forEach((b) =>
        b.addEventListener('click', () => { setAlign(b.dataset.align); })
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
      bindRange('ps-wpm', 'ps-wpm-v', 'wpm', (x) => x + ' KPM', () => {
        invalidateMetrics();
        applySpeedControl(); // sinkron slider HUD bawah
      });
      bindRange('ps-speed', 'ps-speed-v', 'speed', (x) => '×' + x.toFixed(1));
      bindRange('ps-lead', 'ps-lead-v', 'voiceLead', (x) => '+' + x + ' kata', () => {
        applySpeedControl(); // sinkron slider HUD bawah
        if (S.mode === 'voice') {
          const disp = displayPos(S.provisionalPos);
          highlight(disp);
          if (Date.now() > S.manualScrollUntil) scrollToWord(disp);
        }
      });
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
      bindToggle('ps-wordblock', 'wordBlock', () => {
        applyTypography();
        syncWordBlockButtons(); // tombol HUD bawah ikut berubah saat diatur dari panel
      });
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

    // Ulang dari awal: berhenti bila sedang berjalan, kembalikan seluruh status ke
    // posisi awal (posisi kata, penyangga suara, pewaktu) lalu gulir instan ke atas.
    // Menekan Mulai (Spasi) setelahnya memunculkan hitung mundur 3-2-1 — take baru.
    function restartFromTop() {
      if (S.playing) setPlaying(false);
      S.committedPos = 0;
      S.provisionalPos = 0;
      S.unmatchedRun = 0;
      S.recentSpoken = [];
      S.elapsed = 0;
      S.startedAt = null;
      updateTime();
      highlight(0);
      scrollToWord(1, false);
      toastBanner('Kembali ke awal — tekan Mulai (Spasi) untuk mengulang.');
      hudWake();
    }

    // Ganti mode gulir — satu pintu untuk segmen HUD bawah, panel pengaturan,
    // dan pintasan T. Semua tombol ber-label data-mode (HUD & panel) selalu
    // sinkron dengan mode aktif, begitu pula makna slider kecepatan.
    function syncModeButtons() {
      root.querySelectorAll('[data-mode]').forEach((b) => {
        b.classList.toggle('on', b.dataset.mode === S.mode);
      });
    }
    function setMode(mode) {
      if (S.mode === mode) return;
      S.mode = mode;
      settings.mode = mode;
      saveSettings(settings);
      applySpeedControl(); // makna slider HUD bawah mengikuti mode
      syncModeButtons();
      toastBanner('Mode gulir: ' + (mode === 'voice' ? 'Ikut Suara' : 'Timer'));
      if (S.playing) {
        setPlaying(false);
        setPlaying(true);
      }
      hudWake();
    }

    // Toggle blok kata emas — tombol HUD bawah, pintasan B, dan panel pengaturan
    // selalu tersinkron satu sama lain.
    function syncWordBlockButtons() {
      const hud = $('p-wordblock');
      if (hud) hud.classList.toggle('on', settings.wordBlock);
      const pb = elSettings.querySelector('#ps-wordblock');
      if (pb) {
        pb.classList.toggle('on', settings.wordBlock);
        pb.textContent = settings.wordBlock ? 'Aktif' : 'Mati';
      }
    }
    function toggleWordBlock() {
      settings.wordBlock = !settings.wordBlock;
      saveSettings(settings);
      applyTypography();
      syncWordBlockButtons();
      hudWake();
    }

    // Rata teks — tombol siklus di HUD bawah (pintasan A) dan segmen 4 opsi di
    // panel pengaturan; satu pintu setAlign() agar keduanya selalu tersinkron.
    function syncAlignButtons() {
      const hud = $('p-align');
      if (hud) {
        hud.innerHTML = ALIGN_ICONS[settings.align] || ALIGN_ICONS.left;
        hud.title = ALIGN_LABELS[settings.align] + ' — klik untuk ganti rata teks (A)';
      }
      elSettings.querySelectorAll('[data-align]').forEach((b) =>
        b.classList.toggle('on', b.dataset.align === (settings.align || 'left'))
      );
    }
    function setAlign(v) {
      if (!ALIGN_LABELS[v]) return;
      settings.align = v;
      saveSettings(settings);
      applyTypography();
      syncAlignButtons();
      hudWake();
    }
    function cycleAlign() {
      const i = ALIGN_ORDER.indexOf(settings.align || 'left');
      setAlign(ALIGN_ORDER[(i + 1) % ALIGN_ORDER.length]);
      toastBanner('Rata teks: ' + ALIGN_LABELS[settings.align]);
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
        case 'b':
        case 'B':
          toggleWordBlock();
          break;
        case 't':
        case 'T':
          setMode(S.mode === 'voice' ? 'timer' : 'voice');
          break;
        case 'a':
        case 'A':
          cycleAlign();
          break;
        case 'Home':
        case '0':
          e.preventDefault();
          restartFromTop();
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
      document.removeEventListener('fullscreenchange', onFsChange);
      try {
        if (S.recorder.mediaRecorder && S.recorder.mediaRecorder.state === 'recording') S.recorder.mediaRecorder.stop();
        if (S.recorder.stream) S.recorder.stream.getTracks().forEach((t) => t.stop());
        try { elVideo.pause(); } catch { /* abaikan */ }
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
    // Footage: tombol kecil pada kotak video — putar hasil / kembali langsung, & matikan kamera
    $('p-video-off').addEventListener('click', stopCamera);
    $('p-video-play').addEventListener('click', () => setVideoMode(S.videoMode === 'replay' ? 'live' : 'replay'));
    $('p-resync').addEventListener('click', resyncFromView);
    $('p-restart').addEventListener('click', restartFromTop);
    $('p-wordblock').addEventListener('click', toggleWordBlock);
    $('p-align').addEventListener('click', cycleAlign);
    // Pemilih mode gulir di HUD bawah
    $('p-mode').querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => { setMode(b.dataset.mode); })
    );
    $('p-font-up').addEventListener('click', () => adjustFont(0.05));
    $('p-font-down').addEventListener('click', () => adjustFont(-0.05));
    $('p-mirror').addEventListener('click', () => {
      settings.mirrorX = !settings.mirrorX;
      saveSettings(settings);
      applyTypography();
      hudWake();
    });
    // Slider kecepatan/antisipasi di HUD bawah (makna mengikuti mode aktif)
    elSpeed.addEventListener('input', () => {
      const v = Number(elSpeed.value);
      if (S.mode === 'voice') {
        settings.voiceLead = v;
        elSpeedV.textContent = '+' + v;
        const disp = displayPos(S.provisionalPos); // efek langsung terlihat
        highlight(disp);
        if (Date.now() > S.manualScrollUntil) scrollToWord(disp);
      } else {
        settings.wpm = v;
        elSpeedV.textContent = String(v);
        invalidateMetrics(); // kecepatan timer berubah seketika
      }
      saveSettings(settings);
      hudWake();
    });
    applySpeedControl();
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
    // Layar penuh: peramban hanya merender .prompter (footer tak dirender) →
    // klaim kembali ruang footer agar naskah lebih luas.
    const onFsChange = () => root.classList.toggle('p-fs', !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);

    // ---------- Init ----------

    renderWords();
    renderSettingsPanel();
    applyTypography();
    syncAlignButtons(); // tombol HUD & panel pengaturan mengikuti rata teks tersimpan
    highlight(0);
    requestWakeLock();
    if (!supportedVoice()) {
      S.mode = 'timer';
      settings.mode = 'timer';
      banner('Mode Suara memerlukan Chrome/Edge. Mode Timer aktif. (Firefox/Safari: gulir otomatis + kontrol manual)', 6500);
      applySpeedControl();
      syncModeButtons(); // tombol HUD bawah ikut mode aktif
    }
    S._clock = setInterval(updateTime, 1000);
    hudWake();
    scrollToWord(1, false);

    return S;
  }
})();