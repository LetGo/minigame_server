import { BadGatewayException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class WechatClient {
  constructor(
    private readonly credentials: { appId: string; appSecret: string },
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async exchange(code: string): Promise<{ openid: string }> {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: this.credentials.appId,
      secret: this.credentials.appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    let payload: unknown;
    try {
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('upstream HTTP failure');
      payload = await response.json();
    } catch {
      // Never retain upstream URLs/errors: the query contains AppSecret and code.
      throw new BadGatewayException('WECHAT_UNAVAILABLE');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadGatewayException('WECHAT_INVALID_RESPONSE');
    }
    const data = payload as Record<string, unknown>;
    if (data.errcode !== undefined && data.errcode !== 0) {
      if (data.errcode === 40029 || data.errcode === 40163) {
        throw new UnauthorizedException('WECHAT_CODE_INVALID');
      }
      if (data.errcode === 40226) throw new ForbiddenException('WECHAT_LOGIN_BLOCKED');
      if (data.errcode === -1 || data.errcode === 45011) {
        throw new ServiceUnavailableException('WECHAT_BUSY');
      }
      throw new BadGatewayException('WECHAT_LOGIN_FAILED');
    }
    if (typeof data.openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.openid)
      || typeof data.session_key !== 'string' || data.session_key.length < 1 || data.session_key.length > 256) {
      throw new BadGatewayException('WECHAT_INVALID_RESPONSE');
    }
    // session_key is not required for this API; discard it rather than persist/expose it.
    return { openid: data.openid };
  }
}
