/* Baratilyo — IndexedDB store (background page only) */
(function (root) {
  'use strict';

  var DB_NAME = 'baratilyo';
  var DB_VERSION = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('listings')) {
          var s = db.createObjectStore('listings', { keyPath: 'id' });
          s.createIndex('bucket', 'bucket', { unique: false });
          s.createIndex('lastSeen', 'lastSeen', { unique: false });
          s.createIndex('score', 'score', { unique: false });
          s.createIndex('sellerCheck', 'sellerCheckState', { unique: false });
        }
        if (!db.objectStoreNames.contains('sellers')) {
          db.createObjectStore('sellers', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('debug')) {
          db.createObjectStore('debug', { keyPath: 'k', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function get(store, key) { return tx(store, 'readonly').then(function (s) { return wrap(s.get(key)); }); }
  function put(store, val) { return tx(store, 'readwrite').then(function (s) { return wrap(s.put(val)); }); }
  function del(store, key) { return tx(store, 'readwrite').then(function (s) { return wrap(s.delete(key)); }); }

  function getAll(store, indexName, range, limit) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var st = db.transaction(store, 'readonly').objectStore(store);
        var src = indexName ? st.index(indexName) : st;
        var req = src.openCursor(range || null, indexName ? 'prev' : 'next');
        req.onsuccess = function () {
          var c = req.result;
          if (!c || (limit && out.length >= limit)) return resolve(out);
          out.push(c.value);
          c.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function byBucket(bucket) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var idx = db.transaction('listings', 'readonly').objectStore('listings').index('bucket');
        var req = idx.openCursor(IDBKeyRange.only(bucket));
        req.onsuccess = function () {
          var c = req.result;
          if (!c) return resolve(out);
          out.push(c.value);
          c.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function bulkPut(store, values) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readwrite');
        var s = t.objectStore(store);
        values.forEach(function (v) { s.put(v); });
        t.oncomplete = function () { resolve(values.length); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function count(store) { return tx(store, 'readonly').then(function (s) { return wrap(s.count()); }); }

  function purgeOlderThan(cutoffMs) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var n = 0;
        var idx = db.transaction('listings', 'readwrite').objectStore('listings').index('lastSeen');
        var req = idx.openCursor(IDBKeyRange.upperBound(cutoffMs));
        req.onsuccess = function () {
          var c = req.result;
          if (!c) return resolve(n);
          c.delete(); n++; c.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clearAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['listings', 'sellers', 'debug'], 'readwrite');
        t.objectStore('listings').clear();
        t.objectStore('sellers').clear();
        t.objectStore('debug').clear();
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  root.DRDB = {
    open: open, get: get, put: put, del: del, getAll: getAll,
    byBucket: byBucket, bulkPut: bulkPut, count: count,
    purgeOlderThan: purgeOlderThan, clearAll: clearAll
  };
})(typeof self !== 'undefined' ? self : this);
