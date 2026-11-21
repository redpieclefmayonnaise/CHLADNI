import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { MODES, PLATE, plateRadialCoefficient, plateRadialMode, modesFromSpectrum, modeRow } from './chladni.js';
import './style.css';

const $ = (id) => document.getElementById(id);
let sourceType = 'none', youtubePlayer = null, youtubeApiPromise = null, youtubeReady = false, youtubePlaying = false, youtubeTime = 0, youtubeDuration = 0, youtubeVideoId = '';
let loaded = false, simulationActive = false, kickPending = false;
let captureAudioContext = null, captureAnalyser = null, captureSource = null, captureStream = null, captureWaveform = null, captureSpectrum = null;
const liveFeatures = { energy: 0, centroid: 0, peak: 0 };
function sampleLiveAudio() {
  if (sourceType === 'youtube' && youtubePlaying && captureAnalyser) return sampleAnalyser(captureAnalyser, captureAudioContext, captureWaveform, captureSpectrum);
  return null;
}
function sampleAnalyser(analyser, context, waveform, spectrum) {
  analyser.getFloatTimeDomainData(waveform);
  analyser.getByteFrequencyData(spectrum);
  let sum = 0, weighted = 0, total = 0, peak = 0, peakBin = 0;
  for (let i = 0; i < waveform.length; i++) sum += waveform[i] * waveform[i];
  for (let i = 1; i < spectrum.length; i++) {
    const value = spectrum[i] / 255;
    const hz = i * context.sampleRate / analyser.fftSize;
    weighted += hz * value; total += value;
    if (value > peak) { peak = value; peakBin = i; }
  }
  const rms = Math.sqrt(sum / waveform.length);
  liveFeatures.energy = THREE.MathUtils.clamp((20 * Math.log10(rms + 1e-6) + 52) / 44, 0, 1);
  liveFeatures.centroid = total ? weighted / total : 0;
  liveFeatures.peak = liveFeatures.energy > .018 && peak > .035 ? peakBin * context.sampleRate / analyser.fftSize : 0;
  liveFeatures.modes = liveFeatures.energy > .018 ? modesFromSpectrum(spectrum, context.sampleRate, analyser.fftSize) : [];
  return liveFeatures;
}
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 0);
$('visualizer').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
camera.up.set(0, 0, 1);
camera.position.set(0, -16, 10);
const root = new THREE.Group();
scene.add(root);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.rotateSpeed = 1;
controls.zoomSpeed = .9;
controls.minPolarAngle = .08;
controls.maxPolarAngle = Math.PI / 2 - .045;
controls.minDistance = 10;
controls.maxDistance = 48;
let frontAzimuth = null;
let baseCameraDistance = 18, cameraZoom = 1, cameraFitReady = false, cameraView = 'top';
const ambient = new THREE.PointLight(0x67dfff, 13, 22); ambient.position.set(-4, 3, 5); scene.add(ambient);
const violet = new THREE.PointLight(0x8b5dff, 8, 20); violet.position.set(4, -2, 4); scene.add(violet);
const sweepLight = new THREE.PointLight(0x9aeaff, 4.2, 17, 1.8); scene.add(sweepLight);

const simulationSize = 128;
const count = simulationSize * simulationSize;
const radialWidth = 512;
const radialPixels = new Uint8Array(radialWidth * MODES.length * 4);
function updateRadialPixels() {
  for (let row = 0; row < MODES.length; row++) {
    const mode = MODES[row], radial = new Float32Array(radialWidth), coefficient = plateRadialCoefficient(mode);
    let maxAbs = 0;
    for (let x = 0; x < radialWidth; x++) { radial[x] = plateRadialMode(mode, x / (radialWidth - 1), coefficient); maxAbs = Math.max(maxAbs, Math.abs(radial[x])); }
    for (let x = 0; x < radialWidth; x++) {
      const value = maxAbs ? Math.max(-1, Math.min(1, radial[x] / maxAbs)) : 0;
      const encoded = Math.round((value * .5 + .5) * 255), pixel = (row * radialWidth + x) * 4;
      radialPixels[pixel] = encoded; radialPixels[pixel + 1] = encoded; radialPixels[pixel + 2] = encoded; radialPixels[pixel + 3] = 255;
    }
  }
  radialTexture.needsUpdate = true;
}
const radialTexture = new THREE.DataTexture(radialPixels, radialWidth, MODES.length, THREE.RGBAFormat, THREE.UnsignedByteType);
radialTexture.minFilter = THREE.LinearFilter; radialTexture.magFilter = THREE.LinearFilter;
radialTexture.wrapS = THREE.ClampToEdgeWrapping; radialTexture.wrapT = THREE.ClampToEdgeWrapping;
radialTexture.generateMipmaps = false; radialTexture.flipY = false; radialTexture.needsUpdate = true;
updateRadialPixels();
const positions = new Float32Array(count * 3);
const colors = new Float32Array(count * 3);
const colorPhase = new Float32Array(count);
const sizes = new Float32Array(count);
const homePositions = new Float32Array(count * 3);
const velocities = new Float32Array(count * 2);
const references = new Float32Array(count * 2);
let seed = 0x435a1;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let i = 0; i < count; i++) {
  const r = Math.sqrt(random()) * .10, a = random() * Math.PI * 2;
  positions[i * 3] = Math.cos(a) * r; positions[i * 3 + 1] = Math.sin(a) * r; positions[i * 3 + 2] = (random() - .5) * .55;
  const t = random(); colorPhase[i] = t; colors[i * 3] = .19 + .57 * t; colors[i * 3 + 1] = .55 + .29 * (1 - t); colors[i * 3 + 2] = .98 - .1 * t;
  sizes[i] = .32 + random() * .6;
  references[i * 2] = ((i % simulationSize) + .5) / simulationSize;
  references[i * 2 + 1] = (Math.floor(i / simulationSize) + .5) / simulationSize;
}
homePositions.set(positions);
const geometry = new THREE.BufferGeometry();
const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
geometry.setAttribute('position', positionAttribute);
geometry.setAttribute('reference', new THREE.BufferAttribute(references, 2));
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 5.8);
const orbPalette = ['#53ffd2', '#5cd5ff', '#8b8cff', '#ef8cff'].map(hex => new THREE.Color(hex));
function applyOrbColors() {
  const stops = orbPalette;
  for (let i = 0; i < count; i++) {
    const scaled = colorPhase[i] * (stops.length - 1);
    const segment = Math.min(stops.length - 2, Math.floor(scaled));
    const mix = scaled - segment, a = stops[segment], b = stops[segment + 1], p = i * 3;
    colors[p] = a.r + (b.r - a.r) * mix;
    colors[p + 1] = a.g + (b.g - a.g) * mix;
    colors[p + 2] = a.b + (b.b - a.b) * mix;
  }
  geometry.attributes.color.needsUpdate = true;
}
applyOrbColors();
const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true, blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uGlow: { value: 2.8 }, uParticleSize: { value: .6 }, uEnergy: { value: 0.14 }, uTone: { value: .25 }, uRelief: { value: 1.7 }, uModeLut: { value: radialTexture }, uRows: { value: MODES.length }, uModeRows: { value: new Float32Array(3) }, uOrders: { value: new Float32Array(3) }, uWeights: { value: new Float32Array(3) }, uParticles: { value: radialTexture }, uUseGpu: { value: 0 } },
  vertexShader: `
    attribute float size; attribute vec2 reference;
    uniform float uTime,uEnergy,uTone,uRelief,uRows,uUseGpu,uParticleSize;
    uniform float uModeRows[3],uOrders[3],uWeights[3];
    uniform sampler2D uModeLut,uParticles;
    varying vec3 vColor; varying float vAlpha;
    void main(){
      vec3 p=position;
      if(uUseGpu>.5){vec4 state=texture2D(uParticles,reference);p.xy=state.xy*5.0;p.z=0.0;}
      float r=min(length(p.xy)/5.0,.999), theta=atan(p.y,p.x);
      float f0=(texture2D(uModeLut,vec2(r,(uModeRows[0]+.5)/uRows)).r*2.0-1.0)*cos(uOrders[0]*theta);
      float f1=(texture2D(uModeLut,vec2(r,(uModeRows[1]+.5)/uRows)).r*2.0-1.0)*cos(uOrders[1]*theta);
      float f2=(texture2D(uModeLut,vec2(r,(uModeRows[2]+.5)/uRows)).r*2.0-1.0)*cos(uOrders[2]*theta);
      float weightSum=max(.001,uWeights[0]+uWeights[1]+uWeights[2]);
      float wave=(f0*uWeights[0]+f1*uWeights[1]+f2*uWeights[2])/weightSum;
      float mask=1.0-smoothstep(.016,.11,abs(wave));
      p.z=wave*(.42+uEnergy*.7)*sin(uTime*4.4)*uRelief;
      vec4 mv=modelViewMatrix*vec4(p,1.);
      gl_Position=projectionMatrix*mv;
      gl_PointSize=size*uParticleSize*3.2*(1.18+uEnergy*1.45)*(30.0/-mv.z);
      vColor=color*(1.65+uTone*.25+uEnergy*.35);
      vAlpha=(.28+mask*.9)*(.62+uEnergy*.58);
    }`,
  fragmentShader: `
    uniform float uGlow;
    varying vec3 vColor; varying float vAlpha;
    void main(){
      vec2 point=gl_PointCoord-.5;
      float distanceToCenter=length(point);
      vec2 spherePoint=point*2.0;
      float radiusSquared=dot(spherePoint,spherePoint);
      if(radiusSquared>1.12)discard;
      vec3 normal=vec3(spherePoint,sqrt(max(.001,1.0-min(radiusSquared,1.0))));
      vec3 lightDirection=normalize(vec3(-.45,.62,.85));
      float diffuse=.28+.72*max(dot(normal,lightDirection),0.0);
      float specular=pow(max(dot(reflect(-lightDirection,normal),vec3(0.0,0.0,1.0)),0.0),20.0);
      float sphereCore=1.0-smoothstep(.78,1.0,radiusSquared);
      float orbHalo=exp(-distanceToCenter*5.8)*.58;
      vec3 orbColor=vColor*(.34+diffuse*.82)+vec3(.82,.94,1.0)*specular*.75;
      float orbAlpha=(sphereCore*.96+orbHalo)*vAlpha;
      gl_FragColor=vec4(orbColor*uGlow*.78,orbAlpha);
    }`
});
const points = new THREE.Points(geometry, material); root.add(points);

const plateMaterial = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  uniforms: {
    uTime: { value: 0 }, uEnergy: { value: .14 }, uRelief: { value: 1.7 }, uRows: { value: MODES.length }, uModeLut: { value: radialTexture },
    uModeRows: { value: material.uniforms.uModeRows.value }, uOrders: { value: material.uniforms.uOrders.value }, uWeights: { value: material.uniforms.uWeights.value }
  },
  vertexShader: `uniform float uTime,uEnergy,uRelief,uRows,uModeRows[3],uOrders[3],uWeights[3]; uniform sampler2D uModeLut; varying float vRadius,vActivity;
float radialValue(float r,float row){return texture2D(uModeLut,vec2(min(r,.999),(row+.5)/uRows)).r*2.0-1.0;}
void main(){vec3 p=position;float r=length(p.xy)/5.0;float a=atan(p.y,p.x);float m0=radialValue(r,uModeRows[0])*cos(uOrders[0]*a);float m1=radialValue(r,uModeRows[1])*cos(uOrders[1]*a);float m2=radialValue(r,uModeRows[2])*cos(uOrders[2]*a);float s0=sin(uTime*(3.3+uOrders[0]*.16));float s1=sin(uTime*(3.8+uOrders[1]*.16)+1.1);float s2=sin(uTime*(4.2+uOrders[2]*.16)+2.2);float sum=max(.001,uWeights[0]+uWeights[1]+uWeights[2]);float wave=(m0*uWeights[0]*s0+m1*uWeights[1]*s1+m2*uWeights[2]*s2)/sum;float activity=sqrt(m0*m0*uWeights[0]+m1*m1*uWeights[1]+m2*m2*uWeights[2])/sqrt(sum);p.z=wave*(.16+uEnergy*.3)*uRelief;vRadius=r;vActivity=activity;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
  fragmentShader: `varying float vRadius,vActivity; void main(){if(vRadius>1.0)discard;float edge=1.0-smoothstep(.94,1.0,vRadius);float bands=pow(max(0.0,sin(vActivity*26.0)),12.0);vec3 base=mix(vec3(.008,.018,.032),vec3(.025,.13,.19),smoothstep(0.0,.7,vActivity));vec3 color=base+vec3(.12,.5,.68)*bands*.55;float alpha=(.15+vActivity*.11+bands*.13)*edge;gl_FragColor=vec4(color,alpha);}`
});
const plate = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 128, 128), plateMaterial);
const plateBody = new THREE.Mesh(
  new THREE.CylinderGeometry(5, 5, 1, 192, 1, true),
  new THREE.MeshStandardMaterial({ color: 0x132531, metalness: .84, roughness: .24, emissive: 0x06202e, emissiveIntensity: .65 })
);
plateBody.rotation.x = Math.PI / 2;
const plateRim = new THREE.Mesh(
  new THREE.TorusGeometry(5, .034, 8, 192),
  new THREE.MeshStandardMaterial({ color: 0x39738a, metalness: .78, roughness: .2, emissive: 0x14516a, emissiveIntensity: .8 })
);
function updatePlateThicknessVisual() {
  const depth = THREE.MathUtils.clamp(PLATE.thickness / PLATE.diameter * 40, .08, .42);
  plateBody.scale.y = depth;
  plateBody.position.z = -depth / 2 - .012;
  plateRim.position.z = .006;
}
updatePlateThicknessVisual();
plateBody.renderOrder = 0; plate.renderOrder = 1; plateRim.renderOrder = 2; points.renderOrder = 3;
root.add(plateBody, plate, plateRim, points);

const computeShader = `uniform sampler2D uModeLut; uniform float uRows,uDelta,uStrength,uDamping,uTime,uEnergy,uKick; uniform float uModeRows[3],uOrders[3],uWeights[3];
float modeAmplitude(vec2 p,float row,float order){float r=min(length(p),.999);float radial=texture2D(uModeLut,vec2(r,(row+.5)/uRows)).r*2.0-1.0;return radial*cos(order*atan(p.y,p.x));}
float potential(vec2 p){float a=modeAmplitude(p,uModeRows[0],uOrders[0]);float b=modeAmplitude(p,uModeRows[1],uOrders[1]);float c=modeAmplitude(p,uModeRows[2],uOrders[2]);return uWeights[0]*a*a+uWeights[1]*b*b+uWeights[2]*c*c;}
float signedWave(vec2 p){return uWeights[0]*modeAmplitude(p,uModeRows[0],uOrders[0])+uWeights[1]*modeAmplitude(p,uModeRows[1],uOrders[1])+uWeights[2]*modeAmplitude(p,uModeRows[2],uOrders[2]);}
void main(){vec2 uv=gl_FragCoord.xy/resolution.xy;vec4 state=texture2D(textureParticles,uv);vec2 p=state.xy;float e=.006;vec2 grad=vec2(potential(p+vec2(e,0.0))-potential(p-vec2(e,0.0)),potential(p+vec2(0.0,e))-potential(p-vec2(0.0,e)))/(2.0*e);float excitation=abs(signedWave(p));float phase=uTime*7.5+dot(uv,vec2(31.7,19.3));float shake=excitation*uEnergy*1.7;vec2 drive=vec2(sin(phase),cos(phase*1.13+uv.x*4.0))*shake;vec2 acceleration=-grad*uStrength+drive;vec2 velocity=(state.zw+acceleration*uDelta)*exp(-uDamping*uDelta);if(uKick>.5)velocity+=normalize(p+vec2(sin(uv.y*91.0),cos(uv.x*73.0))*.0005)*.95;float speed=length(velocity);if(speed>3.8)velocity*=3.8/speed;vec2 next=p+velocity*uDelta;float radius=length(next);if(radius>.993){next*=.993/radius;velocity*= -.22;}gl_FragColor=vec4(next,velocity);}`;
let gpuCompute = null, particleVariable = null, particleInitialTexture = null, useGpuSimulation = false;
try {
  gpuCompute = new GPUComputationRenderer(simulationSize, simulationSize, renderer);
  const initial = particleInitialTexture = gpuCompute.createTexture(), initialData = initial.image.data;
  for (let i = 0; i < count; i++) { const p = i * 3, t = i * 4; initialData[t] = positions[p] / 5; initialData[t + 1] = positions[p + 1] / 5; initialData[t + 2] = 0; initialData[t + 3] = 0; }
  particleVariable = gpuCompute.addVariable('textureParticles', computeShader, initial);
  gpuCompute.setVariableDependencies(particleVariable, [particleVariable]);
  particleVariable.wrapS = THREE.ClampToEdgeWrapping; particleVariable.wrapT = THREE.ClampToEdgeWrapping;
  const computeUniforms = particleVariable.material.uniforms;
  computeUniforms.uModeLut = { value: radialTexture }; computeUniforms.uRows = { value: MODES.length };
  computeUniforms.uModeRows = { value: new Float32Array(3) }; computeUniforms.uOrders = { value: new Float32Array(3) }; computeUniforms.uWeights = { value: new Float32Array(3) };
  computeUniforms.uDelta = { value: 1 / 60 }; computeUniforms.uStrength = { value: 42 }; computeUniforms.uDamping = { value: 1.15 }; computeUniforms.uTime = { value: 0 }; computeUniforms.uEnergy = { value: .14 }; computeUniforms.uKick = { value: 0 };
  const computeError = gpuCompute.init();
  if (computeError) throw new Error(computeError);
  useGpuSimulation = true;
  material.uniforms.uUseGpu.value = 1;
  material.uniforms.uParticles.value = gpuCompute.getCurrentRenderTarget(particleVariable).texture;
} catch (error) {
  console.warn('GPU particle simulation unavailable; using the compatible particle fallback.', error);
  gpuCompute?.dispose(); gpuCompute = null; particleVariable = null;
}

let width = 1, height = 1, relief = 1.7, seeking = false, lastHudUpdate = 0;
const glow = 2.8;
const fallbackMode = { m: 2, n: 2 };
const modalWeights = new Float32Array(MODES.length);
const targetModalWeights = new Float32Array(MODES.length);
const modeRowsUniform = material.uniforms.uModeRows.value;
const ordersUniform = material.uniforms.uOrders.value;
const weightsUniform = material.uniforms.uWeights.value;
const settleGridSize = 96;
const settleField = new Float32Array(settleGridSize * settleGridSize);
const settleGradientX = new Float32Array(settleField.length);
const settleGradientY = new Float32Array(settleField.length);
const settleWaveField = new Float32Array(settleField.length);
let settleRows = [-1, -1, -1], settleWeights = [0, 0, 0], lastFieldBuild = -Infinity;

function resetParticles() {
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(random()) * .10, angle = random() * Math.PI * 2, p = i * 3, v = i * 2;
    positions[p] = Math.cos(angle) * r;
    positions[p + 1] = Math.sin(angle) * r;
    positions[p + 2] = 0;
    velocities[v] = velocities[v + 1] = 0;
  }
  homePositions.set(positions);
  positionAttribute.needsUpdate = true;
  simulationActive = false;
  kickPending = true;
  if (useGpuSimulation && gpuCompute && particleInitialTexture && particleVariable) {
    const data = particleInitialTexture.image.data;
    for (let i = 0; i < count; i++) {
      const p = i * 3, state = i * 4;
      data[state] = positions[p] / 5;
      data[state + 1] = positions[p + 1] / 5;
      data[state + 2] = 0;
      data[state + 3] = 0;
    }
    particleInitialTexture.needsUpdate = true;
    gpuCompute.renderTexture(particleInitialTexture, particleVariable.renderTargets[0]);
    gpuCompute.renderTexture(particleInitialTexture, particleVariable.renderTargets[1]);
    gpuCompute.currentTextureIndex = 0;
    particleVariable.material.uniforms.uKick.value = 0;
    material.uniforms.uParticles.value = particleVariable.renderTargets[0].texture;
  }
}

function kickParticles() {
  simulationActive = true;
  if (!kickPending) return;
  if (useGpuSimulation && particleVariable) {
    particleVariable.material.uniforms.uKick.value = 1;
  } else {
    for (let i = 0; i < count; i++) {
      const p = i * 3, v = i * 2, length = Math.hypot(positions[p], positions[p + 1]) || .0001;
      velocities[v] = positions[p] / length * 2.4;
      velocities[v + 1] = positions[p + 1] / length * 2.4;
    }
  }
  kickPending = false;
}

function radialValue(row, radius) {
  const x = THREE.MathUtils.clamp(radius, 0, .9999) * (radialWidth - 1);
  const lo = Math.floor(x), hi = Math.min(radialWidth - 1, lo + 1), t = x - lo;
  const a = radialPixels[(row * radialWidth + lo) * 4] / 255 * 2 - 1;
  const b = radialPixels[(row * radialWidth + hi) * 4] / 255 * 2 - 1;
  return a + (b - a) * t;
}
function rebuildSettlingField(rows, weights, now) {
  if (now - lastFieldBuild < .065 && rows.every((row, i) => row === settleRows[i]) && weights.every((weight, i) => Math.abs(weight - settleWeights[i]) < .08)) return;
  settleRows = [...rows]; settleWeights = [...weights]; lastFieldBuild = now;
  const size = settleGridSize, step = 2 / (size - 1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / (size - 1) * 2 - 1, ny = y / (size - 1) * 2 - 1;
    const radius = Math.hypot(nx, ny), sampleRadius = Math.min(radius, .999), index = y * size + x;
    const theta = Math.atan2(ny, nx);
    let value = 0, wave = 0;
    for (let k = 0; k < 3; k++) if (weights[k] > .001) {
      const modal = MODES[rows[k]];
      const displacement = radialValue(rows[k], sampleRadius) * Math.cos(modal.m * theta);
      value += weights[k] * displacement * displacement;
      wave += weights[k] * displacement;
    }
    settleField[index] = value;
    settleWaveField[index] = wave;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = y * size + x, left = y * size + Math.max(0, x - 1), right = y * size + Math.min(size - 1, x + 1);
    const down = Math.max(0, y - 1) * size + x, up = Math.min(size - 1, y + 1) * size + x;
    settleGradientX[index] = (settleField[right] - settleField[left]) / ((x === 0 || x === size - 1 ? step : 2 * step));
    settleGradientY[index] = (settleField[up] - settleField[down]) / ((y === 0 || y === size - 1 ? step : 2 * step));
  }
}
function sampleGrid(values, nx, ny) {
  const size = settleGridSize;
  const x = THREE.MathUtils.clamp((nx + 1) * .5 * (size - 1), 0, size - 1.001);
  const y = THREE.MathUtils.clamp((ny + 1) * .5 * (size - 1), 0, size - 1.001);
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const i = y0 * size + x0, j = i + 1, k = i + size, l = k + 1;
  const a = values[i] + (values[j] - values[i]) * tx;
  const b = values[k] + (values[l] - values[k]) * tx;
  return a + (b - a) * ty;
}
function settleParticles(dt, energy, now) {
  if (!simulationActive || dt <= 0) return;
  const damping = Math.exp(-1.15 * dt), strength = 38 + energy * 26;
  for (let i = 0; i < count; i++) {
    const p = i * 3, v = i * 2, x = positions[p], y = positions[p + 1], nx = x / 5, ny = y / 5;
    const gx = sampleGrid(settleGradientX, nx, ny) / 5, gy = sampleGrid(settleGradientY, nx, ny) / 5;
    const excitation = Math.abs(sampleGrid(settleWaveField, nx, ny));
    const phase = now * 7.5 + i * 2.39996323, shake = excitation * energy * 1.7;
    let vx = (velocities[v] - gx * strength * dt + Math.sin(phase) * shake * dt) * damping;
    let vy = (velocities[v + 1] - gy * strength * dt + Math.cos(phase * 1.13 + nx * 2) * shake * dt) * damping;
    const speed = Math.hypot(vx, vy);
    if (speed > 5.2) { vx *= 5.2 / speed; vy *= 5.2 / speed; }
    let px = x + vx * dt, py = y + vy * dt;
    const radius = Math.hypot(px, py);
    if (radius > 4.96) { px *= 4.96 / radius; py *= 4.96 / radius; vx *= -.25; vy *= -.25; }
    positions[p] = px; positions[p + 1] = py; positions[p + 2] = 0;
    velocities[v] = vx; velocities[v + 1] = vy;
  }
  positionAttribute.needsUpdate = true;
}
const resize = () => {
  const r = $('visualizer').getBoundingClientRect();
  width = Math.max(1, r.width); height = Math.max(1, r.height);
  const oldZoom = cameraFitReady ? controls.getDistance() / baseCameraDistance : 1;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  baseCameraDistance = Math.max(15, 11.8 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect)));
  if (!cameraFitReady) {
    const initialPolar = .09;
    camera.position.set(0, -baseCameraDistance * Math.sin(initialPolar), baseCameraDistance * Math.cos(initialPolar));
    cameraFitReady = true;
  } else {
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, baseCameraDistance * oldZoom);
  }
  cameraZoom = oldZoom;
  controls.update();
  if (frontAzimuth === null) frontAzimuth = controls.getAzimuthalAngle();
  if (frontAzimuth !== null) {
    controls.minAzimuthAngle = frontAzimuth - 1.42;
    controls.maxAzimuthAngle = frontAzimuth + 1.42;
  }
  cameraFitReady = true;
};
controls.addEventListener('change', () => { cameraZoom = controls.getDistance() / baseCameraDistance; });
new ResizeObserver(resize).observe($('visualizer')); resize();
const clock = new THREE.Timer();
clock.connect(document);
modalWeights[modeRow(fallbackMode)] = 1;
function render(timestamp) {
  requestAnimationFrame(render);
  clock.update(timestamp);
  const dt = Math.min(clock.getDelta(), .04), t = clock.getElapsed();
  sweepLight.position.set(Math.cos(t * .3) * 7.1, Math.sin(t * .3) * 7.1, 2.7 + Math.sin(t * .43) * .9);
  const live = sampleLiveAudio();
  const youtubePulse = sourceType === 'youtube' && youtubePlaying ? .12 + .08 * (1 + Math.sin(getSourceTime() * 5.1)) + .035 * (1 + Math.sin(getSourceTime() * 11.7 + .8)) : .08;
  const energy = live ? Math.max(youtubePulse * .3, live.energy) : youtubePulse;
  const tone = live?.centroid || 1500;
  const fallback = fallbackMode;
  targetModalWeights.fill(0);
  if (live?.modes?.length) {
    for (const item of live.modes) targetModalWeights[item.modeIndex] += item.weight;
  } else targetModalWeights[modeRow(fallback)] = 1;
  const follow = 1 - Math.exp(-dt * 150);
  let weightTotal = 0;
  for (let i = 0; i < modalWeights.length; i++) { modalWeights[i] += (targetModalWeights[i] - modalWeights[i]) * follow; weightTotal += modalWeights[i]; }
  if (weightTotal < .001) { const row = modeRow(fallback); modalWeights[row] = 1; weightTotal = 1; }
  const selectedRows = [-1, -1, -1], selectedWeights = [0, 0, 0];
  for (let rank = 0; rank < 3; rank++) {
    let bestRow = -1, bestWeight = 0;
    for (let i = 0; i < modalWeights.length; i++) if (!selectedRows.includes(i) && modalWeights[i] > bestWeight) { bestWeight = modalWeights[i]; bestRow = i; }
    if (bestRow < 0) { bestRow = modeRow(fallback); bestWeight = rank === 0 ? 1 : 0; }
    selectedRows[rank] = bestRow; selectedWeights[rank] = bestWeight / weightTotal;
    modeRowsUniform[rank] = bestRow; ordersUniform[rank] = MODES[bestRow].m; weightsUniform[rank] = selectedWeights[rank];
  }
  material.uniforms.uTime.value = t; material.uniforms.uEnergy.value = energy; material.uniforms.uTone.value = THREE.MathUtils.clamp(tone / 5000, 0, 1); material.uniforms.uGlow.value = glow; material.uniforms.uRelief.value = relief;
  plateMaterial.uniforms.uTime.value = t; plateMaterial.uniforms.uEnergy.value = energy; plateMaterial.uniforms.uRelief.value = relief;
  const vibrationEnergy = sourceIsPlaying() ? energy : 0;
  if (useGpuSimulation && simulationActive) {
    const uniforms = particleVariable.material.uniforms;
    uniforms.uModeRows.value = modeRowsUniform; uniforms.uOrders.value = ordersUniform; uniforms.uWeights.value = weightsUniform;
    uniforms.uDelta.value = dt; uniforms.uStrength.value = 42 + vibrationEnergy * 28; uniforms.uDamping.value = 1.15; uniforms.uTime.value = t; uniforms.uEnergy.value = vibrationEnergy;
    gpuCompute.compute();
    uniforms.uKick.value = 0;
    material.uniforms.uParticles.value = gpuCompute.getCurrentRenderTarget(particleVariable).texture;
  } else if (!useGpuSimulation) {
    rebuildSettlingField(selectedRows, selectedWeights, t);
    settleParticles(dt, vibrationEnergy, t);
  }
  points.material.opacity = 1;
  controls.update();
  renderer.render(scene, camera);
  if (t - lastHudUpdate > .08) { updateReadout(live, selectedRows[0]); lastHudUpdate = t; }
}
function updateReadout(live = null, activeRow = null) {
  const activeMode = activeRow === null ? null : MODES[activeRow];
  const [readoutM, readoutN] = activeMode ? [activeMode.m, activeMode.n] : [fallbackMode.m, fallbackMode.n];
  const displayedFrequency = live?.peak || 0;
  const displayedCentroid = live?.centroid || 0;
  $('frequency-readout').textContent = displayedFrequency ? `${Math.round(displayedFrequency).toLocaleString()} Hz` : '—';
  $('mode-label').textContent = `PLATE MODE · m${readoutM} / n${readoutN}`;
  $('pattern-caption').textContent = sourceType === 'youtube' && !live
    ? 'YouTube timing sync · share tab audio for a live spectrum'
    : `Live mode ${readoutM},${readoutN} · ${displayedCentroid < 900 ? 'low' : displayedCentroid < 2600 ? 'mid' : 'high'} spectral center`;
  $('stage-state').textContent = sourceIsPlaying() ? 'RESONATING' : loaded ? 'YOUTUBE READY' : 'AWAITING A SIGNAL';
}
render();

const formatTime = (s) => `${Math.floor(Math.max(0,s)/60)}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,'0')}`;
function getSourceTime() { return youtubeTime; }
function getSourceDuration() { return youtubeDuration; }
function sourceIsPlaying() { return youtubePlaying; }
function setPlaybackUi(playing) {
  $('play-icon').textContent = playing ? 'Ⅱ' : '▶';
  $('play-button').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('stage-state').textContent = playing ? 'RESONATING' : loaded ? 'YOUTUBE READY' : 'AWAITING A SIGNAL';
}
function updateTimeline() {
  const current = getSourceTime(), duration = getSourceDuration();
  if (duration > 0) $('duration').textContent = formatTime(duration);
  if (!seeking && duration > 0) $('seek').value = String(Math.round(current / duration * 1000));
  if (!seeking) $('current-time').textContent = formatTime(current);
}
function stopYoutubeCapture() {
  captureStream?.getTracks().forEach(track => track.stop());
  captureStream = null;
  captureSource?.disconnect(); captureSource = null;
  captureAnalyser = null; captureWaveform = null; captureSpectrum = null;
  if (captureAudioContext && captureAudioContext.state !== 'closed') captureAudioContext.close();
  captureAudioContext = null;
}
async function enableYoutubeCapture() {
  if (captureStream) {
    stopYoutubeCapture();
    $('capture-youtube-audio').textContent = 'ENABLE LIVE TAB AUDIO';
    $('youtube-feedback').textContent = 'Live spectrum stopped. YouTube playback remains synchronized.';
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('youtube-feedback').textContent = 'Live tab-audio capture is unavailable in this browser. YouTube playback will still stay in sync.';
    return;
  }
  $('capture-youtube-audio').disabled = true;
  $('youtube-feedback').textContent = 'Choose this browser tab and include its audio in the share prompt.';
  try {
    stopYoutubeCapture();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach(track => track.stop());
      $('youtube-feedback').textContent = 'No tab audio was shared. Try again and enable “Share tab audio”.';
      return;
    }
    captureStream = stream;
    captureAudioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    captureAnalyser = captureAudioContext.createAnalyser();
    captureAnalyser.fftSize = 1024;
    captureAnalyser.smoothingTimeConstant = 0;
    captureWaveform = new Float32Array(captureAnalyser.fftSize);
    captureSpectrum = new Uint8Array(captureAnalyser.frequencyBinCount);
    captureSource = captureAudioContext.createMediaStreamSource(captureStream);
    captureSource.connect(captureAnalyser);
    await captureAudioContext.resume();
    captureStream.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (sourceType === 'youtube') {
        $('youtube-feedback').textContent = 'Live tab-audio sharing ended. Playback is still synced without spectrum.';
        $('capture-youtube-audio').textContent = 'ENABLE LIVE TAB AUDIO';
      }
      stopYoutubeCapture();
    }, { once: true }));
    $('youtube-feedback').textContent = 'LIVE SPECTRUM CONNECTED · play the video to drive the plate from its audio.';
    $('capture-youtube-audio').textContent = 'LIVE TAB AUDIO CONNECTED';
  } catch (error) {
    console.warn('Tab audio capture was unavailable.', error);
    $('youtube-feedback').textContent = 'Audio sharing was cancelled or unavailable. You can still use synchronized playback.';
  } finally {
    $('capture-youtube-audio').disabled = false;
  }
}
function parseYoutubeId(value) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const shortId = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[\w-]{11}$/.test(shortId) ? shortId : '';
    }
    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return '';
    const watchId = url.searchParams.get('v');
    const pathId = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    const id = watchId || pathId?.[1] || '';
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}
function loadYoutubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (window.YT?.Player) { resolve(window.YT); return; }
      youtubeApiPromise = null;
      reject(new Error('YouTube player API timed out.'));
    }, 15000);
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previousCallback?.(); clearTimeout(timeout); resolve(window.YT); };
    let script = document.querySelector('script[data-youtube-iframe-api]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      script.onerror = () => { clearTimeout(timeout); youtubeApiPromise = null; reject(new Error('YouTube player API could not be loaded.')); };
      document.head.appendChild(script);
    }
  });
  return youtubeApiPromise;
}
function onYoutubePlayerState(event) {
  if (sourceType !== 'youtube') return;
  const state = event.data;
  if (state === window.YT.PlayerState.PLAYING) {
    youtubePlaying = true; loaded = true; simulationActive = true;
    if (kickPending) kickParticles();
    $('play-button').disabled = false;
    $('youtube-feedback').textContent = captureAnalyser ? 'LIVE SPECTRUM CONNECTED · YouTube playback is driving the plate.' : 'Playback linked · share tab audio for live spectrum analysis.';
    setPlaybackUi(true);
  } else if (state === window.YT.PlayerState.PAUSED || state === window.YT.PlayerState.ENDED) {
    youtubePlaying = false;
    setPlaybackUi(false);
  } else if (state === window.YT.PlayerState.CUED) {
    loaded = true; youtubeReady = true;
    youtubeDuration = youtubePlayer.getDuration() || youtubeDuration;
    $('play-button').disabled = false;
    $('youtube-feedback').textContent = captureAnalyser ? 'LIVE SPECTRUM CONNECTED · play the video to drive the plate from its audio.' : 'YouTube playback is ready · share tab audio for live spectrum analysis.';
    setPlaybackUi(false); updateTimeline();
  }
}
async function loadYoutube(value) {
  const videoId = parseYoutubeId(value);
  if (!videoId) {
    $('youtube-feedback').textContent = 'That link does not look like a standard YouTube video, Shorts, or youtu.be URL.';
    return;
  }
  $('youtube-load').disabled = true;
  sourceType = 'youtube'; loaded = false; youtubeVideoId = videoId; youtubeTime = 0; youtubeDuration = 0; youtubePlaying = false;
  stopYoutubeCapture();
  resetParticles();
  $('youtube-player-shell').hidden = false;
  $('capture-youtube-audio').hidden = false;
  $('capture-youtube-audio').textContent = 'ENABLE LIVE TAB AUDIO';
  $('youtube-feedback').textContent = 'Loading the YouTube player…';
  $('frequency-readout').textContent = '—';
  $('play-button').disabled = true;
  $('duration').textContent = '0:00'; $('current-time').textContent = '0:00'; $('seek').value = '0';
  try {
    await loadYoutubeApi();
    if (!youtubePlayer) {
      youtubePlayer = new window.YT.Player('youtube-player', {
        width: '100%', height: '203',
        playerVars: { playsinline: 1, controls: 1, fs: 0, rel: 0, origin: window.location.origin },
        events: {
          onReady: event => {
            youtubeReady = true;
            event.target.setVolume(Math.round(Number($('volume').value) * 100));
            if (youtubeVideoId) event.target.cueVideoById(youtubeVideoId);
          },
          onStateChange: onYoutubePlayerState,
          onError: event => {
            youtubePlaying = false; loaded = false; $('play-button').disabled = true;
            const reason = event.data === 101 || event.data === 150 ? 'This video owner does not allow embedded playback.' : event.data === 100 ? 'This video is unavailable or private.' : 'YouTube could not load this video.';
            $('youtube-feedback').textContent = `${reason} Try another link.`;
          }
        }
      });
    } else if (youtubeReady) youtubePlayer.cueVideoById(videoId);
  } catch (error) {
    console.error(error);
    $('youtube-feedback').textContent = 'The YouTube player could not be loaded. Check your connection and try again.';
  } finally { $('youtube-load').disabled = false; }
}
$('youtube-form').addEventListener('submit', event => { event.preventDefault(); loadYoutube($('youtube-url').value); });
$('capture-youtube-audio').addEventListener('click', enableYoutubeCapture);
function togglePlayback() {
  if (!loaded) return;
  if (!youtubePlayer || !youtubeReady) return;
  if (youtubePlaying) youtubePlayer.pauseVideo();
  else { kickParticles(); youtubePlayer.playVideo(); }
}
$('play-button').addEventListener('click', togglePlayback);
$('seek').addEventListener('input', () => { seeking = true; $('current-time').textContent = formatTime(($('seek').value / 1000) * getSourceDuration()); });
$('seek').addEventListener('change', () => {
  const targetTime = ($('seek').value / 1000) * getSourceDuration();
  if (youtubePlayer && youtubeReady) { youtubePlayer.seekTo(targetTime, true); youtubeTime = targetTime; }
  seeking = false; updateTimeline();
});
$('volume').addEventListener('input', () => {
  const volume = Number($('volume').value);
  if (youtubePlayer && youtubeReady) youtubePlayer.setVolume(Math.round(volume * 100));
});
$('back-button').addEventListener('click', () => {
  const target = Math.max(0, getSourceTime() - 10);
  if (youtubePlayer && youtubeReady) { youtubePlayer.seekTo(target, true); youtubeTime = target; }
  updateTimeline();
});
$('forward-button').addEventListener('click', () => {
  const target = Math.min(getSourceDuration() || getSourceTime() + 10, getSourceTime() + 10);
  if (youtubePlayer && youtubeReady) { youtubePlayer.seekTo(target, true); youtubeTime = target; }
  updateTimeline();
});
setInterval(() => {
  if (sourceType !== 'youtube' || !youtubePlayer || !youtubeReady) return;
  try {
    youtubeTime = youtubePlayer.getCurrentTime() || youtubeTime;
    const duration = youtubePlayer.getDuration();
    if (duration > 0) youtubeDuration = duration;
    updateTimeline();
  } catch { /* The iframe may be switching videos. */ }
}, 34);
const particleSizeControl = $('particle-size-control');
particleSizeControl.addEventListener('input', () => {
  const size = Number(particleSizeControl.value);
  material.uniforms.uParticleSize.value = size;
  $('particle-size-value').value = `${size.toFixed(1)}×`;
});
const reliefControl = $('relief-control');
reliefControl.addEventListener('input', () => { relief = Number(reliefControl.value); $('relief-value').value = `${relief.toFixed(1)}×`; });
function setCameraView(view) {
  cameraView = view;
  const polar = view === 'top' ? .09 : 1.05;
  const distance = controls.getDistance();
  camera.position.set(0, -distance * Math.sin(polar), distance * Math.cos(polar));
  camera.lookAt(controls.target);
  controls.update();
  $('view-side').classList.toggle('selected', view === 'side');
  $('view-top').classList.toggle('selected', view === 'top');
}
function zoomCamera(factor) {
  const direction = camera.position.clone().sub(controls.target).normalize();
  const distance = THREE.MathUtils.clamp(controls.getDistance() * factor, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).addScaledVector(direction, distance);
  controls.update();
}
function resetCamera() {
  cameraZoom = 1;
  setCameraView('top');
  camera.position.set(0, -baseCameraDistance * Math.sin(.09), baseCameraDistance * Math.cos(.09));
  camera.lookAt(controls.target); controls.update();
}
$('view-side').addEventListener('click', () => setCameraView('side'));
$('view-top').addEventListener('click', () => setCameraView('top'));
$('zoom-in').addEventListener('click', () => zoomCamera(.82));
$('zoom-out').addEventListener('click', () => zoomCamera(1.22));
$('view-reset').addEventListener('click', resetCamera);
$('about-button').addEventListener('click',()=>$('about-dialog').showModal());$('dialog-close').addEventListener('click',()=>$('about-dialog').close());$('about-dialog').addEventListener('click',e=>{if(e.target===$('about-dialog'))$('about-dialog').close();});
