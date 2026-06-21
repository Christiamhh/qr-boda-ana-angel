(function () {
  "use strict";
  var content = document.getElementById("content");
  var statsEl = document.getElementById("stats");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var lb = document.getElementById("lightbox");
  var lbContent = document.getElementById("lb-content");

  document.getElementById("lb-close").onclick = closeLb;
  lb.onclick = function (e) { if (e.target === lb) closeLb(); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeLb(); });

  function closeLb() { lb.classList.remove("open"); lbContent.innerHTML = ""; }
  function openLb(node) { lbContent.innerHTML = ""; lbContent.appendChild(node); lb.classList.add("open"); }

  function fmtDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleString("es-HN", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function isVideo(f) { return f.kind === "video"; }

  function dlIcon() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M5 19h14"/></svg>';
  }

  function render(data) {
    var uploads = data.uploads || [];
    var photos = 0, videos = 0;
    uploads.forEach(function (u) {
      u.files.forEach(function (f) { if (isVideo(f)) videos++; else photos++; });
    });
    statsEl.innerHTML = "<b>" + uploads.length + "</b> personas · <b>" + photos + "</b> fotos · <b>" + videos + "</b> videos";

    if (!uploads.length) {
      content.innerHTML = '<div class="empty">Aún no hay recuerdos en este momento.<br>Aparecerán aquí apenas los invitados suban.</div>';
      return;
    }

    content.innerHTML = "";
    uploads.forEach(function (u) {
      var card = document.createElement("div");
      card.className = "contrib";
      var head = '<h3>' + escapeHtml(u.uploader_name || "Invitado") + "</h3>";
      if (u.message) head += '<div class="msg">“' + escapeHtml(u.message) + '”</div>';
      head += '<div class="when">' + fmtDate(u.created_at) + "</div>";
      card.innerHTML = head;

      var grid = document.createElement("div");
      grid.className = "media-grid";
      u.files.forEach(function (f) {
        var cell = document.createElement("div");
        cell.className = "media";
        if (isVideo(f)) {
          var v = document.createElement("video");
          v.src = f.url; v.muted = true; v.playsInline = true; v.preload = "metadata";
          cell.appendChild(v);
          var tag = document.createElement("div"); tag.className = "tag"; tag.textContent = "video";
          cell.appendChild(tag);
          cell.onclick = function (e) {
            if (e.target.closest(".dl")) return;
            var fv = document.createElement("video");
            fv.src = f.url; fv.controls = true; fv.autoplay = true; fv.playsInline = true;
            openLb(fv);
          };
        } else {
          var img = document.createElement("img");
          img.src = f.url; img.loading = "lazy";
          cell.appendChild(img);
          cell.onclick = function (e) {
            if (e.target.closest(".dl")) return;
            var fi = document.createElement("img"); fi.src = f.url; openLb(fi);
          };
        }
        var dl = document.createElement("a");
        dl.className = "dl"; dl.href = f.downloadUrl || f.url; dl.setAttribute("download", "");
        dl.setAttribute("aria-label", "Descargar"); dl.innerHTML = dlIcon();
        cell.appendChild(dl);
        grid.appendChild(cell);
      });
      card.appendChild(grid);
      content.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function load(momento) {
    content.innerHTML = '<div class="spinner">Cargando recuerdos…</div>';
    fetch("/api/admin/gallery?momento=" + encodeURIComponent(momento))
      .then(function (r) { if (r.status === 401) { location.href = "/galeria"; return null; } return r.json(); })
      .then(function (data) { if (data) render(data); })
      .catch(function () { content.innerHTML = '<div class="empty">No se pudieron cargar los recuerdos.</div>'; });
  }

  tabs.forEach(function (t) {
    t.onclick = function () {
      tabs.forEach(function (x) { x.classList.remove("active"); });
      t.classList.add("active");
      load(t.getAttribute("data-m"));
    };
  });

  load("ceremonia");
})();
