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

    const bh = state.blackHoleStrength || 0;
    const depth = clamp(state.handDepth || 0, -1, 1);
    const depthScale = 0.6 + 0.4 * (depth + 1) * 0.5; // 0.6 ~ 1.0

    // 空间声像跟随手/黑洞位置
    if (this.panner) {
      this.panner.positionX.setTargetAtTime(state.handX || 0, t, 0.05);
      this.panner.positionY.setTargetAtTime(state.handY || 0, t, 0.05);
      this.panner.positionZ.setTargetAtTime(state.handDepth || 0, t, 0.05);
    }

    // 环境音：手出现时稍微变亮
    if (this.ambient) {
      const ambientVol = 0.035 + (state.handPresent ? 0.015 : 0);
      this.ambient.gain.gain.setTargetAtTime(ambientVol, t, 0.2);
    }

    // 黑洞轰鸣：随强度变大，频率略降，模拟质量感
    if (this.rumble) {
      const rumbleVol = bh * 0.28 * depthScale;
      this.rumble.gain.gain.setTargetAtTime(rumbleVol, t, 0.05);
      this.rumble.osc.frequency.setTargetAtTime(55 - bh * 12, t, 0.1);
      this.rumble.sub.frequency.setTargetAtTime(28 - bh * 6, t, 0.1);
      this.rumble.noiseFilter.frequency.setTargetAtTime(90 + bh * 60, t, 0.1);
    }

    // 吸积盘流动声
    if (this.flow) {
      const flowVol = Math.pow(bh, 1.5) * 0.18 * depthScale;
      this.flow.gain.gain.setTargetAtTime(flowVol, t, 0.05);
      this.flow.filter.frequency.setTargetAtTime(600 + bh * 900 * depthScale, t, 0.1);
      this.flow.filter.Q.setTargetAtTime(1.0 + bh * 2.0, t, 0.1);
    }

    // 模式切换提示音
    if (state.forceMode !== this.lastForceMode && state.handPresent) {
      this._playModeChirp(state.forceMode);
    }
    this.lastForceMode = state.forceMode;
  }
}
