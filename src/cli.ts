#!/usr/bin/env bun
/**
 * CLI for testing Sui light client verification against live checkpoints.
 *
 * Usage:
 *   bun src/cli.ts verify <checkpoint_seq> [--url <fullnode_url>]
 *   bun src/cli.ts verify-range <from> <to> [--url <fullnode_url>]
 */

import { bcsCheckpointSummary } from './bcs.js';
import { decodeRoaringBitmap } from './bitmap.js';
import { verifyCheckpoint, PreparedCommittee } from './verify.js';
import { parseBcsSummary } from './parse.js';
import type { Committee, AuthorityQuorumSignInfo } from './types.js';

type Network = 'testnet' | 'mainnet';

function usage(): never {
	console.log(`Usage:
  sui-light-client verify <checkpoint_seq> --network <testnet|mainnet> --url <grpc_url>
  sui-light-client verify-range <from> <to> --network <testnet|mainnet> --url <grpc_url>

Environment variables (override flags):
  GRPC_URL    — fullnode gRPC endpoint
  NETWORK     — testnet or mainnet

Examples:
  bun src/cli.ts verify 318460000 --network testnet --url https://fullnode.testnet.sui.io
  GRPC_URL=https://fullnode.testnet.sui.io NETWORK=testnet bun src/cli.ts verify 318460000`);
	process.exit(1);
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx !== -1 ? args[idx + 1] : undefined;
}

function parseArgs() {
	const args = process.argv.slice(2);
	if (args.length === 0) usage();

	const command = args[0];
	const network = (process.env.NETWORK || getFlag(args, '--network')) as Network | undefined;
	const url = process.env.GRPC_URL || getFlag(args, '--url');

	if (!network || !url) {
		console.error('Error: --network and --url are required (or set NETWORK and GRPC_URL env vars)\n');
		usage();
	}

	if (command === 'verify') {
		const seq = args[1];
		if (!seq || isNaN(Number(seq))) usage();
		return { command: 'verify' as const, seq: Number(seq), network, url };
	}

	if (command === 'verify-range') {
		const from = args[1];
		const to = args[2];
		if (!from || !to || isNaN(Number(from)) || isNaN(Number(to))) usage();
		return { command: 'verify-range' as const, from: Number(from), to: Number(to), network, url };
	}

	usage();
}

interface GrpcCheckpoint {
	summary: { bcs: { value: Uint8Array } };
	signature: { epoch: bigint; signature: Uint8Array; bitmap: Uint8Array };
}

let _grpcClient: InstanceType<typeof import('@mysten/sui/grpc').SuiGrpcClient> | null = null;
async function getGrpcClient(network: Network, url: string) {
	if (_grpcClient) return _grpcClient;
	const { SuiGrpcClient } = await import('@mysten/sui/grpc');
	_grpcClient = new SuiGrpcClient({ network, baseUrl: url });
	return _grpcClient;
}

async function fetchCheckpoint(network: Network, url: string, seq: number): Promise<GrpcCheckpoint> {
	const client = await getGrpcClient(network, url);
	const { response } = await client.ledgerService.getCheckpoint({
		checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: BigInt(seq) },
		readMask: { paths: ['summary.bcs', 'signature'] },
	});
	return response.checkpoint as unknown as GrpcCheckpoint;
}

async function fetchCommittee(url: string, epoch: string): Promise<Committee> {
	const resp = await fetch(`${url}:443`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 1,
			method: 'suix_getCommitteeInfo',
			params: [epoch],
		}),
	});
	const json = (await resp.json()) as { result: { validators: [string, string][] } };
	return {
		epoch: BigInt(epoch),
		members: json.result.validators.map(([pk, stake]) => ({
			publicKey: new Uint8Array(Buffer.from(pk, 'base64')),
			votingPower: BigInt(stake),
		})),
	};
}

function parseCheckpointData(cp: GrpcCheckpoint) {
	const summary = parseBcsSummary(cp.summary.bcs.value);
	const authSignature: AuthorityQuorumSignInfo = {
		epoch: cp.signature.epoch,
		signature: cp.signature.signature,
		signersMap: cp.signature.bitmap,
	};
	return { summary, authSignature };
}

async function verifySingle(seq: number, network: Network, url: string) {
	const total = performance.now();

	process.stdout.write(`Fetching checkpoint ${seq}...`);
	let t = performance.now();
	const cp = await fetchCheckpoint(network, url, seq);
	console.log(` ${(performance.now() - t).toFixed(0)}ms`);

	const { summary, authSignature } = parseCheckpointData(cp);
	const signers = decodeRoaringBitmap(authSignature.signersMap);

	process.stdout.write(`Fetching committee for epoch ${summary.epoch}...`);
	t = performance.now();
	const committee = await fetchCommittee(url, summary.epoch.toString());
	console.log(` ${(performance.now() - t).toFixed(0)}ms (${committee.members.length} validators)`);

	process.stdout.write(`Verifying signature (${signers.length} signers)...`);
	t = performance.now();
	verifyCheckpoint(summary, authSignature, committee);
	console.log(` ${(performance.now() - t).toFixed(0)}ms`);

	console.log(`\nCheckpoint ${seq} verified in ${(performance.now() - total).toFixed(0)}ms`);
}

async function verifyRange(from: number, to: number, network: Network, url: string) {
	const count = to - from + 1;
	console.log(`Verifying ${count} checkpoints (${from} → ${to})\n`);

	process.stdout.write('Fetching first checkpoint...');
	let t = performance.now();
	const firstCp = await fetchCheckpoint(network, url, from);
	const { summary: firstSummary } = parseCheckpointData(firstCp);
	console.log(` epoch ${firstSummary.epoch} (${(performance.now() - t).toFixed(0)}ms)`);

	process.stdout.write('Preparing committee...');
	t = performance.now();
	const committee = await fetchCommittee(url, firstSummary.epoch.toString());
	const prepared = new PreparedCommittee(committee);
	console.log(` ${committee.members.length} validators, ${(performance.now() - t).toFixed(0)}ms\n`);

	let verified = 0;
	let totalVerifyMs = 0;
	const batchStart = performance.now();

	for (let seq = from; seq <= to; seq++) {
		t = performance.now();
		const cp = await fetchCheckpoint(network, url, seq);
		const fetchMs = performance.now() - t;

		const { summary, authSignature } = parseCheckpointData(cp);
		const signers = decodeRoaringBitmap(authSignature.signersMap);

		t = performance.now();
		verifyCheckpoint(summary, authSignature, prepared);
		const verifyMs = performance.now() - t;
		totalVerifyMs += verifyMs;
		verified++;

		console.log(`  [${verified}/${count}] seq=${seq} signers=${signers.length} fetch=${fetchMs.toFixed(0)}ms verify=${verifyMs.toFixed(0)}ms`);
	}

	const elapsed = performance.now() - batchStart;
	console.log(`\n${verified} checkpoints verified in ${(elapsed / 1000).toFixed(1)}s`);
	console.log(`Avg verify: ${(totalVerifyMs / verified).toFixed(1)}ms/checkpoint`);
	console.log(`Throughput: ${(verified / (elapsed / 1000)).toFixed(1)} checkpoints/sec (including network)`);
}

async function main() {
	const parsed = parseArgs();
	if (parsed.command === 'verify') {
		await verifySingle(parsed.seq, parsed.network, parsed.url);
	} else {
		await verifyRange(parsed.from, parsed.to, parsed.network, parsed.url);
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
