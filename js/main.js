import * as THREE from 'three';
import { HandTracker } from './handTracker.js';
import { GPUParticleSystem } from './particles.js';
import { AudioEngine } from './audio.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ═══ hand-particles-gpu 主程序 ═══ */

const STATE = {
  gesture: 'idle',
  handPresent: false,
  handCount: 0,
  // 主手（camera 左侧，排序后 slot 0）
  handX: 0,
  handY: 0,
  handDepth: 0,
  openness: 0,
  pinchStrength: 0,
  forceMode: 0, // 0:引力 1:涡旋 2:排斥 3:布朗 4:简谐
  blackHoleStrength: 0,
  targetBlackHoleStrength: 0,
  // 副手（camera 右侧，排序后 slot 1）
  hand2Present: false,
  hand2X: 0,
  hand2Y: 0,
  hand2Depth: 0,
  blackHoleStrength2: 0,
  targetBlackHoleStrength2: 0,
  // 双手靠近时进入 8 字形合并模式（0=独立，1=8 字）
  figure8Active: 0,
};
window.STATE = STATE;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050505, 0.02);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 100);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
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

// 后期处理：Bloom 让暗粒子也有宇宙辉光，同时避免整体过曝
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,  // strength
  0.40,  // radius
  0.45   // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const handTracker = new HandTracker((result) => {
  parseGesture(result, STATE);
});

const audio = new AudioEngine();

// 音频仅在手势识别后启动（浏览器自动播放策略允许以摄像头授权作为交互）
function ensureAudio() {
  if (STATE.handPresent && !audio.started) audio.start();
}

const muteBtn = document.getElementById('mute-btn');
if (muteBtn) {
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const muted = audio.toggleMute();
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? '开启声音' : '静音';
  });
}

let noHandFrames = 0, hasHandFrames = 0;
const NO_HAND_THRESHOLD = 5;
const HAS_HAND_THRESHOLD = 3;

function parseGesture(result, state) {
  const hands = (result.multiHandLandmarks || []).slice(0, 2);
  const scores = (result.multiHandedness || []).map(h => h.score ?? 0);
  const validHands = hands.filter((_, i) => scores[i] >= 0.6);

  if (validHands.length === 0) {
    noHandFrames++; hasHandFrames = 0;
    if (noHandFrames >= NO_HAND_THRESHOLD) {
      state.handPresent = false;
      state.handCount = 0;
      state.targetBlackHoleStrength = 0;
      state.targetBlackHoleStrength2 = 0;
      state.hand2Present = false;
    }
    state.openness *= 0.9;
    state.pinchStrength *= 0.9;
    return;
  }

  noHandFrames = 0; hasHandFrames++;
  if (hasHandFrames < HAS_HAND_THRESHOLD) return;

  state.handPresent = true;
  state.handCount = validHands.length;
  ensureAudio();

  // 按手腕 x 排序，让左右手槽位稳定
  validHands.sort((a, b) => a[0].x - b[0].x);

  // 处理主手
  const h1 = processHand(validHands[0]);
  applyHandState(state, h1, 1);

  // 处理副手
  if (validHands.length >= 2) {
    const h2 = processHand(validHands[1]);
    applyHandState(state, h2, 2);
    // 双手靠近时进入 8 字合并模式：只有挨得很近（<0.25）才完全 8 字，分开（>0.9）则完全独立双黑洞
    const handDist = Math.hypot(h1.x - h2.x, h1.y - h2.y);
    state.figure8Active = THREE.MathUtils.smoothstep(0.9, 0.25, handDist);
  } else {
    state.hand2Present = false;
    state.targetBlackHoleStrength2 = 0;
    state.figure8Active = 0;
  }

  updateStatus();
}

function processHand(lm) {
  const idxMcp = lm[5];
  const x = (1.0 - idxMcp.x - 0.5) * 5.0;
  const y = -(idxMcp.y - 0.5) * 2.8;

  const zDepth = -((lm[5].z + lm[9].z + lm[13].z) / 3) * 4.0;
  const palmSize2d = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
  const sizeDepth = (palmSize2d - 0.06) / 0.13 - 1.0;
  const depth = THREE.MathUtils.clamp((zDepth + sizeDepth) * 0.5, -1, 1);

  // 张开度
  const tips = [4, 8, 12, 16, 20];
  let sum = 0, cnt = 0;
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      sum += dist3d(lm[tips[i]], lm[tips[j]]); cnt++;
    }
  }
  const openness = THREE.MathUtils.clamp((sum / cnt - 0.05) / 0.30, 0, 1);

  // 捏合强度
  const pinchDist = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
  const pEnter = palmSize2d * 0.32;
  const pExit = palmSize2d * 0.52;
  const pinchStrength = THREE.MathUtils.clamp((pExit - pinchDist) / (pExit - pEnter), 0, 1);

  // 黑洞触发
  const fist = isFist(lm);
  const blackHoleTrigger = pinchStrength > 0.35 || fist;

  // 手势与力场模式
  const digit = detectDigit(lm);
  let gesture = 'idle';
  let forceMode = 1;
  if (blackHoleTrigger) {
    gesture = fist ? 'fist' : 'pinch';
    forceMode = 0;
  } else if (digit === 1) {
    gesture = 'digit1'; forceMode = 2;
  } else if (digit === 2) {
    gesture = 'digit2'; forceMode = 3;
  } else if (digit === 3) {
    gesture = 'digit3'; forceMode = 4;
  }

  return {
    x, y, depth, openness, pinchStrength,
    fist, blackHoleTrigger, gesture, forceMode
  };
}

function applyHandState(state, h, slot) {
  if (slot === 1) {
    state.handX = h.x;
    state.handY = h.y;
    state.handDepth = h.depth;
    state.openness = h.openness;
    state.pinchStrength = h.pinchStrength;
    state.gesture = h.gesture;
    state.forceMode = h.forceMode;
    state.targetBlackHoleStrength = h.blackHoleTrigger ? 1.0 : 0.0;
  } else {
    state.hand2Present = true;
    state.hand2X = h.x;
    state.hand2Y = h.y;
    state.hand2Depth = h.depth;
    state.targetBlackHoleStrength2 = h.blackHoleTrigger ? 1.0 : 0.0;
  }
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
  const bh1 = STATE.blackHoleStrength > 0.05 ? ` | 黑洞1:${(STATE.blackHoleStrength*100).toFixed(0)}%` : '';
  const bh2 = STATE.blackHoleStrength2 > 0.05 ? ` | 黑洞2:${(STATE.blackHoleStrength2*100).toFixed(0)}%` : '';
  const fig8 = STATE.figure8Active > 0.1 ? ` | 8字:${(STATE.figure8Active*100).toFixed(0)}%` : '';
  const hands = STATE.handCount > 0 ? ` | 手:${STATE.handCount}` : '';
  document.getElementById('status').textContent =
    `模式:${modeNames[STATE.forceMode]} | 手势:${STATE.gesture}${hands}${bh1}${bh2}${fig8}`;
}

const clock = new THREE.Clock();
let frameCount = 0, lastFpsTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsedTime();

  // 两个黑洞强度分别平滑插值
  const lerpStrength = (current, target, dt) => {
    const speed = target > current ? 1.0 : 4.0;
    let v = current + (target - current) * Math.min(speed * dt, 1.0);
    if (Math.abs(v - target) < 0.001) v = target;
    return v;
  };
  STATE.blackHoleStrength = lerpStrength(STATE.blackHoleStrength, STATE.targetBlackHoleStrength, dt);
  STATE.blackHoleStrength2 = lerpStrength(STATE.blackHoleStrength2, STATE.targetBlackHoleStrength2, dt);

  // 极缓慢的相机漂移，增强空间纵深感
  camera.position.x = Math.sin(t * 0.08) * 0.15;
  camera.position.y = Math.cos(t * 0.06) * 0.12;
  camera.lookAt(0, 0, 0);

  particleSystem.update(dt, t);
  audio.update(STATE);
  composer.render();

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
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

updateStatus();
