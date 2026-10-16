import { expect, test } from "vitest";
import { assertJoinableDeadline, type Rpc } from "../src/shared/lib/covenant";
import { FREE_STAKE, NETWORK_ID, type Match } from "../src/shared/lib/match";
import { ZERO_PK } from "../src/shared/lib/game";

const rpcAt = (daa: number) =>
  ({ getBlockDagInfo: async () => ({ virtualDaaScore: daa }) }) as unknown as Rpc;
const lobby = (deadline: number): Match => ({
  network: NETWORK_ID,
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: FREE_STAKE,
  state: {
    p1: "11".repeat(32),
    p2: ZERO_PK,
    board: new Uint8Array(42),
    moveCount: 0,
    stake: FREE_STAKE,
    moveTimeout: 3_000,
    deadline,
  },
});

test("a seat needs half an hour of game left by default, more when the caller asks", async () => {
  // 31 minutes left: enough for an invite, a cut-short game for Quick Match.
  const shortCap = lobby(1_000_000 + 18_600);
  await expect(assertJoinableDeadline(rpcAt(1_000_000), shortCap)).resolves.toBeUndefined();
  await expect(
    assertJoinableDeadline(rpcAt(1_000_000), shortCap, { min: 828_000 }),
  ).rejects.toThrow("DEADLINE_TOO_CLOSE");
  await expect(
    assertJoinableDeadline(rpcAt(1_000_000), lobby(1_000_000 + 864_000), { min: 828_000 }),
  ).resolves.toBeUndefined();
});

test("a caller that knows the cap also refuses one set far beyond it", async () => {
  const bounds = { min: 828_000, max: 900_000 };
  const farOff = lobby(1_000_000 + 8_640_000);
  await expect(assertJoinableDeadline(rpcAt(1_000_000), farOff)).resolves.toBeUndefined();
  await expect(assertJoinableDeadline(rpcAt(1_000_000), farOff, bounds)).rejects.toThrow(
    "DEADLINE_TOO_FAR",
  );
  await expect(
    assertJoinableDeadline(rpcAt(1_000_000), lobby(1_000_000 + 864_000), bounds),
  ).resolves.toBeUndefined();
});
