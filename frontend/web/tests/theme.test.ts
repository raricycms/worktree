import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isThemePref, resolveTheme, watchTheme } from '../src/theme';

interface FakeMediaQueryList {
  matches: boolean;
  listeners: Array<() => void>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

function fakeSystem(dark: boolean): FakeMediaQueryList {
  const mql: FakeMediaQueryList = {
    matches: dark,
    listeners: [],
    addEventListener: (type, listener) => {
      if (type === 'change') mql.listeners.push(listener);
    },
    removeEventListener: (type, listener) => {
      if (type !== 'change') return;
      const index = mql.listeners.indexOf(listener);
      if (index !== -1) mql.listeners.splice(index, 1);
    },
  };
  return mql;
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme preference', () => {
  it('accepts exactly the three preferences', () => {
    expect(isThemePref('system')).toBe(true);
    expect(isThemePref('light')).toBe(true);
    expect(isThemePref('dark')).toBe(true);
    expect(isThemePref('neon')).toBe(false);
    expect(isThemePref(undefined)).toBe(false);
    expect(isThemePref(1)).toBe(false);
  });

  it('paints an explicit preference on the document', () => {
    const stop = watchTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('resolves system from the OS preference and follows changes', () => {
    const mql = fakeSystem(true);
    vi.stubGlobal('matchMedia', () => mql);
    const stop = watchTheme('system');
    expect(resolveTheme('system')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    mql.matches = false;
    mql.listeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
  });

  it('never subscribes for an explicit preference', () => {
    const matchMedia = vi.fn();
    vi.stubGlobal('matchMedia', matchMedia);
    watchTheme('light')();
    expect(matchMedia).not.toHaveBeenCalled();
  });
});
