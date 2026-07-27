//! Browser bindings for the FourK covenant.
//!
//! The contract source is embedded at build time, so `CompiledContract`
//! borrows only `'static` data and no self-referential storage is needed.
//! The JS side supplies raw state fields; we return script bytes:
//!
//!   lockScript(state...)              -> redeem script (P2SH preimage)
//!   sigScript(state..., fn, sig, pk, ints) -> full input signature script
//!                                        (entry call + pushed redeem)

use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions, CompiledContract};
use wasm_bindgen::prelude::*;

const SOURCE: &str = include_str!("../../contracts/fourk.sil");

fn compile(
    p1: &[u8],
    p2: &[u8],
    board: &[u8],
    move_count: i64,
    phase: i64,
    move_timeout: i64,
    deadline: i64,
) -> Result<CompiledContract<'static>, JsError> {
    let ctor = vec![
        Expr::bytes(p1.to_vec()),
        Expr::bytes(p2.to_vec()),
        Expr::bytes(board.to_vec()),
        Expr::int(move_count),
        Expr::int(phase),
        Expr::int(move_timeout),
        Expr::int(deadline),
    ];
    compile_contract(SOURCE, &ctor, CompileOptions::default()).map_err(|e| JsError::new(&format!("compile: {e}")))
}

/// The redeem script for a game state — hash it (P2SH) for the state's
/// address, reveal it when spending.
#[wasm_bindgen(js_name = lockScript)]
pub fn lock_script(
    p1: &[u8],
    p2: &[u8],
    board: &[u8],
    move_count: i64,
    phase: i64,
    move_timeout: i64,
    deadline: i64,
) -> Result<Vec<u8>, JsError> {
    Ok(compile(p1, p2, board, move_count, phase, move_timeout, deadline)?.script)
}

/// Full signature script for spending a game UTXO via `function`.
///
/// `sig` is the 65-byte Schnorr signature+hashtype (unused for claim_draw),
/// `pk` the joiner pubkey (join) or the dissolving player's pubkey
/// (dissolve), `ints` the integer args:
/// move -> [col], winning_move -> [col, wcol, wrow, wdir], others -> [].
#[wasm_bindgen(js_name = sigScript)]
pub fn sig_script(
    p1: &[u8],
    p2: &[u8],
    board: &[u8],
    move_count: i64,
    phase: i64,
    move_timeout: i64,
    deadline: i64,
    function: &str,
    sig: Option<Vec<u8>>,
    pk: Option<Vec<u8>>,
    ints: Option<Vec<i64>>,
) -> Result<Vec<u8>, JsError> {
    let contract = compile(p1, p2, board, move_count, phase, move_timeout, deadline)?;
    let sig_expr = || -> Result<Expr<'static>, JsError> {
        Ok(Expr::bytes(sig.clone().ok_or_else(|| JsError::new("missing sig"))?))
    };
    let ints = ints.unwrap_or_default();
    let int_args = |n: usize| -> Result<Vec<Expr<'static>>, JsError> {
        if ints.len() != n {
            return Err(JsError::new(&format!("{function} expects {n} int args, got {}", ints.len())));
        }
        Ok(ints.iter().map(|&i| Expr::int(i)).collect())
    };

    let args: Vec<Expr<'static>> = match function {
        "join" | "dissolve" => {
            let pk = pk.ok_or_else(|| JsError::new(&format!("{function} needs pk")))?;
            vec![sig_expr()?, Expr::bytes(pk)]
        }
        "cancel" | "claim_forfeit" => vec![sig_expr()?],
        "move" => {
            let mut v = vec![sig_expr()?];
            v.extend(int_args(1)?);
            v
        }
        "winning_move" => {
            let mut v = vec![sig_expr()?];
            v.extend(int_args(4)?);
            v
        }
        "claim_draw" | "sudden_death" => vec![],
        other => return Err(JsError::new(&format!("unknown entrypoint {other}"))),
    };

    let call = contract
        .build_sig_script(function, args)
        .map_err(|e| JsError::new(&format!("sig script: {e}")))?;
    kaspa_txscript::pay_to_script_hash_signature_script_with_flags(
        contract.script,
        call,
        kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() },
    )
    .map_err(|e| JsError::new(&format!("p2sh wrap: {e}")))
}

/// Compiler sanity info for the UI's about box / debugging.
#[wasm_bindgen(js_name = contractInfo)]
pub fn contract_info() -> Result<String, JsError> {
    let c = compile(&[0u8; 32], &[0u8; 32], &[0u8; 42], 0, 0, 36_000, 0)?;
    Ok(format!("{} v{} ({} bytes)", c.contract_name, c.compiler_version, c.script.len()))
}
