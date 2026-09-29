# Trota · encuentra mapas para trotar

Webapp sencilla para encontrar las mejores rutas para trotar cerca de ti.

1. Pregunta **"¿Dónde quieres trotar hoy?"** y usa tu ubicación (o un lugar que busques).
2. Eliges **distancia** (1, 3, 5, 10, 21 o 42 km), **altimetría** (totalmente plano,
   falsos planos o con altimetría) y el **radio de búsqueda** (1–25 km).
3. Muestra en el mapa las rutas recomendadas, ordenadas por popularidad, ajuste a la
   distancia y terreno, con perfil de elevación, dificultad, descarga **GPX**
   (para Strava, Garmin, etc.) y botón "Llévame ahí" que abre la ruta en Google Maps a pie.

## Cómo funciona

Todo usa servicios abiertos y gratuitos, sin claves de API:

| Qué | Servicio |
| --- | --- |
| Rutas señalizadas (`route=running/fitness_trail/foot/hiking`), pistas atléticas, parques, reservas, cerros e inicios de sendero | OpenStreetMap vía Overpass API (a través de `/api/overpass`, proxy con caché y servidores espejo) |
| Trazado de circuitos por calles, parques y senderos | OSRM, perfil peatonal (routing.openstreetmap.de) |
| Altimetría (desnivel y perfil) | Open‑Meteo Elevation (Copernicus DEM 90 m) |
| Búsqueda de lugares | Nominatim |
| Mapa base (Mapa / Relieve / Satélite) | OpenStreetMap, OpenTopoMap, Esri World Imagery |

**Candidatos:** rutas señalizadas de OSM (completas, tramo ida y vuelta o N vueltas según
la distancia), pistas atléticas (hasta 10 km), circuitos generados desde tu ubicación y
desde los parques más relevantes del radio, y para terreno con desnivel subidas a cerros
e inicios de sendero.

**Terreno** según desnivel positivo por km: `< 10 m/km` plano, `10–25 m/km` falsos
planos, `≥ 25 m/km` con altimetría.

**Puntaje:** `45 % popularidad + 30 % ajuste a la distancia + 25 % ajuste al terreno`.

> **Sobre la popularidad:** Strava no ofrece públicamente su mapa de calor ni sus
> rutas por API, así que la popularidad se estima con OpenStreetMap: rutas de running
> señalizadas puntúan más alto, luego parques/lugares conocidos (con Wikidata) y los
> circuitos que pasan por varios de ellos. Para usar datos reales de uso habría que
> integrar un backend con la API de Strava (OAuth) u otra fuente con datos de actividad.

## Ejecutar

Es un sitio estático (HTML + CSS + JS, sin compilación). La geolocalización del
navegador exige `https` o `localhost`:

```bash
npx http-server -p 8080 .
# abre http://localhost:8080
```

En local, `/api/overpass` no existe y la app consulta Overpass directamente.
Publicada en Vercel (https://trota-mapas.vercel.app), la función `api/overpass.js`
hace de proxy: prueba varios servidores espejo y guarda las respuestas en caché.

## Estructura

```
index.html          Pantalla de inicio (filtros) y de resultados (mapa + lista)
css/styles.css      Estilos; la paleta está en las variables de :root
js/app.js           Interfaz, mapa (Leaflet), geolocalización, GPX
js/routes.js        Motor de recomendación: candidatos, altimetría, puntaje
js/services.js      Clientes de Overpass, OSRM, Open‑Meteo y Nominatim
js/geo.js           Utilidades geográficas
api/overpass.js     Función de Vercel: proxy de Overpass con caché
vendor/leaflet/     Leaflet 1.9.4 (BSD‑2)
```

Los servicios públicos usados tienen límites de uso razonable; para tráfico alto
conviene montar instancias propias (OSRM, Overpass) o usar planes comerciales.
