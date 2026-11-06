import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  beamFragment, beamVertex, fireFragment, fireVertex, roadFragment, roadVertex,
  skyFragment, skyVertex, vortexFragment, vortexVertex,
} from "./shaders";

const C = {
  midnight: new THREE.Color("#0C1233"),
  horizon: new THREE.Color("#1d1634"),
  glow: new THREE.Color("#ff6a1f"),
  flux: new THREE.Color("#5BD6FF"),
  fire: new THREE.Color("#FF6A1F"),
  red: new THREE.Color("#FF3344"),
};

type Target = { power: number; open: number; ready: number; hover: number; error: number };

/**
 * Cena do portal temporal. Tudo é dirigido por alvos numéricos (power/open/ready…)
 * que a cena persegue suavemente; a interface só muda os alvos e dispara eventos.
 */
export class PortalScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private clock = new THREE.Clock();
  private lowPower: boolean;
  private reducedMotion: boolean;
  private running = true;

  private target: Target = { power: 0, open: 0, ready: 0, hover: 0, error: 0 };
  private value: Target = { power: 0, open: 0, ready: 0, hover: 0, error: 0 };
  private pulse = 0;
  private fire = 0;
  private fireTarget = 0;
  private fireDir = 1;
  private shake = 0;
  private progress = 0;
  private pointer = new THREE.Vector2();
  private lookY = 1.2;

  private portal = new THREE.Group();
  private vortex!: THREE.ShaderMaterial;
  private ringGlow!: THREE.MeshBasicMaterial;
  private coils: THREE.MeshStandardMaterial[] = [];
  private beam!: THREE.ShaderMaterial;
  private beacon!: THREE.PointLight;
  private fireMats: THREE.ShaderMaterial[] = [];
  private roadMat!: THREE.ShaderMaterial;
  private arcs: { line: THREE.Line; mat: THREE.LineBasicMaterial; life: number }[] = [];
  private sparks!: { points: THREE.Points; pos: Float32Array; vel: Float32Array; life: Float32Array; next: number };
  private orbs: { sprite: THREE.Sprite; t: number; dir: 1 | -1 }[] = [];
  private orbTexture: THREE.Texture;
  private envMap!: THREE.Texture;
  private progressRing!: THREE.Mesh;

  constructor(private canvas: HTMLCanvasElement) {
    this.lowPower = matchMedia("(pointer: coarse)").matches || Math.min(innerWidth, innerHeight) < 600;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.lowPower, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.lowPower ? 1.25 : 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 1.7, 9.5);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    // reflexo só no cromo do portal; o resto da cena fica no escuro da noite
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.fog = new THREE.FogExp2(C.horizon.getHex(), 0.025);

    this.orbTexture = makeGlowTexture();
    this.buildSky();
    this.buildRoad();
    this.buildPortal();
    this.buildFireTrails();
    this.buildSparks();
    this.buildArcs();

    if (!this.lowPower) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.6, 0.35, 0.92));
      this.composer.addPass(new OutputPass());
    }

    this.resize();
    addEventListener("resize", () => this.resize());
    addEventListener("pointermove", (e) => {
      this.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    });
    document.addEventListener("visibilitychange", () => {
      this.running = !document.hidden;
      if (this.running) {
        this.clock.getDelta();
        this.loop();
      }
    });
    this.loop();
  }

  // ───────────────────────── API usada pela interface ─────────────────────────

  /** "Abrir portal": as bobinas acendem e o anel começa a girar energia. */
  powerOn() {
    this.target.power = 1;
    this.burstSparks(60);
    this.fireArc(3);
  }

  /** O vórtice se abre (quem envia ao gerar o código; quem recebe ao digitar o código). */
  open() {
    this.target.open = 1;
    this.pulse = 1;
    this.shake = 0.35;
    this.burstSparks(140);
    this.fireArc(6);
  }

  /** Sinal de luz: a outra ponta está pronta para receber. */
  signalReady() {
    this.target.ready = 1;
    this.pulse = 1;
    this.burstSparks(90);
    this.fireArc(4);
  }

  clearReady() {
    this.target.ready = 0;
  }

  setHover(on: boolean) {
    this.target.hover = on ? 1 : 0;
  }

  /** Teletransporte: o arquivo entra no portal (envio) ou sai dele (recebimento). */
  teleport(direction: "in" | "out") {
    this.fireDir = direction === "in" ? 1 : -1;
    this.fire = 0;
    this.fireTarget = 1.2;
    this.shake = 0.5;
    this.spawnOrb(direction === "in" ? 1 : -1);
  }

  setProgress(p: number) {
    this.progress = THREE.MathUtils.clamp(p, 0, 1);
    if (Math.random() < 0.05) this.fireArc(1);
  }

  /** Viagem concluída: clarão, faíscas e os rastros apagam. */
  complete() {
    this.pulse = 1;
    this.fireTarget = 2;
    this.burstSparks(160);
    this.progress = 0;
  }

  /** Portal desestabilizado (erro): pisca em vermelho. */
  error() {
    this.target.error = 1;
    this.shake = 0.4;
    this.fireArc(5);
    window.setTimeout(() => (this.target.error = 0), 1400);
  }

  close() {
    this.target = { power: 0, open: 0, ready: 0, hover: 0, error: 0 };
    this.fireTarget = 0;
    this.fire = 0;
    this.progress = 0;
  }

  // ───────────────────────────────── construção ─────────────────────────────────

  private buildSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(90, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uTop: { value: C.midnight }, uHorizon: { value: C.horizon }, uGlow: { value: C.glow } },
      }),
    );
    this.scene.add(sky);

    const count = this.lowPower ? 350 : 900;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(THREE.MathUtils.randFloat(0.08, 1));
      pos.set([80 * Math.sin(phi) * Math.cos(theta), 80 * Math.cos(phi), 80 * Math.sin(phi) * Math.sin(theta)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.scene.add(
      new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc8d0db, size: 0.18, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.75 })),
    );
  }

  private buildRoad() {
    this.roadMat = new THREE.ShaderMaterial({
      vertexShader: roadVertex,
      fragmentShader: roadFragment,
      uniforms: { uTime: { value: 0 }, uFire: { value: 0 }, uFog: { value: C.horizon.clone().convertLinearToSRGB() } },
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(5, 70), this.roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.z = -22;
    this.scene.add(road);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x0e0c1c, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    this.scene.add(ground);

    this.scene.add(new THREE.HemisphereLight(0x5b6cff, 0x1a0f10, 0.35));
  }

  private buildPortal() {
    this.portal.position.set(0, 2.3, 0);
    this.scene.add(this.portal);

    const chrome = new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 1, roughness: 0.28, envMap: this.envMap, envMapIntensity: this.lowPower ? 0.55 : 0.28 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2, 0.16, 32, 200), chrome);
    this.portal.add(ring);

    const outer = new THREE.Mesh(
      new THREE.TorusGeometry(2.24, 0.05, 16, 200),
      new THREE.MeshStandardMaterial({ color: 0x3a3f4f, metalness: 0.9, roughness: 0.4, envMap: this.envMap }),
    );
    this.portal.add(outer);

    this.ringGlow = new THREE.MeshBasicMaterial({ color: C.flux, transparent: true, opacity: 0, toneMapped: false });
    const glowRing = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.03, 12, 200), this.ringGlow);
    this.portal.add(glowRing);

    // Bobinas em volta do anel: acendem em sequência, como um capacitor carregando.
    const coilGeo = new THREE.BoxGeometry(0.22, 0.42, 0.26);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2a2f3c, metalness: 0.8, roughness: 0.35, envMap: this.envMap, envMapIntensity: 0.35, emissive: C.flux.clone(), emissiveIntensity: 0,
      });
      const coil = new THREE.Mesh(coilGeo, mat);
      coil.position.set(Math.cos(a) * 2.24, Math.sin(a) * 2.24, 0);
      coil.rotation.z = a - Math.PI / 2;
      this.portal.add(coil);
      this.coils.push(mat);
    }

    // Base cromada onde o anel encosta no asfalto.
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.22, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x5a6070, metalness: 1, roughness: 0.35, envMap: this.envMap, envMapIntensity: 0.7 }),
    );
    base.position.set(0, -2.1, 0);
    this.portal.add(base);

    this.vortex = new THREE.ShaderMaterial({
      vertexShader: vortexVertex,
      fragmentShader: vortexFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 }, uOpen: { value: 0 }, uReady: { value: 0 },
        uPulse: { value: 0 }, uHover: { value: 0 }, uError: { value: 0 },
      },
    });
    this.portal.add(new THREE.Mesh(new THREE.CircleGeometry(1.92, 128), this.vortex));

    // Anel de progresso da transmissão, rente à borda interna.
    this.progressRing = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 1.86, 160, 1, Math.PI / 2, 0.0001),
      new THREE.MeshBasicMaterial({ color: C.fire, transparent: true, opacity: 0.95, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.progressRing.position.z = 0.02;
    this.portal.add(this.progressRing);

    this.beam = new THREE.ShaderMaterial({
      vertexShader: beamVertex,
      fragmentShader: beamFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uBeam: { value: 0 }, uColor: { value: C.fire.clone().lerp(new THREE.Color(1, 1, 1), 0.25) } },
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.18, 34, 32, 1, true), this.beam);
    beam.geometry.translate(0, 17, 0);
    beam.position.y = 2.2;
    this.portal.add(beam);

    this.beacon = new THREE.PointLight(C.fire, 0, 14, 1.6);
    this.beacon.position.set(0, 0, 1.2);
    this.portal.add(this.beacon);
  }

  private buildFireTrails() {
    const perTrail = this.lowPower ? 260 : 560;
    for (const x of [-0.9, 0.9]) {
      const pos = new Float32Array(perTrail * 3);
      const t = new Float32Array(perTrail);
      const seed = new Float32Array(perTrail);
      for (let i = 0; i < perTrail; i++) {
        const k = i / perTrail;
        const z = THREE.MathUtils.lerp(8.5, 0.2, k);
        pos.set([x + (Math.random() - 0.5) * 0.12, 0.02, z + (Math.random() - 0.5) * 0.05], i * 3);
        t[i] = k;
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aT", new THREE.BufferAttribute(t, 1));
      g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
      const mat = new THREE.ShaderMaterial({
        vertexShader: fireVertex,
        fragmentShader: fireFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uFire: { value: 0 }, uDir: { value: 1 }, uPixel: { value: 1 } },
      });
      this.fireMats.push(mat);
      this.scene.add(new THREE.Points(g, mat));
    }
  }

  private buildSparks() {
    const n = this.lowPower ? 160 : 400;
    const pos = new Float32Array(n * 3).fill(9999);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.06, map: this.orbTexture, color: 0xbfefff, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    );
    this.portal.add(points);
    this.sparks = { points, pos, vel: new Float32Array(n * 3), life: new Float32Array(n), next: 0 };
  }

  private buildArcs() {
    for (let i = 0; i < 7; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(14 * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xd8f6ff, transparent: true, opacity: 0, toneMapped: false, blending: THREE.AdditiveBlending });
      const line = new THREE.Line(g, mat);
      line.position.z = 0.05;
      this.portal.add(line);
      this.arcs.push({ line, mat, life: 0 });
    }
  }

  // ─────────────────────────────── efeitos ───────────────────────────────

  private burstSparks(count: number) {
    const s = this.sparks;
    const n = s.life.length;
    const scale = this.reducedMotion ? 0.3 : 1;
    for (let k = 0; k < count * scale; k++) {
      const i = s.next;
      s.next = (s.next + 1) % n;
      const a = Math.random() * Math.PI * 2;
      const r = 2 + (Math.random() - 0.5) * 0.2;
      s.pos.set([Math.cos(a) * r, Math.sin(a) * r, (Math.random() - 0.5) * 0.2], i * 3);
      const speed = 1 + Math.random() * 2.5;
      s.vel.set([Math.cos(a) * speed * 0.6 + (Math.random() - 0.5), Math.sin(a) * speed * 0.6 + Math.random(), Math.random() * 2], i * 3);
      s.life[i] = 0.6 + Math.random() * 0.8;
    }
  }

  private fireArc(count: number) {
    if (this.reducedMotion) count = Math.min(count, 1);
    for (let k = 0; k < count; k++) {
      const arc = this.arcs.find((a) => a.life <= 0) ?? this.arcs[Math.floor(Math.random() * this.arcs.length)];
      const attr = arc.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      const a0 = Math.random() * Math.PI * 2;
      const toCenter = Math.random() < 0.35;
      const a1 = a0 + (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 1.1);
      const r0 = 1.95;
      for (let i = 0; i < 14; i++) {
        const t = i / 13;
        let x: number, y: number;
        if (toCenter) {
          const r = r0 * (1 - t * 0.9);
          x = Math.cos(a0) * r;
          y = Math.sin(a0) * r;
        } else {
          const a = THREE.MathUtils.lerp(a0, a1, t);
          const r = r0 - Math.sin(t * Math.PI) * (0.25 + Math.random() * 0.25);
          x = Math.cos(a) * r;
          y = Math.sin(a) * r;
        }
        const jitter = i === 0 || i === 13 ? 0 : 0.12;
        attr.setXYZ(i, x + (Math.random() - 0.5) * jitter, y + (Math.random() - 0.5) * jitter, 0);
      }
      attr.needsUpdate = true;
      arc.life = 0.18 + Math.random() * 0.2;
    }
  }

  private spawnOrb(dir: 1 | -1) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.orbTexture, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    sprite.scale.setScalar(0.8);
    this.scene.add(sprite);
    this.orbs.push({ sprite, t: 0, dir });
  }

  // ─────────────────────────────── laço ───────────────────────────────

  private resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    // em telas em pé, recua a câmera para o portal caber inteiro
    const portrait = w / h < 0.8;
    this.camera.position.z = portrait ? 14 : 10;
    // o portal fica no terço de cima; o painel de controles ocupa a parte de baixo
    this.lookY = portrait ? 0.2 : 1.05;
    this.camera.updateProjectionMatrix();
    for (const m of this.fireMats) m.uniforms.uPixel.value = this.renderer.getPixelRatio() * (h / 900);
  }

  private loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;
    const speed = this.reducedMotion ? 0.35 : 1;

    const v = this.value;
    const tgt = this.target;
    v.power = damp(v.power, tgt.power, 2.2, dt);
    v.open = damp(v.open, tgt.open, tgt.open > v.open ? 1.6 : 3, dt);
    v.ready = damp(v.ready, tgt.ready, 2.5, dt);
    v.hover = damp(v.hover, tgt.hover, 8, dt);
    v.error = damp(v.error, tgt.error, 6, dt);
    this.pulse = Math.max(0, this.pulse - dt * 0.9);
    this.shake = Math.max(0, this.shake - dt * 1.2);
    this.fire = damp(this.fire, this.fireTarget, this.fireTarget >= 2 ? 1.1 : 0.9, dt);
    if (this.fireTarget >= 2 && this.fire > 1.95) {
      this.fireTarget = 0;
      this.fire = 0;
    }

    const vt = time * speed;
    const u = this.vortex.uniforms;
    u.uTime.value = vt;
    u.uOpen.value = v.open;
    u.uReady.value = v.ready;
    u.uPulse.value = this.pulse;
    u.uHover.value = v.hover;
    u.uError.value = v.error;

    const flicker = 0.85 + 0.15 * Math.sin(time * 23) * Math.sin(time * 7);
    this.ringGlow.opacity = (0.1 + 0.6 * v.power) * flicker * Math.max(v.power, 0.05);
    this.ringGlow.color.copy(C.flux).lerp(C.fire, v.ready * 0.8).lerp(C.red, v.error).multiplyScalar(1 + v.power * 1.2);

    // bobinas acendem em onda girando
    this.coils.forEach((m, i) => {
      const wave = 0.5 + 0.5 * Math.sin(vt * (2 + v.open * 4) - i * 0.52);
      m.emissiveIntensity = v.power * (0.2 + wave * (0.8 + v.open * 1.2));
      m.emissive.copy(C.flux).lerp(C.fire, v.ready).lerp(C.red, v.error);
    });

    this.portal.rotation.z = 0;
    this.portal.children[0].rotation.z = vt * 0.05 * v.power;

    this.beam.uniforms.uTime.value = vt;
    this.beam.uniforms.uBeam.value = v.ready * (0.75 + 0.25 * Math.sin(time * 3));
    this.beacon.intensity = v.ready * 3 * (0.7 + 0.3 * Math.sin(time * 5)) + this.pulse * 4 + v.open * 1.2;
    this.beacon.color.copy(C.fire).lerp(C.flux, 1 - v.ready);

    // anel de progresso
    const geo = this.progressRing.geometry as THREE.RingGeometry;
    const len = Math.max(0.0001, this.progress * Math.PI * 2);
    if (Math.abs(geo.parameters.thetaLength - len) > 0.002) {
      geo.dispose();
      this.progressRing.geometry = new THREE.RingGeometry(1.8, 1.86, 160, 1, Math.PI / 2 - len, len);
    }

    for (const m of this.fireMats) {
      m.uniforms.uTime.value = time;
      m.uniforms.uFire.value = this.fire;
      m.uniforms.uDir.value = this.fireDir;
    }
    this.roadMat.uniforms.uFire.value = this.fire;

    // arcos elétricos
    if (v.open > 0.3 && Math.random() < dt * (1.5 + v.open * 3) * speed) this.fireArc(1);
    for (const arc of this.arcs) {
      arc.life -= dt;
      arc.mat.opacity = arc.life > 0 ? Math.min(1, arc.life * 8) * (0.6 + Math.random() * 0.4) : 0;
      arc.mat.color.copy(C.flux).lerp(new THREE.Color(1, 1, 1), 0.6).lerp(C.red, v.error);
    }

    this.updateSparks(dt);
    this.updateOrbs(dt);

    // câmera: leve paralaxe com o ponteiro e tremor nos teletransportes
    const cam = this.camera;
    const px = this.reducedMotion ? 0 : this.pointer.x * 0.45;
    const py = this.reducedMotion ? 0 : -this.pointer.y * 0.2;
    cam.position.x = damp(cam.position.x, px, 2, dt) + (Math.random() - 0.5) * this.shake * 0.08;
    cam.position.y = damp(cam.position.y, 1.45 + py, 2, dt) + (Math.random() - 0.5) * this.shake * 0.08;
    cam.lookAt(0, this.lookY, 0);

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  private updateSparks(dt: number) {
    const s = this.sparks;
    for (let i = 0; i < s.life.length; i++) {
      if (s.life[i] <= 0) continue;
      s.life[i] -= dt;
      const j = i * 3;
      s.vel[j + 1] -= 4.5 * dt;
      s.pos[j] += s.vel[j] * dt;
      s.pos[j + 1] += s.vel[j + 1] * dt;
      s.pos[j + 2] += s.vel[j + 2] * dt;
      if (s.life[i] <= 0) s.pos[j + 1] = 9999;
    }
    (s.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateOrbs(dt: number) {
    const start = new THREE.Vector3(0, 1.2, 7.5);
    const end = new THREE.Vector3(0, 2.3, 0);
    for (const orb of [...this.orbs]) {
      orb.t += dt / 1.1;
      const k = Math.min(orb.t, 1);
      const e = orb.dir === 1 ? easeIn(k) : 1 - easeIn(1 - k);
      const from = orb.dir === 1 ? start : end;
      const to = orb.dir === 1 ? end : start;
      orb.sprite.position.lerpVectors(from, to, e);
      orb.sprite.position.y += Math.sin(k * Math.PI) * 0.6;
      const size = orb.dir === 1 ? 0.9 * (1 - k * 0.9) : 0.1 + k * 0.8;
      orb.sprite.scale.setScalar(size);
      (orb.sprite.material as THREE.SpriteMaterial).opacity = orb.dir === 1 ? 1 : 1 - Math.max(0, k - 0.75) * 4;
      if (orb.t >= 1) {
        if (orb.dir === 1) {
          this.pulse = 1;
          this.burstSparks(50);
        }
        this.scene.remove(orb.sprite);
        orb.sprite.material.dispose();
        this.orbs.splice(this.orbs.indexOf(orb), 1);
      }
    }
  }
}

function damp(current: number, target: number, lambda: number, dt: number) {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

function easeIn(t: number) {
  return t * t * t;
}

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(190,240,255,0.9)");
  grad.addColorStop(0.6, "rgba(91,214,255,0.25)");
  grad.addColorStop(1, "rgba(91,214,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
