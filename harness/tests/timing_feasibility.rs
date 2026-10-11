//! Diagnostic probes for shared Fourk deadlines, not a replacement game contract.
//! These execute timing predicates against the exact compiler and script engine
//! pinned by this workspace. UTXO metadata is supplied by the test ledger.

use kaspa_consensus_core::constants::UNACCEPTED_DAA_SCORE;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::units::ComputeBudget;
use kaspa_consensus_core::tx::{
    ComputeCommit, PopulatedTransaction, Transaction, TransactionId, TransactionInput,
    TransactionOutpoint, UtxoEntry, VerifiableTransaction,
};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{
    EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script,
    pay_to_script_hash_signature_script_with_flags,
};
use kaspa_txscript_errors::TxScriptError;
use silverscript_abi::encode_contract_entry_sig_script;
use silverscript_lang::compiler::{CompileOptions, compile_to_sil_abi_artifact_with_options};

fn source(body: &str) -> String {
    format!("pragma silverscript ^0.1.0; contract TimingProbe() {{ entry verify() {{ {body} }} }}")
}

fn run(body: &str, input_daa: u64, lock_time: u64) -> Result<(), TxScriptError> {
    let artifact =
        compile_to_sil_abi_artifact_with_options(&source(body), &[], CompileOptions::default())
            .expect("timing probe compiles");
    let redeem = &artifact.contracts["TimingProbe"].compiled.bytecode;
    let call = encode_contract_entry_sig_script(&artifact, "TimingProbe", "verify", &[]).unwrap();
    let flags = EngineFlags {
        covenants_enabled: true,
        ..Default::default()
    };
    let input = TransactionInput {
        previous_outpoint: TransactionOutpoint {
            transaction_id: TransactionId::from_bytes([0x42; 32]),
            index: 0,
        },
        signature_script: pay_to_script_hash_signature_script_with_flags(
            redeem.clone(),
            call,
            flags,
        )
        .unwrap(),
        sequence: 0,
        compute_commit: ComputeCommit::ComputeBudget(ComputeBudget(10)),
    };
    let entry = UtxoEntry::new(
        100_000_000,
        pay_to_script_hash_script(redeem),
        input_daa,
        false,
        None,
    );
    let tx = Transaction::new(
        1,
        vec![input.clone()],
        vec![],
        lock_time,
        Default::default(),
        0,
        vec![],
    );
    let populated = PopulatedTransaction::new(&tx, vec![entry]);
    let reused = SigHashReusedValuesUnsync::new();
    let cache = Cache::new(10);
    let covenants = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        0,
        populated.utxo(0).unwrap(),
        EngineCtx::new(&cache)
            .with_reused(&reused)
            .with_covenants_ctx(&covenants),
        flags,
    )
    .execute()
}

const TIMELY: &str = "
    int accepted = OpTxInputDaaScore(this.activeInputIndex);
    require(accepted >= 0);
    require(accepted <= 1600);
";
const LATE: &str = "
    int accepted = OpTxInputDaaScore(this.activeInputIndex);
    require(accepted > 1600);
    require(accepted < 500000000000);
";

#[test]
fn current_time_upper_bounds_are_not_supported() {
    for body in ["require(tx.daa <= 1600);", "require(this.ageDaa <= 600);"] {
        let result =
            compile_to_sil_abi_artifact_with_options(&source(body), &[], CompileOptions::default());
        assert!(
            result.is_err(),
            "must not mistake a lock-time declaration for current time"
        );
    }
}

#[test]
fn declared_locktime_is_not_an_arrival_timestamp() {
    // Even an input born AFTER the deadline can use an earlier transaction
    // locktime. This comparison alone cannot reject late picks.
    assert!(run("require(OpTxLockTime() <= 1600);", 1700, 0).is_ok());
}

#[test]
fn accepted_input_timestamp_distinguishes_timely_from_late() {
    for accepted in [1000, 1599, 1600] {
        assert!(run(TIMELY, accepted, 2000).is_ok());
        assert!(run(LATE, accepted, 2000).is_err());
    }
    for accepted in [1601, 1700] {
        assert!(run(TIMELY, accepted, 0).is_err());
        assert!(run(LATE, accepted, 0).is_ok());
    }
}

#[test]
fn unaccepted_parent_must_not_be_treated_as_timely() {
    // The engine casts u64::MAX to -1. Without the nonnegative guard an
    // unaccepted parent would incorrectly pass a simple <= deadline check.
    assert!(
        run(
            "require(OpTxInputDaaScore(0) <= 1600);",
            UNACCEPTED_DAA_SCORE,
            0
        )
        .is_ok()
    );
    assert!(run(TIMELY, UNACCEPTED_DAA_SCORE, 0).is_err());
    assert!(run(LATE, UNACCEPTED_DAA_SCORE, 0).is_err());
}

#[test]
fn deadline_can_be_anchored_to_the_round_start_output() {
    assert!(run("require(OpTxInputDaaScore(0) + 600 == 1600);", 1000, 0).is_ok());
    assert!(run("require(OpTxInputDaaScore(0) + 600 == 1600);", 1001, 0).is_err());
}
