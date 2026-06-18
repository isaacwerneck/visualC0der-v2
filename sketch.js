/**
 * Acoustic Visualizer - Standalone Web App
 * Made with performance-optimized procedural rendering and full Web Audio API modeling.
 */

// Global App Configuration
const CONFIG = {
  volumeSmoothing: 0.25,
  hueSmoothing: 0.15,
  pitchConfidence: 0.35,

  solo: {
    volumeCeiling: 0.5,
    kickFreqMin: 40,
    kickFreqMax: 150,
    kickThresholdMultiplier: 1.4,
    kickMinEnergy: 8,
    kickCooldownMs: 120,
    kickDecay: 0.90,
    volumeSmoothing: 0.15
  },

  band: {
    kickFreqMin: 40,
    kickFreqMax: 150,
    snareFreqMin: 150,
    snareFreqMax: 2500,
    hihatFreqMin: 6000,
    hihatFreqMax: 14000,
    kickThresholdMultiplier: 1.4,
    kickMinEnergy: 8,
    kickCooldownMs: 120,
    kickDecay: 0.90,
    snareThresholdMultiplier: 1.5,
    snareMinEnergy: 6,
    snareCooldownMs: 100,
    snareDecay: 0.85,
    hihatThresholdMultiplier: 1.6,
    hihatMinEnergy: 4,
    hihatCooldownMs: 65,
    hihatDecay: 0.80,
    volumeCeiling: 0.5,
    bassEnergyCeiling: 180,
    bassSpeedCeiling: 40,
    bassSpeedSmoothing: 0.3,
    bassMaxOffset: 120,
    bassMaxDistortion: 50
  },

  elements: {
    baseWobble: 6,
    minSize: 40,
    maxSize: 220,
    volumeDistortStrength: 80,
    kickDistortStrength: 150
  }
};

// Math and Helper Functions
function hzToBin(hz, sampleRate, fftSize) {
  const hzPerBin = sampleRate / fftSize;
  return Math.round(hz / hzPerBin);
}

function computeRMS(buffer) {
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  return Math.sqrt(sumSquares / (buffer.length || 1));
}

function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.015) return -1;

  let r1 = 0;
  let r2 = SIZE - 1;
  const edgeThreshold = 0.15;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < edgeThreshold) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < edgeThreshold) {
      r2 = SIZE - i;
      break;
    }
  }
  
  const trimmed = buffer.slice(r1, r2);
  const n = trimmed.length;
  if (n === 0) return -1;

  const c = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    for (let i = 0; i < n - lag; i++) {
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  let maxVal = -1;
  let maxPos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxVal) {
      maxVal = c[i];
      maxPos = i;
    }
  }
  if (maxPos <= 0 || maxVal / (c[0] || 1) < CONFIG.pitchConfidence) return -1;

  let T0 = maxPos;
  const x1 = c[T0 - 1] !== undefined ? c[T0 - 1] : c[T0];
  const x2 = c[T0];
  const x3 = c[T0 + 1] !== undefined ? c[T0 + 1] : c[T0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a !== 0) {
    T0 -= b / (2 * a);
  }

  return sampleRate / T0;
}

function freqToNoteIndex(freq) {
  if (freq <= 0) return 0;
  const midiNote = 12 * Math.log2(freq / 440) + 69;
  const rounded = Math.round(midiNote);
  return ((rounded % 12) + 12) % 12;
}

function hslToRgb(h, s = 0.9, l = 0.6) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}

function lerpHueShortest(current, target, amt) {
  const diff = ((target - current + 540) % 360) - 180;
  return (current + diff * amt + 360) % 360;
}

function averageBinRange(data, fromBin, toBin) {
  const from = Math.max(0, fromBin);
  const to = Math.min(data.length - 1, toBin);
  if (to < from) return 0;
  let sum = 0;
  for (let i = from; i <= to; i++) {
    sum += data[i];
  }
  return sum / (to - from + 1);
}

// Subband Beat Onset Detector
class OnsetDetector {
  constructor(thresholdMultiplier, minEnergy, cooldownMs, decay, historySize = 43) {
    this.thresholdMultiplier = thresholdMultiplier;
    this.minEnergy = minEnergy;
    this.cooldownMs = cooldownMs;
    this.decay = decay;
    this.historySize = historySize;
    this.history = [];
    this.energy = 0;
    this.lastTriggerTime = 0;
  }

  update(bandEnergy, now) {
    this.history.push(bandEnergy);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }
    const avg = this.history.reduce((sum, v) => sum + v, 0) / (this.history.length || 1);
    const isHit =
      bandEnergy > avg * this.thresholdMultiplier &&
      bandEnergy > this.minEnergy &&
      now - this.lastTriggerTime > this.cooldownMs;

    if (isHit) {
      this.energy = 1.0;
      this.lastTriggerTime = now;
    } else {
      this.energy *= this.decay;
    }
    return isHit;
  }
}

/**
 * WebGL Background Shader Manager - Handles the psychedelic reactive background
 */
class BackgroundShader {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { alpha: true });
    if (!this.gl) return;
    
    const vsSource = `
      attribute vec2 a_position;
      varying vec2 vTexCoord;
      void main() {
        vTexCoord = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0, 1);
      }
    `;
    const fsSource = `
      precision highp float;
      varying vec2 vTexCoord;
      uniform float u_time;
      uniform vec2 u_resolution;
      uniform float u_volume;
      uniform float u_kick;
      uniform float u_mids;
      uniform float u_treble;
      uniform vec3 u_color;
      uniform float u_iterations;
      uniform float u_speed_mult;
      uniform float u_rot_mult;

      void main() {
        vec2 uv = vTexCoord * 2.0 - 1.0;
        uv.x *= u_resolution.x / u_resolution.y;
        vec2 uv0 = uv;
        vec3 finalColor = vec3(0.0);
        
        float t = u_time * 0.5 * u_speed_mult;
        
        // Rotation logic
        float angle = u_time * 0.1 * u_rot_mult;
        mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
        uv *= rot;

        for (int i = 0; i < 8; i++) {
          if (float(i) >= u_iterations) break;
          uv = fract(uv * (1.5 + u_mids * 0.5)) - 0.5;
          float d = length(uv) * exp(-length(uv0));
          vec3 col = u_color * (0.5 + 0.5 * cos(t + float(i) * 0.4 + vec3(0,2,4)));
          d = sin(d * (8.0 + u_treble * 4.0) + t + u_kick * 3.0) / 8.0;
          d = abs(d);
          d = pow(0.01 / d, 1.2);
          finalColor += col * d;
        }
        gl_FragColor = vec4(finalColor * (0.1 + u_volume), 1.0);
      }
    `;

    this.program = this._createProgram(vsSource, fsSource);
    this.uTimeLoc = this.gl.getUniformLocation(this.program, "u_time");
    this.uResLoc = this.gl.getUniformLocation(this.program, "u_resolution");
    this.uVolLoc = this.gl.getUniformLocation(this.program, "u_volume");
    this.uKickLoc = this.gl.getUniformLocation(this.program, "u_kick");
    this.uMidsLoc = this.gl.getUniformLocation(this.program, "u_mids");
    this.uTrebLoc = this.gl.getUniformLocation(this.program, "u_treble");
    this.uColLoc = this.gl.getUniformLocation(this.program, "u_color");
    this.uIterLoc = this.gl.getUniformLocation(this.program, "u_iterations");
    this.uSpeedLoc = this.gl.getUniformLocation(this.program, "u_speed_mult");
    this.uRotLoc = this.gl.getUniformLocation(this.program, "u_rot_mult");
    this.aPosLoc = this.gl.getAttribLocation(this.program, "a_position");

    this.positionBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), this.gl.STATIC_DRAW);
    
    this.enabled = false;
    this.iterations = 4.0;
    this.speedMult = 1.0;
    this.rotMult = 1.0;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource); gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return prog;
  }

  render(time, volume, kick, mids, treble, rgb) {
    const gl = this.gl;
    if (!this.enabled || !gl) {
      if (gl) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      return;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.aPosLoc);
    gl.vertexAttribPointer(this.aPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.uTimeLoc, time);
    gl.uniform2f(this.uResLoc, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uVolLoc, volume);
    gl.uniform1f(this.uKickLoc, kick);
    gl.uniform1f(this.uMidsLoc, mids);
    gl.uniform1f(this.uTrebLoc, treble);
    gl.uniform3fv(this.uColLoc, rgb);
    gl.uniform1f(this.uIterLoc, this.iterations);
    gl.uniform1f(this.uSpeedLoc, this.speedMult);
    gl.uniform1f(this.uRotLoc, this.rotMult);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// Default Presets Creators
const DEFAULT_SOLO_PRESET = () => [
  {
    id: 'solo-1',
    shape: 'circle',
    x: 50,
    y: 50,
    source: 'main',
    reactions: ['volume-size', 'pitch-color', 'kick-distort'],
    effects: ['pulse'],
    baseHue: 200
  },
  {
    id: 'solo-2',
    shape: 'star',
    x: 50,
    y: 50,
    source: 'main',
    reactions: ['volume-distort', 'volume-size'],
    effects: ['outline', 'trail'],
    baseHue: 280
  }
];

const DEFAULT_BAND_PRESET = () => [
  {
    id: 'band-drums',
    shape: 'square',
    x: 25,
    y: 50,
    source: 'drums',
    reactions: ['kick-distort', 'snare-expand', 'hihat-squash'],
    effects: ['pulse'],
    baseHue: 345
  },
  {
    id: 'band-guitar',
    shape: 'circle',
    x: 50,
    y: 50,
    source: 'guitar',
    reactions: ['volume-size', 'volume-distort', 'pitch-color'],
    effects: ['trail'],
    baseHue: 195
  },
  {
    id: 'band-bass',
    shape: 'triangle',
    x: 75,
    y: 50,
    source: 'bass',
    reactions: ['volume-size', 'bass-orbit'],
    effects: ['mirror'],
    baseHue: 275
  }
];

const REACTION_CATALOG = {
  'volume-size': 'Expandir por Volume',
  'volume-distort': 'Distorcer (Volume)',
  'pitch-color': 'Cor por Nota',
  'kick-distort': 'Distorcer (Batida)',
  'snare-expand': 'Pulso (Caixa)',
  'hihat-squash': 'Achatamento (Hi-Hat)',
  'bass-orbit': 'Órbita do Baixo'
};

const getPermittedReactions = (mode, source) => {
  if (mode !== 'band') {
    return ['volume-size', 'volume-distort', 'pitch-color', 'kick-distort'];
  }
  switch (source) {
    case 'drums':
      return ['volume-size', 'volume-distort', 'kick-distort', 'snare-expand', 'hihat-squash'];
    case 'guitar':
      return ['volume-size', 'volume-distort', 'pitch-color'];
    case 'bass':
      return ['volume-size', 'volume-distort', 'bass-orbit'];
    default:
      return ['volume-size'];
  }
};


/**
 * Audio Engine Controller
 */
class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.globalVolume = 0.7;
    this.audioDestination = null; // Novo: Para capturar o stream de áudio
    this.mode = 'mic'; // 'mic' | 'file' | 'band'
    this.isPlaying = false;

    // Solo files
    this.soloFile = null;
    this.soloName = '';
    this.soloBuffer = null;
    this.soloSourceNode = null;
    this.soloAnalyser = null;
    this.soloGainNode = null;

    // Pre-allocated arrays for performance
    this.analysisBuffers = { time: new Float32Array(512), freq: new Uint8Array(256) };

    // Microphone source
    this.micStream = null;
    this.micSourceNode = null;
    this.micAnalyser = null;

    // Timing tracker
    this.elapsedOffset = 0;
    this.lastStartTime = 0;
    this.duration = 0;

    // Solo detector & output
    this.soloKickDetector = new OnsetDetector(
      CONFIG.solo.kickThresholdMultiplier,
      CONFIG.solo.kickMinEnergy,
      CONFIG.solo.kickCooldownMs,
      CONFIG.solo.kickDecay
    );

    this.soloAnalysis = {
      volume: 0,
      hue: 200,
      targetHue: 200,
      kickEnergy: 0,
      mids: 0,
      treble: 0,
      timeArray: new Float32Array(0),
      freqArray: new Uint8Array(0)
    };

    // Stems & detectors for Band Mode
    this.drumKickDetector = new OnsetDetector(
      CONFIG.band.kickThresholdMultiplier,
      CONFIG.band.kickMinEnergy,
      CONFIG.band.kickCooldownMs,
      CONFIG.band.kickDecay
    );
    this.drumSnareDetector = new OnsetDetector(
      CONFIG.band.snareThresholdMultiplier,
      CONFIG.band.snareMinEnergy,
      CONFIG.band.snareCooldownMs,
      CONFIG.band.snareDecay
    );
    this.drumHihatDetector = new OnsetDetector(
      CONFIG.band.hihatThresholdMultiplier,
      CONFIG.band.hihatMinEnergy,
      CONFIG.band.hihatCooldownMs,
      CONFIG.band.hihatDecay
    );

    this.bandTracks = {
      drums: this.createEmptyTrackState(),
      guitar: this.createEmptyTrackState(),
      bass: this.createEmptyTrackState()
    };
  }

  createEmptyTrackState() {
    return {
      file: null,
      name: '',
      buffer: null,
      analyser: null,
      gainNode: null,
      sourceNode: null,
      volume: 0,
      hue: 200,
      kickEnergy: 0,
      snareEnergy: 0,
      hihatEnergy: 0,
      speed: 0,
      angle: 0,
      previousEnergy: 0
    };
  }

  init() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();
    this.masterGain = this.ctx.createGain();
    // Usar setTargetAtTime para evitar estalos de áudio na inicialização
    this.masterGain.gain.setTargetAtTime(this.globalVolume, this.ctx.currentTime, 0.01);
    
    // Novo: Criar um MediaStreamDestination para capturar o áudio
    this.audioDestination = this.ctx.createMediaStreamDestination();
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.connect(this.audioDestination); // Conectar ao destino para gravação
  }

  setVolume(val) {
    this.globalVolume = val;
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(val, this.ctx.currentTime, 0.05);
  }

  setMode(newMode) {
    this.pause();
    this.stopMic();
    this.mode = newMode;
    this.elapsedOffset = 0;
    this.duration = 0;
    
    // Recast durations
    if (this.mode === 'file' && this.soloBuffer) {
      this.duration = this.soloBuffer.duration;
    } else if (this.mode === 'band') {
      let maxD = 0;
      Object.values(this.bandTracks).forEach((t) => {
        if (t.buffer) maxD = Math.max(maxD, t.buffer.duration);
      });
      this.duration = maxD;
    }
  }

  async startMic() {
    this.init();
    await this.ctx.resume();
    this.pause();

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.micSourceNode = this.ctx.createMediaStreamSource(this.micStream);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.micSourceNode.connect(this.micAnalyser);

    this.isPlaying = true;
    this.lastStartTime = this.ctx.currentTime;
  }

  stopMic() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.micSourceNode) {
      this.micSourceNode.disconnect();
      this.micSourceNode = null;
    }
    this.micAnalyser = null;
  }

  async play() {
    if (this.isPlaying) return;
    this.init();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    if (this.mode === 'file') {
      if (!this.soloBuffer) return;
      this.lastStartTime = this.ctx.currentTime;
      
      this.soloSourceNode = this.ctx.createBufferSource();
      this.soloSourceNode.buffer = this.soloBuffer;

      this.soloAnalyser = this.ctx.createAnalyser();
      this.soloAnalyser.fftSize = 512;

      this.soloGainNode = this.ctx.createGain();

      this.soloSourceNode.connect(this.soloAnalyser);
      this.soloAnalyser.connect(this.soloGainNode);
      this.soloGainNode.connect(this.masterGain);

      // Garante que o offset não ultrapasse a duração do áudio
      const offset = Math.min(this.elapsedOffset, this.soloBuffer.duration - 0.001);
      this.soloSourceNode.start(0, Math.max(0, offset));
      this.isPlaying = true;
    } else if (this.mode === 'band') {
      let startedAny = false;
      this.lastStartTime = this.ctx.currentTime;

      Object.keys(this.bandTracks).forEach((key) => {
        const track = this.bandTracks[key];
        if (!track.buffer) return;

        track.sourceNode = this.ctx.createBufferSource();
        track.sourceNode.buffer = track.buffer;

        track.analyser = this.ctx.createAnalyser();
        track.analyser.fftSize = 512;

        track.gainNode = this.ctx.createGain();

        track.sourceNode.connect(track.analyser);
        track.analyser.connect(track.gainNode);
        track.gainNode.connect(this.masterGain);

        const offset = Math.min(this.elapsedOffset, track.buffer.duration - 0.001);
        track.sourceNode.start(0, Math.max(0, offset));
        startedAny = true;
      });

      if (startedAny) {
        this.isPlaying = true;
      }
    }
  }

  pause() {
    if (!this.isPlaying) return;

    if (this.ctx) {
      this.elapsedOffset = Math.min(
        this.duration,
        this.elapsedOffset + (this.ctx.currentTime - this.lastStartTime)
      );
    }

    if (this.soloSourceNode) {
      try { this.soloSourceNode.stop(); } catch (e) {}
      this.soloSourceNode.disconnect();
      this.soloSourceNode = null;
    }
    this.soloGainNode = null;
    this.soloAnalyser = null;

    Object.values(this.bandTracks).forEach((track) => {
      if (track.sourceNode) {
        try { track.sourceNode.stop(); } catch (e) {}
        track.sourceNode.disconnect();
        track.sourceNode = null;
      }
      track.gainNode = null;
      track.analyser = null;
    });

    this.isPlaying = false;
  }

  seek(seconds) {
    const wasPlaying = this.isPlaying;
    this.pause();
    this.elapsedOffset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) {
      this.play();
    }
  }

  resetAll() {
    this.pause();
    this.stopMic();

    this.soloFile = null;
    this.soloName = 'Nenhum arquivo';
    this.soloBuffer = null;

    this.bandTracks = {
      drums: this.createEmptyTrackState(),
      guitar: this.createEmptyTrackState(),
      bass: this.createEmptyTrackState()
    };

    this.elapsedOffset = 0;
    this.duration = 0;
    this.isPlaying = false;
  }

  updateAnalysis(nowMs) {
    if (!this.isPlaying || !this.ctx) {
      // Decay metrics smoothly
      const decay = 0.82;
      this.soloAnalysis.volume *= decay;
      this.soloAnalysis.kickEnergy *= decay;
      Object.values(this.bandTracks).forEach((t) => {
        t.volume *= decay;
        t.kickEnergy *= decay;
        t.snareEnergy *= decay;
        t.hihatEnergy *= decay;
        t.speed *= decay;
      });
      return;
    }

    // Auto loop termination
    const currentElapsed = this.elapsedOffset + (this.ctx.currentTime - this.lastStartTime);
    if (this.duration > 0 && currentElapsed > this.duration) {
      this.pause();
      this.elapsedOffset = 0;
      return;
    }

    const sampleRate = this.ctx.sampleRate;

    if (this.mode === 'mic' && this.micAnalyser) {
      this.analyzeNode(this.micAnalyser, sampleRate, nowMs, this.soloAnalysis, this.soloKickDetector);
    } else if (this.mode === 'file' && this.soloAnalyser) {
      this.analyzeNode(this.soloAnalyser, sampleRate, nowMs, this.soloAnalysis, this.soloKickDetector);
    } else if (this.mode === 'band') {
      
      // Drums Stems
      const drums = this.bandTracks.drums;
      if (drums.analyser) {
        const fftSize = drums.analyser.fftSize;
        const freqs = new Uint8Array(drums.analyser.frequencyBinCount);
        const times = new Float32Array(drums.analyser.fftSize);
        drums.analyser.getByteFrequencyData(freqs);
        drums.analyser.getFloatTimeDomainData(times);

        drums.volume = Math.min(1, Math.max(0, computeRMS(times) / CONFIG.band.volumeCeiling));

        const kickBinMin = hzToBin(CONFIG.band.kickFreqMin, sampleRate, fftSize);
        const kickBinMax = hzToBin(CONFIG.band.kickFreqMax, sampleRate, fftSize);
        const snareBinMin = hzToBin(CONFIG.band.snareFreqMin, sampleRate, fftSize);
        const snareBinMax = hzToBin(CONFIG.band.snareFreqMax, sampleRate, fftSize);
        const hihatBinMin = hzToBin(CONFIG.band.hihatFreqMin, sampleRate, fftSize);
        const hihatBinMax = hzToBin(CONFIG.band.hihatFreqMax, sampleRate, fftSize);

        const kickEnergyRaw = averageBinRange(freqs, kickBinMin, kickBinMax);
        const snareEnergyRaw = averageBinRange(freqs, snareBinMin, snareBinMax);
        const hihatEnergyRaw = averageBinRange(freqs, hihatBinMin, hihatBinMax);

        this.drumKickDetector.update(kickEnergyRaw, nowMs);
        this.drumSnareDetector.update(snareEnergyRaw, nowMs);
        this.drumHihatDetector.update(hihatEnergyRaw, nowMs);

        drums.kickEnergy = this.drumKickDetector.energy;
        drums.snareEnergy = this.drumSnareDetector.energy;
        drums.hihatEnergy = this.drumHihatDetector.energy;
      }

      // Guitar Stems
      const guitar = this.bandTracks.guitar;
      if (guitar.analyser) {
        guitar.analyser.getFloatTimeDomainData(this.analysisBuffers.time);
        guitar.volume = Math.min(1, Math.max(0, computeRMS(this.analysisBuffers.time) / CONFIG.band.volumeCeiling));

        const freq = autoCorrelate(this.analysisBuffers.time, sampleRate);
        if (freq !== -1) {
          const target = freqToNoteIndex(freq) * 30;
          guitar.hue = lerpHueShortest(guitar.hue, target, CONFIG.hueSmoothing);
        }
      }

      // Bass Stems
      const bass = this.bandTracks.bass;
      if (bass.analyser) {
        const freqs = new Uint8Array(bass.analyser.frequencyBinCount);
        bass.analyser.getByteFrequencyData(freqs);

        const kickBinMin = hzToBin(CONFIG.band.kickFreqMin, sampleRate, bass.analyser.fftSize);
        const kickBinMax = hzToBin(CONFIG.band.kickFreqMax, sampleRate, bass.analyser.fftSize);
        const lowEnergy = averageBinRange(freqs, kickBinMin, kickBinMax);

        const targetVolume = Math.min(1, Math.max(0, lowEnergy / CONFIG.band.bassEnergyCeiling));
        bass.volume = targetVolume;

        const rawSpeed = Math.abs(lowEnergy - bass.previousEnergy);
        bass.previousEnergy = lowEnergy;
        const targetSpeed = Math.min(1, Math.max(0, rawSpeed / CONFIG.band.bassSpeedCeiling));
        
        bass.speed = bass.speed * (1 - CONFIG.band.bassSpeedSmoothing) + targetSpeed * CONFIG.band.bassSpeedSmoothing;
        bass.angle += 0.012 + bass.speed * 0.085;
      }
    }
  }

  analyzeNode(analyser, sampleRate, nowMs, target, kickDetector) {
    const fftSize = analyser.fftSize;
    if (target.timeArray.length !== fftSize) {
      target.timeArray = new Float32Array(fftSize);
    }
    if (target.freqArray.length !== analyser.frequencyBinCount) {
      target.freqArray = new Uint8Array(analyser.frequencyBinCount);
    }

    analyser.getByteFrequencyData(target.freqArray);
    analyser.getFloatTimeDomainData(target.timeArray);

    const rms = computeRMS(target.timeArray);
    const targetVolume = Math.min(1, Math.max(0, rms / CONFIG.solo.volumeCeiling));
    target.volume = target.volume * (1 - CONFIG.volumeSmoothing) + targetVolume * CONFIG.volumeSmoothing;

    const freq = autoCorrelate(target.timeArray, sampleRate);
    if (freq !== -1) {
      target.targetHue = freqToNoteIndex(freq) * 30;
    }
    target.hue = lerpHueShortest(target.hue, target.targetHue, CONFIG.hueSmoothing);

    const kickBinMin = hzToBin(CONFIG.solo.kickFreqMin, sampleRate, fftSize);
    const kickBinMax = hzToBin(CONFIG.solo.kickFreqMax, sampleRate, fftSize);
    const kickBandEnergy = averageBinRange(target.freqArray, kickBinMin, kickBinMax);

    kickDetector.update(kickBandEnergy, nowMs);
    target.kickEnergy = kickDetector.energy;

    // Extract Mids and Treble for Shader logic
    const midBinMin = hzToBin(500, sampleRate, fftSize);
    const midBinMax = hzToBin(2000, sampleRate, fftSize);
    const trebBinMin = hzToBin(5000, sampleRate, fftSize);
    target.mids = averageBinRange(target.freqArray, midBinMin, midBinMax) / 180;
    target.treble = averageBinRange(target.freqArray, trebBinMin, target.freqArray.length - 1) / 120;
  }
}

// Instantiate local singleton
const audioManager = new AudioManager();


/**
 * Standalone App Controller & Drag/Drop Workspace Viewports mapping
 */
let elements = DEFAULT_SOLO_PRESET();
let selectedId = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let ripples = [];
let trails = {};
let previousTime = 0;
let timeCount = 0;
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];

// Grab UI Ref handles
const canvas = document.getElementById('visualizer-canvas');
const ctx = canvas.getContext('2d');
const bgCanvas = document.getElementById('background-canvas');
const bgShader = new BackgroundShader(bgCanvas);

const btnModeMic = document.getElementById('btn-mode-mic');
const btnModeFile = document.getElementById('btn-mode-file');
const btnModeBand = document.getElementById('btn-mode-band');

const btnActionMic = document.getElementById('btn-action-mic');
const txtActionMic = document.getElementById('txt-action-mic');
const btnChooseFile = document.getElementById('btn-choose-file');
const btnExportVideo = document.getElementById('btn-export-video');
const txtChooseFile = document.getElementById('txt-choose-file');
const btnPlayPause = document.getElementById('btn-play-pause');
const volumeSlider = document.getElementById('volume-slider');
const volumeContainer = document.getElementById('volume-container');
const btnResetCanvas = document.getElementById('btn-reset-canvas');
const btnAddShape = document.getElementById('btn-add-shape');

const bandContainer = document.getElementById('band-inputs-container');
const btnBandDrums = document.getElementById('btn-band-drums');
const btnBandGuitar = document.getElementById('btn-band-guitar');
const btnBandBass = document.getElementById('btn-band-bass');

const fileInput = document.getElementById('file-input');
const drumsInput = document.getElementById('drums-input');
const guitarInput = document.getElementById('guitar-input');
const bassInput = document.getElementById('bass-input');

const timelineContainer = document.getElementById('timeline-container');
const timelineSlider = document.getElementById('timeline-slider');
const txtElapsedTime = document.getElementById('txt-elapsed-time');

// Properties Sidebar references
const propertiesPanel = document.getElementById('properties-panel');
const btnCloseProperties = document.getElementById('btn-close-properties');
const btnClosePropPanel = document.getElementById('btn-close-prop-panel');
const btnRemoveShape = document.getElementById('btn-remove-shape');
const selectPropShape = document.getElementById('select-prop-shape');
const sliderPropHue = document.getElementById('slider-prop-hue');
const textPropHueValue = document.getElementById('text-prop-hue-value');
const previewPropColor = document.getElementById('preview-prop-color');
const containerPropSource = document.getElementById('container-prop-source');
const selectPropSource = document.getElementById('select-prop-source');
const reactionsChecklist = document.getElementById('reactions-checklist');
const checkFxMirror = document.getElementById('check-fx-mirror');
const checkFxTrail = document.getElementById('check-fx-trail');
const checkBgShader = document.getElementById('check-bg-shader');
const sliderBgIterations = document.getElementById('slider-bg-iterations');
const textBgIterationsValue = document.getElementById('text-bg-iterations-value');
const sliderBgSpeed = document.getElementById('slider-bg-speed');
const sliderBgRotation = document.getElementById('slider-bg-rotation');


// Resize Canvas dynamically
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (bgCanvas) {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
  }
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();


// UI updates based on current interactive visual element State
function updateUI() {
  // Mode selection highlight states
  [btnModeMic, btnModeFile, btnModeBand].forEach(b => b.classList.remove('bg-neutral-800', 'text-white', 'shadow-md', 'border', 'border-neutral-700/40'));
  [btnModeMic, btnModeFile, btnModeBand].forEach(b => b.classList.add('text-neutral-400', 'hover:text-neutral-200'));

  if (audioManager.mode === 'mic') {
    btnModeMic.classList.add('bg-neutral-800', 'text-white', 'shadow-md', 'border', 'border-neutral-700/40');
    btnModeMic.classList.remove('text-neutral-400', 'hover:text-neutral-200');
    
    btnActionMic.classList.remove('hidden');
    btnChooseFile.classList.add('hidden');
    bandContainer.classList.add('hidden');
    btnPlayPause.classList.add('hidden');
    volumeContainer.classList.add('hidden');
    timelineContainer.classList.add('hidden');
  } else if (audioManager.mode === 'file') {
    btnModeFile.classList.add('bg-neutral-800', 'text-white', 'shadow-md', 'border', 'border-neutral-700/40');
    btnModeFile.classList.remove('text-neutral-400', 'hover:text-neutral-200');

    btnActionMic.classList.add('hidden');
    btnChooseFile.classList.remove('hidden');
    bandContainer.classList.add('hidden');
    btnPlayPause.classList.remove('hidden');
    btnExportVideo.classList.remove('hidden');
    volumeContainer.classList.remove('hidden');
    
    txtChooseFile.innerText = audioManager.soloName ? audioManager.soloName.toUpperCase() : 'ESCOLHER ÁUDIO';
    if (audioManager.duration > 0) timelineContainer.classList.remove('hidden');
    else timelineContainer.classList.add('hidden');
  } else if (audioManager.mode === 'band') {
    btnModeBand.classList.add('bg-neutral-800', 'text-white', 'shadow-md', 'border', 'border-neutral-700/40');
    btnModeBand.classList.remove('text-neutral-400', 'hover:text-neutral-200');

    btnActionMic.classList.add('hidden');
    btnChooseFile.classList.add('hidden');
    bandContainer.classList.remove('hidden');
    btnExportVideo.classList.remove('hidden');
    btnPlayPause.classList.remove('hidden');
    volumeContainer.classList.remove('hidden');

    // Stems details check
    updateBandBtn(btnBandDrums, audioManager.bandTracks.drums.name, '🥁 BATERIA');
    updateBandBtn(btnBandGuitar, audioManager.bandTracks.guitar.name, '🎸 GUITARRA');
    updateBandBtn(btnBandBass, audioManager.bandTracks.bass.name, '🎵 BAIXO');

    if (audioManager.duration > 0) timelineContainer.classList.remove('hidden');
    else timelineContainer.classList.add('hidden');
  }

  // CORREÇÃO: Lucide substitui o <i> por <svg>, então precisamos reinjetar o ícone
  // para que o seletor não retorne null e trave o script.
  btnPlayPause.innerHTML = audioManager.isPlaying 
    ? '<i data-lucide="pause" class="w-4 h-4 fill-current"></i>' 
    : '<i data-lucide="play" class="w-4 h-4 fill-current"></i>';

  // Garante que o Lucide processe o novo ícone injetado
  if (window.lucide) {
    lucide.createIcons();
  }

  // Properties binding
  const selectedElement = elements.find(el => el.id === selectedId);
  if (selectedElement) {
    propertiesPanel.classList.remove('hidden');
    
    selectPropShape.value = selectedElement.shape;
    sliderPropHue.value = selectedElement.baseHue;
    textPropHueValue.innerText = `${selectedElement.baseHue}°`;
    previewPropColor.style.backgroundColor = `hsl(${selectedElement.baseHue}, 90%, 60%)`;
    textPropHueValue.style.color = `hsl(${selectedElement.baseHue}, 90%, 65%)`;

    checkFxMirror.checked = selectedElement.effects.includes('mirror');
    checkFxTrail.checked = selectedElement.effects.includes('trail');
    checkBgShader.checked = bgShader.enabled;
    sliderBgIterations.value = bgShader.iterations;
    textBgIterationsValue.innerText = bgShader.iterations;

    if (audioManager.mode === 'band') {
      containerPropSource.classList.remove('hidden');
      selectPropSource.value = selectedElement.source;
    } else {
      containerPropSource.classList.add('hidden');
    }

    renderReactionsChecklist(selectedElement);
  } else {
    propertiesPanel.classList.add('hidden');
  }
}

function updateBandBtn(btn, trackName, label) {
  if (trackName) {
    btn.classList.add('border-emerald-950', 'bg-emerald-950/20', 'text-emerald-400');
    btn.innerHTML = `<span>${label.split(' ')[0]} CARGADO ✓</span>`;
  } else {
    btn.classList.remove('border-emerald-950', 'bg-emerald-950/20', 'text-emerald-400');
    btn.innerHTML = `<span>${label}</span>`;
  }
}

function renderReactionsChecklist(element) {
  reactionsChecklist.innerHTML = '';
  const permitted = getPermittedReactions(audioManager.mode, element.source);

  permitted.forEach(reactionKey => {
    const isChecked = element.reactions.includes(reactionKey);
    const labelText = REACTION_CATALOG[reactionKey] || reactionKey;

    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 cursor-pointer text-[10.5px] text-neutral-400 hover:text-neutral-200 select-none transition';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = isChecked;
    input.className = 'rounded border-neutral-800 bg-neutral-950 text-neutral-200 accent-neutral-300 w-3.5 h-3.5';
    input.addEventListener('change', () => {
      if (input.checked) {
        if (!element.reactions.includes(reactionKey)) element.reactions.push(reactionKey);
      } else {
        element.reactions = element.reactions.filter(r => r !== reactionKey);
      }
      updateUI();
    });

    const span = document.createElement('span');
    span.innerText = labelText;

    label.appendChild(input);
    label.appendChild(span);
    reactionsChecklist.appendChild(label);
  });
}

// Mode Trigger actions
btnModeMic.onclick = () => { audioManager.setMode('mic'); updateUI(); };
btnModeFile.onclick = () => { audioManager.setMode('file'); updateUI(); };
btnModeBand.onclick = () => { audioManager.setMode('band'); updateUI(); };

btnActionMic.onclick = async () => {
  if (audioManager.isPlaying) {
    audioManager.pause();
    txtActionMic.innerText = '🎤 USAR MICROFONE';
  } else {
    try {
      await audioManager.startMic();
      txtActionMic.innerText = '⏸ PARAR MICROFONE';
    } catch (e) {
      alert('Impossível acessar seu microfone: ' + e);
    }
  }
  updateUI();
};

btnChooseFile.onclick = () => fileInput.click();
btnBandDrums.onclick = () => drumsInput.click();
btnBandGuitar.onclick = () => guitarInput.click();
btnBandBass.onclick = () => bassInput.click();

fileInput.onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  audioManager.init();
  audioManager.soloName = file.name;
  updateUI();

  const reader = new FileReader();
  reader.onload = async (evt) => {
    audioManager.ctx.decodeAudioData(evt.target.result, (buf) => {
      audioManager.soloBuffer = buf;
      audioManager.duration = buf.duration;
      updateUI();
    }, (error) => alert('A decodificação falhou: ' + error));
  };
  reader.readAsArrayBuffer(file);
};

// Help Load multiple stem inputs
function loadStem(input, stemKey, stemLabel) {
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    audioManager.init();
    audioManager.bandTracks[stemKey].name = file.name;
    updateUI();

    const reader = new FileReader();
    reader.onload = async (evt) => {
      audioManager.ctx.decodeAudioData(evt.target.result, (buf) => {
        audioManager.bandTracks[stemKey].buffer = buf;
        
        let maxD = 0;
        Object.values(audioManager.bandTracks).forEach((t) => {
          if (t.buffer) maxD = Math.max(maxD, t.buffer.duration);
        });
        audioManager.duration = maxD;
        
        updateUI();
      }, (error) => alert('A decodificação falhou: ' + error));
    };
    reader.readAsArrayBuffer(file);
  };
}
loadStem(drumsInput, 'drums', 'Drums');
loadStem(guitarInput, 'guitar', 'Guitar');
loadStem(bassInput, 'bass', 'Bass');

// Play pause triggering
btnPlayPause.onclick = async () => {
  if (audioManager.isPlaying) {
    audioManager.pause();
  } else {
    await audioManager.play();
  }
  updateUI();
};

volumeSlider.oninput = () => {
  audioManager.setVolume(parseFloat(volumeSlider.value));
};

btnResetCanvas.onclick = () => {
  audioManager.resetAll();
  elements = audioManager.mode === 'band' ? DEFAULT_BAND_PRESET() : DEFAULT_SOLO_PRESET();
  selectedId = null;
  updateUI();
};

btnAddShape.onclick = () => {
  const newElement = {
    id: 'element-' + Date.now(),
    shape: ['circle', 'ring', 'triangle', 'square', 'star'][Math.floor(Math.random() * 5)],
    x: 40 + Math.random() * 20,
    y: 40 + Math.random() * 20,
    source: audioManager.mode === 'band' ? ['drums', 'guitar', 'bass'][Math.floor(Math.random() * 3)] : 'main',
    reactions: ['volume-size'],
    effects: [],
    baseHue: Math.floor(Math.random() * 360)
  };
  
  // Set default permitted reaction as initial
  const permitted = getPermittedReactions(audioManager.mode, newElement.source);
  
  // Inicializa o tamanho para que ele seja clicável imediatamente
  newElement.reactions = [permitted[0]];
  newElement.lastSize = CONFIG.elements.minSize;

  elements.unshift(newElement); // Adiciona ao topo da lista para facilitar seleção
  selectedId = newElement.id;
  updateUI();
};

// Properties listeners
btnCloseProperties.onclick = btnClosePropPanel.onclick = () => {
  selectedId = null;
  updateUI();
};

btnRemoveShape.onclick = () => {
  if (!selectedId) return;
  elements = elements.filter(el => el.id !== selectedId);
  selectedId = null;
  updateUI();
};

selectPropShape.onchange = () => {
  const selectedElement = elements.find(el => el.id === selectedId);
  if (selectedElement) {
    selectedElement.shape = selectPropShape.value;
  }
};

sliderPropHue.oninput = () => {
  const selectedElement = elements.find(el => el.id === selectedId);
  if (selectedElement) {
    selectedElement.baseHue = parseInt(sliderPropHue.value);
    previewPropColor.style.backgroundColor = `hsl(${selectedElement.baseHue}, 90%, 60%)`;
    textPropHueValue.innerText = `${selectedElement.baseHue}°`;
    textPropHueValue.style.color = `hsl(${selectedElement.baseHue}, 90%, 65%)`;
  }
};

selectPropSource.onchange = () => {
  const selectedElement = elements.find(el => el.id === selectedId);
  if (selectedElement) {
    selectedElement.source = selectPropSource.value;
    const permitted = getPermittedReactions(audioManager.mode, selectedElement.source);
    selectedElement.reactions = [permitted[0]];
    updateUI();
  }
};

checkFxMirror.onclick = () => {
  const selectedElement = elements.find(el => el.id === selectedId);
  if (selectedElement) {
    if (checkFxMirror.checked) {
      if (!selectedElement.effects.includes('mirror')) selectedElement.effects.push('mirror');
    } else {
      selectedElement.effects = selectedElement.effects.filter(e => e !== 'mirror');
    }
  }
};

checkFxTrail.onclick = () => {
  const selectedElement = elements.find(el => el.id === selectedId);
  if (selectedElement) {
    if (checkFxTrail.checked) {
      if (!selectedElement.effects.includes('trail')) selectedElement.effects.push('trail');
    } else {
      selectedElement.effects = selectedElement.effects.filter(e => e !== 'trail');
    }
  }
};

// Video Export Logic
btnExportVideo.onclick = () => {
  if (isRecording) return;
  
  recordedChunks = [];
  
  // Captura o stream de vídeo do canvas principal (2D). Reduzido para 30 FPS para melhor performance.
  const videoStream = canvas.captureStream(30); 
  
  // Captura o stream de áudio do AudioContext
  const audioStream = audioManager.audioDestination ? audioManager.audioDestination.stream : new MediaStream();

  // Combina os streams de vídeo e áudio
  const combinedStream = new MediaStream();
  videoStream.getTracks().forEach(track => combinedStream.addTrack(track));
  audioStream.getTracks().forEach(track => combinedStream.addTrack(track));

  mediaRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm; codecs=vp9' });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `visualizer-export-${Date.now()}.webm`;
    a.click();
    isRecording = false;
    btnExportVideo.classList.remove('animate-pulse', 'bg-red-600');
  };

  isRecording = true;
  mediaRecorder.start();
  btnExportVideo.classList.add('animate-pulse', 'bg-red-600');

  // Grava por 10 segundos
  setTimeout(() => {
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }, 10000);
};

checkBgShader.onchange = () => {
  bgShader.enabled = checkBgShader.checked;
};

sliderBgIterations.oninput = () => {
  bgShader.iterations = parseFloat(sliderBgIterations.value);
  textBgIterationsValue.innerText = bgShader.iterations;
};

sliderBgSpeed.oninput = () => {
  bgShader.speedMult = parseFloat(sliderBgSpeed.value);
};

sliderBgRotation.oninput = () => {
  bgShader.rotMult = parseFloat(sliderBgRotation.value);
};


// Mouse Drag & Drop elements repositioning
canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  let clickedOne = null;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const elX = (el.x / 100) * canvas.width;
    const elY = (el.y / 100) * canvas.height;

    // MELHORIA: Detecção dinâmica baseada no tamanho atual da forma
    const dist = Math.hypot(clickX - elX, clickY - elY);
    // Considera um raio mínimo de 40px para formas pequenas serem clicáveis
    const clickRadius = Math.max(40, (el.lastSize || 60) * 1.2);
    
    if (dist <= clickRadius) {
      clickedOne = el;
      break;
    }
  }

  if (clickedOne) {
    selectedId = clickedOne.id;
    isDragging = true;
    dragOffset.x = clickX - (clickedOne.x / 100) * canvas.width;
    dragOffset.y = clickY - (clickedOne.y / 100) * canvas.height;
  } else {
    selectedId = null;
  }

  updateUI();
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging || !selectedId) return;

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const el = elements.find(item => item.id === selectedId);
  if (el) {
    el.x = Math.max(0, Math.min(100, ((mouseX - dragOffset.x) / canvas.width) * 100));
    el.y = Math.max(0, Math.min(100, ((mouseY - dragOffset.y) / canvas.height) * 100));
  }
});

canvas.addEventListener('mouseup', () => {
  isDragging = false;
});

// Timeline Seeking
timelineSlider.oninput = () => {
  if (audioManager.duration > 0) {
    const targetSec = (parseFloat(timelineSlider.value) / 100) * audioManager.duration;
    audioManager.seek(targetSec);
  }
};


// Main Animation Frame loop
function drawFrame(now) {
  requestAnimationFrame(drawFrame);

  if (previousTime === 0) previousTime = now;
  const delta = now - previousTime;
  previousTime = now;

  // Clock elapsed increment
  timeCount += 0.04;

  // Core Audio managers analyses
  audioManager.updateAnalysis(now);

  // Render Background Shader reactively
  const sVol = audioManager.mode === 'band' ? audioManager.bandTracks.drums.volume : audioManager.soloAnalysis.volume;
  const sKick = audioManager.mode === 'band' ? audioManager.bandTracks.drums.kickEnergy : audioManager.soloAnalysis.kickEnergy;
  const sMids = audioManager.mode === 'band' ? audioManager.bandTracks.guitar.volume : audioManager.soloAnalysis.mids;
  const sTreb = audioManager.mode === 'band' ? audioManager.bandTracks.drums.hihatEnergy : audioManager.soloAnalysis.treble;
  const sHue = audioManager.mode === 'band' ? audioManager.bandTracks.guitar.hue : audioManager.soloAnalysis.hue;
  
  const rgb = hslToRgb(sHue);
  bgShader.render(timeCount, sVol, sKick, sMids, sTreb, rgb);

  // Sync timeline slider elements
  if (audioManager.isPlaying && audioManager.duration > 0 && !audioManager.micAnalyser) {
    const contextCurrentTime = audioManager.ctx.currentTime;
    const currentElapsed = audioManager.elapsedOffset + (contextCurrentTime - audioManager.lastStartTime);

    timelineSlider.value = (currentElapsed / audioManager.duration) * 100;
    
    const minutesElapsed = Math.floor(currentElapsed / 60);
    const secondsElapsed = String(Math.floor(currentElapsed % 60)).padStart(2, '0');
    const minutesTotal = Math.floor(audioManager.duration / 60);
    const secondsTotal = String(Math.floor(audioManager.duration % 60)).padStart(2, '0');

    txtElapsedTime.innerText = `${minutesElapsed}:${secondsElapsed} / ${minutesTotal}:${secondsTotal}`;
  }

  // Draw background grids & radial lights (agora do offscreen canvas)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (isRecording && bgShader.enabled) { // Desenha o bgCanvas no contexto 2D apenas se estiver gravando e o shader estiver ativo
    ctx.drawImage(bgCanvas, 0, 0); // Isso garante que o fundo WebGL seja parte do stream gravado
  }
  const gridSize = 45;
  for (let x = 0; x < canvas.width; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  // Handle active central ripples (drums kick or master kick triggers)
  let activeKick = false;
  let activeKickHue = 200;
  if (audioManager.mode === 'band') {
    activeKick = audioManager.bandTracks.drums.kickEnergy > 0.55;
    activeKickHue = 345;
  } else {
    activeKick = audioManager.soloAnalysis.kickEnergy > 0.55;
    activeKickHue = audioManager.soloAnalysis.hue;
  }

  if (activeKick && Math.random() < 0.12) {
    ripples.push({ r: 20, alpha: 1.0, hue: activeKickHue });
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    // Movimento independente do Play para evitar que fiquem travados ao pausar
    rp.r += 4.5;
    rp.alpha -= 0.025;

    if (rp.alpha <= 0) {
      ripples.splice(i, 1);
      continue;
    }

    ctx.strokeStyle = `hsla(${rp.hue}, 85%, 65%, ${rp.alpha * 0.4})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, rp.r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Draw procedural shapes elements
  elements.forEach((el) => {
    const elX = (el.x / 100) * canvas.width;
    const elY = (el.y / 100) * canvas.height;

    let vol = 0;
    let pColor = el.baseHue;
    let kickE = 0;
    let snareE = 0;
    let hihatE = 0;
    let bassSpeed = 0;
    let bassAngle = 0;

    if (audioManager.mode === 'band' && (el.source === 'drums' || el.source === 'guitar' || el.source === 'bass')) {
      const tState = audioManager.bandTracks[el.source];
      if (tState) {
        vol = tState.volume;
        pColor = el.source === 'guitar' ? tState.hue : el.baseHue;
        kickE = tState.kickEnergy;
        snareE = tState.snareEnergy;
        hihatE = tState.hihatEnergy;
        bassSpeed = tState.speed;
        bassAngle = tState.angle;
      }
    } else {
      vol = audioManager.soloAnalysis.volume;
      pColor = el.reactions.includes('pitch-color') ? audioManager.soloAnalysis.hue : el.baseHue;
      kickE = audioManager.soloAnalysis.kickEnergy;
    }

    let radius = CONFIG.elements.minSize + (CONFIG.elements.maxSize - CONFIG.elements.minSize) * 0.3;
    let distortionPx = CONFIG.elements.baseWobble;
    let scaleMult = 1.0;
    let squashY = 1.0;
    let orbitX = 0;
    let orbitY = 0;
    let hue = pColor;
    let rotationAngle = timeCount * 0.3;

    el.reactions.forEach((reaction) => {
      switch (reaction) {
        case 'volume-size':
          radius = CONFIG.elements.minSize + vol * (CONFIG.elements.maxSize - CONFIG.elements.minSize);
          break;
        case 'volume-distort':
          distortionPx += vol * CONFIG.elements.volumeDistortStrength;
          break;
        case 'pitch-color':
          hue = pColor;
          break;
        case 'kick-distort':
          distortionPx += kickE * CONFIG.elements.kickDistortStrength;
          break;
        case 'snare-expand':
          scaleMult += snareE * 0.45;
          break;
        case 'hihat-squash':
          squashY -= hihatE * 0.35;
          break;
        case 'bass-orbit':
          orbitX = Math.cos(bassAngle) * vol * CONFIG.band.bassMaxOffset;
          orbitY = Math.sin(bassAngle) * vol * CONFIG.band.bassMaxOffset * 0.55;
          distortionPx += bassSpeed * CONFIG.band.bassMaxDistortion;
          rotationAngle = bassAngle;
          break;
      }
    });

    const size = radius * scaleMult;
    el.lastSize = size; // Armazena o tamanho real para a detecção de clique
    const drawX = elX + orbitX;
    const drawY = elY + orbitY;

    // Trail Support
    if (el.effects.includes('trail')) {
      if (!trails[el.id]) trails[el.id] = [];
      const trailArray = trails[el.id];

      // Atualiza o rastro se estiver tocando música OU se você estiver arrastando o objeto
      if (audioManager.isPlaying || (isDragging && el.id === selectedId)) {
        trailArray.push({ x: drawX, y: drawY, size, hue, angle: rotationAngle });
        if (trailArray.length > 12) trailArray.shift();
      } else {
        // Se pausado e parado, remove os pontos gradualmente até o rastro sumir
        if (trailArray.length > 0) trailArray.shift();
      }

      trailArray.forEach((history, idx) => {
        const alpha = (idx / trailArray.length) * 0.28;
        drawShape(
          el.shape,
          history.x,
          history.y,
          history.size,
          history.hue,
          distortionPx * 0.5,
          squashY,
          alpha,
          history.angle
        );
      });
    }

    // Main Shape
    drawShape(
      el.shape,
      drawX,
      drawY,
      size,
      hue,
      distortionPx,
      squashY,
      0.85,
      rotationAngle
    );

    // Mirror Support
    if (el.effects.includes('mirror')) {
      const mirrorDist = size * 1.1;
      drawShape(
        el.shape,
        drawX + mirrorDist,
        drawY,
        size * 0.8,
        hue,
        distortionPx,
        squashY,
        0.4,
        -rotationAngle,
        true
      );
    }

    // Label tags in band mode
    if (audioManager.mode === 'band' && (el.source === 'drums' || el.source === 'guitar' || el.source === 'bass')) {
      const labels = { drums: '🥁 BATERIA', guitar: '🎸 GUITARRA', bass: '🎵 BAIXO' };
      ctx.font = '500 10px sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.textAlign = 'center';
      ctx.fillText(labels[el.source] || el.source.toUpperCase(), elX, elY + size + 25);
    }

    // Selected indicator
    if (el.id === selectedId) {
      ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.65)`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(elX, elY, size + 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = `hsla(${hue}, 90%, 65%, 0.95)`;
      ctx.beginPath();
      ctx.arc(elX, elY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function drawShape(shape, cx, cy, size, hue, distortAmt, squashY, alpha, angle, flipX = false) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(flipX ? -1 : 1, squashY);

  ctx.shadowBlur = 25;
  ctx.shadowColor = `hsla(${hue}, 90%, 55%, ${alpha * 0.75})`;
  ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${alpha})`;

  ctx.beginPath();

  if (shape === 'circle') {
    const segments = 90;
    const distortFactor = distortAmt > 0 ? 1 : 0;
    for (let i = 0; i <= segments; i++) {
      const phi = (i / segments) * Math.PI * 2;
      let r = size;
      if (distortFactor) r += Math.sin(phi * 4 + timeCount * 5) * Math.cos(phi * 3 - timeCount * 2) * distortAmt;
      const px = Math.cos(phi) * r;
      const py = Math.sin(phi) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  } else if (shape === 'square') {
    const sides = 4;
    const corners = [
      { x: -size, y: -size },
      { x: size, y: -size },
      { x: size, y: size },
      { x: -size, y: size }
    ];

    for (let s = 0; s < sides; s++) {
      const p1 = corners[s];
      const p2 = corners[(s + 1) % sides];
      const steps = 15;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const sx = p1.x * (1 - t) + p2.x * t;
        const sy = p1.y * (1 - t) + p2.y * t;
        const distOffset = Math.sin(sx * 0.05 + timeCount * 4) * Math.cos(sy * 0.05 + timeCount * 3) * distortAmt * 0.55;
        const len = Math.hypot(sx, sy);
        const nx = sx / (len || 1);
        const ny = sy / (len || 1);
        const px = sx + nx * distOffset;
        const py = sy + ny * distOffset;

        if (s === 0 && i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
  } else if (shape === 'triangle') {
    const sides = 3;
    const corners = [
      { x: 0, y: -size * 1.1 },
      { x: size * 1.05, y: size * 0.75 },
      { x: -size * 1.05, y: size * 0.75 }
    ];

    for (let s = 0; s < sides; s++) {
      const p1 = corners[s];
      const p2 = corners[(s + 1) % sides];
      const steps = 15;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const sx = p1.x * (1 - t) + p2.x * t;
        const sy = p1.y * (1 - t) + p2.y * t;
        const distOffset = Math.sin(sx * 0.08 + timeCount * 5) * Math.cos(sy * 0.08 - timeCount * 3) * distortAmt * 0.6;
        const len = Math.hypot(sx, sy);
        const nx = sx / (len || 1);
        const ny = sy / (len || 1);
        const px = sx + nx * distOffset;
        const py = sy + ny * distOffset;

        if (s === 0 && i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
  } else if (shape === 'ring') {
    const segments = 90;
    for (let i = 0; i <= segments; i++) {
      const phi = (i / segments) * Math.PI * 2;
      const wave = Math.sin(phi * 5 + timeCount * 6) * Math.cos(phi * 4 - timeCount * 3);
      const r = size + wave * distortAmt;
      const px = Math.cos(phi) * r;
      const py = Math.sin(phi) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    ctx.moveTo(size * 0.55, 0);
    for (let i = segments; i >= 0; i--) {
      const phi = (i / segments) * Math.PI * 2;
      const rInner = size * 0.6 - Math.sin(phi * 3 + timeCount * 3) * distortAmt * 0.3;
      const px = Math.cos(phi) * rInner;
      const py = Math.sin(phi) * rInner;
      ctx.lineTo(px, py);
    }
  } else if (shape === 'star') {
    const spikes = 5;
    const outerRad = size;
    const innerRad = size * 0.45;
    const steps = spikes * 2;

    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      const isOuter = i % 2 === 0;
      const radiusVal = isOuter ? outerRad : innerRad;
      const wave = Math.sin(theta * 3 + timeCount * 6) * distortAmt * 0.5;
      const r = radiusVal + wave;
      const px = Math.cos(theta) * r;
      const py = Math.sin(theta) * r;

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }

  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Fire up first render
updateUI();
requestAnimationFrame(drawFrame);
