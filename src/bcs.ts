/**
 * BCS schemas for Sui checkpoint types.
 * Field order matches the Rust struct declarations exactly.
 */

import { bcs } from '@mysten/bcs';

// --- Primitives ---
// Sui's Digest([u8; 32]) serializes with a ULEB128 length prefix in BCS
const Digest = bcs.vector(bcs.u8());

// AuthorityPublicKeyBytes = [u8; 96] (BLS12-381 G2 compressed, ULEB-prefixed)
const AuthorityPublicKeyBytes = bcs.vector(bcs.u8());

// --- GasCostSummary ---

const GasCostSummary = bcs.struct('GasCostSummary', {
	computationCost: bcs.u64(),
	storageCost: bcs.u64(),
	storageRebate: bcs.u64(),
	nonRefundableStorageFee: bcs.u64(),
});

// --- CheckpointCommitment ---

const CheckpointCommitment = bcs.enum('CheckpointCommitment', {
	ECMHLiveObjectSetDigest: Digest,
	CheckpointArtifactsDigest: Digest,
});

// --- EndOfEpochData ---

const EndOfEpochData = bcs.struct('EndOfEpochData', {
	nextEpochCommittee: bcs.vector(bcs.tuple([AuthorityPublicKeyBytes, bcs.u64()])),
	nextEpochProtocolVersion: bcs.u64(),
	epochCommitments: bcs.vector(CheckpointCommitment),
});

// --- CheckpointSummary ---

export const bcsCheckpointSummary = bcs.struct('CheckpointSummary', {
	epoch: bcs.u64(),
	sequenceNumber: bcs.u64(),
	networkTotalTransactions: bcs.u64(),
	contentDigest: Digest,
	previousDigest: bcs.option(Digest),
	epochRollingGasCostSummary: GasCostSummary,
	timestampMs: bcs.u64(),
	checkpointCommitments: bcs.vector(CheckpointCommitment),
	endOfEpochData: bcs.option(EndOfEpochData),
	versionSpecificData: bcs.vector(bcs.u8()),
});

// --- ExecutionDigests ---

const ExecutionDigests = bcs.struct('ExecutionDigests', {
	transaction: Digest,
	effects: Digest,
});

// --- CheckpointContents ---

const CheckpointContentsV1 = bcs.struct('CheckpointContentsV1', {
	transactions: bcs.vector(ExecutionDigests),
	userSignatures: bcs.vector(bcs.vector(bcs.vector(bcs.u8()))),
});

// V2 nests execution digests + signatures per-transaction,
// adding Option<SequenceNumber> per signature for address alias versioning.
const CheckpointTransactionContents = bcs.struct('CheckpointTransactionContents', {
	digest: ExecutionDigests,
	userSignatures: bcs.vector(bcs.tuple([
		bcs.vector(bcs.u8()),   // GenericSignature
		bcs.option(bcs.u64()),  // Option<SequenceNumber> (address alias version)
	])),
});

const CheckpointContentsV2 = bcs.struct('CheckpointContentsV2', {
	transactions: bcs.vector(CheckpointTransactionContents),
});

export const bcsCheckpointContents = bcs.enum('CheckpointContents', {
	V1: CheckpointContentsV1,
	V2: CheckpointContentsV2,
});

// --- AuthorityQuorumSignInfo ---

export const bcsAuthorityQuorumSignInfo = bcs.struct('AuthorityQuorumSignInfo', {
	epoch: bcs.u64(),
	signature: bcs.vector(bcs.u8()),
	signersMap: bcs.vector(bcs.u8()),
});

// ============================================================
// Transaction Effects BCS schemas
// Mirrors: crates/sui-types/src/effects/ and execution_status.rs
// ============================================================

// 32-byte address / object ID (fixed-length, no ULEB prefix)
const Address = bcs.bytes(32);

const SuiObjectRef = bcs.struct('SuiObjectRef', {
	objectId: Address,
	version: bcs.u64(),
	digest: Digest,
});

const Owner = bcs.enum('Owner', {
	AddressOwner: Address,
	ObjectOwner: Address,
	Shared: bcs.struct('Shared', { initialSharedVersion: bcs.u64() }),
	Immutable: null,
	ConsensusAddressOwner: bcs.struct('ConsensusAddressOwner', {
		startVersion: bcs.u64(),
		owner: Address,
	}),
});

// StructTag / TypeTag (mutually recursive via lazy)
const StructTag = bcs.struct('StructTag', {
	address: Address,
	module: bcs.string(),
	name: bcs.string(),
	typeParams: bcs.lazy(() => bcs.vector(TypeTag)),
});

const TypeTag: ReturnType<typeof bcs.enum> = bcs.enum('TypeTag', {
	bool: null,
	u8: null,
	u64: null,
	u128: null,
	address: null,
	signer: null,
	vector: bcs.lazy(() => TypeTag),
	struct: StructTag,
	u16: null,
	u32: null,
	u256: null,
});

// --- ExecutionFailureStatus (many variants) ---

const PackageUpgradeError = bcs.enum('PackageUpgradeError', {
	UnableToFetchPackage: bcs.struct('UnableToFetchPackage', { packageId: Address }),
	NotAPackage: bcs.struct('NotAPackage', { objectId: Address }),
	IncompatibleUpgrade: null,
	DigestDoesNotMatch: bcs.struct('DigestDoesNotMatch', { digest: bcs.vector(bcs.u8()) }),
	UnknownUpgradePolicy: bcs.struct('UnknownUpgradePolicy', { policy: bcs.u8() }),
	PackageIDDoesNotMatch: bcs.struct('PackageIDDoesNotMatch', {
		packageId: Address,
		ticketId: Address,
	}),
});

const ModuleId = bcs.struct('ModuleId', {
	address: Address,
	name: bcs.string(),
});

const MoveLocation = bcs.struct('MoveLocation', {
	module: ModuleId,
	function: bcs.u16(),
	instruction: bcs.u16(),
	functionName: bcs.option(bcs.string()),
});

const CommandArgumentError = bcs.enum('CommandArgumentError', {
	TypeMismatch: null,
	InvalidBCSBytes: null,
	InvalidUsageOfPureArg: null,
	InvalidArgumentToPrivateEntryFunction: null,
	IndexOutOfBounds: bcs.struct('IndexOutOfBounds', { idx: bcs.u16() }),
	SecondaryIndexOutOfBounds: bcs.struct('SecondaryIndexOutOfBounds', {
		resultIdx: bcs.u16(),
		secondaryIdx: bcs.u16(),
	}),
	InvalidResultArity: bcs.struct('InvalidResultArity', { resultIdx: bcs.u16() }),
	InvalidGasCoinUsage: null,
	InvalidValueUsage: null,
	InvalidObjectByValue: null,
	InvalidObjectByMutRef: null,
	SharedObjectOperationNotAllowed: null,
	InvalidArgumentArity: null,
	InvalidTransferObject: null,
	InvalidMakeMoveVecNonObjectArgument: null,
	ArgumentWithoutValue: null,
	CannotMoveBorrowedValue: null,
	CannotWriteToExtendedReference: null,
	InvalidReferenceArgument: null,
});

const TypeArgumentError = bcs.enum('TypeArgumentError', {
	TypeNotFound: null,
	ConstraintNotSatisfied: null,
});

const ExecutionFailureStatus = bcs.enum('ExecutionFailureStatus', {
	InsufficientGas: null,
	InvalidGasObject: null,
	InvariantViolation: null,
	FeatureNotYetSupported: null,
	MoveObjectTooBig: bcs.struct('MoveObjectTooBig', {
		objectSize: bcs.u64(),
		maxObjectSize: bcs.u64(),
	}),
	MovePackageTooBig: bcs.struct('MovePackageTooBig', {
		objectSize: bcs.u64(),
		maxObjectSize: bcs.u64(),
	}),
	CircularObjectOwnership: bcs.struct('CircularObjectOwnership', { object: Address }),
	InsufficientCoinBalance: null,
	CoinBalanceOverflow: null,
	PublishErrorNonZeroAddress: null,
	SuiMoveVerificationError: null,
	MovePrimitiveRuntimeError: bcs.option(MoveLocation),
	MoveAbort: bcs.tuple([MoveLocation, bcs.u64()]),
	VMVerificationOrDeserializationError: null,
	VMInvariantViolation: null,
	FunctionNotFound: null,
	ArityMismatch: null,
	TypeArityMismatch: null,
	NonEntryFunctionInvoked: null,
	CommandArgumentError: bcs.struct('CommandArgumentError_', {
		argIdx: bcs.u16(),
		kind: CommandArgumentError,
	}),
	TypeArgumentError: bcs.struct('TypeArgumentError_', {
		argumentIdx: bcs.u16(),
		kind: TypeArgumentError,
	}),
	UnusedValueWithoutDrop: bcs.struct('UnusedValueWithoutDrop', {
		resultIdx: bcs.u16(),
		secondaryIdx: bcs.u16(),
	}),
	InvalidPublicFunctionReturnType: bcs.struct('InvalidPublicFunctionReturnType', {
		idx: bcs.u16(),
	}),
	InvalidTransferObject: null,
	EffectsTooLarge: bcs.struct('EffectsTooLarge', {
		currentSize: bcs.u64(),
		maxSize: bcs.u64(),
	}),
	PublishUpgradeMissingDependency: null,
	PublishUpgradeDependencyDowngrade: null,
	PackageUpgradeError: bcs.struct('PackageUpgradeError_', {
		upgradeError: PackageUpgradeError,
	}),
	WrittenObjectsTooLarge: bcs.struct('WrittenObjectsTooLarge', {
		currentSize: bcs.u64(),
		maxSize: bcs.u64(),
	}),
	CertificateDenied: null,
	SuiMoveVerificationTimedout: null,
	SharedObjectOperationNotAllowed: null,
	InputObjectDeleted: null,
	ExecutionCancelledDueToSharedObjectCongestion: bcs.struct(
		'ExecutionCancelledDueToSharedObjectCongestion',
		{ congested_objects: bcs.vector(Address) },
	),
	AddressDeniedForCoin: bcs.struct('AddressDeniedForCoin', {
		address: Address,
		coinType: bcs.string(),
	}),
	CoinTypeGlobalPause: bcs.struct('CoinTypeGlobalPause', { coinType: bcs.string() }),
	ExecutionCancelledDueToRandomnessUnavailable: null,
	MoveVectorElemTooBig: bcs.struct('MoveVectorElemTooBig', {
		valueSize: bcs.u64(),
		maxScaledSize: bcs.u64(),
	}),
	MoveRawValueTooBig: bcs.struct('MoveRawValueTooBig', {
		valueSize: bcs.u64(),
		maxScaledSize: bcs.u64(),
	}),
	InvalidLinkage: null,
	InsufficientBalanceForWithdraw: null,
	NonExclusiveWriteInputObjectModified: bcs.struct('NonExclusiveWriteInputObjectModified', {
		id: Address,
	}),
});

const ExecutionStatus = bcs.enum('ExecutionStatus', {
	Success: null,
	Failure: bcs.struct('Failure', {
		error: ExecutionFailureStatus,
		command: bcs.option(bcs.u64()),
	}),
});

// --- TransactionEffectsV1 ---

const TransactionEffectsV1 = bcs.struct('TransactionEffectsV1', {
	status: ExecutionStatus,
	executedEpoch: bcs.u64(),
	gasUsed: GasCostSummary,
	modifiedAtVersions: bcs.vector(bcs.tuple([Address, bcs.u64()])),
	sharedObjects: bcs.vector(SuiObjectRef),
	transactionDigest: Digest,
	created: bcs.vector(bcs.tuple([SuiObjectRef, Owner])),
	mutated: bcs.vector(bcs.tuple([SuiObjectRef, Owner])),
	unwrapped: bcs.vector(bcs.tuple([SuiObjectRef, Owner])),
	deleted: bcs.vector(SuiObjectRef),
	unwrappedThenDeleted: bcs.vector(SuiObjectRef),
	wrapped: bcs.vector(SuiObjectRef),
	gasObject: bcs.tuple([SuiObjectRef, Owner]),
	eventsDigest: bcs.option(Digest),
	dependencies: bcs.vector(Digest),
});

// --- TransactionEffectsV2 ---

const VersionDigest = bcs.tuple([bcs.u64(), Digest]);

const ObjectIn = bcs.enum('ObjectIn', {
	NotExist: null,
	Exist: bcs.tuple([VersionDigest, Owner]),
});

const AccumulatorAddress = bcs.struct('AccumulatorAddress', {
	address: Address,
	ty: TypeTag,
});

const AccumulatorOperation = bcs.enum('AccumulatorOperation', {
	Merge: null,
	Split: null,
});

const AccumulatorValue = bcs.enum('AccumulatorValue', {
	Integer: bcs.u64(),
	IntegerTuple: bcs.tuple([bcs.u64(), bcs.u64()]),
	EventDigest: bcs.vector(bcs.tuple([bcs.u64(), Digest])),
});

const AccumulatorWriteV1 = bcs.struct('AccumulatorWriteV1', {
	address: AccumulatorAddress,
	operation: AccumulatorOperation,
	value: AccumulatorValue,
});

const ObjectOut = bcs.enum('ObjectOut', {
	NotExist: null,
	ObjectWrite: bcs.tuple([Digest, Owner]),
	PackageWrite: VersionDigest,
	AccumulatorWriteV1: AccumulatorWriteV1,
});

const IDOperation = bcs.enum('IDOperation', {
	None: null,
	Created: null,
	Deleted: null,
});

const EffectsObjectChange = bcs.struct('EffectsObjectChange', {
	inputState: ObjectIn,
	outputState: ObjectOut,
	idOperation: IDOperation,
});

const UnchangedConsensusKind = bcs.enum('UnchangedConsensusKind', {
	ReadOnlyRoot: VersionDigest,
	MutateConsensusStreamEnded: bcs.u64(),
	ReadConsensusStreamEnded: bcs.u64(),
	Cancelled: bcs.u64(),
	PerEpochConfig: null,
});

const TransactionEffectsV2 = bcs.struct('TransactionEffectsV2', {
	status: ExecutionStatus,
	executedEpoch: bcs.u64(),
	gasUsed: GasCostSummary,
	transactionDigest: Digest,
	gasObjectIndex: bcs.option(bcs.u32()),
	eventsDigest: bcs.option(Digest),
	dependencies: bcs.vector(Digest),
	lamportVersion: bcs.u64(),
	changedObjects: bcs.vector(bcs.tuple([Address, EffectsObjectChange])),
	unchangedConsensusObjects: bcs.vector(bcs.tuple([Address, UnchangedConsensusKind])),
	auxDataDigest: bcs.option(Digest),
});

// --- TransactionEffects (V1 | V2) ---

export const bcsTransactionEffects = bcs.enum('TransactionEffects', {
	V1: TransactionEffectsV1,
	V2: TransactionEffectsV2,
});
