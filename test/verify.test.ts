import { test, expect, describe } from 'bun:test';
import { decodeRoaringBitmap } from '../src/bitmap';
import { suiDigest, checkpointContentsDigest, transactionEventsDigest } from '../src/digest';
import { verifyCheckpoint, verifyTransactionInCheckpoint, verifyTransactionEffects, verifyTransactionEvents, verifyObjectInEffects, PreparedCommittee, digestsEqual } from '../src/verify';
import { bcsCheckpointContents, bcsTransactionEffects } from '../src/bcs';
import { parseBcsSummary } from '../src/parse';
import type { Committee, AuthorityQuorumSignInfo } from '../src/types';

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
	test('CheckpointSummary round-trips through BCS', async () => {
		const { bcsCheckpointSummary } = await import('../src/bcs');
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

// Helper: fetch committee for a given epoch from testnet JSON-RPC
async function fetchTestnetCommittee(epoch: string): Promise<Committee> {
	const resp = await fetch('https://fullnode.testnet.sui.io:443', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 1,
			method: 'suix_getCommitteeInfo',
			params: [epoch],
		}),
	});
	const json = (await resp.json()) as any;
	const validators = json.result.validators as [string, string][];
	return {
		epoch: BigInt(epoch),
		members: validators.map(([pk, stake]) => ({
			publicKey: new Uint8Array(Buffer.from(pk, 'base64')),
			weight: BigInt(stake),
		})),
	};
}

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

		// Fetch committee for this epoch
		const epoch = sig.epoch!.toString();
		const committee = await fetchTestnetCommittee(epoch);
		console.log(`Committee: ${committee.members.length} validators`);

		const authSignature: AuthorityQuorumSignInfo = {
			epoch: BigInt(sig.epoch!),
			signature: sig.signature!,
			signersMap: sig.bitmap!,
		};

		// Verify with raw BCS bytes + raw committee (cold path)
		let t = performance.now();
		verifyCheckpoint(summaryBcs, authSignature, committee);
		console.log(`✓ Cold verify: ${(performance.now() - t).toFixed(1)}ms`);

		// Verify with PreparedCommittee (warm path, ~10ms)
		t = performance.now();
		const prepared = new PreparedCommittee(committee);
		console.log(`  PreparedCommittee init: ${(performance.now() - t).toFixed(1)}ms (one-time per epoch)`);

		t = performance.now();
		verifyCheckpoint(summaryBcs, authSignature, prepared);
		console.log(`✓ Prepared verify: ${(performance.now() - t).toFixed(1)}ms`);
	}, 30_000);
});

describe('Transaction verification (testnet)', () => {
	test('verifies transaction effects and events against checkpoint', async () => {
		const { SuiGrpcClient } = await import('@mysten/sui/grpc');
		const client = new SuiGrpcClient({ baseUrl: 'https://fullnode.testnet.sui.io' });

		// Use checkpoint 318460100 — has transactions with events
		const { response } = await client.ledgerService.getCheckpoint({
			checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: '318460100' },
			readMask: { paths: ['*'] },
		});

		const cp = response.checkpoint!;
		const summaryBcs = cp.summary!.bcs!.value!;
		const sig = cp.signature!;
		const contentsBcs = cp.contents!.bcs!.value!;

		// 1. Verify checkpoint signature
		const epoch = sig.epoch!.toString();
		const committee = await fetchTestnetCommittee(epoch);
		const prepared = new PreparedCommittee(committee);
		const authSignature: AuthorityQuorumSignInfo = {
			epoch: BigInt(sig.epoch!),
			signature: sig.signature!,
			signersMap: sig.bitmap!,
		};
		verifyCheckpoint(summaryBcs, authSignature, prepared);
		console.log('✓ Checkpoint signature verified');

		// 2. Verify checkpoint contents digest
		const summary = parseBcsSummary(summaryBcs);
		const computedContentDigest = checkpointContentsDigest(contentsBcs);
		expect(digestsEqual(computedContentDigest, summary.contentDigest)).toBe(true);
		console.log('✓ Checkpoint contents digest verified');

		// 3. Parse contents and extract execution digests (handles V1 and V2)
		const parsedContents = bcsCheckpointContents.parse(contentsBcs);
		let execDigestsList: { transaction: Uint8Array; effects: Uint8Array }[];

		if ('V1' in parsedContents) {
			execDigestsList = parsedContents.V1.transactions.map((t: any) => ({
				transaction: Uint8Array.from(t.transaction),
				effects: Uint8Array.from(t.effects),
			}));
		} else {
			execDigestsList = (parsedContents as any).V2.transactions.map((t: any) => ({
				transaction: Uint8Array.from(t.digest.transaction),
				effects: Uint8Array.from(t.digest.effects),
			}));
		}
		console.log(`  ${execDigestsList.length} transactions in checkpoint`);
		expect(execDigestsList.length).toBeGreaterThan(0);

		// 4. Find a transaction WITH events (tx[1] in this checkpoint)
		// Verify effects for all transactions, track which has events
		let txWithEventsIdx = -1;
		for (let i = 0; i < execDigestsList.length; i++) {
			const txDigestStr = cp.contents!.transactions[i].transaction!;
			const { response: txResp } = await client.ledgerService.getTransaction({
				digest: txDigestStr,
				readMask: { paths: ['effects.bcs'] },
			});
			const effectsBcs = txResp.transaction!.effects!.bcs!.value!;
			const evDigest = verifyTransactionEffects(effectsBcs, execDigestsList[i].effects);
			if (evDigest && txWithEventsIdx === -1) {
				txWithEventsIdx = i;
			}
		}
		console.log(`✓ All ${execDigestsList.length} transaction effects verified`);
		expect(txWithEventsIdx).toBeGreaterThanOrEqual(0);

		// 5. Full chain: verify transaction effects + events for the tx with events
		const evTxDigestStr = cp.contents!.transactions[txWithEventsIdx].transaction!;
		const { response: evTxResp } = await client.ledgerService.getTransaction({
			digest: evTxDigestStr,
			readMask: { paths: ['effects.bcs', 'events.bcs'] },
		});

		const effectsBcs = evTxResp.transaction!.effects!.bcs!.value!;
		const eventsDigest = verifyTransactionEffects(effectsBcs, execDigestsList[txWithEventsIdx].effects);
		expect(eventsDigest).not.toBeNull();
		console.log(`✓ Effects verified for tx[${txWithEventsIdx}] (has events)`);

		// Verify events
		const eventsBcs = evTxResp.transaction!.events!.bcs!.value!;
		console.log(`  Events BCS: ${eventsBcs.length} bytes`);
		verifyTransactionEvents(eventsBcs, eventsDigest!);
		console.log('✓ Transaction events verified');

		// 6. Verify objects in effects
		const parsedEffects = bcsTransactionEffects.parse(effectsBcs);
		const changedObjects = 'V2' in parsedEffects
			? (parsedEffects as any).V2.changedObjects.map(([addr]: [Uint8Array, any]) => addr)
			: [...(parsedEffects as any).V1.created, ...(parsedEffects as any).V1.mutated]
				.map(([ref]: [any, any]) => ref.objectId);

		expect(changedObjects.length).toBeGreaterThan(0);

		// Verify each changed object can be found in effects
		for (const objId of changedObjects) {
			const digest = verifyObjectInEffects(objId, effectsBcs);
			// digest is non-null for written objects, null for deleted
		}
		console.log(`✓ ${changedObjects.length} objects verified in effects`);

		// Verify that a random object ID throws
		const fakeId = new Uint8Array(32).fill(0xff);
		expect(() => verifyObjectInEffects(fakeId, effectsBcs)).toThrow('Object not found');
		console.log('✓ Unknown object correctly rejected');
	}, 60_000);
});
