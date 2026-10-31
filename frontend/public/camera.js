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

  window.Camera = { capture };
})();
