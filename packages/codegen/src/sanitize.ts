import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Name sanitizer + output-root containment guard for codegen.
 *
 * Implements the design Threat Matrix row 1 ("Documentation-like paths"):
 * class/attribute names are user-controlled and feed both the generated Java
 * identifier and the output file path, so a name like `../../pom.xml` must not
 * be able to escape the job output root, and a Java reserved word like `class`
 * must not become a generated type name.
 *
 * The policy is REJECT, not rewrite: a name outside the allow-list throws so
 * generation fails loudly rather than silently producing a mangled identifier.
 */
export class NameSanitizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NameSanitizerError';
  }
}

/**
 * Java identifier allow-list from the threat matrix: `[A-Za-z_][A-Za-z0-9_]*`.
 * Deliberately strict — no dots, slashes, spaces or leading digits, so path
 * traversal and build-file names can never match.
 */
const JAVA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Java keywords + the boolean/null literals that are illegal as identifiers
 * (JLS 3.9). `var`, `record`, `sealed` etc. are contextual, not reserved, so
 * they are intentionally NOT listed.
 */
const JAVA_RESERVED = new Set<string>([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

/** True when `name` is a Java reserved word or literal (case-sensitive). */
export function isReservedJavaName(name: string): boolean {
  return JAVA_RESERVED.has(name);
}

/**
 * Validate `raw` as a Java identifier and return it unchanged.
 *
 * @throws {NameSanitizerError} if `raw` is not `[A-Za-z_][A-Za-z0-9_]*` or is a
 *   reserved word. This is what rejects `../../pom.xml` (bad shape) and `class`
 *   (reserved word) from the threat-matrix RED cases.
 */
export function sanitizeJavaName(raw: string): string {
  if (!JAVA_IDENTIFIER.test(raw)) {
    throw new NameSanitizerError(
      `Invalid Java name ${JSON.stringify(raw)}: must match [A-Za-z_][A-Za-z0-9_]*`,
    );
  }
  if (isReservedJavaName(raw)) {
    throw new NameSanitizerError(`Invalid Java name ${JSON.stringify(raw)}: reserved word`);
  }
  return raw;
}

/**
 * Resolve `relPath` against `outputRoot` and assert the result stays inside it.
 *
 * Defense in depth behind {@link sanitizeJavaName}: even if a path is assembled
 * from names, an escaping path is rejected before any write is planned.
 *
 * @throws {NameSanitizerError} if the resolved path equals neither the root nor
 *   a descendant of it (e.g. `../../pom.xml`, or an absolute path elsewhere).
 */
export function assertInsideOutputRoot(outputRoot: string, relPath: string): string {
  const root = resolve(outputRoot);
  const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new NameSanitizerError(
      `Refusing to write outside the job output root: ${JSON.stringify(relPath)}`,
    );
  }
  return abs;
}
