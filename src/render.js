// Canvas 绘图：球台、轨迹、落点、假想球、容错散布、球与球杆。
import { MODE } from './physics/sim.js';
import { snookerSpots } from './layouts.js';

export const MODE_COLOR = {
  [MODE.SLIDING]: '#ff9f43',
  [MODE.ROLLING]: '#4cc9f0',
  [MODE.SPINNING]: '#c084fc',
  [MODE.STATIONARY]: '#4cc9f0',
};

const CLOTH = {
  pool: ['#1d7fae', '#155f86'],
  snooker: ['#1f8a4c', '#16683a'],
  eight: ['#1f7f72', '#165f55'],
};

export function makeView(table, cssW) {
  const rail = table.railWidth;
  const totalW = table.L + 2 * rail, totalH = table.W + 2 * rail;
  const scale = cssW / totalW;
  return {
    scale, rail, cssW, cssH: totalH * scale, aspect: totalH / totalW,
    X: (x) => (x + rail) * scale,
    Y: (y) => (table.W - y + rail) * scale,
    toTable: (px, py) => [px / scale - rail, table.W - (py / scale - rail)],
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawTable(ctx, v, t) {
  const s = v.scale;
  // 木边
  const wood = ctx.createLinearGradient(0, 0, 0, v.cssH);
  wood.addColorStop(0, '#6b3d1c');
  wood.addColorStop(0.5, '#4a2812');
  wood.addColorStop(1, '#3a1f0d');
  ctx.fillStyle = wood;
  roundRect(ctx, 0, 0, v.cssW, v.cssH, v.rail * s * 0.45);
  ctx.fill();
  // 库边橡胶（深绿）
  const cw = 0.045;
  ctx.fillStyle = '#145a32';
  ctx.fillRect(v.X(-cw), v.Y(t.W + cw), (t.L + 2 * cw) * s, (t.W + 2 * cw) * s);
  // 台呢
  const cloth = ctx.createRadialGradient(v.X(t.L / 2), v.Y(t.W / 2), 10, v.X(t.L / 2), v.Y(t.W / 2), t.L * s * 0.7);
  const cc = CLOTH[t.key] ?? CLOTH.pool;
  cloth.addColorStop(0, cc[0]);
  cloth.addColorStop(1, cc[1]);
  ctx.fillStyle = cloth;
  ctx.fillRect(v.X(0), v.Y(t.W), t.L * s, t.W * s);
  // 袋口
  for (const p of t.pockets) {
    // 袋口区域内的台呢延伸到袋角
    ctx.fillStyle = cc[1];
    ctx.beginPath();
    const [a, b] = p.jaw;
    ctx.moveTo(v.X(a[0]), v.Y(a[1]));
    ctx.lineTo(v.X(a[2]), v.Y(a[3]));
    ctx.lineTo(v.X(b[2]), v.Y(b[3]));
    ctx.lineTo(v.X(b[0]), v.Y(b[1]));
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#050505';
    ctx.beginPath();
    ctx.arc(v.X(p.drawX), v.Y(p.drawY), p.drawR * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // 库边线与袋角
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  for (const sg of t.segments) {
    ctx.beginPath();
    ctx.moveTo(v.X(sg.ax), v.Y(sg.ay));
    ctx.lineTo(v.X(sg.bx), v.Y(sg.by));
    ctx.stroke();
  }
  // 标记
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  if (t.key !== 'snooker') {
    // 库边菱形点
    const off = v.rail * 0.55;
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const x = (t.L * i) / 8;
      dot(ctx, v.X(x), v.Y(t.W + off), 2.5);
      dot(ctx, v.X(x), v.Y(-off), 2.5);
    }
    for (let i = 1; i < 4; i++) {
      const y = (t.W * i) / 4;
      dot(ctx, v.X(-off), v.Y(y), 2.5);
      dot(ctx, v.X(t.L + off), v.Y(y), 2.5);
    }
    dot(ctx, v.X((3 * t.L) / 4), v.Y(t.W / 2), 2); // 脚点
    dot(ctx, v.X(t.L / 4), v.Y(t.W / 2), 2); // 头点
  } else {
    const sp = snookerSpots(t);
    ctx.beginPath();
    ctx.moveTo(v.X(sp.baulk), v.Y(0));
    ctx.lineTo(v.X(sp.baulk), v.Y(t.W));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(v.X(sp.baulk), v.Y(t.W / 2), sp.dR * s, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.stroke();
    for (const k of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) dot(ctx, v.X(sp[k][0]), v.Y(sp[k][1]), 1.8);
  }
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function drawBall(ctx, v, t, b, x, y, alpha = 1) {
  const r = t.R * v.scale;
  const px = v.X(x), py = v.Y(y);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(px + r * 0.18, py + r * 0.22, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  if (b.stripe) {
    ctx.fillStyle = '#f6f4ea';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = b.color;
    ctx.fillRect(px - r, py - r * 0.55, 2 * r, r * 1.1);
    ctx.restore();
  } else {
    ctx.fillStyle = b.color;
    ctx.fill();
  }
  const g = ctx.createRadialGradient(px - r * 0.38, py - r * 0.42, r * 0.08, px, py, r * 1.05);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  if (b.label && r > 6) {
    ctx.fillStyle = '#fbfaf3';
    ctx.beginPath();
    ctx.arc(px, py, r * 0.48, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = `bold ${Math.round(r * 0.62)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, px, py + r * 0.03);
  }
  ctx.restore();
}

/** 画一条轨迹；colorByMode 时按滑动/滚动着色；upto 为动画中的当前时刻 */
export function drawTrack(ctx, v, tr, { color, width = 2, colorByMode = false, alpha = 1, upto = Infinity, dash = null }) {
  const n = tr.t.length;
  if (n < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  let cur = null;
  ctx.beginPath();
  for (let k = 0; k < n - 1; k++) {
    if (tr.t[k] > upto) break;
    const c = colorByMode ? MODE_COLOR[tr.m[k]] : color;
    if (c !== cur) {
      if (cur !== null) ctx.stroke();
      ctx.strokeStyle = c;
      cur = c;
      ctx.beginPath();
      ctx.moveTo(v.X(tr.x[k]), v.Y(tr.y[k]));
    }
    let x1 = tr.x[k + 1], y1 = tr.y[k + 1];
    if (tr.t[k + 1] > upto) {
      const f = (upto - tr.t[k]) / (tr.t[k + 1] - tr.t[k]);
      x1 = tr.x[k] + (x1 - tr.x[k]) * f;
      y1 = tr.y[k] + (y1 - tr.y[k]) * f;
    }
    ctx.lineTo(v.X(x1), v.Y(y1));
  }
  ctx.stroke();
  ctx.restore();
}

export function ghostCircle(ctx, v, t, x, y, color, { width = 1.5, dash = [4, 3], cross = false, fill = null } = {}) {
  const r = t.R * v.scale;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(v.X(x), v.Y(y), r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.stroke();
  if (cross) {
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(v.X(x) - r * 0.45, v.Y(y));
    ctx.lineTo(v.X(x) + r * 0.45, v.Y(y));
    ctx.moveTo(v.X(x), v.Y(y) - r * 0.45);
    ctx.lineTo(v.X(x), v.Y(y) + r * 0.45);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawLabel(ctx, v, x, y, text, color = '#fff') {
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const px = v.X(x), py = v.Y(y);
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, px - 3, py - 9, w + 6, 18, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, px, py);
  ctx.restore();
}

export function drawCue(ctx, v, t, cue, aim, side, speed) {
  const R = t.R;
  const fx = Math.cos(aim), fy = Math.sin(aim);
  const rx = Math.sin(aim), ry = -Math.cos(aim); // 瞄准方向右侧
  const gap = R + 0.012 + 0.012 * speed;
  const tx = cue.x - fx * gap + rx * side * R;
  const ty = cue.y - fy * gap + ry * side * R;
  const len = 1.45;
  const pts = (d, w) => {
    const cx = tx - fx * d, cy = ty - fy * d;
    return [[cx + rx * w, cy + ry * w], [cx - rx * w, cy - ry * w]];
  };
  const poly = (d0, w0, d1, w1, color) => {
    const [a, b] = pts(d0, w0), [c, d] = pts(d1, w1);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(v.X(a[0]), v.Y(a[1]));
    ctx.lineTo(v.X(c[0]), v.Y(c[1]));
    ctx.lineTo(v.X(d[0]), v.Y(d[1]));
    ctx.lineTo(v.X(b[0]), v.Y(b[1]));
    ctx.closePath();
    ctx.fill();
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  poly(0, 0.0065, 0.008, 0.0065, '#3b82f6'); // 杆头（巧粉）
  poly(0.008, 0.0066, 0.03, 0.0068, '#f5f5f0'); // 先角
  poly(0.03, 0.0068, 0.75, 0.0105, '#e9d3a3'); // 前节
  poly(0.75, 0.0105, 0.8, 0.0108, '#1f1f1f');
  poly(0.8, 0.0108, len, 0.0145, '#3a2314'); // 后把
  ctx.restore();
}
