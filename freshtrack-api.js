/* FreshTrack local backend - replaces Google Sheets / Apps Script.
   Implements google.script.run entirely in the browser (localStorage).
   All the original function names and return shapes are kept, so the pages are unchanged. */
(function () {
  var K = { items: 'ft_items', pickers: 'ft_pickers', logs: 'ft_logs', theme: 'FRESHTRACK_THEME_JSON' };

  function load(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function s(v) { return String(v === undefined || v === null ? '' : v).trim(); }

  // ---------- first-run seed ----------
  if (!localStorage.getItem(K.pickers)) save(K.pickers, []);
  // The Matrix and Admin screens are unlocked by pickers named "Matrix" and "Admin".
  // Make sure both always exist (default PIN 0000 - change it in the Data Manager).
  (function () {
    var p = load(K.pickers, []), ch = false;
    ['Matrix', 'Admin'].forEach(function (n) {
      if (!p.some(function (x) { return String(x.name).trim().toUpperCase() === n.toUpperCase(); })) { p.push({ name: n, pin: '0000', phone: '' }); ch = true; }
    });
    if (ch) save(K.pickers, p);
  })();
  if (!localStorage.getItem(K.items)) save(K.items, [
    { barcode: '5202178009006', sku: '866314', description: 'OLYMPOS COTTAGE CHEESE 4% 180 g', imageUrl: '', location: '3' },
    { barcode: '5202178040177', sku: '829408', description: 'OLYMPOS KEFIR 1% 500 ml', imageUrl: '', location: '3' },
    { barcode: '5290021000775', sku: '107205', description: 'SNACK STREAKY BACON 150 g', imageUrl: '', location: '2' },
    { barcode: '4000339435425', sku: '735540', description: 'PHILADELPHIA LIGHT 200 g', imageUrl: '', location: '2' }
  ]);
  if (!localStorage.getItem(K.logs)) save(K.logs, []);

  // ---------- backend functions (ported from Code.gs) ----------
  var api = {
    getFreshtrackTheme: function () { return localStorage.getItem(K.theme) || null; },
    saveFreshtrackTheme: function (json) {
      try { JSON.parse(json); localStorage.setItem(K.theme, json); return { success: true }; }
      catch (e) { return { success: false, error: String(e) }; }
    },
    getInitialData: function () {
      return {
        success: true,
        items: load(K.items, []),
        recipients: load(K.pickers, []).map(function (p) { return { name: p.name, phone: p.phone || '' }; }),
        logs: load(K.logs, [])
      };
    },
    getDashboardData: function () {
      var d = api.getInitialData();
      return { success: true, items: d.items, recipients: d.recipients, logs: d.logs, generatedAt: new Date().toISOString() };
    },
    verifyOperatorPassword: function (name, pass) {
      var n = s(name).toUpperCase(), p = s(pass);
      return { verified: load(K.pickers, []).some(function (x) { return s(x.name).toUpperCase() === n && s(x.pin) === p; }) };
    },
    submitNewProduct: function (itemCode, barcode, description) {
      var items = load(K.items, []), b = s(barcode);
      if (items.some(function (i) { return i.barcode === b; })) throw new Error("Barcode '" + barcode + "' already exists in the database.");
      items.push({ barcode: b, sku: s(itemCode), description: s(description), imageUrl: '', location: '' });
      save(K.items, items);
      return 'Product saved successfully at row ' + (items.length + 1) + '!';
    },
    dispatchOrderList: function (recipientName, queue) {
      var merged = [], idx = {};
      (queue || []).forEach(function (it) {
        var key = s(it.barcode) + '|' + s(it.unit).toLowerCase();
        if (idx.hasOwnProperty(key)) { var e = merged[idx[key]]; e.qty = (parseFloat(e.qty) || 0) + (parseFloat(it.qty) || 0); }
        else { idx[key] = merged.length; merged.push(Object.assign({}, it)); }
      });
      merged.sort(function (a, b) {
        var A = s(a.location), B = s(b.location);
        if (!A && !B) return 0; if (!A) return 1; if (!B) return -1;
        return A.localeCompare(B, undefined, { numeric: true, sensitivity: 'base' });
      });
      var logs = load(K.logs, []), id;
      do { id = 'FT-' + Math.floor(10000 + Math.random() * 90000); } while (logs.some(function (l) { return l.orderId === id; }));
      logs.push({ orderId: id, timestamp: stamp(), picker: recipientName, status: 'Pending', minutesTaken: '',
                  rawItemsJson: JSON.stringify(merged), collaborators: '', startedAt: '' });
      save(K.logs, logs);
      return { success: true, orderId: id };
    },
    _order: function (logs, id) { for (var i = 0; i < logs.length; i++) if (s(logs[i].orderId) === s(id)) return logs[i]; return null; },
    updateOrderProgress: function (id, json) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found' };
      o.rawItemsJson = json; save(K.logs, logs); return { success: true };
    },
    updateSingleItemStatus: function (id, index, newStatus, by) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found' };
      var items; try { items = JSON.parse(o.rawItemsJson); } catch (e) { return { success: false, error: 'Corrupt items JSON for this order' }; }
      if (!items[index]) return { success: false, error: 'Item index out of range' };
      if (items[index].pickerStatus === newStatus) { items[index].pickerStatus = 'Pending'; items[index].pickedBy = ''; }
      else { items[index].pickerStatus = newStatus; items[index].pickedBy = by || ''; }
      o.rawItemsJson = JSON.stringify(items); save(K.logs, logs);
      return { success: true, items: items, rawItemsJson: o.rawItemsJson };
    },
    getOrderSnapshot: function (id) {
      var o = api._order(load(K.logs, []), id);
      return o ? { orderId: o.orderId, picker: o.picker, status: o.status, rawItemsJson: o.rawItemsJson || '[]', collaborators: o.collaborators || '' } : null;
    },
    _finish: function (status, id, mins, json) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found in logs' };
      o.status = status; o.minutesTaken = parseFloat(mins).toFixed(2) + 'm'; o.rawItemsJson = json; save(K.logs, logs);
      return { success: true };
    },
    logCompletedRun: function (id, mins, json) { return api._finish('Completed', id, mins, json); },
    cancelOrderRun: function (id, mins, json) { return api._finish('Cancelled', id, mins, json); },
    markOrderStarted: function (id) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found' };
      o.startedAt = stamp(); save(K.logs, logs); return { success: true };
    },
    _collabs: function (o) { return s(o.collaborators).split(',').map(s).filter(Boolean); },
    inviteCollaborator: function (id, name) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found' };
      var cur = api._collabs(o), n = s(name);
      if (n && cur.indexOf(n) === -1) cur.push(n);
      o.collaborators = cur.join(', '); save(K.logs, logs); return { success: true, collaborators: cur };
    },
    removeCollaborator: function (id, name) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found' };
      var n = s(name).toUpperCase(), cur = api._collabs(o).filter(function (x) { return x.toUpperCase() !== n; });
      o.collaborators = cur.join(', '); save(K.logs, logs); return { success: true, collaborators: cur };
    },
    reassignOrderRun: function (id, name) {
      var logs = load(K.logs, []), o = api._order(logs, id);
      if (!o) return { success: false, error: 'Order ID not found' };
      o.picker = s(name); save(K.logs, logs); return { success: true };
    },
    getScriptUrl: function () { return location.href.split('?')[0]; }
  };

  // ---------- google.script.run emulation ----------
  function call(fn, args) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          if (fn.charAt(0) === '_' || typeof api[fn] !== 'function') throw new Error('Unknown function: ' + fn);
          resolve(api[fn].apply(null, args));
        } catch (e) { reject(e); }
      }, 0);
    });
  }
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (f) { return runner(f, fail); };
      if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
      if (name === 'withUserObject') return function () { return runner(ok, fail); };
      return function () {
        call(name, Array.prototype.slice.call(arguments)).then(
          function (r) { if (ok) ok(r); },
          function (e) { if (fail) fail(e); else console.error(name, e); });
      };
    } });
  }
  window.google = { script: { run: runner(null, null) } };
  window.FreshTrackStore = { K: K, load: load, save: save };
})();
