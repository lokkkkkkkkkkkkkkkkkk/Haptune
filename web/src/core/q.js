// Exact rational numbers for musical time (quarter notes). Every onset and duration in Melovyn is a Q,
// so triplets, quintuplets and pickups never drift and conversions are exact.

export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

export function lcm(a, b) { return Math.abs(a / gcd(a, b) * b); }

export class Q {
  constructor(n, d = 1) {
    if (!Number.isInteger(n) || !Number.isInteger(d) || d === 0) throw new Error(`Bad fraction ${n}/${d}`);
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
    Object.freeze(this);
  }
  static of(n, d = 1) { return new Q(n, d); }
  /** Nearest fraction to x with denominator <= maxDen (continued fractions). */
  static approx(x, maxDen = 1920) {
    if (Number.isInteger(x)) return new Q(x, 1);
    let [h0, h1, k0, k1] = [0, 1, 1, 0];
    let v = x;
    for (let i = 0; i < 40; i++) {
      const a = Math.floor(v);
      const h2 = a * h1 + h0, k2 = a * k1 + k0;
      if (k2 > maxDen) break;
      [h0, h1, k0, k1] = [h1, h2, k1, k2];
      if (Math.abs(v - a) < 1e-12) break;
      v = 1 / (v - a);
    }
    return new Q(h1, k1);
  }
  static parse(s) {
    if (s instanceof Q) return s;
    if (typeof s === 'number') return Q.approx(s);
    const [n, d] = String(s).split('/').map(Number);
    return new Q(n, d || 1);
  }
  add(b) { b = q(b); return new Q(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b) { b = q(b); return new Q(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b) { b = q(b); return new Q(this.n * b.n, this.d * b.d); }
  div(b) { b = q(b); return new Q(this.n * b.d, this.d * b.n); }
  neg() { return new Q(-this.n, this.d); }
  cmp(b) { b = q(b); return this.n * b.d - b.n * this.d; }
  eq(b) { b = q(b); return this.n === b.n && this.d === b.d; }
  lt(b) { return this.cmp(b) < 0; }
  le(b) { return this.cmp(b) <= 0; }
  gt(b) { return this.cmp(b) > 0; }
  ge(b) { return this.cmp(b) >= 0; }
  isZero() { return this.n === 0; }
  sign() { return Math.sign(this.n); }
  floor() { return Math.floor(this.n / this.d); }
  valueOf() { return this.n / this.d; }
  num() { return this.n / this.d; }
  toString() { return this.d === 1 ? String(this.n) : `${this.n}/${this.d}`; }
  toJSON() { return this.toString(); }
}

export function q(x, d) {
  if (x instanceof Q) return x;
  if (d !== undefined) return new Q(x, d);
  if (typeof x === 'number') return Number.isInteger(x) ? new Q(x, 1) : Q.approx(x);
  return Q.parse(x);
}

export const ZERO = new Q(0, 1);
export const ONE = new Q(1, 1);

export function qmin(a, b) { return a.le(b) ? a : b; }
export function qmax(a, b) { return a.ge(b) ? a : b; }
export function qsum(list) { return list.reduce((s, x) => s.add(x), ZERO); }
