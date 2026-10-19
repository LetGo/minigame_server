// Parameterized read-only queries. Every metric is scoped to the configured game.
export async function overview(pool, appId) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    ), settings AS (
      SELECT (moment.at AT TIME ZONE 'Asia/Shanghai')::date AS today,
        moment.at AS generated_at,tracking_started_at,coverage_start
      FROM moment CROSS JOIN game_analytics_metadata WHERE id=true
    ), dates AS (
      SELECT today-n AS d,settings.* FROM settings CROSS JOIN generate_series(0,13) n
    ), daily AS (
      SELECT d,today,coverage_start,
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
        'todayRewardedVideos',(SELECT count(*)::float8 FROM game_rewarded_video_events WHERE app_id=$1
          AND recorded_at>=s.today::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND recorded_at<(s.today+1)::timestamp AT TIME ZONE 'Asia/Shanghai'),
        'totalUsers',(SELECT count(*)::int FROM game_users WHERE app_id=$1 AND first_login_completed),
        'd1',json_build_object('cohortDate',(s.today-1)::text,'cohortSize',current.cohort_size,
          'returned',current.returned,'rate',current.returned::float8/nullif(current.cohort_size,0))),
      'history',(SELECT json_agg(json_build_object('date',d::text,'newUsers',new_users,'dau',dau,
          'invitedNewUsers',invited_new_users,
          'cohortSize',cohort_size,'returned',returned,'d1Rate',returned::float8/nullif(cohort_size,0)) ORDER BY d) FROM daily)
    ) AS result FROM settings s JOIN daily current ON current.d=s.today`, [appId]);
  if (!rows[0]?.result) throw new Error('Analytics metadata unavailable');
  return rows[0].result;
}

export async function player(pool, appId, openid) {
  const { rows } = await pool.query(`
    SELECT json_build_object(
      'user',json_build_object('id',u.id,'openid',u.open_id,'nickname',p.nickname,'avatarUrl',p.avatar_url,
        'registeredAt',u.created_at,'lastLoginAt',u.last_login_at,'sourceScene',u.source_scene,
        'sourceReportedAt',u.source_scene_reported_at),
      'save',json_build_object('exists',s.user_id IS NOT NULL,'data',s.data,'version',coalesce(s.version,0),'updatedAt',s.updated_at),
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
    WHERE u.app_id=$1 AND u.open_id=$2`, [appId, openid]);
  return rows[0]?.result ?? null;
}

// Existing daily records only: storage retains the first successful login per user/day.
// No additional deduplication and no reconstruction from mutable last_login_at.
export async function loginLogs(pool, appId, offset = 0) {
  const { rows } = await pool.query(`
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
    settings AS (
      SELECT at AS generated_at, (at AT TIME ZONE 'Asia/Shanghai')::date AS today FROM moment
    ), matching AS MATERIALIZED (
      SELECT l.user_id, l.first_login_at, u.open_id, p.nickname, u.source_scene
      FROM game_daily_logins l
      JOIN game_users u ON u.app_id=l.app_id AND u.id=l.user_id
      LEFT JOIN game_profiles p ON p.user_id=u.id
      CROSS JOIN settings s
      WHERE l.app_id=$1 AND l.activity_date=s.today AND u.first_login_completed
    ), totals AS (SELECT count(*)::float8 AS total FROM matching),
    page AS (
      SELECT * FROM matching ORDER BY first_login_at DESC, user_id DESC LIMIT 50 OFFSET $2::int
    ) SELECT json_build_object(
      'today',s.today::text,'timezone','Asia/Shanghai','generatedAt',s.generated_at,
      'total',t.total,'offset',$2::int,'limit',50,'hasMore',($2::int+50)<t.total,
      'items',coalesce((SELECT json_agg(json_build_object(
        'loginAt',first_login_at,'openid',open_id,'nickname',nickname,'sourceScene',source_scene
      ) ORDER BY first_login_at DESC,user_id DESC) FROM page),'[]'::json)
    ) AS result FROM settings s CROSS JOIN totals t`, [appId, offset]);
  if (!rows[0]?.result) throw new Error('Login records unavailable');
  return rows[0].result;
}
