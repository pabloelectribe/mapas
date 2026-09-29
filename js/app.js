import { findRoutes, TERRAINS, popularityLevel } from "./routes.js";
import { searchPlace, reverseName } from "./services.js";
import { toGPX, sampleEvenly } from "./geo.js";
import { trackPoints, toFITCourse } from "./export.js";

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
let areaLayer; // radio de búsqueda y punto de partida
let routeLayer; // resto de rutas (discretas)
let focusLayer; // ruta seleccionada (destacada)
let userMovedMap = false;

const ROUTE_COLOR = "#e9663a";
const START_ICON = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.2v7.6L10 6z"/></svg>`;
const MUTED_COLOR = "#7c8594";

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false, attributionControl: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services";
  // "Simple": fondo gris claro con pocas etiquetas, para que destaque el circuito.
  const simple = L.layerGroup([
    L.tileLayer(`${esri}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19, maxNativeZoom: 16,
      attribution: `Mapa base &copy; Esri, HERE, Garmin, ${osm}`,
    }),
    L.tileLayer(`${esri}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19, maxNativeZoom: 16,
    }),
  ]);
  const baseLayers = {
    Simple: simple,
    Calles: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osm }),
    Relieve: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, subdomains: "abc",
      attribution: `${osm}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    }),
    "Satélite": L.tileLayer(`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19, attribution: "Imágenes &copy; Esri, Maxar, Earthstar Geographics",
    }),
  };
  simple.addTo(map);
  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML = `
      <span><i class="start-pin is-start">${START_ICON}</i>Inicio</span>
      <span><i class="km-pin">1<small>km</small></i>Kilómetro</span>
      <span><i class="start-pin muted">2</i>Otras rutas</span>`;
    return div;
  };
  legend.addTo(map);
  L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
  areaLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  focusLayer = L.layerGroup().addTo(map);

  // "Buscar en esta zona" aparece sólo cuando la persona mueve el mapa.
  let interacting = false;
  const el = map.getContainer();
  ["pointerdown", "wheel", "touchstart"].forEach((ev) =>
    el.addEventListener(ev, (e) => {
      if (!e.target.closest(".leaflet-control")) interacting = true;
    }, { passive: true })
  );
  map.on("moveend", () => {
    if (!interacting) return;
    interacting = false;
    userMovedMap = true;
    const c = map.getCenter();
    const far = state.origin && map.distance(c, L.latLng(state.origin)) > 300;
    $("#search-here").hidden = !far;
  });
}

function drawArea() {
  areaLayer.clearLayers();
  L.circle(state.origin, {
    radius: state.radius * 1000,
    color: "#7b45e8", weight: 1.5, opacity: 0.6, dashArray: "4 6", fill: false,
    interactive: false,
  }).addTo(areaLayer);
  L.marker(state.origin, {
    icon: L.divIcon({ className: "me-dot", iconSize: [14, 14] }),
    title: "Punto de partida",
    keyboard: false,
    interactive: false,
  }).addTo(areaLayer);
}

// Marcadores de kilómetro a lo largo de la ruta seleccionada (una vuelta).
function kmMarkers(r) {
  const total = r.onePass;
  const step = total <= 12000 ? 1000 : total <= 25000 ? 2000 : 5000;
  const out = [];
  let acc = 0;
  let next = step;
  for (let i = 1; i < r.line.length && next < total - step / 3; i++) {
    const a = r.line[i - 1];
    const b = r.line[i];
    const seg = L.latLng(a).distanceTo(L.latLng(b));
    while (seg > 0 && acc + seg >= next && next < total - step / 3) {
      const f = (next - acc) / seg;
      out.push({ km: next / 1000, at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] });
      next += step;
    }
    acc += seg;
  }
  return out;
}

function drawRoutes() {
  routeLayer.clearLayers();
  focusLayer.clearLayers();
  state.routes.forEach((r, i) => {
    if (r.id === state.selected) return;
    const line = L.polyline(r.line, { color: MUTED_COLOR, weight: 3, opacity: 0.55 }).addTo(routeLayer);
    line.on("click", () => selectRoute(r.id, { fromMap: true }));
    line.bindTooltip(`${i + 1}. ${r.name}`, { sticky: true });
    L.marker(r.start, {
      icon: L.divIcon({ className: "start-pin muted", html: String(i + 1), iconSize: [22, 22] }),
      keyboard: false,
    }).on("click", () => selectRoute(r.id, { fromMap: true })).addTo(routeLayer);
  });

  const i = state.routes.findIndex((r) => r.id === state.selected);
  if (i < 0) return;
  const r = state.routes[i];
  L.polyline(r.line, { color: "#fff", weight: 11, opacity: 0.95, interactive: false }).addTo(focusLayer);
  L.polyline(r.line, { color: ROUTE_COLOR, weight: 5.5, opacity: 1, interactive: false }).addTo(focusLayer);
  for (const m of kmMarkers(r)) {
    L.marker(m.at, {
      icon: L.divIcon({ className: "km-pin", html: `${m.km}<small>km</small>`, iconSize: [36, 18] }),
      keyboard: false, interactive: false,
    }).addTo(focusLayer);
  }
  L.marker(r.start, {
    icon: L.divIcon({ className: "start-pin is-start", html: START_ICON, iconSize: [30, 30] }),
    keyboard: false, zIndexOffset: 1000, title: "Inicio",
  }).addTo(focusLayer);
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

const FLAME = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.6 1.2c.3 2-.9 3.1-2 4.3C5.5 6.7 4.3 8 4.3 10a3.7 3.7 0 0 0 7.4 0c0-1.3-.5-2.3-1.1-3.1-.1.9-.6 1.6-1.3 1.9.4-2.6-.2-5.6-2.7-7.6Z"/></svg>`;

function popularityHTML(r) {
  const lvl = popularityLevel(r.popularity);
  const flames = [1, 2, 3, 4].map((n) => `<i class="${n <= lvl.level ? "on" : ""}">${FLAME}</i>`).join("");
  const why = (r.reasons || []).map(escapeHTML).join(" · ");
  return `<div class="pop lvl-${lvl.level}" title="Popularidad ${r.popularity}/100 estimada con OpenStreetMap">
      <span class="flames" aria-hidden="true">${flames}</span><b>${lvl.label}</b>
    </div>
    ${why ? `<p class="why">${why}</p>` : ""}`;
}

function renderList(loading) {
  const list = $("#route-list");
  list.innerHTML = "";
  if (!state.routes.length) {
    if (!loading) {
      list.innerHTML = `<li class="empty">No encontramos rutas de ${state.distance} km en este radio. Prueba ampliando el radio o cambiando la distancia.</li>`;
    }
    return;
  }
  state.routes.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "route" + (r.id === state.selected ? " selected" : "");
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
        ${popularityHTML(r)}
        <div class="detail">
          ${r.elev ? profileSVG(r.elev) : ""}
          <div class="actions">
            <button type="button" data-act="gpx">⬇ GPX</button>
            <button type="button" data-act="fit">⬇ Garmin (.fit)</button>
          </div>
          <div class="garmin-help" hidden>
            <b>Listo: se descargó el curso para Garmin (.fit).</b>
            <ol>
              <li><b>Con Garmin Connect:</b> Entrenamiento y planificación → Recorridos → Importar → elige el archivo → Guardar → Enviar al dispositivo.</li>
              <li><b>Por cable:</b> copia el archivo a la carpeta <code>GARMIN/NewFiles</code> del reloj.</li>
              <li>En el reloj: Correr → Navegación → Recorridos → <i>${escapeHTML(r.name)}</i>.</li>
            </ol>
          </div>
          <a class="go" href="${mapsLink(r)}" target="_blank" rel="noopener">Llévame ahí</a>
        </div>
      </div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-act=gpx]")) return downloadGPX(r);
      if (e.target.closest("[data-act=fit]")) {
        downloadFIT(r);
        li.querySelector(".garmin-help").hidden = false;
        return;
      }
      if (e.target.closest("a, .garmin-help")) return;
      selectRoute(r.id, { user: true });
    });
    li.addEventListener("keydown", (e) => {
      if (e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectRoute(r.id, { user: true }); }
    });
    list.appendChild(li);
  });
}

function selectRoute(id, { fromMap = false, user = false, fit = true } = {}) {
  if (fromMap || user) state.userSelected = true;
  state.selected = id;
  drawRoutes();
  document.querySelectorAll(".route").forEach((el) => el.classList.toggle("selected", el.dataset.id === id));
  const r = state.routes.find((x) => x.id === id);
  if (r && fit) map.fitBounds(L.latLngBounds(r.line), { padding: [40, 40], maxZoom: 16 });
  if (fromMap) document.querySelector(`.route[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

const fileName = (r, ext) => `${r.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "ruta"}.${ext}`;

function saveFile(data, name, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadGPX(r) {
  const pts = trackPoints(r);
  saveFile(toGPX(r.name, pts.map((p) => [p.lat, p.lon]), pts.map((p) => p.ele)), fileName(r, "gpx"), "application/gpx+xml");
}

function downloadFIT(r) {
  const fit = toFITCourse(r.name, trackPoints(r), { gain: r.gain || 0, loss: r.loss || 0 });
  saveFile(fit, fileName(r, "fit"), "application/vnd.ant.fit");
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

$("#search-here").addEventListener("click", () => {
  const c = map.getCenter();
  state.origin = [c.lat, c.lng];
  state.originLabel = "zona del mapa";
  locBtn.classList.remove("active");
  placeInput.value = "";
  locStatus.textContent = "✓ Partida: zona elegida en el mapa";
  locStatus.className = "loc-status ok";
  search({ keepView: true });
});

let runId = 0;
async function search({ keepView = false } = {}) {
  if (!state.origin) return;
  const id = ++runId;
  showResults();
  $("#search-here").hidden = true;
  $("#summary").innerHTML = `
    <span class="pill blue">${state.distance} km</span>
    <span class="pill purple">${TERRAINS[state.terrain].label}</span>
    <span class="pill green">Radio ${state.radius} km</span>`;
  state.routes = [];
  state.selected = null;
  state.userSelected = false;
  userMovedMap = false;
  $("#notice").hidden = true;
  renderList(true);
  drawArea();
  drawRoutes();
  if (!keepView) map.fitBounds(L.latLng(state.origin).toBounds(state.radius * 2000), { padding: [20, 20] });

  const progress = $("#progress");
  progress.hidden = false;
  $("#progress-text").textContent = "Buscando rutas…";
  const apply = (routes, final) => {
    state.routes = routes;
    if (!state.userSelected || !routes.some((r) => r.id === state.selected)) {
      state.selected = routes[0]?.id ?? null;
    }
    renderList(!final);
    drawRoutes();
  };
  try {
    const res = await findRoutes({
      origin: state.origin,
      distanceKm: state.distance,
      terrain: state.terrain,
      radiusKm: state.radius,
      onProgress: (t) => { if (id === runId) $("#progress-text").textContent = t; },
      onUpdate: (routes) => { if (id === runId) apply(routes, false); },
    });
    if (id !== runId) return;
    apply(res.routes, true);
    if (res.notice) {
      $("#notice").textContent = res.notice;
      $("#notice").hidden = false;
    }
    if (state.selected && !state.userSelected && !userMovedMap) selectRoute(state.selected);
  } catch (e) {
    if (id !== runId) return;
    $("#notice").textContent = "Los servicios de mapas no respondieron. Revisa tu conexión e inténtalo de nuevo.";
    $("#notice").hidden = false;
  } finally {
    if (id === runId) progress.hidden = true;
  }
}

$("#go").addEventListener("click", () => search());
