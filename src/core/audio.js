// Fully procedural WebAudio SFX + drone. No audio files ship with the build,
// which keeps the APK small and avoids any third-party sample licensing.

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.enabled = true;
    this._droneStarted = false;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.master);
  }

  _env(node, gain, attack, decay) {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(this.master);
    return t + attack + decay;
  }

  tone({ freq = 440, type = 'sine', gain = 0.2, attack = 0.005, decay = 0.2, sweep = null }) {
    if (!this.ctx || !this.enabled) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    const t = this.ctx.currentTime;
    osc.frequency.setValueAtTime(freq, t);
    if (sweep !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t + attack + decay);
    const end = this._env(osc, gain, attack, decay);
    osc.start(t);
    osc.stop(end + 0.02);
  }

  noise({ gain = 0.2, decay = 0.2, filter = 1200, type = 'lowpass' }) {
    if (!this.ctx || !this.enabled) return;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * decay));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const biq = this.ctx.createBiquadFilter();
    biq.type = type;
    biq.frequency.value = filter;
    src.connect(biq);
    this._env(biq, gain, 0.004, decay);
    src.start();
  }

  swing()      { this.noise({ gain: 0.13, decay: 0.13, filter: 2600, type: 'highpass' }); }
  hit(crit)    {
    this.tone({ freq: crit ? 320 : 220, type: 'square', gain: 0.16, decay: 0.1, sweep: crit ? 110 : 80 });
    this.noise({ gain: 0.14, decay: 0.09, filter: 1800 });
  }
  hurt()       { this.tone({ freq: 180, type: 'sawtooth', gain: 0.2, decay: 0.28, sweep: 60 }); }
  dash()       { this.noise({ gain: 0.16, decay: 0.22, filter: 900, type: 'bandpass' }); }
  skill()      { this.tone({ freq: 520, type: 'triangle', gain: 0.18, decay: 0.34, sweep: 1400 }); }
  nova()       {
    this.tone({ freq: 90, type: 'sine', gain: 0.3, decay: 0.7, sweep: 40 });
    this.noise({ gain: 0.22, decay: 0.55, filter: 700 });
  }
  bind()       {
    [220, 330, 440].forEach((f, i) => setTimeout(() => this.tone({ freq: f, type: 'sine', gain: 0.16, decay: 0.5 }), i * 70));
  }
  death()      { this.tone({ freq: 140, type: 'sawtooth', gain: 0.18, decay: 0.45, sweep: 45 }); }
  levelUp()    {
    [523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => this.tone({ freq: f, type: 'triangle', gain: 0.2, decay: 0.35 }), i * 95));
  }
  gateClear()  {
    [392, 523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => this.tone({ freq: f, type: 'sine', gain: 0.2, decay: 0.55 }), i * 130));
  }
  gameOver()   {
    [330, 262, 196, 147].forEach((f, i) =>
      setTimeout(() => this.tone({ freq: f, type: 'sawtooth', gain: 0.16, decay: 0.6 }), i * 190));
  }
  ui()         { this.tone({ freq: 660, type: 'sine', gain: 0.09, decay: 0.07 }); }

  // Low ambient drone that swells while a gate is active.
  startDrone(baseFreq = 55) {
    if (!this.ctx || this._droneStarted) return;
    this._droneStarted = true;
    [1, 1.5, 2.02].forEach((mult, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = i === 2 ? 'triangle' : 'sine';
      osc.frequency.value = baseFreq * mult;
      const g = this.ctx.createGain();
      g.gain.value = 0.22 / (i + 1);
      // Slow detune wobble so the pad never sounds static.
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.03;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 1.4;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start();
      osc.connect(g);
      g.connect(this.musicGain);
      osc.start();
    });
  }

  music(on) {
    if (!this.ctx) return;
    this.startDrone();
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
    this.musicGain.gain.linearRampToValueAtTime(on ? 0.5 : 0.0, t + 1.4);
  }
}
