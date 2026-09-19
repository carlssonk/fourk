# Local playtest — 2026-09-16

Tested against the local simnet node and miner, using isolated Chromium
contexts for different players and desktop, 390 px and 320 px viewports.
Only locally mined test coins were used. The local dispenser was refilled
with 12 lanes of 100 test KAS to support fresh test players.

## Fixed

- **Game creation failed:** the installed WASM JavaScript wrapper and binary
  came from different builds. `fourk-wasm` now uses a direct local package
  link, keeping both files together after rebuilds.
- **Simultaneous Fourk picks required a second click:** recovery now traces
  the opponent's accepted secret commitment before replaying the pick,
  with a bounded wait for confirmation.
- **Overlapping actions could submit together:** the action runner now
  enforces its busy lock; deferred automatic actions remain eligible.
- **Failed joins discarded invitations:** the invite remains available
  until joining or opening the match succeeds.
- **Invalid invitations silently opened the home screen:** malformed and
  wrong-network links now display an actionable, accessible error.
- **Occupied games offered a seat:** running-game links now explicitly
  offer spectating, with no player setup or promise of a disc colour.
- **Draws and timeout losses had incorrect result headings:** outcome
  classification no longer interprets "no winner" as a loss or a Fourk
  timeout loss as a refund. Pending-win settlements use the player's seat.
  Unknown outcomes no longer claim a refund; payout wording acknowledges fees.
- **Clipboard failure still said "Copied!":** success waits for the actual
  write, and denial shows a manual-copy fallback without an uncaught error.
- **Cash-out edge cases:** zero/unknown/insufficient balances cannot submit;
  fields stay fixed while sending; successful transfers clear Max mode;
  editable Max amounts preserve all eight decimal places.
- **Damaged browser storage:** a corrupt game no longer hides subsequent
  valid games. Null bookkeeping records and invalid secret-pick columns
  no longer crash loading or appear usable.
- **Narrow game layouts:** both player panels stay side by side and the
  board respects page margins at 320 px. Flex inputs can shrink correctly.
- **Accessibility and presentation:** controls have explicit names and
  selection states, errors are announced, reduced-motion settings stop
  the winning-disc and selected-disc animations, free match cards say
  "Free", and backup instructions reflect 12- or 24-word phrases.

## Verification

- **208 unit/property tests:** all pass, including action-lock, failed-join,
  storage, exact-amount and result-classification regressions.
- **9 existing live-chain tests:** all pass. Cover Fourk collisions and wins,
  challenge-window double-win contest, one-sided timeout, stale-client
  discovery, Classic draw and win, total time cap, staked payout/cash-out,
  and dispenser claims.
- **5 browser scenarios:** invalid links; account creation and invalid
  sign-in, clipboard denial and zero-balance validation; a complete Classic
  game with refresh and spectator; simultaneous Fourk rounds and refresh
  after committing; funded staked hosting, cancellation, fee reserve,
  invalid destination and successful Max cash-out.
- Production build, root/app type checking, app lint, formatting and
  `git diff --check` pass. Vite retains its bundle-size warning.

Manual exploration also exercised timeout claims and both players' result
screens, profile controls, short-screen dialogs, and viewing finished boards.

## Repeat the checks

Run the node, continuous miner (`node mine.mjs 0`), and app first. The
dispenser needs mature lanes for fresh free players. Browser tests create
disposable accounts and matches, and require the local faucet key to fund
the staked scenario. Its funding helper refuses non-simnet addresses/nodes.

```sh
# Repository root
pnpm test
pnpm typecheck
SIMNET_E2E=1 VITE_NETWORK_ID=simnet pnpm exec vitest run app/e2e/simul-live.test.ts

# app/
pnpm exec playwright install chromium  # once, if Chromium is not installed
PLAYTEST_URL=http://localhost:5174 pnpm test:browser
pnpm build
pnpm lint
```

`PLAYTEST_URL` defaults to port 5173. This session used 5174 because 5173
was already occupied. Failed browser tests save traces/screenshots under
ignored `app/test-results/`; those artifacts can contain disposable test
account phrases and should not be published.

## Scope limits

This is a local Chromium playtest, not proof that every possible state is
bug-free. Real Safari/Firefox/mobile devices, public-network latency and
outages, actual chain reset, and a full contract/security audit were not
covered. The contract source and deployed networks were not changed.

## Payout-stall regression — 2026-09-17

The earlier Fourk browser scenario stopped after three rounds; the native
live-chain win test explicitly waited for DAA maturity before sweeping.
Neither exercised the browser's scheduled payout. A complete browser win
reproduced a sequence-lock rejection followed by an indefinite pending win.

The automatic scheduler now rechecks chain maturity when its timer wakes,
retries sequence-lock and connection failures, and retries failed timing
queries. Winning sweeps no longer require a funded wallet: their fees come
from the pot. The pending-win copy explains the selected challenge duration
(one move timer, approximately one hour by default) instead of "shortly".

`e2e/settlement.pw.ts` adds the complete two-player win, refresh during the
challenge window, and four focused scheduler regressions: sequence-lock
rejection, connection failure, failed age query, and a chain that remains
immature after the estimated delay. `test/payout.test.ts` covers the age
boundary and payout without wallet funding.

Verification: 210 unit/property tests, root/app type checks, production build,
lint and formatting pass. The nine shorter browser scenarios passed together;
the complete win/refresh/payout scenario passed separately in 1.4 minutes
after the combined run timed out during game creation (before reaching a win).

## Game-over UX — 2026-09-17

Game results now appear as soon as the confirmed Fourk board decides the
outcome, independently of on-chain settlement. The result card, board view,
and saved-match list use the same money-free presentation for wins, losses,
double wins, draws, timeouts, and cancellations, including old saved results.
Only staked games show a secondary pending/settled money line. Leaving a
decided-but-unsettled game retains its record so reopening can resume it.

Free-game invites, loading steps, cancellation/leave prompts, and service
errors no longer talk about funding or refunds. Account balances are hidden
while playing or joining a free game; optional stake settings are collapsed
by default. The mobile browser test checks both results before settlement,
returning from the home screen, refreshing, viewing the board, eventual
settlement without reopening the dialog, and starting another game.

Verification: all 222 unit/property tests and all 10 browser scenarios pass.
After the final copy/settings changes, the staked-controls and mobile
win/settlement scenarios passed again. The 320 px result card was visually
inspected. Production build, root/app type checking, lint, formatting, and
`git diff --check` pass; the existing bundle-size warning remains.

## Copy cleanup — 2026-09-18

Removed em dashes and decorative emojis from runtime copy and page metadata.
Shortened conversational filler, loading explanations, and repeated replay
prompts. Functional close, refresh, and progress symbols remain. Legacy saved
results are normalized for display, and result classification accepts the new
sentence capitalization. A source-level copy check covers strings, template
fragments, JSX text, and HTML metadata without policing code comments.

Verification: 224 unit/property tests, build, type checks, lint, formatting,
and diff checks pass. Nine browser scenarios passed in the full run. The
other two passed on rerun after updating an old copy assertion and retrying
a game-creation setup timeout. The revised 320 px result screen was inspected.

## Optional stakes on the home screen — 2026-09-18

The home screen again promotes optional stakes to guests, and account holders
see the Free/stake picker without expanding another section. About explains
that stakes use testnet KAS. This changes discovery and setup only: free-game
play, results, and cancellation messages remain money-free. The Move timer
help remains the same fixed sentence in every mode.

The new 320 px browser scenario checks the account CTA, About copy, free-game
setup and cancellation. It and both timer-help scenarios pass. Staked hosting
also passes after restarting local services and rerunning its funding setup.

## Game screen layout and controls (2026-09-18)

The game header now shows the wordmark, mode, move duration, mode-specific
rules, a persistent sound toggle, and the leave action. The empty account
header is hidden during play. The status has a clear headline and secondary
instruction, while the waiting/invite panel sits below the enlarged board.
Free-game help and status remain money-free. Player cards are wider on desktop;
on phones the avatar sits above the name so it has the full card width.

`e2e/game-layout.pw.ts` checks both modes at five viewport sizes, including
320 px phones and short landscape screens. It verifies board/invite ordering,
no horizontal overflow, readable player names, keyboard help dismissal and
focus return, mute persistence after reload, and cancellation from the header.
`test/sound.test.ts` checks muting all three alerts, unavailable storage, and
cross-tab preference notifications. Both layout scenarios and all 227 unit
tests pass. Build, app type checks, lint, and formatting pass.
The live Classic win/refresh, Fourk simultaneous-pick/refresh, and full Fourk
win/result/replay scenarios also pass. The latter was rerun after scoping its
exit click to the result dialog and extending the finite local mining run.

Follow-up: player panels now use equal compact dimensions, stacked avatars,
two-line names, and a shorter fixed timer row. The header's Home action keeps
unfinished games available, including unjoined invitations. Cancel game is a
separate confirmed action in the invite panel or joined pre-game lobby.
Eight focused browser tests pass, including returning home and reopening both
an unjoined invitation and a joined Classic game, staked cancellation, and
equal-height cards without timer/badge overlap at four viewport widths.

Player identity refinement: your card now keeps its accent border throughout
the game, while other seats use the neutral border. Accessible group labels
identify your player and disc colour without visible "you" text. The cards no
longer reserve a timer row. A shared countdown sits beside the central status,
outside its live announcement region, and turns red in the final five seconds.
Ten targeted browser scenarios pass, including both live modes, a spectator,
four screen widths, and inactive/expired/low-time countdown states. All 227
unit tests, app build, type checks, lint, and diff checks pass.

The overall game limit is now a centered HH:MM:SS countdown in the header,
separate from the move timer. It updates each second, refreshes its network
anchor every 30 seconds and when returning to the tab, retries failed reads,
clamps at zero, and disappears for ended or uncapped games. Help explains that
the countdown is an estimate and the network confirms expiry. Invitation
screens retain their coarse duration wording. Truncated usernames retain their
full native hover titles, covered by the player-panel browser tests.
Verification: 238 unit tests, 12 focused clock/player browser scenarios, both
responsive game-layout scenarios, and the live Classic win/refresh scenario
pass. Build, lint, and diff checks pass.
