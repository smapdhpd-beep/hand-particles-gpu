import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

export class GPUParticleSystem {
  constructor(renderer, state) {
    this.state = state;
    this.renderer = renderer;
    this.width = 512;
    this.height = 512;
    this.count = this.width * this.height;

    this.gpuCompute = new GPUComputationRenderer(this.width, this.height, this.renderer);
    if (!this.gpuCompute) {
      throw new Error('GPUComputationRenderer not supported');
    }

    // 初始位置纹理
    const dtPosition = this.gpuCompute.createTexture();
    this.fillPosition(dtPosition);

    // 初始速度纹理
    const dtVelocity = this.gpuCompute.createTexture();
    this.fillVelocity(dtVelocity);

    // 位置更新 shader
    this.positionVariable = this.gpuCompute.addVariable('texturePosition', `
      uniform float uDelta;
      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D(texturePosition, uv);
        vec4 vel = texture2D(textureVelocity, uv);
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
        vec4 pos = texture2D(texturePosition, uv);
        vec4 vel = texture2D(textureVelocity, uv);

        vec3 force = vec3(0.0);
        vec3 toHand = uHandPos - pos.xyz;
        float dist = length(toHand);
        vec3 dir = normalize(toHand + 0.001);

        if (uMode < 0.5) {
          // 0: 引力奇点
          force += dir / (dist * dist + 0.05) * 0.5;
        } else if (uMode < 1.5) {
          // 1: 涡旋
          vec3 tangent = normalize(cross(toHand, vec3(0.0, 0.0, 1.0)));
          force += tangent / (dist + 0.1) * 0.8;
          force += dir / (dist * dist + 0.2) * 0.2;
        } else if (uMode < 2.5) {
          // 2: 排斥
          force -= dir / (dist * dist + 0.05) * 0.5;
        } else if (uMode < 3.5) {
          // 3: 布朗运动
          vec3 noise = vec3(
            rand(uv + uTime),
            rand(uv + uTime + 1.0),
            rand(uv + uTime + 2.0)
          ) * 2.0 - 1.0;
          force += noise * 0.5;
          force += dir / (dist * dist + 0.2) * 0.1;
        } else {
          // 4: 简谐震荡
          float phase = rand(uv) * 6.28318;
          force += vec3(cos(uTime * 2.0 + phase), sin(uTime * 2.0 + phase), 0.0) * 0.3;
          force += dir / (dist * dist + 0.2) * 0.1;
        }

        vel.xyz += force * 0.016;
        vel.xyz *= 0.985; // 阻尼

        // 边界软约束
        float r = length(pos.xyz);
        if (r > 4.0) {
          vel.xyz -= normalize(pos.xyz) * (r - 4.0) * 0.02;
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

    // 渲染用粒子几何体：每个顶点的 position 存储采样 UV
    const geometry = new THREE.BufferGeometry();
    const refs = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      refs[i * 2] = (i % this.width) / this.width;
      refs[i * 2 + 1] = Math.floor(i / this.width) / this.height;
    }
    geometry.setAttribute('aReference', new THREE.BufferAttribute(refs, 2));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        texturePosition: { value: null },
        uColor: { value: new THREE.Color('#ff9a9e') },
        uSize: { value: 1.5 },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute vec2 aReference;
        uniform sampler2D texturePosition;
        uniform float uSize;
        varying float vLife;
        void main() {
          vec4 pos = texture2D(texturePosition, aReference);
          vec4 mvPosition = modelViewMatrix * vec4(pos.xyz, 1.0);
          gl_PointSize = uSize * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
          vLife = pos.w;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vLife;
        void main() {
          float d = distance(gl_PointCoord, vec2(0.5));
          if (d > 0.5) discard;
          float core = 1.0 - smoothstep(0.0, 0.15, d);
          float glow = 1.0 - smoothstep(0.0, 0.45, d);
          float alpha = (core * 0.6 + glow * 0.25);
          gl_FragColor = vec4(uColor * (1.0 + core * 0.3), alpha);
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
      // 球体内随机分布
      const r = Math.cbrt(Math.random()) * 2.0;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      data[ix]   = r * Math.sin(phi) * Math.cos(theta);
      data[ix+1] = r * Math.sin(phi) * Math.sin(theta);
      data[ix+2] = r * Math.cos(phi);
      data[ix+3] = Math.random(); // life/id
    }
  }

  fillVelocity(texture) {
    const data = texture.image.data;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 4;
      data[ix]   = (Math.random() - 0.5) * 0.1;
      data[ix+1] = (Math.random() - 0.5) * 0.1;
      data[ix+2] = (Math.random() - 0.5) * 0.1;
      data[ix+3] = 0.0;
    }
  }

  update(dt, time) {
    const handX = this.state.handX || 0;
    const handY = this.state.handY || 0;
    const handZ = this.state.handDepth || 0;

    this.gpuCompute.compute();

    const positionUniforms = this.positionVariable.material.uniforms;
    positionUniforms['uDelta'].value = dt;

    const velocityUniforms = this.velocityVariable.material.uniforms;
    velocityUniforms['uHandPos'].value.set(handX, handY, handZ);
    velocityUniforms['uMode'].value = this.state.forceMode || 0;
    velocityUniforms['uTime'].value = time;

    this.points.material.uniforms.texturePosition.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
    this.points.material.uniforms.uTime.value = time;
  }
}
