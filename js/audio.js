/* ═══ 空间化音效引擎（纯 Web Audio API，零外部音频文件）═══ */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.panner = null;
    this.muted = false;
    this.started = false;

    // 各声部节点
    this.ambient = null;
    this.rumble = null;
    this.flow = null;
    this.shape = null;

    // 上一帧状态，用于检测模式切换
    this.lastForceMode = 0;
    this.lastGesture = 'idle';
  }

  async start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      console.warn('Web Audio API not supported');
      return;
    }
    this.ctx = new AC();

    // 主音量 + 空间声像
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;

    this.panner = this.ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 2.0;
    this.panner.maxDistance = 10.0;
    this.panner.rolloffFactor = 1.0;

    this.master.connect(this.panner);
    this.panner.connect(this.ctx.destination);

    this._createAmbient();
    this._createRumble();
    this._createFlow();
    this._createShape();

    this.started = true;
  }

  // 生成指定颜色的噪声（0=brown, 1=pink, 2=white）
  _createNoiseBuffer(color) {
    const len = this.ctx.sampleRate * 2; // 2 秒循环
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 0) {
        // brown
        last = (last + white * 0.02) / 1.02;
        data[i] = last * 3.5;
      } else if (color === 1) {
        // pink（简易 Voss-McCartney 近似）
        last = (last + white * 0.1) * 0.9;
        data[i] = last;
      } else {
        data[i] = white;
      }
    }
    return buffer;
  }

  _createAmbient() {
    // 深空环境嗡鸣：棕色噪声 + 低通 + 轻微 LFO 调制
    const src = this.ctx.createBufferSource();
    src.buffer = this._createNoiseBuffer(0); // brown
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 180;
    filter.Q.value = 0.7;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.035;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();

    // 轻微调制 filter 频率，让环境音有生命感
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 40;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    this.ambient = { src, filter, gain, lfo };
  }

  _createRumble() {
    // 黑洞低频轰鸣：两个正弦波 + 棕色噪声
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55;

    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 28;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this._createNoiseBuffer(0);
    noise.loop = true;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 90;

    const gain = this.ctx.createGain();
    gain.gain.value = 0; // 初始静音，随黑洞强度打开

    osc.connect(gain);
    sub.connect(gain);
    noise.connect(noiseFilter);
    noiseFilter.connect(gain);
    gain.connect(this.master);

    osc.start();
    sub.start();
    noise.start();

    this.rumble = { osc, sub, noiseFilter, gain };
  }

  _createFlow() {
    // 吸积盘流动声：粉色噪声 + 带通滤波
    const src = this.ctx.createBufferSource();
    src.buffer = this._createNoiseBuffer(1); // pink
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 1.2;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();

    this.flow = { src, filter, gain };
  }

  _createShape() {
    // 形态塑形音效：两个失谐正弦波 + 轻微 FM，营造“水晶塑形”感
    const oscA = this.ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.value = 220;

    const oscB = this.ctx.createOscillator();
    oscB.type = 'triangle';
    oscB.frequency.value = 223; // 轻微拍频

    const fm = this.ctx.createOscillator();
    fm.type = 'sine';
    fm.frequency.value = 2.5;
    const fmGain = this.ctx.createGain();
    fmGain.gain.value = 8;
    fm.connect(fmGain);
    fmGain.connect(oscA.frequency);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.8;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    oscA.start();
    oscB.start();
    fm.start();

    this.shape = { oscA, oscB, fm, filter, gain };
  }

  _playModeChirp(mode) {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const freq = 220 + mode * 90;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.18);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      const target = this.muted ? 0 : 0.55;
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  setMute(muted) {
    this.muted = muted;
    if (this.master) {
      const target = this.muted ? 0 : 0.55;
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
    }
  }

  update(state) {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;

    // 首次识别到手启动音频上下文（部分浏览器需要）
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const bh1 = state.blackHoleStrength || 0;
    const bh2 = state.blackHoleStrength2 || 0;
    const totalBH = Math.max(bh1, bh2);
    const bothActive = (bh1 > 0.05 && bh2 > 0.05) ? 1.0 : 0.0;

    // 空间声像放在活跃黑洞的平均位置
    if (this.panner) {
      let px = 0, py = 0, pz = 0, w = 0;
      if (bh1 > 0.05) { px += state.handX || 0; py += state.handY || 0; pz += state.handDepth || 0; w++; }
      if (bh2 > 0.05) { px += state.hand2X || 0; py += state.hand2Y || 0; pz += state.hand2Depth || 0; w++; }
      if (w > 0) {
        this.panner.positionX.setTargetAtTime(px / w, t, 0.05);
        this.panner.positionY.setTargetAtTime(py / w, t, 0.05);
        this.panner.positionZ.setTargetAtTime(pz / w, t, 0.05);
      } else if (state.handPresent) {
        this.panner.positionX.setTargetAtTime(state.handX || 0, t, 0.05);
        this.panner.positionY.setTargetAtTime(state.handY || 0, t, 0.05);
        this.panner.positionZ.setTargetAtTime(state.handDepth || 0, t, 0.05);
      }
    }

    // 无手且黑洞消散后整体静音
    const active = state.handPresent || totalBH > 0.05;
    const masterTarget = (!active || this.muted) ? 0.0 : 0.55;
    this.master.gain.setTargetAtTime(masterTarget, t, 0.15);

    // 环境音：仅在有手时出现
    if (this.ambient) {
      const ambientVol = active ? 0.05 : 0.0;
      this.ambient.gain.gain.setTargetAtTime(ambientVol, t, 0.2);
    }

    // 黑洞轰鸣：双黑洞时额外增强
    if (this.rumble) {
      const depth1 = clamp(state.handDepth || 0, -1, 1);
      const depth2 = clamp(state.hand2Depth || 0, -1, 1);
      const depthScale = 0.6 + 0.4 * (Math.max(depth1, depth2) + 1) * 0.5;
      const rumbleVol = totalBH * 0.28 * depthScale * (1.0 + bothActive * 0.4);
      this.rumble.gain.gain.setTargetAtTime(rumbleVol, t, 0.05);
      this.rumble.osc.frequency.setTargetAtTime(55 - totalBH * 12, t, 0.1);
      this.rumble.sub.frequency.setTargetAtTime(28 - totalBH * 6, t, 0.1);
      this.rumble.noiseFilter.frequency.setTargetAtTime(90 + totalBH * 60, t, 0.1);
    }

    // 吸积盘流动声
    if (this.flow) {
      const depth1 = clamp(state.handDepth || 0, -1, 1);
      const depth2 = clamp(state.hand2Depth || 0, -1, 1);
      const depthScale = 0.6 + 0.4 * (Math.max(depth1, depth2) + 1) * 0.5;
      const flowVol = Math.pow(totalBH, 1.5) * 0.18 * depthScale * (1.0 + bothActive * 0.3);
      this.flow.gain.gain.setTargetAtTime(flowVol, t, 0.05);
      this.flow.filter.frequency.setTargetAtTime(600 + totalBH * 900 * depthScale, t, 0.1);
      this.flow.filter.Q.setTargetAtTime(1.0 + totalBH * 2.0, t, 0.1);
    }

    // 形态塑形音效：随 shapeType 改变基频
    if (this.shape) {
      const shapeStrength = state.shapeStrength || 0;
      const shapeType = state.shapeType || 0;
      const baseFreqs = [220, 330, 440, 277]; // 爱心/球体/螺旋/环面
      const baseFreq = baseFreqs[shapeType % 4];
      const depth = clamp(state.handDepth || 0, -1, 1);
      const depthScale = 0.7 + 0.3 * (depth + 1) * 0.5;
      const shapeVol = Math.pow(shapeStrength, 1.5) * 0.045 * depthScale;
      this.shape.gain.gain.setTargetAtTime(shapeVol, t, 0.08);
      this.shape.oscA.frequency.setTargetAtTime(baseFreq * depthScale, t, 0.1);
      this.shape.oscB.frequency.setTargetAtTime(baseFreq * 1.5 * depthScale, t, 0.1);
      this.shape.fm.frequency.setTargetAtTime(2.0 + shapeStrength * 3.0, t, 0.1);
      this.shape.filter.frequency.setTargetAtTime(800 + shapeStrength * 1200, t, 0.1);
    }

    // 模式切换提示音
    if (state.forceMode !== this.lastForceMode && state.handPresent) {
      this._playModeChirp(state.forceMode);
    }
    this.lastForceMode = state.forceMode;
  }
}
