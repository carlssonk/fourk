import type { MatchmakerOps, PollState } from "../state/deps";

/** The Quick Match matchmaker: the /match routes beside /sweep on our node
 * (app/sweeper/match.ts, docs/adr/0003). Unset in local development unless
 * VITE_SWEEPER_URL points at a local sweeper. */
const SWEEPER_URL: string | undefined = import.meta.env?.VITE_SWEEPER_URL;
const BASE = SWEEPER_URL ? new URL("/match/", SWEEPER_URL).href : undefined;
export const HAS_QUICK_MATCH = !!BASE;

const TIMEOUT_MS = 5_000;

async function call(path: string, body?: object): Promise<Response> {
  if (!BASE) throw new Error("no matchmaker configured");
  return fetch(new URL(path, BASE), {
    ...(body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Anything unexpected throws; the Quick Match loop retries or gives up. */
export const httpMatchmaker: MatchmakerOps = {
  async seek(pk) {
    const res = await call("seek", { pk });
    if (res.status !== 200) throw new Error(`seek: ${res.status}`);
    return ((await res.json()) as { ticket: string }).ticket;
  },
  async poll(ticket) {
    const res = await call(encodeURIComponent(ticket));
    if (res.status === 404) return { state: "gone" };
    if (res.status !== 200) throw new Error(`poll: ${res.status}`);
    return (await res.json()) as PollState;
  },
  async hosted(ticket, code) {
    const res = await call("hosted", { ticket, code });
    if (res.status === 202) return "ok";
    // Not indexed on the matchmaker's node yet.
    if (res.status === 404) return "retry";
    if (res.status === 400 || res.status === 403) return "refused";
    throw new Error(`hosted: ${res.status}`);
  },
};
