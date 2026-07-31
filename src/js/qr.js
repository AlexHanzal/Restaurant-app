// ════════════════════════════════════════════════════════════════════════
// QR.JS — minimal, dependency-free QR Code encoder (ISO/IEC 18004), byte
// mode only, versions 1–10 (plenty of capacity for a GoPay redirect URL —
// version 10 at error-correction level M holds ~200 bytes). No network
// calls, no npm package — just the Reed–Solomon / bit-placement algorithm
// implemented directly, so a "Zaplatit online" QR code can be rendered
// entirely client-side (see src/js/inner.js "TABLE PAY-ONLINE" section).
//
// Usage:
//   const svg = QR.renderSVG('https://gate.gopay.cz/gw/select?id=123', { scale: 5 });
//   container.innerHTML = svg;
//
// Exposes window.QR = { encode(text, opts), toSvgString(modules, opts), renderSVG(text, opts) }
// ════════════════════════════════════════════════════════════════════════

(function (global) {
    'use strict';

    // ── GF(256) arithmetic (Reed–Solomon error correction) ─────────────────

    const GF_EXP = new Array(512).fill(0);
    const GF_LOG = new Array(256).fill(0);
    (function initGF() {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            GF_EXP[i] = x;
            GF_LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11d;
        }
        for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    })();

    function gfMul(a, b) {
        if (a === 0 || b === 0) return 0;
        return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    function polyMul(p1, p2) {
        const res = new Array(p1.length + p2.length - 1).fill(0);
        for (let i = 0; i < p1.length; i++) {
            for (let j = 0; j < p2.length; j++) {
                res[i + j] ^= gfMul(p1[i], p2[j]);
            }
        }
        return res;
    }

    function rsGeneratorPoly(ecLen) {
        let poly = [1];
        for (let i = 0; i < ecLen; i++) poly = polyMul(poly, [1, GF_EXP[i]]);
        return poly;
    }

    function rsEncode(dataCw, ecLen) {
        const gen = rsGeneratorPoly(ecLen);
        const res = dataCw.concat(new Array(ecLen).fill(0));
        for (let i = 0; i < dataCw.length; i++) {
            const coef = res[i];
            if (coef !== 0) {
                for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
            }
        }
        return res.slice(dataCw.length);
    }

    // ── Version capacity / block-structure table (ISO/IEC 18004 Annex) ────
    // { ecPerBlock, blocks: [[count, codewordsPerBlock], ...] }, per EC level.

    const VERSION_TABLE = {
        1: { L: { ec: 7, blocks: [[1, 19]] }, M: { ec: 10, blocks: [[1, 16]] }, Q: { ec: 13, blocks: [[1, 13]] }, H: { ec: 17, blocks: [[1, 9]] } },
        2: { L: { ec: 10, blocks: [[1, 34]] }, M: { ec: 16, blocks: [[1, 28]] }, Q: { ec: 22, blocks: [[1, 22]] }, H: { ec: 28, blocks: [[1, 16]] } },
        3: { L: { ec: 15, blocks: [[1, 55]] }, M: { ec: 26, blocks: [[1, 44]] }, Q: { ec: 18, blocks: [[2, 17]] }, H: { ec: 22, blocks: [[2, 13]] } },
        4: { L: { ec: 20, blocks: [[1, 80]] }, M: { ec: 18, blocks: [[2, 32]] }, Q: { ec: 26, blocks: [[2, 24]] }, H: { ec: 16, blocks: [[4, 9]] } },
        5: { L: { ec: 26, blocks: [[1, 108]] }, M: { ec: 24, blocks: [[2, 43]] }, Q: { ec: 18, blocks: [[2, 15], [2, 16]] }, H: { ec: 22, blocks: [[2, 11], [2, 12]] } },
        6: { L: { ec: 18, blocks: [[2, 68]] }, M: { ec: 16, blocks: [[4, 27]] }, Q: { ec: 24, blocks: [[4, 19]] }, H: { ec: 28, blocks: [[4, 15]] } },
        7: { L: { ec: 20, blocks: [[2, 78]] }, M: { ec: 18, blocks: [[4, 31]] }, Q: { ec: 18, blocks: [[2, 14], [4, 15]] }, H: { ec: 26, blocks: [[4, 13], [1, 14]] } },
        8: { L: { ec: 24, blocks: [[2, 97]] }, M: { ec: 22, blocks: [[2, 38], [2, 39]] }, Q: { ec: 22, blocks: [[4, 18], [2, 19]] }, H: { ec: 26, blocks: [[4, 14], [2, 15]] } },
        9: { L: { ec: 30, blocks: [[2, 116]] }, M: { ec: 22, blocks: [[3, 36], [2, 37]] }, Q: { ec: 20, blocks: [[4, 16], [4, 17]] }, H: { ec: 24, blocks: [[4, 12], [4, 13]] } },
        10: { L: { ec: 18, blocks: [[2, 68], [2, 69]] }, M: { ec: 26, blocks: [[4, 43], [1, 44]] }, Q: { ec: 24, blocks: [[6, 19], [2, 20]] }, H: { ec: 28, blocks: [[6, 15], [2, 16]] } },
    };
    const MAX_VERSION = 10;

    // Alignment-pattern center coordinates per version (v1 has none).
    const ALIGN_POS = {
        1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
        7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    };

    // Extra 0-bits appended after interleaved codewords, per version.
    const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

    function charCountBits(version) {
        return version <= 9 ? 8 : 16;
    }

    // ── Bit buffer ──────────────────────────────────────────────────────────

    function BitBuffer() {
        this.bits = [];
    }
    BitBuffer.prototype.put = function (val, len) {
        for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
    };
    Object.defineProperty(BitBuffer.prototype, 'length', {
        get: function () { return this.bits.length; }
    });
    BitBuffer.prototype.toBytes = function () {
        const bytes = [];
        for (let i = 0; i < this.bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
            bytes.push(b);
        }
        return bytes;
    };

    function utf8Bytes(str) {
        if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
        // Fallback for very old environments — manual UTF-8 encoding.
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            let code = str.codePointAt(i);
            if (code > 0xFFFF) i++; // consumed a surrogate pair
            if (code < 0x80) bytes.push(code);
            else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
            else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
            else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
        return bytes;
    }

    // ── Matrix construction ─────────────────────────────────────────────────

    function makeGrid(size, fill) {
        const g = new Array(size);
        for (let r = 0; r < size; r++) g[r] = new Array(size).fill(fill);
        return g;
    }

    function drawFinderPattern(matrix, reserved, size, r0, c0) {
        for (let dr = -1; dr <= 7; dr++) {
            for (let dc = -1; dc <= 7; dc++) {
                const r = r0 + dr, c = c0 + dc;
                if (r < 0 || c < 0 || r >= size || c >= size) continue;
                reserved[r][c] = true;
                let dark;
                if (dr < 0 || dc < 0 || dr > 6 || dc > 6) dark = false; // separator
                else if (dr === 0 || dr === 6 || dc === 0 || dc === 6) dark = true; // outer ring
                else if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) dark = true; // inner 3x3
                else dark = false;
                matrix[r][c] = dark ? 1 : 0;
            }
        }
    }

    function drawTiming(matrix, reserved, size) {
        for (let i = 8; i < size - 8; i++) {
            if (!reserved[6][i]) { matrix[6][i] = (i % 2 === 0) ? 1 : 0; reserved[6][i] = true; }
            if (!reserved[i][6]) { matrix[i][6] = (i % 2 === 0) ? 1 : 0; reserved[i][6] = true; }
        }
    }

    function drawAlignmentSquare(matrix, reserved, r0, c0) {
        for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
                const r = r0 + dr, c = c0 + dc;
                reserved[r][c] = true;
                const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                matrix[r][c] = dark ? 1 : 0;
            }
        }
    }

    function drawAlignmentPatterns(matrix, reserved, version, size) {
        const positions = ALIGN_POS[version];
        if (!positions || positions.length === 0) return;
        const first = positions[0], last = positions[positions.length - 1];
        for (const r of positions) {
            for (const c of positions) {
                if ((r === first && c === first) || (r === first && c === last) || (r === last && c === first)) continue;
                drawAlignmentSquare(matrix, reserved, r, c);
            }
        }
    }

    // Format info (EC level + mask) — 5 data bits -> BCH(15,5).
    const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
    function formatBCH(data5) {
        let g = data5 << 10;
        for (let i = 14; i >= 10; i--) {
            if (g & (1 << i)) g ^= 0b10100110111 << (i - 10);
        }
        return (data5 << 10) | g;
    }

    function reserveFormatAreas(reserved, size) {
        const c1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
        const c2 = [
            [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
            [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
        ];
        for (const [r, c] of c1) reserved[r][c] = true;
        for (const [r, c] of c2) reserved[r][c] = true;
        reserved[size - 8][8] = true; // dark module
    }

    function placeFormatInfo(matrix, ecLevel, maskId, size) {
        const data5 = (EC_BITS[ecLevel] << 3) | maskId;
        const code = formatBCH(data5) ^ 0b101010000010010;
        const bit = i => (code >> i) & 1; // i=0 LSB .. i=14 MSB
        const c1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
        const c2 = [
            [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
            [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
        ];
        for (let k = 0; k < 15; k++) { const [r, c] = c1[k]; matrix[r][c] = bit(14 - k); }
        for (let k = 0; k < 15; k++) { const [r, c] = c2[k]; matrix[r][c] = bit(14 - k); }
        matrix[size - 8][8] = 1; // dark module — always on
    }

    // Version info (v>=7 only) — 6-bit version number -> BCH(18,6).
    function versionBCH(version) {
        let g = version << 12;
        for (let i = 17; i >= 12; i--) {
            if (g & (1 << i)) g ^= 0b1111100100101 << (i - 12);
        }
        return (version << 12) | g;
    }
    function reserveVersionAreas(reserved, version, size) {
        if (version < 7) return;
        for (let i = 0; i < 18; i++) {
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            reserved[a][b] = true;
            reserved[b][a] = true;
        }
    }
    function placeVersionInfo(matrix, version, size) {
        if (version < 7) return;
        const v = versionBCH(version);
        for (let i = 0; i < 18; i++) {
            const bit = (v >> i) & 1;
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            matrix[a][b] = bit;
            matrix[b][a] = bit;
        }
    }

    function placeDataBits(matrix, reserved, bitsArray, size) {
        let bitIndex = 0;
        let dir = -1; // -1 = upward, 1 = downward
        let col = size - 1;
        while (col > 0) {
            if (col === 6) col--; // skip timing column
            for (let count = 0; count < size; count++) {
                const row = dir === -1 ? size - 1 - count : count;
                for (let dc = 0; dc < 2; dc++) {
                    const c = col - dc;
                    if (!reserved[row][c]) {
                        matrix[row][c] = bitIndex < bitsArray.length ? bitsArray[bitIndex] : 0;
                        bitIndex++;
                    }
                }
            }
            dir = -dir;
            col -= 2;
        }
    }

    const MASK_FUNCS = [
        (r, c) => (r + c) % 2 === 0,
        (r, c) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];

    function applyMaskCopy(matrix, reserved, maskId, size) {
        const fn = MASK_FUNCS[maskId];
        const out = matrix.map(row => row.slice());
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (reserved[r][c]) continue;
                if (fn(r, c)) out[r][c] ^= 1;
            }
        }
        return out;
    }

    function computePenalty(matrix, size) {
        let penalty = 0;

        for (let r = 0; r < size; r++) {
            let runColor = matrix[r][0], runLen = 1;
            for (let c = 1; c < size; c++) {
                if (matrix[r][c] === runColor) { runLen++; }
                else { if (runLen >= 5) penalty += 3 + (runLen - 5); runColor = matrix[r][c]; runLen = 1; }
            }
            if (runLen >= 5) penalty += 3 + (runLen - 5);
        }
        for (let c = 0; c < size; c++) {
            let runColor = matrix[0][c], runLen = 1;
            for (let r = 1; r < size; r++) {
                if (matrix[r][c] === runColor) { runLen++; }
                else { if (runLen >= 5) penalty += 3 + (runLen - 5); runColor = matrix[r][c]; runLen = 1; }
            }
            if (runLen >= 5) penalty += 3 + (runLen - 5);
        }

        for (let r = 0; r < size - 1; r++) {
            for (let c = 0; c < size - 1; c++) {
                const v = matrix[r][c];
                if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) penalty += 3;
            }
        }

        const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
        for (let r = 0; r < size; r++) {
            for (let c = 0; c <= size - 11; c++) {
                let matchA = true, matchB = true;
                for (let k = 0; k < 11; k++) {
                    if (matrix[r][c + k] !== patternA[k]) matchA = false;
                    if (matrix[r][c + k] !== patternB[k]) matchB = false;
                }
                if (matchA || matchB) penalty += 40;
            }
        }
        for (let c = 0; c < size; c++) {
            for (let r = 0; r <= size - 11; r++) {
                let matchA = true, matchB = true;
                for (let k = 0; k < 11; k++) {
                    if (matrix[r + k][c] !== patternA[k]) matchA = false;
                    if (matrix[r + k][c] !== patternB[k]) matchB = false;
                }
                if (matchA || matchB) penalty += 40;
            }
        }

        let dark = 0;
        for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) dark++;
        const percent = (dark * 100) / (size * size);
        penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;

        return penalty;
    }

    // ── Public: encode ───────────────────────────────────────────────────────

    function encode(text, opts) {
        opts = opts || {};
        const ecLevel = (opts.ecLevel || 'M').toUpperCase();
        const bytes = utf8Bytes(String(text == null ? '' : text));

        let version = null, info = null, cbits = null;
        for (let v = 1; v <= MAX_VERSION; v++) {
            const table = VERSION_TABLE[v] && VERSION_TABLE[v][ecLevel];
            if (!table) continue;
            const cb = charCountBits(v);
            const totalDataCodewords = table.blocks.reduce((sum, [count, len]) => sum + count * len, 0);
            const capacityBits = totalDataCodewords * 8;
            const requiredBits = 4 + cb + bytes.length * 8;
            if (requiredBits <= capacityBits) { version = v; info = table; cbits = cb; break; }
        }
        if (!version) throw new Error('QR: text too long to encode (exceeds version ' + MAX_VERSION + ' capacity)');

        const totalDataCodewords = info.blocks.reduce((sum, [count, len]) => sum + count * len, 0);
        const capacityBits = totalDataCodewords * 8;

        const bits = new BitBuffer();
        bits.put(0b0100, 4); // byte mode indicator
        bits.put(bytes.length, cbits);
        for (const b of bytes) bits.put(b, 8);

        const termLen = Math.min(4, capacityBits - bits.length);
        if (termLen > 0) bits.put(0, termLen);
        while (bits.length % 8 !== 0) bits.put(0, 1);
        const padBytes = [0xEC, 0x11];
        let pi = 0;
        while (bits.length < capacityBits) { bits.put(padBytes[pi % 2], 8); pi++; }

        const dataCodewords = bits.toBytes();

        const blocks = [];
        let offset = 0;
        for (const [count, cwLen] of info.blocks) {
            for (let i = 0; i < count; i++) {
                const data = dataCodewords.slice(offset, offset + cwLen);
                offset += cwLen;
                blocks.push({ data, ec: rsEncode(data, info.ec) });
            }
        }

        const maxDataLen = Math.max(...blocks.map(b => b.data.length));
        const finalCodewords = [];
        for (let i = 0; i < maxDataLen; i++) {
            for (const b of blocks) if (i < b.data.length) finalCodewords.push(b.data[i]);
        }
        for (let i = 0; i < info.ec; i++) {
            for (const b of blocks) finalCodewords.push(b.ec[i]);
        }

        const finalBits = new BitBuffer();
        for (const cw of finalCodewords) finalBits.put(cw, 8);
        const remainder = REMAINDER_BITS[version - 1] || 0;
        if (remainder) finalBits.put(0, remainder);

        const size = version * 4 + 17;
        const matrix = makeGrid(size, 0);
        const reserved = makeGrid(size, false);

        drawFinderPattern(matrix, reserved, size, 0, 0);
        drawFinderPattern(matrix, reserved, size, 0, size - 7);
        drawFinderPattern(matrix, reserved, size, size - 7, 0);
        drawTiming(matrix, reserved, size);
        drawAlignmentPatterns(matrix, reserved, version, size);
        reserveFormatAreas(reserved, size);
        reserveVersionAreas(reserved, version, size);

        placeDataBits(matrix, reserved, finalBits.bits, size);

        let best = null;
        for (let m = 0; m < 8; m++) {
            const trial = applyMaskCopy(matrix, reserved, m, size);
            placeFormatInfo(trial, ecLevel, m, size);
            placeVersionInfo(trial, version, size);
            const penalty = computePenalty(trial, size);
            if (!best || penalty < best.penalty) best = { mask: m, matrix: trial, penalty };
        }

        return {
            version,
            size,
            maskPattern: best.mask,
            modules: best.matrix.map(row => row.map(v => !!(v & 1))),
        };
    }

    // ── Public: render as inline SVG markup ─────────────────────────────────

    function toSvgString(modules, opts) {
        opts = opts || {};
        const scale = opts.scale || 6;
        const margin = opts.margin != null ? opts.margin : 4;
        const dark = opts.dark || '#161616';
        const light = opts.light || '#ffffff';
        const n = modules.length;
        const px = (n + margin * 2) * scale;
        let path = '';
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                if (modules[r][c]) {
                    const x = (c + margin) * scale, y = (r + margin) * scale;
                    path += `M${x},${y}h${scale}v${scale}h-${scale}z `;
                }
            }
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR kód pro platbu"><rect width="100%" height="100%" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
    }

    function renderSVG(text, opts) {
        const { modules } = encode(text, opts);
        return toSvgString(modules, opts);
    }

    const QR = { encode, toSvgString, renderSVG };

    if (typeof module !== 'undefined' && module.exports) module.exports = QR;
    global.QR = QR;
})(typeof window !== 'undefined' ? window : globalThis);
