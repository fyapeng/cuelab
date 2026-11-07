// 电脑对手。思路与常见的台球 AI 相同：
//   1. 枚举“目标球 × 袋口”的直接进攻线路，用几何难度（切角、距离、进袋角度、是否被挡）粗筛；
//   2. 对较好的线路尝试多种力度和高低杆，每种完整模拟一次，要求目标球进袋且不犯规，
//      再用“母球停点处下一杆的难度”评估走位；
//   3. 对最好的几种方案加入出杆误差重复模拟，估计真实进球率，综合进球率和走位选出一杆；
//   4. 直接进攻的把握不够时，考虑一库翻袋：镜像法给出几何线路，物理扫描找到真正能进的瞄准区间；
//   5. 找不到靠谱的进攻时打防守：合法碰到目标球，并让对手的下一杆尽量难；
//      被做了斯诺克、直线碰不到目标球时，用一库解球。
// 自由球时先在允许区域内挑几个好的母球位置，再分别规划。

import { simulate } from '../physics/sim.js';
import { strike } from '../physics/cue.js';
import { perturbShot, makeRng } from '../physics/noise.js';
import { bankCandidates, kickCandidates, solveCandidate } from '../physics/solver.js';

export function cueSpeedFor(ballSpeed, table, P) {
  return (ballSpeed * (1 + table.m / P.cueMass)) / (1 + P.tipE);
}

function run(table, P, balls, shot) {
  const { ball } = strike(balls[0], table, P, shot);
  return simulate([ball, ...balls.slice(1)], table, P, { record: false, maxTime: 25 });
}

/** 线段 A→B 是否被除 skip 外的球挡住（与球心距离小于 2R） */
function blocked(ax, ay, bx, by, balls, skip, R) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  for (let i = 0; i < balls.length; i++) {
    if (skip.includes(i) || balls[i].on === false) continue;
    const b = balls[i];
    let t = ((b.x - ax) * dx + (b.y - ay) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(ax + dx * t - b.x, ay + dy * t - b.y) < 2 * R - 1e-4) return true;
  }
  return false;
}

/** 从母球位置 (cx, cy) 出发、对 targets 中各球的直接进攻线路，按 ease（越大越好打）排序 */
export function directShots(table, balls, cx, cy, targets, values = null) {
  const R = table.R;
  const out = [];
  for (const t of targets) {
    const T = balls[t];
    if (!T || T.on === false) continue;
    for (let k = 0; k < table.pockets.length; k++) {
      const p = table.pockets[k];
      const ax = p.mx + p.nx * R * 0.3, ay = p.my + p.ny * R * 0.3;
      let dx = ax - T.x, dy = ay - T.y;
      const d2 = Math.hypot(dx, dy);
      dx /= d2; dy /= d2;
      const approach = Math.acos(Math.max(-1, Math.min(1, dx * p.nx + dy * p.ny)));
      if (approach > (p.corner ? 62 : 48) * (Math.PI / 180)) continue;
      const gx = T.x - 2 * R * dx, gy = T.y - 2 * R * dy;
      if (gx < R || gx > table.L - R || gy < R || gy > table.W - R) continue;
      const ux = gx - cx, uy = gy - cy;
      const d1 = Math.hypot(ux, uy);
      if (d1 < 1e-3) continue;
      const cosCut = (ux * dx + uy * dy) / d1;
      if (cosCut < Math.cos((78 * Math.PI) / 180)) continue;
      if (blocked(cx, cy, gx, gy, balls, [0, t], R)) continue;
      if (blocked(T.x, T.y, ax, ay, balls, [0, t], R)) continue;
      const ease = (cosCut ** 1.5 * Math.cos(approach) ** 0.5) / ((0.35 + d1) * (0.35 + d2));
      const w = values ? 0.6 + 0.4 * (values[t] / 7) : 1;
      out.push({ t, k, aim: Math.atan2(uy, ux), ease, score: ease * w, cut: Math.acos(Math.min(1, cosCut)), d1, d2, dir: Math.atan2(dy, dx) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function positionValue(table, balls, targets, values) {
  const c = balls[0];
  if (!c || c.on === false) return 0;
  const ds = directShots(table, balls, c.x, c.y, targets.filter((i) => balls[i] && balls[i].on !== false), values);
  // 最好的一杆为主，第二好的一杆作为“备选”加分：走位留有余地比只有一条线路更稳
  return ds.length ? ds[0].score + 0.35 * (ds[1]?.score ?? 0) : 0;
}

/**
 * 各档电脑的思考深度。出杆误差另见 presets.js 的 NOISE_LEVELS（电脑用同名档位的误差出杆，也用它来估计进球率）。
 *   cands   每杆考虑的直接进攻线路数
 *   K       估计进球率时每个方案的模拟次数
 *   side    是否尝试左右塞；refine 是否在最好方案附近细调
 *   attack  估计进球率低于这个值时，如果有像样的防守就改打防守
 *   safetyAims  防守时每颗球尝试的厚薄数
 */
export const AI_LEVELS = {
  beginner: { cands: 4, K: 6, side: false, refine: false, attack: 0.12, safetyAims: 3, bank: false },
  amateur: { cands: 5, K: 8, side: false, refine: false, attack: 0.25, safetyAims: 5, bank: true },
  club: { cands: 7, K: 10, side: true, refine: true, attack: 0.35, safetyAims: 5, bank: true },
  pro: { cands: 8, K: 14, side: true, refine: true, attack: 0.45, safetyAims: 7, bank: true },
  elite: { cands: 9, K: 18, side: true, refine: true, attack: 0.5, safetyAims: 9, bank: true },
};
const cfgOf = (ctx) => AI_LEVELS[ctx.level] ?? AI_LEVELS.pro;

// 力度（母球初速 m/s）× 高低杆 × 左右塞（单位 R）。前 10 组是原来的高低杆组合，后面加入左右塞。
const VARIANTS = [
  [0.8, 0, 0], [1.2, 0, 0], [1.2, 0.3, 0], [1.2, -0.35, 0], [1.8, 0, 0], [1.8, 0.3, 0], [1.8, -0.35, 0],
  [2.6, 0, 0], [2.6, -0.4, 0], [3.6, 0, 0],
  [1.2, 0, 0.3], [1.2, 0, -0.3], [1.8, 0, 0.3], [1.8, 0, -0.3], [1.8, 0.3, 0.3], [1.8, 0.3, -0.3],
  [1.8, -0.35, 0.3], [1.8, -0.35, -0.3], [2.6, 0, 0.3], [2.6, 0, -0.3],
];

const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/**
 * 修正瞄准：加塞会让母球偏离球杆方向（偏杆、弧线），球间摩擦会让目标球偏离连心线（投掷），
 * 只瞄几何假想球会打偏。这里用割线法迭代瞄准角，使目标球的实际出射方向等于指向袋口的方向。
 * 每次迭代只模拟到母球第一次碰球为止，开销很小。返回 null 表示碰不到目标球。
 */
export function correctAim(table, P, balls, shot, t, desiredDir) {
  const err = (aim) => {
    const { ball } = strike(balls[0], table, P, { ...shot, aim });
    const r = simulate([ball, ...balls.slice(1)], table, P, { record: false, stopOnFirstHit: true, maxTime: 10 });
    if (!r.firstHit || r.firstHit.obj !== t) return NaN;
    return angDiff(r.firstHit.objDir, desiredDir);
  };
  let a0 = shot.aim, e0 = err(a0);
  if (!Number.isFinite(e0)) return null;
  if (Math.abs(e0) < 2e-4) return a0;
  // 瞄准角往左偏，母球碰到目标球右侧，目标球往右走：斜率为负，量级约 D/(2R)。先按这个估计走一步
  const c = balls[0], T = balls[t];
  const D = Math.max(Math.hypot(T.x - c.x, T.y - c.y) - 2 * table.R, 2 * table.R);
  let step = (e0 * 2 * table.R) / D;
  let a1 = a0 + step, e1 = err(a1);
  for (let k = 0; k < 3 && !Number.isFinite(e1); k++) { step /= 2; a1 = a0 + step; e1 = err(a1); }
  for (let k = 0; k < 6; k++) {
    if (!Number.isFinite(e1)) return null;
    if (Math.abs(e1) < 2e-4) break;
    const slope = (e1 - e0) / (a1 - a0);
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-6) break;
    const a2 = a1 - e1 / slope;
    a0 = a1; e0 = e1;
    a1 = a2; e1 = err(a2);
  }
  return Number.isFinite(e1) && Math.abs(e1) < 0.01 ? a1 : null;
}

function potOk(res, t, ctx) {
  if (!res.balls[0].on) return false;
  if (!res.firstHit || !ctx.targets.includes(res.firstHit.obj)) return false;
  if (res.balls[t].on) return false;
  for (const f of ctx.forbidden) if (!res.balls[f].on) return false;
  return true;
}

/** 试一组出杆参数：修正瞄准 → 完整模拟 → 要求进球不犯规 → 评估走位 */
function tryStroke(ctx, balls, cand, v, h, sd) {
  const { table, phys: P } = ctx;
  const base = { aim: cand.aim, speed: cueSpeedFor(v, table, P), side: sd, height: h, elev: 0 };
  const aim = correctAim(table, P, balls, base, cand.t, cand.dir);
  if (aim === null) return null;
  const shot = { ...base, aim };
  const res = run(table, P, balls, shot);
  if (!potOk(res, cand.t, ctx)) return null;
  const next = ctx.nextTargets(cand.t).filter((i) => res.balls[i].on);
  const pos = next.length ? positionValue(table, res.balls, next, ctx.values) : 0.5;
  return { cand, shot, ballSpeed: v, pos, pre: cand.score * (0.4 + pos) };
}

function scoreStroke(ctx, balls, f, rng) {
  const K = cfgOf(ctx).K;
  let ok = 0;
  for (let k = 0; k < K; k++) {
    const s = perturbShot(f.shot, ctx.noise, ctx.table.R, rng);
    if (potOk(run(ctx.table, ctx.phys, balls, s), f.cand.t, ctx)) ok++;
  }
  f.p = ok / K;
  const val = ctx.values ? ctx.values[f.cand.t] : 1;
  f.score = f.p * (1 + 0.15 * val + 2.5 * Math.min(f.pos, 1.5)) - (1 - f.p) * 0.4;
  return f;
}

/** 在最好的方案附近对力度、高低杆、左右塞各做一轮小范围调整，更好就采用 */
function refineStroke(ctx, balls, best, rng) {
  let cur = best;
  const tweaks = [
    [cur.ballSpeed * 0.85, cur.shot.height, cur.shot.side],
    [cur.ballSpeed * 1.15, cur.shot.height, cur.shot.side],
    [cur.ballSpeed, cur.shot.height + 0.15, cur.shot.side],
    [cur.ballSpeed, cur.shot.height - 0.15, cur.shot.side],
    [cur.ballSpeed, cur.shot.height, cur.shot.side + 0.15],
    [cur.ballSpeed, cur.shot.height, cur.shot.side - 0.15],
  ];
  for (const [v, h, sd] of tweaks) {
    if (Math.hypot(h, sd) > 0.5) continue; // 不超出滑杆界限
    const f = tryStroke(ctx, balls, best.cand, v, h, sd);
    if (!f || f.pre < cur.pre * 0.9) continue;
    scoreStroke(ctx, balls, f, rng);
    if (f.score > cur.score) cur = f;
  }
  return cur;
}

function planFrom(ctx, balls, rng, opts = {}) {
  const cfg = cfgOf(ctx);
  const refine = opts.refine ?? cfg.refine;
  const nCands = opts.nCands ?? cfg.cands;
  const { table } = ctx;
  const c = balls[0];
  const cands = directShots(table, balls, c.x, c.y, ctx.targets, ctx.values).slice(0, nCands);
  const variants = cfg.side ? VARIANTS : VARIANTS.filter((v) => v[2] === 0);
  const found = [];
  for (const cand of cands) {
    for (const [v, h, sd] of variants) {
      const f = tryStroke(ctx, balls, cand, v, h, sd);
      if (f) found.push(f);
    }
  }
  found.sort((a, b) => b.pre - a.pre);
  let best = null;
  for (const f of found.slice(0, 6)) {
    scoreStroke(ctx, balls, f, rng);
    if (!best || f.score > best.score) best = f;
  }
  if (best && refine) best = refineStroke(ctx, balls, best, rng);
  return best;
}

function safetyFrom(ctx, balls) {
  const { table, phys: P } = ctx;
  const R = table.R;
  const c = balls[0];
  const ts = ctx.targets
    .map((i) => ({ i, d: Math.hypot(balls[i].x - c.x, balls[i].y - c.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  let best = null;
  for (const { i, d } of ts) {
    const base = Math.atan2(balls[i].y - c.y, balls[i].x - c.x);
    const n = cfgOf(ctx).safetyAims;
    const offs = Array.from({ length: n }, (_, k) => (n === 1 ? 0 : -0.9 + (1.8 * k) / (n - 1)));
    const speeds = n >= 7 ? [0.7, 1.2, 2.0, 3.0] : [0.9, 1.6, 2.6];
    for (const off of offs) {
      const aim = base + Math.asin(Math.max(-0.99, Math.min(0.99, (off * 2 * R) / Math.max(d, 2 * R))));
      for (const v of speeds) {
        const shot = { aim, speed: cueSpeedFor(v, table, P), side: 0, height: 0, elev: 0 };
        const res = run(table, P, balls, shot);
        if (!res.balls[0].on || !res.firstHit || !ctx.targets.includes(res.firstHit.obj)) continue;
        if (ctx.forbidden.some((f) => !res.balls[f].on)) continue;
        const anyPot = res.balls.some((b, k) => k > 0 && !b.on);
        const rail = res.events.some((e) => e.t >= res.firstHit.t && e.type === 'cushion');
        if (!rail && !anyPot) continue;
        const opp = ctx.oppTargets.filter((k) => res.balls[k].on);
        const oppEase = positionValue(table, res.balls, opp, ctx.values);
        const score = -oppEase + (anyPot ? 0.3 : 0);
        if (!best || score > best.score) best = { shot, ballSpeed: v, score, oppEase };
      }
    }
  }
  return best;
}

const DEG = Math.PI / 180;

/** 估计一杆在出杆误差下的成功率 */
function successRate(ctx, balls, shot, ok, rng, K = 10) {
  let n = 0;
  for (let k = 0; k < K; k++) if (ok(run(ctx.table, ctx.phys, balls, perturbShot(shot, ctx.noise, ctx.table.R, rng)))) n++;
  return n / K;
}

/**
 * 一库翻袋：对每个目标球的几何候选（镜像法），先用路线是否被挡、切角和距离粗筛，
 * 再用求解器在两种力度下做物理扫描，取能进的瞄准区间中点，最后估计误差下的成功率。
 */
export function bankFrom(ctx, balls, rng) {
  const { table, phys: P } = ctx;
  const R = table.R;
  const c = balls[0];
  let cands = [];
  for (const t of ctx.targets) {
    const T = balls[t];
    for (const k of bankCandidates(balls, table, t)) {
      const p = table.pockets[k.pocket];
      if (blocked(c.x, c.y, k.ghost[0], k.ghost[1], balls, [0, t], R)) continue;
      if (blocked(T.x, T.y, k.railHit[0], k.railHit[1], balls, [0, t], R)) continue;
      if (blocked(k.railHit[0], k.railHit[1], p.mx, p.my, balls, [0, t], R)) continue;
      cands.push({ ...k, t });
    }
  }
  cands.sort((a, b) => a.cut / 45 + a.D - (b.cut / 45 + b.D));
  cands = cands.slice(0, 4);
  let best = null;
  for (const cand of cands) {
    for (const v of [1.6, 2.6]) {
      const base = { aim: cand.geomAim, speed: cueSpeedFor(v, table, P), side: 0, height: 0, elev: 0 };
      const sol = solveCandidate(balls, table, P, base, cand.t, cand);
      if (!sol) continue;
      const shot = { ...base, aim: sol.aim };
      const res = run(table, P, balls, shot);
      if (!potOk(res, cand.t, ctx)) continue;
      const next = ctx.nextTargets(cand.t).filter((i) => res.balls[i].on);
      const pos = next.length ? positionValue(table, res.balls, next, ctx.values) : 0.5;
      const p = successRate(ctx, balls, shot, (r) => potOk(r, cand.t, ctx) && !r.balls[cand.t].on && r.balls[cand.t].pocket === cand.pocket, rng);
      const val = ctx.values ? ctx.values[cand.t] : 1;
      const score = p * (1 + 0.15 * val + 2.5 * Math.min(pos, 1.5)) - (1 - p) * 0.4;
      if (!best || score > best.score) {
        best = {
          kind: 'bank', shot, ballSpeed: v, p, pos, score, width: sol.width,
          guide: { type: 'bank', rail: cand.rail, railHit: cand.railHit, mirror: cand.mirror, pocket: cand.pocket, ti: cand.t },
        };
      }
    }
  }
  return best;
}

/**
 * 一库解球：直线碰不到任何目标球时，对最近的几颗目标球按镜像法找吃一库后先碰到它的线路，
 * 合法（碰球后有球碰库或进袋、母球不落袋、不打进禁止的球）的方案里选对手最难打的。
 */
export function kickFrom(ctx, balls) {
  const { table, phys: P } = ctx;
  const c = balls[0];
  const ts = ctx.targets
    .map((i) => ({ i, d: Math.hypot(balls[i].x - c.x, balls[i].y - c.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);
  let best = null;
  for (const { i } of ts) {
    for (const cand of kickCandidates(balls, table, i)) {
      for (const v of [1.6, 2.6]) {
        const base = { aim: cand.geomAim, speed: cueSpeedFor(v, table, P), side: 0, height: 0, elev: 0 };
        const sol = solveCandidate(balls, table, P, base, i, cand);
        if (!sol) continue;
        const shot = { ...base, aim: sol.aim };
        const res = run(table, P, balls, shot);
        if (!res.balls[0].on || !res.firstHit || !ctx.targets.includes(res.firstHit.obj)) continue;
        if (ctx.forbidden.some((f) => !res.balls[f].on)) continue;
        const anyPot = res.balls.some((b, k) => k > 0 && !b.on);
        const rail = res.events.some((e) => e.t > res.firstHit.t && e.type === 'cushion');
        if (!rail && !anyPot) continue;
        const opp = ctx.oppTargets.filter((k) => res.balls[k].on);
        const oppEase = positionValue(table, res.balls, opp, ctx.values);
        // 容错越宽越好：窗口每宽 1° 相当于对手难度降低 0.3
        const score = -oppEase + (anyPot ? 0.3 : 0) + 0.3 * Math.min(sol.width / DEG, 3);
        if (!best || score > best.score) {
          best = {
            kind: 'kick', shot, ballSpeed: v, score, oppEase, width: sol.width,
            guide: { type: 'kick', rail: cand.rail, railHit: cand.railHit, mirror: cand.mirror, ti: i },
          };
        }
      }
    }
  }
  return best;
}

function handPositions(ctx, balls) {
  const { table } = ctx;
  const R = table.R;
  const pts = [];
  const free = (x, y) => balls.every((b, i) => i === 0 || b.on === false || Math.hypot(b.x - x, b.y - y) > 2.1 * R);
  // 每条直接线路“正后方”若干位置（小切角、距离适中）
  for (const t of ctx.targets) {
    const T = balls[t];
    for (const p of table.pockets) {
      let dx = p.mx - T.x, dy = p.my - T.y;
      const L = Math.hypot(dx, dy);
      dx /= L; dy /= L;
      for (const dist of [0.22, 0.4, 0.65]) {
        for (const a of [-0.35, -0.15, 0.15, 0.35]) {
          const ca = Math.cos(a), sa = Math.sin(a);
          const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
          pts.push([T.x - 2 * R * dx - rx * dist, T.y - 2 * R * dy - ry * dist]);
        }
      }
    }
  }
  for (let i = 1; i < 10; i++) for (let j = 1; j < 5; j++) pts.push([(table.L * i) / 10, (table.W * j) / 5]);
  const scored = [];
  for (const [x, y] of pts) {
    if (!ctx.inRegion(x, y) || !free(x, y)) continue;
    const ds = directShots(table, balls, x, y, ctx.targets, ctx.values);
    if (ds.length) scored.push({ x, y, s: ds[0].score });
  }
  scored.sort((a, b) => b.s - a.s);
  const picked = [];
  for (const s of scored) {
    if (picked.every((p) => Math.hypot(p.x - s.x, p.y - s.y) > 0.15)) picked.push(s);
    if (picked.length >= 4) break;
  }
  return picked;
}

/**
 * ctx: { table, phys, balls, targets, forbidden, oppTargets, values, noise,
 *        nextTargets(t) → 打进 t 之后下一杆的目标球, inRegion(x,y) | null（非自由球时为 null）, seed }
 */
export function planShot(ctx) {
  const rng = makeRng(ctx.seed ?? 7);
  const cfg = cfgOf(ctx);
  let balls = ctx.balls;
  let best = null;
  if (ctx.inRegion) {
    for (const p of handPositions(ctx, balls)) {
      const bs = balls.map((b, i) => (i === 0 ? { ...b, x: p.x, y: p.y } : b));
      const plan = planFrom(ctx, bs, rng, { refine: false, nCands: Math.min(5, cfg.cands) });
      if (plan && (!best || plan.score > best.score)) best = { ...plan, cue: [p.x, p.y], bs };
    }
    if (best && cfg.refine) {
      const cue = best.cue, bs = best.bs;
      best = { ...refineStroke(ctx, bs, best, rng), cue };
      delete best.bs;
    }
    if (!best) {
      // 没有好的进攻位置：放在区域内一个合法位置打防守
      const c = handPositions({ ...ctx, targets: ctx.targets }, balls)[0];
      if (c) balls = balls.map((b, i) => (i === 0 ? { ...b, x: c.x, y: c.y } : b));
      const s = safetyFrom(ctx, balls) ?? kickFrom(ctx, balls);
      if (s) return { kind: 'safety', ...s, cue: [balls[0].x, balls[0].y] };
    } else if (best.p >= cfg.attack) return { kind: 'pot', ...best };
    else balls = balls.map((b, i) => (i === 0 ? { ...b, x: best.cue[0], y: best.cue[1] } : b));
  } else {
    best = planFrom(ctx, balls, rng);
    if (best && best.p >= cfg.attack) return { kind: 'pot', ...best };
    // 直接进攻把握不够：看看一库翻袋
    const bank = cfg.bank ? bankFrom(ctx, balls, rng) : null;
    if (bank && (!best || bank.score > best.score)) best = bank;
    if (best && best.p >= cfg.attack) return { kind: 'pot', ...best };
  }
  // 防守；直线碰不到目标球（被做斯诺克）时一库解球
  const safe = safetyFrom(ctx, balls) ?? kickFrom(ctx, balls);
  // 进攻把握不够时，防守能让对手只剩中等以下难度的球就打防守；否则硬打
  if (safe && (!best || best.p < 0.15 || safe.oppEase < 0.6)) return { kind: 'safety', ...safe, cue: best?.cue };
  if (best) return { kind: 'pot', ...best };
  // 兜底：全球对准最近的目标球
  const c = balls[0];
  const t = ctx.targets
    .map((i) => ({ i, d: Math.hypot(balls[i].x - c.x, balls[i].y - c.y) }))
    .sort((a, b) => a.d - b.d)[0];
  const aim = t ? Math.atan2(balls[t.i].y - c.y, balls[t.i].x - c.x) : 0;
  return { kind: 'fallback', shot: { aim, speed: cueSpeedFor(1.5, ctx.table, ctx.phys), side: 0, height: 0, elev: 0 }, ballSpeed: 1.5 };
}
