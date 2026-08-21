'use strict';
var api = typeof browser !== 'undefined' ? browser : chrome;
var $ = function (id) { return document.getElementById(id); };
var FIELDS = ['minDiscount', 'minComps', 'maxSellerJoinYear', 'notifyMinScore', 'keepDays', 'enrichIntervalSec'];

function money(v, cur) {
  if (typeof v !== 'number') return '—';
  var n = Math.round(v).toLocaleString();
  return (cur === 'PHP' ? '₱' : cur === 'USD' ? '$' : (cur ? cur + ' ' : '')) + n;
}

function pillClass(r) {
  if (r.sellerOk === false) return 'pill warn';
  if (r.score >= 75) return 'pill hot';
  if (r.score >= 55) return 'pill good';
  return 'pill';
}

function render(rows) {
  var list = $('list');
  list.textContent = '';
  $('empty').style.display = rows.length ? 'none' : 'block';
  rows.forEach(function (r) {
    var a = document.createElement('a');
    a.className = 'card';
    a.href = r.url || ('https://www.facebook.com/marketplace/item/' + r.id + '/');
    a.target = '_blank';

    var img = document.createElement('img');
    img.className = 'thumb';
    if (r.photo) img.src = r.photo;
    a.appendChild(img);

    var meta = document.createElement('div');
    meta.className = 'meta';

    var pill = document.createElement('span');
    pill.className = pillClass(r);
    pill.textContent = r.score;
    meta.appendChild(pill);

    var t = document.createElement('div');
    t.className = 'title';
    t.textContent = r.title || '(untitled)';
    meta.appendChild(t);

    var p = document.createElement('div');
    p.className = 'price';
    var b = document.createElement('b');
    b.textContent = money(r.price, r.currency);
    p.appendChild(b);
    var first = r.priceHistory && r.priceHistory.length ? r.priceHistory[0].price : null;
    if (first && first > r.price) {
      var was = document.createElement('span');
      was.className = 'was';
      was.textContent = money(first, r.currency);
      p.appendChild(was);
    }
    if (r.baseline) {
      var vs = document.createElement('span');
      vs.className = 'was';
      vs.style.textDecoration = 'none';
      vs.textContent = 'median ' + money(r.baseline, r.currency);
      p.appendChild(vs);
    }
    meta.appendChild(p);

    var why = document.createElement('div');
    why.className = 'why';
    var bits = (r.reasons || []).slice(0, 3);
    if (r.location) bits.push(r.location);
    why.textContent = bits.join(' · ');
    meta.appendChild(why);

    a.appendChild(meta);
    list.appendChild(a);
  });
}

function refresh() {
  api.runtime.sendMessage({
    kind: 'getTop',
    payload: { minScore: parseInt($('minScore').value, 10) || 0, q: $('q').value.trim(), limit: 60, days: 14 }
  }).then(function (res) { render((res && res.rows) || []); });

  api.runtime.sendMessage({ kind: 'getStats' }).then(function (s) {
    if (s) $('stats').textContent = s.listings.toLocaleString() + ' listings · ' + s.sellers + ' sellers';
  });
}

function loadSettings() {
  api.runtime.sendMessage({ kind: 'getSettings' }).then(function (r) {
    var s = (r && r.settings) || {};
    FIELDS.forEach(function (f) { if ($(f)) $(f).value = s[f]; });
    $('sellerGate').value = s.sellerGate || 'flag';
    $('paused').checked = !!s.paused;
  });
}

$('save').addEventListener('click', function () {
  var patch = { sellerGate: $('sellerGate').value, paused: $('paused').checked, notify: true };
  FIELDS.forEach(function (f) { patch[f] = parseInt($(f).value, 10); });
  $('save').textContent = 'Saving…';
  api.runtime.sendMessage({ kind: 'setSettings', payload: patch }).then(function () {
    $('save').textContent = 'Saved';
    setTimeout(function () { $('save').textContent = 'Save'; }, 1200);
    refresh();
  });
});

$('enrich').addEventListener('click', function () {
  api.runtime.sendMessage({ kind: 'forceEnrich' });
  $('enrich').textContent = 'Queued';
  setTimeout(function () { $('enrich').textContent = 'Check sellers now'; }, 1500);
});

$('export').addEventListener('click', function () {
  api.runtime.sendMessage({ kind: 'exportAll' }).then(function (r) {
    var blob = new Blob([JSON.stringify((r && r.rows) || [], null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    api.downloads ? api.downloads.download({ url: url, filename: 'baratilyo-export.json' })
      : window.open(url, '_blank');
  });
});

$('clear').addEventListener('click', function () {
  if (!confirm('Delete all collected listings and price history?')) return;
  api.runtime.sendMessage({ kind: 'clearAll' }).then(refresh);
});

$('q').addEventListener('input', function () { clearTimeout(window.__t); window.__t = setTimeout(refresh, 250); });
$('minScore').addEventListener('change', refresh);

loadSettings();
refresh();
setInterval(refresh, 5000);
