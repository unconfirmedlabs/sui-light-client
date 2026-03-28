/**
 * Convert BCS-deserialized checkpoint data to typed CheckpointSummary.
 *
 * @mysten/bcs returns u64 as strings and byte arrays as number[].
 * This module bridges from the BCS output shape to our typed interfaces.
 */

import { bcsCheckpointSummary } from './bcs.js';
import type { CheckpointSummary, CheckpointCommitment, EndOfEpochData } from './types.js';

/** BCS parse output shape — u64 as string, byte arrays as number[] */
type BcsParsed = ReturnType<typeof bcsCheckpointSummary.parse>;

/** Parse raw BCS bytes into a typed CheckpointSummary. */
export function parseBcsSummary(bcsBytes: Uint8Array): CheckpointSummary {
	const p = bcsCheckpointSummary.parse(bcsBytes);
	return {
		epoch: BigInt(p.epoch),
		sequenceNumber: BigInt(p.sequenceNumber),
		networkTotalTransactions: BigInt(p.networkTotalTransactions),
		contentDigest: Uint8Array.from(p.contentDigest),
		previousDigest: p.previousDigest ? Uint8Array.from(p.previousDigest) : null,
		epochRollingGasCostSummary: {
			computationCost: BigInt(p.epochRollingGasCostSummary.computationCost),
			storageCost: BigInt(p.epochRollingGasCostSummary.storageCost),
			storageRebate: BigInt(p.epochRollingGasCostSummary.storageRebate),
			nonRefundableStorageFee: BigInt(p.epochRollingGasCostSummary.nonRefundableStorageFee),
		},
		timestampMs: BigInt(p.timestampMs),
		checkpointCommitments: p.checkpointCommitments.map(convertCommitment),
		endOfEpochData: p.endOfEpochData ? convertEndOfEpochData(p.endOfEpochData) : null,
		versionSpecificData: Uint8Array.from(p.versionSpecificData),
	};
}

function convertCommitment(c: BcsParsed['checkpointCommitments'][number]): CheckpointCommitment {
	if ('ECMHLiveObjectSetDigest' in c && c.ECMHLiveObjectSetDigest) {
		return { ECMHLiveObjectSetDigest: Uint8Array.from(c.ECMHLiveObjectSetDigest) };
	}
	if ('CheckpointArtifactsDigest' in c && c.CheckpointArtifactsDigest) {
		return { CheckpointArtifactsDigest: Uint8Array.from(c.CheckpointArtifactsDigest) };
	}
	return c as CheckpointCommitment;
}

function convertEndOfEpochData(e: NonNullable<BcsParsed['endOfEpochData']>): EndOfEpochData {
	return {
		nextEpochCommittee: e.nextEpochCommittee.map(([pk, stake]) => [
			Uint8Array.from(pk),
			BigInt(stake),
		]),
		nextEpochProtocolVersion: BigInt(e.nextEpochProtocolVersion),
		epochCommitments: e.epochCommitments.map(convertCommitment),
	};
}
