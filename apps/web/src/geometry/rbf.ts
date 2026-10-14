import type { V3 } from './pca';

export type RbfKernel = 'cubic' | 'linear';

/**
 * Radial basis function displacement field
 *   f(p) = Σ w_i φ(|p − c_i|) + a0 + A·p
 * with an affine polynomial term, so affine displacements are reproduced
 * exactly. Coordinates are centred and scaled internally for conditioning.
 */
export interface RbfField {
  kernel: RbfKernel;
  /** Normalized centres, xyz per centre. */
  centers: Float64Array;
  /** Kernel weights, xyz per centre. */
  weights: Float64Array;
  /** Affine coefficients per output component: [a0, ax, ay, az] × 3. */
  affine: Float64Array;
  shift: V3;
  scale: number;
}

const phi = (kernel: RbfKernel, r: number) => (kernel === 'cubic' ? r * r * r : r);

/** In-place LU with partial pivoting on an m×m row-major matrix; solves for k right-hand sides (m×k row-major). */
function luSolve(a: Float64Array, m: number, b: Float64Array, k: number): void {
  for (let col = 0; col < m; col++) {
    let piv = col;
    let best = Math.abs(a[col * m + col]!);
    for (let r = col + 1; r < m; r++) {
      const v = Math.abs(a[r * m + col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) throw new Error('RBF system is singular (duplicate or degenerate centres)');
    if (piv !== col) {
      for (let c = 0; c < m; c++) {
        const t = a[col * m + c]!;
        a[col * m + c] = a[piv * m + c]!;
        a[piv * m + c] = t;
      }
      for (let c = 0; c < k; c++) {
        const t = b[col * k + c]!;
        b[col * k + c] = b[piv * k + c]!;
        b[piv * k + c] = t;
      }
    }
    const d = a[col * m + col]!;
    for (let r = col + 1; r < m; r++) {
      const f = a[r * m + col]! / d;
      if (f === 0) continue;
      for (let c = col; c < m; c++) a[r * m + c] = a[r * m + c]! - f * a[col * m + c]!;
      for (let c = 0; c < k; c++) b[r * k + c] = b[r * k + c]! - f * b[col * k + c]!;
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    for (let c = 0; c < k; c++) {
      let s = b[r * k + c]!;
      for (let j = r + 1; j < m; j++) s -= a[r * m + j]! * b[j * k + c]!;
      b[r * k + c] = s / a[r * m + r]!;
    }
  }
}

/**
 * Fit a field through `values` (xyz displacement per centre) at `centers`
 * (xyz per centre). `smoothing` > 0 relaxes exact interpolation (ridge on the
 * kernel diagonal, in normalized units). Throws on a singular system.
 */
export function solveRbf(
  centers: Float32Array | Float64Array,
  values: Float32Array | Float64Array,
  opts: { kernel?: RbfKernel; smoothing?: number } = {},
): RbfField {
  return solveRbfFields(centers, [values], opts)[0]!;
}

/**
 * Several fields over the same centres with one matrix factorization: the
 * same as solveRbf for each entry of `valueSets` (evaluate them together with
 * evaluateRbfFields).
 */
export function solveRbfFields(
  centers: Float32Array | Float64Array,
  valueSets: ReadonlyArray<Float32Array | Float64Array>,
  opts: { kernel?: RbfKernel; smoothing?: number } = {},
): RbfField[] {
  const kernel = opts.kernel ?? 'cubic';
  const n = centers.length / 3;
  for (const values of valueSets) if (values.length !== centers.length) throw new Error('RBF: one xyz value per centre');
  if (n < 4) throw new Error('RBF: need at least 4 centres');
  const shift: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) shift[k] = shift[k]! + centers[i * 3 + k]! / n;
  let scale = 0;
  for (let i = 0; i < n; i++) {
    scale = Math.max(scale, Math.hypot(centers[i * 3]! - shift[0], centers[i * 3 + 1]! - shift[1], centers[i * 3 + 2]! - shift[2]));
  }
  scale = scale || 1;
  const c = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = (centers[i * 3 + k]! - shift[k]!) / scale;

  const m = n + 4;
  const cols = 3 * valueSets.length;
  const a = new Float64Array(m * m);
  const b = new Float64Array(m * cols);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const r = Math.hypot(c[i * 3]! - c[j * 3]!, c[i * 3 + 1]! - c[j * 3 + 1]!, c[i * 3 + 2]! - c[j * 3 + 2]!);
      a[i * m + j] = phi(kernel, r);
    }
    a[i * m + i] = a[i * m + i]! + (opts.smoothing ?? 0);
    const row = [1, c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!];
    for (let q = 0; q < 4; q++) {
      a[i * m + n + q] = row[q]!;
      a[(n + q) * m + i] = row[q]!;
    }
    valueSets.forEach((values, s) => {
      for (let k = 0; k < 3; k++) b[i * cols + s * 3 + k] = values[i * 3 + k]!;
    });
  }
  luSolve(a, m, b, cols);
  return valueSets.map((_, s) => {
    // Rows 0..n-1 are kernel weights, rows n..n+3 are [a0, ax, ay, az]; field s owns columns 3s..3s+2.
    const column = (row0: number, rows: number) => {
      const out = new Float64Array(rows * 3);
      for (let r = 0; r < rows; r++) for (let k = 0; k < 3; k++) out[r * 3 + k] = b[(row0 + r) * cols + s * 3 + k]!;
      return out;
    };
    return { kernel, centers: c, weights: column(0, n), affine: column(n, 4), shift, scale };
  });
}

/**
 * Evaluate fields from one solveRbfFields call at world point p (one kernel
 * evaluation per centre for all of them): out[3s..3s+2] = field s at p.
 */
export function evaluateRbfFields(fields: readonly RbfField[], p: V3, out: Float64Array): Float64Array {
  const f0 = fields[0]!;
  const x = (p[0] - f0.shift[0]) / f0.scale;
  const y = (p[1] - f0.shift[1]) / f0.scale;
  const z = (p[2] - f0.shift[2]) / f0.scale;
  fields.forEach(({ affine }, s) => {
    out[s * 3] = affine[0]! + affine[3]! * x + affine[6]! * y + affine[9]! * z;
    out[s * 3 + 1] = affine[1]! + affine[4]! * x + affine[7]! * y + affine[10]! * z;
    out[s * 3 + 2] = affine[2]! + affine[5]! * x + affine[8]! * y + affine[11]! * z;
  });
  const { centers } = f0;
  const n = centers.length / 3;
  for (let i = 0; i < n; i++) {
    const f = phi(f0.kernel, Math.hypot(x - centers[i * 3]!, y - centers[i * 3 + 1]!, z - centers[i * 3 + 2]!));
    for (let s = 0; s < fields.length; s++) {
      const w = fields[s]!.weights;
      out[s * 3] = out[s * 3]! + f * w[i * 3]!;
      out[s * 3 + 1] = out[s * 3 + 1]! + f * w[i * 3 + 1]!;
      out[s * 3 + 2] = out[s * 3 + 2]! + f * w[i * 3 + 2]!;
    }
  }
  return out;
}

/** Displacement at world point p. */
export function evaluateRbf(field: RbfField, p: V3): V3 {
  const x = (p[0] - field.shift[0]) / field.scale;
  const y = (p[1] - field.shift[1]) / field.scale;
  const z = (p[2] - field.shift[2]) / field.scale;
  const { centers, weights, affine } = field;
  const out: V3 = [
    affine[0]! + affine[3]! * x + affine[6]! * y + affine[9]! * z,
    affine[1]! + affine[4]! * x + affine[7]! * y + affine[10]! * z,
    affine[2]! + affine[5]! * x + affine[8]! * y + affine[11]! * z,
  ];
  const n = centers.length / 3;
  for (let i = 0; i < n; i++) {
    const f = phi(field.kernel, Math.hypot(x - centers[i * 3]!, y - centers[i * 3 + 1]!, z - centers[i * 3 + 2]!));
    out[0] += f * weights[i * 3]!;
    out[1] += f * weights[i * 3 + 1]!;
    out[2] += f * weights[i * 3 + 2]!;
  }
  return out;
}

/**
 * Add the field's displacement to positions (xyz per vertex) **in place**,
 * scaled per vertex by `weights` (default 1). Returns `positions`.
 */
export function applyRbf(field: RbfField, positions: Float32Array, weights?: ArrayLike<number>): Float32Array {
  for (let v = 0; v < positions.length / 3; v++) {
    const w = weights ? weights[v]! : 1;
    if (w === 0) continue;
    const d = evaluateRbf(field, [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
    positions[v * 3] = positions[v * 3]! + w * d[0];
    positions[v * 3 + 1] = positions[v * 3 + 1]! + w * d[1];
    positions[v * 3 + 2] = positions[v * 3 + 2]! + w * d[2];
  }
  return positions;
}
