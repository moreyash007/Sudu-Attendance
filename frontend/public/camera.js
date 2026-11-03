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

  const detector = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ear = (p) => (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3])); // eye aspect ratio: drops when the eye closes
  const eyeOpenness = (lm) => { const p = lm.positions; return (ear(p.slice(36, 42)) + ear(p.slice(42, 48))) / 2; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Face descriptor (128 numbers) for the largest face in a JPEG blob, or null when there is no clear face.
  async function descriptorOf(blob) {
    await loadModels();
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const found = await faceapi.detectAllFaces(img, detector()).withFaceLandmarks(true).withFaceDescriptors();
      if (found.length !== 1) return null; // none, or more than one person in the photo
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

      let stream, stopped = false;
      const finish = (fn, v) => {
        stopped = true;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (dlg.open) dlg.close();
        dlg.remove(); fn(v);
      };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(reject, new Error(L.cancelled)); });
      cancel.onclick = () => finish(reject, new Error(L.cancelled));
      dlg.showModal();

      try {
        await loadModels();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      } catch (e) {
        return finish(reject, new Error(e && e.name === 'NotAllowedError' ? L.camera : window.faceapi ? L.camera : L.engine));
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});

      const started = Date.now();
      let openLevel = 0, closed = false;
      while (!stopped) {
        if (Date.now() - started > TIMEOUT_MS) return finish(reject, new Error(L.timeout));
        if (!video.videoWidth) { await wait(100); continue; }
        let faces;
        try { faces = await faceapi.detectAllFaces(video, detector()).withFaceLandmarks(true); }
        catch (e) { return finish(reject, new Error(L.engine)); }
        if (stopped) return;
        if (faces.length === 0) { status.textContent = L.noFace; closed = false; await wait(120); continue; }
        if (faces.length > 1) { status.textContent = L.manyFaces; closed = false; await wait(120); continue; }
        const f = faces[0];
        if (f.detection.box.width < video.videoWidth * 0.25) { status.textContent = L.closer; closed = false; await wait(120); continue; }

        const open = eyeOpenness(f.landmarks);
        if (!closed) {
          openLevel = openLevel ? Math.max(open, openLevel * 0.98) : open; // slowly-fading peak = "eyes open" reference
          if (open < openLevel * 0.72) closed = true;
          else status.textContent = L.blink;
        } else if (open > openLevel * 0.88) {
          // Eyes re-opened: that was a blink. Take the descriptor and the selfie from this frame.
          closed = false;
          status.textContent = L.checking;
          const full = await faceapi.detectSingleFace(video, detector()).withFaceLandmarks(true).withFaceDescriptor();
          if (stopped) return;
          if (!full) { status.textContent = L.noFace; continue; }
          const scale = Math.min(1, 640 / video.videoWidth);
          const c = document.createElement('canvas');
          c.width = Math.round(video.videoWidth * scale);
          c.height = Math.round(video.videoHeight * scale);
          c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
          const descriptor = Array.from(full.descriptor);
          return c.toBlob((blob) => finish(resolve, { blob, descriptor }), 'image/jpeg', 0.7);
        }
        await wait(60);
      }
    });
  }

  window.Camera = { capture, scan, descriptorOf };
})();
