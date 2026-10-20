export const CHECKIN_TEMPLATE_ID = '2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
export const CHECKIN_TEMPLATE_NUMBER = 85;

export interface CheckinMessageData {
  phrase1: { value: string };
  thing10: { value: string };
  thing5: { value: string };
}

/**
 * Builds a check-in subscription message.
 * @param openid - The user's openid (1-128 alphanumeric/underscore/hyphen)
 * @param page - The page path (1-512, no control characters or :// or leading //)
 * @returns Message object for WeChat subscription API
 * @throws Error if openid or page is invalid
 */
export function buildCheckinMessage(openid: string, page = 'index') {
  // Validate openid: safe1..128 regex (alphanumeric, underscores, hyphens, length 1-128)
  // WeChat openids can contain hyphens
  const openidRegex = /^[a-zA-Z0-9_-]{1,128}$/;
  if (typeof openid !== 'string' || !openidRegex.test(openid)) {
    throw new Error('Invalid openid');
  }
  // Validate page: safe1..512 no control characters, no :// protocol, no leading //
  // We allow query parameters like ?from=checkin but reject dangerous patterns
  const pageRegex = /^[^\x00-\x1f\x7f]{1,512}$/; // No control characters (0x00-0x1f and 0x7f)
  if (typeof page !== 'string' || !pageRegex.test(page)) {
    throw new Error('Invalid page');
  }
  // Additionally reject :// and leading // to prevent protocol injection
  if (page.includes('://') || page.startsWith('//')) {
    throw new Error('Invalid page');
  }

  return {
    touser: openid,
    template_id: CHECKIN_TEMPLATE_ID,
    page,
    miniprogram_state: 'trial',
    lang: 'zh_CN',
    data: {
      phrase1: { value: '未签到' },
      thing10: { value: '签到领海量奖励' },
      thing5: { value: '您的猫咪提示您有海量钻石待领取' },
    },
  };
}