// Exportación de rutas: puntos con elevación, GPX y curso FIT para Garmin.

import { haversine } from "./geo.js";

// Puntos de la ruta completa (con vueltas) con elevación interpolada desde las muestras.
export function trackPoints(route) {
  const line = route.line;
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]));
  const total = cum[cum.length - 1] || 1;
  const elev = route.elev;
  const eleAt = (d) => {
    if (!elev || elev.length < 2) return null;
    const x = (d / total) * (elev.length - 1);
    const i = Math.min(Math.floor(x), elev.length - 2);
    const f = x - i;
    return elev[i] + (elev[i + 1] - elev[i]) * f;
  };
  // Cursos muy largos (muchas vueltas) se limitan para no saturar el reloj.
  const laps = Math.max(1, Math.min(route.laps || 1, Math.floor(20000 / line.length) || 1));
  const pts = [];
  for (let lap = 0; lap < laps; lap++) {
    for (let i = lap === 0 ? 0 : 1; i < line.length; i++) {
      pts.push({ lat: line[i][0], lon: line[i][1], ele: eleAt(cum[i]), dist: lap * total + cum[i] });
    }
  }
  return pts;
}

// ---------- FIT ----------
// Especificación: https://developer.garmin.com/fit/protocol/
const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];
export function fitCrc(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

// Tipos base FIT: [código, tamaño]
const T = {
  enum: [0x00, 1], uint8: [0x02, 1], uint16: [0x84, 2], sint32: [0x85, 4],
  uint32: [0x86, 4], uint32z: [0x8c, 4], string: [0x07, 0],
};

class FitWriter {
  constructor() {
    this.buf = [];
    this.defs = new Map();
  }
  u8(v) { this.buf.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  // fields: [numeroCampo, tipo, valor, tamañoString?]
  message(local, globalNum, fields) {
    const sig = fields.map((f) => `${f[0]}:${f[1]}:${f[3] || ""}`).join(",") + `@${globalNum}`;
    if (this.defs.get(local) !== sig) {
      this.u8(0x40 | local);
      this.u8(0); // reservado
      this.u8(0); // little endian
      this.u16(globalNum);
      this.u8(fields.length);
      for (const [num, type, , strSize] of fields) {
        this.u8(num);
        this.u8(type === "string" ? strSize : T[type][1]);
        this.u8(T[type][0]);
      }
      this.defs.set(local, sig);
    }
    this.u8(local);
    for (const [, type, value, strSize] of fields) {
      if (type === "string") {
        // Recorta por caracteres completos para no partir un carácter UTF-8 (á, ñ…).
        let text = String(value);
        let bytes = new TextEncoder().encode(text);
        while (bytes.length > strSize - 1) {
          text = text.slice(0, -1);
          bytes = new TextEncoder().encode(text);
        }
        for (let i = 0; i < strSize; i++) this.u8(i < bytes.length ? bytes[i] : 0);
      } else if (T[type][1] === 1) this.u8(value);
      else if (T[type][1] === 2) this.u16(value);
      else this.u32(value >>> 0);
    }
  }
  bytes() {
    const data = Uint8Array.from(this.buf);
    const header = new Uint8Array(14);
    const dv = new DataView(header.buffer);
    dv.setUint8(0, 14);
    dv.setUint8(1, 0x20); // protocolo 2.0
    dv.setUint16(2, 2132, true); // versión de perfil 21.32
    dv.setUint32(4, data.length, true);
    header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    dv.setUint16(12, fitCrc(header.subarray(0, 12)), true);
    const crc = fitCrc(data, fitCrc(header));
    const out = new Uint8Array(14 + data.length + 2);
    out.set(header, 0);
    out.set(data, 14);
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = crc >> 8;
    return out;
  }
}

const semicircles = (deg) => Math.round(deg * (2 ** 31 / 180));
const altitude = (m) => Math.max(0, Math.min(65534, Math.round((m + 500) * 5)));

// Curso FIT (tipo "course", deporte running) que Garmin Connect y los relojes Garmin reconocen.
export function toFITCourse(name, points, { gain = 0, loss = 0, paceSecPerKm = 360 } = {}) {
  const w = new FitWriter();
  const start = Math.floor(Date.now() / 1000) - FIT_EPOCH;
  const time = (dist) => start + Math.round((dist / 1000) * paceSecPerKm);
  const first = points[0];
  const last = points[points.length - 1];
  const total = last.dist;

  w.message(0, 0, [ // file_id
    [0, "enum", 6], // tipo: course
    [1, "uint16", 255], // fabricante: development
    [2, "uint16", 0],
    [3, "uint32z", start || 1],
    [4, "uint32", start],
  ]);
  w.message(1, 31, [ // course
    [4, "enum", 1], // deporte: running
    [5, "string", name, 32],
  ]);
  w.message(2, 19, [ // lap
    [253, "uint32", time(total)],
    [2, "uint32", start],
    [3, "sint32", semicircles(first.lat)],
    [4, "sint32", semicircles(first.lon)],
    [5, "sint32", semicircles(last.lat)],
    [6, "sint32", semicircles(last.lon)],
    [7, "uint32", Math.round((time(total) - start) * 1000)],
    [8, "uint32", Math.round((time(total) - start) * 1000)],
    [9, "uint32", Math.round(total * 100)],
    [21, "uint16", Math.round(gain)],
    [22, "uint16", Math.round(loss)],
  ]);
  w.message(3, 21, [ // event: timer start
    [253, "uint32", start],
    [0, "enum", 0],
    [1, "enum", 0],
  ]);
  for (const p of points) {
    w.message(4, 20, [ // record
      [253, "uint32", time(p.dist)],
      [0, "sint32", semicircles(p.lat)],
      [1, "sint32", semicircles(p.lon)],
      [2, "uint16", p.ele == null ? 0xffff : altitude(p.ele)],
      [5, "uint32", Math.round(p.dist * 100)],
    ]);
  }
  w.message(3, 21, [ // event: timer stop_disable_all
    [253, "uint32", time(total)],
    [0, "enum", 0],
    [1, "enum", 9],
  ]);
  return w.bytes();
}
