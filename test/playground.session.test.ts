import { describe, expect, it } from 'vitest';
import { TrialStore } from '../src/playground/session.js';
import { Session } from '../src/redact/session.js';

const MINUTE = 60_000;

describe('TrialStore', () => {
  it('hands back the session it was given', () => {
    const store = new TrialStore();
    const created = store.create(new Session(), 'gpt-4o-mini');

    expect(store.get(created.id)?.session).toBe(created.session);
    expect(store.get(created.id)?.model).toBe('gpt-4o-mini');
  });

  it('does not know an id it never issued', () => {
    expect(new TrialStore().get('nope')).toBeUndefined();
  });

  it('issues ids that do not follow from one another', () => {
    const store = new TrialStore();
    const a = store.create(new Session(), 'm');
    const b = store.create(new Session(), 'm');

    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(22);
  });

  it('drops the oldest when it is full', () => {
    const store = new TrialStore({ max: 2 });
    const first = store.create(new Session(), 'm');
    const second = store.create(new Session(), 'm');
    const third = store.create(new Session(), 'm');

    expect(store.size).toBe(2);
    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
    expect(store.get(third.id)).toBeDefined();
  });

  it('forgets a session once its time is up', () => {
    let now = 0;
    const store = new TrialStore({ ttlMs: 30 * MINUTE, now: () => now });
    const created = store.create(new Session(), 'm');

    now = 29 * MINUTE;
    expect(store.get(created.id)).toBeDefined();

    now = 31 * MINUTE;
    expect(store.get(created.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('keeps the mapping usable for as long as it holds the session', () => {
    const store = new TrialStore();
    const session = new Session();
    const { text } = session.redact('write to anna.schmidt@nordlicht.example');
    const created = store.create(session, 'm');

    expect(text).toContain('[EMAIL_1]');
    expect(store.get(created.id)?.session.lookup('[EMAIL_1]')).toBe(
      'anna.schmidt@nordlicht.example',
    );
  });
});
