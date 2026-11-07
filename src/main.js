import { TABLES, DEFAULT_PHYS, NOISE_LEVELS, G } from './physics/presets.js';
import { buildTable } from './physics/table.js';
import { simulate, trackPos } from './physics/sim.js';
import { strike, MISCUE_LIMIT } from './physics/cue.js';
import { perturbShot, makeRng } from './physics/noise.js';
import { railLines } from './physics/solver.js';
import { cueSpeedFor } from './game/ai.js';
import {
  createGame, evaluateShot, applyOutcome, ballOn, onDescription, aiContext, pointsRemaining,
  respotColor, respotEight, inRegion, clampToRegion, defaultCueSpot, GROUP_NAME,
} from './game/rules.js';
import { LAYOUTS, newObjectBall, respotCue, snookerSpots } from './layouts.js';
import { makeView, drawTable, drawBall, drawTrack, ghostCircle, drawLabel, drawCue } from './render.js';

const $ = (id) => document.getElementById(id);
const DEG = 180 / Math.PI;
const MC_N = 120;

// 力度：滑块位置 0–1000 → 母球初速（中杆）0.25–11 m/s，低速段更细
const V_MIN = 0.25, V_MAX = 11, V_EXP = 2.4;
const posToSpeed = (p) => V_MIN + (V_MAX - V_MIN) * (p / 1000) ** V_EXP;
const speedToPos = (v) => 1000 * ((Math.max(V_MIN, v) - V_MIN) / (V_MAX - V_MIN)) ** (1 / V_EXP);
const SPEED_CLASSES = [[0.7, '推球'], [1.3, '轻'], [2.4, '中'], [4, '中重'], [6.5, '重'], [Infinity, '开球级']];
const speedClass = (v) => SPEED_CLASSES.find(([lim]) => v < lim)[1];
const CLOTH_MU = {
  eight: { slow: 0.011, std: 0.008, fast: 0.006 },
  snooker: { slow: 0.009, std: 0.007, fast: 0.005 },
  pool: { slow: 0.013, std: 0.01, fast: 0.008 },
};

const S = {
  mode: 'practice',
  tableKey: 'eight',
  table: null,
  phys: null,
  cloth: 'std',
  layoutKey: 'single',
  balls: [],
  aim: 0,
  locked: false,
  side: 0,
  height: 0,
  ballSpeed: 1.0,
  elev: 0,
  noiseKey: 'amateur',
  pred: null,
  info: null,
  predMs: 0,
  mc: null,
  mcId: 0,
  win: null,
  solve: null,
  solveId: 0,
  guide: null,
  anim: null,
  playback: 1,
  history: [],
  drag: null,
  hoverBall: -1,
  message: '',
  opts: { allPaths: true, ghost: true, window: true, landing: 'region' },
  // 对局
  game: null,
  match: { opp: 'cpu-amateur', aid: 'basic', humanNoise: 'off' },
  cpu: { id: 0, busy: false },
};

const canvas = $('table');
const ctx = canvas.getContext('2d');
let view = null;

const fullBall = (b) => ({ vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, ...b });
const shot = () => ({ aim: S.aim, speed: cueSpeedFor(S.ballSpeed, S.table, S.phys), side: S.side, height: S.height, elev: S.elev });
const snapshot = () => S.balls.map((b) => ({ ...b }));
const inMatch = () => S.mode === 'match' && S.game;
const isCpuTurn = () => inMatch() && !S.game.over && S.game.players[S.game.turn].cpu;
const aid = () => (inMatch() ? S.match.aid : 'full');
const canAct = () => !S.anim && !(inMatch() && (S.game.over || isCpuTurn() || S.cpu.busy));

function pushHistory() {
  S.history.push(snapshot());
  if (S.history.length > 50) S.history.shift();
}

// ---------------- 球台 / 摆球 ----------------

function setTable(key) {
  S.tableKey = key;
  $('tableSel').value = key;
  S.table = buildTable(TABLES[key]);
  S.phys = { ...DEFAULT_PHYS[key], mu_r: CLOTH_MU[key][S.cloth] };
  S.pred = null;
  S.mc = null;
  S.win = null;
  S.balls = [];
  const sel = $('layoutSel');
  sel.innerHTML = '';
  for (const [k, l] of Object.entries(LAYOUTS[key])) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = l.name;
    sel.appendChild(o);
  }
  buildParamPanel();
  renderRulesText();
  resize();
  setLayout(Object.keys(LAYOUTS[key])[0]);
}

function setLayout(key) {
  S.layoutKey = key;
  $('layoutSel').value = key;
  S.balls = LAYOUTS[S.tableKey][key].make(S.table).map(fullBall);
  S.history = [];
  S.anim = null;
  const cue = S.balls[0], obj = S.balls[1];
  if (obj) S.aim = Math.atan2(obj.y - cue.y, obj.x - cue.x);
  S.locked = false;
  S.message = '';
  S.guide = null;
  S.solve = null;
  renderSolve();
  schedulePredict();
}

let predPending = false;
function schedulePredict() {
  if (predPending) return;
  predPending = true;
  requestAnimationFrame(() => {
    predPending = false;
    predict();
  });
}

function predict() {
  if (S.anim) return;
  const t0 = performance.now();
  const { ball, info } = strike(S.balls[0], S.table, S.phys, shot());
  S.info = info;
  S.pred = simulate([ball, ...S.balls.slice(1)], S.table, S.phys, { record: true });
  S.predMs = performance.now() - t0;
  refreshTargetSel();
  renderResult();
  requestMC();
  renderHUD();
  draw();
}

// ---------------- 后台计算 ----------------

const workerUrl = new URL('./mc-worker.js', import.meta.url);
const mcWorker = new Worker(workerUrl, { type: 'module' });
const solveWorker = new Worker(workerUrl, { type: 'module' });
const aiWorker = new Worker(workerUrl, { type: 'module' });
for (const w of [mcWorker, solveWorker, aiWorker]) w.onerror = (e) => console.error('worker error', e.message, e.filename, e.lineno);
mcWorker.onmessage = (e) => {
  const d = e.data;
  if (d.id !== S.mcId) return;
  if (d.kind === 'window') S.win = d.win;
  else S.mc = d;
  renderMC();
  renderHUD();
  draw();
};
solveWorker.onmessage = (e) => {
  const d = e.data;
  if (!S.solve || d.id !== S.solve.id) return;
  Object.assign(S.solve, { sols: d.sols, done: d.done, progress: d.progress });
  renderSolve();
};
aiWorker.onmessage = (e) => {
  if (e.data.id !== S.cpu.id || !inMatch()) return;
  executeCpuPlan(e.data.plan);
};

const ballsSig = () => S.balls.map((b) => b.x.toFixed(4) + ',' + b.y.toFixed(4)).join(';');
const shotSig = () => [S.ballSpeed, S.side, S.height, S.elev].map((v) => v.toFixed(3)).join(',');

let mcTimer = 0;
function requestMC() {
  clearTimeout(mcTimer);
  const id = ++S.mcId;
  const fh = S.pred?.firstHit;
  S.win = null;
  S.mc = null;
  if (!fh || aid() !== 'full' || isCpuTurn()) { renderMC(); return; }
  const cue = S.balls[0];
  const tb = S.pred.balls[fh.obj];
  const N = S.noiseKey === 'off' ? 0 : MC_N;
  S.mc = N ? { id, samples: [], done: false, N } : null;
  renderMC();
  mcTimer = setTimeout(() => {
    mcWorker.postMessage({
      kind: 'mc', id, tableKey: S.tableKey, balls: S.balls, phys: S.phys, shot: shot(),
      noise: NOISE_LEVELS[S.noiseKey] ?? NOISE_LEVELS.amateur, N,
      targetIndex: fh.obj, pocket: tb.on ? -1 : tb.pocket,
      contactDist: Math.hypot(fh.cueX - cue.x, fh.cueY - cue.y),
    });
  }, 90);
}

function startSolve(mode) {
  const ti = +$('targetSel').value;
  if (!(ti > 0)) return;
  const id = ++S.solveId;
  S.solve = { id, mode, ti, sols: [], done: false, progress: [0, 0], sig: ballsSig(), shotSig: shotSig() };
  S.guide = null;
  renderSolve();
  solveWorker.postMessage({ kind: 'solve', id, mode, tableKey: S.tableKey, balls: S.balls, phys: S.phys, shot: shot(), targetIndex: ti });
  draw();
}

const sortedSols = () => (S.solve ? S.solve.sols.slice().sort((a, b) => b.width - a.width) : []);

function selectSolution(i) {
  const sol = sortedSols()[i];
  if (!sol || !canAct()) return;
  S.aim = sol.aim;
  S.locked = true;
  S.guide = { ...sol, ti: S.solve.ti, sig: ballsSig(), idx: i };
  syncControls();
  renderSolve();
  schedulePredict();
}

function refreshTargetSel() {
  const sel = $('targetSel');
  const prevId = S.balls[+sel.value]?.id;
  const fh = S.pred?.firstHit;
  sel.innerHTML = '';
  S.balls.forEach((b, i) => {
    if (i === 0) return;
    const o = document.createElement('option');
    o.value = i;
    o.textContent = b.name;
    sel.appendChild(o);
  });
  const keep = S.balls.findIndex((b) => b.id === prevId);
  if (keep > 0) sel.value = keep;
  else if (fh) sel.value = fh.obj;
}

// ---------------- 击球与动画 ----------------

function shoot() {
  if (!canAct()) return;
  let s = shot();
  let noisy = false;
  const nk = inMatch() ? S.match.humanNoise : $('shootNoise').checked ? S.noiseKey : 'off';
  if (nk !== 'off') {
    s = perturbShot(s, NOISE_LEVELS[nk], S.table.R, makeRng((Math.random() * 2 ** 32) >>> 0));
    noisy = true;
  }
  shootWith(s, noisy);
}

function shootWith(s, noisy) {
  const { ball } = strike(S.balls[0], S.table, S.phys, s);
  const res = simulate([ball, ...S.balls.slice(1)], S.table, S.phys, { record: true, recordEvery: 1 / 240 });
  if (!inMatch()) pushHistory();
  S.anim = { res, start: performance.now(), noisy };
  S.message = '';
  S.guide = null;
  renderHUD();
  requestAnimationFrame(animate);
}

function animate(now) {
  const a = S.anim;
  if (!a) return;
  const simT = ((now - a.start) / 1000) * S.playback;
  if (simT >= a.res.duration) {
    if (inMatch()) finishMatchShot(a);
    else finishPracticeShot(a);
    return;
  }
  a.t = simT;
  draw();
  requestAnimationFrame(animate);
}

function finishPracticeShot(a) {
  const res = a.res;
  const potted = res.balls.filter((b, k) => k > 0 && !b.on);
  const cue = res.balls[0];
  const parts = [];
  parts.push(potted.length ? '进袋：' + potted.map((b) => `${b.name}（${S.table.pockets[b.pocket].name}）`).join('、') : '没有球进袋');
  if (!cue.on) parts.push('母球落袋，已放回');
  if (!res.firstHit) parts.push('母球没有碰到目标球');
  if (a.noisy) parts.push('本杆含随机出杆误差');
  S.message = parts.join(' · ');
  S.balls = res.balls.filter((b, k) => k === 0 || b.on).map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
  if (!cue.on) {
    const [x, y] = respotCue(S.tableKey, S.table, S.balls);
    S.balls[0] = { ...S.balls[0], x, y, on: true, pocket: undefined };
  }
  S.anim = null;
  predict();
}

function undo() {
  if (S.anim || inMatch()) return;
  const h = S.history.pop();
  if (!h) return;
  S.balls = h;
  S.message = '已撤销';
  schedulePredict();
}

// ---------------- 对局 ----------------

const RULES_TEXT = {
  eight: `<ul>
    <li>开球：母球放在开球线后。至少 4 颗球碰库或有球进袋才算合法开球；开球打进 8 号球则 8 号球复位。</li>
    <li>开球后台面开放，第一颗合法打进的球决定球组（全色 1–7 / 花色 9–15）。台面开放时不能先碰 8 号球。</li>
    <li>每杆必须先碰到本方球；碰球后必须有球进袋或有球碰库。</li>
    <li>犯规（没碰到球、先碰错球、碰球后无球碰库、母球落袋）由对方获得自由球，可把母球放在台面任意位置。</li>
    <li>打进本方球可继续击球。本方球清完后打 8 号球，合法打进获胜；提前打进 8 号球或打进时犯规判负。</li>
  </ul>`,
  snooker: `<ul>
    <li>红球与彩球交替击打：打进红球得 1 分，接着打任意彩球（黄 2、绿 3、咖啡 4、蓝 5、粉 6、黑 7），彩球进袋后复位。</li>
    <li>红球全部进袋后，按黄、绿、咖啡、蓝、粉、黑的顺序清彩，此时进袋的彩球不再复位，黑球进袋时本局结束，分高者胜。</li>
    <li>犯规（没碰到球、先碰到非目标球、打进非目标球、母球落袋）对方得分，至少 4 分，取所涉及球的最高分值。母球落袋后对方在 D 区内放母球。</li>
    <li>简化：彩球阶段先碰到的彩球即视为指定球；没有实现“自由球”“复位重打（miss）”和平分时的黑球决胜。</li>
  </ul>`,
  pool: '<p>美式九球的对局规则暂未提供，请切换到中式八球或斯诺克。</p>',
};

function renderRulesText() {
  $('rulesText').innerHTML = RULES_TEXT[S.tableKey];
}

function startMatch() {
  if (S.tableKey === 'pool') {
    S.message = '美式九球的对局规则暂未提供，请切换到中式八球或斯诺克';
    setTab('match');
    return;
  }
  const opp = $('oppSel').value;
  S.match = { opp, aid: $('aidSel').value, humanNoise: $('humanNoiseSel').value };
  const cpuName = opp === 'cpu-pro' ? '电脑（高手）' : '电脑（业余）';
  const players = opp === 'human'
    ? [{ name: '玩家 1', cpu: false }, { name: '玩家 2', cpu: false }]
    : [{ name: '你', cpu: false }, { name: cpuName, cpu: true, level: opp === 'cpu-pro' ? 'pro' : 'amateur' }];
  S.mode = 'match';
  S.game = createGame(S.tableKey, players);
  S.cpu.id++;
  S.cpu.busy = false;
  S.anim = null;
  S.balls = LAYOUTS[S.tableKey][S.tableKey === 'eight' ? 'rack15' : 'full'].make(S.table).map(fullBall);
  const [x, y] = defaultCueSpot(S.game.ballInHand, S.table, S.balls);
  S.balls[0] = { ...S.balls[0], x, y };
  aimAtRack();
  S.ballSpeed = S.tableKey === 'eight' ? 7 : 3;
  S.side = 0;
  S.height = 0;
  S.elev = 0;
  S.locked = false;
  S.solve = null;
  S.guide = null;
  S.message = S.tableKey === 'eight' ? '开球：可在开球线后拖动母球，选好力度后击球' : '开球：可在 D 区内拖动母球';
  $('overlay').hidden = true;
  updateModeUI();
  syncControls();
  renderScoreboard();
  renderMatchLog();
  predict();
}

function aimAtRack() {
  const c = S.balls[0];
  const on = ballOn(S.game, S.balls);
  const t = on.map((i) => S.balls[i]).sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
  if (t) S.aim = Math.atan2(t.y - c.y, t.x - c.x);
}

function setMode(mode) {
  if (mode === 'match') {
    setTab('match');
    startMatch();
    return;
  }
  S.mode = 'practice';
  S.game = null;
  S.cpu.id++;
  S.cpu.busy = false;
  S.anim = null;
  S.ballSpeed = 1.0;
  S.side = S.height = S.elev = 0;
  $('overlay').hidden = true;
  updateModeUI();
  syncControls();
  setLayout(S.layoutKey in LAYOUTS[S.tableKey] ? S.layoutKey : Object.keys(LAYOUTS[S.tableKey])[0]);
}

function updateModeUI() {
  const m = inMatch();
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (m ? 'match' : 'practice')));
  $('layoutSel').disabled = !!m;
  $('undoBtn').disabled = !!m;
  $('resetBtn').textContent = m ? '重新开局' : '重摆';
  $('scoreboard').hidden = !m;
  $('startMatch').textContent = m ? '按以上设置重新开局' : '开始对局';
}

function finishMatchShot(a) {
  const g = S.game;
  const res = a.res;
  const before = S.balls;
  const shooter = g.players[g.turn].name;
  const out = evaluateShot(g, before, res, S.table);
  const keep = [];
  res.balls.forEach((b, i) => {
    const nb = { ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 };
    if (i === 0 || b.on) keep.push(nb);
    else if (out.respot.includes(i)) keep.push({ ...nb, on: true, pocket: undefined, pending: true });
  });
  for (const b of keep) {
    if (!b.pending) continue;
    const placed = keep.filter((x) => !x.pending && x.on);
    const [x, y] = g.kind === 'eight' ? respotEight(S.table, placed, b) : respotColor(S.table, placed, b);
    b.x = x;
    b.y = y;
    delete b.pending;
  }
  applyOutcome(g, out);
  if (!keep[0].on || g.ballInHand) {
    const [x, y] = defaultCueSpot(g.ballInHand ?? 'anywhere', S.table, keep);
    keep[0] = { ...keep[0], x, y, on: true, pocket: undefined };
  }
  S.balls = keep;
  S.anim = null;
  S.message = `${shooter}：${g.message}`;
  renderScoreboard();
  renderMatchLog();
  if (g.over) {
    showGameOver();
    predict();
    return;
  }
  if (isCpuTurn()) {
    predict();
    cpuTurn();
  } else {
    aimAtRack();
    S.locked = false;
    predict();
  }
}

function showGameOver() {
  const g = S.game;
  let title;
  if (g.winner < 0) title = '平局';
  else if (g.players[g.winner].cpu) title = `${g.players[g.winner].name} 获胜`;
  else title = g.players.every((p) => !p.cpu) ? `${g.players[g.winner].name} 获胜` : '你赢了！';
  const score = g.kind === 'snooker' ? `<p>${g.scores[0]} : ${g.scores[1]}</p>` : `<p>${g.message}</p>`;
  const ov = $('overlay');
  ov.innerHTML = `<div class="card"><h3>${title}</h3>${score}<button class="primary" id="againBtn">再来一局</button> <button id="toPractice">回到练习</button></div>`;
  ov.hidden = false;
  $('againBtn').addEventListener('click', startMatch);
  $('toPractice').addEventListener('click', () => setMode('practice'));
}

function cpuTurn() {
  const g = S.game;
  const p = g.players[g.turn];
  S.cpu.busy = true;
  const id = ++S.cpu.id;
  S.message = `${p.name} 思考中…`;
  renderHUD();
  if (g.kind === 'eight' && g.breakShot) {
    // 开球：全力冲顶球
    setTimeout(() => {
      if (id !== S.cpu.id) return;
      const c = S.balls[0];
      const apex = S.balls.slice(1).sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
      executeCpuPlan({ kind: 'break', shot: { aim: Math.atan2(apex.y - c.y, apex.x - c.x), side: 0, height: -0.1, elev: 0 }, ballSpeed: p.level === 'pro' ? 9.5 : 8 });
    }, 500);
    return;
  }
  const c = aiContext(g, S.balls);
  aiWorker.postMessage({
    kind: 'ai', id, tableKey: S.tableKey, phys: S.phys, balls: S.balls, ...c,
    level: p.level, seed: (Math.random() * 2 ** 31) | 0,
  });
}

function executeCpuPlan(plan) {
  const g = S.game;
  const p = g.players[g.turn];
  if (plan.cue) S.balls[0] = { ...S.balls[0], x: plan.cue[0], y: plan.cue[1] };
  S.aim = plan.shot.aim;
  S.ballSpeed = plan.ballSpeed;
  S.side = plan.shot.side;
  S.height = plan.shot.height;
  S.elev = 0;
  syncControls();
  const kindName = { pot: '进攻', safety: '防守', break: '开球', fallback: '碰球', bank: '一库翻袋', kick: '一库解球' }[plan.kind] ?? '';
  const extra = [];
  if (plan.p !== undefined) extra.push(`估计进球率 ${Math.round(plan.p * 100)}%`);
  if (plan.width !== undefined) extra.push(`瞄准容错 ${(plan.width * DEG).toFixed(2)}°`);
  S.message = `${p.name}：${kindName}${extra.length ? `（${extra.join('，')}）` : ''}`;
  S.guide = plan.guide ? { ...plan.guide, sig: ballsSig() } : null;
  predict();
  const id = S.cpu.id;
  setTimeout(() => {
    if (id !== S.cpu.id || !inMatch() || S.anim) return;
    S.cpu.busy = false;
    const s = perturbShot(shot(), NOISE_LEVELS[p.level], S.table.R, makeRng((Math.random() * 2 ** 32) >>> 0));
    shootWith(s, true);
  }, plan.guide ? 2200 : 1100);
}

function renderScoreboard() {
  const g = S.game;
  const el = $('scoreboard');
  if (!g) { el.innerHTML = ''; return; }
  const remainOf = (grp) => S.balls.filter((b, i) => i > 0 && b.num && (grp === 'solid' ? b.num < 8 : b.num > 8));
  const player = (k) => {
    const p = g.players[k];
    let info = '';
    let score = '';
    if (g.kind === 'eight') {
      const grp = g.groups[k];
      if (grp) {
        const rem = remainOf(grp);
        info = `<span class="badge">${GROUP_NAME[grp]}</span><span class="minis">${rem.map((b) => `<i style="background:${b.color}"></i>`).join('')}</span>${rem.length ? '' : '<span class="badge red">打 8 号球</span>'}`;
      } else info = '<span class="dim">未分组</span>';
      score = `<div class="pscore">${grp ? 7 - remainOf(grp).length : 0}<small class="dim"> / 7</small></div>`;
    } else {
      score = `<div class="pscore">${g.scores[k]}</div>`;
      info = `最高单杆 ${g.best[k]}${g.turn === k && g.brk ? ` · 本杆 ${g.brk}` : ''}`;
    }
    return `<div class="player ${k === 1 ? 'right' : ''} ${g.turn === k && !g.over ? 'turn' : ''}"><div class="pname">${p.cpu ? '🤖 ' : ''}${p.name}</div>${score}<div class="pinfo">${info}</div></div>`;
  };
  let mid = `<b>第 ${g.shotNo + 1} 杆</b>`;
  if (!g.over) mid += `<span>目标：${onDescription(g, S.balls)}</span>`;
  if (g.kind === 'snooker') mid += `<span>台面剩余 ${pointsRemaining(g, S.balls)} 分</span>`;
  if (g.ballInHand && !g.over) mid += `<span class="badge">自由球${g.ballInHand === 'D' ? '（D 区）' : g.ballInHand === 'head' ? '（开球线后）' : ''}</span>`;
  el.innerHTML = player(0) + `<div class="mid">${mid}</div>` + player(1);
}

function renderMatchLog() {
  const g = S.game;
  const el = $('matchLog');
  if (!g) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="sub">本局记录</div><ol class="log">' +
    g.log.map((l, i) => `<li><b>${i + 1}. ${g.players[l.player].name}</b>${l.msg}</li>`).join('') + '</ol>';
}

// ---------------- 绘制 ----------------

function draw() {
  if (!view) return;
  const t = S.table;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.cssW, view.cssH);
  drawTable(ctx, view, t);

  if (S.anim) {
    const { res } = S.anim;
    const T = S.anim.t ?? 0;
    res.tracks.forEach((tr, i) => {
      const b = res.balls[i];
      if (i === 0) drawTrack(ctx, view, tr, { colorByMode: true, width: 2, alpha: 0.85, upto: T });
      else drawTrack(ctx, view, tr, { color: b.color, width: 2, alpha: 0.6, upto: T });
    });
    res.tracks.forEach((tr, i) => {
      const b = res.balls[i];
      if (!b.on && b.pocket !== undefined && T >= tr.t[tr.t.length - 1]) return;
      const [x, y] = trackPos(tr, T);
      drawBall(ctx, view, t, b, x, y);
    });
    drawLabel(ctx, view, 0.02, t.W - 0.04, `t = ${T.toFixed(2)} s  ×${S.playback}`);
    return;
  }

  if (!S.balls.length) return;
  const p = S.pred && S.pred.balls.length === S.balls.length ? S.pred : null;
  const fh = p?.firstHit;
  const cue = S.balls[0];
  const level = aid();
  const humanTurn = !isCpuTurn();

  if (inMatch() && S.game.ballInHand && humanTurn && !S.game.over) drawHandRegion();

  if (level === 'full') drawTolerance();
  if (level !== 'none') drawGuide();

  if (p && level !== 'none') {
    if (S.opts.ghost || level === 'basic') {
      const L = fh ? Math.hypot(fh.cueX - cue.x, fh.cueY - cue.y) : 0.8;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(view.X(cue.x), view.Y(cue.y));
      ctx.lineTo(view.X(cue.x + Math.cos(S.aim) * L), view.Y(cue.y + Math.sin(S.aim) * L));
      ctx.stroke();
      ctx.restore();
    }
    if (level === 'full') {
      p.tracks.forEach((tr, i) => {
        if (i === 0) return;
        const isTarget = fh && i === fh.obj;
        if (!isTarget && !S.opts.allPaths) return;
        const col = /^#1[45]1[45]1[45]$/.test(S.balls[i].color) ? '#bbb' : S.balls[i].color;
        drawTrack(ctx, view, tr, { color: col, width: isTarget ? 2.5 : 1.5, alpha: isTarget ? 0.95 : 0.6 });
      });
      drawTrack(ctx, view, p.tracks[0], { colorByMode: true, width: 2.5 });
      p.balls.forEach((b, i) => {
        const b0 = S.balls[i];
        if (!b.on || Math.hypot(b.x - b0.x, b.y - b0.y) < 0.003) return;
        if (i === 0) ghostCircle(ctx, view, t, b.x, b.y, '#ffffff', { width: 2, dash: [5, 3], cross: true, fill: 'rgba(255,255,255,0.12)' });
        else ghostCircle(ctx, view, t, b.x, b.y, /^#1[45]1[45]1[45]$/.test(b0.color) ? '#ccc' : b0.color, { width: 1.5, dash: [4, 3] });
      });
      p.balls.forEach((b, i) => {
        if (b.on || b.pocket === undefined) return;
        const pk = t.pockets[b.pocket];
        ctx.save();
        ctx.strokeStyle = i === 0 ? '#ff5050' : '#7dff8c';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(view.X(pk.drawX), view.Y(pk.drawY), pk.drawR * view.scale + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
    } else if (fh) {
      // 基础辅助：目标球出射方向的一小段
      const ob = S.balls[fh.obj];
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(view.X(ob.x), view.Y(ob.y));
      ctx.lineTo(view.X(ob.x + Math.cos(fh.objDir) * 0.3), view.Y(ob.y + Math.sin(fh.objDir) * 0.3));
      ctx.stroke();
      ctx.restore();
    }
    if (fh && (S.opts.ghost || level === 'basic')) ghostCircle(ctx, view, t, fh.cueX, fh.cueY, 'rgba(255,255,255,0.85)', { dash: [3, 3] });
  }

  S.balls.forEach((b) => drawBall(ctx, view, t, b, b.x, b.y));
  if (S.hoverBall >= 0 && S.hoverBall < S.balls.length && !S.drag && canDrag(S.hoverBall)) {
    const b = S.balls[S.hoverBall];
    ghostCircle(ctx, view, t, b.x, b.y, 'rgba(255,255,255,0.9)', { dash: [], width: 2 });
  }
  if (p && !S.drag && !(inMatch() && S.game.over)) drawCue(ctx, view, t, cue, S.aim, S.side, S.ballSpeed * 0.75);
  if (p && level === 'full') {
    const cb = p.balls[0];
    if (cb.on && Math.hypot(cb.x - cue.x, cb.y - cue.y) > 0.003) {
      const lx = cb.x > t.L - 0.35 ? cb.x - t.R * 1.4 - 64 / view.scale : cb.x + t.R * 1.4;
      const ly = cb.y > t.W - 0.08 ? cb.y - t.R * 1.6 : cb.y + t.R * 1.2;
      drawLabel(ctx, view, lx, ly, '母球落点');
    }
  }
}

function drawHandRegion() {
  const t = S.table, r = S.game.ballInHand;
  ctx.save();
  ctx.fillStyle = 'rgba(255,209,102,0.10)';
  ctx.strokeStyle = 'rgba(255,209,102,0.6)';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  if (r === 'D') {
    const s = snookerSpots(t);
    ctx.moveTo(view.X(s.baulk), view.Y(t.W / 2 + s.dR));
    ctx.arc(view.X(s.baulk), view.Y(t.W / 2), s.dR * view.scale, -Math.PI / 2, Math.PI / 2, true);
    ctx.closePath();
  } else if (r === 'head') {
    ctx.rect(view.X(0), view.Y(t.W), (t.L / 4) * view.scale, t.W * view.scale);
  } else {
    ctx.rect(view.X(0), view.Y(t.W), t.L * view.scale, t.W * view.scale);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** 进袋窗口（两条边界线路之间的绿色区域）与母球落点范围 */
function drawTolerance() {
  const w = S.win;
  if (S.opts.window && w && w.found && w.loTrack && w.hiTrack) {
    const a = w.loTrack, b = w.hiTrack;
    ctx.save();
    ctx.fillStyle = 'rgba(120,255,140,0.18)';
    ctx.beginPath();
    for (let k = 0; k < a.x.length; k++) ctx[k ? 'lineTo' : 'moveTo'](view.X(a.x[k]), view.Y(a.y[k]));
    for (let k = b.x.length - 1; k >= 0; k--) ctx.lineTo(view.X(b.x[k]), view.Y(b.y[k]));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,255,140,0.8)';
    ctx.lineWidth = 1;
    for (const tr of [a, b]) {
      ctx.beginPath();
      for (let k = 0; k < tr.x.length; k++) ctx[k ? 'lineTo' : 'moveTo'](view.X(tr.x[k]), view.Y(tr.y[k]));
      ctx.stroke();
    }
    ctx.restore();
  }
  const mc = S.mc;
  if (!mc || !mc.samples.length || S.opts.landing === 'off') return;
  if (S.opts.landing !== 'region') {
    for (const s of mc.samples) {
      ctx.fillStyle = s.scratch ? 'rgba(255,80,80,0.95)' : s.target ? 'rgba(120,255,140,0.9)' : 'rgba(255,190,80,0.75)';
      ctx.beginPath();
      ctx.arc(view.X(s.x), view.Y(s.y), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (S.opts.landing !== 'dots') {
    const e = landingEllipse();
    if (!e) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.X(0), view.Y(S.table.W), S.table.L * view.scale, S.table.W * view.scale);
    ctx.clip();
    for (const [k, fill, dash] of [[2.146, 'rgba(255,255,255,0.08)', [6, 4]], [1.177, 'rgba(255,255,255,0.18)', []]]) {
      ctx.beginPath();
      ctx.ellipse(view.X(e.mx), view.Y(e.my), Math.max(2, k * e.a * view.scale), Math.max(2, k * e.b * view.scale), -e.ang, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.setLineDash(dash);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** 母球落点的均值与协方差椭圆（只统计目标球进了的样本；太少时退回全部未落袋样本） */
function landingEllipse() {
  const ss = S.mc?.samples;
  if (!ss) return null;
  let pts = ss.filter((s) => s.target && !s.scratch);
  let cond = true;
  if (pts.length < 6) { pts = ss.filter((s) => !s.scratch); cond = false; }
  if (pts.length < 6) return null;
  const n = pts.length;
  const mx = pts.reduce((a, s) => a + s.x, 0) / n, my = pts.reduce((a, s) => a + s.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const s of pts) { sxx += (s.x - mx) ** 2; syy += (s.y - my) ** 2; sxy += (s.x - mx) * (s.y - my); }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  const ang = Math.abs(sxy) < 1e-12 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
  return { mx, my, a: Math.sqrt(l1), b: Math.sqrt(l2), ang, n, cond };
}

function drawGuide() {
  const g = S.guide;
  if (!g) return;
  if (g.sig !== ballsSig()) { S.guide = null; return; }
  const t = S.table;
  const rail = railLines(t).find((r) => r.key === g.rail);
  const [hx, hy] = g.railHit, [mx, my] = g.mirror;
  const from = g.type === 'bank' ? S.balls[g.ti] : S.balls[0];
  const to = g.type === 'bank' ? [t.pockets[g.pocket].mx, t.pockets[g.pocket].my] : [S.balls[g.ti].x, S.balls[g.ti].y];
  ctx.save();
  ctx.strokeStyle = 'rgba(255,209,102,0.55)';
  ctx.setLineDash([2, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (rail.axis === 'y') { ctx.moveTo(view.X(0), view.Y(rail.c)); ctx.lineTo(view.X(t.L), view.Y(rail.c)); }
  else { ctx.moveTo(view.X(rail.c), view.Y(0)); ctx.lineTo(view.X(rail.c), view.Y(t.W)); }
  ctx.stroke();
  ctx.strokeStyle = '#ffd166';
  ctx.setLineDash([7, 5]);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(view.X(from.x), view.Y(from.y));
  ctx.lineTo(view.X(hx), view.Y(hy));
  ctx.lineTo(view.X(to[0]), view.Y(to[1]));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,209,102,0.5)';
  ctx.setLineDash([2, 5]);
  ctx.beginPath();
  ctx.moveTo(view.X(hx), view.Y(hy));
  ctx.lineTo(view.X(mx), view.Y(my));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(view.X(mx), view.Y(my), 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(view.X(hx), view.Y(hy), 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------- 关键结果条 ----------------

function chip(cls, html) {
  return `<span class="chip ${cls}">${html}</span>`;
}

function renderHUD() {
  const out = [];
  const p = S.pred, t = S.table;
  const level = aid();
  if (inMatch()) {
    const g = S.game;
    if (!g.over) {
      const pl = g.players[g.turn];
      out.push(chip('', `轮到 <b>${pl.name}</b> <small>目标：${onDescription(g, S.balls)}</small>`));
      if (g.ballInHand && !pl.cpu) out.push(chip('warn', '<b>自由球</b> <small>拖动母球摆放</small>'));
    }
  }
  if (p && !S.anim) {
    const fh = p.firstHit;
    if (level === 'full') {
      if (fh) {
        const ob = S.balls[fh.obj], after = p.balls[fh.obj];
        out.push(after.on
          ? chip('bad', `<i class="sw" style="background:${ob.color}"></i>${ob.name} <b>✗ 不进</b>`)
          : chip('ok', `<i class="sw" style="background:${ob.color}"></i>${ob.name} <b>✓ 进${t.pockets[after.pocket].name}</b>`));
      } else out.push(chip('warn', '<b>碰不到任何球</b>'));
    }
    if (fh && level !== 'none') {
      const th = 1 - Math.sin(fh.cut / DEG);
      out.push(chip('', `切角 <b>${fh.cut.toFixed(1)}°</b> <small>${thicknessName(th)}</small>`));
    }
    if (level === 'full' && fh) {
      const w = S.win;
      if (!w) out.push(chip('', '进袋窗口 <small>计算中…</small>'));
      else if (!w.found) out.push(chip('bad', '进袋窗口 <b>附近打不进</b>'));
      else if (w.lo <= 0 && w.hi >= 0) out.push(chip(w.width * DEG < 0.15 ? 'warn' : 'ok', `进袋窗口 <b>${(w.width * DEG).toFixed(2)}°</b> <small>左 ${(w.hi * DEG).toFixed(2)} / 右 ${(-w.lo * DEG).toFixed(2)}</small>`));
      else {
        const shift = w.lo > 0 ? w.lo : w.hi;
        out.push(chip('warn', `向${shift > 0 ? '左' : '右'}调 <b>${Math.abs(shift * DEG).toFixed(2)}°</b> <small>才进</small>`));
      }
      if (S.mc && S.mc.samples.length) {
        const k = S.mc.samples.length, hit = S.mc.samples.filter((s) => s.target).length;
        const pct = Math.round((100 * hit) / k);
        out.push(chip(pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'bad', `${NOISE_LEVELS[S.noiseKey].name}进袋率 <b>${pct}%</b>`));
      }
      const cb = p.balls[0];
      out.push(cb.on ? chip('', `母球行程 <b>${p.cueTravel.toFixed(1)} m</b>`) : chip('bad', '<b>✗ 母球落袋</b>'));
      const others = p.balls.filter((b, i) => i > 0 && !b.on && i !== fh.obj);
      if (others.length) out.push(chip('warn', `另进 <b>${others.map((b) => b.name).join('、')}</b>`));
    }
  }
  $('hud').innerHTML = out.join('');
}

// ---------------- 侧栏面板 ----------------

function fmt(x, d = 2) {
  return Number.isFinite(x) ? x.toFixed(d) : '—';
}

function thicknessName(th) {
  if (th > 0.93) return '全球';
  if (th > 0.68) return '约 3/4 球';
  if (th > 0.43) return '约半球';
  if (th > 0.18) return '约 1/4 球';
  if (th > 0.06) return '薄球';
  return '极薄';
}

function spinText(r) {
  if (r > 1.05) return `强上旋（${fmt(r)}× 自然滚动）`;
  if (r > 0.95) return '自然滚动';
  if (r > 0.08) return `弱上旋（${fmt(r)}×）`;
  if (r > -0.08) return '基本无旋（定杆）';
  return `下旋（${fmt(-r)}× 自然滚动转速）`;
}

function renderResult() {
  const p = S.pred, info = S.info, t = S.table;
  renderHitInfo();
  if (aid() !== 'full') {
    $('result').innerHTML = '<div class="dim">对局中辅助线不是“完整”，详细预测已隐藏。可以在“对局”页把辅助线改成完整后重新开局。</div>';
    return;
  }
  const fh = p.firstHit;
  const rows = [];
  rows.push(
    `<div class="kv"><span>母球初速</span><b>${fmt(info.ballSpeed)} m/s</b></div>`,
    `<div class="kv"><span>上下旋</span><b>${spinText(info.spinRatio)}</b></div>`,
    `<div class="kv"><span>侧旋</span><b>${Math.abs(info.sideRpm) < 1 ? '无' : `${info.sideRpm > 0 ? '右塞' : '左塞'} ${Math.abs(info.sideRpm).toFixed(0)} rpm`}</b></div>`,
    `<div class="kv"><span>偏杆角</span><b>${fmt(Math.abs(info.squirtDeg))}°</b></div>`
  );
  if (info.miscue) rows.push('<div class="warn">击打点偏离球心超过 0.5R，实际出杆很可能滑杆</div>');
  rows.push('<div class="sep"></div>');
  if (fh) {
    const ob = S.balls[fh.obj], after = p.balls[fh.obj];
    const th = 1 - Math.sin(fh.cut / DEG);
    rows.push(
      `<div class="kv"><span>目标球</span><b><i class="sw" style="background:${ob.color}"></i> ${ob.name}</b></div>`,
      `<div class="kv"><span>结果</span>${!after.on ? `<b class="ok">✓ 进袋 · ${t.pockets[after.pocket].name}</b>` : '<b class="bad">✗ 未进袋</b>'}</div>`,
      `<div class="kv"><span>切角 / 厚度</span><b>${fmt(fh.cut, 1)}° · ${fmt(th)}（${thicknessName(th)}）</b></div>`,
      `<div class="kv"><span>碰前母球速度</span><b>${fmt(fh.cueSpeedBefore)} m/s</b></div>`,
      `<div class="kv"><span>投掷偏差</span><b>${fmt(fh.throwDeg, 2)}°</b></div>`,
      `<div class="kv"><span>母球分离角</span><b>瞬时 ${fmt(fh.instDeflect, 1)}° → 滚动后 ${fmt(fh.finalDeflect, 1)}°</b></div>`
    );
  } else rows.push('<div class="warn">母球没有碰到任何目标球</div>');
  rows.push('<div class="sep"></div>');
  const cb = p.balls[0];
  rows.push(cb.on
    ? `<div class="kv"><span>母球停点</span><b>(${fmt(cb.x)}, ${fmt(cb.y)}) m · 行程 ${fmt(p.cueTravel)} m</b></div>`
    : `<div class="kv"><span>母球</span><b class="bad">✗ 落袋（${t.pockets[cb.pocket].name}）</b></div>`);
  const others = p.balls.filter((b, k) => k > 0 && !b.on && (!fh || k !== fh.obj));
  if (others.length) rows.push(`<div class="kv"><span>其他进袋</span><b>${others.map((b) => b.name).join('、')}</b></div>`);
  rows.push(`<div class="kv dim"><span>全部静止</span><b>${fmt(p.duration, 1)} s · 计算 ${fmt(S.predMs, 1)} ms</b></div>`);
  const names = (i) => S.balls[i].name;
  const evs = p.events.slice(0, 12).map((e) => {
    let s;
    if (e.type === 'ball') s = `${names(e.i)} ↔ ${names(e.j)}`;
    else if (e.type === 'cushion') s = `${names(e.i)} 撞库`;
    else if (e.type === 'jaw') s = `${names(e.i)} 碰袋角`;
    else s = `${names(e.i)} 落入${t.pockets[e.pocket].name}`;
    return `<li><span>${e.t.toFixed(2)} s</span>${s}${e.speed ? ` · ${e.speed.toFixed(2)} m/s` : ''}</li>`;
  });
  if (p.events.length > 12) evs.push(`<li class="dim">… 共 ${p.events.length} 个事件</li>`);
  rows.push(`<details class="events"><summary>碰撞事件（${p.events.length}）</summary><ol>${evs.join('')}</ol></details>`);
  $('result').innerHTML = rows.join('');
}

function renderMC() {
  const el = $('mcOut');
  const fh = S.pred?.firstHit;
  if (aid() !== 'full') { el.innerHTML = '<div class="dim">对局中辅助线不是“完整”时不计算容错。</div>'; return; }
  if (!fh) { el.innerHTML = '<div class="dim">母球没有碰到目标球，无从计算</div>'; return; }
  const out = [];
  const tgt = S.balls[fh.obj].name;
  const cue = S.balls[0];
  const D = Math.hypot(fh.cueX - cue.x, fh.cueY - cue.y);
  const mm = (rad) => Math.abs(D * rad * 1000).toFixed(1);
  const deg = (rad) => Math.abs(rad * DEG).toFixed(2);
  const w = S.win;
  out.push('<div class="sub">进袋窗口 <span class="dim">（只改瞄准方向，其他不变）</span></div>');
  if (!w) out.push('<div class="dim">计算中…</div>');
  else if (!w.found) out.push(`<div class="warn">瞄准方向左右 ${deg(w.half)}° 内都打不进${tgt}</div>`);
  else if (w.lo <= 0 && w.hi >= 0) {
    out.push(
      `<div class="big"><span>可偏范围</span><b>${deg(w.width)}°</b></div>`,
      `<div class="kv"><span>向左还能偏</span><b>${deg(w.hi)}°（假想球 ${mm(w.hi)} mm）</b></div>`,
      `<div class="kv"><span>向右还能偏</span><b>${deg(w.lo)}°（假想球 ${mm(w.lo)} mm）</b></div>`
    );
    if (Math.min(-w.lo, w.hi) < w.width * 0.2) out.push(`<div class="warn">当前瞄准贴近窗口${-w.lo < w.hi ? '右' : '左'}边缘，往中间调更稳</div>`);
  } else {
    const shift = w.lo > 0 ? w.lo : w.hi;
    out.push(`<div class="warn">当前瞄准不进。向${shift > 0 ? '左' : '右'}调 ${deg(shift)}° 进入窗口，窗口宽 ${deg(w.width)}°</div>`);
  }
  out.push('<div class="dim small">台面上的绿色区域：窗口两侧边界对应的目标球线路</div><div class="sep"></div>');
  if (S.noiseKey === 'off' || !S.mc) {
    out.push('<div class="dim">出杆误差模拟已关闭</div>');
    el.innerHTML = out.join('');
    return;
  }
  const n = NOISE_LEVELS[S.noiseKey];
  const ss = S.mc.samples, k = ss.length;
  out.push(`<div class="sub">按“${n.name}”出杆误差重复 ${S.mc.N} 次</div>`, `<div class="dim small">误差标准差：瞄准 ${n.aimDeg}° · 击打点 ${n.tipMM} mm · 力度 ${n.speedPct}%</div>`);
  if (!k) { out.push('<div class="dim">计算中…</div>'); el.innerHTML = out.join(''); return; }
  const pct = (c) => `${Math.round((100 * c) / k)}%`;
  const target = ss.filter((s) => s.target).length, scratch = ss.filter((s) => s.scratch).length;
  out.push(
    `<div class="big"><span>${tgt}进袋率</span><b>${pct(target)}</b></div>`,
    `<div class="bar"><i style="width:${(100 * target) / k}%"></i></div>`,
    `<div class="kv"><span>母球落袋率</span><b>${pct(scratch)}</b></div>`
  );
  const e = landingEllipse();
  if (e) {
    out.push(`<div class="kv"><span>母球落点 90% 范围</span><b>约 ${(2 * 2.146 * e.a * 100).toFixed(0)} × ${(2 * 2.146 * e.b * 100).toFixed(0)} cm</b></div>`);
    out.push(`<div class="dim small">白色椭圆：内圈约含一半落点，外圈约含九成${e.cond ? '（只统计目标球进袋的那些杆）' : '（进球样本太少，统计的是全部未落袋的杆）'}</div>`);
  }
  out.push(`<div class="kv dim"><span>样本</span><b>${k} / ${S.mc.N}${S.mc.done ? '' : ' …'}</b></div>`);
  if (S.opts.landing !== 'region') out.push('<div class="legend"><i style="background:#78ff8c"></i>目标球进 <i style="background:#ffbe50"></i>未进 <i style="background:#ff5050"></i>母球落袋</div>');
  el.innerHTML = out.join('');
}

function renderSolve() {
  const el = $('solveOut');
  const sv = S.solve;
  if (!sv) { el.innerHTML = ''; return; }
  const t = S.table;
  const deg = (rad) => (rad * DEG).toFixed(2);
  const out = [];
  const [k, n] = sv.progress;
  if (!sv.done) out.push(`<div class="dim">搜索中 ${k} / ${n} 条候选线路…</div>`);
  if (sv.sig !== ballsSig() || sv.shotSig !== shotSig()) out.push('<div class="warn">球的位置或出杆参数已改变，结果可能不再适用，可重新搜索</div>');
  const sols = sortedSols();
  if (sv.done && !sols.length) out.push(`<div class="warn">${n ? '当前力度和旋转下没有找到可行线路。' : '没有几何上可行的线路（切角太大或路线不经过台面）。'}可以换力度、加塞或换目标球再试。</div>`);
  const items = sols.map((s, i) => {
    const sel = S.guide && S.guide.idx === i ? ' sel' : '';
    if (s.type === 'bank') {
      const extra = [`目标球要比镜像线偏${s.dirShift > 0 ? '左' : '右'} ${Math.abs(s.dirShift * DEG).toFixed(1)}° 送出`, `切角 ${s.cutActual.toFixed(0)}°`];
      if (s.scratch) extra.push('<span class="bad">母球会落袋</span>');
      return `<li class="sol${sel}" data-i="${i}"><div><b>翻${s.railName} → ${t.pockets[s.pocket].name}</b><span>容错 ${deg(s.width)}°</span></div><div class="dim small">${extra.join(' · ')}</div></li>`;
    }
    const extra = [`比镜像点瞄准偏${s.aimShift > 0 ? '左' : '右'} ${Math.abs(s.aimShift * DEG).toFixed(2)}°`];
    if (Number.isFinite(s.cut)) extra.push(`碰球切角 ${s.cut.toFixed(0)}°`);
    if (s.targetPotted) extra.push(`<span class="ok">顺带打进${t.pockets[s.targetPocket].name}</span>`);
    if (s.scratch) extra.push('<span class="bad">母球会落袋</span>');
    return `<li class="sol${sel}" data-i="${i}"><div><b>吃${s.railName}解球</b><span>容错 ${deg(s.width)}°</span></div><div class="dim small">${extra.join(' · ')}</div></li>`;
  });
  if (items.length) out.push(`<ol class="sols">${items.join('')}</ol><div class="dim small">点一条线路即把瞄准设到它的容错区间中点。黄色虚线是镜像法给出的几何线路，实线是物理模拟的真实线路。</div>`);
  el.innerHTML = out.join('');
  el.querySelectorAll('li.sol').forEach((li) => li.addEventListener('click', () => selectSolution(+li.dataset.i)));
}

// ---------------- 击打点控件 ----------------

const HP = 96;
const hp = $('hitpoint');
const hctx = hp.getContext('2d');
function drawHitPoint() {
  const dpr = window.devicePixelRatio || 1;
  hp.width = HP * dpr;
  hp.height = HP * dpr;
  hp.style.width = HP + 'px';
  hp.style.height = HP + 'px';
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = HP / 2, r = HP * 0.44;
  hctx.clearRect(0, 0, HP, HP);
  const g = hctx.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#c4c1b3');
  hctx.fillStyle = g;
  hctx.beginPath();
  hctx.arc(c, c, r, 0, Math.PI * 2);
  hctx.fill();
  hctx.strokeStyle = 'rgba(0,0,0,0.22)';
  hctx.lineWidth = 1;
  hctx.beginPath();
  hctx.moveTo(c - r, c); hctx.lineTo(c + r, c);
  hctx.moveTo(c, c - r); hctx.lineTo(c, c + r);
  hctx.stroke();
  hctx.fillStyle = 'rgba(0,120,200,0.7)';
  hctx.beginPath();
  hctx.arc(c, c - 0.4 * r, 2.2, 0, Math.PI * 2);
  hctx.fill();
  hctx.strokeStyle = 'rgba(220,40,40,0.7)';
  hctx.setLineDash([3, 3]);
  hctx.beginPath();
  hctx.arc(c, c, MISCUE_LIMIT * r, 0, Math.PI * 2);
  hctx.stroke();
  hctx.setLineDash([]);
  hctx.fillStyle = '#2563eb';
  hctx.strokeStyle = '#fff';
  hctx.lineWidth = 2;
  hctx.beginPath();
  hctx.arc(c + S.side * r, c - S.height * r, 6, 0, Math.PI * 2);
  hctx.fill();
  hctx.stroke();
}

function renderHitInfo() {
  const s = S.side, h = S.height;
  const a = Math.abs(h) < 0.02 ? '中杆' : h > 0 ? `高杆 ${h.toFixed(2)}R` : `低杆 ${(-h).toFixed(2)}R`;
  const b = Math.abs(s) < 0.02 ? '不加塞' : s > 0 ? `右塞 ${s.toFixed(2)}R` : `左塞 ${(-s).toFixed(2)}R`;
  $('hitInfo').innerHTML = `${a} · ${b}`;
  drawHitPoint();
}

function setHitFromEvent(e) {
  if (!canAct()) return;
  const rect = hp.getBoundingClientRect();
  const w = rect.width, c = w / 2, r = w * 0.44;
  let s = (e.clientX - rect.left - c) / r;
  let h = -(e.clientY - rect.top - c) / r;
  const m = Math.hypot(s, h);
  if (m > 0.7) { s *= 0.7 / m; h *= 0.7 / m; }
  if (Math.abs(s) < 0.03) s = 0;
  if (Math.abs(h) < 0.03) h = 0;
  S.side = s;
  S.height = h;
  schedulePredict();
}
hp.addEventListener('pointerdown', (e) => { hp.setPointerCapture(e.pointerId); setHitFromEvent(e); });
hp.addEventListener('pointermove', (e) => { if (e.buttons) setHitFromEvent(e); });
hp.addEventListener('dblclick', () => { if (!canAct()) return; S.side = 0; S.height = 0; schedulePredict(); });

// ---------------- 球台交互 ----------------

function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return view.toTable(e.clientX - rect.left, e.clientY - rect.top);
}

function ballAt(x, y) {
  let best = -1, bd = Infinity;
  S.balls.forEach((b, i) => {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < S.table.R * 1.3 && d < bd) { bd = d; best = i; }
  });
  return best;
}

function canDrag(i) {
  if (!canAct()) return false;
  if (!inMatch()) return true;
  return i === 0 && !!S.game.ballInHand;
}

function clampToTable(x, y) {
  const R = S.table.R;
  return [Math.min(S.table.L - R, Math.max(R, x)), Math.min(S.table.W - R, Math.max(R, y))];
}

function aimAt(x, y) {
  const c = S.balls[0];
  if (Math.hypot(x - c.x, y - c.y) < 1e-4) return;
  S.aim = Math.atan2(y - c.y, x - c.x);
  updateAimOut();
  schedulePredict();
}

canvas.addEventListener('pointermove', (e) => {
  if (!view || S.anim) return;
  const [x, y] = eventPos(e);
  if (S.drag) {
    const i = S.drag.i;
    let [cx, cy] = clampToTable(x - S.drag.dx, y - S.drag.dy);
    if (inMatch()) [cx, cy] = clampToRegion(S.game.ballInHand, S.table, cx, cy);
    const R = S.table.R;
    if (S.balls.every((b, k) => k === i || Math.hypot(b.x - cx, b.y - cy) >= 2 * R)) {
      S.balls[i] = { ...S.balls[i], x: cx, y: cy };
      S.drag.moved = true;
      schedulePredict();
    }
    return;
  }
  const hb = ballAt(x, y);
  if (hb !== S.hoverBall) { S.hoverBall = hb; draw(); }
  canvas.style.cursor = hb >= 0 && canDrag(hb) ? 'grab' : !canAct() ? 'default' : S.locked ? 'default' : 'crosshair';
  if (!S.locked && canAct()) aimAt(x, y);
});

canvas.addEventListener('pointerleave', () => { S.hoverBall = -1; draw(); });

canvas.addEventListener('pointerdown', (e) => {
  if (!view || !canAct() || e.button !== 0) return;
  const [x, y] = eventPos(e);
  const i = ballAt(x, y);
  if (i >= 0 && canDrag(i)) {
    canvas.setPointerCapture(e.pointerId);
    S.drag = { i, dx: x - S.balls[i].x, dy: y - S.balls[i].y, moved: false, before: snapshot() };
    canvas.style.cursor = 'grabbing';
    return;
  }
  S.locked = !S.locked;
  if (!S.locked) aimAt(x, y);
  updateAimOut();
  draw();
});

canvas.addEventListener('pointerup', () => {
  if (!S.drag) return;
  if (S.drag.moved && !inMatch()) { S.history.push(S.drag.before); S.message = ''; }
  S.drag = null;
  canvas.style.cursor = 'grab';
  schedulePredict();
});

canvas.addEventListener('dblclick', (e) => {
  if (S.anim || inMatch()) return;
  const [x, y] = eventPos(e);
  const i = ballAt(x, y);
  if (i > 0) {
    pushHistory();
    S.balls.splice(i, 1);
    S.hoverBall = -1;
  } else if (i < 0) {
    const [cx, cy] = clampToTable(x, y);
    if (S.balls.every((b) => Math.hypot(b.x - cx, b.y - cy) >= 2 * S.table.R)) {
      pushHistory();
      S.balls.push(fullBall(newObjectBall(S.tableKey, S.balls, cx, cy)));
    }
  }
  updateAimOut();
  schedulePredict();
});

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox')) return;
  if (!canAct() && e.key !== 'z') return;
  const big = e.shiftKey;
  let handled = true;
  let pos = speedToPos(S.ballSpeed);
  switch (e.key) {
    case ' ': shoot(); break;
    case 'ArrowLeft': S.aim += (big ? 0.5 : 0.05) / DEG; S.locked = true; break;
    case 'ArrowRight': S.aim -= (big ? 0.5 : 0.05) / DEG; S.locked = true; break;
    case 'ArrowUp': pos = Math.min(1000, pos + (big ? 50 : 10)); S.ballSpeed = posToSpeed(pos); break;
    case 'ArrowDown': pos = Math.max(0, pos - (big ? 50 : 10)); S.ballSpeed = posToSpeed(pos); break;
    case 'w': case 'W': S.height = Math.min(0.7, S.height + 0.05); break;
    case 's': case 'S': S.height = Math.max(-0.7, S.height - 0.05); break;
    case 'a': case 'A': S.side = Math.max(-0.7, S.side - 0.05); break;
    case 'd': case 'D': S.side = Math.min(0.7, S.side + 0.05); break;
    case 'Escape': S.locked = !S.locked; break;
    case 'z': case 'Z': if (e.ctrlKey || e.metaKey) undo(); else handled = false; break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    syncControls();
    schedulePredict();
  }
});

// ---------------- 控件 ----------------

function updateAimOut() {
  let a = S.aim * DEG;
  a = ((a % 360) + 360) % 360;
  $('aimOut').textContent = `${a.toFixed(2)}°`;
  $('aimLock').textContent = S.locked ? '已锁定' : '跟随鼠标';
  $('aimLock').classList.toggle('on', S.locked);
}

function syncControls() {
  const v = S.ballSpeed;
  $('power').value = speedToPos(v);
  $('powerOut').textContent = `${v.toFixed(2)} m/s`;
  $('powerClass').textContent = speedClass(v);
  const roll = ((5 / 7) * v) ** 2 / (2 * S.phys.mu_r * G);
  const lengths = roll / S.table.L;
  $('powerDesc').textContent = lengths < 6
    ? `母球初速（中杆）。不碰球、不计撞库时可自由滚动约 ${roll.toFixed(1)} m，约 ${lengths.toFixed(1)} 个台长`
    : '母球初速（中杆）。这个速度下台呢阻力只消耗很少能量，球主要靠撞库（每次损失约三到五成速度）和碰球停下来';
  $('elev').value = S.elev;
  $('elevOut').textContent = `${S.elev.toFixed(1)}°`;
  updateAimOut();
}

function setTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
}

$('power').addEventListener('input', (e) => { if (!canAct()) return; S.ballSpeed = posToSpeed(+e.target.value); syncControls(); schedulePredict(); });
$('elev').addEventListener('input', (e) => { if (!canAct()) return; S.elev = +e.target.value; syncControls(); schedulePredict(); });
$('aimLock').addEventListener('click', () => { S.locked = !S.locked; updateAimOut(); });
$('shootBtn').addEventListener('click', shoot);
$('undoBtn').addEventListener('click', undo);
$('resetBtn').addEventListener('click', () => (inMatch() ? startMatch() : setLayout(S.layoutKey)));
$('tableSel').addEventListener('change', (e) => {
  const wasMatch = inMatch();
  S.game = null;
  S.mode = 'practice';
  setTable(e.target.value);
  if (wasMatch && e.target.value !== 'pool') startMatch();
  else updateModeUI();
});
$('layoutSel').addEventListener('change', (e) => setLayout(e.target.value));
$('noiseSel').addEventListener('change', (e) => { S.noiseKey = e.target.value; requestMC(); renderMC(); renderHUD(); draw(); });
$('playback').addEventListener('change', (e) => { S.playback = +e.target.value; });
$('startMatch').addEventListener('click', startMatch);
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('#clothSeg button').forEach((b) => b.addEventListener('click', () => {
  S.cloth = b.dataset.cloth;
  document.querySelectorAll('#clothSeg button').forEach((x) => x.classList.toggle('on', x === b));
  S.phys.mu_r = CLOTH_MU[S.tableKey][S.cloth];
  buildParamPanel();
  syncControls();
  schedulePredict();
}));
for (const k of ['allPaths', 'ghost', 'window']) {
  const el = $('opt_' + k);
  el.checked = S.opts[k];
  el.addEventListener('change', () => { S.opts[k] = el.checked; draw(); });
}
$('landingSel').value = S.opts.landing;
$('landingSel').addEventListener('change', (e) => { S.opts.landing = e.target.value; renderMC(); draw(); });
$('bankBtn').addEventListener('click', () => startSolve('bank'));
$('kickBtn').addEventListener('click', () => startSolve('kick'));
$('targetSel').addEventListener('change', () => { S.solve = null; S.guide = null; renderSolve(); draw(); });

const PARAMS = [
  ['mu_s', '滑动摩擦 μs', 0.01],
  ['mu_r', '滚动阻力 μr', 0.001],
  ['mu_sp', '侧旋衰减 μsp', 0.005],
  ['e_ball', '球-球恢复系数', 0.01],
  ['e_cushion', '球-库恢复系数', 0.01],
  ['mu_cushion', '球-库摩擦', 0.01],
  ['endMass', '杆头端质量 (kg)', 0.001],
  ['tipE', '杆头恢复系数', 0.01],
  ['throw', '计入投掷效应', null],
  ['squirt', '计入偏杆', null],
];

function buildParamPanel() {
  const box = $('params');
  box.innerHTML = '';
  for (const [k, label, step] of PARAMS) {
    const row = document.createElement('label');
    row.className = 'param';
    const inp = document.createElement('input');
    if (step === null) {
      inp.type = 'checkbox';
      inp.checked = S.phys[k];
      inp.addEventListener('change', () => { S.phys[k] = inp.checked; schedulePredict(); });
    } else {
      inp.type = 'number';
      inp.step = step;
      inp.min = 0;
      inp.value = S.phys[k];
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v) && v >= 0) { S.phys[k] = v; syncControls(); schedulePredict(); }
      });
    }
    row.append(Object.assign(document.createElement('span'), { textContent: label }), inp);
    box.appendChild(row);
  }
  const btn = document.createElement('button');
  btn.textContent = '恢复默认参数';
  btn.addEventListener('click', () => {
    S.phys = { ...DEFAULT_PHYS[S.tableKey], mu_r: CLOTH_MU[S.tableKey][S.cloth] };
    buildParamPanel();
    syncControls();
    schedulePredict();
  });
  box.appendChild(btn);
}

// ---------------- 尺寸 ----------------

function resize() {
  if (!S.table) return;
  const wrap = $('tableWrap');
  const probe = makeView(S.table, 100);
  // 球台下方要留出结果条和出杆控制台
  const reserve = 230;
  const maxH = window.innerHeight - wrap.getBoundingClientRect().top - reserve;
  const cssW = Math.max(320, Math.min(wrap.clientWidth, Math.max(260, maxH) / probe.aspect));
  view = makeView(S.table, cssW);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(view.cssW * dpr);
  canvas.height = Math.round(view.cssH * dpr);
  canvas.style.width = view.cssW + 'px';
  canvas.style.height = view.cssH + 'px';
  draw();
}
new ResizeObserver(resize).observe($('tableWrap'));
window.addEventListener('resize', resize);

setInterval(() => {
  const el = $('status');
  let txt;
  if (S.anim) txt = '击球中…';
  else if (S.message) txt = S.message;
  else if (inMatch() && S.game.over) txt = '本局结束';
  else txt = S.locked ? '瞄准已锁定：←/→ 微调角度，空格击球' : '移动鼠标瞄准，单击球台锁定方向';
  if (el.textContent !== txt) el.textContent = txt;
}, 120);

window.cuelab = { S, predict, startMatch, setMode, cpuTurn };

setTable(S.tableKey);
updateModeUI();
syncControls();
