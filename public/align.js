// align.js — algoritma penyelarasan ucapan ↔ naskah Basarang: Bagarak Saurang
// Modul murni tanpa DOM: dipakai oleh prompter.js di browser dan oleh unit test di Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BasarangAlign = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Normalisasi satu kata: lowercase, buang diakritik & tanda baca, sisakan huruf/angka unicode.
  function normalizeWord(w) {
    return String(w == null ? '' : w)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .trim();
  }

  function normalizeAll(text) {
    return String(text || '')
      .split(/\s+/)
      .map(normalizeWord)
      .filter(Boolean);
  }

  // Apakah jarak edit a-b maksimal 1 (substitusi/sisipan/penghapusan tunggal)?
  function editDistanceAtMostOne(a, b) {
    if (a === b) return true;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    if (la === lb) {
      let diff = 0;
      for (let i = 0; i < la; i++) {
        if (a.charCodeAt(i) !== b.charCodeAt(i) && ++diff > 1) return false;
      }
      return true;
    }
    const short = la < lb ? a : b;
    const long = la < lb ? b : a;
    let i = 0;
    let j = 0;
    let skipped = false;
    while (i < short.length && j < long.length) {
      if (short.charCodeAt(i) === long.charCodeAt(j)) {
        i++;
        j++;
        continue;
      }
      if (skipped) return false;
      skipped = true;
      j++;
    }
    return true; // sisa long paling banyak 1 karakter
  }

  // Kesetaraan kata dengan toleransi salah-dengar ASR ringan untuk kata panjang.
  function fuzzyEq(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 5 && b.length >= 5) return editDistanceAtMostOne(a, b);
    return false;
  }

  // Selaraskan kata terucap terhadap naskah mulai startPos.
  // Kata yang tak dikenali tidak menggeser penunjuk (pengguna boleh improvisasi);
  // kata naskah yang dilewati pengguna tetap terkejar lewat jendela lookahead.
  function alignSpoken(scriptNorms, spokenNorms, startPos, opts) {
    const lookahead = (opts && opts.lookahead) || 16;
    const total = scriptNorms.length;
    let pos = Math.max(0, Math.min(startPos, total));
    let matched = 0;
    let unmatched = 0;
    for (let k = 0; k < spokenNorms.length; k++) {
      const w = spokenNorms[k];
      if (!w) continue;
      let found = -1;
      const lim = Math.min(pos + lookahead, total);
      for (let j = pos; j < lim; j++) {
        if (fuzzyEq(scriptNorms[j], w)) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        pos = found + 1;
        matched++;
      } else {
        unmatched++;
      }
    }
    return { pos, matched, unmatched };
  }

  // Cari posisi terbaik bagi ekor kata terucap (untuk resync setelah improvisasi panjang).
  // Mengembalikan { start, score } atau null.
  function resyncSearch(scriptNorms, spokenTail, searchFrom, searchTo) {
    const total = scriptNorms.length;
    const from = Math.max(0, searchFrom || 0);
    const to = Math.min(searchTo == null ? total - 1 : searchTo, total - 1);
    let best = -1;
    let bestScore = 0;
    for (let s = from; s <= to; s++) {
      let score = 0;
      let p = s;
      for (let k = 0; k < spokenTail.length; k++) {
        const w = spokenTail[k];
        if (!w) continue;
        let found = -1;
        const lim = Math.min(p + 4, total);
        for (let j = p; j < lim; j++) {
          if (fuzzyEq(scriptNorms[j], w)) {
            found = j;
            break;
          }
        }
        if (found >= 0) {
          p = found + 1;
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best >= 0 ? { start: best, score: bestScore } : null;
  }

  return { normalizeWord, normalizeAll, fuzzyEq, editDistanceAtMostOne, alignSpoken, resyncSearch };
});
