const TEMPLATE_ID = '2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
const STAGING_URL = 'https://sub2api.wdaveh5game.com/h5login-test';

const STATUSES = ['accept', 'reject', 'ban', 'filter'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createCheckinSubscriptionClient(options) {
  if (!isObject(options) || Object.keys(options).some(key => !['wx', 'accessToken', 'baseUrl'].includes(key))) {
    throw new Error('INVALID_CLIENT_OPTIONS');
  }
  const { wx, accessToken, baseUrl = STAGING_URL } = options;
  // Canonical base64url encoding of the server's 32-byte opaque login token.
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(accessToken) ||
      !wx || typeof wx.request !== 'function' || typeof baseUrl !== 'string' ||
      !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/h5login-test$/.test(baseUrl)) {
    throw new Error('INVALID_CLIENT_OPTIONS');
  }
  function reportResult(input) {
    return new Promise((resolve, reject) => {
      if (!isObject(input) || Object.keys(input).sort().join(',') !== 'eventId,status' ||
          !isUuid(input.eventId) || !STATUSES.includes(input.status)) {
        throw new Error('INVALID_REPORT');
      }
      const { eventId, status } = input;
      function fail(message, statusCode) {
        const error = new Error(message);
        error.pendingReport = { eventId, status };
        if (Number.isInteger(statusCode)) error.statusCode = statusCode;
        reject(error);
      }
      try {
        wx.request({
          url: baseUrl + '/api/subscriptions/checkin/report',
          method: 'POST',
          header: { 'content-type': 'application/json', Authorization: 'Bearer ' + accessToken },
          data: { eventId, templateId: TEMPLATE_ID, status },
          timeout: 20000,
          success(res) {
            if (!res || res.statusCode !== 200) {
              fail('SUBSCRIPTION_REQUEST_FAILED', res && res.statusCode);
              return;
            }
            const data = res.data;
            if (!isObject(data) || Object.keys(data).sort().join(',') !== 'alreadyRecorded,eventId,recordedAt,status,templateId' ||
                data.eventId !== eventId || data.templateId !== TEMPLATE_ID || data.status !== status ||
                typeof data.alreadyRecorded !== 'boolean' || typeof data.recordedAt !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(data.recordedAt) || !Number.isFinite(Date.parse(data.recordedAt))) {
              fail('INVALID_SUBSCRIPTION_RESPONSE');
              return;
            }
            resolve(data);
          },
          fail() { fail('SUBSCRIPTION_NETWORK_ERROR'); },
        });
      } catch { fail('SUBSCRIPTION_NETWORK_ERROR'); }
    });
  }
  return {
    reportResult,
    requestSubscription(eventId) {
      // The Promise executor runs synchronously, preserving the click gesture.
      return new Promise((resolve, reject) => {
        if (!isUuid(eventId)) throw new Error('INVALID_EVENT_ID');
        if (typeof wx.requestSubscribeMessage !== 'function') throw new Error('SUBSCRIPTION_API_UNAVAILABLE');
        let handled = false;
        function fail() {
          if (handled) return;
          handled = true;
          reject(new Error('SUBSCRIPTION_REQUEST_FAILED'));
        }
        try {
          wx.requestSubscribeMessage({
            tmplIds: [TEMPLATE_ID],
            success(res) {
              if (handled) return;
              handled = true;
              if (!isObject(res) || res.errMsg !== 'requestSubscribeMessage:ok' ||
                  !Object.prototype.hasOwnProperty.call(res, TEMPLATE_ID) || !STATUSES.includes(res[TEMPLATE_ID])) {
                reject(new Error('INVALID_SUBSCRIPTION_CALLBACK'));
                return;
              }
              reportResult({ eventId, status: res[TEMPLATE_ID] }).then(resolve, reject);
            },
            fail,
          });
        } catch { fail(); }
      });
    },
  };
}
