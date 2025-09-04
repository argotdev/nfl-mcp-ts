#!/usr/bin/env node
/**
 * NFL Comprehensive MCP Server
 * 
 * A Model Context Protocol server providing NFL statistics, game scores, and play data
 * 
 * Usage:
 *   npm run start -- --team-stats-db nfl_stats.db --plays-db nfl_plays.db --scores-db nfl_scores.db
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { parseArgs } from 'util';
import { existsSync } from 'fs';

// ============= Types and Enums =============

enum SeasonType {
  REG = 'REG',
  POST = 'POST',
  PRE = 'PRE'
}

enum PlayoffRound {
  WILD_CARD = 'Wild Card',
  DIVISIONAL = 'Divisional',
  CONFERENCE = 'Conference',
  SUPER_BOWL = 'Super Bowl'
}

interface TeamStats {
  team: string;
  season: number;
  season_type: SeasonType;
  games: number;
  passing_yards: number;
  passing_tds: number;
  passing_interceptions: number;
  rushing_yards: number;
  rushing_tds: number;
  receiving_yards: number;
  receiving_tds: number;
  def_sacks: number;
  def_interceptions: number;
  fg_pct?: number;
}

interface Play {
  season: number;
  week: string;
  away_team: string;
  home_team: string;
  quarter: string;
  drive_number: number;
  play_number_in_drive: number;
  team_with_possession: string;
  play_outcome: string;
  play_description: string;
  is_scoring_play: boolean;
  is_scoring_drive: boolean;
}

interface Game {
  season: number;
  week: string;
  game_status: string;
  day: string;
  date: string;
  away_team: string;
  away_record: string;
  away_score: number;
  away_win: boolean;
  away_seeding?: number;
  home_team: string;
  home_record: string;
  home_score: number;
  home_win: boolean;
  home_seeding?: number;
  post_season: boolean;
}

// ============= Database Manager =============

class NFLDatabaseManager {
  private teamStatsDb?: Database.Database;
  private playsDb?: Database.Database;
  private scoresDb?: Database.Database;

  constructor(
    teamStatsPath?: string,
    playsPath?: string,
    scoresPath?: string
  ) {
    if (teamStatsPath && existsSync(teamStatsPath)) {
      this.teamStatsDb = new Database(teamStatsPath, { readonly: true });
    }
    if (playsPath && existsSync(playsPath)) {
      this.playsDb = new Database(playsPath, { readonly: true });
    }
    if (scoresPath && existsSync(scoresPath)) {
      this.scoresDb = new Database(scoresPath, { readonly: true });
    }
  }

  hasAnyDatabase(): boolean {
    return !!(this.teamStatsDb || this.playsDb || this.scoresDb);
  }

  getAvailableDatabases(): string[] {
    const available: string[] = [];
    if (this.teamStatsDb) available.push('team stats');
    if (this.playsDb) available.push('plays');
    if (this.scoresDb) available.push('scores');
    return available;
  }

  queryTeamStats<T>(query: string, params?: any[]): T[] {
    if (!this.teamStatsDb) {
      throw new Error('Team stats database not available');
    }
    const stmt = this.teamStatsDb.prepare(query);
    return params ? stmt.all(...params) as T[] : stmt.all() as T[];
  }

  queryPlays<T>(query: string, params?: any[]): T[] {
    if (!this.playsDb) {
      throw new Error('Plays database not available');
    }
    const stmt = this.playsDb.prepare(query);
    return params ? stmt.all(...params) as T[] : stmt.all() as T[];
  }

  queryScores<T>(query: string, params?: any[]): T[] {
    if (!this.scoresDb) {
      throw new Error('Scores database not available');
    }
    const stmt = this.scoresDb.prepare(query);
    return params ? stmt.all(...params) as T[] : stmt.all() as T[];
  }

  close(): void {
    this.teamStatsDb?.close();
    this.playsDb?.close();
    this.scoresDb?.close();
  }
}

// ============= Validation Schemas =============

const TeamCodeSchema = z.string().min(2).max(3).transform(s => s.toUpperCase());
const SeasonSchema = z.number().int().min(1920).max(2030);
const SeasonTypeSchema = z.nativeEnum(SeasonType);
const PlayoffRoundSchema = z.nativeEnum(PlayoffRound);

// Tool parameter schemas
const GetTeamStatsSchema = z.object({
  team: TeamCodeSchema,
  season: SeasonSchema.optional(),
  season_type: SeasonTypeSchema.default(SeasonType.REG)
});

const GetGamePlaysSchema = z.object({
  away_team: TeamCodeSchema,
  home_team: TeamCodeSchema,
  season: SeasonSchema,
  week: z.string().optional()
});

const GetGameScoreSchema = z.object({
  away_team: TeamCodeSchema,
  home_team: TeamCodeSchema,
  season: SeasonSchema,
  week: z.string().optional()
});

const SearchPlaysByOutcomeSchema = z.object({
  play_outcome: z.string(),
  season: SeasonSchema.optional(),
  team: TeamCodeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20)
});

const GetTeamSeasonRecordSchema = z.object({
  team: TeamCodeSchema,
  season: SeasonSchema
});

const GetPlayoffResultsSchema = z.object({
  season: SeasonSchema,
  round_name: PlayoffRoundSchema.optional()
});

// ============= Server Implementation =============

class NFLServer {
  private server: Server;
  private db: NFLDatabaseManager;

  constructor(db: NFLDatabaseManager) {
    this.db = db;
    this.server = new Server(
      {
        name: 'nfl-comprehensive',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_databases_overview',
          description: 'Get an overview of all available NFL databases and their contents',
          inputSchema: zodToJsonSchema(z.object({}))
        },
        {
          name: 'get_team_stats',
          description: 'Get detailed statistics for a specific NFL team',
          inputSchema: zodToJsonSchema(GetTeamStatsSchema)
        },
        {
          name: 'get_game_plays',
          description: 'Get all plays from a specific game',
          inputSchema: zodToJsonSchema(GetGamePlaysSchema)
        },
        {
          name: 'get_game_score',
          description: 'Get the final score and details for a specific game',
          inputSchema: zodToJsonSchema(GetGameScoreSchema)
        },
        {
          name: 'search_plays_by_outcome',
          description: 'Search for plays by their outcome (e.g., Touchdown, Interception)',
          inputSchema: zodToJsonSchema(SearchPlaysByOutcomeSchema)
        },
        {
          name: 'get_team_season_record',
          description: 'Get a team\'s complete season record including all games',
          inputSchema: zodToJsonSchema(GetTeamSeasonRecordSchema)
        },
        {
          name: 'get_playoff_results',
          description: 'Get playoff results for a specific season',
          inputSchema: zodToJsonSchema(GetPlayoffResultsSchema)
        }
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'get_databases_overview':
            return { content: [{ type: 'text', text: this.getDatabasesOverview() }] };
          
          case 'get_team_stats': {
            const params = GetTeamStatsSchema.parse(args);
            return { content: [{ type: 'text', text: this.getTeamStats(params) }] };
          }
          
          case 'get_game_plays': {
            const params = GetGamePlaysSchema.parse(args);
            return { content: [{ type: 'text', text: this.getGamePlays(params) }] };
          }
          
          case 'get_game_score': {
            const params = GetGameScoreSchema.parse(args);
            return { content: [{ type: 'text', text: this.getGameScore(params) }] };
          }
          
          case 'search_plays_by_outcome': {
            const params = SearchPlaysByOutcomeSchema.parse(args);
            return { content: [{ type: 'text', text: this.searchPlaysByOutcome(params) }] };
          }
          
          case 'get_team_season_record': {
            const params = GetTeamSeasonRecordSchema.parse(args);
            return { content: [{ type: 'text', text: this.getTeamSeasonRecord(params) }] };
          }
          
          case 'get_playoff_results': {
            const params = GetPlayoffResultsSchema.parse(args);
            return { content: [{ type: 'text', text: this.getPlayoffResults(params) }] };
          }
          
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            content: [{
              type: 'text',
              text: `Invalid parameters: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
            }]
          };
        }
        return {
          content: [{
            type: 'text',
            text: error instanceof Error ? error.message : 'An unknown error occurred'
          }]
        };
      }
    });
  }

  // Tool implementations
  private getDatabasesOverview(): string {
    let response = 'NFL Databases Overview:\n\n';

    // Team Stats Database
    try {
      const stats = this.db.queryTeamStats<any>(`
        SELECT season_type, 
               COUNT(*) as total_records,
               COUNT(DISTINCT team) as unique_teams,
               MIN(season) as min_season,
               MAX(season) as max_season
        FROM team_stats 
        GROUP BY season_type
        ORDER BY season_type
      `);
      
      response += '📊 Team Stats Database:\n';
      for (const row of stats) {
        response += `  ${row.season_type}: ${row.total_records} records, `;
        response += `${row.unique_teams} teams, seasons ${row.min_season}-${row.max_season}\n`;
      }
    } catch (e) {
      response += '📊 Team Stats Database: Not available\n';
    }

    // Plays Database
    try {
      const plays = this.db.queryPlays<any>(`
        SELECT COUNT(*) as total_plays,
               COUNT(DISTINCT season) as seasons,
               MIN(season) as min_season,
               MAX(season) as max_season,
               COUNT(DISTINCT away_team || '-' || home_team || '-' || date) as unique_games
        FROM plays
      `);
      
      const row = plays[0];
      response += '\n🏈 Plays Database:\n';
      response += `  Total plays: ${row.total_plays.toLocaleString()}\n`;
      response += `  Seasons: ${row.seasons} (${row.min_season}-${row.max_season})\n`;
      response += `  Unique games: ${row.unique_games.toLocaleString()}\n`;
    } catch (e) {
      response += '\n🏈 Plays Database: Not available\n';
    }

    // Scores Database
    try {
      const games = this.db.queryScores<any>(`
        SELECT COUNT(*) as total_games,
               COUNT(DISTINCT season) as seasons,
               MIN(season) as min_season,
               MAX(season) as max_season,
               SUM(CASE WHEN post_season = 1 THEN 1 ELSE 0 END) as playoff_games
        FROM games
      `);
      
      const row = games[0];
      response += '\n🏆 Games Database:\n';
      response += `  Total games: ${row.total_games.toLocaleString()}\n`;
      response += `  Seasons: ${row.seasons} (${row.min_season}-${row.max_season})\n`;
      response += `  Playoff games: ${row.playoff_games.toLocaleString()}\n`;
    } catch (e) {
      response += '\n🏆 Games Database: Not available\n';
    }

    return response;
  }

  private getTeamStats(params: z.infer<typeof GetTeamStatsSchema>): string {
    const { team, season, season_type } = params;

    try {
      let results: TeamStats[];
      
      if (season) {
        results = this.db.queryTeamStats<TeamStats>(
          'SELECT * FROM team_stats WHERE team = ? AND season = ? AND season_type = ?',
          [team, season, season_type]
        );
      } else {
        results = this.db.queryTeamStats<TeamStats>(
          'SELECT * FROM team_stats WHERE team = ? AND season_type = ? ORDER BY season DESC LIMIT 3',
          [team, season_type]
        );
      }

      if (results.length === 0) {
        return `No team stats found for ${team}${season ? ` in ${season}` : ''} (${season_type})`;
      }

      let response = `Team Stats for ${team}${season ? ` - ${season}` : ''} (${season_type}):\n\n`;
      
      for (const row of results) {
        response += `Season: ${row.season}\n`;
        response += `Games: ${row.games}\n`;
        response += `Passing Yards: ${row.passing_yards}\n`;
        response += `Passing TDs: ${row.passing_tds}\n`;
        response += `Rushing Yards: ${row.rushing_yards}\n`;
        response += `Defensive Sacks: ${row.def_sacks}\n\n`;
      }

      return response;
    } catch (error) {
      return `Error retrieving team stats: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  private getGamePlays(params: z.infer<typeof GetGamePlaysSchema>): string {
    const { away_team, home_team, season, week } = params;

    try {
      let query = `
        SELECT season, week, quarter, drive_number, play_number_in_drive,
               team_with_possession, play_outcome, play_description, 
               is_scoring_play, is_scoring_drive
        FROM plays 
        WHERE away_team = ? AND home_team = ? AND season = ?
      `;
      
      const queryParams: any[] = [away_team, home_team, season];
      
      if (week) {
        query += ' AND week = ?';
        queryParams.push(week);
      }
      
      query += ' ORDER BY quarter, drive_number, play_number_in_drive';
      
      const results = this.db.queryPlays<Play>(query, queryParams);

      if (results.length === 0) {
        return `No plays found for ${away_team} @ ${home_team} in ${season}${week ? ` week ${week}` : ''}`;
      }

      let response = `Game Plays: ${away_team} @ ${home_team} - ${season}${week ? ` Week ${week}` : ''}\n\n`;
      response += `Total plays: ${results.length}\n\n`;

      let currentQuarter: string | null = null;
      let currentDrive: number | null = null;

      for (const play of results) {
        if (play.quarter !== currentQuarter) {
          currentQuarter = play.quarter;
          response += `\n=== ${currentQuarter} ===\n`;
          currentDrive = null;
        }

        if (play.drive_number !== currentDrive) {
          currentDrive = play.drive_number;
          response += `\nDrive ${currentDrive} (${play.team_with_possession}):\n`;
        }

        const scoringFlag = play.is_scoring_play ? ' 🏈' : '';
        response += `  ${play.play_number_in_drive.toString().padStart(2)}. ${play.play_outcome}${scoringFlag}\n`;
        
        if (results.length <= 50) {
          const desc = play.play_description.slice(0, 100);
          response += `      ${desc}${play.play_description.length > 100 ? '...' : ''}\n`;
        }
      }

      return response;
    } catch (error) {
      return `Error retrieving plays: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  private getGameScore(params: z.infer<typeof GetGameScoreSchema>): string {
    const { away_team, home_team, season, week } = params;

    try {
      let query = `
        SELECT season, week, game_status, day, date,
               away_team, away_record, away_score, away_win,
               home_team, home_record, home_score, home_win,
               away_seeding, home_seeding, post_season
        FROM games 
        WHERE away_team = ? AND home_team = ? AND season = ?
      `;
      
      const queryParams: any[] = [away_team, home_team, season];
      
      if (week) {
        query += ' AND week = ?';
        queryParams.push(week);
      }

      const results = this.db.queryScores<Game>(query, queryParams);

      if (results.length === 0) {
        return `No game found for ${away_team} @ ${home_team} in ${season}${week ? ` week ${week}` : ''}`;
      }

      const game = results[0];

      let response = `Game Result: ${game.away_team} @ ${game.home_team}\n\n`;
      response += `Date: ${game.day}, ${game.date}\n`;
      response += `Season: ${game.season} Week ${game.week}\n`;
      response += `Status: ${game.game_status}\n`;

      if (game.post_season) {
        response += `🏆 Playoff Game\n`;
        if (game.away_seeding) {
          response += `Seeding: ${game.away_team} #${game.away_seeding} vs ${game.home_team} #${game.home_seeding}\n`;
        }
      }

      response += '\nScore:\n';

      const winner = game.away_win ? game.away_team : game.home_team;
      const loser = game.away_win ? game.home_team : game.away_team;
      const winnerScore = game.away_win ? game.away_score : game.home_score;
      const loserScore = game.away_win ? game.home_score : game.away_score;

      response += `  ${winner} ${winnerScore} - ${loser} ${loserScore}\n\n`;

      response += 'Records:\n';
      response += `  ${game.away_team}: ${game.away_record}\n`;
      response += `  ${game.home_team}: ${game.home_record}\n`;

      return response;
    } catch (error) {
      return `Error retrieving game score: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  private searchPlaysByOutcome(params: z.infer<typeof SearchPlaysByOutcomeSchema>): string {
    const { play_outcome, season, team, limit } = params;

    try {
      let query = `
        SELECT season, week, away_team, home_team, quarter,
               team_with_possession, play_outcome, play_description
        FROM plays 
        WHERE play_outcome LIKE ?
      `;
      
      const queryParams: any[] = [`%${play_outcome}%`];

      if (season) {
        query += ' AND season = ?';
        queryParams.push(season);
      }

      if (team) {
        query += ' AND (away_team = ? OR home_team = ? OR team_with_possession = ?)';
        queryParams.push(team, team, team);
      }

      query += ' ORDER BY season DESC, week DESC LIMIT ?';
      queryParams.push(limit);

      const results = this.db.queryPlays<Play>(query, queryParams);

      if (results.length === 0) {
        let searchDesc = `'${play_outcome}'`;
        if (season) searchDesc += ` in ${season}`;
        if (team) searchDesc += ` involving ${team}`;
        return `No plays found for ${searchDesc}`;
      }

      let response = `Plays with outcome '${play_outcome}'`;
      if (season) response += ` (${season})`;
      if (team) response += ` involving ${team}`;
      response += ':\n\n';

      results.forEach((play, i) => {
        response += `${(i + 1).toString().padStart(2)}. ${play.season} Week ${play.week} - `;
        response += `${play.away_team} @ ${play.home_team}\n`;
        response += `    ${play.quarter} - ${play.team_with_possession}: ${play.play_outcome}\n`;
        const desc = play.play_description.slice(0, 100);
        response += `    ${desc}${play.play_description.length > 100 ? '...' : ''}\n\n`;
      });

      return response;
    } catch (error) {
      return `Error searching plays: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  private getTeamSeasonRecord(params: z.infer<typeof GetTeamSeasonRecordSchema>): string {
    const { team, season } = params;

    try {
      const query = `
        SELECT week, day, date, game_status,
               away_team, away_score, home_team, home_score,
               CASE 
                   WHEN away_team = ? THEN away_win
                   ELSE home_win
               END as team_won,
               CASE 
                   WHEN away_team = ? THEN away_score
                   ELSE home_score  
               END as team_score,
               CASE 
                   WHEN away_team = ? THEN home_score
                   ELSE away_score
               END as opponent_score,
               CASE 
                   WHEN away_team = ? THEN home_team
                   ELSE away_team
               END as opponent,
               CASE 
                   WHEN away_team = ? THEN 'Away'
                   ELSE 'Home'
               END as home_away,
               post_season
        FROM games 
        WHERE (away_team = ? OR home_team = ?) AND season = ?
        ORDER BY 
          post_season ASC,
          CASE 
              WHEN week LIKE '%Preseason%' THEN 0
              WHEN week = 'Wild Card' THEN 19
              WHEN week = 'Divisional' THEN 20
              WHEN week = 'Conference' THEN 21
              WHEN week = 'Super Bowl' THEN 22
              ELSE CAST(week AS INTEGER)
          END
      `;

      const results = this.db.queryScores<any>(
        query,
        [team, team, team, team, team, team, team, season]
      );

      if (results.length === 0) {
        return `No games found for ${team} in ${season}`;
      }

      // Calculate record
      const regularWins = results.filter((g: any) => g.team_won && !g.post_season).length;
      const regularLosses = results.filter((g: any) => !g.team_won && !g.post_season).length;
      const playoffWins = results.filter((g: any) => g.team_won && g.post_season).length;
      const playoffLosses = results.filter((g: any) => !g.team_won && g.post_season).length;

      let response = `${team} ${season} Season Record\n\n`;
      response += `Regular Season: ${regularWins}-${regularLosses}\n`;
      if (playoffWins || playoffLosses) {
        response += `Playoffs: ${playoffWins}-${playoffLosses}\n`;
      }
      response += '\nGames:\n';

      let currentSeasonType: string | null = null;
      for (const game of results) {
        // Separate regular season and playoffs
        if (game.post_season && currentSeasonType !== 'playoffs') {
          currentSeasonType = 'playoffs';
          response += '\nPlayoffs:\n';
        } else if (!game.post_season && currentSeasonType !== 'regular') {
          if (currentSeasonType !== null) {
            response += '\nRegular Season:\n';
          }
          currentSeasonType = 'regular';
        }

        const result = game.team_won ? 'W' : 'L';
        const location = game.home_away === 'Home' ? 'vs' : '@';

        response += `  Week ${game.week.padEnd(12)} ${result} ${location} ${game.opponent.padEnd(3)} `;
        response += `${game.team_score}-${game.opponent_score}\n`;
      }

      return response;
    } catch (error) {
      return `Error retrieving season record: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  private getPlayoffResults(params: z.infer<typeof GetPlayoffResultsSchema>): string {
    const { season, round_name } = params;

    try {
      let query = `
        SELECT week, day, date, away_team, away_score, away_seeding,
               home_team, home_score, home_seeding, away_win, home_win
        FROM games 
        WHERE season = ? AND post_season = 1
      `;
      
      const queryParams: any[] = [season];

      if (round_name) {
        query += ' AND week = ?';
        queryParams.push(round_name);
      }

      query += ` ORDER BY 
        CASE week 
          WHEN 'Wild Card' THEN 1 
          WHEN 'Divisional' THEN 2 
          WHEN 'Conference' THEN 3 
          WHEN 'Super Bowl' THEN 4 
        END, date`;

      const results = this.db.queryScores<Game>(query, queryParams);

      if (results.length === 0) {
        const searchDesc = round_name ? `${season} ${round_name}` : `${season} playoffs`;
        return `No playoff games found for ${searchDesc}`;
      }

      let response = `🏆 ${season} NFL Playoffs`;
      if (round_name) response += ` - ${round_name}`;
      response += '\n\n';

      let currentRound: string | null = null;
      for (const game of results) {
        if (game.week !== currentRound) {
          currentRound = game.week;
          response += `\n${currentRound}:\n`;
        }

        const winner = game.away_win ? game.away_team : game.home_team;
        const loser = game.away_win ? game.home_team : game.away_team;
        const winnerScore = game.away_win ? game.away_score : game.home_score;
        const loserScore = game.away_win ? game.home_score : game.away_score;
        const winnerSeed = game.away_win ? game.away_seeding : game.home_seeding;
        const loserSeed = game.away_win ? game.home_seeding : game.away_seeding;

        let seedDisplay = '';
        if (winnerSeed && loserSeed) {
          seedDisplay = ` (#${winnerSeed} def #${loserSeed})`;
        }

        response += `  ${winner} ${winnerScore} - ${loser} ${loserScore}${seedDisplay}\n`;
      }

      return response;
    } catch (error) {
      return `Error retrieving playoff results: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  async run(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
    console.error(`NFL Server running - Connected databases: ${this.db.getAvailableDatabases().join(', ')}`);
  }
}

// ============= Main Entry Point =============

async function main() {
  // Parse command line arguments
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'team-stats-db': { type: 'string' },
      'plays-db': { type: 'string' },
      'scores-db': { type: 'string' },
    },
  });

  // Check environment variables as fallback
  const teamStatsPath = values['team-stats-db'] || process.env.TEAM_STATS_DB;
  const playsPath = values['plays-db'] || process.env.PLAYS_DB;
  const scoresPath = values['scores-db'] || process.env.SCORES_DB;

  // Initialize database manager
  const db = new NFLDatabaseManager(teamStatsPath, playsPath, scoresPath);

  if (!db.hasAnyDatabase()) {
    console.error('Error: No valid databases found');
    console.error('Checked paths:');
    console.error(`  Team stats: ${teamStatsPath || 'not specified'}`);
    console.error(`  Plays: ${playsPath || 'not specified'}`);
    console.error(`  Scores: ${scoresPath || 'not specified'}`);
    process.exit(1);
  }

  // Create and run server
  const server = new NFLServer(db);
  const transport = new StdioServerTransport();
  
  await server.run(transport);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('Shutting down...');
  process.exit(0);
});

// Run the server
main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});