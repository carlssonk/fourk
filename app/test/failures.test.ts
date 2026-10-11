import { describe, expect, test } from "vitest";
import { classifyFailure, isStaleMatchError, type Failure } from "../src/shared/lib/errors";

// Verbatim rejections from a local simnet kaspad (rusty-kaspa a41a333) as the
// browser SDK surfaced them on 2026-10-10, one per situation the app reacts
// to. classifyFailure reads nothing but this text, so these pin the contract.
const NODE: Array<[string, Failure, string]> = [
  [
    "a second spend of an input the mempool already holds",
    "stale",
    "RPC Server (remote error) -> Rejected transaction 638c8a9ceb4a1de79ed99bf888ffe425760d97f4ef247a7f961e660a830fb927: output (208da46e6a731ceae2787103e97c47a01166e46b759532dfcc6fc4093f8c1e84, 0) already spent by transaction ebf1ff07076b6900b16956b3f2098b49f9bf54dba2fc4bb08c226de74b4f2c4f in the mempool",
  ],
  [
    "a spend of an input a block already consumed",
    "stale",
    "RPC Server (remote error) -> Rejected transaction 6bc28b3ec0853a31d20cd4bf318a6df4b8ed2a5c2120daa69a5b7e3760dcf03f: transaction 6bc28b3ec0853a31d20cd4bf318a6df4b8ed2a5c2120daa69a5b7e3760dcf03f is an orphan where orphan is disallowed",
  ],
  [
    "a spend of an outpoint that never existed",
    "stale",
    "RPC Server (remote error) -> Rejected transaction d0c4742c15470c2312370ca9be6807f93d3f73dbfcd59c99b0c8b07fd2e870db: transaction d0c4742c15470c2312370ca9be6807f93d3f73dbfcd59c99b0c8b07fd2e870db is an orphan where orphan is disallowed",
  ],
  [
    "a lock time ahead of the chain",
    "premature",
    "RPC Server (remote error) -> Rejected transaction 6eca4ca4b2f34b545a570ac7a2b5c16b393b4616eb15bbd3f19fe939d27989c6: transaction input #0 is not finalized",
  ],
  [
    "a sequence lock the input has not aged into",
    "premature",
    "RPC Server (remote error) -> Rejected transaction 900ace1d45e047b17bc9c806924552f476616a06ce417d033375338607f72434: one of the transaction sequence locks conditions was not met",
  ],
  [
    "the same transaction resubmitted while pending",
    "known",
    "RPC Server (remote error) -> Rejected transaction ebf1ff07076b6900b16956b3f2098b49f9bf54dba2fc4bb08c226de74b4f2c4f: transaction ebf1ff07076b6900b16956b3f2098b49f9bf54dba2fc4bb08c226de74b4f2c4f is already in the mempool",
  ],
  [
    "the same transaction resubmitted after acceptance",
    "known",
    "RPC Server (remote error) -> Rejected transaction ebf1ff07076b6900b16956b3f2098b49f9bf54dba2fc4bb08c226de74b4f2c4f: transaction ebf1ff07076b6900b16956b3f2098b49f9bf54dba2fc4bb08c226de74b4f2c4f was already accepted by the consensus",
  ],
];

// Failures the app raises itself, before anything reaches the node.
const APP: Array<[string, Failure, string]> = [
  [
    "the covenant refused the spend in fourk-wasm",
    "script",
    "script rejected: input #0: script ran, but verification failed",
  ],
  ["the game UTXO is gone before building", "stale", "game UTXO not found on chain. Sync first"],
  [
    "a lock-time door checked before building",
    "premature",
    "pick deadline not reached (about 2 minutes)",
  ],
  ["a dropped socket", "transient", "WebSocket disconnected"],
  ["a timed-out request", "transient", "RPC request timed out"],
  ["an offline browser", "transient", "TypeError: Failed to fetch"],
  ["a builder error", "other", "input #0 (FourkSimulV2): unknown entry `nope`"],
];

describe("classifyFailure", () => {
  test.each([...NODE, ...APP])("%s: %s", (_, expected, message) => {
    expect(classifyFailure(new Error(message))).toBe(expected);
  });

  test("a spent input is never mistaken for our own transaction being known", () => {
    // Both contain "already"; submitSpec's resubmit treats only "known" as
    // success, so the opponent's winning spend must not read as ours.
    const spent = NODE[0]![2];
    expect(spent).toContain("already");
    expect(classifyFailure(spent)).toBe("stale");
  });

  test("isStaleMatchError is the stale class", () => {
    for (const [, expected, message] of [...NODE, ...APP])
      expect(isStaleMatchError(message)).toBe(expected === "stale");
  });
});
