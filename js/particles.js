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
      uniform vec3 uBlackHolePos;
      uniform float uBlackHoleStrength;

      float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture(texturePosition, uv);
        vec4 vel = texture(textureVelocity, uv);
        pos.xyz += vel.xyz * uDelta;

        // 事件视界：被吞噬的粒子从远处重生，形成持续吸积流
        float holeDist = length(pos.xyz - uBlackHolePos);
        float horizon = 0.10 * uBlackHoleStrength;
        if (uBlackHoleStrength > 0.05 && holeDist < horizon) {
          float r = 1.6 + rand(uv) * 2.4;
          float theta = rand(uv + 1.0) * 6.28318;
          float phi = acos(2.0 * rand(uv + 2.0) - 1.0);
          pos.x = uBlackHolePos.x + r * sin(phi) * cos(theta);
          pos.y = uBlackHolePos.y + r * sin(phi) * sin(theta);
          pos.z = uBlackHolePos.z + r * cos(phi) * 0.6;
          pos.w = rand(uv + 3.0); // 新生命周期种子
        }

        gl_FragColor = pos;
      }
    `, dtPosition);
    this.positionVariable.material.uniforms.uDelta = { value: 0.016 };
    this.positionVariable.material.uniforms.uBlackHolePos = { value: new THREE.Vector3() };
    this.positionVariable.material.uniforms.uBlackHoleStrength = { value: 0 };

    // 速度更新 shader
    this.velocityVariable = this.gpuCompute.addVariable('textureVelocity', `
      uniform vec3 uHandPos;
      uniform float uHandActive;
      uniform float uHandDepth;
      uniform vec3 uBlackHolePos;
      uniform float uMode;
      uniform float uTime;
      uniform float uBlackHoleStrength;

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

        // 无手时 handInfluence 为 0，避免默认状态粒子被拉向画面中心
        float handInfluence = uHandActive * smoothstep(8.0, 2.0, dist);

        // 手远近影响全局速度感：远慢近快
        float depthScale = 0.35 + 0.85 * clamp(uHandDepth, -1.0, 1.0);

        if (uMode < 0.5) {
          // 0: 引力奇点
          force += dir / (dist * dist + 0.1) * 0.25 * depthScale;
        } else if (uMode < 1.5) {
          // 1: 涡旋（默认漂浮，弱向心力避免中心过亮）
          vec3 tangent = normalize(cross(toHand, vec3(0.0, 0.0, 1.0)));
          force += tangent / (dist + 0.2) * 0.25 * depthScale;
          force += dir / (dist * dist + 0.5) * 0.02 * depthScale;
        } else if (uMode < 2.5) {
          // 2: 排斥
          force -= dir / (dist * dist + 0.1) * 0.25 * depthScale;
        } else if (uMode < 3.5) {
          // 3: 布朗运动
          vec3 noise = vec3(
            rand(uv + uTime),
            rand(uv + uTime + 1.0),
            rand(uv + uTime + 2.0)
          ) * 2.0 - 1.0;
          force += noise * 0.15;
          force += dir / (dist * dist + 0.5) * 0.03 * depthScale;
        } else {
          // 4: 简谐震荡
          float phase = rand(uv) * 6.28318;
          force += vec3(cos(uTime * 1.5 + phase), sin(uTime * 1.5 + phase), 0.0) * 0.15;
          force += dir / (dist * dist + 0.5) * 0.03 * depthScale;
        }

        // 黑洞模式：强径向坠入 + 弱旋涡 + 3D 湍动，避免二维稳定圆环
        if (uBlackHoleStrength > 0.001) {
          // 先削弱普通力场，让黑洞主导
          force *= (1.0 - uBlackHoleStrength * 0.85);

          vec3 toHole = uBlackHolePos - pos.xyz;
          float holeDist = length(toHole);
          vec3 holeDir = normalize(toHole + 0.001);

          // 黑洞速度同样受手远近影响
          float bhScale = depthScale;

          // 径向引力主导：粒子快速坠入，不在固定半径盘旋
          float pull = uBlackHoleStrength * bhScale * 2.0 / (holeDist * holeDist + 0.1);
          // 极弱切向分量：只保留轻微螺旋感
          vec3 holeTangent = normalize(cross(toHole, vec3(0.0, 0.0, 1.0)));
          float swirl = uBlackHoleStrength * bhScale * 0.25 / (holeDist + 0.5);
          // 3D 湍动：彻底打破盘面对称，避免圆环
          vec3 turbulence = vec3(
            rand(uv + uTime) - 0.5,
            rand(uv + uTime + 1.0) - 0.5,
            rand(uv + uTime + 2.0) - 0.5
          ) * uBlackHoleStrength * 0.6;

          force += holeDir * pull;
          force += holeTangent * swirl;
          force += turbulence;
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
    this.velocityVariable.material.uniforms.uHandActive = { value: 0 };
    this.velocityVariable.material.uniforms.uHandDepth = { value: 0 };
    this.velocityVariable.material.uniforms.uBlackHolePos = { value: new THREE.Vector3() };
    this.velocityVariable.material.uniforms.uMode = { value: 0 };
    this.velocityVariable.material.uniforms.uTime = { value: 0 };
    this.velocityVariable.material.uniforms.uBlackHoleStrength = { value: 0 };

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
        uColor: { value: new THREE.Color('#d07090') },
        uSize: { value: 1.0 },
        uTime: { value: 0 },
        uBlackHolePos: { value: new THREE.Vector3() },
        uBlackHoleStrength: { value: 0 },
      },
      vertexShader: `
        uniform sampler2D texturePosition;
        uniform sampler2D textureVelocity;
        uniform float uSize;
        varying vec3 vWorldPos;
        varying float vDepth;
        varying float vSpeed;
        void main() {
          vec4 pos = texture2D(texturePosition, position.xy);
          vec4 vel = texture2D(textureVelocity, position.xy);
          vec4 mvPosition = modelViewMatrix * vec4(pos.xyz, 1.0);
          vSpeed = length(vel.xyz);
          // 小尺寸 + 轻微速度影响；Bloom 负责产生宇宙辉光
          gl_PointSize = min(uSize * (26.0 / max(0.1, -mvPosition.z)) * (1.0 + vSpeed * 0.3), 7.0);
          gl_Position = projectionMatrix * mvPosition;
          vWorldPos = pos.xyz;
          vDepth = -mvPosition.z;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uBlackHolePos;
        uniform float uBlackHoleStrength;
        varying vec3 vWorldPos;
        varying float vDepth;
        varying float vSpeed;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;

          float holeDist = length(vWorldPos - uBlackHolePos);

          // 吸积盘热量：仅在内侧小范围发热，过渡陡峭避免大亮斑
          float heat = uBlackHoleStrength * smoothstep(0.9, 0.05, holeDist);
          heat = clamp(heat, 0.0, 1.0);

          // 颜色从冷尘埃到热吸积盘渐变
          vec3 coolColor = uColor * 0.5;
          vec3 hotColor = mix(vec3(1.0, 0.55, 0.30), vec3(1.0, 0.88, 0.72), heat);
          vec3 col = mix(coolColor, hotColor, heat);

          // 低速/无黑洞时 alpha 很低，靠 Additive + Bloom 堆积出柔和星云
          float baseAlpha = 0.10;
          float alpha = (baseAlpha + heat * 0.45) * (1.0 - smoothstep(0.0, 0.5, d));

          // 事件视界：粒子隐入黑暗，形成真实黑洞剪影
          float horizon = 0.10 * uBlackHoleStrength;
          float shadow = smoothstep(horizon * 2.5, horizon, holeDist);
          float dim = 1.0 - shadow * 0.98;
          col *= dim;
          alpha *= dim;

          // 深度衰减保留空间感
          float depthFade = smoothstep(8.0, 1.0, vDepth);
          alpha *= (0.5 + 0.5 * depthFade);

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
      // sqrt 分布让密度向外围倾斜，避免黑洞附近过度堆积
      const r = 0.8 + Math.sqrt(Math.random()) * 2.7;
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
      // 缓慢切向速度：默认漂浮星云感
      const len = Math.sqrt(px*px + py*py) || 1;
      const tx = -py / len;
      const ty = px / len;
      data[ix]   = tx * 0.15 + (Math.random() - 0.5) * 0.05;
      data[ix+1] = ty * 0.15 + (Math.random() - 0.5) * 0.05;
      data[ix+2] = (Math.random() - 0.5) * 0.05;
      data[ix+3] = 0.0;
    }
    texture.needsUpdate = true;
  }

  update(dt, time) {
    const safeDt = Math.max(dt, 0.001);
    const handX = this.state.handX || 0;
    const handY = this.state.handY || 0;
    const handZ = this.state.handDepth || 0;
    const blackHoleStrength = this.state.blackHoleStrength || 0;
    const handActive = this.state.handPresent ? 1.0 : 0.0;
    const handDepth = this.state.handDepth || 0;

    this.positionVariable.material.uniforms.uDelta.value = safeDt;
    this.positionVariable.material.uniforms.uBlackHolePos.value.set(handX, handY, handZ);
    this.positionVariable.material.uniforms.uBlackHoleStrength.value = blackHoleStrength;

    this.velocityVariable.material.uniforms.uHandPos.value.set(handX, handY, handZ);
    this.velocityVariable.material.uniforms.uHandActive.value = handActive;
    this.velocityVariable.material.uniforms.uHandDepth.value = handDepth;
    this.velocityVariable.material.uniforms.uBlackHolePos.value.set(handX, handY, handZ);
    this.velocityVariable.material.uniforms.uBlackHoleStrength.value = blackHoleStrength;
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
    this.points.material.uniforms.uBlackHolePos.value.set(handX, handY, handZ);
    this.points.material.uniforms.uBlackHoleStrength.value = blackHoleStrength;
  }
}
