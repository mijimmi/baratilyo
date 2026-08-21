/* Baratilyo — page-world capture layer.
   Runs in MAIN world at document_start so it patches fetch/XHR before
   Facebook's bundles grab a reference. Reads listing JSON out of the
   GraphQL traffic your own browsing already generates. Read-only. */
(function () {
  'use strict';
  if (window.__DR_HOOKED__) return;
  window.__DR_HOOKED__ = true;

  var TAG = 'DR_HOOK';
  var DEBUG = true;
  var diag = { world: 'unknown', gql: 0, gqlMarketplaceish: 0, parsed: 0, listings: 0, lastSample: null, lastKeys: null };
  window.__DR_DIAG = diag;
  function log() {
    if (!DEBUG) return;
    var a = Array.prototype.slice.call(arguments);
    a.unshift('%c[Baratilyo]', 'color:#22c55e;font-weight:700');
    console.log.apply(console, a);
  }
  var MAX_NODES = 250000;
  var tokens = { fb_dtsg: null, lsd: null, docIds: {} };

  function send(kind, payload) {
    try {
      window.postMessage({ __dr: true, dir: 'page->cs', kind: kind, payload: payload }, window.location.origin);
    } catch (e) { /* ignore */ }
  }

  /* ---------- listing extraction (path-independent) ---------- */

  function num(v) {
    if (v === null || v === undefined) return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  }

  function priceOf(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.amount !== undefined && p.amount !== null) return num(p.amount);
    if (p.amount_with_offset !== undefined && p.amount_with_offset !== null) {
      var n = num(p.amount_with_offset);
      var off = num(p.offset) || 100;
      return n === null ? null : n / off;
    }
    if (p.formatted_amount) return num(p.formatted_amount);
    return null;
  }

  function looksLikeListing(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    var id = o.id || o.listing_id;
    if (!id || (typeof id !== 'string' && typeof id !== 'number')) return false;
    if (!/^\d{6,}$/.test(String(id))) return false;
    var price = o.listing_price || o.price;
    if (priceOf(price) === null) return false;
    var title = o.marketplace_listing_title || o.custom_title || o.title;
    return !!title;
  }

  function photoOf(o) {
    try {
      if (o.primary_listing_photo && o.primary_listing_photo.image) return o.primary_listing_photo.image.uri;
      if (o.listing_photos && o.listing_photos[0] && o.listing_photos[0].image) return o.listing_photos[0].image.uri;
      if (o.primary_photo && o.primary_photo.image) return o.primary_photo.image.uri;
    } catch (e) { }
    return null;
  }

  function locationOf(o) {
    try {
      var rg = o.location && o.location.reverse_geocode;
      if (rg) return rg.city_page && rg.city_page.display_name ? rg.city_page.display_name
        : [rg.city, rg.state].filter(Boolean).join(', ');
      if (o.location_text && o.location_text.text) return o.location_text.text;
    } catch (e) { }
    return null;
  }

  function sellerOf(o) {
    var s = o.marketplace_listing_seller || o.seller || o.story_seller;
    if (!s || typeof s !== 'object') return {};
    var join = s.join_time || s.profile_join_time || null;
    return {
      sellerId: s.id ? String(s.id) : null,
      sellerName: s.name || null,
      sellerJoinYear: join ? new Date(num(join) * 1000).getFullYear() : null
    };
  }

  function toListing(o) {
    var seller = sellerOf(o);
    var price = priceOf(o.listing_price || o.price);
    var strike = priceOf(o.strikethrough_price);
    return {
      id: String(o.id || o.listing_id),
      title: String(o.marketplace_listing_title || o.custom_title || o.title),
      price: price,
      currency: (o.listing_price && o.listing_price.currency) || (o.price && o.price.currency) || null,
      strikethroughPrice: strike,
      createdAt: num(o.creation_time) || null,
      location: locationOf(o),
      photo: photoOf(o),
      sold: !!(o.is_sold || o.is_pending),
      categoryHint: (o.marketplace_listing_category_id && String(o.marketplace_listing_category_id))
        || (o.marketplace_listing_category && o.marketplace_listing_category.name) || null,
      sellerId: seller.sellerId,
      sellerName: seller.sellerName,
      sellerJoinYear: seller.sellerJoinYear,
      url: 'https://www.facebook.com/marketplace/item/' + String(o.id || o.listing_id) + '/'
    };
  }

  function collect(root) {
    var found = {};
    var stack = [{ v: root, d: 0 }];
    var nodes = 0;
    while (stack.length) {
      var cur = stack.pop();
      var v = cur.v;
      if (!v || typeof v !== 'object' || cur.d > 24) continue;
      if (++nodes > MAX_NODES) break;
      if (looksLikeListing(v)) {
        var l = toListing(v);
        if (l.price !== null && !found[l.id]) found[l.id] = l;
      }
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) stack.push({ v: v[i], d: cur.d + 1 });
      } else {
        for (var k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) {
            var child = v[k];
            if (child && typeof child === 'object') stack.push({ v: child, d: cur.d + 1 });
          }
        }
      }
    }
    var out = [];
    for (var id in found) out.push(found[id]);
    return out;
  }

  /* FB streams several JSON docs in one response body, newline separated */
  function parseChunks(text) {
    var docs = [];
    if (!text) return docs;
    var t = text.indexOf('for (;;);') === 0 ? text.slice(9) : text;
    var lines = t.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) !== '{') continue;
      try { docs.push(JSON.parse(line)); } catch (e) { }
    }
    if (!docs.length) { try { docs.push(JSON.parse(t)); } catch (e) { } }
    return docs;
  }

  function handleBody(url, text) {
    if (!text || text.length < 40) return;
    diag.gql++;
    var marketplaceish = text.indexOf('marketplace_listing_title') !== -1
      || text.indexOf('listing_price') !== -1
      || text.indexOf('marketplace_listing') !== -1;
    if (marketplaceish) diag.gqlMarketplaceish++;

    var docs = parseChunks(text);
    if (!docs.length) {
      if (marketplaceish) log('response looked like marketplace data but would not parse as JSON', url);
      return;
    }
    diag.parsed++;

    var all = [];
    for (var i = 0; i < docs.length; i++) {
      var got = collect(docs[i]);
      if (got.length) all = all.concat(got);
    }

    if (all.length) {
      diag.listings += all.length;
      log('+' + all.length + ' listings (total ' + diag.listings + ')', all[0].title, all[0].price);
      send('listings', { url: url, listings: all, at: Date.now() });
    } else if (marketplaceish) {
      /* the payload smells like listings but nothing matched -> capture a sample
         so the shape can be compared against looksLikeListing() */
      diag.lastSample = text.slice(0, 30000);
      try { diag.lastKeys = Object.keys(docs[0] && docs[0].data ? docs[0].data : docs[0]).slice(0, 25); } catch (e) { }
      log('EXTRACTOR MISS — marketplace-shaped response, 0 listings pulled out.',
        '\ntop-level keys:', diag.lastKeys,
        '\nrun copy(__DR_DIAG.lastSample) to grab the payload');
    }
  }

  function captureTokens(body) {
    if (typeof body !== 'string') return;
    if (!tokens.fb_dtsg) {
      var m = /fb_dtsg=([^&]+)/.exec(body);
      if (m) { tokens.fb_dtsg = decodeURIComponent(m[1]); send('tokens', { fb_dtsg: tokens.fb_dtsg }); }
    }
    if (!tokens.lsd) {
      var l = /lsd=([^&]+)/.exec(body);
      if (l) tokens.lsd = decodeURIComponent(l[1]);
    }
    var fn = /fb_api_req_friendly_name=([^&]+)/.exec(body);
    var did = /doc_id=([^&]+)/.exec(body);
    if (fn && did) tokens.docIds[decodeURIComponent(fn[1])] = did[1];
  }

  function isInteresting(url) {
    return typeof url === 'string' && (url.indexOf('/api/graphql') !== -1 || url.indexOf('/graphql') !== -1);
  }

  /* ---------- fetch patch ---------- */
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    try { if (init && typeof init.body === 'string') captureTokens(init.body); } catch (e) { }
    var p = origFetch.apply(this, arguments);
    if (isInteresting(url)) {
      p.then(function (res) {
        try {
          res.clone().text().then(function (t) { handleBody(url, t); }).catch(function () { });
        } catch (e) { }
        return res;
      }).catch(function () { });
    }
    return p;
  };

  /* ---------- XHR patch ---------- */
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dr_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    try { captureTokens(body); } catch (e) { }
    if (isInteresting(this.__dr_url)) {
      this.addEventListener('load', function () {
        try {
          if (self.responseType === '' || self.responseType === 'text') handleBody(self.__dr_url, self.responseText);
        } catch (e) { }
      });
    }
    return origSend.apply(this, arguments);
  };

  /* ---------- initial server-rendered payload ---------- */
  function scanInlineJSON() {
    try {
      var scripts = document.querySelectorAll('script[type="application/json"]');
      for (var i = 0; i < scripts.length && i < 60; i++) {
        var txt = scripts[i].textContent;
        if (!txt || txt.length < 200) continue;
        if (txt.indexOf('marketplace_listing_title') === -1 && txt.indexOf('listing_price') === -1) continue;
        handleBody('inline:script', txt);
      }
    } catch (e) { }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(scanInlineJSON, 800); });
  } else {
    setTimeout(scanInlineJSON, 800);
  }

  /* ---------- seller-age enrichment, run from the page so cookies/headers are natural ---------- */
  function extractJoinYear(html, sellerId) {
    var m = /Joined Facebook in (\d{4})/.exec(html);
    if (m) return parseInt(m[1], 10);
    m = /"join_time"\s*:\s*(\d{9,12})/.exec(html);
    if (m) {
      var ts = parseInt(m[1], 10);
      if (ts > 1e11) ts = Math.floor(ts / 1000);
      return new Date(ts * 1000).getFullYear();
    }
    m = /Joined in (\d{4})/.exec(html);
    if (m) return parseInt(m[1], 10);
    if (sellerId) {
      var re = new RegExp('"id"\\s*:\\s*"' + sellerId + '"[\\s\\S]{0,600}?"join_time"\\s*:\\s*(\\d{9,12})');
      m = re.exec(html);
      if (m) return new Date(parseInt(m[1], 10) * 1000).getFullYear();
    }
    return null;
  }

  function enrich(job) {
    var url = 'https://www.facebook.com/marketplace/item/' + job.id + '/';
    origFetch.call(window, url, { credentials: 'include', headers: { 'accept': 'text/html' } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var year = extractJoinYear(html, job.sellerId);
        var sold = /"is_sold"\s*:\s*true/.test(html);
        send('enriched', { id: job.id, sellerJoinYear: year, sold: sold, ok: true });
        /* the detail page also carries the full listing object — harvest it */
        handleBody('detail:' + job.id, html.slice(0, 4000000));
      })
      .catch(function (e) {
        send('enriched', { id: job.id, ok: false, error: String(e) });
      });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || !d.__dr || d.dir !== 'cs->page') return;
    if (d.kind === 'enrich') enrich(d.payload);
  });

  /* Are we actually in the page world? If the manifest's world:"MAIN" was
     ignored, our patched fetch is the isolated one and captures nothing. */
  try {
    diag.world = (typeof wrappedJSObject === 'undefined' && window.location && !window.browser) ? 'page(likely)' : 'page';
  } catch (e) { diag.world = 'page'; }

  log('hook installed on', location.pathname, '— type __DR_DIAG in this console any time');
  setInterval(function () {
    if (!DEBUG) return;
    log('diag:', 'graphql seen ' + diag.gql, '| marketplace-shaped ' + diag.gqlMarketplaceish,
      '| listings pulled ' + diag.listings);
  }, 15000);

  send('ready', { url: location.href });
})();
