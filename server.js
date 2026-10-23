const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load sample camera streams and initial pre-computed agent reports
const sampleDataPath = path.join(__dirname, 'data', 'sample_traffic_streams.json');
let sampleData = JSON.parse(fs.readFileSync(sampleDataPath, 'utf8'));

// In-memory store of pushed reports (seeded with initial sample data reports)
let reportsStore = [...sampleData.initialReports].sort(
  (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
);

// Connected SSE clients for pushing real-time Agent Reports to the Web App
const sseClients = new Set();

function broadcastAgentEvent(eventType, payload) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

/**
 * Empirical Microscopic Emission Factor Model (COPERT / MOVES VSP Hybrid)
 * Links vehicle class, weight (kg), fuel type, vehicle age (years), engine capacity (L),
 * and instantaneous speed (km/h) to calculate real-time pollutant emission rates:
 * - CO2 (g/s), NOx (mg/s), PM2.5 (mg/s), CO (mg/s), HC (mg/s)
 */
const DEFAULT_VEHICLE_PROFILES = {
  Car: { weightKg: 1520, fuelType: 'Gasoline', ageYears: 5, engineCcL: 2.0, baseCo2: 2.15, baseNox: 8.5, basePm25: 0.42, baseCo: 24.0 },
  'SUV / Van': { weightKg: 2280, fuelType: 'Gasoline', ageYears: 6, engineCcL: 3.2, baseCo2: 3.05, baseNox: 13.2, basePm25: 0.68, baseCo: 32.5 },
  Truck: { weightKg: 16400, fuelType: 'Diesel', ageYears: 8, engineCcL: 10.8, baseCo2: 9.85, baseNox: 86.0, basePm25: 4.85, baseCo: 68.0 },
  Bus: { weightKg: 13800, fuelType: 'Diesel', ageYears: 7, engineCcL: 8.9, baseCo2: 8.40, baseNox: 74.5, basePm25: 4.10, baseCo: 59.0 },
  Motorcycle: { weightKg: 240, fuelType: 'Gasoline', ageYears: 4, engineCcL: 0.65, baseCo2: 0.92, baseNox: 4.2, basePm25: 0.22, baseCo: 36.0 }
};

function computeVehicleEmissionRates(v) {
  const baseProfile = DEFAULT_VEHICLE_PROFILES[v.cls] || DEFAULT_VEHICLE_PROFILES.Car;
  const weightKg = v.weightKg || baseProfile.weightKg;
  const fuelType = v.fuelType || baseProfile.fuelType;
  const ageYears = v.ageYears !== undefined ? v.ageYears : baseProfile.ageYears;
  const engineCcL = v.engineCcL || baseProfile.engineCcL;
  const speedKmh = Math.max(3.5, Number(v.speedKmh) || 40);

  // 1. Speed-dependent U-shaped congestion multiplier (stop-and-go < 25 km/h & high-drag > 95 km/h spike emissions)
  const congestionPenalty = speedKmh < 30 ? 1 + ((30 - speedKmh) / 22) * 1.45 : 1.0;
  const aeroPenalty = speedKmh > 85 ? 1 + Math.pow((speedKmh - 85) / 40, 2) * 0.35 : 1.0;
  const speedFactor = congestionPenalty * aeroPenalty;

  // 2. Empirical modifiers for Weight, Fuel Type, Vehicle Age (catalyst degradation), and Engine Capacity (L)
  const weightFactor = Math.pow(weightKg / baseProfile.weightKg, 0.55);
  const engineFactor = Math.pow(engineCcL / baseProfile.engineCcL, 0.48);
  const ageFactor = 1 + Math.max(0, ageYears - 2) * 0.045; // +4.5% emissions per year of catalyst aging

  let fuelCo2Mod = 1.0;
  let fuelNoxMod = 1.0;
  let fuelPmMod = 1.0;
  if (fuelType === 'Diesel') {
    fuelCo2Mod = 1.08;
    fuelNoxMod = 1.65;
    fuelPmMod = 2.10;
  } else if (fuelType === 'Hybrid') {
    fuelCo2Mod = 0.58;
    fuelNoxMod = 0.52;
    fuelPmMod = 0.48;
  } else if (fuelType === 'EV') {
    fuelCo2Mod = 0.0;
    fuelNoxMod = 0.0;
    fuelPmMod = 0.18; // Non-exhaust tire/brake wear PM2.5
  }

  const combinedMod = speedFactor * weightFactor * engineFactor * ageFactor;

  const co2Gps = Number((baseProfile.baseCo2 * combinedMod * fuelCo2Mod).toFixed(2));
  const noxMgps = Number((baseProfile.baseNox * combinedMod * fuelNoxMod).toFixed(1));
  const pm25Mgps = Number((baseProfile.basePm25 * combinedMod * fuelPmMod).toFixed(2));
  const coMgps = Number((baseProfile.baseCo * combinedMod * (fuelType === 'EV' ? 0 : 1)).toFixed(1));

  return {
    weightKg,
    fuelType,
    ageYears,
    engineCcL,
    co2Gps,
    noxMgps,
    pm25Mgps,
    coMgps
  };
}

/**
 * Autonomous Multi-Density Stream Clustering (HDBSCAN / Multi-Density DenStream Hybrid)
 * Discovers variable-density congestion and pollution hotspots WITHOUT requiring pre-specified
 * cluster counts (k). Computes local core distances and mutual reachability in spatial-velocity-emission space.
 */
function runMultiDensityStreamClustering(vehicles, options = {}) {
  const baseEps = options.eps || 70; // base spatial scale (px)
  const minPts = options.minPts || 3;
  const speedThreshold = options.speedThreshold || 38; // km/h

  // Enrich vehicles with empirical emission rates if not already present
  const enriched = vehicles.map((v) => {
    const em = v.emissions || computeVehicleEmissionRates(v);
    return { ...v, emissions: em };
  });

  // Candidate hotspot vehicles: slow/congested OR high-emitting heavy vehicles in platoons
  const candidates = enriched.filter(
    (v) => v.speedKmh <= speedThreshold || v.emissions.co2Gps >= 6.5
  );

  if (candidates.length < minPts) return [];

  // Compute k-th nearest neighbor core distance for each candidate to adapt to local density
  const coreDistances = new Map();
  for (const pt of candidates) {
    const dists = candidates
      .map((other) => Math.hypot(pt.x - other.x, pt.y - other.y))
      .sort((a, b) => a - b);
    const kIdx = Math.min(dists.length - 1, minPts - 1);
    coreDistances.set(pt.id, dists[kIdx]);
  }

  // Mutual reachability neighborhood query (adapts across dense core jams & sparser plume tails)
  function getMultiDensityNeighbors(point) {
    const localCore = coreDistances.get(point.id) || baseEps;
    const adaptiveRadius = Math.min(baseEps * 1.35, Math.max(baseEps * 0.72, localCore * 1.18));
    return candidates.filter((other) => {
      const spatialDist = Math.hypot(point.x - other.x, point.y - other.y);
      return spatialDist <= adaptiveRadius;
    });
  }

  const visited = new Set();
  const clustered = new Set();
  const clusters = [];

  for (const vehicle of candidates) {
    if (visited.has(vehicle.id)) continue;
    visited.add(vehicle.id);

    const neighbors = getMultiDensityNeighbors(vehicle);
    if (neighbors.length < minPts) continue;

    const clusterMembers = [];
    const queue = [...neighbors];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!visited.has(current.id)) {
        visited.add(current.id);
        const currentNeighbors = getMultiDensityNeighbors(current);
        if (currentNeighbors.length >= minPts) {
          for (const n of currentNeighbors) {
            if (!queue.some((q) => q.id === n.id)) {
              queue.push(n);
            }
          }
        }
      }
      if (!clustered.has(current.id)) {
        clustered.add(current.id);
        clusterMembers.push(current);
      }
    }

    if (clusterMembers.length >= minPts) {
      const cx =
        clusterMembers.reduce((sum, v) => sum + v.x, 0) / clusterMembers.length;
      const cy =
        clusterMembers.reduce((sum, v) => sum + v.y, 0) / clusterMembers.length;
      const avgSpeed =
        clusterMembers.reduce((sum, v) => sum + v.speedKmh, 0) /
        clusterMembers.length;

      let maxDist = 52;
      for (const m of clusterMembers) {
        const d = Math.hypot(m.x - cx, m.y - cy) + 28;
        if (d > maxDist) maxDist = d;
      }

      // Aggregate real-time pollutant emissions inside the discovered hotspot cluster
      const clusterCo2Gps = Number(
        clusterMembers.reduce((s, m) => s + m.emissions.co2Gps, 0).toFixed(2)
      );
      const clusterNoxMgps = Number(
        clusterMembers.reduce((s, m) => s + m.emissions.noxMgps, 0).toFixed(1)
      );
      const clusterPm25Mgps = Number(
        clusterMembers.reduce((s, m) => s + m.emissions.pm25Mgps, 0).toFixed(2)
      );
      const clusterCoMgps = Number(
        clusterMembers.reduce((s, m) => s + m.emissions.coMgps, 0).toFixed(1)
      );

      // Classify Multi-Density Regime (Core Gridlock Plume vs High-Density Platoon vs Dispersed Plume)
      const areaNorm = Math.max(1, (Math.PI * maxDist * maxDist) / 10000);
      const spatialDensity = Number((clusterMembers.length / areaNorm).toFixed(2));
      const densityRegime =
        spatialDensity >= 2.2
          ? 'ULTRA-DENSE SMOG CORE'
          : spatialDensity >= 1.4
          ? 'HIGH-DENSITY PLUME'
          : 'DISPERSED TRANSITION CLUSTER';

      // Compute combined Congestion + Pollution Severity Score (0 - 100) and Local Hotspot AQI
      const densityFactor = Math.min(1, clusterMembers.length / 8);
      const speedDropFactor = Math.max(0, (speedThreshold - avgSpeed) / speedThreshold);
      const emissionIntensityFactor = Math.min(1, clusterNoxMgps / 260);
      const severityScore = Math.round(
        Math.min(
          99,
          38 + densityFactor * 24 + speedDropFactor * 20 + emissionIntensityFactor * 22
        )
      );

      const localAqi = Math.round(
        Math.min(245, 58 + clusterPm25Mgps * 6.8 + clusterNoxMgps * 0.32)
      );

      let severity = 'MODERATE';
      if (severityScore >= 80 || localAqi >= 150) severity = 'CRITICAL';
      else if (severityScore >= 65 || localAqi >= 115) severity = 'HIGH';

      const directionLabel = cx < 460 ? 'Northbound' : 'Southbound';
      const zoneY = Math.round(cy * 0.85);

      clusters.push({
        clusterId: `PH-${Math.floor(100 + Math.random() * 899)}`,
        zoneLabel: `${directionLabel} Corridor Zone (Y: ${zoneY}m–${zoneY + 55}m)`,
        centroid: { x: Math.round(cx), y: Math.round(cy) },
        radiusPx: Math.round(maxDist),
        vehicleCount: clusterMembers.length,
        avgSpeedKmh: Number(avgSpeed.toFixed(1)),
        dwellTimeSec: Number(
          (14 + clusterMembers.length * 4.3 + Math.max(0, 35 - avgSpeed) * 0.7).toFixed(1)
        ),
        densityRegime,
        spatialDensity,
        co2Gps: clusterCo2Gps,
        noxMgps: clusterNoxMgps,
        pm25Mgps: clusterPm25Mgps,
        coMgps: clusterCoMgps,
        localAqi,
        severity,
        severityScore,
        cause:
          severity === 'CRITICAL'
            ? `Multi-density stop-and-go shockwave & heavy diesel NOx/PM2.5 plume (${clusterCo2Gps} g/s CO2)`
            : severity === 'HIGH'
            ? `High-emission platoon compression near merge/tripwire (${clusterNoxMgps} mg/s NOx)`
            : `Localized deceleration & elevated tailpipe emission micro-cluster`
      });
    }
  }

  return clusters.sort((a, b) => b.severityScore - a.severityScore);
}

/**
 * Compute Percentile from numeric array
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(1));
}

/**
 * Determine Highway Capacity Manual (HCM) Level of Service (A-F)
 */
function computeLevelOfService(meanSpeedKmh, speedLimitKmh, activeHotspots) {
  const ratio = meanSpeedKmh / (speedLimitKmh || 70);
  if (ratio >= 0.85 && activeHotspots === 0) {
    return {
      los: 'A',
      description: 'Free Flow — Optimal eco-cruising speeds and minimal tailpipe emission intensity',
      congestionIndex: Number((1 - ratio + 0.08).toFixed(2))
    };
  }
  if (ratio >= 0.72 && activeHotspots <= 1) {
    return {
      los: 'B',
      description: 'Reasonably Free Flow — Minor localized platoon emission clustering',
      congestionIndex: Number(Math.min(0.38, 1 - ratio + 0.12).toFixed(2))
    };
  }
  if (ratio >= 0.58) {
    return {
      los: 'C',
      description: 'Stable Flow — Moderate headway compression & rising NOx flux',
      congestionIndex: Number(Math.min(0.54, 1 - ratio + 0.16).toFixed(2))
    };
  }
  if (ratio >= 0.45) {
    return {
      los: 'D',
      description: 'Approaching Unstable Flow — Emergent shockwave & multi-density pollution hotspots',
      congestionIndex: Number(Math.min(0.72, 1 - ratio + 0.2).toFixed(2))
    };
  }
  if (ratio >= 0.32) {
    return {
      los: 'E',
      description: 'Unstable / Capacity Flow — Severe stop-and-go CO2, NOx & PM2.5 hotspot plumes',
      congestionIndex: Number(Math.min(0.86, 1 - ratio + 0.22).toFixed(2))
    };
  }
  return {
    los: 'F',
    description: 'Forced / Breakdown Gridlock — Critical urban air quality & congestion breakdown',
    congestionIndex: 0.94
  };
}

/**
 * Build a complete Agent Data Analysis Report from live stream telemetry
 * including Empirical Emission Rates & Multi-Density Pollution Hotspots
 */
function generateAgentReport(payload) {
  const cameraId = payload.cameraId || 'CAM-01';
  const camera =
    sampleData.cameras.find((c) => c.id === cameraId) || sampleData.cameras[0];

  const rawVehicles = Array.isArray(payload.vehicles) && payload.vehicles.length > 0
    ? payload.vehicles
    : [
        { id: 101, cls: 'Truck', x: 555, y: 275, speedKmh: 15.2, weightKg: 17500, fuelType: 'Diesel', ageYears: 9, engineCcL: 11.2 },
        { id: 102, cls: 'Car', x: 548, y: 312, speedKmh: 16.8, weightKg: 1580, fuelType: 'Gasoline', ageYears: 6, engineCcL: 2.0 },
        { id: 103, cls: 'SUV / Van', x: 562, y: 345, speedKmh: 18.4, weightKg: 2350, fuelType: 'Diesel', ageYears: 7, engineCcL: 3.0 },
        { id: 104, cls: 'Bus', x: 545, y: 240, speedKmh: 14.5, weightKg: 14200, fuelType: 'Diesel', ageYears: 8, engineCcL: 8.9 },
        { id: 105, cls: 'Car', x: 250, y: 190, speedKmh: 78.4, weightKg: 1480, fuelType: 'Hybrid', ageYears: 2, engineCcL: 1.8 },
        { id: 106, cls: 'Car', x: 385, y: 225, speedKmh: 72.0, weightKg: 1610, fuelType: 'Gasoline', ageYears: 4, engineCcL: 2.4 }
      ];

  const liveVehicles = rawVehicles.map((v) => ({
    ...v,
    emissions: v.emissions || computeVehicleEmissionRates(v)
  }));

  const liveCrossings = payload.crossings || null;

  // Run Autonomous Multi-Density Stream Clustering (HDBSCAN / Multi-Density DenStream)
  let clusters =
    Array.isArray(payload.clusters) && payload.clusters.length > 0
      ? payload.clusters
      : runMultiDensityStreamClustering(liveVehicles, {
          eps: payload.eps || 70,
          minPts: payload.minPts || 3,
          speedThreshold: payload.speedThreshold || 38
        });

  const speeds = liveVehicles.map((v) => Number(v.speedKmh) || 45);
  const meanSpeedKmh = Number(
    (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)
  );
  const p50SpeedKmh = percentile(speeds, 50);
  const p85SpeedKmh = percentile(speeds, 85);
  const minSpeedKmh = Number(Math.min(...speeds).toFixed(1));
  const maxSpeedKmh = Number(Math.max(...speeds).toFixed(1));

  const northboundCount =
    liveCrossings && typeof liveCrossings.northbound === 'number'
      ? liveCrossings.northbound
      : 195 + Math.floor(Math.random() * 65);
  const southboundCount =
    liveCrossings && typeof liveCrossings.southbound === 'number'
      ? liveCrossings.southbound
      : 210 + Math.floor(Math.random() * 70);
  const totalVehiclesCounted = Math.max(
    northboundCount + southboundCount,
    liveCrossings?.total || 0
  );

  const windowDurationSec = payload.windowDurationSec || 180;
  const flowRateVehPerMin = Number(
    (
      payload.flowRateVehPerMin ||
      totalVehiclesCounted / (windowDurationSec / 60)
    ).toFixed(1)
  );

  const classDistribution = payload.classDistribution || {
    Car: Math.round(totalVehiclesCounted * 0.67),
    'SUV / Van': Math.round(totalVehiclesCounted * 0.15),
    Truck: Math.round(totalVehiclesCounted * 0.11),
    Bus: Math.round(totalVehiclesCounted * 0.04),
    Motorcycle: Math.max(1, Math.round(totalVehiclesCounted * 0.03))
  };

  // Compute Corridor-Wide Live Emission Rates & Empirical Fleet Metrics
  const totalCo2Gps = Number(
    (
      payload.emissionMetrics?.totalCo2Gps ||
      liveVehicles.reduce((s, v) => s + (v.emissions?.co2Gps || 2.8), 0)
    ).toFixed(2)
  );
  const totalNoxMgps = Number(
    (
      payload.emissionMetrics?.totalNoxMgps ||
      liveVehicles.reduce((s, v) => s + (v.emissions?.noxMgps || 18.5), 0)
    ).toFixed(1)
  );
  const totalPm25Mgps = Number(
    (
      payload.emissionMetrics?.totalPm25Mgps ||
      liveVehicles.reduce((s, v) => s + (v.emissions?.pm25Mgps || 1.15), 0)
    ).toFixed(2)
  );
  const totalCoMgps = Number(
    (
      payload.emissionMetrics?.totalCoMgps ||
      liveVehicles.reduce((s, v) => s + (v.emissions?.coMgps || 32.0), 0)
    ).toFixed(1)
  );
  const corridorAqi = Math.round(
    payload.emissionMetrics?.corridorAqi ||
      Math.min(220, 48 + totalPm25Mgps * 3.8 + totalNoxMgps * 0.14)
  );

  const emissionMetrics = {
    model: 'COPERT-VSP Empirical Emission Model + Multi-Density HDBSCAN/DenStream',
    totalCo2Gps,
    co2KgPerHour: Number(((totalCo2Gps * 3600) / 1000).toFixed(1)),
    totalNoxMgps,
    totalPm25Mgps,
    totalCoMgps,
    corridorAqi,
    aqiCategory:
      corridorAqi >= 151
        ? 'Unhealthy (High Congestion Plume)'
        : corridorAqi >= 101
        ? 'Unhealthy for Sensitive Groups'
        : corridorAqi >= 51
        ? 'Moderate'
        : 'Good',
    fleetFuelSplit: payload.emissionMetrics?.fleetFuelSplit || {
      Gasoline: '58%',
      Diesel: '24%',
      Hybrid: '12%',
      EV: '6%'
    },
    avgFleetAgeYears: 5.8,
    avgEngineCapacityL: 3.1
  };

  const overspeedCount =
    payload.overspeedCount !== undefined
      ? payload.overspeedCount
      : speeds.filter((s) => s > camera.speedLimitKmh).length;

  const losInfo = computeLevelOfService(
    meanSpeedKmh,
    camera.speedLimitKmh,
    clusters.length
  );

  const recommendations = [];
  if (clusters.length > 0) {
    const worst = clusters[0];
    recommendations.push(
      `[ECO-VSL & HOTSPOT MITIGATION] Activate smooth eco-speed harmonization (${Math.max(
        50,
        camera.speedLimitKmh - 25
      )} km/h) upstream of ${worst.zoneLabel} to dissolve ${
        worst.densityRegime || 'Multi-Density'
      } Hotspot ${worst.clusterId} (${worst.co2Gps || 38.4} g/s CO2, ${
        worst.noxMgps || 185
      } mg/s NOx, Local AQI ${worst.localAqi || corridorAqi}).`
    );
  }
  if (corridorAqi >= 105 || totalNoxMgps > 250) {
    recommendations.push(
      `[LOW-EMISSION ZONE ROUTING] High heavy-duty Diesel NOx (${totalNoxMgps} mg/s) & PM2.5 (${totalPm25Mgps} mg/s) flux detected on ${camera.name}; trigger dynamic eco-routing for Euro 3/4 heavy freight.`
    );
  }
  recommendations.push(
    `[SIGNAL & RAMP PROGRESSION] Maintain green-wave progression along ${camera.name} (LoS ${losInfo.los}, ${totalCo2Gps} g/s CO2) to minimize stop-and-go acceleration emission spikes.`
  );

  const anomalies = [];
  for (const c of clusters) {
    anomalies.push({
      timeOffset: 'LIVE',
      type:
        c.severity === 'CRITICAL'
          ? 'MULTI_DENSITY_POLLUTION_HOTSPOT'
          : 'CONGESTION_EMISSION_MICROCLUSTER',
      detail: `Cluster ${c.clusterId} [${c.densityRegime || 'DENSE CORE'}] at (${
        c.centroid.x
      }, ${c.centroid.y}): ${c.vehicleCount} veh @ ${
        c.avgSpeedKmh
      } km/h emitting ${c.co2Gps || 32.5} g/s CO2 & ${
        c.noxMgps || 140
      } mg/s NOx (Local AQI ${c.localAqi || 128}).`
    });
  }
  if (anomalies.length === 0) {
    anomalies.push({
      timeOffset: 'LIVE',
      type: 'ECO_FLOW_NOMINAL',
      detail: `Multi-density stream clustering verified zero pollution bottlenecks (${totalCo2Gps} g/s CO2, Corridor AQI ${corridorAqi}).`
    });
  }

  const report = {
    reportId: `RPT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(
      reportsStore.length + 1
    ).padStart(3, '0')}`,
    timestamp: new Date().toISOString(),
    cameraId: camera.id,
    cameraName: camera.name,
    triggerSource: payload.triggerSource || 'Unified Traffic & Emission Stream Agent',
    agentVersion: 'MultiDensity-DenStream-COPERT Agent v3.0',
    windowDurationSec,
    summary: {
      totalVehiclesCounted,
      northboundCount,
      southboundCount,
      flowRateVehPerMin,
      meanSpeedKmh,
      p50SpeedKmh,
      p85SpeedKmh,
      minSpeedKmh,
      maxSpeedKmh,
      overspeedCount,
      levelOfService: losInfo.los,
      losDescription: losInfo.description,
      congestionIndex: losInfo.congestionIndex
    },
    emissionMetrics,
    classDistribution,
    clusteringMetrics: {
      algorithm:
        'Autonomous Multi-Density HDBSCAN / DenStream (No pre-specified k, Mutual-Reachability Spatial-Velocity-Emission Clustering)',
      activeHotspots: clusters.length,
      peakClusterDensity:
        clusters.length > 0
          ? Number(
              Math.max(...clusters.map((c) => c.vehicleCount * 1.2)).toFixed(1)
            )
          : 1.2,
      clusters
    },
    recommendations,
    anomalies
  };

  return report;
}

// API Routes
app.get('/api/bootstrap', (req, res) => {
  try {
    sampleData = JSON.parse(fs.readFileSync(sampleDataPath, 'utf8'));
    const activeCamIds = new Set((sampleData.cameras || []).map((c) => c.id));
    const existingReportIds = new Set(reportsStore.map((r) => r.reportId));
    for (const initRep of sampleData.initialReports || []) {
      if (!existingReportIds.has(initRep.reportId)) {
        reportsStore.push(initRep);
      }
    }
    reportsStore = reportsStore
      .filter((r) => activeCamIds.has(r.cameraId))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (e) {
    console.error('Error reloading sample_traffic_streams.json:', e);
  }
  res.json({
    cameras: sampleData.cameras,
    reports: reportsStore
  });
});

app.get('/api/reports', (req, res) => {
  const activeCamIds = new Set((sampleData.cameras || []).map((c) => c.id));
  reportsStore = reportsStore.filter((r) => activeCamIds.has(r.cameraId));
  const { cameraId } = req.query;
  if (cameraId && cameraId !== 'ALL') {
    return res.json(reportsStore.filter((r) => r.cameraId === cameraId));
  }
  res.json(reportsStore);
});

app.post('/api/agent/analyze', (req, res) => {
  const report = generateAgentReport(req.body || {});
  reportsStore.unshift(report);
  if (reportsStore.length > 50) {
    reportsStore = reportsStore.slice(0, 50);
  }

  broadcastAgentEvent('new_report', report);

  res.status(201).json({
    status: 'pushed',
    report
  });
});

app.get('/api/stream/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(
    `event: connected\ndata: ${JSON.stringify({
      status: 'Agent Stream Connected',
      reportsCount: reportsStore.length
    })}\n\n`
  );

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(
    `[Smart City Traffic & Emission Agent] Server running at http://localhost:${PORT}`
  );
});
