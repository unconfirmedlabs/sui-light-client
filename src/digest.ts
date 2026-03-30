/** Sui digest computation: Blake2b-256 with struct name domain separators. */

import { blake2b } from '@noble/hashes/blake2b';

const encoder = new TextEncoder();

/**
 * Compute a Sui digest: Blake2b-256("StructName::" || data)
 * All Sui digests follow this pattern for domain separation.
 */
export function suiDigest(structName: string, bcsBytes: Uint8Array): Uint8Array {
	const prefix = encoder.encode(`${structName}::`);
	const input = new Uint8Array(prefix.length + bcsBytes.length);
	input.set(prefix);
	input.set(bcsBytes, prefix.length);
	return blake2b(input, { dkLen: 32 });
}

export function checkpointDigest(summaryBcs: Uint8Array): Uint8Array {
	return suiDigest('CheckpointSummary', summaryBcs);
}

export function checkpointContentsDigest(contentsBcs: Uint8Array): Uint8Array {
	return suiDigest('CheckpointContents', contentsBcs);
}

export function transactionDigest(txDataBcs: Uint8Array): Uint8Array {
	return suiDigest('TransactionData', txDataBcs);
}

export function transactionEffectsDigest(effectsBcs: Uint8Array): Uint8Array {
	return suiDigest('TransactionEffects', effectsBcs);
}

export function transactionEventsDigest(eventsBcs: Uint8Array): Uint8Array {
	return suiDigest('TransactionEvents', eventsBcs);
}
