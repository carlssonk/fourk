// Replays the covenant_tests.rs scenario table against the Argent port of the
// contract (contracts/fourk.ag), driving transactions through argent-runtime's
// TxBuilder instead of hand-built silverscript sig scripts. The artifact is
// the committed build of `argentc build contracts/fourk.ag`:
// contracts/build/artifact.json.
//
// Two families of covenant_tests.rs cases have no analog here because the
// two-actor design makes the states unrepresentable rather than rejected:
//   - join/cancel against a LIVE match (a live match is a different template);
//   - a dirty genesis board (join constructs the match board from a constant,
//     so a lobby has no board to dirty).
//
// Negative cases fail in one of two layers, and both count as rejection: the
// script engine (same as covenant_tests.rs), or argent-runtime's builder when
// the context contradicts the artifact's declared transaction shape. Error
// strings are prefixed "script:" / "build:" so a test can tell them apart.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use argent_runtime::{
    Artifact, ArtifactValue, EntryCall, InputSigScript, TxBuilder, TxContext, args,
    execute_transaction_with_covenants, state,
};
use kaspa_consensus_core::{
    Hash,
    hashing::{
        sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash},
        sighash_type::SIG_HASH_ALL,
    },
    tx::{
        ComputeCommit, CovenantBinding, MutableTransaction, ScriptPublicKey, Transaction,
        TransactionId, TransactionOutpoint, UtxoEntry,
    },
};
use secp256k1::{Keypair, Secp256k1, SecretKey};

const STAKE: u64 = 100_000_000;
const POT: u64 = 2 * STAKE;
/// Mirrors MAX_FEE in contracts/fourk.ag: the ceiling the self-funded terminal
/// doors let a cranker shave from the pot for the fee.
const MAX_FEE: u64 = 2_000_000;
const MOVE_TIMEOUT: i64 = 36_000;
const MIN_MOVE_TIMEOUT: i64 = 600;
const MAX_MOVE_TIMEOUT: i64 = 8_640_000;
const DEADLINE: i64 = 5_000_000;
const DEADLINE_LIMIT: i64 = 500_000_000_000;

const COLS: usize = 7;
const ROWS: usize = 6;
const CELLS: usize = 42;

const E: i64 = 0;
const N: i64 = 1;
const NE: i64 = 2;
const SE: i64 = 3;

// -- keys ------------------------------------------------------------------

fn keypair(seed: u8) -> Keypair {
    let secret = SecretKey::from_slice(&[seed; 32]).expect("seed key");
    Keypair::from_secret_key(&Secp256k1::new(), &secret)
}

fn p1() -> Keypair {
    keypair(1)
}

fn p2() -> Keypair {
    keypair(2)
}

fn stranger() -> Keypair {
    keypair(3)
}

fn funder() -> Keypair {
    keypair(4)
}

fn pk(kp: &Keypair) -> [u8; 32] {
    kp.x_only_public_key().0.serialize()
}

fn sign_input(tx: &MutableTransaction<Transaction>, input_idx: usize, kp: &Keypair) -> Vec<u8> {
    let reused = SigHashReusedValuesUnsync::new();
    let hash = calc_schnorr_signature_hash(&tx.as_verifiable(), input_idx, SIG_HASH_ALL, &reused);
    let message = secp256k1::Message::from_digest(hash.as_bytes());
    let mut encoded = kp.sign_schnorr(message).as_ref().to_vec();
    encoded.push(SIG_HASH_ALL.to_u8());
    encoded
}

// -- game model (mirrors covenant_tests.rs) --------------------------------

#[derive(Clone)]
struct Game {
    board: [u8; CELLS],
    move_count: i64,
}

fn new_game() -> Game {
    Game {
        board: [0; CELLS],
        move_count: 0,
    }
}

fn height(game: &Game, col: usize) -> usize {
    let mut h = 0;
    for row in 0..ROWS {
        if game.board[col * ROWS + row] != 0 {
            h = row + 1;
        }
    }
    h
}

fn mover(game: &Game) -> u8 {
    (game.move_count % 2) as u8
}

fn apply_move(game: &Game, col: usize) -> Game {
    let mut next = game.clone();
    let row = height(game, col);
    assert!(row < ROWS, "column {col} full");
    next.board[col * ROWS + row] = mover(game) + 1;
    next.move_count += 1;
    next
}

fn play(cols: &[usize]) -> Game {
    cols.iter()
        .fold(new_game(), |game, &col| apply_move(&game, col))
}

/// A board built cell-by-cell. The covenant never validates board history, so
/// tests may pose any position with any move_count parity.
fn with_cells(cells: &[(usize, usize, u8)], move_count: i64) -> Game {
    let mut game = new_game();
    for &(col, row, disc) in cells {
        game.board[col * ROWS + row] = disc;
    }
    game.move_count = move_count;
    game
}

fn full_board() -> Game {
    let mut game = new_game();
    for cell in 0..CELLS {
        game.board[cell] = (cell % 2) as u8 + 1;
    }
    game.move_count = CELLS as i64;
    game
}

// -- states ----------------------------------------------------------------

fn lobby_state_with(move_timeout: i64, deadline: i64) -> BTreeMap<String, ArtifactValue> {
    state! {
        p1: pk(&p1()),
        move_timeout: move_timeout,
        deadline: deadline,
    }
}

fn lobby_state() -> BTreeMap<String, ArtifactValue> {
    lobby_state_with(MOVE_TIMEOUT, DEADLINE)
}

fn match_state_full(
    game: &Game,
    p1_pk: [u8; 32],
    p2_pk: [u8; 32],
    move_timeout: i64,
    deadline: i64,
) -> BTreeMap<String, ArtifactValue> {
    state! {
        p1: p1_pk,
        p2: p2_pk,
        board: game.board.to_vec(),
        move_count: game.move_count,
        move_timeout: move_timeout,
        deadline: deadline,
    }
}

fn match_state(game: &Game) -> BTreeMap<String, ArtifactValue> {
    match_state_full(game, pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE)
}

// -- transaction plumbing --------------------------------------------------

fn artifact() -> &'static Artifact {
    static ARTIFACT: OnceLock<Artifact> = OnceLock::new();
    ARTIFACT.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/build/artifact.json"
        );
        let json = std::fs::read_to_string(path)
            .expect("run `argentc build contracts/fourk.ag --out contracts/build` first");
        serde_json::from_str(&json).expect("artifact deserializes")
    })
}

fn covenant_id() -> Hash {
    Hash::from_bytes([0xab; 32])
}

fn outpoint() -> TransactionOutpoint {
    TransactionOutpoint {
        transaction_id: TransactionId::from_bytes([0x11; 32]),
        index: 0,
    }
}

fn p2pk_spk(pk: &[u8; 32]) -> ScriptPublicKey {
    let mut script = Vec::with_capacity(34);
    script.push(0x20);
    script.extend_from_slice(pk);
    script.push(0xac);
    ScriptPublicKey::from_vec(0, script)
}

type RunResult = Result<(), String>;

fn build_and_execute(context: TxContext<'_>, utxo: UtxoEntry) -> RunResult {
    build_executed_tx(context, vec![utxo]).map(|_| ())
}

fn build_executed_tx(context: TxContext<'_>, entries: Vec<UtxoEntry>) -> Result<Transaction, String> {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let mut tx = builder.build(&context).map_err(|e| format!("build: {e}"))?;
    execute_transaction_with_covenants(&mut tx, entries).map_err(|e| format!("script: {e}"))?;
    Ok(tx)
}

// -- multi-input plumbing --------------------------------------------------
//
// Real transactions are never single-input: continuations preserve the pot,
// so fees ride on a plain P2PK wallet input, and terminal spends carry wallet
// change. The funded runners put that funding input BEFORE the covenant,
// pushing the covenant to input index 1 — exercising every compiled
// activeInputIndex path (OpAuthOutputCount / OpAuthOutputIdx / self.value)
// off the index-0 fast case, plus the pinned doors' absolute tx.outputs[0]/[1]
// indexing with a trailing change output present. Signatures are produced by
// per-input callbacks after the builder fixes the full transaction shape —
// the sighash commits to every input's outpoint and every output.

/// Fee money on the funding input. No engine rule inspects fees; the value
/// only has to exist so the wallet spend verifies.
const FEE_FUND: u64 = 5_000_000;

fn funding_outpoint() -> TransactionOutpoint {
    TransactionOutpoint {
        transaction_id: TransactionId::from_bytes([0x12; 32]),
        index: 0,
    }
}

fn funding_utxo() -> UtxoEntry {
    UtxoEntry::new(FEE_FUND, p2pk_spk(&pk(&funder())), 0, false, None)
}

/// Plain P2PK signature script: a single push of the funder's signature,
/// built once the transaction shape is known.
fn funding_sig_script() -> InputSigScript<'static> {
    InputSigScript::with_transaction(|tx, idx| {
        let sig = sign_input(tx, idx, &funder());
        let mut script = Vec::with_capacity(66);
        script.push(sig.len() as u8);
        script.extend_from_slice(&sig);
        script
    })
}

/// The wallet's change, appended AFTER whatever outputs the door pins.
fn change_payout() -> (ScriptPublicKey, u64) {
    (p2pk_spk(&pk(&funder())), FEE_FUND - 1_000)
}

/// Runs one FourkLobby::join. The successor match output is caller-supplied so
/// tests can tamper with it.
fn run_join(
    joiner: Keypair,
    joiner_pk_arg: [u8; 32],
    lobby: BTreeMap<String, ArtifactValue>,
    next: BTreeMap<String, ArtifactValue>,
    in_value: u64,
    out_value: u64,
) -> RunResult {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let utxo = builder
        .covenant_utxo(
            "FourkLobby",
            lobby.clone(),
            in_value,
            0,
            false,
            Some(covenant_id()),
        )
        .map_err(|e| format!("builder: {e}"))?;
    let entry = EntryCall::new("join")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &joiner), joiner_pk_arg]);
    let context = TxContext::new()
        .actor_input("FourkLobby", lobby, entry, outpoint(), utxo.clone(), 0)
        .actor_output(
            "FourkMatch",
            next,
            CovenantBinding::new(0, covenant_id()),
            out_value,
        );
    build_and_execute(context, utxo)
}

fn run_cancel(signer: Keypair) -> RunResult {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let lobby = lobby_state();
    let utxo = builder
        .covenant_utxo(
            "FourkLobby",
            lobby.clone(),
            STAKE,
            0,
            false,
            Some(covenant_id()),
        )
        .map_err(|e| format!("builder: {e}"))?;
    let refund = pk(&signer);
    let entry =
        EntryCall::new("cancel").args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
    let context = TxContext::new()
        .actor_input("FourkLobby", lobby, entry, outpoint(), utxo.clone(), 0)
        .output(p2pk_spk(&refund), None, STAKE);
    build_and_execute(context, utxo)
}

/// Runs one FourkMatch entry. `payouts` become plain outputs in order;
/// `successor` (state, value) adds an authorized FourkMatch output.
fn run_match_entry(
    entry: EntryCall<'_>,
    active: BTreeMap<String, ArtifactValue>,
    in_value: u64,
    sequence: u64,
    lock_time: u64,
    payouts: Vec<(ScriptPublicKey, u64)>,
    successor: Option<(BTreeMap<String, ArtifactValue>, u64)>,
) -> Result<Transaction, String> {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let utxo = builder
        .covenant_utxo(
            "FourkMatch",
            active.clone(),
            in_value,
            0,
            false,
            Some(covenant_id()),
        )
        .map_err(|e| format!("builder: {e}"))?;
    let mut context = TxContext::new().lock_time(lock_time).actor_input(
        "FourkMatch",
        active,
        entry,
        outpoint(),
        utxo.clone(),
        sequence,
    );
    if let Some((next, out_value)) = successor {
        context = context.actor_output(
            "FourkMatch",
            next,
            CovenantBinding::new(0, covenant_id()),
            out_value,
        );
    }
    for (spk, value) in payouts {
        context = context.output(spk, None, value);
    }
    build_executed_tx(context, vec![utxo])
}

/// run_match_entry in the real wallet shape: P2PK funding input at index 0,
/// covenant input at index 1, successor (if any) authorized by input 1.
fn run_match_entry_funded(
    entry: EntryCall<'_>,
    active: BTreeMap<String, ArtifactValue>,
    in_value: u64,
    sequence: u64,
    lock_time: u64,
    payouts: Vec<(ScriptPublicKey, u64)>,
    successor: Option<(BTreeMap<String, ArtifactValue>, u64)>,
) -> RunResult {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let utxo = builder
        .covenant_utxo(
            "FourkMatch",
            active.clone(),
            in_value,
            0,
            false,
            Some(covenant_id()),
        )
        .map_err(|e| format!("builder: {e}"))?;
    let mut context = TxContext::new()
        .lock_time(lock_time)
        .input(funding_outpoint(), funding_utxo(), funding_sig_script(), 0)
        .actor_input("FourkMatch", active, entry, outpoint(), utxo.clone(), sequence);
    if let Some((next, out_value)) = successor {
        context = context.actor_output(
            "FourkMatch",
            next,
            CovenantBinding::new(1, covenant_id()),
            out_value,
        );
    }
    for (spk, value) in payouts {
        context = context.output(spk, None, value);
    }
    build_executed_tx(context, vec![funding_utxo(), utxo]).map(|_| ())
}

/// run_join in the real wallet shape (see run_match_entry_funded).
fn run_join_funded(
    joiner: Keypair,
    next: BTreeMap<String, ArtifactValue>,
    in_value: u64,
    out_value: u64,
) -> RunResult {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let lobby = lobby_state();
    let utxo = builder
        .covenant_utxo(
            "FourkLobby",
            lobby.clone(),
            in_value,
            0,
            false,
            Some(covenant_id()),
        )
        .map_err(|e| format!("builder: {e}"))?;
    let joiner_pk = pk(&joiner);
    let entry = EntryCall::new("join")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &joiner), joiner_pk]);
    let context = TxContext::new()
        .input(funding_outpoint(), funding_utxo(), funding_sig_script(), 0)
        .actor_input("FourkLobby", lobby, entry, outpoint(), utxo.clone(), 0)
        .actor_output(
            "FourkMatch",
            next,
            CovenantBinding::new(1, covenant_id()),
            out_value,
        );
    build_executed_tx(context, vec![funding_utxo(), utxo]).map(|_| ())
}

fn run_move(
    active: &Game,
    col: i64,
    signer: Keypair,
    next: BTreeMap<String, ArtifactValue>,
    out_value: u64,
) -> RunResult {
    let entry =
        EntryCall::new("move").args_with(move |tx, idx| args![sign_input(tx, idx, &signer), col]);
    run_match_entry(
        entry,
        match_state(active),
        POT,
        0,
        0,
        vec![],
        Some((next, out_value)),
    )
    .map(|_| ())
}

fn run_winning_move(
    active: &Game,
    col: i64,
    (wcol, wrow, wdir): (i64, i64, i64),
    signer: Keypair,
    smuggle_successor: bool,
) -> RunResult {
    let winner = pk(&signer);
    let entry = EntryCall::new("winning_move")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), col, wcol, wrow, wdir]);
    let successor = smuggle_successor.then(|| (match_state(active), POT));
    run_match_entry(
        entry,
        match_state(active),
        POT,
        0,
        0,
        vec![(p2pk_spk(&winner), POT)],
        successor,
    )
    .map(|_| ())
}

fn run_dissolve(
    active: &Game,
    signer: Keypair,
    claimed_pk: [u8; 32],
    payouts: Vec<(ScriptPublicKey, u64)>,
    sequence: u64,
    smuggle_successor: bool,
) -> RunResult {
    let entry = EntryCall::new("dissolve")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), claimed_pk]);
    let successor = smuggle_successor.then(|| (match_state(active), POT));
    run_match_entry(
        entry,
        match_state(active),
        POT,
        sequence,
        0,
        payouts,
        successor,
    )
    .map(|_| ())
}

fn run_draw(active: &Game, payouts: Vec<(ScriptPublicKey, u64)>) -> RunResult {
    run_match_entry(
        EntryCall::new("claim_draw"),
        match_state(active),
        POT,
        0,
        0,
        payouts,
        None,
    )
    .map(|_| ())
}

fn run_forfeit(
    active: BTreeMap<String, ArtifactValue>,
    signer: Keypair,
    sequence: u64,
) -> RunResult {
    let claimant = pk(&signer);
    let entry = EntryCall::new("claim_forfeit")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
    run_match_entry(
        entry,
        active,
        POT,
        sequence,
        0,
        vec![(p2pk_spk(&claimant), POT)],
        None,
    )
    .map(|_| ())
}

fn run_sudden_death(
    active: BTreeMap<String, ArtifactValue>,
    payouts: Vec<(ScriptPublicKey, u64)>,
    lock_time: u64,
) -> RunResult {
    run_match_entry(
        EntryCall::new("sudden_death"),
        active,
        POT,
        0,
        lock_time,
        payouts,
        None,
    )
    .map(|_| ())
}

fn half_split() -> Vec<(ScriptPublicKey, u64)> {
    vec![
        (p2pk_spk(&pk(&p1())), POT / 2),
        (p2pk_spk(&pk(&p2())), POT / 2),
    ]
}

fn assert_pass(result: RunResult, label: &str) {
    assert!(
        result.is_ok(),
        "{label}: expected pass, got {:?}",
        result.err()
    );
}

fn assert_fail(result: RunResult, label: &str) {
    assert!(result.is_err(), "{label}: expected rejection");
}

// -- single-input API (used by the wasm browser bindings) ------------------

/// The tx-free single-input API must reproduce byte-for-byte what build()
/// puts in a fully verified transaction. join is the strongest case: its sig
/// script carries compiler-generated template witness arguments.
#[test]
fn single_input_api_matches_build_output() {
    let builder = TxBuilder::new(artifact()).expect("builder");
    let lobby = lobby_state();
    let utxo = builder
        .covenant_utxo(
            "FourkLobby",
            lobby.clone(),
            STAKE,
            0,
            false,
            Some(covenant_id()),
        )
        .expect("lobby utxo");

    let joiner = p2();
    let captured = std::cell::RefCell::new(Vec::new());
    let entry = EntryCall::new("join").args_with(|tx, idx| {
        let sig = sign_input(tx, idx, &joiner);
        *captured.borrow_mut() = sig.clone();
        args![sig, pk(&p2())]
    });
    let context = TxContext::new()
        .actor_input(
            "FourkLobby",
            lobby.clone(),
            entry,
            outpoint(),
            utxo.clone(),
            0,
        )
        .actor_output(
            "FourkMatch",
            match_state(&new_game()),
            CovenantBinding::new(0, covenant_id()),
            POT,
        );
    let tx = builder.build(&context).expect("join builds and verifies");

    let reproduced = builder
        .entry_signature_script(
            "FourkLobby",
            lobby.clone(),
            "join",
            args![captured.borrow().clone(), pk(&p2())],
        )
        .expect("single-input sig script");
    assert_eq!(
        tx.inputs[0].signature_script, reproduced,
        "sig script mismatch"
    );

    let spk = builder
        .actor_script_public_key("FourkLobby", lobby.clone())
        .expect("lobby spk");
    assert_eq!(utxo.script_public_key, spk, "lock script mismatch");

    let redeem = builder
        .actor_redeem_script("FourkLobby", lobby)
        .expect("lobby redeem script");
    assert_eq!(
        spk,
        kaspa_txscript::pay_to_script_hash_script(&redeem),
        "redeem/spk mismatch"
    );
}

// -- join ------------------------------------------------------------------

#[test]
fn join_succeeds_and_doubles_pot() {
    assert_pass(
        run_join(
            p2(),
            pk(&p2()),
            lobby_state(),
            match_state(&new_game()),
            STAKE,
            POT,
        ),
        "join",
    );
}

#[test]
fn join_rejects_unmatched_stake() {
    assert_fail(
        run_join(
            p2(),
            pk(&p2()),
            lobby_state(),
            match_state(&new_game()),
            STAKE,
            STAKE,
        ),
        "same stake",
    );
    assert_fail(
        run_join(
            p2(),
            pk(&p2()),
            lobby_state(),
            match_state(&new_game()),
            STAKE,
            POT - 1,
        ),
        "pot minus one",
    );
}

#[test]
fn join_rejects_p1_self_join() {
    let next = match_state_full(&new_game(), pk(&p1()), pk(&p1()), MOVE_TIMEOUT, DEADLINE);
    assert_fail(
        run_join(p1(), pk(&p1()), lobby_state(), next, STAKE, POT),
        "self join",
    );
}

#[test]
fn join_rejects_trap_timeout() {
    let trap = lobby_state_with(MIN_MOVE_TIMEOUT - 1, DEADLINE);
    let trap_next = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&p2()),
        MIN_MOVE_TIMEOUT - 1,
        DEADLINE,
    );
    assert_fail(
        run_join(p2(), pk(&p2()), trap, trap_next, STAKE, POT),
        "trap timeout",
    );

    let floor = lobby_state_with(MIN_MOVE_TIMEOUT, DEADLINE);
    let floor_next = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&p2()),
        MIN_MOVE_TIMEOUT,
        DEADLINE,
    );
    assert_pass(
        run_join(p2(), pk(&p2()), floor, floor_next, STAKE, POT),
        "clock at floor",
    );
}

#[test]
fn join_rejects_hostage_timeout() {
    let hostage = lobby_state_with(MAX_MOVE_TIMEOUT + 1, DEADLINE);
    let hostage_next = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&p2()),
        MAX_MOVE_TIMEOUT + 1,
        DEADLINE,
    );
    assert_fail(
        run_join(p2(), pk(&p2()), hostage, hostage_next, STAKE, POT),
        "hostage timeout",
    );

    let ceiling = lobby_state_with(MAX_MOVE_TIMEOUT, DEADLINE);
    let ceiling_next = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&p2()),
        MAX_MOVE_TIMEOUT,
        DEADLINE,
    );
    assert_pass(
        run_join(p2(), pk(&p2()), ceiling, ceiling_next, STAKE, POT),
        "clock at ceiling",
    );
}

#[test]
fn join_rejects_uncapped_or_clock_flipping_deadline() {
    // deadline == 0 would leave the pot strandable by two vanished players.
    let uncapped = lobby_state_with(MOVE_TIMEOUT, 0);
    let uncapped_next = match_state_full(&new_game(), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, 0);
    assert_fail(
        run_join(p2(), pk(&p2()), uncapped, uncapped_next, STAKE, POT),
        "uncapped game",
    );

    // At/past the consensus lock-time threshold a "DAA score" reads as a
    // unix-ms timestamp.
    let flipped = lobby_state_with(MOVE_TIMEOUT, DEADLINE_LIMIT);
    let flipped_next =
        match_state_full(&new_game(), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE_LIMIT);
    assert_fail(
        run_join(p2(), pk(&p2()), flipped, flipped_next, STAKE, POT),
        "timestamp-flavored deadline",
    );

    let edge = lobby_state_with(MOVE_TIMEOUT, DEADLINE_LIMIT - 1);
    let edge_next =
        match_state_full(&new_game(), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE_LIMIT - 1);
    assert_pass(
        run_join(p2(), pk(&p2()), edge, edge_next, STAKE, POT),
        "deadline just under the limit",
    );
}

#[test]
fn join_preserves_timing_fields() {
    let stretched = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&p2()),
        MOVE_TIMEOUT + 1,
        DEADLINE,
    );
    assert_fail(
        run_join(p2(), pk(&p2()), lobby_state(), stretched, STAKE, POT),
        "stretched move clock",
    );

    let deferred = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&p2()),
        MOVE_TIMEOUT,
        DEADLINE + 1,
    );
    assert_fail(
        run_join(p2(), pk(&p2()), lobby_state(), deferred, STAKE, POT),
        "deferred deadline",
    );
}

#[test]
fn join_rejects_tampered_successor() {
    let replaced_p1 = match_state_full(
        &new_game(),
        pk(&stranger()),
        pk(&p2()),
        MOVE_TIMEOUT,
        DEADLINE,
    );
    assert_fail(
        run_join(p2(), pk(&p2()), lobby_state(), replaced_p1, STAKE, POT),
        "replaced p1",
    );

    let foreign_p2 = match_state_full(
        &new_game(),
        pk(&p1()),
        pk(&stranger()),
        MOVE_TIMEOUT,
        DEADLINE,
    );
    assert_fail(
        run_join(p2(), pk(&p2()), lobby_state(), foreign_p2, STAKE, POT),
        "p2 is not the signer",
    );

    let dirty_board = match_state(&play(&[3]));
    assert_fail(
        run_join(p2(), pk(&p2()), lobby_state(), dirty_board, STAKE, POT),
        "dirty successor board",
    );

    let mut skipped_count = new_game();
    skipped_count.move_count = 1;
    assert_fail(
        run_join(
            p2(),
            pk(&p2()),
            lobby_state(),
            match_state(&skipped_count),
            STAKE,
            POT,
        ),
        "nonzero move count",
    );
}

// -- cancel ----------------------------------------------------------------

#[test]
fn cancel_by_p1_succeeds() {
    assert_pass(run_cancel(p1()), "cancel");
}

#[test]
fn cancel_by_others_fails() {
    assert_fail(run_cancel(p2()), "cancel by p2");
    assert_fail(run_cancel(stranger()), "cancel by stranger");
}

#[test]
fn cancel_must_end_the_lineage() {
    // `emits none` compiles to OpAuthOutputCount == 0: a cancel that smuggles
    // out an authorized lobby successor would resurrect the seat with p1's
    // refund gone.
    let result = (|| -> RunResult {
        let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
        let lobby = lobby_state();
        let utxo = builder
            .covenant_utxo(
                "FourkLobby",
                lobby.clone(),
                STAKE,
                0,
                false,
                Some(covenant_id()),
            )
            .map_err(|e| format!("builder: {e}"))?;
        let signer = p1();
        let refund = pk(&signer);
        let entry =
            EntryCall::new("cancel").args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
        let context = TxContext::new()
            .actor_input("FourkLobby", lobby.clone(), entry, outpoint(), utxo.clone(), 0)
            .output(p2pk_spk(&refund), None, STAKE)
            .actor_output(
                "FourkLobby",
                lobby,
                CovenantBinding::new(0, covenant_id()),
                1_000,
            );
        build_and_execute(context, utxo)
    })();
    assert_fail(result, "cancel smuggling a covenant successor");
}

// -- dissolve --------------------------------------------------------------

#[test]
fn dissolve_by_either_player_refunds_both() {
    let fresh = new_game();
    assert_pass(
        run_dissolve(&fresh, p1(), pk(&p1()), half_split(), 0, false),
        "p1 kick",
    );
    assert_pass(
        run_dissolve(
            &fresh,
            p2(),
            pk(&p2()),
            half_split(),
            MOVE_TIMEOUT as u64,
            false,
        ),
        "p2 exit",
    );
}

#[test]
fn dissolve_p2_rejects_before_move_clock() {
    let fresh = new_game();
    assert_fail(
        run_dissolve(&fresh, p2(), pk(&p2()), half_split(), 0, false),
        "p2 instant exit",
    );
    assert_fail(
        run_dissolve(
            &fresh,
            p2(),
            pk(&p2()),
            half_split(),
            MOVE_TIMEOUT as u64 - 1,
            false,
        ),
        "p2 one block early",
    );
}

#[test]
fn dissolve_by_stranger_fails() {
    assert_fail(
        run_dissolve(
            &new_game(),
            stranger(),
            pk(&stranger()),
            half_split(),
            0,
            false,
        ),
        "stranger",
    );
}

#[test]
fn dissolve_rejects_forged_signer_pk() {
    assert_fail(
        run_dissolve(&new_game(), stranger(), pk(&p1()), half_split(), 0, false),
        "forged pk",
    );
}

#[test]
fn dissolve_rejects_begun_game() {
    let begun = play(&[3]);
    assert_fail(
        run_dissolve(&begun, p1(), pk(&p1()), half_split(), 0, false),
        "p1 after first move",
    );
    assert_fail(
        run_dissolve(
            &begun,
            p2(),
            pk(&p2()),
            half_split(),
            MOVE_TIMEOUT as u64,
            false,
        ),
        "p2 after first move",
    );
}

#[test]
fn dissolve_rejects_bad_payouts() {
    let fresh = new_game();
    let p1_spk = p2pk_spk(&pk(&p1()));
    let p2_spk = p2pk_spk(&pk(&p2()));
    assert_fail(
        run_dissolve(
            &fresh,
            p1(),
            pk(&p1()),
            vec![(p1_spk.clone(), POT)],
            0,
            false,
        ),
        "whole pot to signer",
    );
    assert_fail(
        run_dissolve(
            &fresh,
            p1(),
            pk(&p1()),
            vec![(p1_spk.clone(), POT / 2 + 1), (p2_spk.clone(), POT / 2 - 1)],
            0,
            false,
        ),
        "unequal split",
    );
    assert_fail(
        run_dissolve(
            &fresh,
            p1(),
            pk(&p1()),
            vec![(p2_spk, POT / 2), (p1_spk.clone(), POT / 2)],
            0,
            false,
        ),
        "swapped order",
    );
    assert_fail(
        run_dissolve(
            &fresh,
            p1(),
            pk(&p1()),
            vec![(p1_spk.clone(), POT / 2), (p1_spk, POT / 2)],
            0,
            false,
        ),
        "both halves to signer",
    );
}

#[test]
fn dissolve_must_end_the_lineage() {
    assert_fail(
        run_dissolve(&new_game(), p1(), pk(&p1()), half_split(), 0, true),
        "smuggled successor",
    );
}

// -- move ------------------------------------------------------------------

#[test]
fn legal_moves_advance_the_game() {
    let mut game = new_game();
    for &col in &[3usize, 3, 0, 6, 1] {
        let signer = if mover(&game) == 0 { p1() } else { p2() };
        let next = apply_move(&game, col);
        assert_pass(
            run_move(&game, col as i64, signer, match_state(&next), POT),
            &format!("move col {col}"),
        );
        game = next;
    }
}

#[test]
fn move_out_of_turn_fails() {
    let fresh = new_game();
    let next = apply_move(&fresh, 3);
    assert_fail(
        run_move(&fresh, 3, p2(), match_state(&next), POT),
        "p2 on p1 turn",
    );
    assert_fail(
        run_move(&fresh, 3, stranger(), match_state(&next), POT),
        "stranger",
    );
}

#[test]
fn move_rejects_bad_columns() {
    let fresh = new_game();
    let next = apply_move(&fresh, 3);
    assert_fail(run_move(&fresh, 7, p1(), match_state(&next), POT), "col 7");
    assert_fail(
        run_move(&fresh, -1, p1(), match_state(&next), POT),
        "col -1",
    );
}

#[test]
fn move_rejects_full_column() {
    let full_col: Vec<(usize, usize, u8)> =
        (0..ROWS).map(|row| (3, row, (row % 2) as u8 + 1)).collect();
    let game = with_cells(&full_col, 6);
    let mut next = game.clone();
    next.move_count += 1;
    assert_fail(
        run_move(&game, 3, p1(), match_state(&next), POT),
        "full column",
    );
}

#[test]
fn move_rejects_tampered_successors() {
    let fresh = new_game();

    let floating = with_cells(&[(3, 1, 1)], 1);
    assert_fail(
        run_move(&fresh, 3, p1(), match_state(&floating), POT),
        "floating disc",
    );

    let wrong_color = with_cells(&[(3, 0, 2)], 1);
    assert_fail(
        run_move(&fresh, 3, p1(), match_state(&wrong_color), POT),
        "wrong color",
    );

    let unincremented = with_cells(&[(3, 0, 1)], 0);
    assert_fail(
        run_move(&fresh, 3, p1(), match_state(&unincremented), POT),
        "no move_count bump",
    );

    let extra_disc = with_cells(&[(3, 0, 1), (0, 0, 1)], 1);
    assert_fail(
        run_move(&fresh, 3, p1(), match_state(&extra_disc), POT),
        "extra disc",
    );

    let wrong_column = with_cells(&[(0, 0, 1)], 1);
    assert_fail(
        run_move(&fresh, 3, p1(), match_state(&wrong_column), POT),
        "disc in undeclared column",
    );

    let good = apply_move(&fresh, 3);
    let stretched = match_state_full(&good, pk(&p1()), pk(&p2()), MOVE_TIMEOUT + 1, DEADLINE);
    assert_fail(
        run_move(&fresh, 3, p1(), stretched, POT),
        "stretched move clock",
    );

    let deferred = match_state_full(&good, pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE + 1);
    assert_fail(
        run_move(&fresh, 3, p1(), deferred, POT),
        "deferred deadline",
    );
}

#[test]
fn move_rejects_pot_theft() {
    let fresh = new_game();
    let next = apply_move(&fresh, 3);
    assert_fail(
        run_move(&fresh, 3, p1(), match_state(&next), POT - 1),
        "skimmed pot",
    );
}

// -- winning_move ----------------------------------------------------------

#[test]
fn winning_move_all_directions() {
    // Vertical: p1 stacks col 0 while p2 stacks col 1.
    let vertical = play(&[0, 1, 0, 1, 0, 1]);
    assert_pass(
        run_winning_move(&vertical, 0, (0, 0, N), p1(), false),
        "north",
    );

    // Horizontal: p1 lays row 0 while p2 stacks col 6.
    let horizontal = play(&[0, 6, 1, 6, 2, 6]);
    assert_pass(
        run_winning_move(&horizontal, 3, (0, 0, E), p1(), false),
        "east",
    );

    // NE diagonal (0,0)->(3,3): p1 on the staircase, p2 filler below it.
    let ne = with_cells(
        &[
            (0, 0, 1),
            (1, 1, 1),
            (2, 2, 1),
            (1, 0, 2),
            (2, 0, 2),
            (2, 1, 2),
            (3, 0, 2),
            (3, 1, 2),
            (3, 2, 2),
        ],
        8,
    );
    assert_pass(
        run_winning_move(&ne, 3, (0, 0, NE), p1(), false),
        "north-east",
    );

    // SE diagonal (0,3)->(3,0): p1 on the staircase, p2 filler below it.
    let se = with_cells(
        &[
            (3, 0, 1),
            (2, 1, 1),
            (1, 2, 1),
            (0, 0, 2),
            (0, 1, 2),
            (0, 2, 2),
            (1, 0, 2),
            (1, 1, 2),
            (2, 0, 2),
        ],
        8,
    );
    assert_pass(
        run_winning_move(&se, 0, (0, 3, SE), p1(), false),
        "south-east",
    );
}

#[test]
fn winning_move_by_p2_succeeds() {
    let game = with_cells(
        &[
            (5, 0, 2),
            (5, 1, 2),
            (5, 2, 2),
            (0, 0, 1),
            (1, 0, 1),
            (2, 0, 1),
            (4, 0, 1),
        ],
        7,
    );
    assert_pass(
        run_winning_move(&game, 5, (5, 0, N), p2(), false),
        "p2 vertical win",
    );
}

#[test]
fn unclaimed_win_claimable_later() {
    // p1 completed (0,0)-(3,0) plies ago; the claim rides a later legal move.
    let game = with_cells(
        &[
            (0, 0, 1),
            (1, 0, 1),
            (2, 0, 1),
            (3, 0, 1),
            (0, 1, 2),
            (1, 1, 2),
            (2, 1, 2),
            (4, 0, 2),
        ],
        8,
    );
    assert_pass(
        run_winning_move(&game, 6, (0, 0, E), p1(), false),
        "late claim",
    );
}

#[test]
fn winning_move_rejects_opponent_line() {
    let game = with_cells(
        &[
            (0, 1, 2),
            (1, 1, 2),
            (2, 1, 2),
            (3, 1, 2),
            (0, 0, 1),
            (1, 0, 1),
            (2, 0, 1),
            (3, 0, 1),
        ],
        8,
    );
    // p1 (mover) points at p2's completed row above theirs.
    assert_fail(
        run_winning_move(&game, 6, (0, 1, E), p1(), false),
        "opponent line",
    );
}

#[test]
fn winning_move_rejects_bad_witnesses() {
    let vertical = play(&[0, 1, 0, 1, 0, 1]);
    assert_fail(
        run_winning_move(&vertical, 0, (0, 3, N), p1(), false),
        "off the top",
    );
    assert_fail(
        run_winning_move(&vertical, 0, (5, 0, E), p1(), false),
        "off the right edge",
    );
    assert_fail(
        run_winning_move(&vertical, 0, (0, 2, SE), p1(), false),
        "below the floor",
    );
    assert_fail(
        run_winning_move(&vertical, 0, (-1, 0, E), p1(), false),
        "negative wcol",
    );
    assert_fail(
        run_winning_move(&vertical, 0, (0, 0, 4), p1(), false),
        "direction out of table",
    );
    assert_fail(
        run_winning_move(&vertical, 0, (4, 0, N), p1(), false),
        "line through empty cells",
    );
}

#[test]
fn winning_move_out_of_turn_fails() {
    let vertical = play(&[0, 1, 0, 1, 0, 1]);
    assert_fail(
        run_winning_move(&vertical, 0, (0, 0, N), p2(), false),
        "p2 claiming p1 line",
    );
}

#[test]
fn winning_move_must_end_the_lineage() {
    let vertical = play(&[0, 1, 0, 1, 0, 1]);
    assert_fail(
        run_winning_move(&vertical, 0, (0, 0, N), p1(), true),
        "smuggled successor",
    );
}

// -- claim_draw ------------------------------------------------------------

#[test]
fn claim_draw_splits_pot() {
    assert_pass(run_draw(&full_board(), half_split()), "draw split");
}

#[test]
fn claim_draw_rejects_partial_boards() {
    assert_fail(run_draw(&new_game(), half_split()), "empty board");
    assert_fail(run_draw(&play(&[3, 3, 0]), half_split()), "move three");
}

#[test]
fn claim_draw_rejects_bad_payouts() {
    let p1_spk = p2pk_spk(&pk(&p1()));
    let p2_spk = p2pk_spk(&pk(&p2()));
    assert_fail(
        run_draw(
            &full_board(),
            vec![(p1_spk.clone(), POT / 2 + 1), (p2_spk.clone(), POT / 2 - 1)],
        ),
        "unequal split",
    );
    assert_fail(
        run_draw(
            &full_board(),
            vec![(p1_spk.clone(), POT / 2), (p1_spk.clone(), POT / 2)],
        ),
        "both to p1",
    );
    assert_fail(
        run_draw(&full_board(), vec![(p2_spk, POT / 2), (p1_spk, POT / 2)]),
        "swapped order",
    );
}

#[test]
fn claim_draw_must_end_the_lineage() {
    assert_fail(
        run_match_entry(
            EntryCall::new("claim_draw"),
            match_state(&full_board()),
            POT,
            0,
            0,
            half_split(),
            Some((match_state(&full_board()), 1_000)),
        )
        .map(|_| ()),
        "draw smuggling a covenant successor",
    );
}

// -- claim_forfeit ---------------------------------------------------------

#[test]
fn forfeit_after_timeout_succeeds() {
    // After one move p2 is on the clock, so p1 is the waiting claimant.
    let begun = play(&[3]);
    assert_pass(
        run_forfeit(match_state(&begun), p1(), MOVE_TIMEOUT as u64),
        "at the deadline",
    );
    assert_pass(
        run_forfeit(match_state(&begun), p1(), MOVE_TIMEOUT as u64 + 1),
        "past the deadline",
    );
}

#[test]
fn forfeit_rejects_fresh_game() {
    assert_fail(
        run_forfeit(match_state(&new_game()), p2(), MOVE_TIMEOUT as u64),
        "unmoved game",
    );
}

#[test]
fn forfeit_before_timeout_fails() {
    let begun = play(&[3]);
    assert_fail(
        run_forfeit(match_state(&begun), p1(), MOVE_TIMEOUT as u64 - 1),
        "one block early",
    );
    assert_fail(run_forfeit(match_state(&begun), p1(), 0), "instant");
}

#[test]
fn forfeit_by_wrong_party_fails() {
    let begun = play(&[3]);
    assert_fail(
        run_forfeit(match_state(&begun), p2(), MOVE_TIMEOUT as u64),
        "the mover themself",
    );
    assert_fail(
        run_forfeit(match_state(&begun), stranger(), MOVE_TIMEOUT as u64),
        "stranger",
    );
}

#[test]
fn forfeit_rejects_full_board() {
    // move_count 42 makes p2 the waiting party; the full board is the only gate.
    assert_fail(
        run_forfeit(match_state(&full_board()), p2(), MOVE_TIMEOUT as u64),
        "full board",
    );
}

#[test]
fn forfeit_uses_the_match_clock() {
    let begun = play(&[3]);
    let blitz = match_state_full(&begun, pk(&p1()), pk(&p2()), MIN_MOVE_TIMEOUT, DEADLINE);
    assert_pass(
        run_forfeit(blitz.clone(), p1(), MIN_MOVE_TIMEOUT as u64),
        "blitz at its deadline",
    );
    assert_fail(
        run_forfeit(blitz, p1(), MIN_MOVE_TIMEOUT as u64 - 1),
        "blitz one block early",
    );
}

#[test]
fn claim_forfeit_must_end_the_lineage() {
    let begun = play(&[3]);
    let signer = p1();
    let claimant = pk(&signer);
    let entry = EntryCall::new("claim_forfeit")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
    assert_fail(
        run_match_entry(
            entry,
            match_state(&begun),
            POT,
            MOVE_TIMEOUT as u64,
            0,
            vec![(p2pk_spk(&claimant), POT)],
            Some((match_state(&begun), 1_000)),
        )
        .map(|_| ()),
        "forfeit smuggling a covenant successor",
    );
}

// -- sudden_death ----------------------------------------------------------

#[test]
fn sudden_death_splits_past_the_deadline() {
    assert_pass(
        run_sudden_death(match_state(&play(&[3, 3])), half_split(), DEADLINE as u64),
        "at the cap",
    );
    assert_pass(
        run_sudden_death(
            match_state(&play(&[3, 3])),
            half_split(),
            DEADLINE as u64 + 1,
        ),
        "past the cap",
    );
    assert_pass(
        run_sudden_death(match_state(&new_game()), half_split(), DEADLINE as u64),
        "unmoved game",
    );
}

#[test]
fn sudden_death_rejects_early_or_uncapped() {
    assert_fail(
        run_sudden_death(
            match_state(&play(&[3, 3])),
            half_split(),
            DEADLINE as u64 - 1,
        ),
        "one block early",
    );
    let uncapped = match_state_full(&play(&[3, 3]), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, 0);
    assert_fail(
        run_sudden_death(uncapped, half_split(), u32::MAX as u64),
        "uncapped game",
    );
}

#[test]
fn sudden_death_rejects_bad_payouts() {
    let p1_spk = p2pk_spk(&pk(&p1()));
    let p2_spk = p2pk_spk(&pk(&p2()));
    let active = match_state(&play(&[3, 3]));
    assert_fail(
        run_sudden_death(active.clone(), vec![(p1_spk.clone(), POT)], DEADLINE as u64),
        "whole pot to p1",
    );
    assert_fail(
        run_sudden_death(
            active,
            vec![(p2_spk, POT / 2), (p1_spk, POT / 2)],
            DEADLINE as u64,
        ),
        "swapped split",
    );
}

#[test]
fn sudden_death_must_end_the_lineage() {
    assert_fail(
        run_match_entry(
            EntryCall::new("sudden_death"),
            match_state(&play(&[3, 3])),
            POT,
            0,
            DEADLINE as u64,
            half_split(),
            Some((match_state(&play(&[3, 3])), 1_000)),
        )
        .map(|_| ()),
        "sudden death smuggling a covenant successor",
    );
}

// -- multi-input transaction shapes ----------------------------------------
//
// Funded variants of every classic door (run_match_entry_funded /
// run_join_funded): a P2PK wallet input at index 0 pays fees, the covenant
// sits at input index 1, and the pinned-payout doors carry a trailing wallet
// change output. Same pass/fail outcomes as the single-input tests above.

fn run_move_funded(
    active: &Game,
    col: i64,
    signer: Keypair,
    next: BTreeMap<String, ArtifactValue>,
    out_value: u64,
) -> RunResult {
    let entry =
        EntryCall::new("move").args_with(move |tx, idx| args![sign_input(tx, idx, &signer), col]);
    run_match_entry_funded(
        entry,
        match_state(active),
        POT,
        0,
        0,
        vec![],
        Some((next, out_value)),
    )
}

#[test]
fn funded_join_succeeds_and_doubles_pot() {
    assert_pass(
        run_join_funded(p2(), match_state(&new_game()), STAKE, POT),
        "funded join",
    );
    assert_fail(
        run_join_funded(p2(), match_state(&new_game()), STAKE, POT - 1),
        "funded join one sompi short",
    );
}

#[test]
fn funded_move_advances_the_game() {
    let fresh = new_game();
    let next = apply_move(&fresh, 3);
    assert_pass(
        run_move_funded(&fresh, 3, p1(), match_state(&next), POT),
        "funded move",
    );
    assert_fail(
        run_move_funded(&fresh, 3, p1(), match_state(&next), POT - 1),
        "funded move skimming the pot",
    );
    assert_fail(
        run_move_funded(&fresh, 3, p2(), match_state(&next), POT),
        "funded move out of turn",
    );
}

#[test]
fn funded_winning_move_pays_the_winner() {
    let vertical = play(&[0, 1, 0, 1, 0, 1]);
    let winner = pk(&p1());
    let entry = |smuggle: bool| {
        let signer = p1();
        let entry = EntryCall::new("winning_move")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), 0i64, 0i64, 0i64, N]);
        let successor = smuggle.then(|| (match_state(&vertical), 1_000));
        run_match_entry_funded(
            entry,
            match_state(&vertical),
            POT,
            0,
            0,
            vec![(p2pk_spk(&winner), POT)],
            successor,
        )
    };
    assert_pass(entry(false), "funded vertical win");
    // The smuggled successor authorizes input 1, where the covenant actually
    // sits — the compiled OpAuthOutputCount(activeInputIndex) must see it.
    assert_fail(entry(true), "funded terminal claim smuggling a successor");
}

#[test]
fn funded_forfeit_honors_the_clock() {
    let begun = play(&[3]);
    let claimant = pk(&p1());
    let run = |sequence: u64| {
        let signer = p1();
        let entry = EntryCall::new("claim_forfeit")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
        run_match_entry_funded(
            entry,
            match_state(&begun),
            POT,
            sequence,
            0,
            vec![(p2pk_spk(&claimant), POT), change_payout()],
            None,
        )
    };
    assert_pass(run(MOVE_TIMEOUT as u64), "funded forfeit at the deadline");
    assert_fail(run(MOVE_TIMEOUT as u64 - 1), "funded forfeit one block early");
}

// The pinned-payout doors are self-funded and single-input (MAX_FEE in
// contracts/fourk.ag): one match UTXO in, the fee taken from the pot, and any
// second input rejected. That single-input rule is the anti-aggregation guard
// — two same-stake matches can no longer be swept in one transaction so their
// shared pinned split leaks the surplus pot as change. An equal split stays
// mandatory; the only freedom is a bounded fee shaved equally from both halves.

fn self_funded_split(fee: u64) -> Vec<(ScriptPublicKey, u64)> {
    let each = (POT - fee) / 2;
    vec![
        (p2pk_spk(&pk(&p1())), each),
        (p2pk_spk(&pk(&p2())), each),
    ]
}

#[test]
fn dissolve_is_single_input_self_funded() {
    assert_pass(
        run_dissolve(&new_game(), p1(), pk(&p1()), self_funded_split(40_000), 0, false),
        "self-funded dissolve with a real fee",
    );
    assert_fail(
        run_dissolve(&new_game(), p1(), pk(&p1()), self_funded_split(3 * MAX_FEE), 0, false),
        "fee above the ceiling starves the split",
    );
}

#[test]
fn claim_draw_is_single_input_self_funded() {
    assert_pass(
        run_draw(&full_board(), self_funded_split(40_000)),
        "self-funded draw with a real fee",
    );
    assert_fail(
        run_draw(&full_board(), self_funded_split(3 * MAX_FEE)),
        "fee above the ceiling starves the split",
    );
}

#[test]
fn sudden_death_is_single_input_self_funded() {
    assert_pass(
        run_sudden_death(match_state(&play(&[3, 3])), self_funded_split(40_000), DEADLINE as u64),
        "self-funded sudden death with a real fee",
    );
    assert_fail(
        run_sudden_death(match_state(&play(&[3, 3])), self_funded_split(3 * MAX_FEE), DEADLINE as u64),
        "fee above the ceiling starves the split",
    );
}

#[test]
fn pinned_doors_reject_pot_aggregation() {
    // The theft the single-input rule closes: two full-board matches between
    // the same players at the same stake, swept in ONE claim_draw transaction.
    // Both inputs' pinned split checks the same outputs[0]/[1], so the second
    // pot could leave as a trailing output to the attacker. The transaction now
    // carries two covenant inputs and is rejected (claim_draw_splits_pot is the
    // single-input baseline that passes).
    let builder = TxBuilder::new(artifact()).expect("builder");
    let state = match_state(&full_board());
    let utxo_a = builder
        .covenant_utxo("FourkMatch", state.clone(), POT, 0, false, Some(covenant_id()))
        .expect("utxo a");
    let utxo_b = builder
        .covenant_utxo("FourkMatch", state.clone(), POT, 0, false, Some(covenant_id()))
        .expect("utxo b");
    let outpoint_b = TransactionOutpoint {
        transaction_id: TransactionId::from_bytes([0x13; 32]),
        index: 0,
    };
    let attacker = p2pk_spk(&pk(&funder()));
    let context = TxContext::new()
        .actor_input("FourkMatch", state.clone(), EntryCall::new("claim_draw"), outpoint(), utxo_a.clone(), 0)
        .actor_input("FourkMatch", state.clone(), EntryCall::new("claim_draw"), outpoint_b, utxo_b.clone(), 0)
        .output(p2pk_spk(&pk(&p1())), None, POT / 2)
        .output(p2pk_spk(&pk(&p2())), None, POT / 2)
        .output(attacker, None, POT);
    assert!(
        build_executed_tx(context, vec![utxo_a, utxo_b]).is_err(),
        "aggregating two match pots in one transaction must be rejected",
    );
}

// -- compute budget --------------------------------------------------------

/// Measures the compute budget the engine actually charges per classic entry,
/// at each door's worst case. The app declares covenantBudget: 12 for classic
/// covenant inputs (app/src/shared/modes/classic/engine.ts) — a node rejects
/// any spend whose declared budget is below what execution uses, so every
/// door must fit 12 or the app's transactions bounce off mainnet. Same
/// measurement technique as simul_tests.rs compute_budget_probe.
#[test]
fn compute_budget_probe() {
    /// The app's declared per-input budget for classic covenant spends.
    const CLASSIC_COVENANT_BUDGET: u16 = 12;

    let budget_of = |tx: &Transaction, input_idx: usize| match tx.inputs[input_idx].compute_commit {
        ComputeCommit::ComputeBudget(b) => b.value(),
        _ => panic!("v1 input carries a compute budget"),
    };
    let mut measured: Vec<(&str, u16)> = Vec::new();

    // join (FourkLobby -> FourkMatch successor)
    {
        let builder = TxBuilder::new(artifact()).expect("builder");
        let lobby = lobby_state();
        let utxo = builder
            .covenant_utxo(
                "FourkLobby",
                lobby.clone(),
                STAKE,
                0,
                false,
                Some(covenant_id()),
            )
            .expect("lobby utxo");
        let joiner = p2();
        let entry = EntryCall::new("join")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &joiner), pk(&p2())]);
        let context = TxContext::new()
            .actor_input("FourkLobby", lobby, entry, outpoint(), utxo.clone(), 0)
            .actor_output(
                "FourkMatch",
                match_state(&new_game()),
                CovenantBinding::new(0, covenant_id()),
                POT,
            );
        let tx = build_executed_tx(context, vec![utxo]).expect("join executes");
        measured.push(("join", budget_of(&tx, 0)));
    }

    // 41 discs, only column 6 open (height 5): the height scan and the
    // successor board splice at their dearest. move_count 41 puts p2 on turn.
    let nearly_full = {
        let mut cells = Vec::new();
        for col in 0..COLS {
            let rows = if col == 6 { 5 } else { ROWS };
            for row in 0..rows {
                cells.push((col, row, ((col + row) % 2) as u8 + 1));
            }
        }
        with_cells(&cells, 41)
    };

    // move on the nearly-full board
    {
        let next = apply_move(&nearly_full, 6);
        let signer = p2();
        let entry = EntryCall::new("move")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), 6i64]);
        let tx = run_match_entry(
            entry,
            match_state(&nearly_full),
            POT,
            0,
            0,
            vec![],
            Some((match_state(&next), POT)),
        )
        .expect("move executes");
        measured.push(("move", budget_of(&tx, 0)));
    }

    // winning_move on a nearly-full board with the SE diagonal witness — the
    // height scan, board splice, and the dearest direction arm all at once.
    // P1's SE line (0,3)->(3,0) sits in the fill; move_count 40 puts p1 on
    // turn to play the one open column and point at the old line.
    {
        let mut cells = Vec::new();
        for col in 0..COLS {
            let rows = if col == 6 { 5 } else { ROWS };
            for row in 0..rows {
                let se_line = (col, row) == (0, 3)
                    || (col, row) == (1, 2)
                    || (col, row) == (2, 1)
                    || (col, row) == (3, 0);
                cells.push((col, row, if se_line { 1 } else { 2 }));
            }
        }
        let board = with_cells(&cells, 40);
        let winner = pk(&p1());
        let signer = p1();
        let entry = EntryCall::new("winning_move")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), 6i64, 0i64, 3i64, SE]);
        let tx = run_match_entry(
            entry,
            match_state(&board),
            POT,
            0,
            0,
            vec![(p2pk_spk(&winner), POT)],
            None,
        )
        .expect("winning_move executes");
        measured.push(("winning_move", budget_of(&tx, 0)));
    }

    // claim_draw on the full board
    {
        let tx = run_match_entry(
            EntryCall::new("claim_draw"),
            match_state(&full_board()),
            POT,
            0,
            0,
            half_split(),
            None,
        )
        .expect("claim_draw executes");
        measured.push(("claim_draw", budget_of(&tx, 0)));
    }

    // claim_forfeit on a begun game
    {
        let signer = p1();
        let claimant = pk(&p1());
        let entry = EntryCall::new("claim_forfeit")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
        let tx = run_match_entry(
            entry,
            match_state(&play(&[3])),
            POT,
            MOVE_TIMEOUT as u64,
            0,
            vec![(p2pk_spk(&claimant), POT)],
            None,
        )
        .expect("claim_forfeit executes");
        measured.push(("claim_forfeit", budget_of(&tx, 0)));
    }

    // dissolve (p2's exit takes the age-gate branch too; p1's kick suffices —
    // the branch is two extra compares, both bodies execute the same pins)
    {
        let signer = p1();
        let claimed = pk(&p1());
        let entry = EntryCall::new("dissolve")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), claimed]);
        let tx = run_match_entry(
            entry,
            match_state(&new_game()),
            POT,
            0,
            0,
            half_split(),
            None,
        )
        .expect("dissolve executes");
        measured.push(("dissolve", budget_of(&tx, 0)));
    }

    // sudden_death
    {
        let tx = run_match_entry(
            EntryCall::new("sudden_death"),
            match_state(&play(&[3, 3])),
            POT,
            0,
            DEADLINE as u64,
            half_split(),
            None,
        )
        .expect("sudden_death executes");
        measured.push(("sudden_death", budget_of(&tx, 0)));
    }

    println!("measured budgets: {measured:?}");
    for (entry, budget) in measured {
        assert!(
            budget <= CLASSIC_COVENANT_BUDGET,
            "{entry} needs budget {budget}, app declares {CLASSIC_COVENANT_BUDGET}"
        );
    }
}
