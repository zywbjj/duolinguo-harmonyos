// Web Speech compatibility adapter. Transcripts come only from microphone audio
// decoded locally by Vosk; no prompt text, grading or progress APIs are accessed.
(() => {
  const allowed = ['https://www.duolingo.com', 'https://duolingo.com', 'https://www.duolingo.cn', 'https://duolingo.cn'];
  if (!allowed.includes(location.origin) || window !== window.top || window.__duoAudioV2) return;
  const state = { sequence: 0, stage: 'idle' };
  window.__duoAudioV2 = state;
  const root = location.origin + '/__duolinguo_voice_v1__/';
  const running = new Set();
  let model, modelPromise, libraryPromise, cancelModel, modelEpoch = 0;
  const report = stage => { state.stage = stage; state.sequence++; };
  const stopTracks = stream => { for (const track of stream?.getTracks() || []) { try { track.stop(); } catch {} } };
  const disposeModel = () => {
    modelEpoch++;
    cancelModel?.(); cancelModel = undefined;
    try { model?.terminate(); } catch {}
    // The pinned library posts a termination message; force termination also covers initialization failures.
    try { model?.worker?.terminate(); } catch {}
    model = undefined; modelPromise = undefined;
  };
  const loadLibrary = () => {
    if (window.Vosk?.Model) return Promise.resolve();
    if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); libraryPromise = undefined; reject(new Error('library timeout')); }, 15000);
      script.src = root + 'vosk-0.0.8.js';
      script.onload = () => { clearTimeout(timer); if (window.Vosk?.Model) resolve(); else { libraryPromise = undefined; reject(new Error('library unavailable')); } };
      script.onerror = () => { clearTimeout(timer); script.remove(); libraryPromise = undefined; reject(new Error('library load failed')); };
      (document.head || document.documentElement).append(script);
    });
    return libraryPromise;
  };
  const getModel = () => {
    if (model?.ready) return Promise.resolve(model);
    if (!modelPromise) {
      const pending = (async () => {
      const epoch = modelEpoch;
      report('model-loading'); await loadLibrary();
      if (epoch !== modelEpoch) throw new Error('model initialization cancelled');
      return new Promise((resolve, reject) => {
        let finished = false;
        const fail = () => {
          if (finished) return; finished = true; clearTimeout(timer); cancelModel = undefined;
          try { model?.worker?.terminate(); } catch {}
          model = undefined; modelPromise = undefined; reject(new Error('model unavailable'));
        };
        const timer = setTimeout(fail, 45000); cancelModel = fail;
        try {
          model = new window.Vosk.Model(root + 'en-us-0.15.tar.gz', -2);
          const fatal = () => {
            if (epoch !== modelEpoch) return;
            if (!finished) { fail(); return; }
            for (const recognizer of [...running]) recognizer._fail('audio-capture', 'engine-error');
            disposeModel();
          };
          model.on('error', fatal);
          model.worker?.addEventListener('error', fatal);
          model.worker?.addEventListener('messageerror', fatal);
          model.on('load', message => {
            if (finished || epoch !== modelEpoch) return;
            if (!message.result) { fail(); return; }
            finished = true; clearTimeout(timer); cancelModel = undefined;
            report('model-ready'); resolve(model);
          });
        } catch { fail(); }
      });
      })();
      modelPromise = pending;
      pending.catch(() => { if (modelPromise === pending) modelPromise = undefined; });
    }
    return modelPromise;
  };
  const list = values => { Object.defineProperty(values, 'item', { value: index => values[index] }); return values; };
  const result = (text, final, words) => {
    const scores = (words || []).map(word => word.conf).filter(value => Number.isFinite(value));
    const confidence = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const value = list([{ transcript: text, confidence: Math.max(0, Math.min(1, confidence)) }]);
    Object.defineProperty(value, 'isFinal', { value: final }); return value;
  };
  class OfflineSpeechRecognition extends EventTarget {
    constructor() {
      super(); this.lang = 'en-US'; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
      this._phase = 'idle'; this._ticket = 0; this._finals = []; this._pending = 0; this._hasSpeech = false;
    }
    _emit(type, data = {}) {
      const event = new Event(type); for (const [key, value] of Object.entries(data)) Object.defineProperty(event, key, { value });
      this.dispatchEvent(event);
      const handler = this['on' + type];
      if (typeof handler === 'function') { try { handler.call(this, event); } catch (error) { setTimeout(() => { throw error; }, 0); } }
    }
    _live(ticket) { return this._ticket === ticket && this._phase !== 'idle'; }
    _releaseCapture() {
      clearTimeout(this._limit); this._limit = undefined;
      if (this._processor) this._processor.onaudioprocess = null;
      for (const node of [this._source, this._processor, this._gain]) { try { node?.disconnect(); } catch {} }
      this._source = this._processor = this._gain = undefined;
      stopTracks(this._stream); this._stream = undefined;
      try { this._context?.close().catch(() => {}); } catch {} this._context = undefined;
    }
    _finish() {
      if (this._phase === 'idle') return;
      const hadCapture = this._phase === 'recording' || this._phase === 'finishing';
      this._phase = 'idle'; this._ticket++; this._releaseCapture(); clearTimeout(this._finishTimer);
      try { this._recognizer?.remove(); } catch {} this._recognizer = undefined;
      this._finals = []; this._pending = 0; running.delete(this);
      if (state.stage === 'capture-started') report('capture-stopped');
      if (hadCapture) this._emit('audioend'); this._emit('end');
    }
    _fail(error, stage) {
      if (this._phase === 'idle') return;
      // Never report network/service failures as "network": the site's current
      // speaking component awards a pass for that error. Device/engine failure
      // uses its non-grading alert path instead.
      report(stage); this._emit('error', { error }); this._finish();
    }
    start() {
      if (this._phase !== 'idle') throw new DOMException('Recognition already started', 'InvalidStateError');
      this._phase = 'loading'; this._hasSpeech = false; this._finals = []; this._pending = 0;
      report('capture-starting');
      const ticket = ++this._ticket; running.add(this);
      (async () => {
        if (document.hidden) { this._fail('audio-capture', 'capture-interrupted'); return; }
        if (!/^en(?:-|$)/i.test(this.lang || 'en-US')) { this._fail('audio-capture', 'language-unsupported'); return; }
        if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.Worker || !window.WebAssembly) {
          this._fail('audio-capture', 'engine-unsupported'); return;
        }
        let loaded;
        try { loaded = await getModel(); }
        catch { if (this._live(ticket)) this._fail('audio-capture', 'model-error'); return; }
        if (!this._live(ticket)) return;
        if (document.hidden) { this._fail('audio-capture', 'capture-interrupted'); return; }
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }); }
        catch (error) {
          if (this._live(ticket)) this._fail(['NotAllowedError', 'SecurityError'].includes(error.name) ? 'not-allowed' : 'audio-capture',
            ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'capture-denied' : 'capture-error');
          return;
        }
        if (!this._live(ticket)) { stopTracks(stream); return; }
        this._stream = stream;
        if (document.hidden) { this._fail('audio-capture', 'capture-interrupted'); return; }
        try {
          const context = this._context = new AudioContext({ sampleRate: 16000 });
          let resumeLimit;
          try {
            await Promise.race([context.resume(), new Promise((_, reject) => {
              resumeLimit = setTimeout(() => reject(new Error('audio context unavailable')), 5000);
            })]);
          } finally { clearTimeout(resumeLimit); }
          if (!this._live(ticket)) return;
          const recognizer = this._recognizer = new loaded.KaldiRecognizer(context.sampleRate);
          recognizer.setWords(true);
          const receive = message => {
            if (!this._live(ticket)) return;
            this._pending = Math.max(0, this._pending - 1);
            const final = message.event === 'result';
            const text = String(final ? message.result.text || '' : message.result.partial || '').trim().slice(0, 4096);
            if (text && (final || this.interimResults)) {
              if (!this._hasSpeech) { this._hasSpeech = true; this._emit('speechstart'); }
              const index = this._finals.length, entry = result(text, final, message.result.result);
              const values = list([...this._finals, entry]); if (final) this._finals.push(entry);
              this._emit('result', { resultIndex: index, results: values });
              if (!this._live(ticket)) return;
              if (final && !this.continuous && this._phase === 'recording') this.stop();
            }
            if (this._phase === 'finishing' && this._pending === 0) this._finish();
          };
          recognizer.on('partialresult', receive); recognizer.on('result', receive);
          recognizer.on('error', () => { if (this._live(ticket)) this._fail('audio-capture', 'engine-error'); });
          this._source = context.createMediaStreamSource(stream);
          this._processor = context.createScriptProcessor(4096, 1, 1);
          this._gain = context.createGain(); this._gain.gain.value = 0;
          this._processor.onaudioprocess = event => {
            if (!this._live(ticket) || this._phase !== 'recording') return;
            if (this._pending >= 12) { this._fail('audio-capture', 'engine-overloaded'); return; }
            try { this._pending++; recognizer.acceptWaveform(event.inputBuffer); }
            catch { this._fail('audio-capture', 'engine-error'); }
          };
          this._source.connect(this._processor); this._processor.connect(this._gain); this._gain.connect(context.destination);
          this._phase = 'recording'; this._limit = setTimeout(() => {
            if (!this._live(ticket)) return;
            if (!this._hasSpeech) this._fail('no-speech', 'no-speech'); else this.stop();
          }, 20000);
          report('capture-started'); this._emit('start'); this._emit('audiostart');
        } catch { if (this._live(ticket)) this._fail('audio-capture', 'capture-error'); }
      })().catch(() => { if (this._live(ticket)) this._fail('audio-capture', 'engine-error'); });
    }
    stop() {
      if (this._phase === 'idle' || this._phase === 'finishing') return;
      if (this._phase === 'loading') { this.abort(); return; }
      this._phase = 'finishing'; this._releaseCapture(); this._pending++;
      this._finishTimer = setTimeout(() => { if (this._phase === 'finishing') this._fail('audio-capture', 'engine-error'); }, 5000);
      try { this._recognizer.retrieveFinalResult(); }
      catch { this._fail('audio-capture', 'engine-error'); return; }
    }
    abort() {
      if (this._phase !== 'idle') {
        if (['capture-starting', 'model-loading', 'model-ready', 'capture-started'].includes(state.stage)) report('capture-stopped');
        this._finish();
      }
      if (running.size === 0 && !model?.ready) disposeModel();
    }
  }
  window.webkitSpeechRecognition = OfflineSpeechRecognition;
  window.SpeechRecognition = OfflineSpeechRecognition;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    for (const recognizer of [...running]) recognizer._fail('audio-capture', 'capture-interrupted');
    disposeModel();
  });
  addEventListener('pagehide', () => { for (const recognizer of [...running]) recognizer.abort(); disposeModel(); });
})();
