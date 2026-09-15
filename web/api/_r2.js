// Cloudflare R2, signed by hand.
//
// R2 speaks S3, so every request has to carry an AWS Signature Version 4.
// Doing that here with node's own crypto keeps this function tiny and its
// cold start short, which matters: a heavy SDK on the path between a student
// pressing play and the first frame would cost more time than the fetch.
//
// Two shapes of signature are needed.
//   presign()  puts the whole request into a link, so the browser talks to R2
//              directly and no recording ever passes through this server.
//   r2Fetch()  signs a request this server makes itself, for listing and
//              deleting, which the browser is never allowed to do.

import { createHash, createHmac } from 'node:crypto'

const REGION = 'auto'
const SERVICE = 's3'

/** Reads the deployment's R2 settings, or null when R2 has not been set up. */
export function r2Config() {
  const account = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  if (!account || !accessKeyId || !secretAccessKey || !bucket) return null
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.R2_REGION || REGION,
    host: `${account}.r2.cloudflarestorage.com`
  }
}

// AWS wants the stricter encoding: the characters encodeURIComponent leaves
// alone have to be escaped too, or the signature will not match.
const esc = (s) =>
  encodeURIComponent(String(s)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
const encPath = (s) => String(s).split('/').map(esc).join('/')
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (k, s) => createHmac('sha256', k).update(s).digest()
const queryOf = (q) =>
  Object.keys(q)
    .sort()
    .map((k) => `${esc(k)}=${esc(q[k])}`)
    .join('&')

function stamps(when) {
  const amz = (when || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  return { amz, day: amz.slice(0, 8) }
}

function signingKey(cfg, day) {
  let k = hmac('AWS4' + cfg.secretAccessKey, day)
  k = hmac(k, cfg.region || REGION)
  k = hmac(k, SERVICE)
  return hmac(k, 'aws4_request')
}

// R2 addresses a bucket by path. An empty bucket means the host already names
// it, which is how the published AWS examples are written, and is what the
// signing test checks this code against.
const keyPath = (cfg, key) => (cfg.bucket ? `/${cfg.bucket}/${encPath(key)}` : `/${encPath(key)}`)

/**
 * A link that is the request. Hand it to the browser and it uploads or
 * downloads straight from R2 until the link expires.
 */
export function presign(cfg, method, key, expiresSec, extraQuery = {}, when) {
  const { amz, day } = stamps(when)
  const scope = `${day}/${cfg.region || REGION}/${SERVICE}/aws4_request`
  const path = keyPath(cfg, key)
  const canonicalQuery = queryOf({
    ...extraQuery,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host'
  })
  const canonical = [
    method,
    path,
    canonicalQuery,
    `host:${cfg.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n')
  const sig = createHmac('sha256', signingKey(cfg, day)).update(toSign).digest('hex')
  return `https://${cfg.host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`
}

/** A signed request made by this server: listing a folder, deleting a file. */
export async function r2Fetch(cfg, method, key, query = {}) {
  const { amz, day } = stamps()
  const scope = `${day}/${cfg.region || REGION}/${SERVICE}/aws4_request`
  const path = key ? keyPath(cfg, key) : `/${cfg.bucket}`
  const canonicalQuery = queryOf(query)
  const hash = sha256('')
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = `host:${cfg.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${amz}\n`
  const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, hash].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n')
  const sig = createHmac('sha256', signingKey(cfg, day)).update(toSign).digest('hex')
  const url = `https://${cfg.host}${path}${canonicalQuery ? '?' + canonicalQuery : ''}`
  return fetch(url, {
    method,
    headers: {
      'x-amz-content-sha256': hash,
      'x-amz-date': amz,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
    }
  })
}

/** Every object under a prefix, following R2's paging to the end. */
export async function r2List(cfg, prefix) {
  const out = []
  let token = ''
  for (let page = 0; page < 20; page++) {
    const query = { 'list-type': '2', prefix, 'max-keys': '1000' }
    if (token) query['continuation-token'] = token
    const r = await r2Fetch(cfg, 'GET', '', query)
    if (!r.ok) break
    const xml = await r.text()
    const re = /<Contents>([\s\S]*?)<\/Contents>/g
    let m
    while ((m = re.exec(xml))) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1]
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0)
      if (key) out.push({ key: decodeXml(key), size })
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? ''
    if (!token) break
  }
  return out
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
