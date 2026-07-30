//! Browser bindings for the Fourk covenant, backed by the Argent artifact.
//!
//! The compiled artifact (argentc build of contracts/fourk.ag) is embedded at
//! build time; no compiler runs in the browser. The JS side supplies raw
//! state fields; we return script bytes:
//!
//!   lobbyLockScript(state...) / matchLockScript(state...)
//!       -> redeem script (P2SH preimage) — hash it for the state's address,
//!          reveal it when spending
//!   lobbySigScript(state..., fn, sig, pk) / matchSigScript(state..., fn, sig, pk, ints)
//!       -> full input signature script (entry call + compiler-generated
//!          witness args + pushed redeem script)
//!
//! The OPEN/LIVE phase split of the old fourk.sil is two actors here: a
//! lobby state is (p1, move_timeout, deadline); a match state adds p2, the
//! board, and move_count.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use argent_runtime::{state, ArgValue, Artifact, ArtifactValue, TxBuilder};
use wasm_bindgen::prelude::*;

const ARTIFACT_JSON: &str = include_str!("../../contracts/build/artifact.json");

fn artifact() -> Result<&'static Artifact, JsError> {
    static ARTIFACT: OnceLock<Option<Artifact>> = OnceLock::new();
    ARTIFACT
        .get_or_init(|| serde_json::from_str(ARTIFACT_JSON).ok())
        .as_ref()
        .ok_or_else(|| JsError::new("embedded artifact does not deserialize"))
}

fn builder() -> Result<TxBuilder<'static>, JsError> {
    TxBuilder::new(artifact()?).map_err(|e| JsError::new(&format!("artifact: {e}")))
}

fn lobby_state(p1: &[u8], move_timeout: i64, deadline: i64) -> BTreeMap<String, ArtifactValue> {
    state! {
        p1: p1.to_vec(),
        move_timeout: move_timeout,
        deadline: deadline,
    }
}

#[allow(clippy::too_many_arguments)]
fn match_state(
    p1: &[u8],
    p2: &[u8],
    board: &[u8],
    move_count: i64,
    move_timeout: i64,
    deadline: i64,
) -> BTreeMap<String, ArtifactValue> {
    state! {
        p1: p1.to_vec(),
        p2: p2.to_vec(),
        board: board.to_vec(),
        move_count: move_count,
        move_timeout: move_timeout,
        deadline: deadline,
    }
}

/// Entry arguments in ABI order for one spend. `sig` is the 65-byte Schnorr
/// signature+hashtype, `pk` the joiner pubkey (join) or the dissolving
/// player's pubkey (dissolve), `ints` the integer args:
/// move -> [col], winning_move -> [col, wcol, wrow, wdir], others -> [].
fn entry_args(
    function: &str,
    sig: Option<Vec<u8>>,
    pk: Option<Vec<u8>>,
    ints: Option<Vec<i64>>,
) -> Result<Vec<ArgValue>, JsError> {
    let sig_arg = || -> Result<ArgValue, JsError> {
        Ok(ArgValue::from(
            sig.clone().ok_or_else(|| JsError::new("missing sig"))?,
        ))
    };
    let ints = ints.unwrap_or_default();
    let int_args = |n: usize| -> Result<Vec<ArgValue>, JsError> {
        if ints.len() != n {
            return Err(JsError::new(&format!(
                "{function} expects {n} int args, got {}",
                ints.len()
            )));
        }
        Ok(ints.iter().map(|&i| ArgValue::from(i)).collect())
    };

    match function {
        "join" | "dissolve" => {
            let pk = pk.ok_or_else(|| JsError::new(&format!("{function} needs pk")))?;
            Ok(vec![sig_arg()?, ArgValue::from(pk)])
        }
        "cancel" | "claim_forfeit" => Ok(vec![sig_arg()?]),
        "move" => {
            let mut v = vec![sig_arg()?];
            v.extend(int_args(1)?);
            Ok(v)
        }
        "winning_move" => {
            let mut v = vec![sig_arg()?];
            v.extend(int_args(4)?);
            Ok(v)
        }
        "claim_draw" | "sudden_death" => Ok(vec![]),
        other => Err(JsError::new(&format!("unknown entrypoint {other}"))),
    }
}

/// The redeem script for an open seat awaiting a joiner.
#[wasm_bindgen(js_name = lobbyLockScript)]
pub fn lobby_lock_script(p1: &[u8], move_timeout: i64, deadline: i64) -> Result<Vec<u8>, JsError> {
    builder()?
        .actor_redeem_script("FourkLobby", lobby_state(p1, move_timeout, deadline))
        .map_err(|e| JsError::new(&format!("lobby lock script: {e}")))
}

/// The redeem script for a live game state.
#[wasm_bindgen(js_name = matchLockScript)]
pub fn match_lock_script(
    p1: &[u8],
    p2: &[u8],
    board: &[u8],
    move_count: i64,
    move_timeout: i64,
    deadline: i64,
) -> Result<Vec<u8>, JsError> {
    builder()?
        .actor_redeem_script(
            "FourkMatch",
            match_state(p1, p2, board, move_count, move_timeout, deadline),
        )
        .map_err(|e| JsError::new(&format!("match lock script: {e}")))
}

/// Full signature script for spending a lobby UTXO via `function`
/// (join or cancel).
#[wasm_bindgen(js_name = lobbySigScript)]
pub fn lobby_sig_script(
    p1: &[u8],
    move_timeout: i64,
    deadline: i64,
    function: &str,
    sig: Option<Vec<u8>>,
    pk: Option<Vec<u8>>,
) -> Result<Vec<u8>, JsError> {
    let args = entry_args(function, sig, pk, None)?;
    builder()?
        .entry_signature_script(
            "FourkLobby",
            lobby_state(p1, move_timeout, deadline),
            function,
            args,
        )
        .map_err(|e| JsError::new(&format!("{function} sig script: {e}")))
}

/// Full signature script for spending a match UTXO via `function`
/// (dissolve, move, winning_move, claim_draw, claim_forfeit, sudden_death).
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = matchSigScript)]
pub fn match_sig_script(
    p1: &[u8],
    p2: &[u8],
    board: &[u8],
    move_count: i64,
    move_timeout: i64,
    deadline: i64,
    function: &str,
    sig: Option<Vec<u8>>,
    pk: Option<Vec<u8>>,
    ints: Option<Vec<i64>>,
) -> Result<Vec<u8>, JsError> {
    let args = entry_args(function, sig, pk, ints)?;
    builder()?
        .entry_signature_script(
            "FourkMatch",
            match_state(p1, p2, board, move_count, move_timeout, deadline),
            function,
            args,
        )
        .map_err(|e| JsError::new(&format!("{function} sig script: {e}")))
}

/// Artifact sanity info for the UI's about box / debugging.
#[wasm_bindgen(js_name = contractInfo)]
pub fn contract_info() -> Result<String, JsError> {
    let artifact = artifact()?;
    let lobby = builder()?
        .actor_redeem_script("FourkLobby", lobby_state(&[0u8; 32], 36_000, 0))
        .map_err(|e| JsError::new(&format!("info: {e}")))?;
    Ok(format!(
        "{} artifact {} (lobby script {} bytes)",
        artifact.app,
        &artifact.id[..16],
        lobby.len()
    ))
}
