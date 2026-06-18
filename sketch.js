// ===================================================================
// CONFIG
// ===================================================================

const CONFIG = {
  volumeSmoothing: 0.25,
  hueSmoothing: 0.15,
  pitchConfidence: 0.35,

  // --- Microphone / single-file mode (the lone "main" source) ---
  solo: {
    volumeCeiling: 0.5,
    kickFreqMin: 40, kickFreqMax: 150,
    kickThresholdMultiplier: 1.5, kickMinEnergy: 8, kickCooldownMs: 120, kickDecay: 0.92
  },

  // --- Band mode: three isolated stems ---
  band: {
    kickFreqMin: 40,   kickFreqMax: 150,
    snareFreqMin: 150, snareFreqMax: 2500,
    hihatFreqMin: 6000, hihatFreqMax: 14000,
    kickThresholdMultiplier: 1.5,  kickMinEnergy: 8, kickCooldownMs: 120,  kickDecay: 0.92,
    snareThresholdMultiplier: 1.6, snareMinEnergy: 6, snareCooldownMs: 100, snareDecay: 0.85,
    hihatThresholdMultiplier: 1.7, hihatMinEnergy: 4, hihatCooldownMs: 60,  hihatDecay: 0.8,
    volumeCeiling: 0.5,
    bassEnergyCeiling: 180,
    bassSpeedCeiling: 40,
    bassSpeedSmoothing: 0.3,
    bassMaxOffset: 120,
    bassMaxDistortion: 50
  },

  // --- Generic element rendering (used by every shape, any mode) ---
  elements: {
    baseWobble: 6,
    minSize: 50,
    maxSize: 220,
    volumeDistortStrength: 70,
    kickDistortStrength: 140
  }
};

const ANALYSER_FFT_SIZE = 2048;

// ===================================================================
// AUDIO ENGINE
// ===================================================================

const vert = `
  precision highp float;
  attribute vec3 aPosition;
  attribute vec2 aTexCoord;
  varying vec2 vTexCoord;
  void main() {
    vTexCoord = aTexCoord;
    vec4 positionVec4 = vec4(aPosition, 1.0);
    positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
    gl_Position = positionVec4;
  }
`;

const frag = `
  precision highp float;
  varying vec2 vTexCoord;
  uniform float uTime;
  uniform float uVolume;
  uniform vec3 uColor;

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    vec2 uv0 = uv;
    vec3 finalColor = vec3(0.0);
    for (float i = 0.0; i < 3.0; i++) {
      uv = fract(uv * 1.5) - 0.5;
      float d = length(uv) * exp(-length(uv0));
      vec3 col = uColor * (0.5 + 0.5 * cos(uTime + i * 0.4 + vec3(0,2,4)));
      d = sin(d * 8.0 + uTime + uVolume * 5.0) / 8.0;
      d = abs(d);
      d = pow(0.01 / d, 1.2);
      finalColor += col * d;
    }
    gl_FragColor = vec4(finalColor * (0.1 + uVolume), 1.0);
  }
`;

let audioContext;
let masterGain;
let bgShader, bgGraphics;
let currentMode = 'mic'; // 'mic' | 'file' | 'band'
let audioReady = false;
let sceneIsPlaying = false;
let currentTrackName = "";

function setupAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.gain.value = CONFIG.solo.volumeCeiling;
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') audioContext.resume();
}

function stopAllAudio() {
  if (filePlayerEl) filePlayerEl.pause();
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  stopBandSources();
  sceneIsPlaying = false;
}

function hzToBin(hz) {
  const hzPerBin = audioContext.sampleRate / ANALYSER_FFT_SIZE;
  return Math.round(hz / hzPerBin);
}

function switchMode(newMode) {
  if (newMode === currentMode) return;

  stopAllAudio();
  currentMode = newMode;
  audioReady = newMode === 'band'
    ? Object.values(bandTracks).some((t) => t.buffer)
    : false;
  updatePlayPauseIcon();
  closeElementPanel();
  selectedElementId = null;

  document.querySelectorAll('.panel').forEach((p) => { p.hidden = true; });
  document.getElementById('panel-' + newMode).hidden = false;
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === newMode);
  });
}

function formatTime(seconds) {
  if (isNaN(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function updatePlaybackUI(current, duration) {
  document.getElementById('current-time').textContent = formatTime(current);
  document.getElementById('total-duration').textContent = formatTime(duration);
  document.getElementById('seek-bar').value = current;
  document.getElementById('seek-bar').max = duration || 0;
}

function togglePlayPause() {
  if (!audioReady) return;
  if (currentMode === 'band') {
    if (sceneIsPlaying) pauseBandPlayback();
    else startBandPlayback(bandOffset);
  } else {
    sceneIsPlaying = !sceneIsPlaying;
    if (filePlayerEl) {
      if (sceneIsPlaying) filePlayerEl.play();
      else filePlayerEl.pause();
    }
    updatePlayPauseIcon();
  }
}

function updatePlayPauseIcon() {
  const btn = document.getElementById('play-pause-btn');
  if (!btn) return;
  btn.querySelector('.icon').textContent = sceneIsPlaying ? '⏸' : '▶';
  btn.setAttribute('aria-label', sceneIsPlaying ? 'Pausar' : 'Tocar');
}

// -------------------------------------------------------------------
// Solo engine (microphone or single file -> one shared analyser)
// -------------------------------------------------------------------

let analyser, dataArray, timeDomainArray, fileSourceNode;
let sourceNode, micStream, filePlayerEl;
let kickBinMin = 0, kickBinMax = 0;

function setupSoloAnalyser() {
  if (!analyser) {
    analyser = audioContext.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
  }
  // Garante que o analyser esteja conectado ao masterGain
  analyser.connect(masterGain);
  dataArray = new Uint8Array(analyser.frequencyBinCount);
  timeDomainArray = new Float32Array(analyser.fftSize);
  kickBinMin = hzToBin(CONFIG.solo.kickFreqMin);
  kickBinMax = hzToBin(CONFIG.solo.kickFreqMax);
}

function connectSource(newSource, routeToSpeakers) {
  if (sourceNode && sourceNode !== newSource) sourceNode.disconnect();
  sourceNode = newSource;
  audioReady = true;
  sceneIsPlaying = true;
  updatePlayPauseIcon();
}

function useMicrophone() {
  setupAudioContext();
  setupSoloAnalyser();
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      if (filePlayerEl) filePlayerEl.pause();
      micStream = stream;
      currentTrackName = "Microfone Ativo";
      connectSource(audioContext.createMediaStreamSource(stream), false);
      sourceNode.connect(analyser);
    })
    .catch((err) => alert('Could not access microphone: ' + err.message));
}

function useAudioFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  setupAudioContext();
  setupSoloAnalyser();
  
  stopAllAudio();

  if (!filePlayerEl) {
    filePlayerEl = document.createElement('audio');
    filePlayerEl.style.display = 'none';
    document.body.appendChild(filePlayerEl);
    fileSourceNode = audioContext.createMediaElementSource(filePlayerEl);
    fileSourceNode.connect(analyser);
  }
  filePlayerEl.src = URL.createObjectURL(file);
  filePlayerEl.load();
  currentTrackName = file.name;
  filePlayerEl.play();
  connectSource(fileSourceNode, true);
}

// -------------------------------------------------------------------
// Band engine (synced multi-track playback via AudioBufferSourceNode)
// -------------------------------------------------------------------

let bandTracks = {};
let bandStartContextTime = 0;
let bandOffset = 0;
let bandMaxDuration = 0;

function updateBandMaxDuration() {
  bandMaxDuration = 0;
  Object.values(bandTracks).forEach(t => {
    if (t.buffer) bandMaxDuration = Math.max(bandMaxDuration, t.buffer.duration);
  });
}

function createBandAnalyser() {
  const a = audioContext.createAnalyser();
  a.fftSize = ANALYSER_FFT_SIZE;
  return {
    analyser: a,
    dataArray: new Uint8Array(a.frequencyBinCount),
    timeDomainArray: new Float32Array(a.fftSize),
    buffer: null,
    sourceNode: null,
    kickBinMin: hzToBin(CONFIG.band.kickFreqMin),   kickBinMax: hzToBin(CONFIG.band.kickFreqMax),
    snareBinMin: hzToBin(CONFIG.band.snareFreqMin), snareBinMax: hzToBin(CONFIG.band.snareFreqMax),
    hihatBinMin: hzToBin(CONFIG.band.hihatFreqMin), hihatBinMax: hzToBin(CONFIG.band.hihatFreqMax)
  };
}

function loadBandTrack(id, file) {
  setupAudioContext();
  if (!bandTracks[id]) bandTracks[id] = createBandAnalyser();
  const track = bandTracks[id];

  file.arrayBuffer()
    .then((arrayBuffer) => audioContext.decodeAudioData(arrayBuffer))
    .then((audioBuffer) => {
      track.buffer = audioBuffer;
      track.fileName = file.name;
      updateBandMaxDuration();
      audioReady = true;
      if (currentMode === 'band' && sceneIsPlaying) {
        // Sincroniza se já estiver tocando
        const pos = audioContext.currentTime - bandStartContextTime;
        startBandPlayback(pos);
      }
    })
    .catch((err) => alert('Could not load that audio file: ' + err.message));
}

function startBandPlayback(offset) {
  stopBandSources();
  const when = audioContext.currentTime + 0.05;
  bandStartContextTime = when - offset;
  bandOffset = offset;

  Object.values(bandTracks).forEach((track) => {
    if (!track.buffer) return;
    const node = audioContext.createBufferSource();
    node.buffer = track.buffer;
    node.connect(track.analyser);
    track.analyser.connect(masterGain);
    node.start(when, offset);
    track.sourceNode = node;
  });

  audioReady = true;
  sceneIsPlaying = true;
  updatePlayPauseIcon();
}

function pauseBandPlayback() {
  bandOffset = audioContext.currentTime - bandStartContextTime;
  stopBandSources();
  sceneIsPlaying = false;
  updatePlayPauseIcon();
}

function stopBandSources() {
  Object.values(bandTracks).forEach((track) => {
    if (track.sourceNode) {
      try { track.sourceNode.stop(); } catch (e) { /* already stopped */ }
      track.sourceNode.disconnect();
      track.sourceNode = null;
    }
  });
}

// ===================================================================
// AUDIO ANALYSIS (reusable measurements)
// ===================================================================

function computeRMS(buffer) {
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
  return Math.sqrt(sumSquares / buffer.length);
}

function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;

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
    for (let i = 0; i < n - lag; i++) c[lag] += trimmed[i] * trimmed[i + lag];
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
  }
  if (maxPos <= 0 || maxVal / c[0] < CONFIG.pitchConfidence) return -1;

  let T0 = maxPos;
  const x1 = c[T0 - 1] ?? c[T0];
  const x2 = c[T0];
  const x3 = c[T0 + 1] ?? c[T0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 -= b / (2 * a);

  return sampleRate / T0;
}

function freqToNoteIndex(freq) {
  const midiNote = 12 * Math.log2(freq / 440) + 69;
  const rounded = Math.round(midiNote);
  return ((rounded % 12) + 12) % 12;
}

function lerpHueShortest(current, target, amt) {
  const diff = ((target - current + 540) % 360) - 180;
  return (current + diff * amt + 360) % 360;
}

function averageBinRange(data, fromBin, toBin) {
  const from = Math.max(0, fromBin);
  const to = Math.min(data.length - 1, toBin);
  let sum = 0;
  for (let i = from; i <= to; i++) sum += data[i];
  return sum / (to - from + 1);
}

function makeOnsetDetector({ thresholdMultiplier, minEnergy, cooldownMs, decay, historySize = 43 }) {
  return {
    history: [],
    energy: 0,
    lastTriggerTime: 0,
    update(bandEnergy, now) {
      this.history.push(bandEnergy);
      if (this.history.length > historySize) this.history.shift();
      const avg = this.history.reduce((sum, v) => sum + v, 0) / this.history.length;
      const isHit =
        bandEnergy > avg * thresholdMultiplier &&
        bandEnergy > minEnergy &&
        now - this.lastTriggerTime > cooldownMs;
      if (isHit) { this.energy = 1; this.lastTriggerTime = now; }
      this.energy *= decay;
      return isHit;
    }
  };
}

// ===================================================================
// PER-SOURCE STATE
// Each of these gets updated every frame (while playing) by its own
// update function, and read generically by getReactionValue() below.
// ===================================================================

let visualTime = 0;

// "main" = whatever is active in mic or file mode
let smoothedVolume = 0;
let currentHue = 200, targetHue = 200;
let ripples = [];
const kickDetector = makeOnsetDetector({
  thresholdMultiplier: CONFIG.solo.kickThresholdMultiplier,
  minEnergy: CONFIG.solo.kickMinEnergy,
  cooldownMs: CONFIG.solo.kickCooldownMs,
  decay: CONFIG.solo.kickDecay
});

// "drums"
let drumState = { smoothedVolume: 0 };
const drumKickDetector = makeOnsetDetector({
  thresholdMultiplier: CONFIG.band.kickThresholdMultiplier, minEnergy: CONFIG.band.kickMinEnergy,
  cooldownMs: CONFIG.band.kickCooldownMs, decay: CONFIG.band.kickDecay
});
const drumSnareDetector = makeOnsetDetector({
  thresholdMultiplier: CONFIG.band.snareThresholdMultiplier, minEnergy: CONFIG.band.snareMinEnergy,
  cooldownMs: CONFIG.band.snareCooldownMs, decay: CONFIG.band.snareDecay
});
const drumHihatDetector = makeOnsetDetector({
  thresholdMultiplier: CONFIG.band.hihatThresholdMultiplier, minEnergy: CONFIG.band.hihatMinEnergy,
  cooldownMs: CONFIG.band.hihatCooldownMs, decay: CONFIG.band.hihatDecay
});

// "guitar"
let guitarState = { smoothedVolume: 0, hue: 200, targetHue: 200 };

// "bass"
let bassState = { smoothedVolume: 0, speed: 0, previousEnergy: 0, angle: 0 };

// ===================================================================
// ANALYSIS UPDATE (one function per source, called once per frame)
// ===================================================================

function updateSourceAnalysis() {
  if (currentMode === 'band') {
    const now = millis();
    if (bandTracks.drums && bandTracks.drums.buffer) updateDrumAnalysis(bandTracks.drums, now);
    if (bandTracks.guitar && bandTracks.guitar.buffer) updateGuitarAnalysis(bandTracks.guitar);
    if (bandTracks.bass && bandTracks.bass.buffer) updateBassAnalysis(bandTracks.bass);
  } else {
    analyser.getByteFrequencyData(dataArray);
    analyser.getFloatTimeDomainData(timeDomainArray);

    const rms = computeRMS(timeDomainArray);
    const targetVolume = constrain(map(rms, 0, CONFIG.solo.volumeCeiling, 0, 1), 0, 1);
    smoothedVolume = lerp(smoothedVolume, targetVolume, CONFIG.volumeSmoothing);

    const freq = autoCorrelate(timeDomainArray, audioContext.sampleRate);
    if (freq !== -1) targetHue = freqToNoteIndex(freq) * 30;
    currentHue = lerpHueShortest(currentHue, targetHue, CONFIG.hueSmoothing);

    const kickBandEnergy = averageBinRange(dataArray, kickBinMin, kickBinMax);
    const isHit = kickDetector.update(kickBandEnergy, millis());
    if (isHit) ripples.push({ r: 90, alpha: 100 });

    if (filePlayerEl) {
      updatePlaybackUI(filePlayerEl.currentTime, filePlayerEl.duration);
    }
  }
  if (currentMode === 'band' && sceneIsPlaying) {
    const currentPos = audioContext.currentTime - bandStartContextTime;
    updatePlaybackUI(currentPos, bandMaxDuration);
    if (currentPos >= bandMaxDuration) pauseBandPlayback();
  }
}

function updateDrumAnalysis(track, now) {
  track.analyser.getByteFrequencyData(track.dataArray);
  track.analyser.getFloatTimeDomainData(track.timeDomainArray);

  const rms = computeRMS(track.timeDomainArray);
  const targetVolume = constrain(map(rms, 0, CONFIG.band.volumeCeiling, 0, 1), 0, 1);
  drumState.smoothedVolume = lerp(drumState.smoothedVolume, targetVolume, CONFIG.volumeSmoothing);

  const kickEnergy = averageBinRange(track.dataArray, track.kickBinMin, track.kickBinMax);
  const snareEnergy = averageBinRange(track.dataArray, track.snareBinMin, track.snareBinMax);
  const hihatEnergy = averageBinRange(track.dataArray, track.hihatBinMin, track.hihatBinMax);
  drumKickDetector.update(kickEnergy, now);
  drumSnareDetector.update(snareEnergy, now);
  drumHihatDetector.update(hihatEnergy, now);
}

function updateGuitarAnalysis(track) {
  track.analyser.getByteFrequencyData(track.dataArray);
  track.analyser.getFloatTimeDomainData(track.timeDomainArray);

  const rms = computeRMS(track.timeDomainArray);
  const targetVolume = constrain(map(rms, 0, CONFIG.band.volumeCeiling, 0, 1), 0, 1);
  guitarState.smoothedVolume = lerp(guitarState.smoothedVolume, targetVolume, CONFIG.volumeSmoothing);

  const freq = autoCorrelate(track.timeDomainArray, audioContext.sampleRate);
  if (freq !== -1) guitarState.targetHue = freqToNoteIndex(freq) * 30;
  guitarState.hue = lerpHueShortest(guitarState.hue, guitarState.targetHue, CONFIG.hueSmoothing);
}

function updateBassAnalysis(track) {
  track.analyser.getByteFrequencyData(track.dataArray);

  const lowEnergy = averageBinRange(track.dataArray, track.kickBinMin, track.kickBinMax);
  const targetVolume = constrain(map(lowEnergy, 0, CONFIG.band.bassEnergyCeiling, 0, 1), 0, 1);
  bassState.smoothedVolume = lerp(bassState.smoothedVolume, targetVolume, CONFIG.volumeSmoothing);

  const rawSpeed = Math.abs(lowEnergy - bassState.previousEnergy);
  bassState.previousEnergy = lowEnergy;
  const targetSpeed = constrain(map(rawSpeed, 0, CONFIG.band.bassSpeedCeiling, 0, 1), 0, 1);
  bassState.speed = lerp(bassState.speed, targetSpeed, CONFIG.band.bassSpeedSmoothing);

  bassState.angle += 0.01 + bassState.speed * 0.08;
}

// ===================================================================
// REACTIONS
// Every shape on screen is a generic "element". Instead of hardcoding
// what each shape reacts to, the person picks from this catalog, and
// getReactionValue() fetches the live number from whichever per-source
// state above is relevant.
// ===================================================================

const REACTION_DEFS = {
  'volume-size':    { label: 'Tamanho por Volume',           sources: ['main', 'guitar', 'bass', 'drums'] },
  'volume-distort': { label: 'Distorção por Volume',         sources: ['main', 'guitar', 'bass', 'drums'] },
  'pitch-color':    { label: 'Cor por Nota',                  sources: ['main', 'guitar'] },
  'kick-distort':   { label: 'Distorção por Batida (Kick)',   sources: ['main', 'drums'] },
  'snare-expand':   { label: 'Expansão por Snare',            sources: ['drums'] },
  'hihat-squash':   { label: 'Achatamento por Hi-hat',        sources: ['drums'] },
  'bass-orbit':     { label: 'Órbita por Baixo (intensidade + velocidade)', sources: ['bass'] }
};

function getReactionValue(source, key) {
  if (source === 'main') {
    if (key === 'volume-size' || key === 'volume-distort') return smoothedVolume;
    if (key === 'pitch-color') return currentHue;
    if (key === 'kick-distort') return kickDetector.energy;
  }
  if (source === 'drums') {
    if (key === 'volume-size' || key === 'volume-distort') return drumState.smoothedVolume;
    if (key === 'kick-distort') return drumKickDetector.energy;
    if (key === 'snare-expand') return drumSnareDetector.energy;
    if (key === 'hihat-squash') return drumHihatDetector.energy;
  }
  if (source === 'guitar') {
    if (key === 'volume-size' || key === 'volume-distort') return guitarState.smoothedVolume;
    if (key === 'pitch-color') return guitarState.hue;
  }
  if (source === 'bass') {
    if (key === 'volume-size' || key === 'volume-distort') return bassState.smoothedVolume;
    if (key === 'bass-orbit') return bassState;
  }
  return 0;
}

// Turns an element's active reactions into concrete drawing numbers.
function computeElementVisualState(el) {
  const vs = {
    radius: lerp(CONFIG.elements.minSize, CONFIG.elements.maxSize, 0.3),
    hue: el.baseHue, sat: 78, bri: 90,
    scaleMultiplier: 1, squashY: 1,
    distortionPx: CONFIG.elements.baseWobble,
    orbitX: 0, orbitY: 0
  };

  el.reactions.forEach((key) => {
    const value = getReactionValue(el.source, key);
    switch (key) {
      case 'volume-size':
        vs.radius = map(value, 0, 1, CONFIG.elements.minSize, CONFIG.elements.maxSize);
        break;
      case 'volume-distort':
        vs.distortionPx += value * CONFIG.elements.volumeDistortStrength;
        break;
      case 'pitch-color':
        vs.hue = value;
        break;
      case 'kick-distort':
        vs.distortionPx += value * CONFIG.elements.kickDistortStrength;
        break;
      case 'snare-expand':
        vs.scaleMultiplier += value * 0.5;
        break;
      case 'hihat-squash':
        vs.squashY -= value * 0.4;
        break;
      case 'bass-orbit': {
        const bs = value;
        vs.orbitX = cos(bs.angle) * bs.smoothedVolume * CONFIG.band.bassMaxOffset;
        vs.orbitY = sin(bs.angle) * bs.smoothedVolume * CONFIG.band.bassMaxOffset * 0.5;
        vs.distortionPx += bs.speed * CONFIG.band.bassMaxDistortion;
        break;
      }
    }
  });

  return vs;
}

// ===================================================================
// ELEMENTS: the draggable, configurable shapes themselves
// ===================================================================

let nextElementId = 1;
let soloElements = null;
let bandElementsList = null;
let selectedElementId = null;
let draggingElementId = null;
let dragOffsetX = 0, dragOffsetY = 0;
const HIT_RADIUS = 75;

function getActiveElements() {
  if (currentMode === 'band') {
    if (!bandElementsList) bandElementsList = createDefaultBandElements();
    return bandElementsList;
  }
  if (!soloElements) soloElements = createDefaultSoloElements();
  return soloElements;
}

function createDefaultSoloElements() {
  return [{
    id: nextElementId++, shape: 'circle', x: width / 2, y: height / 2,
    source: 'main', reactions: ['volume-size', 'pitch-color', 'kick-distort'],
    effects: [], baseHue: 200, history: []
  }];
}

function createDefaultBandElements() {
  return [
    { id: nextElementId++, shape: 'square', x: width * 0.2, y: height * 0.55, source: 'drums',
      reactions: ['kick-distort', 'snare-expand', 'hihat-squash'], effects: [], baseHue: 20, history: [] },
    { id: nextElementId++, shape: 'circle', x: width * 0.5, y: height * 0.45, source: 'guitar',
      reactions: ['volume-size', 'volume-distort', 'pitch-color'], effects: [], baseHue: 200, history: [] },
    { id: nextElementId++, shape: 'triangle', x: width * 0.8, y: height * 0.55, source: 'bass',
      reactions: ['bass-orbit'], effects: ['mirror'], baseHue: 280, history: [] }
  ];
}

function addElement() {
  setupAudioContext();
  const elements = getActiveElements();
  const defaultSource = currentMode === 'band' ? 'guitar' : 'main';
  // Centraliza a nova forma
  const el = {
    id: nextElementId++, shape: 'circle',
    x: width / 2 + random(-50, 50), y: height / 2 + random(-50, 50),
    source: defaultSource, reactions: ['volume-size'], effects: [], baseHue: 200, history: []
  };
  elements.push(el);
  selectedElementId = el.id;
  openElementPanel(el);
}

function findSelectedElement() {
  return getActiveElements().find((e) => e.id === selectedElementId);
}

// --- Drag & select ---
function mousePressed() {
  const elements = getActiveElements();
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (dist(mouseX, mouseY, el.x, el.y) < HIT_RADIUS) {
      selectedElementId = el.id;
      draggingElementId = el.id;
      dragOffsetX = el.x - mouseX;
      dragOffsetY = el.y - mouseY;
      openElementPanel(el);
      return;
    }
  }
  selectedElementId = null;
  closeElementPanel();
}

function mouseDragged() {
  if (!draggingElementId) return;
  const el = getActiveElements().find((e) => e.id === draggingElementId);
  if (!el) return;
  el.x = constrain(mouseX + dragOffsetX, 0, width);
  el.y = constrain(mouseY + dragOffsetY, 0, height);
}

function mouseReleased() {
  draggingElementId = null;
}

// --- Properties panel (plain HTML, driven from here) ---
function openElementPanel(el) {
  const panel = document.getElementById('element-panel');
  panel.hidden = false;

  document.getElementById('el-shape').value = el.shape;

  const sourceRow = document.getElementById('el-source-row');
  const sourceSelect = document.getElementById('el-source');
  if (currentMode === 'band') {
    sourceRow.hidden = false;
    sourceSelect.innerHTML =
      '<option value="drums">Bateria</option>' +
      '<option value="guitar">Guitarra</option>' +
      '<option value="bass">Baixo</option>';
    sourceSelect.value = el.source;
  } else {
    sourceRow.hidden = true;
  }

  renderReactionCheckboxes(el);

  document.querySelectorAll('#el-effects input').forEach((cb) => {
    cb.checked = el.effects.includes(cb.value);
  });
}

function closeElementPanel() {
  const panel = document.getElementById('element-panel');
  if (panel) panel.hidden = true;
}

function renderReactionCheckboxes(el) {
  const container = document.getElementById('el-reactions');
  container.innerHTML = '';
  Object.entries(REACTION_DEFS).forEach(([key, def]) => {
    if (!def.sources.includes(el.source)) return;
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = key;
    cb.checked = el.reactions.includes(key);
    cb.addEventListener('change', () => {
      if (cb.checked) el.reactions.push(key);
      else el.reactions = el.reactions.filter((r) => r !== key);
    });
    label.appendChild(cb);
    label.append(' ' + def.label);
    container.appendChild(label);
  });
}

// ===================================================================
// VISUALS
// ===================================================================

function setup() {
  createCanvas(800, 800);
  colorMode(HSB, 360, 100, 100, 100);
  
  bgGraphics = createGraphics(800, 800, WEBGL);
  bgShader = bgGraphics.createShader(vert, frag);

  // Setup Global Events
  document.getElementById('clear-scene-btn').addEventListener('click', () => {
    if (currentMode === 'band') bandElementsList = [];
    else soloElements = [];
    selectedElementId = null;
    closeElementPanel();
  });

  // Áudio e UI
  document.getElementById('mic-btn').addEventListener('click', useMicrophone);
  document.getElementById('file-input').addEventListener('change', useAudioFile);
  document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
  document.getElementById('add-shape-btn').addEventListener('click', addElement);

  document.getElementById('volume-slider').addEventListener('input', (e) => {
    if (masterGain) masterGain.gain.value = parseFloat(e.target.value);
  });

  document.getElementById('seek-bar').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (currentMode === 'file' && filePlayerEl) {
      filePlayerEl.currentTime = val;
    } else if (currentMode === 'band') {
      bandOffset = val;
      if (sceneIsPlaying) startBandPlayback(val);
      else updatePlaybackUI(val, bandMaxDuration);
    }
  });

  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });

  document.getElementById('band-drums-input').addEventListener('change', (e) => {
    if (e.target.files[0]) {
       loadBandTrack('drums', e.target.files[0]);
       currentTrackName = "Sessão de Banda: " + e.target.files[0].name + "...";
    }
  });
  document.getElementById('band-guitar-input').addEventListener('change', (e) => {
    if (e.target.files[0]) loadBandTrack('guitar', e.target.files[0]);
  });
  document.getElementById('band-bass-input').addEventListener('change', (e) => {
    if (e.target.files[0]) loadBandTrack('bass', e.target.files[0]);
  });

  document.getElementById('el-shape').addEventListener('change', (e) => {
    const el = findSelectedElement();
    if (el) el.shape = e.target.value;
  });
  document.getElementById('el-source').addEventListener('change', (e) => {
    const el = findSelectedElement();
    if (!el) return;
    el.source = e.target.value;
    el.reactions = [];
    renderReactionCheckboxes(el);
  });
  document.querySelectorAll('#el-effects input').forEach((cb) => {
    cb.addEventListener('change', () => {
      const el = findSelectedElement();
      if (!el) return;
      if (cb.checked) el.effects.push(cb.value);
      else el.effects = el.effects.filter((f) => f !== cb.value);
    });
  });
  document.getElementById('el-remove').addEventListener('click', () => {
    const elements = getActiveElements();
    const idx = elements.findIndex((e) => e.id === selectedElementId);
    if (idx !== -1) elements.splice(idx, 1);
    selectedElementId = null;
    closeElementPanel();
  });
  document.getElementById('el-close').addEventListener('click', () => {
    selectedElementId = null;
    closeElementPanel();
  });
}

function draw() {
  if (document.getElementById('bg-shader-toggle').checked) {
    bgGraphics.shader(bgShader);
    bgShader.setUniform('uTime', millis() / 1000.0);
    bgShader.setUniform('uVolume', smoothedVolume);
    
    // Converte HSB atual para RGB para o shader
    let c = color(currentHue, 80, 100);
    bgShader.setUniform('uColor', [red(c)/255, green(c)/255, blue(c)/255]);
    
    bgGraphics.rect(0, 0, width, height);
    image(bgGraphics, 0, 0);
  } else {
    background(0, 0, 4);
  }

  document.getElementById('track-name').textContent = currentTrackName || "Silêncio";

  if (!audioReady) {
    fill(0, 0, 100);
    textAlign(CENTER, CENTER);
    textSize(16);
    text(idleMessageFor(currentMode), width / 2, height / 2);
    return;
  }

  // Só processa áudio se estiver tocando (ou modo mic ativo)
  if (sceneIsPlaying || currentMode === 'mic') {
    visualTime += 0.02;
    updateSourceAnalysis();
  }

  if (currentMode !== 'band') drawRipples();

  getActiveElements().forEach((el) => {
    const vs = computeElementVisualState(el);
    const trackLoaded = el.source === 'main' || (bandTracks[el.source] && bandTracks[el.source].buffer);
    drawElementWithEffects(el, vs, trackLoaded);
  });
}

const SOURCE_LABELS = { main: 'Principal', drums: 'Bateria', guitar: 'Guitarra', bass: 'Baixo' };

function idleMessageFor(mode) {
  if (mode === 'band') return 'Carregue ao menos uma faixa da banda para começar';
  return 'Use o microfone ou escolha um arquivo para começar';
}

function drawRipples() {
  noFill();
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    if (sceneIsPlaying) { rp.r += 6; rp.alpha -= 4; }
    if (rp.alpha <= 0) { ripples.splice(i, 1); continue; }
    stroke(currentHue, 50, 100, rp.alpha);
    strokeWeight(2);
    ellipse(width / 2, height / 2, rp.r * 2, rp.r * 2);
  }
}

// --- Generic shape outline: any shape can be a noise-distorted polygon ---
function drawShapePath(shape, size, distortAmt, seed) {
  if (shape === 'circle') {
    beginShape();
    const segments = 80;
    for (let i = 0; i <= segments; i++) {
      const angle = map(i, 0, segments, 0, TWO_PI);
      const n = noise(cos(angle) * 1.5 + seed, sin(angle) * 1.5 + seed, visualTime);
      const r = size + (n - 0.5) * distortAmt;
      vertex(cos(angle) * r, sin(angle) * r);
    }
    endShape(CLOSE);
    return;
  }

  const corners = shape === 'square'
    ? [[-size, -size], [size, -size], [size, size], [-size, size]]
    : [[0, -size], [size * 0.87, size * 0.5], [-size * 0.87, size * 0.5]]; // triangle

  beginShape();
  const perSide = 8;
  for (let s = 0; s < corners.length; s++) {
    const [x1, y1] = corners[s];
    const [x2, y2] = corners[(s + 1) % corners.length];
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      const x = lerp(x1, x2, t);
      const y = lerp(y1, y2, t);
      const n = noise(x * 0.02 + seed, y * 0.02 + seed, visualTime);
      vertex(x + (n - 0.5) * distortAmt, y + (n - 0.5) * distortAmt);
    }
  }
  endShape(CLOSE);
}

function drawShapeAt(shape, cx, cy, size, hue, sat, bri, distortionPx, squashY, alpha, seed, flipX = false, useGlow = false) {
  push();
  translate(cx, cy);
  scale(flipX ? -1 : 1, squashY);
  noStroke();
  fill(hue, sat, bri, alpha);
  
  if (useGlow) {
    drawingContext.shadowBlur = size * 0.2;
    drawingContext.shadowColor = color(hue, sat, bri, alpha).toString();
  } else {
    drawingContext.shadowBlur = 0;
  }

  drawShapePath(shape, size, distortionPx, seed);
  pop();
}

function drawElementWithEffects(el, vs, trackLoaded = true) {
  const seed = el.id * 13;
  const cx = el.x + vs.orbitX;
  const cy = el.y + vs.orbitY;
  const size = vs.radius * vs.scaleMultiplier;

  if (!trackLoaded) {
    noFill();
    stroke(0, 0, 40);
    strokeWeight(1.5);
    ellipse(el.x, el.y, size * 2, size * 2);
  } else {
    if (el.effects.includes('trail')) {
      if (sceneIsPlaying) {
        el.history.push({ x: cx, y: cy, size, hue: vs.hue });
        if (el.history.length > 10) el.history.shift();
      }
      el.history.forEach((snap, i) => {
        const a = map(i, 0, el.history.length, 5, 35);
        drawShapeAt(el.shape, snap.x, snap.y, snap.size, snap.hue, vs.sat, vs.bri, 0, vs.squashY, a, seed);
      });
    }

    const hasGlow = el.effects.includes('glow');
    drawShapeAt(el.shape, cx, cy, size, vs.hue, vs.sat, vs.bri, vs.distortionPx, vs.squashY, 85, seed, false, hasGlow);

    if (el.effects.includes('mirror')) {
      drawShapeAt(el.shape, cx + 40, cy, size * 0.9, vs.hue, vs.sat, vs.bri, vs.distortionPx, vs.squashY, 40, seed, true);
    }
  }

  if (currentMode === 'band') {
    noStroke();
    fill(0, 0, 75);
    textAlign(CENTER, CENTER);
    textSize(12);
    text(SOURCE_LABELS[el.source] || el.source, el.x, el.y + 110);
  }

  // selection highlight
  if (el.id === selectedElementId) {
    noFill();
    stroke(0, 0, 100, 40);
    strokeWeight(1.5);
    ellipse(el.x, el.y, HIT_RADIUS * 2, HIT_RADIUS * 2);
  }
}