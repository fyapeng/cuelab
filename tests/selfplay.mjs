// 电脑对电脑自我对局，用来检查各档实力是否拉开。
// 用法：node tests/selfplay.mjs [档位A] [档位B] [局数] [eight|snooker]
import { TABLES, DEFAULT_PHYS, NOISE_LEVELS } from '../src/physics/presets.js';
import { buildTable } from '../src/physics/table.js';
import { simulate } from '../src/physics/sim.js';
import { strike } from '../src/physics/cue.js';
import { perturbShot, makeRng } from '../src/physics/noise.js';
import { LAYOUTS } from '../src/layouts.js';
import { createGame, evaluateShot, applyOutcome, aiContext, inRegion, defaultCueSpot, respotColor, respotEight } from '../src/game/rules.js';
import { planShot, cueSpeedFor } from '../src/game/ai.js';

const [A = 'elite', B = 'amateur', NG = '3', KIND = 'eight'] = process.argv.slice(2);
const full = (b) => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...b });
const table = buildTable(TABLES[KIND]), P = DEFAULT_PHYS[KIND];
const rng = makeRng(2026);
const stats = { [A]: { wins: 0, pots: 0, shots: 0, fouls: 0 }, [B]: { wins: 0, pots: 0, shots: 0, fouls: 0 } };

for (let gi = 0; gi < +NG; gi++) {
  const levels = gi % 2 ? [B, A] : [A, B];
  const g = createGame(KIND, levels.map((l) => ({ name: l, cpu: true, level: l })));
  let balls = LAYOUTS[KIND][KIND === 'eight' ? 'rack15' : 'full'].make(table).map(full);
  const [x0, y0] = defaultCueSpot(g.ballInHand, table, balls);
  balls[0] = { ...balls[0], x: x0, y: y0 };
  let shots = 0;
  while (!g.over && shots < 150) {
    const lv = levels[g.turn];
    let shot;
    if (KIND === 'eight' && g.breakShot) {
      const c = balls[0];
      const apex = balls.slice(1).sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
      shot = { aim: Math.atan2(apex.y - c.y, apex.x - c.x), speed: cueSpeedFor(9, table, P), side: 0, height: -0.1, elev: 0 };
    } else {
      const c = aiContext(g, balls);
      const plan = planShot({
        table, phys: P, balls, ...c, noise: NOISE_LEVELS[lv], level: lv, seed: shots + 1,
        nextTargets: (t) => c.next[t] ?? [], inRegion: c.region ? (x, y) => inRegion(c.region, table, x, y) : null,
      });
      if (plan.cue) balls[0] = { ...balls[0], x: plan.cue[0], y: plan.cue[1] };
      shot = plan.shot;
    }
    shot = perturbShot(shot, NOISE_LEVELS[lv], table.R, rng);
    const res = simulate([strike(balls[0], table, P, shot).ball, ...balls.slice(1)], table, P);
    const out = evaluateShot(g, balls, res, table);
    stats[lv].shots++;
    if (out.foul) stats[lv].fouls++;
    else stats[lv].pots += (out.potted ?? []).length;
    const keep = [];
    res.balls.forEach((b, i) => {
      const nb = { ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 };
      if (i === 0 || b.on) keep.push(nb);
      else if (out.respot.includes(i)) keep.push({ ...nb, on: true, pending: true });
    });
    for (const b of keep) {
      if (!b.pending) continue;
      const placed = keep.filter((x) => !x.pending && x.on);
      [b.x, b.y] = KIND === 'eight' ? respotEight(table, placed, b) : respotColor(table, placed, b);
      delete b.pending;
    }
    applyOutcome(g, out);
    if (!keep[0].on || g.ballInHand) {
      const [x, y] = defaultCueSpot(g.ballInHand ?? 'anywhere', table, keep);
      keep[0] = { ...keep[0], x, y, on: true };
    }
    balls = keep;
    shots++;
  }
  const w = g.winner >= 0 ? levels[g.winner] : '平局/未完';
  if (g.winner >= 0) stats[w].wins++;
  console.log(`第 ${gi + 1} 局：${levels.join(' 先开 vs ')} → ${w}，${shots} 杆${KIND === 'snooker' ? `，比分 ${g.scores.join(':')}` : ''}`);
}
for (const [k, s] of Object.entries(stats)) {
  console.log(`${NOISE_LEVELS[k].name}：胜 ${s.wins}，出杆 ${s.shots}，进球 ${s.pots}，犯规 ${s.fouls}，每杆进球 ${(s.pots / Math.max(1, s.shots)).toFixed(2)}`);
}
