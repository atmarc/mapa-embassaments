# Aigües Interiors

Static browser map of mainland Spain's official inland standing-water bodies. It overlays MITECO PHC 2022-2027 lake and reservoir polygons on open IGN satellite imagery and vector street cartography.

You can [view and try the map here](https://atmarc.github.io/mapa-embassaments/).

## Run locally

The generated data is included. Start any static HTTP server from the repository root:

```bash
python3 -m http.server 8000 --directory public
```

Open <http://localhost:8000>.

Opening `public/index.html` directly is not supported because browsers restrict local GeoJSON requests.

## Rebuild the data

The pipeline uses only Python's standard library:

```bash
python3 scripts/build_data.py
```

Use `--refresh` to download the WFS data again. The script:

1. Requests MITECO surface-water polygons with `categoria='Lago'`.
2. Archives the unmodified response as compressed GeoJSON in `data/raw/`.
3. Keeps natural, artificial, and heavily modified standing water.
4. Excludes the two records in the `ISLAS BALEARES` hydrological district.
5. For each ring, rounds coordinates to five decimals, removes consecutive duplicates, then applies a radial-distance pre-pass followed by Douglas-Peucker simplification in EPSG:4326 degrees.
6. Produces generalized overview and more detailed browser layers in `public/data/`.
7. Writes counts, checksums, tolerances, and provenance to `data/metadata/processing-report.json`.

Validate both generated layers and their checksums with:

```bash
python3 scripts/validate_data.py
```

The overview tolerance is 0.001° and the more detailed tolerance is 0.0001°. At 40° N these angular values correspond approximately to 111 m north-south and 85 m east-west, and 11 m and 8.5 m respectively. These are directional approximations for the application's generalization, not positional-accuracy claims. The algorithm operates in geographic degrees, and the source's 1:25,000 reference scale does not guarantee a specific error in metres.

## Data and map services

- Water polygons: [MITECO, Masas de agua superficial PHC 2022-2027](https://www.miteco.gob.es/es/cartografia-y-sig/ide/descargas/agua/masas-de-agua-phc-2022-2027.html)
- Satellite imagery: [IGN PNOA/Sentinel-2 WMTS](https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetCapabilities)
- Streets and labels: [IGN Mapabase vector tiles and styles](https://ideespain.github.io/mapabase/servicios/estilos/)

The imagery service uses Sentinel-2 at national scales and current 25/50 cm PNOA orthophotos when zoomed in. Labels are rendered from vectors in both basemap modes. Foreign land is muted at territorial scales to distinguish it from the mainland Spanish coverage. Water boundaries remain hydrological planning delimitations and may not coincide with a reservoir's current shoreline.

## Attribution and licenses

Water data must be attributed as:

> Fuente: «© Ministerio para la Transición Ecológica y el Reto Demográfico».

IGN/SCNE map and imagery services are provided under CC BY 4.0. MapLibre GL JS is used under its open-source BSD license and loaded from a pinned CDN version.

## Deploy

Publish the `public/` directory on Cloudflare Pages, GitHub Pages, Netlify, or another static host. No server-side application or API key is required. Keep the MITECO and IGN services in the Content Security Policy if one is added at the host level.

## Project layout

```text
public/                  Deployable static website
public/data/             Generated browser data
scripts/build_data.py    Reproducible download and processing pipeline
data/raw/                Compressed official source response
data/metadata/           Processing report and checksums
```
