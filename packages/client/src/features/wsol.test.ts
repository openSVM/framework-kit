import type { TransactionSigner } from '@solana/kit';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletSession } from '../types';

type MutableMessage = {
	instructions: unknown[];
	feePayer?: unknown;
	lifetime?: unknown;
};

const addressMock = vi.hoisted(() => vi.fn((value: string) => `addr:${value}`));
const appendTransactionMessageInstructionMock = vi.hoisted(() =>
	vi.fn((instruction: unknown, message: MutableMessage) => {
		message.instructions.push(instruction);
		return message;
	}),
);
const createTransactionMessageMock = vi.hoisted(() =>
	vi.fn(() => ({ instructions: [] as unknown[], steps: [] as unknown[] })),
);
const setTransactionMessageFeePayerMock = vi.hoisted(() =>
	vi.fn((payer: unknown, message: MutableMessage) => {
		message.feePayer = payer;
		return message;
	}),
);
const setTransactionMessageLifetimeUsingBlockhashMock = vi.hoisted(() =>
	vi.fn((lifetime: unknown, message: MutableMessage) => {
		message.lifetime = lifetime;
		return message;
	}),
);
const signTransactionMessageWithSignersMock = vi.hoisted(() => vi.fn(async () => ({ signed: true })));
const signAndSendTransactionMessageWithSignersMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2, 3])));
const getBase64EncodedWireTransactionMock = vi.hoisted(() => vi.fn(() => 'wire-data'));
const signatureMock = vi.hoisted(() => vi.fn((value: unknown) => `signature:${String(value)}`));
const pipeMock = vi.hoisted(() =>
	vi.fn((initial: unknown, ...fns: Array<(value: unknown) => unknown>) => fns.reduce((acc, fn) => fn(acc), initial)),
);
const isTransactionSendingSignerMock = vi.hoisted(() =>
	vi.fn((signer: { sendTransactions?: unknown }) => Boolean(signer?.sendTransactions)),
);
const isWalletSessionMock = vi.hoisted(() =>
	vi.fn((value: unknown) => Boolean((value as WalletSession | undefined)?.session)),
);
const createWalletTransactionSignerMock = vi.hoisted(() =>
	vi.fn((session: { account: { address: unknown } }) => ({
		mode: 'partial' as const,
		signer: { address: session.account.address } as TransactionSigner,
	})),
);
const resolveSignerModeMock = vi.hoisted(() => vi.fn(() => 'partial'));
const getBase58DecoderMock = vi.hoisted(() => vi.fn(() => ({ decode: () => 'decoded-signature' })));
const createTransactionPlanExecutorMock = vi.hoisted(() =>
	vi.fn((config: { executeTransactionMessage: (message: MutableMessage) => Promise<void> }) =>
		vi.fn(async (plan: { message: MutableMessage }) => {
			await config.executeTransactionMessage(plan.message);
			return { kind: 'single', message: plan.message };
		}),
	),
);
const singleTransactionPlanMock = vi.hoisted(() => vi.fn((message: MutableMessage) => ({ kind: 'single', message })));
const findAssociatedTokenPdaMock = vi.hoisted(() => vi.fn(async () => ['ata-address', 'bump']));
const getCreateAssociatedTokenInstructionMock = vi.hoisted(() =>
	vi.fn((config: unknown) => ({ instruction: 'createATA', config })),
);
const getSyncNativeInstructionMock = vi.hoisted(() =>
	vi.fn((config: unknown) => ({ instruction: 'syncNative', config })),
);
const getCloseAccountInstructionMock = vi.hoisted(() =>
	vi.fn((config: unknown) => ({ instruction: 'closeAccount', config })),
);
const getTransferSolInstructionMock = vi.hoisted(() =>
	vi.fn((config: unknown) => ({ instruction: 'transferSol', config })),
);

vi.mock('@solana/kit', () => ({
	address: addressMock,
	appendTransactionMessageInstruction: appendTransactionMessageInstructionMock,
	createTransactionMessage: createTransactionMessageMock,
	createTransactionPlanExecutor: createTransactionPlanExecutorMock,
	getBase64EncodedWireTransaction: getBase64EncodedWireTransactionMock,
	isTransactionSendingSigner: isTransactionSendingSignerMock,
	pipe: pipeMock,
	setTransactionMessageFeePayer: setTransactionMessageFeePayerMock,
	setTransactionMessageLifetimeUsingBlockhash: setTransactionMessageLifetimeUsingBlockhashMock,
	singleTransactionPlan: singleTransactionPlanMock,
	signAndSendTransactionMessageWithSigners: signAndSendTransactionMessageWithSignersMock,
	signature: signatureMock,
	signTransactionMessageWithSigners: signTransactionMessageWithSignersMock,
}));

vi.mock('@solana/codecs-strings', () => ({
	getBase58Decoder: getBase58DecoderMock,
}));

vi.mock('@solana-program/token', () => ({
	findAssociatedTokenPda: findAssociatedTokenPdaMock,
	getCreateAssociatedTokenInstruction: getCreateAssociatedTokenInstructionMock,
	getSyncNativeInstruction: getSyncNativeInstructionMock,
	getCloseAccountInstruction: getCloseAccountInstructionMock,
	TOKEN_PROGRAM_ADDRESS: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
}));

vi.mock('@solana-program/system', () => ({
	getTransferSolInstruction: getTransferSolInstructionMock,
}));

vi.mock('../signers/walletTransactionSigner', () => ({
	createWalletTransactionSigner: createWalletTransactionSignerMock,
	isWalletSession: isWalletSessionMock,
	resolveSignerMode: resolveSignerModeMock,
}));

let createWsolHelper: typeof import('./wsol')['createWsolHelper'];

beforeAll(async () => {
	({ createWsolHelper } = await import('./wsol'));
});

describe('createWsolHelper', () => {
	const runtime = {
		rpc: {
			getAccountInfo: vi.fn(() => ({
				send: vi.fn().mockResolvedValue({ value: null }), // ATA doesn't exist by default
			})),
			getLatestBlockhash: vi.fn(() => ({
				send: vi.fn().mockResolvedValue({ value: { blockhash: 'hash', lastValidBlockHeight: 123n } }),
			})),
			sendTransaction: vi.fn(() => ({
				send: vi.fn().mockResolvedValue('wire-signature'),
			})),
		},
		rpcSubscriptions: {} as never,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('wrapSol', () => {
		it('prepares wrap transaction with wallet session', async () => {
			const helper = createWsolHelper(runtime as never);
			const session = {
				session: true,
				account: { address: 'owner' },
			} as unknown as WalletSession;
			createWalletTransactionSignerMock.mockReturnValueOnce({
				mode: 'partial',
				signer: { address: 'fee-payer' } as TransactionSigner,
			});

			const prepared = await helper.prepareWrapSol({
				amount: 100_000_000n,
				authority: session,
			});

			expect(createWalletTransactionSignerMock).toHaveBeenCalledWith(session, { commitment: undefined });
			expect(runtime.rpc.getLatestBlockhash).toHaveBeenCalled();
			expect(prepared.amount).toBe(100_000_000n);
			expect(prepared.mode).toBe('partial');
			expect(findAssociatedTokenPdaMock).toHaveBeenCalled();
		});

		it('includes create ATA instruction when account does not exist', async () => {
			const helper = createWsolHelper(runtime as never);
			const signer = { address: 'payer' } as TransactionSigner;

			await helper.prepareWrapSol({
				amount: 100_000_000n,
				authority: signer,
			});

			expect(runtime.rpc.getAccountInfo).toHaveBeenCalled();
			expect(getCreateAssociatedTokenInstructionMock).toHaveBeenCalled();
			expect(getTransferSolInstructionMock).toHaveBeenCalled();
			expect(getSyncNativeInstructionMock).toHaveBeenCalled();
		});

		it('wraps SOL end-to-end', async () => {
			const helper = createWsolHelper(runtime as never);
			const signature = await helper.wrapSol({
				amount: 100_000_000n,
				authority: { address: 'payer' } as TransactionSigner,
			});

			expect(signTransactionMessageWithSignersMock).toHaveBeenCalled();
			expect(signature).toBe('signature:wire-signature');
		});
	});

	describe('unwrapSol', () => {
		it('prepares unwrap transaction with wallet session', async () => {
			const helper = createWsolHelper(runtime as never);
			const session = {
				session: true,
				account: { address: 'owner' },
			} as unknown as WalletSession;
			createWalletTransactionSignerMock.mockReturnValueOnce({
				mode: 'partial',
				signer: { address: 'fee-payer' } as TransactionSigner,
			});

			const prepared = await helper.prepareUnwrapSol({
				authority: session,
			});

			expect(createWalletTransactionSignerMock).toHaveBeenCalledWith(session, { commitment: undefined });
			expect(runtime.rpc.getLatestBlockhash).toHaveBeenCalled();
			expect(prepared.mode).toBe('partial');
			expect(findAssociatedTokenPdaMock).toHaveBeenCalled();
			expect(getCloseAccountInstructionMock).toHaveBeenCalled();
		});

		it('unwraps SOL end-to-end', async () => {
			const helper = createWsolHelper(runtime as never);
			const signature = await helper.unwrapSol({
				authority: { address: 'payer' } as TransactionSigner,
			});

			expect(signTransactionMessageWithSignersMock).toHaveBeenCalled();
			expect(signature).toBe('signature:wire-signature');
		});
	});
});
