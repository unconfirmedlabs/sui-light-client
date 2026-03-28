import { test, expect, describe } from 'bun:test';
import { decodeRoaringBitmap } from '../src/bitmap';
import { suiDigest } from '../src/digest';
import { bcsCheckpointSummary } from '../src/bcs';
import { verifyCheckpoint, PreparedCommittee } from '../src/verify';
import type { Committee, CheckpointSummary, AuthorityQuorumSignInfo } from '../src/types';

describe('RoaringBitmap', () => {
	test('decodes array container (cookie 12346)', () => {
		const data = new Uint8Array([
			0x3a, 0x30, 0x00, 0x00, // cookie = 12346 (u32 LE)
			0x01, 0x00, 0x00, 0x00, // containerCount = 1 (u32 LE)
			0x00, 0x00,             // key = 0
			0x03, 0x00,             // cardinality - 1 = 3 (4 items)
			0x10, 0x00, 0x00, 0x00, // offset = 16
			0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, // values
		]);
		expect(decodeRoaringBitmap(data)).toEqual([0, 1, 2, 3]);
	});

	test('decodes run container (cookie 12347)', () => {
		// Cookie 12347 format: [cookie: u16] [count-1: u16] [run bitmap] [headers] [data]
		// 1 container, marked as run in the run bitmap
		const data = new Uint8Array([
			0x3b, 0x30,             // cookie = 12347 (u16 LE)
			0x00, 0x00,             // containerCount - 1 = 0 (1 container)
			0x01,                   // run bitmap: container 0 is a run (bit 0 set)
			0x00, 0x00,             // key = 0
			0x09, 0x00,             // cardinality - 1 = 9 (10 items, but ignored for run containers)
			// Run container data: numRuns=1, then [start=0, length=9] (values 0..9)
			0x01, 0x00,             // numRuns = 1
			0x00, 0x00,             // start = 0
			0x09, 0x00,             // length = 9 (inclusive, so 0..9 = 10 values)
		]);
		expect(decodeRoaringBitmap(data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test('decodes run container with multiple runs', () => {
		const data = new Uint8Array([
			0x3b, 0x30,             // cookie = 12347
			0x00, 0x00,             // 1 container
			0x01,                   // run bitmap: container 0 is run
			0x00, 0x00,             // key = 0
			0x04, 0x00,             // cardinality - 1 = 4
			// 2 runs: [0..2] and [10..11]
			0x02, 0x00,             // numRuns = 2
			0x00, 0x00, 0x02, 0x00, // run 1: start=0, length=2 → 0,1,2
			0x0a, 0x00, 0x01, 0x00, // run 2: start=10, length=1 → 10,11
		]);
		expect(decodeRoaringBitmap(data)).toEqual([0, 1, 2, 10, 11]);
	});
});

describe('Digest', () => {
	test('computes Blake2b-256 with domain separator', () => {
		const a = suiDigest('Test', new Uint8Array([]));
		const b = suiDigest('Test', new Uint8Array([]));
		const c = suiDigest('Other', new Uint8Array([]));
		expect(a.length).toBe(32);
		expect(a).toEqual(b);
		expect(a).not.toEqual(c);
	});
});

describe('BCS', () => {
	test('CheckpointSummary round-trips through BCS', () => {
		const summary = {
			epoch: 100n,
			sequenceNumber: 50000n,
			networkTotalTransactions: 1000000n,
			contentDigest: new Array(32).fill(0),
			previousDigest: new Array(32).fill(1),
			epochRollingGasCostSummary: {
				computationCost: 10n, storageCost: 20n, storageRebate: 5n, nonRefundableStorageFee: 1n,
			},
			timestampMs: 1700000000000n,
			checkpointCommitments: [],
			endOfEpochData: null,
			versionSpecificData: [],
		};
		const bytes = bcsCheckpointSummary.serialize(summary).toBytes();
		expect(bytes.length).toBeGreaterThan(0);
		const decoded = bcsCheckpointSummary.parse(bytes);
		expect(decoded.epoch).toBe('100');
	});
});

describe('Checkpoint verification (testnet)', () => {
	test('verifies a real checkpoint signature', async () => {
		const { SuiGrpcClient } = await import('@mysten/sui/grpc');
		const client = new SuiGrpcClient({ baseUrl: 'https://fullnode.testnet.sui.io' });

		// Fetch checkpoint with summary BCS + validator signature
		const { response } = await client.ledgerService.getCheckpoint({
			checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: '318460000' },
			readMask: { paths: ['*'] },
		});

		const cp = response.checkpoint!;
		const summaryBcs = cp.summary!.bcs!.value!;
		const sig = cp.signature!;

		console.log(`Checkpoint ${cp.sequenceNumber} epoch ${cp.summary!.epoch}`);
		console.log(`Summary BCS: ${summaryBcs.length} bytes`);
		console.log(`Signature: ${sig.signature!.length} bytes, bitmap: ${sig.bitmap!.length} bytes`);

		// Decode bitmap to count signers
		const signerIndices = decodeRoaringBitmap(sig.bitmap!);
		console.log(`Signers: ${signerIndices.length}`);

		// Fetch committee for this epoch via JSON RPC
		const epoch = cp.summary!.epoch!.toString();
		const committeeResp = await fetch('https://fullnode.testnet.sui.io:443', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1,
				method: 'suix_getCommitteeInfo',
				params: [epoch],
			}),
		});
		const committeeJson = (await committeeResp.json()) as any;
		const validators = committeeJson.result.validators as [string, string][];
		console.log(`Committee: ${validators.length} validators`);

		// Build Committee
		const committee: Committee = {
			epoch: BigInt(epoch),
			members: validators.map(([pk, stake]) => ({
				publicKey: new Uint8Array(Buffer.from(pk, 'base64')),
				votingPower: BigInt(stake),
			})),
		};

		// Parse the BCS summary to get our typed CheckpointSummary
		const parsed = bcsCheckpointSummary.parse(summaryBcs);

		const checkpointSummary: CheckpointSummary = {
			epoch: BigInt(parsed.epoch),
			sequenceNumber: BigInt(parsed.sequenceNumber),
			networkTotalTransactions: BigInt(parsed.networkTotalTransactions),
			contentDigest: Uint8Array.from(parsed.contentDigest),
			previousDigest: parsed.previousDigest ? Uint8Array.from(parsed.previousDigest) : null,
			epochRollingGasCostSummary: {
				computationCost: BigInt(parsed.epochRollingGasCostSummary.computationCost),
				storageCost: BigInt(parsed.epochRollingGasCostSummary.storageCost),
				storageRebate: BigInt(parsed.epochRollingGasCostSummary.storageRebate),
				nonRefundableStorageFee: BigInt(parsed.epochRollingGasCostSummary.nonRefundableStorageFee),
			},
			timestampMs: BigInt(parsed.timestampMs),
			checkpointCommitments: parsed.checkpointCommitments,
			endOfEpochData: parsed.endOfEpochData,
			versionSpecificData: Uint8Array.from(parsed.versionSpecificData),
		};

		const authSignature: AuthorityQuorumSignInfo = {
			epoch: BigInt(sig.epoch!),
			signature: sig.signature!,
			signersMap: sig.bitmap!,
		};

		// Verify with raw committee (cold path, ~150ms)
		let t = performance.now();
		verifyCheckpoint(checkpointSummary, authSignature, committee);
		console.log(`✓ Cold verify: ${(performance.now() - t).toFixed(1)}ms`);

		// Verify with PreparedCommittee (warm path, ~10ms)
		t = performance.now();
		const prepared = new PreparedCommittee(committee);
		console.log(`  PreparedCommittee init: ${(performance.now() - t).toFixed(1)}ms (one-time per epoch)`);

		t = performance.now();
		verifyCheckpoint(checkpointSummary, authSignature, prepared);
		console.log(`✓ Prepared verify: ${(performance.now() - t).toFixed(1)}ms`);
	}, 30_000);
});
