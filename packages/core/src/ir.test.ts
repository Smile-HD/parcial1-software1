import { describe, expect, it } from 'vitest';
import { AssociationSchema, MultiplicityEnum } from './ir.js';

describe('IR Schema — Multiplicity Validation (editor:R4)', () => {
  it('accepts valid multiplicities: 1, 0..1, 1..*, 0..*', () => {
    const valid = ['1', '0..1', '1..*', '0..*'] as const;
    for (const m of valid) {
      const result = AssociationSchema.shape.sourceMultiplicity.safeParse(m);
      expect(result.success).toBe(true);
      expect(MultiplicityEnum.safeParse(m).success).toBe(true);
    }
  });

  it('REJECTS multiplicities outside the allowed enum (3..7, 2, 1..3)', () => {
    const invalid = ['3..7', '2', '1..3', '5', '*', '0..2', 'many'] as const;
    for (const m of invalid) {
      const result = AssociationSchema.shape.sourceMultiplicity.safeParse(m);
      expect(result.success).toBe(false);
      expect(MultiplicityEnum.safeParse(m).success).toBe(false);
    }
  });
});