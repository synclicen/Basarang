// app.js — SPA inti Basarang: Bagarak Saurang
// Semua konten dinamis dirender dengan escaping (esc) — aman XSS.
'use strict';

(() => {
  const $app = document.getElementById('app');
  const $modalRoot = document.getElementById('modal-root');
  const $toastRoot = document.getElementById('toast-root');

  const state = { user: null, needsSetup: false, booted: false };

  // ---------- Footer selalu terlihat ----------

  // Footer sticky (fixed, z-index 600) harus tidak menutupi konten app,
  // toast, HUD prompter, maupun panel pengaturannya — semua bergeser
  // sebesar var --footer-h. Tingginya diukur nyata (bisa wrap 2 baris di
  // layar sempit) dan dipantau ResizeObserver agar selalu akurat.
  const syncFooterHeight = () => {
    const f = document.querySelector('.site-footer');
    if (!f) return;
    const h = Math.round(f.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--footer-h', h + 'px');
  };
  syncFooterHeight();
  window.addEventListener('resize', syncFooterHeight);
  window.addEventListener('orientationchange', syncFooterHeight);
  const footerEl = document.querySelector('.site-footer');
  if (footerEl && 'ResizeObserver' in window) {
    new ResizeObserver(syncFooterHeight).observe(footerEl);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncFooterHeight).catch(() => {});
  }

  // ---------- Util ----------

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch('/api' + path, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* kosong */
    }
    if (!res.ok || !data || data.ok === false) {
      throw new ApiError(
        (data && data.message) || 'Gagal terhubung ke server (' + res.status + ').',
        res.status,
        data && data.error
      );
    }
    return data.data;
  }

  function toast(msg, type = 'info', ms = 2600) {
    const node = el(`<div class="toast ${esc(type)}">${esc(msg)}</div>`);
    $toastRoot.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .3s';
      setTimeout(() => node.remove(), 320);
    }, ms);
  }

  function debounce(fn, ms) {
    let t = null;
    const wrapped = (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
    wrapped.flush = (...a) => {
      clearTimeout(t);
      return fn(...a);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  const fmtRel = (() => {
    const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
    return (iso) => {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return '—';
      const diff = t - Date.now();
      const abs = Math.abs(diff);
      const min = 60e3;
      const hour = 60 * min;
      const day = 24 * hour;
      if (abs < min) return 'baru saja';
      if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
      if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
      if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
      return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    };
  })();

  function wordCount(text) {
    const m = String(text || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
    return m ? m.length : 0;
  }
  function estMinutes(words, wpm) {
    if (!wpm) wpm = 140;
    const sec = Math.round((words / wpm) * 60);
    if (sec < 60) return sec + ' detik';
    return Math.round(sec / 60) + ' menit';
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '')).toUpperCase();
  }
  function roleName(role) {
    return { super_admin: 'Super Admin', manager: 'Manager', member: 'Member' }[role] || role;
  }

  // ---------- Ikon SVG ----------

  const I = {
    play: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    mic: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    auto: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 17.5 6.5"/><path d="M17.5 3 18.4 5.1 20.5 6 18.4 6.9 17.5 9 16.6 6.9 14.5 6 16.6 5.1Z" stroke-width="1.6"/><path d="M21.5 12.5v2.2M20.4 13.6h2.2" stroke-width="1.6"/></svg>',
    gear: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
    mirror: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M8 7 4 12l4 5M16 7l4 5-4 5"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    back: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    edit: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13 6.5 17.5 11"/></svg>',
    prompter: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="13" rx="2.5"/><path d="M7 9h9M7 12.5h5.5" stroke-width="1.8"/><path d="M12 17.5v3M8 21h8" stroke-width="1.8"/></svg>',
    users: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 5.6M21.5 20a6.5 6.5 0 0 0-4.5-6.2"/></svg>',
    logout: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9"/></svg>',
    key: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="14" r="4"/><path d="M11 11 20 2M17 5l3 3M15 7l2 2"/></svg>',
    sync: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
    fontUp: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20 9 6l5 14M5.8 15.5h6.4M15 12h6M18 9v6"/></svg>',
    fontDown: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20 9 6l5 14M5.8 15.5h6.4M15 15h6M18 12v6"/></svg>',
    video: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
    full: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 7"/></svg>',
  };

  // ---------- Modal ----------

  function openModal({ title, bodyHtml, wide, onMount, onClose }) {
    const root = el(`
      <div class="modal-back">
        <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head">
            <h3>${esc(title)}</h3>
            <button class="x-btn" type="button" aria-label="Tutup">×</button>
          </div>
          <div class="modal-body"></div>
        </div>
      </div>`);
    const bodyEl = root.querySelector('.modal-body');
    bodyEl.appendChild(typeof bodyHtml === 'string' ? el(`<div>${bodyHtml}</div>`) : bodyHtml);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      root.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    root.querySelector('.x-btn').addEventListener('click', close);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close();
    });
    document.addEventListener('keydown', onKey);
    $modalRoot.appendChild(root);
    if (onMount) onMount(root, close);
    const firstInput = root.querySelector('input, textarea, select');
    if (firstInput) setTimeout(() => firstInput.focus(), 60);
    return { root, close };
  }

  function confirmDialog(title, message, { danger = true, okLabel = 'Ya, lanjutkan' } = {}) {
    return new Promise((resolve) => {
      openModal({
        title,
        bodyHtml: `<p style="margin:0;color:var(--text-2)">${esc(message)}</p>`,
        onMount(root, close) {
          const yes = el(`<button class="btn ${danger ? 'btn-danger' : 'btn-gold'}" type="button">${esc(okLabel)}</button>`);
          const no = el('<button class="btn btn-ghost" type="button">Batal</button>');
          yes.addEventListener('click', () => {
            close();
            resolve(true);
          });
          no.addEventListener('click', () => {
            close();
            resolve(false);
          });
          const foot = el('<div class="modal-foot"></div>');
          foot.append(no, yes);
          root.querySelector('.modal-body').appendChild(foot);
        },
        onClose() {
          resolve(false);
        },
      });
    });
  }

  // ---------- Topbar & shell ----------

  function topbarHtml(active) {
    const u = state.user;
    const adminBtn =
      u && u.role === 'super_admin'
        ? `<a class="btn btn-ghost btn-sm ${active === 'admin' ? 'on' : ''}" href="#/admin" title="Kelola pengguna">${I.users}<span class="hide-sm">Pengguna</span></a>`
        : '';
    return `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/dashboard">
          <span class="brand-mark">${I.prompter}</span>
          <span class="brand-name"><em>BASARANG</em><span class="brand-tail">: Bagarak Saurang</span></span>
        </a>
        <div class="topbar-actions">
          ${adminBtn}
          <a class="btn btn-ghost btn-sm" href="#/dashboard" title="Proyek">${I.prompter}<span class="hide-sm">Proyek</span></a>
          <button class="btn btn-ghost btn-sm" id="btn-pass" title="Ubah kata sandi">${I.key}</button>
          <div class="userchip">
            <span class="avatar">${esc(initials(u ? u.display_name : '?'))}</span>
            <span class="meta">
              <span class="nm">${esc(u ? u.display_name : '')}</span>
              <span class="rl">${esc(u ? roleName(u.role) : '')}</span>
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-logout" title="Keluar">${I.logout}</button>
        </div>
      </div>
    </header>`;
  }

  function bindLogout() {
    const b = document.getElementById('btn-logout');
    if (!b) return;
    b.addEventListener('click', async () => {
      try {
        await api('/auth/logout', { method: 'POST' });
      } catch {
        /* abaikan */
      }
      state.user = null;
      state.needsSetup = false;
      navigate('#/login');
      toast('Anda telah keluar.', 'info');
    });
    const p = document.getElementById('btn-pass');
    if (p) p.addEventListener('click', () => passwordForm());
  }

  function passwordForm() {
    openModal({
      title: 'Ubah Kata Sandi',
      bodyHtml: `
      <form id="pass-form" novalidate>
        <label class="field">
          <span class="label-txt">Kata sandi saat ini</span>
          <input class="input" name="current" type="password" autocomplete="current-password" required>
        </label>
        <label class="field">
          <span class="label-txt">Kata sandi baru</span>
          <input class="input" name="next" type="password" minlength="8" maxlength="128" autocomplete="new-password" required>
          <span class="hint">Minimal 8 karakter. Sesi di perangkat lain akan dikeluarkan.</span>
        </label>
        <div class="form-err" id="pass-err"></div>
        <button class="btn btn-gold btn-block" type="submit">Simpan Kata Sandi Baru</button>
      </form>`,
      onMount(root, close) {
        root.querySelector('#pass-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const errEl = root.querySelector('#pass-err');
          errEl.textContent = '';
          const fd = new FormData(e.target);
          try {
            await api('/auth/password', {
              method: 'POST',
              body: { current: fd.get('current'), next: fd.get('next') },
            });
            close();
            toast('Kata sandi berhasil diganti.', 'ok');
          } catch (err) {
            errEl.textContent = err.message;
          }
        });
      },
    });
  }

  // ---------- Router ----------

  function navigate(hash) {
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
    }
  }

  let currentCleanup = null;

  async function render() {
    if (currentCleanup) {
      try {
        currentCleanup();
      } catch {
        /* abaikan */
      }
      currentCleanup = null;
    }
    const hash = location.hash || '#/';
    const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
    const page = parts[0] || '';

    if (!state.booted) {
      $app.innerHTML = `<div class="page container"><div class="skel" style="height:200px"></div></div>`;
      return;
    }

    if (page === 'prompter' && parts[1]) {
      await viewPrompter(Number(parts[1]));
      return;
    }
    if (state.needsSetup) {
      return viewSetup();
    }
    if (!state.user) {
      return viewLogin();
    }
    if (!page || page === 'dashboard') return viewDashboard();
    if (page === 'project' && parts[1]) return viewProject(Number(parts[1]));
    if (page === 'admin') {
      if (state.user.role !== 'super_admin') {
        toast('Akses khusus super admin.', 'err');
        return navigate('#/dashboard');
      }
      return viewAdmin();
    }
    navigate('#/dashboard');
  }

  // ---------- View: Setup pertama ----------

  function viewSetup() {
    $app.innerHTML = `
    <div class="auth-wrap container">
      <div class="auth-card">
        <div class="auth-hero">
          <div class="mark-trio">
            <span class="mark mark-gold">${I.prompter}</span>
            <span class="mark mark-purple">${I.mic}</span>
            <span class="mark mark-silver">${I.auto}</span>
          </div>
          <h1><em>BASARANG</em>: Bagarak Saurang</h1>
          <p class="tag">Inisialisasi pertama — buat akun <b>Super Admin</b> untuk memulai.</p>
          <div class="feature-row">
            <span class="pill pill-gold">Sinkron lintas perangkat</span>
            <span class="pill pill-purple">Gratis 100%</span>
          </div>
        </div>
        <form class="card" id="setup-form" novalidate>
          <label class="field">
            <span class="label-txt">Nama tampilan</span>
            <input class="input" name="display_name" placeholder="cth: Fajrianor" maxlength="60" autocomplete="name">
          </label>
          <label class="field">
            <span class="label-txt">Username</span>
            <input class="input" name="username" placeholder="huruf kecil, 3-30 karakter" maxlength="30" autocomplete="username" required>
            <span class="hint">Huruf kecil, angka, titik, garis bawah, strip.</span>
          </label>
          <label class="field">
            <span class="label-txt">Email (opsional)</span>
            <input class="input" name="email" type="email" placeholder="opsional" maxlength="120" autocomplete="email">
          </label>
          <label class="field">
            <span class="label-txt">Kata sandi</span>
            <input class="input" name="password" type="password" placeholder="minimal 8 karakter" minlength="8" maxlength="128" autocomplete="new-password" required>
          </label>
          <div class="form-err" id="setup-err"></div>
          <button class="btn btn-gold btn-block btn-lg" type="submit">Buat Super Admin</button>
        </form>
      </div>
    </div>`;
    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('setup-err');
      errEl.textContent = '';
      const fd = new FormData(form);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Membuat akun…';
      try {
        const data = await api('/auth/setup', {
          method: 'POST',
          body: {
            display_name: fd.get('display_name'),
            username: fd.get('username'),
            email: fd.get('email'),
            password: fd.get('password'),
          },
        });
        state.user = data.user;
        state.needsSetup = false;
        toast('Super admin berhasil dibuat. Selamat datang!', 'ok');
        navigate('#/dashboard');
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Buat Super Admin';
      }
    });
  }

  // ---------- View: Login ----------

  function viewLogin() {
    $app.innerHTML = `
    <div class="auth-wrap container">
      <div class="auth-card">
        <div class="auth-hero">
          <div class="mark-trio">
            <span class="mark mark-gold">${I.prompter}</span>
            <span class="mark mark-purple">${I.mic}</span>
            <span class="mark mark-silver">${I.auto}</span>
          </div>
          <h1><em>BASARANG</em>: Bagarak Saurang</h1>
        </div>
        <form class="card" id="login-form" novalidate>
          <label class="field">
            <span class="label-txt">Username</span>
            <input class="input" name="username" autocomplete="username" autocapitalize="none" required>
          </label>
          <label class="field">
            <span class="label-txt">Kata sandi</span>
            <input class="input" name="password" type="password" autocomplete="current-password" required>
          </label>
          <div class="form-err" id="login-err"></div>
          <button class="btn btn-gold btn-block btn-lg" type="submit">Masuk</button>
          <p class="hint" style="text-align:center;margin-top:12px">Akun dibuat oleh super admin. Lupa kata sandi? Hubungi pengelola.</p>
        </form>
      </div>
    </div>`;
    const form = document.getElementById('login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('login-err');
      errEl.textContent = '';
      const fd = new FormData(form);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Memeriksa…';
      try {
        const data = await api('/auth/login', {
          method: 'POST',
          body: { username: fd.get('username'), password: fd.get('password') },
        });
        state.user = data.user;
        toast('Selamat datang kembali, ' + data.user.display_name + '!', 'ok');
        navigate('#/dashboard');
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Masuk';
      }
    });
  }

  // ---------- View: Dashboard ----------

  async function viewDashboard() {
    $app.innerHTML = `
    ${topbarHtml('dashboard')}
    <main class="page container">
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title">Proyek</h2>
        </div>
        <button class="btn btn-gold" id="btn-new-proj">${I.plus} Proyek Baru</button>
      </div>
      <div class="stat-strip" id="dash-stats"></div>
      <div id="dash-projects" class="grid-cards"></div>
    </main>`;
    bindLogout();
    document.getElementById('btn-new-proj').addEventListener('click', () => projectForm(null));

    if (state.user.role === 'super_admin') {
      api('/stats')
        .then((d) => {
          const s = d.stats;
          document.getElementById('dash-stats').innerHTML = `
            <div class="stat"><div class="v">${s.projects}</div><div class="k">Proyek</div></div>
            <div class="stat"><div class="v">${s.scripts}</div><div class="k">Naskah</div></div>
            <div class="stat"><div class="v">${s.users}</div><div class="k">Pengguna</div></div>
            <div class="stat"><div class="v">${s.active_sessions}</div><div class="k">Sesi Aktif</div></div>`;
        })
        .catch(() => {});
    }

    const wrap = document.getElementById('dash-projects');
    wrap.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    try {
      const d = await api('/projects');
      const projects = d.projects || [];
      if (!projects.length) {
        wrap.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <h3>Belum ada proyek</h3>
          <p>Buat proyek pertama Anda, tambahkan naskah, lalu biarkan Basarang mengikuti suara Anda saat presentasi.</p>
          <button class="btn btn-gold" id="btn-new-proj-2">${I.plus} Buat Proyek Pertama</button>
        </div>`;
        const b2 = document.getElementById('btn-new-proj-2');
        if (b2) b2.addEventListener('click', () => projectForm(null));
        return;
      }
      wrap.innerHTML = projects
        .map((p) => {
          const rolePill =
            p.my_role === 'owner'
              ? '<span class="pill pill-gold">Pemilik</span>'
              : p.my_role === 'member'
                ? '<span class="pill pill-purple">Anggota</span>'
                : '<span class="pill">Pengawasan</span>';
          return `
        <a class="card card-hover proj-card" href="#/project/${p.id}">
          <div class="top">
            <h3>${esc(p.name)}</h3>
            ${p.status === 'archived' ? '<span class="pill">Arsip</span>' : ''}
          </div>
          <p class="desc">${esc(p.description || 'Tanpa deskripsi.')}</p>
          <div class="meta">
            ${rolePill}
            <span>${p.script_count} naskah</span>
            <span>·</span>
            <span>${p.member_count} anggota</span>
            <span>·</span>
            <span>${esc(fmtRel(p.created_at))}</span>
          </div>
        </a>`;
        })
        .join('');
    } catch (err) {
      wrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Gagal memuat</h3><p>${esc(err.message)}</p></div>`;
    }
  }

  function projectForm(project, onSaved) {
    const isEdit = !!project;
    openModal({
      title: isEdit ? 'Ubah Proyek' : 'Proyek Baru',
      bodyHtml: `
      <form id="proj-form" novalidate>
        <label class="field">
          <span class="label-txt">Nama proyek</span>
          <input class="input" name="name" value="${esc(isEdit ? project.name : '')}" maxlength="120" placeholder="cth: Konten Media Sosial Ramadhan" required>
        </label>
        <label class="field">
          <span class="label-txt">Deskripsi</span>
          <textarea class="textarea" name="description" maxlength="600" style="min-height:84px" placeholder="opsional">${esc(isEdit ? project.description : '')}</textarea>
        </label>
        ${isEdit ? `
        <label class="field">
          <span class="label-txt">Status</span>
          <select class="select" name="status">
            <option value="active" ${project.status === 'active' ? 'selected' : ''}>Aktif</option>
            <option value="archived" ${project.status === 'archived' ? 'selected' : ''}>Arsip</option>
          </select>
        </label>` : ''}
        <div class="form-err" id="proj-err"></div>
        <button class="btn btn-gold btn-block" type="submit">${isEdit ? 'Simpan Perubahan' : 'Buat Proyek'}</button>
      </form>`,
      onMount(root, close) {
        root.querySelector('#proj-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = e.target.querySelector('button[type=submit]');
          if (btn.disabled) return; // cegah kirim ganda (klik dua kali / Enter dua kali)
          const errEl = root.querySelector('#proj-err');
          errEl.textContent = '';
          const fd = new FormData(e.target);
          const body = { name: fd.get('name'), description: fd.get('description') };
          if (isEdit) body.status = fd.get('status');
          btn.disabled = true;
          btn.textContent = 'Menyimpan…';
          try {
            const data = isEdit
              ? await api('/projects/' + project.id, { method: 'PATCH', body })
              : await api('/projects', { method: 'POST', body });
            close();
            toast(isEdit ? 'Proyek diperbarui.' : 'Proyek dibuat.', 'ok');
            if (onSaved) onSaved(data);
            else render();
          } catch (err) {
            errEl.textContent = err.message;
            btn.disabled = false;
            btn.textContent = isEdit ? 'Simpan Perubahan' : 'Buat Proyek';
          }
        });
      },
    });
  }

  // ---------- View: Detail proyek ----------

  async function viewProject(projectId) {
    $app.innerHTML = `${topbarHtml('dashboard')}
    <main class="page container"><div class="skel" style="height:300px"></div></main>`;
    bindLogout();
    let d;
    try {
      d = await api('/projects/' + projectId);
    } catch (err) {
      $app.innerHTML = `${topbarHtml()}
      <main class="page container">
        <div class="empty-state"><h3>Tidak dapat membuka proyek</h3><p>${esc(err.message)}</p>
        <a class="btn btn-ghost mt-3" href="#/dashboard">${I.back} Kembali</a></div>
      </main>`;
      bindLogout();
      return;
    }
    const { project, scripts, members, owner, my_role, can_manage } = d;
    const isOwner = my_role === 'owner';
    const canAddScript = my_role === 'owner' || my_role === 'member' || state.user.role === 'super_admin';

    $app.innerHTML = `
    ${topbarHtml('dashboard')}
    <main class="page container">
      <div class="crumbs"><a href="#/dashboard">Proyek</a> / <b>${esc(project.name)}</b></div>
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title"><span class="gold">${esc(project.name)}</span>
            ${project.status === 'archived' ? '<span class="pill">Arsip</span>' : ''}</h2>
          <p class="page-sub">${esc(project.description || 'Tanpa deskripsi.')}
            — pemilik: <b>${esc(owner.display_name || owner.username)}</b></p>
        </div>
        <div class="row">
          ${canAddScript ? `<button class="btn btn-gold" id="btn-new-script">${I.plus} Naskah Baru</button>` : ''}
          ${can_manage ? `<button class="btn btn-ghost" id="btn-edit-proj">${I.edit} Ubah</button>
          <button class="btn btn-danger" id="btn-del-proj">${I.trash}</button>` : ''}
        </div>
      </div>
      <div class="split">
        <section>
          <div class="row spread" style="margin-bottom:10px">
            <h3 style="margin:0;font-family:var(--font-brand);font-size:var(--fs-lg)">Naskah <span class="muted">(${scripts.length})</span></h3>
          </div>
          <div class="grid-cards" id="script-grid"></div>
        </section>
        <aside>
          <div class="card">
            <h4 style="margin:0 0 10px;font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em;color:var(--silver-3)">Anggota <span class="muted">(${members.length + 1})</span></h4>
            <div class="member-list" id="member-list"></div>
            ${can_manage ? `
            <form class="row mt-3" id="member-add" style="gap:6px">
              <input class="input" id="member-username" placeholder="username anggota…" maxlength="30" style="min-width:0;flex:1" autocapitalize="none">
              <button class="btn btn-purple btn-sm" type="submit" style="min-height:40px">${I.plus}</button>
            </form>
            <p class="hint">Anggota dapat membaca, membuat, dan mengedit naskahnya sendiri.</p>` : ''}
          </div>
          <div class="card mt-3">
            <h4 style="margin:0 0 8px;font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em;color:var(--silver-3)">Peran Anda</h4>
            <p style="margin:0;font-size:var(--fs-sm);color:var(--text-2)">
              ${isOwner ? 'Pemilik proyek — kendali penuh atas naskah dan anggota.' : my_role === 'member' ? 'Anggota — dapat membaca semua naskah dan mengedit naskah buatan sendiri.' : 'Pengawasan (super admin) — melihat semua proyek organisasi.'}
            </p>
          </div>
        </aside>
      </div>
    </main>`;
    bindLogout();

    // --- render naskah ---
    const grid = document.getElementById('script-grid');
    if (!scripts.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <h3>Belum ada naskah</h3>
        <p>Tulis naskah presentasi Anda, lalu buka teleprompter — teks akan mengikuti suara Anda.</p>
        ${canAddScript ? `<button class="btn btn-gold" id="btn-new-script-2">${I.plus} Tulis Naskah Pertama</button>` : ''}
      </div>`;
      const b2 = document.getElementById('btn-new-script-2');
      if (b2) b2.addEventListener('click', () => scriptEditor(project, null));
    } else {
      grid.innerHTML = scripts
        .map((s) => {
          const w = wordCount(s.content);
          return `
        <div class="card card-hover script-card">
          <h4>${esc(s.title)}</h4>
          <div class="meta">
            <span>${w} kata</span><span>·</span><span>~${estMinutes(w, s.words_per_minute)}</span>
            <span>·</span><span>${esc(fmtRel(s.updated_at))}</span>
          </div>
          <div class="actions">
            <a class="btn btn-gold btn-sm" href="#/prompter/${s.id}">${I.prompter} Teleprompter</a>
            <button class="btn btn-ghost btn-sm" data-edit="${s.id}">${I.edit}</button>
            ${(can_manage || s.created_by === state.user.id) ? `<button class="btn btn-danger btn-sm" data-del="${s.id}">${I.trash}</button>` : ''}
          </div>
        </div>`;
        })
        .join('');
      grid.querySelectorAll('[data-edit]').forEach((b) =>
        b.addEventListener('click', () => {
          const s = scripts.find((x) => String(x.id) === b.dataset.edit);
          scriptEditor(project, s);
        })
      );
      grid.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const s = scripts.find((x) => String(x.id) === b.dataset.del);
          const yes = await confirmDialog('Hapus naskah?', `Naskah "${s.title}" akan dihapus permanen beserta isinya.`);
          if (!yes) return;
          try {
            await api('/scripts/' + s.id, { method: 'DELETE' });
            toast('Naskah dihapus.', 'ok');
            render();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
      );
    }
    const newBtns = [document.getElementById('btn-new-script'), document.getElementById('btn-new-script-2')];
    newBtns.forEach((b) => b && b.addEventListener('click', () => scriptEditor(project, null)));

    // --- render anggota ---
    const memberList = document.getElementById('member-list');
    const renderMembers = () => {
      memberList.innerHTML =
        `<span class="member-chip"><span class="avatar">${esc(initials(owner.display_name || owner.username))}</span>
          <b>${esc(owner.display_name || owner.username)}</b><span class="pill pill-gold" style="padding:1px 8px;font-size:10px">Pemilik</span></span>` +
        members
          .map(
            (m) => `<span class="member-chip">
              <span class="avatar">${esc(initials(m.display_name || m.username))}</span>
              <span>${esc(m.display_name || m.username)}</span>
              ${can_manage || m.user_id === state.user.id ? `<button class="rm" data-rm="${m.user_id}" title="Keluarkan anggota">${I.close}</button>` : ''}
            </span>`
          )
          .join('');
      memberList.querySelectorAll('[data-rm]').forEach((b) =>
        b.addEventListener('click', async () => {
          const uid = Number(b.dataset.rm);
          const self = uid === state.user.id;
          const yes = await confirmDialog(self ? 'Keluar dari proyek?' : 'Keluarkan anggota?',
            self ? 'Anda akan kehilangan akses ke naskah proyek ini.' : 'Anggota akan kehilangan akses ke proyek ini.');
          if (!yes) return;
          try {
            await api(`/projects/${project.id}/members/${uid}`, { method: 'DELETE' });
            toast(self ? 'Anda keluar dari proyek.' : 'Anggota dikeluarkan.', 'ok');
            if (self) navigate('#/dashboard');
            else render();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
      );
    };
    renderMembers();

    const memberForm = document.getElementById('member-add');
    if (memberForm) {
      memberForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('member-username');
        const btn = memberForm.querySelector('button[type=submit]');
        if (btn.disabled) return; // cegah kirim ganda
        const username = input.value.trim().toLowerCase();
        if (!username) return;
        btn.disabled = true;
        try {
          const data = await api(`/projects/${project.id}/members`, { method: 'POST', body: { username } });
          members.push(data);
          input.value = '';
          toast('Anggota ditambahkan: ' + data.username, 'ok');
          renderMembers();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });
    }

    const editBtn = document.getElementById('btn-edit-proj');
    if (editBtn) editBtn.addEventListener('click', () => projectForm(project, () => render()));
    const delBtn = document.getElementById('btn-del-proj');
    if (delBtn)
      delBtn.addEventListener('click', async () => {
        const yes = await confirmDialog('Hapus proyek?', `Proyek "${project.name}" beserta seluruh naskah dan anggotanya akan dihapus permanen.`);
        if (!yes) return;
        try {
          await api('/projects/' + project.id, { method: 'DELETE' });
          toast('Proyek dihapus.', 'ok');
          navigate('#/dashboard');
        } catch (err) {
          toast(err.message, 'err');
        }
      });
  }

  // ---------- Editor naskah (modal, autosave) ----------

  function scriptEditor(project, script) {
    const isNew = !script;
    const wpm = script ? script.words_per_minute : 140;
    openModal({
      title: isNew ? 'Naskah Baru — ' + project.name : 'Edit Naskah',
      wide: true,
      bodyHtml: `
      <form id="script-form" novalidate>
        <label class="field">
          <span class="label-txt">Judul naskah</span>
          <input class="input" name="title" value="${esc(isNew ? '' : script.title)}" maxlength="120" placeholder="cth: Video Sambutan Rektor" required>
        </label>
        <label class="field">
          <span class="label-txt">Isi naskah</span>
          <textarea class="textarea" name="content" id="content-ta" style="min-height:240px;font-size:var(--fs-md)" placeholder="Tulis atau tempek naskah Anda di sini… Panjang tidak dibatasi.">${esc(isNew ? '' : script.content)}</textarea>
        </label>
        <div class="row spread" style="gap:10px">
          <label class="field" style="margin:0;flex:1;max-width:220px">
            <span class="label-txt">Kecepatan baca (KPM)</span>
            <input class="input" name="words_per_minute" type="number" min="60" max="250" step="5" value="${wpm}">
          </label>
          <div style="flex:1;min-width:150px;text-align:right">
            <div id="sc-stats" class="hint" style="margin-top:18px">0 kata · ~0 detik</div>
            <div id="sc-save" class="hint" style="color:var(--silver-3)">Belum tersimpan</div>
          </div>
        </div>
        <div class="form-err" id="script-err"></div>
        <div class="modal-foot" style="padding:12px 0 0">
          <button class="btn btn-ghost" type="button" id="sc-close">Tutup</button>
          <button class="btn btn-purple" type="submit">${I.check} Simpan</button>
          <button class="btn btn-gold" type="button" id="sc-open">${I.prompter} Teleprompter</button>
        </div>
      </form>`,
      onMount(root, close) {
        const form = root.querySelector('#script-form');
        const ta = root.querySelector('#content-ta');
        const stats = root.querySelector('#sc-stats');
        const saveHint = root.querySelector('#sc-save');
        const errEl = root.querySelector('#script-err');
        let savedId = isNew ? null : script.id;
        let lastSaved = isNew ? null : { title: script.title, content: script.content, wpm: script.words_per_minute };
        let dirty = false;
        // Antrean simpan: autosave + Simpan + Teleprompter tidak pernah berjalan paralel,
        // dan setelah simpan pertama (POST) semua simpan berikutnya jadi PUT — mencegah naskah ganda.
        let saveChain = Promise.resolve();

        const updateStats = () => {
          const w = wordCount(ta.value);
          const wpmv = Number(form.words_per_minute.value) || 140;
          stats.textContent = `${w} kata · ~${estMinutes(w, wpmv)}`;
        };
        updateStats();
        ta.addEventListener('input', () => {
          dirty = true;
          updateStats();
          saveHint.textContent = 'Perubahan belum tersimpan…';
          saveHint.style.color = 'var(--warn)';
          autosave();
        });
        form.words_per_minute.addEventListener('input', () => {
          updateStats();
          if (!isNew) {
            dirty = true;
            autosave();
          }
        });

        const doSave = () => {
          saveChain = saveChain.then(async () => {
            const title = form.title.value.trim();
            if (title.length < 2) {
              errEl.textContent = 'Judul minimal 2 karakter.';
              return null;
            }
            const body = {
              title,
              content: ta.value,
              words_per_minute: Number(form.words_per_minute.value) || 140,
            };
            try {
              let data;
              if (savedId) {
                data = await api('/scripts/' + savedId, { method: 'PUT', body });
              } else {
                data = await api(`/projects/${project.id}/scripts`, { method: 'POST', body });
                savedId = data.script.id;
                history.replaceState(null, '', '#/project/' + project.id);
              }
              lastSaved = { title: body.title, content: body.content, wpm: body.words_per_minute };
              dirty = false;
              saveHint.textContent = 'Tersimpan ✓ ' + new Date().toLocaleTimeString('id-ID');
              saveHint.style.color = 'var(--ok)';
              return data.script;
            } catch (err) {
              saveHint.textContent = 'Gagal menyimpan — coba lagi.';
              saveHint.style.color = 'var(--err)';
              toast(err.message, 'err', 4000);
              return null;
            }
          });
          return saveChain;
        };
        const autosave = debounce(doSave, 1300);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = form.querySelector('button[type=submit]');
          if (btn.disabled) return; // cegah kirim ganda
          btn.disabled = true;
          const s = await doSave();
          btn.disabled = false;
          if (s) {
            close();
            toast('Naskah tersimpan.', 'ok');
            render();
          }
        });
        root.querySelector('#sc-close').addEventListener('click', async () => {
          if (dirty) await doSave();
          close();
          if (dirty || !isNew) render();
        });
        root.querySelector('#sc-open').addEventListener('click', async () => {
          const s = await doSave();
          if (!s) return;
          close();
          navigate('#/prompter/' + s.id);
        });

        // Flush saat modal ditutup paksa / halaman disembunyikan
        const flush = () => {
          if (dirty && savedId) {
            try {
              fetch('/api/scripts/' + savedId, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: form.title.value.trim() || (lastSaved ? lastSaved.title : 'Naskah'), content: ta.value, words_per_minute: Number(form.words_per_minute.value) || 140 }),
                keepalive: true,
              }).catch(() => {});
            } catch {
              /* abaikan */
            }
          }
        };
        const onVis = () => {
          if (document.visibilityState === 'hidden') flush();
        };
        document.addEventListener('visibilitychange', onVis);
        currentCleanup = () => document.removeEventListener('visibilitychange', onVis);
      },
    });
  }

  // ---------- View: Admin pengguna ----------

  async function viewAdmin() {
    $app.innerHTML = `${topbarHtml('admin')}
    <main class="page container">
      <div class="page-head">
        <div class="grow">
          <h2 class="page-title">Manajemen <span class="gold">Pengguna</span></h2>
          <p class="page-sub">Super admin dapat menambahkan pengguna baru (mis. manager) untuk menginisiasi proyek.</p>
        </div>
        <button class="btn btn-gold" id="btn-add-user">${I.plus} Tambah Pengguna</button>
      </div>
      <div class="stat-strip" id="adm-stats"></div>
      <div id="users-wrap" class="table-wrap"></div>
    </main>`;
    bindLogout();
    document.getElementById('btn-add-user').addEventListener('click', () => userForm(null));

    api('/stats')
      .then((d) => {
        const s = d.stats;
        document.getElementById('adm-stats').innerHTML = `
          <div class="stat"><div class="v">${s.users}</div><div class="k">Pengguna</div></div>
          <div class="stat"><div class="v">${s.projects}</div><div class="k">Proyek</div></div>
          <div class="stat"><div class="v">${s.scripts}</div><div class="k">Naskah</div></div>
          <div class="stat"><div class="v">${s.active_sessions}</div><div class="k">Sesi Aktif</div></div>`;
      })
      .catch(() => {});

    const wrap = document.getElementById('users-wrap');
    wrap.innerHTML = '<div class="skel" style="height:180px;border-radius:12px"></div>';
    let users = [];
    try {
      const d = await api('/users');
      users = d.users || [];
    } catch (err) {
      wrap.innerHTML = `<div class="empty-state"><h3>Gagal memuat</h3><p>${esc(err.message)}</p></div>`;
      return;
    }
    if (!users.length) {
      wrap.innerHTML = '<div class="empty-state"><h3>Belum ada pengguna</h3><p>Tambahkan pengguna pertama.</p></div>';
      return;
    }
    wrap.innerHTML = `
    <table class="tbl">
      <thead><tr>
        <th>Pengguna</th><th>Peran</th><th>Status</th><th>Proyek</th><th>Login terakhir</th><th></th>
      </tr></thead>
      <tbody>
        ${users
          .map(
            (u) => `
        <tr>
          <td><div class="cell-user">
            <span class="avatar">${esc(initials(u.display_name))}</span>
            <div><b>${esc(u.display_name)}</b><div class="sub">@${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}</div></div>
          </div></td>
          <td><span class="pill ${u.role === 'super_admin' ? 'pill-gold' : u.role === 'manager' ? 'pill-purple' : ''}">${esc(roleName(u.role))}</span></td>
          <td>${u.is_active ? '<span class="pill pill-ok">Aktif</span>' : '<span class="pill pill-err">Nonaktif</span>'}</td>
          <td>${u.projects_owned} milik / ${u.memberships} ikut</td>
          <td class="muted">${esc(fmtRel(u.last_login_at))}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-uid="${u.id}" title="Ubah">${I.edit}</button>
            ${u.id !== state.user.id ? `<button class="btn btn-danger btn-sm" data-uid-del="${u.id}" title="Hapus">${I.trash}</button>` : ''}
          </td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
    wrap.querySelectorAll('[data-uid]').forEach((b) =>
      b.addEventListener('click', () => {
        const u = users.find((x) => String(x.id) === b.dataset.uid);
        userForm(u);
      })
    );
    wrap.querySelectorAll('[data-uid-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const u = users.find((x) => String(x.id) === b.dataset.uidDel);
        const yes = await confirmDialog('Hapus pengguna?', `Akun @${u.username} beserta proyek yang dimiliknya akan dihapus permanen.`);
        if (!yes) return;
        try {
          await api('/users/' + u.id, { method: 'DELETE' });
          toast('Pengguna dihapus.', 'ok');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      })
    );
  }

  function userForm(user) {
    const isEdit = !!user;
    openModal({
      title: isEdit ? 'Ubah Pengguna — @' + user.username : 'Tambah Pengguna',
      bodyHtml: `
      <form id="user-form" novalidate>
        ${isEdit ? '' : `
        <label class="field">
          <span class="label-txt">Username</span>
          <input class="input" name="username" maxlength="30" placeholder="huruf kecil, 3-30 karakter" autocapitalize="none" required>
        </label>`}
        <label class="field">
          <span class="label-txt">Nama tampilan</span>
          <input class="input" name="display_name" value="${esc(isEdit ? user.display_name : '')}" maxlength="60" placeholder="cth: Humas Fajrianor">
        </label>
        <label class="field">
          <span class="label-txt">Email (opsional)</span>
          <input class="input" name="email" type="email" value="${esc(isEdit ? user.email || '' : '')}" maxlength="120" placeholder="opsional">
        </label>
        <label class="field">
          <span class="label-txt">Peran</span>
          <select class="select" name="role">
            <option value="manager" ${isEdit && user.role === 'manager' ? 'selected' : ''}>Manager — dapat membuat & mengelola proyek</option>
            <option value="member" ${isEdit && user.role === 'member' ? 'selected' : ''}>Member — presenter/penulis naskah</option>
            <option value="super_admin" ${isEdit && user.role === 'super_admin' ? 'selected' : ''}>Super Admin — akses penuh</option>
          </select>
        </label>
        <label class="field">
          <span class="label-txt">${isEdit ? 'Kata sandi baru (kosongkan jika tetap)' : 'Kata sandi'}</span>
          <input class="input" name="password" type="password" minlength="8" maxlength="128" placeholder="minimal 8 karakter" ${isEdit ? '' : 'required'}>
        </label>
        ${isEdit ? `
        <label class="field row" style="gap:10px">
          <input type="checkbox" name="is_active" id="uf-active" ${user.is_active ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--gold-2)">
          <label for="uf-active" style="margin:0;font-size:var(--fs-sm)">Akun aktif (nonaktif = tidak bisa masuk)</label>
        </label>` : ''}
        <div class="form-err" id="user-err"></div>
        <button class="btn btn-gold btn-block" type="submit">${isEdit ? 'Simpan' : 'Tambah Pengguna'}</button>
      </form>`,
      onMount(root, close) {
        root.querySelector('#user-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = e.target.querySelector('button[type=submit]');
          if (btn.disabled) return; // cegah kirim ganda
          const errEl = root.querySelector('#user-err');
          errEl.textContent = '';
          const fd = new FormData(e.target);
          const body = {};
          if (!isEdit) body.username = fd.get('username');
          body.display_name = fd.get('display_name');
          body.email = fd.get('email');
          body.role = fd.get('role');
          const pw = fd.get('password');
          if (pw) body.password = pw;
          if (isEdit) body.is_active = !!fd.get('is_active');
          btn.disabled = true;
          btn.textContent = 'Menyimpan…';
          try {
            if (isEdit) await api('/users/' + user.id, { method: 'PATCH', body });
            else await api('/users', { method: 'POST', body });
            close();
            toast(isEdit ? 'Pengguna diperbarui.' : 'Pengguna ditambahkan.', 'ok');
            render();
          } catch (err) {
            errEl.textContent = err.message;
            btn.disabled = false;
            btn.textContent = isEdit ? 'Simpan' : 'Tambah Pengguna';
          }
        });
      },
    });
  }

  // ---------- View: Teleprompter ----------

  async function viewPrompter(scriptId) {
    if (!state.user) {
      navigate(state.needsSetup ? '#/setup' : '#/login');
      return;
    }
    $app.innerHTML = `${topbarHtml()}
    <main class="page container"><div class="skel" style="height:320px"></div></main>`;
    try {
      const d = await api('/scripts/' + scriptId);
      if (!window.Prompter) throw new Error('Modul teleprompter gagal dimuat. Muat ulang halaman.');
      window.Prompter.open({
        script: d.script,
        projectName: d.project ? d.project.name : '',
        onExit: () => {
          navigate('#/project/' + d.script.project_id);
        },
      });
    } catch (err) {
      $app.innerHTML = `${topbarHtml()}
      <main class="page container">
        <div class="empty-state"><h3>Tidak dapat membuka teleprompter</h3><p>${esc(err.message)}</p>
        <a class="btn btn-ghost mt-3" href="#/dashboard">${I.back} Kembali</a></div>
      </main>`;
      bindLogout();
    }
  }

  // ---------- Boot ----------

  async function boot() {
    try {
      const d = await api('/auth/me');
      state.user = d.user;
      state.needsSetup = !!d.needsSetup;
    } catch {
      state.user = null;
      state.needsSetup = false;
    }
    state.booted = true;
    if (!location.hash) location.hash = state.user ? '#/dashboard' : state.needsSetup ? '#/setup' : '#/login';
    render();
  }

  window.addEventListener('hashchange', () => {
    if (window.Prompter && window.Prompter.isActive()) {
      window.Prompter.exit();
    }
    render();
  });
  boot();
})();
