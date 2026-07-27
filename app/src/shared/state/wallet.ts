import type { PrivateKey } from "kaspa-wasm";
import { walletPubkey } from "../lib/covenant";
import { kaspa } from "../lib/sdk";

const KEY_STORAGE = "fourk.key";

interface Wallet {
  key: PrivateKey;
  myPk: string;
}

let wallet: Wallet | undefined;

/** The player's key is invisible infrastructure: created on first visit.
 * Lazy because the wasm SDK must be initialized before the first call. */
export function getWallet(): Wallet {
  if (!wallet) {
    let hex = localStorage.getItem(KEY_STORAGE);
    if (!hex) {
      hex = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey).toString();
      localStorage.setItem(KEY_STORAGE, hex);
    }
    const key = new kaspa.PrivateKey(hex);
    wallet = { key, myPk: walletPubkey(key) };
  }
  return wallet;
}
