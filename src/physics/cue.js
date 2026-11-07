// 出杆模型：球杆以速度 V 撞击母球上偏离球心的一点，给出母球初速度与角速度。
//
// 局部坐标：x' 沿瞄准方向，y' 指向左侧，z 竖直向上。
// 击打点（以球半径 R 为单位）：side = 右塞为正，height = 高杆为正；杆仰角 elev。
// 冲量 J 沿球杆方向 n = (cosθ, 0, -sinθ)，作用点 p = (-c, -A, B)，c = √(R²-A²-B²)。
// 有效质量：1/m_eff = 1/M + 1/m + |p×n|²/I，冲量大小 F = (1+e_tip)·V / (1/M + 1/m + |p×n|²/I)。
// 母球 v = F·n/m（竖直分量被台面吸收），ω = F·(p×n)/I。
// 偏杆（squirt）：加左右塞时母球出射方向偏离球杆方向，采用 Alciatore 的端质量模型：
//   α = atan[ (5/2)x√(1-x²) / (1 + m/m_e + (5/2)(1-x²)) ]，x = 侧向偏移/R。

export const MISCUE_LIMIT = 0.5; // 击打点偏离球心超过 0.5R 易滑杆

export function strike(ball, table, P, shot) {
  const { R, m } = table;
  const M = P.cueMass;
  const A = shot.side * R; // 右塞为正
  const B = shot.height * R; // 高杆为正
  const th = (shot.elev * Math.PI) / 180;
  const c = Math.sqrt(Math.max(0, R * R - A * A - B * B));
  const st = Math.sin(th), ct = Math.cos(th);
  // p × n
  const qx = A * st, qy = B * ct - c * st, qz = A * ct;
  const I = 0.4 * m * R * R;
  const F = ((1 + P.tipE) * shot.speed) / (1 / M + 1 / m + (qx * qx + qy * qy + qz * qz) / I);
  const vf = (F * ct) / m; // 水平速度

  let alpha = 0;
  if (P.squirt && A !== 0) {
    const x = Math.min(0.99, Math.abs(shot.side));
    alpha = Math.atan(
      (2.5 * x * Math.sqrt(1 - x * x)) / (1 + m / P.endMass + 2.5 * (1 - x * x))
    );
    alpha *= shot.side > 0 ? 1 : -1; // 右塞 → 母球向左偏
  }

  const phi = shot.aim;
  const dir = phi + alpha;
  const fx = Math.cos(phi), fy = Math.sin(phi);
  const lx = -fy, ly = fx;
  const wxl = (F * qx) / I, wyl = (F * qy) / I, wzl = (F * qz) / I;

  const out = { ...ball };
  out.vx = vf * Math.cos(dir);
  out.vy = vf * Math.sin(dir);
  out.wx = wxl * fx + wyl * lx;
  out.wy = wxl * fy + wyl * ly;
  out.wz = wzl;
  return {
    ball: out,
    info: {
      ballSpeed: vf,
      squirtDeg: (alpha * 180) / Math.PI,
      // 上旋/下旋相对自然滚动的比值：+1 为自然滚动，负为下旋
      spinRatio: vf > 1e-6 ? (wyl * R) / vf : 0,
      sideRpm: (wzl * 60) / (2 * Math.PI),
      miscue: Math.hypot(shot.side, shot.height) > MISCUE_LIMIT,
      impulse: F,
    },
  };
}
