/**
 * Sec-MS-GEC token（v2）。
 *
 * 微软 Edge「大声朗读」的反滥用签名。2026-10 起服务端换成了 v2：
 *   · `Sec-MS-GEC-Version` 前缀从 `1-` 改成 `2-`
 *   · token 从纯 SHA256 变成 `<16位hex>-<64位hex>`（CS64 + SHA256）
 * 旧的 `1-` 前缀 + 纯 SHA256 现在一律 403（见 rany2/edge-tts#507）。
 *
 * 下面的算法是 rany2/edge-tts 的忠实移植。它**不是标准 SHA256**：
 * 初始状态由数据的头 7 字节算出，轮常量和 schedule 常量也都被改过。
 * 所以不能图省事用 node:crypto 的 createHash('sha256') 代替。
 *
 * 全程用 BigInt 做 32 位运算 —— Python 里靠 `& 0xFFFFFFFF` 截断，
 * 而 JS 的 Number 位运算是 32 位有符号，乘法和移位都会溢出。
 */

const MASK = 0xFFFFFFFFn;

const SHA256_INITIAL = [
  0x6A09E667n, 0xBB67AE85n, 0x3C6EF372n, 0xA54FF53An,
  0x510E527Fn, 0x9B05688Cn, 0x1F83D9ABn, 0x5BE0CD19n,
];

const SHA256_STATE = [
  0xFD9FBEA2n, 0x91243CE7n, 0xBE499094n, 0xCD2E1E0An,
  0x6C006F49n, 0x04BD35ABn, 0xFEB0A7E4n, 0x03EFFBD2n,
];

const SHA256_SCHEDULE = [
  0xEB24BF9En, 0x1558691Fn, 0xA0C09EE2n, 0x0CFA32BAn,
  0xA622EE8Cn, 0xD1DD9491n, 0xC0DD25A0n, 0xF9E70AB6n,
  0xF0C31573n, 0x7058CE4En, 0x7188E606n, 0x00E5AB33n,
  0xD258B060n, 0x72766564n,
];

const SHA256_ROUND_CONSTANTS = [
  0x428A2F98n, 0x71374491n, 0xB5C0FBCFn, 0xE9B5DBA5n,
  0x3956C25Bn, 0x59F111F1n, 0x923F82A4n, 0xAB1C5ED5n,
  0xD807AA98n, 0x12835B01n, 0x243185BEn, 0x550C7DC3n,
  0x72BE5D74n, 0x80DEB1FEn, 0x9BDC06A7n, 0xC19BF174n,
  0xE49B69C1n, 0xEFBE4786n, 0x0FC19DC6n, 0x240CA1CCn,
  0x2DE92C6Fn, 0x4A7484AAn, 0x5CB0A9DCn, 0x76F988DAn,
  0x983E5152n, 0xA831C66Dn, 0xB00327C8n, 0xBF597FC7n,
  0xC6E00BF3n, 0xD5A79147n, 0x06CA6351n, 0x14292967n,
  0x27B70A85n, 0x2E1B2138n, 0x4D2C6DFCn, 0x53380D13n,
  0x650A7354n, 0x766A0ABBn, 0x81C2C92En, 0x92722C85n,
  0xA2BFE8A1n, 0xA81A664Bn, 0xC24B8B70n, 0xC76C51A3n,
  0xD192E819n, 0xD6990624n, 0xF40E3585n, 0x106AA070n,
  0x19A4C116n, 0x1E376C08n, 0x2748774Cn, 0x34B0BCB5n,
  0x391C0CB3n, 0x4ED8AA4An, 0x5B9CCA4Fn, 0x682E6FF3n,
  0x748F82EEn, 0x78A5636Fn, 0x84C87814n, 0x8CC70208n,
  0x90BEFFFAn, 0xA4506CEBn, 0xBEF9A3F7n, 0xC67178F2n,
];

const SHA256_ADJUSTMENT = 0xC9DC06A7n;
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80n;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0n;

// _SHA256_BLOCK_CONSTANTS = ROUND[:14] + (ADJUSTMENT,) + ROUND[15:]
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];

const CS64_COEFFICIENTS = [
  [0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn],
  [0x3BEB65BCn, 0x29514038n], [0xC89C5933n, 0xB328CBDFn],
  [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn],
  [0xE92491B1n, 0x607801C6n], [0xF0A5B9D5n, 0x82B2C1FBn],
  [0x06064CF3n, 0xFA51A3DAn], [0xDA79FA60n, 0x207CC464n],
  [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n],
  [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xF2F90B1An;
const CS64_ADJUSTMENT1 = 0x0B1A0000n;

const WIN_EPOCH = 11644473600n;
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// ───────────────────────── 基础位运算 ─────────────────────────

const u32 = (v) => v & MASK;

/** 32 位左旋 16 —— Python 的 (v << 16 | v >> 16) & MASK */
const rol16 = (v) => ((v << 16n) | (v >> 16n)) & MASK;

/** SHA-256 小 sigma0（组合旋转只截断一次） */
const sigma0 = (v) =>
  ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & MASK;

/** SHA-256 小 sigma1 */
const sigma1 = (v) =>
  ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & MASK;

// ───────────────────────── 字节工具 ─────────────────────────

/** 按大端拆成 32 位字（用于 SHA256 的 16 字 block） */
function beWords(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 4) {
    out.push(
      (BigInt(bytes[i]) << 24n) |
      (BigInt(bytes[i + 1]) << 16n) |
      (BigInt(bytes[i + 2]) << 8n) |
      BigInt(bytes[i + 3])
    );
  }
  return out;
}

/** 按小端拆成 32 位字，补齐到偶数个（CS64 用） */
function leWordsEven(bytes) {
  const padded = Array.from(bytes);
  while (padded.length % 4 !== 0) padded.push(0);
  const out = [];
  for (let i = 0; i < padded.length; i += 4) {
    out.push(
      BigInt(padded[i]) |
      (BigInt(padded[i + 1]) << 8n) |
      (BigInt(padded[i + 2]) << 16n) |
      (BigInt(padded[i + 3]) << 24n)
    );
  }
  if (out.length % 2 === 1) out.push(0n);
  return out;
}

/** 32 位字序列 → 大端字节 */
function wordsToBytesBE(words) {
  const out = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => out.writeUInt32BE(Number(w & MASK), i * 4));
  return out;
}

// ───────────────────────── SHA-256 变体 ─────────────────────────

/** 展开 schedule（从 firstWord 开始） */
function expandSchedule(words, firstWord) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push(u32(s1 + words[i - 7] + s0 + words[i - 16]));
  }
}

/** 由数据的头 7 字节算出初始状态 */
function sha256Init(data) {
  const words = new Array(14).fill(0n);
  words.push((BigInt(data[0]) << 16n) | (BigInt(data[1]) << 8n) | BigInt(data[2]));
  words.push(
    (BigInt(data[3]) << 24n) | (BigInt(data[4]) << 16n) |
    (BigInt(data[5]) << 8n) | BigInt(data[6])
  );

  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value += index === 16
        ? (sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT)
        : sigma1(words[index - 2]);
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      value += index === 29
        ? (sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT)
        : sigma0(words[index - 15]);
    }
    words.push(u32(value));
  }

  words.push(u32(
    sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] +
    SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]
  ));

  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((v, i) => u32(v + working[i]));
}

/**
 * 跑 64 轮。firstRound 非 0 表示从 block 中途接着跑。
 *
 * 前半段是通用循环，后半段（aligned 之后）是手工展开的 8 轮 ——
 * 原实现靠轮转寄存器省赋值，这里忠实照搬，不要「优化」成统一循环：
 * 展开版的运算顺序和中间截断点不同，结果会变。
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;

  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  // 乘以 2^32+1 让 32 位字在 64 位里重复一次，右移就等价于 ROTR
  const rotr = (v, n) => (v * 0x100000001n) >> n;

  for (let index = firstRound; index < aligned; index++) {
    const rotE = e * 0x100000001n;
    const rotA = a * 0x100000001n;
    const t1 = h
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (g ^ (e & (f ^ g)))
      + constants[index]
      + words[index];
    const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((a & b) | (c & (a | b)));
    [a, b, c, d, e, f, g, h] = [
      u32(t1 + t2), a, b, c, u32(d + t1), e, f, g,
    ];
  }

  for (let index = aligned; index < 64; index += 8) {
    // ── 轮 0 ──
    let rotE = e * 0x100000001n;
    let rotA = a * 0x100000001n;
    let t1 = h
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (g ^ (e & (f ^ g)))
      + constants[index] + words[index];
    d = u32(d + t1);
    h = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((a & b) | (c & (a | b))));

    // ── 轮 1 ──
    rotE = d * 0x100000001n;
    rotA = h * 0x100000001n;
    t1 = g
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (f ^ (d & (e ^ f)))
      + constants[index + 1] + words[index + 1];
    c = u32(c + t1);
    g = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((h & a) | (b & (h | a))));

    // ── 轮 2 ──
    rotE = c * 0x100000001n;
    rotA = g * 0x100000001n;
    t1 = f
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (e ^ (c & (d ^ e)))
      + constants[index + 2] + words[index + 2];
    b = u32(b + t1);
    f = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((g & h) | (a & (g | h))));

    // ── 轮 3 ──
    rotE = b * 0x100000001n;
    rotA = f * 0x100000001n;
    t1 = e
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (d ^ (b & (c ^ d)))
      + constants[index + 3] + words[index + 3];
    a = u32(a + t1);
    e = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((f & g) | (h & (f | g))));

    // ── 轮 4 ──
    rotE = a * 0x100000001n;
    rotA = e * 0x100000001n;
    t1 = d
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (c ^ (a & (b ^ c)))
      + constants[index + 4] + words[index + 4];
    h = u32(h + t1);
    d = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((e & f) | (g & (e | f))));

    // ── 轮 5 ──
    rotE = h * 0x100000001n;
    rotA = d * 0x100000001n;
    t1 = c
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (b ^ (h & (a ^ b)))
      + constants[index + 5] + words[index + 5];
    g = u32(g + t1);
    c = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((d & e) | (f & (d | e))));

    // ── 轮 6 ──
    rotE = g * 0x100000001n;
    rotA = c * 0x100000001n;
    t1 = b
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (a ^ (g & (h ^ a)))
      + constants[index + 6] + words[index + 6];
    f = u32(f + t1);
    b = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((c & d) | (e & (c | d))));

    // ── 轮 7 ──
    rotE = f * 0x100000001n;
    rotA = b * 0x100000001n;
    t1 = a
      + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (h ^ (f & (g ^ h)))
      + constants[index + 7] + words[index + 7];
    e = u32(e + t1);
    a = u32(t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
      + ((b & c) | (d & (b | c))));
  }

  return [a, b, c, d, e, f, g, h];
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('token salt 至少需要 7 字节');

  const length = 57 + data.length;
  const padLen = ((55 - length) % 64 + 64) % 64;

  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(padLen),
  ]);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64BE(BigInt(length * 8));
  const block = Buffer.concat([padded, lenBuf]);

  let state = sha256Init(data);
  for (let off = 0; off < block.length; off += 64) {
    const words = beWords(block.subarray(off, off + 64));
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words);
    state = state.map((v, i) => u32(v + working[i]));
  }
  return wordsToBytesBE(state);
}

// ───────────────────────── CS64 ─────────────────────────

function cs64Digest(data, digest) {
  const keyA = BigInt(digest.readUInt32LE(0)) | 1n;
  const keyB = BigInt(digest.readUInt32LE(4)) | 1n;
  const factors = [u32(keyA * CS64_FACTOR), u32(keyB * CS64_FACTOR)];

  const terms = CS64_COEFFICIENTS.map(([coeff], i) => u32(coeff * factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);

  const withZero = Buffer.concat([Buffer.from([0]), data]);
  leWordsEven(withZero).forEach((word, index) => {
    let term = word * (index % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (index % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(u32(term));
    offsets.push(u32(offset));
  });

  let swapAcc = 0n;
  let swapLast = 0n;
  let state = 0n;
  let acc = 0n;

  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16(u32(offsets[index] + x));
    let q = u32(t * 0x76F50F34n);
    swapAcc += u32(rol16(q) * 0xC3EFEA97n + q);

    t = rol16(u32(offsets[index + 1] + y));
    q = u32(t * 0x1881CE3Cn);
    swapLast = u32(rol16(q) * 0x35BD1EC9n + q);
    swapAcc = u32(swapAcc + swapLast);

    state = u32(state * keyA + x);
    state = u32(rol16(state) * 0xCF98B111n);
    state = u32(rol16(state) * 0x87085B9Fn);
    state = u32(rol16(state) * 0x12CEB96Dn);
    state = u32(rol16(state) * 0x257E1D83n);
    acc += state;

    t = u32(state * keyB + y);
    t = u32(rol16(t) * 0xA27416F5n);
    t = u32(rol16(t) * 0xD38396FFn);
    state = u32(rol16(u32(rol16(t) * 0x7C932B89n)) * 0xBFA49F69n);
    acc = u32(acc + state);
  }

  return [swapLast ^ state, swapAcc ^ acc];
}

// ───────────────────────── 对外接口 ─────────────────────────

/**
 * 生成 Sec-MS-GEC token。
 *
 * @param {number} [unixTimestamp] 用指定时间代替当前时间（测试用）
 * @returns {string} `<16位hex>-<64位hex>`
 */
export function generateSecMsGec(unixTimestamp) {
  const now = unixTimestamp ?? Date.now() / 1000;
  let ticks = BigInt(Math.floor(now)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;

  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = sha256Digest(data);
  const [w0, w1] = cs64Digest(data, digest);

  const cs64 = Buffer.alloc(8);
  cs64.writeUInt32LE(Number(w0), 0);
  cs64.writeUInt32LE(Number(w1), 4);

  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}
