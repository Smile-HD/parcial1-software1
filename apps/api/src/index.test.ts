import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@app/api scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@app/api');
  });
});
