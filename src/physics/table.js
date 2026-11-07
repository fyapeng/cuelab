// 由规格生成球台几何：库边线段（含袋角）与袋口。
// 坐标系：x 沿台面长度（0 = 左端/开球区一端），y 沿宽度（0 = 下边库），台面为 [0,L]×[0,W]。

const S2 = Math.SQRT1_2;

function seg(ax, ay, bx, by, kind) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  const ex = dx / len, ey = dy / len;
  return { ax, ay, bx, by, len, ex, ey, nx: -ey, ny: ex, kind };
}

export function buildTable(spec) {
  const { L, W, R, cornerMouth, sideMouth, jawDepth } = spec;
  const g = cornerMouth / Math.SQRT2; // 角袋袋角距台角的距离（沿库边）
  const s = sideMouth / 2;

  // 每个袋：袋口两端点 P1、P2，指向袋内（离开台面）的法向 n
  const defs = [
    { name: '左下角袋', P1: [g, 0], P2: [0, g], n: [-S2, -S2], corner: true },
    { name: '右下角袋', P1: [L - g, 0], P2: [L, g], n: [S2, -S2], corner: true },
    { name: '左上角袋', P1: [g, W], P2: [0, W - g], n: [-S2, S2], corner: true },
    { name: '右上角袋', P1: [L - g, W], P2: [L, W - g], n: [S2, S2], corner: true },
    { name: '下中袋', P1: [L / 2 - s, 0], P2: [L / 2 + s, 0], n: [0, -1], corner: false },
    { name: '上中袋', P1: [L / 2 - s, W], P2: [L / 2 + s, W], n: [0, 1], corner: false },
  ];

  const segments = [
    // 库边
    seg(g, 0, L / 2 - s, 0, 'rail'),
    seg(L / 2 + s, 0, L - g, 0, 'rail'),
    seg(g, W, L / 2 - s, W, 'rail'),
    seg(L / 2 + s, W, L - g, W, 'rail'),
    seg(0, g, 0, W - g, 'rail'),
    seg(L, g, L, W - g, 'rail'),
  ];

  const pockets = defs.map((d) => {
    const [x1, y1] = d.P1, [x2, y2] = d.P2;
    const [nx, ny] = d.n;
    const mw = Math.hypot(x2 - x1, y2 - y1);
    const tx = (x2 - x1) / mw, ty = (y2 - y1) / mw;
    const shrink = d.corner ? spec.cornerThroatShrink : spec.sideThroatShrink;
    // 袋角线段：从袋口端点伸向袋内，略向中线收拢
    const q1x = x1 + nx * jawDepth + tx * shrink, q1y = y1 + ny * jawDepth + ty * shrink;
    const q2x = x2 + nx * jawDepth - tx * shrink, q2y = y2 + ny * jawDepth - ty * shrink;
    segments.push(seg(x1, y1, q1x, q1y, 'jaw'));
    segments.push(seg(x2, y2, q2x, q2y, 'jaw'));
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return {
      name: d.name,
      corner: d.corner,
      mx, my, nx, ny, tx, ty,
      half: mw / 2,
      capDepth: 0.5 * R, // 球心越过袋口线这么深即判落袋
      // 绘图用
      drawX: mx + nx * R * 0.9,
      drawY: my + ny * R * 0.9,
      drawR: (mw / 2) * 1.02,
      jaw: [[x1, y1, q1x, q1y], [x2, y2, q2x, q2y]],
    };
  });

  const sinPhi = Math.max(0, Math.min(0.9, (spec.cushionHeight - R) / R));

  return { ...spec, segments, pockets, sinPhi };
}
