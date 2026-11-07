// 用经典台球物理规律检验引擎。运行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, DEFAULT_PHYS, G } from '../src/physics/presets.js';
import { buildTable } from '../src/physics/table.js';
import { simulate, advanceBall, ballMode, MODE } from '../src/physics/sim.js';
import { strike } from '../src/physics/cue.js';

const table = buildTable(TABLES.pool);
const R = table.R;
const base = DEFAULT_PHYS.pool;
const ball = (id, x, y, extra = {}) => ({ id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...extra });
const deg = (r) => (r * 180) / Math.PI;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('定杆滑动的母球进入滚动时速度为 5/7', () => {
  const P = { ...base, mu_r: 0 };
  const b = ball('c', 0.5, 0.6, { vx: 2 });
  let t = 0;
  while (ballMode(b, R) === MODE.SLIDING && t < 2) { advanceBall(b, 0.001, R, P); t += 0.001; }
  near(b.vx, (2 * 5) / 7, 1e-6, '滚动速度');
  near(t, (2 * 2) / (7 * P.mu_s * G), 0.0011, '滑动时间');
});

test('纯滚动的停球距离 = v²/(2μr g)', () => {
  const P = base;
  const v = 1.5;
  const b = ball('c', 0.3, 0.6, { vx: v, wy: v / R });
  for (let i = 0; i < 2000; i++) advanceBall(b, 0.01, R, P);
  near(b.x - 0.3, (v * v) / (2 * P.mu_r * G), 1e-6, '滚动距离');
});

test('击打点在球心上方 2/5 R 处，母球出杆即为自然滚动', () => {
  const { ball: b, info } = strike(ball('c', 0.5, 0.6), table, base, { aim: 0.3, speed: 2, side: 0, height: 0.4, elev: 0 });
  assert.equal(ballMode(b, R), MODE.ROLLING);
  near(info.spinRatio, 1, 1e-9, '旋转比');
});

test('低杆产生下旋，高杆产生上旋，右塞产生正 ωz 并让母球向左偏', () => {
  const low = strike(ball('c', 0, 0), table, base, { aim: 0, speed: 2, side: 0, height: -0.4, elev: 0 });
  assert.ok(low.info.spinRatio < 0);
  const right = strike(ball('c', 0, 0), table, base, { aim: 0, speed: 2, side: 0.4, height: 0, elev: 0 });
  assert.ok(right.ball.wz > 0);
  assert.ok(right.ball.vy > 0, '右塞偏杆方向');
  assert.ok(right.info.squirtDeg > 1 && right.info.squirtDeg < 4, `偏杆角 ${right.info.squirtDeg}`);
});

test('定杆（无旋转）击球：母球与目标球分离角 90°', () => {
  const P = { ...base, e_ball: 1, throw: false };
  const cut = (30 * Math.PI) / 180;
  const ox = 1.2, oy = 0.6;
  // 让母球沿 +x 前进，以 30° 切角接触
  const cy = oy - 2 * R * Math.sin(cut);
  const cue = ball('c', ox - 2 * R * Math.cos(cut) - 0.002, cy, { vx: 1.5, wy: 0 });
  // 极短距离、母球无旋转 → 接触时仍为纯滑动且旋转为零
  const res = simulate([cue, ball('o', ox, oy)], table, { ...P, mu_s: 1e-6, mu_r: 0 }, { maxTime: 0.01 });
  const [c, o] = res.balls;
  const ang = deg(Math.acos((c.vx * o.vx + c.vy * o.vy) / (Math.hypot(c.vx, c.vy) * Math.hypot(o.vx, o.vy))));
  near(ang, 90, 0.2, '分离角');
  near(res.firstHit.cut, 30, 0.2, '切角');
});

test('自然滚动母球半球击打：最终行进方向偏转约 33.7°（30° 规则）', () => {
  const P = { ...base, e_ball: 1, throw: false };
  const cut = (30 * Math.PI) / 180;
  const ox = 1.2, oy = 0.6;
  const cy = oy - 2 * R * Math.sin(cut);
  const v = 1.5;
  const cue = ball('c', 0.5, cy, { vx: v, wy: v / R });
  const res = simulate([cue, ball('o', ox, oy)], table, P);
  near(res.firstHit.cut, 30, 0.3, '切角');
  near(res.firstHit.finalDeflect, 33.7, 0.8, '最终偏转');
});

test('投掷效应：慢速定杆切 30° 时目标球偏离连心线 1°–6°', () => {
  const cut = (30 * Math.PI) / 180;
  const ox = 1.2, oy = 0.6;
  const cy = oy - 2 * R * Math.sin(cut);
  const cue = ball('c', ox - 2 * R * Math.cos(cut) - 0.002, cy, { vx: 1.0 });
  const res = simulate([cue, ball('o', ox, oy)], table, { ...base, mu_s: 1e-6 }, { maxTime: 0.01 });
  assert.ok(res.firstHit.throwDeg > 1 && res.firstHit.throwDeg < 6, `投掷角 ${res.firstHit.throwDeg}`);
});

test('垂直撞库：反弹速度约为 e·v', () => {
  const P = base;
  const b = ball('c', 1.0, table.W - R - 0.001, { vy: 1.0, wx: -1.0 / R });
  const res = simulate([b], table, P, { maxTime: 0.02 });
  const vy = res.balls[0].vy;
  assert.ok(vy < 0, '已反弹');
  near(-vy, P.e_cushion * 1.0, 0.05, '反弹速度');
});

test('直线送球进角袋；瞄准偏 2° 则不进', () => {
  // 母球、目标球与右上角袋在同一直线上
  const px = table.L, py = table.W;
  const ox = 1.9, oy = 0.95;
  const ang = Math.atan2(py - oy, px - ox);
  const cx = ox - 0.4 * Math.cos(ang), cy = oy - 0.4 * Math.sin(ang);
  const shot = { aim: ang, speed: 2.5, side: 0, height: 0, elev: 0 };
  const go = (aim) => {
    const { ball: c } = strike(ball('c', cx, cy), table, base, { ...shot, aim });
    return simulate([c, ball('o', ox, oy)], table, base);
  };
  const ok = go(ang);
  assert.equal(ok.balls[1].on, false, '应进袋');
  assert.equal(table.pockets[ok.balls[1].pocket].name, '右上角袋');
  const miss = go(ang + (2 * Math.PI) / 180);
  assert.notEqual(miss.balls[1].pocket, 3, '瞄准偏 2° 不应进右上角袋');
});

test('直线低杆：母球碰球后往回走；高杆：跟进', () => {
  const ox = 1.5, oy = 0.6;
  const run = (height) => {
    const { ball: c } = strike(ball('c', 1.0, oy), table, base, { aim: 0, speed: 2.0, side: 0, height, elev: 0 });
    return simulate([c, ball('o', ox, oy)], table, base);
  };
  // 母球碰后进入滚动时的行进方向：低杆 180°（回头），高杆 0°（跟进）
  near(run(-0.45).firstHit.finalDeflect, 180, 0.5, '低杆');
  near(run(0.45).firstHit.finalDeflect, 0, 0.5, '高杆');
});

test('碰撞不增加动能', () => {
  const ke = (bs) => bs.reduce((s, b) => s + 0.5 * table.m * (b.vx ** 2 + b.vy ** 2) + 0.5 * 0.4 * table.m * R * R * (b.wx ** 2 + b.wy ** 2 + b.wz ** 2), 0);
  const { ball: c } = strike(ball('c', 0.6, 0.5), table, base, { aim: 0.2, speed: 4, side: 0.3, height: -0.2, elev: 0 });
  const balls = [c, ball('a', 1.2, 0.62), ball('b', 1.6, 0.7), ball('d', 1.3, 0.4)];
  const k0 = ke(balls);
  const res = simulate(balls, table, base, { maxTime: 0.3 });
  assert.ok(ke(res.balls) <= k0 + 1e-9);
});

test('性能：九球开球一次完整模拟在 100 ms 内', () => {
  const balls = [ball('c', table.L / 4, table.W / 2)];
  const fx = (3 * table.L) / 4, fy = table.W / 2, d = 2 * R + 0.0002;
  const rows = [1, 2, 3, 2, 1];
  let k = 0;
  rows.forEach((cnt, r) => {
    for (let i = 0; i < cnt; i++) balls.push(ball('b' + k++, fx + r * d * Math.cos(Math.PI / 6), fy + (i - (cnt - 1) / 2) * d));
  });
  const { ball: c } = strike(balls[0], table, base, { aim: 0, speed: 7, side: 0, height: 0, elev: 0 });
  balls[0] = c;
  const t0 = performance.now();
  const res = simulate(balls, table, base);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `耗时 ${ms.toFixed(1)} ms`);
  assert.ok(res.duration > 1);
});

// ---------- 翻袋 / 解球求解器 ----------
import { LAYOUTS } from '../src/layouts.js';
import { bankCandidates, kickCandidates, solveCandidate, potWindow, mirror, railLines } from '../src/physics/solver.js';

const full = (b) => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...b });

test('镜像点：沿上库中心线翻折', () => {
  const rail = railLines(table).find((r) => r.key === 'top');
  const [x, y] = mirror(1.0, 0.3, rail);
  near(x, 1.0, 1e-12, 'x');
  near(y, 2 * (table.W - R) - 0.3, 1e-12, 'y');
});

test('中八翻袋练习：能找到翻下库进上中袋的线路，且物理解确实进袋', () => {
  const t8 = buildTable(TABLES.eight);
  const P = DEFAULT_PHYS.eight;
  const balls = LAYOUTS.eight.bank.make(t8).map(full);
  const shot = { aim: 0, speed: 2, side: 0, height: 0, elev: 0 };
  const cands = bankCandidates(balls, t8, 1);
  const c = cands.find((k) => k.rail === 'bottom' && t8.pockets[k.pocket].name === '上中袋');
  assert.ok(c, '应有该几何候选');
  const sol = solveCandidate(balls, t8, P, shot, 1, c);
  assert.ok(sol && sol.width > 0, '应有可行区间');
  const res = simulate([strike(balls[0], t8, P, { ...shot, aim: sol.aim }).ball, ...balls.slice(1)], t8, P);
  assert.equal(res.balls[1].on, false);
  assert.equal(t8.pockets[res.balls[1].pocket].name, '上中袋');
});

test('斯诺克解球练习：直线被挡，一库解球能先碰到红球', () => {
  const ts = buildTable(TABLES.snooker);
  const P = DEFAULT_PHYS.snooker;
  const balls = LAYOUTS.snooker.kick.make(ts).map(full);
  const shot = { aim: Math.atan2(balls[1].y - balls[0].y, balls[1].x - balls[0].x), speed: 2, side: 0, height: 0, elev: 0 };
  const direct = simulate([strike(balls[0], ts, P, shot).ball, ...balls.slice(1)], ts, P, { stopOnFirstHit: true });
  assert.notEqual(direct.firstHit.obj, 1, '直线应被挡');
  const sols = kickCandidates(balls, ts, 1).map((c) => solveCandidate(balls, ts, P, shot, 1, c)).filter(Boolean);
  assert.ok(sols.length >= 1);
  for (const s of sols) {
    const r = simulate([strike(balls[0], ts, P, { ...shot, aim: s.aim }).ball, ...balls.slice(1)], ts, P);
    assert.equal(r.firstHit.obj, 1);
    assert.ok(r.firstHit.cueCushBefore >= 1);
  }
});

test('进袋窗口：直线送角袋的窗口包含当前瞄准，且宽度为正', () => {
  const ox = 1.9, oy = 0.95;
  const ang = Math.atan2(table.W - oy, table.L - ox);
  const cx = ox - 0.4 * Math.cos(ang), cy = oy - 0.4 * Math.sin(ang);
  const balls = [ball('c', cx, cy), ball('o', ox, oy)];
  const w = potWindow(balls, table, base, { aim: ang, speed: 2.5, side: 0, height: 0, elev: 0 }, 1, 3, 0.4 - 2 * R);
  assert.ok(w.found && w.lo < 0 && w.hi > 0, JSON.stringify(w));
  assert.ok(w.width * 180 / Math.PI < 3);
});
