import { getBase58Decoder } from '@solana/codecs-strings';
import {
	type Address,
	address,
	appendTransactionMessageInstruction,
	type Blockhash,
	type Commitment,
	createTransactionMessage,
	createTransactionPlanExecutor,
	getBase64EncodedWireTransaction,
	isSolanaError,
	isTransactionSendingSigner,
	pipe,
	SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
	setTransactionMessageFeePayer,
	setTransactionMessageLifetimeUsingBlockhash,
	signAndSendTransactionMessageWithSigners,
	signature,
	signTransactionMessageWithSigners,
	singleTransactionPlan,
	type TransactionSigner,
	type TransactionVersion,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
	findAssociatedTokenPda,
	getCloseAccountInstruction,
	getCreateAssociatedTokenInstruction,
	getSyncNativeInstruction,
	TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

import { createWalletTransactionSigner, isWalletSession, resolveSignerMode } from '../signers/walletTransactionSigner';
import type { SolanaClientRuntime, WalletSession } from '../types';
import type { SolTransferSendOptions } from './sol';

type BlockhashLifetime = Readonly<{
	blockhash: Blockhash;
	lastValidBlockHeight: bigint;
}>;

type WsolAuthority = TransactionSigner<string> | WalletSession;

type SignableWsolTransactionMessage = Parameters<typeof signTransactionMessageWithSigners>[0];

/** wSOL Native Mint Address: So11111111111111111111111111111111111111112 */
export const WSOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112' as Address;

export type WrapSolConfig = Readonly<{
	amount: bigint;
	authority: WsolAuthority;
	commitment?: Commitment;
	lifetime?: BlockhashLifetime;
	owner?: Address | string;
	transactionVersion?: TransactionVersion;
}>;

export type UnwrapSolConfig = Readonly<{
	authority: WsolAuthority;
	commitment?: Commitment;
	lifetime?: BlockhashLifetime;
	owner?: Address | string;
	transactionVersion?: TransactionVersion;
}>;

type PreparedWrapSol = Readonly<{
	amount: bigint;
	ataAddress: Address;
	commitment?: Commitment;
	lifetime: BlockhashLifetime;
	message: SignableWsolTransactionMessage;
	mode: 'partial' | 'send';
	signer: TransactionSigner;
}>;

type PreparedUnwrapSol = Readonly<{
	ataAddress: Address;
	commitment?: Commitment;
	lifetime: BlockhashLifetime;
	message: SignableWsolTransactionMessage;
	mode: 'partial' | 'send';
	signer: TransactionSigner;
}>;

function ensureAddress(value: Address | string | undefined, fallback?: Address): Address {
	if (value) {
		return typeof value === 'string' ? address(value) : value;
	}
	if (!fallback) {
		throw new Error('An address value was expected but not provided.');
	}
	return fallback;
}

async function resolveLifetime(
	runtime: SolanaClientRuntime,
	commitment?: Commitment,
	fallback?: BlockhashLifetime,
): Promise<BlockhashLifetime> {
	if (fallback) {
		return fallback;
	}
	const { value } = await runtime.rpc.getLatestBlockhash({ commitment }).send();
	return value;
}

function resolveSigner(
	authority: WsolAuthority,
	commitment?: Commitment,
): { mode: 'partial' | 'send'; signer: TransactionSigner } {
	if (isWalletSession(authority)) {
		const { signer, mode } = createWalletTransactionSigner(authority, { commitment });
		return { mode, signer };
	}
	return { mode: resolveSignerMode(authority), signer: authority };
}

export type WsolHelper = Readonly<{
	prepareWrapSol(config: WrapSolConfig): Promise<PreparedWrapSol>;
	prepareUnwrapSol(config: UnwrapSolConfig): Promise<PreparedUnwrapSol>;
	sendPreparedWrapSol(
		prepared: PreparedWrapSol,
		options?: SolTransferSendOptions,
	): Promise<ReturnType<typeof signature>>;
	sendPreparedUnwrapSol(
		prepared: PreparedUnwrapSol,
		options?: SolTransferSendOptions,
	): Promise<ReturnType<typeof signature>>;
	wrapSol(config: WrapSolConfig, options?: SolTransferSendOptions): Promise<ReturnType<typeof signature>>;
	unwrapSol(config: UnwrapSolConfig, options?: SolTransferSendOptions): Promise<ReturnType<typeof signature>>;
}>;

/** Creates helpers for wrapping native SOL into wSOL and unwrapping it back. */
export function createWsolHelper(runtime: SolanaClientRuntime): WsolHelper {
	const mintAddress = address(WSOL_MINT_ADDRESS);
	const tokenProgram = address(TOKEN_PROGRAM_ADDRESS);

	async function prepareWrapSol(config: WrapSolConfig): Promise<PreparedWrapSol> {
		const commitment = config.commitment;
		const lifetime = await resolveLifetime(runtime, commitment, config.lifetime);
		const { signer, mode } = resolveSigner(config.authority, commitment);
		const owner = ensureAddress(config.owner, signer.address);

		const [ataAddress] = await findAssociatedTokenPda({
			mint: mintAddress,
			owner,
			tokenProgram,
		});

		const instructionList: Parameters<typeof appendTransactionMessageInstruction>[0][] = [];

		// Check if ATA exists
		const { value } = await runtime.rpc
			.getAccountInfo(ataAddress, {
				commitment,
				dataSlice: { length: 0, offset: 0 },
				encoding: 'base64',
			})
			.send();

		if (!value) {
			// Create ATA if it doesn't exist
			instructionList.push(
				getCreateAssociatedTokenInstruction({
					ata: ataAddress,
					mint: mintAddress,
					owner,
					payer: signer,
					tokenProgram,
				}),
			);
		}

		// Transfer SOL to the ATA
		instructionList.push(
			getTransferSolInstruction({
				amount: config.amount,
				destination: ataAddress,
				source: signer,
			}),
		);

		// Sync native instruction
		instructionList.push(
			getSyncNativeInstruction({
				account: ataAddress,
			}),
		);

		let message: SignableWsolTransactionMessage = pipe(
			createTransactionMessage({ version: config.transactionVersion ?? 0 }),
			(m) => setTransactionMessageFeePayer(signer.address, m),
			(m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
		);

		for (const instruction of instructionList) {
			message = appendTransactionMessageInstruction(instruction, message);
		}

		return {
			amount: config.amount,
			ataAddress,
			commitment,
			lifetime,
			message,
			mode,
			signer,
		};
	}

	async function prepareUnwrapSol(config: UnwrapSolConfig): Promise<PreparedUnwrapSol> {
		const commitment = config.commitment;
		const lifetime = await resolveLifetime(runtime, commitment, config.lifetime);
		const { signer, mode } = resolveSigner(config.authority, commitment);
		const owner = ensureAddress(config.owner, signer.address);

		const [ataAddress] = await findAssociatedTokenPda({
			mint: mintAddress,
			owner,
			tokenProgram,
		});

		// Close the wSOL account, which unwraps SOL back to the owner
		const instruction = getCloseAccountInstruction({
			account: ataAddress,
			destination: owner,
			owner: signer,
		});

		const message: SignableWsolTransactionMessage = pipe(
			createTransactionMessage({ version: config.transactionVersion ?? 0 }),
			(m) => setTransactionMessageFeePayer(signer.address, m),
			(m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
			(m) => appendTransactionMessageInstruction(instruction, m),
		);

		return {
			ataAddress,
			commitment,
			lifetime,
			message,
			mode,
			signer,
		};
	}

	async function sendPreparedWrapSol(
		prepared: PreparedWrapSol,
		options: SolTransferSendOptions = {},
	): Promise<ReturnType<typeof signature>> {
		if (prepared.mode === 'send' && isTransactionSendingSigner(prepared.signer)) {
			const signatureBytes = await signAndSendTransactionMessageWithSigners(prepared.message, {
				abortSignal: options.abortSignal,
				minContextSlot: options.minContextSlot,
			});
			const base58Decoder = getBase58Decoder();
			return signature(base58Decoder.decode(signatureBytes));
		}

		const commitment = options.commitment ?? prepared.commitment;
		const maxRetries =
			options.maxRetries === undefined
				? undefined
				: typeof options.maxRetries === 'bigint'
					? options.maxRetries
					: BigInt(options.maxRetries);
		let latestSignature: ReturnType<typeof signature> | null = null;
		const executor = createTransactionPlanExecutor({
			async executeTransactionMessage(message, config = {}) {
				const signed = await signTransactionMessageWithSigners(message as SignableWsolTransactionMessage, {
					abortSignal: config.abortSignal ?? options.abortSignal,
					minContextSlot: options.minContextSlot,
				});
				const wire = getBase64EncodedWireTransaction(signed);
				const response = await runtime.rpc
					.sendTransaction(wire, {
						encoding: 'base64',
						maxRetries,
						preflightCommitment: commitment,
						skipPreflight: options.skipPreflight,
					})
					.send({ abortSignal: config.abortSignal ?? options.abortSignal });
				latestSignature = signature(response);
				return { transaction: signed };
			},
		});
		await executor(singleTransactionPlan(prepared.message), { abortSignal: options.abortSignal });
		if (!latestSignature) {
			throw new Error('Failed to resolve transaction signature.');
		}
		return latestSignature;
	}

	async function sendPreparedUnwrapSol(
		prepared: PreparedUnwrapSol,
		options: SolTransferSendOptions = {},
	): Promise<ReturnType<typeof signature>> {
		if (prepared.mode === 'send' && isTransactionSendingSigner(prepared.signer)) {
			const signatureBytes = await signAndSendTransactionMessageWithSigners(prepared.message, {
				abortSignal: options.abortSignal,
				minContextSlot: options.minContextSlot,
			});
			const base58Decoder = getBase58Decoder();
			return signature(base58Decoder.decode(signatureBytes));
		}

		const commitment = options.commitment ?? prepared.commitment;
		const maxRetries =
			options.maxRetries === undefined
				? undefined
				: typeof options.maxRetries === 'bigint'
					? options.maxRetries
					: BigInt(options.maxRetries);
		let latestSignature: ReturnType<typeof signature> | null = null;
		const executor = createTransactionPlanExecutor({
			async executeTransactionMessage(message, config = {}) {
				const signed = await signTransactionMessageWithSigners(message as SignableWsolTransactionMessage, {
					abortSignal: config.abortSignal ?? options.abortSignal,
					minContextSlot: options.minContextSlot,
				});
				const wire = getBase64EncodedWireTransaction(signed);
				const response = await runtime.rpc
					.sendTransaction(wire, {
						encoding: 'base64',
						maxRetries,
						preflightCommitment: commitment,
						skipPreflight: options.skipPreflight,
					})
					.send({ abortSignal: config.abortSignal ?? options.abortSignal });
				latestSignature = signature(response);
				return { transaction: signed };
			},
		});
		await executor(singleTransactionPlan(prepared.message), { abortSignal: options.abortSignal });
		if (!latestSignature) {
			throw new Error('Failed to resolve transaction signature.');
		}
		return latestSignature;
	}

	async function wrapSol(
		config: WrapSolConfig,
		options?: SolTransferSendOptions,
	): Promise<ReturnType<typeof signature>> {
		const prepared = await prepareWrapSol(config);
		try {
			return await sendPreparedWrapSol(prepared, options);
		} catch (error) {
			if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) {
				const retriedPrepared = await prepareWrapSol({ ...config, lifetime: undefined });
				return await sendPreparedWrapSol(retriedPrepared, options);
			}
			throw error;
		}
	}

	async function unwrapSol(
		config: UnwrapSolConfig,
		options?: SolTransferSendOptions,
	): Promise<ReturnType<typeof signature>> {
		const prepared = await prepareUnwrapSol(config);
		try {
			return await sendPreparedUnwrapSol(prepared, options);
		} catch (error) {
			if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) {
				const retriedPrepared = await prepareUnwrapSol({ ...config, lifetime: undefined });
				return await sendPreparedUnwrapSol(retriedPrepared, options);
			}
			throw error;
		}
	}

	return {
		prepareUnwrapSol,
		prepareWrapSol,
		sendPreparedUnwrapSol,
		sendPreparedWrapSol,
		unwrapSol,
		wrapSol,
	};
}
