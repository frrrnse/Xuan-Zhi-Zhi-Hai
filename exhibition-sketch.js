const SUPABASE_URL = 'https://hpacebvclxznmpohxbtf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_b71hGnmuYtG9urxNGTsyFQ_XguBL8Ui';

const PHASE = {
  WAITING: 'waiting',
  UPLOADING: 'uploading',
  GATHERING: 'gathering',
  CONVERGING: 'converging',
  DISPLAYED: 'displayed',
  SCATTERING: 'scattering',
};

const C = {
  totalParticles: 15000,
  targetFreeCount: 4000,
  maxDisplay: 5,
  maxStoredPhotos: 220,
  flowSpeed: 0.00012,
  flowScale: 0.003,
  detailScale: 0.008,
  detailStrength: 0.6,
  baseSpeed: 2.0,
  trailBg: 20,
  /* ★ gatherMs 是曲线飞行总时长，所有粒子匀速在此时长内飞到目标 */
  gatherMs: 4000,
  convergeMs: 1000,           /* ★ 缩短为 1s，粒子已到位只需过渡 */
  displayMs: 14000,
  scatterMs: 5000,
  uploadMs: 5000,
  checkMinMs: 800,
  checkMaxMs: 1500,
  entryRatio: 0.60,
  convergeSnapDist: 8,
  selectionMargin: 150,
  collisionRadius: 7,
  collisionIterations: 1,
  gridCellSize: 24,
  vanishBuffer: 80,
  starWeight: 1.8,
  congestionCellSize: 30,
  congestionThreshold: 15,
  congestionRemoveRatio: 0.3,
  congestionCheckInterval: 30,
  photoParticleTargets: [2000, 1600, 1300, 1150, 1000],
  scatterGridLarge: 6,
  scatterGridMedium: 5,
  scatterGridSmall: 4,
  largePhotoThreshold: 450,
  mediumPhotoThreshold: 250,
  drainFreeTarget: 2500,
  drainFadeChance: 0.012,
  scatterLeadTime: 3000,
  scatterInterval: 3000,
  batchCooldown: 7000,
  drainRecoveryDelay: 2000,
  /* ★ 降粒时自由粒子数不低于此值 */
  drainMinFree: 2000,
};

let pts = [];
let displays = [];
let waitPool = [];
let nextPoolCheck = 0;
let flowField = [];
let detailFlowField = [];
let cols, rows, flowZ = 0;
let ripples = [];
let lastKnownCount = 0;
let bsVisible = false;
let bsPanel = null;
let displayCounts = {};
let frameCount = 0;
let sin1, sin2, sin3;

let currentBatchSize = 0;
const batchSequence = [3, 1, 4, 1, 5, 2, 2, 5, 3, 5, 2, 4, 3, 1, 2, 1, 4, 2, 4, 3, 2, 5, 1, 4, 2, 2];
let batchSequenceIndex = 0;

let drainActive = false;
let drainEndTime = 0;
let scatterCooldownUntil = 0;
let batchCooldownUntil = 0;
let batchInProgress = false;
let batchStartTime = 0;
let photosStartedThisBatch = 0;
let batchEndTriggered = false;

function tinyVel() {
  return createVector(random(-0.3, 0.3), random(-0.3, 0.3));
}

function getBatchDuration(count) {
  const durations = {1: 28, 2: 30, 3: 35, 4: 40, 5: 45};
  return (durations[count] || 30) * 1000;
}

function isAnyPhotoScattering() {
  for (let d of displays) {
    if (d.phase === PHASE.SCATTERING) return true;
  }
  return false;
}

function hasAnyActivePhoto() {
  for (let d of displays) {
    if (d.phase !== PHASE.WAITING && d.phase !== PHASE.UPLOADING) return true;
  }
  return false;
}

function getFreeCount() {
  let cnt = 0;
  for (let p of pts) { if (!p.claimedBy && !p.hidden) cnt++; }
  return cnt;
}

function getVisibleCount() {
  let cnt = 0;
  for (let p of pts) { if (!p.hidden) cnt++; }
  return cnt;
}

function getScatterGridSize(w, h) {
  let minDim = min(w, h);
  if (minDim >= C.largePhotoThreshold) return C.scatterGridLarge;
  if (minDim >= C.mediumPhotoThreshold) return C.scatterGridMedium;
  return C.scatterGridSmall;
}

function setup() {
  let cv = createCanvas(windowWidth, windowHeight);
  cv.parent('exhibitionCanvas');
  pixelDensity(1);
  colorMode(RGB);
  noiseDetail(4, 0.5);

  cols = floor(width / 6);
  rows = floor(height / 6);
  flowField = new Array(cols * rows);
  detailFlowField = new Array(cols * rows);

  initParticles();
  buildPanel();

  loadAll();
  setInterval(checkNewPhoto, 3000);
  frameRate(30);
}

function draw() {
  frameCount++;

  let t = millis();
  sin1 = sin(t * 0.00005);
  sin2 = sin(t * 0.00004);
  sin3 = sin(t * 0.00006);

  flowZ = millis() * C.flowSpeed;
  updateFlowField();

  background(0, 0, 0, C.trailBg);

  updateFreeParticles();

  /* ★ 移除旧的 claimNearbyParticles 调用 — 粒子从屏幕边缘生成，不再吸引 */

  if (frameCount % C.congestionCheckInterval === 0) {
    eliminateCongestion();
  }

  maintainFreeCount();

  for (let i = displays.length - 1; i >= 0; i--) {
    let d = displays[i];
    d.update();
    if (d.phase === PHASE.SCATTERING && millis() - d.stateStart >= C.scatterMs) {
      d.releaseParticles();
      displays.splice(i, 1);
      scatterCooldownUntil = millis() + C.scatterInterval;
    }
  }

  for (let iter = 0; iter < C.collisionIterations; iter++) {
    resolveCollisions();
  }

  drawParticles();

  for (let d of displays) {
    if (d.phase === PHASE.UPLOADING || d.phase === PHASE.CONVERGING ||
        d.phase === PHASE.DISPLAYED ||
        (d.phase === PHASE.SCATTERING && millis() - d.stateStart < C.scatterMs)) {
      d.drawPhotoOverlay();
    }
  }

  if (batchInProgress && !batchEndTriggered) {
    let batchDurationMs = getBatchDuration(currentBatchSize);
    if (millis() - batchStartTime >= batchDurationMs) {
      batchEndTriggered = true;
      drainActive = false;
      drainEndTime = millis();
      for (let d of displays) {
        if (d.phase === PHASE.GATHERING || d.phase === PHASE.CONVERGING || d.phase === PHASE.DISPLAYED) {
          for (let idx of d.assignedPts) {
            let p = pts[idx];
            if (p.hasTarget) {
              p.hidden = true;
              p.claimedBy = null;
            }
          }
          d.phase = PHASE.SCATTERING;
          d.stateStart = millis();
          d.scatterProgress = 0;
          d.prepareScatterPixels();
          ripples.push(new Ripple(d.x, d.y, 1.5));
        }
      }
    }
  }

  if (batchEndTriggered && displays.length === 0) {
    batchEndTriggered = false;
    batchInProgress = false;
    batchCooldownUntil = millis() + 2000;
  }

  if (!batchInProgress && millis() >= batchCooldownUntil) {
    if (waitPool.length > 0) {
      currentBatchSize = batchSequence[batchSequenceIndex % batchSequence.length];
      batchSequenceIndex++;
      batchInProgress = true;
      batchStartTime = millis();
      photosStartedThisBatch = 0;
      nextPoolCheck = millis() + 200;
    }
  }

  ensurePhotoContinuity();
  startPendingUploads();

  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].update(); ripples[i].draw();
    if (ripples[i].done) ripples.splice(i, 1);
  }

  if (bsVisible && bsPanel && bsPanel.style('display') !== 'none') {
    updList();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  cols = floor(width / 6);
  rows = floor(height / 6);
  flowField = new Array(cols * rows);
  detailFlowField = new Array(cols * rows);
}

function initParticles() {
  pts = [];
  for (let i = 0; i < C.totalParticles; i++) {
    let isActive = i < C.targetFreeCount;
    pts.push({
      pos: createVector(random(width), random(height)),
      vel: createVector(random(-0.5, 0.5), random(-0.5, 0.5)),
      acc: createVector(0, 0),
      size: random(1.0, 2.2),
      alpha: random(160, 240),
      isRed: random() < 0.5,
      claimedBy: null,
      targetX: 0, targetY: 0,
      targetR: 255, targetG: 255, targetB: 255,
      targetA: 0,
      hasTarget: false,
      hidden: !isActive,
      /* ★ 贝塞尔曲线路径参数 */
      startX: 0, startY: 0,
      ctrlX: 0, ctrlY: 0,
      endX: 0, endY: 0,
      curveT: 0,
      curveSpeed: 0,
    });
  }
}

function eliminateCongestion() {
  const CS = C.congestionCellSize;
  let gCols = ceil(width / CS) + 1;
  let gRows = ceil(height / CS) + 1;

  let grid = new Array(gCols * gRows);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  for (let i = 0; i < pts.length; i++) {
    let p = pts[i];
    if (p.hidden || p.claimedBy) continue;
    let cx = floor(constrain(p.pos.x / CS, 0, gCols - 1));
    let cy = floor(constrain(p.pos.y / CS, 0, gRows - 1));
    grid[cx + cy * gCols].push(i);
  }

  for (let cellIdx = 0; cellIdx < grid.length; cellIdx++) {
    let cell = grid[cellIdx];
    if (cell.length > C.congestionThreshold) {
      let removeCount = floor(cell.length * C.congestionRemoveRatio);
      shuffle(cell);
      for (let j = 0; j < removeCount && j < cell.length; j++) {
        let idx = cell[j];
        let p = pts[idx];
        if (!p.claimedBy && !p.hidden) {
          p.hidden = true;
        }
      }
    }
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    let j = floor(random(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function maintainFreeCount() {
  if (isAnyPhotoScattering()) return;
  let freeCount = 0;
  for (let p of pts) {
    if (!p.claimedBy && !p.hidden) freeCount++;
  }

  if (drainActive) return;
  if (millis() - drainEndTime < C.drainRecoveryDelay) return;
  if (freeCount < C.targetFreeCount - 150) {
    let deficit = C.targetFreeCount - freeCount;
    let candidates = [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].hidden && !pts[i].claimedBy) {
        candidates.push(i);
      }
    }
    let toActivate = min(deficit, candidates.length);
    for (let i = 0; i < toActivate; i++) {
      let idx = candidates[i];
      let p = pts[idx];
      p.hidden = false;
      let edge = floor(random(4));
      if (edge === 0) p.pos.set(random(width), -20);
      else if (edge === 1) p.pos.set(random(width), height + 20);
      else if (edge === 2) p.pos.set(-20, random(height));
      else p.pos.set(width + 20, random(height));
      p.vel.set(random(-0.5, 0.5), random(-0.5, 0.5));
    }
  }
}

function ensurePhotoContinuity() {
  if (!batchInProgress) return;
  if (photosStartedThisBatch >= currentBatchSize) return;
  if (waitPool.length === 0) return;
  if (displays.length >= C.maxDisplay) return;

  let idx = pickWeightedFromPool();
  if (idx < 0) return;
  let data = waitPool[idx];
  let d = new DisplayPhoto(data, 'random');
  displays.push(d);
  let started = d.startGathering();
  if (started) {
    waitPool.splice(idx, 1);
    maintainFreeCount();
    ripples.push(new Ripple(d.x, d.y, 1.0));
    photosStartedThisBatch++;
  } else {
    displays.pop();
  }
}

function pickWeightedFromPool() {
  if (waitPool.length === 0) return -1;
  let totalWeight = 0;
  for (let d of waitPool) {
    totalWeight += d.starred ? C.starWeight : 1;
  }
  let r = random(totalWeight);
  let accum = 0;
  for (let i = 0; i < waitPool.length; i++) {
    accum += waitPool[i].starred ? C.starWeight : 1;
    if (r <= accum) return i;
  }
  return waitPool.length - 1;
}

function startPendingUploads() {
  let bestIdx = -1;
  let bestTime = 0;
  for (let i = 0; i < waitPool.length; i++) {
    if (waitPool[i].newUpload && waitPool[i].newUpload > bestTime) {
      bestTime = waitPool[i].newUpload;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return;
  if (displays.length >= C.maxDisplay) return;
  if (batchInProgress) {
    let batchDurationMs = getBatchDuration(currentBatchSize);
    let elapsed = millis() - batchStartTime;
    let remaining = batchDurationMs - elapsed;
    if (remaining < 5000) return;
  }

  let data = waitPool[bestIdx];
  let d = new DisplayPhoto(data, 'random');
  displays.push(d);
  let started = d.startGathering();
  if (started) {
    waitPool.splice(bestIdx, 1);
    delete data.newUpload;
    maintainFreeCount();
    ripples.push(new Ripple(d.x, d.y, 1.0));
  } else {
    displays.pop();
  }
}

function resolveCollisions() {
  const CR = C.collisionRadius;
  const CR2 = CR * CR;
  const CS = C.gridCellSize;
  let gCols = ceil(width / CS) + 1;
  let gRows = ceil(height / CS) + 1;

  let grid = new Array(gCols * gRows);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].hidden) continue;
    let p = pts[i];
    let cx = floor(constrain(p.pos.x / CS, 0, gCols - 1));
    let cy = floor(constrain(p.pos.y / CS, 0, gRows - 1));
    grid[cx + cy * gCols].push(i);
  }

  for (let i = 0; i < pts.length; i++) {
    if (pts[i].hidden) continue;
    let p = pts[i];
    let cx = floor(constrain(p.pos.x / CS, 0, gCols - 1));
    let cy = floor(constrain(p.pos.y / CS, 0, gRows - 1));

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        let nx = cx + dx;
        let ny = cy + dy;
        if (nx < 0 || nx >= gCols || ny < 0 || ny >= gRows) continue;
        let cell = grid[nx + ny * gCols];
        for (let j = 0; j < cell.length; j++) {
          let jdx = cell[j];
          if (jdx <= i) continue;
          let q = pts[jdx];
          if (q.hidden) continue;

          let ddx = p.pos.x - q.pos.x;
          let ddy = p.pos.y - q.pos.y;
          let dist2 = ddx * ddx + ddy * ddy;

          if (dist2 < CR2 && dist2 > 0.01) {
            let dist = sqrt(dist2);
            let overlap = CR - dist;
            let nx2 = ddx / dist;
            let ny2 = ddy / dist;
            let correction = overlap * 0.5;
            p.pos.x += nx2 * correction;
            p.pos.y += ny2 * correction;
            q.pos.x -= nx2 * correction;
            q.pos.y -= ny2 * correction;
          }
        }
      }
    }
  }
}

function updateFreeParticles() {
  const VB = C.vanishBuffer;
  const JITTER = C.jitterStrength;

  /* ★ 降粒前先统计自由粒子数，低于 drainMinFree 时停止降粒 */
  let freeCount = 0;
  if (drainActive) {
    for (let p of pts) { if (!p.claimedBy && !p.hidden) freeCount++; }
  }

  for (let p of pts) {
    if (p.claimedBy || p.hidden) continue;

    let force = followFlow(p.pos);
    let detail = followDetailFlow(p.pos);
    force.add(detail);
    p.acc.add(force);

    p.acc.x += random(-JITTER, JITTER);
    p.acc.y += random(-JITTER, JITTER);

    for (let d of displays) {
      if (d.phase === PHASE.WAITING) continue;
      if (d.phase === PHASE.SCATTERING && d.scatterProgress > 0.8) continue;

      let dx = d.x - p.pos.x;
      let dy = d.y - p.pos.y;
      let dist = sqrt(dx * dx + dy * dy);
      let halfDiag = sqrt(d.w * d.w + d.h * d.h) / 2;

      /* ★ 仅保持避让力，移除旧的 GATHERING 吸引力 */
      let avoidForce, avoidRadius;
      if (d.phase === PHASE.GATHERING || d.phase === PHASE.CONVERGING) {
        avoidForce = C.gatheringAvoidForce || 0.3;
        avoidRadius = C.gatheringAvoidRadius || 20;
      } else {
        avoidForce = C.generalAvoidForce || 2.0;
        avoidRadius = C.generalAvoidRadius || 80;
      }

      let avoidDist = halfDiag + avoidRadius;
      if (dist < avoidDist && dist > 5) {
        let strength = avoidForce * pow(1 - dist / avoidDist, 1.5);
        let ang = atan2(-dy, -dx);
        p.acc.x += cos(ang) * strength;
        p.acc.y += sin(ang) * strength;
      }
    }

    p.vel.add(p.acc);

    let speed = p.vel.mag();
    if (speed < 0.5 && speed > 0.01) {
      p.vel.mult(0.5 / speed);
    } else if (speed < 0.01) {
      p.vel.add(tinyVel());
    }

    p.vel.limit(C.baseSpeed * 1.8);
    p.pos.add(p.vel);
    p.acc.mult(0);

    /* ★ 降粒保护：自由粒子数不低于 drainMinFree */
    if (drainActive && freeCount > C.drainMinFree) {
      if (random() < C.drainFadeChance) {
        p.hidden = true;
        freeCount--;
        continue;
      }
    }

    if (p.pos.x < -VB || p.pos.x > width + VB ||
        p.pos.y < -VB || p.pos.y > height + VB) {
      p.hidden = true;
    }
  }
}

function updateFlowField() {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let idx = x + y * cols;
      let ang = noise(x * C.flowScale, y * C.flowScale, flowZ) * TWO_PI * 2.5;
      flowField[idx] = p5.Vector.fromAngle(ang).setMag(C.baseSpeed);

      let detailAng = noise(
        x * C.detailScale + 100,
        y * C.detailScale + 100,
        flowZ * 1.3 + 50
      ) * TWO_PI * 3;
      let detailV = p5.Vector.fromAngle(detailAng);
      detailV.setMag(C.baseSpeed * C.detailStrength);
      detailFlowField[idx] = detailV;
    }
  }
}

function followFlow(pos) {
  let x = floor(constrain(pos.x / 6, 0, cols - 1));
  let y = floor(constrain(pos.y / 6, 0, rows - 1));
  return flowField[x + y * cols].copy();
}

function followDetailFlow(pos) {
  let x = floor(constrain(pos.x / 6, 0, cols - 1));
  let y = floor(constrain(pos.y / 6, 0, rows - 1));
  return detailFlowField[x + y * cols].copy();
}

function euclideanDist(x1, y1, x2, y2) {
  let dx = x1 - x2;
  let dy = y1 - y2;
  return sqrt(dx * dx + dy * dy);
}

function drawParticles() {
  noStroke();
  for (let p of pts) {
    if (p.hidden) continue;

    let r, g, b, a = p.alpha;

    let flowR = p.isRed
      ? 235 + 20 * sin1
      : 25 + 15 * sin2;
    let flowG = p.isRed
      ? 50 + 20 * sin3
      : 160 + 30 * sin1;
    let flowB = p.isRed
      ? 40 + 15 * sin2
      : 235 + 20 * sin3;

    if (!p.claimedBy || !p.hasTarget) {
      r = flowR; g = flowG; b = flowB;
    } else {
      let mix = p.targetA;
      r = lerp(flowR, p.targetR, mix);
      g = lerp(flowG, p.targetG, mix);
      b = lerp(flowB, p.targetB, mix);
      a = p.alpha * (0.5 + 0.5 * mix);
    }

    fill(r, g, b, a);
    ellipse(p.pos.x, p.pos.y, p.size, p.size);

    fill(255, 255, 255, a * 0.2);
    ellipse(p.pos.x, p.pos.y, p.size * 0.35);
  }
}

function easeOutQuad(t) { return t * (2 - t); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2; }

function calcPhotoSize(totalActive) {
  let baseMin, baseMax;
  if (totalActive <= 1) { baseMin = 0.31; baseMax = 0.36; }
  else if (totalActive === 2) { baseMin = 0.18; baseMax = 0.25; }
  else if (totalActive === 3) { baseMin = 0.15; baseMax = 0.20; }
  else if (totalActive === 4) { baseMin = 0.11; baseMax = 0.16; }
  else { baseMin = 0.10; baseMax = 0.14; }

  let existingSizes = [];
  for (let d of displays) {
    if ((d.phase === PHASE.CONVERGING || d.phase === PHASE.DISPLAYED)) {
      existingSizes.push(d.w / width);
    }
  }

  let bestSize = random(baseMin, baseMax);
  let bestDist = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    let candidate = random(baseMin, baseMax);
    let minDist = Infinity;
    for (let s of existingSizes) {
      let d = abs(candidate - s);
      if (d < minDist) minDist = d;
    }
    if (minDist > bestDist) { bestDist = minDist; bestSize = candidate; }
  }
  return bestSize;
}

/* ★ 生成屏幕边缘随机起点 */
function randomEdgePos() {
  let edge = floor(random(4));
  switch (edge) {
    case 0: return { x: random(width), y: -20 };           // 上
    case 1: return { x: random(width), y: height + 20 };   // 下
    case 2: return { x: -20, y: random(height) };          // 左
    case 3: return { x: width + 20, y: random(height) };   // 右
  }
}

/* ★ 二次贝塞尔曲线: B(t) = (1-t)²P0 + 2(1-t)t·P1 + t²·P2 */
function quadraticBezier(t, p0, p1, p2) {
  let omt = 1 - t;
  return omt * omt * p0 + 2 * omt * t * p1 + t * t * p2;
}

class DisplayPhoto {
  constructor(data, type) {
    this.data = data;
    this.id = data.id;
    this.aspect = data.height / data.width;
    this.type = type;
    this.phase = PHASE.WAITING;
    this.stateStart = millis();

    this.img = null;
    this.loaded = false;
    if (data.thumbnail) {
      loadImage(data.thumbnail, img => {
        this.img = img;
        this.loaded = true;
        /* 图片加载后更新已分配粒子的颜色 */
        if (this.assignedPts && this.assignedPts.length > 0) {
          this.sampleTargets();
        }
      });
    }

    this.x = 0;
    this.y = 0;
    this.w = 0;
    this.h = 0;
    this.assignedPts = [];

    this.convergeProgress = 0;
    this.scatterProgress = 0;
    this.particleTarget = 0;
    this.scatterGridCols = 0;
    this.scatterGridRows = 0;
    this.scatterGridSize = 0;
  }

  getTargetParticleCount() {
    let activeCount = 0;
    for (let d of displays) {
      if (d === this) continue;
      if (d.phase === PHASE.GATHERING || d.phase === PHASE.CONVERGING || d.phase === PHASE.DISPLAYED) {
        activeCount++;
      }
    }
    let idx = min(activeCount, C.photoParticleTargets.length - 1);
    return C.photoParticleTargets[idx];
  }

  /* ★ 【核心修改】startGathering — 从隐藏池抓取粒子直接放屏幕边缘 */
  startGathering() {
    let activeCount = 0;
    for (let d of displays) {
      if (d === this) continue;
      if (d.phase === PHASE.GATHERING || d.phase === PHASE.CONVERGING || d.phase === PHASE.DISPLAYED) {
        activeCount++;
      }
    }
    let totalActive = activeCount + 1;

    this.particleTarget = this.getTargetParticleCount();

    let sizeRatio = calcPhotoSize(totalActive);
    let canvasLongSide = max(width, height);

    if (this.aspect >= 1) {
      this.h = canvasLongSide * sizeRatio;
      this.w = this.h / this.aspect;
    } else {
      this.w = canvasLongSide * sizeRatio;
      this.h = this.w * this.aspect;
    }

    this.findNonOverlapPos();

    /* ★ 从隐藏池抓取粒子 */
    let needed = this.particleTarget;
    let claimed = [];
    for (let i = 0; i < pts.length && claimed.length < needed; i++) {
      if (pts[i].hidden && !pts[i].claimedBy) {
        claimed.push(i);
      }
    }
    this.assignedPts = claimed;

    /* ★ 分配目标位置（网格采样）+ 贝塞尔路径 */
    let total = this.assignedPts.length;
    if (total > 0) {
      let cols_ = ceil(sqrt(total * this.aspect));
      let rows_ = ceil(total / cols_);

      for (let i = 0; i < total; i++) {
        let p = pts[this.assignedPts[i]];
        let col = i % cols_;
        let row = floor(i / cols_);
        let nx = (col + 0.5) / cols_;
        let ny = (row + 0.5) / rows_;

        let targetX = (nx - 0.5) * this.w;
        let targetY = (ny - 0.5) * this.h;
        let endX = this.x + targetX;
        let endY = this.y + targetY;

        /* ★ 屏幕边缘起点 */
        let start = randomEdgePos();

        /* ★ 贝塞尔控制点（中点+随机垂直偏移，形成自然弧线） */
        let midX = (start.x + endX) / 2;
        let midY = (start.y + endY) / 2;
        let dirX = endX - start.x;
        let dirY = endY - start.y;
        let dLen = sqrt(dirX * dirX + dirY * dirY);
        if (dLen > 0) {
          let perpX = -dirY / dLen;
          let perpY = dirX / dLen;
          let offset = random(30, 120) * (random() > 0.5 ? 1 : -1);
          midX += perpX * offset;
          midY += perpY * offset;
        }

        /* ★ 写入粒子 */
        p.startX = start.x;
        p.startY = start.y;
        p.ctrlX = midX;
        p.ctrlY = midY;
        p.endX = endX;
        p.endY = endY;
        p.curveT = 0;
        /* 匀速：在 gatherMs 毫秒内从 0 到 1 */
        p.curveSpeed = 1.0 / C.gatherMs;

        p.pos.set(start.x, start.y);
        p.vel.set(0, 0);
        p.hidden = false;
        p.claimedBy = this.id;
        p.hasTarget = true;
        p.targetX = targetX;
        p.targetY = targetY;
        p.targetA = 0;

        /* 颜色采样 */
        if (this.loaded && this.img) {
          let ix = floor(constrain(nx * this.img.width, 0, this.img.width - 1));
          let iy = floor(constrain(ny * this.img.height, 0, this.img.height - 1));
          let c = this.img.get(ix, iy);
          p.targetR = red(c); p.targetG = green(c); p.targetB = blue(c);
        } else if (this.data.redLine) {
          let imgX = floor(nx * this.data.width);
          let ri = this.data.redLine[imgX] || 128;
          let bi = (this.data.blueLine && this.data.blueLine[imgX] !== -1) ? this.data.blueLine[imgX] : 128;
          p.targetR = map(ri, 0, this.data.height, 40, 255);
          p.targetG = 100;
          p.targetB = map(bi, 0, this.data.height, 40, 255);
        } else {
          p.targetR = random(100, 255);
          p.targetG = random(100, 255);
          p.targetB = random(100, 255);
        }
      }
    }

    /* ★ 粒子出现即触发降粒 */
    drainActive = true;

    this.phase = PHASE.GATHERING;
    this.stateStart = millis();
    this.convergeProgress = 0;

    displayCounts[this.id] = (displayCounts[this.id] || 0) + 1;
    return true;
  }

  /* ★ 不再主动调用，保留方法以防万一 */
  claimNearbyParticles() {}

  findNonOverlapPos() {
    for (let attempt = 0; attempt < 60; attempt++) {
      let px = random(this.w / 2 + 10, width - this.w / 2 - 10);
      let py = random(this.h / 2 + 10, height - this.h / 2 - 10);
      let ok = true;
      for (let d of displays) {
        if (d === this) continue;
        if (d.phase === PHASE.UPLOADING || d.phase === PHASE.GATHERING ||
            d.phase === PHASE.CONVERGING || d.phase === PHASE.DISPLAYED) {
          let gap = 20;
          if (abs(px - d.x) < (this.w + d.w) / 2 + gap &&
              abs(py - d.y) < (this.h + d.h) / 2 + gap) { ok = false; break; }
        }
      }
      if (ok) { this.x = px; this.y = py; return; }
    }
    this.x = random(this.w / 2 + 10, width - this.w / 2 - 10);
    this.y = random(this.h / 2 + 10, height - this.h / 2 - 10);
  }

  sampleTargets() {
    let total = this.assignedPts.length;
    if (total === 0) return;

    let cols_ = ceil(sqrt(total * this.aspect));
    let rows_ = ceil(total / cols_);

    for (let i = 0; i < total; i++) {
      let p = pts[this.assignedPts[i]];
      let col = i % cols_;
      let row = floor(i / cols_);
      let nx = (col + 0.5) / cols_;
      let ny = (row + 0.5) / rows_;

      /* ★ 仅更新颜色，不覆盖路径参数 */
      if (this.loaded && this.img) {
        let ix = floor(constrain(nx * this.img.width, 0, this.img.width - 1));
        let iy = floor(constrain(ny * this.img.height, 0, this.img.height - 1));
        let c = this.img.get(ix, iy);
        p.targetR = red(c); p.targetG = green(c); p.targetB = blue(c);
      } else if (this.data.redLine) {
        let imgX = floor(nx * this.data.width);
        let ri = this.data.redLine[imgX] || 128;
        let bi = (this.data.blueLine && this.data.blueLine[imgX] !== -1) ? this.data.blueLine[imgX] : 128;
        p.targetR = map(ri, 0, this.data.height, 40, 255);
        p.targetG = 100;
        p.targetB = map(bi, 0, this.data.height, 40, 255);
      }
    }
  }

  prepareScatterPixels() {
    if (!this.loaded || !this.img) return;

    this.img.loadPixels();

    this.scatterGridSize = getScatterGridSize(this.w, this.h);

    this.scatterGridCols = ceil(this.w / this.scatterGridSize);
    this.scatterGridRows = ceil(this.h / this.scatterGridSize);
    let totalNeeded = this.scatterGridCols * this.scatterGridRows;

    for (let idx of this.assignedPts) {
      let p = pts[idx];
      p.claimedBy = null;
      p.hasTarget = false;
      p.targetA = 0;
      p.hidden = true;
    }
    this.assignedPts = [];

    let gathered = [];
    for (let i = 0; i < pts.length && gathered.length < totalNeeded; i++) {
      if (pts[i].hidden && !pts[i].claimedBy) {
        pts[i].hidden = false;
        pts[i].claimedBy = this.id;
        gathered.push(i);
      }
    }

    this.assignedPts = gathered;
    let total = this.assignedPts.length;
    if (total === 0) return;

    for (let i = 0; i < total; i++) {
      let p = pts[this.assignedPts[i]];
      let col = i % this.scatterGridCols;
      let row = floor(i / this.scatterGridCols);

      let px = col * this.scatterGridSize + this.scatterGridSize / 2;
      let py = row * this.scatterGridSize + this.scatterGridSize / 2;

      p.targetX = px - this.w / 2;
      p.targetY = py - this.h / 2;
      p.hasTarget = true;

      let imgX = floor((px / this.w) * this.img.width);
      let imgY = floor((py / this.h) * this.img.height);

      let half = 2;
      let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          let sx = floor(constrain(imgX + dx, 0, this.img.width - 1));
          let sy = floor(constrain(imgY + dy, 0, this.img.height - 1));
          let idx2 = (sy * this.img.width + sx) * 4;
          rSum += this.img.pixels[idx2];
          gSum += this.img.pixels[idx2 + 1];
          bSum += this.img.pixels[idx2 + 2];
          cnt++;
        }
      }

      p.targetR = rSum / cnt;
      p.targetG = gSum / cnt;
      p.targetB = bSum / cnt;
      p.targetA = 0;

      p.pos.set(this.x + p.targetX, this.y + p.targetY);
      p.vel = tinyVel();
      p.hidden = false;
    }
  }

  releaseParticles() {
    let target = this.particleTarget;
    let kept = 0;

    for (let idx of this.assignedPts) {
      let p = pts[idx];
      p.claimedBy = null;
      p.hasTarget = false;
      p.targetA = 0;

      if (kept < target && !p.hidden) {
        p.hidden = false;
        if (p.vel.mag() < 0.3) p.vel = tinyVel();
        kept++;
      } else {
        p.hidden = true;
      }
    }

    this.assignedPts = [];
    if (!this.data.starred) this.data.starred = false;
    waitPool.push(this.data);
  }

  /* ★ 【核心修改】update — GATHERING 用贝塞尔曲线，CONVERGING 简化 */
  update() {
    let elapsed = millis() - this.stateStart;
    let dt = deltaTime;

    switch (this.phase) {
      case PHASE.WAITING: break;

      /* ★ GATHERING: 贝塞尔曲线匀速运动，到点 snap 隐藏 */
      case PHASE.GATHERING: {
        let allArrived = true;

        for (let idx of this.assignedPts) {
          let p = pts[idx];
          if (!p.hasTarget || p.hidden) continue;
          if (p.curveT === undefined) continue;

          /* 匀速推进曲线进度 */
          p.curveT += p.curveSpeed * dt;

          if (p.curveT >= 1) {
            /* 到点！直接 snap 到目标位置，隐藏 */
            p.pos.set(p.endX, p.endY);
            p.hidden = true;
            p.claimedBy = null;
            p.targetA = 1;
            /* 不重置 curveT，保持 >=1 标记已到达 */
          } else {
            allArrived = false;
            let t = p.curveT;
            /* 二次贝塞尔 */
            p.pos.x = quadraticBezier(t, p.startX, p.ctrlX, p.endX);
            p.pos.y = quadraticBezier(t, p.startY, p.ctrlY, p.endY);
            /* 颜色逐渐显现 */
            p.targetA = min(0.6, t * 0.8);
          }
        }

        /* 全部到位 或 超时 → 切 CONVERGING */
        if (allArrived || elapsed >= C.gatherMs) {
          /* 强制所有未到位粒子 snap */
          for (let idx of this.assignedPts) {
            let p = pts[idx];
            if (p.hidden || !p.hasTarget) continue;
            p.pos.set(p.endX, p.endY);
            p.hidden = true;
            p.claimedBy = null;
            p.targetA = 1;
          }
          this.phase = PHASE.CONVERGING;
          this.stateStart = millis();
          this.convergeProgress = 0;
          ripples.push(new Ripple(this.x, this.y, 1.2));
        }
        break;
      }

      /* ★ CONVERGING: 粒子已全部到位，仅做 overlay 淡入过渡 */
      case PHASE.CONVERGING: {
        this.convergeProgress = min(1, elapsed / C.convergeMs);

        /* 万一还有没到位的（极罕见情况），强制拉到位 */
        for (let idx of this.assignedPts) {
          let p = pts[idx];
          if (p.hidden || !p.hasTarget) continue;
          if (p.curveT !== undefined && p.curveT < 1) {
            p.curveT = 1;
            p.pos.set(p.endX, p.endY);
            p.hidden = true;
            p.claimedBy = null;
            p.targetA = 1;
          }
        }

        if (this.convergeProgress >= 1) {
          this.phase = PHASE.DISPLAYED;
          this.stateStart = millis();
        }
        break;
      }

      /* ★ DISPLAYED: overlay 展示 + 尾部触发 drain 终止 + 到期切 scatter */
      case PHASE.DISPLAYED: {
        /* 不再需要 claimNearbyParticles / 维持 assignedPts */
        let drainStartTime = C.displayMs - C.scatterLeadTime;

        if (elapsed > drainStartTime && elapsed <= C.displayMs) {
          drainActive = true;
        }

        if (elapsed > C.displayMs && !isAnyPhotoScattering()) {
          drainActive = false;
          drainEndTime = millis();
          this.phase = PHASE.SCATTERING;
          this.stateStart = millis();
          this.scatterProgress = 0;
          this.prepareScatterPixels();
          ripples.push(new Ripple(this.x, this.y, 1.5));
        }
        break;
      }

      /* SCATTERING: 保持不变 */
      case PHASE.SCATTERING: {
        this.scatterProgress = min(1, elapsed / C.scatterMs);
        let sp = this.scatterProgress;

        for (let i = 0; i < this.assignedPts.length; i++) {
          let p = pts[this.assignedPts[i]];
          if (!p.hasTarget) continue;

          if (p.hidden) {
            p.hidden = false;
            p.pos.set(this.x + p.targetX, this.y + p.targetY);
            p.vel = tinyVel();
          }

          if (sp < 0.4) {
            let appear = easeInOutCubic(sp / 0.4);
            p.targetA = appear;
            p.vel.mult(0.95);
            if (p.vel.mag() < 0.3) p.vel.add(tinyVel());
            let breathe = sin(millis() * 0.002 + i * 0.05) * 0.5;
            p.pos.set(
              this.x + p.targetX + breathe,
              this.y + p.targetY + breathe * 0.5
            );
          } else {
            let spread = (sp - 0.4) / 0.6;
            let ang = i * 0.618 + this.id * 0.1;
            let dist = easeOutQuad(spread) * random(100, 280);
            let tx = this.x + p.targetX + cos(ang + millis() * 0.0001) * dist;
            let ty = this.y + p.targetY + sin(ang * 1.3 + millis() * 0.0001) * dist;
            p.vel.x = (tx - p.pos.x) * 0.04;
            p.vel.y = (ty - p.pos.y) * 0.04;
            if (p.vel.mag() < 0.3) p.vel.add(tinyVel());
            p.pos.add(p.vel);
            p.targetA = max(0, 1 - spread * 1.3);

            if (spread > 0.3) {
              let fadeOutChance = 0.01 + 0.03 * ((spread - 0.3) / 0.7);
              if (random() < fadeOutChance) {
                p.hidden = true;
              }
            }
          }
        }
        break;
      }
    }
  }

  drawPhotoOverlay() {
    if (!this.loaded || !this.img) return;
    let alpha = 0;

    if (this.phase === PHASE.UPLOADING) {
      let fadeIn = min(1, (millis() - this.stateStart) / 400);
      alpha = 255 * fadeIn;
    } else if (this.phase === PHASE.CONVERGING) {
      let photoFade = easeOutQuad(max(0, (this.convergeProgress - 0.4) / 0.6));
      alpha = 255 * photoFade;
    } else if (this.phase === PHASE.DISPLAYED) {
      alpha = 255;
    } else if (this.phase === PHASE.SCATTERING) {
      let sp = (millis() - this.stateStart) / C.scatterMs;
      if (sp < 0.5) {
        alpha = 255 * (1 - easeOutQuad(sp / 0.5));
      }
    }

    if (alpha > 3) {
      push();
      imageMode(CENTER);
      tint(255, alpha);
      image(this.img, this.x, this.y, this.w, this.h);
      noTint();
      pop();
    }
  }
}

function checkPoolDisplay() {
  if (!batchInProgress) return;
  if (photosStartedThisBatch >= currentBatchSize) return;
  if (millis() < nextPoolCheck) return;
  nextPoolCheck = millis() + random(C.checkMinMs, C.checkMaxMs);

  let activeCount = 0;
  for (let d of displays) {
    if (d.phase === PHASE.GATHERING || d.phase === PHASE.CONVERGING || d.phase === PHASE.DISPLAYED) activeCount++;
  }
  if (activeCount >= currentBatchSize) return;
  if (activeCount >= C.maxDisplay) return;
  if (waitPool.length === 0) return;
  if (currentBatchSize === 0) return;

  let idx = pickWeightedFromPool();
  if (idx < 0) return;
  let data = waitPool[idx];

  let d = new DisplayPhoto(data, 'random');
  displays.push(d);
  let started = d.startGathering();
  if (started) {
    waitPool.splice(idx, 1);
    maintainFreeCount();
    ripples.push(new Ripple(d.x, d.y, 1.0));
  } else {
    displays.pop();
    nextPoolCheck = millis() + random(800, 1500);
  }
}

function handleNewPhoto(data, isNew) {
  if (isNew) {
    cleanupStorage();
    data.newUpload = millis();
    waitPool.push(data);
  } else {
    waitPool.push(data);
  }
}

function cleanupStorage() {
  let allPhotos = [...waitPool];
  for (let d of displays) {
    if (d.data && allPhotos.indexOf(d.data) === -1) {
      allPhotos.push(d.data);
    }
  }
  if (allPhotos.length >= C.maxStoredPhotos) {
    allPhotos.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let toRemove = [];
    for (let p of allPhotos) {
      if (!p.starred) {
        toRemove.push(p);
        if (allPhotos.length - toRemove.length < C.maxStoredPhotos) break;
      }
    }
    for (let r of toRemove) {
      let i = waitPool.indexOf(r);
      if (i !== -1) waitPool.splice(i, 1);
      fetch(`${SUPABASE_URL}/rest/v1/photos?id=eq.${r.id}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }).catch(e => console.error(e));
    }
  }
}

class Ripple {
  constructor(x, y, s) {
    this.x = x; this.y = y;
    this.r = 5 * (s || 1);
    this.max = max(width, height) * 0.4 * (s || 1);
    this.sp = 3 * (s || 1.2);
    this.life = 1; this.done = false;
  }
  update() { this.r += this.sp; this.life = 1 - this.r / this.max; if (this.life <= 0) this.done = true; }
  draw() {
    if (this.done) return;
    noFill();
    stroke(80, 100, 200, 15 * this.life); strokeWeight(0.6); ellipse(this.x, this.y, this.r * 2);
    stroke(60, 80, 180, 8 * this.life); strokeWeight(0.4); ellipse(this.x, this.y, this.r * 2.4);
    stroke(40, 60, 160, 3 * this.life); strokeWeight(0.2); ellipse(this.x, this.y, this.r * 3.0);
  }
}

async function loadAll() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/photos?order=timestamp.desc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const all = await res.json();
    for (let d of all) {
      if (d.starred === undefined) d.starred = false;
      d.redLine = d.red_line;
      d.blueLine = d.blue_line;
      waitPool.push(d);
    }
    if (waitPool.length > 0) {
      nextPoolCheck = millis() + 500;
    }
    if (all.length > 0) {
      lastKnownCount = all[0].id;
    }
  } catch (e) { console.error('加载失败', e); }
}

async function checkNewPhoto() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/photos?order=timestamp.desc&limit=1`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const all = await res.json();
    if (all.length === 0) return;
    const newest = all[0];
    if (newest.id !== lastKnownCount) {
      lastKnownCount = newest.id;
      newest.starred = false;
      newest.redLine = newest.red_line;
      newest.blueLine = newest.blue_line;
      handleNewPhoto(newest, true);
    }
  } catch (e) { console.error(e); }
}

async function updDB(data) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/photos?id=eq.${data.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ starred: data.starred })
    });
  } catch (e) { console.error(e); }
}

async function delDB(id) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/photos?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
  } catch (e) { console.error(e); }
}

function cleanup() {
  if (waitPool.length > C.maxStoredPhotos + 5) {
    cleanupStorage();
  }
}

function keyPressed() { if (key === 'Q' || key === 'q') toggleBS(); }
function toggleBS() { bsVisible = !bsVisible; if (bsPanel) bsVisible ? (bsPanel.style('display', 'flex'), updList()) : bsPanel.style('display', 'none'); }
function hideBS() { bsVisible = false; if (bsPanel) bsPanel.style('display', 'none'); }

function buildPanel() {
  let ov = createDiv(''); ov.class('backstage-overlay'); ov.id('bsOverlay'); ov.parent(document.body); ov.style('display', 'none');
  let p = createDiv(''); p.class('backstage-panel'); p.parent(ov);
  let h = createDiv(''); h.class('backstage-header'); h.parent(p);
  let t = createElement('h2', '🎛 后台管理'); t.parent(h);
  let st = createDiv(''); st.class('backstage-stats'); st.id('bsStats'); st.html('...'); st.parent(h);
  let cl = createDiv('✕ 关闭'); cl.class('backstage-close-btn'); cl.parent(h); cl.mousePressed(hideBS);
  let lst = createDiv(''); lst.class('backstage-list'); lst.id('bsList'); lst.parent(p);
  bsPanel = ov; ov.mousePressed(e => { if (e.target === ov.elt) hideBS(); });
}

const phaseNames = { 'waiting': '等待池', 'uploading': '大图展示', 'gathering': '汇集飞行', 'converging': '照片显现', 'displayed': '展示', 'scattering': '散开中' };

function updList() {
  if (!bsPanel || bsPanel.style('display') === 'none') return;
  let waiting = waitPool.length;
  let activeDisplays = displays.filter(d => d.phase !== PHASE.WAITING).length;
  let allDisplays = displays.length;
  let freeCount = getFreeCount();
  let hiddenCount = 0; for (let p of pts) { if (p.hidden) hiddenCount++; }
  let avgDisplay = 0; let photoCount = 0;
  for (let key in displayCounts) { avgDisplay += displayCounts[key]; photoCount++; }
  if (photoCount > 0) avgDisplay = (avgDisplay / photoCount).toFixed(2);
  let drainMark = drainActive ? '⬇降粒中' : '✔正常';
  let coolScatter = max(0, ceil((scatterCooldownUntil - millis()) / 1000));
  let coolBatch = max(0, ceil((batchCooldownUntil - millis()) / 1000));

  let uploadPending = 0;
  for (let d of waitPool) {
    if (d.newUpload) uploadPending++;
  }

  select('#bsStats').html(
    `池:${waiting} | 批次:${currentBatchSize} | ${drainMark} | ` +
    `自由:${freeCount}/${C.drainMinFree}保底 | 隐藏:${hiddenCount} | ` +
    `散冷:${coolScatter}s | 批冷:${coolBatch}s | ` +
    `均展:${avgDisplay} | 新上传待启:${uploadPending}`
  );
  let l = select('#bsList'); l.html('');
  if (displays.length === 0 && waitPool.length === 0) { let e = createDiv('暂无照片'); e.class('backstage-empty'); e.parent(l); return; }
  for (let d of displays) {
    let it = createDiv(''); it.class('backstage-item'); it.parent(l);
    let th = createElement('img', ''); th.class('backstage-thumb'); if (d.data.thumbnail) th.attribute('src', d.data.thumbnail); th.parent(it);
    let info = createDiv(''); info.class('backstage-info'); info.parent(it);
    let idT = createDiv(''); idT.class('id-text');
    let starMark = d.data.starred ? '⭐ ' : '';
    let scatterInfo = '';
    if (d.phase === PHASE.SCATTERING) {
      scatterInfo = ` ${d.scatterGridCols}×${d.scatterGridRows}格(${d.scatterGridSize}px)`;
    }
    idT.html(`${starMark}#${String(d.data.id).slice(-6)} ${phaseNames[d.phase] || d.phase} (目标${d.particleTarget}粒/${d.assignedPts.length}实${scatterInfo})`); idT.parent(info);
    let szT = createDiv(''); szT.class('date-text'); szT.html(`${floor((millis()-d.stateStart)/1000)}s ${floor(d.w)}×${floor(d.h)}`); szT.parent(info);
    let acts = createDiv(''); acts.class('backstage-actions'); acts.parent(it);
    let starBtn = createDiv(d.data.starred ? '⭐' : '☆'); starBtn.class('backstage-star-btn'); starBtn.parent(acts);
    starBtn.mousePressed(() => toggleStar(d.data));
    let db = createDiv('✕'); db.class('backstage-delete-btn'); db.parent(acts);
    db.mousePressed(() => delPhoto(d.data.id));
  }
  if (waitPool.length > 0) {
    let sep = createDiv(''); sep.class('backstage-separator'); sep.html(`— 等待池 (${waitPool.length}) —`); sep.parent(l);
    let show = waitPool.slice(-10);
    for (let d of show) {
      let it = createDiv(''); it.class('backstage-item'); it.parent(l);
      let th = createElement('img', ''); th.class('backstage-thumb'); if (d.thumbnail) th.attribute('src', d.thumbnail); th.parent(it);
      let info = createDiv(''); info.class('backstage-info'); info.parent(it);
      let idT = createDiv(''); idT.class('id-text');
      let starMark = d.starred ? '⭐ ' : '';
      let uploadMark = d.newUpload ? '📤 ' : '';
      let showCount = displayCounts[d.id] || 0;
      idT.html(`${uploadMark}${starMark}#${String(d.id).slice(-6)} 等待中 (已展${showCount}次)`); idT.parent(info);
      let szT = createDiv(''); szT.class('date-text'); szT.html(new Date(d.timestamp).toLocaleString()); szT.parent(info);
      let acts = createDiv(''); acts.class('backstage-actions'); acts.parent(it);
      let starBtn = createDiv(d.starred ? '⭐' : '☆'); starBtn.class('backstage-star-btn'); starBtn.parent(acts);
      starBtn.mousePressed(() => toggleStar(d));
      let db = createDiv('✕'); db.class('backstage-delete-btn'); db.parent(acts);
      db.mousePressed(() => delPhoto(d.id));
    }
  }
}

function toggleStar(data) { data.starred = !data.starred; updDB(data).then(() => updList()); }

function delPhoto(id) {
  for (let i = 0; i < displays.length; i++) { if (displays[i].data.id === id) { displays[i].releaseParticles(); displays.splice(i, 1); break; } }
  for (let i = 0; i < waitPool.length; i++) { if (waitPool[i].id === id) { waitPool.splice(i, 1); break; } }
  delDB(id).then(() => { updList(); }); ripples.push(new Ripple(random(width), random(height)));
}
