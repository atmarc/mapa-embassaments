/* global maplibregl */

const WATER_COLORS = {
  natural: "#007cb6",
  artificial: "#20acd0",
  modified: "#d8873f",
};

const WMTS_BASE = "https://www.ign.es/wmts";
const STREET_STYLE_URL = "https://vt-mapabase.idee.es/files/styles/mapaBase_scn_color1_CNIG.json";
const IGN_VECTOR_TILES = "https://vt-mapabase.idee.es/1.0.0/mapabase/{z}/{x}/{y}.pbf";
const MAINLAND_BOUNDS = [[-9.55, 35.7], [3.35, 43.9]];
const wmtsUrl = (service, layer, format) =>
  `${WMTS_BASE}/${service}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
  `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible` +
  `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;

const LABEL_LAYER_IDS = [
  "label-water-lines",
  "label-water-reservoirs",
  "label-water-bodies",
  "label-waterways",
  "label-country",
  "label-regions",
  "label-provinces",
  "label-overview-capital",
  "label-overview-places",
  "label-minor-places",
  "label-other-minor-places",
  "label-singular-places",
  "label-population-centres",
  "label-municipal-capitals",
  "label-provincial-capitals",
  "label-regional-capitals",
  "label-national-capital",
];

const state = {
  basemap: "satellite",
  detailLoaded: false,
  detailLoading: false,
  hovered: null,
  selected: null,
  enabledClasses: new Set(["natural", "artificial", "modified"]),
  index: new Map(),
  restoring: true,
};

const streetLayerVisibility = new Map();

function initialFitPadding() {
  if (window.innerWidth <= 720) {
    return {
      top: Math.min(300, window.innerHeight * 0.38),
      right: 22,
      bottom: Math.min(165, window.innerHeight * 0.22),
      left: 22,
    };
  }
  return { top: 34, right: 34, bottom: 34, left: 34 };
}

const map = new maplibregl.Map({
  container: "map",
  bounds: MAINLAND_BOUNDS,
  fitBoundsOptions: { padding: initialFitPadding(), maxZoom: 5 },
  minZoom: 4,
  maxZoom: 19,
  attributionControl: false,
  style: STREET_STYLE_URL,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

function waterFillLayer(id, source, minzoom, maxzoom) {
  return {
    id,
    type: "fill",
    source,
    minzoom,
    maxzoom,
    paint: {
      "fill-color": ["match", ["get", "class"], "natural", WATER_COLORS.natural, "artificial", WATER_COLORS.artificial, WATER_COLORS.modified],
      "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.67, ["boolean", ["feature-state", "hover"], false], 0.54, 0.34],
    },
  };
}

function waterLineLayer(id, source, minzoom, maxzoom) {
  return {
    id,
    type: "line",
    source,
    minzoom,
    maxzoom,
    paint: {
      "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#f7f3dc", "#004e72"],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        ["case", ["boolean", ["feature-state", "selected"], false], 3.5, 0.8],
        14,
        ["case", ["boolean", ["feature-state", "selected"], false], 3.5, 2.1],
      ],
      "line-opacity": 0.96,
    },
  };
}

function ignLabelLayer(id, sourceLayer, minzoom, maxzoom, filter, layout = {}, paint = {}) {
  return {
    id,
    type: "symbol",
    source: "mapaBaseXYZ",
    "source-layer": sourceLayer,
    minzoom,
    maxzoom,
    filter,
    layout: {
      visibility: "visible",
      "text-field": ["get", "nombre"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-keep-upright": true,
      "text-padding": 2,
      ...layout,
    },
    paint: {
      "text-color": "rgba(25, 35, 35, 0.9)",
      "text-halo-color": "rgba(255, 255, 255, 0.92)",
      "text-halo-width": 1.25,
      ...paint,
    },
  };
}

function addApplicationLayers() {
  const officialLayers = map.getStyle().layers || [];
  for (const layer of [...officialLayers].reverse()) map.removeLayer(layer.id);
  if (map.getSource("mapaBaseXYZ")) map.removeSource("mapaBaseXYZ");
  map.addSource("mapaBaseXYZ", {
    type: "vector",
    tiles: [IGN_VECTOR_TILES],
    minzoom: 0,
    maxzoom: 17,
    attribution: "© IGN/SCNE",
  });

  for (const layer of officialLayers) {
    if (layer.type === "symbol") continue;
    const normalized = { ...layer };
    if (normalized.maxZoom !== undefined && normalized.maxzoom === undefined) normalized.maxzoom = normalized.maxZoom;
    if (normalized.minZoom !== undefined && normalized.minzoom === undefined) normalized.minzoom = normalized.minZoom;
    delete normalized.maxZoom;
    delete normalized.minZoom;
    map.addLayer(normalized);
    streetLayerVisibility.set(normalized.id, normalized.layout?.visibility || "visible");
  }

  const firstOfficialLayer = map.getStyle().layers[0]?.id;

  map.addSource("satellite", {
    type: "raster",
    tiles: [wmtsUrl("pnoa-ma", "OI.OrthoimageCoverage", "image/jpeg")],
    tileSize: 256,
    maxzoom: 20,
    attribution: "© <a href='https://www.ign.es/' target='_blank'>IGN/SCNE</a>, CC BY 4.0",
  });
  map.addLayer({ id: "satellite", type: "raster", source: "satellite" }, firstOfficialLayer);

  map.addSource("water-overview", {
    type: "geojson",
    data: "data/inland-waters-overview.geojson",
    promoteId: "id",
    attribution: "© Ministerio para la Transición Ecológica y el Reto Demográfico",
  });

  map.addLayer({
    id: "inactive-countries",
    type: "fill",
    source: "mapaBaseXYZ",
    "source-layer": "contexto_territorios_pol",
    minzoom: 0,
    maxzoom: 12,
    filter: [
      "all",
      ["==", ["get", "clase"], "tierra_firme"],
      ["!=", ["get", "esp"], 1],
    ],
    paint: {
      "fill-color": "#aeb7b3",
      "fill-opacity": 0.7,
    },
  });
  map.addLayer(waterFillLayer("water-overview-fill", "water-overview", 0, 24));
  map.addLayer(waterLineLayer("water-overview-line", "water-overview", 0, 24));
  for (const layer of ignLabelLayers()) map.addLayer(layer);
}

function ignLabelLayers() {
  const equals = (value) => ["==", ["get", "clase"], value];
  const placeSize = ["interpolate", ["linear"], ["zoom"], 9, 11, 12, 14];
  const waterPaint = { "text-color": "#176f9f", "text-halo-color": "rgba(255, 255, 255, 0.94)" };
  const lineLayout = { "symbol-placement": "line", "text-max-angle": 45 };

  return [
    ignLabelLayer("label-water-lines", "nombre_toponimo_lin", 7, 22, equals("hidrografia"), {
      ...lineLayout,
      "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 17, 13],
    }, waterPaint),
    ignLabelLayer("label-water-reservoirs", "nombre_hidrografia_pto", 10, 22, equals("embalse"), {
      "text-font": ["Deja Vu Serif Italic"],
    }, waterPaint),
    ignLabelLayer("label-water-bodies", "nombre_hidrografia_pto", 10, 22, equals("masa_agua"), {
      "text-font": ["Noto Sans Italic"],
      "text-size": 10,
    }, waterPaint),
    ignLabelLayer("label-waterways", "hidrografia_lin", 13, 23, ["!=", ["get", "nombre"], "Desconocido"], {
      ...lineLayout,
      "text-size": 13,
      "text-padding": 5,
    }, waterPaint),
    ignLabelLayer("label-country", "nombre_division_administrativa_pto", 3, 5.5, equals("nacion"), {
      "text-transform": "uppercase",
    }, { "text-color": "rgba(55, 65, 65, 0.82)" }),
    ignLabelLayer("label-regions", "nombre_division_administrativa_pto", 5, 7.5, [
      "match", ["get", "clase"], ["comunidad_autonoma", "ciudad_autonoma"], true, false,
    ], { "text-transform": "uppercase" }, { "text-color": "rgba(55, 65, 65, 0.82)" }),
    ignLabelLayer("label-provinces", "nombre_division_administrativa_pto", 6, 9, equals("provincia"), {
      "text-transform": "uppercase",
      "text-size": 11,
    }, { "text-color": "rgba(65, 75, 75, 0.82)" }),
    ignLabelLayer("label-overview-capital", "contexto_nombre_poblacion_pto", 3, 7, equals("capital_estado"), {
      "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 7, 13],
      "text-offset": [0.8, -0.8],
    }),
    ignLabelLayer("label-overview-places", "contexto_nombre_poblacion_pto", 5, 7, equals("nucleo_poblacion"), {
      "text-size": 10,
      "text-offset": [0.8, -0.8],
    }),
    ignLabelLayer("label-minor-places", "nombre_poblacion_construccion_pto", 10, 22, equals("entidad_menor_poblacion"), {
      "text-font": ["Noto Sans Italic"], "text-size": 10,
    }),
    ignLabelLayer("label-other-minor-places", "nombre_poblacion_construccion_pto", 10, 22, equals("otra_entidad_menor_poblacion"), {
      "text-font": ["Noto Sans Italic"], "text-size": 10,
    }),
    ignLabelLayer("label-singular-places", "nombre_poblacion_construccion_pto", 10, 22, equals("entidad_singular_INE"), {
      "text-font": ["Noto Sans Italic"], "text-size": 10,
    }),
    ignLabelLayer("label-population-centres", "nombre_poblacion_construccion_pto", 9, 23, equals("nucleo_poblacion"), {
      "text-size": placeSize,
    }),
    ignLabelLayer("label-municipal-capitals", "nombre_poblacion_construccion_pto", 9, 23, equals("capital_municipio"), {
      "text-size": placeSize,
    }),
    ignLabelLayer("label-provincial-capitals", "nombre_poblacion_construccion_pto", 8, 22, equals("capital_provincia"), {
      "text-size": 12,
    }),
    ignLabelLayer("label-regional-capitals", "nombre_poblacion_construccion_pto", 7, 22, equals("capital_comunidad_autonoma_ciudad_autonoma"), {
      "text-size": 13,
    }),
    ignLabelLayer("label-national-capital", "nombre_poblacion_construccion_pto", 7, 22, equals("capital_estado"), {
      "text-size": 18,
    }),
  ];
}

map.on("load", async () => {
  addApplicationLayers();
  bindLayerEvents("water-overview-fill", "water-overview");
  if (new URLSearchParams(location.search).get("base") === "street") state.basemap = "street";
  setBasemap(state.basemap);
  document.getElementById("basemap-toggle").disabled = false;
  await loadMetadata();
  restoreUrlState();
  updateZoomMessage();
  document.getElementById("loading").hidden = true;
  document.getElementById("map").classList.add("ready");
});

map.on("zoomend", () => {
  if (map.getZoom() >= 10.35) loadDetailLayer();
  updateZoomMessage();
  updateUrlState();
});
map.on("moveend", updateUrlState);

async function loadDetailLayer() {
  if (state.detailLoaded || state.detailLoading) return;
  state.detailLoading = true;
  const zoomMessage = document.getElementById("map-status");
  zoomMessage.textContent = "Carregant els contorns detallats…";
  try {
    const response = await fetch("data/inland-waters-detail.geojson");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    map.addSource("water-detail", { type: "geojson", data, promoteId: "id", attribution: "© MITECO" });
    map.addLayer(waterFillLayer("water-detail-fill", "water-detail", 10.85, 24), LABEL_LAYER_IDS[0]);
    map.addLayer(waterLineLayer("water-detail-line", "water-detail", 10.85, 24), LABEL_LAYER_IDS[0]);
    bindLayerEvents("water-detail-fill", "water-detail");
    map.setLayerZoomRange("water-overview-fill", 0, 11.15);
    map.setLayerZoomRange("water-overview-line", 0, 11.15);
    applyClassFilter();
    state.detailLoaded = true;
    if (state.selected) setFeatureState(state.selected.id, "selected", true);
  } catch (error) {
    console.error("Could not load detailed water geometry", error);
    zoomMessage.textContent = "No s'ha pogut carregar el detall; es manté el contorn general.";
  } finally {
    state.detailLoading = false;
    updateZoomMessage();
  }
}

function bindLayerEvents(layerId, sourceId) {
  map.on("mousemove", layerId, (event) => {
    map.getCanvas().style.cursor = "pointer";
    const feature = event.features?.[0];
    if (!feature) return;
    if (state.hovered && (state.hovered.id !== feature.id || state.hovered.source !== sourceId)) {
      map.setFeatureState(state.hovered, { hover: false });
    }
    state.hovered = { source: sourceId, id: feature.id };
    map.setFeatureState(state.hovered, { hover: true });
  });
  map.on("mouseleave", layerId, () => {
    map.getCanvas().style.cursor = "";
    if (state.hovered) map.setFeatureState(state.hovered, { hover: false });
    state.hovered = null;
  });
  map.on("click", layerId, (event) => {
    const feature = event.features?.[0];
    if (feature) selectFeature(feature);
  });
}

function selectFeature(feature) {
  if (state.selected) setFeatureState(state.selected.id, "selected", false);
  state.selected = { id: feature.properties.id, properties: feature.properties };
  setFeatureState(state.selected.id, "selected", true);
  renderDetails(state.selected.properties);
  updateUrlState();
}

function setFeatureState(id, property, value) {
  for (const source of ["water-overview", "water-detail"]) {
    if (map.getSource(source)) map.setFeatureState({ source, id }, { [property]: value });
  }
}

function renderDetails(properties) {
  const labels = { natural: "Natural", artificial: "Artificial", modified: "Molt modificada" };
  document.getElementById("details-class").textContent = properties.isReservoir ? "Embassament" : "Massa d'aigua interior";
  document.getElementById("details-title").textContent = properties.name;
  document.getElementById("details-hint").hidden = true;
  document.getElementById("details-data").hidden = false;
  document.getElementById("details-nature").textContent = labels[properties.class] || properties.nature;
  document.getElementById("details-area").textContent = properties.areaKm2 ? `${Number(properties.areaKm2).toLocaleString("ca-ES")} km²` : "No disponible";
  document.getElementById("details-district").textContent = titleCase(properties.district);
  document.getElementById("details-id").textContent = properties.id;
}

function titleCase(value) {
  return value.toLocaleLowerCase("ca-ES").replace(/(^|\s|-)\p{L}/gu, (letter) => letter.toLocaleUpperCase("ca-ES"));
}

function clearSelection() {
  if (state.selected) setFeatureState(state.selected.id, "selected", false);
  state.selected = null;
  document.getElementById("details-class").textContent = "Massa d'aigua";
  document.getElementById("details-title").textContent = "Selecciona un llac o embassament";
  document.getElementById("details-hint").hidden = false;
  document.getElementById("details-data").hidden = true;
  updateUrlState();
}

function setBasemap(name) {
  state.basemap = name;
  map.setLayoutProperty("satellite", "visibility", name === "satellite" ? "visible" : "none");
  for (const [layerId, visibility] of streetLayerVisibility) {
    map.setLayoutProperty(layerId, "visibility", name === "street" ? visibility : "none");
  }
  const button = document.getElementById("basemap-toggle");
  const isSatellite = name === "satellite";
  button.dataset.basemap = name;
  document.getElementById("basemap-label").textContent = isSatellite ? "Satèl·lit" : "Carrers";
  button.setAttribute("aria-label", isSatellite ? "Mapa base actual: satèl·lit. Canvia a carrers" : "Mapa base actual: carrers. Canvia a satèl·lit");
  updateUrlState();
}

function applyClassFilter() {
  const values = [...state.enabledClasses];
  const filter = ["in", ["get", "class"], ["literal", values]];
  for (const layer of ["water-overview-fill", "water-overview-line", "water-detail-fill", "water-detail-line"]) {
    if (map.getLayer(layer)) map.setFilter(layer, filter);
  }
}

async function loadMetadata() {
  try {
    const [summaryResponse, indexResponse] = await Promise.all([
      fetch("data/summary.json"),
      fetch("data/water-index.json"),
    ]);
    const [summary, index] = await Promise.all([summaryResponse.json(), indexResponse.json()]);
    document.getElementById("feature-count").textContent = summary.featureCount.toLocaleString("ca-ES");
    for (const name of ["natural", "artificial", "modified"]) {
      document.getElementById(`${name}-count`).textContent = summary.classifications[name]?.toLocaleString("ca-ES") || "0";
    }
    const options = document.getElementById("water-options");
    for (const record of index) {
      const label = `${record.name} — ${record.id}`;
      state.index.set(label, record);
      state.index.set(record.id, record);
      const option = document.createElement("option");
      option.value = label;
      options.append(option);
    }
  } catch (error) {
    console.warn("Map metadata could not be loaded", error);
  }
}

function updateZoomMessage() {
  if (state.detailLoading) return;
  const message = document.getElementById("map-status");
  if (map.getZoom() < 10.35) message.textContent = "Apropa't per carregar un contorn més detallat, generalitzat des de la font 1:25.000.";
  else if (state.detailLoaded) message.textContent = "Contorn més detallat carregat · generalització d'una font 1:25.000.";
}

function updateUrlState() {
  if (state.restoring) return;
  const center = map.getCenter();
  const params = new URLSearchParams();
  params.set("map", `${map.getZoom().toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`);
  if (state.basemap !== "satellite") params.set("base", state.basemap);
  if (state.selected) params.set("water", state.selected.id);
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}

function restoreUrlState() {
  state.restoring = true;
  const params = new URLSearchParams(location.search);
  const mapState = params.get("map")?.split("/").map(Number);
  if (mapState?.length === 3 && mapState.every(Number.isFinite)) {
    map.jumpTo({ zoom: mapState[0], center: [mapState[2], mapState[1]] });
  }
  if (params.get("base") === "street") setBasemap("street");
  const selectedId = params.get("water");
  if (selectedId && state.index.has(selectedId)) {
    const record = state.index.get(selectedId);
    state.selected = { id: record.id, properties: record };
    setFeatureState(record.id, "selected", true);
    renderDetails(record);
  }
  if (map.getZoom() >= 10.35) loadDetailLayer();
  state.restoring = false;
  updateUrlState();
}

document.getElementById("basemap-toggle").addEventListener("click", () => {
  setBasemap(state.basemap === "satellite" ? "street" : "satellite");
});

document.querySelectorAll(".filter-list input").forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.enabledClasses.add(checkbox.value);
    else state.enabledClasses.delete(checkbox.value);
    applyClassFilter();
  });
});

document.getElementById("close-details").addEventListener("click", clearSelection);

document.getElementById("water-search").addEventListener("change", (event) => {
  const record = state.index.get(event.currentTarget.value);
  if (!record) return;
  if (state.selected) setFeatureState(state.selected.id, "selected", false);
  state.selected = { id: record.id, properties: record };
  setFeatureState(record.id, "selected", true);
  renderDetails(record);
  const camera = { center: record.center, zoom: Math.max(map.getZoom(), 10.5) };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) map.jumpTo(camera);
  else map.flyTo(camera);
});

const aboutDialog = document.getElementById("about-dialog");
document.getElementById("about-button").addEventListener("click", () => aboutDialog.showModal());
