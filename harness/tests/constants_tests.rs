//! The genesis-gate constants (move-timeout floor/ceiling, deadline limit)
//! exist in four places that cannot import each other: the TypeScript
//! reference (src/state.ts), the Argent contract (contracts/fourk.ag), and
//! the two Rust suites' local fixtures (argent_tests.rs, simul_tests.rs).
//! Comments used to be the only thing holding them together — this test
//! parses each source and fails the moment any copy drifts.

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
        ("tests/simul_tests.rs", ["MIN_MOVE_TIMEOUT", "MAX_MOVE_TIMEOUT", "DEADLINE_LIMIT"]),
    ];
    for (file, names) in sources {
        let text = read(file);
        for ((_, want), name) in expected.iter().zip(names) {
            let got = extract(&text, file, name);
            assert_eq!(got, *want, "{name} in {file} diverged from the reference gates");
        }
    }
}
