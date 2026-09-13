//! The browser transaction path, driven natively against the real script
//! engine: every spec here is shaped exactly as app/src/shared/lib/engine.ts
//! builds it. A build succeeding means the engine executed every input.

use fourk_wasm::builder::{actor_script_public_key, build, entry_tags, Built, Spec};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use serde_json::{json, Map, Value};

const STAKE: u64 = 100_000_000;
const POT: u64 = 2 * STAKE;
const FUND: u64 = 5_000_000;
const MOVE_TIMEOUT: i64 = 36_000;
const DEADLINE: i64 = 5_000_000;
const COV_ID: &str = "abababababababababababababababababababababababababababababababab";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn secret(seed: u8) -> [u8; 32] {
    [seed; 32]
}

fn pk(seed: u8) -> String {
    let secp = Secp256k1::new();
    let kp = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&secret(seed)).unwrap());
    hex(&kp.x_only_public_key().0.serialize())
}

fn p2pk_spk(seed: u8) -> String {
    format!("20{}ac", pk(seed))
}

fn outpoint(byte: u8, index: u32) -> Value {
    json!({ "txid": hex(&[byte; 32]), "index": index })
}

fn lobby_state(p1: u8) -> Value {
    json!({ "p1": pk(p1), "move_timeout": MOVE_TIMEOUT, "deadline": DEADLINE })
}

fn match_state(board: &[u8; 42], move_count: i64) -> Value {
    json!({
        "p1": pk(1), "p2": pk(2), "board": hex(board), "move_count": move_count,
        "move_timeout": MOVE_TIMEOUT, "deadline": DEADLINE,
    })
}

fn spec(value: Value) -> Spec {
    serde_json::from_value(value).expect("spec deserializes")
}

fn state_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("state must be an object"),
    }
}

fn funding_input(signer: usize, seed: u8, outpoint_byte: u8) -> Value {
    json!({
        "kind": "p2pk", "signer": signer, "pubkey": pk(seed),
        "outpoint": outpoint(outpoint_byte, 0), "value": FUND.to_string(), "daaScore": 0, "coinbase": false, "sequence": 0,
    })
}

fn built_ok(spec_value: Value, secrets: &[[u8; 32]]) -> Built {
    let secrets: Vec<u8> = secrets.iter().flat_map(|s| s.iter().copied()).collect();
    build(&spec(spec_value), &secrets).unwrap_or_else(|e| panic!("build failed: {e}"))
}

#[test]
fn genesis_lobby_from_a_wallet_input() {
    let built = built_ok(
        json!({
            "network": "simnet",
            "inputs": [funding_input(0, 1, 0x11)],
            "outputs": [
                { "kind": "genesis", "actor": "FourkLobby", "state": lobby_state(1), "authorizingInput": 0, "value": STAKE.to_string() },
                { "kind": "script", "scriptPublicKey": p2pk_spk(1), "value": (FUND - STAKE / 100).to_string() },
            ],
        }),
        &[secret(1)],
    );
    let lobby = &built.outputs[0];
    let covenant = lobby.covenant.as_ref().expect("genesis output is bound");
    assert_eq!(covenant.authorizing_input, 0);
    assert_eq!(covenant.covenant_id.len(), 64);
    assert_eq!(
        lobby.script,
        hex(&actor_script_public_key("FourkLobby", &state_map(lobby_state(1))).unwrap())
    );
    assert!(
        built.inputs[0].compute_budget >= 1,
        "wallet input budget is measured"
    );
    assert!(built.mass.fee.parse::<u64>().unwrap() > 0);
    assert_eq!(built.id.len(), 64);
}

#[test]
fn join_with_funding_and_change() {
    let built = built_ok(
        json!({
            "network": "simnet",
            "payload": "346b7031",
            "inputs": [
                {
                    "kind": "actor", "actor": "FourkLobby", "state": lobby_state(1), "entry": "join",
                    "args": [ { "sig": 0 }, { "bytes": pk(2) } ],
                    "outpoint": outpoint(0x22, 0), "value": STAKE.to_string(), "daaScore": 0, "coinbase": false,
                    "covenantId": COV_ID, "sequence": 0,
                },
                funding_input(0, 2, 0x33),
            ],
            "outputs": [
                { "kind": "actor", "actor": "FourkMatch", "state": match_state(&[0; 42], 0), "authorizingInput": 0, "covenantId": COV_ID, "value": POT.to_string() },
                { "kind": "script", "scriptPublicKey": p2pk_spk(2), "value": (FUND - STAKE / 100).to_string() },
            ],
        }),
        &[secret(2)],
    );
    assert_eq!(
        built.outputs[0].covenant.as_ref().unwrap().covenant_id,
        COV_ID
    );
    assert!(
        built.inputs[0].compute_budget >= 5,
        "join carries template witnesses: budget {}",
        built.inputs[0].compute_budget
    );
    assert_eq!(built.payload, "346b7031");
}

#[test]
fn move_continuation() {
    let mut next = [0u8; 42];
    next[3 * 6] = 1;
    let built = built_ok(
        json!({
            "network": "testnet-10",
            "inputs": [
                {
                    "kind": "actor", "actor": "FourkMatch", "state": match_state(&[0; 42], 0), "entry": "move",
                    "args": [ { "sig": 0 }, { "int": 3 } ],
                    "outpoint": outpoint(0x44, 0), "value": POT.to_string(), "covenantId": COV_ID,
                },
                funding_input(0, 1, 0x55),
            ],
            "outputs": [
                { "kind": "actor", "actor": "FourkMatch", "state": match_state(&next, 1), "authorizingInput": 0, "covenantId": COV_ID, "value": POT.to_string() },
                { "kind": "script", "scriptPublicKey": p2pk_spk(1), "value": (FUND - 1_000).to_string() },
            ],
        }),
        &[secret(1)],
    );
    assert!(built.inputs[0].compute_budget >= 5);
}

#[test]
fn permissionless_pinned_split_is_self_funded() {
    let mut full = [0u8; 42];
    for (i, cell) in full.iter_mut().enumerate() {
        *cell = (i % 2) as u8 + 1;
    }
    let fee = 500_000u64;
    let each = (POT - fee) / 2;
    let built = built_ok(
        json!({
            "network": "simnet",
            "inputs": [{
                "kind": "actor", "actor": "FourkMatch", "state": match_state(&full, 42), "entry": "claim_draw", "args": [],
                "outpoint": outpoint(0x66, 0), "value": POT.to_string(), "covenantId": COV_ID,
            }],
            "outputs": [
                { "kind": "script", "scriptPublicKey": p2pk_spk(1), "value": each.to_string() },
                { "kind": "script", "scriptPublicKey": p2pk_spk(2), "value": each.to_string() },
            ],
        }),
        &[],
    );
    assert_eq!(built.inputs.len(), 1);
    assert!(built.mass.storage.parse::<u64>().is_ok());
}

/// The dispenser's unsigned pure-script claim rides the same builder as an
/// ordinary input with a ready-made signature script. Constants mirror
/// app/src/shared/lib/dispenser.ts (harness/tests/drip_tests.rs prints them).
#[test]
fn dispenser_claim_as_a_static_script_input() {
    const DRIP_REDEEM: &str = "7604441891a2876375b3519c6902b0047600050000000001a569b1b9be760400ca9a3ba063b9bf00c378876900c252790400ca9a3b94a26975687551676a68";
    let claim_sig_script = format!("04441891a23f{DRIP_REDEEM}");
    let redeem = (0..DRIP_REDEEM.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&DRIP_REDEEM[i..i + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let dispenser_spk = kaspa_consensus_core_p2sh(&redeem);
    let balance = 50 * STAKE;
    let drip = 10 * STAKE;
    let built = built_ok(
        json!({
            "network": "testnet-10",
            "inputs": [{
                "kind": "script", "sigScript": claim_sig_script, "scriptPublicKey": dispenser_spk,
                "outpoint": outpoint(0x77, 0), "value": balance.to_string(), "daaScore": 0, "coinbase": false, "sequence": 1200,
            }],
            "outputs": [
                { "kind": "script", "scriptPublicKey": dispenser_spk, "value": (balance - drip).to_string() },
                { "kind": "script", "scriptPublicKey": p2pk_spk(3), "value": (drip - 100_000).to_string() },
            ],
        }),
        &[],
    );
    assert!(
        built.inputs[0].compute_budget <= 1,
        "the claim used to fit budget 1, measured {}",
        built.inputs[0].compute_budget
    );
}

/// blake2b-based P2SH script public key, as kaspa-txscript's
/// pay_to_script_hash_script builds it (0xaa push32 <hash> 0x87).
fn kaspa_consensus_core_p2sh(redeem: &[u8]) -> String {
    let hash = blake2b_simd::Params::new().hash_length(32).hash(redeem);
    format!("aa20{}87", hex(hash.as_bytes()))
}

#[test]
fn entry_tags_name_every_door() {
    let lobby = entry_tags("FourkLobby").unwrap();
    let mut names: Vec<&str> = lobby.values().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, ["cancel", "join"]);
    assert!(
        lobby.keys().all(|tag| tag.len() == 8),
        "tags are 4 bytes of hex"
    );
    let simul = entry_tags("FourkSimul").unwrap();
    assert_eq!(simul.len(), 11);
    assert!(entry_tags("Nope").is_err());
}

#[test]
fn rejects_wrong_argument_count_and_unknown_state_fields() {
    let secrets = secret(2).to_vec();
    let missing_pk = spec(json!({
        "network": "simnet",
        "inputs": [{
            "kind": "actor", "actor": "FourkLobby", "state": lobby_state(1), "entry": "join",
            "args": [ { "sig": 0 } ],
            "outpoint": outpoint(0x22, 0), "value": STAKE.to_string(), "covenantId": COV_ID,
        }],
        "outputs": [
            { "kind": "actor", "actor": "FourkMatch", "state": match_state(&[0; 42], 0), "authorizingInput": 0, "covenantId": COV_ID, "value": POT.to_string() },
        ],
    }));
    assert!(build(&missing_pk, &secrets).is_err());

    let mut typo = state_map(lobby_state(1));
    typo.insert("dead_line".to_string(), json!(1));
    assert!(actor_script_public_key("FourkLobby", &typo).is_err());
}
