/** WHY: the owner could not tell reports sent from the Android app apart from web
 * ones ("I want to receive android feedback visible marked sent from android app").
 * `feedbackOrigin` is the ONE rule the admin list, the report detail and every
 * private export use, so a drift here mislabels reports everywhere at once. */
import { describe, expect, it } from 'vitest';
import { FEEDBACK_CLIENT_RELEASE, FEEDBACK_THREADS, feedbackOrigin } from './feedback';

const NATIVE_054_BUILD = '984ad65f'.padEnd(40, '0');

describe('feedbackOrigin', () => {
  it('labels a server-stamped Android-app report with its release', () => {
    expect(feedbackOrigin({ client: 'android-native', clientRelease: '0.5.4', platform: 'android' }))
      .toEqual({ client: 'android-native', label: 'ANDROID APP 0.5.4', release: '0.5.4' });
    expect(feedbackOrigin({ client: 'android-native' })).toEqual({ client: 'android-native', label: 'ANDROID APP' });
  });

  it('recognises reports the Android app sent BEFORE the server stamped them, with no migration', () => {
    // The 0.5.4 app sends platform android + screen "feedback" + its full 40-hex build.
    expect(feedbackOrigin({ platform: 'android', screen: 'feedback', build: NATIVE_054_BUILD }))
      .toEqual({ client: 'android-native', label: 'ANDROID APP' });
  });

  it('keeps web reports web — including the web client opened on an Android phone', () => {
    // The web client sends screen "tester" and a 7-hex sha: an Android BROWSER is not the app.
    expect(feedbackOrigin({ platform: 'android', screen: 'tester', build: 'cee3869' })).toEqual({ client: 'web', label: 'WEB · android', platform: 'android' });
    expect(feedbackOrigin({ platform: 'android', screen: 'feedback', build: 'cee3869' }).client).toBe('web');
    expect(feedbackOrigin({ platform: 'desktop', screen: 'feedback', build: NATIVE_054_BUILD }).client).toBe('web');
    expect(feedbackOrigin({ platform: 'desktop', build: 'cee3869' })).toEqual({ client: 'web', label: 'WEB · desktop', platform: 'desktop' });
    for (const empty of [null, undefined, {}, 'text', 7]) expect(feedbackOrigin(empty)).toEqual({ client: 'web', label: 'WEB' });
  });

  it('lets the server stamp win over the legacy signature, and ignores an unknown stamp', () => {
    const signature = { platform: 'android', screen: 'feedback', build: NATIVE_054_BUILD };
    expect(feedbackOrigin({ ...signature, client: 'web' }).label).toBe('WEB · android');
    expect(feedbackOrigin({ ...signature, client: 'ios-native' }).client).toBe('android-native');
    expect(feedbackOrigin({ client: 'admin', platform: 'desktop' }).client).toBe('web');
  });

  it('never prints a release that is not a short plain version string', () => {
    for (const bad of ['0.5.4 <script>', 'a'.repeat(FEEDBACK_THREADS.clientReleaseMaxLen + 1), '', 'v 1', 'ünï', 5]) {
      expect(feedbackOrigin({ client: 'android-native', clientRelease: bad })).toEqual({ client: 'android-native', label: 'ANDROID APP' });
    }
    expect(FEEDBACK_CLIENT_RELEASE.test(`0.5.4-candidate:20:${NATIVE_054_BUILD}`)).toBe(true);
  });
});
