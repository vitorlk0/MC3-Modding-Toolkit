/**
 * CPython's `random.Random`, reproduced exactly.
 *
 * The Carcfg Randomizer is a port of a Python tool whose whole output depends on the sequence its
 * random number generator produces. `Math.random` would make the port unverifiable — the same seed
 * has to land on the same values for the result to be diffable against the original at all, and for
 * a seed noted down while using the old script to still mean something here.
 *
 * So this is the Mersenne Twister exactly as `_randommodule.c` implements it (MT19937, seeded
 * through `init_by_array` the way `random_seed` does for an integer), plus `Lib/random.py`'s
 * `getrandbits` / `_randbelow` / `randrange` on top. Verified against Python 3.14 over the seeds and
 * ranges this tool actually uses.
 *
 * Note that `randint(0, 0)` still draws a number even though only one value is possible — CPython's
 * `_randbelow` has no shortcut for a width of 1, and skipping the draw here would shift every later
 * value in the stream.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PythonRandom {
  private readonly mt = new Uint32Array(N);
  private index = N;

  constructor(seed: number | bigint) {
    // random_seed() takes the absolute value of an integer seed and splits it into 32-bit words,
    // least significant first; a seed of 0 still yields a one-word key.
    let value = typeof seed === "bigint" ? seed : BigInt(Math.trunc(seed));
    if (value < 0n) value = -value;
    const words: number[] = [];
    do {
      words.push(Number(value & 0xffffffffn));
      value >>= 32n;
    } while (value > 0n);
    this.initByArray(Uint32Array.from(words));
  }

  private initGenrand(seed: number) {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < N; i += 1) {
      const previous = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, previous) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: Uint32Array) {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k -= 1) {
      const previous = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (((this.mt[i] ^ Math.imul(previous, 1664525)) >>> 0) + key[j] + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= N) { this.mt[0] = this.mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k -= 1) {
      const previous = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (((this.mt[i] ^ Math.imul(previous, 1566083941)) >>> 0) - i) >>> 0;
      i += 1;
      if (i >= N) { this.mt[0] = this.mt[N - 1]; i = 1; }
    }
    this.mt[0] = UPPER_MASK;
  }

  private genrandUint32() {
    if (this.index >= N) {
      for (let kk = 0; kk < N - M; kk += 1) {
        const y = ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (let kk = N - M; kk < N - 1; kk += 1) {
        const y = ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      const y = ((this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK)) >>> 0;
      this.mt[N - 1] = (this.mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.index = 0;
    }
    let y = this.mt[this.index];
    this.index += 1;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random.getrandbits(k)` for the k <= 32 fast path, which is all this tool needs. */
  getrandbits(bits: number) {
    if (bits < 1 || bits > 32) throw new Error("getrandbits is implemented for 1..32 bits.");
    return this.genrandUint32() >>> (32 - bits);
  }

  /** `Random._randbelow_with_getrandbits`: draw k bits, reject and redraw until it lands under n. */
  private randBelow(n: number) {
    if (n <= 0) return 0;
    const bits = 32 - Math.clz32(n);
    let value = this.getrandbits(bits);
    while (value >= n) value = this.getrandbits(bits);
    return value;
  }

  /** `random.choice(seq)` — `seq[_randbelow(len(seq))]`. Like Python, a one-item list still draws. */
  choice<T>(items: readonly T[]) {
    if (!items.length) throw new Error("Cannot choose from an empty list.");
    return items[this.randBelow(items.length)];
  }

  /** `random.randint(a, b)` — inclusive at both ends, via `randrange(a, b + 1)`. */
  randint(a: number, b: number) {
    if (b < a) throw new Error("randint needs b >= a.");
    return a + this.randBelow(b - a + 1);
  }
}
