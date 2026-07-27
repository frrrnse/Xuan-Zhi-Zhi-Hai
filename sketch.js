const SUPABASE_URL = 'https://hpacebvclxznmpohxbtf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_b71hGnmuYtG9urxNGTsyFQ_XguBL8Ui';

let img;
let imgWidth, imgHeight;
let canvasWidth, canvasHeight;
let imgDrawX, imgDrawY, imgDrawW, imgDrawH;

let redYPositions;
let currentRedX = 0;
let lastFreqRed = 0;

let blueVolumeCurve;
let currentBlueX = 0;
let lastFreqBlue = 0;

const STATE_IDLE = -1;
const STATE_BLUE_SCANNING = 0;
const STATE_PAUSE = 1;
const STATE_RED_SCANNING = 2;
const STATE_BOTH_4S = 3;
const STATE_BLUR_SHOW = 4;
const STATE_WHITE_BG = 5;
const STATE_FINISHED = 6;
let state = STATE_IDLE;

let pauseStart, bothStart, blurShowStart, whiteStart;
let finalExportDone = false;
let scanSpeed = 1;

const SAT_THRESHOLD_255 = 205;
const BRIGHT_THRESHOLD_255 = 155;

const BLUE_R = 15, BLUE_G = 245, BLUE_B = 245;
const RED_ALPHA = 216;
const BLUE_ALPHA = 255;

let osc, delay;
let audioStarted = false;
let oscStopped = false;

let fileInput, startBtn, downloadBtn, downloadFocusBtn, statusP;
let canvas;
let loadMessage = '';

const MAX_CANVAS_WIDTH = 1200;

let gridSize = 8;
let gridCols = 0, gridRows = 0;
let gridScore = [];
let focusRegions = [];
let blurComposite = null;
let redCoveredGrid = [];

let redTriggeredByVivid = [];


let debugShowScores = false;
let exhibitionAsked = false;
let uploadModal, uploadYesBtn, uploadNoBtn, toExhibitionBtn;

function setup() {
  pixelDensity(1);
  canvas = createCanvas(800, 400);
  canvas.parent('canvasContainer');
  noLoop();

  fileInput = select('#fileInput');
  startBtn = select('#startBtn');
  downloadBtn = select('#downloadBtn');
  downloadFocusBtn = select('#downloadFocusBtn');
  statusP = select('#status');
  statusP.html('请先选择一张图片');

  fileInput.changed(handleFile);
  startBtn.mousePressed(startScan);
  downloadBtn.mousePressed(downloadResult);
  downloadFocusBtn.mousePressed(downloadFocusPhoto);
  uploadModal = select('#uploadModal');
  uploadYesBtn = select('#uploadYes');
  uploadNoBtn = select('#uploadNo');
  toExhibitionBtn = select('#toExhibitionBtn');

  uploadYesBtn.mousePressed(uploadToExhibition);
  uploadNoBtn.mousePressed(hideUploadModal);
  toExhibitionBtn.mousePressed(openExhibition);
}

function draw() {
  background(0);

  if (state === STATE_IDLE && loadMessage !== '') {
    fill(255);
    textAlign(CENTER, CENTER);
    textSize(18);
    text(loadMessage, width / 2, height / 2);
    return;
  }

  if (state === STATE_IDLE) return;

  switch(state) {
    case STATE_BLUE_SCANNING:
      background(0);
      drawImageScaled();
      drawBlueTrail(0, currentBlueX);
      stroke(BLUE_R, BLUE_G, BLUE_B);
      let bx = map(currentBlueX, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW);
      line(bx, imgDrawY, bx, imgDrawY + imgDrawH);

      if (frameCount % scanSpeed === 0) {
        analyzeBlueColumn(currentBlueX);
        currentBlueX++;
        if (currentBlueX >= imgWidth) {
          if (osc) { osc.amp(0); osc.stop(); oscStopped = true; osc = null; }
          state = STATE_PAUSE;
          pauseStart = millis();
        }
      }
      break;

    case STATE_PAUSE:
      background(0);
      drawImageScaled();
      drawBlueTrail(0, imgWidth);
      if (millis() - pauseStart > 1000) {
        if (oscStopped) initAudio();
        currentRedX = 0;
        lastFreqRed = 0;
        state = STATE_RED_SCANNING;
      }
      break;

    case STATE_RED_SCANNING:
      background(0);
      drawImageScaled();
      drawRedTrail(0, currentRedX);
      stroke(255, 0, 0);
      let rx = map(currentRedX, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW);
      line(rx, imgDrawY, rx, imgDrawY + imgDrawH);

      if (frameCount % scanSpeed === 0) {
        analyzeRedColumn(currentRedX);
        currentRedX++;
        if (currentRedX >= imgWidth) {
          if (osc) { osc.amp(0); osc.stop(); oscStopped = true; osc = null; }
          initGridSystem();
          markRedCoverage();
          runFocusAnalysis();
          applyRedCoverageMask();
          focusRegions = selectFocusRegions();
          renderBlurComposite();
          state = STATE_BOTH_4S;
          bothStart = millis();
        }
      }
      break;

    case STATE_BOTH_4S:
      background(0);
      drawImageScaled();
      drawRedTrail(0, imgWidth);
      drawBlueTrail(0, imgWidth);
      if (millis() - bothStart > 4000) {
        state = STATE_BLUR_SHOW;
        blurShowStart = millis();
      }
      break;

    case STATE_BLUR_SHOW:
      if (blurComposite) {
        image(blurComposite, 0, 0);
      } else {
        background(0);
        drawImageScaled();
        drawRedTrail(0, imgWidth);
        drawBlueTrail(0, imgWidth);
      }
      if (millis() - blurShowStart > 5000) {
        state = STATE_WHITE_BG;
        whiteStart = millis();
      }
      break;

    case STATE_WHITE_BG:
      if (!finalExportDone) {
        finalExportDone = true;
        downloadBtn.style('display', 'inline-block');
        downloadFocusBtn.style('display', 'inline-block');
        statusP.html('图像频谱报告已生成，点击下载保存报告');
      if (!exhibitionAsked) {
          exhibitionAsked = true;
          showUploadModal();
        }
      }
      background(255);
      drawRedTrail(0, imgWidth);
      drawBlueTrail(0, imgWidth);
      if (millis() - whiteStart > 3000) {
        state = STATE_FINISHED;
        noLoop();
      }
      break;

    case STATE_FINISHED:
      break;
  }

  // ★ DEBUG 绘制分数热力图
  if (debugShowScores && gridScore.length > 0) {
    drawScoreDebug();
  }
}

function drawImageScaled() {
  if (img) image(img, imgDrawX, imgDrawY, imgDrawW, imgDrawH);
}

function drawRedTrail(start, end) {
  push();
  stroke(255, 0, 0, RED_ALPHA);
  strokeWeight(1);
  noFill();
  beginShape();
  let e = min(end, imgWidth);
  for (let i = start; i < e; i++) {
    vertex(
      map(i, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW),
      map(redYPositions[i], 0, imgHeight, imgDrawY, imgDrawY + imgDrawH)
    );
  }
  endShape();
  pop();
}

function drawBlueTrail(start, end) {
  push();
  stroke(BLUE_R, BLUE_G, BLUE_B, BLUE_ALPHA);
  strokeWeight(1);
  noFill();
  beginShape();
  let e = min(end, imgWidth);
  for (let i = start; i < e; i++) {
    if (blueVolumeCurve[i] !== -1) {
      vertex(
        map(i, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW),
        map(blueVolumeCurve[i], 0, imgHeight, imgDrawY, imgDrawY + imgDrawH)
      );
    }
  }
  endShape();
  pop();
}

function getRGB(x, y) {
  let idx = (y * imgWidth + x) * 4;
  return { r: img.pixels[idx], g: img.pixels[idx + 1], b: img.pixels[idx + 2] };
}

function rgbToHSB(r, g, b) {
  let h = 0, s = 0, v = 0;
  let cmax = max(r, g, b);
  let cmin = min(r, g, b);
  let delta = cmax - cmin;
  v = cmax;
  if (cmax !== 0) s = (delta * 255) / cmax;
  if (delta !== 0) {
    if (cmax === r) h = ((g - b) / delta) % 6;
    else if (cmax === g) h = ((b - r) / delta) + 2;
    else h = ((r - g) / delta) + 4;
    h = h * 42.5;
    if (h < 0) h += 255;
  }
  return { h, s, v };
}

function analyzeRedColumn(x) {
  let validY = [];
  for (let y = 0; y < imgHeight; y++) {
    let { r, g, b } = getRGB(x, y);
    let hsb = rgbToHSB(r, g, b);
    if (hsb.s > SAT_THRESHOLD_255 && hsb.v > BRIGHT_THRESHOLD_255) validY.push(y);
  }

  redTriggeredByVivid[x] = (validY.length >= 2);

  let maxContrast = 0;
  let targetY = 0;

  if (validY.length >= 2) {
    for (let i = 0; i < validY.length - 1; i++) {
      let c1 = getRGB(x, validY[i]);
      let c2 = getRGB(x, validY[i + 1]);
      let contrast = calcContrast(c1, c2);
      if (contrast > maxContrast) { maxContrast = contrast; targetY = validY[i]; }
    }
  } else {
    for (let y = 0; y < imgHeight - 1; y++) {
      let c1 = getRGB(x, y);
      let c2 = getRGB(x, y + 1);
      let contrast = calcContrast(c1, c2);
      if (contrast > maxContrast) { maxContrast = contrast; targetY = y; }
    }
  }

  redYPositions[x] = targetY;
  let normalized = map(targetY, 0, imgHeight, 1.0, 0.0);
  let freq = pow(normalized, 2) * 1800 + 150;
  freq = lerp(freq, lastFreqRed, 0.3);
  if (osc) osc.freq(freq);
  let amp = map(constrain(maxContrast * 1.5, 0, 255), 0, 255, 0.5, 0.6);
  if (osc) osc.amp(amp, 0.05);
  lastFreqRed = freq;
}

function calcContrast(c1, c2) {
  let hs1 = rgbToHSB(c1.r, c1.g, c1.b);
  let hs2 = rgbToHSB(c2.r, c2.g, c2.b);
  let h1 = hs1.h, s1 = hs1.s, b1 = hs1.v;
  let h2 = hs2.h, s2 = hs2.s, b2 = hs2.v;
  let dh = min(abs(h1 - h2), 256 - abs(h1 - h2));
  let dhNorm = dh / 128.0;
  let avgS = (s1 + s2) / 2.0;
  let hueContrast = dhNorm * (avgS / 255.0) * 255.0;
  let ds = abs(s2 - s1);
  let db = abs(b2 - b1);
  return hueContrast * 1.5 + ds * 0.5 + db * 0.5;
}

function analyzeBlueColumn(x) {
  let sumBrightness = 0;
  for (let y = 0; y < imgHeight; y++) {
    let { r, g, b } = getRGB(x, y);
    let hsb = rgbToHSB(r, g, b);
    sumBrightness += hsb.v;
  }
  let avgBrightness255 = sumBrightness / imgHeight;
  let normalized = avgBrightness255 / 255.0;
  let freq = pow(normalized, 2) * 1800 + 200;
  freq = lerp(freq, lastFreqBlue, 0.3);
  if (osc) osc.freq(freq);
  let amp = map(constrain(avgBrightness255 * 1.2, 0, 255), 0, 255, 0.2, 0.6);
  if (osc) osc.amp(amp, 0.05);
  lastFreqBlue = freq;
  blueVolumeCurve[x] = map(freq, 200, 2000, imgHeight, 0);
}

function initAudio() {
  osc = new p5.Oscillator('sine');
  osc.freq(400);
  osc.amp(0);
  delay = new p5.Delay();
  osc.disconnect();
  osc.connect(delay);
  delay.process(osc, 0.1, 0.2, 2300);
  delay.connect();
  osc.start();
  oscStopped = false;
}

function handleFile() {
  const file = fileInput.elt.files[0];
  if (!file) return;

  statusP.html('图片加载中...');
  loadMessage = '正在载入图片，请稍候...';
  redraw();

  const objectURL = URL.createObjectURL(file);
  loadImage(objectURL,
    function(loadedImg) {
      URL.revokeObjectURL(objectURL);
      let scale = 2560 / max(loadedImg.width, loadedImg.height);
      imgWidth = int(loadedImg.width * scale);
      imgHeight = int(loadedImg.height * scale);
      img = createImage(imgWidth, imgHeight);
      img.copy(loadedImg, 0, 0, loadedImg.width, loadedImg.height, 0, 0, imgWidth, imgHeight);
      img.loadPixels();

      redYPositions = new Array(imgWidth).fill(0);
      blueVolumeCurve = new Array(imgWidth).fill(-1);

      let maxCanvasW = min(windowWidth * 0.9, MAX_CANVAS_WIDTH);
      let ratio = imgHeight / imgWidth;
      canvasWidth = maxCanvasW;
      canvasHeight = canvasWidth * ratio;
      resizeCanvas(canvasWidth, canvasHeight);

      let canvasRatio = canvasWidth / canvasHeight;
      let imgRatio = imgWidth / imgHeight;
      if (canvasRatio > imgRatio) {
        imgDrawH = canvasHeight;
        imgDrawW = imgDrawH * imgRatio;
      } else {
        imgDrawW = canvasWidth;
        imgDrawH = imgDrawW / imgRatio;
      }
      imgDrawX = (canvasWidth - imgDrawW) / 2;
      imgDrawY = (canvasHeight - imgDrawH) / 2;

      startBtn.removeAttribute('disabled');
      statusP.html('图片已加载，点击"开始扫描"');
      downloadBtn.style('display', 'none');
      downloadFocusBtn.style('display', 'none');
      finalExportDone = false;
      focusRegions = [];
      blurComposite = null;
      state = STATE_IDLE;
      loadMessage = '';
      redraw();
    },
    function(err) {
      URL.revokeObjectURL(objectURL);
      statusP.html('图片加载失败，请重试或换一张图片');
      loadMessage = '加载失败，请重新选择图片';
      console.error(err);
      redraw();
    }
  );
}

function startScan() {
  if (!img) return;
  if (!audioStarted) { userStartAudio(); audioStarted = true; }
  if (oscStopped || !osc) initAudio();

  currentBlueX = 0;
  currentRedX = 0;
  lastFreqBlue = 0;
  lastFreqRed = 0;
  blueVolumeCurve.fill(-1);
  focusRegions = [];
  blurComposite = null;
  state = STATE_BLUE_SCANNING;
  finalExportDone = false;
  downloadBtn.style('display', 'none');
  downloadFocusBtn.style('display', 'none');
  statusP.html('图像频谱报告生成中...');
  loop();
  redraw();
}

function initGridSystem() {
  let shortSide = min(imgWidth, imgHeight);
  gridSize = Math.max(3, Math.floor(shortSide * 0.04));
  gridCols = Math.ceil(imgWidth / gridSize);
  gridRows = Math.ceil(imgHeight / gridSize);
  gridScore = [];
  for (let r = 0; r < gridRows; r++) {
    gridScore[r] = new Array(gridCols).fill(0);
  }
  redCoveredGrid = [];
  for (let r = 0; r < gridRows; r++) {
    redCoveredGrid[r] = new Array(gridCols).fill(false);
  }
}

function markRedCoverage() {
  for (let x = 0; x < imgWidth; x++) {
    let y = redYPositions[x];
    let c = Math.floor(x / gridSize);
    let r = Math.floor(y / gridSize);
    for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        let nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols) {
          redCoveredGrid[nr][nc] = true;
        }
      }
    }
  }
}

function applyRedCoverageMask() {
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (!redCoveredGrid[r][c]) {
        gridScore[r][c] = 0;
      }
    }
  }
}

function addScoreRect(xStart, xEnd, yStart, yEnd, score) {
  let c1 = Math.max(0, Math.floor(xStart / gridSize));
  let c2 = Math.min(gridCols - 1, Math.floor(xEnd / gridSize));
  let r1 = Math.max(0, Math.floor(yStart / gridSize));
  let r2 = Math.min(gridRows - 1, Math.floor(yEnd / gridSize));
  for (let c = c1; c <= c2; c++) {
    for (let r = r1; r <= r2; r++) {
      gridScore[r][c] += score;
    }
  }
}

function addScorePoint(x, y, radiusX, radiusY, score) {
  let c = Math.floor(x / gridSize);
  let r = Math.floor(y / gridSize);
  let radC = Math.max(1, Math.ceil(radiusX / gridSize));
  let radR = Math.max(1, Math.ceil(radiusY / gridSize));
  for (let dr = -radR; dr <= radR; dr++) {
    for (let dc = -radC; dc <= radC; dc++) {
      let nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols) {
        let dist = Math.sqrt((dr * dr) / (radR * radR) + (dc * dc) / (radC * radC));
        let weight = Math.max(0, 1 - dist * 0.6);
        gridScore[nr][nc] += score * weight;
      }
    }
  }
}

function runFocusAnalysis() {
  if (imgWidth < 10 || imgHeight < 10) return;

  let windowSize = Math.max(5, Math.floor(imgWidth * 0.05));
  let halfW = Math.floor(windowSize / 2);

  let redLocalVar = [];
  let redStability = [];

  for (let i = 0; i < imgWidth; i++) {
    let s = Math.max(0, i - halfW);
    let e = Math.min(imgWidth - 1, i + halfW);
    let cnt = e - s + 1;
    let sum = 0;
    for (let j = s; j <= e; j++) sum += redYPositions[j];
    let mean = sum / cnt;
    let varSum = 0;
    for (let j = s; j <= e; j++) {
      let d = redYPositions[j] - mean;
      varSum += d * d;
    }
    let variance = varSum / cnt;
    redLocalVar.push(variance);
  }

  for (let i = 0; i < imgWidth; i++) {
    let normVar = redLocalVar[i] / (imgHeight * imgHeight);
    redStability.push(constrain(1.0 - normVar * 40, 0, 1));
  }

  let lockSegments = [];
  let inLock = false;
  let lockStart = 0;

  for (let i = 0; i < imgWidth; i++) {
    if (redStability[i] > 0.35) {
      if (!inLock) { inLock = true; lockStart = i; }
    } else {
      if (inLock) {
        let segLen = i - lockStart;
        if (segLen >= gridSize) {
          lockSegments.push({ xStart: lockStart, xEnd: i - 1, length: segLen });
        }
        inLock = false;
      }
    }
  }
  if (inLock && imgWidth - lockStart >= gridSize) {
    lockSegments.push({ xStart: lockStart, xEnd: imgWidth - 1, length: imgWidth - lockStart });
  }


  let sortedY = [...redYPositions].sort((a, b) => a - b);
  let medianY = sortedY[Math.floor(sortedY.length * 0.5)];
  let lowerQuartileY = sortedY[Math.floor(sortedY.length * 0.25)];
  let crowdBase = max(medianY, lowerQuartileY);
  let minBirdHeight = imgHeight * 0.06;

  let spikeCandidates = [];
  let inSpike = false;
  let spikeStart = 0;
  let spikeMinY = imgHeight;
  let spikeMinX = 0;

  for (let i = 0; i < imgWidth; i++) {
    let y = redYPositions[i];
    let isAbove = (y < crowdBase - minBirdHeight);
    if (isAbove) {
      if (!inSpike) {
        inSpike = true;
        spikeStart = i;
        spikeMinY = y;
        spikeMinX = i;
      } else {
        if (y < spikeMinY) {
          spikeMinY = y;
          spikeMinX = i;
        }
      }
    } else {
      if (inSpike) {
        let spikeWidth = i - spikeStart;
        if (spikeWidth >= Math.max(2, Math.floor(imgWidth * 0.005)) && spikeWidth <= Math.floor(imgWidth * 0.06)) {
          spikeCandidates.push({
            xStart: spikeStart,
            xEnd: i - 1,
            xPeak: spikeMinX,
            yPeak: spikeMinY,
            width: spikeWidth,
            height: crowdBase - spikeMinY
          });
        }
        inSpike = false;
      }
    }
  }
  if (inSpike) {
    let spikeWidth = imgWidth - spikeStart;
    if (spikeWidth >= Math.max(2, Math.floor(imgWidth * 0.005)) && spikeWidth <= Math.floor(imgWidth * 0.06)) {
      spikeCandidates.push({
        xStart: spikeStart,
        xEnd: imgWidth - 1,
        xPeak: spikeMinX,
        yPeak: spikeMinY,
        width: spikeWidth,
        height: crowdBase - spikeMinY
      });
    }
  }

  let hasSignificantBirds = false;

  if (spikeCandidates.length >= 2) {
    let used = new Array(spikeCandidates.length).fill(false);
    for (let i = 0; i < spikeCandidates.length; i++) {
      if (used[i]) continue;
      let cluster = [spikeCandidates[i]];
      used[i] = true;
      for (let j = i + 1; j < spikeCandidates.length; j++) {
        if (used[j]) continue;
        let yDiff = Math.abs(spikeCandidates[j].yPeak - cluster[0].yPeak);
        let xGap = spikeCandidates[j].xStart - spikeCandidates[j - 1].xEnd;
        if (yDiff < imgHeight * 0.04 && xGap < imgWidth * 0.12) {
          cluster.push(spikeCandidates[j]);
          used[j] = true;
        }
      }
      if (cluster.length >= 2) {
        hasSignificantBirds = true;
        break;
      }
    }
  }

  if (!hasSignificantBirds) {
    for (let spike of spikeCandidates) {
      if (spike.height > imgHeight * 0.15) {
        hasSignificantBirds = true;
        break;
      }
    }
  }


  let segmentScores = [];

  for (let seg of lockSegments) {
    let sumStab = 0;
    let minY = imgHeight, maxY = 0;
    for (let x = seg.xStart; x <= seg.xEnd; x++) {
      sumStab += redStability[x];
      minY = Math.min(minY, redYPositions[x]);
      maxY = Math.max(maxY, redYPositions[x]);
    }
    let avgStab = sumStab / seg.length;
    let yRange = (maxY - minY) / imgHeight;
    let widthRatio = seg.length / imgWidth;

    let sumY = 0;
    for (let x = seg.xStart; x <= seg.xEnd; x++) sumY += redYPositions[x];
    let avgY = sumY / seg.length;

    let stabScore = avgStab > 0.7 ? 10 : (avgStab > 0.55 ? 6 : 3);
    let precisionScore = 0;
    if (yRange < 0.03) precisionScore = 8;
    else if (yRange < 0.06) precisionScore = 5;
    else if (yRange < 0.10) precisionScore = 3;
    else if (yRange < 0.15) precisionScore = 1;

    let lengthScore = widthRatio > 0.4 ? 4 : (widthRatio > 0.2 ? 2 : 1);

    let crowdPenalty = 0;
    if (yRange > 0.08 && widthRatio > 0.15) {
      crowdPenalty = -5;
    }

    let totalScore = stabScore + precisionScore + lengthScore + crowdPenalty;

    segmentScores.push({
      xStart: seg.xStart,
      xEnd: seg.xEnd,
      avgY: avgY,
      yRange: yRange,
      totalScore: Math.max(0, totalScore),
      widthRatio: widthRatio
    });

    let bandH = Math.max(imgHeight * 0.04, maxY - minY + gridSize * 2);
    let yCenter = (minY + maxY) / 2;
    let ySampStart = Math.max(0, Math.floor(yCenter - bandH / 2));
    let ySampEnd = Math.min(imgHeight - 1, Math.ceil(yCenter + bandH / 2));

    if (totalScore > 0) {
      addScoreRect(seg.xStart, seg.xEnd, ySampStart, ySampEnd, totalScore);
    }
  }

  for (let i = 1; i < segmentScores.length; i++) {
    let prev = segmentScores[i - 1];
    let curr = segmentScores[i];
    let yDiff = Math.abs(curr.avgY - prev.avgY);
    let gap = curr.xStart - prev.xEnd;

    if (yDiff > imgHeight * 0.04 && gap < imgWidth * 0.20) {
      addScoreRect(
        Math.max(0, prev.xEnd - imgWidth * 0.03), prev.xEnd + 1,
        Math.max(0, prev.avgY - imgHeight * 0.06), Math.min(imgHeight, prev.avgY + imgHeight * 0.06), 8
      );
      addScoreRect(
        curr.xStart - 1, Math.min(imgWidth, curr.xStart + imgWidth * 0.03),
        Math.max(0, curr.avgY - imgHeight * 0.06), Math.min(imgHeight, curr.avgY + imgHeight * 0.06), 8
      );
    }
  }


  let blueGrad = [];
  let maxBlueGrad = 0;
  for (let i = 1; i < imgWidth; i++) {
    let g = Math.abs(blueVolumeCurve[i] - blueVolumeCurve[i - 1]);
    blueGrad.push(g);
    if (g > maxBlueGrad) maxBlueGrad = g;
  }
  if (maxBlueGrad > 0) {
    for (let i = 1; i < imgWidth; i++) {
      let gradNorm = blueGrad[i - 1] / maxBlueGrad;
      if (gradNorm > 0.4 && redStability[i] > 0.35) {
        addScorePoint(i, redYPositions[i], imgWidth * 0.03, imgHeight * 0.08, 4);
      }
    }
  }

  let avgBlueGrad = 0;
  for (let g of blueGrad) avgBlueGrad += g;
  avgBlueGrad /= blueGrad.length;
  let isBlueFlat = maxBlueGrad > 0 && avgBlueGrad < maxBlueGrad * 0.15;

  if (isBlueFlat) {
    for (let seg of segmentScores) {
      if (seg.yRange < imgHeight * 0.05) {
        let bonusW = seg.widthRatio > 0.15 ? 5 : 8;
        addScoreRect(
          seg.xStart, seg.xEnd,
          Math.max(0, seg.avgY - imgHeight * 0.05),
          Math.min(imgHeight, seg.avgY + imgHeight * 0.05),
          bonusW
        );
      }
    }
  }

 
  let hueHistogram = new Array(256).fill(0);
  let totalHueSamples = 0;
  let step = Math.max(1, Math.floor(gridSize / 2));

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (!redCoveredGrid[r][c]) continue;
      let xStart = c * gridSize;
      let xEnd = Math.min(imgWidth - 1, (c + 1) * gridSize);
      let yStart = r * gridSize;
      let yEnd = Math.min(imgHeight - 1, (r + 1) * gridSize);
      for (let x = xStart; x <= xEnd; x += step) {
        for (let y = yStart; y <= yEnd; y += step) {
          let { r: red, g, b } = getRGB(x, y);
          let hsb = rgbToHSB(red, g, b);
          if (hsb.s > 30) {
            let hueBin = Math.floor(hsb.h);
            hueHistogram[hueBin]++;
            totalHueSamples++;
          }
        }
      }
    }
  }

  if (totalHueSamples > 50) {
    let windowWidth = 60;
    let maxCount = 0;
    let dominantHueStart = 0;
    for (let i = 0; i < 256; i++) {
      let count = 0;
      for (let j = 0; j < windowWidth; j++) {
        count += hueHistogram[(i + j) % 256];
      }
      if (count > maxCount) {
        maxCount = count;
        dominantHueStart = i;
      }
    }
    let dominantRatio = maxCount / totalHueSamples;

    if (dominantRatio > 0.40) {
      let dominantCenter = (dominantHueStart + windowWidth / 2) % 256;

      for (let r = 0; r < gridRows; r++) {
        for (let c = 0; c < gridCols; c++) {
          if (!redCoveredGrid[r][c]) continue;
          let xStart = c * gridSize;
          let xEnd = Math.min(imgWidth - 1, (c + 1) * gridSize);
          let yStart = r * gridSize;
          let yEnd = Math.min(imgHeight - 1, (r + 1) * gridSize);

          let hueSum = 0;
          let hueCount = 0;
          for (let x = xStart; x <= xEnd; x += step) {
            for (let y = yStart; y <= yEnd; y += step) {
              let { r: red, g, b } = getRGB(x, y);
              let hsb = rgbToHSB(red, g, b);
              if (hsb.s > 30) {
                hueSum += hsb.h;
                hueCount++;
              }
            }
          }

          if (hueCount > 0) {
            let avgHue = hueSum / hueCount;
            let dominantHueEnd = (dominantHueStart + windowWidth) % 256;

            let isDominantHue = false;
            if (dominantHueStart < dominantHueEnd) {
              isDominantHue = (avgHue >= dominantHueStart && avgHue <= dominantHueEnd);
            } else {
              isDominantHue = (avgHue >= dominantHueStart || avgHue <= dominantHueEnd);
            }

            let hueDiff = Math.abs(avgHue - dominantCenter);
            if (hueDiff > 128) hueDiff = 256 - hueDiff;

            if (isDominantHue) {
              gridScore[r][c] = Math.floor(gridScore[r][c] * 0.2);
              for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                  let nr = r + dr, nc = c + dc;
                  if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols && (dr !== 0 || dc !== 0)) {
                    gridScore[nr][nc] = Math.floor(gridScore[nr][nc] * 0.5);
                  }
                }
              }
            } else if (hueDiff > 40) {
              let bonus = dominantRatio > 0.6 ? 15 : 10;
              gridScore[r][c] += bonus;
              for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                  let nr = r + dr, nc = c + dc;
                  if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols && (dr !== 0 || dc !== 0)) {
                    gridScore[nr][nc] += Math.floor(bonus * 0.4);
                  }
                }
              }
            }
          }
        }
      }
    }
  }


  let vividGrid = [];
  for (let r = 0; r < gridRows; r++) {
    vividGrid[r] = new Array(gridCols).fill(0);
  }

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (!redCoveredGrid[r][c]) continue;
      let xStart = c * gridSize;
      let xEnd = Math.min(imgWidth - 1, (c + 1) * gridSize);
      let yStart = r * gridSize;
      let yEnd = Math.min(imgHeight - 1, (r + 1) * gridSize);

      let vividCount = 0;
      let totalCount = 0;
      let step2 = Math.max(1, Math.floor(gridSize / 3));

      for (let x = xStart; x <= xEnd; x += step2) {
        for (let y = yStart; y <= yEnd; y += step2) {
          let { r: red, g, b } = getRGB(x, y);
          let hsb = rgbToHSB(red, g, b);
          totalCount++;
          if (hsb.s > 160 && hsb.v > 120) {
            vividCount++;
          }
        }
      }

      let vividRatio = totalCount > 0 ? vividCount / totalCount : 0;

      let gridCenterY = (r + 0.5) * gridSize;
      if (hasSignificantBirds && Math.abs(gridCenterY - crowdBase) < imgHeight * 0.08) {
        vividGrid[r][c] = 0;
      } else if (vividRatio > 0.25) {
        vividGrid[r][c] = 6;
      } else if (vividRatio > 0.15) {
        vividGrid[r][c] = 4;
      } else if (vividRatio > 0.08) {
        vividGrid[r][c] = 2;
      }
    }
  }

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (vividGrid[r][c] > 0) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            let nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols) {
              let weight = (dr === 0 && dc === 0) ? 1.0 : 0.3;
              gridScore[nr][nc] += vividGrid[r][c] * weight;
            }
          }
        }
      }
    }
  }

  // ============================================================
  // ★ 红色区域补丁（扩大搜索范围，不限于 redCoveredGrid）
  //    H: 245~255 (345°~360°), S>204 (80%), V>140 (55%)
  //    在整个图像中搜索，但仅在红色轨迹线上下 15% 高度范围内加分
  // ============================================================
  let trajBandTop = imgHeight;
  let trajBandBottom = 0;
  for (let x = 0; x < imgWidth; x++) {
    let y = redYPositions[x];
    trajBandTop = Math.min(trajBandTop, y);
    trajBandBottom = Math.max(trajBandBottom, y);
  }
  // 扩展为轨迹整体范围 + 上下各 15%
  let bandMargin = imgHeight * 0.15;
  let searchYStart = Math.max(0, Math.floor(trajBandTop - bandMargin));
  let searchYEnd = Math.min(imgHeight - 1, Math.ceil(trajBandBottom + bandMargin));

  let redPatchGrid = [];
  for (let r = 0; r < gridRows; r++) {
    redPatchGrid[r] = new Array(gridCols).fill(0);
  }

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      let gridYCenter = (r + 0.5) * gridSize;
      // 只检查在搜索范围内的网格
      if (gridYCenter < searchYStart || gridYCenter > searchYEnd) continue;

      let xStart = c * gridSize;
      let xEnd = Math.min(imgWidth - 1, (c + 1) * gridSize);
      let yStart = r * gridSize;
      let yEnd = Math.min(imgHeight - 1, (r + 1) * gridSize);

      let redCount = 0;
      let totalCount = 0;
      let step2 = Math.max(1, Math.floor(gridSize / 3));

      for (let x = xStart; x <= xEnd; x += step2) {
        for (let y = yStart; y <= yEnd; y += step2) {
          let { r: red, g, b } = getRGB(x, y);
          let hsb = rgbToHSB(red, g, b);
          totalCount++;
          // 主要条件：H: 245~255 (345°~360°), S>204 (80%), V>140 (55%)
          // 宽松条件：H: 240~255 或 0~10（红色附近），S>160, V>120
          let isRed = (hsb.h >= 245 && hsb.s > 204 && hsb.v > 140) ||
                      ((hsb.h >= 240 || hsb.h <= 10) && hsb.s > 185 && hsb.v > 130);
          if (isRed) redCount++;
        }
      }

      let redRatio = totalCount > 0 ? redCount / totalCount : 0;

      if (redRatio > 0.20) {
        redPatchGrid[r][c] = 18;
      } else if (redRatio > 0.10) {
        redPatchGrid[r][c] = 14;
      } else if (redRatio > 0.05) {
        redPatchGrid[r][c] = 10;
      }
    }
  }

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (redPatchGrid[r][c] > 0) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            let nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols) {
              let weight = (dr === 0 && dc === 0) ? 1.0 : 0.4;
              gridScore[nr][nc] += redPatchGrid[r][c] * weight;
            }
          }
        }
      }
    }
  }



  let minTriggerRun = Math.max(gridSize, Math.floor(imgWidth * 0.015));
  let inTrigger = false;
  let triggerStart = 0;

  for (let x = 0; x < imgWidth; x++) {
    if (redTriggeredByVivid[x]) {
      if (!inTrigger) {
        inTrigger = true;
        triggerStart = x;
      }
    } else {
      if (inTrigger) {
        let runLength = x - triggerStart;
        if (runLength >= minTriggerRun) {
          let avgYRun = 0;
          for (let k = triggerStart; k < x; k++) avgYRun += redYPositions[k];
          avgYRun /= runLength;
          let bandH2 = imgHeight * 0.05;
          let yStart2 = Math.max(0, Math.floor(avgYRun - bandH2 / 2));
          let yEnd2 = Math.min(imgHeight - 1, Math.ceil(avgYRun + bandH2 / 2));
          addScoreRect(triggerStart, x - 1, yStart2, yEnd2, 20);
        }
        inTrigger = false;
      }
    }
  }
  if (inTrigger) {
    let runLength = imgWidth - triggerStart;
    if (runLength >= minTriggerRun) {
      let avgYRun = 0;
      for (let k = triggerStart; k < imgWidth; k++) avgYRun += redYPositions[k];
      avgYRun /= runLength;
      let bandH2 = imgHeight * 0.05;
      let yStart2 = Math.max(0, Math.floor(avgYRun - bandH2 / 2));
      let yEnd2 = Math.min(imgHeight - 1, Math.ceil(avgYRun + bandH2 / 2));
      addScoreRect(triggerStart, imgWidth - 1, yStart2, yEnd2, 20);
    }
  }


  if (spikeCandidates.length >= 2) {
    let used = new Array(spikeCandidates.length).fill(false);

    for (let i = 0; i < spikeCandidates.length; i++) {
      if (used[i]) continue;

      let cluster = [spikeCandidates[i]];
      used[i] = true;

      for (let j = i + 1; j < spikeCandidates.length; j++) {
        if (used[j]) continue;
        let yDiff = Math.abs(spikeCandidates[j].yPeak - cluster[0].yPeak);
        let xGap = spikeCandidates[j].xStart - spikeCandidates[j - 1].xEnd;
        if (yDiff < imgHeight * 0.04 && xGap < imgWidth * 0.12) {
          cluster.push(spikeCandidates[j]);
          used[j] = true;
        }
      }

      if (cluster.length >= 2) {
        let totalY = 0;
        let minX = imgWidth, maxX = 0;
        for (let c of cluster) {
          totalY += c.yPeak;
          minX = Math.min(minX, c.xStart);
          maxX = Math.max(maxX, c.xEnd);
        }
        let avgPeakY = totalY / cluster.length;
        let margin = Math.floor((maxX - minX) * 0.15);
        let boxXStart = Math.max(0, minX - margin);
        let boxXEnd = Math.min(imgWidth - 1, maxX + margin);

        let birdBandH = imgHeight * 0.06;
        let birdYStart = Math.max(0, Math.floor(avgPeakY - birdBandH / 2));
        let birdYEnd = Math.min(imgHeight - 1, Math.ceil(avgPeakY + birdBandH / 2));

        let birdThresholdY = crowdBase - minBirdHeight;
        let firstBirdX = -1, lastBirdX = -1;
        for (let xx = boxXStart; xx <= boxXEnd; xx++) {
          if (redYPositions[xx] < birdThresholdY) {
            if (firstBirdX === -1) firstBirdX = xx;
            lastBirdX = xx;
          }
        }
        if (firstBirdX !== -1) {
          addScoreRect(firstBirdX, lastBirdX, birdYStart, birdYEnd, 18);
        }
      }
    }
  }

  for (let spike of spikeCandidates) {
    if (spike.height > imgHeight * 0.15) {
      let birdBandH = imgHeight * 0.05;
      let birdYStart = Math.max(0, Math.floor(spike.yPeak - birdBandH / 2));
      let birdYEnd = Math.min(imgHeight - 1, Math.ceil(spike.yPeak + birdBandH / 2));
      let margin = Math.floor(spike.width * 0.3);
      let boxXStart = Math.max(0, spike.xStart - margin);
      let boxXEnd = Math.min(imgWidth - 1, spike.xEnd + margin);

      // ♻️ 先扫描列范围，只调一次 addScoreRect
      let birdThresholdY = crowdBase - minBirdHeight;
      let firstBirdX = -1, lastBirdX = -1;
      for (let xx = boxXStart; xx <= boxXEnd; xx++) {
        if (redYPositions[xx] < birdThresholdY) {
          if (firstBirdX === -1) firstBirdX = xx;
          lastBirdX = xx;
        }
      }
      if (firstBirdX !== -1) {
        addScoreRect(firstBirdX, lastBirdX, birdYStart, birdYEnd, 14);
      
      }
    }
  }
}

function boxesOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function selectFocusRegions() {
  if (gridCols < 2 || gridRows < 2) return [];

  let allScores = [];
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (gridScore[r][c] > 0) allScores.push(gridScore[r][c]);
    }
  }
  if (allScores.length < 4) return [];

  let sum = 0;
  for (let s of allScores) sum += s;
  let mean = sum / allScores.length;
  let sqSum = 0;
  for (let s of allScores) sqSum += (s - mean) * (s - mean);
  let stdDev = Math.sqrt(sqSum / allScores.length);

  let threshold = Math.max(3, mean + 0.4 * stdDev);

  let active = [];
  for (let r = 0; r < gridRows; r++) {
    active[r] = new Array(gridCols).fill(false);
    for (let c = 0; c < gridCols; c++) {
      if (gridScore[r][c] > threshold) active[r][c] = true;
    }
  }

  let activeCount = 0;
  for (let r = 0; r < gridRows; r++)
    for (let c = 0; c < gridCols; c++)
      if (active[r][c]) activeCount++;

  if (activeCount < 3) {
    threshold = Math.max(2, mean + 0.1 * stdDev);
    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        active[r][c] = gridScore[r][c] > threshold;
      }
    }
    activeCount = 0;
    for (let r = 0; r < gridRows; r++)
      for (let c = 0; c < gridCols; c++)
        if (active[r][c]) activeCount++;
    if (activeCount < 3) return [];
  }

  let visited = [];
  for (let r = 0; r < gridRows; r++) visited[r] = new Array(gridCols).fill(false);

  let components = [];

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (active[r][c] && !visited[r][c]) {
        let cells = [];
        let queue = [{ r, c }];
        visited[r][c] = true;
        while (queue.length > 0) {
          let cur = queue.shift();
          cells.push(cur);
          for (let [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
            let nr = cur.r + dr, nc = cur.c + dc;
            if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols &&
                active[nr][nc] && !visited[nr][nc]) {
              visited[nr][nc] = true;
              queue.push({ r: nr, c: nc });
            }
          }
        }

        let minC = gridCols, maxC = 0, minR = gridRows, maxR = 0;
        let totalScore = 0;
        for (let cell of cells) {
          minC = Math.min(minC, cell.c);
          maxC = Math.max(maxC, cell.c);
          minR = Math.min(minR, cell.r);
          maxR = Math.max(maxR, cell.r);
          totalScore += gridScore[cell.r][cell.c];
        }

        components.push({
          x: minC * gridSize,
          y: minR * gridSize,
          w: (maxC - minC + 1) * gridSize,
          h: (maxR - minR + 1) * gridSize,
          totalScore: totalScore,
          avgScore: totalScore / cells.length,
          cellCount: cells.length,
          centerR: (minR + maxR) / 2,
          minC, maxC, minR, maxR
        });
      }
    }
  }

  components.sort((a, b) => b.totalScore - a.totalScore);

  let selected = [];
  for (let comp of components) {
    if (comp.avgScore < threshold * 0.5) continue;
    let overlaps = false;
    for (let sel of selected) {
      if (boxesOverlap(
        { x: comp.x, y: comp.y, w: comp.w, h: comp.h },
        { x: sel.x, y: sel.y, w: sel.w, h: sel.h }
      )) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      selected.push(comp);
      if (selected.length >= 6) break;
    }
  }

  if (selected.length === 0 && components.length > 0) {
    selected.push(components[0]);
  }

  let expanded = [];
  for (let reg of selected) {
    let eMinC, eMaxC, eMinR, eMaxR;

    if (reg.minC !== undefined) {
      eMinC = reg.minC;
      eMaxC = reg.maxC;
      eMinR = reg.minR;
      eMaxR = reg.maxR;
    } else {
      eMinC = Math.floor(reg.x / gridSize);
      eMaxC = Math.floor((reg.x + reg.w) / gridSize);
      eMinR = Math.floor(reg.y / gridSize);
      eMaxR = Math.floor((reg.y + reg.h) / gridSize);
    }

    let extR = 1;
    let extC = 1;

    eMinR = Math.max(0, eMinR - extR);
    eMaxR = Math.min(gridRows - 1, eMaxR + extR);
    eMinC = Math.max(0, eMinC - extC);
    eMaxC = Math.min(gridCols - 1, eMaxC + extC);

    let pad = Math.floor(gridSize * 0.3);
    expanded.push({
      x: Math.max(0, eMinC * gridSize - pad),
      y: Math.max(0, eMinR * gridSize - pad),
      w: Math.min(imgWidth - eMinC * gridSize + pad, (eMaxC - eMinC + 1) * gridSize + pad * 2),
      h: Math.min(imgHeight - eMinR * gridSize + pad, (eMaxR - eMinR + 1) * gridSize + pad * 2),
      totalScore: reg.totalScore
    });
  }

  let totalArea = imgWidth * imgHeight;
  let maxSingleArea = totalArea * 0.25;
  let maxTotalArea = totalArea * 0.60;

  for (let i = 0; i < expanded.length; i++) {
    let box = expanded[i];
    let area = box.w * box.h;
    if (area > maxSingleArea) {
      let ratio = Math.sqrt(maxSingleArea / area);
      let newW = Math.floor(box.w * ratio);
      let newH = Math.floor(box.h * ratio);
      let dw = box.w - newW;
      let dh = box.h - newH;
      box.x += Math.floor(dw / 2);
      box.y += Math.floor(dh / 2);
      box.w = newW;
      box.h = newH;
    }
  }

  let totalBoxArea = 0;
  for (let box of expanded) totalBoxArea += box.w * box.h;

  if (totalBoxArea > maxTotalArea && expanded.length > 0) {
    let scale = Math.sqrt(maxTotalArea / totalBoxArea);
    for (let box of expanded) {
      let newW = Math.floor(box.w * scale);
      let newH = Math.floor(box.h * scale);
      let dw = box.w - newW;
      let dh = box.h - newH;
      box.x += Math.floor(dw / 2);
      box.y += Math.floor(dh / 2);
      box.w = newW;
      box.h = newH;
    }
  }

  return expanded;
}

function renderBlurComposite() {
  if (!img || focusRegions.length === 0) {
    blurComposite = null;
    return;
  }

  let buf = createGraphics(canvasWidth, canvasHeight);
  let sx = imgDrawW / imgWidth;
  let sy = imgDrawH / imgHeight;

  let blurred = createGraphics(imgDrawW, imgDrawH);
  blurred.image(img, 0, 0, imgDrawW, imgDrawH);
  blurred.filter(BLUR, 8);
  buf.image(blurred, imgDrawX, imgDrawY);
  blurred.remove();

  for (let reg of focusRegions) {
    let cx = imgDrawX + reg.x * sx;
    let cy = imgDrawY + reg.y * sy;
    let cw = reg.w * sx;
    let ch = reg.h * sy;
    let clearPart = createGraphics(cw, ch);
    clearPart.image(img, 0, 0, cw, ch, reg.x, reg.y, reg.w, reg.h);
    buf.image(clearPart, cx, cy);
    clearPart.remove();
  }

  buf.push();
  buf.stroke(255, 0, 0, RED_ALPHA);
  buf.strokeWeight(1);
  buf.noFill();
  buf.beginShape();
  for (let i = 0; i < imgWidth; i++) {
    buf.vertex(
      map(i, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW),
      map(redYPositions[i], 0, imgHeight, imgDrawY, imgDrawY + imgDrawH)
    );
  }
  buf.endShape();
  buf.pop();

  buf.push();
  buf.stroke(BLUE_R, BLUE_G, BLUE_B, BLUE_ALPHA);
  buf.strokeWeight(1);
  buf.noFill();
  buf.beginShape();
  for (let i = 0; i < imgWidth; i++) {
    if (blueVolumeCurve[i] !== -1) {
      buf.vertex(
        map(i, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW),
        map(blueVolumeCurve[i], 0, imgHeight, imgDrawY, imgDrawY + imgDrawH)
      );
    }
  }
  buf.endShape();
  buf.pop();

  buf.stroke(255);
  buf.strokeWeight(1);
  buf.noFill();
  for (let reg of focusRegions) {
    buf.rect(
      imgDrawX + reg.x * sx,
      imgDrawY + reg.y * sy,
      reg.w * sx,
      reg.h * sy
    );
  }

  blurComposite = buf;
}

function downloadResult() {
  if (!img || !finalExportDone) return;
  let result = createGraphics(imgWidth, imgHeight);
  result.image(img, 0, 0);

  result.stroke(255, 0, 0, RED_ALPHA);
  result.strokeWeight(1);
  result.noFill();
  result.beginShape();
  for (let i = 0; i < imgWidth; i++) result.vertex(i, redYPositions[i]);
  result.endShape();

  result.stroke(BLUE_R, BLUE_G, BLUE_B, BLUE_ALPHA);
  result.strokeWeight(2);
  result.beginShape();
  for (let i = 0; i < imgWidth; i++) {
    if (blueVolumeCurve[i] !== -1) result.vertex(i, blueVolumeCurve[i]);
  }
  result.endShape();

  save(result, 'final_output.png');
}

function downloadFocusPhoto() {
  if (!img || focusRegions.length === 0) return;

  let sx = imgDrawW / imgWidth;
  let sy = imgDrawH / imgHeight;
  let result = createGraphics(canvasWidth, canvasHeight);

  let blurred = createGraphics(imgDrawW, imgDrawH);
  blurred.image(img, 0, 0, imgDrawW, imgDrawH);
  blurred.filter(BLUR, 8);
  result.image(blurred, imgDrawX, imgDrawY);
  blurred.remove();

  for (let reg of focusRegions) {
    let cx = imgDrawX + reg.x * sx;
    let cy = imgDrawY + reg.y * sy;
    let cw = reg.w * sx;
    let ch = reg.h * sy;
    let clearPart = createGraphics(cw, ch);
    clearPart.image(img, 0, 0, cw, ch, reg.x, reg.y, reg.w, reg.h);
    result.image(clearPart, cx, cy);
    clearPart.remove();
  }

  result.push();
  result.stroke(255, 0, 0, RED_ALPHA);
  result.strokeWeight(1);
  result.noFill();
  result.beginShape();
  for (let i = 0; i < imgWidth; i++) {
    result.vertex(
      map(i, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW),
      map(redYPositions[i], 0, imgHeight, imgDrawY, imgDrawY + imgDrawH)
    );
  }
  result.endShape();
  result.pop();

  result.push();
  result.stroke(BLUE_R, BLUE_G, BLUE_B, BLUE_ALPHA);
  result.strokeWeight(1);
  result.noFill();
  result.beginShape();
  for (let i = 0; i < imgWidth; i++) {
    if (blueVolumeCurve[i] !== -1) {
      result.vertex(
        map(i, 0, imgWidth, imgDrawX, imgDrawX + imgDrawW),
        map(blueVolumeCurve[i], 0, imgHeight, imgDrawY, imgDrawY + imgDrawH)
      );
    }
  }
  result.endShape();
  result.pop();

  result.stroke(255);
  result.strokeWeight(1);
  result.noFill();
  for (let reg of focusRegions) {
    result.rect(
      imgDrawX + reg.x * sx,
      imgDrawY + reg.y * sy,
      reg.w * sx,
      reg.h * sy
    );
  }

  save(result, 'focus_photo.png');
}

function drawScoreDebug() {
  push();
  noStroke();

  let maxScore = 0;
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (gridScore[r][c] > maxScore) maxScore = gridScore[r][c];
    }
  }
  if (maxScore < 1) { pop(); return; }

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      let score = gridScore[r][c];
      if (score <= 0) continue;

      let intensity = constrain(score / maxScore, 0, 1);
      let gx = imgDrawX + c * gridSize * (imgDrawW / imgWidth);
      let gy = imgDrawY + r * gridSize * (imgDrawH / imgHeight);
      let gw = gridSize * (imgDrawW / imgWidth);
      let gh = gridSize * (imgDrawH / imgHeight);
      let rCol = Math.floor(intensity * 255);
      let gCol = Math.floor((1 - Math.abs(intensity - 0.5) * 2) * 200);
      let bCol = Math.floor((1 - intensity) * 200);
      fill(rCol, gCol, bCol, 180);
      rect(gx, gy, gw, gh);
      if (gw > 14 && gh > 10) {
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(Math.min(gw * 0.35, 10));
        text(Math.round(score), gx + gw / 2, gy + gh / 2);
      }
    }
  }

  fill(0, 0, 0, 180);
  noStroke();
  rect(imgDrawX, imgDrawY + imgDrawH + 5, 200, 18);
  for (let i = 0; i < 100; i++) {
    let t = i / 99;
    fill(Math.floor(t * 255), Math.floor((1 - Math.abs(t - 0.5) * 2) * 200), Math.floor((1 - t) * 200));
    rect(imgDrawX + i * 2, imgDrawY + imgDrawH + 6, 2, 16);
  }
  fill(255);
  textSize(10);
  textAlign(LEFT, CENTER);
  text('0', imgDrawX, imgDrawY + imgDrawH + 5);
  textAlign(RIGHT, CENTER);
  text(maxScore.toFixed(0), imgDrawX + 200, imgDrawY + imgDrawH + 5);
  textAlign(LEFT, CENTER);
  text('D:关闭调试', imgDrawX + 210, imgDrawY + imgDrawH + 5);

  pop();
}

function keyPressed() {
  if (key === 'D' || key === 'd') {
    debugShowScores = !debugShowScores;
    redraw();
  }
}

function showUploadModal() {
  if (uploadModal) uploadModal.style('display', 'flex');
}

function hideUploadModal() {
  if (uploadModal) uploadModal.style('display', 'none');
}

function openExhibition() {
  window.open('exhibition.html', '_blank');
}


function uploadToExhibition() {
  if (!img || !finalExportDone) return;
  hideUploadModal();
  statusP.html('正在上传至悬置之海...');

  generateExhibitionThumbnail().then(thumbnail => {
    const data = {
      id: Date.now(),
      red_line: redYPositions,
      blue_line: blueVolumeCurve,
      width: imgWidth,
      height: imgHeight,
      thumbnail: thumbnail,
      timestamp: Date.now(),
      starred: false
    };

    fetch(`${SUPABASE_URL}/rest/v1/photos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify(data)
    }).then(res => {
      if (res.ok) {
        statusP.html('✅ 已上传至悬置之海！');
      } else {
        statusP.html('❌ 上传失败，请重试');
      }
    }).catch(err => {
      console.error(err);
      statusP.html('❌ 网络错误');
    });
  });
}

function generateExhibitionThumbnail() {
  return new Promise((resolve) => {
    
    let pg = createGraphics(imgWidth, imgHeight);
    pg.image(img, 0, 0);

    pg.stroke(255, 0, 0, RED_ALPHA);
    pg.strokeWeight(1);
    pg.noFill();
    pg.beginShape();
    for (let i = 0; i < imgWidth; i++) pg.vertex(i, redYPositions[i]);
    pg.endShape();

    pg.stroke(BLUE_R, BLUE_G, BLUE_B, BLUE_ALPHA);
    pg.strokeWeight(2);
    pg.beginShape();
    for (let i = 0; i < imgWidth; i++) {
      if (blueVolumeCurve[i] !== -1) pg.vertex(i, blueVolumeCurve[i]);
    }
    pg.endShape();

 
    let quality = 0.8;
    let dataURL;
    let estimatedSize;
    do {
      dataURL = pg.elt.toDataURL('image/jpeg', quality);
      const base64Data = dataURL.split(',')[1];
      estimatedSize = base64Data.length * 0.75; // base64 → 字节
      quality -= 0.1;
    } while (estimatedSize > 200 * 1024 && quality > 0.1);

    pg.remove();
    resolve(dataURL);
  });
}
function windowResized() {}
