// 摆球预设。所有坐标单位为米，台面坐标系见 physics/table.js。

const POOL_COLORS = {
  1: '#f2c200', 2: '#1d4ed8', 3: '#dc2626', 4: '#6d28d9', 5: '#ea580c',
  6: '#15803d', 7: '#7f1d1d', 8: '#141414', 9: '#f2c200',
  10: '#1d4ed8', 11: '#dc2626', 12: '#6d28d9', 13: '#ea580c', 14: '#15803d', 15: '#7f1d1d',
};
const SNOOKER = {
  red: { color: '#c81e1e', value: 1, name: '红球' },
  yellow: { color: '#f4c430', value: 2, name: '黄球' },
  green: { color: '#1f8a3a', value: 3, name: '绿球' },
  brown: { color: '#7a4a21', value: 4, name: '咖啡球' },
  blue: { color: '#1e4fd8', value: 5, name: '蓝球' },
  pink: { color: '#f08fb0', value: 6, name: '粉球' },
  black: { color: '#151515', value: 7, name: '黑球' },
};

export const cueBall = (x, y) => ({ id: 'cue', name: '母球', label: '', color: '#f6f4ea', kind: 'cue', x, y });
export const poolBall = (n, x, y) => ({
  id: 'p' + n, name: `${n} 号球`, label: String(n), color: POOL_COLORS[n] ?? '#888', stripe: n > 8, kind: 'obj', num: n, x, y,
});
let redSeq = 0;
export const snookerBall = (key, x, y) => {
  const s = SNOOKER[key];
  const id = key === 'red' ? 'r' + ++redSeq : key;
  return { id, name: s.name, label: '', color: s.color, kind: 'obj', value: s.value, sk: key, x, y };
};

export function snookerSpots(t) {
  const baulk = 0.737, dR = 0.292, cy = t.W / 2;
  return {
    baulk, dR,
    yellow: [baulk, cy - dR], green: [baulk, cy + dR], brown: [baulk, cy],
    blue: [t.L / 2, cy], pink: [(3 * t.L) / 4, cy], black: [t.L - 0.324, cy],
  };
}

function triangle(apexX, cy, rows, d, make) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const cnt = rows[r];
    for (let i = 0; i < cnt; i++) {
      out.push(make(r, i, apexX + r * d * Math.cos(Math.PI / 6), cy + (i - (cnt - 1) / 2) * d));
    }
  }
  return out;
}

export const LAYOUTS = {
  eight: {
    single: {
      name: '单球练习',
      make: () => [cueBall(1.0, 0.45), poolBall(3, 1.9, 0.86)],
    },
    position: {
      name: '走位练习（三颗球）',
      make: () => [cueBall(0.95, 0.55), poolBall(2, 1.55, 0.88), poolBall(5, 2.2, 0.35), poolBall(8, 0.6, 1.0)],
    },
    bank: {
      name: '翻袋练习',
      // 目标球在下中袋附近，母球在它上方：典型的翻下库进上中袋（对边翻中袋）
      make: () => [cueBall(1.36, 0.98), poolBall(6, 1.45, 0.42), poolBall(12, 2.15, 0.3), poolBall(1, 0.6, 0.85)],
    },
    kick: {
      name: '解球练习（一库解）',
      make: (t) => {
        // 母球与目标球之间的直线被两颗球挡住
        const c = [0.7, 0.5], o = [2.0, 0.85];
        const at = (f) => [c[0] + (o[0] - c[0]) * f, c[1] + (o[1] - c[1]) * f];
        return [cueBall(...c), poolBall(4, ...o), poolBall(8, ...at(0.42)), poolBall(13, ...at(0.7))];
      },
    },
    rack15: {
      name: '中八开球',
      make: (t) => {
        const d = 2 * t.R + 0.0002;
        // 第三排中间为 8 号球，底排两角一花一全
        const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
        let k = 0;
        const balls = triangle((3 * t.L) / 4, t.W / 2, [1, 2, 3, 4, 5], d, (r, i, x, y) => poolBall(order[k++], x, y));
        return [cueBall(t.L / 4 - 0.1, t.W / 2 + 0.12), ...balls];
      },
    },
  },
  pool: {
    single: {
      name: '单球练习',
      make: (t) => [cueBall(1.05, 0.42), poolBall(1, 1.95, 0.93)],
    },
    position: {
      name: '走位练习（三颗球）',
      make: (t) => [cueBall(0.95, 0.55), poolBall(1, 1.55, 0.88), poolBall(2, 2.2, 0.35), poolBall(3, 0.6, 1.0)],
    },
    rack9: {
      name: '九球开球',
      make: (t) => {
        const d = 2 * t.R + 0.0002;
        const order = [1, 2, 3, 4, 9, 5, 6, 7, 8];
        let k = 0;
        const balls = triangle((3 * t.L) / 4, t.W / 2, [1, 2, 3, 2, 1], d, (r, i, x, y) => poolBall(order[k++], x, y));
        return [cueBall(t.L / 4, t.W / 2 - 0.08), ...balls];
      },
    },
    scatter: {
      name: '散布九球',
      make: () => [
        cueBall(0.7, 0.62),
        poolBall(1, 1.3, 0.45), poolBall(2, 1.85, 1.02), poolBall(3, 2.25, 0.62),
        poolBall(4, 0.45, 1.05), poolBall(5, 1.15, 0.95), poolBall(6, 2.05, 0.2),
        poolBall(7, 0.35, 0.25), poolBall(8, 1.6, 0.68), poolBall(9, 2.35, 1.12),
      ],
    },
  },
  snooker: {
    single: {
      name: '单球练习',
      make: (t) => {
        redSeq = 0;
        const s = snookerSpots(t);
        return [cueBall(1.6, 0.62), snookerBall('red', 2.7, 1.32), snookerBall('black', ...s.black), snookerBall('pink', ...s.pink)];
      },
    },
    colors: {
      name: '清彩球',
      make: (t) => {
        redSeq = 0;
        const s = snookerSpots(t);
        return [
          cueBall(0.95, 0.62),
          ...['yellow', 'green', 'brown', 'blue', 'pink', 'black'].map((k) => snookerBall(k, ...s[k])),
        ];
      },
    },
    bank: {
      name: '翻袋练习',
      make: (t) => {
        redSeq = 0;
        const s = snookerSpots(t);
        return [cueBall(1.95, 1.3), snookerBall('red', 2.05, 0.55), snookerBall('red', 2.7, 0.2), snookerBall('black', ...s.black), snookerBall('blue', ...s.blue)];
      },
    },
    kick: {
      name: '解斯诺克（一库解）',
      make: (t) => {
        redSeq = 0;
        const s = snookerSpots(t);
        // 母球藏在咖啡球后面，要打的红球在台面另一端
        return [
          cueBall(s.brown[0] - 0.11, s.brown[1] + 0.012),
          snookerBall('red', 2.6, 0.95),
          snookerBall('brown', ...s.brown),
          snookerBall('yellow', ...s.yellow),
          snookerBall('green', ...s.green),
          snookerBall('blue', ...s.blue),
          snookerBall('pink', ...s.pink),
          snookerBall('black', ...s.black),
        ];
      },
    },
    full: {
      name: '开局',
      make: (t) => {
        redSeq = 0;
        const s = snookerSpots(t);
        const d = 2 * t.R + 0.0002;
        const reds = triangle(s.pink[0] + 2 * t.R + 0.002, t.W / 2, [1, 2, 3, 4, 5], d, (r, i, x, y) => snookerBall('red', x, y));
        return [
          cueBall(s.baulk - 0.12, t.W / 2 + 0.16),
          ...['yellow', 'green', 'brown', 'blue', 'pink', 'black'].map((k) => snookerBall(k, ...s[k])),
          ...reds,
        ];
      },
    },
  },
};

/** 新增一个目标球（双击空白处） */
export function newObjectBall(tableKey, balls, x, y) {
  if (tableKey !== 'snooker') {
    const used = new Set(balls.filter((b) => b.num).map((b) => b.num));
    let n = 1;
    while (used.has(n) && n < 15) n++;
    return poolBall(n, x, y);
  }
  const used = new Set(balls.map((b) => b.id));
  let k = 1;
  while (used.has('r' + k)) k++;
  const b = snookerBall('red', x, y);
  b.id = 'r' + k;
  return b;
}

/** 母球落袋后的放球点 */
export function respotCue(tableKey, t, balls) {
  let x, y;
  if (tableKey !== 'snooker') { x = t.L / 4; y = t.W / 2; }
  else { const s = snookerSpots(t); x = s.baulk - 0.12; y = t.W / 2 + 0.12; }
  for (let k = 0; k < 40; k++) {
    if (balls.every((b) => !b.on || b.kind === 'cue' || Math.hypot(b.x - x, b.y - y) > 2.05 * t.R)) break;
    y += (k % 2 ? -1 : 1) * 2.2 * t.R * (k + 1);
    y = Math.min(t.W - t.R, Math.max(t.R, y));
  }
  return [x, y];
}
