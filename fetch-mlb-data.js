// MLB PICK - 데이터 자동 수집 스크립트
// GitHub Actions에서 매일 실행되어 Supabase에 데이터를 채워넣습니다.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const MLB_API = "https://statsapi.mlb.com/api/v1";
const SEASON = new Date().getFullYear();

// 19시에 수집 → 21시에 "다음날 경기"를 분석하므로, 여기서도 내일 날짜를 수집
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const TODAY = tomorrow.toISOString().slice(0, 10);

if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE_URL / SUPABASE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

async function sbUpsert(table, rows, onConflict) {
  if (!Array.isArray(rows)) rows = [rows];
  if (rows.length === 0) return;
  const res = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[${table}] 저장 실패:`, res.status, text);
  }
}

async function sbInsert(table, rows) {
  if (!Array.isArray(rows)) rows = [rows];
  if (rows.length === 0) return;
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[${table}] insert 실패:`, res.status, text);
  }
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

// ---------- 1. 오늘 경기 + 날씨 ----------
async function fetchGames() {
  console.log(`📅 ${TODAY} 경기 수집 중...`);
  const data = await getJson(
    `${MLB_API}/schedule?sportId=1&date=${TODAY}&hydrate=team,probablePitcher,linescore,weather`
  );
  const games = (data.dates && data.dates[0] && data.dates[0].games) || [];

  for (const g of games) {
    await sbUpsert(
      "mlb_games",
      {
        game_pk: g.gamePk,
        game_date: TODAY,
        home_team: g.teams.home.team.name,
        away_team: g.teams.away.team.name,
        home_team_id: g.teams.home.team.id,
        away_team_id: g.teams.away.team.id,
        venue: g.venue ? g.venue.name : null,
        home_score: g.teams.home.score ?? null,
        away_score: g.teams.away.score ?? null,
        status: g.status.detailedState
      },
      "game_pk"
    );

    await sbInsert("mlb_raw_data", {
      source_endpoint: "schedule",
      reference_id: String(g.gamePk),
      season: SEASON,
      raw_json: g
    });

    if (g.weather) {
      const isRain = /rain|shower|drizzle/i.test(g.weather.condition || "");
      await sbUpsert(
        "mlb_weather_log",
        {
          game_pk: g.gamePk,
          condition: g.weather.condition || null,
          temp: g.weather.temp ? parseInt(g.weather.temp) : null,
          wind: g.weather.wind || null,
          team_id: g.teams.home.team.id,
          is_rain: isRain
        },
        "game_pk"
      );
    }
  }
  console.log(`✅ 경기 ${games.length}건 저장 완료`);
  return games;
}

// ---------- 2. 팀 스탯 + 타격 스플릿 ----------
async function fetchConsecutiveGames(teamId, targetDateStr) {
  try {
    const target = new Date(targetDateStr);
    const start = new Date(target);
    start.setDate(start.getDate() - 12);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = new Date(target.getTime() - 86400000).toISOString().slice(0, 10);

    const data = await getJson(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${startStr}&endDate=${endStr}`);
    const playedDates = new Set();
    (data.dates || []).forEach((d) => {
      const hasGame = d.games && d.games.some((g) => g.status.detailedState !== "Postponed" && g.status.detailedState !== "Cancelled");
      if (hasGame) playedDates.add(d.date);
    });

    let streak = 0;
    let cursor = new Date(target.getTime() - 86400000);
    while (playedDates.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    await sbUpsert(
      "mlb_team_stats",
      {
        team_id: teamId, season: SEASON,
        consecutive_games: streak,
        last_game_date: [...playedDates].sort().pop() || null
      },
      "team_id,season"
    );
  } catch (e) {
    console.error("연속경기 에러", teamId, e.message);
  }
}

async function fetchTeamBattingSplit(teamId, sitCode, splitType) {
  try {
    const data = await getJson(
      `${MLB_API}/teams/${teamId}/stats?stats=statSplits&sitCodes=${sitCode}&group=hitting&season=${SEASON}`
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return;
    await sbUpsert(
      "mlb_batting_splits",
      {
        team_id: teamId,
        season: SEASON,
        split_type: splitType,
        avg: parseFloat(stat.avg) || null,
        obp: parseFloat(stat.obp) || null,
        slg: parseFloat(stat.slg) || null,
        ops: parseFloat(stat.ops) || null,
        updated_at: new Date().toISOString()
      },
      "team_id,season,split_type"
    );
  } catch (e) {
    console.error("타격 스플릿 에러", teamId, e.message);
  }
}

async function fetchLast20Record(teamId, targetDateStr) {
  try {
    const target = new Date(targetDateStr);
    const start = new Date(target);
    start.setDate(start.getDate() - 35); // 20경기 확보 위해 넉넉히 35일 전부터
    const startStr = start.toISOString().slice(0, 10);
    const endStr = new Date(target.getTime() - 86400000).toISOString().slice(0, 10);

    const data = await getJson(
      `${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${startStr}&endDate=${endStr}`
    );
    const results = [];
    (data.dates || []).forEach((d) => {
      (d.games || []).forEach((g) => {
        if (g.status.detailedState !== "Final") return;
        const isHome = g.teams.home.team.id === teamId;
        const myScore = isHome ? g.teams.home.score : g.teams.away.score;
        const oppScore = isHome ? g.teams.away.score : g.teams.home.score;
        if (myScore == null || oppScore == null) return;
        results.push({ date: d.date, win: myScore > oppScore });
      });
    });
    results.sort((a, b) => (a.date < b.date ? 1 : -1)); // 최신순
    const last20 = results.slice(0, 20);
    const wins = last20.filter((r) => r.win).length;
    const losses = last20.length - wins;

    await sbUpsert(
      "mlb_team_stats",
      { team_id: teamId, season: SEASON, last20_wins: wins, last20_losses: losses },
      "team_id,season"
    );
  } catch (e) {
    console.error("최근20경기 에러", teamId, e.message);
  }
}

async function fetchStandings() {
  console.log("📊 팀 스탯(순위) 수집 중...");
  const data = await getJson(
    `${MLB_API}/standings?leagueId=103,104&season=${SEASON}&standingsTypes=regularSeason`
  );
  let count = 0;
  for (const rec of data.records || []) {
    for (const tr of rec.teamRecords) {
      const home = (tr.records.splitRecords || []).find((s) => s.type === "home");
      const away = (tr.records.splitRecords || []).find((s) => s.type === "away");
      const last10 = (tr.records.splitRecords || []).find((s) => s.type === "lastTen");
      const rs = tr.runsScored ?? null;
      const ra = tr.runsAllowed ?? null;
      const pyth = rs && ra ? Math.pow(rs, 1.83) / (Math.pow(rs, 1.83) + Math.pow(ra, 1.83)) : null;

      await sbUpsert(
        "mlb_team_stats",
        {
          team_id: tr.team.id,
          team_name: tr.team.name,
          season: SEASON,
          wins: tr.leagueRecord.wins,
          losses: tr.leagueRecord.losses,
          win_pct: parseFloat(tr.leagueRecord.pct),
          runs_scored: rs,
          runs_allowed: ra,
          pyth_win_pct: pyth,
          home_wins: home ? home.wins : null,
          home_losses: home ? home.losses : null,
          away_wins: away ? away.wins : null,
          away_losses: away ? away.losses : null,
          last10_wins: last10 ? last10.wins : null,
          last10_losses: last10 ? last10.losses : null,
          streak_code: tr.streak ? tr.streak.streakCode : null,
          updated_at: new Date().toISOString()
        },
        "team_id,season"
      );

      await fetchTeamBattingSplit(tr.team.id, "vl", "vs_lhp");
      await fetchTeamBattingSplit(tr.team.id, "vr", "vs_rhp");
      await fetchConsecutiveGames(tr.team.id, TODAY);
      await fetchLast20Record(tr.team.id, TODAY);
      await fetchTeamBatting(tr.team.id);
      await fetchBullpen(tr.team.id);

      await sbInsert("mlb_raw_data", {
        source_endpoint: "standings",
        reference_id: String(tr.team.id),
        season: SEASON,
        raw_json: tr
      });
      count++;
    }
  }
  console.log(`✅ 팀 스탯 ${count}건 저장 완료`);
}

async function fetchPitcherExtended(playerId, teamId, seasonStat, gameDateStr) {
  try {
    // K%/BB%/K-BB%/HR9/BABIP - season stat 기반 계산
    const bf = seasonStat.battersFaced || 0;
    const k = seasonStat.strikeOuts || 0;
    const bb = seasonStat.baseOnBalls || 0;
    const hr = seasonStat.homeRuns || 0;
    const ip = parseFloat(seasonStat.inningsPitched) || 0;
    const hits = seasonStat.hits || 0;
    const ab = seasonStat.battersFaced ? bf - bb - (seasonStat.hitBatsmen || 0) : 0;
    const sf = seasonStat.sacFlies || 0;

    const kPct = bf > 0 ? (k / bf) * 100 : null;
    const bbPct = bf > 0 ? (bb / bf) * 100 : null;
    const kBbPct = kPct != null && bbPct != null ? kPct - bbPct : null;
    const hr9 = ip > 0 ? (hr * 9) / ip : null;
    const babipDenom = ab - k - hr + sf;
    const babip = babipDenom > 0 ? (hits - hr) / babipDenom : null;

    // 홈/원정 ERA
    let homeEra = null, awayEra = null;
    const hData = await getJson(`${MLB_API}/people/${playerId}/stats?stats=statSplits&sitCodes=h&group=pitching&season=${SEASON}`);
    homeEra = parseFloat(hData.stats?.[0]?.splits?.[0]?.stat?.era) || null;
    const aData = await getJson(`${MLB_API}/people/${playerId}/stats?stats=statSplits&sitCodes=a&group=pitching&season=${SEASON}`);
    awayEra = parseFloat(aData.stats?.[0]?.splits?.[0]?.stat?.era) || null;

    // 낮/야간 경기 ERA
    let dayEra = null, nightEra = null;
    const dData = await getJson(`${MLB_API}/people/${playerId}/stats?stats=statSplits&sitCodes=d&group=pitching&season=${SEASON}`);
    dayEra = parseFloat(dData.stats?.[0]?.splits?.[0]?.stat?.era) || null;
    const nData = await getJson(`${MLB_API}/people/${playerId}/stats?stats=statSplits&sitCodes=n&group=pitching&season=${SEASON}`);
    nightEra = parseFloat(nData.stats?.[0]?.splits?.[0]?.stat?.era) || null;

    // 최근 등판일 / 휴식일 / 직전 경기 투구수
    let lastGameDate = null, daysRest = null, lastGamePitches = null;
    const logData = await getJson(`${MLB_API}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${SEASON}`);
    const games = logData.stats?.[0]?.splits || [];
    if (games.length > 0) {
      const sorted = [...games].sort((a, b) => (a.date < b.date ? 1 : -1)); // 최신순
      lastGameDate = sorted[0].date;
      lastGamePitches = sorted[0].stat?.numberOfPitches || null;
      if (gameDateStr && lastGameDate) {
        const diff = (new Date(gameDateStr) - new Date(lastGameDate)) / 86400000;
        daysRest = Math.round(diff);
      }
    }

    await sbUpsert(
      "mlb_pitchers",
      {
        player_id: playerId,
        season: SEASON,
        k_pct: kPct, bb_pct: bbPct, k_bb_pct: kBbPct, hr9, babip,
        home_era: homeEra, away_era: awayEra,
        days_rest: daysRest, last_game_date: lastGameDate,
        day_era: dayEra, night_era: nightEra, last_game_pitches: lastGamePitches
      },
      "player_id,season"
    );
  } catch (e) {
    console.error("투수 확장지표 에러", playerId, e.message);
  }
}

// ---------- 3. 오늘 경기 선발투수 + 스플릿 ----------
async function fetchPitcherSplit(playerId, sitCode, splitType) {
  try {
    const data = await getJson(
      `${MLB_API}/people/${playerId}/stats?stats=statSplits&sitCodes=${sitCode}&group=pitching&season=${SEASON}`
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return;
    await sbUpsert(
      "mlb_pitching_splits",
      {
        player_id: playerId,
        season: SEASON,
        split_type: splitType,
        avg_against: parseFloat(stat.avg) || null,
        obp_against: parseFloat(stat.obp) || null,
        slg_against: parseFloat(stat.slg) || null,
        ops_against: parseFloat(stat.ops) || null,
        updated_at: new Date().toISOString()
      },
      "player_id,season,split_type"
    );
  } catch (e) {
    console.error("투수 스플릿 에러", playerId, e.message);
  }
}

async function fetchPitchers(games) {
  console.log("⚾ 오늘 선발투수 수집 중...");
  let count = 0;
  for (const g of games) {
    for (const side of ["home", "away"]) {
      const team = g.teams[side];
      const p = team.probablePitcher;
      if (!p) continue;
      const data = await getJson(
        `${MLB_API}/people/${p.id}/stats?stats=season&group=pitching&season=${SEASON}`
      );
      const stat = data.stats?.[0]?.splits?.[0]?.stat;
      if (!stat) continue;

      const ip = parseFloat(stat.inningsPitched) || 0;
      const hr = stat.homeRuns || 0;
      const bb = stat.baseOnBalls || 0;
      const hbp = stat.hitByPitch || 0;
      const k = stat.strikeOuts || 0;
      const fip = ip > 0 ? ((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.1) : null;

      await sbUpsert(
        "mlb_pitchers",
        {
          player_id: p.id,
          player_name: p.fullName,
          team_id: team.team.id,
          season: SEASON,
          era: parseFloat(stat.era) || null,
          fip: fip,
          whip: parseFloat(stat.whip) || null,
          wins: stat.wins,
          losses: stat.losses,
          innings_pitched: ip,
          strikeouts: k,
          updated_at: new Date().toISOString()
        },
        "player_id,season"
      );

      await fetchPitcherSplit(p.id, "vl", "vs_lhb");
      await fetchPitcherSplit(p.id, "vr", "vs_rhb");
      await fetchPitcherExtended(p.id, team.team.id, stat, TODAY);
      count++;
    }
  }
  console.log(`✅ 선발투수 ${count}명 저장 완료`);
}

async function fetchTeamBatting(teamId) {
  try {
    const seasonData = await getJson(`${MLB_API}/teams/${teamId}/stats?stats=season&group=hitting&season=${SEASON}`);
    const s = seasonData.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return;

    const bf = s.plateAppearances || 0;
    const kPct = bf > 0 ? ((s.strikeOuts || 0) / bf) * 100 : null;
    const bbPct = bf > 0 ? ((s.baseOnBalls || 0) / bf) * 100 : null;

    const rispData = await getJson(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&sitCodes=risp&group=hitting&season=${SEASON}`);
    const rispAvg = parseFloat(rispData.stats?.[0]?.splits?.[0]?.stat?.avg) || null;

    const mkRange = (days) => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - days);
      return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    };

    async function rangeStat(days) {
      const r = mkRange(days);
      const data = await getJson(
        `${MLB_API}/teams/${teamId}/stats?stats=byDateRange&startDate=${r.start}&endDate=${r.end}&group=hitting&season=${SEASON}`
      );
      return data.stats?.[0]?.splits?.[0]?.stat || {};
    }
    const r7 = await rangeStat(7);
    const r15 = await rangeStat(15);
    const r30 = await rangeStat(30);

    await sbUpsert(
      "mlb_team_batting",
      {
        team_id: teamId, season: SEASON,
        avg: parseFloat(s.avg) || null, obp: parseFloat(s.obp) || null,
        slg: parseFloat(s.slg) || null, ops: parseFloat(s.ops) || null,
        runs: s.runs || 0, home_runs: s.homeRuns || 0, stolen_bases: s.stolenBases || 0,
        k_pct: kPct, bb_pct: bbPct, risp_avg: rispAvg,
        last7_avg: parseFloat(r7.avg) || null, last7_ops: parseFloat(r7.ops) || null,
        last15_avg: parseFloat(r15.avg) || null, last15_ops: parseFloat(r15.ops) || null,
        last30_avg: parseFloat(r30.avg) || null, last30_ops: parseFloat(r30.ops) || null,
        updated_at: new Date().toISOString()
      },
      "team_id,season"
    );
  } catch (e) {
    console.error("팀 타선 에러", teamId, e.message);
  }
}

async function fetchBullpen(teamId) {
  try {
    const seasonData = await getJson(`${MLB_API}/teams/${teamId}/stats?stats=season&group=pitching&season=${SEASON}`);
    const seasonStat = seasonData.stats?.[0]?.splits?.[0]?.stat || {};
    const seasonEraNum = parseFloat(seasonStat.era) || null;

    // MLB API는 '불펜만' 따로 분리한 통계를 제공하지 않아, 팀 투수 전체의 최근7일 ERA를
    // 근사 지표로 사용합니다. (선발 제외 정밀 계산은 박스스코어 전체 분석이 필요해 다음 단계로 보류)
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const r = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };

    const data = await getJson(
      `${MLB_API}/teams/${teamId}/stats?stats=byDateRange&startDate=${r.start}&endDate=${r.end}&group=pitching&season=${SEASON}`
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat || {};
    const last7dEra = parseFloat(stat.era) || null;

    let fatigueRisk = "LOW";
    if (last7dEra != null && seasonEraNum != null) {
      if (last7dEra > seasonEraNum * 1.4) fatigueRisk = "HIGH";
      else if (last7dEra > seasonEraNum * 1.15) fatigueRisk = "MEDIUM";
    }

    await sbUpsert(
      "mlb_bullpen",
      {
        team_id: teamId, season: SEASON,
        bullpen_era: seasonEraNum, bullpen_whip: parseFloat(stat.whip) || null,
        last7d_era: last7dEra,
        last3d_pitches: null,          // MLB API 미제공 - 수동입력 또는 박스스코어 정밀분석 필요
        closer_used_yesterday: null,   // 위와 동일
        setup_used_yesterday: null,
        fatigue_risk: fatigueRisk,
        updated_at: new Date().toISOString()
      },
      "team_id,season"
    );
  } catch (e) {
    console.error("불펜 에러", teamId, e.message);
  }
}

// ---------- 4. 타자/투수 리더보드 ----------
async function fetchBatterLeaders() {
  console.log("🏏 타자 리더보드 수집 중...");
  const data = await getJson(
    `${MLB_API}/stats/leaders?leaderCategories=onBasePlusSlugging&statGroup=hitting&season=${SEASON}&sportId=1&limit=30`
  );
  const leaders = data.leagueLeaders?.[0]?.leaders || [];
  let rank = 1;
  for (const l of leaders) {
    const sdata = await getJson(
      `${MLB_API}/people/${l.person.id}/stats?stats=season&group=hitting&season=${SEASON}`
    );
    const stat = sdata.stats?.[0]?.splits?.[0]?.stat;
    if (stat) {
      await sbUpsert(
        "mlb_batters",
        {
          player_id: l.person.id,
          player_name: l.person.fullName,
          team_id: l.team.id,
          season: SEASON,
          avg: parseFloat(stat.avg) || null,
          obp: parseFloat(stat.obp) || null,
          slg: parseFloat(stat.slg) || null,
          ops: parseFloat(stat.ops) || null,
          home_runs: stat.homeRuns || 0,
          rbi: stat.rbi || 0,
          rank_ops: rank,
          updated_at: new Date().toISOString()
        },
        "player_id,season"
      );
    }
    rank++;
  }
  console.log(`✅ 타자 ${leaders.length}명 저장 완료`);
}

async function fetchPitcherLeaders() {
  console.log("⚾ 투수 리더보드 수집 중...");
  const data = await getJson(
    `${MLB_API}/stats/leaders?leaderCategories=earnedRunAverage&statGroup=pitching&season=${SEASON}&sportId=1&limit=30&sortOrder=asc`
  );
  const leaders = data.leagueLeaders?.[0]?.leaders || [];
  let rank = 1;
  for (const l of leaders) {
    const sdata = await getJson(
      `${MLB_API}/people/${l.person.id}/stats?stats=season&group=pitching&season=${SEASON}`
    );
    const stat = sdata.stats?.[0]?.splits?.[0]?.stat;
    if (stat) {
      await sbUpsert(
        "mlb_pitcher_leaderboard",
        {
          player_id: l.person.id,
          player_name: l.person.fullName,
          team_id: l.team.id,
          season: SEASON,
          era: parseFloat(stat.era) || null,
          whip: parseFloat(stat.whip) || null,
          wins: stat.wins || 0,
          losses: stat.losses || 0,
          strikeouts: stat.strikeOuts || 0,
          saves: stat.saves || 0,
          rank_era: rank,
          updated_at: new Date().toISOString()
        },
        "player_id,season"
      );
    }
    rank++;
  }
  console.log(`✅ 투수 ${leaders.length}명 저장 완료`);
}

// ---------- 실행 ----------
(async () => {
  try {
    const games = await fetchGames();
    await fetchStandings();
    if (games.length > 0) await fetchPitchers(games);
    await fetchBatterLeaders();
    await fetchPitcherLeaders();
    console.log("🎉 전체 자동 수집 완료");
  } catch (e) {
    console.error("❌ 수집 중 에러:", e);
    process.exit(1);
  }
})();
