// End-to-end check against a running server (demo mode):
//   BASE_URL=http://localhost:3000 node scripts/e2e-two-sessions.mjs
// Two brand-new accounts in separate cookie sessions join a private chess
// draft, stake chips, get rosters imported, receive live updates over SSE,
// see the same scores, and get paid once. An outsider is locked out.
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN = { login: process.env.ADMIN_USER ?? "commish", password: process.env.ADMIN_PASSWORD ?? "sidebet-demo" };
const OUTSIDER = { login: "casey", password: "sidebet-demo" };
const tag = Date.now().toString(36).slice(-5);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

class Session {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(path, opts = {}) {
    const res = await fetch(BASE + path, { ...opts, headers: { "content-type": "application/json", cookie: this.header(), ...(opts.headers ?? {}) }, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async json(path, body) {
    const res = await this.req(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  }
  act(name, body = {}) {
    return this.json(`/api/actions/${name}`, body);
  }
  /** Opens the SSE stream and resolves on the first `change` event. */
  listen(contestId) {
    const ctrl = new AbortController();
    const events = [];
    const ready = (async () => {
      const res = await fetch(`${BASE}/api/live/${contestId}`, { headers: { cookie: this.header() }, signal: ctrl.signal });
      if (res.status !== 200) return res.status;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const m of dec.decode(value).matchAll(/event: (\w+)/g)) events.push(m[1]);
          }
        } catch {}
      })();
      return 200;
    })();
    return { ready, events, close: () => ctrl.abort() };
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Side Bet E2E against ${BASE}`);
  const admin = new Session("admin");
  const a = new Session("a");
  const b = new Session("b");
  const out = new Session("outsider");
  ok((await admin.json("/api/auth/signin", ADMIN)).ok, "admin signs in");
  ok((await out.json("/api/auth/signin", OUTSIDER)).ok, "outsider signs in");
  ok((await a.json("/api/auth/signup", { username: `bro_a_${tag}`, password: "password123" })).ok, "account A signs up");
  ok((await b.json("/api/auth/signup", { username: `bro_b_${tag}`, password: "password123" })).ok, "account B signs up");
  const dup = await b.json("/api/auth/signup", { username: `bro_b_${tag}`, password: "password123" });
  ok(dup.status === 409, "usernames are unique");

  // --- admin builds the private chess draft ---
  const pool = [["Ada Kessler", 1], ["Bruno Varga", 2], ["Chen Wei", 3], ["Dina Ross", 4], ["Emil Sato", 5], ["Farah Nadeem", 6], ["Gus Moreau", 7], ["Hugo Lind", 8]].map(([name, seed]) => ({ name, seed }));
  const created = await admin.act("create_contest", {
    contest: { kind: "draft", title: `E2E Chess Draft ${tag}`, category: "chess", visibility: "private", stake: 40, max_entrants: 2, roster_size: 4, draft_format: "snake", draft_mode: "offline" },
    pool,
  });
  ok(created.ok, "admin creates a private draft");
  const cid = created.data.id;
  const instructions = "Each drafted player gets 2 points for a match win and 3 extra if they beat a higher seed. Only main-bracket matches count.";
  const prop = await admin.act("propose_rules", { contest_id: cid, instructions });
  ok(prop.ok && prop.data.ok, `rules proposal created (${prop.data?.provider})`);
  const adminView = (await admin.json(`/api/admin/contests/${cid}`)).data;
  const draft = adminView.admin.rulesets.find((r) => r.status === "draft");
  ok(draft.questions.length >= 2, `parser asked ${draft.questions.length} clarifying questions: ${draft.questions.map((q) => q.id).join(", ")}`);
  const prev = await admin.act("preview_rules", { contest_id: cid, rules: draft.rules });
  const upsetEx = prev.data.examples.find((e) => e.title === "Upset");
  ok(upsetEx.results[0].total === 5, `rule preview: upset example scores 5 (${upsetEx.results[0].lines.map((l) => `${l.label} +${l.points}`).join(", ")})`);
  const tooEarly = await admin.act("approve_rules", { ruleset_id: draft.id });
  ok(tooEarly.status === 400, "approval blocked until questions are answered");
  const answers = Object.fromEntries(draft.questions.map((q) => [q.id, q.id === "forfeits" ? "Forfeits count like normal results" : q.id === "unseeded" ? "Unseeded ranks below every seed" : "main"]));
  ok((await admin.act("save_rules", { ruleset_id: draft.id, rules: draft.rules, answers })).ok, "admin answers the questions");
  ok((await admin.act("approve_rules", { ruleset_id: draft.id })).ok, "admin approves the rules");
  ok((await admin.act("set_status", { contest_id: cid, status: "open" })).ok, "entries open");
  const inv = await admin.act("create_invite", { contest_id: cid, label: "Brothers" });
  const token = inv.data.token;

  // --- private access ---
  ok((await out.json(`/api/contests/${cid}`)).status === 404, "outsider can't load the private contest");
  ok((await out.act("join", { contest_id: cid })).status === 404, "outsider can't join without an invite");
  const outLive = out.listen(cid);
  ok((await outLive.ready) === 404, "outsider can't subscribe to its live stream");
  ok((await a.json(`/api/contests/${cid}`)).status === 404, "A can't see it before redeeming the invite");
  ok((await a.act("set_status", { contest_id: cid, status: "locked" })).status === 403, "A can't run admin actions");

  // --- both join from separate sessions ---
  const walletA0 = (await a.json(`/api/contests/${cid}`)).status;
  void walletA0;
  ok((await a.act("redeem_invite", { token })).ok, "A redeems the invite");
  ok((await b.act("redeem_invite", { token })).ok, "B redeems the invite");
  const viewA0 = (await a.json(`/api/contests/${cid}`)).data;
  ok(viewA0.terms.payout && viewA0.terms.tie && viewA0.terms.cancel && viewA0.contest.stake === 40, "terms (stake, payout, tie, cancel) shown before entering");
  const joins = await Promise.all([a.act("join", { contest_id: cid }), a.act("join", { contest_id: cid }), a.act("join", { contest_id: cid })]);
  ok(joins.every((j) => j.ok) && new Set(joins.map((j) => j.data.entry_id)).size === 1, "A's triple join (retry) returns one entry");
  ok((await b.act("join", { contest_id: cid })).ok, "B joins");
  const lockedEdit = await admin.act("update_contest", { contest_id: cid, patch: { stake: 999 } });
  ok(lockedEdit.status === 409, "terms locked after the first entry");

  // --- import the offline rosters ---
  const v1 = (await admin.json(`/api/contests/${cid}`)).data;
  const entA = v1.entrants.find((e) => e.username === `bro_a_${tag}`).entry_id;
  const entB = v1.entrants.find((e) => e.username === `bro_b_${tag}`).entry_id;
  const imp = await admin.act("import_draft", {
    contest_id: cid,
    rosters: [
      { entry_id: entA, picks: ["Ada Kessler", "Chen Wei", "Emil Sato", "Gus Moreau"] },
      { entry_id: entB, picks: ["Bruno Varga", "Dina Ross", "Farah Nadeem", "Hugo Lind"] },
    ],
  });
  ok(imp.ok && imp.data.picks === 8, "admin imports both rosters");

  // --- live updates to both sessions ---
  const la = a.listen(cid);
  const lb = b.listen(cid);
  ok((await la.ready) === 200 && (await lb.ready) === 200, "both sessions subscribe to live updates");
  await wait(300);
  const upset = [{
    event_key: "r1-moreau-varga", event_type: "match", label: "Moreau vs Varga", round: "Round 1", bracket: "main", status: "final",
    participants: [{ name: "Gus Moreau", result: "win" }, { name: "Bruno Varga", result: "loss" }], winner: "Gus Moreau",
  }];
  const mp = await admin.act("manual_preview", { contest_id: cid, facts: upset });
  ok(mp.ok && mp.data.plan.items[0].lines.length === 2, "admin previews the result: Match win +2, Upset bonus +3");
  ok((await admin.act("manual_apply", { contest_id: cid, facts: upset })).ok, "admin applies the result");
  await wait(800);
  ok(la.events.includes("change") && lb.events.includes("change"), "both sessions received a live change event");
  const va = (await a.json(`/api/contests/${cid}`)).data;
  const vb = (await b.json(`/api/contests/${cid}`)).data;
  const totals = (v) => Object.fromEntries(v.rosters.map((r) => [r.username, r.total]));
  ok(JSON.stringify(totals(va)) === JSON.stringify(totals(vb)), `both sessions see the same standings ${JSON.stringify(totals(va))}`);
  const gus = va.rosters.find((r) => r.username === `bro_a_${tag}`).picks.find((p) => p.name === "Gus Moreau");
  ok(gus.points === 5 && gus.lines.map((l) => `${l.label}:${l.points}`).join(",") === "Match win:2,Upset bonus:3", "Gus Moreau shows 5 pts = Match win +2, Upset bonus +3");
  ok(va.rosters.every((r) => r.picks.length === 4), "every drafted pick is listed, including zero-point picks");

  // reprocess -> zero; correction -> recalculated
  await admin.act("manual_apply", { contest_id: cid, facts: upset });
  const va2 = (await a.json(`/api/contests/${cid}`)).data;
  ok(JSON.stringify(totals(va2)) === JSON.stringify(totals(va)), "reprocessing the same match adds zero points");
  const corrected = [{ ...upset[0], participants: [{ name: "Gus Moreau", result: "loss" }, { name: "Bruno Varga", result: "win" }], winner: "Bruno Varga" }];
  const corr = await admin.act("manual_apply", { contest_id: cid, facts: corrected });
  ok(corr.data.counts.correction === 1, "a corrected result is recorded as a correction");
  const vb3 = (await b.json(`/api/contests/${cid}`)).data;
  ok(totals(vb3)[`bro_a_${tag}`] === 0 && totals(vb3)[`bro_b_${tag}`] === 2, `standings recalculated after correction ${JSON.stringify(totals(vb3))}`);
  ok(vb3.changes[0].kind === "correction", `change log shows: "${vb3.changes[0].summary}"`);

  // --- settle ---
  await admin.act("set_status", { contest_id: cid, status: "awaiting_settlement" });
  const sp = await admin.act("settlement_preview", { contest_id: cid });
  ok(sp.ok && sp.data.pot === 80, "settlement preview: 80-chip pot");
  ok((await a.act("settle", { contest_id: cid, outcome_id: null, hash: sp.data.hash })).status === 403, "entrants can't settle");
  const s1 = await admin.act("settle", { contest_id: cid, outcome_id: null, hash: sp.data.hash });
  const s2 = await admin.act("settle", { contest_id: cid, outcome_id: null, hash: sp.data.hash });
  ok(s1.data.result === "settled" && s2.data.result === "already_settled", "settlement retry doesn't pay twice");
  const fa = (await a.json(`/api/contests/${cid}`)).data;
  ok(fa.contest.status === "settled", "both see the settled contest");
  const payB = fa.entrants.find((e) => e.username === `bro_b_${tag}`).payout;
  ok(payB === 80, "Brother B (leader) is paid the pot");

  la.close();
  lb.close();
  outLive.close();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} — contest /c/${cid}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
