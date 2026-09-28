export default function ShortcutLabel({ label }: { label: string }) {
  if (!label.includes('Windows+')) return <>{label}</>;
  const [before, after] = label.split('Windows+');
  return <span role="img" aria-label={label}>{before}<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" style={{ display: 'inline-block', verticalAlign: '-0.1em' }} fill="currentColor"><path d="M0 0h7v7H0zm9 0h7v7H9zM0 9h7v7H0zm9 0h7v7H9z" /></svg>+{after}</span>;
}
