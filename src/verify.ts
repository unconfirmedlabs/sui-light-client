/**
 * Checkpoint certificate verification.
 *
 * Verifies that a CheckpointSummary was signed by a quorum (≥6667/10000)
 * of validators using BLS12-381 aggregate signatures.
 */

import { bls12_381 } from '@noble/curves/bls12-381';
import { bcs } from '@mysten/bcs';
import { decodeRoaringBitmap } from './bitmap.js';
import { checkpointContentsDigest } from './digest.js';
import {
	CHECKPOINT_SUMMARY_INTENT,
	QUORUM_THRESHOLD,
	type AuthorityQuorumSignInfo,
	type CheckpointContents,
	type CheckpointSummary,
	type Committee,
	type ExecutionDigests,
} from './types.js';
import { bcsCheckpointSummary, bcsCheckpointContents } from './bcs.js';

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
	readonly members: { point: G2Point; votingPower: bigint }[];

	constructor(committee: Committee) {
		this.epoch = committee.epoch;
		this.members = committee.members.map((m) => ({
			point: bls12_381.G2.ProjectivePoint.fromHex(m.publicKey),
			votingPower: m.votingPower,
		}));
	}
}

/**
 * Verify a checkpoint certificate against a prepared committee.
 *
 * Checks that:
 * 1. The signature epoch matches the committee epoch
 * 2. The signing validators have enough voting power (≥6667/10000)
 * 3. The BLS aggregate signature is valid
 *
 * ~10ms per checkpoint with a PreparedCommittee (vs ~150ms without).
 */
export function verifyCheckpoint(
	summary: CheckpointSummary,
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

	// Aggregate pre-parsed G2 points and sum voting power
	let totalPower = 0n;
	let aggregatedPoint: G2Point | null = null;

	for (const idx of signerIndices) {
		if (idx >= prepared.members.length) {
			throw new Error(`Signer index ${idx} exceeds committee size ${prepared.members.length}`);
		}
		const member = prepared.members[idx];
		totalPower += member.votingPower;
		aggregatedPoint = aggregatedPoint ? aggregatedPoint.add(member.point) : member.point;
	}

	if (totalPower < QUORUM_THRESHOLD) {
		throw new Error(
			`Insufficient voting power: ${totalPower} < ${QUORUM_THRESHOLD} (${signerIndices.length}/${prepared.members.length} validators)`,
		);
	}

	// Reconstruct the signed message:
	// BCS(IntentMessage<CheckpointSummary>) || BCS(epoch)
	const summaryBcs = bcsCheckpointSummary.serialize(summary).toBytes();
	const epochBcs = bcs.u64().serialize(authSignature.epoch).toBytes();

	const message = new Uint8Array(
		CHECKPOINT_SUMMARY_INTENT.length + summaryBcs.length + epochBcs.length,
	);
	message.set(CHECKPOINT_SUMMARY_INTENT);
	message.set(summaryBcs, CHECKPOINT_SUMMARY_INTENT.length);
	message.set(epochBcs, CHECKPOINT_SUMMARY_INTENT.length + summaryBcs.length);

	// Hash message to G1 curve and verify BLS signature (min-sig mode)
	const hashedMessage = bls12_381.shortSignatures.hash(message);
	const valid = bls12_381.shortSignatures.verify(
		authSignature.signature,
		hashedMessage,
		aggregatedPoint!.toRawBytes(true), // compressed G2 bytes for verify()
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

function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
