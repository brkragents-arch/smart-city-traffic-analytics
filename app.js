/**
 * SmartCity Pulse AI — Unified Real-Time Vehicle Detection, Speed Estimation,
 * COPERT-VSP Empirical Emission Rate Monitoring & Autonomous Multi-Density
 * Congestion/Pollution Hotspot Clustering Framework
 */

const canvas = document.getElementById('trafficCanvas');
const ctx = canvas.getContext('2d');
const chartCanvas = document.getElementById('telemetryChartCanvas');
const chartCtx = chartCanvas.getContext('2d');
const uploadedVideo = document.getElementById('uploadedVideo');
const syncChannel = new BroadcastChannel('smartcity_pulse_sync');
let mapPopupWindow = null;

// State
let cameras = [];
let activeCamera = {
  id: 'CAM-01',
  name: 'I-70 AT US 29',
  location: '39.2877° N, 76.8398° W',
  gantrySign: 'I-70 AT US 29 • EXIT 87 COLUMBIA PIKE INTERCHANGE',
  speedLimitKmh: 105,
  calibrationMetersPerPixel: 0.092,
  tripwireYRatio: 0.62
};

let reports = [];
let selectedModalReport = null;

// Simulation / Video Mode
let isCustomVideoMode = false;
let cocoModel = null;
let isPaused = false;
let shockwaveActive = false;
let shockwaveZone = { lane: 2, y: 275, x: 545, radius: 78 };

// Vehicle Tracking & Counting State
let vehicles = [];
let nextTrackId = 101;
let crossingCounts = {
  total: 142,
  northbound: 68,
  southbound: 74,
  overspeed: 9
};

let classCounts = {
  Car: 96,
  'SUV / Van': 21,
  Truck: 14,
  Bus: 7,
  Motorcycle: 4
};

// Live Corridor Emission Aggregations
let liveCorridorEmissions = {
  totalCo2Gps: 68.4,
  co2KgPerHour: 246.2,
  totalNoxMgps: 312.5,
  totalPm25Mgps: 16.8,
  totalCoMgps: 540.0,
  corridorAqi: 96
};

let tripwireFlashes = [];
let activeClusters = [];
let telemetryHistory = []; // { meanSpeed, co2RateGps, noxScaled }

// Hyperparameters from UI Sliders
let clusterParams = {
  eps: 72,
  minPts: 3,
  speedThreshold: 38,
  spawnDensity: 2
};

// Lane geometry on 920x500 canvas
const ROAD_LEFT = 175;
const ROAD_RIGHT = 745;
const LANE_WIDTH = (ROAD_RIGHT - ROAD_LEFT) / 4;
const LANE_CENTERS = [
  ROAD_LEFT + LANE_WIDTH * 0.5,
  ROAD_LEFT + LANE_WIDTH * 1.5,
  ROAD_LEFT + LANE_WIDTH * 2.5,
  ROAD_LEFT + LANE_WIDTH * 3.5
];

/**
 * Empirical Vehicle Type & Powertrain Specifications
 * Accounts for Vehicle Type, Weight (kg), Fuel Type, Age (yrs), and Engine Capacity (L)
 */
const VEHICLE_SPECS = [
  {
    cls: 'Car',
    w: 30,
    h: 52,
    color: '#38bdf8',
    maxSpeed: 108,
    prob: 0.60,
    weightRange: [1350, 1720],
    fuels: ['Gasoline', 'Gasoline', 'Hybrid', 'EV'],
    engineRange: [1.5, 2.4],
    baseCo2: 2.15,
    baseNox: 8.5,
    basePm25: 0.42,
    baseCo: 24.0
  },
  {
    cls: 'SUV / Van',
    w: 33,
    h: 58,
    color: '#818cf8',
    maxSpeed: 102,
    prob: 0.16,
    weightRange: [2050, 2650],
    fuels: ['Gasoline', 'Diesel', 'Hybrid'],
    engineRange: [2.5, 3.8],
    baseCo2: 3.05,
    baseNox: 13.2,
    basePm25: 0.68,
    baseCo: 32.5
  },
  {
    cls: 'Truck',
    w: 38,
    h: 84,
    color: '#f59e0b',
    maxSpeed: 88,
    prob: 0.13,
    weightRange: [12500, 22000],
    fuels: ['Diesel', 'Diesel', 'Diesel'],
    engineRange: [8.9, 12.8],
    baseCo2: 9.85,
    baseNox: 86.0,
    basePm25: 4.85,
    baseCo: 68.0
  },
  {
    cls: 'Bus',
    w: 38,
    h: 90,
    color: '#10b981',
    maxSpeed: 84,
    prob: 0.06,
    weightRange: [11800, 15500],
    fuels: ['Diesel', 'Hybrid'],
    engineRange: [6.7, 9.3],
    baseCo2: 8.40,
    baseNox: 74.5,
    basePm25: 4.10,
    baseCo: 59.0
  },
  {
    cls: 'Motorcycle',
    w: 18,
    h: 36,
    color: '#f472b6',
    maxSpeed: 112,
    prob: 0.05,
    weightRange: [190, 280],
    fuels: ['Gasoline'],
    engineRange: [0.5, 0.9],
    baseCo2: 0.92,
    baseNox: 4.2,
    basePm25: 0.22,
    baseCo: 36.0
  }
];

let lastFrameTime = performance.now();
let fpsSmooth = 60;
let frameCounter = 0;

/**
 * Empirical Microscopic Emission Factor Calculator (COPERT / MOVES VSP Hybrid)
 * Links instantaneous speed, acceleration/braking state, vehicle type, weight (kg),
 * fuel type, vehicle age (years), and engine capacity (L) to compute real-time
 * tailpipe emission rates: CO2 (g/s), NOx (mg/s), PM2.5 (mg/s), CO (mg/s)
 */
function computeLiveVehicleEmissions(v) {
  const spec =
    VEHICLE_SPECS.find((s) => s.cls === v.cls) || VEHICLE_SPECS[0];
  const speed = Math.max(3.5, v.speedKmh || 40);

  // 1. Speed-dependent U-shaped congestion factor (severe spike in stop-and-go < 28 km/h)
  const stopAndGoMultiplier =
    speed < 30 ? 1 + ((30 - speed) / 20) * 1.55 : 1.0;
  const highSpeedDragMultiplier =
    speed > 85 ? 1 + Math.pow((speed - 85) / 40, 2) * 0.35 : 1.0;
  const transientLoadMultiplier = v.braking ? 1.24 : 1.0;

  // 2. Empirical vehicle physical modifiers: Weight, Engine CC, Age (catalyst degradation), Fuel Type
  const refWeight = (spec.weightRange[0] + spec.weightRange[1]) / 2;
  const refEngine = (spec.engineRange[0] + spec.engineRange[1]) / 2;
  const weightMod = Math.pow((v.weightKg || refWeight) / refWeight, 0.55);
  const engineMod = Math.pow((v.engineCcL || refEngine) / refEngine, 0.48);
  const ageMod = 1 + Math.max(0, (v.ageYears || 5) - 2) * 0.045;

  let fuelCo2 = 1.0;
  let fuelNox = 1.0;
  let fuelPm = 1.0;
  if (v.fuelType === 'Diesel') {
    fuelCo2 = 1.08;
    fuelNox = 1.68;
    fuelPm = 2.15;
  } else if (v.fuelType === 'Hybrid') {
    fuelCo2 = 0.56;
    fuelNox = 0.50;
    fuelPm = 0.45;
  } else if (v.fuelType === 'EV') {
    fuelCo2 = 0.0;
    fuelNox = 0.0;
    fuelPm = 0.18; // Tire & brake wear non-exhaust PM2.5
  }

  const totalFactor =
    stopAndGoMultiplier *
    highSpeedDragMultiplier *
    transientLoadMultiplier *
    weightMod *
    engineMod *
    ageMod;

  v.emissions = {
    co2Gps: Number((spec.baseCo2 * totalFactor * fuelCo2).toFixed(2)),
    noxMgps: Number((spec.baseNox * totalFactor * fuelNox).toFixed(1)),
    pm25Mgps: Number((spec.basePm25 * totalFactor * fuelPm).toFixed(2)),
    coMgps: Number(
      (spec.baseCo * totalFactor * (v.fuelType === 'EV' ? 0 : 1)).toFixed(1)
    )
  };
  return v.emissions;
}

/**
 * Initialize Web App
 */
async function initApp() {
  try {
    let data = null;
    try {
      const res = await fetch('/api/bootstrap');
      if (res.ok) {
        data = await res.json();
      }
    } catch (_) {
      // Fallback to static JSON when hosted on GitHub Pages
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
      const droppedIds = new Set(['CAM-02', 'CAM-05']);
      cameras = (data.cameras || []).filter((c) => !droppedIds.has(c.id));
      reports = (data.reports || []).filter((r) => !droppedIds.has(r.cameraId));
      if (!cameras.some((c) => c.id === 'CAM-07')) {
        try {
          const staticRes = await fetch('./data/sample_traffic_streams.json');
          if (staticRes.ok) {
            const raw = await staticRes.json();
            cameras = (raw.cameras || []).filter((c) => !droppedIds.has(c.id));
            const repIds = new Set(reports.map((r) => r.reportId));
            for (const r of raw.initialReports || []) {
              if (!droppedIds.has(r.cameraId) && !repIds.has(r.reportId)) {
                reports.unshift(r);
              }
            }
          }
        } catch (_) {}
      }
      if (cameras.length > 0) {
        activeCamera = cameras[0];
      }
      renderReportsFeed();
      renderClassDistributionBars();
    }
  } catch (err) {
    console.error('Bootstrap fetch error:', err);
  }

  connectAgentSSE();
  seedInitialTraffic(18);
  seedTelemetryHistory();
  bindUIEvents();
  requestAnimationFrame(mainInferenceLoop);

  setInterval(recordTelemetryPoint, 1000);

  setInterval(() => {
    const autoPush = document.getElementById('autoPushToggle');
    if (autoPush && autoPush.checked && !isPaused) {
      triggerAgentReportPush('Scheduled Unified Stream Agent');
    }
  }, 25000);
}

/**
 * Connect to Backend Server-Sent Events (SSE)
 */
function connectAgentSSE() {
  const evtSource = new EventSource('/api/stream/events');
  const statusBadge = document.getElementById('agentStatusText');

  evtSource.addEventListener('connected', () => {
    if (statusBadge)
      statusBadge.textContent = 'Unified Stream Agent Connected (SSE)';
  });

  evtSource.addEventListener('new_report', (event) => {
    try {
      const newReport = JSON.parse(event.data);
      const exists = reports.some((r) => r.reportId === newReport.reportId);
      if (!exists) {
        reports.unshift(newReport);
        renderReportsFeed(newReport.reportId);
        const co2Str = newReport.emissionMetrics
          ? ` • ${newReport.emissionMetrics.totalCo2Gps} g/s CO2`
          : '';
        showToast(
          `Agent pushed report ${newReport.reportId} (${newReport.cameraId} • LoS ${newReport.summary.levelOfService}${co2Str})`
        );
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  });

  evtSource.onerror = () => {
    evtSource.close();
    if (statusBadge)
      statusBadge.textContent = 'Unified Stream Agent Active (Edge Mode)';
  };
}

function pickVehicleSpec() {
  const r = Math.random();
  let acc = 0;
  for (const spec of VEHICLE_SPECS) {
    acc += spec.prob;
    if (r <= acc) return spec;
  }
  return VEHICLE_SPECS[0];
}

function buildEmpiricalVehicleAttributes(spec) {
  const weightKg = Math.round(
    spec.weightRange[0] +
      Math.random() * (spec.weightRange[1] - spec.weightRange[0])
  );
  const fuelType =
    spec.fuels[Math.floor(Math.random() * spec.fuels.length)];
  const ageYears = Math.floor(1 + Math.random() * 11);
  const engineCcL =
    fuelType === 'EV'
      ? 0.0
      : Number(
          (
            spec.engineRange[0] +
            Math.random() * (spec.engineRange[1] - spec.engineRange[0])
          ).toFixed(1)
        );
  return { weightKg, fuelType, ageYears, engineCcL };
}

/**
 * Seed initial vehicles across the 4 lanes + a multi-density slow platoon
 */
function seedInitialTraffic(count = 18) {
  vehicles = [];
  for (let i = 0; i < count; i++) {
    const lane = i % 4;
    const y = 40 + ((i * 67) % 420);
    spawnVehicleInLane(lane, y);
  }
  // Create a slow heavy-freight + commuter platoon in Lane 2 to demonstrate Multi-Density Pollution Hotspot discovery
  const platoonYs = [205, 258, 308, 355];
  platoonYs.forEach((py, idx) => {
    const spec = idx < 2 ? VEHICLE_SPECS[2] : VEHICLE_SPECS[0]; // 2 Heavy Diesel Trucks + 2 Cars
    const emp = buildEmpiricalVehicleAttributes(spec);
    if (idx < 2) {
      emp.fuelType = 'Diesel';
      emp.weightKg = 17800;
      emp.engineCcL = 10.8;
      emp.ageYears = 9;
    }
    const vObj = {
      id: nextTrackId++,
      cls: spec.cls,
      color: spec.color,
      lane: 2,
      direction: 'SB',
      x: LANE_CENTERS[2] + (Math.random() * 8 - 4),
      y: py,
      w: spec.w,
      h: spec.h,
      speedKmh: 16.5 + idx * 2.2,
      targetSpeedKmh: idx === 0 ? 22 : 76,
      crossedTripwire: py > canvas.height * activeCamera.tripwireYRatio,
      braking: true,
      confidence: Number((0.9 + Math.random() * 0.08).toFixed(2)),
      trail: [],
      ...emp
    };
    computeLiveVehicleEmissions(vObj);
    vehicles.push(vObj);
  });
}

function spawnVehicleInLane(lane, customY = null) {
  const isNorthbound = lane < 2;
  const spec = pickVehicleSpec();
  const spawnY =
    customY !== null ? customY : isNorthbound ? canvas.height + 55 : -55;

  const tooClose = vehicles.some(
    (v) => v.lane === lane && Math.abs(v.y - spawnY) < 78
  );
  if (tooClose && customY === null) return;

  const limit = activeCamera.speedLimitKmh || 95;
  const baseSpeed = Math.min(
    spec.maxSpeed,
    limit * (0.74 + Math.random() * 0.34)
  );
  const emp = buildEmpiricalVehicleAttributes(spec);

  const vObj = {
    id: nextTrackId++,
    cls: spec.cls,
    color: spec.color,
    lane,
    direction: isNorthbound ? 'NB' : 'SB',
    x: LANE_CENTERS[lane] + (Math.random() * 6 - 3),
    y: spawnY,
    w: spec.w,
    h: spec.h,
    speedKmh: baseSpeed,
    targetSpeedKmh: baseSpeed,
    crossedTripwire: false,
    braking: false,
    confidence: Number((0.88 + Math.random() * 0.11).toFixed(2)),
    trail: [],
    ...emp
  };
  computeLiveVehicleEmissions(vObj);
  vehicles.push(vObj);
}

/**
 * Intelligent Driver Model (IDM) + Live COPERT-VSP Emission Rate Update
 */
function updateSimulatedTraffic(dt) {
  const tripwireY = canvas.height * activeCamera.tripwireYRatio;

  const spawnChance =
    clusterParams.spawnDensity === 3
      ? 0.095
      : clusterParams.spawnDensity === 2
      ? 0.055
      : 0.025;

  if (Math.random() < spawnChance && vehicles.length < 34) {
    const lane = Math.floor(Math.random() * 4);
    spawnVehicleInLane(lane);
  }

  for (let lane = 0; lane < 4; lane++) {
    const isNB = lane < 2;
    const laneVehicles = vehicles
      .filter((v) => v.lane === lane)
      .sort((a, b) => (isNB ? a.y - b.y : b.y - a.y));

    for (let i = 0; i < laneVehicles.length; i++) {
      const v = laneVehicles[i];
      const lead = i > 0 ? laneVehicles[i - 1] : null;

      let desiredSpeed = v.targetSpeedKmh;
      v.braking = false;

      if (shockwaveActive) {
        const distToShock = Math.hypot(
          v.x - shockwaveZone.x,
          v.y - shockwaveZone.y
        );
        if (distToShock < shockwaveZone.radius + 58) {
          desiredSpeed = Math.min(desiredSpeed, 10.5);
          v.braking = true;
        }
      }

      if (lead) {
        const gap = isNB
          ? v.y - lead.y - (v.h + lead.h) * 0.5
          : lead.y - v.y - (v.h + lead.h) * 0.5;
        const safeGap = 26 + v.speedKmh * 0.42;

        if (gap < safeGap) {
          desiredSpeed = Math.min(desiredSpeed, Math.max(6, lead.speedKmh * 0.86));
          v.braking = true;
        }
        if (gap < 16) {
          desiredSpeed = Math.min(desiredSpeed, 5);
          v.braking = true;
        }
      }

      const accelRate = v.braking ? 6.5 : 2.6;
      v.speedKmh += (desiredSpeed - v.speedKmh) * Math.min(1, dt * accelRate);
      v.speedKmh = Math.max(4.5, v.speedKmh);

      // Update live empirical tailpipe emissions for this vehicle at its current speed & load
      computeLiveVehicleEmissions(v);

      const pxPerSec = (v.speedKmh / 3.6) / activeCamera.calibrationMetersPerPixel;
      const dy = (isNB ? -1 : 1) * pxPerSec * dt * 0.145;
      const prevY = v.y;
      v.y += dy;

      if (frameCounter % 3 === 0) {
        v.trail.push({ x: v.x, y: v.y });
        if (v.trail.length > 14) v.trail.shift();
      }

      if (!v.crossedTripwire) {
        const crossedNB = isNB && prevY >= tripwireY && v.y < tripwireY;
        const crossedSB = !isNB && prevY <= tripwireY && v.y > tripwireY;
        if (crossedNB || crossedSB) {
          v.crossedTripwire = true;
          crossingCounts.total++;
          if (isNB) crossingCounts.northbound++;
          else crossingCounts.southbound++;

          if (v.speedKmh > activeCamera.speedLimitKmh) {
            crossingCounts.overspeed++;
          }

          classCounts[v.cls] = (classCounts[v.cls] || 0) + 1;
          tripwireFlashes.push({
            x: v.x,
            y: tripwireY,
            alpha: 1.0,
            dir: isNB ? 'NB' : 'SB',
            speed: v.speedKmh,
            co2: v.emissions?.co2Gps || 2.5
          });
          renderClassDistributionBars();
        }
      }
    }
  }

  vehicles = vehicles.filter((v) => v.y > -90 && v.y < canvas.height + 90);
}

/**
 * Custom Uploaded Video Mode: TensorFlow.js COCO-SSD + Empirical Emission Factor Assignment
 */
let lastCocoRun = 0;
async function updateCustomVideoInference(now) {
  if (!uploadedVideo || uploadedVideo.paused || uploadedVideo.ended) return;

  if (cocoModel && now - lastCocoRun > 90) {
    lastCocoRun = now;
    try {
      const predictions = await cocoModel.detect(uploadedVideo);
      const validClasses = {
        car: 'Car',
        truck: 'Truck',
        bus: 'Bus',
        motorcycle: 'Motorcycle'
      };

      const scaleX = canvas.width / (uploadedVideo.videoWidth || canvas.width);
      const scaleY = canvas.height / (uploadedVideo.videoHeight || canvas.height);

      const detections = predictions
        .filter((p) => validClasses[p.class] && p.score >= 0.35)
        .map((p) => {
          const [bx, by, bw, bh] = p.bbox;
          return {
            cls: validClasses[p.class],
            x: (bx + bw / 2) * scaleX,
            y: (by + bh / 2) * scaleY,
            w: bw * scaleX,
            h: bh * scaleY,
            confidence: Number(p.score.toFixed(2))
          };
        });

      matchDetectionsToTracks(detections);
    } catch (e) {
      console.warn('COCO-SSD frame inference warning:', e);
    }
  }
}

function matchDetectionsToTracks(detections) {
  const tripwireY = canvas.height * activeCamera.tripwireYRatio;
  const matchedTrackIds = new Set();

  for (const det of detections) {
    let bestTrack = null;
    let bestDist = 65;

    for (const track of vehicles) {
      if (matchedTrackIds.has(track.id)) continue;
      const d = Math.hypot(det.x - track.x, det.y - track.y);
      if (d < bestDist) {
        bestDist = d;
        bestTrack = track;
      }
    }

    if (bestTrack) {
      matchedTrackIds.add(bestTrack.id);
      const prevY = bestTrack.y;
      const pixelDelta = Math.hypot(det.x - bestTrack.x, det.y - bestTrack.y);
      const estSpeed = Math.min(
        115,
        Math.max(8, pixelDelta * activeCamera.calibrationMetersPerPixel * 38)
      );

      bestTrack.speedKmh = bestTrack.speedKmh * 0.65 + estSpeed * 0.35;
      bestTrack.x = det.x;
      bestTrack.y = det.y;
      bestTrack.w = det.w;
      bestTrack.h = det.h;
      bestTrack.confidence = det.confidence;
      bestTrack.missedFrames = 0;
      bestTrack.direction = det.y < prevY ? 'NB' : 'SB';
      computeLiveVehicleEmissions(bestTrack);

      bestTrack.trail.push({ x: det.x, y: det.y });
      if (bestTrack.trail.length > 14) bestTrack.trail.shift();

      if (!bestTrack.crossedTripwire) {
        const crossed =
          (prevY < tripwireY && det.y >= tripwireY) ||
          (prevY > tripwireY && det.y <= tripwireY);
        if (crossed) {
          bestTrack.crossedTripwire = true;
          crossingCounts.total++;
          if (bestTrack.direction === 'NB') crossingCounts.northbound++;
          else crossingCounts.southbound++;
          classCounts[bestTrack.cls] = (classCounts[bestTrack.cls] || 0) + 1;
          tripwireFlashes.push({
            x: det.x,
            y: tripwireY,
            alpha: 1.0,
            dir: bestTrack.direction,
            speed: bestTrack.speedKmh,
            co2: bestTrack.emissions?.co2Gps || 2.5
          });
          renderClassDistributionBars();
        }
      }
    } else {
      const spec =
        VEHICLE_SPECS.find((s) => s.cls === det.cls) || VEHICLE_SPECS[0];
      const emp = buildEmpiricalVehicleAttributes(spec);
      const newTrack = {
        id: nextTrackId++,
        cls: det.cls,
        color: spec.color,
        lane: det.x < canvas.width / 2 ? 1 : 2,
        direction: det.x < canvas.width / 2 ? 'NB' : 'SB',
        x: det.x,
        y: det.y,
        w: det.w,
        h: det.h,
        speedKmh: 42,
        targetSpeedKmh: 55,
        crossedTripwire: false,
        braking: false,
        confidence: det.confidence,
        missedFrames: 0,
        trail: [{ x: det.x, y: det.y }],
        ...emp
      };
      computeLiveVehicleEmissions(newTrack);
      vehicles.push(newTrack);
    }
  }

  for (const track of vehicles) {
    if (!matchedTrackIds.has(track.id)) {
      track.missedFrames = (track.missedFrames || 0) + 1;
    }
  }
  vehicles = vehicles.filter((t) => (t.missedFrames || 0) < 8);
}

/**
 * Autonomous Multi-Density Stream Clustering (HDBSCAN / Multi-Density DenStream)
 * Discovers variable-density congestion & pollution hotspots WITHOUT requiring
 * pre-specified cluster counts (k). Uses mutual-reachability adaptive neighborhood radii
 * and aggregates real-time CO2, NOx, PM2.5, and Local AQI per discovered hotspot.
 */
function runLiveStreamClustering() {
  const baseEps = clusterParams.eps;
  const minPts = clusterParams.minPts;
  const speedThresh = clusterParams.speedThreshold;

  // Update corridor-wide emission totals across all active vehicles
  let sumCo2 = 0;
  let sumNox = 0;
  let sumPm25 = 0;
  let sumCo = 0;
  for (const v of vehicles) {
    const em = v.emissions || computeLiveVehicleEmissions(v);
    sumCo2 += em.co2Gps;
    sumNox += em.noxMgps;
    sumPm25 += em.pm25Mgps;
    sumCo += em.coMgps;
  }

  liveCorridorEmissions = {
    totalCo2Gps: Number(sumCo2.toFixed(1)),
    co2KgPerHour: Number(((sumCo2 * 3600) / 1000).toFixed(1)),
    totalNoxMgps: Number(sumNox.toFixed(1)),
    totalPm25Mgps: Number(sumPm25.toFixed(2)),
    totalCoMgps: Number(sumCo.toFixed(1)),
    corridorAqi: Math.round(
      Math.min(230, 46 + sumPm25 * 3.8 + sumNox * 0.14)
    )
  };

  // Candidate hotspot points: slow/congested vehicles OR high-emission heavy vehicles
  const candidates = vehicles.filter(
    (v) => v.speedKmh <= speedThresh || (v.emissions && v.emissions.co2Gps >= 6.8)
  );

  if (candidates.length < minPts) {
    activeClusters = [];
    return;
  }

  // Compute local k-nearest-neighbor core distance for multi-density adaptation
  const coreDistances = new Map();
  for (const pt of candidates) {
    const dists = candidates
      .map((other) => Math.hypot(pt.x - other.x, pt.y - other.y))
      .sort((a, b) => a - b);
    const kIdx = Math.min(dists.length - 1, minPts - 1);
    coreDistances.set(pt.id, dists[kIdx]);
  }

  function getMultiDensityNeighbors(pt) {
    const localCore = coreDistances.get(pt.id) || baseEps;
    const adaptiveEps = Math.min(
      baseEps * 1.35,
      Math.max(baseEps * 0.72, localCore * 1.18)
    );
    return candidates.filter(
      (other) => Math.hypot(pt.x - other.x, pt.y - other.y) <= adaptiveEps
    );
  }

  const visited = new Set();
  const clustered = new Set();
  const discovered = [];
  let clusterIndex = 1;

  for (const v of candidates) {
    if (visited.has(v.id)) continue;
    visited.add(v.id);

    const neighbors = getMultiDensityNeighbors(v);
    if (neighbors.length < minPts) continue;

    const members = [];
    const queue = [...neighbors];

    while (queue.length > 0) {
      const curr = queue.shift();
      if (!visited.has(curr.id)) {
        visited.add(curr.id);
        const currNeighbors = getMultiDensityNeighbors(curr);
        if (currNeighbors.length >= minPts) {
          for (const n of currNeighbors) {
            if (!queue.some((q) => q.id === n.id)) queue.push(n);
          }
        }
      }
      if (!clustered.has(curr.id)) {
        clustered.add(curr.id);
        members.push(curr);
      }
    }

    if (members.length >= minPts) {
      const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
      const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
      const avgSpeed =
        members.reduce((s, m) => s + m.speedKmh, 0) / members.length;

      let radiusPx = 56;
      for (const m of members) {
        const d = Math.hypot(m.x - cx, m.y - cy) + 32;
        if (d > radiusPx) radiusPx = d;
      }

      // Aggregate real-time pollutant emissions within this hotspot cluster
      const co2Gps = Number(
        members.reduce((s, m) => s + (m.emissions?.co2Gps || 2.5), 0).toFixed(1)
      );
      const noxMgps = Number(
        members.reduce((s, m) => s + (m.emissions?.noxMgps || 14), 0).toFixed(1)
      );
      const pm25Mgps = Number(
        members.reduce((s, m) => s + (m.emissions?.pm25Mgps || 0.8), 0).toFixed(2)
      );

      // Classify Multi-Density Regime
      const areaNorm = Math.max(1, (Math.PI * radiusPx * radiusPx) / 10000);
      const spatialDensity = Number((members.length / areaNorm).toFixed(2));
      const densityRegime =
        spatialDensity >= 2.1
          ? 'ULTRA-DENSE SMOG CORE'
          : spatialDensity >= 1.35
          ? 'HIGH-DENSITY PLUME'
          : 'DISPERSED TRANSITION';

      const localAqi = Math.round(
        Math.min(245, 58 + pm25Mgps * 6.8 + noxMgps * 0.32)
      );

      const densityRatio = Math.min(1, members.length / 8);
      const speedDropRatio = Math.max(0, (speedThresh - avgSpeed) / speedThresh);
      const emissionRatio = Math.min(1, noxMgps / 250);
      const severityScore = Math.round(
        Math.min(
          99,
          38 + densityRatio * 24 + speedDropRatio * 20 + emissionRatio * 22
        )
      );

      let severity = 'MODERATE';
      if (severityScore >= 80 || localAqi >= 150) severity = 'CRITICAL';
      else if (severityScore >= 65 || localAqi >= 115) severity = 'HIGH';

      const dirLabel = cx < canvas.width / 2 ? 'Northbound' : 'Southbound';
      const yMeters = Math.round(cy * 0.85);

      discovered.push({
        clusterId: `PH-${activeCamera.id.split('-')[1]}0${clusterIndex++}`,
        zoneLabel: `${dirLabel} Corridor (Y: ${yMeters}m)`,
        centroid: { x: Math.round(cx), y: Math.round(cy) },
        radiusPx: Math.round(radiusPx),
        vehicleCount: members.length,
        avgSpeedKmh: Number(avgSpeed.toFixed(1)),
        dwellTimeSec: Number((15 + members.length * 4.2).toFixed(1)),
        densityRegime,
        co2Gps,
        noxMgps,
        pm25Mgps,
        localAqi,
        severity,
        severityScore,
        members
      });
    }
  }

  activeClusters = discovered.sort((a, b) => b.severityScore - a.severityScore);
}

/**
 * Render Smart Corridor Roadway or Custom Uploaded Video Frame
 */
function renderSceneBackground() {
  if (isCustomVideoMode && uploadedVideo.readyState >= 2) {
    ctx.drawImage(uploadedVideo, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(6, 10, 22, 0.22)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  ctx.fillStyle = '#09111f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(34, 50, 84, 0.45)';
  ctx.lineWidth = 1;
  for (let y = 0; y < canvas.height; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(ROAD_LEFT - 18, y);
    ctx.moveTo(ROAD_RIGHT + 18, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#141e30';
  ctx.fillRect(ROAD_LEFT - 18, 0, 18, canvas.height);
  ctx.fillRect(ROAD_RIGHT, 0, 18, canvas.height);

  const roadGrad = ctx.createLinearGradient(ROAD_LEFT, 0, ROAD_RIGHT, 0);
  roadGrad.addColorStop(0, '#161f30');
  roadGrad.addColorStop(0.5, '#1c273c');
  roadGrad.addColorStop(1, '#161f30');
  ctx.fillStyle = roadGrad;
  ctx.fillRect(ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, canvas.height);

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(ROAD_LEFT, 0);
  ctx.lineTo(ROAD_LEFT, canvas.height);
  ctx.moveTo(ROAD_RIGHT, 0);
  ctx.lineTo(ROAD_RIGHT, canvas.height);
  ctx.stroke();

  const centerDividerX = ROAD_LEFT + LANE_WIDTH * 2;
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(centerDividerX - 3, 0);
  ctx.lineTo(centerDividerX - 3, canvas.height);
  ctx.moveTo(centerDividerX + 3, 0);
  ctx.lineTo(centerDividerX + 3, canvas.height);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(203, 213, 225, 0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([22, 18]);
  [ROAD_LEFT + LANE_WIDTH, ROAD_LEFT + LANE_WIDTH * 3].forEach((lx) => {
    ctx.beginPath();
    ctx.moveTo(lx, 0);
    ctx.lineTo(lx, canvas.height);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.font = '700 13px Inter, sans-serif';
  ctx.textAlign = 'center';
  LANE_CENTERS.forEach((cx, i) => {
    const dirText = i < 2 ? '▲ NB L' + (i + 1) : '▼ SB L' + (i + 1);
    ctx.fillText(dirText, cx, 78);
    ctx.fillText(dirText, cx, canvas.height - 22);
  });

  // Overhead Highway Interchange Gantry Sign
  ctx.save();
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(ROAD_LEFT - 14, 28);
  ctx.lineTo(ROAD_RIGHT + 14, 28);
  ctx.stroke();

  const gantryText =
    activeCamera.gantrySign || `${activeCamera.id} • ${activeCamera.name.toUpperCase()}`;
  const signW = 485;
  const signX = (canvas.width - signW) / 2;
  ctx.fillStyle = '#064e3b';
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1.8;
  ctx.fillRect(signX, 10, signW, 32);
  ctx.strokeRect(signX, 10, signW, 32);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 11.2px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(gantryText, canvas.width / 2, 30);
  ctx.restore();

  if (shockwaveActive) {
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(
      shockwaveZone.x,
      shockwaveZone.y,
      shockwaveZone.radius,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fcd34d';
    ctx.font = '700 11px JetBrains Mono, monospace';
    ctx.fillText(
      '⚠ ACTIVE CONGESTION & EMISSION SHOCKWAVE ZONE',
      shockwaveZone.x,
      shockwaveZone.y - shockwaveZone.radius - 8
    );
    ctx.restore();
  }
}

/**
 * Render Tailpipe Pollutant Dispersion Plume Field
 * Scales radial plume intensity by each vehicle's real-time CO2 & NOx emission rate
 */
function renderThermalHeatmapLayer() {
  if (!document.getElementById('toggleHeatmap').checked) return;

  for (const v of vehicles) {
    const co2 = v.emissions?.co2Gps || 2.0;
    const nox = v.emissions?.noxMgps || 10.0;
    if (v.speedKmh > clusterParams.speedThreshold + 15 && co2 < 4.5) continue;

    const plumeRadius = Math.min(88, 38 + co2 * 3.2);
    const intensity = Math.max(0.08, Math.min(0.42, (co2 / 18) + (nox / 260)));
    const grad = ctx.createRadialGradient(v.x, v.y, 4, v.x, v.y, plumeRadius);
    grad.addColorStop(0, `rgba(239, 68, 68, ${intensity})`);
    grad.addColorStop(0.5, `rgba(245, 158, 11, ${intensity * 0.6})`);
    grad.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(v.x, v.y, plumeRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Render Vehicles + Bounding Boxes + Speed + Empirical Emission Rate Badges
 */
function renderVehiclesAndDetections() {
  const showBBox = document.getElementById('toggleBBox').checked;
  const showFactors = document.getElementById('toggleVehicleFactors')?.checked;
  const showTrails = document.getElementById('toggleTrails').checked;
  const speedLimit = activeCamera.speedLimitKmh || 95;

  for (const v of vehicles) {
    if (showTrails && v.trail.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < v.trail.length; i++) {
        const pt = v.trail[i];
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = v.color + '66';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    if (!isCustomVideoMode) {
      ctx.save();
      ctx.translate(v.x, v.y);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(-v.w / 2 + 3, -v.h / 2 + 4, v.w, v.h);

      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = v.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-v.w / 2, -v.h / 2, v.w, v.h, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = v.color + '44';
      ctx.fillRect(-v.w / 2 + 4, -v.h / 4, v.w - 8, v.h / 2);

      const isNB = v.direction === 'NB';
      const frontY = isNB ? -v.h / 2 : v.h / 2 - 3;
      const rearY = isNB ? v.h / 2 - 3 : -v.h / 2;

      ctx.fillStyle = '#fef08a';
      ctx.fillRect(-v.w / 2 + 3, frontY, 6, 3);
      ctx.fillRect(v.w / 2 - 9, frontY, 6, 3);

      ctx.fillStyle = v.braking ? '#ef4444' : '#7f1d1d';
      ctx.fillRect(-v.w / 2 + 3, rearY, 7, 3);
      ctx.fillRect(v.w / 2 - 10, rearY, 7, 3);
      ctx.restore();
    }

    if (showBBox) {
      const co2 = v.emissions?.co2Gps ?? 2.2;
      const isHighEmitter = co2 >= 6.5;
      const isCongested = v.speedKmh <= clusterParams.speedThreshold;
      const isOverspeed = v.speedKmh > speedLimit;
      const boxColor = isOverspeed
        ? '#f43f5e'
        : isCongested || isHighEmitter
        ? '#f59e0b'
        : '#00e5ff';

      const bx = v.x - v.w / 2 - 4;
      const by = v.y - v.h / 2 - 4;
      const bw = v.w + 8;
      const bh = v.h + 8;

      ctx.strokeStyle = boxColor;
      ctx.lineWidth = 1.6;
      ctx.strokeRect(bx, by, bw, bh);

      // Primary Line: ID, Class, Speed, Live CO2 Rate (g/s)
      const labelText = `#${v.id} ${v.cls} • ${Math.round(v.speedKmh)} km/h • ${co2}g/s CO₂`;
      ctx.font = '700 9.5px JetBrains Mono, monospace';
      const textWidth = ctx.measureText(labelText).width + 8;

      const tagHeight = showFactors ? 27 : 15;
      const tagY = by - tagHeight - 1;

      ctx.fillStyle = 'rgba(8, 13, 26, 0.9)';
      ctx.fillRect(bx, tagY, textWidth, tagHeight);
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, tagY, textWidth, tagHeight);

      ctx.fillStyle = boxColor;
      ctx.textAlign = 'left';
      ctx.fillText(labelText, bx + 4, tagY + 10);

      // Secondary Line: Empirical Factors (Fuel Type, Engine CC, Weight, Age)
      if (showFactors) {
        const massStr =
          v.weightKg >= 1000
            ? `${(v.weightKg / 1000).toFixed(1)}t`
            : `${v.weightKg}kg`;
        const ccStr = v.engineCcL > 0 ? `${v.engineCcL}L` : 'EV';
        const factorText = `${v.fuelType} ${ccStr} • ${massStr} • ${v.ageYears}yr`;
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '500 8.8px JetBrains Mono, monospace';
        ctx.fillText(factorText, bx + 4, tagY + 22);
      }
    }
  }
}

/**
 * Render Virtual Line-Crossing Tripwire & Crossing Flash Animations
 */
function renderTripwireLayer() {
  if (!document.getElementById('toggleTripwire').checked) return;

  const tripwireY = canvas.height * activeCamera.tripwireYRatio;

  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(ROAD_LEFT - 15, tripwireY);
  ctx.lineTo(ROAD_RIGHT + 15, tripwireY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(0, 229, 255, 0.16)';
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 1;
  ctx.fillRect(14, tripwireY - 13, 145, 24);
  ctx.strokeRect(14, tripwireY - 13, 145, 24);

  ctx.fillStyle = '#00e5ff';
  ctx.font = '700 10.5px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`TRIPWIRE Y=${Math.round(tripwireY)}px`, 22, tripwireY + 3);

  for (let i = tripwireFlashes.length - 1; i >= 0; i--) {
    const fl = tripwireFlashes[i];
    ctx.strokeStyle = `rgba(16, 185, 129, ${fl.alpha})`;
    ctx.fillStyle = `rgba(16, 185, 129, ${fl.alpha * 0.3})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(fl.x, fl.y, (1.2 - fl.alpha) * 34 + 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = `rgba(110, 231, 183, ${fl.alpha})`;
    ctx.font = '700 10.5px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      `+1 ${fl.dir} (${Math.round(fl.speed)} km/h • ${fl.co2}g/s)`,
      fl.x,
      fl.y - 16
    );

    fl.alpha -= 0.032;
    if (fl.alpha <= 0) tripwireFlashes.splice(i, 1);
  }
  ctx.restore();
}

/**
 * Render Autonomous Multi-Density Congestion & Pollution Hotspot Hulls
 */
function renderDBSCANHotspotLayer() {
  if (!document.getElementById('toggleClusters').checked) return;

  const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.05;

  for (const cluster of activeClusters) {
    const {
      centroid,
      radiusPx,
      severity,
      clusterId,
      vehicleCount,
      avgSpeedKmh,
      densityRegime,
      co2Gps,
      noxMgps,
      localAqi,
      members
    } = cluster;

    const colorRGB =
      severity === 'CRITICAL'
        ? '239, 68, 68'
        : severity === 'HIGH'
        ? '245, 158, 11'
        : '59, 130, 246';

    ctx.save();

    // Spatial-emission mutual reachability graph edges
    ctx.strokeStyle = `rgba(${colorRGB}, 0.55)`;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        ctx.beginPath();
        ctx.moveTo(members[i].x, members[i].y);
        ctx.lineTo(members[j].x, members[j].y);
        ctx.stroke();
      }
    }

    // Outer Dispersion Plume Ring
    ctx.fillStyle = `rgba(${colorRGB}, 0.11)`;
    ctx.strokeStyle = `rgba(${colorRGB}, 0.55)`;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(centroid.x, centroid.y, radiusPx * 1.18 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inner Core Multi-Density Ring
    ctx.fillStyle = `rgba(${colorRGB}, 0.16)`;
    ctx.strokeStyle = `rgba(${colorRGB}, 0.95)`;
    ctx.lineWidth = 2.4;
    ctx.setLineDash([9, 5]);
    ctx.beginPath();
    ctx.arc(centroid.x, centroid.y, radiusPx * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = `rgb(${colorRGB})`;
    ctx.beginPath();
    ctx.arc(centroid.x, centroid.y, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Floating Multi-Density Pollution & Congestion Callout Box
    const badgeW = 258;
    const badgeH = 52;
    const bx = Math.min(
      canvas.width - badgeW - 10,
      Math.max(10, centroid.x - badgeW / 2)
    );
    const by = Math.max(46, centroid.y - radiusPx - 58);

    ctx.fillStyle = 'rgba(8, 13, 26, 0.94)';
    ctx.strokeStyle = `rgb(${colorRGB})`;
    ctx.lineWidth = 1.6;
    ctx.fillRect(bx, by, badgeW, badgeH);
    ctx.strokeRect(bx, by, badgeW, badgeH);

    ctx.fillStyle = `rgb(${colorRGB})`;
    ctx.font = '700 10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${clusterId} [${densityRegime}] • AQI ${localAqi}`,
      bx + 7,
      by + 14
    );

    ctx.fillStyle = '#f8fafc';
    ctx.font = '600 9.8px JetBrains Mono, monospace';
    ctx.fillText(
      `CO₂: ${co2Gps} g/s | NOx: ${noxMgps} mg/s`,
      bx + 7,
      by + 29
    );

    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 9.4px JetBrains Mono, monospace';
    ctx.fillText(
      `${vehicleCount} veh @ ${avgSpeedKmh} km/h (${severity})`,
      bx + 7,
      by + 44
    );

    ctx.restore();
  }
}

/**
 * Update Live DOM KPIs (Traffic + Live Emission Rates + Multi-Density Hotspots)
 */
function updateLiveDashboardDOM() {
  document.getElementById('fpsReadout').textContent = Math.round(fpsSmooth);
  document.getElementById('activeTracksReadout').textContent = vehicles.length;

  document.getElementById('kpiTotalCount').textContent = crossingCounts.total;
  document.getElementById(
    'kpiDirectionalSplit'
  ).textContent = `▲ NB: ${crossingCounts.northbound}  |  ▼ SB: ${crossingCounts.southbound}`;

  const speeds = vehicles.map((v) => v.speedKmh).sort((a, b) => a - b);
  const meanSpeed =
    speeds.length > 0
      ? speeds.reduce((a, b) => a + b, 0) / speeds.length
      : 0;
  const p85Speed =
    speeds.length > 0
      ? speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.85))]
      : 0;

  document.getElementById('kpiMeanSpeed').textContent = meanSpeed.toFixed(1);
  document.getElementById(
    'kpiP85Speed'
  ).textContent = `P85: ${p85Speed.toFixed(1)} km/h • Viol: ${
    crossingCounts.overspeed
  }`;

  // Update Live Emission Rate KPIs
  document.getElementById('kpiCo2Rate').textContent =
    liveCorridorEmissions.totalCo2Gps.toFixed(1);
  document.getElementById(
    'kpiCo2Hourly'
  ).textContent = `${liveCorridorEmissions.co2KgPerHour} kg/hr corridor flux`;

  document.getElementById('kpiNoxRate').textContent =
    liveCorridorEmissions.totalNoxMgps.toFixed(1);
  document.getElementById(
    'kpiPm25Rate'
  ).textContent = `PM2.5: ${liveCorridorEmissions.totalPm25Mgps} mg/s | CO: ${Math.round(
    liveCorridorEmissions.totalCoMgps
  )} mg/s`;

  // Active Multi-Density Hotspots & AQI KPI
  const clusteredVehCount = activeClusters.reduce(
    (s, c) => s + c.vehicleCount,
    0
  );
  document.getElementById('kpiHotspotCount').textContent = activeClusters.length;
  document.getElementById(
    'kpiAqiBadge'
  ).textContent = `AQI ${liveCorridorEmissions.corridorAqi}`;
  document.getElementById(
    'kpiClusterVehicles'
  ).textContent = `${clusteredVehCount} veh in multi-density plumes`;
  document.getElementById(
    'liveClusterBadge'
  ).textContent = `${activeClusters.length} Active (Auto-k)`;

  // Level of Service (LoS A-F)
  const ratio = meanSpeed / (activeCamera.speedLimitKmh || 95);
  let los = 'B';
  let losDesc = 'Reasonably Free Flow';
  if (ratio >= 0.84 && activeClusters.length === 0) {
    los = 'A';
    losDesc = 'Free Flow • Minimal Emissions';
  } else if (ratio >= 0.7 && activeClusters.length <= 1) {
    los = 'B';
    losDesc = 'Reasonably Free Flow';
  } else if (ratio >= 0.56) {
    los = 'C';
    losDesc = 'Stable • Moderate NOx Flux';
  } else if (ratio >= 0.44) {
    los = 'D';
    losDesc = 'Unstable • Plume Forming';
  } else if (ratio >= 0.32) {
    los = 'E';
    losDesc = 'Severe Congestion & Smog Plume';
  } else {
    los = 'F';
    losDesc = 'Gridlock Emission Breakdown';
  }

  const losBadge = document.getElementById('kpiLosBadge');
  losBadge.textContent = `LoS ${los}`;
  losBadge.className = `los-badge los-${los.toLowerCase()}`;
  document.getElementById('kpiLosDesc').textContent = losDesc;
  const flowRateVal = Math.round(vehicles.length * 3.4);
  document.getElementById('kpiFlowRate').textContent = `${flowRateVal} veh/m`;

  // Broadcast live telemetry, emission rates & multi-density hotspots to Separate Map Window
  syncChannel.postMessage({
    type: 'LIVE_TELEMETRY_TICK',
    cameraId: activeCamera.id,
    meanSpeedKmh: Number(meanSpeed.toFixed(1)),
    p85SpeedKmh: Number(p85Speed.toFixed(1)),
    flowRate: flowRateVal,
    totalCount: crossingCounts.total,
    los,
    emissionMetrics: liveCorridorEmissions,
    clusters: activeClusters.map((c) => ({
      clusterId: c.clusterId,
      zoneLabel: c.zoneLabel,
      centroid: c.centroid,
      radiusPx: c.radiusPx,
      vehicleCount: c.vehicleCount,
      avgSpeedKmh: c.avgSpeedKmh,
      dwellTimeSec: c.dwellTimeSec,
      densityRegime: c.densityRegime,
      co2Gps: c.co2Gps,
      noxMgps: c.noxMgps,
      pm25Mgps: c.pm25Mgps,
      localAqi: c.localAqi,
      severity: c.severity,
      severityScore: c.severityScore
    })),
    vehicles: vehicles.map((v) => ({
      id: v.id,
      x: Math.round(v.x),
      y: Math.round(v.y),
      speedKmh: Math.round(v.speedKmh),
      co2Gps: v.emissions?.co2Gps || 2.2,
      direction: v.direction
    }))
  });

  // Active Multi-Density Clusters Table
  const tbody = document.getElementById('liveClustersTableBody');
  if (activeClusters.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">No multi-density congestion or pollution hotspots detected</td></tr>`;
  } else {
    tbody.innerHTML = activeClusters
      .map(
        (c) => `
      <tr>
        <td><strong style="color:#00e5ff;font-family:var(--font-mono)">${c.clusterId}</strong></td>
        <td>
          <span class="density-tag">${c.densityRegime}</span><br/>
          <span class="sub-label">${c.zoneLabel}</span>
        </td>
        <td style="font-family:var(--font-mono)">${c.vehicleCount} veh<br/>${c.avgSpeedKmh} km/h</td>
        <td style="font-family:var(--font-mono)">
          <strong style="color:#38bdf8">${c.co2Gps} g/s CO₂</strong><br/>
          <span style="color:#fbbf24">${c.noxMgps} mg/s NOx</span> • ${c.pm25Mgps} PM2.5
        </td>
        <td><span class="sev-pill sev-${c.severity}">AQI ${c.localAqi} (${c.severity})</span></td>
      </tr>
    `
      )
      .join('');
  }
}

/**
 * Main Frame-by-Frame Inference & Rendering Loop
 */
function mainInferenceLoop(now) {
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  fpsSmooth = fpsSmooth * 0.92 + (1 / Math.max(0.001, dt)) * 0.08;
  frameCounter++;

  if (!isPaused) {
    if (isCustomVideoMode) {
      updateCustomVideoInference(now);
    } else {
      updateSimulatedTraffic(dt);
    }
    runLiveStreamClustering();
  }

  renderSceneBackground();
  renderThermalHeatmapLayer();
  renderTripwireLayer();
  renderVehiclesAndDetections();
  renderDBSCANHotspotLayer();

  if (frameCounter % 6 === 0) {
    updateLiveDashboardDOM();
  }

  requestAnimationFrame(mainInferenceLoop);
}

/**
 * Seed & Render 60-Second Sliding Window Speed, CO2 Rate & NOx Flux Chart
 */
function seedTelemetryHistory() {
  telemetryHistory = [];
  for (let i = 0; i < 40; i++) {
    telemetryHistory.push({
      meanSpeed: 54 + Math.sin(i * 0.25) * 8,
      co2RateGps: 72 + Math.cos(i * 0.22) * 14,
      noxScaled: 48 + Math.sin(i * 0.18) * 12
    });
  }
  drawTelemetryChart();
}

function recordTelemetryPoint() {
  if (isPaused) return;
  const speeds = vehicles.map((v) => v.speedKmh).sort((a, b) => a - b);
  const meanSpeed =
    speeds.length > 0
      ? speeds.reduce((a, b) => a + b, 0) / speeds.length
      : 52;
  const co2RateGps = liveCorridorEmissions.totalCo2Gps || 65;
  const noxScaled = Math.min(115, (liveCorridorEmissions.totalNoxMgps || 300) / 6);

  telemetryHistory.push({ meanSpeed, co2RateGps, noxScaled });
  if (telemetryHistory.length > 45) telemetryHistory.shift();
  drawTelemetryChart();
}

function drawTelemetryChart() {
  const w = chartCanvas.width;
  const h = chartCanvas.height;
  chartCtx.clearRect(0, 0, w, h);

  const padL = 34;
  const padR = 14;
  const padT = 20;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  chartCtx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  chartCtx.fillStyle = '#8fa3c7';
  chartCtx.font = '10px JetBrains Mono, monospace';
  chartCtx.textAlign = 'right';

  [0, 40, 80, 120].forEach((val) => {
    const y = padT + plotH - (val / 130) * plotH;
    chartCtx.beginPath();
    chartCtx.moveTo(padL, y);
    chartCtx.lineTo(w - padR, y);
    chartCtx.stroke();
    chartCtx.fillText(`${val}`, padL - 5, y + 3);
  });

  if (telemetryHistory.length < 2) return;

  const stepX = plotW / (telemetryHistory.length - 1);

  // Draw NOx Flux Bars (Amber)
  telemetryHistory.forEach((pt, idx) => {
    const x = padL + idx * stepX;
    const barH = Math.min(plotH, (pt.noxScaled / 130) * plotH);
    chartCtx.fillStyle = 'rgba(245, 158, 11, 0.25)';
    chartCtx.fillRect(x - 3, padT + plotH - barH, 6, barH);
  });

  // Draw Live CO2 Emission Rate Line (Red/Rose)
  chartCtx.strokeStyle = '#f43f5e';
  chartCtx.lineWidth = 2.0;
  chartCtx.beginPath();
  telemetryHistory.forEach((pt, idx) => {
    const x = padL + idx * stepX;
    const y = padT + plotH - (Math.min(130, pt.co2RateGps) / 130) * plotH;
    if (idx === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  });
  chartCtx.stroke();

  // Draw Mean Speed Line (Cyan)
  chartCtx.strokeStyle = '#00e5ff';
  chartCtx.lineWidth = 2.2;
  chartCtx.beginPath();
  telemetryHistory.forEach((pt, idx) => {
    const x = padL + idx * stepX;
    const y = padT + plotH - (Math.min(130, pt.meanSpeed) / 130) * plotH;
    if (idx === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  });
  chartCtx.stroke();

  // Legend
  chartCtx.textAlign = 'left';
  chartCtx.fillStyle = '#00e5ff';
  chartCtx.fillText('● Speed (km/h)', padL + 4, 12);
  chartCtx.fillStyle = '#f43f5e';
  chartCtx.fillText('● CO₂ Rate (g/s)', padL + 115, 12);
  chartCtx.fillStyle = '#fbbf24';
  chartCtx.fillText('▮ NOx Flux (scaled)', padL + 235, 12);
}

/**
 * Render Empirical Emission Factors & Vehicle Classification Breakdown
 */
function renderClassDistributionBars() {
  const container = document.getElementById('classBarsContainer');
  const total = Object.values(classCounts).reduce((a, b) => a + b, 0) || 1;
  const metaProfiles = {
    Car: { color: '#38bdf8', factor: 'Gas/Hyb/EV • ~1.5t • 2.0L' },
    'SUV / Van': { color: '#818cf8', factor: 'Gas/Diesel • ~2.3t • 3.2L' },
    Truck: { color: '#f59e0b', factor: 'Heavy Diesel • ~17t • 10.8L' },
    Bus: { color: '#10b981', factor: 'Transit Diesel • ~14t • 8.9L' },
    Motorcycle: { color: '#f472b6', factor: 'Gasoline • ~0.24t • 0.65L' }
  };

  container.innerHTML = Object.entries(classCounts)
    .map(([cls, count]) => {
      const pct = ((count / total) * 100).toFixed(1);
      const prof = metaProfiles[cls] || { color: '#38bdf8', factor: '' };
      return `
      <div class="class-bar-row" style="grid-template-columns: 155px 1fr 68px;">
        <div>
          <strong>${cls}</strong>
          <div style="font-size:0.63rem;color:var(--text-muted);font-family:var(--font-mono)">${prof.factor}</div>
        </div>
        <div class="class-bar-track">
          <div class="class-bar-fill" style="width:${pct}%;background:${prof.color}"></div>
        </div>
        <span class="class-bar-count">${count} (${pct}%)</span>
      </div>
    `;
    })
    .join('');
}

/**
 * Push a Live Telemetry + Emission Snapshot to the Backend Agent
 */
async function triggerAgentReportPush(triggerSource = 'Manual User Trigger') {
  const payload = {
    cameraId: activeCamera.id,
    triggerSource,
    windowDurationSec: 180,
    eps: clusterParams.eps,
    minPts: clusterParams.minPts,
    speedThreshold: clusterParams.speedThreshold,
    crossings: {
      total: crossingCounts.total,
      northbound: crossingCounts.northbound,
      southbound: crossingCounts.southbound
    },
    overspeedCount: crossingCounts.overspeed,
    emissionMetrics: liveCorridorEmissions,
    classDistribution: { ...classCounts },
    vehicles: vehicles.map((v) => ({
      id: v.id,
      cls: v.cls,
      x: Math.round(v.x),
      y: Math.round(v.y),
      speedKmh: Number(v.speedKmh.toFixed(1)),
      weightKg: v.weightKg,
      fuelType: v.fuelType,
      ageYears: v.ageYears,
      engineCcL: v.engineCcL,
      emissions: v.emissions,
      direction: v.direction
    })),
    clusters: activeClusters.map((c) => ({
      clusterId: c.clusterId,
      zoneLabel: c.zoneLabel,
      centroid: c.centroid,
      radiusPx: c.radiusPx,
      vehicleCount: c.vehicleCount,
      avgSpeedKmh: c.avgSpeedKmh,
      dwellTimeSec: c.dwellTimeSec,
      densityRegime: c.densityRegime,
      co2Gps: c.co2Gps,
      noxMgps: c.noxMgps,
      pm25Mgps: c.pm25Mgps,
      localAqi: c.localAqi,
      severity: c.severity,
      severityScore: c.severityScore,
      cause:
        c.severity === 'CRITICAL'
          ? `Multi-density stop-and-go shockwave & heavy diesel plume (${c.co2Gps} g/s CO2, AQI ${c.localAqi})`
          : `Localized platoon deceleration & elevated tailpipe NOx (${c.noxMgps} mg/s)`
    }))
  };

  try {
    let newReport = null;
    try {
      const res = await fetch('/api/agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        newReport = data.report;
      }
    } catch (_) {
      // Static GitHub Pages fallback
    }

    if (!newReport) {
      newReport = buildClientSideAgentReport(payload);
      syncChannel.postMessage({ type: 'NEW_AGENT_REPORT', report: newReport });
      const co2Str = newReport.emissionMetrics
        ? ` • ${newReport.emissionMetrics.totalCo2Gps} g/s CO2`
        : '';
      showToast(
        `Agent pushed report ${newReport.reportId} (${newReport.cameraId} • LoS ${newReport.summary.levelOfService}${co2Str})`
      );
    }

    if (newReport) {
      const exists = reports.some((r) => r.reportId === newReport.reportId);
      if (!exists) {
        reports.unshift(newReport);
        renderReportsFeed(newReport.reportId);
      }
    }
  } catch (err) {
    console.error('Failed to push agent analysis report:', err);
  }
}

function buildClientSideAgentReport(payload) {
  const speeds = (payload.vehicles || []).map((v) => v.speedKmh);
  const sorted = [...speeds].sort((a, b) => a - b);
  const meanSpeedKmh =
    speeds.length > 0
      ? Number((speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1))
      : 54.2;
  const p50SpeedKmh =
    sorted.length > 0
      ? Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(1))
      : 52.0;
  const p85SpeedKmh =
    sorted.length > 0
      ? Number(sorted[Math.floor(sorted.length * 0.85)].toFixed(1))
      : 78.4;
  const minSpeedKmh = sorted.length > 0 ? Number(sorted[0].toFixed(1)) : 12.0;
  const maxSpeedKmh =
    sorted.length > 0 ? Number(sorted[sorted.length - 1].toFixed(1)) : 98.0;

  const clusters = payload.clusters || [];
  const ratio = meanSpeedKmh / (activeCamera.speedLimitKmh || 100);
  let levelOfService = 'B';
  let losDescription = 'Reasonably Free Flow';
  if (ratio < 0.35 || clusters.length >= 2) {
    levelOfService = 'F';
    losDescription = 'Forced Breakdown & Multi-Density Congestion';
  } else if (ratio < 0.5 || clusters.length === 1) {
    levelOfService = 'E';
    losDescription = 'Unstable Flow Near Capacity';
  } else if (ratio < 0.68) {
    levelOfService = 'D';
    losDescription = 'Approaching Unstable Flow';
  } else if (ratio < 0.82) {
    levelOfService = 'C';
    losDescription = 'Stable Flow';
  }

  const em = payload.emissionMetrics || liveCorridorEmissions;
  const aqiCategory =
    em.corridorAqi >= 151
      ? 'Unhealthy'
      : em.corridorAqi >= 101
      ? 'Unhealthy for Sensitive Groups'
      : 'Moderate';

  const recommendations = [];
  if (clusters.length > 0) {
    const worst = clusters[0];
    recommendations.push(
      `[ECO-VSL & HOTSPOT MITIGATION] Activate smooth eco-speed harmonization (${Math.max(
        50,
        activeCamera.speedLimitKmh - 25
      )} km/h) upstream of ${worst.zoneLabel} to dissolve ${
        worst.densityRegime || 'Multi-Density'
      } Hotspot ${worst.clusterId} (${worst.co2Gps || 38.4} g/s CO2, ${
        worst.noxMgps || 185
      } mg/s NOx, Local AQI ${worst.localAqi || em.corridorAqi}).`
    );
  }
  recommendations.push(
    `[SIGNAL & RAMP PROGRESSION] Maintain green-wave progression along ${activeCamera.name} (LoS ${levelOfService}, ${em.totalCo2Gps} g/s CO2) to minimize stop-and-go acceleration emission spikes.`
  );

  const anomalies =
    clusters.length > 0
      ? clusters.map((c) => ({
          timeOffset: 'LIVE',
          type:
            c.severity === 'CRITICAL'
              ? 'MULTI_DENSITY_POLLUTION_HOTSPOT'
              : 'CONGESTION_EMISSION_MICROCLUSTER',
          detail: `Cluster ${c.clusterId} [${c.densityRegime || 'DENSE CORE'}] at (${c.centroid.x}, ${c.centroid.y}): ${c.vehicleCount} veh @ ${c.avgSpeedKmh} km/h emitting ${c.co2Gps} g/s CO2 & ${c.noxMgps} mg/s NOx (Local AQI ${c.localAqi}).`
        }))
      : [
          {
            timeOffset: 'LIVE',
            type: 'ECO_FLOW_NOMINAL',
            detail: `Multi-density stream clustering verified zero pollution bottlenecks (${em.totalCo2Gps} g/s CO2, Corridor AQI ${em.corridorAqi}).`
          }
        ];

  return {
    reportId: `RPT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(
      reports.length + 1
    ).padStart(3, '0')}`,
    timestamp: new Date().toISOString(),
    cameraId: activeCamera.id,
    cameraName: activeCamera.name,
    triggerSource: payload.triggerSource || 'Unified Traffic & Emission Stream Agent',
    agentVersion: 'MultiDensity-DenStream-COPERT Agent v3.0',
    windowDurationSec: payload.windowDurationSec || 180,
    summary: {
      totalVehiclesCounted: payload.crossings.total,
      northboundCount: payload.crossings.northbound,
      southboundCount: payload.crossings.southbound,
      flowRateVehPerMin: Number((payload.crossings.total / 3).toFixed(1)),
      meanSpeedKmh,
      p50SpeedKmh,
      p85SpeedKmh,
      minSpeedKmh,
      maxSpeedKmh,
      overspeedCount: payload.overspeedCount || 0,
      levelOfService,
      losDescription,
      congestionIndex: Number(Math.min(0.98, Math.max(0.08, 1 - ratio)).toFixed(2))
    },
    emissionMetrics: {
      model:
        'COPERT-VSP Empirical Emission Model (Vehicle Class + Weight + Fuel + Age + Engine CC)',
      totalCo2Gps: em.totalCo2Gps,
      co2KgPerHour: em.co2KgPerHour,
      totalNoxMgps: em.totalNoxMgps,
      totalPm25Mgps: em.totalPm25Mgps,
      totalCoMgps: em.totalCoMgps,
      corridorAqi: em.corridorAqi,
      aqiCategory,
      avgFleetAgeYears: 5.8,
      avgEngineCapacityL: 3.1
    },
    classDistribution: payload.classDistribution,
    clusteringMetrics: {
      algorithm:
        'Autonomous Multi-Density HDBSCAN / DenStream (No pre-specified k, Mutual-Reachability Spatial-Velocity-Emission Clustering)',
      activeHotspots: clusters.length,
      peakClusterDensity:
        clusters.length > 0
          ? Number(Math.max(...clusters.map((c) => c.vehicleCount * 1.2)).toFixed(1))
          : 1.2,
      clusters
    },
    recommendations,
    anomalies
  };
}

/**
 * Render Pushed Agent Reports Feed in the Right Column
 */
function renderReportsFeed(highlightReportId = null) {
  const feedEl = document.getElementById('reportsFeedContainer');
  const filterVal = document.getElementById('reportFilterSelect').value;

  const filtered =
    filterVal === 'ALL'
      ? reports
      : reports.filter((r) => r.cameraId === filterVal);

  if (filtered.length === 0) {
    feedEl.innerHTML = `<div class="empty-cell">No reports for selected camera filter.</div>`;
    return;
  }

  feedEl.innerHTML = filtered
    .map((r) => {
      const timeStr = new Date(r.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const topRec =
        r.recommendations && r.recommendations[0]
          ? r.recommendations[0]
          : 'Flow nominal.';
      const isNew = r.reportId === highlightReportId ? 'new-flash' : '';
      const em = r.emissionMetrics || {
        totalCo2Gps: 84.2,
        totalNoxMgps: 420,
        corridorAqi: 118
      };

      return `
      <div class="report-card ${isNew}" data-report-id="${r.reportId}">
        <div class="report-card-top">
          <div>
            <span class="report-id-pill">${r.reportId}</span>
            <span class="los-badge los-${r.summary.levelOfService.toLowerCase()}" style="font-size:0.7rem;padding:0.08rem 0.38rem;margin-left:0.3rem;">
              LoS ${r.summary.levelOfService}
            </span>
            <span class="sev-pill ${
              em.corridorAqi >= 140 ? 'sev-CRITICAL' : 'sev-HIGH'
            }" style="margin-left:0.25rem;">
              AQI ${em.corridorAqi}
            </span>
          </div>
          <span class="report-time">${timeStr}</span>
        </div>
        <div class="report-cam-name">${r.cameraId}: ${r.cameraName}</div>
        <div class="report-metrics-strip">
          <div class="rm-item"><span>Veh / Speed</span><strong>${r.summary.totalVehiclesCounted} • ${r.summary.meanSpeedKmh} km/h</strong></div>
          <div class="rm-item"><span>CO₂ Rate</span><strong style="color:#38bdf8">${em.totalCo2Gps} g/s</strong></div>
          <div class="rm-item"><span>NOx Flux</span><strong style="color:#fbbf24">${em.totalNoxMgps} mg/s</strong></div>
          <div class="rm-item"><span>Hotspots</span><strong style="color:#f87171">${r.clusteringMetrics.activeHotspots} (Auto-k)</strong></div>
        </div>
        <div class="report-rec-preview">${topRec}</div>
      </div>
    `;
    })
    .join('');

  feedEl.querySelectorAll('.report-card').forEach((card) => {
    card.addEventListener('click', () => {
      const repId = card.getAttribute('data-report-id');
      const reportObj = reports.find((x) => x.reportId === repId);
      if (reportObj) openReportModal(reportObj);
    });
  });
}

/**
 * Open Detailed Report Inspector Modal (Traffic + COPERT-VSP Emissions + Multi-Density Hotspots)
 */
function openReportModal(report) {
  selectedModalReport = report;
  const em = report.emissionMetrics || {
    model: 'COPERT-VSP Empirical Emission Model',
    totalCo2Gps: 92.4,
    co2KgPerHour: 332.6,
    totalNoxMgps: 480.0,
    totalPm25Mgps: 24.5,
    totalCoMgps: 720.0,
    corridorAqi: 128,
    aqiCategory: 'Unhealthy for Sensitive Groups'
  };

  document.getElementById('modalReportId').textContent = report.reportId;
  document.getElementById(
    'modalReportTitle'
  ).textContent = `${report.cameraId} — ${report.cameraName}`;
  document.getElementById(
    'modalReportMeta'
  ).textContent = `Generated ${new Date(
    report.timestamp
  ).toLocaleString()} • ${report.agentVersion} • ${
    report.clusteringMetrics.algorithm
  }`;

  const clustersHtml =
    report.clusteringMetrics.clusters.length === 0
      ? `<p class="sub-label">Zero persistent multi-density congestion or pollution hotspots detected during window.</p>`
      : `<table class="data-table">
          <thead>
            <tr>
              <th>Hotspot ID</th>
              <th>Multi-Density Regime & Zone</th>
              <th>Veh / Avg Speed</th>
              <th>CO₂ Rate</th>
              <th>NOx / PM₂.₅</th>
              <th>Local AQI & Severity</th>
            </tr>
          </thead>
          <tbody>
            ${report.clusteringMetrics.clusters
              .map(
                (c) => `
              <tr>
                <td><strong style="color:#00e5ff;font-family:var(--font-mono)">${c.clusterId}</strong></td>
                <td>
                  <span class="density-tag">${c.densityRegime || 'MULTI-DENSITY CORE'}</span><br/>
                  <strong>${c.zoneLabel}</strong><br/>
                  <span class="sub-label">${c.cause || ''}</span>
                </td>
                <td style="font-family:var(--font-mono)">${c.vehicleCount} veh<br/>${c.avgSpeedKmh} km/h (${c.dwellTimeSec}s)</td>
                <td style="font-family:var(--font-mono);color:#38bdf8"><strong>${c.co2Gps || 42.0} g/s</strong></td>
                <td style="font-family:var(--font-mono)">${c.noxMgps || 210} mg/s NOx<br/>${c.pm25Mgps || 11.2} mg/s PM2.5</td>
                <td><span class="sev-pill sev-${c.severity}">AQI ${c.localAqi || 142} • ${c.severity}</span></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>`;

  const bodyEl = document.getElementById('modalReportBody');
  bodyEl.innerHTML = `
    <div>
      <div class="modal-section-title">1. Executive Traffic & Speed Telemetry Summary</div>
      <div class="modal-kpi-grid">
        <div class="modal-kpi-box">
          <span>Total Vehicles (NB / SB)</span>
          <strong>${report.summary.totalVehiclesCounted} (${report.summary.northboundCount} / ${report.summary.southboundCount})</strong>
        </div>
        <div class="modal-kpi-box">
          <span>Mean / Median (P50) Speed</span>
          <strong>${report.summary.meanSpeedKmh} / ${report.summary.p50SpeedKmh} km/h</strong>
        </div>
        <div class="modal-kpi-box">
          <span>P85 Speed / Overspeeds</span>
          <strong>${report.summary.p85SpeedKmh} km/h (${report.summary.overspeedCount} viol.)</strong>
        </div>
        <div class="modal-kpi-box">
          <span>Level of Service (HCM)</span>
          <strong>LoS ${report.summary.levelOfService} (CI: ${report.summary.congestionIndex})</strong>
        </div>
      </div>
    </div>

    <div>
      <div class="modal-section-title">2. Live Empirical Emission Rate Monitoring (Type • Weight • Fuel • Age • Engine CC)</div>
      <div class="modal-kpi-grid">
        <div class="modal-kpi-box">
          <span>Corridor CO₂ Rate</span>
          <strong style="color:#38bdf8">${em.totalCo2Gps} g/s (${em.co2KgPerHour} kg/h)</strong>
        </div>
        <div class="modal-kpi-box">
          <span>Tailpipe NOx Flux</span>
          <strong style="color:#fbbf24">${em.totalNoxMgps} mg/s</strong>
        </div>
        <div class="modal-kpi-box">
          <span>Fine PM₂.₅ & CO Flux</span>
          <strong>${em.totalPm25Mgps} mg/s PM₂.₅ | ${em.totalCoMgps} mg/s CO</strong>
        </div>
        <div class="modal-kpi-box">
          <span>Corridor Air Quality Index</span>
          <strong style="color:#f87171">AQI ${em.corridorAqi} (${em.aqiCategory})</strong>
        </div>
      </div>
      <p class="sub-label" style="margin-top:0.45rem;">
        <strong>Empirical Model:</strong> ${em.model} • Avg Fleet Age: ${em.avgFleetAgeYears || 5.8} yrs • Avg Engine Displacement: ${em.avgEngineCapacityL || 3.2}L
      </p>
    </div>

    <div>
      <div class="modal-section-title">3. Autonomous Multi-Density Congestion & Pollution Hotspots (No Pre-Specified k)</div>
      ${clustersHtml}
    </div>

    <div>
      <div class="modal-section-title">4. Actionable Smart City Eco-Routing & Signal Recommendations</div>
      <ul class="rec-list">
        ${(report.recommendations || []).map((rec) => `<li>✓ ${rec}</li>`).join('')}
      </ul>
    </div>

    <div>
      <div class="modal-section-title">5. Stream Anomaly & Pollution Plume Event Log</div>
      <ul class="anomaly-list">
        ${(report.anomalies || [])
          .map((a) => `<li>[${a.timeOffset}] <strong>${a.type}:</strong> ${a.detail}</li>`)
          .join('')}
      </ul>
    </div>
  `;

  document.getElementById('reportModalBackdrop').style.display = 'flex';
}

function switchActiveCamera(camId) {
  const found = cameras.find((c) => c.id === camId);
  if (found) {
    isCustomVideoMode = false;
    document.getElementById('resetSimBtn').style.display = 'none';
    document.getElementById('detectorName').textContent =
      'YOLOv8 + COPERT-VSP + Multi-Density HDBSCAN';
    activeCamera = found;
    document.getElementById('cameraSelect').value = found.id;
    document.getElementById(
      'activeCamTitle'
    ).textContent = `${found.id}: ${found.name}`;
    document.getElementById('activeCamCoords').textContent = found.location;
    seedInitialTraffic(20);
  }
}

/**
 * Bind UI Controls, Sliders, Video Upload, and Modal Export Actions
 */
function bindUIEvents() {
  const openMapBtn = document.getElementById('openMapWindowBtn');
  if (openMapBtn) {
    openMapBtn.addEventListener('click', () => {
      mapPopupWindow = window.open(
        'map.html',
        'SmartCityCameraMapWindow',
        'width=1320,height=840,resizable=yes,scrollbars=yes'
      );
      if (mapPopupWindow) {
        mapPopupWindow.focus();
      }
    });
  }

  syncChannel.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'SELECT_CAMERA' && msg.cameraId) {
      switchActiveCamera(msg.cameraId);
      showToast(`Camera switched to ${msg.cameraId} from GIS Map Window`);
    } else if (msg.type === 'REQUEST_LIVE_STATE') {
      updateLiveDashboardDOM();
    }
  };

  document.getElementById('cameraSelect').addEventListener('change', (e) => {
    switchActiveCamera(e.target.value);
  });

  document
    .getElementById('triggerShockwaveBtn')
    .addEventListener('click', () => {
      shockwaveActive = true;
      shockwaveZone = {
        lane: 2,
        x: LANE_CENTERS[2],
        y: 265,
        radius: 82
      };
      spawnVehicleInLane(2, 95);
      spawnVehicleInLane(2, 155);
      spawnVehicleInLane(3, 125);
      showToast(
        'Congestion & Diesel emission shockwave injected — watch Multi-Density Hotspot form!'
      );
    });

  document.getElementById('clearShockwaveBtn').addEventListener('click', () => {
    shockwaveActive = false;
    vehicles.forEach((v) => {
      v.braking = false;
      v.targetSpeedKmh = activeCamera.speedLimitKmh * 0.92;
    });
    showToast('Corridor obstruction cleared — emissions returning to free-flow baseline.');
  });

  const pauseBtn = document.getElementById('pauseResumeBtn');
  pauseBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    if (isCustomVideoMode) {
      if (isPaused) uploadedVideo.pause();
      else uploadedVideo.play();
    }
    pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  });

  document
    .getElementById('pushReportNowBtn')
    .addEventListener('click', () => {
      triggerAgentReportPush('Manual Operator Push');
    });

  document.getElementById('epsSlider').addEventListener('input', (e) => {
    clusterParams.eps = Number(e.target.value);
    document.getElementById('epsVal').textContent = `${clusterParams.eps}px`;
  });

  document.getElementById('minPtsSlider').addEventListener('input', (e) => {
    clusterParams.minPts = Number(e.target.value);
    document.getElementById('minPtsVal').textContent = clusterParams.minPts;
  });

  document
    .getElementById('speedThreshSlider')
    .addEventListener('input', (e) => {
      clusterParams.speedThreshold = Number(e.target.value);
      document.getElementById(
        'speedThreshVal'
      ).textContent = `${clusterParams.speedThreshold} km/h`;
    });

  document.getElementById('spawnRateSlider').addEventListener('input', (e) => {
    clusterParams.spawnDensity = Number(e.target.value);
    const labels = { 1: 'Moderate', 2: 'High', 3: 'Peak Jam' };
    document.getElementById('spawnRateVal').textContent =
      labels[clusterParams.spawnDensity] || 'High';
  });

  document
    .getElementById('reportFilterSelect')
    .addEventListener('change', () => renderReportsFeed());

  document
    .getElementById('videoUploadInput')
    .addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const url = URL.createObjectURL(file);
      uploadedVideo.src = url;
      await uploadedVideo.play();

      isCustomVideoMode = true;
      vehicles = [];
      document.getElementById('resetSimBtn').style.display = 'inline-flex';
      document.getElementById(
        'activeCamTitle'
      ).textContent = `UPLOADED FEED: ${file.name}`;
      document.getElementById('detectorName').textContent =
        'Loading TensorFlow.js COCO-SSD...';

      if (!cocoModel && window.cocoSsd) {
        showToast('Loading TensorFlow.js COCO-SSD neural model...');
        cocoModel = await window.cocoSsd.load();
      }
      document.getElementById('detectorName').textContent =
        'TF.js COCO-SSD + COPERT-VSP + HDBSCAN';
      showToast(`Running unified traffic & emission inference on ${file.name}`);
    });

  document.getElementById('resetSimBtn').addEventListener('click', () => {
    isCustomVideoMode = false;
    uploadedVideo.pause();
    document.getElementById('resetSimBtn').style.display = 'none';
    document.getElementById('detectorName').textContent =
      'YOLOv8 + COPERT-VSP + Multi-Density HDBSCAN';
    document.getElementById(
      'activeCamTitle'
    ).textContent = `${activeCamera.id}: ${activeCamera.name}`;
    seedInitialTraffic(20);
  });

  document.getElementById('closeModalBtn').addEventListener('click', () => {
    document.getElementById('reportModalBackdrop').style.display = 'none';
  });

  document
    .getElementById('reportModalBackdrop')
    .addEventListener('click', (e) => {
      if (e.target.id === 'reportModalBackdrop') {
        document.getElementById('reportModalBackdrop').style.display = 'none';
      }
    });

  document
    .getElementById('exportReportJsonBtn')
    .addEventListener('click', () => {
      if (!selectedModalReport) return;
      const blob = new Blob([JSON.stringify(selectedModalReport, null, 2)], {
        type: 'application/json'
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${selectedModalReport.reportId}.json`;
      a.click();
    });

  document
    .getElementById('exportReportCsvBtn')
    .addEventListener('click', () => {
      if (!selectedModalReport) return;
      const r = selectedModalReport;
      const em = r.emissionMetrics || {};
      const rows = [
        ['Report ID', r.reportId],
        ['Timestamp', r.timestamp],
        ['Camera ID', r.cameraId],
        ['Camera Name', r.cameraName],
        ['Total Vehicles', r.summary.totalVehiclesCounted],
        ['Mean Speed (km/h)', r.summary.meanSpeedKmh],
        ['P85 Speed (km/h)', r.summary.p85SpeedKmh],
        ['Level of Service', r.summary.levelOfService],
        ['Corridor CO2 Rate (g/s)', em.totalCo2Gps || 0],
        ['Corridor NOx Flux (mg/s)', em.totalNoxMgps || 0],
        ['Corridor PM2.5 Flux (mg/s)', em.totalPm25Mgps || 0],
        ['Corridor AQI', em.corridorAqi || 0],
        ['Active Multi-Density Hotspots', r.clusteringMetrics.activeHotspots]
      ];
      const csvContent = rows.map((row) => row.join(',')).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${r.reportId}.csv`;
      a.click();
    });

  document.getElementById('printReportBtn').addEventListener('click', () => {
    window.print();
  });
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="status-indicator"></span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4200);
}

window.addEventListener('DOMContentLoaded', initApp);
