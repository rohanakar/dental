/**
 * Vertex adjacency (CSR): the neighbours of vertex v are
 * neighbors[offsets[v] .. offsets[v + 1]), unique and sorted.
 */
export interface SurfaceGraph {
  offsets: Uint32Array;
  neighbors: Uint32Array;
}

export interface SurfaceAnalysis {
  graph: SurfaceGraph;
  /** Signed curvature per vertex in 1/mm: convex (ridges, cusps) > 0, concave (fissures, sulcus) < 0. */
  curvature: Float32Array;
  timingsMs: { adjacency: number; curvature: number };
}

/** Unique, sorted 1-ring vertex neighbours from a triangle index buffer. */
export function buildVertexAdjacency(indices: Uint32Array, vertexCount: number): SurfaceGraph {
  const counts = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < indices.length; i++) counts[indices[i]!]! += 2;
  const start = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) start[v + 1] = start[v]! + counts[v]!;
  const raw = new Uint32Array(start[vertexCount]!);
  const fill = start.slice(0, vertexCount);
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f]!, b = indices[f + 1]!, c = indices[f + 2]!;
    raw[fill[a]!++] = b;
    raw[fill[a]!++] = c;
    raw[fill[b]!++] = c;
    raw[fill[b]!++] = a;
    raw[fill[c]!++] = a;
    raw[fill[c]!++] = b;
  }
  // Sort each segment (small: ~12 entries) and drop duplicates in place.
  const offsets = new Uint32Array(vertexCount + 1);
  let out = 0;
  for (let v = 0; v < vertexCount; v++) {
    const s = start[v]!, e = start[v + 1]!;
    for (let i = s + 1; i < e; i++) {
      const x = raw[i]!;
      let j = i - 1;
      while (j >= s && raw[j]! > x) {
        raw[j + 1] = raw[j]!;
        j--;
      }
      raw[j + 1] = x;
    }
    offsets[v] = out;
    for (let i = s; i < e; i++) {
      if (i > s && raw[i] === raw[i - 1]) continue;
      raw[out++] = raw[i]!;
    }
  }
  offsets[vertexCount] = out;
  return { offsets, neighbors: raw.slice(0, out) };
}

/** Normals averaged with their 1-ring `iterations` times (renormalized each pass). */
export function smoothVertexNormals(normals: Float32Array, graph: SurfaceGraph, iterations = 2): Float32Array {
  let src: Float32Array = normals;
  let dst: Float32Array = new Float32Array(normals.length);
  const n = normals.length / 3;
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < n; v++) {
      let x = src[v * 3]!, y = src[v * 3 + 1]!, z = src[v * 3 + 2]!;
      for (let k = graph.offsets[v]!; k < graph.offsets[v + 1]!; k++) {
        const u = graph.neighbors[k]! * 3;
        x += src[u]!;
        y += src[u + 1]!;
        z += src[u + 2]!;
      }
      const len = Math.hypot(x, y, z) || 1;
      dst[v * 3] = x / len;
      dst[v * 3 + 1] = y / len;
      dst[v * 3 + 2] = z / len;
    }
    if (it === 0) {
      src = dst;
      dst = new Float32Array(normals.length);
    } else {
      [src, dst] = [dst, src];
    }
  }
  return iterations === 0 ? normals.slice() : src;
}

/**
 * Signed curvature per vertex (1/mm): mean over the 1-ring of
 * (nᵥ − nᵤ)·(pᵥ − pᵤ) / ‖pᵥ − pᵤ‖². For outward normals this is +1/r on a
 * sphere of radius r and −1/r inside a bowl.
 */
export function signedCurvature(positions: Float32Array, normals: Float32Array, graph: SurfaceGraph): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const s = graph.offsets[v]!, e = graph.offsets[v + 1]!;
    if (e === s) continue;
    const px = positions[v * 3]!, py = positions[v * 3 + 1]!, pz = positions[v * 3 + 2]!;
    const nx = normals[v * 3]!, ny = normals[v * 3 + 1]!, nz = normals[v * 3 + 2]!;
    let sum = 0;
    let count = 0;
    for (let k = s; k < e; k++) {
      const u = graph.neighbors[k]! * 3;
      const dx = px - positions[u]!, dy = py - positions[u + 1]!, dz = pz - positions[u + 2]!;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-16) continue;
      sum += ((nx - normals[u]!) * dx + (ny - normals[u + 1]!) * dy + (nz - normals[u + 2]!) * dz) / len2;
      count++;
    }
    out[v] = count > 0 ? sum / count : 0;
  }
  return out;
}

/** Average a per-vertex scalar with its 1-ring `iterations` times. */
export function smoothScalar(values: Float32Array, graph: SurfaceGraph, iterations = 1): Float32Array {
  let src = values;
  for (let it = 0; it < iterations; it++) {
    const dst = new Float32Array(values.length);
    for (let v = 0; v < values.length; v++) {
      let sum = src[v]!;
      const s = graph.offsets[v]!, e = graph.offsets[v + 1]!;
      for (let k = s; k < e; k++) sum += src[graph.neighbors[k]!]!;
      dst[v] = sum / (1 + e - s);
    }
    src = dst;
  }
  return src === values ? values.slice() : src;
}

/**
 * Adjacency + smoothed signed curvature for live-wire costs. Normals are
 * smoothed twice and the curvature once, which spreads it over roughly
 * 0.1–0.3 mm on intraoral-scan resolutions.
 */
export function analyzeSurface(
  mesh: { positions: Float32Array; indices: Uint32Array; normals: Float32Array },
  options: { normalIterations?: number; curvatureIterations?: number } = {},
): SurfaceAnalysis {
  const t0 = performance.now();
  const graph = buildVertexAdjacency(mesh.indices, mesh.positions.length / 3);
  const t1 = performance.now();
  const smoothed = smoothVertexNormals(mesh.normals, graph, options.normalIterations ?? 2);
  const curvature = smoothScalar(signedCurvature(mesh.positions, smoothed, graph), graph, options.curvatureIterations ?? 1);
  const t2 = performance.now();
  return { graph, curvature, timingsMs: { adjacency: t1 - t0, curvature: t2 - t1 } };
}
