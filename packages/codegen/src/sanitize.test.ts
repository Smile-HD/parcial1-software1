import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NameSanitizerError,
  assertInsideOutputRoot,
  isReservedJavaName,
  normalizeJavaIdentifier,
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

describe('normalizeJavaIdentifier', () => {
  it('converts informal spaced names to camelCase and PascalCase', () => {
    expect(normalizeJavaIdentifier('Phone number', 'camel')).toBe('phoneNumber');
    expect(normalizeJavaIdentifier('Phone number', 'pascal')).toBe('PhoneNumber');
    expect(normalizeJavaIdentifier('customer   order   item', 'camel')).toBe('customerOrderItem');
  });

  it('normalizes accents and diacritics', () => {
    expect(normalizeJavaIdentifier('dirección', 'camel')).toBe('direccion');
    expect(normalizeJavaIdentifier('año de nacimiento', 'camel')).toBe('anoDeNacimiento');
    expect(normalizeJavaIdentifier('canción', 'pascal')).toBe('Cancion');
  });

  it('normalizes hyphens, underscores and symbols', () => {
    expect(normalizeJavaIdentifier('first-name', 'camel')).toBe('firstName');
    expect(normalizeJavaIdentifier('last_name', 'camel')).toBe('lastName');
    expect(normalizeJavaIdentifier('total price ($USD)', 'camel')).toBe('totalPriceUsd');
  });

  it('handles leading digits safely with an underscore prefix', () => {
    expect(normalizeJavaIdentifier('123code', 'camel')).toBe('_123code');
    expect(normalizeJavaIdentifier('9lives', 'pascal')).toBe('_9lives');
  });

  it('escapes Java reserved words with an underscore prefix in camelCase', () => {
    expect(normalizeJavaIdentifier('class', 'camel')).toBe('_class');
    expect(normalizeJavaIdentifier('package', 'camel')).toBe('_package');
    expect(normalizeJavaIdentifier('default', 'camel')).toBe('_default');
    expect(normalizeJavaIdentifier('int', 'camel')).toBe('_int');
  });

  it('preserves valid identifiers without altering casing unnecessarily', () => {
    expect(normalizeJavaIdentifier('Product', 'pascal')).toBe('Product');
    expect(normalizeJavaIdentifier('orderId', 'camel')).toBe('orderId');
  });

  it('rejects path-traversal sequences', () => {
    expect(() => normalizeJavaIdentifier('../../pom.xml', 'pascal')).toThrow(NameSanitizerError);
    expect(() => normalizeJavaIdentifier('../x', 'camel')).toThrow(NameSanitizerError);
    expect(() => normalizeJavaIdentifier('/etc/passwd', 'pascal')).toThrow(NameSanitizerError);
    expect(() => normalizeJavaIdentifier('path\\file', 'camel')).toThrow(NameSanitizerError);
  });

  it('rejects empty or whitespace/symbol-only strings', () => {
    expect(() => normalizeJavaIdentifier('', 'camel')).toThrow(NameSanitizerError);
    expect(() => normalizeJavaIdentifier('   ', 'pascal')).toThrow(NameSanitizerError);
    expect(() => normalizeJavaIdentifier('---', 'camel')).toThrow(NameSanitizerError);
    expect(() => normalizeJavaIdentifier('$$$', 'pascal')).toThrow(NameSanitizerError);
  });
});
