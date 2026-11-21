// Thin, isotropic circular plate (Kirchhoff-Love model), defaulting to a free rim.
// The profile is an idealized demonstration model; configure it for known hardware.
export const MATERIALS = Object.freeze({
  aluminum: Object.freeze({ youngsModulus: 69e9, density: 2700, poissonRatio: .33 }),
  steel: Object.freeze({ youngsModulus: 200e9, density: 7850, poissonRatio: .29 }),
  acrylic: Object.freeze({ youngsModulus: 3.2e9, density: 1180, poissonRatio: .35 }),
});
export let PLATE = Object.freeze({ material: 'aluminum', diameter: .2, thickness: .001, ...MATERIALS.aluminum, edge: 'free' });

function besselJPositive(order, x) {
  const m = Math.trunc(order);
  if (x < 1e-8) return m === 0 ? 1 : 0;
  if (x < 18) {
    let term = Math.pow(x / 2, m);
    for (let k = 2; k <= m; k++) term /= k;
    let sum = term;
    const quarter = x * x / 4;
    for (let k = 1; k < 80; k++) {
      term *= -quarter / (k * (m + k));
      sum += term;
      if (Math.abs(term) < 1e-14 * Math.max(1, Math.abs(sum))) break;
    }
    return sum;
  }
  const top = Math.max(64, Math.ceil(x) + 40, m + 40);
  const values = new Float64Array(top + 2);
  values[top] = 1;
  for (let k = top; k > 0; k--) {
    values[k - 1] = (2 * k / x) * values[k] - values[k + 1];
    if (Math.abs(values[k - 1]) > 1e100) {
      for (let j = k - 1; j <= top + 1; j++) values[j] *= 1e-100;
    }
  }
  let normalizer = values[0];
  for (let k = 2; k <= top; k += 2) normalizer += 2 * values[k];
  return values[m] / normalizer;
}

export function besselJ(order, x) {
  const m = Math.abs(Math.trunc(order));
  return order < 0 && m % 2 ? -besselJPositive(m, x) : besselJPositive(m, x);
}

export function modifiedBesselI(order, x) {
  const m = Math.abs(Math.trunc(order));
  if (x < 1e-8) return m === 0 ? 1 : 0;
  let term = Math.pow(x / 2, m);
  for (let k = 2; k <= m; k++) term /= k;
  let sum = term;
  const quarter = x * x / 4;
  for (let k = 1; k < 120; k++) {
    term *= quarter / (k * (m + k));
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

function clampedEdgeResidual(m, lambda) {
  const j = besselJ(m, lambda);
  const jm1 = m === 0 ? -besselJ(1, lambda) : besselJ(m - 1, lambda);
  const jp1 = besselJ(m + 1, lambda);
  const im1 = m === 0 ? modifiedBesselI(1, lambda) : modifiedBesselI(m - 1, lambda);
  const ip1 = modifiedBesselI(m + 1, lambda);
  const jPrime = (jm1 - jp1) * 0.5;
  const iPrimeOverI = (im1 + ip1) / (2 * modifiedBesselI(m, lambda));
  return jPrime - j * iPrimeOverI;
}

function simplySupportedEdgeResidual(m, lambda, poissonRatio) {
  const j = besselJ(m, lambda), i = modifiedBesselI(m, lambda), coefficient = -j / i;
  const jm1 = m === 0 ? -besselJ(1, lambda) : besselJ(m - 1, lambda), jp1 = besselJ(m + 1, lambda);
  const im1 = m === 0 ? modifiedBesselI(1, lambda) : modifiedBesselI(m - 1, lambda), ip1 = modifiedBesselI(m + 1, lambda);
  const jp = (jm1 - jp1) * .5, ip = (im1 + ip1) * .5;
  const jpp = -jp / lambda - (1 - m * m / (lambda * lambda)) * j;
  const ipp = -ip / lambda + (1 + m * m / (lambda * lambda)) * i;
  const radialPrime = lambda * (jp + coefficient * ip);
  const radialSecond = lambda * lambda * (jpp + coefficient * ipp);
  return radialSecond + poissonRatio * radialPrime;
}

function besselDerivatives(m, x, modified = false) {
  const value = modified ? modifiedBesselI(m, x) : besselJ(m, x);
  const before = modified ? modifiedBesselI(m - 1, x) : (m === 0 ? -besselJ(1, x) : besselJ(m - 1, x));
  const after = modified ? modifiedBesselI(m + 1, x) : besselJ(m + 1, x);
  const first = modified ? (before + after) * .5 : (before - after) * .5;
  const second = modified
    ? -first / x + (1 + m * m / (x * x)) * value
    : -first / x - (1 - m * m / (x * x)) * value;
  const third = modified
    ? -second / x + first / (x * x) + (1 + m * m / (x * x)) * first - 2 * m * m * value / (x * x * x)
    : -second / x + first / (x * x) - (1 - m * m / (x * x)) * first - 2 * m * m * value / (x * x * x);
  return [value, first, second, third];
}

function freeEdgeBoundaryValues(m, lambda, poissonRatio, modified = false) {
  const [value, firstX, secondX, thirdX] = besselDerivatives(m, lambda, modified);
  const first = lambda * firstX, second = lambda * lambda * secondX, third = lambda ** 3 * thirdX;
  const moment = second + poissonRatio * (first - m * m * value);
  const shear = third + second - (1 + m * m * (2 - poissonRatio)) * first + m * m * (3 - poissonRatio) * value;
  return { moment, shear };
}

function freeEdgeResidual(m, lambda, poissonRatio) {
  const j = freeEdgeBoundaryValues(m, lambda, poissonRatio);
  const i = freeEdgeBoundaryValues(m, lambda, poissonRatio, true);
  return j.moment * i.shear - i.moment * j.shear;
}

function solvePlateModes(edge = 'clamped', poissonRatio = PLATE.poissonRatio, maxOrder = 10, rootsPerOrder = 8) {
  const roots = [];
  for (let m = 0; m <= maxOrder; m++) {
    const residual = x => edge === 'free' ? freeEdgeResidual(m, x, poissonRatio) : edge === 'simply-supported' ? simplySupportedEdgeResidual(m, x, poissonRatio) : clampedEdgeResidual(m, x);
    let previousX = 0.5, previous = residual(previousX), found = 0;
    for (let x = 0.55; x <= 42 && found < rootsPerOrder; x += 0.05) {
      const value = residual(x);
      if (value * previous < 0) {
        let lo = previousX, hi = x, flo = previous;
        for (let iteration = 0; iteration < 36; iteration++) {
          const mid = (lo + hi) * 0.5, fm = residual(mid);
          if (fm * flo <= 0) hi = mid;
          else { lo = mid; flo = fm; }
        }
        roots.push({ m, n: ++found, lambda: (lo + hi) * 0.5 });
      }
      previousX = x; previous = value;
    }
  }
  return roots;
}

export let MODES = [];
function updateModeFrequencies() {
  const scale = PLATE.thickness / (2 * Math.PI * (PLATE.diameter / 2) ** 2)
    * Math.sqrt(PLATE.youngsModulus / (12 * PLATE.density * (1 - PLATE.poissonRatio ** 2)));
  for (const mode of MODES) mode.frequency = scale * mode.lambda ** 2;
}
MODES = solvePlateModes(PLATE.edge, PLATE.poissonRatio).map(mode => ({ ...mode, frequency: 0 }));
updateModeFrequencies();

export function configurePlate({ material = PLATE.material, diameter = PLATE.diameter, thickness = PLATE.thickness, edge = PLATE.edge } = {}) {
  const properties = MATERIALS[material] || MATERIALS.aluminum;
  const nextPlate = Object.freeze({ material, diameter, thickness, ...properties, edge });
  if (edge !== PLATE.edge || properties.poissonRatio !== PLATE.poissonRatio) {
    const solved = solvePlateModes(edge, properties.poissonRatio);
    if (solved.length !== MODES.length) throw new Error('The selected boundary profile produced an unexpected number of modes.');
    MODES.splice(0, MODES.length, ...solved.map(mode => ({ ...mode, frequency: 0 })));
  }
  PLATE = nextPlate;
  updateModeFrequencies();
  return PLATE;
}

export function plateRadialCoefficient(mode) {
  if (PLATE.edge === 'free') {
    const { moment: momentJ } = freeEdgeBoundaryValues(mode.m, mode.lambda, PLATE.poissonRatio);
    const { moment: momentI } = freeEdgeBoundaryValues(mode.m, mode.lambda, PLATE.poissonRatio, true);
    return momentJ / momentI;
  }
  return besselJ(mode.m, mode.lambda) / modifiedBesselI(mode.m, mode.lambda);
}

// Regular thin-plate mode shape R(r)=J_m(λr)-c I_m(λr), with c selected by
// the chosen outer-edge condition. Radius is normalized to the plate radius.
export function plateRadialMode(mode, radius, coefficient = plateRadialCoefficient(mode)) {
  return besselJ(mode.m, mode.lambda * radius) - coefficient * modifiedBesselI(mode.m, mode.lambda * radius);
}

export function modeForFrequency(frequency) {
  const target = Math.max(0, frequency);
  let best = MODES[0], distance = Infinity;
  for (const mode of MODES) {
    const delta = Math.abs(Math.log((mode.frequency + 1) / (target + 1)));
    if (delta < distance) { best = mode; distance = delta; }
  }
  return best;
}

// Convert several prominent spectrum peaks into a normalized modal mixture.
// The SDOF response term favors frequencies near each plate resonance.
export function peaksFromSpectrum(magnitudes, sampleRate, fftSize, limit = 5) {
  let maximum = 0;
  for (let i = 1; i < magnitudes.length; i++) maximum = Math.max(maximum, magnitudes[i]);
  if (!maximum) return [];
  const peaks = [];
  const minBin = Math.max(1, Math.floor(35 * fftSize / sampleRate));
  const maxBin = Math.min(magnitudes.length - 2, Math.floor(12000 * fftSize / sampleRate));
  for (let i = minBin; i <= maxBin; i++) {
    const value = magnitudes[i];
    if (value >= maximum * .09 && value >= magnitudes[i - 1] && value > magnitudes[i + 1]) peaks.push({ bin: i, value });
  }
  peaks.sort((a, b) => b.value - a.value);
  return peaks.slice(0, limit).map(peak => {
    const left = magnitudes[peak.bin - 1], center = magnitudes[peak.bin], right = magnitudes[peak.bin + 1];
    const curvature = left - 2 * center + right;
    const offset = Math.abs(curvature) > 1e-9 ? Math.max(-.5, Math.min(.5, .5 * (left - right) / curvature)) : 0;
    return { frequency: (peak.bin + offset) * sampleRate / fftSize, amplitude: peak.value };
  });
}

export function modesFromPeaks(peaks) {
  const accumulated = new Map();
  for (const peak of peaks) {
    const frequency = peak.frequency;
    const mode = modeForFrequency(frequency);
    const ratio = frequency / mode.frequency;
    const damping = .025;
    const response = Math.min(20, 1 / Math.sqrt((1 - ratio * ratio) ** 2 + (2 * damping * ratio) ** 2));
    const row = modeRow(mode);
    const item = accumulated.get(row) || { modeIndex: row, m: mode.m, n: mode.n, frequency, weight: 0 };
    item.weight += peak.amplitude * response;
    accumulated.set(row, item);
  }
  const modes = [...accumulated.values()].sort((a, b) => b.weight - a.weight).slice(0, 3);
  const sum = modes.reduce((total, item) => total + item.weight, 0) || 1;
  for (const item of modes) item.weight /= sum;
  return modes;
}

export function modesFromSpectrum(magnitudes, sampleRate, fftSize, limit = 5) {
  return modesFromPeaks(peaksFromSpectrum(magnitudes, sampleRate, fftSize, limit));
}

export function modeRow(mode) {
  return Math.max(0, MODES.findIndex(item => item.m === mode.m && item.n === mode.n));
}
