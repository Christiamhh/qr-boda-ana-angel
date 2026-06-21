(function () {
  "use strict";

  var MOMENTO = window.__MOMENTO__;
  var LIMITS = { maxPhotos: 15, maxVideos: 2, maxVideoSeconds: 31 };
  var PHOTO_MAX_EDGE = 3000;
  var PHOTO_QUALITY = 0.9;

  var uploadId = null;
  var photosLeft = LIMITS.maxPhotos;
  var videosUsed = 0;
  var pending = 0;
  var facing = "environment";

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    start: $("start-view"),
    rollo: $("rollo-view"),
    resume: $("resume-view"),
    resumeText: $("resume-text"),
    done: $("done-view"),
    doneText: $("done-text"),
    nombre: $("nombre"),
    mensaje: $("mensaje"),
    btnStart: $("btn-start"),
    camNum: $("cam-num"),
    videoLine: $("video-line"),
    btnPhoto: $("btn-photo"),
    btnFacing: $("btn-facing"),
    btnVideo: $("btn-video"),
    videoCount: $("video-count"),
    btnFinish: $("btn-finish"),
    btnResume: $("btn-resume"),
    inputPhoto: $("input-photo"),
    inputVideo: $("input-video"),
    canvas: $("capture-canvas"),
    flash: $("flash"),
    peek: $("peek"),
    peekImg: $("peek-img"),
    toast: $("toast"),
  };

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove("show"); }, 3000);
  }

  function show(view) {
    [el.start, el.rollo, el.resume, el.done].forEach(function (v) { v.classList.add("hidden"); });
    view.classList.remove("hidden");
  }

  // ── Dispositivo ────────────────────────────────────────
  function readCookie(name) {
    var m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : "";
  }
  function writeCookie(name, val, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = name + "=" + encodeURIComponent(val) + "; expires=" + d.toUTCString() + "; path=/; SameSite=Lax";
  }
  function deviceId() {
    var id = "";
    try { id = localStorage.getItem("boda_device") || ""; } catch (e) {}
    if (!id) id = readCookie("boda_device");
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    try { localStorage.setItem("boda_device", id); } catch (e) {}
    writeCookie("boda_device", id, 400);
    return id;
  }
  var DEVICE = deviceId();

  // ── Contadores ─────────────────────────────────────────
  function updateCounters() {
    el.camNum.textContent = Math.max(0, photosLeft);
    var vl = Math.max(0, LIMITS.maxVideos - videosUsed);
    el.videoLine.textContent = vl > 0
      ? (vl + " video" + (vl === 1 ? "" : "s") + " disponible" + (vl === 1 ? "" : "s"))
      : "sin videos disponibles";
    el.videoCount.textContent = videosUsed + "/" + LIMITS.maxVideos;
    el.btnPhoto.disabled = photosLeft <= 0;
    el.btnVideo.disabled = videosUsed >= LIMITS.maxVideos;
  }

  // ── Destello + vistazo ─────────────────────────────────
  function peekShow(url) {
    el.flash.classList.remove("fire");
    void el.flash.offsetWidth;
    el.flash.classList.add("fire");
    el.peekImg.src = url;
    el.peek.classList.add("show");
    return wait(1100).then(function () { el.peek.classList.remove("show"); });
  }

  // ── Compresión (respeta orientación) ───────────────────
  function compressImageBlob(blob, maxEdge, q) {
    return new Promise(function (resolve) {
      if (!("createImageBitmap" in window)) return resolve(blob);
      createImageBitmap(blob, { imageOrientation: "from-image" }).then(function (bmp) {
        var scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
        var w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
        var cv = el.canvas;
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
        bmp.close && bmp.close();
        cv.toBlob(function (b) { resolve(b && b.size < blob.size ? b : blob); }, "image/jpeg", q);
      }).catch(function () { resolve(blob); });
    });
  }

  function videoDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = function () { var d = v.duration; URL.revokeObjectURL(url); resolve(isFinite(d) ? d : 0); };
      v.onerror = function () { URL.revokeObjectURL(url); resolve(-1); };
      v.src = url;
    });
  }

  // ── Subir un disparo ───────────────────────────────────
  function reqJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  function setStatusHint() {
    el.btnFinish.textContent = pending > 0 ? "Subiendo… (no cierres)" : "Listo por ahora";
  }
  async function uploadShot(blob, kind, filename) {
    pending++; setStatusHint();
    try {
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          var ct = blob.type || (kind === "video" ? "video/mp4" : "image/jpeg");
          var pres = await reqJSON("/api/roll/presign", {
            uploadId: uploadId, deviceId: DEVICE, momento: MOMENTO,
            kind: kind, filename: filename, contentType: ct, size: blob.size,
          });
          if (pres.status === 409) { toast(kind === "video" ? "Ya usaste tus 2 videos" : "Se acabó tu rollo"); return false; }
          if (!pres.ok) throw new Error("presign");
          var data = await pres.json();
          var put = await fetch(data.url, { method: "PUT", headers: { "Content-Type": ct }, body: blob });
          if (!put.ok) throw new Error("put " + put.status);
          var conf = await reqJSON("/api/roll/confirm", {
            uploadId: uploadId, deviceId: DEVICE, momento: MOMENTO,
            key: data.key, kind: kind, filename: filename, size: blob.size, contentType: ct,
          });
          if (!conf.ok) throw new Error("confirm");
          return true;
        } catch (e) {
          if (attempt === 2) { toast(kind === "video" ? "No se pudo subir el video" : "No se pudo guardar una foto"); return false; }
          await wait(900);
        }
      }
    } finally { pending--; setStatusHint(); }
  }

  // ── Tomar foto (cámara nativa: flash real + modo noche) ─
  el.btnPhoto.addEventListener("click", function () {
    if (photosLeft <= 0) { toast("Se acabó tu rollo de fotos"); return; }
    el.inputPhoto.setAttribute("capture", facing);
    el.inputPhoto.click();
  });
  el.inputPhoto.addEventListener("change", function (e) {
    var file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return; // canceló: no gasta el cupo
    if (photosLeft <= 0) { toast("Se acabó tu rollo de fotos"); return; }
    photosLeft--;
    updateCounters();
    var url = URL.createObjectURL(file);
    peekShow(url).then(function () { URL.revokeObjectURL(url); });
    compressImageBlob(file, PHOTO_MAX_EDGE, PHOTO_QUALITY).then(function (blob) {
      uploadShot(blob || file, "photo", "foto-" + (LIMITS.maxPhotos - photosLeft) + ".jpg");
    });
    if (photosLeft <= 0) toast("¡Se acabó tu rollo de fotos! Te quedan los videos.");
  });

  // ── Cambiar cámara (trasera / selfie) ──────────────────
  el.btnFacing.addEventListener("click", function () {
    facing = facing === "environment" ? "user" : "environment";
    el.btnFacing.textContent = "Cámara: " + (facing === "user" ? "frontal (selfie)" : "trasera");
  });

  // ── Grabar video ───────────────────────────────────────
  el.btnVideo.addEventListener("click", function () {
    if (videosUsed >= LIMITS.maxVideos) return;
    el.inputVideo.setAttribute("capture", facing);
    el.inputVideo.click();
  });
  el.inputVideo.addEventListener("change", function (e) {
    var file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    videoDuration(file).then(function (dur) {
      if (dur > LIMITS.maxVideoSeconds) { toast("Ese video dura " + Math.round(dur) + "s. El máximo es 30 segundos."); return; }
      if (videosUsed >= LIMITS.maxVideos) return;
      videosUsed++; updateCounters();
      toast("Video guardado 💛");
      uploadShot(file, "video", file.name || ("video-" + videosUsed + ".mp4"));
    });
  });

  // ── Salir / reanudar / terminar ────────────────────────
  function showResume() {
    var pl = Math.max(0, photosLeft), vl = Math.max(0, LIMITS.maxVideos - videosUsed);
    el.resumeText.innerHTML = "Todavía te quedan <b>" + pl + " foto" + (pl === 1 ? "" : "s") +
      " y " + vl + " video" + (vl === 1 ? "" : "s") + "</b>. Salí y volvé cuando quieras — se guardan solos.";
    show(el.resume);
  }
  async function showDone() {
    var photos = LIMITS.maxPhotos - photosLeft;
    el.doneText.innerHTML = "Usaste todo tu rollo (" + photos + " foto" + (photos === 1 ? "" : "s") +
      (videosUsed ? " y " + videosUsed + " video" + (videosUsed === 1 ? "" : "s") : "") +
      "). ¡Gracias de corazón! 💛";
    show(el.done);
    for (var i = 0; i < 30 && pending > 0; i++) await wait(300);
    reqJSON("/api/roll/finish", { uploadId: uploadId, deviceId: DEVICE, momento: MOMENTO }).catch(function () {});
  }
  function exitRoll() {
    var pl = photosLeft, vl = LIMITS.maxVideos - videosUsed;
    if (pl <= 0 && vl <= 0) showDone();
    else showResume();
  }
  el.btnFinish.addEventListener("click", exitRoll);
  el.btnResume.addEventListener("click", function () { show(el.rollo); updateCounters(); });

  // ── Iniciar rollo ──────────────────────────────────────
  el.nombre.addEventListener("input", function () {
    el.btnStart.disabled = el.nombre.value.trim().length === 0;
  });
  async function startRoll() {
    var name = el.nombre.value.trim();
    if (!name) { toast("Escribe tu nombre, por favor"); return; }
    el.btnStart.disabled = true;
    el.btnStart.textContent = "Abriendo…";
    try {
      var r = await reqJSON("/api/roll/start", {
        momento: MOMENTO, deviceId: DEVICE, name: name, message: el.mensaje.value.trim(),
      });
      if (r.status === 409) { await routeFromStatus(); return; }
      if (!r.ok) throw new Error("start");
      var data = await r.json();
      uploadId = data.uploadId;
      if (data.limits) { LIMITS = data.limits; photosLeft = LIMITS.maxPhotos; }
      show(el.rollo); updateCounters();
    } catch (e) {
      toast("No se pudo iniciar. Intentá de nuevo.");
      el.btnStart.disabled = false;
      el.btnStart.textContent = "Comenzar mi rollo";
    }
  }
  el.btnStart.addEventListener("click", startRoll);

  // ── Estado inicial / reanudación ───────────────────────
  async function routeFromStatus() {
    try {
      var s = await fetch("/api/status?deviceId=" + encodeURIComponent(DEVICE) + "&momento=" + encodeURIComponent(MOMENTO))
        .then(function (r) { return r.json(); });
      if (s && s.limits) LIMITS = s.limits;
      if (s && s.state === "in_progress") {
        uploadId = s.uploadId;
        photosLeft = LIMITS.maxPhotos - s.photosUsed;
        videosUsed = s.videosUsed;
        show(el.rollo); updateCounters();
      } else if (s && s.state === "done") {
        photosLeft = LIMITS.maxPhotos - (s.photosUsed || LIMITS.maxPhotos);
        videosUsed = (s.videosUsed != null) ? s.videosUsed : LIMITS.maxVideos;
        show(el.done);
        el.doneText.innerHTML = "Ya usaste todo tu rollo. ¡Gracias por ser parte de este día! 💛";
      } else {
        photosLeft = LIMITS.maxPhotos;
        show(el.start);
      }
    } catch (e) { show(el.start); }
  }
  routeFromStatus();
})();
