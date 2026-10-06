/**
 * The bundled entry (`dist/wallet-kit.js`): Stellar Wallets Kit with the offered wallets only, on testnet, exposed as
 * `window.AgentpeyWallet` for the signing screens, which are plain HTML.
 */
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";

import { WalletError } from "./errors.js";
import { describe } from "./messages.js";
import { createWallet } from "./wallet.js";
import { OFFERED_WALLETS } from "./wallets.js";

StellarWalletsKit.init({
  modules: [new FreighterModule(), new xBullModule(), new LobstrModule(), new HanaModule()],
  network: Networks.TESTNET,
  authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
});

const wallet = createWallet(StellarWalletsKit);

Object.assign(globalThis, { AgentpeyWallet: { ...wallet, offered: OFFERED_WALLETS, WalletError, describe } });
