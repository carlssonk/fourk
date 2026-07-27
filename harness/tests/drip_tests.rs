//! Adversarial suite for contracts/drip.sil — the on-chain dispenser —
//! executed against the real script engine. Claims are unsigned pure-script
//! spends, so every test is just transaction shape + sequence.

use std::fs;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::units::ComputeBudget;
use kaspa_consensus_core::tx::{
    ComputeCommit, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint,
    TransactionOutput, UtxoEntry, VerifiableTransaction,
};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{
    EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags,
};
use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::compiler::{CompileOptions, CompiledContract, compile_contract};

const COOLDOWN: u64 = 1200;
const DRIP: u64 = 1_000_000_000;
const TKAS: u64 = 100_000_000;

fn drip_contract() -> &'static Arc<CompiledContract<'static>> {
    static C: OnceLock<Arc<CompiledContract<'static>>> = OnceLock::new();
    C.get_or_init(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/drip.sil");
        let source: &'static str = Box::leak(fs::read_to_string(path).expect("read drip.sil").into_boxed_str());
        Arc::new(compile_contract(source, &[], CompileOptions::default()).expect("drip.sil compiles"))
    })
}

fn dispenser_spk() -> ScriptPublicKey {
    pay_to_script_hash_script(&drip_contract().script)
}

fn claimant_spk() -> ScriptPublicKey {
    ScriptPublicKey::from_vec(0, [&[0x20u8][..], &[0x77u8; 32], &[0xacu8]].concat())
}

fn claim_sigscript() -> Vec<u8> {
    let contract = drip_contract();
    let call = contract.build_sig_script("drip", vec![]).expect("sigscript builds");
    pay_to_script_hash_signature_script_with_flags(
        contract.script.clone(),
        call,
        EngineFlags { covenants_enabled: true, ..Default::default() },
    )
    .expect("wrap p2sh")
}

fn dispenser_input(index: u32, sequence: u64) -> TransactionInput {
    TransactionInput {
        previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([0xdd; 32]), index },
        signature_script: claim_sigscript(),
        sequence,
        compute_commit: ComputeCommit::ComputeBudget(ComputeBudget(1)),
    }
}

fn run_claim(balances: &[u64], sequence: u64, outputs: Vec<TransactionOutput>) -> Result<(), TxScriptError> {
    let inputs: Vec<TransactionInput> = (0..balances.len()).map(|i| dispenser_input(i as u32, sequence)).collect();
    let entries: Vec<UtxoEntry> = balances.iter().map(|&v| UtxoEntry::new(v, dispenser_spk(), 0, false, None)).collect();
    let tx = Transaction::new(1, inputs, outputs, 0, Default::default(), 0, vec![]);
    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[0].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(0).unwrap();
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        0,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused_values).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, ..Default::default() },
    );
    vm.execute()
}

fn successor(value: u64) -> TransactionOutput {
    TransactionOutput { value, script_public_key: dispenser_spk(), covenant: None }
}

fn payout(value: u64) -> TransactionOutput {
    TransactionOutput { value, script_public_key: claimant_spk(), covenant: None }
}

#[test]
fn script_is_tiny() {
    let c = drip_contract();
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    println!("drip redeem script ({} bytes): {}", c.script.len(), hex(&c.script));
    println!("claim sigscript ({} bytes): {}", claim_sigscript().len(), hex(&claim_sigscript()));
    assert!(c.script.len() < 100);
}

#[test]
fn claim_succeeds_without_any_signature() {
    let balance = 100 * TKAS;
    let outputs = vec![successor(balance - DRIP), payout(DRIP - 200_000)];
    assert!(run_claim(&[balance], COOLDOWN, outputs).is_ok());
}

#[test]
fn claim_may_take_less_than_the_full_drip() {
    let balance = 100 * TKAS;
    let outputs = vec![successor(balance - DRIP / 2), payout(DRIP / 2 - 200_000)];
    assert!(run_claim(&[balance], COOLDOWN, outputs).is_ok());
}

#[test]
fn cooldown_is_enforced() {
    let balance = 100 * TKAS;
    let outputs = vec![successor(balance - DRIP), payout(DRIP - 200_000)];
    assert!(run_claim(&[balance], COOLDOWN - 1, outputs.clone()).is_err());
    assert!(run_claim(&[balance], 0, outputs).is_err());
}

#[test]
fn overdraw_is_rejected() {
    let balance = 100 * TKAS;
    let outputs = vec![successor(balance - DRIP - 1), payout(DRIP + 1)];
    assert!(run_claim(&[balance], COOLDOWN, outputs).is_err());
}

#[test]
fn successor_must_return_to_the_dispenser() {
    let balance = 100 * TKAS;
    // output 0 pays the claimant instead of re-locking to the script
    let outputs = vec![payout(balance - DRIP), payout(DRIP - 200_000)];
    assert!(run_claim(&[balance], COOLDOWN, outputs).is_err());
}

#[test]
fn lane_aggregation_attack_is_rejected() {
    // Two dispenser lanes in one tx, one shared successor: without the
    // single-input rule this would drain a full extra lane.
    let balance = 100 * TKAS;
    let outputs = vec![successor(balance - DRIP), payout(balance + DRIP)];
    assert!(run_claim(&[balance, balance], COOLDOWN, outputs).is_err());
}

#[test]
fn missing_outputs_fail() {
    assert!(run_claim(&[100 * TKAS], COOLDOWN, vec![]).is_err());
}

#[test]
fn endgame_sweep_when_balance_at_or_below_drip() {
    // Once the lane can't fund a full drip, the claimant may take everything.
    for balance in [DRIP, DRIP / 2] {
        let outputs = vec![payout(balance - 200_000)];
        assert!(run_claim(&[balance], COOLDOWN, outputs).is_ok(), "sweep at balance {balance}");
    }
    // ...but one sompi above DRIP still demands a successor.
    let outputs = vec![payout(DRIP + 1 - 200_000)];
    assert!(run_claim(&[DRIP + 1], COOLDOWN, outputs).is_err());
}
