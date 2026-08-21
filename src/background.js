/* Baratilyo — background: ingest, comps, scoring, enrichment, alerts */
'use strict';
var api = typeof browser !== 'undefined' ? browser : chrome;
var S = self.DRScore, DB = self.DRDB;

var DEFAULTS = {
  minDiscount: 20,        // % below bucket median to count as a deal
  minComps: 6,            // comps needed before a baseline is trusted
  maxSellerJoinYear: 2021,// seller account must be this old or older
  sellerGate: 'flag',     // 'off' | 'flag' (hide new accounts) | 'require' (verified old only)
  notify: true,
  notifyMinScore: 60,
  keepDays: 90,
  enrichIntervalSec: 14,  // seconds between seller-age lookups (be gentle)
  enrichPerRun: 4,
  paused: false
};

var settings = Object.assign({}, DEFAULTS);
var notified = new Set();

function loadSettings() {
  return api.storage.local.get('settings').then(function (r) {
    settings = Object.assign({}, DEFAULTS, r.settings || {});
    return settings;
  });
}
function saveSettings(patch) {
  settings = Object.assign({}, settings, patch || {});
  return api.storage.local.set({ settings: settings }).then(function () { return settings; });
}

/* ---------------- ingest ---------------- */

function mergeListing(existing, incoming, nowMs) {
  var l = existing || {
    id: incoming.id,
    firstSeen: nowMs,
    priceHistory: [],
    sellerCheckState: 'new',
    sellerCheckTries: 0
  };
  l.title = incoming.title || l.title;
  l.currency = incoming.currency || l.currency;
  l.location = incoming.location || l.location;
  l.photo = incoming.photo || l.photo;
  l.url = incoming.url || l.url;
  l.categoryHint = incoming.categoryHint || l.categoryHint;
  l.createdAt = incoming.createdAt || l.createdAt;
  l.sellerId = incoming.sellerId || l.sellerId;
  l.sellerName = incoming.sellerName || l.sellerName;
  if (incoming.sellerJoinYear) l.sellerJoinYear = incoming.sellerJoinYear;
  if (incoming.strikethroughPrice) l.strikethroughPrice = incoming.strikethroughPrice;
  if (typeof incoming.sold === 'boolean' && incoming.sold) l.sold = true;

  var p = incoming.price;
  if (typeof p === 'number' && isFinite(p) && p > 0) {
    var last = l.priceHistory.length ? l.priceHistory[l.priceHistory.length - 1].price : null;
    if (last === null || Math.abs(last - p) > 0.5) l.priceHistory.push({ t: nowMs, price: p });
    l.price = p;
  }
  l.lastSeen = nowMs;
  l.bucket = S.bucketKey(l.title, l.categoryHint);
  return l;
}

function rescoreBucket(bucket, nowSec) {
  return DB.byBucket(bucket).then(function (rows) {
    var cutoff = Date.now() - settings.keepDays * 86400000;
    var live = rows.filter(function (r) { return r.lastSeen >= cutoff && typeof r.price === 'number'; });
    var prices = live.map(function (r) { return r.price; });
    var updated = [];
    live.forEach(function (r) {
      /* leave-one-out: a listing never helps set its own baseline */
      var others = prices.slice();
      var idx = others.indexOf(r.price);
      if (idx > -1) others.splice(idx, 1);
      var st = S.stats(others);
      var sc = S.scoreListing(r, st, settings, nowSec);
      r.score = sc.score;
      r.discountPct = sc.discountPct;
      r.dropPct = sc.dropPct;
      r.baseline = sc.baseline;
      r.comps = sc.comps;
      r.reasons = sc.reasons;
      r.eligible = sc.eligible;
      r.sellerOk = sc.sellerOk;
      r.ageHours = sc.ageHours;
      updated.push(r);
    });
    return DB.bulkPut('listings', updated).then(function () { return updated; });
  });
}

function drlog() {
  var a = Array.prototype.slice.call(arguments);
  a.unshift('%c[Baratilyo:bg]', 'color:#f97316;font-weight:700');
  console.log.apply(console, a);
}

function ingest(listings) {
  if (settings.paused || !listings || !listings.length) return Promise.resolve([]);
  var nowMs = Date.now(), nowSec = Math.floor(nowMs / 1000);
  var ids = listings.map(function (l) { return l.id; });
  return Promise.all(listings.map(function (inc) {
    return DB.get('listings', inc.id).then(function (ex) { return mergeListing(ex, inc, nowMs); });
  })).then(function (merged) {
    return applySellerCache(merged);
  }).then(function (merged) {
    return DB.bulkPut('listings', merged).then(function () {
      var buckets = {};
      merged.forEach(function (m) { buckets[m.bucket] = true; });
      return Promise.all(Object.keys(buckets).map(function (b) { return rescoreBucket(b, nowSec); }));
    }).then(function (groups) {
      var flat = [].concat.apply([], groups);
      maybeNotify(flat);
      var wanted = new Set(ids);
      var out = flat.filter(function (r) { return wanted.has(r.id); }).map(slim);
      drlog('ingested ' + listings.length + ', scored ' + out.length + ', buckets touched ' + groups.length);
      return out;
    });
  });
}

function applySellerCache(list) {
  var need = list.filter(function (l) { return !l.sellerJoinYear && l.sellerId; });
  if (!need.length) return Promise.resolve(list);
  return Promise.all(need.map(function (l) {
    return DB.get('sellers', l.sellerId).then(function (s) {
      if (s && s.joinYear) { l.sellerJoinYear = s.joinYear; l.sellerCheckState = 'done'; }
    }).catch(function () { });
  })).then(function () { return list; });
}

function slim(r) {
  return {
    id: r.id, score: r.score || 0, discountPct: r.discountPct || 0, dropPct: r.dropPct || 0,
    baseline: r.baseline || null, comps: r.comps || 0, reasons: r.reasons || [],
    eligible: !!r.eligible, sellerOk: r.sellerOk === undefined ? null : r.sellerOk
  };
}

/* ---------------- alerts ---------------- */

function maybeNotify(rows) {
  if (!settings.notify) return;
  rows.forEach(function (r) {
    if (!r.eligible || r.score < settings.notifyMinScore) return;
    if (notified.has(r.id)) return;
    notified.add(r.id);
    try {
      api.notifications.create('dr-' + r.id, {
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon48.png'),
        title: Math.round(r.discountPct) + '% under market · score ' + r.score,
        message: (r.title || '').slice(0, 80) + '\n' + (r.currency || '') + Math.round(r.price)
          + ' · ' + (r.reasons || []).slice(0, 2).join(' · ')
      });
    } catch (e) { }
  });
}

api.notifications.onClicked.addListener(function (id) {
  if (id.indexOf('dr-') !== 0) return;
  api.tabs.create({ url: 'https://www.facebook.com/marketplace/item/' + id.slice(3) + '/' });
});

/* ---------------- seller-age enrichment ---------------- */

function enrichCandidates(limit) {
  var cutoff = Date.now() - settings.keepDays * 86400000;
  return DB.getAll('listings', 'lastSeen', IDBKeyRange.lowerBound(cutoff), 4000).then(function (rows) {
    return rows.filter(function (r) {
      if (r.sellerJoinYear || r.sold) return false;
      if (r.sellerCheckState === 'done' || (r.sellerCheckTries || 0) >= 2) return false;
      var interesting = (r.discountPct || 0) >= Math.max(8, settings.minDiscount - 8) || (r.dropPct || 0) >= 10;
      return interesting;
    }).sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).slice(0, limit);
  });
}

function fbTab() {
  return api.tabs.query({ url: '*://*.facebook.com/*' }).then(function (tabs) {
    return tabs && tabs.length ? tabs[0] : null;
  });
}

function runEnrichment() {
  if (settings.paused || settings.sellerGate === 'off') return;
  return fbTab().then(function (tab) {
    if (!tab) return;
    return enrichCandidates(settings.enrichPerRun).then(function (cands) {
      cands.forEach(function (c, i) {
        setTimeout(function () {
          c.sellerCheckTries = (c.sellerCheckTries || 0) + 1;
          c.sellerCheckState = 'pending';
          DB.put('listings', c);
          api.tabs.sendMessage(tab.id, { kind: 'enrich', payload: { id: c.id, sellerId: c.sellerId } })
            .catch(function () { });
        }, i * settings.enrichIntervalSec * 1000 + Math.random() * 2500);
      });
    });
  });
}

function onEnriched(p) {
  if (!p || !p.id) return Promise.resolve();
  return DB.get('listings', p.id).then(function (r) {
    if (!r) return;
    if (p.ok && p.sellerJoinYear) {
      r.sellerJoinYear = p.sellerJoinYear;
      r.sellerCheckState = 'done';
      if (r.sellerId) DB.put('sellers', { id: r.sellerId, joinYear: p.sellerJoinYear, at: Date.now() });
    } else {
      r.sellerCheckState = p.ok ? 'unknown' : 'failed';
    }
    if (p.sold) r.sold = true;
    return DB.put('listings', r).then(function () {
      return rescoreBucket(r.bucket, Math.floor(Date.now() / 1000));
    });
  });
}

/* ---------------- messages ---------------- */

api.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || !msg.kind) return;
  switch (msg.kind) {
    case 'listings':
      return ingest(msg.payload.listings)
        .then(function (scores) { return { scores: scores }; })
        .catch(function (e) { drlog('INGEST FAILED', e); return { scores: [], error: String(e) }; });
    case 'getScores':
      return Promise.all((msg.payload.ids || []).map(function (id) { return DB.get('listings', id); }))
        .then(function (rows) { return { scores: rows.filter(Boolean).map(slim) }; });
    case 'enriched':
      return onEnriched(msg.payload).then(function () { return { ok: true }; });
    case 'tokens':
    case 'ready':
      return Promise.resolve({ ok: true });
    case 'getTop':
      return getTop(msg.payload || {}).then(function (rows) { return { rows: rows }; });
    case 'getSettings':
      return Promise.resolve({ settings: settings });
    case 'setSettings':
      return saveSettings(msg.payload).then(function (s) {
        return rescoreAll().then(function () { return { settings: s }; });
      });
    case 'getStats':
      return Promise.all([DB.count('listings'), DB.count('sellers')]).then(function (c) {
        return { listings: c[0], sellers: c[1] };
      });
    case 'clearAll':
      return DB.clearAll().then(function () { notified.clear(); return { ok: true }; });
    case 'exportAll':
      return DB.getAll('listings', 'lastSeen', null, 20000).then(function (rows) { return { rows: rows }; });
    case 'forceEnrich':
      return Promise.resolve(runEnrichment()).then(function () { return { ok: true }; });
  }
});

function getTop(opts) {
  var cutoff = Date.now() - (opts.days || 14) * 86400000;
  return DB.getAll('listings', 'lastSeen', IDBKeyRange.lowerBound(cutoff), 6000).then(function (rows) {
    var out = rows.filter(function (r) {
      if (r.sold) return false;
      if (opts.onlyEligible !== false && !r.eligible) return false;
      if (opts.minScore && (r.score || 0) < opts.minScore) return false;
      if (opts.q) {
        var q = opts.q.toLowerCase();
        if (String(r.title || '').toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });
    out.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return out.slice(0, opts.limit || 60);
  });
}

function rescoreAll() {
  var cutoff = Date.now() - settings.keepDays * 86400000;
  return DB.getAll('listings', 'lastSeen', IDBKeyRange.lowerBound(cutoff), 8000).then(function (rows) {
    var buckets = {};
    rows.forEach(function (r) { buckets[r.bucket] = true; });
    var now = Math.floor(Date.now() / 1000);
    var keys = Object.keys(buckets);
    return keys.reduce(function (p, b) {
      return p.then(function () { return rescoreBucket(b, now); });
    }, Promise.resolve());
  });
}

/* ---------------- schedule ---------------- */

api.alarms.create('dr-enrich', { periodInMinutes: 1 });
api.alarms.create('dr-maintain', { periodInMinutes: 180 });
api.alarms.onAlarm.addListener(function (a) {
  if (a.name === 'dr-enrich') runEnrichment();
  if (a.name === 'dr-maintain') {
    DB.purgeOlderThan(Date.now() - settings.keepDays * 86400000);
    notified.clear();
    rescoreAll();
  }
});

loadSettings();
