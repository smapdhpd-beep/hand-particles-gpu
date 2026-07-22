import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

export class GPUParticleSystem {
  constructor(renderer, state) {
    this.state = state;
    this.renderer = renderer;
    this.width = 256;
    this.height = 256;
    this.count = this.width * this.height;

    this.gpuCompute = new GPUComputationRenderer(this.width, this.height, this.renderer);
    if (!this.gpuCompute) {
      throw new Error('GPUComputationRenderer not supported');
    }

    // 初始位置纹理
    const dtPosition = this.gpuCompute.createTexture();
    dtPosition.minFilter = THREE.NearestFilter;
    dtPosition.magFilter = THREE.NearestFilter;
    this.fillPosition(dtPosition);

    // 初始速度纹理
    const dtVelocity = this.gpuCompute.createTexture();
    dtVelocity.minFilter = THREE.NearestFilter;
    dtVelocity.magFilter = THREE.NearestFilter;
    this.fillVelocity(dtVelocity, dtPosition.image.data);

    // 位置更新 shader（GPUComputationRenderer 在 WebGL2 下使用 GLSL3，用 texture 而非 texture2D）
    this.positionVariable = this.gpuCompute.addVariable('texturePosition', `
      uniform float uDelta;
      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture(texturePosition, uv);
        vec4 vel = texture(textureVelocity, uv);
        pos.xyz += vel.xyz * uDelta;
        gl_FragColor = pos;
      }
    `, dtPosition);
    this.positionVariable.material.uniforms.uDelta = { value: 0.016 };

    // 速度更新 shader
    this.velocityVariable = this.gpuCompute.addVariable('textureVelocity', `
      uniform vec3 uHandPos;
      uniform float uMode;
      uniform float uTime;

      // 伪随机
      float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture(texturePosition, uv);
        vec4 vel = texture(textureVelocity, uv);

        vec3 force = vec3(0.0);
        vec3 toHand = uHandPos - pos.xyz;
        float dist = length(toHand);
        vec3 dir = normalize(toHand + 0.001);

        // 无手或手很远时，保持微弱漂移，避免全部塌缩到原点
        float handInfluence = smoothstep(8.0, 2.0, dist);

        if (uMode < 0.5) {
          // 0: 引力奇点
          force += dir / (dist * dist + 0.1) * 0.25;
        } else if (uMode < 1.5) {
          // 1: 涡旋
          vec3 tangent = normalize(cross(toHand, vec3(0.0, 0.0, 1.0)));
          force += tangent / (dist + 0.2) * 0.4;
          force += dir / (dist * dist + 0.5) * 0.05;
        } else if (uMode < 2.5) {
          // 2: 排斥
          force -= dir / (dist * dist + 0.1) * 0.25;
        } else if (uMode < 3.5) {
          // 3: 布朗运动
          vec3 noise = vec3(
            rand(uv + uTime),
            rand(uv + uTime + 1.0),
            rand(uv + uTime + 2.0)
          ) * 2.0 - 1.0;
          force += noise * 0.15;
          force += dir / (dist * dist + 0.5) * 0.03;
        } else {
          // 4: 简谐震荡
          float phase = rand(uv) * 6.28318;
          force += vec3(cos(uTime * 1.5 + phase), sin(uTime * 1.5 + phase), 0.0) * 0.15;
          force += dir / (dist * dist + 0.5) * 0.03;
        }

        vel.xyz += force * 0.016 * handInfluence;
        vel.xyz *= 0.99; // 轻阻尼

        // 边界软约束：保持粒子在可视球内
        float r = length(pos.xyz);
        if (r > 5.0) {
          vel.xyz -= normalize(pos.xyz) * (r - 5.0) * 0.01;
        }

        gl_FragColor = vel;
      }
    `, dtVelocity);
    this.velocityVariable.material.uniforms.uHandPos = { value: new THREE.Vector3() };
    this.velocityVariable.material.uniforms.uMode = { value: 0 };
    this.velocityVariable.material.uniforms.uTime = { value: 0 };

    this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);
    this.gpuCompute.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable]);

    const error = this.gpuCompute.init();
    if (error !== null) {
      console.error('GPUComputationRenderer init error:', error);
    }

    // 渲染用粒子几何体：position.xy 存储采样 UV，position.z = 0
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      positions[i * 3]     = (i % this.width) / this.width + 0.5 / this.width;
      positions[i * 3 + 1] = Math.floor(i / this.width) / this.height + 0.5 / this.height;
      positions[i * 3 + 2] = 0.0;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        texturePosition: { value: null },
        textureVelocity: { value: null },
        uColor: { value: new THREE.Color('#ff6b9d') },
        uSize: { value: 1.0 },
        uTime: { value: 0 },
      },
      vertexShader: `
        uniform sampler2D texturePosition;
        uniform sampler2D textureVelocity;
        uniform float uSize;
        varying vec3 vVel;
        varying float vLife;
        void main() {
          vec4 pos = texture2D(texturePosition, position.xy);
          vec4 vel = texture2D(textureVelocity, position.xy);
          vec4 mvPosition = modelViewMatrix * vec4(pos.xyz, 1.0);
          float speed = length(vel.xyz);
          // 速度越快，点越大，拖尾越长
          gl_PointSize = uSize * (30.0 / max(0.1, -mvPosition.z)) * (1.0 + speed * 8.0);
          gl_Position = projectionMatrix * mvPosition;
          vVel = vel.xyz;
          vLife = pos.w;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec3 vVel;
        varying float vLife;
        void main() {
          float speed = length(vVel);
          // 速度方向在屏幕空间的投影（简化：使用 velocity.xy）
          vec2 dir = normalize(vVel.xy + 0.001);
          // 把 gl_PointCoord 旋转到速度方向
          vec2 uv = gl_PointCoord - 0.5;
          vec2 rotUV;
          rotUV.x =  uv.x * dir.x + uv.y * dir.y;
          rotUV.y = -uv.x * dir.y + uv.y * dir.x;
          // 沿速度方向拉伸：速度越快越长
          float stretch = 1.0 + speed * 12.0;
          rotUV.x /= stretch;
          float d = length(rotUV);
          if (d > 0.5) discard;
          // 头部亮，尾部淡：尾部在 rotUV.x 负方向（与速度相反）
          float trail = smoothstep(-0.5, 0.3, rotUV.x);
          float core = 1.0 - smoothstep(0.0, 0.25, d);
          float glow = 1.0 - smoothstep(0.0, 0.50, d);
          float alpha = (core * 0.5 + glow * 0.2) * (0.3 + 0.7 * trail);
          vec3 col = uColor * (1.0 + core * 0.3 + speed * 0.5);
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  fillPosition(texture) {
    const data = texture.image.data;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 4;
      // 较大球体内随机分布
      const r = Math.cbrt(Math.random()) * 3.5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      data[ix]   = r * Math.sin(phi) * Math.cos(theta);
      data[ix+1] = r * Math.sin(phi) * Math.sin(theta);
      data[ix+2] = r * Math.cos(phi);
      data[ix+3] = Math.random();
    }
    texture.needsUpdate = true;
  }

  fillVelocity(texture, positionData) {
    const data = texture.image.data;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 4;
      const px = positionData[ix];
      const py = positionData[ix+1];
      const pz = positionData[ix+2];
      // 切向速度：绕 z 轴
      const len = Math.sqrt(px*px + py*py) || 1;
      const tx = -py / len;
      const ty = px / len;
      data[ix]   = tx * 0.5 + (Math.random() - 0.5) * 0.1;
      data[ix+1] = ty * 0.5 + (Math.random() - 0.5) * 0.1;
      data[ix+2] = (Math.random() - 0.5) * 0.1;
      data[ix+3] = 0.0;
    }
    texture.needsUpdate = true;
  }

  update(dt, time) {
    const safeDt = Math.max(dt, 0.001);
    const handX = this.state.handX || 0;
    const handY = this.state.handY || 0;
    const handZ = this.state.handDepth || 0;

    this.positionVariable.material.uniforms.uDelta.value = safeDt;
    this.velocityVariable.material.uniforms.uHandPos.value.set(handX, handY, handZ);
    this.velocityVariable.material.uniforms.uMode.value = this.state.forceMode || 0;
    this.velocityVariable.material.uniforms.uTime.value = time;

    this.gpuCompute.compute();

    const rtPos = this.gpuCompute.getCurrentRenderTarget(this.positionVariable);
    const rtVel = this.gpuCompute.getCurrentRenderTarget(this.velocityVariable);
    if (!rtPos || !rtPos.texture || !rtVel || !rtVel.texture) {
      console.error('GPU compute render target is null');
      return;
    }
    this.points.material.uniforms.texturePosition.value = rtPos.texture;
    this.points.material.uniforms.textureVelocity.value = rtVel.texture;
    this.points.material.uniforms.uTime.value = time;
  }
}
