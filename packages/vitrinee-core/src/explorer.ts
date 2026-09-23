/** Links a human can click from the agent's output, the dashboard and the README. */
export function stellarExpertTxUrl(txHash: string, network: "testnet" | "public" = "testnet"): string {
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

export function stellarExpertAccountUrl(account: string, network: "testnet" | "public" = "testnet"): string {
  return `https://stellar.expert/explorer/${network}/account/${account}`;
}

export function stellarExpertContractUrl(contractId: string, network: "testnet" | "public" = "testnet"): string {
  return `https://stellar.expert/explorer/${network}/contract/${contractId}`;
}

/** An account or a contract, whichever `address` is: a payer can be either (VT-22). */
export function stellarExpertAddressUrl(address: string, network: "testnet" | "public" = "testnet"): string {
  return address.startsWith("C") ? stellarExpertContractUrl(address, network) : stellarExpertAccountUrl(address, network);
}
