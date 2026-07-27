//! Replay browser-built transactions through the real script engine.
//!
//! tests/replay-fixtures/gen-join-repro.mjs rebuilds a transaction exactly as
//! the React app does (same wasm modules, same code path) and dumps it as
//! JSON; this test executes every input against the engine. It exists because
//! the wasm layer can silently change a transaction between build and submit
//! (the original catch: TransactionOutput consuming the CovenantBinding on
//! reuse), and the node's script errors don't say which check failed.
//!
//! Regenerate the fixture after changing the app's tx assembly:
//!   cd tests/replay-fixtures && node gen-join-repro.mjs

use std::path::Path;
use std::str::FromStr;

use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::units::ComputeBudget;
use kaspa_consensus_core::tx::{
    ComputeCommit, CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput,
    TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction,
};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{EngineCtx, EngineFlags, TxScriptEngine};

#[test]
fn replay_browser_join() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/replay-fixtures/join-repro.json");
    if !path.exists() {
        panic!("fixture missing — run `node gen-join-repro.mjs` in tests/replay-fixtures");
    }
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

    let inputs: Vec<TransactionInput> = raw["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| TransactionInput {
            previous_outpoint: TransactionOutpoint {
                transaction_id: TransactionId::from_str(i["transactionId"].as_str().unwrap()).unwrap(),
                index: i["index"].as_u64().unwrap() as u32,
            },
            signature_script: hex(i["signatureScript"].as_str().unwrap()),
            sequence: i["sequence"].as_u64().unwrap(),
            compute_commit: ComputeCommit::ComputeBudget(ComputeBudget(i["computeBudget"].as_u64().unwrap() as u16)),
        })
        .collect();

    let outputs: Vec<TransactionOutput> = raw["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| TransactionOutput {
            value: o["value"].as_u64().unwrap(),
            script_public_key: ScriptPublicKey::from_vec(0, hex(o["script"].as_str().unwrap())),
            covenant: o["covenant"].as_object().map(|c| CovenantBinding {
                authorizing_input: c["authorizingInput"].as_u64().unwrap() as u16,
                covenant_id: Hash::from_str(c["covenantId"].as_str().unwrap()).unwrap(),
            }),
        })
        .collect();

    let entries: Vec<UtxoEntry> = raw["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            UtxoEntry::new(
                i["utxoAmount"].as_u64().unwrap(),
                ScriptPublicKey::from_vec(0, hex(i["utxoScript"].as_str().unwrap())),
                0,
                false,
                i["utxoCovenantId"].as_str().map(|s| Hash::from_str(s).unwrap()),
            )
        })
        .collect();

    let tx = Transaction::new(1, inputs, outputs, 0, Default::default(), 0, vec![]);

    for input_idx in 0..tx.inputs.len() {
        let reused_values = SigHashReusedValuesUnsync::new();
        let sig_cache = Cache::new(10_000);
        let input = tx.inputs[input_idx].clone();
        let populated = PopulatedTransaction::new(&tx, entries.clone());
        let cov_ctx = CovenantsContext::from_tx(&populated).expect("covenant context builds");
        let utxo = populated.utxo(input_idx).unwrap();
        let mut vm = TxScriptEngine::from_transaction_input(
            &populated,
            &input,
            input_idx,
            utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused_values).with_covenants_ctx(&cov_ctx),
            EngineFlags { covenants_enabled: true, ..Default::default() },
        );
        let result = vm.execute();
        assert!(result.is_ok(), "browser-built tx: input {input_idx} failed: {:?}", result.unwrap_err());
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
