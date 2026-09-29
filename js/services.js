// Clientes de servicios abiertos de mapas:
//  - Overpass (OpenStreetMap): rutas señalizadas, parques, pistas, cerros.
//  - OSRM perfil peatonal (routing.openstreetmap.de): traza circuitos por calles y senderos.
//  - Open-Meteo Elevation (Copernicus DEM 90 m): altimetría.
//  - Nominatim: búsqueda de lugares por nombre.

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OSRM_FOOT = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const ELEVATION = "https://api.open-meteo.com/v1/elevation";
const NOMINATIM = "https://nominatim.openstreetmap.org";

async function fetchJSON(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function overpass(query) {
  let lastError;
  for (const endpoint of OVERPASS) {
    try {
      return await fetchJSON(
        endpoint,
        {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
        40000
      );
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// Lugares y rutas relevantes para trotar dentro del radio.
export function fetchRunningFeatures([lat, lon], radiusM, bbox) {
  const around = `(around:${Math.round(radiusM)},${lat},${lon})`;
  const box = bbox.map((v) => v.toFixed(5)).join(",");
  const query = `[out:json][timeout:35];
relation["route"~"^(running|fitness_trail|foot|hiking)$"]${around};
out tags geom(${box});
way["leisure"="track"]["sport"~"running|athletics"]${around};
out tags geom;
(
  way["leisure"="park"]["name"]${around};
  relation["leisure"="park"]["name"]${around};
  way["leisure"="nature_reserve"]["name"]${around};
  relation["leisure"="nature_reserve"]["name"]${around};
  node["natural"="peak"]["name"]${around};
  node["highway"="trailhead"]${around};
);
out tags center 150;`;
  return overpass(query);
}

// Ruta peatonal que pasa por los puntos dados. Devuelve geometría [lat, lon], distancia y calles.
export async function routeFoot(points) {
  const coords = points.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const url = `${OSRM_FOOT}/${coords}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
  const data = await fetchJSON(url);
  if (data.code !== "Ok" || !data.routes?.length) throw new Error("Sin ruta peatonal");
  const route = data.routes[0];
  const streets = new Map();
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      if (step.name) streets.set(step.name, (streets.get(step.name) || 0) + step.distance);
    }
  }
  return {
    coords: route.geometry.coordinates.map(([x, y]) => [y, x]),
    distance: route.distance,
    streets: [...streets.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
  };
}

// Elevación (m) para hasta 100 puntos por consulta.
export async function elevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const lat = chunk.map((p) => p[0].toFixed(5)).join(",");
    const lon = chunk.map((p) => p[1].toFixed(5)).join(",");
    const data = await fetchJSON(`${ELEVATION}?latitude=${lat}&longitude=${lon}`);
    out.push(...data.elevation);
  }
  return out;
}

export async function searchPlace(q) {
  const url = `${NOMINATIM}/search?format=json&limit=5&accept-language=es&q=${encodeURIComponent(q)}`;
  const data = await fetchJSON(url, {}, 15000);
  return data.map((d) => ({ name: d.display_name, center: [+d.lat, +d.lon] }));
}

export async function reverseName([lat, lon]) {
  try {
    const url = `${NOMINATIM}/reverse?format=json&zoom=14&accept-language=es&lat=${lat}&lon=${lon}`;
    const d = await fetchJSON(url, {}, 10000);
    const a = d.address || {};
    return a.suburb || a.neighbourhood || a.city_district || a.town || a.city || a.village || null;
  } catch {
    return null;
  }
}
