//! Versioned shared-deadline actors, executed by the pinned real script engine.
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
        CovenantBinding, MutableTransaction, ScriptPublicKey, Transaction, TransactionId,
        TransactionOutpoint,
    },
};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use std::collections::BTreeMap;
use std::sync::OnceLock;

type State = BTreeMap<String, ArtifactValue>;

#[test]
fn legacy_script_templates_remain_compatible_with_existing_matches() {
    // Golden template IDs recorded from the deployed artifact BEFORE adding V2.
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/build/artifact.json"
        ))
        .unwrap(),
    )
    .unwrap();
    for (actor, expected) in [
        (
            "FourkLobby",
            "ddfb4b996112c5b9b5acdb06f8d319642ea38e88f3e3c99fcbbb79c71ea21a15",
        ),
        (
            "FourkMatch",
            "659e0597d475bc43c85ded262b3c1271e170a869d719cac747b13d1374282a44",
        ),
        (
            "FourkSimul",
            "6944f862e52cede9fa21e0cd86ed1affde7b210a124f93a2f04768e5a6a52dd2",
        ),
        (
            "FourkSimulLobby",
            "bdd11c222b23be98a1c0f7ac68e14efe9bbcd215d56056d17bc8cba773fada5d",
        ),
    ] {
        let bytes = json["sil_abi"]["contracts"][actor]["compiled"]["template_hash"]
            .as_array()
            .unwrap();
        let actual: String = bytes
            .iter()
            .map(|b| format!("{:02x}", b.as_u64().unwrap()))
            .collect();
        assert_eq!(actual, expected, "{actor} must not change when adding V2");
    }
}
const POT: u64 = 200_000_000;

#[test]
fn four_complete_rounds_reach_a_valid_double_win_without_changing_the_clock_rules() {
    let mut current = ready_state(3);
    for round in 0..4 {
        let start = 1000 + round * 5000;
        let one = committed(&current, 1, start + 1200, 1);
        ok(run(
            current.clone(),
            Some(one.clone()),
            commit(1),
            start as u64,
            0,
            0,
            vec![],
        ));
        let two = committed(&one, 2, start + 1200, 1);
        ok(run(
            one,
            Some(two.clone()),
            commit(2),
            (start + 100) as u64,
            0,
            0,
            vec![],
        ));
        let shown = revealed(&two, 1);
        ok(run(
            two,
            Some(shown.clone()),
            reveal_entry("reveal", 1),
            (start + 1200) as u64,
            0,
            0,
            vec![],
        ));
        let mut next = ready_state(3);
        let mut board = vec![0u8; 42];
        for row in 0..=round as usize {
            board[row] = 1;
            board[6 + row] = 2;
        }
        next.insert("board".into(), ArtifactValue::Bytes(board));
        number(&mut next, "round", round + 1);
        ok(run(
            shown,
            Some(next.clone()),
            reveal_entry("resolve", 2),
            (start + 1300) as u64,
            0,
            0,
            vec![],
        ));
        current = next;
    }
    ok(run(
        current,
        None,
        EntryCall::new("claim_split").args(args![0i64, 0i64, 1i64, 1i64, 0i64, 1i64]),
        20_000,
        0,
        0,
        split(),
    ));
}
fn key(player: u8) -> Keypair {
    Keypair::from_secret_key(
        &Secp256k1::new(),
        &SecretKey::from_slice(&[player; 32]).unwrap(),
    )
}
fn pk(player: u8) -> [u8; 32] {
    key(player).x_only_public_key().0.serialize()
}
fn sign(tx: &MutableTransaction<Transaction>, idx: usize, player: u8) -> Vec<u8> {
    let hash = calc_schnorr_signature_hash(
        &tx.as_verifiable(),
        idx,
        SIG_HASH_ALL,
        &SigHashReusedValuesUnsync::new(),
    );
    let mut sig = key(player)
        .sign_schnorr(secp256k1::Message::from_digest(hash.as_bytes()))
        .as_ref()
        .to_vec();
    sig.push(SIG_HASH_ALL.to_u8());
    sig
}
fn artifact() -> &'static Artifact {
    static ART: OnceLock<Artifact> = OnceLock::new();
    ART.get_or_init(|| {
        serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../contracts/build/artifact.json"
            ))
            .unwrap(),
        )
        .unwrap()
    })
}
fn initial() -> State {
    state! {
        p1: pk(1), p2: pk(2), board: vec![0u8;42], round: 0i64,
        commit1: vec![0u8;32], commit2: vec![0u8;32], reveal1: 0i64, reveal2: 0i64,
        pending_win: 0i64, move_timeout: 1200i64, deadline: 100_000i64,
        ready_mask: 0i64, pick_deadline: 0i64, first_committer: 0i64, reveal_timeout: 600i64,
    }
}
fn number(s: &mut State, name: &str, value: i64) {
    s.insert(name.into(), ArtifactValue::Int(value));
}
fn ready_state(mask: i64) -> State {
    let mut s = initial();
    number(&mut s, "ready_mask", mask);
    s
}
fn run(
    active: State,
    next: Option<State>,
    entry: EntryCall<'_>,
    input_daa: u64,
    lock: u64,
    sequence: u64,
    payouts: Vec<(ScriptPublicKey, u64)>,
) -> Result<Transaction, String> {
    let builder = TxBuilder::new(artifact()).map_err(|e| format!("builder: {e}"))?;
    let id = Hash::from_bytes([0xcd; 32]);
    let utxo = builder
        .covenant_utxo(
            "FourkSimulV2",
            active.clone(),
            POT,
            input_daa,
            false,
            Some(id),
        )
        .map_err(|e| format!("utxo: {e}"))?;
    let mut context = TxContext::new().lock_time(lock).actor_input(
        "FourkSimulV2",
        active,
        entry,
        TransactionOutpoint {
            transaction_id: TransactionId::from_bytes([0x22; 32]),
            index: 0,
        },
        utxo.clone(),
        sequence,
    );
    if let Some(next) = next {
        context = context.actor_output("FourkSimulV2", next, CovenantBinding::new(0, id), POT);
    }
    for (spk, value) in payouts {
        context = context.output(spk, None, value);
    }
    let mut tx = builder.build(&context).map_err(|e| format!("build: {e}"))?;
    execute_transaction_with_covenants(&mut tx, vec![utxo]).map_err(|e| format!("script: {e}"))?;
    Ok(tx)
}
fn ready(player: u8) -> EntryCall<'static> {
    EntryCall::new("ready").args_with(move |tx, idx| args![sign(tx, idx, player), pk(player)])
}
fn ok(result: Result<Transaction, String>) {
    assert!(result.is_ok(), "{result:?}");
}
fn rejected(result: Result<Transaction, String>) {
    assert!(result.is_err(), "unexpectedly accepted");
}

#[test]
fn readiness_is_signed_monotonic_and_cannot_restart_a_game() {
    ok(run(
        initial(),
        Some(ready_state(1)),
        ready(1),
        1000,
        0,
        0,
        vec![],
    ));
    ok(run(
        ready_state(1),
        Some(ready_state(3)),
        ready(2),
        1100,
        0,
        0,
        vec![],
    ));
    rejected(run(
        ready_state(1),
        Some(ready_state(1)),
        ready(1),
        1100,
        0,
        0,
        vec![],
    ));
    rejected(run(
        initial(),
        Some(ready_state(3)),
        ready(1),
        1000,
        0,
        0,
        vec![],
    ));
    rejected(run(
        initial(),
        Some(ready_state(1)),
        ready(3),
        1000,
        0,
        0,
        vec![],
    ));
    rejected(run(
        ready_state(3),
        Some(ready_state(3)),
        ready(1),
        1200,
        0,
        0,
        vec![],
    ));
}

fn hash(player: u8) -> Vec<u8> {
    let mut preimage = vec![player - 1, player - 1];
    preimage.extend([player; 32]);
    blake2b_simd::Params::new()
        .hash_length(32)
        .hash(&preimage)
        .as_bytes()
        .to_vec()
}
fn committed(s: &State, player: u8, deadline: i64, first: i64) -> State {
    let mut next = s.clone();
    next.insert(
        format!("commit{player}"),
        ArtifactValue::Bytes(hash(player)),
    );
    number(&mut next, "pick_deadline", deadline);
    number(&mut next, "first_committer", first);
    next
}
fn commit(player: u8) -> EntryCall<'static> {
    EntryCall::new("commit")
        .args_with(move |tx, idx| args![sign(tx, idx, player), pk(player), hash(player)])
}

#[test]
fn commits_use_the_confirmed_round_start_and_preserve_the_shared_deadline() {
    for first in [1u8, 2] {
        let second = 3 - first;
        let start = ready_state(3);
        let one = committed(&start, first, 2200, first as i64);
        ok(run(
            start.clone(),
            Some(one.clone()),
            commit(first),
            1000,
            0,
            0,
            vec![],
        ));
        rejected(run(
            initial(),
            Some(one.clone()),
            commit(first),
            1000,
            0,
            0,
            vec![],
        ));
        rejected(run(
            start.clone(),
            Some(one.clone()),
            commit(first),
            u64::MAX,
            0,
            0,
            vec![],
        ));
        rejected(run(
            start,
            Some(one.clone()),
            commit(first),
            100_000,
            0,
            0,
            vec![],
        ));
        let two = committed(&one, second, 2200, first as i64);
        // A first commit accepted within the rebase grace of the deadline
        // extends the stored second cutoff by exactly that grace.
        for (score, cutoff) in [(2100u64, 2200i64), (2199, 2299), (2200, 2300)] {
            ok(run(
                one.clone(),
                Some(committed(&one, second, cutoff, first as i64)),
                commit(second),
                score,
                0,
                0,
                vec![],
            ));
        }
        rejected(run(
            one.clone(),
            Some(two.clone()),
            commit(second),
            2199,
            0,
            0,
            vec![],
        ));
        rejected(run(
            one.clone(),
            Some(two.clone()),
            commit(second),
            2201,
            0,
            0,
            vec![],
        ));
        rejected(run(
            one.clone(),
            Some(two.clone()),
            commit(second),
            u64::MAX,
            0,
            0,
            vec![],
        ));
        for field in [
            "pick_deadline",
            "first_committer",
            "ready_mask",
            "move_timeout",
            "reveal_timeout",
            "deadline",
        ] {
            let mut forged = two.clone();
            number(&mut forged, field, 9999);
            rejected(run(
                one.clone(),
                Some(forged),
                commit(second),
                2100,
                0,
                0,
                vec![],
            ));
        }
    }
}

fn reveal_entry(name: &'static str, player: u8) -> EntryCall<'static> {
    EntryCall::new(name).args_with(move |tx, idx| {
        args![
            sign(tx, idx, player),
            pk(player),
            (player - 1) as i64,
            vec![player; 32]
        ]
    })
}
fn revealed(s: &State, player: u8) -> State {
    let mut next = s.clone();
    next.insert(format!("commit{player}"), ArtifactValue::Bytes(vec![0; 32]));
    number(&mut next, &format!("reveal{player}"), player as i64);
    number(&mut next, "pick_deadline", 0);
    number(&mut next, "first_committer", 0);
    next
}

#[test]
fn only_two_timely_picks_can_reveal_and_resolve_into_the_next_round() {
    for first in [1u8, 2] {
        let second = 3 - first;
        let one = committed(&ready_state(3), first, 2200, first as i64);
        let two = committed(&one, second, 2200, first as i64);
        // A graced second commit reveals up to its stored cutoff and no later.
        let graced = committed(&one, second, 2300, first as i64);
        ok(run(
            graced.clone(),
            Some(revealed(&graced, first)),
            reveal_entry("reveal", first),
            2300,
            0,
            0,
            vec![],
        ));
        rejected(run(
            graced.clone(),
            Some(revealed(&graced, first)),
            reveal_entry("reveal", first),
            2301,
            0,
            0,
            vec![],
        ));
        for revealer in [1u8, 2] {
            let shown = revealed(&two, revealer);
            ok(run(
                two.clone(),
                Some(shown.clone()),
                reveal_entry("reveal", revealer),
                2200,
                9000,
                0,
                vec![],
            ));
            rejected(run(
                two.clone(),
                Some(shown.clone()),
                reveal_entry("reveal", revealer),
                2201,
                0,
                0,
                vec![],
            ));
            rejected(run(
                two.clone(),
                Some(shown.clone()),
                reveal_entry("reveal", revealer),
                u64::MAX,
                0,
                0,
                vec![],
            ));
            let mut next = ready_state(3);
            let mut board = vec![0u8; 42];
            board[0] = 1;
            board[6] = 2;
            next.insert("board".into(), ArtifactValue::Bytes(board));
            number(&mut next, "round", 1);
            ok(run(
                shown.clone(),
                Some(next.clone()),
                reveal_entry("resolve", 3 - revealer),
                2300,
                0,
                0,
                vec![],
            ));
            let next_pick = committed(&next, first, 11_200, first as i64);
            ok(run(
                next.clone(),
                Some(next_pick),
                commit(first),
                10_000,
                0,
                0,
                vec![],
            ));
            number(&mut next, "pick_deadline", 2200);
            rejected(run(
                shown,
                Some(next),
                reveal_entry("resolve", 3 - revealer),
                2300,
                0,
                0,
                vec![],
            ));
        }
    }
}

fn spk(player: u8) -> ScriptPublicKey {
    let mut bytes = vec![0x20];
    bytes.extend(pk(player));
    bytes.push(0xac);
    ScriptPublicKey::from_vec(0, bytes)
}
fn split() -> Vec<(ScriptPublicKey, u64)> {
    vec![(spk(1), POT / 2), (spk(2), POT / 2)]
}
fn timeout(player: u8) -> EntryCall<'static> {
    EntryCall::new("claim_timeout").args_with(move |tx, idx| args![sign(tx, idx, player)])
}

#[test]
fn late_commits_cannot_steal_or_reset_timeout_entitlements() {
    for first in [1u8, 2] {
        let second = 3 - first;
        let one = committed(&ready_state(3), first, 2200, first as i64);
        let win = vec![(spk(first), POT)];
        rejected(run(
            one.clone(),
            None,
            timeout(first),
            2100,
            2199,
            9999,
            win.clone(),
        ));
        ok(run(
            one.clone(),
            None,
            timeout(first),
            2100,
            2200,
            0,
            win.clone(),
        ));
        rejected(run(
            one.clone(),
            None,
            timeout(second),
            2100,
            2200,
            0,
            vec![(spk(second), POT)],
        ));
        rejected(run(
            one.clone(),
            None,
            EntryCall::new("split_timeout"),
            2100,
            2200,
            9999,
            split(),
        ));
        rejected(run(
            one.clone(),
            None,
            timeout(first),
            2201,
            2200,
            0,
            win.clone(),
        ));
        ok(run(
            one.clone(),
            None,
            EntryCall::new("split_timeout"),
            2201,
            0,
            0,
            split(),
        ));
        // The timeout claim waits out the second committer's rebase grace.
        rejected(run(
            one.clone(),
            None,
            timeout(first),
            2150,
            2249,
            0,
            win.clone(),
        ));
        ok(run(
            one.clone(),
            None,
            timeout(first),
            2150,
            2250,
            0,
            win.clone(),
        ));
        let graced = committed(&one, second, 2300, first as i64);
        rejected(run(
            graced.clone(),
            None,
            timeout(first),
            2300,
            0,
            0,
            win.clone(),
        ));
        ok(run(
            graced.clone(),
            None,
            timeout(first),
            2301,
            0,
            0,
            win.clone(),
        ));
        ok(run(
            graced,
            None,
            EntryCall::new("split_timeout"),
            2300,
            0,
            600,
            split(),
        ));
        let two = committed(&one, second, 2200, first as i64);
        ok(run(
            two.clone(),
            None,
            timeout(first),
            2201,
            0,
            0,
            win.clone(),
        ));
        rejected(run(
            two.clone(),
            None,
            timeout(second),
            2201,
            0,
            0,
            vec![(spk(second), POT)],
        ));
        rejected(run(
            two.clone(),
            None,
            EntryCall::new("split_timeout"),
            2201,
            9999,
            9999,
            split(),
        ));
        rejected(run(
            two.clone(),
            None,
            timeout(first),
            2200,
            9999,
            9999,
            win,
        ));
        rejected(run(
            two.clone(),
            None,
            EntryCall::new("split_timeout"),
            2200,
            9999,
            599,
            split(),
        ));
        ok(run(
            two.clone(),
            None,
            EntryCall::new("split_timeout"),
            2200,
            9999,
            600,
            split(),
        ));
        rejected(run(
            two,
            None,
            EntryCall::new("split_timeout"),
            u64::MAX,
            9999,
            9999,
            split(),
        ));
    }
    rejected(run(
        ready_state(3),
        None,
        EntryCall::new("split_timeout"),
        1000,
        2199,
        9999,
        split(),
    ));
    ok(run(
        ready_state(3),
        None,
        EntryCall::new("split_timeout"),
        1000,
        2200,
        0,
        split(),
    ));
    rejected(run(
        ready_state(3),
        None,
        EntryCall::new("split_timeout"),
        1000,
        2200,
        0,
        vec![(spk(1), POT)],
    ));
    rejected(run(
        ready_state(3),
        None,
        EntryCall::new("split_timeout"),
        1000,
        2200,
        0,
        vec![(spk(1), POT / 2), (spk(3), POT / 2)],
    ));
}

#[test]
fn cap_cleanup_pays_the_timeout_winner_and_cannot_shorten_response_windows() {
    for first in [1u8, 2] {
        let one = committed(&ready_state(3), first, 2200, first as i64);
        let two = committed(&one, 3 - first, 2200, first as i64);
        let win = vec![(spk(first), POT)];
        ok(run(
            one.clone(),
            None,
            EntryCall::new("sudden_death"),
            2100,
            100_000,
            0,
            win.clone(),
        ));
        rejected(run(
            one.clone(),
            None,
            EntryCall::new("sudden_death"),
            2100,
            100_000,
            9999,
            split(),
        ));
        ok(run(
            one,
            None,
            EntryCall::new("sudden_death"),
            2201,
            100_000,
            0,
            split(),
        ));
        ok(run(
            two.clone(),
            None,
            EntryCall::new("sudden_death"),
            2201,
            100_000,
            0,
            win.clone(),
        ));
        rejected(run(
            two.clone(),
            None,
            EntryCall::new("sudden_death"),
            2201,
            100_000,
            9999,
            split(),
        ));
        ok(run(
            two.clone(),
            None,
            EntryCall::new("sudden_death"),
            2200,
            100_000,
            600,
            split(),
        ));
        rejected(run(
            two.clone(),
            None,
            EntryCall::new("sudden_death"),
            2200,
            100_000,
            599,
            split(),
        ));
        let shown = revealed(&two, first);
        ok(run(
            shown.clone(),
            None,
            timeout(first),
            2300,
            0,
            600,
            win.clone(),
        ));
        rejected(run(
            shown.clone(),
            None,
            timeout(first),
            2300,
            0,
            599,
            win.clone(),
        ));
        ok(run(
            shown.clone(),
            None,
            EntryCall::new("sudden_death"),
            2300,
            100_000,
            600,
            win.clone(),
        ));
        rejected(run(
            shown.clone(),
            None,
            EntryCall::new("sudden_death"),
            2300,
            100_000,
            599,
            win,
        ));
        rejected(run(
            shown,
            None,
            EntryCall::new("sudden_death"),
            2300,
            100_000,
            600,
            split(),
        ));
    }
    // A picking deadline that extends past the overall cap is not shortened.
    let one = committed(&ready_state(3), 1, 101_100, 1);
    rejected(run(
        one.clone(),
        None,
        EntryCall::new("sudden_death"),
        99_950,
        100_000,
        9999,
        vec![(spk(1), POT)],
    ));
    ok(run(
        one,
        None,
        EntryCall::new("sudden_death"),
        99_950,
        101_100,
        0,
        vec![(spk(1), POT)],
    ));
    rejected(run(
        ready_state(3),
        None,
        EntryCall::new("sudden_death"),
        1000,
        99_999,
        600,
        split(),
    ));
    ok(run(
        ready_state(3),
        None,
        EntryCall::new("sudden_death"),
        1000,
        100_000,
        600,
        split(),
    ));
    // With nobody picked, the cap waits out the full picking window (or the
    // lobby clock), not the shorter reveal grace.
    rejected(run(
        ready_state(3),
        None,
        EntryCall::new("sudden_death"),
        99_950,
        100_000,
        9999,
        split(),
    ));
    ok(run(
        ready_state(3),
        None,
        EntryCall::new("sudden_death"),
        99_950,
        101_150,
        0,
        split(),
    ));
    for mask in [0i64, 1, 2] {
        rejected(run(
            ready_state(mask),
            None,
            EntryCall::new("sudden_death"),
            99_950,
            100_000,
            1199,
            split(),
        ));
        ok(run(
            ready_state(mask),
            None,
            EntryCall::new("sudden_death"),
            99_950,
            100_000,
            1200,
            split(),
        ));
    }
}

#[test]
fn board_wins_keep_their_challenge_window_and_double_win_contest() {
    let mut board = vec![0u8; 42];
    board[0..4].fill(1);
    let mut won = ready_state(3);
    won.insert("board".into(), ArtifactValue::Bytes(board.clone()));
    let mut pending = won.clone();
    number(&mut pending, "pending_win", 1);
    let claim = || {
        EntryCall::new("claim_win").args_with(|tx, idx| args![sign(tx, idx, 1), 0i64, 0i64, 1i64])
    };
    ok(run(
        won.clone(),
        Some(pending.clone()),
        claim(),
        1000,
        0,
        0,
        vec![],
    ));
    let sweep = || EntryCall::new("sweep_win").args_with(|tx, idx| args![sign(tx, idx, 1)]);
    rejected(run(
        pending.clone(),
        None,
        sweep(),
        1000,
        0,
        599,
        vec![(spk(1), POT)],
    ));
    ok(run(
        pending.clone(),
        None,
        sweep(),
        1000,
        0,
        600,
        vec![(spk(1), POT)],
    ));
    ok(run(
        pending.clone(),
        None,
        EntryCall::new("sudden_death"),
        1000,
        100_000,
        600,
        vec![(spk(1), POT)],
    ));
    rejected(run(
        pending.clone(),
        None,
        EntryCall::new("sudden_death"),
        1000,
        100_000,
        600,
        split(),
    ));
    rejected(run(
        pending.clone(),
        None,
        EntryCall::new("split_timeout"),
        1000,
        99999,
        9999,
        split(),
    ));
    rejected(run(
        pending.clone(),
        None,
        timeout(1),
        1000,
        99999,
        9999,
        vec![(spk(1), POT)],
    ));
    board[6..10].fill(2);
    pending.insert("board".into(), ArtifactValue::Bytes(board));
    ok(run(
        pending.clone(),
        None,
        EntryCall::new("claim_split").args(args![0i64, 0i64, 1i64, 1i64, 0i64, 1i64]),
        1000,
        0,
        0,
        split(),
    ));
    rejected(run(
        won,
        None,
        EntryCall::new("claim_split").args(args![0i64, 0i64, 1i64, 1i64, 0i64, 1i64]),
        1000,
        0,
        0,
        split(),
    ));
    let mut full = ready_state(3);
    full.insert("board".into(), ArtifactValue::Bytes(vec![1u8; 42]));
    rejected(run(
        full.clone(),
        None,
        EntryCall::new("claim_draw"),
        1000,
        0,
        599,
        split(),
    ));
    ok(run(
        full,
        None,
        EntryCall::new("claim_draw"),
        1000,
        0,
        600,
        split(),
    ));
}

fn join_game(grace: i64, next: State, player: u8, value: u64) -> Result<Transaction, String> {
    let builder = TxBuilder::new(artifact()).map_err(|e| e.to_string())?;
    let id = Hash::from_bytes([0xcd; 32]);
    let lobby =
        state! { p1: pk(1), move_timeout:1200i64, deadline:100_000i64, reveal_timeout:grace };
    let utxo = builder
        .covenant_utxo(
            "FourkSimulV2Lobby",
            lobby.clone(),
            POT / 2,
            1000,
            false,
            Some(id),
        )
        .map_err(|e| e.to_string())?;
    let context = TxContext::new()
        .actor_input(
            "FourkSimulV2Lobby",
            lobby,
            EntryCall::new("join")
                .args_with(move |tx, idx| args![sign(tx, idx, player), pk(player)]),
            TransactionOutpoint {
                transaction_id: TransactionId::from_bytes([0x22; 32]),
                index: 0,
            },
            utxo.clone(),
            0,
        )
        .actor_output("FourkSimulV2", next, CovenantBinding::new(0, id), value);
    let mut tx = builder.build(&context).map_err(|e| e.to_string())?;
    execute_transaction_with_covenants(&mut tx, vec![utxo]).map_err(|e| e.to_string())?;
    Ok(tx)
}
fn dissolve(player: u8) -> EntryCall<'static> {
    EntryCall::new("dissolve").args_with(move |tx, idx| args![sign(tx, idx, player), pk(player)])
}

#[test]
fn joining_enforces_timing_bounds_and_lobby_exits_end_at_readiness() {
    ok(join_game(600, initial(), 2, POT));
    rejected(join_game(599, initial(), 2, POT));
    rejected(join_game(1201, initial(), 2, POT));
    rejected(join_game(600, initial(), 1, POT));
    rejected(join_game(600, ready_state(3), 2, POT));
    rejected(join_game(600, initial(), 2, POT - 1));
    for mask in [0i64, 1, 2] {
        ok(run(
            ready_state(mask),
            None,
            dissolve(1),
            1000,
            0,
            0,
            split(),
        ));
        rejected(run(
            ready_state(mask),
            None,
            dissolve(2),
            1000,
            0,
            1199,
            split(),
        ));
        ok(run(
            ready_state(mask),
            None,
            dissolve(2),
            1000,
            0,
            1200,
            split(),
        ));
        ok(run(
            ready_state(mask),
            None,
            EntryCall::new("split_timeout"),
            1000,
            0,
            1200,
            split(),
        ));
        rejected(run(
            ready_state(mask),
            None,
            dissolve(3),
            1000,
            0,
            1200,
            split(),
        ));
    }
    for player in [1u8, 2] {
        rejected(run(
            ready_state(3),
            None,
            dissolve(player),
            1000,
            0,
            9999,
            split(),
        ));
    }
}
