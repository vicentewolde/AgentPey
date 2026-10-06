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
import { OFFERED_WALLETS, parseNeeds, walletsFor } from "./wallets.js";

/**
 * LOBSTR's extension answers "are you there?" by message, in up to 2 s, and the kit's picker gives every wallet 1 s:
 * a slow answer showed LOBSTR as not installed. The question is asked once, as the page loads, and the picker reads
 * the answer.
 */
class PatientLobstrModule extends LobstrModule {
  private presence: Promise<boolean> | undefined;
  override isAvailable(): Promise<boolean> {
    this.presence ??= super
      .isAvailable()
      .then((present) => {
        if (!present) this.presence = undefined; // asked again next time: the extension may load later
        return present;
      })
      .catch(() => {
        this.presence = undefined; // a failed question is not an answer: ask again next time
        return false;
      });
    return this.presence;
  }
}

const freighter = new FreighterModule();
const xbull = new xBullModule();
const lobstr = new PatientLobstrModule();
const hana = new HanaModule();

/** What this screen signs, from its script tag; the picker offers only the wallets that can sign all of it. */
const needs = parseNeeds(document.currentScript?.getAttribute("data-needs"));
const offeredHere = walletsFor(needs);
const modules = { freighter, xbull, lobstr, hana };
if (offeredHere.includes("lobstr")) void lobstr.isAvailable();

StellarWalletsKit.init({
  modules: offeredHere.map((id) => modules[id]),
  network: Networks.TESTNET,
  authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
});

const wallet = createWallet(StellarWalletsKit);

const within = (ms: number, check: () => Promise<boolean>): Promise<boolean> =>
  Promise.race([check().catch(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

/**
 * Which wallets' extensions this page can see right now, with more patience than the picker (3 s each). For the lab:
 * an extension that does not inject itself into the page (some skip `http://localhost`) shows here as `false`.
 * xBull is reported as its extension's presence (`window.xBullSDK`); without it, xBull opens its web wallet instead.
 */
async function detect(): Promise<Record<string, boolean>> {
  const [freighterSeen, lobstrSeen, hanaSeen] = await Promise.all([within(3000, () => freighter.isAvailable()), within(3000, () => lobstr.isAvailable()), within(3000, () => hana.isAvailable())]);
  return { freighter: freighterSeen, xbullExtension: "xBullSDK" in globalThis, lobstr: lobstrSeen, hana: hanaSeen };
}

Object.assign(globalThis, { AgentpeyWallet: { ...wallet, offered: OFFERED_WALLETS.filter((w) => offeredHere.includes(w.id)), needs, WalletError, describe, detect } });
