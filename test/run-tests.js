#!/usr/bin/env node
/*!
 * run-tests.js — 离线版权水印与溯源核验 自动化测试（零依赖，node test/run-tests.js）
 *
 * 覆盖五类案例：
 *   合法（原样/旋转/翻转/缩放/量化/裁切部分可见）、损坏（擦除/裁切改色/重噪）、
 *   变形（8 朝向 × 裁放转翻 × 量化组合）、篡改（改色/伪造字段）、无解（无水印/空白/过重破坏）。
 * 另含登记册写保护、导入导出、光栅恢复、色线数量不变、连续批量核验性能。
 */
"use strict";
const path = require("path");
const WM = require(path.join(__dirname, "..", "js", "watermark.js"));
const Registry = require(path.join(__dirname, "..", "js", "registry.js"));
const Raster = require(path.join(__dirname, "..", "js", "raster.js"));

/* ------------------------------- 迷你框架 ------------------------------- */
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; process.stdout.write("  ✓ " + name + "\n"); }
  else { failed++; failures.push(name); process.stdout.write("  ✗ " + name + (extra ? "  — " + extra : "") + "\n"); }
}
function eq(a, b, name) { ok(a === b, name, "got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
function group(name) { process.stdout.write("\n[" + name + "]\n"); }
function section(n) { process.stdout.write("\n=== " + n + " ===\n"); }

/* ------------------------------- 造样工具 ------------------------------- */
function makePattern(cols, rows, seed) {
  const cells = new Array(cols * rows).fill(0);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const k = (x * (7 + seed) + y * (13 + seed) + x * y + seed * 31) % 8;
    if (k >= 2) cells[y * cols + x] = k; // 约一半以上为暗色，保证容量
  }
  return cells;
}
function makeRecord(cells, cols, rows, info, name) {
  const em = WM.embed(cells, cols, rows, info);
  if (!em.ok) throw new Error("造样嵌入失败: " + em.hint);
  return {
    record: {
      nonce: "n" + Math.random().toString(36).slice(2, 8),
      name: name || "测试纹样", author: info.author, scope: info.scope,
      startYM: info.startYM, months: info.months,
      endYM: info.months ? WM.ymOf(WM.monthIndex(info.startYM) + info.months - 1) : null,
      cols, rows, tag: em.tag, fingerprint: em.fingerprint, fpWm: em.fpWm,
      wmCells: em.cells, watermarked: true, registeredAt: info.startYM + "-01"
    },
    embedded: em
  };
}
function matrixCrop(cells, cols, rows, x0, x1, y0, y1) {
  const m = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.push(cells[y * cols + x]);
  return [m, x1 - x0, y1 - y0];
}
function rotCW(m, c, r) {
  const n = new Array(r * c);
  for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) n[x * r + (r - 1 - y)] = m[y * c + x];
  return n;
}
function flipH(m, c, r) {
  const n = new Array(c * r);
  for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) n[y * c + (c - 1 - x)] = m[y * c + x];
  return n;
}
const INFO = { author: 2026, scope: 5, startYM: "2026-03", months: 24 };
const NOW = "2026-09";

/* ============================ 1. 算法基础 ============================ */
section("一、编码与指纹");

group("指纹/SHA-256");
{
  const a = makePattern(18, 14, 1);
  const fp = WM.fingerprint(a, 18, 14);
  ok(/^[0-9a-f]{64}$/.test(fp), "指纹为 64 位十六进制");
  eq(WM.fingerprint(a, 18, 14), fp, "指纹稳定可复算");
  const b = a.slice(); b[100] = (b[100] + 1) % 8;
  ok(WM.fingerprint(b, 18, 14) !== fp, "改动一格指纹即变化");
  ok(WM.sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 已知向量");
}

group("载荷编解码");
{
  const samples = [
    { author: 1, scope: 1, startYM: "2020-01", months: 1 },
    { author: 32767, scope: 6, startYM: "2026-12", months: 63 },
    { author: 2026, scope: 5, startYM: "2026-03", months: 0 },
    { author: 42, scope: 3, startYM: "2099-06", months: 12 }
  ];
  samples.forEach((s, i) => {
    const cw = WM.encodeCodeword(WM.encodeData(s));
    eq(cw.length, WM.CW_BITS, "码字长度 " + WM.CW_BITS + "（样例 " + i + "）");
    const dec = WM.decodeData(cw.slice(0, WM.DATA_BITS));
    ok(dec.magicOk && dec.author === s.author && dec.scope === s.scope &&
       dec.startYM === s.startYM && dec.months === s.months, "载荷往返一致（样例 " + i + "）");
  });
}

/* ============================ 2. 嵌入性质 ============================ */
section("二、嵌入：藏在格点、色线数量不变");

{
  const cols = 18, rows = 14;
  const cells = makePattern(cols, rows, 3);
  const em = WM.embed(cells, cols, rows, INFO);
  ok(em.ok, "嵌入成功");
  eq(em.meta.author, INFO.author, "嵌入元数据作者编号");
  ok(em.changedCells > 0, "确有格点被重排（" + em.changedCells + " 格）");
  ok(WM.sameCounts(cells, em.cells), "★ 嵌入后 8 种色线数量一格不差");
  const ca = WM.colorCounts(cells), cb = WM.colorCounts(em.cells);
  ok(ca.every((n, i) => n === cb[i]), "逐色计数一致：[" + ca.join(",") + "]");
  // 格值仍在合法色号内
  ok(em.cells.every(v => Number.isInteger(v) && v >= 0 && v < 8), "未产生非法色号");
  // 不修改原数组
  ok(cells.some((v, i) => v !== em.cells[i]) && cells.length === cols * rows, "原方案矩阵不被原地修改");
}

group("容量不足拒绝");
{
  const sparse = new Array(18 * 14).fill(0);
  for (let i = 0; i < 10; i++) sparse[i * 17] = 6;
  const r = WM.embed(sparse, 18, 14, INFO);
  ok(!r.ok && !!r.hint, "过素图案拒绝嵌入并给出原因");
  const small = makePattern(8, 8, 1);
  ok(!WM.embed(small, 8, 8, INFO).ok, "8×8 小网格拒绝嵌入");
  const reg = new Registry(new Registry.MemoryStore());
  const before = reg.count();
  const rr = reg.register({ name: "x", author: 1, scope: 1, startYM: "2026-01", months: 1, cols: 18, rows: 14, cells: sparse });
  ok(!rr.ok && reg.count() === before, "容量不足时登记失败且登记册无变化");
}

/* ============================ 3. 合法案例 ============================ */
section("三、合法案例核验");

{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 5);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);
  const det = WM.detect(embedded.cells, cols, rows);
  ok(det.found && det.strong, "原样检出且为强解");
  eq(det.data.author, INFO.author, "作者编号 2026");
  eq(det.data.scopeText, "商用授权", "授权范围文本");
  eq(det.data.startYM, "2026-03", "授权起始 2026-03");
  eq(det.data.endYM, "2028-02", "授权到期 2028-02（24 个月）");

  const v = WM.verify(embedded.cells, cols, rows, [record], NOW);
  eq(v.status, "valid", "★ 原样核验 valid");
  eq(v.record.author, 2026, "核验返回作者");
  eq(v.term.text, "2026-03 至 2028-02", "核验返回授权期限文本");
  eq(v.term.state, "valid", "当前在有效期内");
  eq(v.altered.length, 0, "无被改格");
  ok(v.confidence >= 0.85, "可信度 ≥0.85（" + v.confidence + "，无票位已由校验补解）");
}

group("授权期限状态");
{
  const cells = makePattern(18, 14, 9);
  const cases = [
    ["2020-01", 12, "2026-09", "expired", "已过期"],
    ["2030-01", 12, "2026-09", "future", "未生效"],
    ["2026-01", 0, "2026-09", "open", "长期有效"],
    ["2026-01", 24, "2026-09", "valid", "有效"]
  ];
  cases.forEach(([s, m, now, state, label]) => {
    const { record } = makeRecord(cells, 18, 14, { author: 7, scope: 2, startYM: s, months: m });
    const em = WM.embed(cells, 18, 14, { author: 7, scope: 2, startYM: s, months: m });
    eq(WM.verify(em.cells, 18, 14, [record], now).term.state, state, label);
  });
}

/* ============================ 4. 变形恢复 ============================ */
section("四、裁切/缩放/旋转/翻转/量化后恢复");

group("二面体群 8 朝向（矩阵层）");
{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 2);
  const { embedded } = makeRecord(cells, cols, rows, INFO);
  const forms = [];
  let cur = embedded.cells, cc = cols, cr = rows;
  for (let i = 0; i < 4; i++) { forms.push([cur, cc, cr, i]); cur = rotCW(cur, cc, cr); [cc, cr] = [cr, cc]; }
  cur = flipH(embedded.cells, cols, rows); cc = cols; cr = rows;
  for (let i = 0; i < 4; i++) { forms.push([cur, cc, cr, i + 4]); cur = rotCW(cur, cc, cr); [cc, cr] = [cr, cc]; }
  const expectedOri = [0, 3, 2, 1, 4, 5, 6, 7];
  forms.forEach(([m, c, r, t], i) => {
    const d = WM.detect(m, c, r);
    ok(d.found && d.strong && d.orientation === expectedOri[i] && d.data.author === INFO.author,
      "朝向 " + i + " 强检出（还原朝向 " + expectedOri[i] + "）");
  });
}

group("裁切矩阵（含奇数格错位）");
{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 4);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);
  const crops = [
    [2, 18, 2, 13, "右下双裁 16×11"],
    [1, 17, 1, 13, "四周窄裁 16×12"],
    [2, 16, 2, 12, "双侧各裁 2 格 14×10"],
    [0, 16, 0, 14, "左边保留 16×14"],
    [1, 17, 1, 14, "17×13"],
    [2, 17, 2, 13, "15×11 重裁"]
  ];
  crops.forEach(([x0, x1, y0, y1, label]) => {
    const [m, c, r] = matrixCrop(embedded.cells, cols, rows, x0, x1, y0, y1);
    const d = WM.detect(m, c, r);
    ok(d.found && d.data.author === INFO.author && d.c === cols && d.r === rows &&
       d.dx === x0 && d.dy === y0, "裁切「" + label + "」检出原尺寸与偏移 (" + d.dx + "," + d.dy + ")");
    const v = WM.verify(m, c, r, [record], NOW);
    ok(v.status === "valid_partial" || v.status === "valid", "裁切核验 " + v.status + "（" + label + "）");
    eq(v.missing.length, (cols * rows) - c * r, "无法确认格数=被裁格数（" + label + "）");
    if (v.status === "valid_partial") ok(v.reasons.some(x => x.indexOf("裁切") >= 0), "给出裁切原因说明（" + label + "）");
  });
}

group("裁切后旋转/翻转");
{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 6);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);
  const [m, c, r] = matrixCrop(embedded.cells, cols, rows, 2, 18, 2, 13);
  const mr = rotCW(m, c, r);
  const v1 = WM.verify(mr, r, c, [record], NOW);
  ok(v1.status === "valid_partial" || v1.status === "valid", "裁切+90° 旋转核验 " + v1.status);
  const mf = flipH(m, c, r);
  const v2 = WM.verify(mf, c, r, [record], NOW);
  ok(v2.status === "valid_partial" || v2.status === "valid", "裁切+翻转核验 " + v2.status);
}

/* ============================ 5. 光栅通道 ============================ */
section("五、图像光栅：缩放/旋转/翻转/量化/噪声");

{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 7);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);
  const img = Raster.render(embedded.cells, cols, rows);

  const plain = Raster.recover(img);
  ok(plain.cols === cols && plain.rows === rows &&
     JSON.stringify(plain.cells) === JSON.stringify(embedded.cells), "渲染→恢复 完全无损");

  [0.45, 0.5, 0.6, 0.7, 1.5, 2].forEach(f => {
    const rr = Raster.recover(Raster.scaleBy(img, f));
    ok(rr.cols === cols && rr.rows === rows &&
       JSON.stringify(rr.cells) === JSON.stringify(embedded.cells), "缩放 ×" + f + " 后无损恢复");
  });

  const r90 = Raster.recover(Raster.rot90CW(img));
  ok(r90.cols === rows && r90.rows === cols, "90° 旋转后格数互换 " + r90.cols + "×" + r90.rows);
  const d90 = WM.detect(r90.cells, r90.cols, r90.rows);
  ok(d90.found && d90.strong && d90.data.author === INFO.author, "90° 旋转后水印强检出");
  const r180 = Raster.recover(Raster.rot180(img));
  ok(WM.detect(r180.cells, r180.cols, r180.rows).strong, "180° 旋转后强检出");
  const fl = Raster.recover(Raster.flipH(img));
  ok(WM.detect(fl.cells, fl.cols, fl.rows).strong, "水平翻转后强检出");

  [2, 3, 4].forEach(bits => {
    const rr = Raster.recover(Raster.quantize(img, bits));
    ok(JSON.stringify(rr.cells) === JSON.stringify(embedded.cells), "颜色量化到 " + bits + " 位/通道后格点不变");
    ok(WM.detect(rr.cells, rr.cols, rr.rows).strong, bits + " 位量化后强检出");
  });

  const nz = Raster.recover(Raster.addNoise(img, 18, mulberryLike(42)));
  ok(JSON.stringify(nz.cells) === JSON.stringify(embedded.cells), "强度 18 均匀噪声后格点不变");

  // 组合攻击 1：缩放+旋转+量化+噪声
  let im = Raster.scaleBy(img, 0.6); im = Raster.rot90CW(im); im = Raster.quantize(im, 3);
  im = Raster.addNoise(im, 10, mulberryLike(7));
  const vc = Raster.verifyImage(im, [record], NOW);
  eq(vc.status, "valid", "★ 组合攻击（缩放0.6+旋转+3位量化+噪声）核验 valid");

  // 组合攻击 2：裁切+翻转+缩放
  let im2 = Raster.crop(img, 54, 28, img.width - 80, img.height - 56);
  im2 = Raster.flipH(im2); im2 = Raster.scaleBy(im2, 1.4);
  const vf = Raster.verifyImage(im2, [record], NOW);
  ok(vf.status === "valid_partial" || vf.status === "valid",
     "★ 组合攻击（裁切+翻转+缩放1.4）核验 " + vf.status);
  ok(vf.detection && vf.detection.orientationText.indexOf("翻转") >= 0, "识别出翻转朝向");
}
function mulberryLike(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================ 6. 损坏案例 ============================ */
section("六、损坏案例（信息不完整但可部分确认）");

{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 8);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);

  // 轻度裁切（缺票少，改色可由校验纠正后仍逐格比对）后再改 2 个可见格
  let [m, c, r] = matrixCrop(embedded.cells, cols, rows, 0, 16, 0, 14);
  m[10] = m[10] === 0 ? 6 : 0; m[120] = m[120] === 0 ? 6 : 0;
  const v1 = WM.verify(m, c, r, [record], NOW);
  eq(v1.status, "tampered", "裁切+改色判 tampered（水印可纠错误改，指纹判定内容被改）");
  ok(v1.altered.length === 2, "被改格清单列出 2 格（实际 " + v1.altered.length + "）");
  ok(v1.altered.every(a => a.from !== undefined && a.to !== undefined && a.x >= 0 && a.y >= 0),
     "被改格带坐标与前后色号");
  ok(v1.missing.length > 0 && v1.missing.every(x => x.reason === "裁切缺失，无法确认"),
     "缺失格逐条给出无法确认原因");
  ok(v1.reasons.length > 0, "附文字说明");

  // 光栅层严重污损：对恢复矩阵做大面积改色（模拟翻拍/涂抹后错读约 1/5 格）
  const heavyCells = embedded.cells.slice();
  for (let i = 0; i < heavyCells.length; i += 5) heavyCells[i] = (heavyCells[i] + 3) % 8;
  const v2 = WM.verify(heavyCells, cols, rows, [record], NOW);
  ok(["damaged", "unknown", "tampered"].indexOf(v2.status) >= 0 && v2.status !== "valid",
     "大面积错读（约1/5格）不得判 valid，实际：" + v2.status);
}

/* ============================ 7. 篡改案例 ============================ */
section("七、篡改案例（水印完好但内容被改 / 字段伪造）");

{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 11);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);

  [1, 3, 8].forEach((n, ci) => {
    const tam = embedded.cells.slice();
    const spots = [10, 80, 150, 200, 50, 220, 90, 170].slice(0, n);
    spots.forEach(i => { tam[i] = tam[i] === 6 ? 0 : 6; });
    const v = WM.verify(tam, cols, rows, [record], NOW);
    eq(v.status, "tampered", "改 " + n + " 格判 tampered（组 " + ci + "）");
    eq(v.altered.length, n, "列出全部 " + n + " 个被改格");
    ok(v.reasons.some(x => x.indexOf("篡改") >= 0 || x.indexOf("指纹不符") >= 0), "给出篡改原因");
  });

  // 字段伪造：同样图案用另一作者/范围重新嵌水印，冒充本记录
  const forged = WM.embed(cells, cols, rows, { author: 9999, scope: 1, startYM: "2026-03", months: 24 });
  const vf = WM.verify(forged.cells, cols, rows, [record], NOW);
  eq(vf.status, "tampered", "伪造/套用他方水印判 tampered");
  ok(vf.reasons.join("").indexOf("覆盖") >= 0, "原因中声明不会覆盖原方案");

  // 写保护：updateRecord 拒绝指纹不符的图样
  const reg = new Registry(new Registry.MemoryStore());
  const regged = reg.register(Object.assign({ name: "山纹", cols, rows, cells }, INFO));
  const upd = reg.updateRecord(regged.record.nonce, { wmCells: forged.cells });
  ok(!upd.ok, "登记册拒绝用伪造图样更新（防覆盖）");
  eq(reg.get(regged.record.nonce).fpWm, regged.record.fpWm || reg.get(regged.record.nonce).fpWm, "原记录指纹未被改动");
}

/* ============================ 8. 无解案例 ============================ */
section("八、无解案例（无水印 / 空白 / 严重破坏 / 尺寸异常）");

{
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 12);
  const { record, embedded } = makeRecord(cells, cols, rows, INFO);

  const random = new Array(cols * rows).fill(0).map((_, i) => i % 8);
  const d1 = WM.verify(random, cols, rows, [record], NOW);
  eq(d1.status, "unknown", "规则彩条（无水印）判 unknown");
  ok(d1.reasons.length >= 1, "说明无法确认原因");

  const blank = new Array(cols * rows).fill(0);
  eq(WM.verify(blank, cols, rows, [record], NOW).status, "unknown", "全空白判 unknown");

  const unrelated = makePattern(cols, rows, 77);
  eq(WM.verify(unrelated, cols, rows, [record], NOW).status, "unknown", "另一幅普通纹样判 unknown");

  // 只剩 8×6 的极小残片
  const [tiny] = matrixCrop(embedded.cells, cols, rows, 5, 13, 4, 10);
  eq(WM.verify(tiny, 8, 6, [record], NOW).status, "unknown", "8×6 残片判 unknown");

  // 无登记记录的水印样本 → orphan
  const vo = WM.verify(embedded.cells, cols, rows, [], NOW);
  eq(vo.status, "orphan", "本机无登记记录判 orphan");
  ok(vo.extracted.author === INFO.author, "orphan 仍显示读取出的作者编号");
  ok(vo.reasons.join("").indexOf("登记册") >= 0, "说明登记册无匹配");

  // 尺寸越界
  const big = WM.verify(new Array(40 * 40).fill(1), 40, 40, [record], NOW);
  eq(big.status, "unknown", "超尺寸判 unknown 并给出原因");
}

/* ============================ 9. 登记册与导入导出 ============================ */
section("九、登记册：登记、写保护、导入导出");

{
  const store = new Registry.MemoryStore();
  const reg = new Registry(store);
  const cols = 18, rows = 14, cells = makePattern(cols, rows, 13);

  const regInput = Object.assign({ name: "云雷纹", note: "备注", cols, rows, cells }, INFO);
  const regged = reg.register(regInput);
  ok(regged.ok && regged.record.fingerprint.length === 64, "登记成功，含方案指纹");
  ok(regged.embedded.changedCells > 0, "登记返回嵌入结果");

  const bad = reg.register({ name: "x", cols, rows, cells, author: 0, scope: 1, startYM: "2026-01", months: 1 });
  ok(!bad.ok && bad.errors.length, "非法作者编号被拒");
  const bad2 = reg.register({ name: "x", cols, rows, cells, author: 1, scope: 9, startYM: "2026-01", months: 1 });
  ok(!bad2.ok, "非法授权范围被拒");
  const bad3 = reg.register({ name: "x", cols, rows, cells, author: 1, scope: 1, startYM: "2026/01", months: 1 });
  ok(!bad3.ok, "错误日期格式被拒");

  // 持久化重载
  const regReloaded = new Registry(store);
  ok(regReloaded.count() === reg.count(), "localStorage 持久化后重载记录数一致");
  const reGet = regReloaded.get(regged.record.nonce);
  ok(!!reGet && reGet.fpWm === regged.record.fpWm, "重载记录可检索且指纹一致");
  eq(regReloaded.verifyMany([{ cells: reg.get(regged.record.nonce).wmCells, cols, rows }], NOW)[0].status,
     "valid", "重载后仍可核验 valid");

  // 改名允许，图样覆盖拒绝
  ok(reg.updateRecord(regged.record.nonce, { name: "云雷纹·改" }).ok, "元信息改名允许");
  ok(!reg.updateRecord(regged.record.nonce, { wmCells: cells }).ok, "用原图（非水印图）覆盖被拒");

  // 导出再导入
  const data = reg.exportJSON();
  eq(data.format, "zfl31-brocade-watermark-registry", "导出格式标识");
  eq(data.count, reg.count(), "导出条数一致");

  const reg2 = new Registry(new Registry.MemoryStore());
  const imp = reg2.importJSON(JSON.parse(JSON.stringify(data)));
  ok(imp.ok && imp.added === reg.count(), "干净导出文件导入成功（" + imp.added + " 条）");

  const tamperedExport = JSON.parse(JSON.stringify(data));
  tamperedExport.records[0].wmCells[100] = tamperedExport.records[0].wmCells[100] === 6 ? 0 : 6;
  const imp2 = reg2.importJSON(tamperedExport);
  ok(imp2.rejected.length === 1, "★ 篡改的导入文件被拒绝（" + (imp2.rejected[0] && imp2.rejected[0].reason) + "）");

  const corruptExport = JSON.parse(JSON.stringify(data));
  const origV = corruptExport.records[0].cells[50];
  corruptExport.records[0].cells[50] = (origV + 1) % 8; // 保证与原色不同
  const imp3 = reg2.importJSON(corruptExport);
  ok(imp3.rejected.length >= 1, "原图损坏（指纹不符）的导入被拒绝");

  const bogus = reg2.importJSON({ format: "nope", records: [] });
  ok(!bogus.ok, "非本台格式文件被拒绝");

  // 同 nonce 不同指纹拒绝覆盖
  const evil = JSON.parse(JSON.stringify(data));
  evil.records[0].author = 1;
  evil.records[0].wmCells = evil.records[0].wmCells.slice();
  evil.records[0].wmCells[0] = evil.records[0].wmCells[0] === 6 ? 0 : 6;
  const imp4 = reg2.importJSON(evil);
  ok(imp4.rejected.length >= 1, "同编号异指纹的导入拒绝覆盖");
}

/* ============================ 10. 连续批量核验性能 ============================ */
section("十、大量方案连续核验");

{
  const N = 200;
  const reg = new Registry(new Registry.MemoryStore());
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const cols = 18, rows = 14, cells = makePattern(cols, rows, i + 20);
    const info = { author: 1000 + (i % 300), scope: 1 + (i % 6), startYM: "2025-01", months: 12 + (i % 40) };
    const regged = reg.register(Object.assign({ name: "批量纹样 " + i, cols, rows, cells }, info));
    if (!regged.ok) { ok(false, "批量登记 #" + i + " 失败：" + (regged.errors || regged.hint)); continue; }
    let s = reg.get(regged.record.nonce).wmCells, sc = cols, sr = rows;
    if (i % 5 === 1) { s = rotCW(s, sc, sr); [sc, sr] = [sr, sc]; }
    if (i % 7 === 2) s = flipH(s, sc, sr);
    samples.push({ cells: s, cols: sc, rows: sr, name: regged.record.name });
  }
  const tReg = Date.now() - t0;
  eq(reg.count(), N, "登记册含 200 条记录");
  const results = reg.verifyMany(samples, NOW);
  const dt = results.durationMs;
  const badResults = results.filter(x => x.status !== "valid");
  ok(badResults.length === 0, "★ 200 个方案连续核验全部 valid（含旋转/翻转样本），失败 " + badResults.length +
     (badResults.length ? "，例：" + badResults[0].sampleName + "=" + badResults[0].status : ""));
  ok(dt < 15000, "连续核验 200 个耗时 " + dt + "ms（<15s），平均 " + (dt / N).toFixed(1) + "ms/个");
  process.stdout.write("    （登记+嵌入 200 个耗时 " + tReg + "ms）\n");

  // 混合样本：合法/篡改/无水印（基于已登记的前 30 条）
  const mix = samples.slice(0, 30).map((s, i) => {
    if (i % 3 === 0) { const t = s.cells.slice(); t[20] = t[20] === 6 ? 0 : 6; return { cells: t, cols: s.cols, rows: s.rows }; }
    if (i % 3 === 1) return { cells: new Array(s.cols * s.rows).fill(0).map((_, k) => k % 8), cols: s.cols, rows: s.rows };
    return s;
  });
  const rm = reg.verifyMany(mix, NOW);
  const counts = rm.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
  ok((counts.valid || 0) === 10 && (counts.tampered || 0) >= 9 && (counts.unknown || 0) >= 9,
     "混合批次正确分类：" + JSON.stringify(counts));
}

/* ============================== 结果汇总 ============================== */
section("汇总");
process.stdout.write("\n通过 " + passed + " 项，失败 " + failed + " 项\n");
if (failed) {
  process.stdout.write("\n失败项：\n - " + failures.join("\n - ") + "\n");
  process.exit(1);
}
process.stdout.write("全部通过 ✅\n");
