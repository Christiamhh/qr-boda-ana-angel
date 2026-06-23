import { upload } from 'https://esm.sh/@vercel/blob@0.27.3/client';

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
  var currentFacing = "environment";
  var stream = null, videoTrack = null, imageCapture = null;
  var torchAvailable = false, flashOn = true, busy = false, switching = false;

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
  function updatePhotoCounter(){ el.camNum.textContent=Math.max(0,photosLeft); el.shutter.disabled=photosLeft<=0||busy; }
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
    el.canvas.width=w; el.canvas.height=h; el.canvas.getContext("2d").drawImage(v,0,0,w,h); return el.canvas;
  }
  async function captureStill(){
    if(imageCapture && imageCapture.takePhoto){
      var settings=(flashOn && currentFacing==="environment")?{fillLightMode:"flash"}:undefined;
      try{ var raw=settings?await imageCapture.takePhoto(settings):await imageCapture.takePhoto(); if(raw&&raw.size) return await compressBlob(raw); }
      catch(e){ try{ var r2=await imageCapture.takePhoto(); if(r2&&r2.size) return await compressBlob(r2); }catch(_){} }
    }
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
    if(busy||photosLeft<=0) return;
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

  // ── Video (nativo) ──
  function videoDuration(file){
    return new Promise(function(resolve){
      var url=URL.createObjectURL(file); var v=document.createElement("video"); v.preload="metadata";
      v.onloadedmetadata=function(){ var d=v.duration; URL.revokeObjectURL(url); resolve(isFinite(d)?d:0); };
      v.onerror=function(){ URL.revokeObjectURL(url); resolve(-1); }; v.src=url;
    });
  }
  el.btnVideo.addEventListener("click", function(){ if(videosUsed>=LIMITS.maxVideos) return; el.inputVideo.setAttribute("capture",currentFacing); el.inputVideo.click(); });
  el.inputVideo.addEventListener("change", function(e){
    var file=(e.target.files||[])[0]; e.target.value=""; if(!file) return;
    videoDuration(file).then(function(dur){
      if(dur>LIMITS.maxVideoSeconds){ toast("Ese video dura "+Math.round(dur)+"s. El máximo es 30 segundos."); return; }
      if(videosUsed>=LIMITS.maxVideos) return;
      videosUsed++; updateVideoCounter(); toast("Subiendo tu video…");
      uploadShot(file,"video","video-"+videosUsed+".mp4");
    });
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
  function getStream(facing){
    return navigator.mediaDevices.getUserMedia({ video:{ facingMode: facing==="user"?"user":{ideal:"environment"}, width:{ideal:2560}, height:{ideal:1440} }, audio:false });
  }
  function stopStream(){ if(stream){ stream.getTracks().forEach(function(t){t.stop();}); stream=null; } }
  function toggleFlash(){ flashOn=!flashOn; el.btnTorch.classList.toggle("active",flashOn); toast(flashOn?"Flash activado":"Flash apagado"); }
  el.btnTorch.addEventListener("click", toggleFlash);
  async function flipCamera(){
    if(switching||el.camera.classList.contains("fallback")) return; switching=true; el.btnFlip.disabled=true;
    var prev=currentFacing; currentFacing=currentFacing==="user"?"environment":"user"; stopStream();
    try{ stream=await getStream(currentFacing); el.vf.srcObject=stream; await el.vf.play().catch(function(){}); setupTrack(); }
    catch(e){ currentFacing=prev; try{ stream=await getStream(currentFacing); el.vf.srcObject=stream; await el.vf.play().catch(function(){}); setupTrack(); }catch(_){} toast("No se pudo cambiar de cámara"); }
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
      stream=await getStream(currentFacing); el.vf.srcObject=stream; await el.vf.play().catch(function(){}); setupTrack();
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
    el.camera.classList.remove("open"); stopStream();
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
