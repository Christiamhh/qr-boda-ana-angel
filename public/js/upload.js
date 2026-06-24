import { upload } from 'https://esm.sh/@vercel/blob@0.27.3/client';

(function () {
  "use strict";

  var MOMENTO = window.__MOMENTO__;
  var LIMITS = { maxPhotos: 15, maxVideos: 2, maxVideoSeconds: 30 };
  var PHOTO_MAX_EDGE = 3000;
  var PHOTO_QUALITY = 0.9;

  var uploadId = null;
  var photosLeft = LIMITS.maxPhotos;
  var videosUsed = 0;
  var pending = 0;
  var currentFacing = "environment";
  var stream = null, videoTrack = null, imageCapture = null, backCamId = null;
  var torchAvailable = false, flashOn = true, busy = false, switching = false;
  // Grabación de video dentro de la app (se corta sola al llegar al límite)
  var recording = false, mediaRecorder = null, recChunks = [];
  var recTimer = null, recTick = null, recStart = 0, audioStream = null;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    start: $("start-view"), denied: $("denied-view"), resume: $("resume-view"),
    resumeText: $("resume-text"), done: $("done-view"), doneText: $("done-text"),
    nombre: $("nombre"), mensaje: $("mensaje"), btnStart: $("btn-start"), btnRetry: $("btn-retry"),
    camera: $("camera"), viewfinder: $("viewfinder"), vf: $("vf"),
    flash: $("flash"), peek: $("peek"), peekImg: $("peek-img"), focusRing: $("focus-ring"),
    screenFlash: $("screen-flash"), camNum: $("cam-num"), camClose: $("cam-close"),
    btnTorch: $("btn-torch"), btnFlip: $("btn-flip"), shutter: $("shutter"),
    btnVideo: $("btn-video"), videoCount: $("video-count"), btnFinish: $("btn-finish"),
    btnResume: $("btn-resume"), inputVideo: $("input-video"), canvas: $("capture-canvas"), toast: $("toast"),
    recBadge: $("rec-badge"),
  };

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.toast.classList.remove("show"); }, 3000);
  }
  function show(view) {
    [el.start, el.denied, el.resume, el.done].forEach(function (v) { v.classList.add("hidden"); });
    view.classList.remove("hidden");
  }

  // ── Dispositivo ──
  function readCookie(n){ var m=document.cookie.match("(?:^|; )"+n+"=([^;]*)"); return m?decodeURIComponent(m[1]):""; }
  function writeCookie(n,v,d){ var e=new Date(); e.setTime(e.getTime()+d*864e5); document.cookie=n+"="+encodeURIComponent(v)+"; expires="+e.toUTCString()+"; path=/; SameSite=Lax"; }
  function deviceId(){
    var id=""; try{ id=localStorage.getItem("boda_device")||""; }catch(e){}
    if(!id) id=readCookie("boda_device");
    if(!id) id=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():"d"+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
    try{ localStorage.setItem("boda_device",id); }catch(e){} writeCookie("boda_device",id,400); return id;
  }
  var DEVICE = deviceId();

  // ── Contadores ──
  function updatePhotoCounter(){ el.camNum.textContent=Math.max(0,photosLeft); el.shutter.disabled=photosLeft<=0||busy||recording; }
  function updateVideoCounter(){ el.videoCount.textContent=videosUsed+"/"+LIMITS.maxVideos; el.btnVideo.disabled=videosUsed>=LIMITS.maxVideos; }
  function setStatusHint(){ el.camStatus = el.camStatus || $("cam-status"); if(el.camStatus) el.camStatus.textContent = pending>0?"subiendo…":""; }

  // ── Destello + vistazo ──
  function fireFlashAndPeek(url){
    el.flash.classList.remove("fire"); void el.flash.offsetWidth; el.flash.classList.add("fire");
    el.peekImg.src=url; el.peek.classList.add("show");
    return wait(1000).then(function(){ el.peek.classList.remove("show"); });
  }
  function screenFlashOn(){ el.screenFlash.classList.add("on"); }
  function screenFlashOff(){ el.screenFlash.classList.remove("on"); }

  // ── Compresión ──
  function compressBlob(blob){
    return new Promise(function(resolve){
      if(!("createImageBitmap" in window)) return resolve(blob);
      createImageBitmap(blob,{imageOrientation:"from-image"}).then(function(bmp){
        var s=Math.min(1,PHOTO_MAX_EDGE/Math.max(bmp.width,bmp.height));
        var w=Math.round(bmp.width*s),h=Math.round(bmp.height*s);
        var cv=el.canvas; cv.width=w; cv.height=h; cv.getContext("2d").drawImage(bmp,0,0,w,h); bmp.close&&bmp.close();
        cv.toBlob(function(b){ resolve(b&&b.size<blob.size?b:blob); },"image/jpeg",PHOTO_QUALITY);
      }).catch(function(){ resolve(blob); });
    });
  }
  function captureFrame(){
    var v=el.vf, cw=v.videoWidth, ch=v.videoHeight; if(!cw||!ch) return null;
    var s=Math.min(1,PHOTO_MAX_EDGE/Math.max(cw,ch)); var w=Math.round(cw*s),h=Math.round(ch*s);
    el.canvas.width=w; el.canvas.height=h;
    var ctx=el.canvas.getContext("2d");
    // En selfie espejamos para que la foto coincida con el visor
    if(currentFacing==="user"){ ctx.setTransform(-1,0,0,1,w,0); } else { ctx.setTransform(1,0,0,1,0,0); }
    ctx.drawImage(v,0,0,w,h); ctx.setTransform(1,0,0,1,0,0);
    return el.canvas;
  }
  // Capturamos SIEMPRE el fotograma del visor: la foto = lo que ves (WYSIWYG),
  // misma lente que el preview, y SIN el flash automático de takePhoto.
  async function captureStill(){
    var canvas=captureFrame(); if(!canvas) return null;
    return await new Promise(function(res){ canvas.toBlob(function(b){res(b);},"image/jpeg",PHOTO_QUALITY); });
  }

  // ── Subir a Vercel Blob ──
  function reqJSON(u,b){ return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}); }
  async function uploadShot(file,kind,filename){
    pending++; setStatusHint();
    try{
      for(var a=0;a<3;a++){
        try{
          var ct=file.type||(kind==="video"?"video/mp4":"image/jpeg");
          var blob=await upload(MOMENTO+"/"+DEVICE+"/"+kind+"-"+filename,file,{
            access:"public", handleUploadUrl:"/api/blob/upload", contentType:ct,
            clientPayload:JSON.stringify({momento:MOMENTO,deviceId:DEVICE,kind:kind}),
          });
          var conf=await reqJSON("/api/roll/confirm",{momento:MOMENTO,deviceId:DEVICE,kind:kind,url:blob.url,filename:filename,size:file.size,contentType:ct});
          if(conf.status===409){ toast(kind==="video"?"Ya usaste tus 2 videos":"Se acabó tu rollo"); return false; }
          if(!conf.ok) throw new Error("confirm");
          return true;
        }catch(e){ if(a===2){ toast(kind==="video"?"No se pudo subir el video":"No se pudo guardar una foto"); return false; } await wait(900); }
      }
    } finally{ pending--; setStatusHint(); }
  }

  // ── Disparar (sin repetir) con flash real ──
  async function shoot(){
    if(busy||photosLeft<=0||recording) return;
    busy=true; el.shutter.disabled=true;
    var usedTorch=false, usedScreen=false;
    if(flashOn){
      if(currentFacing==="environment" && videoTrack && torchAvailable){
        try{ await videoTrack.applyConstraints({advanced:[{torch:true}]}); usedTorch=true; await wait(140); }catch(e){}
      }
      if(currentFacing==="user"){ screenFlashOn(); usedScreen=true; await wait(200); }
    }
    var blob=await captureStill();
    if(usedTorch){ try{ await videoTrack.applyConstraints({advanced:[{torch:false}]}); }catch(e){} }
    if(usedScreen){ screenFlashOff(); }
    if(!blob){ busy=false; updatePhotoCounter(); toast("La cámara aún no está lista"); return; }
    photosLeft--; updatePhotoCounter();
    var url=URL.createObjectURL(blob);
    uploadShot(blob,"photo","foto-"+(LIMITS.maxPhotos-photosLeft)+".jpg");
    await fireFlashAndPeek(url); URL.revokeObjectURL(url);
    busy=false; updatePhotoCounter();
    if(photosLeft<=0) toast("¡Se acabó tu rollo de fotos! Te quedan los videos.");
  }
  el.shutter.addEventListener("click", shoot);

  // ── Video: grabación DENTRO de la app (se corta sola al llegar al límite) ──
  function recSeconds(){ return Math.max(5, (LIMITS && LIMITS.maxVideoSeconds) || 30); }
  function pickVideoMime(){
    var c=["video/mp4","video/mp4;codecs=h264,aac","video/webm;codecs=vp8,opus","video/webm;codecs=vp9,opus","video/webm"];
    if(window.MediaRecorder && MediaRecorder.isTypeSupported){
      for(var i=0;i<c.length;i++){ if(MediaRecorder.isTypeSupported(c[i])) return c[i]; }
    }
    return "";
  }
  function stopAudio(){ if(audioStream){ audioStream.getTracks().forEach(function(t){t.stop();}); audioStream=null; } }
  function showRecUI(secs){
    el.btnVideo.classList.add("rec");
    if(el.recBadge){ el.recBadge.textContent="● "+secs+"s"; el.recBadge.classList.add("show"); }
    el.videoCount.textContent=secs+"s";
    el.btnFlip.disabled=true; el.btnTorch.disabled=true;
    updatePhotoCounter();
  }
  function tickRecUI(secs){ if(el.recBadge) el.recBadge.textContent="● "+secs+"s"; el.videoCount.textContent=secs+"s"; }
  function clearRecUI(){
    el.btnVideo.classList.remove("rec");
    if(el.recBadge) el.recBadge.classList.remove("show");
    el.btnFlip.disabled=false; el.btnTorch.disabled=false;
    updateVideoCounter(); updatePhotoCounter();
  }
  async function startVideoRecording(){
    if(recording||busy||videosUsed>=LIMITS.maxVideos) return;
    var vt=(stream&&stream.getVideoTracks)?stream.getVideoTracks()[0]:null;
    if(!vt){ toast("La cámara no está lista"); return; }
    var tracks=[vt];
    try{ audioStream=await navigator.mediaDevices.getUserMedia({audio:true}); var at=audioStream.getAudioTracks()[0]; if(at) tracks.push(at); }
    catch(e){ toast("Sin micrófono: el video irá sin sonido"); }
    var mime=pickVideoMime();
    try{ mediaRecorder = mime ? new MediaRecorder(new MediaStream(tracks),{mimeType:mime}) : new MediaRecorder(new MediaStream(tracks)); }
    catch(e){ stopAudio(); toast("No se pudo iniciar la grabación"); return; }
    recChunks=[];
    mediaRecorder.ondataavailable=function(ev){ if(ev.data&&ev.data.size) recChunks.push(ev.data); };
    mediaRecorder.onstop=finishVideoRecording;
    recording=true; recStart=Date.now();
    try{ mediaRecorder.start(); }catch(e){ recording=false; stopAudio(); toast("No se pudo iniciar la grabación"); return; }
    var max=recSeconds(); showRecUI(max);
    recTick=setInterval(function(){ var left=Math.ceil(max-(Date.now()-recStart)/1000); tickRecUI(Math.max(0,left)); },250);
    recTimer=setTimeout(stopVideoRecording, max*1000);
    toast("Grabando… (máx "+max+"s) · tocá de nuevo para terminar");
  }
  function stopVideoRecording(){
    if(!recording) return; recording=false;
    clearTimeout(recTimer); clearInterval(recTick); recTimer=null; recTick=null;
    try{ if(mediaRecorder && mediaRecorder.state!=="inactive") mediaRecorder.stop(); }catch(e){}
    clearRecUI();
  }
  function finishVideoRecording(){
    stopAudio();
    var type=(mediaRecorder&&mediaRecorder.mimeType)||"video/webm";
    var blob=new Blob(recChunks,{type:type}); recChunks=[];
    if(!blob.size){ toast("No se grabó el video"); return; }
    if(videosUsed>=LIMITS.maxVideos){ toast("Ya usaste tus "+LIMITS.maxVideos+" videos"); return; }
    videosUsed++; updateVideoCounter();
    var ext=(type.indexOf("mp4")>-1)?"mp4":"webm";
    toast("Subiendo tu video…");
    uploadShot(blob,"video","video-"+videosUsed+"."+ext);
  }

  // ── Respaldo: cámara nativa (solo si el navegador no soporta MediaRecorder) ──
  function videoDuration(file){
    return new Promise(function(resolve){
      var url=URL.createObjectURL(file); var v=document.createElement("video"); v.preload="metadata";
      v.onloadedmetadata=function(){ var d=v.duration; URL.revokeObjectURL(url); resolve(isFinite(d)?d:0); };
      v.onerror=function(){ URL.revokeObjectURL(url); resolve(-1); }; v.src=url;
    });
  }
  function startNativeVideo(){ if(videosUsed>=LIMITS.maxVideos) return; el.inputVideo.setAttribute("capture",currentFacing); el.inputVideo.click(); }
  el.inputVideo.addEventListener("change", function(e){
    var file=(e.target.files||[])[0]; e.target.value=""; if(!file) return;
    videoDuration(file).then(function(dur){
      if(dur>LIMITS.maxVideoSeconds){ toast("Ese video dura "+Math.round(dur)+"s. El máximo es "+LIMITS.maxVideoSeconds+" segundos."); return; }
      if(videosUsed>=LIMITS.maxVideos) return;
      videosUsed++; updateVideoCounter(); toast("Subiendo tu video…");
      uploadShot(file,"video","video-"+videosUsed+".mp4");
    });
  });

  el.btnVideo.addEventListener("click", function(){
    if(recording){ stopVideoRecording(); return; }
    if(videosUsed>=LIMITS.maxVideos){ toast("Ya usaste tus "+LIMITS.maxVideos+" videos"); return; }
    if(window.MediaRecorder){ startVideoRecording(); } else { startNativeVideo(); }
  });

  // ── Cámara: pista, flash, flip, foco ──
  function safeImageCapture(t){ try{ return ("ImageCapture" in window)?new ImageCapture(t):null; }catch(e){ return null; } }
  function setupTrack(){
    videoTrack=stream.getVideoTracks()[0]||null;
    imageCapture=videoTrack?safeImageCapture(videoTrack):null;
    var caps=(videoTrack&&videoTrack.getCapabilities)?videoTrack.getCapabilities():{};
    torchAvailable=!!caps.torch;
    el.btnTorch.classList.toggle("active",flashOn);
    el.vf.classList.toggle("mirror",currentFacing==="user");
  }
  // Elegimos la cámara trasera NORMAL (no gran angular / tele / macro / profundidad)
  function isOddLens(label){ return /(ultra|wide|angular|tele|zoom|macro|depth|monochrome|bokeh|profundidad)/i.test(label||""); }
  async function pickBackCamera(){
    try{
      var devs=await navigator.mediaDevices.enumerateDevices();
      var cams=devs.filter(function(d){ return d.kind==="videoinput"; });
      var back=cams.filter(function(d){ return /(back|rear|tras|environment)/i.test(d.label); });
      if(!back.length) back=cams;
      var normal=back.filter(function(d){ return !isOddLens(d.label); });
      var chosen=normal[0]||back[0];
      backCamId=chosen?chosen.deviceId:null;
    }catch(e){ backCamId=null; }
  }
  function getStreamById(id){
    return navigator.mediaDevices.getUserMedia({ video:{ deviceId:{exact:id}, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
  }
  function getStreamFacing(facing){
    if(facing==="environment" && backCamId) return getStreamById(backCamId);
    return navigator.mediaDevices.getUserMedia({ video:{ facingMode: facing==="user"?"user":{ideal:"environment"}, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
  }
  function stopStream(){ if(stream){ stream.getTracks().forEach(function(t){t.stop();}); stream=null; } }
  function toggleFlash(){ flashOn=!flashOn; el.btnTorch.classList.toggle("active",flashOn); toast(flashOn?"Flash activado":"Flash apagado"); }
  el.btnTorch.addEventListener("click", toggleFlash);
  async function flipCamera(){
    if(switching||el.camera.classList.contains("fallback")) return; switching=true; el.btnFlip.disabled=true;
    var prev=currentFacing; currentFacing=currentFacing==="user"?"environment":"user"; stopStream();
    try{ stream=await getStreamFacing(currentFacing); el.vf.srcObject=stream; await el.vf.play().catch(function(){}); setupTrack(); }
    catch(e){ currentFacing=prev; try{ stream=await getStreamFacing(currentFacing); el.vf.srcObject=stream; await el.vf.play().catch(function(){}); setupTrack(); }catch(_){} toast("No se pudo cambiar de cámara"); }
    switching=false; el.btnFlip.disabled=false;
  }
  el.btnFlip.addEventListener("click", flipCamera);
  // Tocar para enfocar (anillo visual + mejor esfuerzo)
  el.viewfinder.addEventListener("pointerup", function(e){
    if(el.peek.classList.contains("show")) return;
    var r=el.viewfinder.getBoundingClientRect(); var x=e.clientX-r.left, y=e.clientY-r.top;
    el.focusRing.style.left=x+"px"; el.focusRing.style.top=y+"px";
    el.focusRing.classList.remove("show"); void el.focusRing.offsetWidth; el.focusRing.classList.add("show");
    if(videoTrack){ videoTrack.applyConstraints({advanced:[{focusMode:"single-shot",pointsOfInterest:[{x:Math.max(0,Math.min(1,x/r.width)),y:Math.max(0,Math.min(1,y/r.height))}]}]}).catch(function(){}); }
  });

  async function openCamera(){
    el.camera.classList.add("open"); currentFacing="environment"; updatePhotoCounter(); updateVideoCounter();
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ el.camera.classList.remove("open"); show(el.denied); return; }
    try{
      stream=await getStreamFacing("environment");          // 1) permiso + stream inicial
      if(!backCamId){ await pickBackCamera(); }             // 2) con permiso ya conocemos las lentes
      if(backCamId){                                        // 3) reabrir con la cámara normal si hace falta
        var t0=stream.getVideoTracks()[0];
        var cur=(t0&&t0.getSettings)?t0.getSettings():{};
        if(cur.deviceId && cur.deviceId!==backCamId){
          try{ var s2=await getStreamById(backCamId); stream.getTracks().forEach(function(t){t.stop();}); stream=s2; }catch(e){}
        }
      }
      el.vf.srcObject=stream; await el.vf.play().catch(function(){}); setupTrack();
    }catch(err){ el.camera.classList.remove("open"); show(el.denied); }
  }

  // ── Salir / reanudar / terminar ──
  function showResume(){
    var pl=Math.max(0,photosLeft), vl=Math.max(0,LIMITS.maxVideos-videosUsed);
    el.resumeText.innerHTML="Todavía te quedan <b>"+pl+" foto"+(pl===1?"":"s")+" y "+vl+" video"+(vl===1?"":"s")+"</b>. Salí y volvé cuando quieras — se guardan solos.";
    show(el.resume);
  }
  async function showDone(){
    var photos=LIMITS.maxPhotos-photosLeft;
    el.doneText.innerHTML="Usaste todo tu rollo ("+photos+" foto"+(photos===1?"":"s")+(videosUsed?" y "+videosUsed+" video"+(videosUsed===1?"":"s"):"")+"). ¡Gracias de corazón! 💛";
    show(el.done);
    for(var i=0;i<40&&pending>0;i++) await wait(300);
    reqJSON("/api/roll/finish",{momento:MOMENTO,deviceId:DEVICE}).catch(function(){});
  }
  function exitCamera(){
    if(recording) stopVideoRecording();
    el.camera.classList.remove("open"); stopStream(); stopAudio();
    var pl=photosLeft, vl=LIMITS.maxVideos-videosUsed;
    if(pl<=0&&vl<=0) showDone(); else showResume();
  }
  el.camClose.addEventListener("click", exitCamera);
  el.btnFinish.addEventListener("click", exitCamera);
  el.btnResume.addEventListener("click", function(){ openCamera(); });

  // ── Iniciar rollo ──
  el.nombre.addEventListener("input", function(){ el.btnStart.disabled=el.nombre.value.trim().length===0; });
  async function startRoll(){
    var name=el.nombre.value.trim(); if(!name){ toast("Escribe tu nombre, por favor"); return; }
    el.btnStart.disabled=true; el.btnStart.textContent="Abriendo…";
    try{
      var r=await reqJSON("/api/roll/start",{momento:MOMENTO,deviceId:DEVICE,name:name,message:el.mensaje.value.trim()});
      if(!r.ok) throw new Error("start");
      var data=await r.json(); uploadId=data.uploadId;
      if(data.limits){ LIMITS=data.limits; photosLeft=LIMITS.maxPhotos; }
      await openCamera();
    }catch(e){ toast("No se pudo iniciar. Intentá de nuevo."); el.btnStart.disabled=false; el.btnStart.textContent="Abrir mi cámara"; }
  }
  el.btnStart.addEventListener("click", startRoll);
  el.btnRetry.addEventListener("click", function(){ show(el.start); openCamera(); });

  // ── Estado inicial / reanudación ──
  async function routeFromStatus(){
    try{
      var s=await fetch("/api/status?deviceId="+encodeURIComponent(DEVICE)+"&momento="+encodeURIComponent(MOMENTO)).then(function(r){return r.json();});
      if(s&&s.limits) LIMITS=s.limits;
      if(s&&s.state==="in_progress"){ uploadId=s.uploadId; photosLeft=LIMITS.maxPhotos-s.photosUsed; videosUsed=s.videosUsed; showResume(); }
      else if(s&&s.state==="done"){ photosLeft=0; videosUsed=(s.videosUsed!=null)?s.videosUsed:LIMITS.maxVideos; show(el.done); el.doneText.innerHTML="Ya usaste todo tu rollo. ¡Gracias por ser parte de este día! 💛"; }
      else { photosLeft=LIMITS.maxPhotos; show(el.start); }
    }catch(e){ show(el.start); }
  }
  routeFromStatus();
})();
