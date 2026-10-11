/** Read-only ranked-league standing for the signed-in wallet. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { getLeagueOverview } from './game/leagues';
import { defaultSeasonPrizePolicy, getLeagueSeasonView } from './game/leagueSeason';
import { parse } from './lib/validation';

const LeagueQuery = z.object({
  baseId: z.string().uuid().optional(),
}).strict();

export function registerLeagueRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get('/leagues', { preHandler: app.authenticate }, async (req) => {
    const query = parse(LeagueQuery, req.query);
    return getLeagueOverview(
      db,
      req.wallet,
      query.baseId,
      {
        enabled: config.LEAGUE_REWARDS_ENABLED === 'true',
        startWeek: config.LEAGUE_REWARD_START_WEEK,
      },
    );
  });

  /** The weekly season projection: season end, prize table and the would-be
   * winners. GET only; no claim, allocation or payment exists behind it. */
  app.get('/leagues/season', { preHandler: app.authenticate }, async (req) => {
    const query = parse(LeagueQuery, req.query);
    return getLeagueSeasonView(db, req.wallet, query.baseId, defaultSeasonPrizePolicy(config.SOLANA_CLUSTER));
  });
}
