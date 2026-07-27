import { createHash, createHmac } from 'node:crypto';

import type { CheckOutcome, ServiceCheck } from '../service-check.types.js';
import { DEV_STACK_REMEDY, withTransportFailure } from './transport.util.js';

/**
 * `HeadBucket` against the S3-compatible endpoint, signed with AWS Signature Version 4.
 *
 * Why the signature is computed here instead of pulling in `@aws-sdk/client-s3`: the SDK is the
 * runtime dependency of the file-storage adapter (ADR-0015) and belongs in `packages/server`, not
 * in the root tooling of the workspace. One signed HEAD request is forty lines of `node:crypto`
 * against a specification that has not changed since 2012, and it keeps a multi-megabyte dependency
 * tree — and its supply-chain surface — out of a script every contributor runs.
 *
 * The check is deliberately authenticated. An anonymous HEAD would answer "the bucket exists" while
 * saying nothing about `S3_ACCESS_KEY`/`S3_SECRET_KEY`, which is the half that is actually wrong
 * when uploads fail.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** sha256 of the empty body — a HEAD has no payload, and MinIO rejects UNSIGNED-PAYLOAD here. */
const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

export interface SignatureRequest {
  readonly method: string;
  readonly url: URL;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly now: Date;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** `/a b/c` → `/a%20b/c`: each segment is encoded, the separators are not. */
const canonicalPath = (pathname: string): string =>
  pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

export const signAwsV4 = (request: SignatureRequest): Record<string, string> => {
  const amzDate = request.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${request.region}/${SERVICE}/aws4_request`;
  const host = request.url.host;

  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
    `x-amz-date:${amzDate}`,
  ].join('\n');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    request.method,
    canonicalPath(request.url.pathname),
    request.url.search.replace(/^\?/, ''),
    `${canonicalHeaders}\n`,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const dateKey = hmac(`AWS4${request.secretKey}`, dateStamp);
  const regionKey = hmac(dateKey, request.region);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
    authorization: `${ALGORITHM} Credential=${request.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

export const interpretHeadBucket = (status: number, bucket: string): CheckOutcome => {
  if (status === 200) {
    return { status: 'ok', details: [`bucket ${bucket} exists and the credentials are accepted`] };
  }

  if (status === 404) {
    return {
      status: 'failed',
      details: [`bucket ${bucket} does not exist`],
      remedy:
        'the one-shot `minio-setup` container creates it — run `pnpm docker:up`, which runs that container after MinIO is healthy',
    };
  }

  if (status === 403) {
    return {
      status: 'failed',
      details: [
        `MinIO rejected the signature for bucket ${bucket}: S3_ACCESS_KEY and S3_SECRET_KEY do not match the credentials the container runs with`,
      ],
      remedy:
        'align S3_ACCESS_KEY / S3_SECRET_KEY in .env with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD, then `pnpm docker:up`',
    };
  }

  return {
    status: 'failed',
    details: [`HeadBucket ${bucket} answered HTTP ${status}`],
    remedy: 'inspect the container with `docker compose logs minio`',
  };
};

export interface HeadBucketRequest {
  readonly url: URL;
  readonly headers: Record<string, string>;
}

export const createS3Check = (options: {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly now: () => Date;
  readonly head: (request: HeadBucketRequest) => Promise<number>;
}): ServiceCheck => {
  // Path-style addressing: `S3_FORCE_PATH_STYLE` defaults to true because that is what MinIO and
  // most S3-compatible servers need, and a virtual-host style URL against `localhost` cannot work.
  const url = new URL(`${options.endpoint.replace(/\/$/, '')}/${options.bucket}`);

  return {
    service: 'minio',
    requirement: 'required',
    target: url.toString(),
    run: async () =>
      withTransportFailure(DEV_STACK_REMEDY, async () =>
        interpretHeadBucket(
          await options.head({
            url,
            headers: signAwsV4({
              method: 'HEAD',
              url,
              region: options.region,
              accessKey: options.accessKey,
              secretKey: options.secretKey,
              now: options.now(),
            }),
          }),
          options.bucket,
        ),
      ),
  };
};
