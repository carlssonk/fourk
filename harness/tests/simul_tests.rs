// Drives the fourk-mode actors (FourkSimulLobby / FourkSimul in
// contracts/fourk.ag) through argent-runtime's TxBuilder against the real
// script engine — the simul counterpart of argent_tests.rs, mirroring the
// adversarial matrix of test/simul.rules.test.ts plus the covenant-only
// cases (tampered successors, smuggled outputs, pot theft, pinned-payout
// tampering) that have no TS analog.
//
// Same two rejection layers as argent_tests.rs: the script engine
// ("script:") or the builder refusing a context that contradicts the
// artifact's declared shape ("build:"). Both count as rejection.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use argent_runtime::{
    Artifact, ArtifactValue, EntryCall, TxBuilder, TxContext, args,
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
const MOVE_TIMEOUT: i64 = 36_000;
const MIN_MOVE_TIMEOUT: i64 = 600;
const MAX_MOVE_TIMEOUT: i64 = 8_640_000;
const DEADLINE: i64 = 5_000_000;
const DEADLINE_LIMIT: i64 = 500_000_000_000;

const ROWS: usize = 6;
const CELLS: usize = 42;

const E: i64 = 0;
const N: i64 = 1;

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

fn pk(kp: &Keypair) -> [u8; 32] {
    kp.x_only_public_key().0.serialize()
}

fn player_kp(player: usize) -> Keypair {
    if player == 0 { p1() } else { p2() }
}

fn sign_input(tx: &MutableTransaction<Transaction>, input_idx: usize, kp: &Keypair) -> Vec<u8> {
    let reused = SigHashReusedValuesUnsync::new();
    let hash = calc_schnorr_signature_hash(&tx.as_verifiable(), input_idx, SIG_HASH_ALL, &reused);
    let message = secp256k1::Message::from_digest(hash.as_bytes());
    let mut encoded = kp.sign_schnorr(message).as_ref().to_vec();
    encoded.push(SIG_HASH_ALL.to_u8());
    encoded
}

// -- commitments (mirrors src/simul/hash.ts) -------------------------------

fn commitment(player: usize, col: usize, salt: &[u8; 32]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(34);
    preimage.push(player as u8);
    preimage.push(col as u8);
    preimage.extend_from_slice(salt);
    let hash = blake2b_simd::Params::new()
        .hash_length(32)
        .to_state()
        .update(&preimage)
        .finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(hash.as_bytes());
    out
}

fn salt(player: usize, round: i64) -> [u8; 32] {
    [0x10 * (player as u8 + 1) + (round % 16) as u8; 32]
}

// -- simul game model (mirrors src/simul/state.ts + rules.ts) --------------

#[derive(Clone)]
struct Simul {
    board: [u8; CELLS],
    round: i64,
    commit1: [u8; 32],
    commit2: [u8; 32],
    reveal1: i64,
    reveal2: i64,
    pending_win: i64,
}

fn new_simul() -> Simul {
    Simul {
        board: [0; CELLS],
        round: 0,
        commit1: [0; 32],
        commit2: [0; 32],
        reveal1: 0,
        reveal2: 0,
        pending_win: 0,
    }
}

fn height(board: &[u8; CELLS], col: usize) -> usize {
    let mut h = 0;
    for row in 0..ROWS {
        if board[col * ROWS + row] != 0 {
            h = row + 1;
        }
    }
    h
}

/// A board built cell-by-cell — the covenant never validates history.
fn with_cells(cells: &[(usize, usize, u8)], round: i64) -> Simul {
    let mut s = new_simul();
    for &(col, row, disc) in cells {
        s.board[col * ROWS + row] = disc;
    }
    s.round = round;
    s
}

fn full_board_simul() -> Simul {
    let mut s = new_simul();
    for cell in 0..CELLS {
        s.board[cell] = (cell % 2) as u8 + 1;
    }
    s.round = 21;
    s
}

fn with_commit(s: &Simul, player: usize, col: usize) -> Simul {
    let mut next = s.clone();
    let h = commitment(player, col, &salt(player, s.round));
    if player == 0 {
        next.commit1 = h;
    } else {
        next.commit2 = h;
    }
    next
}

fn committed_both(s: &Simul, col_p1: usize, col_p2: usize) -> Simul {
    with_commit(&with_commit(s, 0, col_p1), 1, col_p2)
}

/// Player's first reveal: zero their commitment slot, record col + 1.
fn with_reveal(s: &Simul, player: usize, col: usize) -> Simul {
    let mut next = s.clone();
    if player == 0 {
        next.commit1 = [0; 32];
        next.reveal1 = col as i64 + 1;
    } else {
        next.commit2 = [0; 32];
        next.reveal2 = col as i64 + 1;
    }
    next
}

/// The honest resolution successor: both discs on the pre-round board,
/// round bumped, all slots cleared. `col_a` was revealed first by `player_a`.
fn resolved(s: &Simul, col_a: usize, player_a: usize, col_b: usize) -> Simul {
    let player_b = 1 - player_a;
    let mut board = s.board;
    if col_a != col_b {
        board[col_a * ROWS + height(&s.board, col_a)] = player_a as u8 + 1;
        board[col_b * ROWS + height(&s.board, col_b)] = player_b as u8 + 1;
    } else {
        let h = height(&s.board, col_a);
        let lower = (s.round % 2) as usize;
        board[col_a * ROWS + h] = lower as u8 + 1;
        if h + 1 < ROWS {
            board[col_a * ROWS + h + 1] = (1 - lower) as u8 + 1;
        }
    }
    Simul {
        board,
        round: s.round + 1,
        commit1: [0; 32],
        commit2: [0; 32],
        reveal1: 0,
        reveal2: 0,
        pending_win: 0,
    }
}

/// claim_win's canonical pending successor: round slots zeroed, the
/// witnessed color parked in pending_win, everything else untouched.
fn with_pending(s: &Simul, color: i64) -> Simul {
    Simul {
        commit1: [0; 32],
        commit2: [0; 32],
        reveal1: 0,
        reveal2: 0,
        pending_win: color,
        ..s.clone()
    }
}

// -- states ----------------------------------------------------------------

fn simul_lobby_state_with(move_timeout: i64, deadline: i64) -> BTreeMap<String, ArtifactValue> {
    state! {
        p1: pk(&p1()),
        move_timeout: move_timeout,
        deadline: deadline,
    }
}

fn simul_lobby_state() -> BTreeMap<String, ArtifactValue> {
    simul_lobby_state_with(MOVE_TIMEOUT, DEADLINE)
}

fn simul_state_full(
    s: &Simul,
    p1_pk: [u8; 32],
    p2_pk: [u8; 32],
    move_timeout: i64,
    deadline: i64,
) -> BTreeMap<String, ArtifactValue> {
    state! {
        p1: p1_pk,
        p2: p2_pk,
        board: s.board.to_vec(),
        round: s.round,
        commit1: s.commit1.to_vec(),
        commit2: s.commit2.to_vec(),
        reveal1: s.reveal1,
        reveal2: s.reveal2,
        pending_win: s.pending_win,
        move_timeout: move_timeout,
        deadline: deadline,
    }
}

fn simul_state(s: &Simul) -> BTreeMap<String, ArtifactValue> {
    simul_state_full(s, pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE)
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
    Hash::from_bytes([0xcd; 32])
}

fn outpoint() -> TransactionOutpoint {
    TransactionOutpoint {
        transaction_id: TransactionId::from_bytes([0x22; 32]),
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
    build_executed_tx(context, utxo).map(|_| ())
}

fn build_executed_tx(context: TxContext<'_>, utxo: UtxoEntry) -> Result<Transaction, String> {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let mut tx = builder.build(&context).map_err(|e| format!("build: {e}"))?;
    execute_transaction_with_covenants(&mut tx, vec![utxo]).map_err(|e| format!("script: {e}"))?;
    Ok(tx)
}

fn run_simul_join(
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
            "FourkSimulLobby",
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
        .actor_input("FourkSimulLobby", lobby, entry, outpoint(), utxo.clone(), 0)
        .actor_output(
            "FourkSimul",
            next,
            CovenantBinding::new(0, covenant_id()),
            out_value,
        );
    build_and_execute(context, utxo)
}

fn run_simul_cancel(signer: Keypair) -> RunResult {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let lobby = simul_lobby_state();
    let utxo = builder
        .covenant_utxo(
            "FourkSimulLobby",
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
        .actor_input("FourkSimulLobby", lobby, entry, outpoint(), utxo.clone(), 0)
        .output(p2pk_spk(&refund), None, STAKE);
    build_and_execute(context, utxo)
}

/// Runs one FourkSimul entry (the run_match_entry analog).
fn run_simul_entry(
    entry: EntryCall<'_>,
    active: BTreeMap<String, ArtifactValue>,
    sequence: u64,
    lock_time: u64,
    payouts: Vec<(ScriptPublicKey, u64)>,
    successor: Option<(BTreeMap<String, ArtifactValue>, u64)>,
) -> Result<Transaction, String> {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let utxo = builder
        .covenant_utxo(
            "FourkSimul",
            active.clone(),
            POT,
            0,
            false,
            Some(covenant_id()),
        )
        .map_err(|e| format!("builder: {e}"))?;
    let mut context = TxContext::new().lock_time(lock_time).actor_input(
        "FourkSimul",
        active,
        entry,
        outpoint(),
        utxo.clone(),
        sequence,
    );
    if let Some((next, out_value)) = successor {
        context = context.actor_output(
            "FourkSimul",
            next,
            CovenantBinding::new(0, covenant_id()),
            out_value,
        );
    }
    for (spk, value) in payouts {
        context = context.output(spk, None, value);
    }
    build_executed_tx(context, utxo)
}

fn run_commit(
    active: &Simul,
    signer: Keypair,
    claimed_pk: [u8; 32],
    hash: [u8; 32],
    next: BTreeMap<String, ArtifactValue>,
    out_value: u64,
) -> RunResult {
    let entry = EntryCall::new("commit")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), claimed_pk, hash]);
    run_simul_entry(entry, simul_state(active), 0, 0, vec![], Some((next, out_value))).map(|_| ())
}

fn run_reveal_like(
    entrypoint: &'static str,
    active: &Simul,
    signer: Keypair,
    claimed_pk: [u8; 32],
    col: i64,
    salt_arg: [u8; 32],
    next: BTreeMap<String, ArtifactValue>,
    out_value: u64,
) -> RunResult {
    let entry = EntryCall::new(entrypoint).args_with(move |tx, idx| {
        args![sign_input(tx, idx, &signer), claimed_pk, col, salt_arg]
    });
    run_simul_entry(entry, simul_state(active), 0, 0, vec![], Some((next, out_value))).map(|_| ())
}

/// Honest reveal by `player`: correct salt, honest successor.
fn run_reveal(active: &Simul, player: usize, col: usize) -> RunResult {
    run_reveal_like(
        "reveal",
        active,
        player_kp(player),
        pk(&player_kp(player)),
        col as i64,
        salt(player, active.round),
        simul_state(&with_reveal(active, player, col)),
        POT,
    )
}

/// Honest resolve by `player` (the opponent revealed first).
fn run_resolve(active: &Simul, player: usize, col: usize) -> RunResult {
    let other = 1 - player;
    let other_col = if other == 0 {
        active.reveal1 - 1
    } else {
        active.reveal2 - 1
    } as usize;
    run_reveal_like(
        "resolve",
        active,
        player_kp(player),
        pk(&player_kp(player)),
        col as i64,
        salt(player, active.round),
        simul_state(&resolved(active, other_col, other, col)),
        POT,
    )
}

/// claim_win with a caller-supplied successor, for tampering tests.
fn run_claim_win_into(
    active: &Simul,
    (wcol, wrow, wdir): (i64, i64, i64),
    signer: Keypair,
    successor: Option<(BTreeMap<String, ArtifactValue>, u64)>,
) -> RunResult {
    let entry = EntryCall::new("claim_win")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), wcol, wrow, wdir]);
    run_simul_entry(entry, simul_state(active), 0, 0, vec![], successor).map(|_| ())
}

/// Honest claim_win: emits the canonical pending successor for the
/// witnessed cell's color, preserving the pot.
fn run_claim_win(active: &Simul, witness: (i64, i64, i64), signer: Keypair) -> RunResult {
    // A bogus witness (out of bounds, empty cell) has no meaningful
    // successor color; any pending value works because the spend must fail
    // before the successor is checked.
    let in_bounds = (0..7).contains(&witness.0) && (0..ROWS as i64).contains(&witness.1);
    let color = if in_bounds {
        active.board[(witness.0 as usize) * ROWS + witness.1 as usize] as i64
    } else {
        0
    };
    let color = if color == 0 { 1 } else { color };
    run_claim_win_into(
        active,
        witness,
        signer,
        Some((simul_state(&with_pending(active, color)), POT)),
    )
}

fn run_sweep_win(active: &Simul, signer: Keypair, sequence: u64) -> RunResult {
    let claimant = pk(&signer);
    let entry = EntryCall::new("sweep_win")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
    run_simul_entry(
        entry,
        simul_state(active),
        sequence,
        0,
        vec![(p2pk_spk(&claimant), POT)],
        None,
    )
    .map(|_| ())
}

fn run_claim_split(
    active: &Simul,
    w1: (i64, i64, i64),
    w2: (i64, i64, i64),
    payouts: Vec<(ScriptPublicKey, u64)>,
) -> RunResult {
    let entry = EntryCall::new("claim_split")
        .args_with(move |_tx, _idx| args![w1.0, w1.1, w1.2, w2.0, w2.1, w2.2]);
    run_simul_entry(entry, simul_state(active), 0, 0, payouts, None).map(|_| ())
}

fn run_simul_draw(active: &Simul, sequence: u64, payouts: Vec<(ScriptPublicKey, u64)>) -> RunResult {
    run_simul_entry(
        EntryCall::new("claim_draw"),
        simul_state(active),
        sequence,
        0,
        payouts,
        None,
    )
    .map(|_| ())
}

fn run_claim_timeout(active: &Simul, signer: Keypair, sequence: u64) -> RunResult {
    let claimant = pk(&signer);
    let entry = EntryCall::new("claim_timeout")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
    run_simul_entry(
        entry,
        simul_state(active),
        sequence,
        0,
        vec![(p2pk_spk(&claimant), POT)],
        None,
    )
    .map(|_| ())
}

fn run_split_timeout(
    active: &Simul,
    sequence: u64,
    payouts: Vec<(ScriptPublicKey, u64)>,
) -> RunResult {
    run_simul_entry(
        EntryCall::new("split_timeout"),
        simul_state(active),
        sequence,
        0,
        payouts,
        None,
    )
    .map(|_| ())
}

fn run_simul_dissolve(
    active: &Simul,
    signer: Keypair,
    claimed_pk: [u8; 32],
    payouts: Vec<(ScriptPublicKey, u64)>,
    sequence: u64,
    smuggle_successor: bool,
) -> RunResult {
    let entry = EntryCall::new("dissolve")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), claimed_pk]);
    let successor = smuggle_successor.then(|| (simul_state(active), POT));
    run_simul_entry(entry, simul_state(active), sequence, 0, payouts, successor).map(|_| ())
}

fn run_simul_sudden_death(
    active: BTreeMap<String, ArtifactValue>,
    sequence: u64,
    payouts: Vec<(ScriptPublicKey, u64)>,
    lock_time: u64,
) -> RunResult {
    run_simul_entry(
        EntryCall::new("sudden_death"),
        active,
        sequence,
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

/// The 32-byte hash argument is the new ABI shape the wasm bindings carry:
/// the single-input API must reproduce a verified commit byte-for-byte.
#[test]
fn simul_single_input_commit_matches_build_output() {
    let builder = TxBuilder::new(artifact()).expect("builder");
    let active = new_simul();
    let state = simul_state(&active);
    let utxo = builder
        .covenant_utxo(
            "FourkSimul",
            state.clone(),
            POT,
            0,
            false,
            Some(covenant_id()),
        )
        .expect("simul utxo");

    let signer = p1();
    let hash = commitment(0, 3, &salt(0, 0));
    let captured = std::cell::RefCell::new(Vec::new());
    let entry = EntryCall::new("commit").args_with(|tx, idx| {
        let sig = sign_input(tx, idx, &signer);
        *captured.borrow_mut() = sig.clone();
        args![sig, pk(&p1()), hash]
    });
    let context = TxContext::new()
        .actor_input(
            "FourkSimul",
            state.clone(),
            entry,
            outpoint(),
            utxo.clone(),
            0,
        )
        .actor_output(
            "FourkSimul",
            simul_state(&with_commit(&active, 0, 3)),
            CovenantBinding::new(0, covenant_id()),
            POT,
        );
    let tx = builder.build(&context).expect("commit builds and verifies");

    let reproduced = builder
        .entry_signature_script(
            "FourkSimul",
            state.clone(),
            "commit",
            args![captured.borrow().clone(), pk(&p1()), hash],
        )
        .expect("single-input sig script");
    assert_eq!(
        tx.inputs[0].signature_script, reproduced,
        "sig script mismatch"
    );

    let spk = builder
        .actor_script_public_key("FourkSimul", state.clone())
        .expect("simul spk");
    assert_eq!(utxo.script_public_key, spk, "lock script mismatch");
}

// -- join / cancel ---------------------------------------------------------

#[test]
fn simul_join_succeeds_and_doubles_pot() {
    assert_pass(
        run_simul_join(
            p2(),
            pk(&p2()),
            simul_lobby_state(),
            simul_state(&new_simul()),
            STAKE,
            POT,
        ),
        "simul join",
    );
}

#[test]
fn simul_join_rejects_unmatched_stake() {
    assert_fail(
        run_simul_join(
            p2(),
            pk(&p2()),
            simul_lobby_state(),
            simul_state(&new_simul()),
            STAKE,
            POT - 1,
        ),
        "pot minus one",
    );
}

#[test]
fn simul_join_rejects_self_join() {
    let next = simul_state_full(&new_simul(), pk(&p1()), pk(&p1()), MOVE_TIMEOUT, DEADLINE);
    assert_fail(
        run_simul_join(p1(), pk(&p1()), simul_lobby_state(), next, STAKE, POT),
        "self join",
    );
}

#[test]
fn simul_join_rejects_trap_timeout() {
    let trap = simul_lobby_state_with(MIN_MOVE_TIMEOUT - 1, DEADLINE);
    let trap_next = simul_state_full(
        &new_simul(),
        pk(&p1()),
        pk(&p2()),
        MIN_MOVE_TIMEOUT - 1,
        DEADLINE,
    );
    assert_fail(
        run_simul_join(p2(), pk(&p2()), trap, trap_next, STAKE, POT),
        "trap timeout",
    );

    let floor = simul_lobby_state_with(MIN_MOVE_TIMEOUT, DEADLINE);
    let floor_next = simul_state_full(
        &new_simul(),
        pk(&p1()),
        pk(&p2()),
        MIN_MOVE_TIMEOUT,
        DEADLINE,
    );
    assert_pass(
        run_simul_join(p2(), pk(&p2()), floor, floor_next, STAKE, POT),
        "clock at floor",
    );
}

#[test]
fn simul_join_rejects_hostage_timeout() {
    let hostage = simul_lobby_state_with(MAX_MOVE_TIMEOUT + 1, DEADLINE);
    let hostage_next = simul_state_full(
        &new_simul(),
        pk(&p1()),
        pk(&p2()),
        MAX_MOVE_TIMEOUT + 1,
        DEADLINE,
    );
    assert_fail(
        run_simul_join(p2(), pk(&p2()), hostage, hostage_next, STAKE, POT),
        "hostage timeout",
    );

    let ceiling = simul_lobby_state_with(MAX_MOVE_TIMEOUT, DEADLINE);
    let ceiling_next = simul_state_full(
        &new_simul(),
        pk(&p1()),
        pk(&p2()),
        MAX_MOVE_TIMEOUT,
        DEADLINE,
    );
    assert_pass(
        run_simul_join(p2(), pk(&p2()), ceiling, ceiling_next, STAKE, POT),
        "clock at ceiling",
    );
}

#[test]
fn simul_join_rejects_uncapped_or_clock_flipping_deadline() {
    // deadline == 0 is a strandable pot: claim_timeout pays one SPECIFIC
    // player (who may be the vanished one) and split_timeout needs symmetric
    // silence, so sudden_death is the only guaranteed exit.
    let uncapped = simul_lobby_state_with(MOVE_TIMEOUT, 0);
    let uncapped_next = simul_state_full(&new_simul(), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, 0);
    assert_fail(
        run_simul_join(p2(), pk(&p2()), uncapped, uncapped_next, STAKE, POT),
        "uncapped game",
    );

    let flipped = simul_lobby_state_with(MOVE_TIMEOUT, DEADLINE_LIMIT);
    let flipped_next =
        simul_state_full(&new_simul(), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE_LIMIT);
    assert_fail(
        run_simul_join(p2(), pk(&p2()), flipped, flipped_next, STAKE, POT),
        "timestamp-flavored deadline",
    );

    let edge = simul_lobby_state_with(MOVE_TIMEOUT, DEADLINE_LIMIT - 1);
    let edge_next =
        simul_state_full(&new_simul(), pk(&p1()), pk(&p2()), MOVE_TIMEOUT, DEADLINE_LIMIT - 1);
    assert_pass(
        run_simul_join(p2(), pk(&p2()), edge, edge_next, STAKE, POT),
        "deadline just under the limit",
    );
}

#[test]
fn simul_join_rejects_tampered_successor() {
    let dirty = with_cells(&[(3, 0, 1)], 0);
    assert_fail(
        run_simul_join(
            p2(),
            pk(&p2()),
            simul_lobby_state(),
            simul_state(&dirty),
            STAKE,
            POT,
        ),
        "dirty board",
    );

    let mut skipped = new_simul();
    skipped.round = 1;
    assert_fail(
        run_simul_join(
            p2(),
            pk(&p2()),
            simul_lobby_state(),
            simul_state(&skipped),
            STAKE,
            POT,
        ),
        "nonzero round",
    );

    let preloaded = with_commit(&new_simul(), 0, 3);
    assert_fail(
        run_simul_join(
            p2(),
            pk(&p2()),
            simul_lobby_state(),
            simul_state(&preloaded),
            STAKE,
            POT,
        ),
        "preloaded commitment",
    );

    let mut prerevealed = new_simul();
    prerevealed.reveal2 = 4;
    assert_fail(
        run_simul_join(
            p2(),
            pk(&p2()),
            simul_lobby_state(),
            simul_state(&prerevealed),
            STAKE,
            POT,
        ),
        "preloaded reveal",
    );
}

#[test]
fn simul_cancel_by_p1_only() {
    assert_pass(run_simul_cancel(p1()), "cancel");
    assert_fail(run_simul_cancel(p2()), "cancel by p2");
    assert_fail(run_simul_cancel(stranger()), "cancel by stranger");
}

// -- dissolve --------------------------------------------------------------

#[test]
fn simul_dissolve_by_either_player_refunds_both() {
    let fresh = new_simul();
    assert_pass(
        run_simul_dissolve(&fresh, p1(), pk(&p1()), half_split(), 0, false),
        "p1 kick",
    );
    assert_pass(
        run_simul_dissolve(
            &fresh,
            p2(),
            pk(&p2()),
            half_split(),
            MOVE_TIMEOUT as u64,
            false,
        ),
        "p2 exit",
    );
    assert_fail(
        run_simul_dissolve(&fresh, p2(), pk(&p2()), half_split(), 0, false),
        "p2 instant exit",
    );
    assert_fail(
        run_simul_dissolve(
            &fresh,
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
fn simul_dissolve_rejects_begun_game() {
    let committed = with_commit(&new_simul(), 0, 3);
    assert_fail(
        run_simul_dissolve(&committed, p1(), pk(&p1()), half_split(), 0, false),
        "after a commitment",
    );
    let mut played = new_simul();
    played.round = 1;
    assert_fail(
        run_simul_dissolve(&played, p1(), pk(&p1()), half_split(), 0, false),
        "after a round",
    );
}

#[test]
fn simul_dissolve_rejects_bad_payouts_and_smuggling() {
    let fresh = new_simul();
    let p1_spk = p2pk_spk(&pk(&p1()));
    let p2_spk = p2pk_spk(&pk(&p2()));
    assert_fail(
        run_simul_dissolve(&fresh, p1(), pk(&p1()), vec![(p1_spk.clone(), POT)], 0, false),
        "whole pot to signer",
    );
    assert_fail(
        run_simul_dissolve(
            &fresh,
            p1(),
            pk(&p1()),
            vec![(p2_spk, POT / 2), (p1_spk, POT / 2)],
            0,
            false,
        ),
        "swapped order",
    );
    assert_fail(
        run_simul_dissolve(&fresh, p1(), pk(&p1()), half_split(), 0, true),
        "smuggled successor",
    );
}

// -- commit ----------------------------------------------------------------

#[test]
fn commit_either_order_advances() {
    let fresh = new_simul();
    let h1 = commitment(0, 3, &salt(0, 0));
    assert_pass(
        run_commit(
            &fresh,
            p1(),
            pk(&p1()),
            h1,
            simul_state(&with_commit(&fresh, 0, 3)),
            POT,
        ),
        "p1 first",
    );
    let h2 = commitment(1, 5, &salt(1, 0));
    assert_pass(
        run_commit(
            &fresh,
            p2(),
            pk(&p2()),
            h2,
            simul_state(&with_commit(&fresh, 1, 5)),
            POT,
        ),
        "p2 first",
    );
    let one = with_commit(&fresh, 0, 3);
    assert_pass(
        run_commit(
            &one,
            p2(),
            pk(&p2()),
            h2,
            simul_state(&committed_both(&fresh, 3, 5)),
            POT,
        ),
        "p2 second",
    );
}

#[test]
fn commit_rejects_copying_the_opponent() {
    // P2 mirrors P1's visible commitment value to echo whatever column P1
    // reveals. The commit door rejects a hash equal to the opponent's slot, and
    // the player byte in the preimage makes a copied hash unopenable regardless.
    let fresh = new_simul();
    let h1 = commitment(0, 3, &salt(0, 0));
    let after_p1 = with_commit(&fresh, 0, 3);
    assert_eq!(after_p1.commit1, h1);
    let mut copied = after_p1.clone();
    copied.commit2 = h1;
    assert_fail(
        run_commit(&after_p1, p2(), pk(&p2()), h1, simul_state(&copied), POT),
        "p2 copies p1's commitment",
    );
}

#[test]
fn commit_rejects_wrong_phase_and_parties() {
    let fresh = new_simul();
    let one = with_commit(&fresh, 0, 3);
    let h = commitment(0, 4, &salt(0, 0));
    assert_fail(
        run_commit(&one, p1(), pk(&p1()), h, simul_state(&one), POT),
        "double commit",
    );
    assert_fail(
        run_commit(
            &fresh,
            stranger(),
            pk(&stranger()),
            h,
            simul_state(&with_commit(&fresh, 0, 4)),
            POT,
        ),
        "stranger",
    );
    assert_fail(
        run_commit(
            &fresh,
            stranger(),
            pk(&p1()),
            h,
            simul_state(&with_commit(&fresh, 0, 4)),
            POT,
        ),
        "forged pk",
    );
    assert_fail(
        run_commit(
            &fresh,
            p1(),
            pk(&p1()),
            [0; 32],
            simul_state(&fresh),
            POT,
        ),
        "zero hash",
    );

    let half = with_reveal(&committed_both(&fresh, 3, 5), 0, 3);
    assert_fail(
        run_commit(
            &half,
            p1(),
            pk(&p1()),
            h,
            simul_state(&half),
            POT,
        ),
        "commit during reveal phase",
    );

    let full = full_board_simul();
    assert_fail(
        run_commit(
            &full,
            p1(),
            pk(&p1()),
            h,
            simul_state(&with_commit(&full, 0, 0)),
            POT,
        ),
        "commit on full board",
    );
}

#[test]
fn commit_rejects_tampered_successors() {
    let fresh = new_simul();
    let h = commitment(0, 3, &salt(0, 0));

    // P1 signs but the successor loads P2's slot.
    let mut wrong_slot = fresh.clone();
    wrong_slot.commit2 = h;
    assert_fail(
        run_commit(&fresh, p1(), pk(&p1()), h, simul_state(&wrong_slot), POT),
        "wrong slot",
    );

    let mut board_edit = with_commit(&fresh, 0, 3);
    board_edit.board[0] = 1;
    assert_fail(
        run_commit(&fresh, p1(), pk(&p1()), h, simul_state(&board_edit), POT),
        "board edited",
    );

    let mut round_bump = with_commit(&fresh, 0, 3);
    round_bump.round = 1;
    assert_fail(
        run_commit(&fresh, p1(), pk(&p1()), h, simul_state(&round_bump), POT),
        "round bumped",
    );

    let mut sneak_reveal = with_commit(&fresh, 0, 3);
    sneak_reveal.reveal2 = 6;
    assert_fail(
        run_commit(&fresh, p1(), pk(&p1()), h, simul_state(&sneak_reveal), POT),
        "smuggled reveal",
    );

    assert_fail(
        run_commit(
            &fresh,
            p1(),
            pk(&p1()),
            h,
            simul_state(&with_commit(&fresh, 0, 3)),
            POT - 1,
        ),
        "skimmed pot",
    );
}

// -- reveal ----------------------------------------------------------------

#[test]
fn reveal_both_players_advance() {
    let both = committed_both(&new_simul(), 3, 5);
    assert_pass(run_reveal(&both, 0, 3), "p1 reveals");
    assert_pass(run_reveal(&both, 1, 5), "p2 reveals");
}

#[test]
fn reveal_rejects_wrong_preimage_and_phase() {
    let fresh = new_simul();
    let both = committed_both(&fresh, 3, 5);

    // Wrong column and wrong salt against the correct commitment.
    assert_fail(
        run_reveal_like(
            "reveal",
            &both,
            p1(),
            pk(&p1()),
            4,
            salt(0, 0),
            simul_state(&with_reveal(&both, 0, 4)),
            POT,
        ),
        "wrong column",
    );
    assert_fail(
        run_reveal_like(
            "reveal",
            &both,
            p1(),
            pk(&p1()),
            3,
            salt(0, 1),
            simul_state(&with_reveal(&both, 0, 3)),
            POT,
        ),
        "wrong salt",
    );

    let one = with_commit(&fresh, 0, 3);
    assert_fail(
        run_reveal_like(
            "reveal",
            &one,
            p1(),
            pk(&p1()),
            3,
            salt(0, 0),
            simul_state(&with_reveal(&one, 0, 3)),
            POT,
        ),
        "before both commitments",
    );

    let half = with_reveal(&both, 0, 3);
    assert_fail(
        run_reveal_like(
            "reveal",
            &half,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&with_reveal(&half, 1, 5)),
            POT,
        ),
        "second reveal must resolve",
    );
}

#[test]
fn reveal_rejects_full_column() {
    // Column 0 topped out; P1 sealed it anyway (the board was public — a
    // knowingly dead commitment).
    let mut base = new_simul();
    for row in 0..ROWS {
        base.board[row] = (row % 2) as u8 + 1;
    }
    let both = committed_both(&base, 0, 1);
    assert_fail(run_reveal(&both, 0, 0), "full column reveal");
    // The opponent's legal reveal still works.
    assert_pass(run_reveal(&both, 1, 1), "legal sibling reveal");
}

#[test]
fn reveal_rejects_tampered_successors() {
    let both = committed_both(&new_simul(), 3, 5);

    // Keeps the commitment while recording the reveal.
    let mut keeps_commit = with_reveal(&both, 0, 3);
    keeps_commit.commit1 = both.commit1;
    assert_fail(
        run_reveal_like(
            "reveal",
            &both,
            p1(),
            pk(&p1()),
            3,
            salt(0, 0),
            simul_state(&keeps_commit),
            POT,
        ),
        "commitment kept",
    );

    // Records a different column than revealed.
    assert_fail(
        run_reveal_like(
            "reveal",
            &both,
            p1(),
            pk(&p1()),
            3,
            salt(0, 0),
            simul_state(&with_reveal(&both, 0, 4)),
            POT,
        ),
        "wrong recorded column",
    );

    // Lands a disc early.
    let mut early_disc = with_reveal(&both, 0, 3);
    early_disc.board[3 * ROWS] = 1;
    assert_fail(
        run_reveal_like(
            "reveal",
            &both,
            p1(),
            pk(&p1()),
            3,
            salt(0, 0),
            simul_state(&early_disc),
            POT,
        ),
        "disc landed early",
    );

    assert_fail(
        run_reveal_like(
            "reveal",
            &both,
            p1(),
            pk(&p1()),
            3,
            salt(0, 0),
            simul_state(&with_reveal(&both, 0, 3)),
            POT - 1,
        ),
        "skimmed pot",
    );
}

// -- resolve ---------------------------------------------------------------

#[test]
fn resolve_lands_both_discs_either_direction() {
    let both = committed_both(&new_simul(), 3, 5);
    // P1 revealed col 3 first, P2 resolves col 5 (revealer's index < resolver's).
    assert_pass(run_resolve(&with_reveal(&both, 0, 3), 1, 5), "p2 resolves");
    // P2 revealed col 5 first, P1 resolves col 3 (resolver's index < revealer's).
    assert_pass(run_resolve(&with_reveal(&both, 1, 5), 0, 3), "p1 resolves");
}

#[test]
fn resolve_collision_priority_alternates() {
    // Round 0: p1's disc lands lower.
    let round0 = committed_both(&new_simul(), 3, 3);
    assert_pass(
        run_resolve(&with_reveal(&round0, 0, 3), 1, 3),
        "round 0 collision",
    );

    // Round 1: p2's disc lands lower.
    let mut base = new_simul();
    base.round = 1;
    base.board[3 * ROWS] = 1;
    base.board[3 * ROWS + 1] = 2;
    let round1 = committed_both(&base, 3, 3);
    assert_pass(
        run_resolve(&with_reveal(&round1, 0, 3), 1, 3),
        "round 1 collision",
    );

    // A successor with the collision order swapped must fail.
    let swapped_base = with_reveal(&round0, 0, 3);
    let honest = resolved(&round0, 3, 0, 3);
    let mut swapped = honest.clone();
    swapped.board[3 * ROWS] = 2;
    swapped.board[3 * ROWS + 1] = 1;
    assert_fail(
        run_reveal_like(
            "resolve",
            &swapped_base,
            p2(),
            pk(&p2()),
            3,
            salt(1, 0),
            simul_state(&swapped),
            POT,
        ),
        "swapped collision order",
    );
}

#[test]
fn resolve_collision_on_last_slot_drops_priority_disc_only() {
    // Column 0 at height 5, round 3 (priority p2): both sealed column 0.
    let mut base = new_simul();
    base.round = 3;
    for row in 0..5 {
        base.board[row] = (row % 2) as u8 + 1;
    }
    let both = committed_both(&base, 0, 0);
    let half = with_reveal(&both, 0, 0);
    assert_pass(run_resolve(&half, 1, 0), "vanish resolve");

    // Sneaking the vanished disc into another column must fail.
    let honest = resolved(&both, 0, 0, 0);
    let mut smuggled = honest.clone();
    smuggled.board[1 * ROWS] = 1;
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p2(),
            pk(&p2()),
            0,
            salt(1, 3),
            simul_state(&smuggled),
            POT,
        ),
        "vanished disc smuggled",
    );
}

#[test]
fn resolve_rejects_wrong_phase_states() {
    let fresh = new_simul();
    let both = committed_both(&fresh, 3, 5);
    // Nothing to resolve: no reveal on the table.
    assert_fail(
        run_reveal_like(
            "resolve",
            &both,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&resolved(&both, 3, 0, 5)),
            POT,
        ),
        "nothing to resolve",
    );
    // The revealer cannot also resolve.
    let half = with_reveal(&both, 0, 3);
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p1(),
            pk(&p1()),
            3,
            salt(0, 0),
            simul_state(&resolved(&both, 3, 0, 3)),
            POT,
        ),
        "revealer resolving",
    );
    // Missing commitment for the resolver (posed state).
    let mut no_commit = half.clone();
    no_commit.commit2 = [0; 32];
    assert_fail(
        run_reveal_like(
            "resolve",
            &no_commit,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&resolved(&both, 3, 0, 5)),
            POT,
        ),
        "no commitment to resolve",
    );
}

#[test]
fn resolve_rejects_full_column_and_theft() {
    // Column 6 topped out pre-round; P2 sealed it anyway.
    let mut base = new_simul();
    for row in 0..ROWS {
        base.board[6 * ROWS + row] = (row % 2) as u8 + 1;
    }
    let both = committed_both(&base, 3, 6);
    let half = with_reveal(&both, 0, 3);
    // No honest successor exists (column 6 has no slot); any successor must
    // be rejected — pose one that only lands the revealer's disc.
    let mut posed = half.clone();
    posed.board[3 * ROWS] = 1;
    posed.round += 1;
    posed.commit2 = [0; 32];
    posed.reveal1 = 0;
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p2(),
            pk(&p2()),
            6,
            salt(1, 0),
            simul_state(&posed),
            POT,
        ),
        "resolver's column full",
    );

    let good = committed_both(&new_simul(), 3, 5);
    let good_half = with_reveal(&good, 0, 3);
    assert_fail(
        run_reveal_like(
            "resolve",
            &good_half,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&resolved(&good, 3, 0, 5)),
            POT - 1,
        ),
        "skimmed pot",
    );
}

#[test]
fn resolve_rejects_tampered_successors() {
    let both = committed_both(&new_simul(), 3, 5);
    let half = with_reveal(&both, 0, 3);
    let honest = resolved(&both, 3, 0, 5);

    let mut one_disc = honest.clone();
    one_disc.board[5 * ROWS] = 0;
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&one_disc),
            POT,
        ),
        "only one disc landed",
    );

    let mut unbumped = honest.clone();
    unbumped.round = 0;
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&unbumped),
            POT,
        ),
        "round not bumped",
    );

    let mut resurrected = honest.clone();
    resurrected.commit2 = both.commit2;
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&resurrected),
            POT,
        ),
        "commitment resurrected",
    );

    let mut lingering = honest.clone();
    lingering.reveal1 = 4;
    assert_fail(
        run_reveal_like(
            "resolve",
            &half,
            p2(),
            pk(&p2()),
            5,
            salt(1, 0),
            simul_state(&lingering),
            POT,
        ),
        "reveal not cleared",
    );
}

// -- claim_win -------------------------------------------------------------

/// P1's bottom-row line at cols 0..3 with P2 filler above — a board a real
/// resolve can produce; the resolver was P2, the winner is P1.
fn p1_line() -> Simul {
    with_cells(
        &[
            (0, 0, 1),
            (1, 0, 1),
            (2, 0, 1),
            (3, 0, 1),
            (0, 1, 2),
            (1, 1, 2),
            (2, 1, 2),
            (5, 0, 2),
        ],
        4,
    )
}

#[test]
fn claim_win_opens_the_challenge_window() {
    assert_pass(run_claim_win(&p1_line(), (0, 0, E), p1()), "p1 line");

    let p2_vertical = with_cells(
        &[
            (5, 0, 2),
            (5, 1, 2),
            (5, 2, 2),
            (5, 3, 2),
            (0, 0, 1),
            (1, 0, 1),
            (2, 0, 1),
            (4, 0, 1),
        ],
        4,
    );
    assert_pass(run_claim_win(&p2_vertical, (5, 0, N), p2()), "p2 line");
    // Slots on the table are zeroed by the claim — the game is over except
    // for the contest.
    let mid_round = with_commit(&p1_line(), 1, 5);
    assert_pass(
        run_claim_win(&mid_round, (0, 0, E), p1()),
        "claim mid-commit zeroes the slots",
    );
}

#[test]
fn claim_win_rejects_tampered_pending_successors() {
    let s = p1_line();
    let w = (0, 0, E);
    assert_fail(
        run_claim_win_into(&s, w, p1(), None),
        "no pending successor at all (the old terminal shape)",
    );
    assert_fail(
        run_claim_win_into(&s, w, p1(), Some((simul_state(&with_pending(&s, 2)), POT))),
        "pending the wrong color",
    );
    assert_fail(
        run_claim_win_into(&s, w, p1(), Some((simul_state(&s), POT))),
        "successor without the pending mark",
    );
    assert_fail(
        run_claim_win_into(
            &s,
            w,
            p1(),
            Some((simul_state(&with_pending(&s, 1)), POT - 1)),
        ),
        "pending successor shaving the pot",
    );
    let mut wiped = with_pending(&s, 1);
    wiped.board = [0; CELLS];
    assert_fail(
        run_claim_win_into(&s, w, p1(), Some((simul_state(&wiped), POT))),
        "pending successor wiping the board",
    );
    assert_fail(
        run_claim_win(&with_pending(&s, 1), w, p1()),
        "claiming again on an already-pending state",
    );
}

#[test]
fn sweep_win_pays_the_winner_after_the_window() {
    let pending = with_pending(&p1_line(), 1);
    assert_pass(
        run_sweep_win(&pending, p1(), MOVE_TIMEOUT as u64),
        "sweep at the clock",
    );
    assert_fail(
        run_sweep_win(&pending, p1(), MOVE_TIMEOUT as u64 - 1),
        "sweep one block early",
    );
    assert_fail(
        run_sweep_win(&pending, p2(), MOVE_TIMEOUT as u64),
        "the loser sweeping",
    );
    assert_fail(
        run_sweep_win(&pending, stranger(), MOVE_TIMEOUT as u64),
        "a stranger sweeping",
    );
    assert_fail(
        run_sweep_win(&p1_line(), p1(), MOVE_TIMEOUT as u64),
        "sweeping with no pending claim",
    );
}

#[test]
fn sweep_win_must_end_the_lineage() {
    let pending = with_pending(&p1_line(), 1);
    let signer = p1();
    let entry = EntryCall::new("sweep_win")
        .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
    assert_fail(
        run_simul_entry(
            entry,
            simul_state(&pending),
            MOVE_TIMEOUT as u64,
            0,
            vec![(p2pk_spk(&pk(&p1())), POT)],
            Some((simul_state(&pending), 1_000)),
        )
        .map(|_| ()),
        "smuggled successor",
    );
}

#[test]
fn a_pending_win_freezes_every_other_door_except_the_exits() {
    let pending = with_pending(&p1_line(), 1);
    // The round machine is suspended...
    assert_fail(
        run_commit(
            &pending,
            p2(),
            pk(&p2()),
            commitment(1, 5, &salt(1, pending.round)),
            simul_state(&with_commit(&pending, 1, 5)),
            POT,
        ),
        "commit into a pending state",
    );
    // ...the permissionless pot-splitters are gated (split_timeout on the
    // same clock as the sweep would otherwise halve the winner's pot)...
    assert_fail(
        run_split_timeout(&pending, MOVE_TIMEOUT as u64, half_split()),
        "split_timeout on a pending state",
    );
    assert_fail(
        run_claim_timeout(&pending, p1(), MOVE_TIMEOUT as u64),
        "claim_timeout on a pending state",
    );
    let mut full_pending = with_pending(&full_board_simul(), 1);
    full_pending.round = full_board_simul().round;
    assert_fail(
        run_simul_draw(&full_pending, MOVE_TIMEOUT as u64, half_split()),
        "claim_draw racing a pending win on a full board",
    );
    // ...but the liveness exit stays open — and on a pending state it pays the
    // winner in FULL once the challenge window elapses (a stalling loser at
    // the deadline can no longer halve a decided game), never a split.
    let win_pot = vec![(p2pk_spk(&pk(&p1())), POT)];
    assert_fail(
        run_simul_sudden_death(simul_state(&pending), 0, win_pot.clone(), DEADLINE as u64),
        "sudden death before the challenge window",
    );
    assert_fail(
        run_simul_sudden_death(simul_state(&pending), MOVE_TIMEOUT as u64, half_split(), DEADLINE as u64),
        "sudden death splitting a pending win",
    );
    assert_pass(
        run_simul_sudden_death(simul_state(&pending), MOVE_TIMEOUT as u64, win_pot, DEADLINE as u64),
        "sudden death sweeps the pending winner",
    );
}

#[test]
fn claim_win_rejects_non_owners() {
    assert_fail(
        run_claim_win(&p1_line(), (0, 0, E), p2()),
        "opponent claiming",
    );
    assert_fail(
        run_claim_win(&p1_line(), (0, 0, E), stranger()),
        "stranger claiming",
    );
}

#[test]
fn claim_win_rejects_bad_witnesses() {
    let s = p1_line();
    assert_fail(run_claim_win(&s, (0, 5, E), p1()), "empty start");
    assert_fail(run_claim_win(&s, (0, 1, E), p2()), "broken line");
    assert_fail(run_claim_win(&s, (6, 0, E), p1()), "off the edge");
    assert_fail(run_claim_win(&s, (-1, 0, E), p1()), "negative col");
    assert_fail(run_claim_win(&s, (0, 0, 4), p1()), "bad direction");
}

// -- claim_split -----------------------------------------------------------

/// The double win: p1's row-0 line with p2's directly above it.
fn double_win() -> Simul {
    with_cells(
        &[
            (0, 0, 1),
            (1, 0, 1),
            (2, 0, 1),
            (3, 0, 1),
            (0, 1, 2),
            (1, 1, 2),
            (2, 1, 2),
            (3, 1, 2),
        ],
        4,
    )
}

#[test]
fn claim_split_splits_on_a_double_win() {
    assert_pass(
        run_claim_split(&double_win(), (0, 0, E), (0, 1, E), half_split()),
        "double win split",
    );
}

/// THE POINT of the challenge window: a greedy one-line claim_win on a
/// double-win board no longer races the honest claim_split in the mempool —
/// it opens a pending state that claim_split (permissionless, witnesses
/// computable from the public board by anyone) converts into the fair split
/// for a whole move clock, while the sweep's sequence lock keeps the greedy
/// claimant waiting.
#[test]
fn a_greedy_double_win_claim_is_contestable_for_a_whole_move_clock() {
    // Either owner can still open the window with only their own line...
    assert_pass(
        run_claim_win(&double_win(), (0, 0, E), p1()),
        "p1 claims a double win with only their own line",
    );
    assert_pass(
        run_claim_win(&double_win(), (0, 1, E), p2()),
        "p2 claims a double win with only their own line",
    );
    // ...but the pending state is exactly where claim_split stays legal.
    for greedy in [1, 2] {
        assert_pass(
            run_claim_split(
                &with_pending(&double_win(), greedy),
                (0, 0, E),
                (0, 1, E),
                half_split(),
            ),
            "contest converts the pending claim into the fair split",
        );
    }
    // And the greedy sweep is exactly one move clock away — consensus-gated.
    assert_fail(
        run_sweep_win(&with_pending(&double_win(), 1), p1(), MOVE_TIMEOUT as u64 - 1),
        "sweeping inside the window",
    );
}

#[test]
fn claim_split_rejects_wrong_witnesses_and_payouts() {
    // Color order is fixed: w1 must be p1's line, w2 p2's.
    assert_fail(
        run_claim_split(&double_win(), (0, 1, E), (0, 0, E), half_split()),
        "swapped colors",
    );
    assert_fail(
        run_claim_split(&p1_line(), (0, 0, E), (0, 1, E), half_split()),
        "single-line board",
    );
    let p1_spk = p2pk_spk(&pk(&p1()));
    let p2_spk = p2pk_spk(&pk(&p2()));
    assert_fail(
        run_claim_split(
            &double_win(),
            (0, 0, E),
            (0, 1, E),
            vec![(p1_spk.clone(), POT)],
        ),
        "whole pot to p1",
    );
    assert_fail(
        run_claim_split(
            &double_win(),
            (0, 0, E),
            (0, 1, E),
            vec![(p2_spk, POT / 2), (p1_spk, POT / 2)],
        ),
        "swapped order",
    );
}

// -- claim_draw ------------------------------------------------------------

#[test]
fn simul_draw_splits_on_full_board() {
    assert_pass(
        run_simul_draw(&full_board_simul(), MOVE_TIMEOUT as u64, half_split()),
        "draw",
    );
    // A full board can hide a just-completed, unclaimed line, so the split
    // waits out one move clock — the window in which that line's owner claims.
    assert_fail(
        run_simul_draw(&full_board_simul(), MOVE_TIMEOUT as u64 - 1, half_split()),
        "draw one block early",
    );
    assert_fail(
        run_simul_draw(&new_simul(), MOVE_TIMEOUT as u64, half_split()),
        "empty board",
    );

    // One column open is not a draw.
    let mut nearly = full_board_simul();
    nearly.board[3 * ROWS + 5] = 0;
    assert_fail(
        run_simul_draw(&nearly, MOVE_TIMEOUT as u64, half_split()),
        "one slot open",
    );

    let p1_spk = p2pk_spk(&pk(&p1()));
    assert_fail(
        run_simul_draw(&full_board_simul(), MOVE_TIMEOUT as u64, vec![(p1_spk.clone(), POT)]),
        "whole pot to p1",
    );
}

// -- claim_timeout ---------------------------------------------------------

#[test]
fn claim_timeout_pays_the_lone_committer() {
    for player in 0..2usize {
        let s = with_commit(&new_simul(), player, 3);
        let kp = player_kp(player);
        assert_pass(
            run_claim_timeout(&s, kp, MOVE_TIMEOUT as u64),
            "lone committer claims",
        );
        assert_fail(
            run_claim_timeout(&s, player_kp(1 - player), MOVE_TIMEOUT as u64),
            "silent player claims",
        );
        assert_fail(
            run_claim_timeout(&s, player_kp(player), MOVE_TIMEOUT as u64 - 1),
            "one block early",
        );
    }
}

#[test]
fn claim_timeout_pays_the_lone_revealer() {
    for player in 0..2usize {
        let both = committed_both(&new_simul(), 3, 5);
        let col = if player == 0 { 3 } else { 5 };
        let s = with_reveal(&both, player, col);
        assert_pass(
            run_claim_timeout(&s, player_kp(player), MOVE_TIMEOUT as u64),
            "lone revealer claims",
        );
        assert_fail(
            run_claim_timeout(&s, player_kp(1 - player), MOVE_TIMEOUT as u64),
            "the staller claims",
        );
    }
}

#[test]
fn claim_timeout_rejects_symmetric_and_full_states() {
    assert_fail(
        run_claim_timeout(&new_simul(), p1(), MOVE_TIMEOUT as u64),
        "neither committed",
    );
    let both = committed_both(&new_simul(), 3, 5);
    assert_fail(
        run_claim_timeout(&both, p1(), MOVE_TIMEOUT as u64),
        "both committed",
    );
    let mut full = full_board_simul();
    full = with_commit(&full, 0, 0);
    assert_fail(
        run_claim_timeout(&full, p1(), MOVE_TIMEOUT as u64),
        "full board",
    );
}

// -- split_timeout ---------------------------------------------------------

#[test]
fn split_timeout_splits_symmetric_stalls() {
    assert_pass(
        run_split_timeout(&new_simul(), MOVE_TIMEOUT as u64, half_split()),
        "neither committed",
    );
    let both = committed_both(&new_simul(), 3, 5);
    assert_pass(
        run_split_timeout(&both, MOVE_TIMEOUT as u64, half_split()),
        "both committed, neither revealed",
    );
    assert_fail(
        run_split_timeout(&both, MOVE_TIMEOUT as u64 - 1, half_split()),
        "one block early",
    );
}

#[test]
fn split_timeout_rejects_one_sided_states_and_bad_payouts() {
    let one = with_commit(&new_simul(), 0, 3);
    assert_fail(
        run_split_timeout(&one, MOVE_TIMEOUT as u64, half_split()),
        "lone commitment",
    );
    let half = with_reveal(&committed_both(&new_simul(), 3, 5), 0, 3);
    assert_fail(
        run_split_timeout(&half, MOVE_TIMEOUT as u64, half_split()),
        "lone reveal",
    );
    let p1_spk = p2pk_spk(&pk(&p1()));
    assert_fail(
        run_split_timeout(
            &new_simul(),
            MOVE_TIMEOUT as u64,
            vec![(p1_spk, POT)],
        ),
        "whole pot to p1",
    );
}

// -- sudden_death ----------------------------------------------------------

#[test]
fn simul_sudden_death_splits_when_nothing_pending() {
    let mid = committed_both(&new_simul(), 3, 5);
    assert_pass(
        run_simul_sudden_death(simul_state(&mid), MOVE_TIMEOUT as u64, half_split(), DEADLINE as u64),
        "at the cap",
    );
    // The cap now also waits out a move clock (so a board-filling resolve at
    // the deadline cannot be split before its win becomes claimable).
    assert_fail(
        run_simul_sudden_death(simul_state(&mid), MOVE_TIMEOUT as u64 - 1, half_split(), DEADLINE as u64),
        "challenge window still open",
    );
    assert_fail(
        run_simul_sudden_death(simul_state(&mid), MOVE_TIMEOUT as u64, half_split(), DEADLINE as u64 - 1),
        "one block early",
    );
    let uncapped = simul_state_full(&mid, pk(&p1()), pk(&p2()), MOVE_TIMEOUT, 0);
    assert_fail(
        run_simul_sudden_death(uncapped, MOVE_TIMEOUT as u64, half_split(), u32::MAX as u64),
        "uncapped game",
    );
}

// -- engine-limit canaries -------------------------------------------------

/// MAX_STACK_SIZE is 244 and does not scale post-Toccata: a resolve on a
/// heavily loaded board with both 32-byte slots in state is the deepest
/// execution this contract has. If this passes, everything passes.
#[test]
fn stack_canary_resolve_on_loaded_board() {
    let mut base = new_simul();
    // 40 discs: all columns full except col 5 (height 4) and col 6 (height 4).
    for col in 0..5 {
        for row in 0..ROWS {
            base.board[col * ROWS + row] = ((col + row) % 2) as u8 + 1;
        }
    }
    for row in 0..4 {
        base.board[5 * ROWS + row] = (row % 2) as u8 + 1;
        base.board[6 * ROWS + row] = (row % 2) as u8 + 1;
    }
    base.round = 20;
    let both = committed_both(&base, 5, 6);
    let half = with_reveal(&both, 0, 5);
    assert_pass(run_resolve(&half, 1, 6), "resolve at depth");
}

/// Measures the compute budget the engine actually charges per simul entry.
/// The app declares SIMUL_COVENANT_BUDGET (covenant.ts) — every continuation
/// rebuilds and hashes the ~4.3 KB FourkSimul successor template in-script,
/// which is what makes these dearer than classic's 12. Found live: join at
/// budget 12 was rejected with used=131188 vs limit=129999.
#[test]
fn compute_budget_probe() {
    /// The app's declared per-input budget for fourk-mode covenant spends.
    const SIMUL_COVENANT_BUDGET: u16 = 20;

    let budget_of = |tx: &Transaction| match tx.inputs[0].compute_commit {
        ComputeCommit::ComputeBudget(b) => b.value(),
        _ => panic!("v1 input carries a compute budget"),
    };
    let mut measured: Vec<(&str, u16)> = Vec::new();

    // join (FourkSimulLobby -> FourkSimul successor)
    {
        let builder = TxBuilder::new(artifact()).expect("builder");
        let lobby = simul_lobby_state();
        let utxo = builder
            .covenant_utxo(
                "FourkSimulLobby",
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
            .actor_input("FourkSimulLobby", lobby, entry, outpoint(), utxo.clone(), 0)
            .actor_output(
                "FourkSimul",
                simul_state(&new_simul()),
                CovenantBinding::new(0, covenant_id()),
                POT,
            );
        let tx = build_executed_tx(context, utxo).expect("join executes");
        measured.push(("join", budget_of(&tx)));
    }

    // commit
    {
        let fresh = new_simul();
        let h = commitment(0, 3, &salt(0, 0));
        let signer = p1();
        let entry = EntryCall::new("commit")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), pk(&p1()), h]);
        let tx = run_simul_entry(
            entry,
            simul_state(&fresh),
            0,
            0,
            vec![],
            Some((simul_state(&with_commit(&fresh, 0, 3)), POT)),
        )
        .expect("commit executes");
        measured.push(("commit", budget_of(&tx)));
    }

    // reveal
    {
        let both = committed_both(&new_simul(), 3, 5);
        let signer = p1();
        let entry = EntryCall::new("reveal").args_with(move |tx, idx| {
            args![sign_input(tx, idx, &signer), pk(&p1()), 3i64, salt(0, 0)]
        });
        let tx = run_simul_entry(
            entry,
            simul_state(&both),
            0,
            0,
            vec![],
            Some((simul_state(&with_reveal(&both, 0, 3)), POT)),
        )
        .expect("reveal executes");
        measured.push(("reveal", budget_of(&tx)));
    }

    // resolve
    {
        let both = committed_both(&new_simul(), 3, 5);
        let half = with_reveal(&both, 0, 3);
        let honest = resolved(&both, 3, 0, 5);
        let signer = p2();
        let entry = EntryCall::new("resolve").args_with(move |tx, idx| {
            args![sign_input(tx, idx, &signer), pk(&p2()), 5i64, salt(1, 0)]
        });
        let tx = run_simul_entry(
            entry,
            simul_state(&half),
            0,
            0,
            vec![],
            Some((simul_state(&honest), POT)),
        )
        .expect("resolve executes");
        measured.push(("resolve", budget_of(&tx)));
    }

    // claim_split (heaviest terminal: two unrolled line checks)
    {
        let entry = EntryCall::new("claim_split")
            .args_with(move |_tx, _idx| args![0i64, 0i64, E, 0i64, 1i64, E]);
        let tx = run_simul_entry(entry, simul_state(&double_win()), 0, 0, half_split(), None)
            .expect("claim_split executes");
        measured.push(("claim_split", budget_of(&tx)));
    }

    // claim_win — now a continuation: line check PLUS the successor template
    // rebuild, the same cost class as commit/reveal/resolve.
    {
        let s = p1_line();
        let signer = p1();
        let entry = EntryCall::new("claim_win")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer), 0i64, 0i64, E]);
        let tx = run_simul_entry(
            entry,
            simul_state(&s),
            0,
            0,
            vec![],
            Some((simul_state(&with_pending(&s, 1)), POT)),
        )
        .expect("claim_win executes");
        measured.push(("claim_win", budget_of(&tx)));
    }

    // sweep_win
    {
        let pending = with_pending(&p1_line(), 1);
        let signer = p1();
        let entry = EntryCall::new("sweep_win")
            .args_with(move |tx, idx| args![sign_input(tx, idx, &signer)]);
        let tx = run_simul_entry(
            entry,
            simul_state(&pending),
            MOVE_TIMEOUT as u64,
            0,
            vec![(p2pk_spk(&pk(&p1())), POT)],
            None,
        )
        .expect("sweep_win executes");
        measured.push(("sweep_win", budget_of(&tx)));
    }

    println!("measured budgets: {measured:?}");
    for (entry, budget) in measured {
        assert!(
            budget <= SIMUL_COVENANT_BUDGET,
            "{entry} needs budget {budget}, app declares {SIMUL_COVENANT_BUDGET}"
        );
    }
}
