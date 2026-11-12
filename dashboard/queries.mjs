// Parameterized read-only queries. Every metric is scoped to the configured game.
// yesterdaySameTime compares the same Beijing wall-clock instant one day earlier, from a single
// materialized DB clock shared with generatedAt/today (never a browser or request clock):
//   window = [yesterday 00:00 Beijing, cutoff] with cutoff = (now Beijing local - 1 day), inclusive.
//   - dau uses game_daily_logins.first_login_at/activity_date, NOT mutable game_users.last_login_at.
//     It is null when yesterday <= coverage_start: the coverage day was backfilled from last_login_at,
//     so first logins before tracking started are not reconstructible (unknown is not zero).
//   - newUsers counts completed registrations created in the window; other apps are excluded.
//   - invitedNewUsers additionally requires the binding's invited_at <= cutoff, so a late bind is
//     not attributed retrospectively to yesterday-at-that-time. Claimed and unclaimed both count.
//   - todayRewardedVideos is the card's yesterday value: app events recorded in the window.
// The existing history/metrics keep their full-Beijing-day semantics and are unchanged.
export async function overview(pool, appId) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    ), settings AS (
      SELECT (moment.at AT TIME ZONE 'Asia/Shanghai')::date AS today,
        moment.at AS generated_at,tracking_started_at,coverage_start,
        ((moment.at AT TIME ZONE 'Asia/Shanghai') - interval '1 day')::date AS yesterday,
        ((moment.at AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AS yesterday_local
      FROM moment CROSS JOIN game_analytics_metadata WHERE id=true
    ), bounds AS (
      SELECT yesterday,yesterday::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_start,
        yesterday_local AT TIME ZONE 'Asia/Shanghai' AS cutoff_at
      FROM settings
    ), dates AS (
      SELECT today-n AS d,settings.* FROM settings CROSS JOIN generate_series(0,13) n
    ), daily AS (
      SELECT d,today,coverage_start,
        (SELECT count(*)::float8 FROM game_rewarded_video_events e WHERE e.app_id=$1
          AND e.recorded_at>=d::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND e.recorded_at<(d+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS rewarded_videos,
        (SELECT count(*)::float8 FROM game_users u JOIN game_rewarded_video_events e
          ON e.app_id=u.app_id AND e.user_id=u.id
          WHERE u.app_id=$1 AND u.first_login_completed
            AND u.created_at>=d::timestamp AT TIME ZONE 'Asia/Shanghai'
            AND u.created_at<(d+1)::timestamp AT TIME ZONE 'Asia/Shanghai'
            AND e.recorded_at>=d::timestamp AT TIME ZONE 'Asia/Shanghai'
            AND e.recorded_at<(d+1)::timestamp AT TIME ZONE 'Asia/Shanghai'
            AND e.recorded_at>=u.created_at) AS registered_user_videos,
        (SELECT count(*)::int FROM game_users u WHERE u.app_id=$1 AND u.first_login_completed
          AND u.created_at>=d::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND u.created_at<(d+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS new_users,
        (SELECT count(*)::int FROM game_users u WHERE u.app_id=$1 AND u.first_login_completed
          AND u.created_at>=d::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND u.created_at<(d+1)::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND EXISTS (SELECT 1 FROM game_invitations i WHERE i.app_id=u.app_id AND i.invitee_user_id=u.id)
        ) AS invited_new_users,
        CASE WHEN d>=coverage_start THEN
          (SELECT count(*)::int FROM game_daily_logins l WHERE l.app_id=$1 AND l.activity_date=d)
        END AS dau,
        (SELECT count(*)::int FROM game_users u WHERE u.app_id=$1 AND u.first_login_completed
          AND u.created_at>=(d-1)::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND u.created_at<d::timestamp AT TIME ZONE 'Asia/Shanghai') AS cohort_size,
        CASE WHEN d>=coverage_start THEN
          (SELECT count(*)::int FROM game_users u JOIN game_daily_logins l
             ON l.app_id=u.app_id AND l.user_id=u.id AND l.activity_date=d
           WHERE u.app_id=$1 AND u.first_login_completed
             AND u.created_at>=(d-1)::timestamp AT TIME ZONE 'Asia/Shanghai'
             AND u.created_at<d::timestamp AT TIME ZONE 'Asia/Shanghai')
        END AS returned
      FROM dates
    ) SELECT json_build_object(
      'today',s.today::text,'timezone','Asia/Shanghai','environment','production','generatedAt',s.generated_at,
      'trackingStartedAt',s.tracking_started_at,'coverageStart',s.coverage_start::text,
      'metrics',json_build_object('dau',current.dau,'newUsers',current.new_users,
        'invitedNewUsers',current.invited_new_users,
        'todayRewardedVideos',current.rewarded_videos,
        'totalUsers',(SELECT count(*)::int FROM game_users WHERE app_id=$1 AND first_login_completed),
        'd1',json_build_object('cohortDate',(s.today-1)::text,'cohortSize',current.cohort_size,
          'returned',current.returned,'rate',current.returned::float8/nullif(current.cohort_size,0))),
      'yesterdaySameTime',json_build_object(
        'date',b.yesterday::text,'cutoffAt',b.cutoff_at,
        'dau',CASE WHEN b.yesterday>s.coverage_start THEN
          (SELECT count(*)::int FROM game_daily_logins l WHERE l.app_id=$1 AND l.activity_date=b.yesterday
            AND l.first_login_at>=b.day_start AND l.first_login_at<=b.cutoff_at) END,
        'newUsers',(SELECT count(*)::int FROM game_users u WHERE u.app_id=$1 AND u.first_login_completed
          AND u.created_at>=b.day_start AND u.created_at<=b.cutoff_at),
        'invitedNewUsers',(SELECT count(*)::int FROM game_users u WHERE u.app_id=$1 AND u.first_login_completed
          AND u.created_at>=b.day_start AND u.created_at<=b.cutoff_at
          AND EXISTS (SELECT 1 FROM game_invitations i WHERE i.app_id=u.app_id AND i.invitee_user_id=u.id
            AND i.invited_at<=b.cutoff_at)),
        'todayRewardedVideos',(SELECT count(*)::int FROM game_rewarded_video_events e WHERE e.app_id=$1
          AND e.recorded_at>=b.day_start AND e.recorded_at<=b.cutoff_at)),
      'history',(SELECT json_agg(json_build_object('date',h.d::text,'newUsers',h.new_users,'dau',h.dau,
          'invitedNewUsers',h.invited_new_users,'rewardedVideos',h.rewarded_videos,'registeredUserVideos',h.registered_user_videos,'retentionDate',(h.d+1)::text,'d1Pending',h.d=s.today,
          'cohortSize',h.new_users,'returned',next_day.returned,
          'd1Rate',next_day.returned::float8/nullif(h.new_users,0)) ORDER BY h.d)
        FROM daily h LEFT JOIN daily next_day ON next_day.d=h.d+1)
    ) AS result FROM settings s JOIN daily current ON current.d=s.today CROSS JOIN bounds b`, [appId]);
  if (!rows[0]?.result) throw new Error('Analytics metadata unavailable');
  return rows[0].result;
}

export async function player(pool, appId, identifier, lookupType = 'openid') {
  if(!['openid','uid'].includes(lookupType))throw new Error('Invalid player lookup type');
  // Only fixed server-selected predicates are interpolated; values stay parameterized.
  const predicate=lookupType==='uid'?'u.id=$2::uuid':'u.open_id=$2';
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    ), settings AS (
      SELECT (at AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_start,
        ((at AT TIME ZONE 'Asia/Shanghai')::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_end
      FROM moment
    )
    SELECT json_build_object(
      'user',json_build_object('id',u.id,'openid',u.open_id,'nickname',p.nickname,'avatarUrl',p.avatar_url,
        'registeredAt',u.created_at,'lastLoginAt',u.last_login_at,'sourceScene',u.source_scene,
        'sourceReportedAt',u.source_scene_reported_at),
      'save',json_build_object('exists',s.user_id IS NOT NULL,'data',s.data,'version',coalesce(s.version,0),'updatedAt',s.updated_at),
      'rewardedVideos',(SELECT json_build_object(
          'total',count(*)::int,
          'today',(count(*) FILTER (WHERE e.recorded_at>=(SELECT day_start FROM settings)
            AND e.recorded_at<(SELECT day_end FROM settings)))::int,
          'firstRecordedAt',to_char(min(e.recorded_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'lastRecordedAt',to_char(max(e.recorded_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'placements',coalesce((SELECT json_agg(json_build_object('placement',g.placement,'total',g.total,'today',g.today) ORDER BY g.placement)
            FROM (SELECT placement,count(*)::int AS total,
                (count(*) FILTER (WHERE recorded_at>=(SELECT day_start FROM settings)
                  AND recorded_at<(SELECT day_end FROM settings)))::int AS today
              FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=u.id GROUP BY placement) g),'[]'::json)
        ) FROM game_rewarded_video_events e WHERE e.app_id=$1 AND e.user_id=u.id),
      'inviter',(SELECT json_build_object('id',v.id,'openid',v.open_id,'nickname',vp.nickname,
          'invitedAt',i.invited_at,'rewardClaimed',i.claim_id IS NOT NULL)
        FROM game_invitations i JOIN game_users v ON v.app_id=i.app_id AND v.id=i.inviter_user_id
        LEFT JOIN game_profiles vp ON vp.user_id=v.id WHERE i.app_id=$1 AND i.invitee_user_id=u.id),
      'invitations',json_build_object(
        'summary',(SELECT json_build_object('total',count(*)::int,'claimed',count(*) FILTER(WHERE claim_id IS NOT NULL)::int,
            'unclaimed',count(*) FILTER(WHERE claim_id IS NULL)::int)
          FROM game_invitations WHERE app_id=$1 AND inviter_user_id=u.id),
        'items',coalesce((SELECT json_agg(item ORDER BY invited_at DESC,invitee_user_id DESC) FROM (
          SELECT i.invited_at,i.invitee_user_id,json_build_object('inviteeUid',v.id,'openid',v.open_id,'nickname',vp.nickname,
            'invitedAt',i.invited_at,'rewardClaimed',i.claim_id IS NOT NULL,'rewardClaimedAt',i.reward_claimed_at,'claimId',i.claim_id) AS item
          FROM game_invitations i JOIN game_users v ON v.app_id=i.app_id AND v.id=i.invitee_user_id
          LEFT JOIN game_profiles vp ON vp.user_id=v.id WHERE i.app_id=$1 AND i.inviter_user_id=u.id
          ORDER BY i.invited_at DESC,i.invitee_user_id DESC LIMIT 100) page),'[]'::json),
        'limit',100,'truncated',(SELECT count(*)>100 FROM game_invitations WHERE app_id=$1 AND inviter_user_id=u.id)),
      'dailyLogins',coalesce((SELECT json_agg(json_build_object('date',activity_date::text,'firstLoginAt',first_login_at) ORDER BY activity_date DESC)
        FROM (SELECT activity_date,first_login_at FROM game_daily_logins WHERE app_id=$1 AND user_id=u.id ORDER BY activity_date DESC LIMIT 30) logins),'[]'::json)
    ) AS result
    FROM game_users u LEFT JOIN game_profiles p ON p.user_id=u.id LEFT JOIN game_saves s ON s.user_id=u.id
    WHERE u.app_id=$1 AND ${predicate}`, [appId, identifier]);
  return rows[0]?.result ?? null;
}

// Successful logins, one row each. game_login_events stores every new successful login with the scene
// reported by that login (migration 013); game_daily_logins remains historical coverage only.
// A daily row is kept as a compatibility row ONLY when no event carries that exact first_login_at,
// so a new first daily login is not duplicated and real historical daily firsts keep their old
// coverage with no fabricated scene. total/pagination/date filter all run on the union.
// Ordering: login time DESC, then uid DESC, then event id DESC so identical timestamps are stable.
// Event ids are internal (bigint) and never returned to the page.
export async function loginLogs(pool, appId, offset = 0, date = null, openid = null) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
    settings AS (
      SELECT at AS generated_at, (at AT TIME ZONE 'Asia/Shanghai')::date AS today,
        coalesce($3::date,(at AT TIME ZONE 'Asia/Shanghai')::date) AS selected_date FROM moment
    ), bounds AS (
      SELECT selected_date::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_start,
        (selected_date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_end FROM settings
    ), events AS MATERIALIZED (
      SELECT e.user_id, e.login_at, e.id AS event_id, e.scene, e.client_instance_id, e.session_id, e.client_version, u.open_id, p.nickname,
        u.source_scene, u.created_at, u.last_client_version
      FROM game_login_events e CROSS JOIN bounds b
      JOIN game_users u ON u.app_id=e.app_id AND u.id=e.user_id
      LEFT JOIN game_profiles p ON p.user_id=u.id
      WHERE e.app_id=$1 AND e.login_at>=b.day_start AND e.login_at<b.day_end AND u.first_login_completed
        AND ($4::text IS NULL OR u.open_id=$4::text)
    ), legacy AS MATERIALIZED (
      SELECT l.user_id, l.first_login_at AS login_at, NULL::bigint AS event_id, NULL::int AS scene, NULL::uuid AS client_instance_id, NULL::uuid AS session_id, NULL::varchar AS client_version,
        u.open_id, p.nickname, u.source_scene, u.created_at, u.last_client_version
      FROM game_daily_logins l
      JOIN game_users u ON u.app_id=l.app_id AND u.id=l.user_id
      LEFT JOIN game_profiles p ON p.user_id=u.id
      CROSS JOIN settings s
      WHERE l.app_id=$1 AND l.activity_date=s.selected_date AND u.first_login_completed
        AND ($4::text IS NULL OR u.open_id=$4::text)
        AND NOT EXISTS (SELECT 1 FROM game_login_events e
          WHERE e.app_id=l.app_id AND e.user_id=l.user_id AND e.login_at=l.first_login_at)
    ), matching AS MATERIALIZED (SELECT * FROM events UNION ALL SELECT * FROM legacy),
    totals AS (SELECT count(*)::float8 AS total FROM matching),
    page AS (
      SELECT * FROM matching ORDER BY login_at DESC,user_id DESC,event_id DESC NULLS LAST
      LIMIT 50 OFFSET $2::int
    ) SELECT json_build_object(
      'today',s.today::text,'date',s.selected_date::text,'timezone','Asia/Shanghai','generatedAt',s.generated_at,
      'openid',$4::text,'total',t.total,'offset',$2::int,'limit',50,'hasMore',($2::int+50)<t.total,
      'items',coalesce((SELECT json_agg(json_build_object(
        'loginAt',login_at,'openid',open_id,'nickname',nickname,'sourceScene',source_scene,'loginScene',scene,
        'registeredAt',created_at,'clientVersion',coalesce(client_version,last_client_version),'clientInstanceId',client_instance_id,'sessionId',session_id
      ) ORDER BY login_at DESC,user_id DESC,event_id DESC NULLS LAST) FROM page),'[]'::json)
    ) AS result FROM settings s CROSS JOIN totals t`, [appId, offset, date, openid]);
  if (!rows[0]?.result) throw new Error('Login records unavailable');
  return rows[0].result;
}

// One row per stored, deduplicated completion report, not an ad-platform verification or reward.
// recorded_at is the server insertion time. Profiles are current and may be absent.
// This table has no numeric id: its PK is (app_id,user_id,event_id), event_id is UUID.
// Use both UUID keys after recorded_at for a stable total order, including cross-user event-id ties.
export async function videoLogs(pool, appId, offset = 0, date = null, openid = null, placement = null) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
    settings AS (
      SELECT at AS generated_at,(at AT TIME ZONE 'Asia/Shanghai')::date AS today,
        coalesce($3::date,(at AT TIME ZONE 'Asia/Shanghai')::date) AS selected_date FROM moment
    ), bounds AS (
      SELECT selected_date::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_start,
        (selected_date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_end FROM settings
    ), matching AS MATERIALIZED (
      SELECT e.recorded_at,e.event_id,e.user_id,u.open_id,p.nickname,e.placement,e.client_instance_id,e.session_id
      FROM game_rewarded_video_events e CROSS JOIN bounds b
      JOIN game_users u ON u.app_id=e.app_id AND u.id=e.user_id
      LEFT JOIN game_profiles p ON p.user_id=u.id
      WHERE e.app_id=$1 AND e.recorded_at>=b.day_start AND e.recorded_at<b.day_end
        AND u.first_login_completed AND ($4::text IS NULL OR u.open_id=$4::text)
        AND ($5::text IS NULL OR e.placement=$5::text)
    ), totals AS (SELECT count(*)::float8 AS total FROM matching),
    page AS (
      SELECT * FROM matching ORDER BY recorded_at DESC,event_id DESC,user_id DESC
      LIMIT 50 OFFSET $2::int
    ) SELECT json_build_object(
      'today',s.today::text,'date',s.selected_date::text,'timezone','Asia/Shanghai','generatedAt',s.generated_at,
      'openid',$4::text,'placement',$5::text,'total',t.total,'offset',$2::int,'limit',50,'hasMore',($2::int+50)<t.total,
      'items',coalesce((SELECT json_agg(json_build_object(
        'recordedAt',recorded_at,'openid',open_id,'nickname',nickname,'placement',placement,'clientInstanceId',client_instance_id,'sessionId',session_id
      ) ORDER BY recorded_at DESC,event_id DESC,user_id DESC) FROM page),'[]'::json)
    ) AS result FROM settings s CROSS JOIN totals t`, [appId, offset, date, openid, placement]);
  if (!rows[0]?.result) throw new Error('Video records unavailable');
  return rows[0].result;
}

// Read-only ranking of server-reported rewarded-video completions for one Beijing day.
// The day (and today) come from ONE materialized DB clock; cumulative totals cover every
// retained event for the ranked player, independent of the selected date.
export async function videoRanking(pool, appId, date = null) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
    settings AS (
      SELECT at AS generated_at,(at AT TIME ZONE 'Asia/Shanghai')::date AS today,
        coalesce($2::date,(at AT TIME ZONE 'Asia/Shanghai')::date) AS selected_date FROM moment
    ), window_bounds AS (
      SELECT selected_date::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_start,
        (selected_date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_end FROM settings
    ), daily AS MATERIALIZED (
      SELECT e.user_id,count(*)::int AS daily_count
      FROM game_rewarded_video_events e CROSS JOIN window_bounds w
      WHERE e.app_id=$1 AND e.recorded_at>=w.day_start AND e.recorded_at<w.day_end
      GROUP BY e.user_id
    ), top AS MATERIALIZED (
      SELECT d.user_id,d.daily_count,u.open_id
      FROM daily d JOIN game_users u ON u.app_id=$1 AND u.id=d.user_id
      WHERE d.daily_count>0 AND u.first_login_completed
      ORDER BY d.daily_count DESC,d.user_id DESC LIMIT 20
    ) SELECT json_build_object(
      'today',s.today::text,'date',s.selected_date::text,'timezone','Asia/Shanghai',
      'generatedAt',to_char(s.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'limit',20,
      'items',coalesce((SELECT json_agg(json_build_object(
          'rank',r.rank,'userId',r.user_id,'openid',r.open_id,'nickname',p.nickname,
          'dailyCount',r.daily_count,'totalCount',r.total_count) ORDER BY r.rank)
        FROM (SELECT t.user_id,t.open_id,t.daily_count,
            row_number() OVER (ORDER BY t.daily_count DESC,t.user_id DESC)::int AS rank,
            (SELECT count(*)::int FROM game_rewarded_video_events h
              WHERE h.app_id=$1 AND h.user_id=t.user_id) AS total_count
          FROM top t) r
        LEFT JOIN game_profiles p ON p.user_id=r.user_id),'[]'::json)
    ) AS result FROM settings s`, [appId, date]);
  if (!rows[0]?.result) throw new Error('Video ranking unavailable');
  return rows[0].result;
}

// Yesterday's registration cohort, split by first-touch scene, for the 昨日用户分析 tab.
// One read-only statement on ONE materialized DB clock:
//   cohort = game_users.first_login_completed registered in [yesterday 00:00, today 00:00) Beijing.
//   registrations: every cohort user, including users with no rewarded video.
//   rewardedVideos: only YESTERDAY's stored events of those cohort users (not lifetime, not today).
//   returnedUsers: cohort users with a TODAY game_daily_logins row (EXISTS, deduplicated) whose
//     first_login_at is at or before generatedAt. Never derived from mutable last_login_at.
//   loginCoverage: today >= coverage_start. When unknown, returnedUsers is null, never zero.
// Scenes come from game_users.source_scene: null (unreported) and unknown ids stay distinct groups.
export async function yesterdayAnalysis(pool, appId) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    ), settings AS (
      SELECT at AS generated_at,(at AT TIME ZONE 'Asia/Shanghai')::date AS today,
        ((at AT TIME ZONE 'Asia/Shanghai')::date-1) AS cohort_date,coverage_start
      FROM moment CROSS JOIN game_analytics_metadata WHERE id=true
    ), bounds AS (
      SELECT cohort_date::timestamp AT TIME ZONE 'Asia/Shanghai' AS cohort_start,
        (cohort_date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS cohort_end,
        generated_at,(today>=coverage_start) AS login_coverage
      FROM settings
    ), cohort AS MATERIALIZED (
      SELECT u.id,u.source_scene FROM game_users u CROSS JOIN bounds b
      WHERE u.app_id=$1 AND u.first_login_completed
        AND u.created_at>=b.cohort_start AND u.created_at<b.cohort_end
    ), registrations AS (
      SELECT c.source_scene,count(*)::int AS value FROM cohort c GROUP BY c.source_scene
    ), videos AS (
      SELECT c.source_scene,count(*)::int AS value
      FROM game_rewarded_video_events e JOIN cohort c ON c.id=e.user_id CROSS JOIN bounds b
      WHERE e.app_id=$1 AND e.recorded_at>=b.cohort_start AND e.recorded_at<b.cohort_end
      GROUP BY c.source_scene
    ), returned AS (
      SELECT c.source_scene,count(*)::int AS value
      FROM cohort c CROSS JOIN bounds b
      WHERE EXISTS (SELECT 1 FROM game_daily_logins l WHERE l.app_id=$1 AND l.user_id=c.id
        AND l.activity_date=(SELECT today FROM settings) AND l.first_login_at<=b.generated_at)
      GROUP BY c.source_scene
    ) SELECT json_build_object(
      'today',s.today::text,'cohortDate',s.cohort_date::text,'timezone','Asia/Shanghai',
      'generatedAt',to_char(s.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'loginCoverage',b.login_coverage,
      'registrations',json_build_object(
        'total',(SELECT coalesce(sum(r.value),0)::int FROM registrations r),
        'items',coalesce((SELECT json_agg(json_build_object('scene',r.source_scene,'value',r.value)
          ORDER BY r.value DESC,(r.source_scene IS NULL),r.source_scene) FROM registrations r),'[]'::json)),
      'rewardedVideos',json_build_object(
        'total',(SELECT coalesce(sum(v.value),0)::int FROM videos v),
        'items',coalesce((SELECT json_agg(json_build_object('scene',v.source_scene,'value',v.value)
          ORDER BY v.value DESC,(v.source_scene IS NULL),v.source_scene) FROM videos v),'[]'::json)),
      'returnedUsers',CASE WHEN b.login_coverage THEN json_build_object(
        'total',(SELECT coalesce(sum(q.value),0)::int FROM returned q),
        'items',coalesce((SELECT json_agg(json_build_object('scene',q.source_scene,'value',q.value)
          ORDER BY q.value DESC,(q.source_scene IS NULL),q.source_scene) FROM returned q),'[]'::json))
      ELSE json_build_object('total',NULL,'items',NULL) END
    ) AS result FROM settings s CROSS JOIN bounds b`, [appId]);
  if (!rows[0]?.result) throw new Error('Yesterday analysis unavailable');
  return rows[0].result;
}
