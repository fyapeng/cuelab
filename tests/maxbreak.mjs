// 斯诺克最高单杆测试：两个同档电脑打若干局，记录每局最高单杆以及彩球阶段选黑球的比例。
// 用法：node tests/maxbreak.mjs [档位] [局数] [prefer147]
import { TABLES, DEFAULT_PHYS, NOISE_LEVELS } from '../src/physics/presets.js';
import { buildTable } from '../src/physics/table.js';
import { simulate } from '../src/physics/sim.js';
import { strike } from '../src/physics/cue.js';
import { perturbShot, makeRng } from '../src/physics/noise.js';
import { LAYOUTS } from '../src/layouts.js';
import { createGame, evaluateShot, applyOutcome, aiContext, inRegion, defaultCueSpot, respotColor } from '../src/game/rules.js';
import { planShot } from '../src/game/ai.js';

const [LV = 'elite', NG = '4', MODE = ''] = process.argv.slice(2);
const full = (b) => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...b });
const table = buildTable(TABLES.snooker), P = DEFAULT_PHYS.snooker;
const rng = makeRng(147);
const all = [];
for (let gi = 0; gi < +NG; gi++) {
  const g = createGame('snooker', [{ name: 'A', cpu: true }, { name: 'B', cpu: true }]);
  let balls = LAYOUTS.snooker.full.make(table).map(full);
  const [x0, y0] = defaultCueSpot('D', table, balls);
  balls[0] = { ...balls[0], x: x0, y: y0 };
  let shots = 0, brk = 0, colorsInBreak = [], best = { pts: 0, colors: [] };
  while (!g.over && shots < 220) {
    const c = aiContext(g, balls);
    const plan = planShot({
      table, phys: P, balls, ...c, noise: NOISE_LEVELS[LV], level: LV, seed: shots + gi * 1000 + 1, prefer147: MODE === 'prefer147',
      nextTargets: (t) => c.next[t] ?? [], inRegion: c.region ? (x, y) => inRegion(c.region, table, x, y) : null,
    });
    if (plan.cue) balls[0] = { ...balls[0], x: plan.cue[0], y: plan.cue[1] };
    const shot = perturbShot(plan.shot, NOISE_LEVELS[LV], table.R, rng);
    const res = simulate([strike(balls[0], table, P, shot).ball, ...balls.slice(1)], table, P);
    const phase = g.phase;
    const out = evaluateShot(g, balls, res, table);
    if (!out.foul && out.keepTurn) {
      brk += out.points;
      if (phase === 'color') colorsInBreak.push(balls[out.potted.find((i) => balls[i].sk !== 'red')]?.sk);
    } else {
      if (brk > best.pts) best = { pts: brk, colors: colorsInBreak };
      brk = 0;
      colorsInBreak = [];
    }
    const keep = [];
    res.balls.forEach((b, i) => {
      const nb = { ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 };
      if (i === 0 || b.on) keep.push(nb);
      else if (out.respot.includes(i)) keep.push({ ...nb, on: true, pending: true });
    });
    for (const b of keep) {
      if (!b.pending) continue;
      [b.x, b.y] = respotColor(table, keep.filter((x) => !x.pending && x.on), b);
      delete b.pending;
    }
    applyOutcome(g, out);
    if (!keep[0].on || g.ballInHand) {
      const [x, y] = defaultCueSpot(g.ballInHand ?? 'D', table, keep);
      keep[0] = { ...keep[0], x, y, on: true };
    }
    balls = keep;
    shots++;
  }
  if (brk > best.pts) best = { pts: brk, colors: colorsInBreak };
  const blacks = best.colors.filter((k) => k === 'black').length;
  all.push(best.pts);
  console.log(`第 ${gi + 1} 局：比分 ${g.scores.join(':')}，${shots} 杆，最高单杆 ${best.pts}（红球后打黑 ${blacks}/${best.colors.length} 次）`);
}
console.log(`最高单杆：${all.join(', ')}；最大 ${Math.max(...all)}`);
