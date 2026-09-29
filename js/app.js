import { findRoutes, TERRAINS } from "./routes.js";
import { searchPlace, reverseName } from "./services.js";
import { toGPX, sampleEvenly } from "./geo.js";

const $ = (s) => document.querySelector(s);
const STORE_KEY = "trota:filters";

const state = {
  origin: null,
  originLabel: "",
  distance: 5,
  terrain: "flat",
  radius: 5,
  routes: [],
  selected: null,
};

// ---------- Preferencias guardadas ----------
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  if ([1, 3, 5, 10, 21, 42].includes(saved.distance)) state.distance = saved.distance;
  if (TERRAINS[saved.terrain]) state.terrain = saved.terrain;
  if (saved.radius >= 1 && saved.radius <= 25) state.radius = saved.radius;
} catch { /* sin almacenamiento */ }

function saveFilters() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ distance: state.distance, terrain: state.terrain, radius: state.radius }));
  } catch { /* sin almacenamiento */ }
}

// ---------- Filtros ----------
function bindRadioGroup(el, key, parse) {
  const buttons = [...el.querySelectorAll("button")];
  const paint = () =>
    buttons.forEach((b) => b.setAttribute("aria-checked", String(parse(b.dataset.v) === state[key])));
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      state[key] = parse(b.dataset.v);
      paint();
      saveFilters();
    })
  );
  paint();
}
bindRadioGroup($("#distance"), "distance", Number);
bindRadioGroup($("#terrain"), "terrain", String);

const radius = $("#radius");
radius.value = state.radius;
const paintRadius = () => ($("#radius-out").textContent = `${state.radius} km`);
radius.addEventListener("input", () => {
  state.radius = Number(radius.value);
  paintRadius();
  saveFilters();
});
paintRadius();

// ---------- Ubicación ----------
const locBtn = $("#locate");
const locStatus = $("#loc-status");

function setOrigin(center, label) {
  state.origin = center;
  state.originLabel = label;
  locStatus.textContent = `✓ Partida: ${label}`;
  locStatus.className = "loc-status ok";
  $("#go").disabled = false;
  $("#go-hint").hidden = true;
}

function setLocError(msg) {
  locStatus.textContent = msg;
  locStatus.className = "loc-status err";
}

locBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    setLocError("Tu navegador no permite geolocalización. Busca un lugar en el campo de abajo.");
    return;
  }
  locBtn.classList.add("loading");
  locStatus.className = "loc-status";
  locStatus.textContent = "Buscando tu ubicación…";
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      locBtn.classList.remove("loading");
      locBtn.classList.add("active");
      $("#place").value = "";
      const center = [pos.coords.latitude, pos.coords.longitude];
      setOrigin(center, "tu ubicación actual");
      const name = await reverseName(center);
      if (name && state.origin === center) setOrigin(center, `tu ubicación (${name})`);
    },
    (err) => {
      locBtn.classList.remove("loading");
      setLocError(
        err.code === err.PERMISSION_DENIED
          ? "No diste permiso de ubicación. Puedes buscar un lugar por nombre."
          : "No pudimos obtener tu ubicación. Intenta de nuevo o busca un lugar."
      );
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
});

// Búsqueda por nombre (Nominatim), con espera para no saturar el servicio.
const placeInput = $("#place");
const placeList = $("#place-results");
let searchTimer;
let searchSeq = 0;
placeInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = placeInput.value.trim();
  if (q.length < 3) { placeList.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const results = await searchPlace(q);
      if (seq !== searchSeq) return;
      placeList.innerHTML = "";
      if (!results.length) {
        placeList.innerHTML = `<li aria-disabled="true">Sin resultados</li>`;
      }
      for (const r of results) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = r.name;
        li.addEventListener("click", () => {
          placeInput.value = r.name.split(",")[0];
          placeList.hidden = true;
          locBtn.classList.remove("active");
          setOrigin(r.center, r.name.split(",").slice(0, 2).join(","));
        });
        placeList.appendChild(li);
      }
      placeList.hidden = false;
    } catch {
      setLocError("La búsqueda de lugares no respondió. Intenta nuevamente.");
    }
  }, 450);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) placeList.hidden = true;
});

// ---------- Mapa ----------
let map;
let layers;
let baseLayers;
const lines = new Map();

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false, attributionControl: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  baseLayers = {
    Mapa: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: osm,
    }),
    Relieve: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      subdomains: "abc",
      attribution: `${osm}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    }),
    "Satélite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Imágenes &copy; Esri, Maxar, Earthstar Geographics",
    }),
  };
  L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
  layers = L.layerGroup().addTo(map);
}

function drawBase() {
  const wanted = state.terrain === "hilly" ? "Relieve" : "Mapa";
  for (const [name, layer] of Object.entries(baseLayers)) {
    if (name === wanted) layer.addTo(map);
    else map.removeLayer(layer);
  }
  layers.clearLayers();
  lines.clear();
  L.circle(state.origin, {
    radius: state.radius * 1000,
    color: "#7b45e8", weight: 1.5, dashArray: "6 6", fillColor: "#7b45e8", fillOpacity: 0.06,
    interactive: false,
  }).addTo(layers);
  L.marker(state.origin, {
    icon: L.divIcon({ className: "me-dot", iconSize: [16, 16] }),
    title: "Punto de partida",
    keyboard: false,
  }).addTo(layers);
  map.fitBounds(L.latLng(state.origin).toBounds(state.radius * 2000), { padding: [20, 20] });
}

function drawRoutes() {
  state.routes.forEach((r, i) => {
    const line = L.polyline(r.line, { color: "#7b45e8", weight: 4, opacity: 0.45 }).addTo(layers);
    line.on("click", () => selectRoute(r.id, true));
    line.bindTooltip(`#${i + 1} ${r.name}`, { sticky: true });
    const pin = L.marker(r.start, {
      icon: L.divIcon({ className: "start-pin", html: String(i + 1), iconSize: [26, 26] }),
      keyboard: false,
    }).addTo(layers);
    pin.on("click", () => selectRoute(r.id, true));
    lines.set(r.id, line);
  });
}

// ---------- Resultados ----------
const fmtKm = (m) => (m / 1000).toLocaleString("es-CL", { maximumFractionDigits: 1 });

function profileSVG(elev) {
  const vals = elev.filter((e) => e != null);
  if (vals.length < 2) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(max - min, 20);
  const W = 300;
  const H = 80;
  const pts = vals.map((e, i) => [(i / (vals.length - 1)) * W, H - 6 - ((e - min) / span) * (H - 14)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  return `<svg class="profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Perfil de elevación">
    <path class="area" d="${d}L${W},${H}L0,${H}Z"/><path class="line" d="${d}"/></svg>
    <div class="profile-legend"><span>mín ${Math.round(min)} m</span><span>Perfil de elevación</span><span>máx ${Math.round(max)} m</span></div>`;
}

function mapsLink(r) {
  const s = `${r.start[0].toFixed(6)},${r.start[1].toFixed(6)}`;
  const pts = sampleEvenly(r.line, 5).slice(1, -1).map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`);
  const end = r.line[r.line.length - 1];
  return (
    "https://www.google.com/maps/dir/?api=1&travelmode=walking" +
    `&origin=${s}&destination=${end[0].toFixed(6)},${end[1].toFixed(6)}&waypoints=${encodeURIComponent(pts.join("|"))}`
  );
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderList() {
  const list = $("#route-list");
  list.innerHTML = "";
  if (!state.routes.length) {
    list.innerHTML = `<li class="empty">No encontramos rutas de ${state.distance} km en este radio. Prueba ampliando el radio o cambiando la distancia.</li>`;
    return;
  }
  state.routes.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "route";
    li.dataset.id = r.id;
    li.tabIndex = 0;
    const terrain = r.terrain
      ? `<span class="tag ${r.terrain}">${TERRAINS[r.terrain].short}</span>`
      : `<span class="tag">Altimetría no disponible</span>`;
    const gain = r.gain == null ? "" : `<span><b>+${Math.round(r.gain)}</b> m</span>`;
    li.innerHTML = `
      <div class="rank">${i + 1}</div>
      <div>
        <h3>${escapeHTML(r.name)}</h3>
        <p class="sub">${escapeHTML(r.subtitle)}</p>
        <div class="stats">
          <span><b>${fmtKm(r.distance)}</b> km</span>${gain}${terrain}<span>${r.difficulty.label}</span>
        </div>
        <div class="pop"><span>Popularidad</span><div class="bar"><i style="width:${r.popularity}%"></i></div><span>${r.popularity}</span></div>
        <div class="detail">
          ${r.elev ? profileSVG(r.elev) : ""}
          <div class="actions">
            <button type="button" data-act="gpx">Descargar GPX</button>
            <a class="primary" href="${mapsLink(r)}" target="_blank" rel="noopener">Llévame ahí</a>
          </div>
        </div>
      </div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-act=gpx]")) return downloadGPX(r);
      if (e.target.closest("a")) return;
      selectRoute(r.id, false);
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRoute(r.id, false); }
    });
    list.appendChild(li);
  });
}

function selectRoute(id, fromMap) {
  state.selected = id;
  for (const [rid, line] of lines) {
    const on = rid === id;
    line.setStyle(on ? { color: "#e9663a", weight: 6, opacity: 1 } : { color: "#7b45e8", weight: 4, opacity: 0.35 });
    if (on) line.bringToFront();
  }
  document.querySelectorAll(".route").forEach((el) => el.classList.toggle("selected", el.dataset.id === id));
  const r = state.routes.find((x) => x.id === id);
  if (r) map.fitBounds(L.latLngBounds(r.line), { padding: [40, 40], maxZoom: 16 });
  if (fromMap) document.querySelector(`.route[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function downloadGPX(r) {
  const elev = r.elev && r.samples.length === r.elev.length ? r.elev : null;
  const gpx = toGPX(r.name, elev ? r.samples : r.line, elev);
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${r.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Navegación ----------
function showResults() {
  document.body.classList.remove("on-start");
  $("#start").hidden = true;
  $("#results").hidden = false;
  window.scrollTo(0, 0);
  ensureMap();
  map.invalidateSize();
}

$("#back").addEventListener("click", () => {
  $("#results").hidden = true;
  $("#start").hidden = false;
  document.body.classList.add("on-start");
});

let runId = 0;
$("#go").addEventListener("click", async () => {
  if (!state.origin) return;
  const id = ++runId;
  showResults();
  $("#summary").innerHTML = `
    <span class="pill blue">${state.distance} km</span>
    <span class="pill purple">${TERRAINS[state.terrain].label}</span>
    <span class="pill green">Radio ${state.radius} km</span>`;
  state.routes = [];
  state.selected = null;
  $("#route-list").innerHTML = "";
  $("#notice").hidden = true;
  drawBase();

  const progress = $("#progress");
  progress.hidden = false;
  try {
    const res = await findRoutes({
      origin: state.origin,
      distanceKm: state.distance,
      terrain: state.terrain,
      radiusKm: state.radius,
      onProgress: (t) => { if (id === runId) $("#progress-text").textContent = t; },
    });
    if (id !== runId) return;
    state.routes = res.routes;
    if (res.notice) {
      $("#notice").textContent = res.notice;
      $("#notice").hidden = false;
    }
    renderList();
    drawRoutes();
    if (state.routes.length) selectRoute(state.routes[0].id, false);
  } catch (e) {
    if (id !== runId) return;
    $("#notice").textContent = "Los servicios de mapas no respondieron. Revisa tu conexión e inténtalo de nuevo.";
    $("#notice").hidden = false;
  } finally {
    if (id === runId) progress.hidden = true;
  }
});
