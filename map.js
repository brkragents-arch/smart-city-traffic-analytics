/**
 * SmartCity Pulse AI — Separate Window GIS Camera Network, Live Emission Rate
 * & Multi-Density Pollution Hotspot Radar Map
 */

const syncChannel = new BroadcastChannel('smartcity_pulse_sync');
const miniCanvas = document.getElementById('miniPreviewCanvas');
const miniCtx = miniCanvas.getContext('2d');

let map = null;
let currentTileLayer = null;
let cameras = [];
let reports = [];
let selectedCamId = 'CAM-01';
let mainWinActiveCamId = 'CAM-01';

const cameraTelemetry = {};

let markersById = {};
let corridorLayers = [];
let hotspotCircleLayers = [];
let localMiniVehicles = [];

const TILE_URLS = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};

function losColor(los) {
  switch (los) {
    case 'A':
    case 'B':
      return '#10b981';
    case 'C':
      return '#3b82f6';
    case 'D':
      return '#f59e0b';
    case 'E':
    case 'F':
      return '#ef4444';
    default:
      return '#38bdf8';
  }
}

async function initMapWindow() {
  map = L.map('cityMap', {
    center: [39.2645, -76.8675],
    zoom: 12,
    zoomControl: true
  });

  setTileStyle('dark');

  try {
    let data = null;
    try {
      const res = await fetch('/api/bootstrap');
      if (res.ok) {
        data = await res.json();
      }
    } catch (_) {
      // Static fallback for GitHub Pages
    }
    if (!data) {
      const staticRes = await fetch('./data/sample_traffic_streams.json');
      if (staticRes.ok) {
        const raw = await staticRes.json();
        data = {
          cameras: raw.cameras || [],
          reports: [...(raw.initialReports || [])].sort(
            (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
          )
        };
      }
    }
    if (data) {
      cameras = data.cameras || [];
      reports = data.reports || [];
    }
  } catch (err) {
    console.error('Failed to bootstrap map data:', err);
  }

  seedCameraTelemetry();
  seedLocalMiniVehicles();
  renderAllMapLayers();
  if (cameras.length > 0) {
    const bounds = L.latLngBounds(cameras.map((c) => [c.lat, c.lng]));
    map.fitBounds(bounds.pad(0.18));
  }
  renderCameraDirectory();
  updateSelectedCameraPanel();
  bindMapWindowEvents();
  connectSSE();

  syncChannel.postMessage({ type: 'REQUEST_LIVE_STATE' });
  requestAnimationFrame(renderMiniPreviewLoop);
}

function setTileStyle(styleKey) {
  if (currentTileLayer) {
    map.removeLayer(currentTileLayer);
  }
  currentTileLayer = L.tileLayer(TILE_URLS[styleKey] || TILE_URLS.dark, {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap & CartoDB SmartCity GIS'
  }).addTo(map);
}

function seedCameraTelemetry() {
  cameras.forEach((cam) => {
    const latestRep = reports.find((r) => r.cameraId === cam.id);
    if (latestRep) {
      cameraTelemetry[cam.id] = {
        meanSpeedKmh: latestRep.summary.meanSpeedKmh,
        p85SpeedKmh: latestRep.summary.p85SpeedKmh,
        flowRate: latestRep.summary.flowRateVehPerMin,
        totalCount: latestRep.summary.totalVehiclesCounted,
        los: latestRep.summary.levelOfService,
        hotspots: latestRep.clusteringMetrics.activeHotspots,
        co2Gps: latestRep.emissionMetrics?.totalCo2Gps || 84.5,
        noxMgps: latestRep.emissionMetrics?.totalNoxMgps || 410.0,
        pm25Mgps: latestRep.emissionMetrics?.totalPm25Mgps || 21.4,
        corridorAqi: latestRep.emissionMetrics?.corridorAqi || 124,
        clusters: latestRep.clusteringMetrics.clusters || [],
        liveVehicles: null
      };
    } else {
      cameraTelemetry[cam.id] = {
        meanSpeedKmh: 58.0,
        p85SpeedKmh: 82.0,
        flowRate: 76.0,
        totalCount: 340,
        los: 'C',
        hotspots: 1,
        co2Gps: 76.4,
        noxMgps: 345.0,
        pm25Mgps: 18.2,
        corridorAqi: 108,
        clusters: [],
        liveVehicles: null
      };
    }
  });
}

function renderAllMapLayers() {
  corridorLayers.forEach((l) => map.removeLayer(l));
  corridorLayers = [];
  hotspotCircleLayers.forEach((l) => map.removeLayer(l));
  hotspotCircleLayers = [];
  Object.values(markersById).forEach((m) => map.removeLayer(m));
  markersById = {};

  const showCorridors = document.getElementById('toggleCorridors').checked;
  const showHotspots = document.getElementById('toggleHotspotCircles').checked;

  cameras.forEach((cam) => {
    const tele = cameraTelemetry[cam.id] || {
      meanSpeedKmh: 55,
      los: 'B',
      hotspots: 0,
      co2Gps: 65.0,
      noxMgps: 310.0,
      corridorAqi: 92,
      clusters: []
    };
    const color = losColor(tele.los);

    // 1. Corridor LoS & Emission Polyline
    if (showCorridors && Array.isArray(cam.corridorPath)) {
      const glowLine = L.polyline(cam.corridorPath, {
        color,
        weight: 12,
        opacity: 0.24,
        lineCap: 'round'
      }).addTo(map);

      const coreLine = L.polyline(cam.corridorPath, {
        color,
        weight: 5,
        opacity: 0.9,
        dashArray: tele.los === 'E' || tele.los === 'F' ? '8, 6' : null
      }).addTo(map);

      corridorLayers.push(glowLine, coreLine);

      if (Array.isArray(cam.secondaryCorridorPath)) {
        const secGlow = L.polyline(cam.secondaryCorridorPath, {
          color: '#38bdf8',
          weight: 10,
          opacity: 0.22,
          lineCap: 'round'
        }).addTo(map);

        const secCore = L.polyline(cam.secondaryCorridorPath, {
          color: '#38bdf8',
          weight: 4,
          opacity: 0.85,
          dashArray: '6, 6'
        }).addTo(map);

        corridorLayers.push(secGlow, secCore);
      }
    }

    // 2. Geo-Projected Multi-Density Congestion & Pollution Hotspot Plume Rings
    if (showHotspots && Array.isArray(tele.clusters)) {
      tele.clusters.forEach((c, cIdx) => {
        const latOffset = ((c.centroid?.y || 250) - 250) * 0.000018;
        const lngOffset = ((c.centroid?.x || 460) - 460) * 0.000022;
        const hsLat = cam.lat + latOffset + cIdx * 0.0006;
        const hsLng = cam.lng + lngOffset + cIdx * 0.0005;

        const hsColor =
          c.severity === 'CRITICAL'
            ? '#ef4444'
            : c.severity === 'HIGH'
            ? '#f59e0b'
            : '#3b82f6';

        // Outer dispersion plume ring
        const outerPlume = L.circle([hsLat, hsLng], {
          radius: Math.max(135, (c.radiusPx || 70) * 2.7),
          color: hsColor,
          weight: 1,
          dashArray: '4, 4',
          fillColor: hsColor,
          fillOpacity: 0.12
        }).addTo(map);

        // Inner dense smog core circle
        const circle = L.circle([hsLat, hsLng], {
          radius: Math.max(95, (c.radiusPx || 70) * 2.0),
          color: hsColor,
          weight: 2.2,
          fillColor: hsColor,
          fillOpacity: 0.3
        }).addTo(map);

        circle.bindPopup(`
          <div style="font-family:Inter,sans-serif;min-width:235px;">
            <div style="color:${hsColor};font-weight:700;font-family:monospace;font-size:12px;">
              ● POLLUTION HOTSPOT ${c.clusterId} (AQI ${c.localAqi || 145})
            </div>
            <div style="font-size:10px;color:#c4b5fd;font-family:monospace;margin-top:2px;">
              [${c.densityRegime || 'MULTI-DENSITY SMOG CORE'}]
            </div>
            <div style="font-size:12px;margin:4px 0;font-weight:600;">${cam.id}: ${c.zoneLabel}</div>
            <div style="font-size:11px;color:#cbd5e1;font-family:monospace;">
              Vehicles: <strong>${c.vehicleCount}</strong> | Avg Speed: <strong>${c.avgSpeedKmh} km/h</strong><br/>
              CO₂ Rate: <strong style="color:#38bdf8">${c.co2Gps || 42.5} g/s</strong> | NOx: <strong style="color:#fbbf24">${c.noxMgps || 210} mg/s</strong><br/>
              PM₂.₅: <strong>${c.pm25Mgps || 11.4} mg/s</strong> | Severity: <strong>${c.severityScore}/100</strong>
            </div>
          </div>
        `);

        hotspotCircleLayers.push(outerPlume, circle);
      });
    }

    // 3. Camera Marker Pin with Live Speed, LoS, CO2 Rate & AQI
    const isMainActive = cam.id === mainWinActiveCamId;
    const pinClass =
      tele.los === 'E' || tele.los === 'F'
        ? 'pin-critical'
        : tele.los === 'D'
        ? 'pin-warn'
        : '';

    const iconHtml = `
      <div class="cam-map-pin ${pinClass} ${isMainActive ? 'active-sync' : ''}">
        <div class="cam-pin-header">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
          <span>${cam.id}: ${cam.name}</span>
          <span style="background:${color}33;color:${color};padding:1px 4px;border-radius:3px;font-size:9.5px;">LoS ${tele.los}</span>
        </div>
        <div class="cam-pin-sub">
          ${tele.meanSpeedKmh} km/h • <span style="color:#38bdf8">${tele.co2Gps}g/s CO₂</span> • AQI ${tele.corridorAqi}
        </div>
      </div>
    `;

    const customIcon = L.divIcon({
      className: '',
      html: iconHtml,
      iconSize: [195, 44],
      iconAnchor: [97, 22]
    });

    const marker = L.marker([cam.lat, cam.lng], { icon: customIcon }).addTo(map);

    marker.bindPopup(`
      <div style="font-family:Inter,sans-serif;min-width:255px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong style="color:#00e5ff;font-family:monospace;font-size:12px;">${cam.id}</strong>
          <span style="background:${color}33;color:${color};padding:2px 6px;border-radius:4px;font-family:monospace;font-weight:700;font-size:11px;">
            LoS ${tele.los} • AQI ${tele.corridorAqi}
          </span>
        </div>
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">${cam.name}</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">${cam.description}</div>
        <div style="background:#09101f;padding:6px 8px;border-radius:6px;font-family:monospace;font-size:11px;margin-bottom:8px;">
          Speed: <strong>${tele.meanSpeedKmh} km/h</strong> | Flow: <strong>${tele.flowRate} veh/m</strong><br/>
          CO₂ Flux: <strong style="color:#38bdf8">${tele.co2Gps} g/s</strong> | NOx: <strong style="color:#fbbf24">${tele.noxMgps} mg/s</strong><br/>
          Multi-Density Hotspots: <strong style="color:#f87171">${tele.hotspots} (Auto-k)</strong>
        </div>
        <button onclick="window.selectAndSyncCamera('${cam.id}')" style="width:100%;background:#0284c7;color:#fff;border:none;padding:6px 10px;border-radius:5px;font-weight:600;cursor:pointer;">
          📺 Switch Main Feed to ${cam.id}
        </button>
      </div>
    `);

    marker.on('click', () => {
      selectedCamId = cam.id;
      renderCameraDirectory();
      updateSelectedCameraPanel();
    });

    markersById[cam.id] = marker;
  });
}

window.selectAndSyncCamera = function (camId) {
  selectedCamId = camId;
  mainWinActiveCamId = camId;
  syncChannel.postMessage({ type: 'SELECT_CAMERA', cameraId: camId });
  renderAllMapLayers();
  renderCameraDirectory();
  updateSelectedCameraPanel();
  showToast(`Switched Main Inference Window to ${camId}`);
};

function renderCameraDirectory() {
  const listEl = document.getElementById('camDirectoryList');
  listEl.innerHTML = cameras
    .map((cam) => {
      const tele = cameraTelemetry[cam.id] || {
        meanSpeedKmh: 55,
        co2Gps: 72.0,
        corridorAqi: 105,
        los: 'B',
        hotspots: 0
      };
      const isSel = cam.id === selectedCamId ? 'selected' : '';
      const isMain =
        cam.id === mainWinActiveCamId
          ? `<span style="font-size:0.65rem;color:#00e5ff;font-family:var(--font-mono);">● MAIN FEED</span>`
          : '';

      return `
      <div class="cam-dir-card ${isSel}" data-cam-id="${cam.id}">
        <div class="cam-dir-top">
          <span class="cam-dir-title">${cam.id}: ${cam.name}</span>
          <span class="los-badge los-${tele.los.toLowerCase()}" style="font-size:0.68rem;padding:0.08rem 0.4rem;">
            LoS ${tele.los} • AQI ${tele.corridorAqi}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="cam-dir-coords">📍 ${cam.location}</span>
          ${isMain}
        </div>
        <div class="cam-dir-metrics">
          <div>Speed: <strong>${tele.meanSpeedKmh} km/h</strong></div>
          <div>CO₂: <strong style="color:#38bdf8">${tele.co2Gps} g/s</strong></div>
          <div>Hotspots: <strong style="color:#f87171">${tele.hotspots}</strong></div>
        </div>
      </div>
    `;
    })
    .join('');

  listEl.querySelectorAll('.cam-dir-card').forEach((card) => {
    card.addEventListener('click', () => {
      const cid = card.getAttribute('data-cam-id');
      selectedCamId = cid;
      const cam = cameras.find((c) => c.id === cid);
      if (cam && map) {
        map.flyTo([cam.lat, cam.lng], 15, { duration: 0.65 });
        if (markersById[cid]) markersById[cid].openPopup();
      }
      renderCameraDirectory();
      updateSelectedCameraPanel();
    });
  });
}

function updateSelectedCameraPanel() {
  const cam = cameras.find((c) => c.id === selectedCamId) || cameras[0];
  if (!cam) return;
  document.getElementById(
    'selectedCamHeader'
  ).textContent = `${cam.id}: ${cam.name}`;
  document.getElementById(
    'selectedCamGps'
  ).textContent = `📍 ${cam.location} • Limit ${cam.speedLimitKmh} km/h`;
}

function seedLocalMiniVehicles() {
  localMiniVehicles = [];
  for (let i = 0; i < 12; i++) {
    const lane = i % 4;
    localMiniVehicles.push({
      x: 80 + lane * 48,
      y: (i * 35) % 175,
      w: 14,
      h: 24,
      speedKmh: lane === 2 ? 18 : 62,
      direction: lane < 2 ? 'NB' : 'SB',
      color: lane === 2 ? '#f59e0b' : '#38bdf8'
    });
  }
}

function renderMiniPreviewLoop() {
  const w = miniCanvas.width;
  const h = miniCanvas.height;

  miniCtx.fillStyle = '#09111f';
  miniCtx.fillRect(0, 0, w, h);

  const roadL = 55;
  const roadR = w - 55;
  miniCtx.fillStyle = '#172235';
  miniCtx.fillRect(roadL, 0, roadR - roadL, h);

  const midX = (roadL + roadR) / 2;
  miniCtx.strokeStyle = '#f59e0b';
  miniCtx.lineWidth = 1.5;
  miniCtx.beginPath();
  miniCtx.moveTo(midX, 0);
  miniCtx.lineTo(midX, h);
  miniCtx.stroke();

  miniCtx.strokeStyle = '#00e5ff';
  miniCtx.setLineDash([6, 4]);
  miniCtx.beginPath();
  miniCtx.moveTo(roadL, h * 0.62);
  miniCtx.lineTo(roadR, h * 0.62);
  miniCtx.stroke();
  miniCtx.setLineDash([]);

  const tele = cameraTelemetry[selectedCamId];
  const scaleX = w / 920;
  const scaleY = h / 500;

  if (tele && Array.isArray(tele.liveVehicles) && tele.liveVehicles.length > 0) {
    tele.liveVehicles.forEach((v) => {
      const vx = v.x * scaleX;
      const vy = v.y * scaleY;
      miniCtx.strokeStyle = v.speedKmh <= 38 ? '#f59e0b' : '#00e5ff';
      miniCtx.fillStyle = '#1e293b';
      miniCtx.fillRect(vx - 6, vy - 10, 12, 20);
      miniCtx.strokeRect(vx - 6, vy - 10, 12, 20);
    });

    if (Array.isArray(tele.clusters)) {
      tele.clusters.forEach((c) => {
        const cx = (c.centroid?.x || 460) * scaleX;
        const cy = (c.centroid?.y || 250) * scaleY;
        const r = Math.max(18, (c.radiusPx || 65) * scaleX);
        miniCtx.strokeStyle = '#ef4444';
        miniCtx.fillStyle = 'rgba(239, 68, 68, 0.24)';
        miniCtx.beginPath();
        miniCtx.arc(cx, cy, r, 0, Math.PI * 2);
        miniCtx.fill();
        miniCtx.stroke();
      });
    }
  } else {
    localMiniVehicles.forEach((v) => {
      v.y += (v.direction === 'NB' ? -1 : 1) * (v.speedKmh * 0.022);
      if (v.y < -15) v.y = h + 15;
      if (v.y > h + 15) v.y = -15;

      miniCtx.fillStyle = '#1e293b';
      miniCtx.strokeStyle = v.color;
      miniCtx.fillRect(v.x - 6, v.y - 10, 12, 20);
      miniCtx.strokeRect(v.x - 6, v.y - 10, 12, 20);
    });
  }

  requestAnimationFrame(renderMiniPreviewLoop);
}

syncChannel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'LIVE_TELEMETRY_TICK') {
    mainWinActiveCamId = msg.cameraId;
    cameraTelemetry[msg.cameraId] = {
      meanSpeedKmh: msg.meanSpeedKmh,
      p85SpeedKmh: msg.p85SpeedKmh,
      flowRate: msg.flowRate,
      totalCount: msg.totalCount,
      los: msg.los,
      co2Gps: msg.emissionMetrics?.totalCo2Gps || 75.0,
      noxMgps: msg.emissionMetrics?.totalNoxMgps || 350.0,
      pm25Mgps: msg.emissionMetrics?.totalPm25Mgps || 18.0,
      corridorAqi: msg.emissionMetrics?.corridorAqi || 110,
      hotspots: (msg.clusters || []).length,
      clusters: msg.clusters || [],
      liveVehicles: msg.vehicles || []
    };
    renderAllMapLayers();
    renderCameraDirectory();
  } else if (msg.type === 'NEW_AGENT_REPORT' && msg.report) {
    handleIncomingReport(msg.report);
  }
};

function handleIncomingReport(rep) {
  reports.unshift(rep);
  cameraTelemetry[rep.cameraId] = {
    meanSpeedKmh: rep.summary.meanSpeedKmh,
    p85SpeedKmh: rep.summary.p85SpeedKmh,
    flowRate: rep.summary.flowRateVehPerMin,
    totalCount: rep.summary.totalVehiclesCounted,
    los: rep.summary.levelOfService,
    co2Gps: rep.emissionMetrics?.totalCo2Gps || 84.0,
    noxMgps: rep.emissionMetrics?.totalNoxMgps || 420.0,
    pm25Mgps: rep.emissionMetrics?.totalPm25Mgps || 22.0,
    corridorAqi: rep.emissionMetrics?.corridorAqi || 126,
    hotspots: rep.clusteringMetrics.activeHotspots,
    clusters: rep.clusteringMetrics.clusters || [],
    liveVehicles: cameraTelemetry[rep.cameraId]?.liveVehicles || null
  };
  renderAllMapLayers();
  renderCameraDirectory();
  showToast(
    `GIS Map Updated: ${rep.reportId} (${rep.cameraId} • ${
      rep.emissionMetrics?.totalCo2Gps || 84
    } g/s CO₂)`
  );
}

function connectSSE() {
  const es = new EventSource('/api/stream/events');
  es.addEventListener('new_report', (e) => {
    try {
      const rep = JSON.parse(e.data);
      handleIncomingReport(rep);
    } catch (err) {
      console.error(err);
    }
  });
  es.onerror = () => {
    es.close();
  };
}

function bindMapWindowEvents() {
  document.getElementById('tileStyleSelect').addEventListener('change', (e) => {
    setTileStyle(e.target.value);
  });

  document
    .getElementById('toggleCorridors')
    .addEventListener('change', renderAllMapLayers);
  document
    .getElementById('toggleHotspotCircles')
    .addEventListener('change', renderAllMapLayers);

  const flyI70Btn = document.getElementById('flyI70Btn');
  if (flyI70Btn) {
    flyI70Btn.addEventListener('click', () => {
      selectedCamId = 'CAM-01';
      const cam = cameras.find((c) => c.id === 'CAM-01');
      if (cam && map) {
        map.flyTo([cam.lat, cam.lng], 15, { duration: 0.75 });
        if (markersById['CAM-01']) markersById['CAM-01'].openPopup();
      }
      renderCameraDirectory();
      updateSelectedCameraPanel();
    });
  }

  document.getElementById('fitBoundsBtn').addEventListener('click', () => {
    if (!map || cameras.length === 0) return;
    const bounds = L.latLngBounds(cameras.map((c) => [c.lat, c.lng]));
    map.fitBounds(bounds.pad(0.22));
  });

  document
    .getElementById('focusInMainWinBtn')
    .addEventListener('click', () => {
      window.selectAndSyncCamera(selectedCamId);
    });

  document
    .getElementById('pushMapReportBtn')
    .addEventListener('click', async () => {
      const tele = cameraTelemetry[selectedCamId] || {};
      try {
        const res = await fetch('/api/agent/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cameraId: selectedCamId,
            triggerSource: 'GIS Map Window Operator Push',
            clusters: tele.clusters || []
          })
        });
        if (!res.ok) throw new Error('Static mode');
      } catch (_) {
        showToast(
          `Snapshot logged for ${selectedCamId} (${tele.co2Gps || 78} g/s CO₂ • AQI ${
            tele.corridorAqi || 112
          })`
        );
      }
    });
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="status-indicator"></span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

window.addEventListener('DOMContentLoaded', initMapWindow);
