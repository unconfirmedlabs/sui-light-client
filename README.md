# Kei

Pure TypeScript Sui light client — verify checkpoint signatures, committee transitions, and transaction inclusion using BLS12-381.

## Why

Sui fullnodes return data, but how do you know it's correct? The light client verifies responses cryptographically by checking that checkpoint summaries are signed by a quorum of validators, then proving that transactions and objects are included in those certified checkpoints.

This is the first TypeScript implementation of Sui's light client verification. No native dependencies — works in browsers, Cloudflare Workers, Bun, and Node.js.

## How it works

Sui validators sign checkpoint summaries using BLS12-381 aggregate signatures. A checkpoint is valid if validators holding ≥66.67% of voting power (6667/10000) have signed it. The light client:

1. **Decodes the signers bitmap** (RoaringBitmap) to identify which validators signed
2. **Aggregates their BLS public keys** (G2 points in min-sig mode)
3. **Verifies the aggregate signature** against the BCS-serialized checkpoint summary
4. **Validates quorum** — total voting power of signers must meet the threshold

Once a checkpoint is verified, any data committed to it (transactions, objects, events) can be trusted via hash chains.

```
Genesis → Committee₀ → verify Checkpoint₀ → Committee₁ → verify Checkpoint₁ → ...
                         ↓
                   ContentDigest → CheckpointContents → TransactionDigest
```

## Performance

| Operation | Time | Notes |
|-----------|------|-------|
| `PreparedCommittee` init | ~118ms | One-time per epoch (~24h), parses all G2 pubkeys |
| Checkpoint verification | **~11ms** | With `PreparedCommittee` |
| Cold verification | ~188ms | Without pre-parsed keys |
| Throughput | **~88 checkpoints/sec** | Single core, prepared committee |

No WASM needed. The bottleneck was G2 point deserialization, not the BLS pairing math — `PreparedCommittee` pre-parses all public keys once per epoch, making per-checkpoint aggregation <1ms (point additions instead of decompression).

## CLI

Try it out against live checkpoints:

```sh
# Set your fullnode endpoint
export GRPC_URL=https://fullnode.testnet.sui.io
export NETWORK=testnet

# Verify a single checkpoint
bun src/cli.ts verify 318460000

# Verify a range (uses PreparedCommittee for bulk speed)
bun src/cli.ts verify-range 318460000 318460009

# Or pass as flags
bun src/cli.ts verify 318460000 --network testnet --url https://fullnode.testnet.sui.io
```

```
$ bun src/cli.ts verify-range 318460000 318460009

Verifying 10 checkpoints (318460000 → 318460009)

Fetching first checkpoint... epoch 1052 (204ms)
Preparing committee... 118 validators, 232ms

  [1/10]  seq=318460000  signers=74  fetch=111ms  verify=78ms
  [2/10]  seq=318460001  signers=73  fetch=95ms   verify=11ms
  [3/10]  seq=318460002  signers=76  fetch=176ms  verify=11ms
  ...
  [10/10] seq=318460009  signers=75  fetch=96ms   verify=10ms

10 checkpoints verified in 1.3s
Avg verify: 17.4ms/checkpoint
Throughput: 7.5 checkpoints/sec (including network)
```

## Usage

```typescript
import {
  verifyCheckpoint,
  PreparedCommittee,
  bcsCheckpointSummary,
} from '@unconfirmed/sui-light-client';

// Build committee from validator data (once per epoch)
const committee = {
  epoch: 1052n,
  members: validators.map(({ publicKey, votingPower }) => ({
    publicKey, // 96-byte BLS12-381 G2 compressed
    votingPower,
  })),
};

// Pre-parse for fast bulk verification
const prepared = new PreparedCommittee(committee);

// Parse checkpoint summary from BCS bytes (e.g., from gRPC summary.bcs.value)
const summary = bcsCheckpointSummary.parse(summaryBcsBytes);

// Verify the checkpoint signature
verifyCheckpoint(summary, authSignature, prepared);
// Throws on invalid signature or insufficient quorum
```

### With Sui gRPC API

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { verifyCheckpoint, PreparedCommittee, bcsCheckpointSummary } from '@unconfirmed/sui-light-client';

const client = new SuiGrpcClient({ baseUrl: 'https://fullnode.testnet.sui.io' });

// Fetch checkpoint with BCS summary + validator signature
const { response } = await client.ledgerService.getCheckpoint({
  checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: '318460000' },
  readMask: { paths: ['summary.bcs', 'signature'] },
});

const cp = response.checkpoint!;
const parsed = bcsCheckpointSummary.parse(cp.summary!.bcs!.value!);

// Build auth signature from gRPC response
const authSignature = {
  epoch: BigInt(cp.signature!.epoch!),
  signature: cp.signature!.signature!,   // 48-byte BLS aggregate sig
  signersMap: cp.signature!.bitmap!,      // RoaringBitmap of signer indices
};

// Verify
verifyCheckpoint(parsed, authSignature, prepared);
```

### Committee transitions

```typescript
import { verifyCommitteeTransition, walkCommitteeChain } from '@unconfirmed/sui-light-client';

// Verify a single epoch transition from an end-of-epoch checkpoint
const nextCommittee = verifyCommitteeTransition(summary, authSignature, currentCommittee);

// Walk a chain of end-of-epoch checkpoints to advance multiple epochs
const latestCommittee = walkCommitteeChain(endOfEpochCheckpoints, trustedCommittee);
```

## Cryptographic details

| Component | Implementation |
|-----------|---------------|
| Signature scheme | BLS12-381 min-sig (G2 pubkeys 96 bytes, G1 sigs 48 bytes) |
| Hash function | Blake2b-256 with struct name domain separators |
| Serialization | BCS (Binary Canonical Serialization) |
| Signers bitmap | RoaringBitmap (standard portable format) |
| Quorum threshold | 6667/10000 (Byzantine 2f+1) |

### Signed message format

```
[0x02, 0x00, 0x00]              Intent: scope=CheckpointSummary, version=V0, app=Sui
|| BCS(CheckpointSummary)       The checkpoint data
|| BCS(epoch: u64)              Appended epoch
```

### Digest computation

All Sui digests follow: `Blake2b-256("StructName::" || BCS(struct))`

## API

### `verifyCheckpoint(summary, authSignature, committee)`

Verify a checkpoint certificate. Throws on failure.

### `PreparedCommittee`

Pre-parses G2 public keys for fast bulk verification. Create once per epoch.

### `verifyCheckpointContents(summary, contents)`

Verify that checkpoint contents match the content digest in the summary.

### `verifyTransactionInCheckpoint(txDigest, contents)`

Prove a transaction exists in checkpoint contents. Returns the execution digests.

### `verifyCommitteeTransition(summary, authSignature, committee)`

Verify an epoch transition and extract the next committee.

### `walkCommitteeChain(checkpoints, trustedCommittee)`

Walk multiple epoch transitions from a trusted starting committee.

### BCS schemas

`bcsCheckpointSummary`, `bcsCheckpointContents`, `bcsAuthorityQuorumSignInfo` — for parsing raw BCS bytes from gRPC responses.

### Utilities

`suiDigest(structName, bcsBytes)`, `decodeRoaringBitmap(data)`, and specific digest helpers (`checkpointDigest`, `transactionDigest`, etc.).

## Dependencies

- [`@noble/curves`](https://github.com/paulmillr/noble-curves) — BLS12-381 (audited, pure JS)
- [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — Blake2b-256 (audited, pure JS)
- [`@mysten/bcs`](https://github.com/MystenLabs/sui/tree/main/sdk/bcs) — BCS serialization

## License

Apache-2.0
