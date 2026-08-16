/**
 * 阿里云 NLS 一句话识别客户端（服务端代理）。
 *
 * 凭据经 ctx.credentials 按次解析（值存于 harness 凭据层，如
 * ~/.dsh/.credentials.yaml 的 ALIYUN_NLS_APPKEY / ALIYUN_NLS_ACCESS_KEY_ID /
 * ALIYUN_NLS_ACCESS_KEY_SECRET）——本仓库不携带任何密钥，公开到 GitHub 也安全。
 * 协议移植自 led-server 的 AliyunSigner.cs / AliyunSttService.cs（同一套
 * RPC HMAC-SHA1 签名 + 一句话识别）。
 * @module dsh-blubby/asr
 */

import { createHmac, randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

/** RPC CreateToken 元服务端点。 */
const META_ENDPOINT = 'https://nls-meta.cn-shanghai.aliyuncs.com'
/** 一句话识别端点。 */
const ASR_ENDPOINT = 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr'
/** RPC API 版本。 */
const RPC_VERSION = '2019-02-28'
/** Token 提前刷新余量（ms）——Token 有效期 24h。 */
const TOKEN_EARLY_REFRESH_MS = 60_000

/** 凭据未配置（前端据此降级提示）。 */
export class AsrUnconfiguredError extends Error {
  readonly code = 'asr-unconfigured'
  constructor() {
    super('语音识别未配置（缺 ALIYUN_NLS_* 凭据）')
    this.name = 'AsrUnconfiguredError'
  }
}

/** 上游失败（签名/换 Token/识别均可能）。 */
export class AsrUpstreamError extends Error {
  readonly code = 'asr-upstream'
  constructor(message: string) {
    super(message)
    this.name = 'AsrUpstreamError'
  }
}

interface TokenRecord {
  id: string
  expiresAtMs: number
}

/** RFC3986 percent-encode（表单编码转 RFC3986：+→%20、*→%2A、%7E→~）。 */
function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

/** 按 key 字典序拼规范查询串（RPC 签名与 URL 共用）。 */
function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&')
}

/** Aliyun RPC HMAC-SHA1 签名（AliyunSigner 移植）：签名密钥 = Secret + '&'。 */
function rpcSignature(params: Record<string, string>, secret: string): string {
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`
  return createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64')
}

/** 阿里云 NLS 一句话识别客户端。Token 24h 缓存 + 提前刷新；凭据每次操作重解析。 */
export class AliyunNlsAsr {
  private token: TokenRecord | undefined

  constructor(private readonly ctx: Context) {}

  /** 按次解析凭据（不缓存——凭据改动下一次操作即时生效）。 */
  private async credentials(): Promise<{ appkey: string; akId: string; akSecret: string }> {
    const [appkey, akId, akSecret] = await Promise.all([
      this.ctx.credentials.resolve(credentialRef('ALIYUN_NLS_APPKEY')),
      this.ctx.credentials.resolve(credentialRef('ALIYUN_NLS_ACCESS_KEY_ID')),
      this.ctx.credentials.resolve(credentialRef('ALIYUN_NLS_ACCESS_KEY_SECRET')),
    ])
    if (appkey === undefined || akId === undefined || akSecret === undefined) {
      throw new AsrUnconfiguredError()
    }
    return { appkey: appkey.value, akId: akId.value, akSecret: akSecret.value }
  }

  /** RPC CreateToken 换 Token：AK/SK → HMAC-SHA1 签名 → nls-meta → Token.Id。 */
  private async ensureToken(akId: string, akSecret: string): Promise<string> {
    if (this.token !== undefined && Date.now() < this.token.expiresAtMs) return this.token.id
    const params: Record<string, string> = {
      AccessKeyId: akId,
      Action: 'CreateToken',
      Format: 'JSON',
      RegionId: 'cn-shanghai',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: RPC_VERSION,
    }
    params.Signature = rpcSignature(params, akSecret)
    const url = `${META_ENDPOINT}?${canonicalQuery(params)}`
    const response = await fetch(url)
    if (!response.ok) throw new AsrUpstreamError(`CreateToken HTTP ${response.status}`)
    const body = (await response.json()) as { Token?: { Id?: string; ExpireTime?: number }; Message?: string }
    const id = body.Token?.Id
    const expireAt = body.Token?.ExpireTime
    if (typeof id !== 'string' || typeof expireAt !== 'number') {
      throw new AsrUpstreamError(`CreateToken 失败: ${body.Message ?? '未知响应'}`)
    }
    this.token = { id, expiresAtMs: expireAt * 1000 - TOKEN_EARLY_REFRESH_MS }
    return id
  }

  /** 一句话识别：整段 PCM（16k/mono/16bit）→ 文本。PCM < 3200 字节（~0.1s）丢弃。 */
  async recognize(pcm: Buffer): Promise<string> {
    if (pcm.byteLength < 3200) throw new AsrUpstreamError('音频过短（<0.1s）')
    const { appkey, akId, akSecret } = await this.credentials()
    const token = await this.ensureToken(akId, akSecret)
    const query = canonicalQuery({
      appkey,
      format: 'pcm',
      sample_rate: '16000',
      enable_punctuation_prediction: 'true',
      enable_inverse_text_normalization: 'true',
    })
    const response = await fetch(`${ASR_ENDPOINT}?${query}`, {
      method: 'POST',
      headers: {
        'X-NLS-Token': token,
        'content-type': 'application/octet-stream',
      },
      body: pcm as unknown as BodyInit,
    })
    if (!response.ok) throw new AsrUpstreamError(`ASR HTTP ${response.status}`)
    const body = (await response.json()) as { status?: number; result?: string; message?: string }
    if (body.status !== 20000000) {
      throw new AsrUpstreamError(`ASR status=${String(body.status)}${body.message ? ` ${body.message}` : ''}`)
    }
    return body.result ?? ''
  }
}
