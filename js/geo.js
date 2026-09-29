// Utilidades geométricas. Todas las coordenadas son [lat, lon].

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
    Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Punto a `dist` metros de `p` en dirección `brg` (grados).
export function destination(p, brg, dist) {
  const d = dist / R;
  const t = rad(brg);
  const lat1 = rad(p[0]);
  const lon1 = rad(p[1]);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(t) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [deg(lat2), ((deg(lon2) + 540) % 360) - 180];
}

export function lineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

// Recorta una línea a los primeros `meters` metros.
export function cutLine(coords, meters) {
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i - 1], coords[i]);
    if (acc + seg >= meters) {
      const f = (meters - acc) / seg;
      out.push([
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f,
      ]);
      return out;
    }
    acc += seg;
    out.push(coords[i]);
  }
  return out;
}

// `n` puntos equiespaciados (por distancia) a lo largo de la línea.
export function sampleEvenly(coords, n) {
  if (coords.length <= 1) return coords.slice();
  const total = lineLength(coords);
  const step = total / (n - 1);
  const out = [coords[0]];
  let acc = 0;
  let next = step;
  for (let i = 1; i < coords.length && out.length < n - 1; i++) {
    const seg = haversine(coords[i - 1], coords[i]);
    while (seg > 0 && acc + seg >= next && out.length < n - 1) {
      const f = (next - acc) / seg;
      out.push([
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f,
      ]);
      next += step;
    }
    acc += seg;
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// Une tramos (ways de una relación OSM) en cadenas continuas y devuelve la más larga.
export function stitchLongest(segments, tolerance = 60) {
  const pool = segments.filter((s) => s.length > 1).map((s) => s.slice());
  let best = [];
  let bestLen = 0;
  while (pool.length) {
    let chain = pool.shift();
    let grew = true;
    while (grew) {
      grew = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const first = s[0];
        const last = s[s.length - 1];
        if (haversine(tail, first) < tolerance) chain = chain.concat(s.slice(1));
        else if (haversine(tail, last) < tolerance) chain = chain.concat(s.slice(0, -1).reverse());
        else if (haversine(head, last) < tolerance) chain = s.slice(0, -1).concat(chain);
        else if (haversine(head, first) < tolerance) chain = s.slice(1).reverse().concat(chain);
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    const len = lineLength(chain);
    if (len > bestLen) {
      best = chain;
      bestLen = len;
    }
  }
  return best;
}

export function toGPX(name, coords, elevations) {
  const esc = (s) =>
    String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
  const pts = coords
    .map((c, i) => {
      const ele = elevations && elevations[i] != null ? `<ele>${elevations[i].toFixed(1)}</ele>` : "";
      return `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}">${ele}</trkpt>`;
    })
    .join("\n      ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trota" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <type>running</type>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

const COMPASS = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];
export const compassName = (brg) => COMPASS[Math.round(brg / 45) % 8];
