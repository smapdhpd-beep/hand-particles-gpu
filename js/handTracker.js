/* ═══ MediaPipe Hands 手势追踪（原生 getUserMedia 版）═══ */

export class HandTracker {
  constructor(onResults) {
    this.video = document.getElementById('input-video');
    this.onResults = onResults;
    this.hands = null;
    this.isRunning = false;
    this.init();
  }

  async init() {
    const Hands = window.Hands;
    if (!Hands) {
      console.error('MediaPipe Hands not loaded');
      return;
    }

    this.hands = new Hands({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`;
      }
    });

    this.hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    this.hands.onResults(this.onResults);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
      });
      this.video.srcObject = stream;
      this.video.onloadedmetadata = () => {
        this.video.play();
        this.isRunning = true;
        this.loop();
      };
    } catch (err) {
      console.error('Camera error:', err);
    }
  }

  async loop() {
    if (!this.isRunning) return;
    if (this.video.readyState >= 2) {
      await this.hands.send({ image: this.video });
    }
    requestAnimationFrame(() => this.loop());
  }
}
