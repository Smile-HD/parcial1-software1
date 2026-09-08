/**
 * PresenceBar — connected-user names via Yjs awareness (realtime:R2, 6b.3).
 * Pure presentational component so the awareness wiring stays testable.
 *
 * unit 13e.10 — the aria-label goes through the i18n dictionary (reactive).
 * unit 13e.11 — EA-style light chips: initials avatar + green online dot +
 * name, inside the existing `presence-bar__user` contract.
 */
import { useT } from '../i18n';

/**
 * Initials for the chip avatar: the first letters of the first two
 * alphanumeric tokens of the name ("User-a1b2" → "UA", "Ana López" → "AL");
 * a single-token name contributes its first two letters.
 */
export function presenceInitials(name: string): string {
  const tokens = name.split(/[^a-zA-Z0-9À-ɏ]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return '';
  }
  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 2).toUpperCase();
  }
  return (tokens[0]![0]! + tokens[1]![0]!).toUpperCase();
}

export function PresenceBar({ names }: { names: readonly string[] }) {
  const { t } = useT();
  if (names.length === 0) {
    return null;
  }
  return (
    <div className="presence-bar" aria-label={t('presence.onlineUsers')}>
      {names.map((name) => (
        <span key={name} className="presence-bar__user">
          {/* EA-style chip: initials avatar + online dot + full name. */}
          <span className="presence-bar__avatar" aria-hidden="true">
            {presenceInitials(name)}
          </span>
          <span className="presence-bar__dot" aria-hidden="true" />
          <span className="presence-bar__name">{name}</span>
        </span>
      ))}
    </div>
  );
}
