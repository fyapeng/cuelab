// 球台与物理参数预设。单位：米、千克、秒、弧度。

export const G = 9.81;

/** 球台几何与球的规格 */
export const TABLES = {
  // 中式八球：台面与美式 9 尺台相同、用同样大小的球，但袋口窄得多，袋角为圆弧形（这里用直线袋角近似）。
  // 袋口尺寸取常见比赛台的近似值，不同品牌、型号会有出入，可按实际球台修改。
  eight: {
    key: 'eight',
    name: '中式八球台',
    L: 2.54,
    W: 1.27,
    R: 0.028575,
    m: 0.17,
    cornerMouth: 0.086,
    sideMouth: 0.096,
    cornerThroatShrink: 0.002,
    sideThroatShrink: 0.0,
    jawDepth: 0.034,
    cushionHeight: 0.0363,
    railWidth: 0.11,
  },
  pool: {
    key: 'pool',
    name: '美式九球台（9 尺）',
    L: 2.54, // 台面长度（库边鼻线之间）
    W: 1.27, // 台面宽度
    R: 0.028575, // 球半径（直径 57.15 mm）
    m: 0.17, // 球质量
    cornerMouth: 0.117, // 角袋口宽（两袋角之间）
    sideMouth: 0.133, // 中袋口宽
    cornerThroatShrink: 0.006, // 角袋袋喉相对袋口每侧收窄量
    sideThroatShrink: 0.0,
    jawDepth: 0.036, // 袋角（jaw）深度
    cushionHeight: 0.0363, // 库边鼻线离台面高度（约 0.635 倍球径）
    railWidth: 0.11, // 绘图用：木边宽度
  },
  snooker: {
    key: 'snooker',
    name: '斯诺克台（12 尺）',
    L: 3.569,
    W: 1.778,
    R: 0.02625, // 直径 52.5 mm
    m: 0.1415,
    cornerMouth: 0.086,
    sideMouth: 0.104,
    cornerThroatShrink: 0.004,
    sideThroatShrink: 0.0,
    jawDepth: 0.032,
    cushionHeight: 0.0333,
    railWidth: 0.12,
  },
};

/** 物理参数默认值（可在界面里调整） */
export const DEFAULT_PHYS = {
  eight: {
    mu_s: 0.2,
    mu_r: 0.008, // 中八台呢比美式台快
    mu_sp: 0.02,
    e_ball: 0.95,
    e_cushion: 0.85,
    mu_cushion: 0.14,
    throw: true,
    squirt: true,
    cueMass: 0.54,
    tipE: 0.75,
    endMass: 0.008,
  },
  pool: {
    mu_s: 0.2, // 球-台呢滑动摩擦系数
    mu_r: 0.01, // 滚动阻力系数
    mu_sp: 0.02, // 旋转（竖直轴）衰减系数
    e_ball: 0.95, // 球-球恢复系数
    e_cushion: 0.85, // 球-库恢复系数
    mu_cushion: 0.14, // 球-库摩擦系数（Mathavan 等 2010 实测约 0.14）
    throw: true, // 是否计入球间摩擦（投掷效应）
    squirt: true, // 是否计入偏杆（squirt）
    cueMass: 0.54, // 球杆质量
    tipE: 0.75, // 杆头-母球恢复系数
    endMass: 0.008, // 杆头有效端质量（决定偏杆大小）
  },
  snooker: {
    mu_s: 0.2,
    mu_r: 0.007,
    mu_sp: 0.02,
    e_ball: 0.95,
    e_cushion: 0.82,
    mu_cushion: 0.14,
    throw: true,
    squirt: true,
    cueMass: 0.5,
    tipE: 0.75,
    endMass: 0.007,
  },
};

/**
 * 出杆稳定性（每杆误差的标准差），用于容错分析、出杆误差模拟和电脑对手。
 *
 * 切角误差 ≈ (母球到目标球距离 / 球径) × 出杆方向误差，斯诺克 2 m 长台约放大 40 倍；
 * 击打点横向偏 0.1 mm 又会带来约 0.02° 的偏杆。所以真正的职业水准对应百分之一度量级的方向误差。
 * 各档按下面几种标准球的进袋率标定（tests/calibrate.mjs，各 400 次）：
 *
 *              中八中距离30°  中八长台直球  斯诺克中距离25°  斯诺克长台
 *   顶级职业        100%          90%           100%           73%
 *   职业            100%          80%           100%           53%
 *   业余高手         97%          50%            75%           27%
 *   业余             70%          25%            42%           15%
 *   新手             33%          13%            19%            8%
 *
 * 这些是示意性设定：数值让各档的进袋率接近常见印象，不是对真人的测量。
 */
export const NOISE_LEVELS = {
  elite: { name: '顶级职业', aimDeg: 0.008, tipMM: 0.08, speedPct: 1.5 },
  pro: { name: '职业', aimDeg: 0.012, tipMM: 0.12, speedPct: 2 },
  club: { name: '业余高手', aimDeg: 0.025, tipMM: 0.25, speedPct: 3 },
  amateur: { name: '业余', aimDeg: 0.05, tipMM: 0.5, speedPct: 5 },
  beginner: { name: '新手', aimDeg: 0.12, tipMM: 1.2, speedPct: 10 },
};
export const LEVEL_ORDER = ['elite', 'pro', 'club', 'amateur', 'beginner'];
