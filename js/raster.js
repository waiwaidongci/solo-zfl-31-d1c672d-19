/*!
 * raster.js — 网格 <-> 图像通道（与算法、页面分离）
 *
 * 所有核心函数操作普通 ImageData 形态 {width,height,data:Uint8ClampedArray}，
 * 不依赖 DOM/canvas，Node 下可直接用合成数据测试；浏览器端用 toRaster/putCanvas
 * 与 <canvas> 互转。
 *
 * 渲染规格：木质外框 F 像素 + 格缝 G 像素（同色），每格边长 S 像素。
 * 恢复时不依赖这些参数：自动找图样包围盒，再用亮度投影+自相关估计格距、格数，
 * 在每个格心取色吸附到标准 8 色调色板。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      typeof require === "function" ? require("./watermark.js") : root.WM
    );
  } else root.Raster = factory(root.WM);
})(typeof self !== "undefined" ? self : this, function (WM) {
  "use strict";

  var FRAME = [114, 83, 60];      // #72533c 外框/格缝
  var PAPER = [243, 239, 231];    // 画布底色
  var F = 8, G = 2;               // 外框宽、格缝宽（默认）

  /* =========================== 基础 ImageData =========================== */

  function Raster(w, h, fill) {
    this.width = w; this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    if (fill) for (var i = 0; i < w * h; i++) setPx(this.data, i, fill[0], fill[1], fill[2], fill[3] === undefined ? 255 : fill[3]);
  }
  function setPx(d, i, r, g, b, a) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a === undefined ? 255 : a; }
  function cloneRaster(img) {
    var r = new Raster(img.width, img.height);
    r.data.set(img.data);
    return r;
  }

  function fillRect(img, x0, y0, w, h, rgb) {
    for (var y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
      for (var x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
        var i = y * img.width + x;
        setPx(img.data, i, rgb[0], rgb[1], rgb[2], 255);
      }
    }
  }

  /* ============================== 渲染 ============================== */

  // 按规格把网格画成光栅。opts: {cell:24, frame:8, gap:2, frameRGB}
  function render(cells, cols, rows, opts) {
    opts = opts || {};
    var S = opts.cell || 24, f = opts.frame === undefined ? F : opts.frame, g = opts.gap === undefined ? G : opts.gap;
    var frameRGB = opts.frameRGB || FRAME;
    var w = f * 2 + cols * S + (cols - 1) * g;
    var h = f * 2 + rows * S + (rows - 1) * g;
    var img = new Raster(w, h, opts.paperRGB || PAPER);
    fillRect(img, 0, 0, w, h, frameRGB); // 整底铺框/缝色，再覆盖格块
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var rgb = WM.PALETTE_RGB[cells[y * cols + x]];
        var px = f + x * (S + g), py = f + y * (S + g);
        fillRect(img, px, py, S, S, rgb);
      }
    }
    img.meta = { cell: S, frame: f, gap: g, cols: cols, rows: rows };
    return img;
  }

  /* ============================ 几何攻击 ============================ */

  function crop(img, x0, y0, w, h) {
    var out = new Raster(w, h, PAPER);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      var si = sy * img.width + sx, di = y * w + x;
      for (var k = 0; k < 4; k++) out.data[di * 4 + k] = img.data[si * 4 + k];
    }
    return out;
  }

  // 最近邻缩放
  function scale(img, nw, nh) {
    var out = new Raster(nw, nh, PAPER);
    for (var y = 0; y < nh; y++) {
      var sy = Math.min(img.height - 1, Math.floor(y * img.height / nh));
      for (var x = 0; x < nw; x++) {
        var sx = Math.min(img.width - 1, Math.floor(x * img.width / nw));
        var si = sy * img.width + sx, di = y * nw + x;
        for (var k = 0; k < 4; k++) out.data[di * 4 + k] = img.data[si * 4 + k];
      }
    }
    return out;
  }
  function scaleBy(img, factor) {
    return scale(img, Math.max(4, Math.round(img.width * factor)), Math.max(4, Math.round(img.height * factor)));
  }

  function rot90CW(img) {
    var out = new Raster(img.height, img.width, PAPER);
    for (var y = 0; y < img.height; y++) for (var x = 0; x < img.width; x++) {
      var di = x * out.width + (img.height - 1 - y), si = y * img.width + x;
      for (var k = 0; k < 4; k++) out.data[di * 4 + k] = img.data[si * 4 + k];
    }
    return out;
  }
  function rot180(img) { return rot90CW(rot90CW(img)); }
  function rot90CCW(img) { return rot90CW(rot90CW(rot90CW(img))); }
  function flipH(img) {
    var out = new Raster(img.width, img.height, PAPER);
    for (var y = 0; y < img.height; y++) for (var x = 0; x < img.width; x++) {
      var di = y * out.width + x, si = y * img.width + (img.width - 1 - x);
      for (var k = 0; k < 4; k++) out.data[di * 4 + k] = img.data[si * 4 + k];
    }
    return out;
  }
  function flipV(img) { return rot180(flipH(img)); }

  /* ============================ 颜色攻击 ============================ */

  // 每通道位深压缩（2..7 位），再吸附到标准色板由 recover 完成
  function quantize(img, bits) {
    var out = new Raster(img.width, img.height, PAPER);
    var levels = (1 << Math.max(2, Math.min(7, bits | 0)));
    var step = 256 / levels;
    for (var i = 0; i < img.width * img.height; i++) {
      for (var k = 0; k < 3; k++) {
        var v = img.data[i * 4 + k];
        out.data[i * 4 + k] = Math.min(255, Math.floor(v / step) * step + step / 2) | 0;
      }
      out.data[i * 4 + 3] = img.data[i * 4 + 3];
    }
    return out;
  }

  // 均匀噪声（模拟翻拍/压缩抖动），强度 0..60
  function addNoise(img, strength, rng) {
    rng = rng || Math.random;
    var out = new Raster(img.width, img.height, PAPER);
    for (var i = 0; i < img.width * img.height; i++) {
      var n = (rng() - 0.5) * 2 * strength;
      for (var k = 0; k < 3; k++) out.data[i * 4 + k] = Math.max(0, Math.min(255, img.data[i * 4 + k] + n));
      out.data[i * 4 + 3] = img.data[i * 4 + 3];
    }
    return out;
  }

  /* =========================== 网格恢复 =========================== */

  function lumaAt(img, x, y) {
    var i = (y * img.width + x) * 4;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  function isFrameRGB(r, g, b) {
    return Math.abs(r - FRAME[0]) < 34 && Math.abs(g - FRAME[1]) < 34 && Math.abs(b - FRAME[2]) < 34;
  }

  // 找框/缝色包围盒（返回图样内容外框边界，含框）
  function findBounds(img) {
    var minX = img.width, minY = img.height, maxX = -1, maxY = -1, count = 0;
    var xAny = new Array(img.width).fill(0);
    for (var y = 0; y < img.height; y++) {
      for (var x = 0; x < img.width; x++) {
        var i = (y * img.width + x) * 4;
        // “非纸底色”即图样（框或格）
        var dr = img.data[i] - PAPER[0], dg = img.data[i + 1] - PAPER[1], db = img.data[i + 2] - PAPER[2];
        if (dr * dr + dg * dg + db * db > 40 * 40) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          count++; xAny[x]++;
        }
      }
    }
    if (count < 16) return null;
    return { x0: minX, y0: minY, x1: maxX, y1: maxY };
  }

  // 由框/缝投影联合恢复格数与每格可见区间（横纵近正方形约束）。
  function estimateGrid(img, b) {
    var w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    var colFrame = new Array(w).fill(0), rowFrame = new Array(h).fill(0);
    for (var y = b.y0; y <= b.y1; y++) {
      for (var x = b.x0; x <= b.x1; x++) {
        var i = (y * img.width + x) * 4;
        if (isFrameRGB(img.data[i], img.data[i + 1], img.data[i + 2])) {
          colFrame[x - b.x0]++; rowFrame[y - b.y0]++;
        }
      }
    }
    var maxNx = Math.min(36, Math.floor(w / 3)), maxNy = Math.min(32, Math.floor(h / 3));
    var sx = axisScores(colFrame, 6, maxNx), sy = axisScores(rowFrame, 6, maxNy);
    var best = null;
    for (var ix = 0; ix < sx.length; ix++) {
      for (var iy = 0; iy < sy.length; iy++) {
        var ax = sx[ix], ay = sy[iy];
        var ratio = ax.pitch / ay.pitch;
        if (ratio < 0.75 || ratio > 1.33) continue; // 格近正方形
        var square = 1 - Math.abs(Math.log(ratio));
        var score = ax.score + ay.score + 0.6 * square;
        if (!best || score > best.score) best = { x: ax, y: ay, score: score };
      }
    }
    if (!best) best = { x: sx.sort(function (a, z) { return z.score - a.score; })[0],
                        y: sy.sort(function (a, z) { return z.score - a.score; })[0] };
    return {
      cols: best.x.count, rows: best.y.count,
      innerX0: best.x.cellBounds[0][0], innerX1: best.x.cellBounds[best.x.count - 1][1],
      innerY0: best.y.cellBounds[0][0], innerY1: best.y.cellBounds[best.y.count - 1][1],
      centersX: best.x.cellBounds.map(function (bd) { return (bd[0] + bd[1]) / 2; }),
      centersY: best.y.cellBounds.map(function (bd) { return (bd[0] + bd[1]) / 2; }),
      boundsX: best.x.cellBounds, boundsY: best.y.cellBounds
    };
  }

  // 一维：识别端边外框 -> 在内部区域对每个候选格数 N 拟合缝偏移并打分。
  function axisScores(profile, nMin, nMax) {
    var n = profile.length, maxV = 0;
    for (var i = 0; i < n; i++) if (profile[i] > maxV) maxV = profile[i];
    var norm = profile.map(function (v) { return maxV ? v / maxV : 0; });

    // 外框：端边连续高值段（裁切无边时通常不足 4px，视为 0）
    var lead = 0, trail = 0;
    while (lead < n && norm[lead] > 0.5) lead++;
    while (trail < n && norm[n - 1 - trail] > 0.5) trail++;
    var borderL = lead >= 4 ? lead : 0, borderR = trail >= 4 ? trail : 0;
    var inner0 = borderL, inner1 = n - 1 - borderR, L = inner1 - inner0 + 1;

    var out = [];
    for (var N = nMin; N <= nMax; N++) {
      var pitch = L / N;
      if (pitch < 3) continue;
      var gapW = Math.max(1, Math.round(pitch * 0.10));
      // 格缝 k（k=1..N-1）位于 inner0 + k*pitch 附近，搜索小幅偏移 t
      var bestLine = -1, bestT = 0;
      var tRange = Math.max(gapW * 2, Math.round(pitch * 0.18));
      for (var t = -tRange; t <= tRange; t++) {
        var lineScore = 0, cnt = 0;
        for (var k = 1; k < N; k++) {
          var gp = Math.round(inner0 + k * pitch) + t;
          for (var d = -gapW; d <= gapW; d++) {
            var p = gp + d;
            if (p >= 0 && p < n) { lineScore += norm[p]; cnt++; }
          }
        }
        lineScore /= Math.max(1, cnt);
        if (lineScore > bestLine) { bestLine = lineScore; bestT = t; }
      }
      // 格心应明显非框色
      var centerScore = 0, cc = 0;
      for (k = 0; k < N; k++) {
        var cp = Math.round(inner0 + (k + 0.5) * pitch) + bestT;
        var win2 = Math.max(1, Math.round(pitch * 0.18));
        var s2 = 0, c2 = 0;
        for (var d2 = -win2; d2 <= win2; d2++) {
          var p2 = cp + d2;
          if (p2 >= 0 && p2 < n) { s2 += 1 - norm[p2]; c2++; }
        }
        centerScore += s2 / Math.max(1, c2); cc++;
      }
      centerScore /= Math.max(1, cc);

      var bounds = [];
      for (k = 0; k < N; k++) {
        var l = k === 0 ? inner0 : Math.round(inner0 + k * pitch) + bestT + gapW + 1;
        var r2 = k === N - 1 ? inner1 : Math.round(inner0 + (k + 1) * pitch) + bestT - gapW - 1;
        if (r2 < l) { var mid = (l + r2) >> 1; l = mid; r2 = mid; }
        bounds.push([Math.max(0, l), Math.min(n - 1, r2)]);
      }
      out.push({ count: N, pitch: pitch, score: bestLine * 2 + centerScore, cellBounds: bounds });
    }
    return out;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[s.length >> 1];
  }

  // 主入口：从图像恢复索引矩阵
  // 返回 {cols,rows,cells,confidence, diagnostics}
  function recover(img, opts) {
    opts = opts || {};
    var b = findBounds(img);
    if (!b) return { ok: false, reason: "找不到图样区域（与底色差异不足）。" };

    var g = estimateGrid(img, b);
    var w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    if (opts.hintCols) g.cols = opts.hintCols;
    if (opts.hintRows) g.rows = opts.hintRows;
    if (opts.hintCols || opts.hintRows) {
      var lead = g.innerX0, trail = w - 1 - g.innerX1;
      var innerW = w - lead - trail, pX = innerW / g.cols;
      g.boundsX = [];
      for (var kx = 0; kx < g.cols; kx++)
        g.boundsX.push([Math.round(lead + kx * pX), Math.round(lead + (kx + 1) * pX) - 1]);
      var leadY = g.innerY0, trailY = h - 1 - g.innerY1;
      var innerH = h - leadY - trailY, pY = innerH / g.rows;
      g.boundsY = [];
      for (var ky = 0; ky < g.rows; ky++)
        g.boundsY.push([Math.round(leadY + ky * pY), Math.round(leadY + (ky + 1) * pY) - 1]);
    }

    var cells = new Array(g.cols * g.rows).fill(0);
    var margins = [];

    for (var cy = 0; cy < g.rows; cy++) {
      var by = g.boundsY[cy] || [g.innerY0, g.innerY0];
      for (var cx = 0; cx < g.cols; cx++) {
        var bx = g.boundsX[cx] || [g.innerX0, g.innerX0];
        // 采样窗严格限制在本格可见区间内部，绝不越过格缝/外框
        var wx = Math.max(1, Math.floor((bx[1] - bx[0]) * 0.28));
        var wy = Math.max(1, Math.floor((by[1] - by[0]) * 0.28));
        var ccx = (bx[0] + bx[1]) / 2, ccy = (by[0] + by[1]) / 2;
        var x0 = Math.round(ccx - wx), x1 = Math.round(ccx + wx);
        var y0 = Math.round(ccy - wy), y1 = Math.round(ccy + wy);
        var r = 0, gg = 0, bl = 0, nn = 0;
        for (var yy = y0; yy <= y1; yy++) {
          for (var xx = x0; xx <= x1; xx++) {
            var ax = b.x0 + xx, ay = b.y0 + yy;
            if (ax < 0 || ay < 0 || ax >= img.width || ay >= img.height) continue;
            var i = (ay * img.width + ax) * 4;
            r += img.data[i]; gg += img.data[i + 1]; bl += img.data[i + 2]; nn++;
          }
        }
        if (!nn) continue;
        r = r / nn; gg = gg / nn; bl = bl / nn;
        var idx = WM.nearestIndex(r | 0, gg | 0, bl | 0);
        cells[cy * g.cols + cx] = idx;
        var pr = WM.PALETTE_RGB[idx], dd = Math.hypot(r - pr[0], gg - pr[1], bl - pr[2]);
        margins.push(Math.max(0, 1 - dd / 180));
      }
    }
    var conf = margins.length ? margins.reduce(function (a, x) { return a + x; }, 0) / margins.length : 0;
    var spanX = (g.innerX1 - g.innerX0 + 1) / g.cols, spanY = (g.innerY1 - g.innerY0 + 1) / g.rows;
    return {
      ok: g.cols >= 6 && g.rows >= 6,
      cols: g.cols, rows: g.rows, cells: cells,
      confidence: Math.round(conf * 100) / 100,
      bounds: b, pitchX: Math.round(spanX * 10) / 10, pitchY: Math.round(spanY * 10) / 10
    };
  }

  // 一体化：图像 -> 矩阵 -> 水印核验（records 为登记册）
  function verifyImage(img, records, nowYM, opts) {
    var recov = recover(img, opts);
    if (!recov.ok) return { status: "unknown", reasons: [recov.reason], recover: recov };
    var v = WM.verify(recov.cells, recov.cols, recov.rows, records, nowYM);
    v.recover = { ok: true, cols: recov.cols, rows: recov.rows, confidence: recov.confidence, pitchX: recov.pitchX, pitchY: recov.pitchY };
    return v;
  }

  /* ============================ DOM 适配 ============================ */

  function toCanvas(img, docObj) {
    if (typeof document === "undefined") throw new Error("需要浏览器环境");
    var cv = (docObj || document).createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    var ctx = cv.getContext("2d");
    var id = ctx.createImageData(img.width, img.height);
    id.data.set(img.data);
    ctx.putImageData(id, 0, 0);
    return cv;
  }
  function fromCanvas(canvas) {
    var ctx = canvas.getContext("2d");
    var id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var r = new Raster(canvas.width, canvas.height);
    r.data.set(id.data);
    return r;
  }

  // 测试辅助：在格心矩形区域涂黑（模拟物理涂抹/污损照片）
  function smudgeRect(img, x0, y0, w, h, rgb) {
    rgb = rgb || [30, 27, 24];
    for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      var i = (y * img.width + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
    return img;
  }

  return {
    Raster: Raster, render: render,
    crop: crop, scale: scale, scaleBy: scaleBy,
    rot90CW: rot90CW, rot90CCW: rot90CCW, rot180: rot180, flipH: flipH, flipV: flipV,
    quantize: quantize, addNoise: addNoise, smudgeRect: smudgeRect,
    findBounds: findBounds, estimateGrid: estimateGrid, recover: recover, verifyImage: verifyImage,
    toCanvas: toCanvas, fromCanvas: fromCanvas,
    FRAME: FRAME, PAPER: PAPER
  };
});
