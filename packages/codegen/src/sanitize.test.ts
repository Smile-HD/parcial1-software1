import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NameSanitizerError,
  assertInsideOutputRoot,
  isReservedJavaName,
  sanitizeJavaName,
} from './sanitize.js';

/**
 * Unit 14.1 — codegen threat matrix row 1 ("Documentation-like paths").
 *
 * Class/attribute names are user-controlled and feed both the Java identifier
 * and the output file path. A name such as `../../pom.xml` must never be able
 * to escape the job output root, and a Java reserved word such as `class` must
 * never become a generated type name. These are the RED tests for that row.
 */
describe('sanitizeJavaName (codegen threat row 1)', () => {
  it('rejects a path-traversal name that resolves to a build file', () => {
    expect(() => sanitizeJavaName('../../pom.xml')).toThrow(NameSanitizerError);
  });

  it('rejects a Java reserved word', () => {
    expect(() => sanitizeJavaName('class')).toThrow(NameSanitizerError);
  });

  it('rejects names that are not a valid Java identifier', () => {
    // `mvnw` is a legal Java identifier on its own; the build-file threat it
    // represents is a PATH concern, covered by assertInsideOutputRoot below.
    for (const bad of ['a b', '9lives', 'Order-Service', '', 'pom.xml', '../x']) {
      expect(() => sanitizeJavaName(bad)).toThrow(NameSanitizerError);
    }
  });

  it('accepts a well-formed Java type name', () => {
    expect(sanitizeJavaName('Product')).toBe('Product');
    expect(sanitizeJavaName('_Order2')).toBe('_Order2');
  });

  it('flags reserved words independently of the identifier shape', () => {
    expect(isReservedJavaName('class')).toBe(true);
    expect(isReservedJavaName('Product')).toBe(false);
  });
});

describe('assertInsideOutputRoot (codegen threat row 1)', () => {
  const root = '/tmp/job-abc123';

  it('rejects a relative path that escapes the output root', () => {
    expect(() => assertInsideOutputRoot(root, '../../pom.xml')).toThrow(NameSanitizerError);
  });

  it('rejects an absolute path outside the output root', () => {
    expect(() => assertInsideOutputRoot(root, '/etc/passwd')).toThrow(NameSanitizerError);
  });

  it('accepts a backend source path inside the output root', () => {
    const abs = assertInsideOutputRoot(root, 'src/main/java/Product.java');
    expect(abs).toBe(resolve(root, 'src/main/java/Product.java'));
  });
});
