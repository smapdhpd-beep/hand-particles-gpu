import * as THREE from 'three';
import { HandTracker } from './handTracker.js';
import { GPUParticleSystem } from './particles.js';

/* ═══ hand-particles-gpu 主程序 ═══ */

const STATE = {
  gesture: 'idle',
  handPresent: false,
  handX: 0,
  handY: 0,
  handDepth: 0,
  openness: 0,
  pinchStrength: 0,
  forceMode: 0, // 0:引力 1:涡旋 2:排斥 3:布朗 4:简谐
  blackHoleStrength: 0,      // 当前黑洞强度（0~1，平滑插值）
  targetBlackHoleStrength: 0,// 目标黑洞强度
};
window.STATE = STATE;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050505, 0.02);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 100);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

if (!renderer.capabilities.isWebGL2) {
  document.getElementById('status').textContent = '错误：需要 WebGL 2.0 支持';
  throw new Error('WebGL 2.0 required');
}

let particleSystem;
try {
  particleSystem = new GPUParticleSystem(renderer, STATE);
  scene.add(particleSystem.points);
  console.log('GPUParticleSystem initialized:', particleSystem.count, 'particles');
} catch (err) {
  console.error(err);
  document.getElementById('status').textContent = 'GPU 粒子系统初始化失败：' + err.message;
  throw err;
}

const handTracker = new HandTracker((result) => {
  parseGesture(result, STATE);
});

let noHandFrames = 0, hasHandFrames = 0;
const NO_HAND_THRESHOLD = 5;
const HAS_HAND_THRESHOLD = 3;

function parseGesture(result, state) {
  const lm0 = result.multiHandLandmarks?.[0];
  const sc0 = result.multiHandedness?.[0]?.score ?? 0;
  let palmSize = 0;
  if (lm0) palmSize = dist3d(lm0[0], lm0[9]);

  if (!lm0 || sc0 < 0.6 || palmSize < 0.03) {
    noHandFrames++; hasHandFrames = 0;
    if (noHandFrames >= NO_HAND_THRESHOLD) state.handPresent = false;
    state.openness *= 0.9;
    state.pinchStrength *= 0.9;
    return;
  }

  noHandFrames = 0; hasHandFrames++;
  if (hasHandFrames < HAS_HAND_THRESHOLD) return;

  state.handPresent = true;
  const lm = lm0;

  // 手掌位置（镜像，符合自拍直觉）
  const idxMcp = lm[5];
  state.handX = (1.0 - idxMcp.x - 0.5) * 5.0;
  state.handY = -(idxMcp.y - 0.5) * 2.8;
  state.handDepth = THREE.MathUtils.clamp(-((lm[5].z + lm[9].z + lm[13].z) / 3) * 4.0, -1, 1);

  // 张开度
  const tips = [4, 8, 12, 16, 20];
  let sum = 0, cnt = 0;
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      sum += dist3d(lm[tips[i]], lm[tips[j]]); cnt++;
    }
  }
  state.openness = THREE.MathUtils.clamp((sum / cnt - 0.05) / 0.30, 0, 1);

  // 捏合强度
  const pinchDist = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
  const palmSize2d = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
  const pEnter = palmSize2d * 0.32;
  const pExit = palmSize2d * 0.52;
  state.pinchStrength = THREE.MathUtils.clamp((pExit - pinchDist) / (pExit - pEnter), 0, 1);

  // 黑洞触发：捏合或握拳
  const fist = isFist(lm);
  const blackHoleTrigger = state.pinchStrength > 0.35 || fist;
  state.targetBlackHoleStrength = blackHoleTrigger ? 1.0 : 0.0;

  // 手势 -> 力场模式
  // 捏合/握拳: 黑洞（mode 0 引力奇点作为底层，叠加黑洞螺旋）
  // 张开: 涡旋
  // 数字1: 排斥
  // 数字2: 布朗
  // 数字3: 简谐
  const digit = detectDigit(lm);
  if (blackHoleTrigger) {
    state.gesture = fist ? 'fist' : 'pinch';
    state.forceMode = 0;
  } else if (digit === 1) {
    state.gesture = 'digit1';
    state.forceMode = 2;
  } else if (digit === 2) {
    state.gesture = 'digit2';
    state.forceMode = 3;
  } else if (digit === 3) {
    state.gesture = 'digit3';
    state.forceMode = 4;
  } else {
    state.gesture = 'idle';
    state.forceMode = 1; // 默认涡旋
  }

  updateStatus();
}

function detectDigit(lm) {
  const idxExt = isFingerExtended(lm, 8, 6);
  const midExt = isFingerExtended(lm, 12, 10);
  const ringExt = isFingerExtended(lm, 16, 14);
  const pinkyExt = isFingerExtended(lm, 20, 18);
  if (idxExt && !midExt && !ringExt && !pinkyExt) return 1;
  if (idxExt && midExt && !ringExt && !pinkyExt) return 2;
  if (idxExt && midExt && ringExt && !pinkyExt) return 3;
  return 0;
}

function isFingerExtended(lm, tipIdx, pipIdx) {
  const wrist = lm[0];
  return dist3d(lm[tipIdx], wrist) > dist3d(lm[pipIdx], wrist) * 1.15;
}

function isFist(lm) {
  // 四指指尖到手腕的距离均小于对应 PIP 关节到手腕的距离，则判定为握拳
  const fingers = [
    { tip: 8, pip: 6 },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 },
  ];
  for (const f of fingers) {
    if (dist3d(lm[f.tip], lm[0]) > dist3d(lm[f.pip], lm[0]) * 1.08) return false;
  }
  // 拇指收向掌心：拇指尖到食指根部的距离小于拇指 IP 到食指根部
  return dist3d(lm[4], lm[5]) < dist3d(lm[3], lm[5]) * 1.15;
}

function dist3d(a, b) {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
}

function updateStatus() {
  const modeNames = ['引力奇点', '涡旋', '排斥', '布朗运动', '简谐震荡'];
  const bh = STATE.blackHoleStrength > 0.05 ? ` | 黑洞:${(STATE.blackHoleStrength*100).toFixed(0)}%` : '';
  document.getElementById('status').textContent =
    `模式:${modeNames[STATE.forceMode]} | 手势:${STATE.gesture} | O:${(STATE.openness*100).toFixed(0)}%${bh}`;
}

const clock = new THREE.Clock();
let frameCount = 0, lastFpsTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsedTime();

  // 黑洞强度平滑插值：形成约 1.0 秒淡入，0.35 秒快速淡出，避免残影圆环
  const target = STATE.targetBlackHoleStrength;
  const speed = target > STATE.blackHoleStrength ? 1.0 : 2.8;
  STATE.blackHoleStrength += (target - STATE.blackHoleStrength) * Math.min(speed * dt, 1.0);
  if (Math.abs(STATE.blackHoleStrength - target) < 0.001) STATE.blackHoleStrength = target;

  // 极缓慢的相机漂移，增强空间纵深感
  camera.position.x = Math.sin(t * 0.08) * 0.15;
  camera.position.y = Math.cos(t * 0.06) * 0.12;
  camera.lookAt(0, 0, 0);

  particleSystem.update(dt, t);
  renderer.render(scene, camera);

  frameCount++;
  if (performance.now() - lastFpsTime > 1000) {
    document.getElementById('fps').textContent = frameCount + ' FPS';
    frameCount = 0;
    lastFpsTime = performance.now();
    updateStatus();
  }
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

updateStatus();
