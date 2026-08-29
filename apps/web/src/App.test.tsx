import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('App smoke test', () => {
  it('renders the application title', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'AI UML Design Tool' })).toBeTruthy();
  });
});
