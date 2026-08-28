#!/usr/bin/env python3
"""Download, validate, and prepare MITECO inland water polygons for the web map."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
PUBLIC_DATA_DIR = ROOT / "public" / "data"
METADATA_DIR = ROOT / "data" / "metadata"
RAW_ARCHIVE = RAW_DIR / "miteco-lakes-phc-2022-2027.geojson.gz"
OVERVIEW_FILE = PUBLIC_DATA_DIR / "inland-waters-overview.geojson"
DETAIL_FILE = PUBLIC_DATA_DIR / "inland-waters-detail.geojson"
INDEX_FILE = PUBLIC_DATA_DIR / "water-index.json"
SUMMARY_FILE = PUBLIC_DATA_DIR / "summary.json"
REPORT_FILE = METADATA_DIR / "processing-report.json"

WFS_ENDPOINT = "https://gis.miteco.gob.es/geoserver/agua/masas_aguaspf_2027_a/wfs"
WFS_PARAMS = {
    "service": "WFS",
    "version": "2.0.0",
    "request": "GetFeature",
    "typeNames": "agua:masas_aguaspf_2027_a",
    "outputFormat": "application/json",
    "srsName": "EPSG:4326",
    "CQL_FILTER": "categoria='Lago'",
}
SOURCE_PAGE = (
    "https://www.miteco.gob.es/es/cartografia-y-sig/ide/descargas/agua/"
    "masas-de-agua-phc-2022-2027.html"
)
VALID_NATURES = {"Natural", "Artificial", "Muy modificada"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-file",
        type=Path,
        help="Use an existing MITECO GeoJSON response instead of downloading it.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Download the WFS response again even if the raw archive exists.",
    )
    return parser.parse_args()


def ensure_directories() -> None:
    for directory in (RAW_DIR, PUBLIC_DATA_DIR, METADATA_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def download_source(target: Path) -> None:
    url = f"{WFS_ENDPOINT}?{urllib.parse.urlencode(WFS_PARAMS)}"
    request = urllib.request.Request(url, headers={"User-Agent": "Aigues-Interiors-map/1.0"})
    print(f"Downloading official MITECO lake polygons from {WFS_ENDPOINT}")
    with urllib.request.urlopen(request, timeout=300) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)


def archive_source(source: Path) -> None:
    with source.open("rb") as input_file, RAW_ARCHIVE.open("wb") as archive:
        with gzip.GzipFile(fileobj=archive, mode="wb", compresslevel=9, mtime=0) as output:
            shutil.copyfileobj(input_file, output)


def load_source(args: argparse.Namespace) -> dict:
    if args.source_file:
        if not args.source_file.exists():
            raise FileNotFoundError(args.source_file)
        archive_source(args.source_file)
        with args.source_file.open(encoding="utf-8") as source:
            return json.load(source)

    if RAW_ARCHIVE.exists() and not args.refresh:
        print(f"Using archived source {RAW_ARCHIVE.relative_to(ROOT)}")
        with gzip.open(RAW_ARCHIVE, "rt", encoding="utf-8") as source:
            return json.load(source)

    with tempfile.NamedTemporaryFile(suffix=".geojson", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        download_source(temporary_path)
        archive_source(temporary_path)
        with temporary_path.open(encoding="utf-8") as source:
            return json.load(source)
    finally:
        temporary_path.unlink(missing_ok=True)


def perpendicular_distance(point: list[float], start: list[float], end: list[float]) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    if dx == 0 and dy == 0:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    numerator = abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0])
    return numerator / math.hypot(dx, dy)


def simplify_line(points: list[list[float]], tolerance: float) -> list[list[float]]:
    if len(points) <= 2:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        start_index, end_index = stack.pop()
        max_distance = 0.0
        max_index = None
        for index in range(start_index + 1, end_index):
            distance = perpendicular_distance(points[index], points[start_index], points[end_index])
            if distance > max_distance:
                max_distance = distance
                max_index = index
        if max_index is not None and max_distance > tolerance:
            keep.add(max_index)
            stack.append((start_index, max_index))
            stack.append((max_index, end_index))
    return [points[index] for index in sorted(keep)]


def radial_simplify(points: list[list[float]], tolerance: float) -> list[list[float]]:
    if len(points) <= 2:
        return points
    squared_tolerance = tolerance * tolerance
    result = [points[0]]
    previous = points[0]
    for point in points[1:-1]:
        dx = point[0] - previous[0]
        dy = point[1] - previous[1]
        if dx * dx + dy * dy > squared_tolerance:
            result.append(point)
            previous = point
    result.append(points[-1])
    return result


def signed_ring_area(ring: list[list[float]]) -> float:
    return 0.5 * sum(
        first[0] * second[1] - second[0] * first[1]
        for first, second in zip(ring, ring[1:])
    )


def valid_ring(ring: list[list[float]]) -> bool:
    return len(set(map(tuple, ring[:-1]))) >= 3 and abs(signed_ring_area(ring)) > 1e-12


def simplify_ring(ring: list[list[float]], tolerance: float, decimals: int) -> list[list[float]]:
    rounded = []
    for point in ring:
        candidate = [round(point[0], decimals), round(point[1], decimals)]
        if not rounded or candidate != rounded[-1]:
            rounded.append(candidate)
    if rounded[0] != rounded[-1]:
        rounded.append(rounded[0])
    open_ring = rounded[:-1]
    if not valid_ring(rounded):
        return []

    # Rotate away from an arbitrary ring closure before Douglas-Peucker simplification.
    anchor = min(range(len(open_ring)), key=lambda index: (open_ring[index][0], open_ring[index][1]))
    rotated = open_ring[anchor:] + open_ring[:anchor] + [open_ring[anchor]]
    simplified = simplify_line(radial_simplify(rotated, tolerance), tolerance)
    if simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    if not valid_ring(simplified):
        return rounded if valid_ring(rounded) else []
    return simplified


def simplify_geometry(geometry: dict, tolerance: float, decimals: int) -> dict:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        rings = [simplify_ring(ring, tolerance, decimals) for ring in coordinates]
        if not rings[0]:
            return {}
        result = [rings[0], *(ring for ring in rings[1:] if ring)]
    elif geometry_type == "MultiPolygon":
        result = []
        for polygon in coordinates:
            rings = [simplify_ring(ring, tolerance, decimals) for ring in polygon]
            if rings[0]:
                result.append([rings[0], *(ring for ring in rings[1:] if ring)])
        if not result:
            return {}
    else:
        raise ValueError(f"Unsupported geometry type: {geometry_type}")
    return {"type": geometry_type, "coordinates": result}


def count_points(geometry: dict) -> int:
    coordinates = geometry["coordinates"]
    if geometry["type"] == "Polygon":
        return sum(len(ring) for ring in coordinates)
    return sum(len(ring) for polygon in coordinates for ring in polygon)


def classify(properties: dict) -> str:
    nature = properties["naturldad"]
    if nature == "Natural":
        return "natural"
    if nature == "Artificial":
        return "artificial"
    return "modified"


def clean_properties(properties: dict) -> dict:
    area = properties.get("area_masa")
    reservoir = (properties.get("embalse") or "").strip()
    return {
        "id": properties["cod_masa"],
        "name": properties.get("nombre_masa") or "Sense nom",
        "nature": properties["naturldad"],
        "class": classify(properties),
        "isReservoir": bool(reservoir and reservoir != "Not a reservoir"),
        "district": properties.get("nom_ddhh") or "",
        "areaKm2": area if isinstance(area, (int, float)) and area >= 0 else None,
        "type": properties.get("nom_tipo_na") or "",
        "sourceVersion": properties.get("version_id") or "2022-2027",
    }


def feature_collection(features: list[dict], tolerance: float, decimals: int) -> dict:
    output = []
    for feature in features:
        geometry = simplify_geometry(feature["geometry"], tolerance, decimals)
        if geometry:
            output.append({
                "type": "Feature",
                "id": feature["properties"]["id"],
                "properties": feature["properties"],
                "geometry": geometry,
            })
    return {"type": "FeatureCollection", "features": output}


def geometry_center(geometry: dict) -> list[float]:
    coordinates = []
    if geometry["type"] == "Polygon":
        coordinates = geometry["coordinates"][0]
    else:
        coordinates = [point for polygon in geometry["coordinates"] for point in polygon[0]]
    longitudes = [point[0] for point in coordinates]
    latitudes = [point[1] for point in coordinates]
    return [round((min(longitudes) + max(longitudes)) / 2, 5), round((min(latitudes) + max(latitudes)) / 2, 5)]


def write_json(path: Path, data: dict, pretty: bool = False) -> None:
    with path.open("w", encoding="utf-8") as output:
        json.dump(
            data,
            output,
            ensure_ascii=False,
            indent=2 if pretty else None,
            separators=None if pretty else (",", ":"),
        )
        output.write("\n")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def process(source: dict) -> None:
    source_features = source.get("features", [])
    rejected = Counter()
    cleaned: list[dict] = []
    ids: set[str] = set()
    source_points = 0

    for feature in source_features:
        properties = feature.get("properties") or {}
        if properties.get("categoria") != "Lago":
            rejected["not_lake"] += 1
            continue
        if properties.get("naturldad") not in VALID_NATURES:
            rejected["unknown_nature"] += 1
            continue
        if properties.get("nom_ddhh") == "ISLAS BALEARES":
            rejected["balearic_islands"] += 1
            continue
        identifier = properties.get("cod_masa")
        if not identifier or identifier in ids:
            rejected["missing_or_duplicate_id"] += 1
            continue
        geometry = feature.get("geometry")
        if not geometry or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
            rejected["invalid_geometry"] += 1
            continue
        ids.add(identifier)
        source_points += count_points(geometry)
        cleaned.append({"properties": clean_properties(properties), "geometry": geometry})

    if not cleaned:
        raise RuntimeError("No valid mainland lake features found")

    # Overview tolerance is about 110 m; detail tolerance is about 11 m at 40 N.
    overview = feature_collection(cleaned, tolerance=0.001, decimals=5)
    detail = feature_collection(cleaned, tolerance=0.0001, decimals=5)
    if len(overview["features"]) != len(cleaned) or len(detail["features"]) != len(cleaned):
        raise RuntimeError("Geometry cleanup removed a complete water body")
    write_json(OVERVIEW_FILE, overview)
    write_json(DETAIL_FILE, detail)
    index = [
        {**feature["properties"], "center": geometry_center(feature["geometry"])}
        for feature in cleaned
    ]
    index.sort(key=lambda item: (item["name"].casefold(), item["id"]))
    write_json(INDEX_FILE, index)

    classifications = Counter(feature["properties"]["class"] for feature in cleaned)
    known_area = sum(feature["properties"]["areaKm2"] or 0 for feature in cleaned)
    summary = {
        "featureCount": len(cleaned),
        "areaKm2": round(known_area, 2),
        "classifications": dict(sorted(classifications.items())),
        "planningCycle": "2022-2027",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    write_json(SUMMARY_FILE, summary, pretty=True)

    overview_points = sum(count_points(feature["geometry"]) for feature in overview["features"])
    detail_points = sum(count_points(feature["geometry"]) for feature in detail["features"])
    report = {
        **summary,
        "source": {
            "title": "Masas de agua superficial (polígonos) PHC 2022-2027",
            "page": SOURCE_PAGE,
            "wfs": WFS_ENDPOINT,
            "filter": WFS_PARAMS["CQL_FILTER"],
            "crs": source.get("crs"),
            "rawFeatureCount": len(source_features),
            "rawArchive": str(RAW_ARCHIVE.relative_to(ROOT)),
            "rawArchiveSha256": sha256(RAW_ARCHIVE),
        },
        "processing": {
            "scope": "Mainland Spain",
            "excluded": dict(sorted(rejected.items())),
            "sourcePoints": source_points,
            "overviewPoints": overview_points,
            "detailPoints": detail_points,
            "overviewToleranceDegrees": 0.001,
            "detailToleranceDegrees": 0.0001,
            "coordinateDecimals": 5,
            "coordinateProcessing": "Round each ring to 5 decimals and remove consecutive duplicates before simplification",
            "simplification": "Radial-distance pre-pass followed by Douglas-Peucker on each ring in EPSG:4326 degrees",
        },
        "outputs": {
            "overviewBytes": OVERVIEW_FILE.stat().st_size,
            "detailBytes": DETAIL_FILE.stat().st_size,
            "indexBytes": INDEX_FILE.stat().st_size,
            "overviewSha256": sha256(OVERVIEW_FILE),
            "detailSha256": sha256(DETAIL_FILE),
        },
        "attribution": "© Ministerio para la Transición Ecológica y el Reto Demográfico",
    }
    write_json(REPORT_FILE, report, pretty=True)
    print(
        f"Prepared {len(cleaned)} mainland water bodies: "
        f"{OVERVIEW_FILE.stat().st_size / 1_000_000:.1f} MB overview, "
        f"{DETAIL_FILE.stat().st_size / 1_000_000:.1f} MB detail"
    )


def main() -> int:
    args = parse_args()
    ensure_directories()
    try:
        process(load_source(args))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"Data build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
