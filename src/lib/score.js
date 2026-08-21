/* Baratilyo — comps + scoring engine (no DOM deps, unit-testable in node) */
(function (root) {
  'use strict';

  var STOP = new Set(('for sale and or the a an with in on of to my new used like good great condition '
    + 'brand box complete set free delivery pickup only negotiable nego rush sale price barely excellent '
    + 'original legit slightly repriced onhand on hand ready stock available php peso pesos').split(' '));

  var BRANDS = ('apple macbook iphone ipad airpods samsung galaxy sony lg asus rog zephyrus acer predator '
    + 'lenovo thinkpad legion dell alienware xps hp omen victus msi razer logitech keychron corsair '
    + 'steelseries hyperx bose jbl anker nintendo switch playstation ps4 ps5 xbox gopro canon nikon fujifilm '
    + 'dji xiaomi redmi poco realme oppo vivo huawei honor google pixel oneplus nothing intel amd ryzen '
    + 'nvidia rtx gtx gigabyte evga seagate sandisk crucial kingston wd viewsonic benq aoc').split(' ');
  var BRANDSET = new Set(BRANDS);

  function normalizeTitle(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/[‘’“”]/g, '')
      .replace(/[^a-z0-9+.\- ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(t) {
    return normalizeTitle(t).split(' ').filter(function (w) {
      return w.length > 1 && !STOP.has(w);
    });
  }

  /* A token is "model-ish" if it carries digits (m2, 5800x, 3070, 256gb, 15.6) */
  function isModelToken(w) { return /\d/.test(w); }

  /* Bucket = the comparison group a listing is priced against.
     Electronics get brand|model|capacity, everything else falls back to
     the three most informative tokens, sorted for stability. */
  function bucketKey(title, categoryHint) {
    var toks = tokenize(title);
    if (!toks.length) return 'misc|' + (categoryHint || 'unknown');
    var brand = null;
    for (var i = 0; i < toks.length; i++) {
      if (BRANDSET.has(toks[i])) { brand = toks[i]; break; }
    }
    var models = toks.filter(isModelToken);
    var cap = null;
    for (var j = 0; j < toks.length; j++) {
      if (/^\d+(gb|tb|mb)$/.test(toks[j])) { cap = toks[j]; break; }
    }
    if (brand) {
      var model = null;
      for (var k = 0; k < models.length; k++) {
        if (models[k] !== cap) { model = models[k]; break; }
      }
      return [brand, model || 'x', cap || 'x'].join('|');
    }
    var informative = toks.filter(function (w) { return !/^\d+$/.test(w); }).slice(0, 3).sort();
    return 'gen|' + informative.join('-') + (categoryHint ? '|' + categoryHint : '');
  }

  function median(nums) {
    if (!nums.length) return null;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* Median absolute deviation — robust to the one $1 troll listing that
     would otherwise blow up a mean/stddev baseline. */
  function mad(nums, med) {
    if (!nums.length) return 0;
    var dev = nums.map(function (n) { return Math.abs(n - med); });
    return median(dev) || 0;
  }

  function cleanComps(prices) {
    var valid = prices.filter(function (p) { return typeof p === 'number' && isFinite(p) && p > 1; });
    if (valid.length < 3) return valid;
    var med = median(valid);
    /* drop absurd outliers (10x either side) before computing the baseline */
    return valid.filter(function (p) { return p <= med * 10 && p >= med / 10; });
  }

  function stats(prices) {
    var c = cleanComps(prices);
    if (!c.length) return null;
    var med = median(c);
    return { n: c.length, median: med, mad: mad(c, med), min: Math.min.apply(null, c), max: Math.max.apply(null, c) };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var HOUR = 3600;

  /* listing: {price, createdAt(sec), priceHistory:[{t,price}], sellerJoinYear}
     st: output of stats() for its bucket (comps EXCLUDING this listing)
     settings: user thresholds */
  function scoreListing(listing, st, settings, nowSec) {
    var now = nowSec || Math.floor(Date.now() / 1000);
    var s = settings || {};
    var minComps = s.minComps || 6;
    var out = {
      score: 0, discountPct: 0, robustZ: null, comps: st ? st.n : 0,
      baseline: st ? st.median : null, dropPct: 0, ageHours: null,
      sellerOk: null, reasons: [], eligible: false
    };

    if (typeof listing.price !== 'number' || !isFinite(listing.price) || listing.price <= 0) return out;

    if (listing.createdAt) out.ageHours = Math.max(0, (now - listing.createdAt) / HOUR);

    /* price drop vs the first price we ever saw for this exact listing */
    var hist = listing.priceHistory || [];
    if (hist.length > 1) {
      var first = hist[0].price;
      if (first > listing.price) {
        out.dropPct = ((first - listing.price) / first) * 100;
      }
    }
    if (listing.strikethroughPrice && listing.strikethroughPrice > listing.price) {
      out.dropPct = Math.max(out.dropPct, ((listing.strikethroughPrice - listing.price) / listing.strikethroughPrice) * 100);
    }

    if (st && st.n >= minComps && st.median > 0) {
      out.discountPct = ((st.median - listing.price) / st.median) * 100;
      if (st.mad > 0) out.robustZ = 0.6745 * (listing.price - st.median) / st.mad;
    }

    var maxYear = s.maxSellerJoinYear || 2021;
    if (listing.sellerJoinYear) out.sellerOk = listing.sellerJoinYear <= maxYear;

    /* --- score components --- */
    var base = clamp(out.discountPct, 0, 50) / 50 * 75;
    var conf = st ? clamp(st.n / 20, 0, 1) * 9 : 0;
    var fresh = 0;
    if (out.ageHours !== null) {
      if (out.ageHours <= 6) fresh = 10;
      else if (out.ageHours <= 24) fresh = 6;
      else if (out.ageHours <= 72) fresh = 2;
    }
    var drop = clamp(out.dropPct, 0, 30) / 30 * 12;
    var seller = 0;
    if (out.sellerOk === true) seller = 6;
    else if (out.sellerOk === false) seller = s.sellerGate === 'off' ? 0 : -10;

    out.score = Math.round(clamp(base + conf + fresh + drop + seller, 0, 100));

    if (out.discountPct >= (s.minDiscount || 20)) {
      out.reasons.push(Math.round(out.discountPct) + '% below median of ' + out.comps + ' comps');
    }
    if (out.dropPct >= 5) out.reasons.push('price dropped ' + Math.round(out.dropPct) + '%');
    if (fresh >= 6) out.reasons.push('posted ' + (out.ageHours <= 1 ? 'minutes ago' : Math.round(out.ageHours) + 'h ago'));
    if (out.sellerOk === true) out.reasons.push('seller since ' + listing.sellerJoinYear);
    if (out.sellerOk === false) out.reasons.push('NEW seller account (' + listing.sellerJoinYear + ')');
    if (out.sellerOk === null) out.reasons.push('seller age unknown');

    /* eligibility = what shows up in the deals list / triggers a notification */
    var passPrice = out.discountPct >= (s.minDiscount || 20) || out.dropPct >= 15;
    var passComps = !!st && st.n >= minComps;
    var passSeller = true;
    if (s.sellerGate === 'require') passSeller = out.sellerOk === true;
    else if (s.sellerGate === 'flag') passSeller = out.sellerOk !== false;
    out.eligible = passPrice && passComps && passSeller && !listing.sold;
    return out;
  }

  var api = {
    normalizeTitle: normalizeTitle, tokenize: tokenize, bucketKey: bucketKey,
    median: median, mad: mad, stats: stats, scoreListing: scoreListing, BRANDS: BRANDS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DRScore = api;
})(typeof self !== 'undefined' ? self : this);
