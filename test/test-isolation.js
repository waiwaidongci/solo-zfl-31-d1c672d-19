#!/usr/bin/env node
/*!
 * test-isolation.js — 登记/编辑/核验/导出 数据隔离专项测试
 *
 * 复现并锁定曾存在的缺陷链：
 *   登记返回的 embedded.cells 与登记记录 wmCells 曾是同一数组引用，
 *   页面继续编辑画布会直接改写核验基准 -> 改色仍判 valid；
 *   污染后的登记记录导出再导入，又会被导入校验拒绝。
 */
"use strict";
const path = require("path");
const WM = require(path.join(__dirname, "..", "js", "watermark.js"));
const Registry = require(path.join(__dirname, "..", "js", "registry.js"));

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name); console.log("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function eq(a, b, name) { ok(a === b, name, "got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
function group(n) { console.log("\n[" + n + "]"); }

function makePattern(cols, rows, seed) {
  const m = new Array(cols * rows).fill(0);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const k = (x * (7 + seed) + y * (13 + seed) + x * y + seed * 31) % 8;
    if (k >= 2) m[y * cols + x] = k;
  }
  return m;
}
const COLS = 18, ROWS = 14, NOW = "2026-09";
const INFO = { author: 3141, scope: 5, startYM: "2026-03", months: 24 };

/* ================= 1. 登记返回值与记录互不共享数组 ================= */
group("一、登记瞬间的数据隔离");

const reg = new Registry(new Registry.MemoryStore());
const original = makePattern(COLS, ROWS, 5);
const regRes = reg.register(Object.assign({ name: "隔离样案", cols: COLS, rows: ROWS, cells: original }, INFO));
ok(regRes.ok, "登记成功");
const rec = reg.get(regRes.record.nonce);

ok(regRes.embedded.cells !== rec.wmCells, "★ 返回给画布的数组与登记核验基准不是同一引用");
ok(rec.cells !== original, "登记保存的原图也不是入参数组的同一引用");
ok(rec.cells !== rec.wmCells, "原图与水印图各自独立");
ok(reg.isIntact(rec), "登记后记录自洽（双指纹吻合、色线数一致）");

/* ================= 2. 登记后继续编辑画布，基准不变 ================= */
group("二、登记后编辑画布 → 核验基准不被改写");

// 模拟页面：画布持有 embedded.cells，用户改若干格
const canvas = regRes.embedded.cells;
const baselineFingerprint = rec.fpWm;
const baselineCell10 = rec.wmCells[10];
canvas[10] = canvas[10] === 6 ? 0 : 6;
canvas[80] = canvas[80] === 6 ? 0 : 6;
canvas[150] = canvas[150] === 6 ? 0 : 6;

eq(rec.fpWm, baselineFingerprint, "画布改色后登记记录水印指纹不变");
eq(rec.wmCells[10], baselineCell10, "画布改色后基准 wmCells 不被连带修改");
ok(reg.isIntact(rec), "记录仍自洽（基准没有被画布污染）");

/* ================= 3. 改色后核验必须判篡改 ================= */
group("三、改色画布核验 → tampered，且列出被改格");

const vEdited = WM.verify(canvas, COLS, ROWS, reg.all(), NOW);
eq(vEdited.status, "tampered", "★ 改色后核验为 tampered（不会再误判 valid）");
ok(vEdited.altered.length === 3, "列出 3 个被改格（实际 " + vEdited.altered.length + "）");
ok(vEdited.altered.every(a => [10, 80, 150].indexOf(a.index) >= 0), "被改格坐标正确");
ok(vEdited.reasons.join("").indexOf("覆盖") >= 0 || vEdited.reasons.join("").indexOf("篡改") >= 0,
   "原因声明篡改且不覆盖原方案");

// 未编辑的原始水印矩阵核验仍通过（基准正确）
const clean = reg.get(regRes.record.nonce).wmCells;
eq(WM.verify(clean, COLS, ROWS, reg.all(), NOW).status, "valid", "登记基准本身核验仍 valid");

/* ================= 4. 再次“保存”不影响登记；导出快照可往返导入 ================= */
group("四、再次保存 → 导出 → 导入 闭环");

// 页面 saveDoc 只写 localStorage 画布文档，不应触碰登记册：再次登记一条新记录模拟反复保存
const secondOriginal = makePattern(COLS, ROWS, 9);
const reg2res = reg.register(Object.assign({ name: "第二案", cols: COLS, rows: ROWS, cells: secondOriginal },
  { author: 3142, scope: 2, startYM: "2025-06", months: 36 }));
ok(reg2res.ok && reg.count() === 2, "可再次登记，共 2 条且互不影响");
ok(reg.isIntact(rec) && reg.isIntact(reg.get(reg2res.record.nonce)), "两条记录都自洽");

// 画布已被改脏；导出登记册不应包含画布的改动
const exportData = reg.exportJSON();
eq(exportData.format, "zfl31-brocade-watermark-registry", "导出格式正确");
eq(exportData.count, 2, "导出 2 条");
const exportedFirst = exportData.records.find(r => r.nonce === rec.nonce);
eq(exportedFirst.wmCells[10], baselineCell10, "★ 导出的基准格点不含画布改色");
eq(WM.fingerprint(exportedFirst.wmCells, COLS, ROWS), exportedFirst.fpWm, "导出自带指纹吻合");

// 导出对象是快照：外部改它不影响登记册
exportedFirst.wmCells[10] = exportedFirst.wmCells[10] === 6 ? 0 : 6;
ok(reg.isIntact(rec), "篡改导出快照后，登记册内部基准仍自洽");

// 重新导出（干净的）→ 导入到新登记册必须被接受
const cleanExport = reg.exportJSON();
const regImport = new Registry(new Registry.MemoryStore());
const report = regImport.importJSON(JSON.parse(JSON.stringify(cleanExport)));
ok(report.ok, "★ 再次保存后导出的登记册可被导入接受");
eq(report.rejected.length, 0, "没有被拒绝的记录（曾出现的核心缺陷）");
eq(report.added, 2, "导入 2 条");

// 导入后用被改脏的画布核验，仍判篡改
const vAfterImport = WM.verify(canvas, COLS, ROWS, regImport.all(), NOW);
eq(vAfterImport.status, "tampered", "导入的登记册核验改色画布仍判 tampered");
// 用导出的干净基准核验通过
const importedClean = regImport.all().find(r => r.nonce === rec.nonce).wmCells;
eq(WM.verify(importedClean, COLS, ROWS, regImport.all(), NOW).status, "valid", "导入基准核验 valid");

/* ================= 5. 导入侧也不共享数组引用 ================= */
group("五、导入对象与登记册内部隔离");

const probe = JSON.parse(JSON.stringify(cleanExport));
const regProbe = new Registry(new Registry.MemoryStore());
const rp = regProbe.importJSON(probe);
ok(rp.ok, "探测导入成功");
const stored = regProbe.all()[0];
ok(stored.cells !== probe.records[0].cells && stored.wmCells !== probe.records[0].wmCells,
   "★ 入库后不持有导入对象的数组引用");
probe.records[0].wmCells[5] = probe.records[0].wmCells[5] === 6 ? 0 : 6;
ok(regProbe.isIntact(stored), "改导入源对象不影响已入库基准");

/* ================= 6. 写保护仍生效 ================= */
group("六、原图/篡改图不得覆盖登记");

ok(!reg.updateRecord(rec.nonce, { wmCells: canvas }).ok, "用改色画布更新登记被拒绝");
ok(!reg.updateRecord(rec.nonce, { wmCells: original }).ok, "用未嵌水印的原图更新水印基准被拒绝");
ok(reg.updateRecord(rec.nonce, { name: "改名允许" }).ok, "仅改名称等元信息允许");
ok(reg.isIntact(reg.get(rec.nonce)), "拒绝后记录仍自洽");

/* ================= 7. 批量核验中数据隔离一致 ================= */
group("七、批量核验：改色/干净样本混合分类");

const samples = [
  { name: "干净基准", cells: clean, cols: COLS, rows: ROWS },
  { name: "改色画布", cells: canvas, cols: COLS, rows: ROWS },
  { name: "无水印彩条", cells: new Array(COLS * ROWS).fill(0).map((_, i) => i % 8), cols: COLS, rows: ROWS }
];
const batch = reg.verifyMany(samples, NOW);
eq(batch[0].status, "valid", "批量：干净样本 valid");
eq(batch[1].status, "tampered", "批量：改色样本 tampered");
eq(batch[2].status, "unknown", "批量：无水印样本 unknown");

/* ================= 汇总 ================= */
console.log("\n通过 " + passed + " 项，失败 " + failed + " 项");
if (failed) { console.log("\n失败项：\n - " + failures.join("\n - ")); process.exit(1); }
console.log("隔离专项全部通过 ✅");
