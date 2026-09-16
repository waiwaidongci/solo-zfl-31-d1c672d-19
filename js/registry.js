/*!
 * registry.js — 离线版权登记册（与算法、页面分离）
 *
 *  - 每个方案登记：作者编号、授权范围、有效期、方案指纹（登记前原图 + 水印后图样两份指纹）。
 *  - 登记数据只存本机（localStorage / 可注入存储），导出/导入为 JSON 文件。
 *  - 登记即写保护：后续对同一方案的核验若不匹配，调用方不得用其覆盖记录
 *    （updateRecord 强制校验指纹，不匹配直接拒绝）。
 *  - 支持多方案登记、按作者/编号检索、批量核验，无 DOM 依赖，可在 Node 测试。
 *
 * UMD：浏览器 window.Registry；Node require('./js/registry.js')。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      typeof require === "function" ? require("./watermark.js") : root.WM
    );
  } else root.Registry = factory(root.WM);
})(typeof self !== "undefined" ? self : this, function (WM) {
  "use strict";

  var STORE_KEY = "zfl31WatermarkRegistry.v1";
  var STORE_REC_PREFIX = "zfl31WatermarkRecord.v1.";
  var VERSION = 1;

  function nonce() {
    var s = "r" + Date.now().toString(36);
    var cryptoObj = (typeof crypto !== "undefined") && crypto;
    if (cryptoObj && cryptoObj.getRandomValues) {
      var b = new Uint8Array(6);
      cryptoObj.getRandomValues(b);
      for (var i = 0; i < b.length; i++) s += b[i].toString(16);
    } else {
      for (var j = 0; j < 8; j++) s += ((Math.random() * 16) | 0).toString(16);
    }
    return s;
  }

  function todayISO() {
    var d = new Date();
    var m = d.getMonth() + 1;
    return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" +
      (d.getDate() < 10 ? "0" + d.getDate() : d.getDate());
  }

  function endYMOf(startYM, months) {
    if (!months) return null;
    var p = startYM.split("-").map(Number);
    var idx = (p[0] - 2000) * 12 + (p[1] - 1) + months - 1;
    return WM.ymOf(idx);
  }

  function validateInput(input) {
    var errors = [];
    if (!input || !input.cells || input.cells.length !== (input.cols | 0) * (input.rows | 0)) {
      errors.push("方案网格数据不完整。");
    }
    if (input.cols < 6 || input.rows < 6 || input.cols > 36 || input.rows > 32) {
      errors.push("网格尺寸须在 6×6 到 36×32 之间。");
    }
    var author = Number(input.author);
    if (!Number.isInteger(author) || author < 1 || author > 32767) {
      errors.push("作者编号须为 1–32767 的整数。");
    }
    var scope = Number(input.scope);
    if (!Number.isInteger(scope) || scope < 1 || scope > 6) {
      errors.push("授权范围无效（1–6）。");
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.startYM || "")) {
      errors.push("授权起始月格式应为 YYYY-MM。");
    }
    var months = Number(input.months);
    if (!Number.isInteger(months) || months < 0 || months > 63) {
      errors.push("授权月数须为 0（长期）到 63。");
    }
    return errors;
  }

  function Registry(storage) {
    // 存储注入：默认 localStorage；Node 测试传一个内存对象适配器
    this.store = storage || (typeof localStorage !== "undefined" ? localStorage : new MemoryStore());
    this.records = [];
    this.index = {};
    this.load();
  }

  function MemoryStore() { this.m = {}; }
  MemoryStore.prototype.getItem = function (k) { return Object.prototype.hasOwnProperty.call(this.m, k) ? this.m[k] : null; };
  MemoryStore.prototype.setItem = function (k, v) { this.m[k] = String(v); };
  MemoryStore.prototype.removeItem = function (k) { delete this.m[k]; };

  Registry.prototype.load = function () {
    var raw = null;
    try { raw = this.store.getItem(STORE_KEY); } catch (e) { raw = null; }
    var list = [];
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.records && parsed.version === VERSION) list = parsed.records;
      } catch (e) { list = []; }
    }
    // 单元格矩阵可能较大：支持按记录分键存储（导出时合并）
    this.records = list.map(function (ref) {
      if (ref && ref.cellsRef) {
        var full = null;
        try { full = JSON.parse(this.store.getItem(ref.cellsRef) || "null"); } catch (e) { full = null; }
        if (full) return full;
      }
      return ref;
    }, this).filter(Boolean);
    this.index = {};
    this.records.forEach(function (r) { this.index[r.nonce] = r; }, this);
    return this.records.length;
  };

  Registry.prototype.persist = function () {
    var refs = this.records.map(function (r, i) {
      // 大于 800 格的矩阵分键存储，避免单条 localStorage 过大
      if (r.cells && r.cells.length > 800) {
        var key = STORE_REC_PREFIX + r.nonce;
        this.store.setItem(key, JSON.stringify(r));
        var ref = Object.assign({}, r);
        delete ref.cells; delete ref.wmCells;
        ref.cellsRef = key;
        return ref;
      }
      return r;
    }, this);
    this.store.setItem(STORE_KEY, JSON.stringify({ version: VERSION, records: refs }));
  };

  // 登记：先嵌水印（保色线数），写两份指纹。返回 {ok, record, embedded}。
  Registry.prototype.register = function (input) {
    var errors = validateInput(input);
    if (errors.length) return { ok: false, errors: errors };

    var cols = input.cols | 0, rows = input.rows | 0;
    var cells = input.cells.slice();
    var em = WM.embed(cells, cols, rows, {
      author: Number(input.author),
      scope: Number(input.scope),
      startYM: input.startYM,
      months: Number(input.months)
    });
    if (!em.ok) return { ok: false, errors: [em.hint || ("图案不具备水印容量（可用块 " + em.usable + "）。")], embed: em };

    var record = {
      nonce: nonce(),
      version: VERSION,
      name: (input.name || ("方案 " + (this.records.length + 1))).slice(0, 40),
      author: Number(input.author),
      scope: Number(input.scope),
      startYM: input.startYM,
      months: Number(input.months),
      endYM: endYMOf(input.startYM, Number(input.months)),
      cols: cols, rows: rows,
      cells: cells,                 // 登记时原始方案（水印前）
      wmCells: em.cells,            // 水印方案（核验基准）
      fingerprint: em.fingerprint,  // 原图指纹
      fpWm: em.fpWm,                // 水印图指纹
      tag: em.tag,
      watermarked: true,
      registeredAt: input.registeredAt || todayISO(),
      note: input.note ? String(input.note).slice(0, 200) : ""
    };
    this.records.push(record);
    this.index[record.nonce] = record;
    this.persist();
    return {
      ok: true, record: this.publicView(record),
      embedded: { cells: em.cells, changedCells: em.changedCells, usedBlocks: em.usedBlocks, minVotes: em.minVotes }
    };
  };

  // 写保护更新：只允许更新授权元信息；若传入 wmCells 必须与登记指纹一致，否则拒绝。
  Registry.prototype.updateRecord = function (nonceId, patch) {
    var rec = this.index[nonceId];
    if (!rec) return { ok: false, errors: ["找不到登记记录。"] };
    if (patch.wmCells) {
      var fp = WM.fingerprint(patch.wmCells, rec.cols, rec.rows);
      if (fp !== rec.fpWm) {
        return { ok: false, errors: ["提供的图样指纹与登记原方案不符，更新已拒绝（防止覆盖）。"] };
      }
    }
    var allowed = ["name", "note"];
    allowed.forEach(function (k) { if (patch[k] !== undefined) rec[k] = patch[k]; });
    // 授权续期：显式字段 + 必须与当前水印读出的信息无关，仅记录方操作
    if (patch.renew) {
      var rn = patch.renew;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rn.startYM || "") ||
          !Number.isInteger(Number(rn.months)) || Number(rn.months) < 0 || Number(rn.months) > 63) {
        return { ok: false, errors: ["续期参数无效。"] };
      }
      rec.startYM = rn.startYM; rec.months = Number(rn.months);
      rec.endYM = endYMOf(rec.startYM, rec.months);
    }
    this.persist();
    return { ok: true, record: this.publicView(rec) };
  };

  Registry.prototype.remove = function (nonceId) {
    var i = this.records.findIndex(function (r) { return r.nonce === nonceId; });
    if (i < 0) return false;
    var r = this.records[i];
    this.records.splice(i, 1);
    delete this.index[nonceId];
    try { this.store.removeItem(STORE_REC_PREFIX + r.nonce); } catch (e) {}
    this.persist();
    return true;
  };

  Registry.prototype.get = function (nonceId) { return this.index[nonceId] || null; };
  Registry.prototype.all = function () { return this.records.slice(); };
  Registry.prototype.count = function () { return this.records.length; };

  Registry.prototype.findByAuthor = function (author) {
    var a = Number(author);
    return this.records.filter(function (r) { return r.author === a; });
  };

  // 批量核验（连续核验大量方案）：逐条调用 WM.verify，带进度回调与计时。
  Registry.prototype.verifyMany = function (samples, nowYM, onProgress) {
    var t0 = Date.now();
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      var r = WM.verify(s.cells, s.cols, s.rows, this.records, s.nowYM || nowYM);
      r.sampleName = s.name || ("样本 " + (i + 1));
      r.index = i;
      out.push(r);
      if (onProgress) onProgress(i + 1, samples.length, r);
    }
    out.durationMs = Date.now() - t0;
    return out;
  };

  Registry.prototype.publicView = function (rec) {
    return {
      nonce: rec.nonce, name: rec.name, author: rec.author, scope: rec.scope,
      scopeText: WM.SCOPE_TEXT[rec.scope] || "未知",
      startYM: rec.startYM, months: rec.months, endYM: rec.endYM,
      cols: rec.cols, rows: rec.rows,
      fingerprint: rec.fingerprint, fpWm: rec.fpWm, tag: rec.tag,
      watermarked: rec.watermarked, registeredAt: rec.registeredAt, note: rec.note
    };
  };
  Registry.prototype.list = function () { return this.records.map(this.publicView, this); };

  /* ----------------------------- 导入导出 ----------------------------- */

  Registry.prototype.exportJSON = function (nonceIds) {
    var recs = nonceIds ? nonceIds.map(function (id) { return this.index[id]; }, this).filter(Boolean) : this.records;
    return {
      format: "zfl31-brocade-watermark-registry",
      version: VERSION,
      exportedAt: todayISO(),
      count: recs.length,
      records: recs.map(exportRecord)
    };
  };

  function exportRecord(r) {
    return {
      nonce: r.nonce, version: r.version, name: r.name,
      author: r.author, scope: r.scope,
      startYM: r.startYM, months: r.months, endYM: r.endYM,
      cols: r.cols, rows: r.rows,
      cells: r.cells, wmCells: r.wmCells,
      fingerprint: r.fingerprint, fpWm: r.fpWm, tag: r.tag,
      watermarked: true, registeredAt: r.registeredAt, note: r.note
    };
  }

  // 导入：校验结构与指纹，拒绝任何与本机同 nonce 但指纹不一致的条目（防覆盖）。
  // mode: "merge"(默认) | "replace"
  Registry.prototype.importJSON = function (data, mode) {
    var report = { added: 0, skipped: 0, rejected: [], merged: 0 };
    var parsed = (typeof data === "string") ? JSON.parse(data) : data;
    if (!parsed || parsed.format !== "zfl31-brocade-watermark-registry" || !Array.isArray(parsed.records)) {
      return { ok: false, errors: ["文件不是本台登记册导出格式。"], report: report };
    }
    if (mode === "replace") { this.records = []; this.index = {}; }
    for (var i = 0; i < parsed.records.length; i++) {
      var r = parsed.records[i];
      var err = checkImportRecord(r);
      if (err) { report.rejected.push({ index: i, name: r && r.name, reason: err }); continue; }
      var existing = this.index[r.nonce];
      if (existing) {
        if (existing.fpWm !== r.fpWm) {
          report.rejected.push({ index: i, name: r.name, reason: "同编号记录指纹不一致，拒绝覆盖。" });
          continue;
        }
        report.merged++;
        this.index[r.nonce] = Object.assign({}, existing, r);
      } else {
        this.records.push(r);
        this.index[r.nonce] = r;
        report.added++;
      }
    }
    this.records = Object.keys(this.index).map(function (k) { return this.index[k]; }, this);
    this.persist();
    report.ok = true;
    return report;
  };

  function checkImportRecord(r) {
    if (!r || typeof r !== "object") return "记录为空。";
    if (!r.nonce || !Number.isInteger(r.author) || !r.startYM) return "缺少编号/作者/起始月。";
    if (!Array.isArray(r.cells) || !Array.isArray(r.wmCells)) return "缺少网格数据。";
    if (r.cells.length !== r.cols * r.rows || r.wmCells.length !== r.cols * r.rows) return "网格尺寸与数据不符。";
    if (WM.fingerprint(r.cells, r.cols, r.rows) !== r.fingerprint) return "原图指纹不匹配（数据可能已损坏）。";
    if (WM.fingerprint(r.wmCells, r.cols, r.rows) !== r.fpWm) return "水印图指纹不匹配（数据可能已损坏）。";
    if (!WM.sameCounts(r.cells, r.wmCells)) return "水印前后色线数量不一致，记录非法。";
    var det = WM.detect(r.wmCells, r.cols, r.rows);
    if (!det.found || !det.data || det.data.author !== r.author) return "水印解不出登记作者，记录非法。";
    return null;
  }

  Registry.version = VERSION;
  Registry.MemoryStore = MemoryStore;
  Registry.validateInput = validateInput;
  return Registry;
});
