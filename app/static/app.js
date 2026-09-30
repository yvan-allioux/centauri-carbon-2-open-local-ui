const MACHINE_STATUS = {
  0: "Initializing",
  1: "Idle",
  2: "Printing",
  3: "Loading",
  4: "Unloading",
  5: "Auto-leveling",
  6: "PID calibration",
  7: "Resonance test",
  8: "Self-test",
  9: "Updating",
  10: "Manual homing",
  11: "File transfer",
  12: "Timelapse",
  13: "Extruding",
  14: "Emergency stop",
  15: "Power-loss recovery",
};

const PRINT_STATE = {
  standby: "Standby",
  printing: "Printing",
  paused: "Paused",
  complete: "Complete",
  cancelled: "Cancelled",
  error: "Error",
};

const EXCEPTION_STATUS = {
  101: "Bed heating failed",
  102: "Bed sensor disconnected",
  103: "Nozzle heating failed",
  104: "Nozzle sensor disconnected",
  105: "Nozzle sensor short circuit",
  106: "Bed sensor short circuit",
  107: "Toolhead overheating",
  108: "Bed overheating",
  205: "Chamber sensor disconnected",
  206: "Chamber sensor short circuit",
  304: "Z homing failed",
  401: "Accelerometer error",
  605: "Pressure sensor error",
  701: "Mainboard fan error",
  702: "Heatbreak fan error",
  703: "Model fan error",
  704: "Leveling failed",
  705: "Auxiliary fan error",
  706: "Case fan error",
  707: "Front cover open",
  801: "Mainboard-extruder communication error",
  802: "Leveling sensor communication error",
  803: "Critical system error",
  901: "Chamber too hot",
  902: "Chamber overheating",
  903: "Driver overheating",
  904: "USB drive full",
  905: "USB read error",
  906: "Update failed",
  1101: "Exhaust vent open failed",
  1102: "Exhaust vent close failed",
  1210: "Canvas communication error",
  1211: "Canvas filament runout",
  1220: "Extruder error",
  1231: "Filament cut failed",
  1232: "Cutter handle not released",
  1241: "Loading error",
  1242: "Toolhead unload failed",
  1251: "Toolhead extrusion failed",
  1261: "Front cover detached",
};

const $ = (id) => document.getElementById(id);

let latestFiles = {};
let latestTrays = [];
let latestActiveTray = null;
let printTargetFile = "";
let statPeriod = "today";
const tempSeries = [];
const TEMP_MAX_POINTS = 150;

function toast(message, kind = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast " + kind;
  if (message) setTimeout(() => { if (el.textContent === message) el.textContent = ""; }, 4000);
}

async function send(method, params = {}) {
  const resp = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function pwmToPct(speed) {
  if (speed == null) return "—";
  return `${Math.round((speed / 255) * 100)} %`;
}

function fmtTemp(obj) {
  if (!obj) return "—";
  const cur = obj.temperature != null ? Math.round(obj.temperature) : "?";
  const tgt = obj.target != null ? Math.round(obj.target) : "?";
  return `${cur} / ${tgt} °C`;
}

function fmtDuration(sec) {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
}

function fmtDate(sec) {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  return d.toLocaleString("en-US", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtBytes(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function colorDots(map) {
  if (!Array.isArray(map) || !map.length) return "";
  return map
    .map((c) => `<span class="dot" style="background:${c.color || "#888"}" title="${c.name || ""} ${c.color || ""}"></span>`)
    .join("");
}

function render(data) {
  const badge = $("conn");
  const ok = data.connected && data.registered;
  badge.textContent = ok ? "connected" : data.connected ? "connecting…" : "disconnected";
  badge.className = "badge " + (ok ? "online" : "offline");

  const wrap = document.querySelector(".camera-wrap");
  wrap.classList.toggle("down", !data.camera);

  const s = data.state || {};
  const ms = s.machine_status || {};
  const ps = s.print_status || {};
  const fans = s.fans || {};
  const move = s.gcode_move || s.gcode_move_inf || {};

  $("st-machine").textContent = MACHINE_STATUS[ms.status] || (ms.status != null ? `Code ${ms.status}` : "—");
  $("st-print-state").textContent = PRINT_STATE[ps.state] || (ps.state || "—");

  let file = ps.filename || "—";
  if (ps.current_layer != null && ps.total_layer) file += `  (layer ${ps.current_layer}/${ps.total_layer})`;
  $("st-file").textContent = file;

  const progress = ms.progress != null ? ms.progress : 0;
  $("st-progress").textContent =
    ms.progress != null
      ? `${progress} %  ·  ${fmtDuration(ps.remaining_time_sec)} left`
      : "—";
  $("progress-bar").style.width = `${progress}%`;

  $("st-ext").textContent = fmtTemp(s.extruder);
  $("st-bed").textContent = fmtTemp(s.heater_bed);
  $("st-chamber").textContent = s.ztemperature_sensor
    ? `${Math.round(s.ztemperature_sensor.temperature)} °C`
    : "—";

  const pos = [move.x, move.y, move.z].map((v) => (v == null ? "—" : Number(v).toFixed(1)));
  $("st-pos").textContent = `${pos[0]} / ${pos[1]} / ${pos[2]}`;
  $("st-speed").textContent = move.speed != null ? `${move.speed} mm/min` : "—";

  const fan = fans.fan && fans.fan.speed;
  const aux = fans.aux_fan && fans.aux_fan.speed;
  const box = fans.box_fan && fans.box_fan.speed;
  const ctrl = fans.controller_fan && fans.controller_fan.speed;
  const hot = fans.heater_fan && fans.heater_fan.speed;
  $("st-fan").textContent = pwmToPct(fan);
  $("st-fan2").textContent = `${pwmToPct(aux)} / ${pwmToPct(box)}`;
  $("st-fan3").textContent = `${pwmToPct(ctrl)} / ${pwmToPct(hot)}`;

  const ext = s.extruder || {};
  if (ext.filament_detect_enable) {
    $("st-filament").textContent = ext.filament_detected ? "present" : "runout";
  } else {
    $("st-filament").textContent = "sensor off";
  }

  $("st-mesh").textContent = ps.bed_mesh_detect ? "OK" : "missing";

  const errs = ms.exception_status || [];
  $("st-error").textContent = errs.length
    ? errs.map((e) => EXCEPTION_STATUS[e] || `Code ${e}`).join(", ")
    : "—";

  pushTemp(s);
  drawTempChart();
}

function pushTemp(s) {
  tempSeries.push({
    ext: s.extruder ? s.extruder.temperature : null,
    bed: s.heater_bed ? s.heater_bed.temperature : null,
    chamber: s.ztemperature_sensor ? s.ztemperature_sensor.temperature : null,
  });
  if (tempSeries.length > TEMP_MAX_POINTS) tempSeries.shift();
}

function drawTempChart() {
  const canvas = $("temp-chart");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.getBoundingClientRect().width;
  const h = 160;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 32, r: 8, t: 8, b: 16 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  let maxV = 50;
  tempSeries.forEach((p) => {
    maxV = Math.max(maxV, p.ext || 0, p.bed || 0, p.chamber || 0);
  });
  maxV = Math.ceil((maxV + 10) / 50) * 50;

  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.fillStyle = "rgba(255,255,255,.4)";
  ctx.font = "10px system-ui, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch * (i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + cw, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(maxV * (1 - i / 4))), 4, y + 3);
  }

  if (tempSeries.length < 2) return;
  const n = tempSeries.length;
  const xAt = (i) => pad.l + cw * (i / (n - 1));
  const yAt = (v) => pad.t + ch * (1 - Math.min(1, (v || 0) / maxV));
  const line = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    tempSeries.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p[key]);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  line("ext", "#e5484d");
  line("bed", "#4f8cff");
  line("chamber", "#3dd68c");
}

function renderStats(data) {
  $("stat-prints").textContent = `${data.prints} ${data.prints === 1 ? "print" : "prints"}`;
  $("stat-time").textContent = fmtDuration(data.print_time_sec);
  $("stat-filament").textContent = `${data.filament_g} g`;
  const series = data.series || [];
  const maxFil = Math.max(1, ...series.map((s) => s.filament_g));
  $("stat-series").innerHTML = series
    .map((s) => {
      const pct = Math.round((s.filament_g / maxFil) * 100);
      const d = new Date(`${s.date}T00:00:00`);
      const lbl = d.toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "2-digit" });
      return `
        <div class="series-row">
          <span class="muted">${lbl}</span>
          <div class="series-bar"><div style="width:${pct}%"></div></div>
          <span>${s.filament_g.toFixed(1)} g · ${fmtDuration(s.print_time_sec)}</span>
        </div>`;
    })
    .join("");
}

async function loadStats(silent = true) {
  try {
    const tz = new Date().getTimezoneOffset();
    const resp = await fetch(`/api/stats?period=${statPeriod}&tz=${tz}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    renderStats(data);
  } catch (e) {
    if (!silent) toast(e.message, "error");
  }
}

function setStatPeriod(period) {
  statPeriod = period;
  $("stat-today").classList.toggle("active", period === "today");
  $("stat-week").classList.toggle("active", period === "week");
  loadStats(false);
}

$("stat-today").addEventListener("click", () => setStatPeriod("today"));
$("stat-week").addEventListener("click", () => setStatPeriod("week"));
window.addEventListener("resize", drawTempChart);

async function refresh() {
  try {
    const resp = await fetch("/api/status");
    render(await resp.json());
  } catch (e) {
    render({ connected: false, registered: false, camera: false, state: {} });
  }
}

async function run(label, fn) {
  try {
    await fn();
    toast(label + " sent", "ok");
    setTimeout(refresh, 500);
  } catch (e) {
    toast(e.message, "error");
  }
}

document.querySelectorAll("[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
    const method = Number(btn.dataset.cmd);
    run(btn.textContent.trim(), () => send(method, {}));
  });
});

document.querySelectorAll("[data-light]").forEach((btn) => {
  btn.addEventListener("click", () => {
    run("Light", () => send(1029, { power: Number(btn.dataset.light) }));
  });
});

$("apply-temps").addEventListener("click", () => {
  const params = {};
  const ext = Number($("temp-ext").value);
  const bed = Number($("temp-bed").value);
  if (!Number.isNaN(ext)) params.extruder = ext;
  if (!Number.isNaN(bed)) params.heater_bed = bed;
  run("Temperatures", () => send(1028, params));
});

document.querySelectorAll(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const ext = Number(btn.dataset.ext);
    const bed = Number(btn.dataset.bed);
    $("temp-ext").value = ext;
    $("temp-bed").value = bed;
    const params = {};
    if (ext > 0) params.extruder = ext;
    else params.extruder = 0;
    params.heater_bed = bed;
    run("Preset", () => send(1028, params));
  });
});

$("fan").addEventListener("input", (e) => { $("fan-val").textContent = e.target.value; });
$("apply-fan").addEventListener("click", () => {
  run("Fan", () => send(1030, { fan: Number($("fan").value) }));
});

$("home").addEventListener("click", () => {
  run("Home", () => send(1026, { homed_axes: "xyz" }));
});

$("move").addEventListener("click", () => {
  run("Move", () =>
    send(1027, { axes: $("move-axis").value, distance: Number($("move-dist").value) })
  );
});

$("apply-speed").addEventListener("click", () => {
  run("Speed", () => send(1031, { mode: Number($("speed-mode").value) }));
});

const thumbQueue = [];
let thumbActive = 0;

function pumpThumbs() {
  while (thumbActive < 2 && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive++;
    const done = () => { thumbActive--; pumpThumbs(); };
    job.img.onload = done;
    job.img.onerror = () => { job.img.classList.add("empty"); done(); };
    job.img.src = "/api/files/thumbnail?name=" + encodeURIComponent(job.name);
  }
}

const thumbObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      thumbObserver.unobserve(entry.target);
      const name = entry.target.dataset.name;
      if (name) { thumbQueue.push({ img: entry.target, name }); pumpThumbs(); }
    }
  });
}, { rootMargin: "200px" });

function renderFiles(data) {
  const list = $("files-list");
  const files = data.files || [];
  latestFiles = {};
  files.forEach((f) => { latestFiles[f.filename] = f; });
  if (!files.length) {
    list.innerHTML = '<p class="muted">No files in internal storage.</p>';
    return;
  }
  list.innerHTML = files
    .map((f) => {
      const sub = [
        f.layer != null ? `${f.layer} layers` : null,
        f.print_time ? fmtDuration(f.print_time) : null,
        f.size ? fmtBytes(f.size) : null,
        f.total_filament_used ? `${f.total_filament_used} g` : null,
      ].filter(Boolean).join(" · ");
      return `
        <div class="file-item">
          <img class="thumb" data-name="${f.filename.replace(/"/g, "&quot;")}" alt="">
          <div class="file-meta">
            <div class="file-name" title="${f.filename}">${f.filename}</div>
            <div class="file-sub muted">${sub || "—"}</div>
            <div class="file-colors">${colorDots(f.color_map)}</div>
          </div>
          <div class="file-actions">
            <button class="btn small" data-start="${f.filename.replace(/"/g, "&quot;")}">Print</button>
            <button class="btn small danger" data-delete="${f.filename.replace(/"/g, "&quot;")}">Delete</button>
          </div>
        </div>`;
    })
    .join("");
  list.querySelectorAll(".thumb").forEach((img) => thumbObserver.observe(img));
}

function renderStorage(storage) {
  const internal = (storage && storage.internal) || {};
  const total = internal.total_bytes;
  const used = internal.used_bytes;
  if (!total) {
    $("storage-text").textContent = "—";
    $("storage-fill").style.width = "0%";
    return;
  }
  const pct = Math.min(100, Math.round((used / total) * 100));
  $("storage-fill").style.width = `${pct}%`;
  $("storage-text").textContent = `${fmtBytes(used)} / ${fmtBytes(total)} (${pct} %)`;
}

async function loadFiles(silent = true) {
  try {
    const resp = await fetch("/api/files");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    renderFiles(data);
    renderStorage(data.storage);
  } catch (e) {
    if (!silent) toast(e.message, "error");
    $("files-list").innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

function renderHistory(data) {
  const list = $("history-list");
  const tasks = data.tasks || [];
  if (!tasks.length) {
    list.innerHTML = '<p class="muted">No history.</p>';
    return;
  }
  list.innerHTML = tasks
    .map((t) => {
      const status = t.task_status === 1 ? "ok" : t.task_status === 2 ? "bad" : "muted";
      const label = t.task_status === 1 ? "Completed" : t.task_status === 2 ? "Failed" : `Code ${t.task_status}`;
      const dur = t.end_time && t.begin_time ? fmtDuration(t.end_time - t.begin_time) : "—";
      const video = t.time_lapse_video_url
        ? `<a href="${t.time_lapse_video_url}" target="_blank" rel="noopener">timelapse</a>`
        : "";
      return `
        <div class="history-item">
          <div class="history-main">
            <div class="file-name" title="${t.task_name}">${t.task_name}</div>
            <div class="file-sub muted">${fmtDate(t.begin_time)} · ${dur} ${video}</div>
          </div>
          <span class="tag ${status}">${label}</span>
        </div>`;
    })
    .join("");
}

async function loadHistory(silent = true) {
  try {
    const resp = await fetch("/api/history");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    renderHistory(data);
  } catch (e) {
    if (!silent) toast(e.message, "error");
    $("history-list").innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

function renderFilament(data) {
  const list = $("filament-list");
  const info = data.canvas_info || {};
  if ($("auto-refill").dataset.bound !== "1") {
    $("auto-refill").checked = !!info.auto_refill;
  }
  const canvases = info.canvas_list || [];
  const trays = canvases.flatMap((c) => (c.tray_list || []).map((t) => ({ ...t, connected: c.connected })));
  latestTrays = trays;
  latestActiveTray = info.active_tray_id != null ? info.active_tray_id : null;
  if (!trays.length) {
    list.innerHTML = '<p class="muted">No filament detected.</p>';
    return;
  }
  list.innerHTML = trays
    .map((t) => {
      const active = t.tray_id === info.active_tray_id;
      const present = t.status > 0;
      const color = t.filament_color || "#333";
      const name = present ? `${t.filament_type || t.filament_name || "?"} · ${t.brand || ""}`.trim() : "empty";
      const temps = present && t.min_nozzle_temp ? `${t.min_nozzle_temp}-${t.max_nozzle_temp} °C` : "—";
      const actions = present
        ? `<button class="btn small" data-load="${t.tray_id}">Load</button>
           <button class="btn small" data-unload="${t.tray_id}">Unload</button>`
        : "";
      return `
        <div class="tray${active ? " active" : ""}">
          <span class="swatch" style="background:${color}"></span>
          <div class="tray-meta">
            <div class="file-name">Slot ${t.tray_id + 1} ${active ? "· active" : ""}</div>
            <div class="file-sub muted">${name} · ${temps}</div>
          </div>
          <div class="tray-actions">${actions}</div>
        </div>`;
    })
    .join("");
}

async function loadFilament(silent = true) {
  try {
    const resp = await fetch("/api/filament");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    renderFilament(data);
  } catch (e) {
    if (!silent) toast(e.message, "error");
    $("filament-list").innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

async function loadInfo() {
  try {
    const resp = await fetch("/api/info");
    const data = await resp.json();
    if (!resp.ok) return;
    const sw = data.software_version || {};
    const parts = [data.machine_model, sw.ota_version && `fw ${sw.ota_version}`, data.ip, data.sn];
    $("printer-info").textContent = parts.filter(Boolean).join(" · ");
  } catch (e) {
    /* ignore */
  }
}

async function uploadFile(file) {
  const zone = $("upload-zone");
  const bar = $("upload-progress");
  const form = new FormData();
  form.append("file", file);
  zone.classList.add("busy");
  bar.hidden = false;
  bar.value = 0;
  try {
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = (e.loaded / e.total) * 100; };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(form);
    });
    const code = result.printer && result.printer.error_code;
    if (code) throw new Error(`printer: code ${code}`);
    toast(`"${result.filename}" uploaded`, "ok");
    loadFiles();
  } catch (e) {
    toast("Upload: " + e.message, "error");
  } finally {
    zone.classList.remove("busy");
    bar.hidden = true;
  }
}

function trayOptions(selectedTray) {
  return latestTrays
    .filter((t) => t.status > 0)
    .map((t) => {
      const sel = t.tray_id === selectedTray ? " selected" : "";
      const label = `Slot ${t.tray_id + 1} — ${t.filament_type || t.filament_name || "?"} ${t.brand || ""}`.trim();
      return `<option value="${t.tray_id}"${sel}>${label}</option>`;
    })
    .join("");
}

function defaultTrayFor(color) {
  const present = latestTrays.filter((t) => t.status > 0);
  if (!present.length) return null;
  if (color) {
    const match = present.find((t) => (t.filament_color || "").toUpperCase() === color.toUpperCase());
    if (match) return match.tray_id;
  }
  if (latestActiveTray != null && present.some((t) => t.tray_id === latestActiveTray)) return latestActiveTray;
  return present[0].tray_id;
}

async function openPrintDialog(name) {
  await loadFilament();
  const file = latestFiles[name];
  let colors = (file && file.color_map) || [];
  if (!colors.length) colors = [{ t: 0, name: "", color: "#888888" }];
  $("print-slot-map").innerHTML = colors
    .map((c, i) => {
      const selected = defaultTrayFor(c.color);
      const label = c.name ? c.name : `Color ${i + 1}`;
      return `
        <div class="slot-row">
          <span class="swatch" style="background:${c.color || "#888"}"></span>
          <div class="file-meta">
            <div class="file-name">${label}</div>
            <div class="file-sub muted">${c.color || ""}</div>
          </div>
          <select data-t="${c.t}">${trayOptions(selected)}</select>
        </div>`;
    })
    .join("");
  const anyTray = latestTrays.filter((t) => t.status > 0).length > 0;
  printTargetFile = name;
  $("print-modal-file").textContent = name;
  $("print-modal-hint").textContent = anyTray
    ? "Choose the spool to use for each color in the file."
    : "No filament detected.";
  $("print-confirm").disabled = !anyTray;
  $("print-modal").classList.remove("hidden");
}

function closePrintDialog() {
  $("print-modal").classList.add("hidden");
}

function startPrint() {
  const name = printTargetFile;
  const slot_map = [...document.querySelectorAll("#print-slot-map select")].map((s) => ({
    t: Number(s.dataset.t),
    canvas_id: 0,
    tray_id: Number(s.value),
  }));
  closePrintDialog();
  run("Print", () =>
    send(1020, {
      filename: name,
      storage_media: "local",
      config: {
        delay_video: false,
        printer_check: false,
        print_layout: "A",
        bedlevel_force: false,
        slot_map,
      },
    })
  ).then(() => { setTimeout(() => { loadFiles(); loadHistory(); }, 1500); });
}

$("print-confirm").addEventListener("click", startPrint);
$("print-cancel").addEventListener("click", closePrintDialog);
$("print-modal").addEventListener("click", (e) => {
  if (e.target === $("print-modal")) closePrintDialog();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("print-modal").classList.contains("hidden")) closePrintDialog();
});

$("files-list").addEventListener("click", (e) => {
  const start = e.target.closest("[data-start]");
  const del = e.target.closest("[data-delete]");
  if (start) {
    openPrintDialog(start.dataset.start);
  }
  if (del) {
    const name = del.dataset.delete;
    if (!confirm(`Delete "${name}"?`)) return;
    run("Delete", () => send(1047, { storage_media: "local", file_path: [name] }))
      .then(() => loadFiles());
  }
});

$("filament-list").addEventListener("click", (e) => {
  const load = e.target.closest("[data-load]");
  const unload = e.target.closest("[data-unload]");
  if (load) {
    const tray = Number(load.dataset.load);
    if (!confirm(`Load filament from slot ${tray + 1}?`)) return;
    run("Load", () => send(2001, { canvas_id: 0, tray_id: tray }))
      .then(() => setTimeout(() => loadFilament(), 2000));
  }
  if (unload) {
    const tray = Number(unload.dataset.unload);
    if (!confirm(`Unload filament from slot ${tray + 1}?`)) return;
    run("Unload", () => send(2002, { canvas_id: 0, tray_id: tray }))
      .then(() => setTimeout(() => loadFilament(), 2000));
  }
});

$("auto-refill").addEventListener("change", (e) => {
  $("auto-refill").dataset.bound = "1";
  run("Auto-refill", () => send(2004, { enable: e.target.checked }));
});

$("files-refresh").addEventListener("click", () => loadFiles(false));
$("history-refresh").addEventListener("click", () => loadHistory(false));

const uploadInput = $("upload-input");
$("upload-btn").addEventListener("click", () => uploadInput.click());
uploadInput.addEventListener("change", () => {
  if (uploadInput.files[0]) uploadFile(uploadInput.files[0]);
  uploadInput.value = "";
});

const zone = $("upload-zone");
["dragenter", "dragover"].forEach((ev) =>
  zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); })
);
zone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

refresh();
loadFiles();
loadHistory();
loadFilament();
loadInfo();
loadStats();
setInterval(refresh, 2000);
setInterval(() => loadFilament(), 15000);
setInterval(() => loadHistory(), 30000);
setInterval(() => loadStats(), 60000);
