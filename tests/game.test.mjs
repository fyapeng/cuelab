// 规则与电脑对手。运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, DEFAULT_PHYS, NOISE_LEVELS } from '../src/physics/presets.js';
import { buildTable } from '../src/physics/table.js';
import { simulate } from '../src/physics/sim.js';
import { strike } from '../src/physics/cue.js';
import { LAYOUTS, poolBall, cueBall, snookerBall, snookerSpots } from '../src/layouts.js';
import { createGame, evaluateShot, applyOutcome, aiContext, ballOn, inRegion, defaultCueSpot, respotColor } from '../src/game/rules.js';
import { planShot, cueSpeedFor, bankFrom, kickFrom } from '../src/game/ai.js';
import { makeRng } from '../src/physics/noise.js';

const full = (b) => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...b });
const t8 = buildTable(TABLES.eight), P8 = DEFAULT_PHYS.eight;
const ts = buildTable(TABLES.snooker), PS = DEFAULT_PHYS.snooker;
const shootAt = (table, P, balls, aim, v, height = 0) =>
  simulate([strike(balls[0], table, P, { aim, speed: cueSpeedFor(v, table, P), side: 0, height, elev: 0 }).ball, ...balls.slice(1)], table, P);
const aimTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const settle = (res, keep = []) =>
  res.balls.filter((b, i) => i === 0 || b.on || keep.includes(i)).map((b) => ({ ...b, on: true, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));

test('中八：已分组时先碰对方球判犯规，对方获自由球', () => {
  const g = createGame('eight', ['A', 'B']);
  g.breakShot = false;
  g.groups = ['solid', 'stripe'];
  const balls = [cueBall(1.0, 0.6), poolBall(10, 1.5, 0.6), poolBall(2, 2.2, 1.1)].map(full);
  const out = evaluateShot(g, balls, shootAt(t8, P8, balls, 0, 1.5), t8);
  assert.ok(out.foul);
  assert.equal(out.ballInHand, 'anywhere');
  applyOutcome(g, out);
  assert.equal(g.turn, 1);
});

test('中八：本方球未清完打进 8 号球判负', () => {
  const g = createGame('eight', ['A', 'B']);
  g.breakShot = false;
  g.groups = ['solid', 'stripe'];
  const balls = [cueBall(0.6, t8.W - 0.6), poolBall(8, 0.25, t8.W - 0.25), poolBall(3, 2.0, 0.3)].map(full);
  const res = shootAt(t8, P8, balls, aimTo(balls[0], balls[1]), 1.5);
  assert.equal(res.balls[1].on, false, '8 号球应进袋');
  const out = evaluateShot(g, balls, res, t8);
  assert.equal(out.over, true);
  assert.equal(out.winner, 1);
});

test('斯诺克：红球阶段打进粉球，罚 6 分且粉球复位', () => {
  const g = createGame('snooker', ['A', 'B']);
  g.ballInHand = null;
  const s = snookerSpots(ts);
  const balls = [cueBall(0.65, ts.W - 0.65), snookerBall('pink', 0.3, ts.W - 0.3), snookerBall('red', 2.0, 1.2)].map(full);
  const res = shootAt(ts, PS, balls, aimTo(balls[0], balls[1]), 1.5);
  assert.equal(res.balls[1].on, false, '粉球应进袋');
  const out = evaluateShot(g, balls, res, ts);
  assert.ok(out.foul);
  assert.equal(out.penalty, 6);
  assert.deepEqual(out.respot, [1]);
  applyOutcome(g, out);
  assert.equal(g.scores[1], 6);
  assert.deepEqual(respotColor(ts, balls.map((b, i) => (i === 1 ? { ...b, on: false } : b)), balls[1]), s.pink);
});

test('斯诺克：打进红球得 1 分并转为彩球阶段', () => {
  const g = createGame('snooker', ['A', 'B']);
  const balls = [cueBall(0.65, ts.W - 0.65), snookerBall('red', 0.3, ts.W - 0.3), snookerBall('black', ...snookerSpots(ts).black)].map(full);
  // 直线球用低杆，否则母球会跟进袋（入袋犯规）
  const res = shootAt(ts, PS, balls, aimTo(balls[0], balls[1]), 2.0, -0.5);
  const out = evaluateShot(g, balls, res, ts);
  assert.ok(!out.foul && out.keepTurn, out.msg.join(' '));
  applyOutcome(g, out);
  assert.equal(g.scores[0], 1);
  assert.equal(g.phase, 'color');
  assert.deepEqual(ballOn(g, balls.map((b, i) => (i === 1 ? { ...b, on: false } : b))), [2]);
});

test('自由球区域：D 区与开球区判定', () => {
  const s = snookerSpots(ts);
  assert.ok(inRegion('D', ts, s.baulk - 0.1, ts.W / 2));
  assert.ok(!inRegion('D', ts, s.baulk + 0.05, ts.W / 2));
  assert.ok(!inRegion('D', ts, s.baulk - 0.05, ts.W / 2 + s.dR + 0.05));
  assert.ok(inRegion('head', t8, 0.4, 0.6) && !inRegion('head', t8, 1.0, 0.6));
});

test('电脑对手：简单直线球能选出进攻并打进', () => {
  const g = createGame('eight', ['A', 'B']);
  g.breakShot = false;
  g.groups = ['solid', 'stripe'];
  g.ballInHand = null;
  const balls = [cueBall(1.6, 0.85), poolBall(2, 1.95, 1.0), poolBall(11, 0.8, 0.3), poolBall(8, 1.2, 0.3)].map(full);
  const c = aiContext(g, balls);
  const plan = planShot({ table: t8, phys: P8, balls, ...c, noise: NOISE_LEVELS.pro, nextTargets: (t) => c.next[t] ?? [], inRegion: null, seed: 1 });
  assert.equal(plan.kind, 'pot');
  const res = simulate([strike(balls[0], t8, P8, plan.shot).ball, ...balls.slice(1)], t8, P8);
  assert.equal(res.balls[1].on, false, '2 号球应进袋');
});

test('电脑对手：中八开球后连续对打若干杆，规则流程不出错', () => {
  const g = createGame('eight', ['电脑 A', '电脑 B']);
  let balls = LAYOUTS.eight.rack15.make(t8).map(full);
  let res = shootAt(t8, P8, balls, aimTo(balls[0], balls[1]), 8);
  let out = evaluateShot(g, balls, res, t8);
  applyOutcome(g, out);
  balls = settle(res, out.respot);
  for (let k = 0; k < 6 && !g.over; k++) {
    if (g.ballInHand) {
      const [x, y] = defaultCueSpot(g.ballInHand, t8, balls);
      balls[0] = { ...balls[0], x, y };
    }
    const c = aiContext(g, balls);
    const plan = planShot({
      table: t8, phys: P8, balls, ...c, noise: NOISE_LEVELS.amateur, seed: k + 1,
      nextTargets: (t) => c.next[t] ?? [],
      inRegion: c.region ? (x, y) => inRegion(c.region, t8, x, y) : null,
    });
    if (plan.cue) balls[0] = { ...balls[0], x: plan.cue[0], y: plan.cue[1] };
    res = simulate([strike(balls[0], t8, P8, plan.shot).ball, ...balls.slice(1)], t8, P8);
    out = evaluateShot(g, balls, res, t8);
    applyOutcome(g, out);
    assert.ok(g.message.length > 0);
    balls = settle(res);
  }
});

test('电脑对手：中八翻袋练习中能找到一库翻袋并真实打进', () => {
  const balls = LAYOUTS.eight.bank.make(t8).map(full);
  const ctx = {
    table: t8, phys: P8, balls, targets: [1], forbidden: [], oppTargets: [2], values: balls.map(() => 1),
    noise: NOISE_LEVELS.pro, nextTargets: () => [3], inRegion: null,
  };
  const plan = bankFrom(ctx, balls, makeRng(3));
  assert.ok(plan, '应找到翻袋线路');
  assert.equal(plan.kind, 'bank');
  const res = simulate([strike(balls[0], t8, P8, plan.shot).ball, ...balls.slice(1)], t8, P8);
  assert.equal(res.balls[1].on, false, '6 号球应进袋');
  assert.equal(res.balls[1].pocket, plan.guide.pocket);
  assert.equal(res.events.filter((e) => e.type === 'cushion' && e.i === 1).length, 1, '目标球恰好吃一库');
});

test('电脑对手：斯诺克被咖啡球挡住时一库解球，母球先吃库再合法碰到红球', () => {
  const balls = LAYOUTS.snooker.kick.make(ts).map(full);
  const g = createGame('snooker', ['A', 'B']);
  g.ballInHand = null;
  const c = aiContext(g, balls);
  const plan = kickFrom({ table: ts, phys: PS, balls, ...c, noise: NOISE_LEVELS.pro, nextTargets: (t) => c.next[t] ?? [], inRegion: null }, balls);
  assert.ok(plan, '应找到解球线路');
  assert.equal(plan.kind, 'kick');
  const res = simulate([strike(balls[0], ts, PS, plan.shot).ball, ...balls.slice(1)], ts, PS);
  assert.equal(balls[res.firstHit.obj].sk, 'red');
  assert.ok(res.firstHit.cueCushBefore >= 1);
  const out = evaluateShot(g, balls, res, ts);
  assert.ok(!out.foul, out.msg.join(' '));
});
