// Live front-camera capture (no gallery upload).
// Camera.capture(labels) opens a camera dialog and resolves { blob } with a JPEG.
(function () {
  const DEFAULTS = {
    capture: 'Capture selfie',
    cancel: 'Cancel',
    ready: 'Look straight at the camera.',
    camera: 'Camera blocked. Allow camera access for this site.',
    cancelled: 'Selfie is required.',
  };

  function capture(labels) {
    const L = { ...DEFAULTS, ...(labels || {}) };
    return new Promise(async (resolve, reject) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = '<video autoplay playsinline muted></video>' +
        '<p class="muted" style="text-align:center;margin:10px 0" role="status"></p>' +
        '<button class="primary" type="button"></button><button type="button"></button>';
      const video = dlg.querySelector('video');
      const status = dlg.querySelector('p');
      const [snap, cancel] = dlg.querySelectorAll('button');
      snap.textContent = L.capture; cancel.textContent = L.cancel; status.textContent = L.ready;
      document.body.appendChild(dlg);

      let stream;
      const finish = (fn, v) => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        dlg.close(); dlg.remove(); fn(v);
      };

      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      } catch (e) { dlg.remove(); return reject(new Error(L.camera)); }

      video.srcObject = stream;
      dlg.showModal();
      cancel.onclick = () => finish(reject, new Error(L.cancelled));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(reject, new Error(L.cancelled)); });

      snap.onclick = () => {
        if (!video.videoWidth) return; // camera not ready yet
        const scale = Math.min(1, 640 / video.videoWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(video.videoWidth * scale);
        c.height = Math.round(video.videoHeight * scale);
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        c.toBlob((blob) => finish(resolve, { blob }), 'image/jpeg', 0.7);
      };
    });
  }

  // ---------- live face check (face-api.js, runs in the browser) ----------
  const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';
  const TIMEOUT_MS = 45000;
  const VDEFAULTS = {
    loading: 'Loading face check...',
    noFace: 'No face found. Look straight at the camera.',
    manyFaces: 'Only one face please.',
    closer: 'Move closer to the camera.',
    blink: 'Face found. Blink once to confirm you are live.',
    checking: 'Checking...',
    blinkHelp: 'Look straight at the camera and blink slowly, once.',
    timeout: 'Face check timed out. Try again in better light.',
    engine: 'Face check could not load. Check your internet and try again.',
  };

  let modelsReady;
  function loadModels() {
    if (!modelsReady) {
      modelsReady = (async () => {
        if (!window.faceapi) throw new Error('face-api missing');
        const n = faceapi.nets;
        await Promise.all([n.tinyFaceDetector.loadFromUri(MODELS), n.faceLandmark68TinyNet.loadFromUri(MODELS), n.faceRecognitionNet.loadFromUri(MODELS)]);
      })().catch((e) => { modelsReady = null; throw e; });
    }
    return modelsReady;
  }

  const detector = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }); // still photos: accurate
  const liveDetector = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }); // video: fast, so a blink is not missed
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ear = (p) => (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3])); // eye aspect ratio: drops when the eye closes
  const eyeOpenness = (lm) => { const p = lm.positions; return (ear(p.slice(36, 42)) + ear(p.slice(42, 48))) / 2; };
  // Second blink signal that does not depend on the landmark shape: the contrast (standard deviation of brightness)
  // inside each eye box. An open eye (dark iris, white sclera) is high contrast; an eyelid over it is flat skin.
  // It is cheap, so it is sampled ~60 times a second between the (slower) face detections: a real blink is only
  // 100-150 ms long and would fall between detections otherwise.
  const eyeCanvas = document.createElement('canvas');
  eyeCanvas.width = 32; eyeCanvas.height = 12;
  const eyeCtx = eyeCanvas.getContext('2d', { willReadFrequently: true });
  function eyeBoxes(lm) {
    const p = lm.positions;
    return [p.slice(36, 42), p.slice(42, 48)].map((pts) => {
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const padY = Math.max(1, (y1 - y0) * 0.25);
      return { x: x0, y: y0 - padY, w: Math.max(2, x1 - x0), h: (y1 - y0) + 2 * padY };
    });
  }
  function contrastIn(video, boxes) {
    let total = 0;
    for (const b of boxes) {
      eyeCtx.drawImage(video, b.x, b.y, b.w, b.h, 0, 0, 32, 12);
      const d = eyeCtx.getImageData(0, 0, 32, 12).data;
      let sum = 0, sq = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += l; sq += l * l; n++; }
      total += Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
    }
    return total / boxes.length;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Face descriptor (128 numbers) for the largest face in a JPEG blob, or null when there is no clear face.
  async function descriptorOf(blob) {
    await loadModels();
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const found = await faceapi.detectAllFaces(img, detector()).withFaceLandmarks(true).withFaceDescriptors();
      if (!found.length) return null;
      const area = (f) => f.detection.box.width * f.detection.box.height;
      found.sort((a, b) => area(b) - area(a));
      if (found.length > 1 && area(found[1]) * 2 > area(found[0])) return null; // two people of similar size: ambiguous
      return Array.from(found[0].descriptor);
    } finally { URL.revokeObjectURL(url); }
  }

  // Opens the camera, waits for one blink from a single face (so a held-up photo does not pass), then takes the
  // selfie and the face descriptor. Who the face belongs to is decided by the server. Resolves { blob, descriptor }.
  function scan(labels) {
    const L = { ...DEFAULTS, ...VDEFAULTS, ...(labels || {}) };
    return new Promise(async (resolve, reject) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = '<video autoplay playsinline muted></video>' +
        '<p class="muted" style="text-align:center;margin:10px 0" role="status"></p><button type="button"></button>';
      const video = dlg.querySelector('video');
      const status = dlg.querySelector('p');
      const cancel = dlg.querySelector('button');
      cancel.textContent = L.cancel; status.textContent = L.loading;
      document.body.appendChild(dlg);

      let stream, stopped = false, sampler;
      const finish = (fn, v) => {
        stopped = true; clearInterval(sampler);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (dlg.open) dlg.close();
        dlg.remove(); fn(v);
      };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(reject, new Error(L.cancelled)); });
      cancel.onclick = () => finish(reject, new Error(L.cancelled));
      dlg.showModal();

      try {
        await loadModels();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      } catch (e) {
        return finish(reject, new Error(e && e.name === 'NotAllowedError' ? L.camera : window.faceapi ? L.camera : L.engine));
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});

      const started = Date.now();
      let boxes = null, boxesAt = 0, blinkSeen = false;
      let peakC = 0, cClosed = false, cClosedAt = 0;   // blink state from the fast contrast sampler
      let peak = 0, closed = false, closedAt = 0;      // blink state from the landmark shape (checked per detection)
      const forget = () => { boxes = null; blinkSeen = false; peakC = 0; cClosed = false; peak = 0; closed = false; };

      sampler = setInterval(() => {
        if (stopped || !boxes || Date.now() - boxesAt > 1500 || !video.videoWidth) return;
        const c = contrastIn(video, boxes), now = Date.now();
        if (!cClosed) {
          peakC = peakC ? Math.max(c, peakC * 0.995) : c; // slowly-fading peak = the "eyes open" reference
          if (peakC > 4 && c < peakC * 0.88) { cClosed = true; cClosedAt = now; }
        } else if (c > peakC * 0.94) {
          cClosed = false;
          if (now - cClosedAt >= 30) blinkSeen = true;
        } else if (now - cClosedAt > 2500) { cClosed = false; peakC = c; } // stuck reading: start over
      }, 16);

      while (!stopped) {
        if (Date.now() - started > TIMEOUT_MS) return finish(reject, new Error(L.timeout));
        if (!video.videoWidth) { await wait(100); continue; }
        let faces;
        try { faces = await faceapi.detectAllFaces(video, liveDetector()).withFaceLandmarks(true); }
        catch (e) { return finish(reject, new Error(L.engine)); }
        if (stopped) return;
        if (faces.length === 0) { status.textContent = L.noFace; forget(); await wait(100); continue; }
        if (faces.length > 1) { status.textContent = L.manyFaces; forget(); await wait(100); continue; }
        const f = faces[0];
        // Face size is judged against the shorter side of the picture, so a wide laptop webcam works like a phone.
        if (f.detection.box.width < Math.min(video.videoWidth, video.videoHeight) * 0.2) { status.textContent = L.closer; forget(); await wait(100); continue; }

        boxes = eyeBoxes(f.landmarks); boxesAt = Date.now();
        const shape = eyeOpenness(f.landmarks);
        if (!closed) {
          peak = peak ? Math.max(shape, peak * 0.99) : shape;
          if (shape < peak * 0.82) { closed = true; closedAt = Date.now(); }
        } else if (shape > peak * 0.92) { closed = false; blinkSeen = true; }
        else if (Date.now() - closedAt > 2500) { closed = false; peak = shape; }

        if (!blinkSeen) { status.textContent = Date.now() - started > 8000 ? L.blinkHelp : L.blink; await wait(10); continue; }
        // A blink was seen: take the descriptor and the selfie now.
        blinkSeen = false;
        status.textContent = L.checking;
        const full = await faceapi.detectSingleFace(video, detector()).withFaceLandmarks(true).withFaceDescriptor();
        if (stopped) return;
        if (!full) { status.textContent = L.noFace; forget(); continue; }
        const scale = Math.min(1, 640 / video.videoWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(video.videoWidth * scale);
        c.height = Math.round(video.videoHeight * scale);
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        const descriptor = Array.from(full.descriptor);
        return c.toBlob((blob) => finish(resolve, { blob, descriptor }), 'image/jpeg', 0.7);
      }
    });
  }

  window.Camera = { capture, scan, descriptorOf };
})();
