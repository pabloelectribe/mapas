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
      tracks.push({
        id: `trk-${el.id}`,
        name: t.name || "Pista atlética",
        line: el.geometry.map((g) => [g.lat, g.lon]),
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
        dist: haversine(origin, c),
      });
    }
  }
  return { curated, tracks, spots };
}

// Circuito aproximadamente circular desde `start` que se aleja en dirección `brg`.
async function buildLoop(start, brg, targetM) {
  let r = targetM / (2 * Math.PI) / 1.2; // las calles alargan ~20 % el círculo ideal
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = destination(start, brg, r);
    const wps = [start, destination(c, brg - 90, r), destination(c, brg, r), destination(c, brg + 90, r), start];
    const route = await routeFoot(wps);
    if (!best || Math.abs(route.distance - targetM) < Math.abs(best.distance - targetM)) best = route;
    const ratio = route.distance / targetM;
    if (ratio > 0.9 && ratio < 1.1) break;
    r *= clamp(1 / ratio, 0.4, 2.5);
  }
  return best;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function passBonus(line, spots, excludeId) {
  const pts = sampleEvenly(line, 40);
  let n = 0;
  for (const s of spots) {
    if (s.id === excludeId) continue;
    if (pts.some((p) => haversine(p, s.center) < 200)) n++;
  }
  return Math.min(20, n * 6);
}

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

export async function findRoutes({ origin, distanceKm, terrain, radiusKm, onProgress = () => {} }) {
  const targetM = distanceKm * 1000;
  const radiusM = radiusKm * 1000;
  const reach = radiusM + Math.min(targetM / 2, 10000);
  const bbox = [
    destination(origin, 180, reach)[0], destination(origin, 270, reach)[1],
    destination(origin, 0, reach)[0], destination(origin, 90, reach)[1],
  ];

  onProgress("Buscando parques, senderos y rutas conocidas…");
  let features = { curated: [], tracks: [], spots: [] };
  let notice = null;
  try {
    features = parseFeatures(await fetchRunningFeatures(origin, radiusM, bbox), origin);
  } catch (e) {
    notice = "No pudimos consultar OpenStreetMap; te mostramos circuitos desde tu ubicación.";
  }
  const { curated, tracks, spots } = features;

  const candidates = [];

  for (const c of curated) {
    const fit = fitCurated(c, targetM, origin);
    if (!fit) continue;
    candidates.push({
      id: c.id, source: "curated", name: c.name, subtitle: `Ruta señalizada · ${fit.suffix}`,
      line: fit.line, laps: fit.laps, popularity: c.popularity,
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
        candidates.push({
          id: t.id, source: "track", name: t.name, subtitle: `Pista · ${laps} vueltas`,
          line: t.line, laps, popularity: 70,
        });
      });
  }

  // Tareas de trazado con el ruteador peatonal.
  const inRadius = spots.filter((s) => s.dist <= radiusM);
  const green = inRadius
    .filter((s) => s.kind === "park" || s.kind === "reserve")
    .sort((a, b) => b.popularity - a.popularity || a.dist - b.dist);
  const tasks = [];
  const firstBrg = green.length ? bearing(origin, green[0].center) : 0;
  [0, 120, 240].forEach((off) =>
    tasks.push({ type: "loop", start: origin, brg: firstBrg + off, popularity: 35, from: null })
  );
  for (const s of green.slice(0, 4)) {
    tasks.push({
      type: "loop", start: s.center, brg: s.dist > 50 ? bearing(origin, s.center) : 90,
      popularity: s.popularity, from: s,
    });
  }
  if (terrain !== "flat") {
    const peaks = inRadius.filter((s) => s.kind === "peak").sort((a, b) => a.dist - b.dist);
    for (const p of peaks.slice(0, terrain === "hilly" ? 3 : 1)) {
      tasks.push({ type: "summit", peak: p, popularity: p.popularity });
    }
    const heads = inRadius.filter((s) => s.kind === "trailhead").sort((a, b) => a.dist - b.dist);
    for (const h of heads.slice(0, terrain === "hilly" ? 2 : 1)) {
      tasks.push({ type: "loop", start: h.center, brg: bearing(origin, h.center), popularity: h.popularity, from: h });
    }
  }

  let done = 0;
  onProgress(`Trazando ${tasks.length} circuitos por calles y senderos…`);
  const traced = await pool(tasks, 2, async (task) => {
    let result;
    if (task.type === "summit") {
      const p = task.peak;
      // Partida en dirección a tu ubicación, a la distancia que da la ida y vuelta pedida.
      const back = targetM / 2 / 1.25;
      const start = destination(p.center, p.dist > 50 ? bearing(p.center, origin) : 180, back);
      result = await routeFoot([start, p.center, start]);
    } else {
      result = await buildLoop(task.start, task.brg, targetM);
    }
    onProgress(`Trazando circuitos… ${++done}/${tasks.length}`);
    return { task, result };
  });

  for (const t of traced) {
    if (!t || !t.result) continue;
    const { task, result } = t;
    const via = result.streets.filter((n) => !task.from || n !== task.from.name).slice(0, 2);
    let name;
    let subtitle;
    if (task.type === "summit") {
      name = `Subida a ${task.peak.name}`;
      subtitle = "Cerro · ida y vuelta";
    } else if (task.from) {
      name = `Circuito ${task.from.name}`;
      subtitle = via.length ? `Por ${via.join(" y ")}` : "Circuito";
    } else {
      name = `Circuito ${compassName(((task.brg % 360) + 360) % 360)}`;
      subtitle = via.length ? `Desde tu ubicación · por ${via.join(" y ")}` : "Desde tu ubicación";
    }
    candidates.push({
      id: `osrm-${candidates.length}`,
      source: task.type === "summit" ? "summit" : "loop",
      name, subtitle, line: result.coords, laps: 1,
      popularity: clamp(task.popularity + passBonus(result.coords, spots, task.from?.id), 0, 92),
    });
  }

  // Sólo distancias razonablemente cercanas a lo pedido.
  const fitting = candidates.filter((c) => {
    const d = lineLength(c.line) * c.laps;
    return d >= targetM * 0.7 && d <= targetM * 1.35;
  });

  onProgress("Midiendo la altimetría de cada ruta…");
  const measured = await pool(fitting, 3, async (c) => {
    const onePass = lineLength(c.line);
    const n = clamp(Math.round(onePass / 40), 20, 100);
    const pts = sampleEvenly(c.line, n);
    let elev = null;
    try { elev = await elevations(pts); } catch { /* sin altimetría */ }
    const st = elev ? elevationStats(elev) : null;
    return { ...c, samples: pts, elev, onePass, stats: st };
  });

  const wantIdx = TERRAIN_ORDER.indexOf(terrain);
  const routes = measured.filter(Boolean).map((c) => {
    const distance = c.onePass * c.laps;
    const km = distance / 1000;
    const gain = c.stats ? c.stats.gain * c.laps : null;
    const t = gain == null ? null : classifyTerrain(gain / km);
    const terrainMatch = t == null ? 50 : [100, 40, 0][Math.abs(TERRAIN_ORDER.indexOf(t) - wantIdx)];
    const distMatch = clamp(100 - (Math.abs(distance - targetM) / targetM) * 200, 0, 100);
    return {
      ...c,
      distance,
      gain,
      loss: c.stats ? c.stats.loss * c.laps : null,
      gainPerKm: gain == null ? null : gain / km,
      terrain: t,
      difficulty: difficultyOf(km, gain || 0),
      score: Math.round(0.45 * c.popularity + 0.3 * distMatch + 0.25 * terrainMatch),
      start: c.line[0],
    };
  });

  routes.sort((a, b) => b.score - a.score);
  const unique = [];
  for (const r of routes) {
    const dup = unique.some(
      (u) =>
        haversine(u.start, r.start) < 200 &&
        Math.abs(u.distance - r.distance) / r.distance < 0.06 &&
        Math.abs((u.gain || 0) - (r.gain || 0)) < 15
    );
    if (!dup) unique.push(r);
  }

  const matching = unique.filter((r) => r.terrain === terrain);
  let list = matching;
  if (!matching.length && unique.length) {
    notice = `No encontramos rutas "${TERRAINS[terrain].label.toLowerCase()}" en este radio. Te mostramos las más parecidas.`;
    list = unique;
  }
  return { routes: list.slice(0, 8), notice, spots: inRadius };
}
