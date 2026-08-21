/* Baratilyo — content script bridge + in-page badges */
(function () {
  'use strict';
  var api = typeof browser !== 'undefined' ? browser : chrome;
  var scores = new Map();      // listingId -> {score, discountPct, reasons, eligible}
  var requested = new Set();
  var pendingIds = new Set();
  var flushTimer = null;

  /* ---------- page -> background ---------- */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || !d.__dr || d.dir !== 'page->cs') return;
    if (d.kind === 'listings') {
      api.runtime.sendMessage({ kind: 'listings', payload: d.payload }).then(function (res) {
        if (res && res.scores) applyScores(res.scores);
      }).catch(function () { });
    } else if (d.kind === 'enriched' || d.kind === 'tokens' || d.kind === 'ready') {
      api.runtime.sendMessage({ kind: d.kind, payload: d.payload }).catch(function () { });
    }
  });

  /* ---------- background -> page ---------- */
  api.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.kind === 'enrich') {
      window.postMessage({ __dr: true, dir: 'cs->page', kind: 'enrich', payload: msg.payload }, location.origin);
      return Promise.resolve({ ok: true });
    }
    if (msg.kind === 'scores') {
      applyScores(msg.payload);
      return Promise.resolve({ ok: true });
    }
  });

  function applyScores(list) {
    (list || []).forEach(function (s) { scores.set(String(s.id), s); });
    decorate();
  }

  function askFor(ids) {
    var fresh = ids.filter(function (id) { return !requested.has(id); });
    fresh.forEach(function (id) { requested.add(id); pendingIds.add(id); });
    if (!pendingIds.size) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      var batch = Array.from(pendingIds);
      pendingIds.clear();
      api.runtime.sendMessage({ kind: 'getScores', payload: { ids: batch } })
        .then(function (res) { if (res && res.scores) applyScores(res.scores); })
        .catch(function () { });
    }, 350);
  }

  /* ---------- badges ---------- */
  var ID_RE = /\/marketplace\/item\/(\d+)/;

  function badgeClass(s) {
    if (s.score >= 75) return 'dr-badge dr-hot';
    if (s.score >= 55) return 'dr-badge dr-good';
    if (s.sellerOk === false) return 'dr-badge dr-warn';
    return 'dr-badge dr-meh';
  }

  function badgeText(s) {
    if (s.discountPct >= 1) return '-' + Math.round(s.discountPct) + '% · ' + s.score;
    if (s.dropPct >= 5) return '↓' + Math.round(s.dropPct) + '% · ' + s.score;
    return String(s.score);
  }

  function decorate() {
    var links = document.querySelectorAll('a[href*="/marketplace/item/"]');
    var seen = [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var m = ID_RE.exec(a.getAttribute('href') || '');
      if (!m) continue;
      var id = m[1];
      seen.push(id);
      var s = scores.get(id);
      if (!s) continue;
      var host = a;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      var b = a.querySelector(':scope > .dr-badge');
      if (!b) {
        b = document.createElement('div');
        a.appendChild(b);
      }
      b.className = badgeClass(s);
      b.textContent = badgeText(s);
      b.title = (s.reasons || []).join(' · ') + (s.baseline ? '\nbaseline ' + Math.round(s.baseline) + ' from ' + s.comps + ' comps' : '');
    }
    if (seen.length) askFor(seen);
  }

  var raf = null;
  var obs = new MutationObserver(function () {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = null; decorate(); });
  });

  function start() {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    decorate();
    setInterval(decorate, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
