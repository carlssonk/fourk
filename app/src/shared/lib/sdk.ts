/** Load both wasm modules once; everything else imports the namespaces. */
import kaspaInit, * as kaspa from "kaspa-wasm";
import fourkInit, * as fourk from "fourk-wasm";

let ready: Promise<void> | undefined;

export function initSdk(): Promise<void> {
  ready ??= Promise.all([kaspaInit(), fourkInit()]).then(() => undefined);
  return ready;
}

export { kaspa, fourk };
