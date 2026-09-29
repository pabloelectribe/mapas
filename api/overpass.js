// Proxy de Overpass (Vercel Function): prueba varios servidores espejo,
// se identifica con User-Agent como pide la política de uso de Overpass
// y deja la respuesta en la caché del CDN para no repetir consultas.

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const MAX_QUERY = 4000;

async function readQuery(request) {
  if (request.method === "GET") return new URL(request.url).searchParams.get("data");
  const body = await request.text();
  return new URLSearchParams(body).get("data");
}

async function handle(request) {
  const query = await readQuery(request);
  if (!query || query.length > MAX_QUERY || !query.startsWith("[out:json]")) {
    return Response.json({ error: "Consulta inválida" }, { status: 400 });
  }
  const errors = [];
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Trota/1.0 (https://trota-mapas.vercel.app)",
        },
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith("{")) {
        errors.push(`${new URL(endpoint).host}: HTTP ${res.status}`);
        continue;
      }
      return new Response(text, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
          "X-Overpass-Endpoint": new URL(endpoint).host,
        },
      });
    } catch (e) {
      errors.push(`${new URL(endpoint).host}: ${e.name === "TimeoutError" ? "timeout" : e.message}`);
    }
  }
  return Response.json({ error: "Overpass no respondió", detail: errors }, { status: 502 });
}

export const GET = handle;
export const POST = handle;
export const config = { maxDuration: 60 };
