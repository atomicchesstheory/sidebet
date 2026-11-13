import { asService, getDb, num } from "./db";
import { AppError } from "./errors";

/** Everything achievements are judged on, for one player (their own data). */
export type PlayerStats = {
  entered: number;
  bets_entered: number;
  drafts_entered: number;
  wins: number;
  draft_wins: number;
  best_streak: number;
  biggest_win: number;
  chips_won: number;
  underdog_wins: number;
  biggest_stake: number;
  biggest_table: number;
  claims: number;
  friends: number;
  created: number;
  ran_to_payout: number;
};

/**
 * Each family has three tiers. Tier I is the base goal and reward; tier II is
 * 3× the goal for 3× the reward; tier III is 10× the goal for 10× the reward.
 */
export const TIER_MULTIPLIERS = [1, 3, 10] as const;
export const TIER_LABELS = ["I", "II", "III"] as const;

export type AchievementFamily = {
  id: string;
  title: string;
  icon: string;
  /** Goal description for a target, e.g. n => `Win ${n} contests.` */
  blurb: (n: number) => string;
  base: number;
  reward: number;
  value: (s: PlayerStats) => number;
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const FAMILIES: AchievementFamily[] = [
  { id: "entries", title: "Pull up a chair", icon: "🎟️", base: 1, reward: 10, value: (s) => s.entered, blurb: (n) => `Enter ${plural(n, "contest", "contests")}.` },
  { id: "wins", title: "Winner winner", icon: "🏆", base: 1, reward: 20, value: (s) => s.wins, blurb: (n) => `Win ${plural(n, "contest", "contests")}.` },
  { id: "streak", title: "On fire", icon: "🔥", base: 3, reward: 50, value: (s) => s.best_streak, blurb: (n) => `Win ${n} contests in a row.` },
  { id: "big_haul", title: "Big haul", icon: "💰", base: 100, reward: 30, value: (s) => s.biggest_win, blurb: (n) => `Win ${n.toLocaleString()}+ chips in a single contest.` },
  { id: "high_roller", title: "High roller", icon: "🎰", base: 500, reward: 75, value: (s) => s.chips_won, blurb: (n) => `Win ${n.toLocaleString()} chips all-time.` },
  { id: "underdog", title: "Underdog", icon: "🐶", base: 1, reward: 30, value: (s) => s.underdog_wins, blurb: (n) => `Win ${plural(n, "bet", "bets")} backing the less popular side.` },
  { id: "drafts", title: "Draft day", icon: "📋", base: 1, reward: 15, value: (s) => s.drafts_entered, blurb: (n) => `Play in ${plural(n, "draft", "drafts")}.` },
  { id: "draft_champ", title: "Draft champ", icon: "👑", base: 1, reward: 40, value: (s) => s.draft_wins, blurb: (n) => `Win ${plural(n, "draft", "drafts")}.` },
  { id: "high_stakes", title: "High stakes", icon: "💎", base: 50, reward: 15, value: (s) => s.biggest_stake, blurb: (n) => `Put up ${n.toLocaleString()}+ chips on a single contest.` },
  { id: "full_house", title: "Full house", icon: "🍿", base: 4, reward: 15, value: (s) => s.biggest_table, blurb: (n) => `Play in a contest with ${n}+ players.` },
  { id: "friends", title: "Squad up", icon: "🤝", base: 1, reward: 10, value: (s) => s.friends, blurb: (n) => `Have ${plural(n, "friend", "friends")}.` },
  { id: "commish", title: "Commish", icon: "📝", base: 1, reward: 15, value: (s) => s.created, blurb: (n) => `Set up ${plural(n, "bet", "bets")} of your own.` },
  { id: "closer", title: "Closer", icon: "✅", base: 1, reward: 25, value: (s) => s.ran_to_payout, blurb: (n) => `Run ${plural(n, "of your own bets", "of your own bets")} all the way to payout.` },
  { id: "claims", title: "Regular", icon: "☕", base: 4, reward: 20, value: (s) => s.claims, blurb: (n) => `Claim your weekly free chips ${n} times.` },
];

export type AchievementDef = {
  id: string; // `${family}:${tier}`
  family: string;
  tier: number; // 1..3
  title: string;
  blurb: string;
  icon: string;
  reward: number;
  target: number;
};

export const ACHIEVEMENTS: AchievementDef[] = FAMILIES.flatMap((f) =>
  TIER_MULTIPLIERS.map((m, i) => ({
    id: `${f.id}:${i + 1}`,
    family: f.id,
    tier: i + 1,
    title: `${f.title} ${TIER_LABELS[i]}`,
    blurb: f.blurb(f.base * m),
    icon: f.icon,
    reward: f.reward * m,
    target: f.base * m,
  })),
);

/** Achievements from before tiers. A claim under an old id counts as that tier claimed (never paid twice). */
export const LEGACY_IDS: Record<string, string> = {
  first_entry: "entries:1",
  regular: "entries:3",
  first_win: "wins:1",
  hat_trick: "wins:2",
  on_fire: "streak:1",
  big_haul: "big_haul:1",
  high_roller: "high_roller:1",
  underdog: "underdog:1",
  draft_day: "drafts:1",
  squad_up: "friends:1",
  the_crew: "friends:2",
  commish: "commish:1",
  closer: "closer:1",
  daily_grind: "claims:1",
  never_misses: "claims:2",
};

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
       (select count(*) from public.entries e join public.contests c on c.id = e.contest_id where e.user_id = $1 and c.kind = 'draft' and e.status = 'won') as draft_wins,
       (select coalesce(max(e.payout - e.stake), 0) from public.entries e where e.user_id = $1 and e.payout > 0) as biggest_win,
       (select coalesce(sum(greatest(e.payout - e.stake, 0)), 0) from public.entries e where e.user_id = $1) as chips_won,
       (select coalesce(max(e.stake), 0) from public.entries e where e.user_id = $1) as biggest_stake,
       (select coalesce(max((select count(*) from public.entries x where x.contest_id = e.contest_id)), 0)
          from public.entries e where e.user_id = $1) as biggest_table,
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
    draft_wins: num(r.draft_wins),
    best_streak: bestStreak((r.results as string[]) ?? []),
    biggest_win: num(r.biggest_win),
    chips_won: num(r.chips_won),
    underdog_wins: num(r.underdog_wins),
    biggest_stake: num(r.biggest_stake),
    biggest_table: num(r.biggest_table),
    claims: num(r.claims),
    friends: num(r.friends),
    created: num(r.created),
    ran_to_payout: num(r.ran_to_payout),
  };
}

export type AchievementView = AchievementDef & {
  progress: number;
  state: "claimed" | "ready" | "locked";
  claimed_at: string | null;
};

export type FamilyView = {
  id: string;
  title: string;
  icon: string;
  value: number;
  tiers: AchievementView[];
};

/** Claimed tier ids for a player, with legacy (pre-tier) claims mapped onto their tier. */
async function claimedTiers(userId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.query<{ achievement_id: string; claimed_at: string }>(
    "select achievement_id, claimed_at from public.achievement_claims where user_id = $1",
    [userId],
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    const tierId = LEGACY_IDS[r.achievement_id] ?? r.achievement_id;
    if (!out.has(tierId)) out.set(tierId, new Date(r.claimed_at).toISOString());
  }
  return out;
}

export async function listAchievements(userId: string) {
  const [stats, claimed] = await Promise.all([playerStats(userId), claimedTiers(userId)]);
  const families: FamilyView[] = FAMILIES.map((f) => {
    const value = f.value(stats);
    return {
      id: f.id,
      title: f.title,
      icon: f.icon,
      value,
      tiers: ACHIEVEMENTS.filter((a) => a.family === f.id).map((a): AchievementView => {
        const at = claimed.get(a.id) ?? null;
        return { ...a, progress: Math.min(value, a.target), claimed_at: at, state: at ? "claimed" : value >= a.target ? "ready" : "locked" };
      }),
    };
  });
  const items = families.flatMap((f) => f.tiers);
  return {
    families,
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
  const fam = FAMILIES.find((f) => f.id === def.family)!;
  const [stats, claimed] = await Promise.all([playerStats(userId), claimedTiers(userId)]);
  if (fam.value(stats) < def.target) throw new AppError("achievement_locked");
  if (claimed.has(def.id)) {
    // Already claimed (possibly under its pre-tier id): never pay twice.
    const [w] = await asService((q) => q.query<{ balance: number }>("select balance from public.wallets where user_id = $1", [userId]));
    return { claimed: false, balance: w?.balance ?? 0, reward: 0 };
  }
  const res = await asService(async (q) => {
    const [r] = await q.query<{ ok: boolean }>("select sidebet_private.claim_achievement($1, $2, $3, $4) as ok", [userId, def.id, def.reward, `Achievement: ${def.title}`]);
    const [w] = await q.query<{ balance: number }>("select balance from public.wallets where user_id = $1", [userId]);
    return { claimed: r.ok, balance: w?.balance ?? 0 };
  });
  return { ...res, reward: res.claimed ? def.reward : 0 };
}
