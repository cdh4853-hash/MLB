// MLB PICK - 21시 자동 분석 스크립트
// 19시에 수집된 데이터를 기반으로 다음날 경기를 분석하여 mlb_ai_predictions에 저장합니다.
// 데이터 수집(fetch-mlb-data.js)과 분석 로직을 분리했습니다 - 원본 데이터는 절대 수정하지 않습니다.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const SEASON = new Date().getFullYear();

// 다음날 날짜 (한국시간 21시에 도는 스크립트이므로, "내일" 경기를 분석)
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const TARGET_DATE = tomorrow.toISOString().slice(0, 10);

if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE_URL / SUPABASE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

async function sbSelect(table, query) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  if (!res.ok) {
    console.error(`[${table}] 조회 실패:`, res.status, await res.text());
    return [];
  }
  return res.json();
}

async function sbUpsert(table, rows, onConflict) {
  if (!Array.isArray(rows)) rows = [rows];
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
  if (!res.ok) console.error(`[${table}] 저장 실패:`, res.status, await res.text());
}

// ---------- 점수 정규화 ----------
function normalize(val, min, max) {
  if (val == null) return 50;
  const v = Math.max(min, Math.min(max, val));
  return ((v - min) / (max - min)) * 100;
}

// ---------- 상대전적 계산 (원본 데이터 조회만, 수정 없음) ----------
async function calcH2H(teamA, teamB) {
  const games = await sbSelect(
    "mlb_games",
    `or=(and(home_team_id.eq.${teamA},away_team_id.eq.${teamB}),and(home_team_id.eq.${teamB},away_team_id.eq.${teamA}))&status=eq.Final`
  );
  let aWins = 0, bWins = 0;
  games.forEach((g) => {
    if (g.home_score == null || g.away_score == null) return;
    const winnerId = g.home_score > g.away_score ? g.home_team_id : g.away_team_id;
    if (winnerId === teamA) aWins++;
    else if (winnerId === teamB) bWins++;
  });
  return { aWins, bWins };
}

// ---------- 경기 하나 분석 ----------
async function analyzeGame(g, teamStatsMap, pitchersMap) {
  const home = teamStatsMap[g.home_team_id];
  const away = teamStatsMap[g.away_team_id];
  const riskFactors = [];

  // 데이터 부족 체크
  if (!home || !away) riskFactors.push("팀 스탯 데이터 부족");

  // 1. 피타고리안 (40%)
  const pythHome = home?.pyth_win_pct != null ? home.pyth_win_pct * 100 : 50;
  const pythAway = away?.pyth_win_pct != null ? away.pyth_win_pct * 100 : 50;

  // 2. 최근10경기 (30%)
  const l10Home = home ? normalize(home.last10_wins, 0, 10) : 50;
  const l10Away = away ? normalize(away.last10_wins, 0, 10) : 50;

  // 3. 선발투수 매치업 - FIP (20%)
  const rawGame = (await sbSelect("mlb_raw_data", `source_endpoint=eq.schedule&reference_id=eq.${g.game_pk}&order=fetched_at.desc&limit=1`))[0];
  let fipHome = 50, fipAway = 50;
  if (rawGame?.raw_json?.teams) {
    const homeP = rawGame.raw_json.teams.home.probablePitcher;
    const awayP = rawGame.raw_json.teams.away.probablePitcher;
    if (!homeP || !awayP) riskFactors.push("선발투수 미확정");
    const pHome = homeP ? pitchersMap[homeP.id] : null;
    const pAway = awayP ? pitchersMap[awayP.id] : null;
    if (pHome && pAway) {
      // FIP 낮을수록 유리 → 역산 정규화 (1.5~6.0 범위 기준)
      fipHome = 100 - normalize(pHome.fip, 1.5, 6.0);
      fipAway = 100 - normalize(pAway.fip, 1.5, 6.0);
    } else {
      riskFactors.push("투수 기록 부족");
    }
  }

  // 4. 홈/어웨이 + 상대전적 (10%)
  const h2h = await calcH2H(g.home_team_id, g.away_team_id);
  const h2hTotal = h2h.aWins + h2h.bWins;
  const h2hHome = h2hTotal > 0 ? (h2h.aWins / h2hTotal) * 100 : 50;
  const h2hAway = h2hTotal > 0 ? (h2h.bWins / h2hTotal) * 100 : 50;
  if (h2hTotal < 3) riskFactors.push("상대전적 표본 부족");

  const homeScore = pythHome * 0.4 + l10Home * 0.3 + fipHome * 0.2 + h2hHome * 0.1;
  const awayScore = pythAway * 0.4 + l10Away * 0.3 + fipAway * 0.2 + h2hAway * 0.1;
  const total = homeScore + awayScore;
  const winProbHome = total > 0 ? (homeScore / total) * 100 : 50;
  const winProbAway = 100 - winProbHome;
  const confidence = Math.abs(homeScore - awayScore);

  // 추천/신뢰도 판정
  let recommendation, confidenceLevel;
  if (riskFactors.length >= 2 || confidence < 5) {
    recommendation = "PASS";
    confidenceLevel = "LOW";
  } else if (confidence > 15) {
    recommendation = homeScore > awayScore ? "BET_HOME" : "BET_AWAY";
    confidenceLevel = "HIGH";
  } else if (confidence > 7) {
    recommendation = homeScore > awayScore ? "BET_HOME" : "BET_AWAY";
    confidenceLevel = "MEDIUM";
  } else {
    recommendation = "PASS";
    confidenceLevel = "LOW";
  }

  await sbUpsert(
    "mlb_ai_predictions",
    {
      game_pk: g.game_pk,
      game_date: g.game_date,
      home_team: g.home_team,
      away_team: g.away_team,
      win_prob_home: winProbHome,
      win_prob_away: winProbAway,
      recommendation,
      confidence_level: confidenceLevel,
      risk_factors: riskFactors,
      key_factors: { pythHome, pythAway, l10Home, l10Away, fipHome, fipAway, h2hHome, h2hAway },
      analyzed_at: new Date().toISOString()
    },
    "game_pk"
  );

  console.log(`  ${g.away_team} @ ${g.home_team} → ${recommendation} (${confidenceLevel}, 홈승률 ${winProbHome.toFixed(1)}%)`);
}

// ---------- 실행 ----------
(async () => {
  try {
    console.log(`🧠 ${TARGET_DATE} 경기 분석 시작...`);

    const games = await sbSelect("mlb_games", `game_date=eq.${TARGET_DATE}`);
    if (games.length === 0) {
      console.log("분석할 경기가 없어요 (아직 수집 안 됐을 수 있음)");
      return;
    }

    const teamStats = await sbSelect("mlb_team_stats", `season=eq.${SEASON}`);
    const teamStatsMap = {};
    teamStats.forEach((t) => (teamStatsMap[t.team_id] = t));

    const pitchers = await sbSelect("mlb_pitchers", `season=eq.${SEASON}`);
    const pitchersMap = {};
    pitchers.forEach((p) => (pitchersMap[p.player_id] = p));

    for (const g of games) {
      await analyzeGame(g, teamStatsMap, pitchersMap);
    }

    console.log(`🎉 ${games.length}경기 분석 완료`);
  } catch (e) {
    console.error("❌ 분석 중 에러:", e);
    process.exit(1);
  }
})();
