//! Browser bindings for the Fourk covenants (see Cargo.toml). Thin
//! wasm-bindgen wrappers over `builder`; every function speaks JSON so the
//! app's transaction specs stay plain data.

pub mod builder;

use wasm_bindgen::prelude::*;

fn js_err(e: builder::BuildError) -> JsError {
    JsError::new(&e.0)
}

/// The script public key (version 0 script bytes) locking `actor` carrying
/// the JSON `state` — hash-free input for the app's address derivation.
#[wasm_bindgen(js_name = actorScriptPublicKey)]
pub fn actor_script_public_key(actor: &str, state_json: &str) -> Result<Vec<u8>, JsError> {
    let state: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(state_json).map_err(|e| JsError::new(&format!("state: {e}")))?;
    builder::actor_script_public_key(actor, &state).map_err(js_err)
}

/// Build, sign, and engine-verify a transaction from a JSON spec (see
/// builder.rs). `secrets` is the concatenation of the 32-byte secret keys the
/// spec's signer indices refer to. Returns the finished transaction as JSON.
#[wasm_bindgen(js_name = buildTransaction)]
pub fn build_transaction(spec_json: &str, secrets: &[u8]) -> Result<String, JsError> {
    builder::build_json(spec_json, secrets).map_err(js_err)
}

/// JSON object mapping `actor`'s entry dispatch tags (hex) to entry names.
#[wasm_bindgen(js_name = entryTags)]
pub fn entry_tags(actor: &str) -> Result<String, JsError> {
    let tags = builder::entry_tags(actor).map_err(js_err)?;
    serde_json::to_string(&tags).map_err(|e| JsError::new(&format!("tags: {e}")))
}
