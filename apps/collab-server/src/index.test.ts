import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@app/collab-server scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@app/collab-server');
  });
});
