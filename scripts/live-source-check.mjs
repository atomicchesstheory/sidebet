// Live integration check: a real public PGN feed (Lichess broadcast) through
// the same checkContest() pipeline the scheduler and cron route use.
//   BASE_URL=http://localhost:3000 PGN_URL=https://lichess.org/api/broadcast/round/<id>.pgn \
//   PLAYERS="Abdusattorov, Nodirbek|1;Caruana, Fabiano|2;Duda, Jan-Krzysztof|3;Praggnanandhaa R|4" \
//   node scripts/live-source-check.mjs
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PGN_URL = process.env.PGN_URL;
const PLAYERS = (process.env.PLAYERS ?? "").split(";").filter(Boolean).map((p) => {
  const [name, seed] = p.split("|");
  return { name: name.trim(), seed: seed ? Number(seed) : null };
});
if (!PGN_URL || PLAYERS.length < 4) throw new Error("Set PGN_URL and at least 4 PLAYERS");

const jar = new Map();
async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
  }
  const j = await res.json();
  if (!j.ok) throw new Error(`${path}: ${JSON.stringify(j.error)}`);
  return j.data;
}
const act = (n, b) => call(`/api/actions/${n}`, b);

await call("/api/auth/signin", { login: "commish", password: "sidebet-demo" });
const { id } = await act("create_contest", {
  contest: { kind: "draft", title: `Live PGN check ${new Date().toISOString().slice(0, 16)}`, category: "chess", visibility: "private", stake: 0, roster_size: Math.floor(PLAYERS.length / 2), draft_format: "snake", draft_mode: "offline" },
  pool: PLAYERS,
});
const p = await act("propose_rules", { contest_id: id, instructions: "Each drafted player gets 2 points for a match win and 3 extra if they beat a higher seed. 1 point for a draw." });
const admin = await call(`/api/admin/contests/${id}`);
const rs = admin.admin.rulesets.find((r) => r.status === "draft");
await act("save_rules", { ruleset_id: rs.id, rules: rs.rules, answers: Object.fromEntries(rs.questions.map((q) => [q.id, "default"])) });
await act("approve_rules", { ruleset_id: rs.id });
await act("set_status", { contest_id: id, status: "open" });
// two demo entrants join via invite
const { token } = await act("create_invite", { contest_id: id, label: "live" });
const entrantJar = [];
for (const u of ["jordan", "riley"]) {
  jar.clear();
  await call("/api/auth/signin", { login: u, password: "sidebet-demo" });
  await act("redeem_invite", { token });
  await act("join", { contest_id: id });
  entrantJar.push(new Map(jar));
}
jar.clear();
await call("/api/auth/signin", { login: "commish", password: "sidebet-demo" });
const v = (await call(`/api/admin/contests/${id}`)).view;
const half = Math.floor(PLAYERS.length / 2);
await act("import_draft", {
  contest_id: id,
  rosters: [
    { entry_id: v.entrants[0].entry_id, picks: PLAYERS.filter((_, i) => i % 2 === 0).slice(0, half).map((x) => x.name) },
    { entry_id: v.entrants[1].entry_id, picks: PLAYERS.filter((_, i) => i % 2 === 1).slice(0, half).map((x) => x.name) },
  ],
});
await act("add_source", { contest_id: id, source: { kind: "pgn", url: PGN_URL, label: "Lichess broadcast (live)" } });
const first = await act("check_now", { contest_id: id });
const second = await act("check_now", { contest_id: id });
const view = (await call(`/api/admin/contests/${id}`)).view;
console.log(`AI/rules provider: ${p.provider}`);
console.log("check 1:", JSON.stringify(first.map((s) => ({ ok: s.ok, notes: s.notes, counts: s.counts, error: s.error }))));
console.log("check 2 (recheck):", JSON.stringify(second.map((s) => ({ ok: s.ok, counts: s.counts }))));
for (const r of view.rosters) {
  console.log(`${r.username}: ${r.total} pts`);
  for (const pk of r.picks) console.log(`   ${pk.name}: ${pk.points}  ${pk.lines.map((l) => `${l.label} +${l.points} [${l.detail}]`).join("; ")}`);
}
console.log(`last_success_at: ${view.contest.last_success_at}  contest: /c/${id}`);
