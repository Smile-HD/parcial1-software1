/**
 * PresenceBar — connected-user names via Yjs awareness (realtime:R2, 6b.3).
 * Pure presentational component so the awareness wiring stays testable.
 */
export function PresenceBar({ names }: { names: readonly string[] }) {
  if (names.length === 0) {
    return null;
  }
  return (
    <div className="presence-bar" aria-label="Online users">
      {names.map((name) => (
        <span key={name} className="presence-bar__user">
          {name}
        </span>
      ))}
    </div>
  );
}
