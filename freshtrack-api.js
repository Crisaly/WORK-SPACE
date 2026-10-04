/* FreshTrack cloud backend: shared database on Firebase Realtime Database (REST, no SDK).
   Same google.script.run function names as before, so the pages are unchanged.
   Every device reads/writes the same data: orders, products, pickers, theme. */
(function () {
  var CFG = window.FRESHTRACK_CONFIG || {};
  var DB = String(CFG.databaseUrl || '').replace(/\/+$/, '');
  var SECRET = String(CFG.secretPath || '');
  var ROOT = (!SECRET || SECRET.indexOf('PASTE_') === 0) ? 'ft' : SECRET.replace(/[^A-Za-z0-9_-]/g, '');
  var configured = /^https:\/\//.test(DB) && DB.indexOf('PASTE_') < 0;

  function s(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function key(v) { return s(v).replace(/[.$#\[\]\/]/g, '_'); }
  function pkey(name) { return key(s(name).toUpperCase()); }

  // ---------- small status banner ----------
  var bar;
  function notify(msg, sticky) {
    function show() {
      if (!bar) {
        bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#7f1d1d;color:#fff;padding:12px 14px;border-radius:12px;font:600 13px system-ui;box-shadow:0 8px 30px #0008;display:none';
        document.body.appendChild(bar);
      }
      bar.textContent = msg; bar.style.display = 'block';
      clearTimeout(bar._t); if (!sticky) bar._t = setTimeout(function () { bar.style.display = 'none'; }, 5000);
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
  // ---------- cloud status badge (bottom-left) ----------
  var badge, VERSION = 'cloud v5';
  function setStatus(ok, msg) {
    function show() {
      if (!badge) {
        badge = document.createElement('div');
        badge.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99998;font:700 11px system-ui;padding:4px 8px;border-radius:999px;color:#fff;opacity:.85';
        badge.onclick = function () { fbRaw('GET', 'theme').then(function () { }, function () { }); };
        document.body.appendChild(badge);
      }
      badge.style.background = ok ? '#047857' : '#b91c1c';
      badge.textContent = ok ? '\u2601 ' + VERSION + ' online' : '\u2601 ' + VERSION + ' ERROR: ' + (msg || '');
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
  if (!configured) setStatus(false, 'config.js not set');
  if (!configured) notify('Cloud database is not set up yet. Edit config.js (see README).', true);

  // ---------- Firebase REST helpers ----------
  function url(path) {
    return DB + '/' + ROOT + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '') + '.json';
  }
  function fbRaw(method, path, body, headers) {
    if (!configured) return Promise.reject(new Error('Cloud database is not set up. Edit config.js'));
    var o = { method: method };
    if (body !== undefined) o.body = JSON.stringify(body);
    if (headers) o.headers = headers;
    return fetch(url(path), o).then(function (r) {
      if (r.status === 412) { var e = new Error('conflict'); e.conflict = true; throw e; }
      if (!r.ok) { var m = 'Database error ' + r.status + (r.status === 401 || r.status === 403 ? ' - rules/secret do not match' : ''); setStatus(false, m); throw new Error(m); }
      setStatus(true);
      var etag = r.headers.get('ETag');
      return r.text().then(function (t) { return { data: t ? JSON.parse(t) : null, etag: etag }; });
    }, function (err) { if (err && err.conflict) throw err; if (err && /^Database error/.test(err.message)) throw err; setStatus(false, 'no connection'); throw new Error('No connection to the database. Check the internet / databaseUrl.'); });
  }
  function get(path) { return fbRaw('GET', path).then(function (r) { return r.data; }); }
  function put(path, v) { return fbRaw('PUT', path, v); }
  function patch(path, v) { return fbRaw('PATCH', path, v); }
  function del(path) { return fbRaw('DELETE', path); }

  // atomic read-modify-write; fn(current) returns {value, result} or null to abort
  function txn(path, fn) {
    var tries = 0;
    function attempt() {
      return fbRaw('GET', path, undefined, { 'X-Firebase-ETag': 'true' }).then(function (g) {
        var res = fn(g.data);
        if (!res) return { aborted: true };
        return fbRaw('PUT', path, res.value, g.etag ? { 'if-match': g.etag } : undefined).then(
          function () { return { value: res.value, result: res.result }; },
          function (e) { if (e.conflict && ++tries < 8) return attempt(); if (e.conflict) throw new Error('Server busy, please retry.'); throw e; });
      });
    }
    return attempt();
  }

  // ---------- PIN hashing ----------
  function hashPin(name, pin) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('Secure connection (https) required.'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('ft|' + s(name).toUpperCase() + '|' + s(pin)))
      .then(function (b) { return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); });
  }

  // ---------- catalog cache ----------
  var itemsCache = null;
  function getItems(force) {
    if (!force && itemsCache && Date.now() - itemsCache.t < 30000) return Promise.resolve(itemsCache.list);
    return get('items').then(function (o) {
      var list = Object.keys(o || {}).map(function (k) { var i = o[k]; return { barcode: s(i.barcode), sku: s(i.sku), description: s(i.description), imageUrl: s(i.imageUrl), location: s(i.location) }; });
      itemsCache = { t: Date.now(), list: list };
      return list;
    });
  }
  function dropItemsCache() { itemsCache = null; }

  // fill missing image/location on order items from the catalog
  function enrich(json) {
    var arr; try { arr = JSON.parse(json); } catch (e) { return Promise.resolve(json); }
    if (!arr.some(function (it) { return !s(it.imageUrl) || !s(it.location); })) return Promise.resolve(json);
    return getItems().then(function (list) {
      var cat = {}; list.forEach(function (i) { cat[i.barcode] = i; });
      arr.forEach(function (it) {
        var c = cat[s(it.barcode)]; if (!c) return;
        if (!s(it.imageUrl) && c.imageUrl) it.imageUrl = c.imageUrl;
        if (!s(it.location) && c.location) it.location = c.location;
      });
      return JSON.stringify(arr);
    }, function () { return json; });
  }

  // ---------- default Matrix / Admin pickers ----------
  var defaultsP = null;
  function ensureDefaults() {
    if (!defaultsP) {
      defaultsP = get('pickers').then(function (p) {
        p = p || {};
        return ['Matrix', 'Admin'].reduce(function (chain, n) {
          return chain.then(function () {
            if (p[pkey(n)]) return;
            return hashPin(n, '0000').then(function (h) { return put('pickers/' + pkey(n), { name: n, pinHash: h, phone: '' }); });
          });
        }, Promise.resolve());
      }).catch(function (e) { defaultsP = null; throw e; });
    }
    return defaultsP;
  }

  function normLog(l) {
    return { orderId: s(l.orderId), timestamp: s(l.timestamp), picker: s(l.picker), status: s(l.status), minutesTaken: s(l.minutesTaken),
             rawItemsJson: l.rawItemsJson || '[]', collaborators: s(l.collaborators), startedAt: s(l.startedAt), seq: l.seq || 0 };
  }
  function orderExists(id) { return get('logs/' + key(id) + '/orderId').then(function (v) { return !!v; }); }
  function notFound() { return { success: false, error: 'Order ID not found' }; }
  function fail(e) { var m = String(e && e.message ? e.message : e); notify(m); return { success: false, error: m }; }

  // ---------- backend functions (same names as the original Code.gs) ----------
  var api = {
    getFreshtrackTheme: function () { return get('theme').then(function (v) { return v || null; }, function () { return null; }); },
    saveFreshtrackTheme: function (json) {
      try { JSON.parse(json); } catch (e) { return Promise.resolve({ success: false, error: String(e) }); }
      return put('theme', json).then(function () { return { success: true }; }, fail);
    },
    getInitialData: function () {
      return ensureDefaults().then(function () {
        return Promise.all([getItems(true), get('pickers'), get('logs')]);
      }).then(function (r) {
        var logs = Object.keys(r[2] || {}).filter(function (k) { return r[2][k]; }).map(function (k) { return normLog(r[2][k]); }).sort(function (a, b) { return a.seq - b.seq; });
        return Promise.all(logs.map(function (l) { return enrich(l.rawItemsJson).then(function (j) { l.rawItemsJson = j; return l; }); })).then(function (logs2) {
          var rec = Object.keys(r[1] || {}).map(function (k) { return { name: s(r[1][k].name), phone: s(r[1][k].phone) }; });
          return { success: true, items: r[0], recipients: rec, logs: logs2 };
        });
      }).catch(fail);
    },
    getDashboardData: function () {
      return api.getInitialData().then(function (d) {
        if (!d.success) return d;
        return { success: true, items: d.items, recipients: d.recipients, logs: d.logs, generatedAt: new Date().toISOString() };
      });
    },
    verifyOperatorPassword: function (name, pass) {
      return ensureDefaults().then(function () { return Promise.all([get('pickers/' + pkey(name) + '/pinHash'), hashPin(name, pass)]); })
        .then(function (r) { return { verified: !!r[0] && r[0] === r[1] }; }, function (e) { return { verified: false, error: String(e.message) }; });
    },
    submitNewProduct: function (itemCode, barcode, description) {
      var b = s(barcode); if (!b) return Promise.reject(new Error('Barcode is required.'));
      return get('items/' + key(b)).then(function (ex) {
        if (ex) throw new Error("Barcode '" + barcode + "' already exists in the database.");
        return put('items/' + key(b), { barcode: b, sku: s(itemCode), description: s(description), imageUrl: '', location: '' });
      }).then(function () { dropItemsCache(); return 'Product saved successfully!'; });
    },
    dispatchOrderList: function (recipientName, queue) {
      var merged = [], idx = {};
      (queue || []).forEach(function (it) {
        var k = s(it.barcode) + '|' + s(it.unit).toLowerCase();
        if (idx.hasOwnProperty(k)) { var e = merged[idx[k]]; e.qty = (parseFloat(e.qty) || 0) + (parseFloat(it.qty) || 0); }
        else { idx[k] = merged.length; merged.push(Object.assign({}, it)); }
      });
      merged.sort(function (a, b) {
        var A = s(a.location), B = s(b.location);
        if (!A && !B) return 0; if (!A) return 1; if (!B) return -1;
        return A.localeCompare(B, undefined, { numeric: true, sensitivity: 'base' });
      });
      function newId(n) {
        var id = 'FT-' + Math.floor(10000 + Math.random() * 90000);
        return orderExists(id).then(function (x) { return x && n < 10 ? newId(n + 1) : id; });
      }
      return newId(0).then(function (id) {
        return put('logs/' + id, { orderId: id, timestamp: stamp(), picker: s(recipientName), status: 'Pending', minutesTaken: '',
          rawItemsJson: JSON.stringify(merged), collaborators: '', startedAt: '', seq: Date.now() })
          .then(function () { return { success: true, orderId: id }; });
      }).catch(fail);
    },
    updateOrderProgress: function (id, json) {
      return orderExists(id).then(function (ok) { if (!ok) return notFound(); return put('logs/' + key(id) + '/rawItemsJson', json).then(function () { return { success: true }; }); }).catch(fail);
    },
    updateSingleItemStatus: function (id, index, newStatus, by) {
      var err = null;
      return txn('logs/' + key(id) + '/rawItemsJson', function (cur) {
        if (cur === null || cur === undefined) { err = 'Order ID not found'; return null; }
        var items; try { items = JSON.parse(cur); } catch (e) { err = 'Corrupt items JSON for this order'; return null; }
        if (!items[index]) { err = 'Item index out of range'; return null; }
        if (items[index].pickerStatus === newStatus) { items[index].pickerStatus = 'Pending'; items[index].pickedBy = ''; }
        else { items[index].pickerStatus = newStatus; items[index].pickedBy = by || ''; }
        return { value: JSON.stringify(items) };
      }).then(function (r) {
        if (r.aborted) return { success: false, error: err || 'Update failed' };
        return enrich(r.value).then(function (j) { return { success: true, items: JSON.parse(j), rawItemsJson: j }; });
      }).catch(fail);
    },
    getOrderSnapshot: function (id) {
      return get('logs/' + key(id)).then(function (o) {
        if (!o) return null;
        return enrich(o.rawItemsJson || '[]').then(function (j) {
          return { orderId: s(o.orderId), picker: s(o.picker), status: s(o.status), rawItemsJson: j, collaborators: s(o.collaborators) };
        });
      }, function () { return null; });
    },
    _finish: function (status, id, mins, json) {
      return orderExists(id).then(function (ok) {
        if (!ok) return { success: false, error: 'Order ID not found in logs' };
        return patch('logs/' + key(id), { status: status, minutesTaken: parseFloat(mins).toFixed(2) + 'm', rawItemsJson: json }).then(function () { return { success: true }; });
      }).catch(fail);
    },
    logCompletedRun: function (id, mins, json) { return api._finish('Completed', id, mins, json); },
    cancelOrderRun: function (id, mins, json) { return api._finish('Cancelled', id, mins, json); },
    markOrderStarted: function (id) {
      return orderExists(id).then(function (ok) { if (!ok) return notFound(); return patch('logs/' + key(id), { startedAt: stamp() }).then(function () { return { success: true }; }); }).catch(fail);
    },
    _collab: function (id, fn) {
      var out;
      return txn('logs/' + key(id) + '/collaborators', function (cur) {
        if (cur === null || cur === undefined) return null;
        var list = s(cur).split(',').map(s).filter(Boolean); list = fn(list); out = list;
        return { value: list.join(', ') };
      }).then(function (r) { return r.aborted ? notFound() : { success: true, collaborators: out }; }).catch(fail);
    },
    inviteCollaborator: function (id, name) {
      return api._collab(id, function (l) { var n = s(name); if (n && l.indexOf(n) === -1) l.push(n); return l; });
    },
    removeCollaborator: function (id, name) {
      var n = s(name).toUpperCase();
      return api._collab(id, function (l) { return l.filter(function (x) { return x.toUpperCase() !== n; }); });
    },
    reassignOrderRun: function (id, name) {
      return orderExists(id).then(function (ok) { if (!ok) return notFound(); return patch('logs/' + key(id), { picker: s(name) }).then(function () { return { success: true }; }); }).catch(fail);
    },
    deleteOrders: function (ids) {
      var o = {}; (ids || []).forEach(function (id) { if (s(id)) o[key(id)] = null; });
      if (!Object.keys(o).length) return Promise.resolve({ success: true, deleted: 0 });
      return patch('logs', o).then(function () { return { success: true, deleted: Object.keys(o).length }; }, fail);
    },
    getScriptUrl: function () { return Promise.resolve(location.href.split('?')[0]); }
  };

  // ---------- google.script.run emulation ----------
  function call(fn, args) {
    return new Promise(function (resolve, reject) {
      if (fn.charAt(0) === '_' || typeof api[fn] !== 'function') return reject(new Error('Unknown function: ' + fn));
      try { Promise.resolve(api[fn].apply(null, args)).then(resolve, reject); } catch (e) { reject(e); }
    });
  }
  function runner(ok, bad) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (f) { return runner(f, bad); };
      if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
      if (name === 'withUserObject') return function () { return runner(ok, bad); };
      return function () {
        call(name, Array.prototype.slice.call(arguments)).then(
          function (r) { if (ok) ok(r); },
          function (e) { notify(e.message); if (bad) bad(e); else console.error(name, e); });
      };
    } });
  }
  window.google = { script: { run: runner(null, null) } };

  // ---------- extra tools used by the Data Manager ----------
  window.FreshTrackCloud = {
    configured: configured,
    hashPin: hashPin,
    listItems: function () { return getItems(true); },
    saveItem: function (rec) { dropItemsCache(); return put('items/' + key(rec.barcode), rec); },
    deleteItem: function (barcode) { dropItemsCache(); return del('items/' + key(barcode)); },
    importItems: function (list, replace) {
      var o = {}; list.forEach(function (r) { if (r.barcode) o[key(r.barcode)] = r; });
      dropItemsCache(); return replace ? put('items', o) : patch('items', o);
    },
    listPickers: function () {
      return ensureDefaults().then(function () { return get('pickers'); }).then(function (o) {
        return Object.keys(o || {}).map(function (k) { return { name: s(o[k].name), phone: s(o[k].phone) }; });
      });
    },
    savePicker: function (name, pin, phone) {
      var k = pkey(name), n = s(name).toUpperCase();
      return get('pickers/' + k).then(function (ex) {
        if (!pin && !ex) throw new Error('A PIN is required for a new picker.');
        return (pin ? hashPin(n, pin) : Promise.resolve(ex.pinHash)).then(function (h) { return put('pickers/' + k, { name: n, pinHash: h, phone: s(phone) }); });
      });
    },
    deletePicker: function (name) { return del('pickers/' + pkey(name)); },
    backup: function () {
      return Promise.all([get('items'), get('pickers'), get('logs'), get('theme')]).then(function (r) { return { version: 2, items: r[0] || {}, pickers: r[1] || {}, logs: r[2] || {}, theme: r[3] || null }; });
    },
    restore: function (d) {
      var steps = [], toObj = function (a, kf) { if (!Array.isArray(a)) return a || {}; var o = {}; a.forEach(function (x) { o[kf(x)] = x; }); return o; };
      var items = toObj(d.items, function (x) { return key(x.barcode); });
      var logs = toObj(d.logs, function (x) { return key(x.orderId); });
      Object.keys(logs).forEach(function (k, i) { if (!logs[k].seq) logs[k].seq = Date.now() + i; });
      var pk = d.pickers || {}; var plist = Array.isArray(pk) ? pk : Object.keys(pk).map(function (k) { return pk[k]; });
      return Promise.all(plist.map(function (p) {
        if (p.pinHash) return Promise.resolve({ name: s(p.name).toUpperCase(), pinHash: p.pinHash, phone: s(p.phone) });
        return hashPin(p.name, p.pin || '0000').then(function (h) { return { name: s(p.name).toUpperCase(), pinHash: h, phone: s(p.phone) }; });
      })).then(function (pl) {
        var po = {}; pl.forEach(function (p) { po[pkey(p.name)] = p; });
        dropItemsCache(); defaultsP = null;
        return Promise.all([put('items', items), put('logs', logs), put('pickers', po), d.theme ? put('theme', d.theme) : Promise.resolve()]);
      });
    },
    clearAll: function () { dropItemsCache(); defaultsP = null; return del(''); },
    listLogs: function () { return get('logs').then(function (o) { return Object.keys(o || {}).filter(function (k) { return o[k]; }).map(function (k) { return normLog(o[k]); }).sort(function (a, b) { return a.seq - b.seq; }); }); },
    // one-time upload of the old on-device (localStorage) data
    migrateLocal: function () {
      function ld(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
      var items = ld('ft_items') || [], pickers = ld('ft_pickers') || [], logs = ld('ft_logs') || [];
      return window.FreshTrackCloud.restore({ items: items, pickers: pickers, logs: logs, theme: localStorage.getItem('FRESHTRACK_THEME_JSON') })
        .then(function () { return { items: items.length, pickers: pickers.length, logs: logs.length }; });
    }
  };
})();
