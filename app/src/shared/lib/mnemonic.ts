/**
 * Recovery phrases: the human face of an account's key.
 *
 * An account IS its 12-word BIP-39 phrase. The key is derived the way every
 * Kaspa wallet does it (m/44'/111111'/0', receive address 0, via the SDK's
 * PrivateKeyGenerator), never stored — so a phrase written down here
 * restores the same account in Kaspium/Kasware and vice versa, and there is
 * exactly one secret in the world that can be lost.
 *
 * Bare private keys are deliberately not accepted: a key nobody can write
 * down as words is a backup nobody takes, and supporting both means every
 * screen that shows a secret has to show two kinds.
 */

import { kaspa } from "./sdk";

/** Derive the account key from a validated phrase (receive address 0). */
export function phraseToKeyHex(phrase: string): string {
  const seed = new kaspa.Mnemonic(phrase).toSeed();
  const xprv = new kaspa.XPrv(seed);
  return new kaspa.PrivateKeyGenerator(xprv, false, 0n).receiveKey(0).toString();
}

/** A fresh 12-word account. */
export function generatePhrase(): string {
  return kaspa.Mnemonic.random(12).phrase;
}

/**
 * Validate and normalize whatever the user pasted into sign-in: a 12- or
 * 24-word recovery phrase, with case and stray whitespace forgiven. Throws
 * BAD_SECRET on anything else — mapped to a friendly sentence by errors.ts.
 */
export function parsePhrase(input: string): string {
  const phrase = input.trim().toLowerCase().split(/\s+/).join(" ");
  const words = phrase.split(" ").length;
  if ((words === 12 || words === 24) && kaspa.Mnemonic.validate(phrase)) return phrase;
  throw new Error("BAD_SECRET");
}
