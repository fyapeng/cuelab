// 标定出杆误差档位：几种标准球在各档误差下的进袋率。
// 用法：node tests/calibrate.mjs（不带参数时用 presets.js 里的档位）
import { TABLES, DEFAULT_PHYS } from '../src/physics/presets.js';
import { buildTable } from '../src/physics/table.js';
import { simulate } from '../src/physics/sim.js';
import { strike } from '../src/physics/cue.js';
import { perturbShot, makeRng } from '../src/physics/noise.js';
import { correctAim, cueSpeedFor } from '../src/game/ai.js';

import { NOISE_LEVELS } from '../src/physics/presets.js';
const LEVELS = process.argv[2] ? JSON.parse(process.argv[2]) : NOISE_LEVELS;
const full = (b) => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...b });

// 目标球放在 obj，打左上角袋；母球在假想球后方 cueDist、切角 cutDeg（自动选在台面内的一侧）
function scenario(tk, name, obj, cueDist, cutDeg, v) {
  const t = buildTable(TABLES[tk]), P = DEFAULT_PHYS[tk], R = t.R;
  const p = t.pockets.find((q) => q.name === '左上角袋');
  const ax = p.mx + p.nx * R * 0.3, ay = p.my + p.ny * R * 0.3;
  const dir = Math.atan2(ay - obj[1], ax - obj[0]);
  const gx = obj[0] - 2 * R * Math.cos(dir), gy = obj[1] - 2 * R * Math.sin(dir);
  let C = null;
  for (const sg of [1, -1]) {
    const ca = dir + (sg * cutDeg * Math.PI) / 180;
    const c = { x: gx - Math.cos(ca) * cueDist, y: gy - Math.sin(ca) * cueDist };
    if (c.x > R && c.x < t.L - R && c.y > R && c.y < t.W - R) { C = c; break; }
  }
  if (!C) throw new Error('母球不在台面内：' + name);
  const balls = [full({ id: 'c', ...C }), full({ id: 'o', x: obj[0], y: obj[1] })];
  const base = { aim: Math.atan2(gy - C.y, gx - C.x), speed: cueSpeedFor(v, t, P), side: 0, height: 0, elev: 0 };
  const aim = correctAim(t, P, balls, base, 1, dir) ?? base.aim;
  return { name, t, P, balls, shot: { ...base, aim } };
}

const S = [
  scenario('eight', '中八中距离30°', [0.45, 0.85], 0.8, 30, 1.5),
  scenario('eight', '中八长台直球', [0.8, 1.0], 1.6, 3, 2.0),
  scenario('snooker', '斯诺克中距离25°', [0.6, 1.2], 1.0, 25, 1.6),
  scenario('snooker', '斯诺克长台', [1.0, 1.4], 2.2, 5, 2.4),
];

const N = 400;
console.log('档位'.padEnd(9), S.map((s) => s.name).join(' | '));
for (const [k, lv] of Object.entries(LEVELS)) {
  const row = [k.padEnd(10)];
  for (const sc of S) {
    const rng = makeRng(11);
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const s = perturbShot(sc.shot, lv, sc.t.R, rng);
      const r = simulate([strike(sc.balls[0], sc.t, sc.P, s).ball, sc.balls[1]], sc.t, sc.P, { stopIndex: 1 });
      if (!r.balls[1].on && r.balls[0].on) ok++;
    }
    row.push(String(Math.round((100 * ok) / N)).padStart(6) + '%');
  }
  console.log(row.join(' '));
}
