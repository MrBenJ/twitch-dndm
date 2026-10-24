import type { LightMyRequestResponse } from 'fastify';
import type { twitchSetup } from './twitch';

export type Setup = Awaited<ReturnType<typeof twitchSetup>>;

/** Runs the sign-up flow against the fake Twitch for `user` (the fake must know the user). */
export async function signIn(x: Setup, user = '77'): Promise<LightMyRequestResponse> {
  const start = await x.srv.app.inject('/signup/start');
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const cookie = (start.headers['set-cookie'] as string).split(';')[0]!;
  return x.srv.app.inject({ url: `/signup/callback?code=${x.fake.codeFor(user)}&state=${state}`, headers: { cookie } });
}

export const setCookies = (res: LightMyRequestResponse): string[] => {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h : [h];
};

/** The `dndm_session=...` pair from a response, as a Cookie request header. */
export const sessionCookie = (res: LightMyRequestResponse): string =>
  setCookies(res).find((v) => v.startsWith('dndm_session='))!.split(';')[0]!;
