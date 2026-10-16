// HTTPS protects transport; the server authenticates this opaque Bearer token.
export function createDataClient({ wx, accessToken, baseUrl = 'https://sub2api.wdaveh5game.com/h5login' }) {
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(accessToken) ||
      !wx || typeof wx.request !== 'function' || typeof baseUrl !== 'string' ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?\/h5login$/i.test(baseUrl)) {
    throw new Error('INVALID_CLIENT_OPTIONS');
  }

  function call(operation, payload) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: baseUrl + '/api/data/' + operation,
        method: 'POST',
        header: { 'content-type': 'application/json', Authorization: 'Bearer ' + accessToken },
        data: payload,
        timeout: 20000,
        success(res) {
          try {
            if (res.statusCode !== 200) {
              const err = new Error('DATA_REQUEST_FAILED');
              err.statusCode = res.statusCode;
              err.apiMessage = res.data && res.data.message;
              err.retryAfter = res.header && (res.header['Retry-After'] || res.header['retry-after']);
              throw err;
            }
            const data = res.data;
            if (!data || typeof data !== 'object' || Array.isArray(data) ||
                !Number.isInteger(data.version) || data.version < 0 || data.version > 2147483647 ||
                (operation === 'save' ?
                  Object.keys(data).sort().join(',') !== 'updatedAt,version' || data.version < 1 || typeof data.updatedAt !== 'string' :
                  Object.keys(data).sort().join(',') !== 'data,exists,updatedAt,version' || typeof data.exists !== 'boolean' ||
                  (data.exists ? data.version < 1 || typeof data.data !== 'string' || typeof data.updatedAt !== 'string' :
                    data.version !== 0 || data.data !== null || data.updatedAt !== null))) {
              throw new Error('INVALID_DATA_RESPONSE');
            }
            resolve(data);
          } catch (err) { reject(err); }
        },
        fail() { reject(new Error('DATA_NETWORK_ERROR')); }
      });
    });
  }

  return {
    get() { return call('get', {}); },
    async save(data, version) {
      if (typeof data !== 'string' || !Number.isInteger(version) || version < 0 || version > 2147483646) {
        throw new Error('INVALID_SAVE_DATA');
      }
      try {
        // URI encoding validates UTF-16 and gives UTF-8 byte count without platform globals.
        const byteLength = (encodeURIComponent(data).match(/%[0-9A-F]{2}|[^%]/g) || []).length;
        if (byteLength > 65536) throw new Error();
        JSON.parse(data);
      } catch { throw new Error('INVALID_SAVE_DATA'); }
      return call('save', { version, data });
    }
  };
}
