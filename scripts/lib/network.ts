/**
 * Stellar testnet plumbing for the repo scripts: Friendbot, Horizon account
 * state, and the USDC trustline. Testnet only — there is no switch.
 */
import { Asset, BASE_FEE, Horizon, Networks, Operation, TransactionBuilder, type Keypair } from "@stellar/stellar-sdk";

export const TESTNET = {
  network: "testnet",
  passphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  usdc: {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
} as const;

export const USDC_ASSET = new Asset(TESTNET.usdc.code, TESTNET.usdc.issuer);

export interface AccountState {
  funded: boolean;
  nativeBalance: string | undefined;
  usdcTrustline: boolean;
  usdcBalance: string | undefined;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { response?: { status?: number } }).response?.status;
  return status === 404 || (error as { name?: string }).name === "NotFoundError";
}

export async function getAccountState(horizonUrl: string, address: string): Promise<AccountState> {
  const server = new Horizon.Server(horizonUrl);
  try {
    const account = await server.loadAccount(address);
    let nativeBalance: string | undefined;
    let usdcBalance: string | undefined;
    for (const balance of account.balances) {
      if (balance.asset_type === "native") nativeBalance = balance.balance;
      else if (
        (balance.asset_type === "credit_alphanum4" || balance.asset_type === "credit_alphanum12") &&
        balance.asset_code === TESTNET.usdc.code &&
        balance.asset_issuer === TESTNET.usdc.issuer
      ) {
        usdcBalance = balance.balance;
      }
    }
    return { funded: true, nativeBalance, usdcTrustline: usdcBalance !== undefined, usdcBalance };
  } catch (error) {
    if (isNotFound(error)) return { funded: false, nativeBalance: undefined, usdcTrustline: false, usdcBalance: undefined };
    throw error;
  }
}

export async function fundWithFriendbot(friendbotUrl: string, address: string): Promise<void> {
  const response = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(address)}`);
  if (!response.ok) {
    const body = await response.text();
    // "createAccountAlreadyExist" means a race with an earlier run; harmless.
    if (!body.includes("createAccountAlreadyExist")) {
      throw new Error(`friendbot refused ${address}: HTTP ${response.status} ${body.slice(0, 300)}`);
    }
  }
}

/** Opens the USDC trustline on `source`. The account must be funded. Returns the tx hash. */
export async function openUsdcTrustline(horizonUrl: string, source: Keypair): Promise<string> {
  const server = new Horizon.Server(horizonUrl);
  const account = await server.loadAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
    .setTimeout(60)
    .build();
  tx.sign(source);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
