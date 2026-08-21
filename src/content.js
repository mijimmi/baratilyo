/* Baratilyo — content script bridge, in-page badges, and the on-page HUD */
(function () {
  'use strict';
  var api = typeof browser !== 'undefined' ? browser : chrome;
  var DEBUG = true;
  var scores = new Map();
  var requested = new Set();
  var pendingIds = new Set();
  var flushTimer = null;
  var stat = { captured: 0, badged: 0, ingested: 0, hookWorld: '?' };

  function log() {
    if (!DEBUG) return;
    var a = Array.prototype.slice.call(arguments);
    a.unshift('%c[Baratilyo:cs]', 'color:#38bdf8;font-weight:700');
    console.log.apply(console, a);
  }

  /* ---------- make sure the page-world hook actually got installed ----------
     manifest world:"MAIN" needs Firefox 128+. If it was ignored, hook.js ran in
     the isolated world instead, where patching fetch captures nothing. Detect
     that through Firefox's Xray wrapper and fall back to a script tag. */
  function pageHookInstalled() {
    try { return !!(window.wrappedJSObject && window.wrappedJSObject.__DR_HOOKED__); }
    catch (e) { return false; }
  }

  function injectHook() {
    try {
      var s = document.createElement('script');
      s.src = api.runtime.getURL('src/hook.js');
      s.async = false;
      s.onload = function () { s.remove(); };
      s.onerror = function () { log('script-tag injection blocked (page CSP?)'); stat.hookWorld = 'blocked'; };
      (document.head || document.documentElement).appendChild(s);
      log('world:"MAIN" unavailable — injected hook via script tag instead');
      stat.hookWorld = 'injected';
    } catch (e) {
      log('could not inject hook:', e);
      stat.hookWorld = 'failed';
    }
  }

  setTimeout(function () {
    if (pageHookInstalled()) { stat.hookWorld = 'MAIN'; log('page-world hook confirmed'); }
    else injectHook();
  }, 600);

  /* ---------- page -> background ---------- */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || !d.__dr || d.dir !== 'page->cs') return;
    if (d.kind === 'listings') {
      stat.captured += d.payload.listings.length;
      api.runtime.sendMessage({ kind: 'listings', payload: d.payload }).then(function (res) {
        if (res && res.scores) {
          stat.ingested += res.scores.length;
          applyScores(res.scores);
        } else {
          log('background returned no scores for', d.payload.listings.length, 'listings', res);
        }
      }).catch(function (e) { log('sendMessage failed:', e); });
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
    var n = 0;
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var m = ID_RE.exec(a.getAttribute('href') || '');
      if (!m) continue;
      var id = m[1];
      seen.push(id);
      var s = scores.get(id);
      if (!s) continue;
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      var b = a.querySelector(':scope > .dr-badge');
      if (!b) { b = document.createElement('div'); a.appendChild(b); }
      b.className = badgeClass(s);
      b.textContent = badgeText(s);
      b.title = (s.reasons || []).join(' · ')
        + (s.baseline ? '\nbaseline ' + Math.round(s.baseline) + ' from ' + s.comps + ' comps' : '');
      n++;
    }
    stat.badged = n;
    if (seen.length) askFor(seen);
    updateHud(links.length);
  }

  /* ---------- HUD ---------- */
  var hud = null;
  function updateHud(cardCount) {
    if (!document.body) return;
    if (!hud) {
      hud = document.createElement('div');
      hud.className = 'dr-hud';
      hud.title = 'Baratilyo status — click to hide for this page';
      hud.addEventListener('click', function () { hud.style.display = 'none'; });
      document.body.appendChild(hud);
    }
    var state = stat.captured === 0 ? 'dr-hud dr-hud-cold' : 'dr-hud dr-hud-live';
    hud.className = state;
    hud.textContent = 'Baratilyo · ' + stat.captured + ' captured · '
      + stat.badged + '/' + (cardCount || 0) + ' badged'
      + (stat.hookWorld !== 'MAIN' ? ' · hook:' + stat.hookWorld : '');
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
    log('content script running');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
