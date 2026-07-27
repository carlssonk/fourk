//! Adversarial suite for contracts/fourk.sil, executed against the real
//! rusty-kaspa script engine with real Schnorr signatures — the Rust port of
//! the TypeScript reference tests in ../../test/. Same harness pattern as
//! silverscript-lang's chess_apps_tests.rs: compile the contract per state,
//! build a covenant transaction, sign, execute the active input.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::mass::units::SigopCount;
use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint,
    TransactionOutput, UtxoEntry, VerifiableTransaction,
};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{
    EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags,
};
use kaspa_txscript_errors::TxScriptError;
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{CompileOptions, CompiledContract, compile_contract};

const COLS: usize = 7;
const ROWS: usize = 6;
const CELLS: usize = 42;
const STAKE: u64 = 100_000_000;
const POT: u64 = 2 * STAKE;
// Must match MOVE_TIMEOUT in fourk.sil.
const MOVE_TIMEOUT: u64 = 36_000;

const OPEN: i64 = 0;
const LIVE: i64 = 1;
// Must match MIN_MOVE_TIMEOUT in fourk.sil.
const MIN_MOVE_TIMEOUT: i64 = 600;

// Witness directions, matching the contract: 0 = E, 1 = N, 2 = NE, 3 = SE.
const E: i64 = 0;
const N: i64 = 1;
const NE: i64 = 2;
const SE: i64 = 3;

#[derive(Clone)]
struct GameState {
    p1: [u8; 32],
    p2: [u8; 32],
    board: [u8; CELLS],
    move_count: i64,
    phase: i64,
    move_timeout: i64,
    deadline: i64,
}

struct Player {
    keypair: Keypair,
    pk: [u8; 32],
}

fn player_from_seed(seed: u8) -> Player {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_slice(&[seed; 32]).expect("valid deterministic secret key");
    let keypair = Keypair::from_secret_key(&secp, &secret);
    let (x_only, _) = keypair.x_only_public_key();
    Player { keypair, pk: x_only.serialize() }
}

fn p1() -> &'static Player {
    static P: OnceLock<Player> = OnceLock::new();
    P.get_or_init(|| player_from_seed(1))
}

fn p2() -> &'static Player {
    static P: OnceLock<Player> = OnceLock::new();
    P.get_or_init(|| player_from_seed(2))
}

fn stranger() -> &'static Player {
    static P: OnceLock<Player> = OnceLock::new();
    P.get_or_init(|| player_from_seed(3))
}

fn covenant_id() -> Hash {
    Hash::from_bytes([0xab; 32])
}

// --- Reference game logic (test-side mirror of src/rules.ts) -----------------

fn open_start() -> GameState {
    GameState {
        p1: p1().pk,
        p2: [0u8; 32],
        board: [0u8; CELLS],
        move_count: 0,
        phase: OPEN,
        move_timeout: MOVE_TIMEOUT as i64,
        deadline: 0,
    }
}

fn live_start() -> GameState {
    GameState { p2: p2().pk, phase: LIVE, ..open_start() }
}

fn height(board: &[u8; CELLS], col: usize) -> usize {
    (0..ROWS).take_while(|&r| board[col * ROWS + r] != 0).count()
}

fn mover_index(state: &GameState) -> usize {
    (state.move_count % 2) as usize
}

fn mover_player(state: &GameState) -> &'static Player {
    if mover_index(state) == 0 { p1() } else { p2() }
}

fn apply_move(state: &GameState, col: usize) -> GameState {
    let mut next = state.clone();
    let h = height(&state.board, col);
    assert!(h < ROWS, "test fixture bug: column {col} full");
    next.board[col * ROWS + h] = (mover_index(state) + 1) as u8;
    next.move_count += 1;
    next
}

fn play(state: &GameState, cols: &[usize]) -> GameState {
    cols.iter().fold(state.clone(), |s, &c| apply_move(&s, c))
}

fn full_board() -> GameState {
    let cols: Vec<usize> = (0..COLS).flat_map(|c| std::iter::repeat_n(c, ROWS)).collect();
    play(&live_start(), &cols)
}

// --- Compilation -------------------------------------------------------------

fn fourk_source() -> &'static str {
    static SOURCE: OnceLock<&'static str> = OnceLock::new();
    SOURCE.get_or_init(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/fourk.sil");
        let source = fs::read_to_string(&path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
        Box::leak(source.into_boxed_str())
    })
}

fn ctor_exprs(state: &GameState) -> Vec<Expr<'static>> {
    vec![
        Expr::bytes(state.p1.to_vec()),
        Expr::bytes(state.p2.to_vec()),
        Expr::bytes(state.board.to_vec()),
        Expr::int(state.move_count),
        Expr::int(state.phase),
        Expr::int(state.move_timeout),
        Expr::int(state.deadline),
    ]
}

fn compile_cache() -> &'static Mutex<HashMap<String, Arc<CompiledContract<'static>>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<CompiledContract<'static>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn compile_state(state: &GameState) -> Arc<CompiledContract<'static>> {
    let ctor = ctor_exprs(state);
    let key = serde_json::to_string(&ctor).expect("serialize ctor args");
    if let Some(compiled) = compile_cache().lock().expect("cache mutex").get(&key) {
        return Arc::clone(compiled);
    }
    let compiled =
        Arc::new(compile_contract(fourk_source(), &ctor, CompileOptions::default()).expect("fourk.sil compiles"));
    compile_cache().lock().expect("cache mutex").insert(key, Arc::clone(&compiled));
    compiled
}

// --- Transaction plumbing ----------------------------------------------------

fn entry_sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Vec<u8> {
    let sigscript = compiled.build_sig_script(function, args).expect("sigscript builds");
    pay_to_script_hash_signature_script_with_flags(
        compiled.script.clone(),
        sigscript,
        EngineFlags { covenants_enabled: true, ..Default::default() },
    )
    .expect("wrap p2sh sigscript")
}

fn game_input(signature_script: Vec<u8>, sequence: u64, sig_op_count: u8) -> TransactionInput {
    TransactionInput {
        previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([0x01; 32]), index: 0 },
        signature_script,
        sequence,
        compute_commit: SigopCount(sig_op_count).into(),
    }
}

fn game_utxo(compiled: &CompiledContract<'_>, value: u64) -> UtxoEntry {
    UtxoEntry::new(value, pay_to_script_hash_script(&compiled.script), 0, false, Some(covenant_id()))
}

fn successor_output(compiled: &CompiledContract<'_>, value: u64) -> TransactionOutput {
    TransactionOutput {
        value,
        script_public_key: pay_to_script_hash_script(&compiled.script),
        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: covenant_id() }),
    }
}

/// 34-byte P2PK lock: OP_DATA_32 <x-only pubkey> OP_CHECKSIG — the shape the
/// contract's `new ScriptPubKeyP2PK(...)` builds.
fn p2pk_output(pk: &[u8; 32], value: u64) -> TransactionOutput {
    let mut script = Vec::with_capacity(34);
    script.push(0x20);
    script.extend_from_slice(pk);
    script.push(0xac);
    TransactionOutput { value, script_public_key: ScriptPublicKey::from_vec(0, script), covenant: None }
}

fn sign_input(tx: &Transaction, entries: &[UtxoEntry], input_idx: usize, signer: &Keypair) -> Vec<u8> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let sig_hash = calc_schnorr_signature_hash(&populated, input_idx, SIG_HASH_ALL, &reused_values);
    let msg = Message::from_digest_slice(sig_hash.as_bytes().as_slice()).expect("valid sighash message");
    let sig = signer.sign_schnorr(msg);
    let mut signature = Vec::with_capacity(65);
    signature.extend_from_slice(sig.as_ref());
    signature.push(SIG_HASH_ALL.to_u8());
    signature
}

fn execute(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(input_idx).expect("selected input utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused_values).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, ..Default::default() },
    );
    vm.execute()
}

/// Build, sign, and execute one spend of the game UTXO.
/// `args(sig)` produces the call args with the given signature spliced in;
/// pass `signer: None` for unsigned entrypoints (claim_draw, sudden_death).
/// `lock_time` is the declared absolute time (`tx.time` in the contract).
fn run_entry_at(
    active_state: &GameState,
    function: &str,
    args: &dyn Fn(Vec<u8>) -> Vec<Expr<'static>>,
    signer: Option<&Keypair>,
    in_value: u64,
    outputs: Vec<TransactionOutput>,
    sequence: u64,
    lock_time: u64,
) -> Result<(), TxScriptError> {
    let active = compile_state(active_state);
    let entries = vec![game_utxo(&active, in_value)];
    let sig_ops = if signer.is_some() { 1 } else { 0 };
    let placeholder = entry_sigscript(&active, function, args(vec![0u8; 65]));
    let mut tx =
        Transaction::new(1, vec![game_input(placeholder, sequence, sig_ops)], outputs, lock_time, Default::default(), 0, vec![]);
    if let Some(keypair) = signer {
        let sig = sign_input(&tx, &entries, 0, keypair);
        tx.inputs[0].signature_script = entry_sigscript(&active, function, args(sig));
    }
    execute(tx, entries, 0)
}

fn run_entry(
    active_state: &GameState,
    function: &str,
    args: &dyn Fn(Vec<u8>) -> Vec<Expr<'static>>,
    signer: Option<&Keypair>,
    in_value: u64,
    outputs: Vec<TransactionOutput>,
    sequence: u64,
) -> Result<(), TxScriptError> {
    run_entry_at(active_state, function, args, signer, in_value, outputs, sequence, 0)
}

fn run_move(state: &GameState, col: i64, signer: &Player, next: &GameState, out_value: u64) -> Result<(), TxScriptError> {
    run_entry(
        state,
        "move",
        &move |sig| vec![Expr::bytes(sig), Expr::int(col)],
        Some(&signer.keypair),
        POT,
        vec![successor_output(&compile_state(next), out_value)],
        0,
    )
}

fn run_winning_move(
    state: &GameState,
    col: i64,
    (wcol, wrow, wdir): (i64, i64, i64),
    signer: &Player,
    extra_successor: bool,
) -> Result<(), TxScriptError> {
    let mut outputs = vec![p2pk_output(&signer.pk, POT)];
    if extra_successor {
        // A cheat: terminal claim that also smuggles out a covenant successor.
        outputs.push(successor_output(&compile_state(state), 1_000));
    }
    run_entry(
        state,
        "winning_move",
        &move |sig| vec![Expr::bytes(sig), Expr::int(col), Expr::int(wcol), Expr::int(wrow), Expr::int(wdir)],
        Some(&signer.keypair),
        POT,
        outputs,
        0,
    )
}

fn run_forfeit(state: &GameState, signer: &Player, sequence: u64) -> Result<(), TxScriptError> {
    run_entry(state, "claim_forfeit", &|sig| vec![Expr::bytes(sig)], Some(&signer.keypair), POT, vec![p2pk_output(&signer.pk, POT)], sequence)
}

fn assert_pass(result: Result<(), TxScriptError>, label: &str) {
    assert!(result.is_ok(), "{label} should pass: {:?}", result.unwrap_err());
}

fn assert_fail(result: Result<(), TxScriptError>, label: &str) {
    assert!(result.is_err(), "{label} should fail but passed");
}

// --- Budget ------------------------------------------------------------------

#[test]
fn script_stays_small() {
    // ~1.7 KB after the dissolve door and per-match timing (was ~1.4 KB) —
    // about the simplest chess contract (1754) and nowhere near the ~300 KB
    // practical ceiling. Not an exact snapshot, just an early alarm if the
    // script balloons.
    let len = compile_state(&live_start()).script.len();
    println!("fourk compiled script: {len} bytes");
    assert!(len < 1_900, "script grew to {len} bytes — check what changed");
}

// --- Open phase --------------------------------------------------------------

fn run_join(state: &GameState, joiner: &Player, next: &GameState, in_value: u64, out_value: u64) -> Result<(), TxScriptError> {
    let joiner_pk = joiner.pk.to_vec();
    run_entry(
        state,
        "join",
        &move |sig| vec![Expr::bytes(sig), Expr::bytes(joiner_pk.clone())],
        Some(&joiner.keypair),
        in_value,
        vec![successor_output(&compile_state(next), out_value)],
        0,
    )
}

#[test]
fn join_succeeds_and_doubles_pot() {
    assert_pass(run_join(&open_start(), p2(), &live_start(), STAKE, POT), "join");
}

#[test]
fn join_rejects_unmatched_stake() {
    assert_fail(run_join(&open_start(), p2(), &live_start(), STAKE, STAKE), "join without doubling the pot");
    assert_fail(run_join(&open_start(), p2(), &live_start(), STAKE, POT - 1), "join one sompi short");
}

#[test]
fn join_rejects_live_match() {
    assert_fail(run_join(&live_start(), stranger(), &live_start(), POT, 2 * POT), "join on a live match");
}

#[test]
fn join_rejects_p1_self_join() {
    let next = GameState { p2: p1().pk, phase: LIVE, ..open_start() };
    assert_fail(run_join(&open_start(), p1(), &next, STAKE, POT), "p1 joining their own match");
}

#[test]
fn join_rejects_trap_timeout() {
    let mut trap = open_start();
    trap.move_timeout = MIN_MOVE_TIMEOUT - 1;
    let mut next = live_start();
    next.move_timeout = MIN_MOVE_TIMEOUT - 1;
    assert_fail(run_join(&trap, p2(), &next, STAKE, POT), "join into a below-floor move clock");

    let mut floor = open_start();
    floor.move_timeout = MIN_MOVE_TIMEOUT;
    let mut floor_next = live_start();
    floor_next.move_timeout = MIN_MOVE_TIMEOUT;
    assert_pass(run_join(&floor, p2(), &floor_next, STAKE, POT), "join at the timeout floor");
}

#[test]
fn join_preserves_timing_fields() {
    let mut capped = open_start();
    capped.move_timeout = 3000;
    capped.deadline = 5_000_000;
    let mut kept = live_start();
    kept.move_timeout = 3000;
    kept.deadline = 5_000_000;
    assert_pass(run_join(&capped, p2(), &kept, STAKE, POT), "join keeping the genesis clock");

    let mut stretched = kept.clone();
    stretched.deadline = 9_000_000; // joiner tries to defer sudden death
    assert_fail(run_join(&capped, p2(), &stretched, STAKE, POT), "join tampering with the deadline");
    let mut slowed = kept.clone();
    slowed.move_timeout = 864_000; // joiner tries to slow the move clock
    assert_fail(run_join(&capped, p2(), &slowed, STAKE, POT), "join tampering with the move timeout");
}

#[test]
fn join_rejects_dirty_genesis() {
    let mut dirty_board = open_start();
    dirty_board.board[0] = 1;
    let mut next = live_start();
    next.board[0] = 1;
    assert_fail(run_join(&dirty_board, p2(), &next, STAKE, POT), "join on a non-empty genesis board");

    let mut dirty_count = open_start();
    dirty_count.move_count = 5;
    assert_fail(run_join(&dirty_count, p2(), &live_start(), STAKE, POT), "join on a nonzero genesis move count");
}

#[test]
fn join_rejects_tampered_successor() {
    let mut stays_open = live_start();
    stays_open.phase = OPEN;
    assert_fail(run_join(&open_start(), p2(), &stays_open, STAKE, POT), "join whose successor stays open");

    let mut usurped = live_start();
    usurped.p1 = p2().pk;
    assert_fail(run_join(&open_start(), p2(), &usurped, STAKE, POT), "join that replaces p1");

    let mut wrong_p2 = live_start();
    wrong_p2.p2 = stranger().pk;
    assert_fail(run_join(&open_start(), p2(), &wrong_p2, STAKE, POT), "join binding a different p2 than the signer");
}

#[test]
fn cancel_by_p1_succeeds() {
    let result = run_entry(
        &open_start(),
        "cancel",
        &|sig| vec![Expr::bytes(sig)],
        Some(&p1().keypair),
        STAKE,
        vec![p2pk_output(&p1().pk, STAKE)],
        0,
    );
    assert_pass(result, "cancel by p1");
}

#[test]
fn cancel_by_others_fails() {
    for (label, player) in [("p2", p2()), ("stranger", stranger())] {
        let result = run_entry(
            &open_start(),
            "cancel",
            &|sig| vec![Expr::bytes(sig)],
            Some(&player.keypair),
            STAKE,
            vec![p2pk_output(&player.pk, STAKE)],
            0,
        );
        assert_fail(result, &format!("cancel by {label}"));
    }
}

#[test]
fn cancel_rejects_live_match() {
    let result = run_entry(
        &live_start(),
        "cancel",
        &|sig| vec![Expr::bytes(sig)],
        Some(&p1().keypair),
        POT,
        vec![p2pk_output(&p1().pk, POT)],
        0,
    );
    assert_fail(result, "cancel on a live match");
}

// --- Dissolve ----------------------------------------------------------------

fn run_dissolve(
    state: &GameState,
    signer: &Player,
    outputs: Vec<TransactionOutput>,
    sequence: u64,
) -> Result<(), TxScriptError> {
    let signer_pk = signer.pk.to_vec();
    run_entry(
        state,
        "dissolve",
        &move |sig| vec![Expr::bytes(sig), Expr::bytes(signer_pk.clone())],
        Some(&signer.keypair),
        POT,
        outputs,
        sequence,
    )
}

fn refund_outputs() -> Vec<TransactionOutput> {
    vec![p2pk_output(&p1().pk, STAKE), p2pk_output(&p2().pk, STAKE)]
}

#[test]
fn dissolve_by_either_player_refunds_both() {
    assert_pass(run_dissolve(&live_start(), p1(), refund_outputs(), 0), "p1 kicking the joiner");
    assert_pass(
        run_dissolve(&live_start(), p2(), refund_outputs(), MOVE_TIMEOUT),
        "p2 leaving the lobby after one move clock",
    );
}

#[test]
fn dissolve_p2_rejects_before_move_clock() {
    // The anti-grief gate: the joiner's exit proves this.age >= move_timeout.
    assert_fail(run_dissolve(&live_start(), p2(), refund_outputs(), 0), "p2 join-and-run dissolve");
    assert_fail(
        run_dissolve(&live_start(), p2(), refund_outputs(), MOVE_TIMEOUT - 1),
        "p2 dissolve one block early",
    );
}

#[test]
fn dissolve_by_stranger_fails() {
    assert_fail(run_dissolve(&live_start(), stranger(), refund_outputs(), 0), "stranger dissolving");
}

#[test]
fn dissolve_rejects_forged_signer_pk() {
    // Claim to be p1 but sign with the stranger's key.
    let result = run_entry(
        &live_start(),
        "dissolve",
        &|sig| vec![Expr::bytes(sig), Expr::bytes(p1().pk.to_vec())],
        Some(&stranger().keypair),
        POT,
        refund_outputs(),
        0,
    );
    assert_fail(result, "dissolve with a signature that doesn't match the claimed pk");
}

#[test]
fn dissolve_rejects_begun_game() {
    let state = play(&live_start(), &[3]);
    assert_fail(run_dissolve(&state, p1(), refund_outputs(), 0), "dissolve after the first disc");
    assert_fail(run_dissolve(&state, p2(), refund_outputs(), MOVE_TIMEOUT), "dissolve after the first disc by p2");
}

#[test]
fn dissolve_rejects_open_match() {
    assert_fail(run_dissolve(&open_start(), p1(), refund_outputs(), 0), "dissolve before a join");
}

#[test]
fn dissolve_rejects_bad_payouts() {
    assert_fail(
        run_dissolve(&live_start(), p1(), vec![p2pk_output(&p1().pk, POT)], 0),
        "signer pocketing the whole pot",
    );
    assert_fail(
        run_dissolve(&live_start(), p1(), vec![p2pk_output(&p1().pk, STAKE + 1), p2pk_output(&p2().pk, STAKE - 1)], 0),
        "unequal refund",
    );
    assert_fail(
        run_dissolve(&live_start(), p1(), vec![p2pk_output(&p2().pk, STAKE), p2pk_output(&p1().pk, STAKE)], 0),
        "refund order swapped",
    );
    assert_fail(
        run_dissolve(&live_start(), p2(), vec![p2pk_output(&p2().pk, STAKE), p2pk_output(&p2().pk, STAKE)], MOVE_TIMEOUT),
        "both refunds to the signer",
    );
}

#[test]
fn dissolve_must_end_the_lineage() {
    let mut outputs = refund_outputs();
    outputs.push(successor_output(&compile_state(&live_start()), 1_000));
    assert_fail(run_dissolve(&live_start(), p1(), outputs, 0), "dissolve smuggling a covenant successor");
}

// --- Moves -------------------------------------------------------------------

#[test]
fn legal_moves_advance_the_game() {
    let mut state = live_start();
    for &col in &[3usize, 3, 0, 6, 1] {
        let signer = mover_player(&state);
        let next = apply_move(&state, col);
        assert_pass(run_move(&state, col as i64, signer, &next, POT), &format!("move in column {col}"));
        state = next;
    }
}

#[test]
fn move_out_of_turn_fails() {
    let state = live_start(); // p1 to move
    let next = apply_move(&state, 0);
    assert_fail(run_move(&state, 0, p2(), &next, POT), "p2 moving on p1's turn");
    assert_fail(run_move(&state, 0, stranger(), &next, POT), "stranger moving");
}

#[test]
fn move_rejects_bad_columns() {
    let state = live_start();
    // The successor is irrelevant: validation fails before it is checked.
    let next = apply_move(&state, 0);
    assert_fail(run_move(&state, 7, p1(), &next, POT), "column 7");
    assert_fail(run_move(&state, -1, p1(), &next, POT), "column -1");
}

#[test]
fn move_rejects_full_column() {
    let state = play(&live_start(), &[0, 0, 0, 0, 0, 0]);
    let next = apply_move(&state, 1); // any successor; the height check trips first
    assert_fail(run_move(&state, 0, p1(), &next, POT), "move in a full column");
}

#[test]
fn move_rejects_tampered_successors() {
    let state = live_start();

    let mut floating = state.clone();
    floating.board[0 * ROWS + 1] = 1; // disc floats above an empty cell
    floating.move_count = 1;
    assert_fail(run_move(&state, 0, p1(), &floating, POT), "floating disc");

    let mut wrong_color = state.clone();
    wrong_color.board[0] = 2; // p1 places p2's disc
    wrong_color.move_count = 1;
    assert_fail(run_move(&state, 0, p1(), &wrong_color, POT), "wrong-color disc");

    let mut no_increment = state.clone();
    no_increment.board[0] = 1; // board advances but move_count stays
    assert_fail(run_move(&state, 0, p1(), &no_increment, POT), "move_count not incremented");

    let mut extra_disc = apply_move(&state, 0);
    extra_disc.board[6 * ROWS] = 1; // a second disc appears elsewhere
    assert_fail(run_move(&state, 0, p1(), &extra_disc, POT), "extra disc smuggled in");

    let mut wrong_column = apply_move(&state, 1); // disc lands in a different column than declared
    wrong_column.move_count = 1;
    assert_fail(run_move(&state, 0, p1(), &wrong_column, POT), "disc in undeclared column");

    let mut clock_stretched = apply_move(&state, 0); // mover grants themselves a slower clock
    clock_stretched.move_timeout = 864_000;
    assert_fail(run_move(&state, 0, p1(), &clock_stretched, POT), "move stretching the clock");

    let mut deadline_deferred = apply_move(&state, 0); // mover defers sudden death
    deadline_deferred.deadline = 9_000_000;
    assert_fail(run_move(&state, 0, p1(), &deadline_deferred, POT), "move deferring the deadline");
}

#[test]
fn move_rejects_pot_theft() {
    let state = live_start();
    let next = apply_move(&state, 0);
    assert_fail(run_move(&state, 0, p1(), &next, POT - 1), "successor output short one sompi");
}

// --- Winning move ------------------------------------------------------------

#[test]
fn winning_move_all_directions() {
    let vertical = play(&live_start(), &[0, 1, 0, 1, 0, 1]);
    assert_pass(run_winning_move(&vertical, 0, (0, 0, N), p1(), false), "vertical win");

    let horizontal = play(&live_start(), &[0, 6, 1, 6, 2, 6]);
    assert_pass(run_winning_move(&horizontal, 3, (0, 0, E), p1(), false), "horizontal win");

    let ne_diag = play(&live_start(), &[0, 1, 1, 2, 2, 3, 2, 3, 3, 5]);
    assert_pass(run_winning_move(&ne_diag, 3, (0, 0, NE), p1(), false), "NE diagonal win");

    let se_diag = play(&live_start(), &[3, 2, 2, 1, 1, 0, 1, 0, 0, 5]);
    assert_pass(run_winning_move(&se_diag, 0, (0, 3, SE), p1(), false), "SE diagonal win");
}

#[test]
fn winning_move_by_p2_succeeds() {
    let state = play(&live_start(), &[6, 0, 5, 0, 4, 0, 6]);
    assert_pass(run_winning_move(&state, 0, (0, 0, N), p2(), false), "p2 vertical win");
}

#[test]
fn unclaimed_win_claimable_later() {
    // P1 completed a vertical four with a plain move, then P2 moved.
    let state = play(&live_start(), &[0, 1, 0, 1, 0, 1, 0, 2]);
    assert_pass(run_winning_move(&state, 5, (0, 0, N), p1(), false), "claiming an old line");
}

#[test]
fn winning_move_rejects_opponent_line() {
    // P2 quietly holds an unclaimed vertical four in column 6; P1 points at it.
    let state = play(&live_start(), &[0, 6, 1, 6, 2, 6, 4, 6]);
    assert_fail(run_winning_move(&state, 5, (6, 0, N), p1(), false), "claiming the opponent's line");
}

#[test]
fn winning_move_rejects_bad_witnesses() {
    let state = play(&live_start(), &[0, 1, 0, 1, 0, 1]);
    assert_fail(run_winning_move(&state, 0, (4, 0, E), p1(), false), "line running off the right edge");
    assert_fail(run_winning_move(&state, 0, (0, 3, N), p1(), false), "line running off the top");
    assert_fail(run_winning_move(&state, 0, (0, 2, SE), p1(), false), "line running below the floor");
    assert_fail(run_winning_move(&state, 0, (-1, 0, E), p1(), false), "negative start column");
    assert_fail(run_winning_move(&state, 0, (0, 0, 4), p1(), false), "unknown direction");
    assert_fail(run_winning_move(&state, 0, (1, 0, N), p1(), false), "line through empty cells");
}

#[test]
fn winning_move_out_of_turn_fails() {
    let state = play(&live_start(), &[0, 1, 0, 1, 0, 1]); // p1 to move
    assert_fail(run_winning_move(&state, 0, (0, 0, N), p2(), false), "p2 claiming on p1's turn");
}

#[test]
fn winning_move_must_end_the_lineage() {
    let state = play(&live_start(), &[0, 1, 0, 1, 0, 1]);
    assert_fail(run_winning_move(&state, 0, (0, 0, N), p1(), true), "terminal claim smuggling a covenant successor");
}

// --- Draw --------------------------------------------------------------------

fn run_draw(state: &GameState, outputs: Vec<TransactionOutput>) -> Result<(), TxScriptError> {
    run_entry(state, "claim_draw", &|_| vec![], None, POT, outputs, 0)
}

#[test]
fn claim_draw_splits_pot() {
    let state = full_board();
    assert_eq!(state.move_count, CELLS as i64);
    let outputs = vec![p2pk_output(&p1().pk, STAKE), p2pk_output(&p2().pk, STAKE)];
    assert_pass(run_draw(&state, outputs), "draw split on a full board");
}

#[test]
fn claim_draw_rejects_partial_boards() {
    let outputs = vec![p2pk_output(&p1().pk, STAKE), p2pk_output(&p2().pk, STAKE)];
    assert_fail(run_draw(&live_start(), outputs.clone()), "draw on an empty board");
    assert_fail(run_draw(&play(&live_start(), &[0, 1, 2]), outputs), "draw at move 3");
}

#[test]
fn claim_draw_rejects_bad_payouts() {
    let state = full_board();
    assert_fail(
        run_draw(&state, vec![p2pk_output(&p1().pk, STAKE + 1), p2pk_output(&p2().pk, STAKE - 1)]),
        "unequal split",
    );
    assert_fail(
        run_draw(&state, vec![p2pk_output(&p1().pk, STAKE), p2pk_output(&p1().pk, STAKE)]),
        "both halves to p1",
    );
    assert_fail(
        run_draw(&state, vec![p2pk_output(&p2().pk, STAKE), p2pk_output(&p1().pk, STAKE)]),
        "payout order swapped",
    );
}

// --- Forfeit -----------------------------------------------------------------

#[test]
fn forfeit_after_timeout_succeeds() {
    // P1 moved; P2 has gone silent. P1 is the waiting player.
    let state = play(&live_start(), &[0]);
    assert_pass(run_forfeit(&state, p1(), MOVE_TIMEOUT), "forfeit at the deadline");
    assert_pass(run_forfeit(&state, p1(), MOVE_TIMEOUT + 500), "forfeit past the deadline");
}

#[test]
fn forfeit_rejects_fresh_game() {
    // Nobody moved yet: p1 may not even know the join happened. The unmoved
    // game is dissolvable by either player, never forfeitable.
    assert_fail(run_forfeit(&live_start(), p2(), MOVE_TIMEOUT), "seizing the pot before the first disc");
}

#[test]
fn forfeit_before_timeout_fails() {
    let state = play(&live_start(), &[0]);
    assert_fail(run_forfeit(&state, p1(), MOVE_TIMEOUT - 1), "forfeit one block early");
    assert_fail(run_forfeit(&state, p1(), 0), "forfeit immediately");
}

#[test]
fn forfeit_by_wrong_party_fails() {
    let state = play(&live_start(), &[0]); // p2 to move, p1 waiting
    assert_fail(run_forfeit(&state, p2(), MOVE_TIMEOUT), "the mover forfeiting their own timeout");
    assert_fail(run_forfeit(&state, stranger(), MOVE_TIMEOUT), "a stranger claiming the pot");
}

#[test]
fn forfeit_rejects_wrong_phases() {
    assert_fail(run_forfeit(&open_start(), p1(), MOVE_TIMEOUT), "forfeit on an open match");
    assert_fail(run_forfeit(&full_board(), p1(), MOVE_TIMEOUT), "forfeit on a full board");
}

#[test]
fn forfeit_uses_the_match_clock() {
    let mut blitz = live_start();
    blitz.move_timeout = MIN_MOVE_TIMEOUT;
    let state = play(&blitz, &[0]);
    assert_pass(run_forfeit(&state, p1(), MIN_MOVE_TIMEOUT as u64), "blitz forfeit at its own deadline");
    assert_fail(run_forfeit(&state, p1(), MIN_MOVE_TIMEOUT as u64 - 1), "blitz forfeit one block early");
}

// --- Sudden death ------------------------------------------------------------

const DEADLINE: u64 = 5_000_000;

fn capped_live() -> GameState {
    let mut s = live_start();
    s.deadline = DEADLINE as i64;
    s
}

fn run_sudden_death(state: &GameState, outputs: Vec<TransactionOutput>, lock_time: u64) -> Result<(), TxScriptError> {
    run_entry_at(state, "sudden_death", &|_| vec![], None, POT, outputs, 0, lock_time)
}

#[test]
fn sudden_death_splits_past_the_deadline() {
    let state = play(&capped_live(), &[3, 3]);
    assert_pass(run_sudden_death(&state, refund_outputs(), DEADLINE), "split at the deadline");
    assert_pass(run_sudden_death(&capped_live(), refund_outputs(), DEADLINE + 10), "lobby cleanup past the deadline");
}

#[test]
fn sudden_death_rejects_early_uncapped_or_open() {
    assert_fail(run_sudden_death(&capped_live(), refund_outputs(), DEADLINE - 1), "split before the deadline");
    assert_fail(run_sudden_death(&live_start(), refund_outputs(), 400_000_000_000), "uncapped game sudden-deathed");
    let mut open = open_start();
    open.deadline = DEADLINE as i64;
    assert_fail(run_sudden_death(&open, vec![p2pk_output(&p1().pk, STAKE)], DEADLINE), "sudden death on an open match");
}

#[test]
fn sudden_death_rejects_bad_payouts() {
    let state = capped_live();
    assert_fail(run_sudden_death(&state, vec![p2pk_output(&p1().pk, POT)], DEADLINE), "whole pot to p1");
    assert_fail(
        run_sudden_death(&state, vec![p2pk_output(&p2().pk, STAKE), p2pk_output(&p1().pk, STAKE)], DEADLINE),
        "split swapped",
    );
    let mut smuggle = refund_outputs();
    smuggle.push(successor_output(&compile_state(&state), 1_000));
    assert_fail(run_sudden_death(&state, smuggle, DEADLINE), "sudden death smuggling a successor");
}
