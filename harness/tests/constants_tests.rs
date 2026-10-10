//! Constants that exist in several sources that cannot import each other —
//! the TypeScript reference and app, the Argent and Silverscript contracts,
//! the faucet script, the Rust fixtures. Comments used to be the only thing
//! holding them together; these tests parse each source and fail the moment
//! any copy drifts.

use std::fs;
use std::path::Path;

const MIN_MOVE_TIMEOUT: i64 = 600;
const MAX_MOVE_TIMEOUT: i64 = 8_640_000;
const DEADLINE_LIMIT: i64 = 500_000_000_000;

fn read(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Extract `<name> = <integer>` (underscores allowed) from a source file.
fn extract(source: &str, file: &str, name: &str) -> i64 {
    for line in source.lines() {
        let Some(idx) = line.find(name) else { continue };
        let rest = &line[idx + name.len()..];
        let Some(eq) = rest.find('=') else { continue };
        let digits: String = rest[eq + 1..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '_')
            .collect();
        if !digits.is_empty() {
            return digits.replace('_', "").parse().unwrap();
        }
    }
    panic!("{name} not found in {file}");
}

#[test]
fn genesis_gate_constants_match_across_all_sources() {
    let expected = [
        ("MIN_MOVE_TIMEOUT", MIN_MOVE_TIMEOUT),
        ("MAX_MOVE_TIMEOUT", MAX_MOVE_TIMEOUT),
        ("DEADLINE_LIMIT", DEADLINE_LIMIT),
    ];
    // (file, name of the min/max/limit constants in that file)
    let sources = [
        ("../src/state.ts", ["MIN_MOVE_TIMEOUT_DAA", "MAX_MOVE_TIMEOUT_DAA", "DEADLINE_LIMIT"]),
        ("../contracts/fourk.ag", ["MIN_MOVE_TIMEOUT", "MAX_MOVE_TIMEOUT", "DEADLINE_LIMIT"]),
        ("tests/argent_tests.rs", ["MIN_MOVE_TIMEOUT", "MAX_MOVE_TIMEOUT", "DEADLINE_LIMIT"]),
    ];
    for (file, names) in sources {
        let text = read(file);
        for ((_, want), name) in expected.iter().zip(names) {
            let got = extract(&text, file, name);
            assert_eq!(got, *want, "{name} in {file} diverged from the reference gates");
        }
    }
}

/// One value, every (file, name) copy of it.
fn assert_same(label: &str, want: i64, copies: &[(&str, &str)]) {
    for (file, name) in copies {
        let got = extract(&read(file), file, name);
        assert_eq!(got, want, "{label}: {name} in {file} diverged");
    }
}

#[test]
fn timing_and_fee_constants_match_across_all_sources() {
    // The second commit's rebase grace: reference rules and covenant.
    assert_same(
        "rebase grace",
        100,
        &[
            ("../src/simul-v2/rules.ts", "REBASE_GRACE_DAA"),
            ("../contracts/fourk.ag", "REBASE_GRACE"),
        ],
    );
    // The fee ceiling of the self-funded doors: the app clamps to it.
    assert_same(
        "fee ceiling",
        2_000_000,
        &[
            ("../contracts/fourk.ag", "MAX_FEE"),
            ("../app/src/shared/lib/engine.ts", "MAX_FEE"),
            ("tests/argent_tests.rs", "MAX_FEE"),
        ],
    );
}

#[test]
fn dispenser_constants_match_across_all_sources() {
    assert_same(
        "drip cooldown",
        1200,
        &[
            ("../contracts/drip.sil", "COOLDOWN"),
            ("../app/src/shared/lib/dispenser.ts", "COOLDOWN_DAA"),
            ("../faucet/fund-dispenser.mjs", "COOLDOWN_DAA"),
        ],
    );
    assert_same(
        "drip size",
        1_000_000_000,
        &[
            ("../contracts/drip.sil", "DRIP"),
            ("../app/src/shared/lib/dispenser.ts", "DRIP_SOMPI"),
            ("../faucet/fund-dispenser.mjs", "DRIP_SOMPI"),
        ],
    );
    assert_same(
        "dust floor",
        3_000_000,
        &[
            ("../app/src/shared/lib/dispenser.ts", "DUST"),
            ("../app/src/shared/lib/engine.ts", "DUST"),
            ("../faucet/fund-dispenser.mjs", "DUST"),
        ],
    );
}
