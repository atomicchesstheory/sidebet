import { asService, getDb, num } from "./db";
import { AppError } from "./errors";

/** Everything achievements are judged on, for one player (their own data). */
export type PlayerStats = {
  entered: number;
  bets_entered: number;
  drafts_entered: number;
  wins: number;
  best_streak: number;
  biggest_win: number;
  chips_won: number;
  underdog_wins: number;
  claims: number;
  friends: number;
  created: number;
  ran_to_payout: number;
};

export type AchievementDef = {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  reward: number;
  target: number;
  value: (s: PlayerStats) => number;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first_entry", title: "Pull up a chair", blurb: "Enter your first contest.", icon: "🪑", reward: 10, target: 1, value: (s) => s.entered },
  { id: "first_win", title: "Winner winner", blurb: "Win a contest.", icon: "🏆", reward: 20, target: 1, value: (s) => s.wins },
  { id: "hat_trick", title: "Hat trick", blurb: "Win 3 contests.", icon: "🎩", reward: 40, target: 3, value: (s) => s.wins },
  { id: "on_fire", title: "On fire", blurb: "Win 3 contests in a row.", icon: "🔥", reward: 50, target: 3, value: (s) => s.best_streak },
  { id: "big_haul", title: "Big haul", blurb: "Win 100+ chips in a single contest.", icon: "💰", reward: 30, target: 100, value: (s) => s.biggest_win },
  { id: "high_roller", title: "High roller", blurb: "Win 500 chips all-time.", icon: "🎰", reward: 75, target: 500, value: (s) => s.chips_won },
  { id: "underdog", title: "Underdog", blurb: "Win a bet backing the less popular side.", icon: "🐶", reward: 30, target: 1, value: (s) => s.underdog_wins },
  { id: "draft_day", title: "Draft day", blurb: "Play in a draft.", icon: "📋", reward: 15, target: 1, value: (s) => s.drafts_entered },
  { id: "regular", title: "Regular", blurb: "Enter 10 contests.", icon: "🎟️", reward: 25, target: 10, value: (s) => s.entered },
  { id: "squad_up", title: "Squad up", blurb: "Add your first friend.", icon: "🤝", reward: 10, target: 1, value: (s) => s.friends },
  { id: "the_crew", title: "The crew", blurb: "Have 5 friends.", icon: "👥", reward: 30, target: 5, value: (s) => s.friends },
  { id: "commish", title: "Commish", blurb: "Set up your own bet.", icon: "📝", reward: 15, target: 1, value: (s) => s.created },
  { id: "closer", title: "Closer", blurb: "Run your own bet all the way to payout.", icon: "✅", reward: 25, target: 1, value: (s) => s.ran_to_payout },
  { id: "daily_grind", title: "Daily grind", blurb: "Claim free chips 7 times.", icon: "☕", reward: 20, target: 7, value: (s) => s.claims },
  { id: "never_misses", title: "Never misses", blurb: "Claim free chips 30 times.", icon: "📅", reward: 60, target: 30, value: (s) => s.claims },
];

/** Longest run of consecutive wins in a list of results (oldest first). */
export function bestStreak(results: string[]): number {
  let best = 0;
  let run = 0;
  for (const r of results) {
    if (r === "won") best = Math.max(best, ++run);
    else if (r !== "push") run = 0;
  }
  return best;
}

export async function playerStats(userId: string): Promise<PlayerStats> {
  const db = await getDb();
  const [r] = await db.query<Record<string, unknown>>(
    `select
       (select count(*) from public.entries e where e.user_id = $1) as entered,
       (select count(*) from public.entries e join public.contests c on c.id = e.contest_id where e.user_id = $1 and c.kind = 'bet') as bets_entered,
       (select count(*) from public.entries e join public.contests c on c.id = e.contest_id where e.user_id = $1 and c.kind = 'draft') as drafts_entered,
       (select count(*) from public.entries e where e.user_id = $1 and e.status = 'won') as wins,
       (select coalesce(max(e.payout - e.stake), 0) from public.entries e where e.user_id = $1 and e.payout > 0) as biggest_win,
       (select coalesce(sum(greatest(e.payout - e.stake, 0)), 0) from public.entries e where e.user_id = $1) as chips_won,
       (select coalesce(array_agg(e.status order by c.settled_at), '{}') from public.entries e join public.contests c on c.id = e.contest_id
         where e.user_id = $1 and c.status = 'settled') as results,
       (select count(*) from public.entries e join public.bet_picks b on b.entry_id = e.id
         where e.user_id = $1 and e.status = 'won'
           and (select count(*) from public.bet_picks x where x.contest_id = e.contest_id and x.outcome_id = b.outcome_id)
             < (select count(*) from public.bet_picks x where x.contest_id = e.contest_id and x.outcome_id <> b.outcome_id)) as underdog_wins,
       (select count(*) from public.ledger l where l.user_id = $1 and l.kind = 'free_claim') as claims,
       (select count(*) from public.friendships f where f.status = 'accepted' and (f.requester = $1 or f.addressee = $1)) as friends,
       (select count(*) from public.contests c where c.manual and c.created_by = $1) as created,
       (select count(*) from public.contests c where c.manual and c.created_by = $1 and c.status = 'settled') as ran_to_payout`,
    [userId],
  );
  return {
    entered: num(r.entered),
    bets_entered: num(r.bets_entered),
    drafts_entered: num(r.drafts_entered),
    wins: num(r.wins),
    best_streak: bestStreak((r.results as string[]) ?? []),
    biggest_win: num(r.biggest_win),
    chips_won: num(r.chips_won),
    underdog_wins: num(r.underdog_wins),
    claims: num(r.claims),
    friends: num(r.friends),
    created: num(r.created),
    ran_to_payout: num(r.ran_to_payout),
  };
}

export type AchievementView = Omit<AchievementDef, "value"> & {
  progress: number;
  state: "claimed" | "ready" | "locked";
  claimed_at: string | null;
};

export async function listAchievements(userId: string) {
  const db = await getDb();
  const [stats, claims] = await Promise.all([
    playerStats(userId),
    db.query<{ achievement_id: string; claimed_at: string }>("select achievement_id, claimed_at from public.achievement_claims where user_id = $1", [userId]),
  ]);
  const claimed = new Map(claims.map((c) => [c.achievement_id, new Date(c.claimed_at).toISOString()]));
  const items: AchievementView[] = ACHIEVEMENTS.map(({ value, ...a }) => {
    const progress = Math.min(value(stats), a.target);
    const at = claimed.get(a.id) ?? null;
    return { ...a, progress, claimed_at: at, state: at ? "claimed" : progress >= a.target ? "ready" : "locked" };
  });
  return {
    items,
    ready: items.filter((i) => i.state === "ready").length,
    earned: items.filter((i) => i.state === "claimed").reduce((s, i) => s + i.reward, 0),
    available: items.reduce((s, i) => s + i.reward, 0),
  };
}

export async function readyAchievementCount(userId: string) {
  return (await listAchievements(userId)).ready;
}

/** The app checks eligibility; the database records the claim once and pays it. */
export async function claimAchievement(userId: string, id: string) {
  const def = ACHIEVEMENTS.find((a) => a.id === id);
  if (!def) throw new AppError("validation", "Unknown achievement.");
  const stats = await playerStats(userId);
  if (def.value(stats) < def.target) throw new AppError("achievement_locked");
  const res = await asService(async (q) => {
    const [r] = await q.query<{ ok: boolean }>("select sidebet_private.claim_achievement($1, $2, $3, $4) as ok", [userId, def.id, def.reward, `Achievement: ${def.title}`]);
    const [w] = await q.query<{ balance: number }>("select balance from public.wallets where user_id = $1", [userId]);
    return { claimed: r.ok, balance: w?.balance ?? 0 };
  });
  return { ...res, reward: res.claimed ? def.reward : 0 };
}
