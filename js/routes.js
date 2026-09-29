// Motor de recomendación: reúne candidatos, mide su altimetría y los ordena
// según popularidad, longitud y complejidad del terreno.

import {
  haversine, bearing, destination, lineLength, cutLine, sampleEvenly,
  stitchLongest, compassName,
} from "./geo.js";
import { fetchRunningFeatures, routeFoot, elevations } from "./services.js";

export const TERRAINS = {
  flat: { label: "Totalmente plano", short: "Plano" },
  rolling: { label: "Falsos planos", short: "Falsos planos" },
  hilly: { label: "Con altimetría", short: "Cerros / trail" },
};
const TERRAIN_ORDER = ["flat", "rolling", "hilly"];

// Metros de desnivel positivo por kilómetro.
export function classifyTerrain(gainPerKm) {
  if (gainPerKm < 10) return "flat";
  if (gainPerKm < 25) return "rolling";
  return "hilly";
}

export function difficultyOf(km, gain) {
  const effort = km + gain / 100; // ~100 m de subida ≈ 1 km extra de esfuerzo
  const levels = ["Suave", "Moderada", "Exigente", "Muy exigente"];
  let i = effort < 5 ? 0 : effort < 12 ? 1 : effort < 25 ? 2 : 3;
  if (km > 0 && gain / km > 40) i = Math.min(3, i + 1);
  return { label: levels[i], level: i };
}

// Desnivel con histéresis para no sumar ruido del modelo de elevación.
export function elevationStats(elev, threshold = 3) {
  const vals = elev.filter((e) => e != null);
  if (vals.length < 2) return { gain: 0, loss: 0, min: 0, max: 0 };
  const smooth = vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  let gain = 0;
  let loss = 0;
  let ref = smooth[0];
  for (const e of smooth) {
    if (e - ref >= threshold) { gain += e - ref; ref = e; }
    else if (ref - e >= threshold) { loss += ref - e; ref = e; }
  }
  return { gain, loss, min: Math.min(...vals), max: Math.max(...vals) };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function spotPopularity(tags, kind) {
  let s = { park: 50, reserve: 55, peak: 45, trailhead: 55 }[kind] ?? 40;
  if (tags.wikidata || tags.wikipedia) s += 20;
  if (tags.website) s += 5;
  if (tags.tourism || tags.historic) s += 5;
  return clamp(s, 0, 90);
}

const RELATION_POP = { running: 95, fitness_trail: 85, foot: 78, hiking: 72 };

function parseFeatures(data, origin) {
  const curated = [];
  const tracks = [];
  const spots = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (el.type === "relation" && t.route && RELATION_POP[t.route]) {
      const segs = (el.members || [])
        .filter((m) => m.type === "way" && Array.isArray(m.geometry))
        .map((m) => m.geometry.filter(Boolean).map((g) => [g.lat, g.lon]));
      const line = stitchLongest(segs);
      if (line.length > 1) {
        curated.push({
          id: `rel-${el.id}`,
          name: t.name || t.ref || "Ruta señalizada",
          kind: t.route,
          line,
          popularity: clamp(RELATION_POP[t.route] + (t.wikidata ? 5 : 0), 0, 99),
        });
      }
    } else if (el.type === "way" && t.leisure === "track" && Array.isArray(el.geometry)) {
      // Sólo pistas completas (anillo cerrado de ~200–1000 m), no tramos sueltos.
      const ring = el.geometry.filter(Boolean).map((g) => [g.lat, g.lon]);
      const len = lineLength(ring);
      if (ring.length < 4 || haversine(ring[0], ring[ring.length - 1]) > 30 || len < 180 || len > 1000) continue;
      tracks.push({
        id: `trk-${el.id}`,
        name: t.name || "Pista atlética",
        line: ring,
      });
    } else {
      const c = el.type === "node" ? [el.lat, el.lon] : el.center && [el.center.lat, el.center.lon];
      if (!c) continue;
      const kind =
        t.natural === "peak" ? "peak"
        : t.highway === "trailhead" ? "trailhead"
        : t.leisure === "nature_reserve" ? "reserve"
        : "park";
      spots.push({
        id: `${el.type}-${el.id}`,
        name: t.name || (kind === "trailhead" ? "Inicio de sendero" : "Parque"),
        kind,
        center: c,
        ele: t.ele ? parseFloat(t.ele) : null,
        popularity: spotPopularity(t, kind),
        notable: Boolean(t.wikidata || t.wikipedia),
        dist: haversine(origin, c),
      });
    }
  }
  return { curated, tracks, spots };
}

// Circuito aproximadamente circular desde `start` que se aleja en dirección `brg`.
// Un segundo intento sólo si el primero se desvía mucho de la distancia pedida.
async function buildLoop(start, brg, targetM) {
  let r = targetM / (2 * Math.PI) / 1.25; // las calles alargan ~25 % el círculo ideal
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = destination(start, brg, r);
    const wps = [start, destination(c, brg - 90, r), destination(c, brg, r), destination(c, brg + 90, r), start];
    const route = await routeFoot(wps);
    if (!best || Math.abs(route.distance - targetM) < Math.abs(best.distance - targetM)) best = route;
    const ratio = route.distance / targetM;
    if (ratio > 0.8 && ratio < 1.25) break;
    r *= clamp(1 / ratio, 0.4, 2.5);
  }
  return best;
}

// Limita cuántas tareas corren a la vez contra un mismo servicio.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Lugares conocidos por los que pasa la ruta (además del de partida).
function placesPassed(line, spots, exclude) {
  const pts = sampleEvenly(line, 40);
  const seen = new Set(exclude ? [exclude.name] : []);
  return spots.filter((s) => {
    if (s.kind === "trailhead" || seen.has(s.name)) return false;
    if (!pts.some((p) => haversine(p, s.center) < 200)) return false;
    seen.add(s.name);
    return true;
  });
}

export const POPULARITY_LEVELS = [
  { min: 85, label: "Muy popular", level: 4 },
  { min: 65, label: "Popular", level: 3 },
  { min: 45, label: "Conocida", level: 2 },
  { min: 0, label: "Poco transitada", level: 1 },
];
export const popularityLevel = (score) => POPULARITY_LEVELS.find((l) => score >= l.min);

const ROUTE_KIND = {
  running: "Ruta de running señalizada",
  fitness_trail: "Circuito deportivo señalizado",
  foot: "Ruta peatonal señalizada",
  hiking: "Sendero de trekking señalizado",
};

// Adapta una ruta señalizada a la distancia pedida: completa, ida y vuelta o vueltas.
function fitCurated(route, targetM, origin) {
  let line = route.line;
  const len = lineLength(line);
  const closed = haversine(line[0], line[line.length - 1]) < 150;
  if (haversine(origin, line[line.length - 1]) < haversine(origin, line[0])) line = line.slice().reverse();
  if (len >= targetM * 0.75 && len <= targetM * 1.3) {
    return { line, laps: 1, suffix: closed ? "circuito completo" : "recorrido completo" };
  }
  if (len > targetM * 1.3) {
    const half = cutLine(line, targetM / 2);
    return { line: half.concat(half.slice(0, -1).reverse()), laps: 1, suffix: "tramo ida y vuelta" };
  }
  if (closed && len > 200) {
    const laps = Math.round(targetM / len);
    if (laps >= 2 && laps <= 30) return { line, laps, suffix: `${laps} vueltas` };
  }
  return null;
}

const fitsDistance = (c, targetM) => {
  const d = lineLength(c.line) * c.laps;
  return d >= targetM * 0.7 && d <= targetM * 1.35;
};

// Ordena, quita duplicados y aplica el filtro de terreno.
function finalize(results, terrain, final) {
  const sorted = results.slice().sort((a, b) => b.score - a.score);
  const unique = [];
  for (const r of sorted) {
    const dup = unique.some(
      (u) =>
        haversine(u.start, r.start) < 200 &&
        Math.abs(u.distance - r.distance) / r.distance < 0.06 &&
        Math.abs((u.gain || 0) - (r.gain || 0)) < 15
    );
    if (!dup) unique.push(r);
  }
  const matching = unique.filter((r) => r.terrain === terrain);
  if (matching.length) return { routes: matching.slice(0, 8), fallback: false };
  return { routes: final ? unique.slice(0, 8) : [], fallback: unique.length > 0 };
}

// Caché en memoria de lo consultado a Overpass (cambiar sólo distancia o terreno no repite la consulta).
const featureCache = new Map();

export async function findRoutes({ origin, distanceKm, terrain, radiusKm, onProgress = () => {}, onUpdate = () => {} }) {
  const targetM = distanceKm * 1000;
  const radiusM = radiusKm * 1000;
  const reach = radiusM + Math.min(targetM / 2, 10000);
  const bbox = [
    destination(origin, 180, reach)[0], destination(origin, 270, reach)[1],
    destination(origin, 0, reach)[0], destination(origin, 90, reach)[1],
  ];
  const osrm = limiter(4);
  const elevation = limiter(4);
  const wantIdx = TERRAIN_ORDER.indexOf(terrain);
  const results = [];
  let spots = [];
  let pending = 0;
  let done = 0;
  const progress = () => onProgress(`Encontradas ${results.length} rutas · analizando ${pending - done} más…`);
  const emit = () => onUpdate(finalize(results, terrain, false).routes);

  async function measure(c) {
    const onePass = lineLength(c.line);
    const n = clamp(Math.round(onePass / 80), 20, 80);
    const samples = sampleEvenly(c.line, n);
    let elev = null;
    try { elev = await elevation(() => elevations(samples)); } catch { /* sin altimetría */ }
    const st = elev ? elevationStats(elev) : null;
    const distance = onePass * c.laps;
    const km = distance / 1000;
    const gain = st ? st.gain * c.laps : null;
    const t = gain == null ? null : classifyTerrain(gain / km);
    const terrainMatch = t == null ? 50 : [100, 40, 0][Math.abs(TERRAIN_ORDER.indexOf(t) - wantIdx)];
    const distMatch = clamp(100 - (Math.abs(distance - targetM) / targetM) * 200, 0, 100);
    results.push({
      ...c,
      samples, elev, onePass, distance, gain,
      loss: st ? st.loss * c.laps : null,
      gainPerKm: gain == null ? null : gain / km,
      terrain: t,
      difficulty: difficultyOf(km, gain || 0),
      score: Math.round(0.45 * c.popularity + 0.3 * distMatch + 0.25 * terrainMatch),
      start: c.line[0],
    });
    emit();
  }

  // Cada candidato corre en paralelo y aparece en pantalla apenas está listo.
  const jobs = [];
  const run = (fn) => {
    pending++;
    progress();
    jobs.push(fn().catch(() => null).finally(() => { done++; progress(); }));
  };
  const addCandidate = (c) => { if (fitsDistance(c, targetM)) run(() => measure(c)); };

  const loopJob = (task) => async () => {
    let result;
    if (task.type === "summit") {
      const p = task.peak;
      // Partida en dirección a tu ubicación, a la distancia que da la ida y vuelta pedida.
      const back = targetM / 2 / 1.25;
      const start = destination(p.center, p.dist > 50 ? bearing(p.center, origin) : 180, back);
      result = await osrm(() => routeFoot([start, p.center, start]));
    } else {
      result = await osrm(() => buildLoop(task.start, task.brg, targetM));
    }
    const passed = placesPassed(result.coords, spots, task.from ?? task.peak);
    const via = result.streets.filter((n) => !task.from || n !== task.from.name).slice(0, 2);
    const reasons = [];
    let name;
    let subtitle;
    if (task.type === "summit") {
      name = `Subida a ${task.peak.name}`;
      subtitle = "Cerro · ida y vuelta";
      reasons.push(`Cumbre conocida${task.peak.notable ? " y destacada" : ""}`);
    } else if (task.from) {
      name = `Circuito ${task.from.name}`;
      subtitle = via.length ? `Por ${via.join(" y ")}` : "Circuito";
      reasons.push(
        task.from.kind === "trailhead" ? "Parte en un inicio de sendero"
        : `Parte en ${task.from.kind === "reserve" ? "una reserva" : "un parque"}${task.from.notable ? " destacado" : ""}`
      );
    } else {
      name = `Circuito ${compassName(((task.brg % 360) + 360) % 360)}`;
      subtitle = via.length ? `Desde tu punto de partida · por ${via.join(" y ")}` : "Desde tu punto de partida";
      reasons.push("Circuito trazado por calles y senderos");
    }
    if (passed.length) reasons.push(`Pasa por ${passed.slice(0, 2).map((s) => s.name).join(" y ")}`);
    addCandidate({
      id: `osrm-${task.key}`,
      source: task.type === "summit" ? "summit" : "loop",
      name, subtitle, reasons, line: result.coords, laps: 1,
      popularity: clamp(task.popularity + Math.min(20, passed.length * 6), 0, 92),
    });
  };

  // 1) Circuitos desde el punto de partida: no dependen de OpenStreetMap, parten de inmediato.
  [0, 120, 240].forEach((brg, i) =>
    run(loopJob({ key: `o${i}`, type: "loop", start: origin, brg, popularity: 35, from: null }))
  );

  // 2) Rutas y lugares de OpenStreetMap.
  onProgress("Buscando parques, senderos y rutas conocidas…");
  let notice = null;
  const cacheKey = `${origin[0].toFixed(3)},${origin[1].toFixed(3)},${radiusKm},${distanceKm}`;
  let features = featureCache.get(cacheKey);
  if (!features) {
    try {
      features = parseFeatures(await fetchRunningFeatures(origin, radiusM, bbox), origin);
      featureCache.set(cacheKey, features);
    } catch (e) {
      features = { curated: [], tracks: [], spots: [] };
      notice = "No pudimos consultar OpenStreetMap; te mostramos circuitos desde tu punto de partida.";
    }
  }
  const { curated, tracks } = features;
  spots = features.spots;
  const inRadius = spots.filter((s) => s.dist <= radiusM);

  for (const c of curated) {
    const fit = fitCurated(c, targetM, origin);
    if (!fit) continue;
    const passed = placesPassed(fit.line, spots, c);
    const reasons = [ROUTE_KIND[c.kind]];
    if (passed.length) reasons.push(`Pasa por ${passed.slice(0, 2).map((s) => s.name).join(" y ")}`);
    addCandidate({
      id: c.id, source: "curated", name: c.name, subtitle: fit.suffix[0].toUpperCase() + fit.suffix.slice(1),
      reasons, line: fit.line, laps: fit.laps, popularity: c.popularity,
    });
  }

  if (distanceKm <= 10) {
    tracks
      .map((t) => ({ ...t, dist: haversine(origin, t.line[0]) }))
      .filter((t) => t.dist <= radiusM)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2)
      .forEach((t) => {
        const laps = Math.max(1, Math.round(targetM / lineLength(t.line)));
        addCandidate({
          id: t.id, source: "track", name: t.name, subtitle: `Pista · ${laps} vueltas`,
          reasons: ["Pista atlética: plana, medida y sin tráfico"], line: t.line, laps, popularity: 70,
        });
      });
  }

  const green = inRadius
    .filter((s) => s.kind === "park" || s.kind === "reserve")
    .sort((a, b) => b.popularity - a.popularity || a.dist - b.dist);
  green.slice(0, 4).forEach((s) =>
    run(loopJob({
      key: s.id, type: "loop", start: s.center, brg: s.dist > 50 ? bearing(origin, s.center) : 90,
      popularity: s.popularity, from: s,
    }))
  );
  if (terrain !== "flat") {
    const peaks = inRadius.filter((s) => s.kind === "peak").sort((a, b) => a.dist - b.dist);
    peaks.slice(0, terrain === "hilly" ? 3 : 1).forEach((p) =>
      run(loopJob({ key: p.id, type: "summit", peak: p, popularity: p.popularity }))
    );
    const heads = inRadius.filter((s) => s.kind === "trailhead").sort((a, b) => a.dist - b.dist);
    heads.slice(0, terrain === "hilly" ? 2 : 1).forEach((h) =>
      run(loopJob({
        key: h.id, type: "loop", start: h.center, brg: bearing(origin, h.center), popularity: h.popularity, from: h,
      }))
    );
  }

  // Los trabajos pueden agregar más trabajos (circuito → altimetría): esperar hasta vaciar.
  while (done < pending) await Promise.all(jobs.slice());

  const out = finalize(results, terrain, true);
  if (out.fallback && !out.routes.some((r) => r.terrain === terrain)) {
    notice = `No encontramos rutas "${TERRAINS[terrain].label.toLowerCase()}" en este radio. Te mostramos las más parecidas.`;
  }
  return { routes: out.routes, notice, spots: inRadius };
}
