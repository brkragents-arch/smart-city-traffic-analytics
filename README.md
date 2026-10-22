# SmartCity Pulse AI — Real-Time Vehicle Detection, Speed Estimation & Stream Clustering Agent

A real-time computer vision and stream-clustering web application for **Smart City Traffic Analytics**. The platform ingests live corridor feeds or uploaded `.mp4`/`.webm` traffic videos, performs frame-by-frame vehicle inference and multi-object tracking, counts directional virtual tripwire line crossings, estimates calibrated speeds ($\text{km/h}$), discovers dynamic **congestion hotspots** via **Online DenStream / Sliding-Window Spatio-Temporal DBSCAN**, and automatically pushes comprehensive **Data Analysis Reports** to the web dashboard via Server-Sent Events (SSE).

---

## Core Capabilities

1. **Frame-by-Frame Vehicle Detection & Multi-Object Tracking**
   - Supports **3 Built-In Smart Corridor Feeds** (`CAM-01: I-95 Downtown`, `CAM-02: 5th Ave & Innovation Pkwy`, `CAM-03: Harbor Bridge Toll Approach`) with Intelligent Driver Model (IDM) car-following physics, plus **Custom Video Upload (`.mp4`/`.webm`)** powered by **TensorFlow.js (`COCO-SSD`)** + Euclidean/IoU multi-object tracking.
   - Classifies `Car`, `SUV / Van`, `Truck`, `Bus`, and `Motorcycle` with persistent Track IDs, motion trails, and bounding boxes rendered directly on the HUD canvas.

2. **Virtual Tripwire Line-Crossing Counter & Calibrated Speed Estimation**
   - Tracks bidirectional (`Northbound` / `Southbound`) line crossings with visual flash indicators and modal split breakdown.
   - Computes real-world speed ($v = \frac{\Delta d \cdot \text{metersPerPixel}}{\Delta t} \times 3.6\text{ km/h}$), $P_{50}$ / $P_{85}$ speed percentiles, and speed-limit violation alerts.

3. **Stream-Based Congestion Hotspot Discovery (Online DenStream / DBSCAN)**
   - Filters slow/queued vehicles ($v \le v_{\text{threshold}}$) and executes real-time spatial-velocity **DBSCAN / DenStream micro-clustering** ($\varepsilon$-radius, $\text{MinPts}$).
   - Renders pulsing hotspot hulls, spatial cluster graphs, centroid coordinates, dwell times, and severity scores (`MODERATE`, `HIGH`, `CRITICAL`) directly onto the video viewport.

4. **Autonomous Data Analysis Agent & Pushed Web App Reports**
   - Backend Agent (`server.js`) + external Python YOLOv8 worker (`agent/yolo_stream_agent.py`) analyze stream windows, compute Highway Capacity Manual **Level of Service (LoS A–F)**, diagnose congestion causes, synthesize traffic signal / VSL recommendations, and push reports live to all connected browsers via SSE (`/api/stream/events`).
   - Full interactive **Report Inspector Modal** with **JSON**, **CSV**, and **Print/PDF** export.

---

## Quick Start

```bash
npm.cmd start
```

Then open **http://localhost:3080** in your browser.
