import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@app/core scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@app/core');
  });
});
