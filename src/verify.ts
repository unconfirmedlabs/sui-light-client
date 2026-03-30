/**
 * Checkpoint certificate verification.
 *
 * Verifies that a CheckpointSummary was signed by a quorum (≥6667/10000)
 * of validators using BLS12-381 aggregate signatures.
 */

import { bls12_381 } from '@noble/curves/bls12-381';
import { decodeRoaringBitmap } from './bitmap.js';
import { checkpointContentsDigest, transactionEffectsDigest, transactionEventsDigest } from './digest.js';
import {
	CHECKPOINT_SUMMARY_INTENT,
	QUORUM_THRESHOLD,
	type AuthorityQuorumSignInfo,
	type CheckpointContents,
	type CheckpointSummary,
	type Committee,
	type Digest,
	type ExecutionDigests,
} from './types.js';
import { bcsCheckpointContents, bcsTransactionEffects } from './bcs.js';

type G2Point = ReturnType<typeof bls12_381.G2.ProjectivePoint.fromHex>;

/**
 * A committee with pre-parsed G2 public key points.
 *
 * Parsing 96-byte compressed G2 points is the bottleneck (~1ms per key).
 * Pre-parsing the full committee once (~113ms for 118 validators) lets
 * per-checkpoint aggregation drop from ~75ms to <1ms.
 *
 * Create once per epoch, reuse for all checkpoints in that epoch.
 */
export class PreparedCommittee {
	readonly epoch: bigint;
	readonly members: { point: G2Point; weight: bigint }[];

	constructor(committee: Committee) {
		this.epoch = committee.epoch;
		this.members = committee.members.map((m) => ({
			point: bls12_381.G2.ProjectivePoint.fromHex(m.publicKey),
			weight: m.weight,
		}));
	}
}

/**
 * Verify a checkpoint certificate against a committee.
 *
 * Takes the raw BCS bytes of the CheckpointSummary — the exact bytes
 * that validators signed. Using raw bytes avoids re-serialization which
 * could introduce subtle mismatches.
 *
 * ~10ms per checkpoint with a PreparedCommittee (vs ~150ms without).
 */
export function verifyCheckpoint(
	summaryBcs: Uint8Array,
	authSignature: AuthorityQuorumSignInfo,
	committee: Committee | PreparedCommittee,
): void {
	const prepared = committee instanceof PreparedCommittee
		? committee
		: new PreparedCommittee(committee);

	if (authSignature.epoch !== prepared.epoch) {
		throw new Error(
			`Epoch mismatch: signature epoch ${authSignature.epoch} !== committee epoch ${prepared.epoch}`,
		);
	}

	// Decode signer indices from RoaringBitmap
	const signerIndices = decodeRoaringBitmap(authSignature.signersMap);

	// Aggregate pre-parsed G2 points and sum weight
	let totalPower = 0n;
	let aggregatedPoint: G2Point | null = null;

	for (const idx of signerIndices) {
		if (idx >= prepared.members.length) {
			throw new Error(`Signer index ${idx} exceeds committee size ${prepared.members.length}`);
		}
		const member = prepared.members[idx];
		totalPower += member.weight;
		aggregatedPoint = aggregatedPoint ? aggregatedPoint.add(member.point) : member.point;
	}

	if (totalPower < QUORUM_THRESHOLD) {
		throw new Error(
			`Insufficient weight: ${totalPower} < ${QUORUM_THRESHOLD} (${signerIndices.length}/${prepared.members.length} validators)`,
		);
	}

	// Reconstruct the signed message using the raw BCS bytes:
	// [Intent(3 bytes)] || [CheckpointSummary BCS] || [epoch as u64 LE(8 bytes)]
	const epochBytes = new Uint8Array(8);
	const epochView = new DataView(epochBytes.buffer);
	epochView.setBigUint64(0, authSignature.epoch, true);

	const message = new Uint8Array(
		CHECKPOINT_SUMMARY_INTENT.length + summaryBcs.length + epochBytes.length,
	);
	message.set(CHECKPOINT_SUMMARY_INTENT);
	message.set(summaryBcs, CHECKPOINT_SUMMARY_INTENT.length);
	message.set(epochBytes, CHECKPOINT_SUMMARY_INTENT.length + summaryBcs.length);

	// Hash message to G1 curve and verify BLS signature (min-sig mode)
	const hashedMessage = bls12_381.shortSignatures.hash(message);
	const valid = bls12_381.shortSignatures.verify(
		authSignature.signature,
		hashedMessage,
		aggregatedPoint!.toRawBytes(true),
	);

	if (!valid) {
		throw new Error('BLS signature verification failed');
	}
}

/**
 * Verify that checkpoint contents match the content digest in a checkpoint summary.
 */
export function verifyCheckpointContents(
	summary: CheckpointSummary,
	contents: CheckpointContents,
): void {
	const contentsBcs = bcsCheckpointContents.serialize({ V1: contents }).toBytes();
	const computedDigest = checkpointContentsDigest(contentsBcs);

	if (!digestsEqual(computedDigest, summary.contentDigest)) {
		throw new Error('Checkpoint contents digest mismatch');
	}
}

/**
 * Verify that a transaction (by digest) is included in checkpoint contents.
 * Returns the execution digests (tx + effects) for the matched transaction.
 */
export function verifyTransactionInCheckpoint(
	txDigest: Uint8Array,
	contents: CheckpointContents,
): ExecutionDigests {
	for (const exec of contents.transactions) {
		if (digestsEqual(exec.transaction, txDigest)) {
			return exec;
		}
	}
	throw new Error('Transaction not found in checkpoint contents');
}

/**
 * Verify transaction effects against an expected digest from checkpoint contents.
 *
 * Verifies the raw BCS bytes hash to the expected effects digest, then parses
 * the effects to extract the events digest for further verification.
 *
 * @returns The events digest if the transaction emitted events, null otherwise.
 */
export function verifyTransactionEffects(
	effectsBcs: Uint8Array,
	expectedDigest: Digest,
): Digest | null {
	const computed = transactionEffectsDigest(effectsBcs);
	if (!digestsEqual(computed, expectedDigest)) {
		throw new Error('Transaction effects digest mismatch');
	}

	const parsed = bcsTransactionEffects.parse(effectsBcs);
	const eventsDigest = 'V1' in parsed ? parsed.V1.eventsDigest : parsed.V2.eventsDigest;
	return eventsDigest ? Uint8Array.from(eventsDigest) : null;
}

/**
 * Verify transaction events against an expected digest from transaction effects.
 */
export function verifyTransactionEvents(
	eventsBcs: Uint8Array,
	expectedDigest: Digest,
): void {
	const computed = transactionEventsDigest(eventsBcs);
	if (!digestsEqual(computed, expectedDigest)) {
		throw new Error('Transaction events digest mismatch');
	}
}

/**
 * Verify that an object was modified in the given transaction effects.
 *
 * Searches the effects' changed objects for the given object ID and returns
 * the object's output digest. Returns null if the object was deleted or wrapped.
 * Throws if the object ID is not found in the effects at all.
 *
 * Effects should have been verified via verifyTransactionEffects() first to
 * ensure the effects data is authentic.
 */
export function verifyObjectInEffects(
	objectId: Uint8Array,
	effectsBcs: Uint8Array,
): Digest | null {
	const parsed = bcsTransactionEffects.parse(effectsBcs);

	if ('V2' in parsed) {
		for (const [addr, change] of parsed.V2.changedObjects) {
			if (!digestsEqual(addr, objectId)) continue;

			const out = change.outputState;
			if ('ObjectWrite' in out) return Uint8Array.from(out.ObjectWrite[0]);
			if ('PackageWrite' in out) return Uint8Array.from(out.PackageWrite[1]);
			// NotExist or AccumulatorWriteV1 — object deleted or accumulator
			return null;
		}
	} else if ('V1' in parsed) {
		const v1 = parsed.V1;
		// created, mutated, unwrapped have (ObjectRef, Owner) tuples
		for (const list of [v1.created, v1.mutated, v1.unwrapped]) {
			for (const [ref] of list) {
				if (digestsEqual(ref.objectId, objectId)) {
					return Uint8Array.from(ref.digest);
				}
			}
		}
		// deleted, unwrappedThenDeleted, wrapped have ObjectRef only
		for (const list of [v1.deleted, v1.unwrappedThenDeleted, v1.wrapped]) {
			for (const ref of list) {
				if (digestsEqual(ref.objectId, objectId)) {
					return null; // deleted or wrapped
				}
			}
		}
	}

	throw new Error('Object not found in transaction effects');
}

export function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
