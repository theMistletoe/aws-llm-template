import { describe, expect, it } from 'vitest';
import { awsClientConfig, isLocalEndpoint } from './index';

describe('awsClientConfig', () => {
  it('forces endpoint and dummy credentials in local mode', () => {
    const c = awsClientConfig({ mode: 'local', region: 'ap-northeast-1', endpoint: 'http://localhost:4566' });
    expect(c).toEqual({
      region: 'ap-northeast-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });

  it('refuses remote endpoints in local mode', () => {
    expect(() =>
      awsClientConfig({ mode: 'local', region: 'ap-northeast-1', endpoint: 'https://dynamodb.ap-northeast-1.amazonaws.com' }),
    ).toThrow(/Refusing/);
  });

  it('uses the default credential chain in aws mode', () => {
    expect(awsClientConfig({ mode: 'aws', region: 'ap-northeast-1' })).toEqual({ region: 'ap-northeast-1' });
  });

  it('detects local endpoints', () => {
    expect(isLocalEndpoint('http://127.0.0.1:4566')).toBe(true);
    expect(isLocalEndpoint('not a url')).toBe(false);
  });
});
