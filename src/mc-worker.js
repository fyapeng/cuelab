// 后台计算线程。两类任务：
//   mc    —— 容错带：先算进袋窗口（瞄准角能偏多少仍然进），再按人的出杆误差重复模拟 N 次；
//   solve —— 翻袋 / 解球线路搜索。
// 每类任务只保留最新一个，旧任务在下一个分片开始前放弃。
import { TABLES } from './physics/presets.js';
import { buildTable } from './physics/table.js';
import { simulate } from './physics/sim.js';
import { strike } from './physics/cue.js';
import { perturbShot, makeRng } from './physics/noise.js';
import { potWindow, bankCandidates, kickCandidates, solveCandidate, runShot } from './physics/solver.js';
import { planShot } from './game/ai.js';
import { inRegion } from './game/rules.js';
import { NOISE_LEVELS } from './physics/presets.js';

const latest = { mc: 0, solve: 0, ai: 0 };
const tables = {};
const getTable = (k) => tables[k] ?? (tables[k] = buildTable(TABLES[k]));

self.onmessage = (e) => {
  const job = e.data;
  latest[job.kind] = job.id;
  if (job.kind === 'mc') runMC(job);
  else if (job.kind === 'solve') runSolve(job);
  else if (job.kind === 'ai') runAI(job);
};

function runAI(job) {
  const table = getTable(job.tableKey);
  const t0 = performance.now();
  const plan = planShot({
    table,
    phys: job.phys,
    balls: job.balls,
    targets: job.targets,
    forbidden: job.forbidden,
    oppTargets: job.oppTargets,
    values: job.values,
    noise: NOISE_LEVELS[job.level],
    nextTargets: (t) => job.next[t] ?? [],
    inRegion: job.region ? (x, y) => inRegion(job.region, table, x, y) : null,
    seed: job.seed,
  });
  self.postMessage({ kind: 'ai', id: job.id, plan, ms: performance.now() - t0 });
}

function targetTrack(job, table, aim) {
  const { ball } = strike(job.balls[0], table, job.phys, { ...job.shot, aim });
  const r = simulate([ball, ...job.balls.slice(1)], table, job.phys, { record: true, stopIndex: job.targetIndex, maxTime: 20 });
  const tr = r.tracks[job.targetIndex];
  return { x: tr.x, y: tr.y };
}

function runMC(job) {
  const table = getTable(job.tableKey);
  const ti = job.targetIndex;
  // 1. 进袋窗口
  setTimeout(() => {
    if (job.id !== latest.mc) return;
    let win = null;
    if (ti > 0) {
      win = potWindow(job.balls, table, job.phys, job.shot, ti, job.pocket, job.contactDist);
      if (win.found) {
        win.loTrack = targetTrack(job, table, win.loAim);
        win.hiTrack = targetTrack(job, table, win.hiAim);
      }
    }
    if (job.id !== latest.mc) return;
    self.postMessage({ kind: 'window', id: job.id, win });
    if (job.N > 0) setTimeout(chunk, 0);
  }, 0);

  // 2. 蒙特卡洛
  const rng = makeRng(20261107); // 固定种子：参数小幅变化时散布平滑移动
  const samples = [];
  let i = 0;
  const chunk = () => {
    if (job.id !== latest.mc) return;
    const t0 = performance.now();
    while (i < job.N && performance.now() - t0 < 25) {
      const s = perturbShot(job.shot, job.noise, table.R, rng);
      const res = runShot(job.balls, table, job.phys, s, { maxTime: 30 });
      const c = res.balls[0];
      samples.push({
        x: c.x, y: c.y,
        scratch: !c.on,
        target: ti > 0 ? !res.balls[ti].on : false,
      });
      i++;
    }
    self.postMessage({ kind: 'mc', id: job.id, samples, done: i >= job.N, N: job.N });
    if (i < job.N) setTimeout(chunk, 0);
  };
}

function runSolve(job) {
  const table = getTable(job.tableKey);
  const cands = job.mode === 'bank'
    ? bankCandidates(job.balls, table, job.targetIndex)
    : kickCandidates(job.balls, table, job.targetIndex);
  const sols = [];
  let k = 0;
  self.postMessage({ kind: 'solve', id: job.id, sols, done: cands.length === 0, progress: [0, cands.length] });
  const step = () => {
    if (job.id !== latest.solve || k >= cands.length) return;
    const s = solveCandidate(job.balls, table, job.phys, job.shot, job.targetIndex, cands[k]);
    k++;
    if (s) sols.push(s);
    self.postMessage({ kind: 'solve', id: job.id, sols, done: k >= cands.length, progress: [k, cands.length] });
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
