#!/usr/bin/env python3
"""Validate generated inland-water web data and its provenance report."""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OVERVIEW = ROOT / "public" / "data" / "inland-waters-overview.geojson"
DETAIL = ROOT / "public" / "data" / "inland-waters-detail.geojson"
SUMMARY = ROOT / "public" / "data" / "summary.json"
REPORT = ROOT / "data" / "metadata" / "processing-report.json"
INDEX = ROOT / "public" / "data" / "water-index.json"
VALID_CLASSES = {"natural", "artificial", "modified"}


def load(path: Path) -> dict:
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def rings(geometry: dict):
    if geometry["type"] == "Polygon":
        yield from geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield from polygon
    else:
        raise AssertionError(f"Unexpected geometry type {geometry['type']}")


def signed_ring_area(ring: list[list[float]]) -> float:
    return 0.5 * sum(
        first[0] * second[1] - second[0] * first[1]
        for first, second in zip(ring, ring[1:])
    )


def validate_collection(path: Path, expected_count: int) -> Counter:
    collection = load(path)
    assert collection["type"] == "FeatureCollection"
    assert len(collection["features"]) == expected_count
    identifiers = set()
    classes = Counter()
    for feature in collection["features"]:
        properties = feature["properties"]
        identifier = properties["id"]
        assert identifier and identifier not in identifiers
        identifiers.add(identifier)
        assert properties["class"] in VALID_CLASSES
        assert properties["district"] != "ISLAS BALEARES"
        classes[properties["class"]] += 1
        for ring in rings(feature["geometry"]):
            assert len(ring) >= 4, f"Short ring in {identifier}"
            assert ring[0] == ring[-1], f"Open ring in {identifier}"
            assert len(set(map(tuple, ring[:-1]))) >= 3, f"Degenerate ring in {identifier}"
            assert abs(signed_ring_area(ring)) > 1e-12, f"Zero-area ring in {identifier}"
            for longitude, latitude, *_ in ring:
                assert -10.0 <= longitude <= 4.5, f"Longitude out of scope in {identifier}"
                assert 35.0 <= latitude <= 44.0, f"Latitude out of scope in {identifier}"
    return classes


def main() -> int:
    try:
        summary = load(SUMMARY)
        report = load(REPORT)
        expected_count = summary["featureCount"]
        overview_classes = validate_collection(OVERVIEW, expected_count)
        detail_classes = validate_collection(DETAIL, expected_count)
        expected_classes = Counter(summary["classifications"])
        assert overview_classes == expected_classes
        assert detail_classes == expected_classes
        index = load(INDEX)
        assert len(index) == expected_count
        assert {item["id"] for item in index} == {
            feature["properties"]["id"] for feature in load(OVERVIEW)["features"]
        }
        assert report["outputs"]["overviewSha256"] == sha256(OVERVIEW)
        assert report["outputs"]["detailSha256"] == sha256(DETAIL)
        assert report["processing"]["excluded"].get("balearic_islands", 0) >= 0
    except (AssertionError, KeyError, OSError, json.JSONDecodeError) as error:
        print(f"Validation failed: {error}", file=sys.stderr)
        return 1
    print(
        f"Validated {expected_count} mainland water bodies "
        f"({', '.join(f'{name}: {count}' for name, count in sorted(expected_classes.items()))})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
