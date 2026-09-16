/*!
 * watermark.js — 离线版权水印与溯源核验核心算法（与页面完全分离）
 *
 * 载体模型
 *  - 网格本身即水印。43 位载荷（魔数/作者编号/授权范围/有效期）编成 126 位
 *    系统码：43 位系统位（前 43 格）+ 83 位 GF(2) 稀疏 XOR 校验位。
 *    最多可在 83 个码位无票（擦除）时解出全部载荷；码位按伪随机顺序散布
 *    在 2×2 满铺块里，重复块按多数表决汇总（还能纠正个别改色）。
 *  - 嵌入只在每个 2×2 块内部重排“明/暗”两类颜色：块内暗色格数不变，
 *    全局每种色线数量“一格不差”。明暗按亮度门限分两簇，抗颜色量化。
 *  - 块布局是尺寸与相位的确定性函数，与图案内容无关：改坏一块不会让
 *    后续块的符号错位，盲检测可直接重建布局。
 *
 * 几何恢复
 *  - 旋转/翻转：穷举二面体群 8 个朝向。
 *  - 裁切：候选原尺寸 × 偏移 × 4 种块相位，按扩边量从小到大搜索。
 *  - 缩放/颜色量化：由光栅层（raster.js）先还原为索引矩阵，再进入同一核验。
 *
 * UMD：浏览器 window.WM；Node require('./js/watermark.js')。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ============================== 常量 ============================== */

  var PALETTE = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437",
                 "#355b38", "#713d7b", "#1e1b18", "#e98c52"];
  var PALETTE_RGB = PALETTE.map(hexToRgb);
  var LUMA = PALETTE_RGB.map(function (c) {
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  });
  var DARK_GATE = 0.35;
  function isDarkIndex(i) { return LUMA[i] < DARK_GATE; }

  var MAGIC = 0xA6;
  var DATA_BITS = 43;
  var PARITY_BITS = 83;
  var CW_BITS = DATA_BITS + PARITY_BITS; // 126
  var SYMBOLS = CW_BITS / 2;              // 63 个 2 位符号
  var MAX_COLS = 36, MAX_ROWS = 32, MIN_SIDE = 6;
  var MIN_USABLE = 48;     // 可用块下限（不足 63 时，缺票位由 83 个校验方程补解）
  var CROP_MARGIN = 6;
  var HYPOTHESIS_BUDGET = 16000;
  var SUPPORT_MIN = 0.90;
  var ERASURE_RATE_MAX = 0.30;
  var UNKNOWN_MAX = 83;
  var MIN_USED_BLOCKS = 28;

  /* ============================== 工具 ============================== */

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fnvSeed(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function pushBits(arr, value, n) {
    for (var i = n - 1; i >= 0; i--) arr.push((value >>> i) & 1);
  }
  function readBits(bits, offset, n) {
    var v = 0;
    for (var i = 0; i < n; i++) v = (v << 1) | bits[offset + i];
    return v >>> 0;
  }
  function colorCounts(cells) {
    var m = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < cells.length; i++) m[cells[i]]++;
    return m;
  }
  function sameCounts(a, b) {
    var ca = colorCounts(a), cb = colorCounts(b);
    for (var i = 0; i < 8; i++) if (ca[i] !== cb[i]) return false;
    return true;
  }

  /* ============================ SHA-256 ============================ */

  var K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  function sha256Bytes(bytes) {
    var H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    var bitLen = bytes.length * 8, withPad = (((bytes.length + 8) >> 6) + 1) * 64;
    var buf = new Uint8Array(withPad);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    var hv = (bitLen / 0x100000000) >>> 0, lo = bitLen >>> 0;
    buf[withPad-8]=(hv>>>24)&0xff;buf[withPad-7]=(hv>>>16)&0xff;buf[withPad-6]=(hv>>>8)&0xff;buf[withPad-5]=hv&0xff;
    buf[withPad-4]=(lo>>>24)&0xff;buf[withPad-3]=(lo>>>16)&0xff;buf[withPad-2]=(lo>>>8)&0xff;buf[withPad-1]=lo&0xff;
    var w = new Uint32Array(64);
    for (var off = 0; off < withPad; off += 64) {
      for (var i = 0; i < 16; i++)
        w[i] = (buf[off+4*i]<<24)|(buf[off+4*i+1]<<16)|(buf[off+4*i+2]<<8)|buf[off+4*i+3];
      for (i = 16; i < 64; i++) {
        var s0=((w[i-15]>>>7)|(w[i-15]<<25))^((w[i-15]>>>18)|(w[i-15]<<14))^(w[i-15]>>>3);
        var s1=((w[i-2]>>>17)|(w[i-2]<<15))^((w[i-2]>>>19)|(w[i-2]<<13))^(w[i-2]>>>10);
        w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
      }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (i = 0; i < 64; i++) {
        var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
        var t1=(h+S1+((e&f)^(~e&g))+K[i]+w[i])>>>0;
        var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
        var t2=(S0+((a&b)^(a&c)^(b&c)))>>>0;
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      for (i=0;i<8;i++) H[i]=(H[i]+[a,b,c,d,e,f,g,h][i])>>>0;
    }
    var hex = "";
    for (i = 0; i < 8; i++) hex += ("00000000" + H[i].toString(16)).slice(-8);
    return hex;
  }
  function sha256Ascii(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return sha256Bytes(bytes);
  }

  /* ============================== 指纹/日期 ============================== */

  function fingerprint(cells, cols, rows) {
    return sha256Ascii("zfl31|v2|" + cols + "x" + rows + "|" + cells.join(","));
  }
  function fingerprintTag(fp) { return parseInt(fp.slice(0, 2), 16) & 0xff; }
  function monthIndex(ym) {
    var p = ym.split("-").map(Number);
    return (p[0] - 2000) * 12 + (p[1] - 1);
  }
  function ymOf(idx) {
    var y = 2000 + Math.floor(idx / 12), m = (idx % 12) + 1;
    return y + "-" + (m < 10 ? "0" + m : m);
  }
  function currentYM(now) {
    var d = now || new Date(), m = d.getMonth() + 1;
    return d.getFullYear() + "-" + (m < 10 ? "0" + m : m);
  }
  var SCOPE_TEXT = ["未知","个人留存","非营利展示","教学使用","内部织造","商用授权","独占授权","禁止使用"];

  /* ====================== GF(2) 系统外码 (126,43) ====================== */
  // 校验位 j = XOR 若干系统位（确定性伪随机稀疏连接，每行 5..8 个数据位）。

  var PARITY_PLAN = (function () {
    var rng = mulberry32(fnvSeed("zfl31-linear-parity-v2"));
    var plan = [];
    for (var j = 0; j < PARITY_BITS; j++) {
      var deg = 5 + Math.floor(rng() * 4);
      var set = {};
      while (Object.keys(set).length < deg) set[(rng() * DATA_BITS) | 0] = true;
      plan.push(Object.keys(set).map(Number));
    }
    return plan;
  })();

  function encodeData(info) {
    var b = [];
    pushBits(b, MAGIC, 8);
    pushBits(b, info.author & 0x7fff, 15);
    pushBits(b, info.scope & 0x7, 3);
    pushBits(b, monthIndex(info.startYM) & 0x7ff, 11);
    pushBits(b, info.months & 0x3f, 6);
    return b;
  }

  function encodeCodeword(data43) {
    var cw = data43.slice();
    for (var j = 0; j < PARITY_BITS; j++) {
      var x = 0;
      for (var k = 0; k < PARITY_PLAN[j].length; k++) x ^= data43[PARITY_PLAN[j][k]];
      cw.push(x);
    }
    return cw;
  }

  function decodeData(d) {
    var magic = readBits(d, 0, 8), start = readBits(d, 26, 11), months = readBits(d, 37, 6), scope = readBits(d, 23, 3);
    return {
      magic: magic, magicOk: magic === MAGIC,
      author: readBits(d, 8, 15),
      scope: scope, scopeText: SCOPE_TEXT[scope] || "未知",
      startIdx: start, startYM: ymOf(start), months: months,
      endYM: months > 0 ? ymOf(start + months - 1) : null
    };
  }

  var FIELD_RANGES = { magic: [0, 8], author: [8, 15], scope: [23, 3], start: [26, 11], months: [37, 6] };

  // 已知系统位直接给出字段确定性；未知时由解的秩/自由位判断（见 tryDecode）。
  function fieldsKnownByData(dataKnown) {
    var out = { all: dataKnown };
    Object.keys(FIELD_RANGES).forEach(function (k) {
      var r = FIELD_RANGES[k], ok = true;
      for (var i = r[0]; i < r[0] + r[1]; i++) if (!dataKnown[i]) { ok = false; break; }
      out[k] = ok;
    });
    return out;
  }

  /* ============================== 块布局 ============================== */

  var layoutCache = {};
  function blockLayout(cols, rows, px, py) {
    px = px || 0; py = py || 0;
    var key = cols * 10000 + rows * 100 + px * 10 + py;
    if (layoutCache[key]) return layoutCache[key];
    var anchors = [];
    for (var y = py; y + 1 < rows; y += 2)
      for (var x = px; x + 1 < cols; x += 2) anchors.push([x, y]);
    var n = anchors.length, order = [];
    for (var i = 0; i < n; i++) order.push(i);
    var rng = mulberry32(fnvSeed("zfl31-blocks-v2|" + cols + "x" + rows + "|" + px + py));
    for (i = n - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    var blocks = new Array(n);
    for (var k = 0; k < n; k++) {
      var ax = anchors[order[k]][0], ay = anchors[order[k]][1], a = ay * cols + ax;
      blocks[k] = { x: ax, y: ay, cells: [a, a + 1, a + cols, a + cols + 1] };
    }
    layoutCache[key] = blocks;
    return blocks;
  }
  function anchorsInView(c, r, px, py, oriC, oriR, dx, dy) {
    var x0 = Math.max(px, dx), x1 = Math.min(c - 2, dx + oriC - 2);
    var y0 = Math.max(py, dy), y1 = Math.min(r - 2, dy + oriR - 2);
    if (x1 < x0 || y1 < y0) return 0;
    var nx = Math.floor((x1 - px) / 2) - Math.floor((x0 - 1 - px) / 2);
    var ny = Math.floor((y1 - py) / 2) - Math.floor((y0 - 1 - py) / 2);
    return Math.max(0, nx) * Math.max(0, ny);
  }
  function darkCount(cells, block) {
    var d = 0;
    for (var i = 0; i < 4; i++) if (isDarkIndex(cells[block.cells[i]])) d++;
    return d;
  }

  var PAIR_COMBOS = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  function symbolSlots(d, value) {
    var dark = [];
    if (d === 1) dark = [value];
    else if (d === 3) dark = [0,1,2,3].filter(function (s) { return s !== value; });
    else dark = PAIR_COMBOS[value];
    var isDark = [false,false,false,false];
    dark.forEach(function (s) { isDark[s] = true; });
    return isDark;
  }
  function readSymbol(d, darkMask) {
    var dark = [];
    for (var s = 0; s < 4; s++) if (darkMask[s]) dark.push(s);
    if (dark.length !== d) return -1;
    if (d === 1) return dark[0];
    if (d === 3) return [0,1,2,3].filter(function (s) { return dark.indexOf(s) < 0; })[0];
    if (d === 2) {
      for (var v = 0; v < 6; v++) {
        var c = PAIR_COMBOS[v];
        if (dark[0] === c[0] && dark[1] === c[1]) return v;
      }
    }
    return -1;
  }

  /* ============================== 容量/嵌入 ============================== */

  function capacity(cols, rows, cells) {
    if (cols < MIN_SIDE || rows < MIN_SIDE || cols > MAX_COLS || rows > MAX_ROWS ||
        !cells || cells.length !== cols * rows) {
      return { ok: false, reason: "dimensions", usable: 0, minVotes: 0 };
    }
    var blocks = blockLayout(cols, rows, 0, 0), usable = 0;
    for (var j = 0; j < blocks.length; j++) {
      var d = darkCount(cells, blocks[j]);
      if (d >= 1 && d <= 3) usable++;
    }
    if (usable < MIN_USABLE) {
      return {
        ok: false, reason: "capacity", usable: usable,
        hint: "图案过素或网格过小：可用 2×2 块 " + usable + " 个（至少 " + MIN_USABLE +
          "）。建议网格不小于 16×14，并让明暗色线交错覆盖约一半以上格点。"
      };
    }
    // 块数 ≥63 时所有符号都有位置；<63 时缺票符号由校验方程解出。
    return { ok: true, blocks: blocks, usable: usable, minVotes: (usable / SYMBOLS) | 0 };
  }

  function embed(cells, cols, rows, info) {
    var cap = capacity(cols, rows, cells);
    if (!cap.ok) return { ok: false, reason: cap.reason, hint: cap.hint, usable: cap.usable, minVotes: cap.minVotes };
    var fp = fingerprint(cells, cols, rows);
    var meta = {
      author: info.author & 0x7fff, scope: info.scope & 0x7,
      startYM: info.startYM, months: info.months & 0x3f
    };
    var code = encodeCodeword(encodeData(meta));
    var out = cells.slice(), blocks = cap.blocks, usedBlocks = 0, changedCells = 0;

    for (var j = 0; j < blocks.length; j++) {
      var blk = blocks[j], d = darkCount(cells, blk);
      if (d < 1 || d > 3) continue;
      var value = (code[2 * (j % SYMBOLS)] << 1) | code[2 * (j % SYMBOLS) + 1];
      var slotDark = symbolSlots(d, value);
      var oldDark = [], oldLight = [];
      for (var s = 0; s < 4; s++)
        (isDarkIndex(cells[blk.cells[s]]) ? oldDark : oldLight).push(cells[blk.cells[s]]);
      var di = 0, li = 0;
      for (s = 0; s < 4; s++) {
        var nv = slotDark[s] ? oldDark[di++] : oldLight[li++];
        if (out[blk.cells[s]] !== nv) changedCells++;
        out[blk.cells[s]] = nv;
      }
      usedBlocks++;
    }

    var selfVote = voteHypothesis(out, cols, rows, cols, rows, 0, 0, 0, 0);
    if (!sameCounts(cells, out) || !selfVote.data || selfVote.data.author !== meta.author ||
        selfVote.data.scope !== meta.scope || selfVote.data.startYM !== meta.startYM ||
        selfVote.data.months !== meta.months) {
      return { ok: false, reason: "selfcheck", hint: "嵌入自检未通过，原方案未被改动。" };
    }
    var fpWm = fingerprint(out, cols, rows);
    return {
      ok: true, cells: out, codeword: code, blocks: blocks,
      usedBlocks: usedBlocks, changedCells: changedCells, minVotes: cap.minVotes,
      fingerprint: fp, fpWm: fpWm, tag: fingerprintTag(fp), meta: meta
    };
  }

  /* ====================== GF(2) 擦除求解（BigInt） ====================== */

  // raw/known/conf：126 个码位的多数表决值、有票表、逐位余量。
  // 处理顺序：无票位用校验方程补解（GF(2) 高斯消元）；若仍有少量“错票”，
  // 按余量最低的已知位做小范围翻位重试，最多纠正 2 个错票位。
  function tryDecode(raw, known, conf) {
    // 快筛：魔数多数表决错太多位时，任何单位翻转都救不回（非水印/严重破坏）
    var rawMagicWrong = 0;
    for (var mi2 = 0; mi2 < 8; mi2++)
      if (known[mi2] && raw[mi2] !== ((MAGIC >>> (7 - mi2)) & 1)) rawMagicWrong++;
    var unknownCw = 0;
    for (mi2 = 0; mi2 < CW_BITS; mi2++) if (!known[mi2]) unknownCw++;

    function attempt(flipSet) {
      var raw2 = raw.slice();
      flipSet.forEach(function (p) { raw2[p] ^= 1; });
      return solveOnce(raw2, known);
    }
    var first = attempt([]);
    if (first.ok && first.decoded && first.decoded.magicOk) return finalize(first, []);
    if (rawMagicWrong > 3) return failResult(countUnknown(known));
    // 裁切重裁（无票位多）时不做翻位搜索：改色的重裁样本按无解处理
    if (unknownCw > 16) {
      if (first.ok) return finalize(first, []);
      return failResult(countUnknown(known));
    }

    // 翻位纠错：一个被改色的块恰好翻转某码位。候选顺序：
    // 低余位（单票/分歧）→ 数据位（篡改常落在有重复块的信息位）。
    var weak = [];
    for (var i = 0; i < CW_BITS; i++) if (known[i] && conf[i] < 1) weak.push(i);
    weak.sort(function (a, b) { return conf[a] - conf[b]; });
    var dataCands = [];
    for (i = 0; i < DATA_BITS; i++) if (known[i] && conf[i] >= 1 && weak.indexOf(i) < 0) dataCands.push(i);
    var pool = weak.slice(0, 10).concat(dataCands);

    var good = [];
    for (var a = 0; a < pool.length; a++) {
      var r1 = attempt([pool[a]]);
      if (r1.ok && r1.decoded && r1.decoded.magicOk && (r1.violations || 0) <= 1) {
        r1.flipped = [pool[a]]; good.push(r1);
      }
    }
    if (!good.length) {
      // 双位翻转（仅在低余位范围内尝试，控制开销）
      for (a = 0; a < weak.slice(0, 10).length; a++) {
        for (var b = a + 1; b < weak.slice(0, 10).length; b++) {
          var r2 = attempt([weak[a], weak[b]]);
          if (r2.ok && r2.decoded && r2.decoded.magicOk) { r2.flipped = [weak[a], weak[b]]; good.push(r2); }
        }
      }
    }
    if (good.length) {
      good.sort(function (x, y) { return (x.violations || 0) - (y.violations || 0); });
      return finalize(good[0], good[0].flipped);
    }
    if (first.ok) return finalize(first, []);
    return failResult(countUnknown(known));

    function finalize(res, flipped) {
      if (flipped && flipped.length) res.corrected = true;
      res.correctedVotes = flipped ? flipped.length : 0;
      return res;
    }
  }
  function countUnknown(known) {
    var n = 0;
    for (var i = 0; i < known.length; i++) if (!known[i]) n++;
    return n;
  }

  function solveOnce(raw, known) {
    var dataKnown = new Array(DATA_BITS);
    for (var i = 0; i < DATA_BITS; i++) dataKnown[i] = !!known[i];
    var unknownData = [];
    for (i = 0; i < DATA_BITS; i++) if (!known[i]) unknownData.push(i);

    // 已知魔数位可错至多 1 位（单错票由校验方程与多数表决交叉纠正）
    var mm = 0;
    for (var mb = 0; mb < 8; mb++) if (known[mb] && raw[mb] !== ((MAGIC >>> (7 - mb)) & 1)) mm++;
    if (mm > 2) return failResult(unknownData.length);

    // 建立关于未知系统位 x 的校验方程：plan 内已知位贡献 rhs，未知位贡献系数。
    var rows = [];
    function addRow(mask, b) { rows.push({ mask: mask, b: b }); }
    for (var j = 0; j < PARITY_BITS; j++) {
      var cwIdx = DATA_BITS + j, mask = 0n, b = 0;
      var plan = PARITY_PLAN[j];
      for (var k2 = 0; k2 < plan.length; k2++) {
        var di = plan[k2];
        if (known[di]) b ^= raw[di];
        else {
          var u = unknownData.indexOf(di);
          mask |= (1n << BigInt(u));
        }
      }
      if (known[cwIdx]) b ^= raw[cwIdx]; // 移到 rhs
      else { /* 校验位本身未知：方程不增加约束，跳过 */ }
      if (!known[cwIdx]) continue;
      addRow(mask, b);
    }
    // 魔数硬约束（已知位无需方程；未知魔数位给单位行）
    for (mb = 0; mb < 8; mb++) {
      if (known[mb]) continue;
      addRow(1n << BigInt(unknownData.indexOf(mb)), (MAGIC >>> (7 - mb)) & 1);
    }

    var u = unknownData.length;
    var solved = {}; // dataIndex -> value
    var freeUnknown = unknownData.slice();
    if (u > 0) {
      // 高斯消元（BigInt 系数，位 0..u-1，rhs 单独存）
      var M = rows.map(function (r) { return { m: r.mask, b: r.b }; });
      var pivotRow = {};
      var pr = 0;
      for (var col = 0; col < u; col++) {
        var bit = 1n << BigInt(col), sel = -1;
        for (var rr = pr; rr < M.length; rr++) if (M[rr].m & bit) { sel = rr; break; }
        if (sel < 0) continue;
        var tmp = M[pr]; M[pr] = M[sel]; M[sel] = tmp;
        for (rr = 0; rr < M.length; rr++) {
          if (rr !== pr && (M[rr].m & bit)) { M[rr].m ^= M[pr].m; M[rr].b ^= M[pr].b; }
        }
        pivotRow[col] = pr;
        pr++;
      }
      for (rr = 0; rr < M.length; rr++) {
        if (M[rr].m === 0n && M[rr].b) return failResult(u); // 矛盾
      }
      // 回代（RREF 已消去其他行的主元列；主元行可能含自由位列）
      for (col = u - 1; col >= 0; col--) {
        if (pivotRow[col] === undefined) continue;
        var row = M[pivotRow[col]], val = row.b;
        var mm2 = row.m;
        for (var cc = col + 1; cc < u; cc++) if ((mm2 >> BigInt(cc)) & 1n) val ^= (solved[unknownData[cc]] || 0);
        solved[unknownData[col]] = val;
      }
      freeUnknown = unknownData.filter(function (di) { return solved[di] === undefined; });
    }

    var data = new Array(DATA_BITS);
    var inferredCount = 0;
    for (i = 0; i < DATA_BITS; i++) {
      if (known[i]) data[i] = raw[i];
      else if (solved[i] !== undefined) { data[i] = solved[i]; inferredCount++; dataKnown[i] = true; }
      else { data[i] = 0; dataKnown[i] = false; }
    }

    // 校验完整码字一致性（解出的数据重新算校验位，与已知校验位核对）
    var cw = encodeCodeword(data);
    var violations = 0;
    for (j = 0; j < CW_BITS; j++) if (known[j] && raw[j] !== cw[j]) violations++;
    if (violations > 2) return failResult(u); // 0..2 个错票交给 tryDecode 翻位纠正

    var dec = decodeData(data);
    if (!dec.magicOk) return failResult(u);

    // 自由位（欠定）：逐字段判断其所有可能取值是否一致
    var fieldConf = fieldsKnownByData(dataKnown);
    if (freeUnknown.length > 0 && freeUnknown.length <= 3) {
      var frees = freeUnknown, firstSig = null, stable = { author: true, scope: true, start: true, months: true };
      for (var fa = 0; fa < (1 << frees.length); fa++) {
        var d2 = data.slice();
        frees.forEach(function (di, z) { d2[di] = (fa >> z) & 1; });
        var dd = decodeData(d2);
        var sig = [dd.author, dd.scope, dd.startIdx, dd.months];
        if (firstSig === null) firstSig = sig;
        else {
          if (sig[0] !== firstSig[0]) stable.author = false;
          if (sig[1] !== firstSig[1]) stable.scope = false;
          if (sig[2] !== firstSig[2]) stable.start = false;
          if (sig[3] !== firstSig[3]) stable.months = false;
        }
      }
      fieldConf.author = fieldConf.author && stable.author;
      fieldConf.scope = fieldConf.scope && stable.scope;
      fieldConf.start = fieldConf.start && stable.start;
      fieldConf.months = fieldConf.months && stable.months;
    }
    if (freeUnknown.length > 3) {
      fieldConf = { magic: fieldConf.magic, author: false, scope: false, start: false, months: false, all: false };
    }

    return {
      ok: true, bits: cw, data: data, decoded: dec,
      clean: inferredCount === 0 && freeUnknown.length === 0 && violations === 0,
      inferred: inferredCount, freeCount: freeUnknown.length,
      fieldConfident: fieldConf, dataKnown: dataKnown,
      underdetermined: freeUnknown.length > 0, violations: violations
    };
  }

  function failResult(u) {
    return {
      ok: false, bits: null, data: null, decoded: null,
      clean: false, inferred: u, underdetermined: false
    };
  }

  /* ========================= 8 朝向 + 投票 ========================= */

  function orientations(obs, oc, or) {
    function rotCW(m, c, r) {
      var n = new Array(r * c).fill(-1);
      for (var y = 0; y < r; y++) for (var x = 0; x < c; x++) n[x * r + (r - 1 - y)] = m[y * c + x];
      return { c: r, r: c, m: n };
    }
    function flipH(m, c, r) {
      var n = new Array(c * r).fill(-1);
      for (var y = 0; y < r; y++) for (var x = 0; x < c; x++) n[y * c + (c - 1 - x)] = m[y * c + x];
      return { c: c, r: r, m: n };
    }
    var out = [], cur = { c: oc, r: or, m: obs.slice() };
    for (var i = 0; i < 4; i++) { out.push(cur); cur = rotCW(cur.m, cur.c, cur.r); }
    cur = flipH(obs.slice(), oc, or);
    for (i = 0; i < 4; i++) { out.push(cur); cur = rotCW(cur.m, cur.c, cur.r); }
    return out;
  }

  function voteHypothesis(oriM, oriC, oriR, c, r, dx, dy, px, py) {
    var blocks = blockLayout(c, r, px, py);
    var votes = [];
    for (var i = 0; i < CW_BITS; i++) votes.push([]);
    var used = 0, missing = 0, erased = 0, blocksTotal = blocks.length;

    function at(x, y) {
      if (x < dx || y < dy || x >= dx + oriC || y >= dy + oriR) return -1;
      return oriM[(y - dy) * oriC + (x - dx)];
    }
    for (var j = 0; j < blocks.length; j++) {
      var blk = blocks[j], sx = blk.x, sy = blk.y;
      var coords = [[sx,sy],[sx+1,sy],[sx,sy+1],[sx+1,sy+1]];
      var vals = [], complete = true;
      for (var q = 0; q < 4; q++) {
        var v = at(coords[q][0], coords[q][1]);
        if (v < 0) { complete = false; break; }
        vals.push(v);
      }
      if (!complete) { missing++; continue; }
      var d = 0, mask = [false,false,false,false];
      for (q = 0; q < 4; q++) if (isDarkIndex(vals[q])) { d++; mask[q] = true; }
      if (d < 1 || d > 3) continue;
      var sym = readSymbol(d, mask);
      if (sym < 0 || sym > 3) { erased++; continue; }
      votes[2 * (j % SYMBOLS)].push((sym >> 1) & 1);
      votes[2 * (j % SYMBOLS) + 1].push(sym & 1);
      used++;
    }

    var raw = new Array(CW_BITS), conf = new Array(CW_BITS), known = new Array(CW_BITS);
    var minMargin = 1, unanimous = true, unknownBits = 0, disagreeBits = 0;
    for (i = 0; i < CW_BITS; i++) {
      var ones = 0;
      for (var z = 0; z < votes[i].length; z++) ones += votes[i][z];
      var total = votes[i].length;
      if (total === 0) { raw[i] = 0; conf[i] = 0; known[i] = false; unknownBits++; minMargin = 0; unanimous = false; continue; }
      known[i] = true;
      var zero = total - ones;
      raw[i] = ones >= zero ? 1 : 0;
      conf[i] = Math.max(ones, zero) / total;
      if (Math.min(ones, zero) > 0) { unanimous = false; disagreeBits++; }
      minMargin = Math.min(minMargin, conf[i]);
    }

    var dec = tryDecode(raw, known, conf);
    // 支持度：全部选票中与“多数表决位”（而非解码重算位）一致的比例
    var support = 0, supportTotal = 0;
    for (i = 0; i < CW_BITS; i++)
      for (z = 0; z < votes[i].length; z++) { supportTotal++; if (votes[i][z] === raw[i]) support++; }
    support = supportTotal ? support / supportTotal : 0;
    // 可信度：已知位取逐位余量；校验补解位按 0.6 折算，按信息权重汇总
    var confSum = 0, confWeight = 0;
    for (i = 0; i < DATA_BITS; i++) {
      confSum += known[i] ? conf[i] : 0.6;
      confWeight++;
    }
    var infoConf = confWeight ? confSum / confWeight : 0;
    var inView = blocksTotal - missing;
    var fk = dec.ok ? dec.fieldConfident : { magic:false, author:false, scope:false, start:false, months:false };
    // 字段全部可由“选票或校验方程”唯一确定（无自由位）即视为读得确定
    var fullyDetermined = dec.ok && dec.freeCount === 0 &&
      fk.author && fk.scope && fk.start && fk.months;
    return {
      c: c, r: r, dx: dx, dy: dy, px: px, py: py,
      bits: dec.bits, data: dec.decoded, rawBits: raw, known: known,
      conf: conf,
      cleanCode: dec.ok && dec.inferred === 0 && !dec.corrected,
      fullyDetermined: fullyDetermined,
      corrected: dec.ok && (dec.corrected === true), voteCorrections: dec.correctedVotes || 0,
      inferred: dec.inferred,
      underdetermined: dec.ok && dec.underdetermined, freeCount: dec.freeCount || 0,
      doubleError: !dec.ok, magicOk: !!(dec.decoded && dec.decoded.magicOk),
      usedBlocks: used, missingBlocks: missing, erasedBlocks: erased, blocksTotal: blocksTotal,
      unknownBits: unknownBits, disagreeBits: disagreeBits,
      minMargin: minMargin, unanimous: unanimous,
      coverage: inView ? (used + erased) / inView : 0,
      support: support, infoConf: infoConf, fieldKnown: fk, usableAvailable: used
    };
  }

  /* ============================== 盲检测 ============================== */

  function searchOrientation(ori, oi, state, fullOnly) {
    function acceptable(h) {
      if (!(h.data && h.data.magicOk) || h.doubleError) return false;
      if ((h.support || 0) < SUPPORT_MIN) return false;
      if (h.unknownBits > UNKNOWN_MAX) return false;
      if (h.usedBlocks < MIN_USED_BLOCKS) return false;
      var seen = h.usedBlocks + h.erasedBlocks;
      if (seen && h.erasedBlocks / seen > ERASURE_RATE_MAX) return false;
      return true;
    }
    function consider(h) {
      h.orientation = oi;
      if (acceptable(h)) {
        var s = scoreHyp(h);
        if (!state.best || s.score > state.best.score) state.best = s;
      } else if (h.coverage >= 0.5 || h.usableAvailable >= SYMBOLS) {
        var sn = scoreHyp(h);
        if (!state.bestNear || sn.score > state.bestNear.score) state.bestNear = sn;
      }
    }
    function voted(c, r, dx, dy) {
      state.budget++;
      for (var ph = 0; ph < 4; ph++) {
        if (anchorsInView(c, r, ph & 1, (ph >> 1) & 1, ori.c, ori.r, dx, dy) < MIN_USED_BLOCKS) continue;
        consider(voteHypothesis(ori.m, ori.c, ori.r, c, r, dx, dy, ph & 1, (ph >> 1) & 1));
      }
    }

    voted(ori.c, ori.r, 0, 0);
    var b = state.best;
    if (b && b.orientation === oi && b.fullyDetermined &&
        b.erasedBlocks === 0 && b.support >= 0.99 && b.missingBlocks === 0) {
      return "strong";
    }
    if (fullOnly) return "ok";

    var cMin = Math.max(MIN_SIDE, ori.c - CROP_MARGIN), cMax = Math.min(MAX_COLS, ori.c + CROP_MARGIN);
    var rMin = Math.max(MIN_SIDE, ori.r - CROP_MARGIN), rMax = Math.min(MAX_ROWS, ori.r + CROP_MARGIN);
    var maxDelta = (cMax - ori.c) + (rMax - ori.r);
    for (var delta = 1; delta <= maxDelta; delta++) {
      for (var c = cMin; c <= cMax; c++) {
        var dc = c - ori.c;
        if (dc < 0) continue;
        var dr = delta - dc, r = ori.r + dr;
        if (r < rMin || r > rMax || dr < 0) continue;
        var dxs = centeredOrder(dc, dc >> 1);
        for (var xi = 0; xi < dxs.length; xi++) {
          var dys = centeredOrder(dr, dr >> 1);
          for (var yi = 0; yi < dys.length; yi++) {
            voted(c, r, dxs[xi], dys[yi]);
            if (state.budget > HYPOTHESIS_BUDGET) return "budget";
            b = state.best;
            if (b && b.fullyDetermined && b.erasedBlocks === 0 &&
                b.support >= 0.99 && b.missingBlocks === 0) return "strong";
          }
        }
      }
    }
    return "ok";
  }

  function detect(obs, oc, or) {
    var oris = orientations(obs, oc, or);
    var state = { best: null, bestNear: null, budget: 0 };
    for (var oi = 0; oi < 8; oi++) if (searchOrientation(oris[oi], oi, state, true) === "strong") return finish(state.best);
    for (oi = 0; oi < 8; oi++) {
      var rc = searchOrientation(oris[oi], oi, state, false);
      if (rc === "strong") return finish(state.best);
      if (rc === "budget") break;
    }
    if (state.best) return finish(state.best);
    return { found: false, reasons: state.bestNear ? ["crc-fail"] : ["no-watermark"], bestNear: state.bestNear, budget: state.budget };
  }
  function centeredOrder(max, center) {
    var arr = [center], seen = {}; seen[center] = true;
    for (var d = 1; d <= max; d++) {
      if (center - d >= 0 && !seen[center - d]) { arr.push(center - d); seen[center - d] = true; }
      if (center + d <= max && !seen[center + d]) { arr.push(center + d); seen[center + d] = true; }
    }
    return arr;
  }
  function scoreHyp(h) {
    var avg = h.infoConf !== undefined ? h.infoConf : 0;
    var score = h.coverage * 6 + (h.support || 0) * 10 + avg + (h.unanimous ? 1 : 0) -
      0.05 * h.erasedBlocks - 0.1 * h.unknownBits + (h.cleanCode ? 5 : 0) +
      (h.data && h.data.magicOk ? 2 : 0);
    return Object.assign({}, h, { avgConf: avg, score: score });
  }
  function finish(h) {
    var strong = h.fullyDetermined && h.erasedBlocks === 0 &&
      (h.support || 0) >= 0.99 && h.missingBlocks === 0;
    return Object.assign({}, h, { found: true, strong: strong });
  }

  function rectify(obs, oc, or, det) {
    var oris = orientations(obs, oc, or), ori = oris[det.orientation];
    var out = new Array(det.c * det.r).fill(-1);
    for (var y = 0; y < ori.r; y++)
      for (var x = 0; x < ori.c; x++)
        out[(y + det.dy) * det.c + (x + det.dx)] = ori.m[y * ori.c + x];
    return { cells: out, cols: det.c, rows: det.r };
  }

  // 水印解码失败时的逐格回退比对：8 朝向 × 各登记记录 × 裁切偏移。
  // 返回最佳（记录、朝向、偏移、一致率、改格、缺格）；找不到高相似记录则 null。
  function fallbackCompare(cells, cols, rows, records) {
    var oris = orientations(cells, cols, rows);
    var best = null;
    var candidates = records.filter(function (r) { return r.wmCells && r.cols >= 6 && r.rows >= 6; });
    for (var oi = 0; oi < 8; oi++) {
      var ori = oris[oi];
      for (var ri = 0; ri < candidates.length; ri++) {
        var rec = candidates[ri];
        // 朝向 i 使观测尺寸变为 (ori.c, ori.r)；登记尺寸必须不小于观测，且每边最多大 CROP_MARGIN
        if (rec.cols < ori.c || rec.rows < ori.r) continue;
        if (rec.cols - ori.c > CROP_MARGIN || rec.rows - ori.r > CROP_MARGIN) continue;
        for (var dx = 0; dx <= rec.cols - ori.c; dx++) {
          for (var dy = 0; dy <= rec.rows - ori.r; dy++) {
            var same = 0, seen = 0, alt = [];
            var allowedMismatch = Math.ceil((ori.c * ori.r) * 0.12); // 早停：>12% 不同直接放弃
            for (var y = 0; y < ori.r; y++) {
              for (var x = 0; x < ori.c; x++) {
                var v = ori.m[y * ori.c + x];
                var p = (y + dy) * rec.cols + (x + dx);
                seen++;
                if (v === rec.wmCells[p]) same++;
                else {
                  alt.push({ x: x + dx, y: y + dy, from: rec.wmCells[p], to: v });
                  if (seen - same > allowedMismatch) { same = -1; break; }
                }
              }
              if (same < 0) break;
            }
            if (same < 0) continue;
            var ratio = seen ? same / seen : 0;
            if (ratio < 0.85) continue;
            if (!best || ratio > best.ratio) {
              var missing = rec.cols * rec.rows - seen;
              best = {
                record: rec, ratio: ratio, same: same, seen: seen,
                synthetic: {
                  found: true, c: rec.cols, r: rec.rows, dx: dx, dy: dy, px: 0, py: 0,
                  orientation: oi, data: {
                    magicOk: true, author: rec.author, scope: rec.scope,
                    scopeText: SCOPE_TEXT[rec.scope] || "未知", startIdx: monthIndex(rec.startYM),
                    startYM: rec.startYM, months: rec.months, endYM: rec.endYM
                  },
                  fieldKnown: { magic: true, author: false, scope: false, start: false, months: false },
                  conf: new Array(CW_BITS).fill(0), avgConf: ratio, infoConf: ratio,
                  support: ratio, coverage: seen / (rec.cols * rec.rows),
                  usedBlocks: seen, missingBlocks: missing, erasedBlocks: 0, blocksTotal: rec.cols * rec.rows / 4 | 0,
                  unknownBits: CW_BITS, disagreeBits: 0, minMargin: 0, unanimous: false,
                  cleanCode: false, fullyDetermined: false, corrected: true, inferred: CW_BITS,
                  freeCount: 0, underdetermined: true, doubleError: false, magicOk: true,
                  usableAvailable: seen, strong: false, fallback: true
                }
              };
            }
          }
        }
      }
    }
    return best;
  }

  /* ============================== 核验 ============================== */

  function verify(cells, cols, rows, records, nowYM) {
    var result = {
      status: "unknown", extracted: null, confidence: 0, perBit: null,
      record: null, term: null, altered: [], missing: [],
      reasons: [], rectified: null, detection: null
    };
    nowYM = nowYM || currentYM();
    var cap = capacity(cols, rows, cells), det = detect(cells, cols, rows);
    result.detection = det.found ? summarize(det) : null;

    // 回退路径：水印解不出（重度篡改/污损）时，仍以登记原方案为基准，
    // 在 8 朝向 × 全部可能裁切偏移上逐格比对——指纹级核验不依赖水印能否读出。
    var fallbackUsed = false, fb = null;
    if (!det.found && records && records.length) {
      fb = fallbackCompare(cells, cols, rows, records);
      if (fb) {
        det = fb.synthetic;
        fallbackUsed = true;
        result.detection = summarize(det);
      }
    }

    if (!det.found) {
      if (!cap.ok && cap.reason === "dimensions") result.reasons.push("尺寸超出可核验范围（" + cols + "×" + rows + "）。");
      else if (!cap.ok) result.reasons.push(cap.hint);
      (det.reasons || []).forEach(function (rr) {
        result.reasons.push({
          "crc-fail": "找到疑似水印布局，但表决结果无法通过魔数与校验（内容被大面积改写、污损或量化过重）。",
          "no-watermark": "未发现可通过校验的水印结构：可能未登记水印、裁切过重，或并非本排版台方案。"
        }[rr] || rr);
      });
      if (det.budget >= HYPOTHESIS_BUDGET) result.reasons.push("候选形变组合过多，已停止搜索；请提供更完整、清晰的图样。");
      return result;
    }

    var meta, fk;
    meta = det.data; fk = det.fieldKnown;
    result.extracted = {
      author: fk.author ? meta.author : null, authorRaw: meta.author, authorKnown: fk.author,
      scope: fk.scope ? meta.scope : null,
      scopeText: fk.scope ? meta.scopeText : "无法确认", scopeKnown: fk.scope,
      startYM: fk.start ? meta.startYM : null,
      endYM: (fk.start && fk.months) ? meta.endYM : null,
      months: fk.months ? meta.months : null,
      termKnown: fk.start && fk.months, magicOk: meta.magicOk
    };
    result.perBit = det.conf;
    result.confidence = Math.round(det.avgConf * 100) / 100;
    var cur = monthIndex(nowYM);
    if (fk.start && fk.months) result.term = termOf({ startYM: meta.startYM, months: meta.months, endYM: meta.endYM }, cur);
    else result.term = { text: "授权期限位读不全，无法确认", state: "unknown" };

    var rect = rectify(cells, cols, rows, det);
    result.rectified = rect;
    var match, rec;
    if (fallbackUsed) { match = { ratio: fb.ratio }; rec = fb.record; }
    else { match = matchRecord(records, meta, fk, det, rect); rec = match.record; }
    result.record = rec ? publicRecord(rec) : null;
    result.matchRatio = match.ratio;

    if (rec) {
      result.extracted.author = rec.author; result.extracted.authorFromRecord = !fk.author;
      result.extracted.scope = rec.scope; result.extracted.scopeText = SCOPE_TEXT[rec.scope] || "未知";
      result.extracted.scopeFromRecord = !fk.scope;
      result.extracted.startYM = rec.startYM; result.extracted.endYM = rec.endYM;
      result.extracted.months = rec.months; result.extracted.termFromRecord = !(fk.start && fk.months);
      result.term = termOf(rec, cur);
    }

    if (!rec) {
      // 同尺寸存在明显更相似的登记记录（阈值 0.6 远高于不同纹样的随机一致率），
      // 但水印作者对不上 => 内容被替换/套用（篡改）
      if (match.nearest && match.nearest.ratio >= 0.6 && fk.author) {
        result.status = "tampered";
        result.reasons.push("读出的作者编号 " + meta.author + " 与登记记录（作者 " +
          match.nearest.r.author + "）不符，且图样有 " + Math.round(match.nearest.ratio * 100) +
          "% 格点近似于登记原方案，疑似内容替换或水印套用，核验结果不会覆盖原方案。");
        return result;
      }
      result.status = "orphan";
      if (fk.author) result.reasons.push("水印可读出作者编号 " + meta.author +
        "，但本机登记册没有尺寸 " + det.c + "×" + det.r + " 的对应登记，无法确认作者与授权。");
      else result.reasons.push("只能确认存在本台水印（魔数通过），作者编号位读不全，登记册无法引导匹配。");
      if (!fk.scope) result.reasons.push("授权范围字段有缺失位，无法确认。");
      if (!fk.start || !fk.months) result.reasons.push("有效期字段有缺失位，无法确认。");
      addWeakReasons(result, det);
      return result;
    }
    if (rec.cols !== det.c || rec.rows !== det.r) {
      result.status = "damaged";
      result.reasons.push("水印尺寸与登记记录不一致（检出 " + det.c + "×" + det.r + "，登记 " +
        rec.cols + "×" + rec.rows + "），仅能确认水印字段，无法逐格比对。");
      return result;
    }

    var altered = [], missing = [];
    for (var p = 0; p < rec.wmCells.length; p++) {
      var v = rect.cells[p];
      if (v < 0) missing.push({ index: p, x: p % det.c, y: Math.floor(p / det.c), reason: "裁切缺失，无法确认" });
      else if (v !== rec.wmCells[p]) {
        altered.push({ index: p, x: p % det.c, y: Math.floor(p / det.c),
          from: rec.wmCells[p], to: v, inWatermarkBlock: inAnyBlock(p, det.c, det.r, det.px, det.py) });
      }
    }
    result.altered = altered; result.missing = missing;

    var fieldClash = [];
    if (fk.author && meta.author !== rec.author) fieldClash.push("作者编号");
    if (fk.scope && meta.scope !== rec.scope) fieldClash.push("授权范围");
    if (fk.start && meta.startYM !== rec.startYM) fieldClash.push("授权起始月");
    if (fk.months && meta.months !== rec.months) fieldClash.push("授权时长");

    if (altered.length === 0 && missing.length === 0 && fieldClash.length === 0) {
      result.status = "valid";
      annotatePartialFields(result, fk);
      return result;
    }
    if (altered.length === 0 && fieldClash.length === 0 && meta.magicOk && match.ratio >= 1 - 1e-9) {
      result.status = "valid_partial";
      annotatePartialFields(result, fk);
      result.reasons.push("样本被裁切，" + missing.length + " 格不在样本内无法确认；其余可见格点与登记原方案完全一致，已确认部分通过。");
      return result;
    }

    if (fieldClash.length) {
      result.status = "tampered";
      result.reasons.push("读出的" + fieldClash.join("、") + "与登记记录不符，水印可能被伪造或套用，核验结果不会覆盖原方案。");
    }
    // 回退路径（水印本身读不出来）：逐格比对就是权威——有改格即篡改，仅缺格即部分通过
    if (fallbackUsed && !fieldClash.length) {
      if (altered.length > 0) {
        result.status = "tampered";
        result.reasons.push("水印已无法完整读出（" + (det.erasedBlocks || 0) +
          " 处异常），但按 8 朝向逐格比对，仍在登记原方案中定位到该图样：有 " + altered.length +
          " 格颜色被改动、" + missing.length + " 格缺失，可见格点一致率 " +
          Math.round(match.ratio * 100) + "%，判定内容被篡改。核验结果不会覆盖登记原方案。");
        return result;
      }
      result.status = "valid_partial";
      result.reasons.push("水印位无法完整读出，按登记原方案逐格比对定位到该图样；可见格点全部一致，" +
        missing.length + " 格因裁切无法确认。展示的作者与授权信息来自登记册。");
      return result;
    }
    var readDetermined = det.fullyDetermined && det.erasedBlocks === 0 &&
      det.missingBlocks === 0 && (det.support || 0) >= SUPPORT_MIN;
    if (!fieldClash.length) result.status = readDetermined ? "tampered" : "damaged";
    if (result.status === "damaged") {
      addWeakReasons(result, det);
      result.reasons.push("与登记图样存在差异：" + altered.length + " 格改色、" + missing.length +
        " 格缺失；可见格点一致率 " + Math.round(match.ratio * 100) + "%。");
    } else if (!fieldClash.length) {
      result.reasons.push("水印完整可读且字段一致，但登记指纹不符：有 " + altered.length +
        " 格颜色被改动，属于内容篡改。核验结果不会覆盖登记原方案。");
    }
    return result;
  }

  function annotatePartialFields(result, fk) {
    if (!fk.scope) result.reasons.push("授权范围位部分缺失，展示值来自登记册。");
    if (!fk.start || !fk.months) result.reasons.push("有效期位部分缺失，展示值来自登记册。");
    if (!fk.author) result.reasons.push("作者编号位部分缺失，展示值来自登记册（由可见格点一致匹配）。");
  }
  function termOf(rec, cur) {
    var si = monthIndex(rec.startYM);
    if (rec.months === 0) return { text: rec.startYM + " 起 · 长期有效", state: "open" };
    if (cur < si) return { text: rec.startYM + " 至 " + rec.endYM, state: "future" };
    if (cur > si + rec.months - 1) return { text: rec.startYM + " 至 " + rec.endYM, state: "expired" };
    return { text: rec.startYM + " 至 " + rec.endYM, state: "valid" };
  }
  function matchRecord(records, meta, fk, det, rect) {
    if (!records || !records.length) return { record: null, ratio: 0 };
    function score(recList) {
      return recList.map(function (r) {
        var same = 0, seen = 0;
        for (var p = 0; p < r.wmCells.length; p++) {
          var v = rect.cells[p];
          if (v < 0) continue;
          seen++; if (v === r.wmCells[p]) same++;
        }
        return { r: r, ratio: seen ? same / seen : 0, seen: seen };
      }).filter(function (s) { return s.seen >= MIN_USED_BLOCKS * 2; });
    }
    var pool = records.filter(function (r) {
      return r.cols === det.c && r.rows === det.r && r.wmCells && (!fk.author || r.author === meta.author);
    });
    var scored = score(pool);
    // 作者位读得很确定却匹配不上：不允许退回到“他人记录”作为命中（防伪造套用）
    if (!scored.length && !fk.author) {
      scored = score(records.filter(function (r) { return r.cols === det.c && r.rows === det.r && r.wmCells; }));
    }
    // 最近相似记录（不论作者），供“套用/替换”判定
    var nearest = score(records.filter(function (r) { return r.cols === det.c && r.rows === det.r && r.wmCells; }))
      .sort(function (a, b) { return b.ratio - a.ratio; })[0] || null;
    scored.sort(function (a, b) { return b.ratio - a.ratio; });
    if (scored.length && scored[0].ratio >= 0.95)
      return { record: scored[0].r, ratio: scored[0].ratio, nearest: nearest,
               ambiguous: scored.length > 1 && scored[1].ratio >= scored[0].ratio - 0.01 };
    return { record: null, ratio: scored.length ? scored[0].ratio : 0, nearest: nearest };
  }
  function addWeakReasons(result, det) {
    if (result.missing.length) result.reasons.push("图样被裁切，" + result.missing.length + " 格不在样本内，这些格无法确认。");
    if (det.erasedBlocks) result.reasons.push(det.erasedBlocks + " 个水印块呈非法图案（污损/涂改/重量化），已按擦除处理。");
    if (det.inferred) result.reasons.push(det.inferred + " 个码位无票，已由校验方程解出（可信度下降）。");
    if (det.freeCount) result.reasons.push(det.freeCount + " 个码位无约束解，相关字段标注为无法确认。");
    if (det.corrected) result.reasons.push("发现码位错票，已按校验约束纠正，图样可能轻微受损。");
    if (det.minMargin < 1 && det.unknownBits === 0)
      result.reasons.push("部分水印位表决不完全一致，最低余量 " + Math.round(det.minMargin * 100) + "%。");
  }
  function inAnyBlock(index, cols, rows, px, py) {
    px = px || 0; py = py || 0;
    var x = index % cols, y = (index / cols) | 0;
    return x >= px && y >= py && x < cols - ((cols - px) % 2) && y < rows - ((rows - py) % 2);
  }

  function summarize(det) {
    return {
      orientation: det.orientation,
      orientationText: ["原样","样本逆时针旋转90°","旋转180°","样本顺时针旋转90°",
                        "水平翻转","水平翻转+逆时针90°","翻转并旋转180°","水平翻转+顺时针90°"][det.orientation],
      cols: det.c, rows: det.r, dx: det.dx, dy: det.dy, px: det.px, py: det.py,
      coverage: Math.round(det.coverage * 100) / 100,
      usedBlocks: det.usedBlocks, missingBlocks: det.missingBlocks,
      erasedBlocks: det.erasedBlocks, unknownBits: det.unknownBits,
      minMargin: Math.round(det.minMargin * 100) / 100,
      avgConfidence: Math.round(det.avgConf * 100) / 100,
      inferred: det.inferred || 0, freeCount: det.freeCount || 0,
      cleanCode: !!det.cleanCode, strong: !!det.strong
    };
  }
  function publicRecord(rec) {
    return {
      nonce: rec.nonce, name: rec.name, author: rec.author,
      scope: rec.scope, scopeText: SCOPE_TEXT[rec.scope] || "未知",
      startYM: rec.startYM, endYM: rec.endYM, months: rec.months,
      cols: rec.cols, rows: rec.rows, fingerprint: rec.fingerprint, fpWm: rec.fpWm,
      tag: rec.tag, watermarked: !!rec.watermarked, registeredAt: rec.registeredAt
    };
  }

  /* ====================== 颜色量化（外部 RGB -> 索引） ====================== */

  function nearestIndex(r, g, b) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < 8; i++) {
      var dr = r - PALETTE_RGB[i][0], dg = g - PALETTE_RGB[i][1], db = b - PALETTE_RGB[i][2];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function quantizeCells(cells, levels) {
    if (!levels || levels >= 8) return cells.slice();
    var bits = Math.max(2, Math.min(7, levels | 0));
    return cells.map(function (idx) {
      var c = PALETTE_RGB[idx];
      var q = c.map(function (v) {
        var step = 256 / (1 << bits);
        return Math.min(255, Math.floor(v / step) * step + step / 2) | 0;
      });
      return nearestIndex(q[0], q[1], q[2]);
    });
  }

  return {
    PALETTE: PALETTE, PALETTE_RGB: PALETTE_RGB, LUMA: LUMA, DARK_GATE: DARK_GATE,
    isDarkIndex: isDarkIndex, nearestIndex: nearestIndex, quantizeCells: quantizeCells,
    colorCounts: colorCounts, sameCounts: sameCounts,
    fingerprint: fingerprint, fingerprintTag: fingerprintTag,
    monthIndex: monthIndex, ymOf: ymOf, currentYM: currentYM, SCOPE_TEXT: SCOPE_TEXT,
    encodeData: encodeData, encodeCodeword: encodeCodeword, decodeData: decodeData,
    blockLayout: blockLayout, capacity: capacity, embed: embed, detect: detect,
    rectify: rectify, verify: verify,
    sha256: sha256Ascii,
    CW_BITS: CW_BITS, DATA_BITS: DATA_BITS, SYMBOLS: SYMBOLS,
    MAX_COLS: MAX_COLS, MAX_ROWS: MAX_ROWS, MIN_USABLE: MIN_USABLE
  };
});
