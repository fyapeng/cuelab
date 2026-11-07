// 翻袋与解球求解器。
//
// 第一步用镜像法给出几何线路：把袋口（翻袋）或目标球（解球）沿库边翻折，
// 球心碰库时所在的直线是离库边一个球半径的线，所以翻折轴取这条线。
// 第二步在几何瞄准角附近做物理扫描：每个瞄准角都完整模拟一次，
// 找出真正能完成这杆球的瞄准角区间（区间宽度就是这条线路的容错），
// 并给出物理解与镜像法的偏差——这部分偏差来自力度、旋转、库边摩擦和库边高度。

import { simulate } from './sim.js';
import { strike } from './cue.js';

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function railLines(t) {
  const { L, W, R } = t;
  return [
    { key: 'bottom', name: '下库', axis: 'y', c: R, edge: 0, segs: [0, 1] },
    { key: 'top', name: '上库', axis: 'y', c: W - R, edge: W, segs: [2, 3] },
    { key: 'left', name: '左库', axis: 'x', c: R, edge: 0, segs: [4] },
    { key: 'right', name: '右库', axis: 'x', c: L - R, edge: L, segs: [5] },
  ];
}

export function mirror(x, y, rail) {
  return rail.axis === 'y' ? [x, 2 * rail.c - y] : [2 * rail.c - x, y];
}

/** 直线 A→B 与库边中心线的交点 */
function railCross(ax, ay, bx, by, rail) {
  if (rail.axis === 'y') {
    const f = (rail.c - ay) / (by - ay);
    return [ax + (bx - ax) * f, rail.c, f];
  }
  const f = (rail.c - ax) / (bx - ax);
  return [rail.c, ay + (by - ay) * f, f];
}

function pocketOnRail(p, rail, t) {
  const tol = 0.12;
  if (rail.axis === 'y') return Math.abs(p.my - rail.edge) < tol;
  return Math.abs(p.mx - rail.edge) < tol;
}

export function runShot(balls, table, P, shot, opts = {}) {
  const { ball } = strike(balls[0], table, P, shot);
  return simulate([ball, ...balls.slice(1)], table, P, { record: false, maxTime: 20, ...opts });
}

/**
 * 在 [center−half, center+half] 内扫描瞄准角，返回满足 ok 的连续区间（取离 center 最近的一段），
 * 区间两端用二分法细化。
 */
export function scanWindow(ok, center, half, steps = 48, refine = 7) {
  const step = (2 * half) / steps;
  const at = (i) => center - half + i * step;
  const flags = [];
  for (let i = 0; i <= steps; i++) flags.push(ok(at(i)));
  const ivs = [];
  let s = -1;
  for (let i = 0; i <= steps; i++) {
    if (flags[i] && s < 0) s = i;
    if (s >= 0 && (!flags[i] || i === steps)) {
      ivs.push([s, flags[i] ? i : i - 1]);
      s = -1;
    }
  }
  if (!ivs.length) return null;
  const c = steps / 2;
  const dist = ([a, b]) => (c >= a && c <= b ? 0 : Math.min(Math.abs(a - c), Math.abs(b - c)));
  ivs.sort((p, q) => dist(p) - dist(q));
  const [si, ei] = ivs[0];
  let lo = at(si), hi = at(ei);
  if (si > 0) {
    let a = at(si - 1), b = lo;
    for (let r = 0; r < refine; r++) { const m = (a + b) / 2; if (ok(m)) b = m; else a = m; }
    lo = b;
  }
  if (ei < steps) {
    let a = hi, b = at(ei + 1);
    for (let r = 0; r < refine; r++) { const m = (a + b) / 2; if (ok(m)) a = m; else b = m; }
    hi = a;
  }
  return { lo, hi, mid: (lo + hi) / 2, width: hi - lo, clipped: si === 0 || ei === steps, segments: ivs.length };
}

/** 目标球沿某条库翻进某个袋的几何候选 */
export function bankCandidates(balls, table, ti) {
  const C = balls[0], T = balls[ti], R = table.R;
  const out = [];
  for (const rail of railLines(table)) {
    for (let k = 0; k < table.pockets.length; k++) {
      const p = table.pockets[k];
      if (pocketOnRail(p, rail, table)) continue;
      const [mx, my] = mirror(p.mx, p.my, rail);
      const [hx, hy, f] = railCross(T.x, T.y, mx, my, rail);
      if (!(f > 0 && f < 1)) continue;
      if (rail.axis === 'y' ? hx < 0.05 || hx > table.L - 0.05 : hy < 0.05 || hy > table.W - 0.05) continue;
      const dl = Math.hypot(mx - T.x, my - T.y);
      const dx = (mx - T.x) / dl, dy = (my - T.y) / dl;
      const gx = T.x - 2 * R * dx, gy = T.y - 2 * R * dy;
      const ux = gx - C.x, uy = gy - C.y;
      const D = Math.hypot(ux, uy);
      if (D < 2 * R) continue;
      const cut = Math.acos(clamp((ux * dx + uy * dy) / D, -1, 1)) / DEG;
      if (cut > 75) continue;
      out.push({
        type: 'bank', pocket: k, rail: rail.key, railName: rail.name, segs: rail.segs,
        mirror: [mx, my], railHit: [hx, hy], ghost: [gx, gy],
        geomAim: Math.atan2(uy, ux), mirrorDir: Math.atan2(dy, dx), cut, D,
      });
    }
  }
  return out;
}

/** 母球先吃一库再碰到目标球的几何候选 */
export function kickCandidates(balls, table, ti) {
  const C = balls[0], T = balls[ti];
  const out = [];
  for (const rail of railLines(table)) {
    const [mx, my] = mirror(T.x, T.y, rail);
    const [hx, hy, f] = railCross(C.x, C.y, mx, my, rail);
    if (!(f > 0 && f < 1)) continue;
    if (rail.axis === 'y' ? hx < 0.05 || hx > table.L - 0.05 : hy < 0.05 || hy > table.W - 0.05) continue;
    const D = Math.hypot(mx - C.x, my - C.y);
    out.push({
      type: 'kick', rail: rail.key, railName: rail.name, segs: rail.segs,
      mirror: [mx, my], railHit: [hx, hy],
      geomAim: Math.atan2(my - C.y, mx - C.x), D,
    });
  }
  return out;
}

function bankOk(r, ti, cand) {
  const fh = r.firstHit;
  if (!fh || fh.obj !== ti) return false;
  const b = r.balls[ti];
  if (b.on || b.pocket !== cand.pocket) return false;
  if (!r.balls[0].on) return false;
  const cush = r.events.filter((e) => e.type === 'cushion' && e.i === ti);
  return cush.length === 1 && cand.segs.includes(cush[0].seg);
}

function kickOk(r, ti, cand) {
  const fh = r.firstHit;
  return !!fh && fh.obj === ti && fh.cueCushBefore === 1 && cand.segs.includes(fh.cueFirstSeg);
}

const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/** 对一个候选做物理扫描。返回 null 表示这条线路在当前力度和旋转下打不成。 */
export function solveCandidate(balls, table, P, shot, ti, cand) {
  const R = table.R;
  let half, ok;
  if (cand.type === 'bank') {
    // 母球瞄准角的微小变化会被放大约 D/(2R) 倍变成目标球方向的变化
    half = clamp((10 * DEG * 2 * R) / cand.D, 0.25 * DEG, 5 * DEG);
    ok = (aim) => bankOk(runShot(balls, table, P, { ...shot, aim }, { stopIndex: ti }), ti, cand);
  } else {
    half = clamp((4 * R) / cand.D + 1.5 * DEG, 0.6 * DEG, 8 * DEG);
    ok = (aim) => kickOk(runShot(balls, table, P, { ...shot, aim }, { stopOnFirstHit: true }), ti, cand);
  }
  const w = scanWindow(ok, cand.geomAim, half, cand.type === 'bank' ? 72 : 48, 7);
  if (!w) return null;
  const sol = { ...cand, aim: w.mid, width: w.width, lo: w.lo, hi: w.hi, aimShift: angDiff(w.mid, cand.geomAim) };
  // 在区间中点完整模拟一次，给出教学用的细节
  const r = runShot(balls, table, P, { ...shot, aim: w.mid });
  const fh = r.firstHit;
  if (cand.type === 'bank') {
    sol.objDir = fh ? fh.objDir : NaN;
    // 目标球实际出射方向与镜像法方向之差：正值表示要比镜像线“更偏左”地送出
    sol.dirShift = fh ? angDiff(fh.objDir, cand.mirrorDir) : NaN;
    sol.cutActual = fh ? fh.cut : NaN;
    sol.scratch = !r.balls[0].on;
  } else {
    sol.cut = fh ? fh.cut : NaN;
    const tb = r.balls[ti];
    sol.targetPotted = !tb.on;
    sol.targetPocket = tb.pocket;
    sol.scratch = !r.balls[0].on;
  }
  sol.cueEnd = r.balls[0].on ? [r.balls[0].x, r.balls[0].y] : null;
  return sol;
}

/** 进袋窗口：当前这杆在瞄准角附近能把目标球打进的区间 */
export function potWindow(balls, table, P, shot, ti, pocket, D) {
  const R = table.R;
  // 搜索范围对应目标球出射方向约 ±25°，足以在当前不进时找到最近的进袋方向
  const half = clamp((25 * DEG * 2 * R) / Math.max(D, 0.05), 0.3 * DEG, 6 * DEG);
  const ok = (aim) => {
    const r = runShot(balls, table, P, { ...shot, aim }, { stopIndex: ti });
    const fh = r.firstHit;
    if (!fh || fh.obj !== ti) return false;
    const b = r.balls[ti];
    return !b.on && (pocket < 0 || b.pocket === pocket);
  };
  const w = scanWindow(ok, shot.aim, half, 100, 8);
  if (!w) return { found: false, half };
  return { found: true, lo: angDiff(w.lo, shot.aim), hi: angDiff(w.hi, shot.aim), width: w.width, clipped: w.clipped, half, loAim: w.lo, hiAim: w.hi };
}
