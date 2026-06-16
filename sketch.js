// ===================================================================
// CONFIG
// All the "tuning knobs" live here so you can adjust behavior without
// hunting through the logic below. Sensitivity will vary by source
// (mic vs file) and by genre, so expect to tweak these.
// ===================================================================

const CONFIG = {
  // --- size, driven by overall loudness (RMS) ---
  volumeSmoothing: 0.25,     // 0-1: higher = snappier, lower = smoother
  volumeCeiling: 0.5,        // RMS (0-1) you treat as "loudest" -- raise if the
                             // ball never gets big, lower if it maxes out too easily
  minRadius: 60,
  maxRadius: 260,

  // --- color, driven by detected musical note (pitch) ---
  hueSmoothing: 0.15,        // how fast color drifts toward a newly detected note
  pitchConfidence: 0.35,     // 0-1: how clear a pitch must be before we trust it.
                             // raise this if color flickers randomly during noisy/atonal sound

  // --- distortion, driven by bass/kick onsets ---
  kickFreqMin: 40,           // Hz, low end of the band we watch for hits
  kickFreqMax: 150,          // Hz, high end -- widen toward 200 for boomy 808-style kicks
  kickThresholdMultiplier: 1.5, // how much louder than the recent average counts as a "hit"
  kickMinEnergy: 8,          // ignore tiny bass blips below this (0-255 scale)
  kickCooldownMs: 120,       // minimum time between hits, prevents one kick from re-triggering
  kickDecay: 0.92,           // how fast the punch fades each frame, lower = snappier
  kickDistortion: 140,       // how spiky the blob gets on a hit, in pixels
  baseWobble: 6              // a small constant wobble, even with no hits
};

// ===================================================================
// AUDIO ENGINE
// Gets sound from the mic or a file into one shared AnalyserNode.
// The analysis/visual code below doesn't care which source it is.
// ===================================================================

let audioContext, analyser, dataArray, timeDomainArray, bufferLength;
let sourceNode, micStream, filePlayerEl;
let audioReady = false;
let kickBinMin = 0, kickBinMax = 0;

function setupAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;          // bigger window = better pitch detection, a bit more CPU
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    timeDomainArray = new Float32Array(analyser.fftSize);

    // Convert our kick frequency range (in Hz) into bin indices, once,
    // based on this device's actual sample rate.
    const hzPerBin = audioContext.sampleRate / analyser.fftSize;
    kickBinMin = Math.floor(CONFIG.kickFreqMin / hzPerBin);
    kickBinMax = Math.ceil(CONFIG.kickFreqMax / hzPerBin);
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();            // browsers pause audio until a click
  }
}

function connectSource(newSource, routeToSpeakers) {
  if (sourceNode) sourceNode.disconnect();
  sourceNode = newSource;
  sourceNode.connect(analyser);

  analyser.disconnect();              // clear any previous speaker routing
  if (routeToSpeakers) {
    analyser.connect(audioContext.destination); // so you can hear the file
  }
  audioReady = true;
}

function useMicrophone() {
  setupAudioContext();
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      if (filePlayerEl) filePlayerEl.pause();
      micStream = stream;
      connectSource(audioContext.createMediaStreamSource(stream), false);
      // false = don't route to speakers, that would cause mic feedback
    })
    .catch((err) => alert('Could not access microphone: ' + err.message));
}

function useAudioFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  setupAudioContext();
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  if (!filePlayerEl) {
    filePlayerEl = document.createElement('audio');
    filePlayerEl.controls = true;
    filePlayerEl.style.position = 'fixed';
    filePlayerEl.style.bottom = '20px';
    filePlayerEl.style.left = '50%';
    filePlayerEl.style.transform = 'translateX(-50%)';
    document.body.appendChild(filePlayerEl);
  }

  filePlayerEl.src = URL.createObjectURL(file);
  filePlayerEl.play();
  connectSource(audioContext.createMediaElementSource(filePlayerEl), true);
  // true = also route to speakers so you can actually hear the track
}

// ===================================================================
// AUDIO ANALYSIS
// Three independent measurements, each feeding one visual property.
// ===================================================================

// --- 1. Loudness, for size ---
// RMS (root mean square) of the raw waveform is a much steadier measure
// of "how loud is this instant" than averaging FFT bins.
function computeRMS(buffer) {
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
  return Math.sqrt(sumSquares / buffer.length);
}

// --- 2. Pitch, for color ---
// Autocorrelation: slide the waveform against a copy of itself and find
// the offset (lag) where it lines up best. That lag is the wave's period,
// and 1/period is its fundamental frequency -- the "note" being played.
// Works best on a clear, single pitch (a voice, a synth lead); on a dense
// full mix it gives an approximate, more impressionistic reading.
function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;

  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // too quiet to bother

  // Trim toward zero-crossings at each edge so the window starts/ends cleanly
  let r1 = 0, r2 = SIZE - 1;
  const edgeThreshold = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < edgeThreshold) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < edgeThreshold) { r2 = SIZE - i; break; }
  }
  const trimmed = buffer.slice(r1, r2);
  const n = trimmed.length;

  const c = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    for (let i = 0; i < n - lag; i++) {
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  // Skip past the initial downward slope from lag 0 (which is always the peak)
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
  }

  // No confident peak found -- treat as "no clear pitch" rather than guess
  if (maxPos <= 0 || maxVal / c[0] < CONFIG.pitchConfidence) return -1;

  // Parabolic interpolation around the peak for sub-sample precision
  let T0 = maxPos;
  const x1 = c[T0 - 1] ?? c[T0];
  const x2 = c[T0];
  const x3 = c[T0 + 1] ?? c[T0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 -= b / (2 * a);

  return sampleRate / T0;
}

// Converts a frequency to a pitch class 0-11 (C, C#, D, ... B),
// using the standard equal-tempered scale where A4 = 440Hz.
function freqToNoteIndex(freq) {
  const midiNote = 12 * Math.log2(freq / 440) + 69;
  const rounded = Math.round(midiNote);
  return ((rounded % 12) + 12) % 12;
}

// Interpolates an angle (like hue, 0-360) the short way around the circle,
// so going from note B to note C doesn't spin all the way through the wheel.
function lerpHueShortest(current, target, amt) {
  const diff = ((target - current + 540) % 360) - 180;
  return (current + diff * amt + 360) % 360;
}

// --- 3. Bass hits, for distortion ---
// Average energy in the kick's frequency band, compared against its own
// recent rolling average. A sudden spike above that average = a hit.
function averageBinRange(data, fromBin, toBin) {
  const from = Math.max(0, fromBin);
  const to = Math.min(data.length - 1, toBin);
  let sum = 0;
  for (let i = from; i <= to; i++) sum += data[i];
  return sum / (to - from + 1);
}

// ===================================================================
// VISUAL STATE
// ===================================================================

let smoothedVolume = 0;
let currentHue = 200, targetHue = 200;
let kickEnergy = 0;
let lastKickTime = 0;
let bassHistory = [];
const BASS_HISTORY_SIZE = 43; // roughly 0.7s of frames at 60fps
let ripples = [];

// ===================================================================
// VISUALS
// ===================================================================

function setup() {
  createCanvas(800, 800);
  colorMode(HSB, 360, 100, 100, 100);

  document.getElementById('mic-btn').addEventListener('click', useMicrophone);
  document.getElementById('file-input').addEventListener('change', useAudioFile);
}

function draw() {
  background(0, 0, 4); // near-black

  if (!audioReady) {
    fill(0, 0, 100);
    textAlign(CENTER, CENTER);
    textSize(18);
    text('Use the microphone or choose a file above to begin', width / 2, height / 2);
    return;
  }

  analyser.getByteFrequencyData(dataArray);
  analyser.getFloatTimeDomainData(timeDomainArray);

  // ---------- size: smoothed RMS loudness ----------
  const rms = computeRMS(timeDomainArray);
  const targetVolume = constrain(map(rms, 0, CONFIG.volumeCeiling, 0, 1), 0, 1);
  smoothedVolume = lerp(smoothedVolume, targetVolume, CONFIG.volumeSmoothing);
  const radius = map(smoothedVolume, 0, 1, CONFIG.minRadius, CONFIG.maxRadius);

  // ---------- color: detected note ----------
  const freq = autoCorrelate(timeDomainArray, audioContext.sampleRate);
  if (freq !== -1) {
    targetHue = freqToNoteIndex(freq) * 30; // 12 notes spread evenly, 30° apart
  }
  // if no confident pitch this frame, currentHue just holds its last value
  currentHue = lerpHueShortest(currentHue, targetHue, CONFIG.hueSmoothing);

  // ---------- distortion: bass/kick onset detection ----------
  const kickBandEnergy = averageBinRange(dataArray, kickBinMin, kickBinMax);
  bassHistory.push(kickBandEnergy);
  if (bassHistory.length > BASS_HISTORY_SIZE) bassHistory.shift();
  const bassAverage = bassHistory.reduce((a, b) => a + b, 0) / bassHistory.length;

  const now = millis();
  const isHit =
    kickBandEnergy > bassAverage * CONFIG.kickThresholdMultiplier &&
    kickBandEnergy > CONFIG.kickMinEnergy &&
    now - lastKickTime > CONFIG.kickCooldownMs;

  if (isHit) {
    kickEnergy = 1;
    lastKickTime = now;
    ripples.push({ r: radius, alpha: 100 });
  }
  kickEnergy *= CONFIG.kickDecay; // percussive envelope: spike, then decay

  // saturation/brightness ride along with loudness -- quiet feels soft, loud feels vivid
  const sat = map(smoothedVolume, 0, 1, 50, 100);
  const bri = map(smoothedVolume, 0, 1, 70, 100);

  drawRipples();
  drawBlob(width / 2, height / 2, radius, sat, bri);
}

// A faint ring that expands outward and fades on every detected kick --
// handy for confirming hits are landing where you expect.
function drawRipples() {
  noFill();
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    rp.r += 6;
    rp.alpha -= 4;
    if (rp.alpha <= 0) {
      ripples.splice(i, 1);
      continue;
    }
    stroke(currentHue, 50, 100, rp.alpha);
    strokeWeight(2);
    ellipse(width / 2, height / 2, rp.r * 2, rp.r * 2);
  }
}

// The main shape: a circle whose edge is pushed in/out by Perlin noise.
// Distortion strength rides on kickEnergy, so it stays smooth between
// hits and spikes sharply right when one lands.
function drawBlob(cx, cy, baseRadius, sat, bri) {
  const distortion = CONFIG.baseWobble + kickEnergy * CONFIG.kickDistortion;

  noStroke();
  fill(currentHue, sat, bri, 85);
  beginShape();
  const segments = 100;
  for (let i = 0; i <= segments; i++) {
    const angle = map(i, 0, segments, 0, TWO_PI);
    const n = noise(cos(angle) * 1.5 + 10, sin(angle) * 1.5 + 10, frameCount * 0.01);
    const r = baseRadius + (n - 0.5) * distortion;
    vertex(cx + cos(angle) * r, cy + sin(angle) * r);
  }
  endShape(CLOSE);
}