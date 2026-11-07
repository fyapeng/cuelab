// 出杆误差：给瞄准角、力度、击打点加入高斯扰动。

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function perturbShot(shot, noise, R, rng) {
  const tip = noise.tipMM / 1000 / R;
  let side = shot.side + gauss(rng) * tip;
  let height = shot.height + gauss(rng) * tip;
  const r = Math.hypot(side, height);
  if (r > 0.7) { side *= 0.7 / r; height *= 0.7 / r; }
  return {
    ...shot,
    aim: shot.aim + (gauss(rng) * noise.aimDeg * Math.PI) / 180,
    speed: Math.max(0.05, shot.speed * (1 + (gauss(rng) * noise.speedPct) / 100)),
    side,
    height,
  };
}
