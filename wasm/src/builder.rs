//! The transaction builder behind the browser bindings.
//!
//! A JSON spec names every input and output of one transaction; this module
//! turns it into an argent-runtime `TxContext`, lets `TxBuilder::build` sign,
//! assemble, and execute every input through the real script engine (which
//! also measures each input's compute budget), then prices the result the way
//! the mempool does. Nothing here is wasm-specific — tests/ drives it natively.
//!
//! Spec (all sompi/DAA quantities are decimal strings or numbers; all byte
//! strings are hex):
//!
//! ```json
//! {
//!   "network": "simnet",
//!   "lockTime": 0,
//!   "payload": "",
//!   "inputs": [
//!     { "kind": "actor", "actor": "FourkLobby", "state": { "p1": "..", "move_timeout": 600, "deadline": 1 },
//!       "entry": "join", "args": [ { "sig": 0 }, { "bytes": ".." } ],
//!       "outpoint": { "txid": "..", "index": 0 }, "value": "100000000", "daaScore": 0,
//!       "coinbase": false, "covenantId": "..", "sequence": 0 },
//!     { "kind": "p2pk", "signer": 0, "pubkey": "..", "outpoint": {..}, "value": "..", "daaScore": 0, "coinbase": false, "sequence": 0 },
//!     { "kind": "script", "sigScript": "..", "scriptPublicKey": "..", "outpoint": {..}, "value": "..", "daaScore": 0, "coinbase": false, "sequence": 0 }
//!   ],
//!   "outputs": [
//!     { "kind": "actor", "actor": "FourkMatch", "state": {..}, "authorizingInput": 0, "covenantId": "..", "value": ".." },
//!     { "kind": "genesis", "actor": "FourkLobby", "state": {..}, "authorizingInput": 0, "value": ".." },
//!     { "kind": "script", "scriptPublicKey": "..", "value": ".." }
//!   ]
//! }
//! ```
//!
//! `{ "sig": n }` arguments and `signer` indices name 32-byte secret keys in
//! the `secrets` slice; the signature (Schnorr, SIGHASH_ALL) is computed over
//! the finished unsigned transaction. Actor states are typed by the artifact's
//! state declarations (bytes-like fields as hex, ints as numbers).

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

use argent_runtime::{
    ArgValue, Artifact, ArtifactValue, EntryCall, InputSigScript, TxBuilder, TxContext,
};
use kaspa_consensus_core::config::params::{
    Params, DEVNET_PARAMS, MAINNET_PARAMS, SIMNET_PARAMS, TESTNET_PARAMS,
};
use kaspa_consensus_core::hashing::sighash::{
    calc_schnorr_signature_hash, SigHashReusedValuesUnsync,
};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::mass::MassCalculator;
use kaspa_consensus_core::tx::{
    ComputeCommit, CovenantBinding, MutableTransaction, PopulatedTransaction, ScriptPublicKey,
    Transaction, TransactionId, TransactionOutpoint, UtxoEntry,
};
use kaspa_consensus_core::Hash;
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};
use serde::{Deserialize, Deserializer, Serialize};
use silverscript_abi::TypeArtifact;

const ARTIFACT_JSON: &str = include_str!("../../contracts/build/artifact.json");

/// The genesis subgroup every fresh lobby is launched under. One group per
/// transaction; the name only has to be stable.
const GENESIS_GROUP: &str = "launch::fourk";

#[derive(Debug)]
pub struct BuildError(pub String);

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BuildError {}

fn err<T>(message: impl Into<String>) -> Result<T, BuildError> {
    Err(BuildError(message.into()))
}

type BuildResult<T> = Result<T, BuildError>;

/// The embedded artifact, parsed once.
pub fn artifact() -> BuildResult<&'static Artifact> {
    static ARTIFACT: OnceLock<Option<Artifact>> = OnceLock::new();
    ARTIFACT
        .get_or_init(|| serde_json::from_str(ARTIFACT_JSON).ok())
        .as_ref()
        .ok_or_else(|| BuildError("embedded artifact does not deserialize".to_string()))
}

fn builder() -> BuildResult<TxBuilder<'static>> {
    TxBuilder::new(artifact()?).map_err(|e| BuildError(format!("artifact: {e}")))
}

// --- hex / numbers -----------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(what: &str, text: &str) -> BuildResult<Vec<u8>> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.len() % 2 != 0 {
        return err(format!("{what}: odd-length hex"));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16)
                .map_err(|_| BuildError(format!("{what}: invalid hex")))
        })
        .collect()
}

/// A u64 that may arrive as a JSON number or a decimal string (sompi values
/// exceed JavaScript's safe-integer range).
#[derive(Clone, Copy, Debug, Default)]
pub struct Num(pub u64);

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            N(u64),
            S(String),
        }
        match Raw::deserialize(deserializer)? {
            Raw::N(n) => Ok(Num(n)),
            Raw::S(s) => s
                .trim()
                .parse()
                .map(Num)
                .map_err(|_| serde::de::Error::custom(format!("not a u64: {s:?}"))),
        }
    }
}

// --- spec --------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub network: String,
    #[serde(default)]
    pub lock_time: Num,
    #[serde(default)]
    pub payload: String,
    pub inputs: Vec<InputSpec>,
    pub outputs: Vec<OutputSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutpointSpec {
    pub txid: String,
    pub index: u32,
}

/// One UTXO being spent: value, age, and what else the engine needs to know.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoSpec {
    pub outpoint: OutpointSpec,
    pub value: Num,
    #[serde(default)]
    pub daa_score: Num,
    #[serde(default)]
    pub coinbase: bool,
    #[serde(default)]
    pub sequence: Num,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputSpec {
    /// A covenant UTXO spent through one of its actor's entries.
    #[serde(rename_all = "camelCase")]
    Actor {
        actor: String,
        state: serde_json::Map<String, serde_json::Value>,
        entry: String,
        args: Vec<ArgSpec>,
        covenant_id: String,
        #[serde(flatten)]
        utxo: UtxoSpec,
    },
    /// A plain wallet UTXO (pay-to-pubkey), signed by `signer`.
    #[serde(rename_all = "camelCase")]
    P2pk {
        signer: usize,
        pubkey: String,
        #[serde(flatten)]
        utxo: UtxoSpec,
    },
    /// Any other UTXO with a ready-made signature script (the dispenser's
    /// unsigned pure-script claim).
    #[serde(rename_all = "camelCase")]
    Script {
        sig_script: String,
        script_public_key: String,
        #[serde(flatten)]
        utxo: UtxoSpec,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum ArgSpec {
    /// A Schnorr signature by secret key `sig` over this input.
    Sig {
        sig: usize,
    },
    Bytes {
        bytes: String,
    },
    Int {
        int: i64,
    },
    Bool {
        bool: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutputSpec {
    /// A continuation of an existing covenant.
    #[serde(rename_all = "camelCase")]
    Actor {
        actor: String,
        state: serde_json::Map<String, serde_json::Value>,
        authorizing_input: u16,
        covenant_id: String,
        value: Num,
    },
    /// A brand-new covenant (a lobby); its id is derived from the transaction.
    #[serde(rename_all = "camelCase")]
    Genesis {
        actor: String,
        state: serde_json::Map<String, serde_json::Value>,
        authorizing_input: u16,
        value: Num,
    },
    #[serde(rename_all = "camelCase")]
    Script {
        script_public_key: String,
        value: Num,
    },
}

// --- result ------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub id: String,
    pub version: u16,
    pub lock_time: String,
    pub subnetwork_id: String,
    pub gas: String,
    pub payload: String,
    pub inputs: Vec<BuiltInput>,
    pub outputs: Vec<BuiltOutput>,
    pub mass: Masses,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInput {
    pub transaction_id: String,
    pub index: u32,
    pub signature_script: String,
    pub sequence: String,
    pub sig_op_count: u8,
    /// The compute budget the engine measured for this input.
    pub compute_budget: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltOutput {
    pub value: String,
    pub script_version: u16,
    pub script: String,
    pub covenant: Option<BuiltCovenant>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltCovenant {
    pub authorizing_input: u16,
    pub covenant_id: String,
}

/// Consensus masses of the built transaction. `fee` is the mass the mempool
/// prices a relay fee on — max(compute, normalized transient); storage mass
/// is reported for diagnostics only (the node does not charge fees on it).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Masses {
    pub compute: String,
    pub transient: String,
    pub storage: String,
    pub fee: String,
}

// --- artifact-typed values ---------------------------------------------------

fn params_for(network: &str) -> BuildResult<Params> {
    Ok(match network.split('-').next().unwrap_or(network) {
        "mainnet" => MAINNET_PARAMS,
        "testnet" => TESTNET_PARAMS,
        "simnet" => SIMNET_PARAMS,
        "devnet" => DEVNET_PARAMS,
        other => return err(format!("unknown network {other:?}")),
    })
}

/// Decode a JSON state object into artifact values, typed by the actor's
/// declared state fields. Every declared field must be present; unknown keys
/// are rejected so a misspelled field cannot silently derive a wrong address.
pub fn decode_state(
    artifact: &Artifact,
    actor: &str,
    json: &serde_json::Map<String, serde_json::Value>,
) -> BuildResult<BTreeMap<String, ArtifactValue>> {
    let actor_artifact = artifact
        .argent
        .actors
        .iter()
        .find(|a| a.name == actor)
        .ok_or_else(|| BuildError(format!("unknown actor {actor:?}")))?;
    let state = artifact
        .argent
        .states
        .iter()
        .find(|s| s.name == actor_artifact.state)
        .ok_or_else(|| BuildError(format!("actor {actor:?} has no state declaration")))?;

    for key in json.keys() {
        if !state.fields.iter().any(|f| &f.name == key) {
            return err(format!("{actor}: unknown state field {key:?}"));
        }
    }

    let mut out = BTreeMap::new();
    for field in &state.fields {
        let raw = json
            .get(&field.name)
            .ok_or_else(|| BuildError(format!("{actor}: missing state field {:?}", field.name)))?;
        let what = format!("{actor}.{}", field.name);
        let value = match &field.ty {
            TypeArtifact::Int | TypeArtifact::Temporal => ArtifactValue::Int(json_i64(&what, raw)?),
            TypeArtifact::Bool => ArtifactValue::Bool(
                raw.as_bool()
                    .ok_or_else(|| BuildError(format!("{what}: expected bool")))?,
            ),
            TypeArtifact::Text => ArtifactValue::Text(
                raw.as_str()
                    .ok_or_else(|| BuildError(format!("{what}: expected string")))?
                    .to_string(),
            ),
            TypeArtifact::Bytes | TypeArtifact::Sig | TypeArtifact::Datasig => {
                ArtifactValue::Bytes(json_bytes(&what, raw, None)?)
            }
            TypeArtifact::Pubkey => ArtifactValue::Bytes(json_bytes(&what, raw, Some(32))?),
            TypeArtifact::FixedBytes { len } => {
                ArtifactValue::Bytes(json_bytes(&what, raw, Some(*len))?)
            }
            other => return err(format!("{what}: unsupported state field type {other:?}")),
        };
        out.insert(field.name.clone(), value);
    }
    Ok(out)
}

fn json_i64(what: &str, raw: &serde_json::Value) -> BuildResult<i64> {
    match raw {
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| BuildError(format!("{what}: not an i64"))),
        serde_json::Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| BuildError(format!("{what}: not an i64: {s:?}"))),
        _ => err(format!("{what}: expected an integer")),
    }
}

fn json_bytes(what: &str, raw: &serde_json::Value, len: Option<usize>) -> BuildResult<Vec<u8>> {
    let text = raw
        .as_str()
        .ok_or_else(|| BuildError(format!("{what}: expected hex string")))?;
    let bytes = unhex(what, text)?;
    if let Some(len) = len {
        if bytes.len() != len {
            return err(format!("{what}: expected {len} bytes, got {}", bytes.len()));
        }
    }
    Ok(bytes)
}

/// The script public key (version 0) locking `actor` carrying `state`.
pub fn actor_script_public_key(
    actor: &str,
    state: &serde_json::Map<String, serde_json::Value>,
) -> BuildResult<Vec<u8>> {
    let artifact = artifact()?;
    let state = decode_state(artifact, actor, state)?;
    let output = builder()?
        .genesis_output(actor, state, 0)
        .map_err(|e| BuildError(format!("{actor} script: {e}")))?;
    Ok(output.script_public_key.script().to_vec())
}

/// Entry dispatch tags of `actor`'s contract: tag hex -> entry name. A spend's
/// signature script ends with the tag push followed by the redeem script
/// push, which is how the app classifies a traced spend.
pub fn entry_tags(actor: &str) -> BuildResult<BTreeMap<String, String>> {
    let artifact = artifact()?;
    let actor_artifact = artifact
        .argent
        .actors
        .iter()
        .find(|a| a.name == actor)
        .ok_or_else(|| BuildError(format!("unknown actor {actor:?}")))?;
    let contract = artifact
        .sil_abi
        .contract(&actor_artifact.abi.contract)
        .ok_or_else(|| {
            BuildError(format!(
                "{actor}: contract {:?} missing from ABI",
                actor_artifact.abi.contract
            ))
        })?;
    let mut tags = BTreeMap::new();
    for entry in &actor_artifact.entries {
        let sil = contract.entries.get(&entry.abi.entry).ok_or_else(|| {
            BuildError(format!(
                "{actor}::{}: ABI entry {:?} missing",
                entry.name, entry.abi.entry
            ))
        })?;
        tags.insert(hex(sil.dispatch_tag.as_bytes()), entry.name.clone());
    }
    Ok(tags)
}

// --- building ----------------------------------------------------------------

fn parse_hash(what: &str, text: &str) -> BuildResult<Hash> {
    Hash::from_str(text).map_err(|e| BuildError(format!("{what}: {e}")))
}

fn outpoint_of(spec: &OutpointSpec) -> BuildResult<TransactionOutpoint> {
    Ok(TransactionOutpoint {
        transaction_id: TransactionId::from_str(&spec.txid)
            .map_err(|e| BuildError(format!("outpoint txid: {e}")))?,
        index: spec.index,
    })
}

fn p2pk_script_public_key(pubkey_hex: &str) -> BuildResult<ScriptPublicKey> {
    let pk = unhex("pubkey", pubkey_hex)?;
    if pk.len() != 32 {
        return err(format!("pubkey: expected 32 bytes, got {}", pk.len()));
    }
    let mut script = Vec::with_capacity(34);
    script.push(0x20);
    script.extend_from_slice(&pk);
    script.push(0xac);
    Ok(ScriptPublicKey::from_vec(0, script))
}

fn keypairs_of(secp: &Secp256k1<secp256k1::All>, secrets: &[u8]) -> BuildResult<Vec<Keypair>> {
    if secrets.len() % 32 != 0 {
        return err(format!(
            "secrets: expected a multiple of 32 bytes, got {}",
            secrets.len()
        ));
    }
    secrets
        .chunks(32)
        .map(|chunk| {
            let secret =
                SecretKey::from_slice(chunk).map_err(|e| BuildError(format!("secret key: {e}")))?;
            Ok(Keypair::from_secret_key(secp, &secret))
        })
        .collect()
}

/// Schnorr-sign input `index` of the finished unsigned transaction:
/// 64 signature bytes plus the SIGHASH_ALL type byte, as the engine expects.
fn sign_input(
    secp: &Secp256k1<secp256k1::All>,
    tx: &MutableTransaction<Transaction>,
    index: usize,
    keypair: &Keypair,
) -> Vec<u8> {
    let reused = SigHashReusedValuesUnsync::new();
    let hash = calc_schnorr_signature_hash(&tx.as_verifiable(), index, SIG_HASH_ALL, &reused);
    let message = Message::from_digest(hash.as_bytes());
    let mut encoded = secp
        .sign_schnorr_no_aux_rand(&message, keypair)
        .as_ref()
        .to_vec();
    encoded.push(SIG_HASH_ALL.to_u8());
    encoded
}

fn keypair_at<'k>(keypairs: &'k [Keypair], index: usize) -> BuildResult<&'k Keypair> {
    keypairs.get(index).ok_or_else(|| {
        BuildError(format!(
            "signer #{index} not supplied ({} secret keys given)",
            keypairs.len()
        ))
    })
}

/// Build, sign, and engine-verify the transaction `spec` describes.
pub fn build(spec: &Spec, secrets: &[u8]) -> BuildResult<Built> {
    let artifact = artifact()?;
    let builder = builder()?;
    let params = params_for(&spec.network)?;
    let secp = Secp256k1::new();
    let keypairs = keypairs_of(&secp, secrets)?;

    let mut context = TxContext::new()
        .lock_time(spec.lock_time.0)
        .payload(unhex("payload", &spec.payload)?);
    let mut entries = Vec::with_capacity(spec.inputs.len());

    for (index, input) in spec.inputs.iter().enumerate() {
        let what = format!("input #{index}");
        match input {
            InputSpec::Actor {
                actor,
                state,
                entry,
                args,
                covenant_id,
                utxo,
            } => {
                let state = decode_state(artifact, actor, state)?;
                let covenant_id = parse_hash(&format!("{what} covenantId"), covenant_id)?;
                let entry_utxo = builder
                    .covenant_utxo(
                        actor.as_str(),
                        state.clone(),
                        utxo.value.0,
                        utxo.daa_score.0,
                        utxo.coinbase,
                        Some(covenant_id),
                    )
                    .map_err(|e| BuildError(format!("{what} ({actor}): {e}")))?;
                for arg in args {
                    if let ArgSpec::Sig { sig } = arg {
                        keypair_at(&keypairs, *sig)?;
                    }
                }
                let args = args.clone();
                let keypairs = &keypairs;
                let secp = &secp;
                let call = EntryCall::new(entry.as_str()).try_args_with(move |tx, input_index| {
                    args.iter()
                        .map(|arg| {
                            Ok(match arg {
                                ArgSpec::Sig { sig } => ArgValue::Value(ArtifactValue::Bytes(
                                    sign_input(secp, tx, input_index, keypair_at(keypairs, *sig)?),
                                )),
                                ArgSpec::Bytes { bytes } => {
                                    ArgValue::Value(ArtifactValue::Bytes(unhex("arg", bytes)?))
                                }
                                ArgSpec::Int { int } => ArgValue::Value(ArtifactValue::Int(*int)),
                                ArgSpec::Bool { bool } => {
                                    ArgValue::Value(ArtifactValue::Bool(*bool))
                                }
                            })
                        })
                        .collect::<BuildResult<Vec<_>>>()
                });
                context = context.actor_input(
                    actor.as_str(),
                    state,
                    call,
                    outpoint_of(&utxo.outpoint)?,
                    entry_utxo.clone(),
                    utxo.sequence.0,
                );
                entries.push(entry_utxo);
            }
            InputSpec::P2pk {
                signer,
                pubkey,
                utxo,
            } => {
                let entry_utxo = UtxoEntry::new(
                    utxo.value.0,
                    p2pk_script_public_key(pubkey)?,
                    utxo.daa_score.0,
                    utxo.coinbase,
                    None,
                );
                let keypair = keypair_at(&keypairs, *signer)?;
                let secp = &secp;
                let sig_script = InputSigScript::with_transaction(move |tx, input_index| {
                    let sig = sign_input(secp, tx, input_index, keypair);
                    let mut script = Vec::with_capacity(sig.len() + 1);
                    script.push(sig.len() as u8);
                    script.extend_from_slice(&sig);
                    script
                });
                context = context.input(
                    outpoint_of(&utxo.outpoint)?,
                    entry_utxo.clone(),
                    sig_script,
                    utxo.sequence.0,
                );
                entries.push(entry_utxo);
            }
            InputSpec::Script {
                sig_script,
                script_public_key,
                utxo,
            } => {
                let spk = ScriptPublicKey::from_vec(
                    0,
                    unhex(&format!("{what} scriptPublicKey"), script_public_key)?,
                );
                let entry_utxo =
                    UtxoEntry::new(utxo.value.0, spk, utxo.daa_score.0, utxo.coinbase, None);
                let sig_script = unhex(&format!("{what} sigScript"), sig_script)?;
                context = context.input(
                    outpoint_of(&utxo.outpoint)?,
                    entry_utxo.clone(),
                    sig_script,
                    utxo.sequence.0,
                );
                entries.push(entry_utxo);
            }
        }
    }

    for (index, output) in spec.outputs.iter().enumerate() {
        let what = format!("output #{index}");
        match output {
            OutputSpec::Actor {
                actor,
                state,
                authorizing_input,
                covenant_id,
                value,
            } => {
                let state = decode_state(artifact, actor, state)?;
                let binding = CovenantBinding::new(
                    *authorizing_input,
                    parse_hash(&format!("{what} covenantId"), covenant_id)?,
                );
                context = context.actor_output(actor.as_str(), state, binding, value.0);
            }
            OutputSpec::Genesis {
                actor,
                state,
                authorizing_input,
                value,
            } => {
                let state = decode_state(artifact, actor, state)?;
                context = context.actor_genesis_output(
                    *authorizing_input,
                    GENESIS_GROUP,
                    actor.as_str(),
                    state,
                    value.0,
                );
            }
            OutputSpec::Script {
                script_public_key,
                value,
            } => {
                let spk = ScriptPublicKey::from_vec(
                    0,
                    unhex(&format!("{what} scriptPublicKey"), script_public_key)?,
                );
                context = context.output(spk, None, value.0);
            }
        }
    }

    // Signs, assembles, executes every input on the engine, commits budgets,
    // and checks the consensus mass limits.
    let mut tx = builder
        .build(&context)
        .map_err(|e| BuildError(e.to_string()))?;
    tx.finalize();

    let calculator = MassCalculator::new_with_consensus_params(&params);
    let non_contextual = calculator.calc_non_contextual_masses(&tx);
    let storage = calculator
        .calc_contextual_masses(&PopulatedTransaction::new(&tx, entries))
        .map(|m| m.storage_mass)
        .unwrap_or(0);
    let cofactors = params.block_mass_limits().after().cofactors();
    let fee_mass = non_contextual.normalized_max(&cofactors);

    Ok(Built {
        id: tx.id().to_string(),
        version: tx.version,
        lock_time: tx.lock_time.to_string(),
        subnetwork_id: tx.subnetwork_id.to_string(),
        gas: tx.gas.to_string(),
        payload: hex(&tx.payload),
        inputs: tx
            .inputs
            .iter()
            .map(|input| {
                let (sig_op_count, compute_budget) = match input.compute_commit {
                    ComputeCommit::ComputeBudget(budget) => (0, budget.value()),
                    ComputeCommit::SigopCount(count) => (count.into(), 0),
                };
                BuiltInput {
                    transaction_id: input.previous_outpoint.transaction_id.to_string(),
                    index: input.previous_outpoint.index,
                    signature_script: hex(&input.signature_script),
                    sequence: input.sequence.to_string(),
                    sig_op_count,
                    compute_budget,
                }
            })
            .collect(),
        outputs: tx
            .outputs
            .iter()
            .map(|output| BuiltOutput {
                value: output.value.to_string(),
                script_version: output.script_public_key.version(),
                script: hex(output.script_public_key.script()),
                covenant: output.covenant.as_ref().map(|binding| BuiltCovenant {
                    authorizing_input: binding.authorizing_input,
                    covenant_id: binding.covenant_id.to_string(),
                }),
            })
            .collect(),
        mass: Masses {
            compute: non_contextual.compute_mass.to_string(),
            transient: non_contextual.transient_mass.to_string(),
            storage: storage.to_string(),
            fee: fee_mass.to_string(),
        },
    })
}

/// `build` over JSON text, for the wasm wrapper.
pub fn build_json(spec_json: &str, secrets: &[u8]) -> BuildResult<String> {
    let spec: Spec =
        serde_json::from_str(spec_json).map_err(|e| BuildError(format!("spec: {e}")))?;
    serde_json::to_string(&build(&spec, secrets)?).map_err(|e| BuildError(format!("result: {e}")))
}
