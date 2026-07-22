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
      uniform vec3 uBlackHolePos2;
      uniform float uBlackHoleStrength;
      uniform float uBlackHoleStrength2;

      float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void respawnAt(vec2 uv, vec3 center, inout vec4 pos) {
        float r = 0.8 + rand(uv) * 2.4;
        float theta = rand(uv + 1.0) * 6.28318;
        float phi = acos(2.0 * rand(uv + 2.0) - 1.0);
        pos.x = center.x + r * sin(phi) * cos(theta);
        pos.y = center.y + r * sin(phi) * sin(theta);
        pos.z = center.z + r * cos(phi) * 0.6;
        pos.w = rand(uv + 3.0);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture(texturePosition, uv);
        vec4 vel = texture(textureVelocity, uv);
        pos.xyz += vel.xyz * uDelta;

        // 事件视界：被任一黑洞吞噬的粒子从该黑洞远处重生
        float holeDist1 = length(pos.xyz - uBlackHolePos);
        float horizon1 = 0.10 * uBlackHoleStrength;
        if (uBlackHoleStrength > 0.05 && holeDist1 < horizon1) {
          respawnAt(uv, uBlackHolePos, pos);
        }

        float holeDist2 = length(pos.xyz - uBlackHolePos2);
        float horizon2 = 0.10 * uBlackHoleStrength2;
        if (uBlackHoleStrength2 > 0.05 && holeDist2 < horizon2) {
          respawnAt(uv, uBlackHolePos2, pos);
        }

        gl_FragColor = pos;
      }
    `, dtPosition);
    this.positionVariable.material.uniforms.uDelta = { value: 0.016 };
    this.positionVariable.material.uniforms.uBlackHolePos = { value: new THREE.Vector3() };
    this.positionVariable.material.uniforms.uBlackHolePos2 = { value: new THREE.Vector3() };
    this.positionVariable.material.uniforms.uBlackHoleStrength = { value: 0 };
    this.positionVariable.material.uniforms.uBlackHoleStrength2 = { value: 0 };

    // 速度更新 shader
    this.velocityVariable = this.gpuCompute.addVariable('textureVelocity', `
      uniform vec3 uHandPos;
      uniform float uHandActive;
      uniform float uHandDepth;
      uniform float uHandDepth2;
      uniform vec3 uBlackHolePos;
      uniform vec3 uBlackHolePos2;
      uniform float uMode;
      uniform float uTime;
      uniform float uBlackHoleStrength;
      uniform float uBlackHoleStrength2;
      uniform float uFigure8Active;
      uniform float uShapeType;
      uniform float uShapeStrength;

      // 伪随机
      float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // 黑洞力场计算
      vec3 blackHoleForce(vec3 pos, vec3 holePos, float strength, float depthScale, vec2 uv) {
        vec3 f = vec3(0.0);
        if (strength <= 0.001) return f;
        vec3 toHole = holePos - pos;
        float holeDist = length(toHole);
        vec3 holeDir = normalize(toHole + 0.001);

        float pull = strength * depthScale * 2.0 / (holeDist * holeDist + 0.1);
        vec3 holeTangent = normalize(cross(toHole, vec3(0.0, 0.0, 1.0)));
        float swirl = strength * depthScale * 0.25 / (holeDist + 0.5);
        vec3 turbulence = vec3(
          rand(uv + uTime) - 0.5,
          rand(uv + uTime + 1.0) - 0.5,
          rand(uv + uTime + 2.0) - 0.5
        ) * strength * 0.6;

        f += holeDir * pull;
        f += holeTangent * swirl;
        f += turbulence;
        return f;
      }

      // 8 字形（伯努利双纽线）力场：随双手方向旋转，始终与双手连线对齐
      vec3 figure8Force(vec3 pos, vec3 center, vec3 handDir, float scale, float strength, float depthScale, vec2 uv) {
        vec3 f = vec3(0.0);
        if (strength <= 0.001 || scale <= 0.001) return f;

        // 建立局部坐标系：x 轴沿双手连线，y 轴在画面平面内垂直于 x 轴
        vec3 xAxis = normalize(handDir);
        vec3 ref = abs(dot(xAxis, vec3(0.0, 0.0, -1.0))) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, -1.0);
        vec3 yAxis = normalize(cross(xAxis, ref));
        vec3 zAxis = cross(xAxis, yAxis);

        vec3 local = pos - center;
        float lx = dot(local, xAxis);
        float ly = dot(local, yAxis);
        float lz = dot(local, zAxis);

        float angle = atan(ly, lx);
        float c2 = cos(2.0 * angle);
        if (c2 > 0.0) {
          float rCurve = scale * sqrt(c2);
          vec3 target = center + xAxis * (rCurve * cos(angle)) + yAxis * (rCurve * sin(angle));
          vec3 toCurve = target - pos;
          float d2 = dot(toCurve, toCurve);
          f += normalize(toCurve + 0.001) * strength * depthScale * 2.0 / (d2 + 0.08);

          // 沿 8 字切向流动
          vec3 tangent = normalize(-xAxis * sin(angle) + yAxis * cos(angle));
          float dirSign = sign(cos(angle));
          f += tangent * dirSign * strength * depthScale * 0.5;

          // z 方向轻微拉回局部平面，避免粒子散开
          f -= zAxis * lz * strength * 0.15;
        }
        return f;
      }

      // 形态目标：根据粒子 UV 稳定映射到几何形状上的位置
      vec3 shapeTarget(vec2 uv, float shapeType) {
        float r = rand(uv);
        float t = rand(uv + 0.5) * 6.28318;
        if (shapeType < 0.5) {
          // 0: 爱心（平面 Parametric heart，带厚度）
          float a = t;
          float hx = 16.0 * pow(sin(a), 3.0);
          float hy = 13.0 * cos(a) - 5.0 * cos(2.0 * a) - 2.0 * cos(3.0 * a) - cos(4.0 * a);
          float z = (r - 0.5) * 0.6;
          return vec3(hx * 0.11, hy * 0.11 - 0.2, z);
        } else if (shapeType < 1.5) {
          // 1: 球体
          float theta = t;
          float phi = acos(2.0 * r - 1.0);
          float radius = 2.0;
          return vec3(radius * sin(phi) * cos(theta), radius * sin(phi) * sin(theta), radius * cos(phi));
        } else if (shapeType < 2.5) {
          // 2: 螺旋
          float angle = t + r * 10.0;
          float rad = 0.15 + r * 2.2;
          float z = (t / 6.28318 - 0.5) * 3.5;
          return vec3(rad * cos(angle), rad * sin(angle), z);
        } else {
          // 3: 环面
          float tubeR = 0.55;
          float majorR = 1.5;
          float u = t;
          float v = r * 6.28318;
          return vec3(
            (majorR + tubeR * cos(v)) * cos(u),
            (majorR + tubeR * cos(v)) * sin(u),
            tubeR * sin(v)
          );
        }
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

        // 手远近影响全局速度感：远慢近快，差异更加明显
        float depthScale = 0.25 + 1.25 * clamp((uHandDepth + 1.0) * 0.5, 0.0, 1.0);

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
        } else if (uMode < 4.5) {
          // 4: 简谐震荡
          float phase = rand(uv) * 6.28318;
          force += vec3(cos(uTime * 1.5 + phase), sin(uTime * 1.5 + phase), 0.0) * 0.15;
          force += dir / (dist * dist + 0.5) * 0.03 * depthScale;
        } else {
          // 5: 形态塑形（爱心/球体/螺旋/环面）
          vec3 target = uHandPos + shapeTarget(uv, uShapeType);
          vec3 toTarget = target - pos.xyz;
          float targetDist = length(toTarget);
          // 弹簧力拉向目标形态
          force += normalize(toTarget + 0.001) * uShapeStrength * depthScale * 1.8 / (targetDist + 0.15);
          force += toTarget * uShapeStrength * 0.35 * depthScale;
          // 微弱切向流动，避免死寂
          vec3 tangent = normalize(cross(toTarget, vec3(0.0, 0.0, 1.0)));
          force += tangent * uShapeStrength * 0.12 * depthScale;
          // 保留轻微手引力，让形态随手动
          force += dir / (dist * dist + 0.8) * 0.04 * depthScale;
        }

        // 双黑洞模式：两个黑洞独立施加力场；双手靠近时渐变为 8 字形力场
        float totalBHStrength = max(uBlackHoleStrength, uBlackHoleStrength2);
        if (totalBHStrength > 0.001) {
          force *= (1.0 - totalBHStrength * 0.85);
        }

        float depthScale2 = 0.25 + 1.25 * clamp((uHandDepth2 + 1.0) * 0.5, 0.0, 1.0);

        vec3 dualForce = vec3(0.0);
        dualForce += blackHoleForce(pos.xyz, uBlackHolePos, uBlackHoleStrength, depthScale, uv);
        dualForce += blackHoleForce(pos.xyz, uBlackHolePos2, uBlackHoleStrength2, depthScale2, uv + 3.0);

        vec3 center = (uBlackHolePos + uBlackHolePos2) * 0.5;
        vec3 handDir = uBlackHolePos2 - uBlackHolePos;
        float handDist = length(handDir);
        float f8Scale = handDist * 0.707; // 8 字焦点与双手位置对齐
        float f8Strength = totalBHStrength * (1.0 + uFigure8Active * 0.3);
        float avgDepthScale = (depthScale + depthScale2) * 0.5;
        vec3 f8Force = figure8Force(pos.xyz, center, handDir, f8Scale, f8Strength, avgDepthScale, uv + 7.0);

        force += mix(dualForce, f8Force, uFigure8Active);

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
    this.velocityVariable.material.uniforms.uHandDepth2 = { value: 0 };
    this.velocityVariable.material.uniforms.uBlackHolePos = { value: new THREE.Vector3() };
    this.velocityVariable.material.uniforms.uBlackHolePos2 = { value: new THREE.Vector3() };
    this.velocityVariable.material.uniforms.uMode = { value: 0 };
    this.velocityVariable.material.uniforms.uTime = { value: 0 };
    this.velocityVariable.material.uniforms.uBlackHoleStrength = { value: 0 };
    this.velocityVariable.material.uniforms.uBlackHoleStrength2 = { value: 0 };
    this.velocityVariable.material.uniforms.uFigure8Active = { value: 0 };
    this.velocityVariable.material.uniforms.uShapeType = { value: 0 };
    this.velocityVariable.material.uniforms.uShapeStrength = { value: 0 };

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
        uBlackHolePos2: { value: new THREE.Vector3() },
        uBlackHoleStrength: { value: 0 },
        uBlackHoleStrength2: { value: 0 },
        uHandDepth: { value: 0 },
        uHandDepth2: { value: 0 },
        uFigure8Active: { value: 0 },
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
        uniform vec3 uBlackHolePos2;
        uniform float uBlackHoleStrength;
        uniform float uBlackHoleStrength2;
        uniform float uHandDepth;
        uniform float uHandDepth2;
        uniform float uFigure8Active;
        varying vec3 vWorldPos;
        varying float vDepth;
        varying float vSpeed;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;

          float holeDist1 = length(vWorldPos - uBlackHolePos);
          float holeDist2 = length(vWorldPos - uBlackHolePos2);
          float depthFactor1 = 0.5 + 0.5 * clamp((uHandDepth + 1.0) * 0.5, 0.0, 1.0);
          float depthFactor2 = 0.5 + 0.5 * clamp((uHandDepth2 + 1.0) * 0.5, 0.0, 1.0);

          // 吸积盘热量：独立黑洞
          float heatRadius1 = 0.05 + depthFactor1 * 0.22;
          float heatRadius2 = 0.05 + depthFactor2 * 0.22;
          float heat1 = uBlackHoleStrength * smoothstep(heatRadius1 * 2.0, heatRadius1, holeDist1);
          float heat2 = uBlackHoleStrength2 * smoothstep(heatRadius2 * 2.0, heatRadius2, holeDist2);
          float heat = max(heat1, heat2);

          // 8 字形热量：双手靠近时沿 8 字曲线发光（随双手方向旋转）
          if (uFigure8Active > 0.001) {
            vec3 center = (uBlackHolePos + uBlackHolePos2) * 0.5;
            vec3 handDir = uBlackHolePos2 - uBlackHolePos;
            vec3 xAxis = normalize(handDir);
            vec3 ref = abs(dot(xAxis, vec3(0.0, 0.0, -1.0))) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, -1.0);
            vec3 yAxis = normalize(cross(xAxis, ref));

            vec3 local = vWorldPos - center;
            float lx = dot(local, xAxis);
            float ly = dot(local, yAxis);
            float angle = atan(ly, lx);
            float c2 = cos(2.0 * angle);
            float f8Heat = 0.0;
            if (c2 > 0.0) {
              float handDist = length(handDir);
              float scale = handDist * 0.707;
              float rCurve = scale * sqrt(c2);
              float rPos = length(vec2(lx, ly));
              float distToCurve = abs(rPos - rCurve);
              float totalStr = max(uBlackHoleStrength, uBlackHoleStrength2);
              f8Heat = totalStr * smoothstep(0.35, 0.0, distToCurve);
            }
            heat = mix(heat, f8Heat, uFigure8Active);
          }
          heat = clamp(heat, 0.0, 1.0);

          // 颜色从冷尘埃到热吸积盘渐变
          vec3 coolColor = uColor * 0.72;
          vec3 hotColor = mix(vec3(1.0, 0.55, 0.30), vec3(1.0, 0.88, 0.72), heat);
          vec3 col = mix(coolColor, hotColor, heat);

          // 默认 alpha 提高到可见，但离手后不会形成硬质亮环；热量区域靠 Bloom 发光
          float baseAlpha = 0.26;
          float alpha = (baseAlpha + heat * 0.42) * (1.0 - smoothstep(0.0, 0.5, d));

          // 事件视界：任一黑洞中心形成真实阴影
          float horizon1 = 0.10 * uBlackHoleStrength;
          float horizon2 = 0.10 * uBlackHoleStrength2;
          float shadow1 = smoothstep(horizon1 * 2.5, horizon1, holeDist1);
          float shadow2 = smoothstep(horizon2 * 2.5, horizon2, holeDist2);
          float shadow = max(shadow1, shadow2);
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

    const hand2X = this.state.hand2X || 0;
    const hand2Y = this.state.hand2Y || 0;
    const hand2Z = this.state.hand2Depth || 0;
    const blackHoleStrength2 = this.state.blackHoleStrength2 || 0;
    const handDepth2 = this.state.hand2Depth || 0;
    const figure8Active = this.state.figure8Active || 0;
    const shapeType = this.state.shapeType || 0;
    const shapeStrength = this.state.shapeStrength || 0;

    this.positionVariable.material.uniforms.uDelta.value = safeDt;
    this.positionVariable.material.uniforms.uBlackHolePos.value.set(handX, handY, handZ);
    this.positionVariable.material.uniforms.uBlackHolePos2.value.set(hand2X, hand2Y, hand2Z);
    this.positionVariable.material.uniforms.uBlackHoleStrength.value = blackHoleStrength;
    this.positionVariable.material.uniforms.uBlackHoleStrength2.value = blackHoleStrength2;

    this.velocityVariable.material.uniforms.uHandPos.value.set(handX, handY, handZ);
    this.velocityVariable.material.uniforms.uHandActive.value = handActive;
    this.velocityVariable.material.uniforms.uHandDepth.value = handDepth;
    this.velocityVariable.material.uniforms.uHandDepth2.value = handDepth2;
    this.velocityVariable.material.uniforms.uBlackHolePos.value.set(handX, handY, handZ);
    this.velocityVariable.material.uniforms.uBlackHolePos2.value.set(hand2X, hand2Y, hand2Z);
    this.velocityVariable.material.uniforms.uBlackHoleStrength.value = blackHoleStrength;
    this.velocityVariable.material.uniforms.uBlackHoleStrength2.value = blackHoleStrength2;
    this.velocityVariable.material.uniforms.uMode.value = this.state.forceMode || 0;
    this.velocityVariable.material.uniforms.uTime.value = time;
    this.velocityVariable.material.uniforms.uFigure8Active.value = figure8Active;
    this.velocityVariable.material.uniforms.uShapeType.value = shapeType;
    this.velocityVariable.material.uniforms.uShapeStrength.value = shapeStrength;

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
    this.points.material.uniforms.uBlackHolePos2.value.set(hand2X, hand2Y, hand2Z);
    this.points.material.uniforms.uBlackHoleStrength.value = blackHoleStrength;
    this.points.material.uniforms.uBlackHoleStrength2.value = blackHoleStrength2;
    this.points.material.uniforms.uHandDepth.value = handDepth;
    this.points.material.uniforms.uHandDepth2.value = handDepth2;
    this.points.material.uniforms.uFigure8Active.value = figure8Active;
  }
}
