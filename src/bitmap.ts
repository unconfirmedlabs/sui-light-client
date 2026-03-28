/**
 * Minimal RoaringBitmap decoder for Sui's validator signers bitmap.
 *
 * Supports the standard portable serialization format:
 * - Cookie 12346: array and bitset containers
 * - Cookie 12347: array, bitset, and run containers
 *
 * See: https://github.com/RoaringBitmap/RoaringFormatSpec
 */

const SERIAL_COOKIE_NO_RUNCONTAINER = 12346;
const SERIAL_COOKIE = 12347;
const NO_OFFSET_THRESHOLD = 4;

/** Decode a serialized RoaringBitmap into a sorted array of set bit positions. */
export function decodeRoaringBitmap(data: Uint8Array): number[] {
	if (data.byteLength < 4) {
		throw new Error(`RoaringBitmap too small: ${data.byteLength} bytes`);
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;

	const firstU32 = view.getUint32(0, true);
	const firstU16 = firstU32 & 0xffff;

	let containerCount: number;
	let isRunBitmap: boolean[] = [];

	if (firstU32 === SERIAL_COOKIE_NO_RUNCONTAINER) {
		// Cookie 12346: [cookie: u32] [containerCount: u32]
		// No run containers possible in this format.
		offset = 4;
		containerCount = view.getUint32(offset, true);
		offset += 4;
	} else if (firstU16 === SERIAL_COOKIE) {
		// Cookie 12347: [cookie: u16] [containerCount-1: u16] [run bitmap...]
		// The run bitmap indicates which containers use run encoding.
		offset = 2;
		containerCount = view.getUint16(offset, true) + 1;
		offset += 2;

		// Read the run bitmap — 1 bit per container, packed into bytes
		const runBitmapBytes = Math.ceil(containerCount / 8);
		for (let i = 0; i < containerCount; i++) {
			const byteIdx = Math.floor(i / 8);
			const bitIdx = i % 8;
			isRunBitmap.push((data[offset + byteIdx] & (1 << bitIdx)) !== 0);
		}
		offset += runBitmapBytes;
	} else {
		throw new Error(`Invalid RoaringBitmap cookie: ${firstU32}`);
	}

	// Read container descriptive headers: [key: u16, cardinality-1: u16]
	const keys: number[] = [];
	const cardinalities: number[] = [];
	for (let i = 0; i < containerCount; i++) {
		keys.push(view.getUint16(offset, true));
		offset += 2;
		cardinalities.push(view.getUint16(offset, true) + 1);
		offset += 2;
	}

	// Skip offset headers
	if (firstU32 === SERIAL_COOKIE_NO_RUNCONTAINER) {
		// Always present for cookie 12346
		offset += containerCount * 4;
	} else if (containerCount >= NO_OFFSET_THRESHOLD) {
		// Only present for cookie 12347 when >= 4 containers
		offset += containerCount * 4;
	}

	// Read container data
	const result: number[] = [];
	for (let i = 0; i < containerCount; i++) {
		const highBits = keys[i] << 16;
		const cardinality = cardinalities[i];

		if (isRunBitmap[i]) {
			// Run container: pairs of [start: u16, length: u16]
			// Number of runs is stored as (numberOfRuns - 1) in the cardinality field?
			// No — for run containers, the data starts with a u16 run count.
			const numRuns = view.getUint16(offset, true);
			offset += 2;
			for (let r = 0; r < numRuns; r++) {
				const start = view.getUint16(offset, true);
				offset += 2;
				const length = view.getUint16(offset, true);
				offset += 2;
				for (let v = start; v <= start + length; v++) {
					result.push(highBits | v);
				}
			}
		} else if (cardinality <= 4096) {
			// Array container: sorted uint16 values
			for (let j = 0; j < cardinality; j++) {
				result.push(highBits | view.getUint16(offset, true));
				offset += 2;
			}
		} else {
			// Bitset container: 1024 x uint64 words (8192 bytes)
			for (let word = 0; word < 1024; word++) {
				const lo = view.getUint32(offset, true);
				const hi = view.getUint32(offset + 4, true);
				offset += 8;
				for (let bit = 0; bit < 32; bit++) {
					if (lo & (1 << bit)) result.push(highBits | (word * 64 + bit));
					if (hi & (1 << bit)) result.push(highBits | (word * 64 + 32 + bit));
				}
			}
		}
	}

	return result;
}
