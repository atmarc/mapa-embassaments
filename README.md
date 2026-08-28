# Aigües Interiors

Static browser map of mainland Spain's official inland standing-water bodies. It overlays MITECO PHC 2022-2027 lake and reservoir polygons on open IGN satellite imagery and labelled street cartography.

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
4. Excludes the `ISLAS BALEARES` hydrological district to match the article's mainland scope.
5. Produces generalized overview and detailed browser layers in `public/data/`.
6. Writes counts, checksums, tolerances, and provenance to `data/metadata/processing-report.json`.

Validate both generated layers and their checksums with:

```bash
python3 scripts/validate_data.py
```

The detailed tolerance is approximately 11 m at 40° N, appropriate for but not more precise than the source's 1:25,000 reference scale. The overview is generalized only for national-scale rendering.

## Data and map services

- Water polygons: [MITECO, Masas de agua superficial PHC 2022-2027](https://www.miteco.gob.es/es/cartografia-y-sig/ide/descargas/agua/masas-de-agua-phc-2022-2027.html)
- Satellite imagery: [IGN PNOA/Sentinel-2 WMTS](https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetCapabilities)
- Streets and labels: [IGN Base Map WMTS](https://www.ign.es/wmts/ign-base?service=WMTS&request=GetCapabilities)
- Scientific context: `1-s2.0-S0959652622003912-main(1).pdf`

The imagery service uses Sentinel-2 at national scales and current 25/50 cm PNOA orthophotos when zoomed in. Water boundaries remain hydrological planning delimitations and may not coincide with a reservoir's current shoreline.

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
