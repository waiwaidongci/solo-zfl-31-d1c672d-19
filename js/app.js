/*!
 * app.js — 织锦纹样台页面逻辑（只负责交互，所有判定走 WM / Registry / Raster）
 */
(function () {
  "use strict";
  var WM = window.WM, Registry = window.Registry, Raster = window.Raster;
  var colors = WM.PALETTE;

  /* ------------------------------ 应用状态 ------------------------------ */
  var state = {
    cols: 18, rows: 14, cells: [], active: 1, block: "dot",
    undo: [], redo: [],
    docId: null,            // 已保存文档（画布）id
    watermarkNonce: null,   // 若当前画布已登记，对应登记记录 nonce
    dirty: false
  };
  var registry = new Registry(localStorage);

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  /* ------------------------------ 画布编辑 ------------------------------ */
  var gridEl = $("#grid"), paletteEl = $("#palette"), statsEl = $("#stats"),
      previewEl = $("#preview"), riskEl = $("#risk"), wmBadge = $("#wmBadge");
  var dragging = false;

  function init(loadSaved) {
    var saved = null;
    if (loadSaved) {
      try { saved = JSON.parse(localStorage.getItem("zfl31Pattern") || "null"); } catch (e) { saved = null; }
    }
    if (saved && saved.cells && saved.cells.length === saved.cols * saved.rows) {
      state.cols = saved.cols; state.rows = saved.rows; state.cells = saved.cells;
      state.docId = saved.docId || null; state.watermarkNonce = saved.watermarkNonce || null;
    } else {
      state.cols = clampDim($("#cols").value, 36); state.rows = clampDim($("#rows").value, 32);
      state.cells = new Array(state.cols * state.rows).fill(0);
      state.docId = null; state.watermarkNonce = null;
    }
    $("#cols").value = state.cols; $("#rows").value = state.rows;
    state.undo = []; state.redo = []; state.dirty = false;
    render();
    refreshRegistrationPanel();
  }
  function clampDim(v, max) { v = Number(v); return Math.max(6, Math.min(max, isNaN(v) ? 18 : v)); }

  function snapshot() {
    state.undo.push({ cells: state.cells.slice(), wm: state.watermarkNonce, dirty: state.dirty });
    state.redo = [];
    if (state.undo.length > 60) state.undo.shift();
    // 编辑即解除“与登记一致”状态（原登记仍受保护，不被覆盖）
    if (state.watermarkNonce) state.watermarkNonce = null;
    state.dirty = true;
  }

  function render() {
    paletteEl.innerHTML = colors.map(function (c, i) {
      return '<button type="button" class="swatch ' + (i === state.active ? "active" : "") +
        '" data-color="' + i + '" style="background:' + c + '" title="色线' + i + '"></button>';
    }).join("");
    paletteEl.querySelectorAll("[data-color]").forEach(function (el) {
      el.onclick = function () { state.active = Number(el.dataset.color); render(); };
    });
    gridEl.style.gridTemplateColumns = "repeat(" + state.cols + ",1fr)";
    gridEl.innerHTML = state.cells.map(function (v, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' + colors[v] + '"></div>';
    }).join("");
    gridEl.querySelectorAll(".cell").forEach(function (el) {
      el.onpointerdown = function () { dragging = true; paint(Number(el.dataset.i)); el.setPointerCapture && el.setPointerCapture(); };
      el.onpointerenter = function () { if (dragging) paint(Number(el.dataset.i)); };
    });
    window.onpointerup = function () { dragging = false; };
    renderStats();
    renderBadge();
  }

  function idx(x, y) { return (x < 0 || x >= state.cols || y < 0 || y >= state.rows) ? null : y * state.cols + x; }
  function paint(i) {
    snapshot();
    var x = i % state.cols, y = Math.floor(i / state.cols), targets = [i];
    if (state.block === "cross") {
      [[x-1,y],[x+1,y],[x,y-1],[x,y+1]].forEach(function (p) { var k = idx(p[0],p[1]); if (k!==null) targets.push(k); });
    } else if (state.block === "diamond") {
      [[x,y-1],[x-1,y],[x+1,y],[x,y+1]].forEach(function (p) { var k = idx(p[0],p[1]); if (k!==null) targets.push(k); });
    }
    targets.forEach(function (t) { state.cells[t] = state.active; });
    render();
  }

  function renderStats() {
    var counts = WM.colorCounts(state.cells);
    statsEl.innerHTML = colors.map(function (color, i) {
      return '<div class="stat"><span><span class="dot" style="background:' + color + '"></span>色线' + i +
        "</span><b>" + counts[i] + "</b></div>";
    }).join("");
    previewEl.innerHTML = Array.from({ length: 36 }, function (_, i) {
      var v = state.cells[(i % 6) + Math.floor(i / 6) * state.cols] || 0;
      return '<div class="mini" style="background:' + colors[v] + '"></div>';
    }).join("");
    var riskRows = [];
    for (var y = 0; y < state.rows; y++) {
      var sw = 0;
      for (var x = 1; x < state.cols; x++) if (state.cells[y*state.cols+x] !== state.cells[y*state.cols+x-1]) sw++;
      if (sw > state.cols * 0.62) riskRows.push(y + 1);
    }
    riskEl.innerHTML = riskRows.length
      ? '<p class="warning">第' + riskRows.join("、") + "行换色过密，可能断线。</p>"
      : "<p>暂无明显断线风险。</p>";
  }

  function currentCap() { return WM.capacity(state.cols, state.rows, state.cells); }

  function renderBadge() {
    var rec = state.watermarkNonce ? registry.get(state.watermarkNonce) : null;
    var cap = currentCap();
    if (rec) {
      wmBadge.className = "wm-badge ok";
      wmBadge.innerHTML = "● 已登记水印 · 作者 " + rec.author + " · " + esc(WM.SCOPE_TEXT[rec.scope]) +
        "<br><small>格点与登记原方案一致；再编辑会解除绑定且不影响登记记录。</small>";
    } else {
      wmBadge.className = "wm-badge " + (cap.ok ? "ready" : "no");
      wmBadge.innerHTML = cap.ok
        ? "○ 当前图样可嵌入水印（可用 2×2 块 " + cap.usable + " 个）"
        : "× 当前图样无法嵌入水印<br><small>" + esc(cap.hint || "") + "</small>";
    }
  }

  /* ------------------------------ 登记 ------------------------------ */
  function refreshRegistrationPanel() {
    var list = registry.list().slice().reverse();
    var cnt = $("#regCount"); if (cnt) cnt.textContent = list.length;
    var box = $("#regList");
    if (!list.length) { box.innerHTML = '<p class="muted">本机尚无登记记录。</p>'; return; }
    box.innerHTML = list.map(function (r) {
      return '<div class="reg-item" data-nonce="' + esc(r.nonce) + '">' +
        '<b>' + esc(r.name) + '</b> <span class="mono">#' + r.author + "</span><br>" +
        '<small>' + esc(r.scopeText) + " · " + esc(r.startYM) + (r.endYM ? " 至 " + esc(r.endYM) : " 起长期") +
        " · " + r.cols + "×" + r.rows + '<br>指纹 ' + esc(r.fpWm.slice(0, 12)) + "…</small></div>";
    }).join("");
    box.querySelectorAll(".reg-item").forEach(function (el) {
      el.onclick = function () {
        var r = registry.get(el.dataset.nonce);
        if (r) loadRecordToCanvas(r);
      };
    });
  }

  function loadRecordToCanvas(r) {
    state.cols = r.cols; state.rows = r.rows; state.cells = r.wmCells.slice();
    state.watermarkNonce = r.nonce; state.undo = []; state.redo = []; state.dirty = false;
    $("#cols").value = state.cols; $("#rows").value = state.rows;
    render();
    toast('已载入登记方案「' + r.name + "」的水印图样。");
  }

  $("#registerBtn").onclick = function () {
    var info = readRegForm();
    if (info.errors.length) { toast(info.errors.join(" "), true); return; }
    var result = registry.register({
      name: $("#regName").value.trim() || "未命名方案",
      cols: state.cols, rows: state.rows, cells: state.cells,
      author: info.author, scope: info.scope, startYM: info.startYM, months: info.months,
      note: $("#regNote").value.trim()
    });
    if (!result.ok) { toast((result.errors || [result.hint]).join(" "), true); return; }
    // 嵌入后的水印图样成为当前画布；原方案已在登记记录内保存
    state.cells = result.embedded.cells;
    state.watermarkNonce = result.record.nonce;
    state.undo = []; state.redo = []; state.dirty = false;
    saveDoc();
    render(); refreshRegistrationPanel();
    toast("水印已嵌入并登记：改动 " + result.embedded.changedCells +
      " 个格点（色线数量不变），使用载体块 " + result.embedded.usedBlocks + " 个。");
  };

  function readRegForm() {
    var errors = [];
    var author = Number($("#regAuthor").value);
    if (!(author >= 1 && author <= 32767)) errors.push("作者编号须为 1–32767。");
    var scope = Number($("#regScope").value);
    if (!(scope >= 1 && scope <= 6)) errors.push("请选择授权范围。");
    var startYM = $("#regStart").value;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startYM)) errors.push("授权起始月格式应为 YYYY-MM。");
    var months = Number($("#regMonths").value);
    if (!(months >= 0 && months <= 63)) errors.push("授权月数须为 0（长期）到 63。");
    return { author: author, scope: scope, startYM: startYM, months: months, errors: errors };
  }

  /* ------------------------------ 核验 ------------------------------ */
  var verifyResult = null;

  $("#verifyBtn").onclick = function () {
    runVerify(state.cells.slice(), state.cols, state.rows, "当前画布");
  };

  function runVerify(cells, cols, rows, sourceName) {
    var panel = $("#verifyPanel");
    panel.classList.add("busy");
    // 让 UI 有机会渲染 busy（裁切搜索最坏情况约 1 秒）
    setTimeout(function () {
      var t0 = performance.now();
      var v = WM.verify(cells, cols, rows, registry.all(), WM.currentYM());
      v.sourceName = sourceName; v.ms = Math.round(performance.now() - t0);
      verifyResult = v;
      renderVerify(v);
      panel.classList.remove("busy");
    }, 20);
  }

  var STATUS_META = {
    valid: ["通过", "st-ok"], valid_partial: ["部分通过（裁切）", "st-partial"],
    tampered: ["篡改", "st-bad"], damaged: ["损坏", "st-warn"],
    orphan: ["无登记（孤儿水印）", "st-warn"], unknown: ["无法确认", "st-bad"]
  };
  function renderVerify(v) {
    var out = $("#verifyResult");
    var meta = STATUS_META[v.status] || ["未知", "st-bad"];
    var html = '<div class="verdict ' + meta[1] + '"><big>' + meta[0] + "</big>";
    html += '<span class="muted">样本：' + esc(v.sourceName) + " · 耗时 " + v.ms + "ms</span></div>";

    if (v.extracted) {
      html += '<table class="kv"><tr><th>提取结果</th><td>';
      html += field("作者编号", v.extracted.author, v.extracted.authorFromRecord);
      html += field("授权范围", v.extracted.scopeText, v.extracted.scopeFromRecord);
      html += field("授权期限", v.term ? v.term.text : "—", v.extracted.termFromRecord);
      html += "</td></tr>";
      html += '<tr><th>可信度</th><td><div class="confbar"><i style="width:' +
        Math.round(v.confidence * 100) + '%"></i></div> ' + Math.round(v.confidence * 100) + "%</td></tr>";
      if (v.record) {
        html += '<tr><th>登记作者</th><td>#' + v.record.author + " " + esc(v.record.name) + "</td></tr>";
        html += '<tr><th>授权期限</th><td>' + termBadge(v.term) + "</td></tr>";
        html += '<tr><th>登记时间</th><td>' + esc(v.record.registeredAt) + "</td></tr>";
      }
      if (v.detection) {
        html += '<tr><th>几何检测</th><td>' + esc(v.detection.orientationText) + " · 原尺寸 " +
          v.detection.cols + "×" + v.detection.rows + " · 载体块 " + v.detection.usedBlocks +
          " 个 · 平均余量 " + Math.round(v.detection.avgConfidence * 100) + "%</td></tr>";
      }
      html += "</table>";
    }

    if (v.reasons && v.reasons.length) {
      html += '<div class="reasons"><b>无法确认 / 判定依据：</b><ul>' +
        v.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div>";
    }

    if (v.altered && v.altered.length) {
      var shown = v.altered.slice(0, 60);
      html += '<div class="difflist"><b>被改格（' + v.altered.length + '）：</b>' +
        '<span class="muted">坐标为还原到原方案后的列/行（从 1 起）</span><br>' +
        shown.map(function (a) {
          return '<span class="chip bad" title="色线' + a.from + "→色线" + a.to + (a.inWatermarkBlock ? "，水印块内" : "") +
            '">(' + (a.x + 1) + "," + (a.y + 1) + ") " + a.from + "→" + a.to + "</span>";
        }).join(" ") + (v.altered.length > 60 ? " …" : "") + "</div>";
    }
    if (v.missing && v.missing.length) {
      html += '<div class="difflist"><b>无法确认的格（' + v.missing.length + "，裁切缺失）：</b><br>" +
        '<span class="chip warn">缺失格已在差异图中标为深色</span></div>';
    }
    if (v.record && (v.altered.length || v.missing.length)) {
      html += '<div class="diff-canvas-wrap"><canvas id="diffCanvas" width="520" height="420"></canvas></div>';
    }
    out.innerHTML = html;
    var cv = $("#diffCanvas");
    if (cv) drawDiff(cv, v);
    out.style.display = "block";
  }
  function field(label, val, fromRecord) {
    return '<div class="fld"><span>' + label + "</span><b>" + esc(val == null ? "无法确认" : val) +
      (fromRecord ? '<em class="fromrec">登记册</em>' : "") + "</b></div>";
  }
  function termBadge(term) {
    if (!term) return "—";
    var map = { valid: ["有效", "tag-ok"], expired: ["已过期", "tag-bad"], future: ["未生效", "tag-warn"], open: ["长期", "tag-ok"], unknown: ["无法确认", "tag-warn"] };
    var m = map[term.state] || ["", ""];
    return esc(term.text) + ' <span class="tag ' + m[1] + '">' + m[0] + "</span>";
  }

  function drawDiff(canvas, v) {
    var rec = registry.get(v.record.nonce) || null;
    if (!rec) return;
    var ctx = canvas.getContext("2d");
    var pad = 10, cw = rec.cols, ch = rec.rows;
    var s = Math.min((canvas.width - pad * 2) / cw, (canvas.height - pad * 2) / ch);
    ctx.fillStyle = "#72533c"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    var base = v.rectified.cells;
    for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) {
      var p = y * cw + x, val = base[p];
      ctx.fillStyle = val < 0 ? "#241a12" : colors[val];
      ctx.fillRect(pad + x * s + 0.5, pad + y * s + 0.5, s - 1, s - 1);
    }
    var mark = function (x, y, color) {
      ctx.strokeStyle = color; ctx.lineWidth = 2.5;
      ctx.strokeRect(pad + x * s + 1.5, pad + y * s + 1.5, s - 3, s - 3);
    };
    v.altered.forEach(function (a) { mark(a.x, a.y, "#ff3b30"); });
    v.missing.forEach(function (mm) { mark(mm.x, mm.y, "#ffd60a"); });
    // 图例
    ctx.fillStyle = "#fffaf2"; ctx.font = "12px sans-serif";
    ctx.fillText("红框=被改格  黄框=裁切缺失无法确认  深色=不在样本内", pad, canvas.height - 1);
  }

  /* ------------------------- 撤销/重做/保存/新建 ------------------------- */
  $("#undoBtn").onclick = function () {
    if (!state.undo.length) return;
    state.redo.push({ cells: state.cells.slice(), wm: state.watermarkNonce, dirty: state.dirty });
    var s = state.undo.pop();
    state.cells = s.cells; state.watermarkNonce = s.wm; state.dirty = s.dirty;
    render();
  };
  $("#redoBtn").onclick = function () {
    if (!state.redo.length) return;
    state.undo.push({ cells: state.cells.slice(), wm: state.watermarkNonce, dirty: state.dirty });
    var s = state.redo.pop();
    state.cells = s.cells; state.watermarkNonce = s.wm; state.dirty = s.dirty;
    render();
  };
  $("#newBtn").onclick = function () {
    if (!confirm("新建空白网格？当前未登记的改动会丢失（登记记录不受影响）。")) return;
    init(false);
  };
  $("#saveBtn").onclick = function () { saveDoc(); toast("方案已保存到本机。"); };
  function saveDoc() {
    localStorage.setItem("zfl31Pattern", JSON.stringify({
      cols: state.cols, rows: state.rows, cells: state.cells,
      docId: state.docId, watermarkNonce: state.watermarkNonce
    }));
    state.dirty = false;
  }

  /* ------------------------------ 导入导出 ------------------------------ */
  $("#exportBtn").onclick = function () {
    var data = {
      format: "zfl31-brocade-pattern", version: 1,
      cols: state.cols, rows: state.rows, cells: state.cells,
      usage: colors.map(function (color, i) { return { color: color, count: WM.colorCounts(state.cells)[i] }; }),
      watermark: state.watermarkNonce ? registry.get(state.watermarkNonce).nonce : null,
      fingerprint: WM.fingerprint(state.cells, state.cols, state.rows),
      exportedAt: new Date().toISOString().slice(0, 10)
    };
    download(JSON.stringify(data, null, 2), "brocade-pattern.json", "application/json");
  };
  $("#exportRegBtn").onclick = function () {
    const data = registry.exportJSON();
    if (!data.count) { toast("登记册为空，无可导出的记录。", true); return; }
    download(JSON.stringify(data, null, 2), "watermark-registry.json", "application/json");
  };
  $("#exportPngBtn").onclick = function () {
    var img = Raster.render(state.cells, state.cols, state.rows, { cell: 28 });
    var cv = Raster.toCanvas(img);
    cv.toBlob(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "brocade-pattern.png"; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
  };

  $("#importFile").onchange = function (e) {
    var file = e.target.files[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (data.format === "zfl31-brocade-watermark-registry") {
          var report = registry.importJSON(data);
          refreshRegistrationPanel();
          toast(report.ok ? ("登记册导入：新增 " + report.added + "，合并 " + report.merged + "，拒绝 " + report.rejected.length + " 条。")
                          : ("导入失败：" + report.errors.join(" ")), report.rejected.length > 0);
        } else if (Array.isArray(data.cells) && data.cols && data.rows) {
          loadExternalPattern(data);
        } else { toast("无法识别的文件格式。", true); }
      } catch (err) { toast("JSON 解析失败：" + err.message, true); }
      e.target.value = "";
    };
    reader.readAsText(file);
  };
  function loadExternalPattern(data) {
    if (data.cells.length !== data.cols * data.rows) { toast("网格尺寸与数据不符。", true); return; }
    state.cols = data.cols; state.rows = data.rows; state.cells = data.cells.map(function (v) { return Number(v) & 7; });
    state.undo = []; state.redo = [];
    // 水印状态同步：若该图样就是本机某登记的水印图样，则直接绑定；否则为未绑定
    var bound = registry.all().filter(function (r) {
      return r.cols === state.cols && r.rows === state.rows &&
        WM.fingerprint(state.cells, state.cols, state.rows) === r.fpWm;
    })[0] || null;
    state.watermarkNonce = bound ? bound.nonce : null;
    state.dirty = false; saveDoc();
    $("#cols").value = state.cols; $("#rows").value = state.rows;
    render(); refreshRegistrationPanel();
    toast("已导入方案 " + state.cols + "×" + state.rows + (bound ? "，并匹配到本机登记水印。" : "（未匹配到本机登记）。"));
  }

  // 图像核验（PNG/照片）：走光栅恢复
  $("#imageFile").onchange = function (e) {
    var file = e.target.files[0]; if (!file) return;
    var url = URL.createObjectURL(file);
    var im = new Image();
    im.onload = function () {
      var cv = document.createElement("canvas");
      var maxW = 1400; var scale = Math.min(1, maxW / im.width);
      cv.width = Math.round(im.width * scale); cv.height = Math.round(im.height * scale);
      cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
      var img = Raster.fromCanvas(cv);
      URL.revokeObjectURL(url);
      var recov = Raster.recover(img, {
        hintCols: Number($("#hintCols").value) || null,
        hintRows: Number($("#hintRows").value) || null
      });
      if (!recov.ok) { toast("图像恢复失败：" + recov.reason, true); return; }
      runVerify(recov.cells, recov.cols, recov.rows,
        "图像 " + file.name + "（恢复 " + recov.cols + "×" + recov.rows + "，采色置信 " + recov.confidence + "）");
      e.target.value = "";
    };
    im.onerror = function () { toast("无法读取该图片。", true); };
    im.src = url;
  };

  /* ------------------------------ 批量核验 ------------------------------ */
  $("#batchBtn").onclick = function () {
    var files = $("#batchFiles").files;
    if (!files || !files.length) { toast("请先选择多个 JSON 方案。", true); return; }
    var readers = Array.prototype.map.call(files, function (f) {
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var d = JSON.parse(fr.result);
            if (Array.isArray(d.cells) && d.cols && d.rows) res({ d: d, name: f.name }); else res({ name: f.name, error: "格式不符" });
          } catch (e) { res({ name: f.name, error: e.message }); }
        };
        fr.readAsText(f);
      });
    });
    Promise.all(readers).then(function (items) {
      var t0 = performance.now();
      var rows = items.map(function (it) {
        if (it.error) return { sampleName: it.name, status: "unknown", reasons: [it.error] };
        var v = WM.verify(it.d.cells, it.d.cols, it.d.rows, registry.all(), WM.currentYM());
        v.sampleName = it.name; return v;
      });
      var dt = Math.round(performance.now() - t0);
      renderBatch(rows, dt);
    });
  };
  function renderBatch(rows, dt) {
    var cnt = {};
    rows.forEach(function (r) { cnt[r.status] = (cnt[r.status] || 0) + 1; });
    var html = '<p>连续核验 <b>' + rows.length + "</b> 个方案，总耗时 " + dt + "ms（平均 " +
      Math.round(dt / rows.length) + 'ms/个）</p><div class="batch-summary">' +
      Object.keys(STATUS_META).map(function (k) {
        if (!cnt[k]) return "";
        return '<span class="tag ' + STATUS_META[k][1] + '">' + STATUS_META[k][0] + " ×" + cnt[k] + "</span>";
      }).join("") + "</div><table class='batch'><tr><th>样本</th><th>结果</th><th>作者</th><th>期限</th><th>改/缺格</th><th>原因</th></tr>" +
      rows.map(function (r) {
        var m = STATUS_META[r.status] || ["?", ""];
        return "<tr><td>" + esc(r.sampleName) + '</td><td><span class="tag ' + m[1] + '">' + m[0] + "</span></td><td>" +
          (r.record ? "#" + r.record.author : (r.extracted && r.extracted.authorKnown ? "#" + r.extracted.authorRaw : "—")) +
          "</td><td>" + (r.term ? esc(r.term.text) : "—") + "</td><td>" +
          ((r.altered ? r.altered.length : 0) + "/" + (r.missing ? r.missing.length : 0)) + "</td><td>" +
          esc((r.reasons || []).slice(0, 1).join(" ")) + "</td></tr>";
      }).join("") + "</table>";
    $("#batchResult").innerHTML = html;
  }

  /* ------------------------------ 杂项 ------------------------------ */
  $$("[data-block]").forEach(function (btn) {
    btn.onclick = function () {
      state.block = btn.dataset.block;
      $$("[data-block]").forEach(function (b) { b.classList.toggle("active", b === btn); });
    };
  });
  $("#cols").onchange = $("#rows").onchange = function () {
    var nc = clampDim($("#cols").value, 36), nr = clampDim($("#rows").value, 32);
    if (nc === state.cols && nr === state.rows) return;
    if (!confirm("调整网格尺寸会清空当前画布，且不影响已登记记录。继续？")) {
      $("#cols").value = state.cols; $("#rows").value = state.rows; return;
    }
    state.cols = nc; state.rows = nr; state.cells = new Array(nc * nr).fill(0);
    state.undo = []; state.redo = []; state.watermarkNonce = null; state.dirty = true;
    render();
  };
  // 默认授权起始月填本月
  (function () {
    $("#regStart").value = WM.currentYM();
    $("#regMonths").value = 12;
  })();

  function toast(msg, bad) {
    var t = $("#toast"); t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
    clearTimeout(toast._h); toast._h = setTimeout(function () { t.className = ""; }, 4200);
  }
  function download(text, name, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  window.addEventListener("beforeunload", function () { try { saveDoc(); } catch (e) {} });

  init(true);
})();
