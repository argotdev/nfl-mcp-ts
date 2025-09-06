#!/usr/bin/env node

/**
 * NFL Live MCP Server - TypeScript Version
 *
 * A comprehensive MCP server that provides tools to query NFL historical data from SQLite databases
 * and live data from ESPN's API.
 *
 * Usage:
 *   npm run dev -- --team-stats-db nfl_stats.db --plays-db nfl_plays.db --scores-db nfl_scores.db
 *   
 *   Or for Claude Desktop, add to your config:
 *   {
 *     "mcpServers": {
 *       "nfl-live": {
 *         "command": "node",
 *         "args": ["dist/server.js", 
 *                  "--team-stats-db", "nfl_stats.db", 
 *                  "--plays-db", "nfl_plays.db", 
 *                  "--scores-db", "nfl_scores.db"],
 *         "cwd": "/path/to/this/directory"
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import { parseArgs } from 'util';

// Global database paths
let TEAM_STATS_DB = '';
let PLAYS_DB = '';
let SCORES_DB = '';

// ESPN API endpoint
const ESPN_SCOREBOARD_URL = 'https://cdn.espn.com/core/nfl/scoreboard';

interface DatabaseRow {
  [key: string]: any;
}

interface ESPNGame {
  competitions: Array<{
    competitors: Array<{
      team: {
        name: string;
        displayName: string;
        abbreviation: string;
      };
      score: string;
      records?: Array<{
        type: string;
        summary: string;
      }>;
    }>;
    venue?: {
      fullName: string;
      address?: {
        city: string;
        state: string;
      };
    };
    broadcasts?: Array<{
      media?: {
        shortName: string;
      };
    }>;
    odds?: Array<{
      details: string;
      overUnder: string;
    }>;
  }>;
  status: {
    type: {
      name: string;
      detail: string;
    };
    period?: number;
    displayClock?: string;
  };
  date: string;
}

interface ESPNScoreboardResponse {
  content?: {
    sbData?: {
      events?: ESPNGame[];
      leagues?: Array<{
        season?: {
          year: string;
          type: {
            name: string;
          };
          week: {
            number: string;
          };
        };
      }>;
    };
  };
}

/**
 * Execute a query against a specific database and return results
 */
async function executeQuery(dbPath: string, query: string, params?: any[]): Promise<DatabaseRow[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(new Error(`Database connection error (${dbPath}): ${err.message}`));
        return;
      }
    });

    db.all(query, params || [], (err, rows) => {
      if (err) {
        db.close();
        reject(new Error(`Database error (${dbPath}): ${err.message}`));
        return;
      }
      
      db.close();
      resolve(rows as DatabaseRow[]);
    });
  });
}

/**
 * Fetch live NFL scoreboard data from ESPN API
 */
async function fetchLiveScoreboard(): Promise<ESPNScoreboardResponse> {
  try {
    const url = new URL(ESPN_SCOREBOARD_URL);
    url.searchParams.set('xhr', '1');
    url.searchParams.set('limit', '50');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json() as ESPNScoreboardResponse;
  } catch (error) {
    throw new Error(`ESPN API error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Format a game into a summary string
 */
function formatGameSummary(game: ESPNGame, showDate = false): string {
  try {
    const competition = game.competitions[0];
    const competitors = competition?.competitors || [];

    if (competitors.length < 2) {
      return 'Invalid game data';
    }

    // Get teams (away is typically index 1, home is index 0)
    const awayTeam = competitors[1]?.team || {};
    const homeTeam = competitors[0]?.team || {};
    
    const awayScore = competitors[1]?.score || '0';
    const homeScore = competitors[0]?.score || '0';

    // Game status
    const status = game.status;
    const statusName = status?.type?.name || 'Unknown';
    const statusDetail = status?.type?.detail || '';

    // Format the summary
    const awayName = awayTeam.abbreviation || 'TBD';
    const homeName = homeTeam.abbreviation || 'TBD';

    if (statusName === 'STATUS_SCHEDULED') {
      let gameStr = `${awayName} @ ${homeName}`;
      if (showDate && game.date) {
        try {
          const dt = new Date(game.date);
          gameStr += ` (${dt.toLocaleDateString()} ${dt.toLocaleTimeString()})`;
        } catch {
          // Ignore date parsing errors
        }
      }
      gameStr += ` - ${statusDetail}`;
      return gameStr;
    } else {
      let gameStr = `${awayName} ${awayScore} - ${homeName} ${homeScore}`;
      
      if (statusName === 'STATUS_IN_PROGRESS') {
        const period = status.period || 1;
        const clock = status.displayClock || '';
        gameStr += ` (${period}Q ${clock})`;
      } else if (statusName === 'STATUS_HALFTIME') {
        gameStr += ' (HALFTIME)';
      } else if (statusName === 'STATUS_FINAL') {
        if (statusDetail && statusDetail !== 'Final') {
          gameStr += ` (${statusDetail})`;
        } else {
          gameStr += ' (FINAL)';
        }
      }
      
      return gameStr;
    }
  } catch {
    return 'Error formatting game';
  }
}

/**
 * Format detailed game information
 */
function formatDetailedGame(game: ESPNGame): string {
  try {
    const competition = game.competitions[0];
    const competitors = competition?.competitors || [];

    if (competitors.length < 2) {
      return 'Invalid game data';
    }

    // Get teams
    const awayTeam = competitors[1];
    const homeTeam = competitors[0];

    let response = '🏈 Game Details\n\n';

    // Teams and scores
    const awayInfo = awayTeam?.team || {};
    const homeInfo = homeTeam?.team || {};

    response += `${awayInfo.displayName || 'Away Team'} (${awayInfo.abbreviation || 'AWAY'})\n`;
    response += 'vs\n';
    response += `${homeInfo.displayName || 'Home Team'} (${homeInfo.abbreviation || 'HOME'})\n\n`;

    // Score
    const awayScore = awayTeam?.score || '0';
    const homeScore = homeTeam?.score || '0';
    response += `Score: ${awayInfo.abbreviation || 'AWAY'} ${awayScore} - ${homeInfo.abbreviation || 'HOME'} ${homeScore}\n\n`;

    // Game status
    const status = game.status;
    const statusName = status?.type?.name || 'Unknown';
    const statusDetail = status?.type?.detail || '';

    if (statusName === 'STATUS_IN_PROGRESS') {
      const period = status.period || 1;
      const clock = status.displayClock || '';
      response += `Status: ${period}Q ${clock} - IN PROGRESS 🔴\n`;
    } else if (statusName === 'STATUS_HALFTIME') {
      response += 'Status: HALFTIME\n';
    } else if (statusName === 'STATUS_FINAL') {
      response += 'Status: FINAL\n';
    } else {
      response += `Status: ${statusDetail}\n`;
    }

    // Date and venue
    if (game.date) {
      try {
        const dt = new Date(game.date);
        response += `Date: ${dt.toLocaleDateString('en-US', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })} at ${dt.toLocaleTimeString('en-US')} UTC\n`;
      } catch {
        response += `Date: ${game.date}\n`;
      }
    }

    // Venue
    const venue = competition?.venue;
    if (venue) {
      response += `Venue: ${venue.fullName || 'N/A'}\n`;
      const address = venue.address;
      if (address?.city && address?.state) {
        response += `Location: ${address.city}, ${address.state}\n`;
      }
    }

    // Broadcast info
    const broadcasts = competition?.broadcasts || [];
    if (broadcasts.length > 0) {
      const networks = broadcasts
        .map(b => b.media?.shortName)
        .filter(Boolean);
      if (networks.length > 0) {
        response += `TV: ${networks.join(', ')}\n`;
      }
    }

    // Betting odds (if available)
    const odds = competition?.odds || [];
    if (odds.length > 0) {
      response += '\n📊 Betting Info:\n';
      const firstOdd = odds[0];
      if (firstOdd?.details) {
        response += `Spread: ${firstOdd.details}\n`;
      }
      if (firstOdd?.overUnder) {
        response += `Over/Under: ${firstOdd.overUnder}\n`;
      }
    }

    // Team records
    const awayRecord = awayTeam?.records || [];
    const homeRecord = homeTeam?.records || [];

    if (awayRecord.length > 0 || homeRecord.length > 0) {
      response += '\n📈 Records:\n';
      
      for (const record of awayRecord) {
        if (record.type === 'total') {
          response += `${awayInfo.abbreviation || 'AWAY'}: ${record.summary || 'N/A'}\n`;
        }
      }
      
      for (const record of homeRecord) {
        if (record.type === 'total') {
          response += `${homeInfo.abbreviation || 'HOME'}: ${record.summary || 'N/A'}\n`;
        }
      }
    }

    return response;
  } catch (error) {
    return `Error formatting game details: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

const server = new Server(
  {
    name: 'nfl-live-stats-scores',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_live_scores',
        description: 'Get current live NFL scores and game status from ESPN',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_live_game_details',
        description: 'Get detailed information about a specific live or recent NFL game',
        inputSchema: {
          type: 'object',
          properties: {
            team1: {
              type: 'string',
              description: 'First team name or abbreviation (e.g., "Bills", "BUF")',
            },
            team2: {
              type: 'string',
              description: 'Second team name or abbreviation (optional, will search for team1\'s current game if not provided)',
            },
          },
          required: ['team1'],
        },
      },
      {
        name: 'get_nfl_standings',
        description: 'Get current NFL standings and playoff picture',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_databases_overview',
        description: 'Get an overview of all available NFL databases and their contents',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_game_plays',
        description: 'Get all plays from a specific historical game (from database)',
        inputSchema: {
          type: 'object',
          properties: {
            away_team: {
              type: 'string',
              description: 'Away team abbreviation (e.g., "BUF", "KC")',
            },
            home_team: {
              type: 'string',
              description: 'Home team abbreviation (e.g., "BUF", "KC")',
            },
            season: {
              type: 'number',
              description: 'Season year',
            },
            week: {
              type: 'string',
              description: 'Week number or description (optional, gets first match if not specified)',
            },
          },
          required: ['away_team', 'home_team', 'season'],
        },
      },
      {
        name: 'get_team_season_record',
        description: 'Get a team\'s complete season record from historical database',
        inputSchema: {
          type: 'object',
          properties: {
            team: {
              type: 'string',
              description: 'Team abbreviation (e.g., "BUF", "KC", "GB")',
            },
            season: {
              type: 'number',
              description: 'Season year',
            },
          },
          required: ['team', 'season'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_live_scores': {
        try {
          const data = await fetchLiveScoreboard();
          
          // ESPN API has events under content.sbData.events
          const events = data.content?.sbData?.events || [];
          
          if (events.length === 0) {
            return {
              content: [{ type: 'text', text: 'No NFL games found in the current schedule' }],
            };
          }
          
          let response = '🏈 Live NFL Scores & Status\n';
          response += `Updated: ${new Date().toLocaleString()}\n\n`;
          
          const games = events;
          
          // Group games by status
          const liveGames: ESPNGame[] = [];
          const upcomingGames: ESPNGame[] = [];
          const finalGames: ESPNGame[] = [];
          
          for (const game of games) {
            const status = game.status?.type?.name || 'Unknown';
            
            if (['STATUS_IN_PROGRESS', 'STATUS_HALFTIME'].includes(status)) {
              liveGames.push(game);
            } else if (['STATUS_SCHEDULED', 'STATUS_POSTPONED'].includes(status)) {
              upcomingGames.push(game);
            } else {
              finalGames.push(game);
            }
          }
          
          // Show live games first
          if (liveGames.length > 0) {
            response += '🔴 LIVE GAMES:\n';
            for (const game of liveGames) {
              response += formatGameSummary(game) + '\n';
            }
          }
          
          // Show final games
          if (finalGames.length > 0) {
            response += '\n✅ FINAL SCORES:\n';
            for (const game of finalGames) {
              response += formatGameSummary(game) + '\n';
            }
          }
          
          // Show upcoming games
          if (upcomingGames.length > 0) {
            response += '\n⏰ UPCOMING GAMES:\n';
            for (const game of upcomingGames) {
              response += formatGameSummary(game) + '\n';
            }
          }
          
          return {
            content: [{ type: 'text', text: response }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error fetching live scores: ${error instanceof Error ? error.message : String(error)}` }],
          };
        }
      }

      case 'get_live_game_details': {
        const { team1, team2 } = args as { team1: string; team2?: string };
        
        try {
          const data = await fetchLiveScoreboard();
          
          // ESPN API has events under content.sbData.events
          const events = data.content?.sbData?.events || [];
          
          if (events.length === 0) {
            return {
              content: [{ type: 'text', text: 'No NFL games found in the current schedule' }],
            };
          }
          
          // Normalize team names for searching
          const team1Upper = team1.toUpperCase();
          const team2Upper = team2?.toUpperCase();
          
          let targetGame: ESPNGame | null = null;
          
          // Search for the game
          for (const game of events) {
            const competition = game.competitions[0];
            if (!competition) continue;
            
            const competitors = competition.competitors || [];
            if (competitors.length < 2) continue;
            
            const teamNames: string[] = [];
            const teamAbbrevs: string[] = [];
            
            for (const competitor of competitors) {
              const team = competitor.team;
              if (team) {
                teamNames.push((team.name || '').toUpperCase());
                teamNames.push((team.displayName || '').toUpperCase());
                teamAbbrevs.push((team.abbreviation || '').toUpperCase());
              }
            }
            
            // Check if team1 is in this game
            if (teamNames.includes(team1Upper) || teamAbbrevs.includes(team1Upper)) {
              if (!team2Upper) {
                // Found team1's game
                targetGame = game;
                break;
              } else if (teamNames.includes(team2Upper) || teamAbbrevs.includes(team2Upper)) {
                // Found both teams
                targetGame = game;
                break;
              }
            }
          }
          
          if (!targetGame) {
            const searchTerm = team2 ? `${team1} vs ${team2}` : team1;
            return {
              content: [{ type: 'text', text: `No current game found for ${searchTerm}` }],
            };
          }
          
          return {
            content: [{ type: 'text', text: formatDetailedGame(targetGame) }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error fetching game details: ${error instanceof Error ? error.message : String(error)}` }],
          };
        }
      }

      case 'get_nfl_standings': {
        try {
          const data = await fetchLiveScoreboard();
          
          let response = '📊 NFL Season Information\n\n';
          
          // Get season info from content.sbData
          const leagues = data.content?.sbData?.leagues || [];
          const seasonInfo = leagues[0]?.season;
          if (seasonInfo) {
            response += `Season: ${seasonInfo.year || 'N/A'}\n`;
            response += `Type: ${seasonInfo.type?.name || 'N/A'}\n`;
            response += `Week: ${seasonInfo.week?.number || 'N/A'}\n\n`;
          }
          
          response += 'For complete standings, please check ESPN.com or NFL.com\n';
          response += 'This tool focuses on live scores and game details.\n';
          
          // Show some recent results to give context
          const events = data.content?.sbData?.events || [];
          if (events.length > 0) {
            response += '\n📈 Recent Results:\n';
            const recentFinals = events
              .filter(g => g.status?.type?.name === 'STATUS_FINAL')
              .slice(0, 5);
            
            for (const game of recentFinals) {
              response += formatGameSummary(game, true) + '\n';
            }
          }
          
          return {
            content: [{ type: 'text', text: response }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error fetching NFL information: ${error instanceof Error ? error.message : String(error)}` }],
          };
        }
      }

      case 'get_databases_overview': {
        let response = 'NFL Databases Overview:\n\n';
        
        // Team Stats Database
        if (TEAM_STATS_DB && await fileExists(TEAM_STATS_DB)) {
          try {
            const results = await executeQuery(TEAM_STATS_DB, `
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
            for (const row of results) {
              response += `  ${row.season_type}: ${row.total_records} records, `;
              response += `${row.unique_teams} teams, seasons ${row.min_season}-${row.max_season}\n`;
            }
          } catch (error) {
            response += `📊 Team Stats Database: Error - ${error instanceof Error ? error.message : String(error)}\n`;
          }
        } else {
          response += '📊 Team Stats Database: Not available\n';
        }
        
        // Plays Database
        if (PLAYS_DB && await fileExists(PLAYS_DB)) {
          try {
            const results = await executeQuery(PLAYS_DB, `
              SELECT COUNT(*) as total_plays,
                     COUNT(DISTINCT season) as seasons,
                     MIN(season) as min_season,
                     MAX(season) as max_season,
                     COUNT(DISTINCT away_team || '-' || home_team || '-' || date) as unique_games
              FROM plays
            `);
            
            const row = results[0];
            response += `\n🏈 Plays Database:\n`;
            response += `  Total plays: ${Number(row.total_plays).toLocaleString()}\n`;
            response += `  Seasons: ${row.seasons} (${row.min_season}-${row.max_season})\n`;
            response += `  Unique games: ${Number(row.unique_games).toLocaleString()}\n`;
          } catch (error) {
            response += `\n🏈 Plays Database: Error - ${error instanceof Error ? error.message : String(error)}\n`;
          }
        } else {
          response += '\n🏈 Plays Database: Not available\n';
        }
        
        // Scores Database
        if (SCORES_DB && await fileExists(SCORES_DB)) {
          try {
            const results = await executeQuery(SCORES_DB, `
              SELECT COUNT(*) as total_games,
                     COUNT(DISTINCT season) as seasons,
                     MIN(season) as min_season,
                     MAX(season) as max_season,
                     COUNT(CASE WHEN post_season = 1 THEN 1 END) as playoff_games
              FROM games
            `);
            
            const row = results[0];
            response += `\n🏆 Games Database:\n`;
            response += `  Total games: ${Number(row.total_games).toLocaleString()}\n`;
            response += `  Seasons: ${row.seasons} (${row.min_season}-${row.max_season})\n`;
            response += `  Playoff games: ${Number(row.playoff_games).toLocaleString()}\n`;
          } catch (error) {
            response += `\n🏆 Games Database: Error - ${error instanceof Error ? error.message : String(error)}\n`;
          }
        } else {
          response += '\n🏆 Games Database: Not available\n';
        }
        
        response += '\n🔴 Live Data: ESPN API integration available\n';
        
        return {
          content: [{ type: 'text', text: response }],
        };
      }

      case 'get_game_plays': {
        const { away_team, home_team, season, week } = args as { 
          away_team: string; 
          home_team: string; 
          season: number; 
          week?: string; 
        };
        
        if (!PLAYS_DB || !await fileExists(PLAYS_DB)) {
          return {
            content: [{ type: 'text', text: 'Plays database not available' }],
          };
        }
        
        const awayTeam = away_team.toUpperCase();
        const homeTeam = home_team.toUpperCase();
        
        let baseQuery = `
          SELECT season, week, quarter, drive_number, play_number_in_drive,
                 team_with_possession, play_outcome, play_description, 
                 is_scoring_play, is_scoring_drive
          FROM plays 
          WHERE away_team = ? AND home_team = ? AND season = ?
        `;
        
        const params: (string | number)[] = [awayTeam, homeTeam, season];
        
        if (week) {
          baseQuery += ' AND week = ?';
          params.push(week);
        }
        
        baseQuery += ' ORDER BY quarter, drive_number, play_number_in_drive LIMIT 200';
        
        try {
          const results = await executeQuery(PLAYS_DB, baseQuery, params);
          
          if (results.length === 0) {
            return {
              content: [{ 
                type: 'text', 
                text: `No plays found for ${awayTeam} @ ${homeTeam} in ${season}${week ? ` week ${week}` : ''}` 
              }],
            };
          }
          
          let response = `Historical Game Plays: ${awayTeam} @ ${homeTeam} - ${season}${week ? ` Week ${week}` : ''}\n\n`;
          response += `Total plays: ${results.length}\n\n`;
          
          let currentQuarter: string | null = null;
          const scoringPlays: DatabaseRow[] = [];
          
          for (const play of results) {
            if (play.quarter !== currentQuarter) {
              currentQuarter = play.quarter;
              response += `\n=== ${currentQuarter} ===\n`;
            }
            
            if (play.is_scoring_play) {
              scoringPlays.push(play);
            }
            
            const scoringFlag = play.is_scoring_play ? ' 🏈' : '';
            response += `  ${play.team_with_possession}: ${play.play_outcome}${scoringFlag}\n`;
          }
          
          if (scoringPlays.length > 0) {
            response += `\n🏈 Scoring Plays (${scoringPlays.length}):\n`;
            for (const play of scoringPlays) {
              response += `  ${play.quarter} - ${play.team_with_possession}: ${play.play_outcome}\n`;
            }
          }
          
          return {
            content: [{ type: 'text', text: response }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error retrieving plays: ${error instanceof Error ? error.message : String(error)}` }],
          };
        }
      }

      case 'get_team_season_record': {
        const { team, season } = args as { team: string; season: number };
        
        if (!SCORES_DB || !await fileExists(SCORES_DB)) {
          return {
            content: [{ type: 'text', text: 'Scores database not available' }],
          };
        }
        
        const teamUpper = team.toUpperCase();
        
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
          LIMIT 20
        `;
        
        try {
          const results = await executeQuery(SCORES_DB, query, [
            teamUpper, teamUpper, teamUpper, teamUpper, teamUpper, teamUpper, teamUpper, season
          ]);
          
          if (results.length === 0) {
            return {
              content: [{ type: 'text', text: `No games found for ${teamUpper} in ${season}` }],
            };
          }
          
          // Calculate record
          const regularWins = results.filter(game => game.team_won && !game.post_season).length;
          const regularLosses = results.filter(game => !game.team_won && !game.post_season).length;
          
          let response = `${teamUpper} ${season} Historical Season Record\n\n`;
          response += `Regular Season: ${regularWins}-${regularLosses}\n`;
          
          response += '\nRecent Games:\n';
          for (const game of results.slice(0, 10)) { // Show up to 10 games
            const result = game.team_won ? 'W' : 'L';
            const location = game.home_away === 'Home' ? 'vs' : '@';
            
            response += `  Week ${String(game.week).padEnd(12)} ${result} ${location} ${String(game.opponent).padEnd(3)} `;
            response += `${Math.floor(game.team_score)}-${Math.floor(game.opponent_score)}\n`;
          }
          
          return {
            content: [{ type: 'text', text: response }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error retrieving season record: ${error instanceof Error ? error.message : String(error)}` }],
          };
        }
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

async function main() {
  // Check for environment variables first (for mcp dev compatibility)
  TEAM_STATS_DB = process.env.TEAM_STATS_DB || '';
  PLAYS_DB = process.env.PLAYS_DB || '';
  SCORES_DB = process.env.SCORES_DB || '';
  
  if (!TEAM_STATS_DB || !PLAYS_DB || !SCORES_DB) {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        'team-stats-db': {
          type: 'string',
          short: 't',
        },
        'plays-db': {
          type: 'string',
          short: 'p',
        },
        'scores-db': {
          type: 'string',
          short: 's',
        },
      },
    });
    
    TEAM_STATS_DB = values['team-stats-db'] || TEAM_STATS_DB;
    PLAYS_DB = values['plays-db'] || PLAYS_DB;
    SCORES_DB = values['scores-db'] || SCORES_DB;
  }
  
  // Note: We don't require databases to exist since we have live API functionality
  const availableSources = ['ESPN Live API'];
  
  if (TEAM_STATS_DB && await fileExists(TEAM_STATS_DB)) {
    availableSources.push('team stats DB');
  }
  if (PLAYS_DB && await fileExists(PLAYS_DB)) {
    availableSources.push('plays DB');
  }
  if (SCORES_DB && await fileExists(SCORES_DB)) {
    availableSources.push('scores DB');
  }
  
  console.error(`NFL Live Server - Available data sources: ${availableSources.join(', ')}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}