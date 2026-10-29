import {
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it, vi } from 'vitest';
import { CognitoOtpAuthProvider } from './cognito';
import { computeSecretHash } from './index';

type Handler = (input: Record<string, unknown>) => unknown;

function awsError(name: string) {
  return Object.assign(new Error(name), { name });
}

function setup(handlers: Partial<Record<string, Handler>>, idTokenEmail = 'user@example.com') {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    calls.push({ command: name, input: command.input });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected ${name}`);
    return handler(command.input);
  });
  const provider = new CognitoOtpAuthProvider({
    region: 'ap-northeast-1',
    userPoolId: 'ap-northeast-1_test',
    clientId: 'client-id',
    getClientSecret: async () => 'client-secret',
    client: { send } as unknown as CognitoIdentityProviderClient,
    verifyIdToken: async (token) => ({ sub: `sub-of-${token}`, email: idTokenEmail }),
  });
  return { provider, calls };
}

const email = 'user@example.com';

describe('computeSecretHash', () => {
  it('matches the Cognito definition Base64(HMAC_SHA256(secret, username + clientId))', () => {
    expect(computeSecretHash('user@example.com', 'client-id', 'client-secret')).toBe(
      'NpqglvUHBpz0nyO+qeiUjlRR297+e+uA7UhuwY3pkSE=',
    );
  });
});

describe('CognitoOtpAuthProvider.start', () => {
  it('new user -> SignUp without password (signup flow)', async () => {
    const { provider, calls } = setup({ [SignUpCommand.name]: () => ({ UserConfirmed: false, Session: 'S1' }) });
    await expect(provider.start(email)).resolves.toEqual({ flowType: 'signup', email, session: 'S1' });
    expect(calls[0]!.input).toMatchObject({ ClientId: 'client-id', Username: email, SecretHash: expect.any(String) });
    expect(calls[0]!.input).not.toHaveProperty('Password');
  });

  it('existing user -> InitiateAuth USER_AUTH with EMAIL_OTP (signin flow)', async () => {
    const { provider, calls } = setup({
      [SignUpCommand.name]: () => {
        throw awsError('UsernameExistsException');
      },
      [InitiateAuthCommand.name]: () => ({ ChallengeName: 'EMAIL_OTP', Session: 'S2' }),
    });
    await expect(provider.start(email)).resolves.toEqual({ flowType: 'signin', email, session: 'S2' });
    expect(calls[1]!.input).toMatchObject({
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP', SECRET_HASH: expect.any(String) },
    });
  });

  it('unconfirmed user -> ResendConfirmationCode (signup flow without session)', async () => {
    const { provider, calls } = setup({
      [SignUpCommand.name]: () => {
        throw awsError('UsernameExistsException');
      },
      [InitiateAuthCommand.name]: () => {
        throw awsError('UserNotConfirmedException');
      },
      [ResendConfirmationCodeCommand.name]: () => ({}),
    });
    await expect(provider.start(email)).resolves.toEqual({ flowType: 'signup', email });
    expect(calls.map((c) => c.command)).toEqual([
      SignUpCommand.name,
      InitiateAuthCommand.name,
      ResendConfirmationCodeCommand.name,
    ]);
  });

  it('propagates unexpected errors', async () => {
    const { provider } = setup({
      [SignUpCommand.name]: () => {
        throw awsError('TooManyRequestsException');
      },
    });
    await expect(provider.start(email)).rejects.toThrow('TooManyRequestsException');
  });
});

describe('CognitoOtpAuthProvider.verify', () => {
  it('signup: ConfirmSignUp with Session then auto sign-in with USER_AUTH', async () => {
    const { provider, calls } = setup({
      [ConfirmSignUpCommand.name]: () => ({ Session: 'S-confirmed' }),
      [InitiateAuthCommand.name]: () => ({ AuthenticationResult: { IdToken: 'idt' } }),
    });
    await expect(provider.verify({ flowType: 'signup', email, session: 'S1' }, '123456')).resolves.toEqual({
      status: 'authenticated',
      user: { sub: 'sub-of-idt', email },
    });
    expect(calls[0]!.input).toMatchObject({ ConfirmationCode: '123456', Session: 'S1' });
    expect(calls[1]!.input).toMatchObject({ AuthFlow: 'USER_AUTH', Session: 'S-confirmed' });
  });

  it('signup without auto sign-in session -> sends a sign-in code', async () => {
    const { provider } = setup({
      [ConfirmSignUpCommand.name]: () => ({}),
      [InitiateAuthCommand.name]: () => ({ ChallengeName: 'EMAIL_OTP', Session: 'S3' }),
    });
    await expect(provider.verify({ flowType: 'signup', email }, '123456')).resolves.toEqual({
      status: 'additional_code_sent',
      next: { flowType: 'signin', email, session: 'S3' },
    });
  });

  it('signin: RespondToAuthChallenge EMAIL_OTP', async () => {
    const { provider, calls } = setup({
      [RespondToAuthChallengeCommand.name]: () => ({ AuthenticationResult: { IdToken: 'idt2' } }),
    });
    await expect(provider.verify({ flowType: 'signin', email, session: 'S2' }, '87654321')).resolves.toEqual({
      status: 'authenticated',
      user: { sub: 'sub-of-idt2', email },
    });
    expect(calls[0]!.input).toMatchObject({
      ChallengeName: 'EMAIL_OTP',
      Session: 'S2',
      ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: '87654321' },
    });
  });

  it('signin wrong code that returns a new challenge -> invalid_code with the new session', async () => {
    const { provider } = setup({
      [RespondToAuthChallengeCommand.name]: () => ({ ChallengeName: 'EMAIL_OTP', Session: 'S2b' }),
    });
    await expect(provider.verify({ flowType: 'signin', email, session: 'S2' }, '000000')).resolves.toEqual({
      status: 'invalid_code',
      session: 'S2b',
    });
  });

  it.each([
    ['CodeMismatchException', 'invalid_code'],
    ['ExpiredCodeException', 'flow_expired'],
    ['NotAuthorizedException', 'flow_expired'],
  ])('maps %s to %s', async (error, status) => {
    const { provider } = setup({
      [RespondToAuthChallengeCommand.name]: () => {
        throw awsError(error);
      },
    });
    await expect(provider.verify({ flowType: 'signin', email, session: 'S' }, '111111')).resolves.toEqual({ status });
  });

  it('signin without session -> flow_expired', async () => {
    const { provider } = setup({});
    await expect(provider.verify({ flowType: 'signin', email }, '111111')).resolves.toEqual({ status: 'flow_expired' });
  });

  it('rejects an ID token whose email does not match the flow', async () => {
    const { provider } = setup(
      { [RespondToAuthChallengeCommand.name]: () => ({ AuthenticationResult: { IdToken: 'idt' } }) },
      'attacker@example.com',
    );
    await expect(provider.verify({ flowType: 'signin', email, session: 'S' }, '111111')).rejects.toThrow(
      /email mismatch/,
    );
  });

  it('propagates ID token verification failures', async () => {
    const provider = new CognitoOtpAuthProvider({
      region: 'ap-northeast-1',
      userPoolId: 'p',
      clientId: 'c',
      getClientSecret: async () => 's',
      client: {
        send: async () => ({ AuthenticationResult: { IdToken: 'bad' } }),
      } as unknown as CognitoIdentityProviderClient,
      verifyIdToken: async () => {
        throw new Error('JwtInvalidSignatureError');
      },
    });
    await expect(provider.verify({ flowType: 'signin', email, session: 'S' }, '111111')).rejects.toThrow(
      'JwtInvalidSignatureError',
    );
  });
});
