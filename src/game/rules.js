// 对局规则：中式八球与斯诺克（核心规则，部分细则做了简化，见 README）。
//
// 用法：createGame() 建立对局状态；每杆结束后 evaluateShot(game, ballsBefore, simResult, table)
// 给出判定（犯规、得分、是否继续击球、哪些球复位、自由球区域），再用 applyOutcome() 更新对局状态。

import { snookerSpots } from '../layouts.js';

export const SNOOKER_ORDER = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];
export const GROUP_NAME = { solid: '全色', stripe: '花色' };
const COLOR_NAME = { red: '红球', yellow: '黄球', green: '绿球', brown: '咖啡球', blue: '蓝球', pink: '粉球', black: '黑球' };

const group8 = (b) => (b.num === 8 ? 'eight' : b.num < 8 ? 'solid' : 'stripe');
const isRed = (b) => b.sk === 'red';
const other = (p) => 1 - p;

export function createGame(kind, players) {
  const g = { kind, players, turn: 0, over: false, winner: -1, shotNo: 0, message: '', log: [] };
  if (kind === 'eight') {
    Object.assign(g, { groups: [null, null], breakShot: true, ballInHand: 'head' });
  } else {
    Object.assign(g, { scores: [0, 0], phase: 'red', brk: 0, best: [0, 0], ballInHand: 'D' });
  }
  return g;
}

/** 当前击球方的“目标球”（必须先碰到的球）下标 */
export function ballOn(g, balls) {
  const idx = balls.map((_, i) => i).filter((i) => i > 0 && balls[i].on !== false);
  if (g.kind === 'eight') {
    const grp = g.groups[g.turn];
    if (!grp) return idx.filter((i) => balls[i].num !== 8);
    const own = idx.filter((i) => group8(balls[i]) === grp);
    return own.length ? own : idx.filter((i) => balls[i].num === 8);
  }
  if (g.phase === 'red') return idx.filter((i) => isRed(balls[i]));
  if (g.phase === 'color') return idx.filter((i) => !isRed(balls[i]));
  const next = SNOOKER_ORDER.find((k) => idx.some((i) => balls[i].sk === k));
  return idx.filter((i) => balls[i].sk === next);
}

/** 当前要打的球的文字描述 */
export function onDescription(g, balls) {
  if (g.kind === 'eight') {
    const grp = g.groups[g.turn];
    if (!grp) return g.breakShot ? '开球' : '台面开放：任意非 8 号球';
    const on = ballOn(g, balls);
    return on.length === 1 && balls[on[0]].num === 8 ? '8 号球' : GROUP_NAME[grp];
  }
  if (g.phase === 'red') return '红球';
  if (g.phase === 'color') return '任意彩球';
  const on = ballOn(g, balls);
  return on.length ? COLOR_NAME[balls[on[0]].sk] : '—';
}

function pottedInOrder(res) {
  const seen = new Set();
  const out = [];
  for (const e of res.events) if (e.type === 'pocket' && e.i > 0 && !seen.has(e.i)) { seen.add(e.i); out.push(e.i); }
  return out;
}

export function evaluateShot(g, before, res, table) {
  return g.kind === 'eight' ? evalEight(g, before, res, table) : evalSnooker(g, before, res, table);
}

// ---------------- 中式八球 ----------------

function evalEight(g, before, res) {
  const fh = res.firstHit;
  const first = fh ? fh.obj : -1;
  const potted = pottedInOrder(res);
  const cueIn = !res.balls[0].on;
  const me = g.turn;
  const grp = g.groups[me];
  const on = ballOn(g, before);
  const reasons = [];
  const name = (i) => before[i].name;

  if (first < 0) reasons.push('母球没有碰到任何球');
  else if (!g.breakShot && !on.includes(first)) reasons.push(`先碰到的是${name(first)}，不是本方目标球`);
  if (cueIn) reasons.push('母球落袋');
  if (first >= 0 && !potted.length && !g.breakShot) {
    const rail = res.events.some((e) => e.t >= fh.t - 1e-9 && e.type === 'cushion');
    if (!rail) reasons.push('碰球后没有任何球碰库或进袋');
  }
  if (g.breakShot && !potted.length) {
    const railBalls = new Set(res.events.filter((e) => e.type === 'cushion' && e.i > 0).map((e) => e.i));
    if (railBalls.size < 4) reasons.push(`开球不合法：只有 ${railBalls.size} 颗球碰库（至少 4 颗）`);
  }
  const foul = reasons.length > 0;
  const eight = potted.find((i) => before[i].num === 8);
  const out = { foul, reasons, potted, respot: [], keepTurn: false, ballInHand: null, over: false, winner: -1, assign: null, msg: [] };

  if (eight !== undefined) {
    if (g.breakShot) {
      out.respot.push(eight);
      out.msg.push('开球打进 8 号球，8 号球复位');
    } else {
      const cleared = grp && !before.some((b, i) => i > 0 && group8(b) === grp);
      out.over = true;
      if (cleared && !foul) {
        out.winner = me;
        out.msg.push('合法打进 8 号球，获胜！');
      } else {
        out.winner = other(me);
        out.msg.push(cleared ? '打进 8 号球时犯规，判负' : '本方球未清完就打进了 8 号球，判负');
      }
      return out;
    }
  }

  const objPots = potted.filter((i) => before[i].num !== 8);
  if (foul) {
    out.ballInHand = 'anywhere';
    out.msg.push('犯规：' + reasons.join('；'), '对方获得自由球');
    return out;
  }
  let myGroup = grp;
  if (!grp && !g.breakShot && objPots.length) {
    myGroup = group8(before[objPots[0]]);
    out.assign = myGroup;
    out.msg.push(`确定球组：${GROUP_NAME[myGroup]}`);
  }
  if (g.breakShot) out.keepTurn = objPots.length > 0;
  else out.keepTurn = objPots.some((i) => group8(before[i]) === myGroup);
  if (objPots.length) out.msg.unshift('进球：' + objPots.map(name).join('、'));
  if (!out.keepTurn) out.msg.push(objPots.length ? '没有打进本方球，换人' : '没有进球，换人');
  return out;
}

// ---------------- 斯诺克 ----------------

function evalSnooker(g, before, res) {
  const fh = res.firstHit;
  const first = fh ? fh.obj : -1;
  const potted = pottedInOrder(res);
  const cueIn = !res.balls[0].on;
  const on = ballOn(g, before);
  const reasons = [];
  const pen = [4];
  const name = (i) => before[i].name;
  const val = (i) => before[i].value;

  // 彩球阶段：先碰到的彩球视为指定球（简化：不单独报球）
  const nominated = g.phase === 'color' && first > 0 && !isRed(before[first]) ? first : -1;
  if (g.phase === 'red') pen.push(1);
  if (g.phase === 'sequence' && on.length) pen.push(val(on[0]));
  if (nominated > 0) pen.push(val(nominated));

  if (first < 0) reasons.push('母球没有碰到任何球');
  else if (!on.includes(first)) { reasons.push(`先碰到的是${name(first)}，不是目标球`); pen.push(val(first)); }
  if (cueIn) reasons.push('母球落袋');

  const legal = [];
  for (const i of potted) {
    let ok;
    if (g.phase === 'red') ok = isRed(before[i]);
    else if (g.phase === 'color') ok = i === nominated && potted.filter((k) => !isRed(before[k])).length === 1;
    else ok = on.includes(i);
    if (ok) legal.push(i);
    else { reasons.push(`打进了${name(i)}`); pen.push(val(i)); }
  }
  const foul = reasons.length > 0;
  const redsBefore = before.filter((b, i) => i > 0 && isRed(b)).length;
  const redsPotted = potted.filter((i) => isRed(before[i])).length;
  const redsLeft = redsBefore - redsPotted;
  const out = { foul, reasons, potted, respot: [], keepTurn: false, ballInHand: cueIn ? 'D' : null, points: 0, penalty: 0, over: false, winner: -1, msg: [] };

  // 彩球复位：犯规时所有进袋彩球复位；合法时只有清彩阶段之前的彩球复位
  for (const i of potted) {
    if (isRed(before[i])) continue;
    if (foul || g.phase !== 'sequence') out.respot.push(i);
  }

  if (foul) {
    out.penalty = Math.max(...pen);
    out.msg.push(`犯规：${reasons.join('；')}，对方得 ${out.penalty} 分`);
    out.nextPhase = redsLeft > 0 ? 'red' : 'sequence';
    if (g.phase === 'sequence' && on.length && before[on[0]].sk === 'black' && potted.includes(on[0])) out.blackEnd = true;
  } else if (legal.length) {
    out.keepTurn = true;
    if (g.phase === 'red') { out.points = legal.length; out.nextPhase = 'color'; }
    else if (g.phase === 'color') { out.points = val(nominated); out.nextPhase = redsLeft > 0 ? 'red' : 'sequence'; }
    else { out.points = val(legal[0]); out.nextPhase = 'sequence'; if (before[legal[0]].sk === 'black') out.blackEnd = true; }
    out.msg.push(`进球：${legal.map(name).join('、')}，得 ${out.points} 分`);
  } else {
    out.nextPhase = redsLeft > 0 ? 'red' : 'sequence';
    out.msg.push('没有进球，换人');
  }
  return out;
}

export function applyOutcome(g, out) {
  g.shotNo++;
  const me = g.turn;
  if (g.kind === 'eight') {
    if (out.assign) { g.groups[me] = out.assign; g.groups[other(me)] = out.assign === 'solid' ? 'stripe' : 'solid'; }
    g.breakShot = false;
    if (out.over) { g.over = true; g.winner = out.winner; }
    else if (!out.keepTurn) g.turn = other(me);
    g.ballInHand = out.ballInHand;
  } else {
    if (out.foul) { g.scores[other(me)] += out.penalty; g.brk = 0; }
    else if (out.points) { g.scores[me] += out.points; g.brk += out.points; g.best[me] = Math.max(g.best[me], g.brk); }
    g.phase = out.nextPhase;
    if (!out.keepTurn) { g.turn = other(me); g.brk = 0; }
    g.ballInHand = out.ballInHand;
    if (out.blackEnd) {
      g.over = true;
      g.winner = g.scores[0] === g.scores[1] ? -1 : g.scores[0] > g.scores[1] ? 0 : 1;
    }
  }
  g.message = out.msg.join(' · ');
  g.log.push({ player: me, msg: g.message });
}

/** 台面剩余可得最高分（斯诺克） */
export function pointsRemaining(g, balls) {
  const reds = balls.filter((b, i) => i > 0 && isRed(b)).length;
  const colors = balls.filter((b, i) => i > 0 && !isRed(b)).reduce((s, b) => s + b.value, 0);
  return reds * 8 + colors + (g.phase === 'color' ? 7 : 0);
}

// ---------------- 复位与自由球 ----------------

function freeAt(balls, x, y, R, skip) {
  return balls.every((b) => b === skip || b.on === false || Math.hypot(b.x - x, b.y - y) > 2 * R + 0.0005);
}

/** 彩球复位：本位被占则放到最高分的空置球点，都被占则沿本位向顶库方向找最近的空位 */
export function respotColor(table, balls, b) {
  const s = snookerSpots(table);
  const R = table.R;
  if (freeAt(balls, ...s[b.sk], R, b)) return s[b.sk];
  for (const k of [...SNOOKER_ORDER].reverse()) if (freeAt(balls, ...s[k], R, b)) return s[k];
  let [x, y] = s[b.sk];
  for (let k = 0; k < 200; k++) {
    x += R * 0.25;
    if (x > table.L - R) x = s[b.sk][0] - (x - (table.L - R));
    if (freeAt(balls, x, y, R, b)) return [x, y];
  }
  return s[b.sk];
}

/** 中八：8 号球复位到置球点，被占则向底库方向找空位 */
export function respotEight(table, balls, b) {
  const R = table.R;
  let x = (3 * table.L) / 4, y = table.W / 2;
  for (let k = 0; k < 200 && !freeAt(balls, x, y, R, b); k++) x = Math.min(table.L - R, x + R * 0.25);
  return [x, y];
}

export function inRegion(region, table, x, y) {
  const R = table.R;
  if (x < R || x > table.L - R || y < R || y > table.W - R) return false;
  if (region === 'head') return x <= table.L / 4;
  if (region === 'D') {
    const s = snookerSpots(table);
    return x <= s.baulk && Math.hypot(x - s.baulk, y - table.W / 2) <= s.dR;
  }
  return true;
}

export function clampToRegion(region, table, x, y) {
  const R = table.R;
  x = Math.min(table.L - R, Math.max(R, x));
  y = Math.min(table.W - R, Math.max(R, y));
  if (region === 'head') x = Math.min(x, table.L / 4);
  if (region === 'D') {
    const s = snookerSpots(table);
    x = Math.min(x, s.baulk);
    const dx = x - s.baulk, dy = y - table.W / 2, d = Math.hypot(dx, dy);
    if (d > s.dR) { x = s.baulk + (dx / d) * s.dR; y = table.W / 2 + (dy / d) * s.dR; }
  }
  return [x, y];
}

export function defaultCueSpot(region, table, balls) {
  const R = table.R;
  let x, y;
  if (region === 'D') { const s = snookerSpots(table); x = s.baulk - 0.1; y = table.W / 2 + 0.12; }
  else if (region === 'head') { x = table.L / 4 - 0.05; y = table.W / 2; }
  else { x = table.L / 4; y = table.W / 2; }
  for (let k = 0; k < 60 && !freeAt(balls, x, y, R, balls[0]); k++) y += (k % 2 ? -1 : 1) * 2.2 * R * (k + 1);
  return clampToRegion(region, table, x, y);
}

/** 给电脑对手的规则上下文：目标球、不能打进的球、打进某球后下一杆的目标、对手的目标 */
export function aiContext(g, balls) {
  const targets = ballOn(g, balls);
  const idx = balls.map((_, i) => i).filter((i) => i > 0 && balls[i].on !== false);
  const values = balls.map((b) => b.value ?? 1);
  const next = {};
  let forbidden, oppTargets;
  if (g.kind === 'eight') {
    const grp = g.groups[g.turn];
    const e8 = idx.find((i) => balls[i].num === 8);
    const only8 = targets.length === 1 && targets[0] === e8;
    forbidden = only8 || e8 === undefined ? [] : [e8];
    const og = g.groups[other(g.turn)];
    oppTargets = og ? idx.filter((i) => group8(balls[i]) === og) : idx.filter((i) => balls[i].num !== 8);
    if (!oppTargets.length && e8 !== undefined) oppTargets = [e8];
    for (const t of targets) {
      if (only8) { next[t] = []; continue; }
      const g2 = grp ?? group8(balls[t]);
      const own = idx.filter((i) => i !== t && group8(balls[i]) === g2);
      next[t] = own.length ? own : e8 !== undefined ? [e8] : [];
    }
  } else {
    forbidden = idx.filter((i) => !targets.includes(i));
    const reds = idx.filter((i) => isRed(balls[i]));
    const colors = idx.filter((i) => !isRed(balls[i]));
    const lowest = (exclude) => {
      const k = SNOOKER_ORDER.find((c) => colors.some((i) => balls[i].sk === c && i !== exclude));
      return colors.filter((i) => balls[i].sk === k);
    };
    for (const t of targets) {
      if (g.phase === 'red') next[t] = colors;
      else if (g.phase === 'color') next[t] = reds.length ? reds : lowest(-1);
      else next[t] = lowest(t);
    }
    oppTargets = reds.length ? reds : lowest(-1);
  }
  return { targets, forbidden, oppTargets, values, next, region: g.ballInHand ?? null };
}
