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
