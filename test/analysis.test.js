import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBuffer, fft } from '../src/analysis.js';
import { besselJ, configurePlate, MODES, modeForFrequency, modesFromSpectrum, peaksFromSpectrum, plateRadialMode, PLATE } from '../src/chladni.js';

test('FFT locates the dominant sinusoid bin', () => {
  const size = 4096, re = new Float32Array(size), im = new Float32Array(size);
  for (let i = 0; i < size; i++) re[i] = Math.sin(2 * Math.PI * 440 * i / 48000);
  fft(re, im);
  let peak = 1;
  for (let i = 2; i < size / 2; i++) if (Math.hypot(re[i], im[i]) > Math.hypot(re[peak], im[peak])) peak = i;
  assert.ok(Math.abs(peak * 48000 / size - 440) < 15);
});

test('spectrum peak interpolation recovers a sub-bin frequency', () => {
  const fftSize = 1024, sampleRate = 48000, centerBin = 80.35;
  const spectrum = new Float32Array(fftSize / 2);
  for (let bin = 0; bin < spectrum.length; bin++) spectrum[bin] = Math.exp(-((bin - centerBin) ** 2) / 2.4);
  const peak = peaksFromSpectrum(spectrum, sampleRate, fftSize, 1)[0];
  assert.ok(Math.abs(peak.frequency - centerBin * sampleRate / fftSize) < 2);
});

test('clamped circular plate modes satisfy edge constraints', () => {
  const original = { material: PLATE.material, diameter: PLATE.diameter, thickness: PLATE.thickness, edge: PLATE.edge };
  try {
    configurePlate({ edge: 'clamped', material: 'aluminum', diameter: .2, thickness: .001 });
    assert.ok(Math.abs(besselJ(0, 2.40483)) < 1e-5);
    assert.ok(Math.abs(besselJ(1, 3.83171)) < 1e-5);
    assert.ok(Math.abs(besselJ(0, 30) - (-0.08636798)) < 1e-6);
    assert.ok(Math.abs(MODES[0].lambda - 3.1962206) < 1e-5);
    assert.ok(Math.abs(plateRadialMode(MODES[0], 1)) < 1e-12);
    assert.ok(Math.abs(plateRadialMode(MODES[0], 1) - plateRadialMode(MODES[0], .99999)) / 1e-5 < 1e-4);
    assert.ok(Math.abs(MODES[0].frequency - 251.35) < 0.1);
    assert.equal(PLATE.edge, 'clamped');
    const mode = modeForFrequency(440);
    assert.ok(MODES.includes(mode));
    assert.ok(mode.lambda > 0 && mode.n > 0);
  } finally {
    configurePlate(original);
  }
});

test('free-rim model keeps the edge from becoming a fixed nodal ring', () => {
  assert.equal(PLATE.edge, 'free');
  const mode = MODES.find(item => item.m === 2 && item.n === 1);
  assert.ok(mode);
  assert.ok(Math.abs(mode.lambda - 2.29391) < 1e-4);
  assert.ok(Math.abs(plateRadialMode(mode, 1)) > .5);
});

test('spectrum maps multiple peaks into normalized resonant modes', () => {
  const fftSize = 4096, sampleRate = 48000, spectrum = new Float32Array(fftSize / 2);
  spectrum[21] = 1; spectrum[22] = .1; spectrum[20] = .1;
  spectrum[45] = .7; spectrum[46] = .1; spectrum[44] = .1;
  const modes = modesFromSpectrum(spectrum, sampleRate, fftSize);
  assert.ok(modes.length >= 2);
  assert.ok(Math.abs(modes.reduce((sum, mode) => sum + mode.weight, 0) - 1) < 1e-6);
  assert.ok(modes.every(mode => mode.weight > 0 && MODES[mode.modeIndex].m === mode.m));
});

test('full-track analysis returns time-varying spectral and plate features', async () => {
  const sampleRate = 48000, duration = 1, samples = new Float32Array(sampleRate * duration);
  for (let i = 0; i < samples.length; i++) samples[i] = .4 * Math.sin(2 * Math.PI * 880 * i / sampleRate);
  const buffer = { numberOfChannels: 1, length: samples.length, sampleRate, getChannelData: () => samples };
  let progress = 0;
  const frames = await analyzeAudioBuffer(buffer, value => { progress = value; });
  assert.ok(frames.length >= 7);
  assert.ok(frames.every(frame => frame.energy > 0 && frame.centroid > 0 && frame.bass >= 0 && frame.mid >= 0 && frame.high >= 0));
  assert.ok(frames.every(frame => Number.isInteger(frame.m) && Number.isInteger(frame.n) && frame.n > 0));
  assert.ok(frames.every(frame => Number.isInteger(frame.modeIndex) && frame.modeIndex >= 0 && frame.modeIndex < MODES.length));
  assert.ok(frames.every(frame => MODES[frame.modeIndex].m === frame.m && MODES[frame.modeIndex].n === frame.n));
  assert.ok(Math.abs(frames[1].peak - 880) < 25);
  assert.equal(progress, 1);
});

test('plate profiles recalculate ideal edge modes and resonance frequencies', () => {
  const original = { material: PLATE.material, diameter: PLATE.diameter, thickness: PLATE.thickness, edge: PLATE.edge };
  try {
    configurePlate({ edge: 'simply-supported' });
    assert.equal(PLATE.edge, 'simply-supported');
    assert.equal(MODES.length, 88);
    assert.ok(Math.abs(MODES[0].lambda - 2.231369) < 1e-5);
    assert.ok(Math.abs(plateRadialMode(MODES[0], 1)) < 1e-10);
    const baseFrequency = MODES[0].frequency;
    configurePlate({ diameter: .4, thickness: .002 });
    assert.ok(Math.abs(MODES[0].frequency - baseFrequency * .5) < .01);
    configurePlate({ material: 'steel' });
    assert.ok(MODES.every(mode => Number.isFinite(mode.frequency) && mode.frequency > 0));
  } finally {
    configurePlate(original);
  }
});
