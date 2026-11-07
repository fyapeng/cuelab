// 台球运动模拟引擎。
//
// 球在台呢上的运动分四种状态，每种状态内的运动都有解析解：
//   滑动 SLIDING：接触点相对台呢有速度 u≠0，滑动摩擦 μs·g 方向恒定（沿 -û），轨迹为抛物线；
//                 u 以 (7/2)μs·g 的速率线性衰减，经 t = 2|u|/(7μs·g) 进入纯滚动。
//   滚动 ROLLING：u=0，仅受滚动阻力 μr·g 减速，直线运动。
//   原地旋转 SPINNING：速度为零但仍有竖直轴旋转，ωz 线性衰减。
//   静止 STATIONARY。
// 碰撞（球-球、球-库、袋角）按冲量模型瞬时处理，包含库边接触点高于球心的影响和球间摩擦（投掷效应）。
// 时间推进：固定步长内用解析解推进，并在步长内求解最早碰撞时刻（连续碰撞检测）后拆分步长。

import { G } from './presets.js';

export const MODE = { STATIONARY: 0, SPINNING: 1, ROLLING: 2, SLIDING: 3 };
export const MODE_NAME = ['静止', '原地旋转', '滚动', '滑动'];

const EPS_U = 1e-4; // m/s
const EPS_V = 1e-4; // m/s
const EPS_WZ = 1e-2; // rad/s

export function ballMode(b, R) {
  const ux = b.vx - R * b.wy;
  const uy = b.vy + R * b.wx;
  if (ux * ux + uy * uy > EPS_U * EPS_U) return MODE.SLIDING;
  if (b.vx * b.vx + b.vy * b.vy > EPS_V * EPS_V) return MODE.ROLLING;
  if (Math.abs(b.wz) > EPS_WZ) return MODE.SPINNING;
  return MODE.STATIONARY;
}

function decaySpinZ(b, tau, R, P) {
  if (b.wz === 0) return;
  const dw = (5 * P.mu_sp * G / (2 * R)) * tau;
  const a = Math.abs(b.wz) - dw;
  b.wz = a > 0 ? Math.sign(b.wz) * a : 0;
}

/**
 * 用解析解把一个球推进 t 秒（期间可能发生滑动→滚动→静止的状态切换）。
 * 返回值：推进过程中是否发生了 滑动→滚动 切换。
 */
export function advanceBall(b, t, R, P) {
  let rolledNow = false;
  let guard = 0;
  while (t > 1e-15 && guard++ < 8) {
    const mode = ballMode(b, R);
    if (mode === MODE.SLIDING) {
      const ux = b.vx - R * b.wy, uy = b.vy + R * b.wx;
      const u = Math.hypot(ux, uy);
      const hx = ux / u, hy = uy / u;
      const a = P.mu_s * G;
      const ts = (2 * u) / (7 * a);
      const tau = Math.min(t, ts);
      b.x += b.vx * tau - 0.5 * a * hx * tau * tau;
      b.y += b.vy * tau - 0.5 * a * hy * tau * tau;
      b.vx -= a * hx * tau;
      b.vy -= a * hy * tau;
      const k = (5 * a) / (2 * R);
      b.wx -= k * hy * tau;
      b.wy += k * hx * tau;
      decaySpinZ(b, tau, R, P);
      if (tau >= ts) {
        // 精确进入纯滚动
        b.wx = -b.vy / R;
        b.wy = b.vx / R;
        rolledNow = true;
      }
      t -= tau;
    } else if (mode === MODE.ROLLING) {
      const v = Math.hypot(b.vx, b.vy);
      const hx = b.vx / v, hy = b.vy / v;
      const a = P.mu_r * G;
      const tr = v / a;
      const tau = Math.min(t, tr);
      const d = v * tau - 0.5 * a * tau * tau;
      b.x += hx * d;
      b.y += hy * d;
      const v2 = tau >= tr ? 0 : v - a * tau;
      b.vx = hx * v2;
      b.vy = hy * v2;
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
      decaySpinZ(b, tau, R, P);
      t -= tau;
    } else if (mode === MODE.SPINNING) {
      decaySpinZ(b, t, R, P);
      b.vx = b.vy = b.wx = b.wy = 0;
      t = 0;
    } else {
      b.vx = b.vy = b.wx = b.wy = b.wz = 0;
      t = 0;
    }
  }
  return rolledNow;
}

// ---------- 碰撞检测（步长内按线性运动求最早接触时刻） ----------

const hit = { s: 0, nx: 0, ny: 0 };

/** 球心与线段（视为半径 R 的胶囊）的最早接触时刻，返回 s 或 Infinity，法向写入 hit */
function segmentTOI(px, py, vx, vy, R, sg, maxS) {
  let best = Infinity;
  // 线段所在直线
  let d0 = (px - sg.ax) * sg.nx + (py - sg.ay) * sg.ny;
  let sx = sg.nx, sy = sg.ny;
  if (d0 < 0) { d0 = -d0; sx = -sx; sy = -sy; }
  const vn = vx * sx + vy * sy;
  if (vn < 0) {
    let s = (d0 - R) / -vn;
    if (s < 0) s = 0;
    if (s <= maxS) {
      const cx = px + vx * s, cy = py + vy * s;
      const along = (cx - sg.ax) * sg.ex + (cy - sg.ay) * sg.ey;
      if (along >= 0 && along <= sg.len) {
        best = s;
        hit.nx = sx; hit.ny = sy;
      }
    }
  }
  // 两个端点（圆角）
  for (let e = 0; e < 2; e++) {
    const ex = e === 0 ? sg.ax : sg.bx, ey = e === 0 ? sg.ay : sg.by;
    const dx = px - ex, dy = py - ey;
    const b = dx * vx + dy * vy;
    if (b >= 0) continue;
    const c = dx * dx + dy * dy - R * R;
    const a = vx * vx + vy * vy;
    let s;
    if (c <= 0) s = 0;
    else {
      const disc = b * b - a * c;
      if (disc < 0) continue;
      s = (-b - Math.sqrt(disc)) / a;
    }
    if (s < best && s <= maxS) {
      const cx = dx + vx * s, cy = dy + vy * s;
      const l = Math.hypot(cx, cy) || 1;
      best = s;
      hit.nx = cx / l; hit.ny = cy / l;
    }
  }
  return best;
}

function pairTOI(a, b, R2, maxS) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const wx = b.vx - a.vx, wy = b.vy - a.vy;
  const bb = dx * wx + dy * wy;
  if (bb >= 0) return Infinity; // 没有相互接近
  const c = dx * dx + dy * dy - R2;
  if (c <= 0) return 0;
  const aa = wx * wx + wy * wy;
  const disc = bb * bb - aa * c;
  if (disc < 0) return Infinity;
  const s = (-bb - Math.sqrt(disc)) / aa;
  return s <= maxS ? s : Infinity;
}

// ---------- 碰撞响应 ----------

/** 球-球碰撞：法向恢复 + 接触点库仑摩擦（投掷效应） */
export function collideBalls(a, b, R, m, P) {
  let nx = b.x - a.x, ny = b.y - a.y;
  const d = Math.hypot(nx, ny) || 1;
  nx /= d; ny /= d;
  const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (vn <= 0) return null;
  const Jn = ((1 + P.e_ball) * vn * m) / 2;
  const I = 0.4 * m * R * R;
  const rx = R * nx, ry = R * ny; // a 的接触点相对球心；b 为其相反数
  // 接触点表面速度 v + ω × r
  const cax = a.vx - a.wz * ry, cay = a.vy + a.wz * rx, caz = a.wx * ry - a.wy * rx;
  const cbx = b.vx + b.wz * ry, cby = b.vy - b.wz * rx, cbz = -(b.wx * ry - b.wy * rx);
  let sx = cax - cbx, sy = cay - cby, sz = caz - cbz;
  const sn = sx * nx + sy * ny;
  sx -= sn * nx; sy -= sn * ny;
  const smag = Math.hypot(sx, sy, sz);
  let Jtx = 0, Jty = 0, Jtz = 0;
  if (P.throw && smag > 1e-9) {
    // Alciatore 实测拟合：球间摩擦系数随相对滑动速度下降
    const mu = 0.00995 + 0.108 * Math.exp(-1.088 * smag);
    const Jt = Math.min(mu * Jn, (m * smag) / 7);
    Jtx = (Jt * sx) / smag; Jty = (Jt * sy) / smag; Jtz = (Jt * sz) / smag;
  }
  // 作用在 a 上的冲量 Ja = -Jn n - Jt t；b 上为 -Ja
  const Jax = -Jn * nx - Jtx, Jay = -Jn * ny - Jty, Jaz = -Jtz;
  a.vx += Jax / m; a.vy += Jay / m;
  b.vx -= Jax / m; b.vy -= Jay / m;
  // Δω = r × J / I；a: r = R n, J = Ja；b: r = -R n, J = -Ja，两者相同
  const dwx = (ry * Jaz) / I, dwy = (-rx * Jaz) / I, dwz = (rx * Jay - ry * Jax) / I;
  a.wx += dwx; a.wy += dwy; a.wz += dwz;
  b.wx += dwx; b.wy += dwy; b.wz += dwz;
  return { vn, Jn, nx, ny };
}

/** 球-库碰撞：接触点高于球心（sinφ），法向恢复 + 接触点库仑摩擦。n 指向台内。 */
export function collideCushion(b, nx, ny, R, m, P, sinPhi) {
  const vn = -(b.vx * nx + b.vy * ny);
  if (vn <= 0) return null;
  const cosPhi = Math.sqrt(1 - sinPhi * sinPhi);
  const rx = -R * cosPhi * nx, ry = -R * cosPhi * ny, rz = R * sinPhi;
  const Jn = (1 + P.e_cushion) * m * vn;
  const cx = b.vx + (b.wy * rz - b.wz * ry);
  const cy = b.vy + (b.wz * rx - b.wx * rz);
  const cz = b.wx * ry - b.wy * rx;
  const cn = cx * nx + cy * ny;
  const sx = cx - cn * nx, sy = cy - cn * ny, sz = cz;
  const smag = Math.hypot(sx, sy, sz);
  let Jtx = 0, Jty = 0, Jtz = 0;
  if (smag > 1e-9) {
    const Jt = Math.min(P.mu_cushion * Jn, (2 * m * smag) / 7);
    Jtx = (-Jt * sx) / smag; Jty = (-Jt * sy) / smag; Jtz = (-Jt * sz) / smag;
  }
  const Jx = Jn * nx + Jtx, Jy = Jn * ny + Jty, Jz = Jtz;
  b.vx += Jx / m; b.vy += Jy / m;
  const I = 0.4 * m * R * R;
  b.wx += (ry * Jz - rz * Jy) / I;
  b.wy += (rz * Jx - rx * Jz) / I;
  b.wz += (rx * Jy - ry * Jx) / I;
  return { vn };
}

function checkPocket(b, table) {
  const { pockets, L, W, R } = table;
  for (let k = 0; k < pockets.length; k++) {
    const p = pockets[k];
    const dx = b.x - p.mx, dy = b.y - p.my;
    const depth = dx * p.nx + dy * p.ny;
    if (depth > p.capDepth && Math.abs(dx * p.tx + dy * p.ty) < p.half + R) return k;
  }
  // 兜底：球心离开台面区域太远（只能是进了袋口）
  if (b.x < -R || b.x > L + R || b.y < -R || b.y > W + R) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < pockets.length; k++) {
      const d = Math.hypot(b.x - pockets[k].mx, b.y - pockets[k].my);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  return -1;
}

function angleBetween(ax, ay, bx, by) {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return NaN;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * 模拟直到所有球静止。
 * balls: [{id, x, y, vx, vy, wx, wy, wz, on}]，第 0 个为母球（用于记录首次碰撞信息）。
 * 返回 { balls, tracks, events, firstHit, duration }
 */
export function simulate(ballsIn, table, P, opts = {}) {
  const R = table.R, m = table.m;
  const dt = opts.dt ?? 0.002;
  const maxTime = opts.maxTime ?? 40;
  const record = opts.record ?? true;
  const recEvery = opts.recordEvery ?? 0.01;
  const cueIndex = opts.cueIndex ?? 0;
  // 求解器用的提前终止：stopIndex 球落袋或被碰后停下即停；stopOnFirstHit 母球首次碰球即停
  const stopIndex = opts.stopIndex ?? -1;
  const stopOnFirstHit = opts.stopOnFirstHit ?? false;
  let stopMoved = false;
  let done = false;
  let cueCush = 0, cueFirstSeg = -1;
  const R2 = 4 * R * R;
  const bs = ballsIn.map((b) => ({ ...b }));
  const n = bs.length;
  const segs = table.segments;
  const events = [];
  const tracks = record
    ? bs.map((b) => ({ id: b.id, t: [0], x: [b.x], y: [b.y], m: [b.on ? ballMode(b, R) : 0] }))
    : null;
  const moving = new Uint8Array(n);

  const rec = (i, t) => {
    if (!record) return;
    const tr = tracks[i], b = bs[i];
    tr.t.push(t); tr.x.push(b.x); tr.y.push(b.y); tr.m.push(b.on ? ballMode(b, R) : 0);
  };

  let firstHit = null;
  let cueRollWatch = false; // 首次碰撞后等待母球进入滚动，记录最终行进方向
  let t = 0, lastRec = 0;
  let cueTravel = 0;

  while (t < maxTime && !done) {
    if (stopIndex >= 0 && stopMoved && bs[stopIndex].on && ballMode(bs[stopIndex], R) === MODE.STATIONARY) break;
    let any = false;
    for (let i = 0; i < n; i++) {
      const b = bs[i];
      moving[i] = b.on && ballMode(b, R) !== MODE.STATIONARY ? 1 : 0;
      if (moving[i]) any = true;
    }
    if (!any) break;

    let rem = dt;
    let guard = 0;
    while (rem > 1e-12 && !done) {
      let best = rem, type = 0, bi = -1, bj = -1, hnx = 0, hny = 0;
      if (guard++ < 64) {
        for (let i = 0; i < n; i++) {
          const a = bs[i];
          if (!a.on) continue;
          const translating = a.vx !== 0 || a.vy !== 0;
          if (translating) {
            for (let k = 0; k < segs.length; k++) {
              const s = segmentTOI(a.x, a.y, a.vx, a.vy, R, segs[k], best);
              if (s < best) { best = s; type = 2; bi = i; bj = k; hnx = hit.nx; hny = hit.ny; }
            }
          }
          for (let j = i + 1; j < n; j++) {
            const b = bs[j];
            if (!b.on) continue;
            if (!translating && b.vx === 0 && b.vy === 0) continue;
            const s = pairTOI(a, b, R2, best);
            if (s < best) { best = s; type = 1; bi = i; bj = j; }
          }
        }
      }

      // 所有球推进 best 秒
      const cx0 = bs[cueIndex].x, cy0 = bs[cueIndex].y;
      for (let i = 0; i < n; i++) {
        const b = bs[i];
        if (!b.on || !moving[i]) continue;
        const rolled = advanceBall(b, best, R, P);
        if (rolled) {
          rec(i, t + best);
          if (i === cueIndex && cueRollWatch && firstHit) {
            firstHit.finalDeflect = angleBetween(firstHit.preVx, firstHit.preVy, b.vx, b.vy);
            cueRollWatch = false;
          }
        }
      }
      cueTravel += Math.hypot(bs[cueIndex].x - cx0, bs[cueIndex].y - cy0);
      t += best;
      rem -= best;

      if (type === 1) {
        const a = bs[bi], b = bs[bj];
        const preAx = a.vx, preAy = a.vy, preBx = b.vx, preBy = b.vy;
        const r = collideBalls(a, b, R, m, P);
        if (r) {
          moving[bi] = moving[bj] = 1;
          if (bi === stopIndex || bj === stopIndex) stopMoved = true;
          events.push({ t, type: 'ball', i: bi, j: bj, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, speed: r.vn });
          if (cueRollWatch && (bi === cueIndex || bj === cueIndex)) cueRollWatch = false;
          if (!firstHit && (bi === cueIndex || bj === cueIndex)) {
            const cue = bi === cueIndex ? a : b;
            const obj = bi === cueIndex ? b : a;
            const preVx = bi === cueIndex ? preAx : preBx, preVy = bi === cueIndex ? preAy : preBy;
            const lx = obj.x - cue.x, ly = obj.y - cue.y;
            firstHit = {
              t,
              obj: bi === cueIndex ? bj : bi,
              cueX: cue.x, cueY: cue.y,
              preVx, preVy,
              cut: angleBetween(preVx, preVy, lx, ly),
              objDir: Math.atan2(obj.vy, obj.vx),
              objSpeed: Math.hypot(obj.vx, obj.vy),
              cueSpeedBefore: Math.hypot(preVx, preVy),
              cueSpeedAfter: Math.hypot(cue.vx, cue.vy),
              instDeflect: angleBetween(preVx, preVy, cue.vx, cue.vy),
              throwDeg: (angleBetween(lx, ly, obj.vx, obj.vy) || 0),
              finalDeflect: NaN,
              cueCushBefore: cueCush,
              cueFirstSeg,
            };
            if (stopOnFirstHit) done = true;
            if (ballMode(cue, R) === MODE.SLIDING) cueRollWatch = true;
            else firstHit.finalDeflect = firstHit.instDeflect;
          }
          rec(bi, t); rec(bj, t);
        }
      } else if (type === 2) {
        const b = bs[bi];
        const r = collideCushion(b, hnx, hny, R, m, P, table.sinPhi);
        if (r) {
          events.push({ t, type: segs[bj].kind === 'jaw' ? 'jaw' : 'cushion', i: bi, seg: bj, x: b.x, y: b.y, speed: r.vn });
          if (bi === cueIndex && !firstHit && segs[bj].kind === 'rail') {
            cueCush++;
            if (cueFirstSeg < 0) cueFirstSeg = bj;
          }
          if (cueRollWatch && bi === cueIndex) cueRollWatch = false;
          rec(bi, t);
        }
      }

      // 落袋判定
      for (let i = 0; i < n; i++) {
        const b = bs[i];
        if (!b.on || !moving[i]) continue;
        const k = checkPocket(b, table);
        if (k >= 0) {
          rec(i, t);
          b.on = false;
          b.pocket = k;
          b.vx = b.vy = b.wx = b.wy = b.wz = 0;
          events.push({ t, type: 'pocket', i, pocket: k, x: b.x, y: b.y });
          if (i === cueIndex) cueRollWatch = false;
          rec(i, t);
          if (i === stopIndex) done = true;
        }
      }
    }

    if (record && t - lastRec >= recEvery - 1e-9) {
      for (let i = 0; i < n; i++) if (moving[i] && bs[i].on) rec(i, t);
      lastRec = t;
    }
  }

  if (record) for (let i = 0; i < n; i++) if (bs[i].on) rec(i, t);
  return { balls: bs, tracks, events, firstHit, duration: t, cueTravel };
}

/** 在轨迹上取 t 时刻的位置（线性插值） */
export function trackPos(tr, t) {
  const ts = tr.t;
  if (t <= ts[0]) return [tr.x[0], tr.y[0], 0];
  const last = ts.length - 1;
  if (t >= ts[last]) return [tr.x[last], tr.y[last], last];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const f = span > 0 ? (t - ts[lo]) / span : 1;
  return [tr.x[lo] + (tr.x[hi] - tr.x[lo]) * f, tr.y[lo] + (tr.y[hi] - tr.y[lo]) * f, lo];
}
