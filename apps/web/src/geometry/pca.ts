export type V3 = [number, number, number];

export interface PrincipalAxes {
  centroid: V3;
  /** Unit eigenvectors, sorted by decreasing variance. */
  axes: [V3, V3, V3];
  variances: V3;
}

/**
 * Principal axes of a point set (subsampled to ~maxSamples points).
 * Used for the default view frame: the least-variance axis of a dental arch
 * approximates the occlusal-plane normal.
 */
export function principalAxes(positions: Float32Array, maxSamples = 200_000): PrincipalAxes {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / maxSamples));
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (let i = 0; i < n; i += step) {
    cx += positions[i * 3]!;
    cy += positions[i * 3 + 1]!;
    cz += positions[i * 3 + 2]!;
    count++;
  }
  cx /= count; cy /= count; cz /= count;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i += step) {
    const x = positions[i * 3]! - cx, y = positions[i * 3 + 1]! - cy, z = positions[i * 3 + 2]! - cz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const { values, vectors } = symmetricEigen3([
    [xx / count, xy / count, xz / count],
    [xy / count, yy / count, yz / count],
    [xz / count, yz / count, zz / count],
  ]);
  const order = [0, 1, 2].sort((a, b) => values[b]! - values[a]!);
  const col = (k: number): V3 => [vectors[0]![k]!, vectors[1]![k]!, vectors[2]![k]!];
  return {
    centroid: [cx, cy, cz],
    axes: [col(order[0]!), col(order[1]!), col(order[2]!)],
    variances: [values[order[0]!]!, values[order[1]!]!, values[order[2]!]!],
  };
}

/** Jacobi eigen-decomposition of a symmetric 3×3 matrix. Eigenvectors are columns. */
export function symmetricEigen3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    if (off < 1e-14) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!, akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!, aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!, vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0]![0]!, a[1]![1]!, a[2]![2]!], vectors: v };
}
