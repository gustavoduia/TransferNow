const noise = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

export const vortexVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** Membrana do portal: fechada = véu escuro tremulando; aberta = vórtice de energia do fluxo. */
export const vortexFragment = /* glsl */ `
  uniform float uTime, uOpen, uReady, uPulse, uHover, uError;
  varying vec2 vUv;
  ${noise}
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);

    float twist = a + uTime * 0.55 + (1.2 / (r + 0.22)) * uOpen;
    float n = fbm(vec2(cos(twist), sin(twist)) * 2.2 + vec2(r * 3.5 - uTime * 1.3, uTime * 0.2));
    float streaks = pow(abs(sin(twist * 6.0 + r * 9.0 - uTime * 3.0)), 8.0);
    float ripples = 0.5 + 0.5 * sin(r * 34.0 - uTime * 7.0 - uPulse * 12.0);

    vec3 deep = vec3(0.01, 0.03, 0.22);
    vec3 flux = vec3(0.16, 0.62, 1.0);
    vec3 hot  = vec3(1.0, 0.97, 0.9);
    vec3 fire = vec3(1.0, 0.42, 0.12);
    vec3 red  = vec3(1.0, 0.18, 0.22);

    float core = smoothstep(0.6, 0.0, r);
    vec3 col = mix(deep, flux, clamp(n * 1.25, 0.0, 1.0));
    col += vec3(0.55, 0.9, 1.0) * streaks * 0.5;
    col += hot * core * core * core * (0.3 + 0.5 * uPulse);
    col += flux * ripples * 0.12 * uPulse;
    col = mix(col, col * vec3(1.15, 0.85, 0.7) + fire * (0.25 + 0.35 * n), uReady * 0.45);
    col = mix(col, red * (0.5 + n), uError * 0.6);

    float edge = smoothstep(1.0, 0.9, r);
    float veil = (0.07 + 0.05 * sin(uTime * 1.7 + r * 22.0) + 0.06 * n) * (1.0 - uOpen);
    float alpha = edge * (uOpen * (0.28 + 0.5 * n * n + 0.12 * core) + veil + uHover * 0.2);
    vec3 closedCol = mix(deep * 2.0, flux * 0.35, n);
    vec3 outCol = mix(closedCol, col, uOpen);
    outCol = pow(max(outCol, 0.0), vec3(1.8));
    gl_FragColor = vec4(outCol * alpha, alpha);
  }
`;

export const beamVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

/** Feixe de luz vertical: o sinal de que a outra ponta está pronta. */
export const beamFragment = /* glsl */ `
  uniform float uTime, uBeam;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(vNormalV, vView));
    float body = pow(facing, 2.5);
    float fade = pow(1.0 - vUv.y, 1.6);
    float pulse = 0.65 + 0.35 * sin(vUv.y * 60.0 - uTime * 10.0);
    float a = uBeam * body * fade * pulse;
    gl_FragColor = vec4(uColor * a * 1.4, a);
  }
`;

/** Rastros de fogo dos pneus, desenhados como partículas ao longo da estrada. */
export const fireVertex = /* glsl */ `
  uniform float uTime, uFire, uDir, uPixel;
  attribute float aT;
  attribute float aSeed;
  varying float vAlpha;
  varying float vHeat;
  void main() {
    float t = uDir > 0.0 ? aT : 1.0 - aT;
    float lit = smoothstep(t - 0.04, t, uFire) * (1.0 - smoothstep(1.4, 2.0, uFire));
    vec3 p = position;
    float life = fract(uTime * (0.8 + aSeed) + aSeed * 7.0);
    p.y += life * (0.35 + aSeed * 0.5);
    p.x += sin(uTime * 6.0 + aSeed * 30.0) * 0.04 * life;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    vHeat = 1.0 - life;
    vAlpha = lit * (1.0 - life);
    gl_PointSize = uPixel * (34.0 + 40.0 * aSeed) * (0.4 + vHeat) / -mv.z;
  }
`;

export const fireFragment = /* glsl */ `
  varying float vAlpha;
  varying float vHeat;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.0, d);
    vec3 col = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.85, 0.45), vHeat * vHeat);
    float a = soft * vAlpha;
    gl_FragColor = vec4(col * a, a);
  }
`;

export const skyVertex = /* glsl */ `
  varying vec3 vPos;
  void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export const skyFragment = /* glsl */ `
  uniform vec3 uTop, uHorizon, uGlow;
  varying vec3 vPos;
  void main() {
    vec3 d = normalize(vPos);
    float h = clamp(d.y, -0.2, 1.0);
    vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
    float glow = exp(-abs(h) * 14.0) * smoothstep(-0.6, 0.0, -abs(d.x) * 0.6);
    col += uGlow * glow * 0.55;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const roadVertex = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const roadFragment = /* glsl */ `
  uniform float uTime, uFire;
  uniform vec3 uFog;
  varying vec2 vUv;
  varying float vDepth;
  ${noise}
  void main() {
    vec2 uv = vUv;
    float grain = vnoise(uv * vec2(120.0, 600.0)) * 0.025;
    vec3 asphalt = vec3(0.12, 0.125, 0.17) + grain * 2.0;
    float center = smoothstep(0.012, 0.0, abs(uv.x - 0.5)) * step(0.5, fract(uv.y * 30.0));
    float edges = smoothstep(0.012, 0.0, abs(uv.x - 0.06)) + smoothstep(0.012, 0.0, abs(uv.x - 0.94));
    vec3 col = asphalt + vec3(0.85, 0.7, 0.3) * center * 0.45 + vec3(0.7) * edges * 0.25;
    // reflexo quente dos rastros de fogo no asfalto
    float tracks = exp(-pow((uv.x - 0.35) * 18.0, 2.0)) + exp(-pow((uv.x - 0.65) * 18.0, 2.0));
    col += vec3(1.0, 0.35, 0.08) * tracks * clamp(uFire, 0.0, 1.0) * (1.0 - smoothstep(1.4, 2.0, uFire)) * 0.25;
    float fog = 1.0 - exp(-vDepth * 0.045);
    // cores pensadas em sRGB → espaço linear (o OutputPass converte de volta)
    gl_FragColor = vec4(pow(mix(col, uFog, fog), vec3(2.2)), 1.0);
  }
`;
