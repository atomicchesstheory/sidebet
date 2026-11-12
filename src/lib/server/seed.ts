import { asService, asUser } from "./db";
import { createLocalUser } from "./auth";
import { createContest, createInvite, importDraft, manualApply, addSource, setStatus, saveRulesetDraft, approveRuleset } from "./admin";
import { joinContest, redeemInvite } from "./contests";
import { checkContest } from "./results/pipeline";
import { demoProposeRules } from "./ai/demo";
import { proposalFromWire } from "./ai/wire";

/**
 * Three playable demos with fictional people and events:
 *  1. Private chess draft (2 pts per match win, +3 for beating a higher seed)
 *  2. Public sports bets with a live score and a separate final outcome
 *  3. Private custom contest scored from admin-entered results
 */
export const DEMO_PASSWORD = "sidebet-demo";
export const DEMO_USERS = [
  { username: "commish", display: "The Commish", admin: true },
  { username: "jordan", display: "Jordan", admin: false },
  { username: "riley", display: "Riley", admin: false },
  { username: "casey", display: "Casey", admin: false },
];

export const CHESS_RULES = "Each drafted player gets 2 points for a match win and 3 extra if they beat a higher seed. Only main-bracket matches count.";
export const RACE_RULES = "1st place in each race gets 5 points, 2nd place 3 points, 3rd place 1 point.";

type CreateUser = (username: string, password: string, display: string) => Promise<string>;

export async function seedDemo(createUser: CreateUser = createLocalUser) {
  const ids: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    ids[u.username] = await createUser(u.username, DEMO_PASSWORD, u.display);
    if (u.admin) await asService((q) => q.query("update public.profiles set is_admin = true where id = $1", [ids[u.username]]));
  }
  const admin = ids.commish;

  // ---------------------------------------------- 1. private chess draft --
  const chessPool = [
    ["Mira Okafor", 1], ["Lev Dragunov", 2], ["Ana Castellanos", 3], ["Tomas Lindqvist", 4],
    ["Priya Raman", 5], ["Elias Brandt", 6], ["Hana Moriyama", 7], ["Dario Ferreira", 8],
    ["Kofi Mensah", null], ["Sofia Petrov", null],
  ].map(([name, seed]) => ({ name, seed, kind: "player", aliases: [] }));
  const chess = await createContest(
    admin,
    {
      kind: "draft", title: "Northgate Chess Championship Draft", category: "chess", visibility: "private", stake: 50,
      description: "Brothers' draft for the (fictional) Northgate Chess Championship. Rosters were drafted offline and imported.",
      max_entrants: 2, roster_size: 4, draft_format: "snake", draft_mode: "offline",
      terms_text: "Main-bracket matches only. Scores update as matches finish.",
    },
    [],
    chessPool,
  );
  await approveDemoRules(admin, chess, CHESS_RULES, { unseeded: "lowest", forfeits: "count", bracket: "main" });
  await setStatus(admin, chess, "open");
  const chessInvite = await createInvite(admin, chess, "Family link");
  for (const u of ["jordan", "riley"]) {
    await redeemInvite(ids[u], chessInvite);
    await joinContest(ids[u], chess, null);
  }
  const chessEntries = await entriesOf(chess);
  await importDraft(admin, chess, [
    { entry_id: chessEntries.jordan, picks: ["Mira Okafor", "Ana Castellanos", "Elias Brandt", "Kofi Mensah"] },
    { entry_id: chessEntries.riley, picks: ["Lev Dragunov", "Tomas Lindqvist", "Priya Raman", "Hana Moriyama"] },
  ]);
  await addSource(admin, chess, { kind: "fixture", label: "Demo feed: Northgate results", config: { fixture: "northgate-chess", stage: 0 } });
  await checkContest(chess, "schedule");

  // ------------------------------------------ 2. public sports bets ------
  const lock = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const game = { event_key: "game-comets-owls", label: "Harbor City Comets vs Ridgeview Owls" };
  const winBet = await createContest(
    admin,
    {
      kind: "bet", title: "Comets vs Owls: who wins?", category: "sports", visibility: "public", stake: 20, lock_at: lock,
      description: "Fictional league game. Pick a side before tip-off.", resolution: game,
    },
    [
      { label: "Comets win", color: "teal", resolve_when: [{ fact: "event.winner", op: "eq", value: "Harbor City Comets" }] },
      { label: "Owls win", color: "violet", resolve_when: [{ fact: "event.winner", op: "eq", value: "Ridgeview Owls" }] },
    ],
  );
  const otBet = await createContest(
    admin,
    {
      kind: "bet", title: "Comets vs Owls: overtime?", category: "sports", visibility: "public", stake: 10, lock_at: lock,
      description: "Does the game go past regulation? Stays pending until the final whistle.", resolution: game,
    },
    [
      { label: "Yes, overtime", color: "teal", resolve_when: [{ fact: "event.overtime", op: "true" }] },
      { label: "No overtime", color: "violet", resolve_when: [{ fact: "event.overtime", op: "false" }] },
    ],
  );
  for (const b of [winBet, otBet]) {
    await setStatus(admin, b, "open");
    await addSource(admin, b, { kind: "fixture", label: "Demo feed: league scoreboard", config: { fixture: "harbor-comets-owls", stage: 1 } });
  }
  const outcomes = async (cid: string) =>
    Object.fromEntries((await asService((q) => q.query("select id, label from public.contest_outcomes where contest_id = $1", [cid]))).map((o) => [o.label, o.id]));
  const wo = await outcomes(winBet);
  await joinContest(ids.jordan, winBet, wo["Comets win"]);
  await joinContest(ids.riley, winBet, wo["Owls win"]);
  await joinContest(ids.casey, winBet, wo["Comets win"]);
  const oo = await outcomes(otBet);
  await joinContest(ids.jordan, otBet, oo["No overtime"]);
  await joinContest(ids.riley, otBet, oo["Yes, overtime"]);
  await checkContest(winBet, "schedule");
  await checkContest(otBet, "schedule");

  // ---------------------------------- 3. private custom (admin results) --
  const race = await createContest(
    admin,
    {
      kind: "draft", title: "Backyard Race Day", category: "custom", visibility: "private", stake: 25,
      description: "Family sprint races. No public source — the commish enters results.",
      max_entrants: 2, roster_size: 3, draft_format: "snake", draft_mode: "offline",
    },
    [],
    ["Josiah", "Mara", "Theo", "Lucy", "Ben", "Ava"].map((name) => ({ name, kind: "player", seed: null, aliases: [] })),
  );
  await approveDemoRules(admin, race, RACE_RULES, { forfeits: "count" });
  await setStatus(admin, race, "open");
  const raceInvite = await createInvite(admin, race, "Race day link");
  for (const u of ["jordan", "riley"]) {
    await redeemInvite(ids[u], raceInvite);
    await joinContest(ids[u], race, null);
  }
  const raceEntries = await entriesOf(race);
  await importDraft(admin, race, [
    { entry_id: raceEntries.jordan, picks: ["Josiah", "Lucy", "Ben"] },
    { entry_id: raceEntries.riley, picks: ["Mara", "Theo", "Ava"] },
  ]);
  await addSource(admin, race, { kind: "manual", label: "Commish's stopwatch" });
  await manualApply(admin, race, [
    {
      event_key: "race-1", event_type: "race", label: "Race 1", status: "final",
      participants: [
        { name: "Mara", place: 1, result: "win" }, { name: "Josiah", place: 2, result: "loss" }, { name: "Theo", place: 3, result: "loss" },
        { name: "Lucy", place: 4, result: "loss" }, { name: "Ben", place: 5, result: "loss" }, { name: "Ava", place: 6, result: "loss" },
      ],
      winner: "Mara", evidence: "Entered by the commish: Mara, Josiah, Theo, Lucy, Ben, Ava",
    },
  ]);

  // a request from a regular user
  await asUser(ids.casey, (q) =>
    q.query("insert into public.contest_requests (user_id, title, body) values (auth.uid(), $1, $2)", [
      "Office chili cook-off",
      "Bet on whose chili wins the Friday cook-off. Judges score 1–10; highest average wins.",
    ]),
  );
  return { ids, chess, winBet, otBet, race, chessInvite, raceInvite };
}

async function entriesOf(contestId: string) {
  const rows = await asService((q) =>
    q.query("select e.id, p.username from public.entries e join public.profiles p on p.id = e.user_id where e.contest_id = $1", [contestId]),
  );
  return Object.fromEntries(rows.map((r) => [r.username, r.id])) as Record<string, string>;
}

/** Seed rules through the deterministic demo parser and the normal approval path. */
async function approveDemoRules(admin: string, contestId: string, instructions: string, answers: Record<string, string>) {
  const r = proposalFromWire(demoProposeRules(instructions));
  if (!r.ok) throw new Error(`demo rules failed: ${r.errors.join("; ")}`);
  const p = r.proposal;
  const [{ id }] = await asUser(admin, (q) =>
    q.query(
      `insert into public.scoring_rulesets (contest_id, version, instructions, rules, questions, unsupported, proposed_by, created_by)
       values ($1, 1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 'Demo parser (seed)', auth.uid()) returning id`,
      [contestId, instructions, JSON.stringify(p.ruleset), JSON.stringify(p.questions), JSON.stringify(p.unsupported)],
    ),
  );
  const rules = { ...p.ruleset, options: { ...p.ruleset.options, ...(answers.unseeded ? { unseeded: answers.unseeded } : {}), ...(answers.forfeits ? { forfeits: answers.forfeits } : {}) } };
  const full = Object.fromEntries(p.questions.map((q) => [q.id, answers[q.id] ?? "default"]));
  await saveRulesetDraft(admin, id, rules, { ...full, ...(p.unsupported.length ? { __unsupported_ack: "yes" } : {}) });
  await approveRuleset(admin, id);
}

export async function ensureDemoSeed() {
  const [{ n }] = await asService((q) => q.query<{ n: number }>("select count(*)::int as n from public.profiles"));
  if (Number(n) > 0) return false;
  await seedDemo();
  return true;
}
